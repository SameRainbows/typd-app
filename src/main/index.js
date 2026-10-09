'use strict';

const {
  app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, nativeTheme, dialog, powerMonitor,
  session: electronSession
} = require('electron');

const { createOverlayWindow, positionOverlay, showOverlay } = require('./overlay-window');
const { registerHotkeys } = require('./hotkeys');
const settings = require('./settings');
const settingsWindow = require('./settings-window');
const pipeline = require('./pipeline');
const inject = require('./inject');
const learn = require('./learn');
const dictionary = require('./dictionary');
const collect = require('./collect');   // tester builds only; inert without tester.json

/**
 * Opt-in: keep each dictation's audio with everything needed to replay it -- the text Typd
 * produced, the model, the screen context and highlighted span it was given -- so real
 * dictations can become a private test set and training data. Stored under
 * %APPDATA%\Typd\recordings and never sent anywhere; the first law still holds.
 *
 * The folder is the switch: it records while the folder exists (or TYPD_KEEP_AUDIO is set).
 * Rename or delete the folder to stop. Off by default.
 */
function recordingsDir() {
  if (!settings.get('keepRecordings')) return null;
  const dir = require('path').join(app.getPath('appData'), 'Typd', 'recordings');
  if (process.env.TYPD_KEEP_AUDIO) return dir;
  return require('fs').existsSync(dir) ? dir : null;
}

function keepRecording(current, text) {
  const audio = current.audio;
  const dir = recordingsDir();
  // A stub session's text never came from its audio; keeping the pair would plant a wrong
  // label in the user's own test and training set.
  if (stub || !dir || !audio || !audio.samples) return;
  try {
    const fs = require('fs');
    const path = require('path');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const pcm = audio.samples;
    const buf = Buffer.alloc(44 + pcm.length * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(audio.sampleRate, 24); buf.writeUInt32LE(audio.sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(pcm.length * 2, 40);
    for (let i = 0; i < pcm.length; i++) {
      buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
    }
    fs.writeFileSync(path.join(dir, stamp + '.wav'), buf);
    const meta = {
      mode: current.mode,
      output: text,
      seconds: Math.round((pcm.length / audio.sampleRate) * 100) / 100,
      ms: current.endedAt ? Date.now() - current.endedAt : null,   // stop -> text ready
      model: path.basename(require('./pipeline/local').MODEL),
      app: current.target ? current.target.process : null,
      context: current.contextBlock || null,
      span: current.span || null
    };
    fs.writeFileSync(path.join(dir, stamp + '.json'), JSON.stringify(meta, null, 1));
  } catch (err) {
    if (process.env.TYPD_DEBUG) console.log('[typd:keep]', err);
  }
}

const dev = process.argv.includes('--dev');

// The fake pipeline, for tuning the overlay without a model load or an API call.
const stub = process.argv.includes('--stub');

// Holds the overlay open in listening state so the pill can be looked at
// without synthesising a hotkey. Design work needs to see the thing at actual
// size, over real content.
const preview = process.argv.includes('--preview');

// How long to wait for the renderer to hand over captured audio before giving
// up. Generous: it is a buffer copy, not a network call.
const AUDIO_TIMEOUT_MS = 4000;

let overlay = null;
let tray = null;
let hotkeys = null;
let session = null;

// Two copies fighting over one global hotkey is a confusing failure that looks
// like the hotkey is simply broken.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/* ------------------------------------------------------------------ plumbing */

// Messages sent before the renderer has registered its listeners are dropped on
// the floor -- so a hotkey pressed in the first second after launch produced a
// visible-but-empty overlay. Anything sent early is held and flushed on load.
let rendererReady = false;
const queued = [];

function send(channel, payload) {
  if (!overlay || overlay.isDestroyed()) return;
  if (!rendererReady) {
    queued.push([channel, payload]);
    return;
  }
  overlay.webContents.send(channel, payload);
}

function markRendererReady() {
  rendererReady = true;
  overlay.webContents.send('settings:changed', { sounds: settings.get('sounds'), mic: settings.get('mic') });
  while (queued.length) {
    const [channel, payload] = queued.shift();
    overlay.webContents.send(channel, payload);
  }
}

/** Restore full click-through. Anything else leaves a dead rectangle on screen. */
function passThrough() {
  if (overlay && !overlay.isDestroyed()) {
    overlay.setIgnoreMouseEvents(true, { forward: true });
  }
}

/* ------------------------------------------------------------------ session */

/** "notepad" -> "Notepad". Process names are lowercase far too often to trust. */
function appLabel(focus) {
  if (!focus || !focus.process) return null;
  return focus.process.charAt(0).toUpperCase() + focus.process.slice(1);
}

function beginSession() {
  if (session) session.controller.abort();

  const controller = new AbortController();
  session = {
    mode: 'dictate', modeSettled: false, controller, target: null,
    contextBlock: null, span: null, audio: null, onAudio: null, ready: null,
    stream: undefined   // opened on the first chunk; null when the model takes one piece
  };
  const current = session;

  // What is on screen decides the mode. A highlighted span means the user is
  // revising it; no highlight means they are dictating. There is one key, and
  // nothing is being guessed -- the selection is a fact, read the same way it
  // was already being read.
  //
  // The overlay still has to appear on this tick, so the read is not awaited
  // here. The cheap UI Automation probe usually settles it within ~8 ms and the
  // pill adopts revise styling before anyone could see otherwise; only when
  // that probe is inconclusive does the ~140 ms clipboard path run, and the
  // pill spends that time looking like dictation. Both are far inside the
  // several seconds the speaker is about to spend talking.
  //
  // The promise is kept rather than only its result: a fast "press, say one
  // word, press" can beat the slow path, and endSession has to be able to wait
  // for the answer rather than act on a half-built session.
  current.ready = inject
    .selection((selected) => {
      // Early word from the cheap probe, when it is certain either way.
      if (session === current && selected) setMode(current, 'revise');
    })
    .then(async (sel) => {
      if (session !== current) return;

      if (sel && sel.text) {
        learn.stop();
        current.span = sel.text;
        current.target = { process: sel.process, title: sel.title };
        setMode(current, 'revise');
        pipeline.wake(null);
        return;
      }

      // Nothing highlighted: an ordinary dictation. The surrounding text is
      // still worth reading, as vocabulary for the recogniser to repair against.
      setMode(current, 'dictate');
      const focus = await inject.focusContext();
      // The same read is the last look for a fix to the previous paste, so a
      // word corrected just now is already in this dictation's vocabulary.
      learn.settle(focus);
      if (session !== current) return;
      current.target = focus;
      current.contextBlock = pipeline.buildContextFrom(focus);
      pipeline.wake(current.contextBlock);
    });

  positionOverlay(overlay);
  passThrough();
  showOverlay(overlay);   // on top of everything, never takes focus from the app being dictated into
  send('session:start', { mode: current.mode });
}

/**
 * Settle the session's mode and tell the overlay, once.
 *
 * Revision overwrites writing the user already has, so the pill must not look
 * like dictation while it is about to do that -- but it also must not flicker
 * between the two as reads come back. The first answer wins and later ones are
 * ignored, which is safe because the cheap probe only speaks when it is certain.
 */
function setMode(current, mode) {
  if (current.modeSettled) return;
  current.modeSettled = true;
  current.mode = mode;
  send('session:mode', { mode });
}

/**
 * The renderer owns the microphone, so the captured audio arrives by IPC a beat
 * after we ask it to stop. Everything downstream waits on this.
 */
function awaitAudio(current) {
  if (current.audio) return Promise.resolve(current.audio);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      current.onAudio = null;
      reject(new Error('No audio captured — check the microphone'));
    }, AUDIO_TIMEOUT_MS);

    current.onAudio = (audio) => {
      clearTimeout(timer);
      current.onAudio = null;
      resolve(audio);
    };
  });
}

async function endSession() {
  if (!session) return;

  const current = session;
  current.endedAt = Date.now();
  send('session:capture-end', {});
  // Escape still means "never mind" while the model works, not only while recording.
  hotkeys.holdWork(() => { if (session === current) cancelSession(); });

  try {
    // The context or selection read was started when the session opened and is
    // usually long finished. It is not finished if the user pressed, said one
    // word and pressed again -- and the clipboard fallback costs ~140 ms. Wait
    // for it rather than proceeding with a half-built session.
    if (current.ready) await current.ready;
    if (session !== current) return;

    const source = stub
      ? pipeline.runStub({ mode: current.mode, signal: current.controller.signal })
      : pipeline.run({
          mode: current.mode,
          audio: await awaitAudio(current),
          contextBlock: current.contextBlock,
          span: current.span,
          signal: current.controller.signal,
          stream: current.stream || null
        });

    if (session !== current) return;

    for await (const event of source) {
      if (session !== current) return;   // superseded by a newer session

      // 'done' is the only event with a side effect: the text has to land in
      // the app the user was in before the overlay reports that it did.
      if (event.type === 'done') {
        // A revision replaces the selection by pasting over it, which only
        // works while the selection is still there. Clicking away during the
        // several seconds this takes turns the replacement into an insertion
        // of rewritten text next to the untouched original -- silently. Refuse
        // instead: the user loses a sentence of speech, not a paragraph of
        // writing.
        if (current.mode === 'revise') {
          const still = await inject.selectionStillIs(current.span);
          if (session !== current) return;

          if (!still.ok) {
            // Nothing is overwritten, but the rewrite is kept: it is on the clipboard.
            remember(event.text);
            await inject.copy(event.text);
            if (session !== current) return;
            send('session:error', {
              message: still.reason === 'collapsed'
                ? 'Selection lost — rewrite copied'
                : 'Selection changed — rewrite copied'
            });
            break;
          }
        }

        keepRecording(current, event.text);
        remember(event.text);
        const result = await inject.paste(event.text);
        if (session !== current) return;

        if (!result.ok) {
          send('session:error', {
            message: result.copied
              ? 'Copied — press ' + (process.platform === 'darwin' ? '⌘V' : 'Ctrl+V') + ' to paste'   // macOS: ⌘V
              : 'Could not paste — ' + result.reason
          });
          break;
        }

        send('session:done', { text: event.text, target: appLabel(current.target) });
        learn.watch(event.text, current.target && current.target.process, inject.focusContext, learned);
        // Tester builds only (a tester.json is present, see collect.js): queue this audio and
        // text for upload to the developer, with the tester's consent. Only after the paste
        // has landed, never awaited, and it never reads the screen context or the span.
        collect.add(current, event.text);
        continue;
      }

      send('session:' + event.type, event);
    }
  } catch (err) {
    if (err && err.message === 'aborted') return;
    send('session:error', { message: String(err && err.message ? err.message : err) });
  }

  if (session === current) session = null;
  hotkeys.releaseWork();
}

function cancelSession() {
  if (session) session.controller.abort();
  session = null;
  hotkeys.releaseWork();
  passThrough();
  send('session:cancel', {});
}

/* --------------------------------------------------------------------- tray */

/**
 * Draw the tray mark straight into a BGRA buffer. No icon asset to ship, and no
 * invisible tray entry that leaves the app unquittable while there is still no
 * real mark to use.
 */
function trayIcon(size) {
  const scale = 4;   // supersample, then let the downscale do the antialiasing
  const big = size * scale;
  const buf = Buffer.alloc(big * big * 4);
  const r = big / 2 - scale;
  const c = big / 2;

  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      if (dx * dx + dy * dy <= r * r) {
        const i = (y * big + x) * 4;
        buf[i] = 0xF7;       // B
        buf[i + 1] = 0xF5;   // G
        buf[i + 2] = 0xF4;   // R  -> near-white, matching the pill
        buf[i + 3] = 0xff;   // A
      }
    }
  }

  return nativeImage
    .createFromBitmap(buf, { width: big, height: big })
    .resize({ width: size, height: size, quality: 'best' });
}

// The last finished text, so it is never more than a right-click away: pasted into the wrong
// window, lost to a crash of the target app, or simply wanted twice. Memory only.
let lastText = '';

// The word most recently learned from a correction, so a wrong lesson is one
// right-click from undone (ROADMAP 3.8). The full list is the dictionary file.
let lastLearned = null;

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: `Dictate    ${hotkeys ? hotkeys.binding : 'Right Alt'}`, enabled: false },
    { label: 'Revise     select text first', enabled: false },
    { type: 'separator' },
    { label: 'Copy last dictation', enabled: Boolean(lastText), click: () => inject.copy(lastText) },
    ...(lastLearned ? [{ label: `Forget “${lastLearned}”`, click: () => forget(lastLearned) }] : []),
    { type: 'separator' },
    { label: 'Settings…', click: () => settingsWindow.open() },
    { label: 'Quit Typd', click: () => app.quit() }
  ]);
}

function remember(text) {
  lastText = text;
  if (tray) tray.setContextMenu(trayMenu());
}

/**
 * A correction was learned. Say so once, quietly, and only between sessions --
 * the pill is never interrupted mid-dictation for this.
 */
function learned({ term }) {
  lastLearned = term;
  if (tray) tray.setContextMenu(trayMenu());
  if (session || !overlay || overlay.isDestroyed()) return;
  positionOverlay(overlay);
  passThrough();
  showOverlay(overlay);
  send('session:note', { message: `Learned “${term}”` });
}

function forget(term) {
  dictionary.remove(term);
  if (lastLearned === term) lastLearned = null;
  if (tray) tray.setContextMenu(trayMenu());
}

function buildTray() {
  // macOS: a template image, black and alpha, that the menu bar tints itself (mac/tray-icon.js).
  tray = new Tray(process.platform === 'darwin' ? require('./mac/tray-icon').image() : trayIcon(16));
  tray.setToolTip('Typd — ' + (hotkeys ? hotkeys.binding : 'Right Alt'));
  tray.setContextMenu(trayMenu());
}

/* -------------------------------------------------------------------- start */

app.whenReady().then(() => {
  // macOS: a menu-bar utility -- no Dock icon, no app menu, not in the app switcher. Before
  // the overlay exists, so it is created as the accessory window it will stay.
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  // Dark unless the OS says otherwise. The overlay sits over other people's
  // windows and a bright pill is the more intrusive default of the two.
  nativeTheme.themeSource = 'dark';

  // The overlay needs the mic for its level meter. Grant that and deny the rest
  // -- an always-on-top window should have the narrowest surface possible.
  electronSession.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media' || permission === 'audioCapture');
  });

  overlay = createOverlayWindow({ dev });
  overlay.webContents.on('did-finish-load', markRendererReady);

  // Warm the injector during launch so the first paste does not pay the ~450 ms
  // shell start, and the speech model so the first dictation does not pay for
  // loading it.
  inject.start();
  if (!stub) {
    pipeline.warm();

    // With the single local model, dictation needs no key at all; only revise
    // (and the old cascade engine) call the cloud.
    if (pipeline.ENGINE === 'cascade' && !process.env.POOLSIDE_API_KEY) {
      dialog.showMessageBox({
        type: 'warning',
        title: 'Typd — no API key',
        message: 'POOLSIDE_API_KEY is not set.',
        detail:
          'Speech recognition runs locally and will work, but the cleanup step ' +
          'needs a key from platform.poolside.ai.\n\n' +
          'Set it in the environment before launching, or run with --stub to ' +
          'use canned responses.'
      });
    }
  }

  const bindHotkeys = (binding) => registerHotkeys({
    onPress: () => beginSession(),
    onRelease: endSession,
    onCancel: cancelSession,
    onAltDown: () => inject.maskAlt(),
    binding
  });
  hotkeys = bindHotkeys(settings.get('hotkey'));

  // Settings: the window, and what each change does right away.
  settingsWindow.register({
    modelName: () => require('path').basename(require('./pipeline/local').MODEL).replace(/\.gguf$/, ''),
    applyHotkey: (binding) => {
      if (session) return false;                  // never swap the key mid-dictation
      const old = hotkeys;
      old.close();
      const next = bindHotkeys(binding);
      if (next.failed.length) { next.close(); hotkeys = bindHotkeys(settings.get('hotkey')); return false; }
      hotkeys = next;
      if (tray) { tray.setContextMenu(trayMenu()); tray.setToolTip('Typd — ' + hotkeys.binding); }
      return true;
    }
  });
  settings.onChange((key) => {
    if (key === 'sounds' || key === 'mic') send('settings:changed', { sounds: settings.get('sounds'), mic: settings.get('mic') });
  });
  // Launching Typd again (Start, Windows search) while it runs opens Settings: the tray icon
  // may be hidden by Windows, and "I opened it and nothing happened" must never be the answer.
  app.on('second-instance', () => settingsWindow.open());

  // After sleep or a lock screen the keyboard hook may be gone without a word; put it back.
  // A beat later, so the desktop session is fully back first.
  for (const ev of ['resume', 'unlock-screen']) {
    powerMonitor.on(ev, () => setTimeout(() => hotkeys.rearm(), 1500));
  }

  if (hotkeys.failed.length) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'Typd — hotkey unavailable',
      message: 'Another application already owns ' + hotkeys.failed.join(' and ') + '.',
      detail: 'Set TYPD_HOTKEY to another key (for example CommandOrControl+Shift+D) and restart.'
    });
  }

  buildTray();

  // macOS: microphone, Accessibility and Input Monitoring are asked for together, in one
  // dialog, and again whenever one goes missing (permissions-mac.js). Open at login is the
  // system's own login item, added on the first run of the installed app. Opening Typd
  // again from Finder, Spotlight or Launchpad -- the way to reach it when the menu bar hides
  // its icon behind the notch -- opens Settings, as a second launch does on Windows.
  if (process.platform === 'darwin') {
    require('./permissions-mac').ensure('startup');
    require('./mac/login-item').sync(settings.get('startAtLogin'));
    const launched = Date.now();
    app.on('activate', () => { if (Date.now() - launched > 3000) settingsWindow.open(); });
  }

  if (preview) {
    if (process.env.TYPD_PREVIEW_THEME) {
      nativeTheme.themeSource = process.env.TYPD_PREVIEW_THEME;
    }
    setTimeout(() => beginSession(), 400);

    // With TYPD_PREVIEW_OUT set, render the overlay to a PNG and quit. Win32
    // screen capture cannot do this -- BitBlt skips layered windows and
    // PrintWindow drops the alpha -- but the renderer can screenshot itself
    // exactly as composited.
    const out = process.env.TYPD_PREVIEW_OUT;
    if (out) {
      setTimeout(async () => {
        await overlay.webContents.insertCSS(
          'html{background:' + (process.env.TYPD_PREVIEW_BG || '#1A1D22') + ' !important}'
        );
        if (process.env.TYPD_PREVIEW_ACTIVE) {
          await overlay.webContents.executeJavaScript('window.__typdSynthetic = true');
          await new Promise((r) => setTimeout(r, 900));   // let the meter fill
        }
        const shot = await overlay.webContents.capturePage();
        require('fs').writeFileSync(out, shot.toPNG());
        app.exit(0);
      // Generous by default: asr.warm() loads 640 MB of ONNX synchronously and
      // blocks the main process for ~4 s, delaying the renderer's first paint.
      }, Number(process.env.TYPD_PREVIEW_DELAY || 5000));
    }
  }

  // The overlay is click-through by default and opts back in only while the
  // cursor is over one of its two controls, so the rest of the pill never
  // swallows a click meant for the window underneath.
  ipcMain.on('overlay:interactive', (_e, on) => {
    if (overlay && !overlay.isDestroyed()) {
      overlay.setIgnoreMouseEvents(!on, { forward: true });
    }
  });

  // Live PCM while the user talks, 256 ms at a time. Only a model trained on
  // audio in pieces uses it (pipeline.openStream); revision never does -- the
  // instruction is short and the span decides what it means.
  ipcMain.on('overlay:chunk', (_e, payload) => {
    const current = session;
    if (!current || !payload || !payload.buffer || payload.sampleRate !== 16000) return;
    if (current.mode !== 'dictate') return;
    if (current.stream === undefined) {
      current.stream = pipeline.openStream(current.controller.signal, () => current.contextBlock);
    }
    if (!current.stream) return;
    const raw = payload.buffer;
    current.stream.push(Buffer.isBuffer(raw)
      ? new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
      : new Float32Array(raw));
  });

  // Captured PCM, arriving once per session after the renderer stops the mic.
  ipcMain.on('overlay:audio', (_e, payload) => {
    if (!session || !payload || !payload.buffer) return;

    // Electron hands this back as a Node Buffer view rather than the bare
    // ArrayBuffer that went in, so honour the offset and length.
    const raw = payload.buffer;
    const samples = Buffer.isBuffer(raw)
      ? new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4))
      : new Float32Array(raw);

    const audio = { samples, sampleRate: payload.sampleRate || 16000 };
    session.audio = audio;
    if (session.onAudio) session.onAudio(audio);
  });

  // Finishing or abandoning from the pill's own controls has to settle the
  // hotkey state too, or the next keypress would try to close a dead session.
  ipcMain.on('overlay:confirm', () => {
    if (hotkeys.settle()) {
      passThrough();
      endSession();
    }
  });

  // A dead microphone ends the session at once with the reason, instead of after the
  // user has finished talking ("No audio captured").
  ipcMain.on('overlay:mic', (_e, kind) => {
    if (!session || session.endedAt) return;
    hotkeys.settle();
    session.controller.abort();
    session = null;
    passThrough();
    send('session:error', {
      message: kind === 'silent' ? 'Mic silent — check mute/privacy' : 'No mic access — check settings'
    });
  });

  ipcMain.on('overlay:cancel', () => {
    if (hotkeys.settle()) cancelSession();
  });

  // The overlay reports when its exit animation has finished, so the window is
  // hidden on the frame after the fade rather than mid-transition.
  ipcMain.on('overlay:hidden', () => {
    passThrough();
    if (overlay && !overlay.isDestroyed()) overlay.hide();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      rendererReady = false;
      overlay = createOverlayWindow({ dev });
      overlay.webContents.on('did-finish-load', markRendererReady);
    }
  });
});

app.on('will-quit', () => {
  if (hotkeys) hotkeys.close();
  inject.stop();
  pipeline.stop();
});

// A dictation overlay is a background utility. Closing its only window is not a
// reason to exit -- it lives in the tray until asked to leave.
app.on('window-all-closed', (e) => e.preventDefault());
