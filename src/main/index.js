'use strict';

const {
  app, ipcMain, nativeTheme, dialog, powerMonitor, systemPreferences,
  session: electronSession
} = require('electron');

const { createOverlayWindow, positionOverlay, showOverlay, releaseClicks } = require('./overlay-window');
const { registerHotkeys, registerFlagHotkey, stopHook } = require('./hotkeys');
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
const sharing = require('./sharing');   // public builds: on unless turned off in Settings; tester builds: their key
const ask = require('./ask-window');    // the "That was wrong" window
const modelUpdate = require('./modelUpdate');   // every packaged build (no key: the public routes) and the developer's machines
const appUpdate = require('./appUpdate');       // packaged builds: a newer signed Typd, installed while you are away
const netcost = require('./netcost');           // a metered connection: big model downloads ask first

// Which published model this machine follows (Settings: Automatic / Full / Light; hardware.js).
const choice = require('./modelChoice').createChoice({
  setting: () => settings.get('modelVariant'),
  detect: () => require('./hardware').detect({ gpuInfo: () => app.getGPUInfo('basic') })
});

const MAC = process.platform === 'darwin';

/*
 * A crash leaves a minidump on this computer: crashReporter, local only -- nothing is uploaded
 * (no URL, uploadToServer false). The life log (lifelog.js) names any dump a run left behind when
 * it ended without quitting, and the tray's "Copy diagnostics" lists them.
 */
try {
  require('electron').crashReporter.start({ uploadToServer: false, compress: false });
} catch (err) {
  console.log('[typd] crash reporter:', err && err.message);
}
const life = require('./lifelog');

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
      ms: current.endedAt ? (current.textAt || Date.now()) - current.endedAt : null,   // stop -> text ready
      model: path.basename(require('./pipeline/local').MODEL),
      app: current.target ? current.target.process : null,
      context: current.contextBlock || null,
      span: current.span || null,
      // A revision the guards refused (never pasted): why. Absent on everything that landed.
      ...(current.guard ? { guard: current.guard } : {})
    };
    fs.writeFileSync(path.join(dir, stamp + '.json'), JSON.stringify(meta, null, 1));
  } catch (err) {
    if (process.env.TYPD_DEBUG) console.log('[typd:keep]', err);
  }
}

/**
 * One line per dictation in the life log (lifelog.dictationLine): how long the key's release took
 * to become text and the text to become a paste, on which model and which device. Counts only:
 * never the text, the app or the context.
 */
function logDictation(current, chars, result, pastedAt) {
  try {
    const local = stub ? null : require('./pipeline/local');
    let model = 'stub';
    if (local) { try { model = local.modelVersion(); } catch { model = 'unknown'; } }
    let device = null, lowMemory = null;
    // local.device ('GPU' | 'CPU' | null) and local.lowMemory ({on}) arrive with 0.2.6's local.js;
    // read so that a local.js without them logs "device unknown".
    if (local) { try { device = local.device || null; lowMemory = local.lowMemory || null; } catch { /* older local.js */ } }
    const audio = current.audio;
    life.log('dictation', life.dictationLine({
      mode: current.mode,
      audioSeconds: audio && audio.samples ? audio.samples.length / (audio.sampleRate || 16000) : null,
      chars,
      releaseToTextMs: current.endedAt && current.textAt ? current.textAt - current.endedAt : null,
      textToPasteMs: current.textAt ? pastedAt - current.textAt : null,
      outcome: result && result.ok ? 'pasted' : 'copied',
      model,
      device,
      lowMemory: lowMemory ? Boolean(lowMemory.on) : null
    }));
  } catch (err) {
    if (process.env.TYPD_DEBUG) console.log('[typd:life]', err);
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
let flagKey = null;         // "That was wrong" (registerFlagHotkey); null when sharing is not in this build
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
app.on('before-quit', () => {
  debugLife('before-quit, asked by ' + (quitBy || 'macOS or a signal (⌘Q, the Dock, logout, kill)'));
  life.log('quit asked', 'by ' + (quitBy || 'macOS or a signal (Cmd-Q, the Dock, logout, kill)'));
});
app.on('quit', (_e, code) => life.ended('quit, exit code ' + code));
process.on('exit', (code) => { debugLife('process exit, code ' + code); life.ended('process exit, code ' + code); });

// Two copies fighting over one global hotkey is a confusing failure that looks
// like the hotkey is simply broken. The second copy quits at once and does nothing
// else on the way out (whenReady below checks `primary`); the first opens its window.
const primary = app.requestSingleInstanceLock();
if (!primary) {
  quit('a second copy of Typd (the first keeps running)');
} else {
  // The life log (lifelog.js) belongs to the copy that runs: a second copy would report the first
  // as lost and take its run marker.
  const via = process.env.__CFBundleIdentifier;
  life.init(app.getPath('userData'), {
    crashDumps: (() => { try { return app.getPath('crashDumps'); } catch { return null; } })(),
    info: 'Typd ' + app.getVersion() + (app.isPackaged ? '' : ' (from source)') + ', Electron ' + process.versions.electron + ', ' +
      process.platform + ' ' + require('os').release() + ' ' + process.arch + (MAC ? ', macOS ' + process.getSystemVersion() : '') +
      ', started ' + (via === 'ai.typd.app' ? 'by macOS (LaunchServices)' : via ? 'from ' + via : 'directly') +
      (process.argv.some((a) => a === '--stub' || a === '--preview' || a === '--dev') ? ', ' + process.argv.filter((a) => /^--(stub|preview|dev)$/.test(a)).join(' ') : '')
  });
  // Errors nobody caught, for the log: one line each, nothing quoted (lifelog.errorLine).
  process.on('uncaughtExceptionMonitor', (err) => life.log('uncaught exception', life.errorLine(err)));
  process.on('unhandledRejection', (reason) => {
    life.log('unhandled rejection', life.errorLine(reason));
    if (process.env.TYPD_DEBUG) console.log('[typd] unhandled rejection:', reason);
  });
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

/**
 * Restore full click-through. Anything else leaves a dead rectangle on screen. Through the click
 * gate (overlay-window.js), and never with `forward`: that installs a global mouse hook on this
 * thread, the 0.2.5 dead-buttons bug.
 */
function passThrough() {
  releaseClicks(overlay);
}

/* ------------------------------------------------------------------ session */

/** "notepad" -> "Notepad". Process names are lowercase far too often to trust. */
function appLabel(focus) {
  if (!focus || !focus.process) return null;
  return focus.process.charAt(0).toUpperCase() + focus.process.slice(1);
}

function beginSession() {
  // No speech model yet (a public install's first launch: modelUpdate.js is downloading it). The key
  // says how far that is, in the pill, and nothing is recorded: no error, no dialog.
  if (!session && modelMissing()) {
    note(status.describe().line, 6000);
    return;
  }
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
        // Whether the revise adapter ran on this request (pipeline/index.js): a shared item records it.
        current.reviseAdapter = event.reviseAdapter || false;
        current.textAt = Date.now();   // the text is ready (logDictation: release-to-text, text-to-paste)
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

        // The paste first: the WAV encode and write (Keep recordings is on by default) and the
        // tray menu rebuild used to run between the text being ready and Ctrl+V. The files wait a
        // tick more, so the pill's "done" does not wait on them either.
        const result = await inject.paste(event.text);
        const pastedAt = Date.now(), text = event.text;
        remember(text);
        setImmediate(() => { keepRecording(current, text); logDictation(current, text.length, result, pastedAt); });
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
        // Kept in memory as the last dictation (for "That was wrong"), and queued for the
        // developer unless this person turned sharing off, or as a tester build's (sharing.js).
        // Only after the paste has landed, never awaited, and never the screen context or span.
        sharing.add(current, event.text);
        refreshTray();
        continue;
      }

      // A revision the guards stopped (pipeline/guards.js): nothing is pasted and the selection
      // stays as it was. Kept with the recording (marked) so the failures can be studied; a
      // deletion's result goes to the clipboard in case it was wanted after all.
      if (event.type === 'refused') {
        current.guard = event.reason;
        keepRecording(current, event.text);
        if (event.copy) {
          remember(event.text);
          keepHistory(current, event.text, 'copied');
          await inject.copy(event.text);
          if (session !== current) return;
        }
        send('session:error', { message: event.message });
        break;
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
  if (id === 'hotkey') return home.open('settings', { capture: true, by: 'the menu bar status line' });
  if (id === 'retry') { if (modelMissing()) { modelUpdate.recheck(0); return null; } return warmModel(); }
  if (id === 'model-now') return modelUpdate.approve().catch(() => {});
  if (id === 'privacy') {
    if (MAC) return require('./permissions-mac').openPane('microphone');
    return require('electron').shell.openExternal('ms-settings:privacy-microphone').catch(() => {});
  }
  if (id === 'permissions') return home.open('home', { by: 'the menu bar status line' });
}

const trayUi = createTray({
  open: (section, opts) => home.open(section, { ...(opts || {}), by: 'the menu bar menu' }),
  copy: (text) => inject.copy(text),
  updateLine: () => appUpdate.line(),
  updateAction: () => require('electron').shell.openExternal(appUpdate.DOWNLOAD_PAGE).catch(() => {}),
  statusAction,
  forget: (term) => forget(term),
  modelLine: () => modelUpdate.line(),
  packLine: () => modelUpdate.packLine(),
  // "Check for updates": both updaters look now; the answer shows in Settings (its Updates line).
  checkUpdates: () => { checkForUpdates('the tray menu').catch(() => {}); home.open('settings', { updates: true, by: 'Check for updates' }); },
  modelPrompt: () => modelUpdate.pending(),
  modelNow: () => { modelUpdate.approve().catch(() => {}); },
  modelLater: () => { modelUpdate.later().catch(() => {}); },
  flag: () => openFlag(),
  canFlag: () => {
    const s = sharing.get();
    return s ? (s.lastInfo() ? 'ready' : 'none') : null;
  },
  flagKey: () => (flagKey && flagKey.binding) || null,
  quit: () => quit('the tray menu (Quit Typd)'),
  diagnostics: () => copyDiagnostics()
});

const refreshTray = () => trayUi.refresh();

/**
 * The tray's "Copy diagnostics": what a tester can send when Typd misbehaves. A few lines on this
 * Typd and its state, then the life log's last 200 lines (lifelog.js). No dictated text, screen
 * context, selection or window title is in either; minidumps are named, never attached.
 */
function diagnosticsText() {
  const { BrowserWindow, systemPreferences: sp } = require('electron');
  const safe = (fn) => { try { return fn(); } catch (err) { return 'unknown (' + life.clean(err && err.message, 60) + ')'; } };
  const s = status.get();
  const dumps = life.dumps();
  const lines = [
    'Typd diagnostics, ' + new Date().toISOString() + ' (no dictation text in here)',
    'Typd ' + app.getVersion() + (app.isPackaged ? '' : ' (from source)') + ', Electron ' + process.versions.electron + ', ' +
      process.platform + ' ' + require('os').release() + ' ' + process.arch + (MAC ? ', macOS ' + safe(() => process.getSystemVersion()) : ''),
    'running ' + Math.round(process.uptime()) + ' s, pid ' + process.pid,
    'key: ' + (hotkeys ? hotkeys.state() : 'none') + (hotkeys && hotkeys.health ? ', tap ' + safe(() => JSON.stringify(hotkeys.health())) : ''),
    'status: ' + safe(() => status.describe().line) + '; model ' + s.model + (s.perms && s.perms.length ? '; switches off: ' + s.perms.join(', ') : ''),
    ...(MAC ? ['accessibility trusted: ' + safe(() => sp.isTrustedAccessibilityClient(false)) + ', microphone: ' + safe(() => sp.getMediaAccessStatus('microphone')),
      'Dock icon: ' + safe(() => (app.dock.isVisible() ? 'shown' : 'hidden')) + ' (Show Typd in the Dock ' + (settings.get('showInDock') ? 'on' : 'off') + ')'] : []),
    'menu-bar/tray icon: ' + (trayUi.tray && !trayUi.tray.isDestroyed() ? 'yes' : 'no') + ', windows: ' + BrowserWindow.getAllWindows().length +
      ', Typd window ' + (home.isOpen() ? 'open' : 'closed') + ', pill ' + (overlay && !overlay.isDestroyed() ? 'alive' : 'gone'),
    'model file: ' + safe(() => require('path').basename(require('./pipeline/local').MODEL)),
    'minidumps: ' + (dumps.length ? dumps.length + ', newest ' + dumps.slice(0, 3).map((d) => d.name + ' ' + d.at).join('; ') : 'none'),
    '--- life log, last 200 lines',
    ...life.tail(200)
  ];
  return lines.join('\n') + '\n';
}

function copyDiagnostics() {
  try {
    require('electron').clipboard.writeText(diagnosticsText());
    life.log('diagnostics copied');
    note('Diagnostics copied — paste them into a message', 5000);
  } catch (err) {
    life.log('diagnostics failed', life.errorLine(err));
  }
}

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

/* ------------------------------------------------------------- sharing */

/**
 * "That was wrong" (the tray item, or the flag shortcut): opens the small window on the last
 * dictation. Never while a dictation is running -- the flag is for the one that landed.
 */
function openFlag() {
  const s = sharing.get();
  if (!s || session) return;
  if (!s.lastInfo()) { note('Nothing to flag yet'); return; }
  ask.open('flag');
}

/** Settings switched sharing on or off. */
async function chooseSharing(share) {
  const s = sharing.get();
  if (!s) return { ok: false };
  const r = await s.choose(share ? 'on' : 'off');
  home.changed('sharing');
  return r;
}

ask.register({
  sharing: () => sharing.get(),
  flagged: (r) => {
    if (r.state === 'flagged') note(r.how === 'shared' ? 'Shared to fix it — thank you' : 'Flagged — thank you');
  }
});

/* ------------------------------------------------------------- model, mic */

function warmModel() {
  if (stub) { status.set({ model: 'ready' }); return; }
  // A model-less install before its first model: nothing to start. The download (modelUpdate.js)
  // calls switchModel() once the model is here.
  if (modelMissing()) return;
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
  const first = status.get().model === 'missing';
  status.set({ model: 'loading', modelWhy: '', modelFetch: null });
  return Promise.resolve(pipeline.switchModel()).then(() => {
    status.set({ model: 'ready' });
    // The first model of a model-less install: say once that Typd can dictate now.
    if (first) { const k = keyInfo(); note('Ready — ' + k.verb + ' ' + k.short + ' and talk', 10000); }
  }, (err) => {
    status.set({ model: 'failed', modelWhy: String((err && err.message) || '') });
    throw err;
  });
}

/**
 * The CUDA pack has just been installed (or set aside): restart the model server so it runs on what is
 * there now (modelUpdate.js calls this only with no session open). The same few seconds of "Getting
 * ready…" as a model switch; no app restart. A failure is the updater's to handle: it sets the pack
 * aside and calls this once more, on the processor.
 */
function switchBackend() {
  status.set({ model: 'loading', modelWhy: '' });
  return Promise.resolve(pipeline.switchModel()).then(() => {
    status.set({ model: 'ready' });
  }, (err) => {
    status.set({ model: 'failed', modelWhy: String((err && err.message) || '') });
    throw err;
  });
}

/* ------------------------------------------------------- check for updates */

/*
 * "Check for updates" (the tray menu, Settings): the app and the model updaters look now (each resolves
 * as soon as it has read its manifest; a new version then downloads at full speed), and the answer
 * shows in Typd's own window -- Settings' Updates line, under the version -- never in an OS dialog:
 * up to date (with the versions), downloading with its progress, ready ("installs the next time you're
 * away", with Restart now), offline, or could not check. updatesInfo() reads the updaters' live state
 * each time, so progress moves while the window is open (home.changed('updates')).
 */
let updatesUi = { checking: false, app: null, model: null, at: null };

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => { const t = setTimeout(() => r({ outcome: 'error', why: 'no answer' }), ms); if (t.unref) t.unref(); })]);

async function checkForUpdates(by) {
  if (updatesUi.checking) return updatesInfo();
  updatesUi = { ...updatesUi, checking: true };
  life.log('updates', 'check for updates, from ' + (by || 'Settings'));
  home.changed('updates');
  const safe = (p) => withTimeout(Promise.resolve(p), 45000).catch((e) => ({ outcome: 'error', why: String((e && e.message) || e) }));
  const [a, m] = await Promise.all([appUpdater ? safe(appUpdater.checkNow()) : { outcome: 'off' }, safe(modelUpdate.checkNow())]);
  updatesUi = { checking: false, app: a, model: m, at: new Date().toISOString() };
  refreshTray();
  home.changed('updates');
  return updatesInfo();
}

/** "Restart now": the downloaded Typd installs at once (no dictation in progress); Typd quits for it. */
function restartForUpdate() {
  const ok = Boolean(appUpdater && appUpdater.applyNow());
  if (ok) life.log('updates', 'restart now: installing ' + appUpdater.target);
  return ok;
}

/** For Settings: {versions, text, checking, canRestart, pct}. */
function updatesInfo() {
  const local = require('./pipeline/local');
  let model = '';
  try { model = local.modelVersion(); } catch { model = ''; }
  const ver = app.getVersion();
  const versions = 'Typd ' + ver + (model && model !== 'unknown' ? ' · model ' + model : '');
  const u = appUpdater;
  const pct = (p) => (p && p.total ? Math.floor((100 * p.done) / p.total) : 0);
  let text = '', canRestart = false, progress = null;
  if (u && ['downloading', 'retrying'].includes(u.state)) {
    progress = pct(u.progress);
    text = 'Downloading Typd ' + u.target + '… ' + progress + ' %' + (u.state === 'retrying' ? ' (paused; it goes on by itself)' : '');
  } else if (u && u.state === 'ready') {
    text = 'Typd ' + u.target + ' is ready: it installs the next time you’re away.';
    canRestart = true;
  } else if (u && u.state === 'applying') {
    text = 'Installing Typd ' + u.target + '… Typd restarts in a moment.';
  } else if (u && ['reinstall', 'manual'].includes(u.state)) {
    text = (u.line() || {}).label || 'A new Typd is out.';
  } else if (/· updating \d+ %/.test(modelUpdate.line() || '') || /downloading/.test(modelUpdate.packLine() || '')) {
    const m = /· updating (\d+) %( \(paused\))?/.exec(modelUpdate.line() || '');
    text = m ? 'Downloading the new model… ' + m[1] + ' %' + (m[2] ? ' (paused; it goes on by itself)' : '') : modelUpdate.packLine();
  } else if (updatesUi.checking) {
    text = 'Checking for updates…';
  } else if (updatesUi.at) {
    const o = [updatesUi.app, updatesUi.model].map((x) => (x && x.outcome) || 'error');
    if (o.every((x) => x === 'off')) text = 'Updates are off in this copy of Typd.';
    else if (o.includes('offline')) text = 'Couldn’t check for updates: no internet connection.';
    else if (o.includes('error') || o.includes('busy')) text = 'Couldn’t check for updates right now. Typd tries again by itself.';
    else if (updatesUi.model && updatesUi.model.outcome === 'ask') text = 'A new ' + (updatesUi.model.what === 'pack' ? 'GPU acceleration download' : 'model') + ' (' + updatesUi.model.size + ') is waiting for your OK above.';
    else if (o.includes('downloading')) text = 'Downloading…';
    else text = 'Typd is up to date (' + ver + (model && model !== 'unknown' ? ', model ' + model : '') + ').';
  }
  return { versions, text, checking: updatesUi.checking, canRestart, progress, at: updatesUi.at, enabled: Boolean(u) || modelUpdate.following() };
}

/* ------------------------------------------------------------ walkthrough */

/**
 * The first-run walkthrough (renderer/home.js: what Typd is, a dictation, a revision, "That was
 * wrong", done; under a minute, skippable) is due once, on a fresh install (settings 'walkthrough'
 * 'due': settings.walkthroughFor), in a packaged build. Never after an update. Never with
 * --stub or --preview, TYPD_NO_WALKTHROUGH=1, or the CI's window tests (TYPD_TEST_CLOSE_HOME;
 * TYPD_TEST_LIFE but for its "watch" pass, which checks exactly this rule); from source only with
 * TYPD_WALKTHROUGH=1. Settings opens it again any time.
 */
function walkthroughDue() {
  if (stub || preview || process.env.TYPD_NO_WALKTHROUGH === '1' || process.env.TYPD_TEST_CLOSE_HOME || (process.env.TYPD_TEST_LIFE && process.env.TYPD_TEST_LIFE_HOW !== 'watch')) return false;
  if (!app.isPackaged && process.env.TYPD_WALKTHROUGH !== '1') return false;
  return settings.get('walkthrough') === 'due';
}

/**
 * Show it when it is due: a few seconds after a fresh install's first launch, one question at a
 * time (it waits while the Mac permission dialog is open). Never after an app update, and never
 * on an install that ran Typd before. It counts as shown once it opens: closing it early does not
 * bring it back. Its first screen says, in a public build with sharing on, that
 * dictations are shared to train the model and that Settings turns it off (renderer/home.js).
 */
function startWalkthrough(afterUpdate) {
  // Fresh installs only, never after an update (the user's rule since 0.2.4): settings.js says
  // 'due' for a fresh install's first launch and 'done' for any install that ran Typd before
  // (walkthroughFor). TYPD_WALKTHROUGH=1 makes it due anyway, to look at it from source.
  const now = process.env.TYPD_WALKTHROUGH === '1' ? 'due'
    : settings.walkthroughFor({ fresh: settings.isFreshInstall(), afterUpdate: Boolean(afterUpdate) });
  if (now !== settings.get('walkthrough')) {
    settings.set('walkthrough', now);
    life.log('walkthrough', now === 'due' ? 'due: a fresh install' : 'never: an existing install' + (afterUpdate ? ' (an update)' : ''));
  }
  if (!walkthroughDue()) return;
  const show = () => {
    if (!walkthroughDue()) return;
    if (MAC && require('./permissions-mac').isAsking()) { setTimeout(show, 1000); return; }
    settings.set('walkthrough', 'done');
    home.open('home', { walkthrough: true, by: 'the first-run walkthrough' });
  };
  setTimeout(show, 3500);
}

/* ---------------------------------------------- model choice, asking first */

/**
 * The model updater's line changed: the tray, an open Typd window (Settings shows the model), and
 * -- once each time a big download starts waiting for "Update now" -- a quiet note in the pill
 * pointing at the menu that has the two buttons.
 */
let notedAsk = null;
function modelChanged() {
  modelMissing();   // the first model's progress, for the tray's first line and Home
  refreshTray();
  home.changed('model');
  const p = modelUpdate.pending();
  const asking = p && !p.later ? p.version : null;
  if (asking && asking !== notedAsk) note((p.kind === 'pack' ? 'GPU acceleration (' : p.first ? 'Speech model needed (' : 'New model (') + p.size + '): see the menu', 8000);
  notedAsk = asking;
}

/**
 * True while there is no speech model to dictate with (a public installer ships without one, and
 * modelUpdate.js downloads the hardware's pick at the first launch); it then sets the status's
 * 'missing' state with the download's progress. False once a model is loaded, and also while a
 * downloaded first model is only waiting for switchModel() (the status is left as it is).
 */
let missingLogged = null;
function modelMissing() {
  if (stub || require('./pipeline/local').hasModel()) return false;
  const fetch = modelUpdate.needed();
  if (!fetch && modelUpdate.following()) return status.get().model === 'missing';   // downloaded: switching to it
  status.set({ model: 'missing', modelWhy: '', modelFetch: fetch });
  const said = fetch ? fetch.state + ' ' + fetch.size : 'no download (model updates off)';
  if (process.env.TYPD_DEBUG && said !== missingLogged) console.log('[typd:model] no speech model yet:', said);
  missingLogged = said;
  return true;
}

/** For Settings: the model choice, Automatic's answer and why, and a download waiting for an answer. */
async function modelInfo() {
  let d = null;
  try { d = await choice.describe(); } catch { d = null; }
  return { following: modelUpdate.following(), ...(d || {}), chosen: modelUpdate.chosen(), pending: modelUpdate.pending(), line: modelUpdate.line(), needed: modelUpdate.needed(), pack: modelUpdate.packInfo() };
}

/* -------------------------------------------------------------- app updates */

let appUpdater = null;

/** Leave so appUpdate.js's helper can swap the app; forced if anything holds the quit up. */
function quitForUpdate() {
  const t = setTimeout(() => app.exit(0), 8000);
  if (t.unref) t.unref();
  quit('an app update (appUpdate.js)');
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
    // "Restart now" waits only for a dictation in progress, never for the window it was pressed in.
    dictating: () => Boolean(session),
    onWarm: local.onWarm,
    changed: () => { refreshTray(); home.changed('updates'); },
    quit: quitForUpdate,
    // ax: is this Typd trusted for Accessibility (macOS)? The Mac CI's update test grants the old
    // version by its designated requirement and checks the new one inherits it (docs/MAC.md).
    reportExtra: () => ({ windows: visible().map((w) => w.getTitle() || 'untitled'), dock: MAC && app.dock ? app.dock.isVisible() : null, tray: Boolean(trayUi.tray), asking: asking(),
      ax: MAC ? (() => { try { return systemPreferences.isTrustedAccessibilityClient(false); } catch { return null; } })() : null })
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
  // A model-less install whose first model has not arrived yet: no model start will come to wait
  // for (the helper would time out and put the old version back). The window decides; settle()
  // keeps an update when the model was not working before it either (pending.modelOk).
  if (!local.hasModel()) { warm = { ok: false, error: new Error('no speech model yet: it downloads at first launch') }; decide(); }
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
  if (blocked && openIfBlocked) home.open('settings', { by: 'a blocked microphone' });
}

/** macOS: which of the switches Typd needs are off, for the tray line and Home's card. */
function checkMacPermissions() {
  if (!MAC) return;
  require('./permissions-mac').status().then((on) => {
    const off = ['microphone', 'accessibility', 'input'].filter((k) => on && on[k] === false);
    status.set({ perms: off });
  }).catch(() => {});
}

/* ------------------------------------------------------------- watchdogs */

let lastWake = 0;

/**
 * The main thread, timed: a 5 s timer that fires seconds late means the main thread was stuck or
 * napping (App Nap coalesces a background app's timers). On a Mac the key's event tap waits on
 * this thread for every key press, so a stuck main thread is a stuck keyboard. Measured on the
 * monotonic clock, which stops while the computer sleeps; logged at most every 5 minutes, and not
 * around sleep and wake.
 */
function watchMainThread() {
  let last = process.hrtime.bigint(), noted = 0;
  const t = setInterval(() => {
    const now = process.hrtime.bigint();
    const late = Number(now - last) / 1e6 - 5000;
    last = now;
    if (late > 3000 && Date.now() - lastWake > 60000 && Date.now() - noted > 300000) {
      noted = Date.now();
      life.log('main thread late', Math.round(late / 100) / 10 + ' s (a stall, or App Nap)');
    }
  }, 5000);
  if (t.unref) t.unref();
}

/**
 * The key layer's health, every 10 s, into the life log when it changes: the key's state, and on a
 * Mac whether Typd is still trusted for Accessibility and what the event tap's watchdog saw
 * (hotkeys.health(): macOS switched the tap off for a slow answer or for user input and it was
 * switched back on; the tap thread stopped answering).
 */
function watchKeyLayer() {
  let state = null, trusted = null, health = null, stuck = 0;
  const t = setInterval(() => {
    try {
      const st = hotkeys ? hotkeys.state().replace(/, \d+ key events heard$/, '') : 'none';
      if (st !== state) { life.log('key', st); state = st; }
      if (!MAC) return;
      const tr = (() => { try { return systemPreferences.isTrustedAccessibilityClient(false); } catch { return null; } })();
      if (tr !== trusted) { if (trusted !== null || tr === false) life.log('accessibility', tr ? 'trusted' : 'NOT trusted (the key cannot be heard)'); trusted = tr; }
      const h = hotkeys && hotkeys.health ? hotkeys.health() : null;
      if (!h) return;
      if (health) {
        const more = ['timeouts', 'userInput', 'rearmed'].filter((k) => (h[k] || 0) > (health[k] || 0));
        if (more.length) life.log('key tap', 'macOS switched it off and it was switched back on: ' + more.map((k) => k + ' ' + h[k]).join(', '));
        if (h.enabled !== health.enabled) life.log('key tap', h.enabled === 1 ? 'on' : h.enabled === 0 ? 'OFF' : h.enabled === -2 ? 'its port is gone' : 'not running');
        if (h.running && h.checks === health.checks) { if (++stuck === 3) life.log('key tap', 'its thread has not answered for 30 s (stuck?)'); } else stuck = 0;
      }
      health = h;
    } catch (err) {
      life.log('key watch failed', life.errorLine(err));
    }
  }, 10000);
  if (t.unref) t.unref();
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

  // Before anything this launch writes (settings.json, a model download, carried files): is this a
  // fresh install? Only a fresh install gets the first-run walkthrough (startWalkthrough).
  settings.isFreshInstall();
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
      changed: modelChanged,
      // The 1.7B or the 0.6B, by the hardware unless Settings pins one; big downloads ask first
      // on a metered connection, every download with "Ask before downloading new models".
      variant: () => choice.variant(),
      askFirst: () => settings.get('askBeforeModelDownload'),
      networkCost: () => netcost.probe(),
      // Windows public installs (0.2.5+): llama.cpp's CUDA backend, fetched after the model when the
      // hardware takes the GPU path; until then, and on any other PC, llama.cpp runs on the processor.
      cuda: local.cuda,
      cudaWanted: () => choice.cuda(),
      switchBackend
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
    // dictation that would have nowhere to land -- the key picker's check, and any time. The
    // walkthrough's practice box is the exception: there the key dictates, into that box.
    intercept: () => {
      if (session || !home.isFocused() || home.isPracticing()) return false;
      home.heard();
      return true;
    },
    buttons
  });

  const keyFailed = () => {
    const failed = hotkeys.failed.length > 0;
    status.set({ key: failed ? 'failed' : 'ok', keyWhy: failed ? hotkeys.reason : '' });
  };

  // "That was wrong": a second, separate shortcut, only where sharing exists (hotkeys.js). The CI's
  // window checks (TYPD_TEST_LIFE) bind it too, with sharing off: closing the window re-binds it.
  const bindFlag = () => {
    if (flagKey) flagKey.close();
    flagKey = sharing.get() || process.env.TYPD_TEST_LIFE ? registerFlagHotkey(settings.get('flagHotkey'), hotkeys.name, openFlag) : null;
  };

  hotkeys = bindHotkeys(settings.get('hotkey'));
  keyFailed();
  bindFlag();

  /**
   * Swap the live key. The old one is closed first (one hook, one shortcut); if the new
   * one will not arm, the old one comes back and the reason goes to the page.
   */
  const applyHotkey = (binding) => {
    if (session) return { ok: false, reason: 'Finish the dictation first.' };
    if (flagKey && flagKey.binding && String(binding).toLowerCase() === flagKey.binding.toLowerCase()) {
      return { ok: false, reason: flagKey.label + ' is Typd’s “That was wrong” shortcut. Pick another key.' };
    }
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
    bindFlag();
    refreshTray();
    return { ok: true };
  };

  home.register({
    hotkey: () => (hotkeys ? hotkeys.name : settings.get('hotkey')),
    applyHotkey,
    // The key picker listening: the flag shortcut lets go too, so the page can see every key.
    pauseHotkey: (on) => {
      if (hotkeys && hotkeys.pause) hotkeys.pause(on);
      if (on) { if (flagKey) flagKey.close(); } else bindFlag();
    },
    hotkeyChanged: () => status.touch(),
    sideButtons: () => Boolean(buttons),
    model: () => ({ name: require('path').basename(require('./pipeline/local').MODEL).replace(/\.gguf$/i, '') }),
    copy: (text) => inject.copy(text),
    retryModel: warmModel,
    historyChanged: () => refreshTray(),
    wordRemoved: (term) => trayUi.forgotten(term),
    chooseSharing,
    flagKey: () => (flagKey && flagKey.binding) || null,
    modelInfo,
    updatesInfo,
    checkForUpdates: () => checkForUpdates('Settings'),
    restartForUpdate,
    modelNow: () => modelUpdate.approve(),
    modelLater: () => modelUpdate.later(),
    // Automatic / Full / Light, or the asking switch, changed: read the hardware again and check soon.
    modelChanged: () => { choice.forget(); modelUpdate.recheck(); }
  });

  settings.onChange((key) => {
    if (key === 'sounds' || key === 'mic' || key === 'micLabel') send('settings:changed', { sounds: settings.get('sounds'), mic: settings.get('mic'), micLabel: settings.get('micLabel') });
    if (key === 'mic') refreshTray();
    if (key === 'showInDock') home.syncDock();
  });

  // Launching Typd again (Start, Windows search) while it runs opens the window: the tray
  // icon may be hidden by Windows, and "I opened it and nothing happened" must never be the
  // answer.
  app.on('second-instance', () => home.open('home', { by: 'a second launch' }));

  // After sleep or a lock screen the keyboard hook may be gone without a word; put it back.
  // A beat later, so the desktop session is fully back first.
  for (const ev of ['resume', 'unlock-screen']) {
    powerMonitor.on(ev, () => setTimeout(() => { hotkeys.rearm(); checkMic(false); }, 1500));
  }
  for (const ev of ['suspend', 'resume', 'lock-screen', 'unlock-screen']) {
    powerMonitor.on(ev, () => { lastWake = Date.now(); life.log('power', ev); });
  }
  watchMainThread();
  watchKeyLayer();

  trayUi.build();
  life.log('ready', 'menu-bar icon ' + (trayUi.tray ? 'made' : 'missing') + '; key ' + (hotkeys ? hotkeys.state() : 'none') +
    (MAC ? '; Show Typd in the Dock ' + (settings.get('showInDock') ? 'on' : 'off') : '') + (appUpdater && appUpdater.firstStart ? '; the first start after an update' : ''));
  if (MAC) {
    app.on('did-become-active', () => life.log('active', 'Typd became the active app'));
    app.on('did-resign-active', () => life.log('active', 'Typd stopped being the active app'));
  }

  // Sharing asks nothing at launch: public builds share unless turned off in Settings (since
  // 0.2.4), and the walkthrough's first screen says so (sharing.js). There is no consent screen.

  // The walkthrough: once, in the Typd window, on the first launch of an installed Typd (after the
  // Mac permission dialog), and never into an app update's quiet relaunch.
  startWalkthrough(Boolean(appUpdater && appUpdater.firstStart));

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
    if (Date.now() - launched > 3000) home.open('home', { by: 'macOS activate (the Dock icon, or opening Typd again)' });
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

  // The overlay is click-through by default and takes clicks only while the cursor is over one
  // of its two live controls: overlay-window.js's click gate, fed by the page (overlay:hit).

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

  // Live PCM while the user talks, 256 ms at a time (pipeline.openStream): a model
  // trained on audio in pieces has them primed, any other has a long dictation's
  // 45-70 s pieces written before the key is released. Revision never uses it --
  // the instruction is short and the span decides what it means.
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
  // CI only: the menu-bar path (scripts/mac-tray-close-check.sh, src/main/test-life.js).
  if (process.env.TYPD_TEST_LIFE) {
    require('./test-life').start({
      file: process.env.TYPD_TEST_LIFE, how: ['gui', 'watch'].includes(process.env.TYPD_TEST_LIFE_HOW) ? process.env.TYPD_TEST_LIFE_HOW : 'tray',
      app, home, trayUi, getOverlay: () => overlay, getHotkeys: () => hotkeys, getSession: () => session
    });
  }
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
  life.log('will-quit');
  if (hotkeys) hotkeys.close();
  if (flagKey) flagKey.close();
  stopHook();
  inject.stop();
  pipeline.stop();
});

// A dictation overlay is a background utility. Closing its only window is not a
// reason to exit -- it lives in the tray until asked to leave.
app.on('window-all-closed', (e) => e.preventDefault());

// Anything that dies under Typd, for the log: a renderer (the pill, the window) or a helper
// process Electron runs (GPU, audio, network).
app.on('render-process-gone', (_e, wc, d) => {
  const which = overlay && !overlay.isDestroyed() && wc === overlay.webContents ? 'the pill (overlay)'
    : home.current() && wc === home.current().webContents ? 'the Typd window' : 'another page';
  debugLife('a renderer is gone:', which, d && d.reason, d && d.exitCode);
  life.log('renderer gone', which + ': ' + (d && d.reason) + ', exit code ' + (d && d.exitCode));
});
app.on('child-process-gone', (_e, d) => {
  debugLife('a ' + (d && d.type) + ' process is gone:', d && d.reason, d && d.exitCode);
  life.log('helper process gone', (d && d.type) + (d && (d.serviceName || d.name) ? ' (' + (d.serviceName || d.name) + ')' : '') + ': ' + (d && d.reason) + ', exit code ' + (d && d.exitCode));
});
