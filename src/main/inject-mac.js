'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { clipboard, systemPreferences } = require('electron');
const life = require('./lifelog');

/**
 * Text injection on macOS, and knowing where it is going. The same contract as
 * inject.js, which hands over to this file on darwin; index.js and learn.js
 * cannot tell the two apart.
 *
 * macOS does have the clipboard dance's ingredients as public API -- NSPasteboard
 * with a change count, CoreGraphics events for ⌘V, Accessibility for the focused
 * control -- but not in Node, and a native module is what the Windows side went
 * out of its way to avoid. So the same shape: a long-lived helper process taking
 * line-delimited commands, here `osascript -l JavaScript` running
 * mac/inject-helper.js, whose Objective-C bridge reaches all three. Booting it
 * costs a few hundred milliseconds, paid during launch; after that a command is
 * a pipe write and, for the screen reads, a handful of Apple events.
 *
 * Two helpers rather than one:
 *
 *   keys  the clipboard and the keystrokes -- paste, copy, the ⌘C probe. Never
 *         sends an Apple event, so it never waits on another application.
 *   ax    the screen: which app is in front, its window title, the focused
 *         control's text and selection, read through System Events. Reading
 *         another app's accessibility tree waits on that app, and a hung app
 *         holds the read for seconds.
 *
 * In one process a hung read would queue the paste behind it. In two, the read
 * times out on its own, its helper is replaced, and the paste never notices.
 *
 * Permissions (permissions-mac.js asks for them): Accessibility for the key
 * presses, Automation for System Events for the screen reads. Without
 * Automation the reads come back empty and revision finds the selection with ⌘C
 * alone; without Accessibility nothing can be pressed, and a dictation is left
 * on the clipboard with a message saying so.
 */

const SOURCE = path.join(__dirname, 'mac', 'inject-helper.js');
const OSASCRIPT = '/usr/bin/osascript';

// The receiving app reads the clipboard asynchronously; putting the old contents
// back too early pastes the wrong thing. The same 250 ms as Windows.
const RESTORE_MS = 250;

// A helper is replaced after this many commands, once idle: its Objective-C
// objects (clipboard snapshots included, which can be screenshots) are freed
// with the process rather than trusted to a long-running script's memory.
const RECYCLE_AFTER = 40;
const RECYCLE_IDLE_MS = 20000;

const debug = process.env.TYPD_DEBUG
  ? (...args) => console.log('[typd:inject-mac]', ...args)
  : () => {};

// Things worth one line in the log even without TYPD_DEBUG, but only once.
const said = new Set();
function warnOnce(key, ...args) {
  if (said.has(key)) return;
  said.add(key);
  console.log('[typd:inject-mac]', ...args);
}

/** permissions-mac.js, required late: it requires this file back through inject.js. */
function permissions() {
  try { return require('./permissions-mac'); } catch { return null; }
}

/**
 * osascript needs a real file. Inside app.asar there is none, but Electron's fs
 * can still read it -- so a packaged build runs a copy from the temp folder.
 */
let scriptFile = null;
function script() {
  if (scriptFile && fs.existsSync(scriptFile)) return scriptFile;
  if (!/\.asar[\\/]/.test(SOURCE)) return (scriptFile = SOURCE);
  try {
    // Named by content, so a launch reuses the copy and an update makes a new one.
    const body = fs.readFileSync(SOURCE);
    const hash = require('crypto').createHash('sha1').update(body).digest('hex').slice(0, 10);
    const copy = path.join(os.tmpdir(), 'typd-inject-helper-' + hash + '.js');
    if (!fs.existsSync(copy)) fs.writeFileSync(copy, body);
    return (scriptFile = copy);
  } catch (err) {
    if (!said.has('script')) life.log('injector', 'cannot copy the helper script out of app.asar: ' + life.errorLine(err));
    warnOnce('script', 'cannot stage the helper script:', err && err.message);
    return null;
  }
}

class Helper {
  constructor(name) {
    this.name = name;
    this.proc = null;
    this.ready = false;
    this.pending = new Map();   // id -> {resolve, reject, command, long}
    this.nextId = 1;
    this.buffer = '';
    this.handled = 0;
    this.idle = null;
    this.crashes = [];          // when it exited without being asked to, to stop a crash loop
    this.holding = false;       // keys: a clipboard snapshot is waiting for 'restore'
  }

  start() {
    if (this.proc) return;
    // A helper that dies on its own five times in a minute is broken, not unlucky;
    // respawning it on every command would only add a failed spawn to each one.
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < 60000);
    if (this.crashes.length >= 5) {
      if (!said.has('loop-' + this.name)) life.log('injector', `${this.name} helper died 5 times in a minute: not starting it again for a minute`);
      warnOnce('loop-' + this.name, `the ${this.name} helper keeps exiting; not restarting it for a minute`);
      return;
    }

    const file = script();
    if (!file) return;

    let proc;
    try {
      proc = spawn(OSASCRIPT, ['-l', 'JavaScript', file, this.name], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      warnOnce('spawn-' + this.name, `cannot start the ${this.name} helper:`, err && err.message);
      return;
    }

    this.proc = proc;
    this.ready = false;
    this.buffer = '';
    this.handled = 0;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf('\n')) !== -1) {
        this.onLine(this.buffer.slice(0, i));
        this.buffer = this.buffer.slice(i + 1);
      }
    });
    // osascript reports a script error on stderr and exits; keep the tail, so the
    // one line that explains a dead helper reaches the log.
    let stderr = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (s) => {
      stderr = (stderr + s).slice(-600);
      debug(this.name, 'stderr:', String(s).trim());
    });
    proc.stdin.on('error', () => { /* EPIPE as it dies; 'exit' reports it */ });

    // Only a process still current when it exits died on its own: stop() lets go of
    // its process before killing it.
    let died = false, failed = null;
    const gone = (why) => {
      if (this.proc !== proc) return;   // an old process, already replaced
      died = true;
      this.proc = null;
      this.ready = false;
      this.crashes.push(Date.now());
      this.fail(why);
    };
    proc.on('exit', (code, signal) => {
      if (this.proc === proc && code) {
        warnOnce('exit-' + this.name, `the ${this.name} helper exited (${code}):`, stderr.trim() || '(no output)');
      }
      gone('injector exited');
    });
    proc.on('error', (err) => {
      warnOnce('error-' + this.name, `the ${this.name} helper failed:`, err && err.message);
      failed = err;
      gone('injector exited');
    });
    // Once its stderr is all read, a death in the life log as one line, as on Windows (inject.js):
    // osascript's first line there, without the script's own path in front of it.
    proc.on('close', (code, signal) => {
      if (!died) return;
      const why = life.clean(stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '', 200).replace(/^\S+\.js:\s*/, '');
      life.log('injector', `${this.name} helper ` + (failed ? 'could not start (' + life.clean(failed.code || failed.message, 60) + ')' : 'exited (' + (signal || 'code ' + code) + ')') + (why ? ': ' + why : ''));
    });
  }

  onLine(line) {
    const text = line.trim();
    if (!text) return;

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      debug(this.name, 'stray output:', text.slice(0, 200));
      return;   // not a response we asked for
    }

    if (payload.ready) {
      this.ready = true;
      debug(this.name, 'ready', JSON.stringify(payload));
      if (payload.pasteboardAccess !== null && payload.pasteboardAccess !== undefined && payload.pasteboardAccess !== 0) {
        warnOnce('pasteboard', 'macOS pasteboard access for Typd is set to', payload.pasteboardAccess,
          '(1 ask, 2 allow, 3 deny): pastes may prompt or fail');
      }
      return;
    }

    const entry = this.pending.get(payload.id);
    if (!entry) return;   // answered after its timeout: nobody is waiting
    this.pending.delete(payload.id);
    entry.resolve(payload);
    this.settled();
  }

  /**
   * One command, answered by id. A command that times out is abandoned and, unless it
   * is one that waits on a person, its helper is replaced: a helper that missed one
   * deadline is stuck behind something, and every later command would wait there too.
   */
  send(command, arg = '', timeoutMs = 2000, { long = false } = {}) {
    if (!this.proc) this.start();
    if (!this.proc) return Promise.reject(new Error('injector not started'));

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error('injector timed out'));
        if (!long) this.restart(command + ' timed out');
      }, timeoutMs);

      this.pending.set(id, {
        command,
        long,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });

      try {
        this.proc.stdin.write(id + ' ' + command + (arg ? ' ' + arg : '') + '\n');
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** True while a command that waits on a person (a macOS prompt) is outstanding. */
  waitingOnPerson() {
    for (const p of this.pending.values()) if (p.long) return true;
    return false;
  }

  settled() {
    this.handled++;
    if (this.handled < RECYCLE_AFTER) return;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (!this.proc || this.pending.size || this.holding) return;
      debug(this.name, 'recycling after', this.handled, 'commands');
      this.restart('recycled');
    }, RECYCLE_IDLE_MS);
  }

  fail(why) {
    const all = [...this.pending.values()];
    this.pending.clear();
    all.forEach((p) => p.reject(new Error(why)));
  }

  restart(why) {
    debug(this.name, 'restarting:', why);
    this.stop();
    this.start();
  }

  stop() {
    clearTimeout(this.idle);
    const proc = this.proc;
    this.proc = null;
    this.ready = false;
    this.holding = false;
    this.fail('injector stopped');
    if (!proc) return;
    try {
      proc.stdin.end();
      proc.kill();
    } catch {
      // already gone
    }
  }
}

const keys = new Helper('keys');
const ax = new Helper('ax');

function start() {
  keys.start();
  ax.start();
}

function stop() {
  keys.stop();
  ax.stop();
}

/** Without Accessibility, a posted ⌘V is dropped without a word; check rather than hope. */
function trusted() {
  try {
    return systemPreferences.isTrustedAccessibilityClient(false);
  } catch {
    return true;   // cannot tell: try, and let the result speak
  }
}

/** Read the screen through the ax helper. Null when it cannot answer now. */
async function read(command, timeoutMs) {
  // macOS is showing the user a permission prompt that this helper is waiting on;
  // a read would queue behind their answer. Answer "unknown" instead.
  if (ax.waitingOnPerson()) return null;
  try {
    const r = await ax.send(command, '', timeoutMs);
    if (r && r.denied && !said.has('denied-' + r.denied)) {
      // Once per kind: the reads go on degrading quietly, and permissions-mac.js decides
      // whether this is worth a dialog.
      warnOnce('denied-' + r.denied, r.denied === 'automation'
        ? 'System Events automation is off for Typd: no screen context, and revision finds the selection with ⌘C only'
        : 'Accessibility is off for Typd: the screen cannot be read');
      const p = permissions();
      if (p) p.ensure(r.denied === 'assistive' ? 'accessibility' : r.denied);
    }
    return r;
  } catch (err) {
    debug(command, 'failed:', err && err.message);
    return null;
  }
}

/**
 * Stop a bare Alt tap from opening the focused app's menu bar. macOS has no such
 * behaviour to stop -- and its key is Right ⌘ anyway -- so there is nothing to do.
 */
function maskAlt() {}

/** The app the text is about to land in. Null if it cannot be determined. */
async function focusedApp() {
  const r = await read('focus', 2000);
  if (!r || !r.process) return null;
  return { process: r.process, title: r.title || '' };
}

/**
 * The same, plus whatever text the focused control exposes through
 * Accessibility -- the editor you are typing into, the compose box, the form
 * field.
 *
 * Called at the *start* of a session rather than the end, because the speaker
 * then talks for several seconds and the query finishes long before it is
 * needed. Doing it at capture-end would put it on the critical path for nothing.
 */
async function focusContext() {
  const started = Date.now();
  const r = await read('context', 4000);
  debug('context', r && r.process, 'text=' + (r && r.text ? r.text.length : 0), (Date.now() - started) + 'ms');
  if (!r || !r.process) return null;
  // field: whether the focused element can take a paste (fieldFacts; pasteTarget.js decides).
  return { process: r.process, title: r.title || '', text: r.text || '', field: r.field || null };
}

/**
 * The field facts alone, read now: the second look before a dictation is offered in the copy
 * pop-up instead of pasted (pasteTarget.decide). Null when the screen cannot be read -- which
 * means "unknown", and the paste goes ahead.
 */
async function fieldState() {
  const r = await read('field', 1500);
  return r && r.ok && r.field ? r.field : null;
}

/**
 * What the user has highlighted, and therefore what a revision will replace.
 *
 * Two mechanisms, tried in order, as on Windows:
 *
 *   Accessibility  silent, and disturbs nothing -- AXSelectedText through
 *                  System Events, a few tens of milliseconds -- but web views
 *                  and Electron apps often keep their text out of the
 *                  accessibility tree until a screen reader asks, and some
 *                  controls have no notion of a selection at all.
 *
 *   ⌘C             up to ~300 ms and a real keystroke into the user's
 *                  application -- but it works wherever copying works, which is
 *                  everywhere, because it asks the app to do something it
 *                  already knows.
 *
 * So: take the free one when it answers, pay for the reliable one when it does
 * not. Neither is on the critical path -- this is read when the hotkey is
 * pressed, and the user then speaks for several seconds.
 */
const debugSelection = process.env.TYPD_DEBUG
  ? (...args) => console.log('[typd:selection]', ...args)
  : () => {};

/**
 * @param {(settled: boolean) => void} [onEarly] Called as soon as the cheap
 *   probe can answer, with true if something is definitely selected and false
 *   if definitely nothing is. Not called at all when the probe is inconclusive
 *   and the slow path has to run.
 */
async function selection(onEarly) {
  try {
    const started = Date.now();
    const r = await read('selection', 2000);
    debugSelection(r && r.process, r && r.method, 'sel=' + (r && r.length), 'doc=' + (r && r.docLength), (Date.now() - started) + 'ms');

    if (r && r.method === 'ax' && r.text) {
      if (onEarly) onEarly(true);
      return { text: r.text, method: 'ax', process: r.process || '', title: r.title || '' };
    }

    // A caret with no range is the one negative answer worth trusting: the
    // control does expose a selection model and is telling us the selection is
    // collapsed. Nothing is highlighted, and there is no reason to spend a ⌘C
    // finding that out again.
    if (r && r.method === 'caret-only') {
      if (onEarly) onEarly(false);
      return null;
    }

    // Anything else is not evidence that nothing is selected -- it is evidence
    // that this control will not tell us. That includes the case where the
    // control claimed the whole document was selected, which is the same
    // answer as no answer. Ask the application instead -- if a key press can
    // reach it at all.
    if (!trusted()) {
      debugSelection('fallback skipped: no Accessibility, so ⌘C cannot be pressed');
      return null;
    }
    const c = await keys.send('copysel', '', 6000);
    debugSelection('fallback', c && c.method, 'len=' + (c && c.length), (c && c.ms) + 'ms');

    if (c && c.method === 'clipboard' && c.text) {
      return { text: c.text, method: 'clipboard', process: (r && r.process) || c.process || '', title: (r && r.title) || '' };
    }

    return null;
  } catch (err) {
    debugSelection('failed', err && err.message);
    return null;
  }
}

/**
 * Is the span we captured still the thing that is selected?
 *
 * Between pressing the hotkey and the model answering, several seconds pass and
 * the user is free to click somewhere else. If they do, the selection is gone
 * and ⌘V stops being a replacement: it becomes an insertion, at whatever caret
 * happens to be live, of a rewrite of text that is still sitting untouched
 * somewhere above. That is the worst outcome this feature has, and it is silent.
 *
 * So the span is re-read immediately before pasting and compared, exactly as on
 * Windows. Only a positive mismatch blocks: a control that cannot tell us what
 * is selected is not evidence that the selection moved.
 */
async function selectionStillIs(expected) {
  if (!expected) return { ok: true, reason: 'nothing-to-check' };

  const r = await read('selection', 2000);
  if (r && r.method === 'ax' && r.text) {
    return r.text === expected
      ? { ok: true, reason: 'verified' }
      : { ok: false, reason: 'changed' };
  }

  // Caret with no range means the selection was collapsed -- they clicked.
  // That is a positive signal rather than an absent one, so it does block.
  if (r && r.method === 'caret-only') return { ok: false, reason: 'collapsed' };

  return { ok: true, reason: 'unverifiable' };
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/**
 * Put `text` into the focused application.
 *
 * The helper saves what the user had copied (text, rich text, HTML, images,
 * files -- every item, so several files copied in Finder come back as several),
 * writes ours marked transient and kept off Universal Clipboard, and presses
 * ⌘V. The old clipboard goes back RESTORE_MS later, unless the change count
 * says the user copied something in between.
 *
 * A dictation is never lost: if the paste fails, the text is left on the
 * clipboard and the result says so (`copied`).
 */
async function paste(text) {
  if (!text) return { ok: false, reason: 'empty' };

  try {
    if (!trusted()) throw new Error('accessibility');
    const r = await keys.send('put', b64(text), 3000);
    if (r && r.ok === false) throw new Error(r.error || 'paste failed');
    debug('pasted via', r && r.via);
  } catch (err) {
    // Awaited: from Electron 44 the clipboard calls return promises (harmless on older versions).
    try {
      if ((await clipboard.readText()) !== text) await clipboard.writeText(text);
    } catch (e) {
      debug('clipboard fallback failed:', e && e.message);
    }
    const raw = String((err && err.message) || '');
    if (raw === 'accessibility') {
      warnOnce('paste-ax', 'Accessibility is off for Typd: the dictation was left on the clipboard');
      const p = permissions();
      if (p) p.ensure('accessibility');
      return { ok: false, copied: true, reason: 'turn on Accessibility for Typd' };
    }
    return { ok: false, copied: true, reason: raw.includes('exited') || raw.includes('not started') ? 'restart Typd' : raw };
  }

  keys.holding = true;
  setTimeout(() => {
    keys.send('restore', '', 2000)
      .catch(() => {})
      .then(() => { keys.holding = false; });
  }, RESTORE_MS);
  return { ok: true };
}

/** Leave text on the clipboard, out of clipboard history, for the user to paste. */
async function copy(text) {
  try {
    const r = await keys.send('copy', b64(text), 2000);
    if (r && r.ok) return;
  } catch {
    // fall through
  }
  await clipboard.writeText(text);
}

/* -------------------------------------------- for permissions-mac.js only */

/** Input Monitoring: 'granted', 'denied', 'unknown' (never asked), 'missing', or null if unreadable. */
async function listenAccess() {
  try {
    const r = await keys.send('access', '', 3000);
    return r ? r.listen : null;
  } catch {
    return null;
  }
}

/** Ask macOS for Input Monitoring: adds Typd to the list, and prompts the first time. */
async function requestListen() {
  try {
    return await ax.send('request-listen', '', 60000, { long: true });
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

/**
 * Send the first Apple event to System Events now, so macOS's Automation prompt
 * appears at a moment Typd chose, not in the middle of a dictation. Waits for
 * the user's answer; screen reads meanwhile report "unknown" (see read()).
 */
async function prime() {
  try {
    return await ax.send('prime', '', 120000, { long: true });
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

module.exports = {
  start, stop, paste, copy, maskAlt, focusedApp, focusContext, fieldState, selection, selectionStillIs,
  isReady: () => keys.ready,
  listenAccess, requestListen, prime
};
