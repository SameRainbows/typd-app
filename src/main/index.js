'use strict';

const {
  app, ipcMain, nativeTheme, dialog, powerMonitor, systemPreferences,
  session: electronSession
} = require('electron');

const { createOverlayWindow, positionOverlay, showOverlay } = require('./overlay-window');
const { registerHotkeys, stopHook } = require('./hotkeys');
const hotkeyLogic = require('./hotkey-logic');
const settings = require('./settings');
const home = require('./home-window');
const status = require('./status');
const brand = require('./brand');
const { store } = require('./store');
const { createTray } = require('./tray');
const pipeline = require('./pipeline');
const inject = require('./inject');
const learn = require('./learn');
const dictionary = require('./dictionary');
const collect = require('./collect');   // tester builds only; inert without tester.json
const modelUpdate = require('./modelUpdate');   // tester builds and the developer's machines; inert without a key
const appUpdate = require('./appUpdate');       // packaged builds: a newer signed Typd, installed while you are away

const MAC = process.platform === 'darwin';

/**
 * Keep each dictation's audio with everything needed to replay it -- the text Typd
 * produced, the model, the screen context and highlighted span it was given -- so real
 * dictations can become a private test set and training data. Stored under
 * %APPDATA%\Typd\recordings and never sent anywhere; the first law still holds.
 *
 * The "Keep recordings" switch in Settings is the switch: on, every dictation is kept and
 * the folder is made if it is missing; off, nothing is. TYPD_KEEP_AUDIO forces it on.
 */
function recordingsDir() {
  if (!settings.get('keepRecordings') && !process.env.TYPD_KEEP_AUDIO) return null;
  return settings.recordingsDir();
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

/**
 * History (store.js): what landed, for the window's History and Home. Never the screen
 * context, the span or a title -- store.record drops anything it does not know. Written a
 * tick later, so the paste is never waiting on a file.
 */
function keepHistory(current, text, outcome) {
  if (stub) return;
  const audio = current.audio;
  setImmediate(() => {
    try {
      store().record({
        mode: current.mode,
        text,
        seconds: audio && audio.samples ? audio.samples.length / (audio.sampleRate || 16000) : 0,
        waitMs: current.endedAt ? Date.now() - current.endedAt : 0,
        app: current.target && current.target.process ? current.target.process : null,
        outcome
      });
    } catch (err) {
      if (process.env.TYPD_DEBUG) console.log('[typd:history]', err);
    }
    home.changed('history');
    refreshTray();
  });
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
let firstRunNote = false;   // the pill says "Ready — tap … and talk" once, on the very first launch

/* -------------------------------------------------------------------- quit */

/*
 * Who asked Typd to quit, for the log: the tray's "Quit Typd", or (unset) macOS itself --
 * ⌘Q, the Dock's Quit, logging out, a quit Apple event, SIGTERM. Closing a window is never
 * on that list: window-all-closed below keeps Typd running.
 */
let quitBy = null;

function quit(by) {
  quitBy = by;
  app.quit();
}

const debugLife = (...args) => { if (process.env.TYPD_DEBUG) console.log('[typd:quit]', ...args); };
app.on('before-quit', () => debugLife('before-quit, asked by ' + (quitBy || 'macOS or a signal (⌘Q, the Dock, logout, kill)')));
process.on('exit', (code) => debugLife('process exit, code ' + code));

// Two copies fighting over one global hotkey is a confusing failure that looks
// like the hotkey is simply broken. The second copy quits at once and does nothing
// else on the way out (whenReady below checks `primary`); the first opens its window.
const primary = app.requestSingleInstanceLock();
if (!primary) {
  quit('a second copy of Typd (the first keeps running)');
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
  overlay.webContents.send('settings:changed', { sounds: settings.get('sounds'), mic: settings.get('mic'), micLabel: settings.get('micLabel') });
  while (queued.length) {
    const [channel, payload] = queued.shift();
    overlay.webContents.send(channel, payload);
  }
}

/**
 * The overlay, made again if it is gone. Nothing closes it on purpose, but a key press that
 * found it destroyed would throw inside the hotkey's native callback (hotkeys.js, guard), and
 * every later dictation would find it destroyed too.
 */
function ensureOverlay() {
  if (overlay && !overlay.isDestroyed()) return overlay;
  if (overlay) console.log('[typd] the overlay was gone; making it again');
  rendererReady = false;
  overlay = createOverlayWindow({ dev });
  overlay.webContents.on('did-finish-load', markRendererReady);
  return overlay;
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
    contextBlock: null, span: null, spanTruncated: false, audio: null, onAudio: null, ready: null,
    stream: undefined   // opened on the first chunk; null when the model takes one piece
  };
  const current = session;
  firstRunNote = false;
  status.set({ live: true });

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
        // More was highlighted than could be read: revising it would paste a rewrite of
        // only the part read over all of it. The pipeline refuses instead.
        current.spanTruncated = Boolean(sel.truncated);
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

  ensureOverlay();
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
  status.set({ live: false });   // the microphone is closed; the model is writing
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
          spanTruncated: current.spanTruncated,
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
            keepHistory(current, event.text, 'copied');
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
          keepHistory(current, event.text, 'copied');
          send('session:error', {
            message: result.copied
              ? 'Copied — press ' + (MAC ? '⌘V' : 'Ctrl+V') + ' to paste'
              : 'Could not paste — ' + result.reason
          });
          break;
        }

        keepHistory(current, event.text, 'pasted');
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
  status.set({ live: false });
  hotkeys.releaseWork();
  passThrough();
  send('session:cancel', {});
}

/** A short note in the pill between sessions -- a learned word, or the first-run hello. */
function note(message, ms) {
  if (session || !overlay) return;
  ensureOverlay();
  positionOverlay(overlay);
  passThrough();
  showOverlay(overlay);
  send('session:note', { message, ms });
}

/* --------------------------------------------------------------------- tray */

function keyInfo() {
  const b = hotkeys ? hotkeys.name : settings.get('hotkey');
  return {
    label: hotkeyLogic.label(b, process.platform),
    short: hotkeyLogic.shortLabel(b, process.platform),
    verb: hotkeyLogic.verb(b, process.platform)
  };
}
status.useKey(keyInfo);

/** A click on the tray's status line: whatever fixes what it says. */
function statusAction(id) {
  if (id === 'hotkey') return home.open('settings', { capture: true });
  if (id === 'retry') return warmModel();
  if (id === 'privacy') {
    if (MAC) return require('./permissions-mac').openPane('microphone');
    return require('electron').shell.openExternal('ms-settings:privacy-microphone').catch(() => {});
  }
  if (id === 'permissions') return home.open('home');
}

const trayUi = createTray({
  open: (section, opts) => home.open(section, opts),
  copy: (text) => inject.copy(text),
  updateLine: () => appUpdate.line(),
  updateAction: () => require('electron').shell.openExternal(appUpdate.DOWNLOAD_PAGE).catch(() => {}),
  statusAction,
  forget: (term) => forget(term),
  modelLine: () => modelUpdate.line(),
  quit: () => quit('the tray menu (Quit Typd)')
});

const refreshTray = () => trayUi.refresh();

function remember(text) {
  trayUi.remember(text);
}

/**
 * A correction was learned. Say so once, quietly, and only between sessions --
 * the pill is never interrupted mid-dictation for this.
 */
function learned({ term }) {
  trayUi.learned(term);
  home.changed('dictionary');
  note(`Learned “${term}”`);
}

function forget(term) {
  dictionary.remove(term);
  trayUi.forgotten(term);
  home.changed('dictionary');
}

/* ------------------------------------------------------------- model, mic */

function warmModel() {
  if (stub) { status.set({ model: 'ready' }); return; }
  status.set({ model: 'loading', modelWhy: '' });
  Promise.resolve(pipeline.warm()).then(() => {
    status.set({ model: 'ready' });
    if (firstRunNote) {
      const k = keyInfo();
      note('Ready — ' + k.verb + ' ' + k.short + ' and talk', 10000);
    }
  }, (err) => {
    status.set({ model: 'failed', modelWhy: String((err && err.message) || '') });
  });
}

/**
 * A downloaded model is ready (modelUpdate.js, which only calls this with no session open):
 * restart the model server on it. The tray says "Getting ready…" for the few seconds it takes;
 * a dictation begun meanwhile waits for the new server.
 */
function switchModel() {
  status.set({ model: 'loading', modelWhy: '' });
  return Promise.resolve(pipeline.switchModel()).then(() => {
    status.set({ model: 'ready' });
  }, (err) => {
    status.set({ model: 'failed', modelWhy: String((err && err.message) || '') });
    throw err;
  });
}

/* -------------------------------------------------------------- app updates */

let appUpdater = null;

/** Leave so appUpdate.js's helper can swap the app; forced if anything holds the quit up. */
function quitForUpdate() {
  const t = setTimeout(() => app.exit(0), 8000);
  if (t.unref) t.unref();
  app.quit();
}

/**
 * Packaged builds only (appUpdate.js). Started as soon as the overlay exists, so the first start
 * of a just-installed version says at once that it is alive; its verdict follows the overlay's
 * page and the model's start-up self-test, and a failure hands the helper back the old version.
 */
function startAppUpdate() {
  const { BrowserWindow } = require('electron');
  const visible = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible());
  const asking = () => MAC && require('./permissions-mac').isAsking();
  const local = require('./pipeline/local');
  const away = () => { try { return powerMonitor.getSystemIdleTime() >= 1800; } catch { return false; } };
  appUpdater = appUpdate.start({
    // Never while dictating; not while a Typd window is open, unless nobody has touched the
    // computer for half an hour (a window left open must not hold updates back for days).
    busy: () => Boolean(session) || (visible().length > 0 && !away()),
    onWarm: local.onWarm,
    changed: () => refreshTray(),
    quit: quitForUpdate,
    reportExtra: () => ({ windows: visible().map((w) => w.getTitle() || 'untitled'), dock: MAC && app.dock ? app.dock.isVisible() : null, tray: Boolean(trayUi.tray), asking: asking() })
  });
  if (!appUpdater) return;
  // "Updated to x": the tray says it; on Windows the pill too, briefly. A Mac relaunch shows nothing.
  appUpdater.onUpdated(({ to }) => { if (!MAC) note('Updated to ' + to, 4000); refreshTray(); });
  if (!appUpdater.firstStart) return;
  let loaded = false, warm = null;
  const decide = () => {
    if (!loaded || !warm) return;
    appUpdater.settle({ windowOk: true, modelOk: warm.ok, why: warm.ok ? '' : String((warm.error && warm.error.message) || '') })
      .then((v) => { if (v === 'failed') setTimeout(() => { pipeline.stop(); app.exit(1); }, 500); });
  };
  overlay.webContents.once('did-finish-load', () => { loaded = true; decide(); });
  local.onWarm((r) => { if (!warm) { warm = r; decide(); } });
}

/**
 * Windows: is the microphone switched off for desktop apps in Privacy settings? Read
 * without opening it. A blocked microphone is the one launch-time problem that opens the
 * window unasked, on the row that fixes it -- Typd cannot work, and a hidden tray icon
 * cannot say so (ROADMAP, Law 2). macOS asks through permissions-mac.js instead.
 */
function checkMic(openIfBlocked) {
  if (MAC) return;
  let state = 'unknown';
  try { state = systemPreferences.getMediaAccessStatus('microphone'); } catch { /* older Windows */ }
  const blocked = state === 'denied';
  status.set({ mic: blocked ? 'blocked' : 'ok' });
  if (blocked && openIfBlocked) home.open('settings');
}

/** macOS: which of the switches Typd needs are off, for the tray line and Home's card. */
function checkMacPermissions() {
  if (!MAC) return;
  require('./permissions-mac').status().then((on) => {
    const off = ['microphone', 'accessibility', 'input'].filter((k) => on && on[k] === false);
    status.set({ perms: off });
  }).catch(() => {});
}

/* -------------------------------------------------------------------- start */

app.whenReady().then(() => {
  if (!primary) return;   // the second copy is on its way out (see requestSingleInstanceLock)

  // macOS: a menu-bar utility -- no Dock icon, no app menu, not in the app switcher -- unless
  // "Show Typd in the Dock" is on. Before the overlay exists, so it is created as the window
  // it will stay. The Typd window brings the Dock icon back while it is open (syncDock).
  home.syncDock();

  // The windows follow the system's light or dark theme. The pill does not: it keeps the
  // dark palette it has always had, pinned in overlay.html (data-scheme), because it sits
  // over other people's windows and a bright pill is the more intrusive of the two.
  nativeTheme.themeSource = 'system';

  // The overlay needs the mic for its level meter, and the Typd window for its own. Grant
  // that and deny the rest -- an always-on-top window should have the narrowest surface
  // possible. The check handler lets the overlay read device names for the tray's
  // Microphone menu.
  electronSession.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media' || permission === 'audioCapture');
  });
  electronSession.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media');

  firstRunNote = settings.isFirstRun();

  overlay = createOverlayWindow({ dev });
  overlay.webContents.on('did-finish-load', markRendererReady);
  if (!stub) startAppUpdate();

  // Warm the injector during launch so the first paste does not pay the ~450 ms
  // shell start, and the speech model so the first dictation does not pay for
  // loading it.
  inject.start();
  if (!stub) {
    // Before the first warm start, so a switch that never got its first good start is
    // judged by this one (and reverted if it fails).
    const local = require('./pipeline/local');
    modelUpdate.start({
      bundledDir: local.BUNDLED_DIR,
      busy: () => Boolean(session),
      switchModel,
      onWarm: local.onWarm,
      changed: () => refreshTray()
    });
  }
  warmModel();
  if (!stub && pipeline.ENGINE === 'cascade' && !process.env.POOLSIDE_API_KEY) {
    // With the single local model, dictation needs no key at all; only the old cascade
    // engine calls the cloud for everything.
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

  // Windows: side buttons come from the injector's mouse hook, which swallows them so Back
  // does not also go back in the app underneath (inject.ps1). Null where there is none.
  const buttons = !MAC && typeof inject.buttons === 'function' ? inject.buttons() : null;

  const bindHotkeys = (binding) => registerHotkeys({
    onPress: () => beginSession(),
    onRelease: endSession,
    onCancel: cancelSession,
    onAltDown: () => inject.maskAlt(),
    binding,
    // With the Typd window in front, the key answers "heard it" there instead of starting a
    // dictation that would have nowhere to land -- the key picker's check, and any time.
    intercept: () => {
      if (session || !home.isFocused()) return false;
      home.heard();
      return true;
    },
    buttons
  });

  const keyFailed = () => {
    const failed = hotkeys.failed.length > 0;
    status.set({ key: failed ? 'failed' : 'ok', keyWhy: failed ? hotkeys.reason : '' });
  };

  hotkeys = bindHotkeys(settings.get('hotkey'));
  keyFailed();

  /**
   * Swap the live key. The old one is closed first (one hook, one shortcut); if the new
   * one will not arm, the old one comes back and the reason goes to the page.
   */
  const applyHotkey = (binding) => {
    if (session) return { ok: false, reason: 'Finish the dictation first.' };
    const previous = hotkeys.name;
    hotkeys.close();
    const next = bindHotkeys(binding);
    if (next.failed.length) {
      next.close();
      hotkeys = bindHotkeys(previous);
      keyFailed();
      return { ok: false, reason: next.reason || "Typd couldn't use that key." };
    }
    hotkeys = next;
    keyFailed();
    refreshTray();
    return { ok: true };
  };

  home.register({
    hotkey: () => (hotkeys ? hotkeys.name : settings.get('hotkey')),
    applyHotkey,
    pauseHotkey: (on) => { if (hotkeys && hotkeys.pause) hotkeys.pause(on); },
    hotkeyChanged: () => status.touch(),
    sideButtons: () => Boolean(buttons),
    model: () => ({ name: require('path').basename(require('./pipeline/local').MODEL).replace(/\.gguf$/i, '') }),
    copy: (text) => inject.copy(text),
    retryModel: warmModel,
    historyChanged: () => refreshTray(),
    wordRemoved: (term) => trayUi.forgotten(term)
  });

  settings.onChange((key) => {
    if (key === 'sounds' || key === 'mic' || key === 'micLabel') send('settings:changed', { sounds: settings.get('sounds'), mic: settings.get('mic'), micLabel: settings.get('micLabel') });
    if (key === 'mic') refreshTray();
    if (key === 'showInDock') home.syncDock();
  });

  // Launching Typd again (Start, Windows search) while it runs opens the window: the tray
  // icon may be hidden by Windows, and "I opened it and nothing happened" must never be the
  // answer.
  app.on('second-instance', () => home.open('home'));

  // After sleep or a lock screen the keyboard hook may be gone without a word; put it back.
  // A beat later, so the desktop session is fully back first.
  for (const ev of ['resume', 'unlock-screen']) {
    powerMonitor.on(ev, () => setTimeout(() => { hotkeys.rearm(); checkMic(false); }, 1500));
  }

  trayUi.build();

  // First run: start at login is on by default, so make it so -- the installed app's own
  // login entry, or the Startup shortcut when run from source.
  if (firstRunNote && !MAC && settings.get('startAtLogin') && !home.loginItem()) home.setLoginItem(true);
  checkMic(true);

  // A chosen mark (brand.js) is drawn once in a hidden page; the tray picks it up when ready.
  brand.prepare(MAC ? [18, 36] : [16, 20, 24, 32]).then((ok) => { if (ok) trayUi.redraw(); });

  // macOS: microphone, Accessibility and Input Monitoring are asked for together, in one
  // dialog, and again whenever one goes missing (permissions-mac.js). Open at login is the
  // system's own login item, added on the first run of the installed app.
  if (MAC) {
    // After a quiet update relaunch the dialog waits until someone is at the keyboard (a new
    // ad-hoc build is a new app to macOS, so its switches may need turning on again).
    const askPermissions = () => require('./permissions-mac').ensure('startup').then(checkMacPermissions);
    if (appUpdater && appUpdater.firstStart) { checkMacPermissions(); appUpdate.whenUserActive(askPermissions); } else askPermissions();
    require('./mac/login-item').sync(settings.get('startAtLogin'));
    setInterval(checkMacPermissions, 15000);
  }

  // macOS: a click on the Dock icon, or opening Typd again from Finder, Spotlight or
  // Launchpad while it runs -- the way to reach it when the menu bar hides its icon behind
  // the notch -- opens the window, as a second launch does on Windows. The overlay is made
  // again first if it is gone. The one handler for 'activate'; not in the first seconds,
  // when macOS can send one as Typd launches.
  const launched = Date.now();
  app.on('activate', () => {
    ensureOverlay();
    if (Date.now() - launched > 3000) home.open('home');
  });

  if (preview) {
    // The pill is pinned dark (overlay.html); TYPD_PREVIEW_THEME=light shows its light palette.
    if (process.env.TYPD_PREVIEW_THEME) {
      overlay.webContents.once('did-finish-load', () => {
        overlay.webContents.executeJavaScript(
          'document.documentElement.dataset.scheme = ' + JSON.stringify(process.env.TYPD_PREVIEW_THEME === 'light' ? 'light' : 'dark')
        ).catch(() => {});
      });
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

  // The input devices, from the overlay (it already holds microphone permission), for the
  // tray's Microphone menu. Sent at load and whenever a device comes or goes.
  ipcMain.on('overlay:devices', (e, list) => {
    if (!overlay || e.sender !== overlay.webContents || !Array.isArray(list)) return;
    const devices = list
      .filter((d) => d && typeof d.deviceId === 'string' && d.deviceId.length <= 256)
      .slice(0, 32)
      .map((d) => ({ deviceId: d.deviceId, label: String(d.label || '').slice(0, 120) }));
    trayUi.setDevices(devices);
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
    status.set({ live: false });
    passThrough();
    checkMic(false);
    const blocked = status.get().mic === 'blocked';
    send('session:error', {
      message: blocked ? 'Mic blocked by ' + (MAC ? 'macOS' : 'Windows') + ' privacy'
        : kind === 'silent' ? 'Mic silent — check mute or privacy' : 'No microphone — check Settings'
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

  if (process.env.TYPD_TEST_CLOSE_HOME) testCloseHome(process.env.TYPD_TEST_CLOSE_HOME);
});

/*
 * CI only (mac.yml, "Close the Typd window, stay running"). TYPD_TEST_CLOSE_HOME=<file>: open
 * the Typd window 5 s after launch, close it 3 s after it shows with win.close() -- the close
 * button's own path -- and from 10 s after that write <file> once a second: the pid, "alive",
 * and whether the key is still heard. Nothing here runs without the variable.
 */
function testCloseHome(file) {
  const { BrowserWindow } = require('electron');
  const heard = () => (hotkeys ? hotkeys.keysHeard : 0);
  let atOpen = 0, atClose = 0, closedAt = 0, last = 0, late = 0;
  const write = () => {
    // How late this 1 s timer fires: App Nap, among others, coalesces a background app's timers.
    const now = Date.now();
    if (last) late = Math.max(late, now - last - 1000);
    last = now;
    const lines = [
      'pid: ' + process.pid,
      'alive',
      'window: closed ' + Math.round((Date.now() - closedAt) / 1000) + ' s ago' + (home.isOpen() ? ', but still open' : ''),
      'hotkey: ' + (hotkeys ? hotkeys.state() : 'none'),
      'keys heard: ' + atOpen + ' before the window opened, ' + (atClose - atOpen) + ' while open, ' + (heard() - atClose) + ' since it closed',
      'dictation: ' + (session ? session.mode + ', open' : 'none open'),
      'dock: ' + (app.dock ? (app.dock.isVisible() ? 'shown' : 'hidden') : 'none'),
      'overlay: ' + (overlay && !overlay.isDestroyed() ? 'alive' : 'gone') + ', windows: ' + BrowserWindow.getAllWindows().length,
      'timer: up to ' + late + ' ms late'
    ];
    try { require('fs').writeFileSync(file, lines.join('\n') + '\n'); } catch (err) { console.log('[typd:test]', err.message); }
  };
  setTimeout(() => {
    atOpen = heard();
    home.open('home');
    const opened = Date.now();
    const waitShown = setInterval(() => {
      const shown = BrowserWindow.getAllWindows().some((w) => w !== overlay && w.isVisible());
      if (!shown && Date.now() - opened < 15000) return;
      clearInterval(waitShown);
      setTimeout(() => {
        atClose = heard();
        closedAt = Date.now();
        console.log('[typd:test] closing the Typd window; ' + (hotkeys ? hotkeys.state() : 'no hotkey'));
        home.close();
        setTimeout(() => { write(); setInterval(write, 1000); }, 10000);
      }, 3000);
    }, 250);
  }, 5000);
}

app.on('will-quit', () => {
  debugLife('will-quit');
  if (hotkeys) hotkeys.close();
  stopHook();
  inject.stop();
  pipeline.stop();
});

// A dictation overlay is a background utility. Closing its only window is not a
// reason to exit -- it lives in the tray until asked to leave.
app.on('window-all-closed', (e) => e.preventDefault());

// Anything that dies under Typd, for the log: a renderer (the pill, the window) or a helper
// process Electron runs (GPU, audio, network).
app.on('render-process-gone', (_e, wc, d) => debugLife('a renderer is gone:', d && d.reason, d && d.exitCode));
app.on('child-process-gone', (_e, d) => debugLife('a ' + (d && d.type) + ' process is gone:', d && d.reason, d && d.exitCode));
