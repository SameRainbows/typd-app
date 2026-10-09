'use strict';

// macOS has its own injector with the same exports (inject-mac.js): osascript in
// place of PowerShell, ⌘V in place of Ctrl+V. Everything below is Windows.
if (process.platform === 'darwin') {
  module.exports = require('./inject-mac');
  return;
}

const path = require('path');
const { spawn } = require('child_process');
const { clipboard } = require('electron');

/**
 * Text injection, and knowing where it is going.
 *
 * Windows has no user-space API for "type this into whatever has focus", so the
 * universal approach is the clipboard dance: stash what is there, write ours,
 * synthesise Ctrl+V, put the original back. It works in every app that accepts
 * a paste, which is every app.
 *
 * The keystroke itself needs a native call. Rather than take on a native module
 * -- robotjs is unmaintained, nut-js changed licence -- this keeps one
 * PowerShell process alive for the lifetime of the app and writes commands to
 * its stdin. Measured on this machine: 350 ms to start and load the assemblies,
 * paid once during launch, then ~1 ms per command. A fresh `powershell -c` per
 * paste would cost 300 ms and flash a console window.
 *
 * The same process answers which application has focus and what text is in the
 * focused control -- both the "pasted into X" label and the model's context.
 */

const HELPER = path.join(__dirname, 'inject.ps1');

let proc = null;
let ready = false;
let queue = [];       // pending {resolve, reject} in command order
let buffer = '';
const buttonListeners = new Set();
let armedButton = 0;  // the side button the helper's hook is swallowing, 0 for none

function handleLine(line) {
  const text = line.trim();
  if (!text) return;

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return; // stray output from the shell; not a response we asked for
  }

  if (payload.ready) {
    ready = true;
    if (armedButton && proc) proc.stdin.write('buttons ' + armedButton + '\n');   // asked for before the helper was up
    return;
  }

  // Unasked-for lines from the side-button hook (inject.ps1): not an answer to a command.
  if (payload.ev) {
    if (payload.ev === 'button') for (const fn of buttonListeners) fn(payload.b, Boolean(payload.down));
    if (payload.ev === 'buttons' && process.env.TYPD_DEBUG) console.log('[typd:buttons]', payload);
    return;
  }

  const pending = queue.shift();
  if (pending) pending.resolve(payload);
}

function start() {
  if (proc) return;

  proc = spawn(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      handleLine(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
    }
  });

  proc.on('exit', () => {
    proc = null;
    ready = false;
    queue.forEach((p) => p.reject(new Error('injector exited')));
    queue = [];
  });

  proc.on('error', () => {
    proc = null;
    ready = false;
  });
}

function command(line, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    if (!proc) return reject(new Error('injector not started'));

    const timer = setTimeout(() => {
      const i = queue.indexOf(entry);
      if (i !== -1) queue.splice(i, 1);
      reject(new Error('injector timed out'));
    }, timeoutMs);

    const entry = {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    };

    queue.push(entry);
    proc.stdin.write(line + '\n');
  });
}

/**
 * Stop a bare Alt tap from opening the focused app's menu bar. Fire and forget:
 * the helper sends no reply for this, so it cannot take another command's answer.
 */
function maskAlt() {
  if (proc && ready) proc.stdin.write('mask\n');
}

/**
 * Mouse side buttons as the Typd key (hotkeys.js). The helper's own low-level mouse hook
 * swallows the bound button -- Back must not also go back in the app underneath -- and
 * reports its presses here. arm(4 | 5) installs it, arm(0) removes it. If the hook
 * cannot be installed, presses simply never arrive, and the key picker's "press it
 * again" check puts the old key back.
 */
function buttons() {
  return {
    on(fn) { buttonListeners.add(fn); },
    off(fn) { buttonListeners.delete(fn); },
    arm(b) {
      armedButton = b === 4 || b === 5 ? b : 0;
      if (proc) proc.stdin.write('buttons ' + armedButton + '\n');
    }
  };
}

/** The app the text is about to land in. Null if it cannot be determined. */
async function focusedApp() {
  try {
    const r = await command('focus');
    if (!r || !r.process) return null;
    return { process: r.process, title: r.title || '' };
  } catch {
    return null;
  }
}

/**
 * The same, plus whatever text the focused control exposes through UI
 * Automation -- the editor you are typing into, the compose box, the form
 * field. Costs ~8 ms once the helper is warm.
 *
 * Called at the *start* of a session rather than the end, because the speaker
 * then talks for several seconds and the query finishes long before it is
 * needed. Doing it at capture-end would put it on the critical path for nothing.
 */
async function focusContext() {
  try {
    const r = await command('context', 4000);
    if (!r || !r.process) return null;
    return { process: r.process, title: r.title || '', text: r.text || '' };
  } catch {
    return null;
  }
}

/**
 * What the user has highlighted, and therefore what a revision will replace.
 *
 * Two mechanisms, tried in order, because bench/selection.js measured neither
 * one as sufficient alone:
 *
 *   UI Automation  ~8 ms, silent, disturbs nothing -- but it returned a real
 *                  span in a browser and in nothing else. Electron chat apps
 *                  gave back a caret with no selection, and controls exposing
 *                  only ValuePattern have no notion of a selection at all.
 *
 *   Ctrl+C         ~140 ms and a real keystroke into the user's application --
 *                  but it works wherever copying works, which is everywhere,
 *                  because it asks the app to do something it already knows.
 *
 * So: take the free one when it answers, pay for the reliable one when it does
 * not. The 140 ms is not on the critical path either way -- this is read when
 * the hotkey is pressed, and the user then speaks for several seconds.
 */
const debug = process.env.TYPD_DEBUG
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
    const r = await command('selection');
    debug(r && r.process, r && r.method, 'sel=' + (r && r.length), 'doc=' + (r && r.docLength));

    if (r && r.method === 'text-pattern' && r.text) {
      if (onEarly) onEarly(true);
      // truncated: more was highlighted than the helper reads (inject.ps1, SelectionLimit).
      // Revising it would replace all of it with a rewrite of part of it; the pipeline refuses.
      return { text: r.text, truncated: Boolean(r.truncated), method: 'uia', process: r.process || '', title: r.title || '' };
    }

    // A caret with no range is the one negative answer worth trusting: the
    // control does expose a selection model and is telling us the selection is
    // collapsed. Nothing is highlighted, and there is no reason to spend a
    // Ctrl+C finding that out again.
    if (r && r.method === 'caret-only') {
      if (onEarly) onEarly(false);
      return null;
    }

    // Anything else is not evidence that nothing is selected -- it is evidence
    // that this control will not tell us. That includes the case where the
    // control claimed the whole document was selected, which is the same
    // answer as no answer. Ask the application instead.
    const c = await command('copysel', 6000);
    debug('fallback', c && c.method, 'len=' + (c && c.length), (c && c.ms) + 'ms');

    if (c && c.method === 'clipboard' && c.text) {
      return { text: c.text, method: 'clipboard', process: c.process || '', title: c.title || '' };
    }

    return null;
  } catch (err) {
    debug('failed', err && err.message);
    return null;
  }
}

/**
 * Is the span we captured still the thing that is selected?
 *
 * Between pressing the hotkey and the model answering, several seconds pass and
 * the user is free to click somewhere else. If they do, the selection is gone
 * and Ctrl+V stops being a replacement: it becomes an insertion, at whatever
 * caret happens to be live, of a rewrite of text that is still sitting
 * untouched somewhere above. That is the worst outcome this feature has, and it
 * is silent.
 *
 * So the span is re-read immediately before pasting and compared. This does put
 * a read on the critical path, which everything else in this file is careful to
 * avoid -- but the alternative is corrupting a document to save 8 ms, and the
 * cheap UI Automation read answers most of the time.
 *
 * Only a positive mismatch blocks. A control that cannot tell us what is
 * selected is not evidence that the selection moved, and refusing to paste
 * every time UI Automation shrugs would make revision unusable in exactly the
 * applications that need the clipboard fallback.
 */
async function selectionStillIs(expected) {
  if (!expected) return { ok: true, reason: 'nothing-to-check' };

  try {
    const r = await command('selection');
    if (r && r.method === 'text-pattern' && r.text) {
      return r.text === expected
        ? { ok: true, reason: 'verified' }
        : { ok: false, reason: 'changed' };
    }

    // Caret with no range means the selection was collapsed -- they clicked.
    // That is a positive signal rather than an absent one, so it does block.
    if (r && r.method === 'caret-only') return { ok: false, reason: 'collapsed' };

    return { ok: true, reason: 'unverifiable' };
  } catch {
    return { ok: true, reason: 'unverifiable' };
  }
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/**
 * Put `text` into the focused application.
 *
 * The helper saves what the user had copied (text, rich text, HTML, images,
 * files), writes ours in a form that stays out of Win+V history and cloud sync,
 * and presses Ctrl+V. The old clipboard goes back afterwards, but not
 * immediately -- the receiving app reads it asynchronously, and putting the old
 * contents back too early pastes the wrong thing. 250 ms is comfortably past
 * every app tested and still fast enough that a Ctrl+V a moment later gets the
 * user's own clipboard back.
 *
 * A dictation is never lost: if the paste fails, the text is left on the
 * clipboard and the result says so (`copied`).
 */
async function paste(text) {
  if (!text) return { ok: false, reason: 'empty' };

  try {
    if (!proc) throw new Error('injector not started');
    const r = await command('put ' + b64(text));
    if (r && r.ok === false) throw new Error(r.error || 'SendKeys failed');
  } catch (err) {
    // Awaited: from Electron 44 the clipboard calls return promises (harmless on older versions).
    if ((await clipboard.readText()) !== text) await clipboard.writeText(text);
    const raw = String((err && err.message) || '');
    return { ok: false, copied: true, reason: raw.includes('exited') || raw.includes('not started') ? 'restart Typd' : raw };
  }

  setTimeout(() => { command('restore').catch(() => {}); }, 250);
  return { ok: true };
}

/** Leave text on the clipboard, out of clipboard history, for the user to paste. */
async function copy(text) {
  try {
    const r = await command('copy ' + b64(text));
    if (r && r.ok) return;
  } catch {
    // fall through
  }
  await clipboard.writeText(text);
}

function stop() {
  if (!proc) return;
  try {
    proc.stdin.end();
    proc.kill();
  } catch {
    // already gone
  }
  proc = null;
  ready = false;
}

module.exports = {
  start, stop, paste, copy, maskAlt, focusedApp, focusContext, selection, selectionStillIs, buttons,
  isReady: () => ready
};
