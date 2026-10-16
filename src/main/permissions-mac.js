'use strict';

const path = require('path');
const { app, dialog, shell, systemPreferences, nativeImage, ipcMain } = require('electron');

/**
 * macOS permissions: asked for once, together, in plain words -- and again
 * whenever one goes missing.
 *
 * Typd needs three switches in System Settings › Privacy & Security, and can
 * live without a fourth:
 *
 *   Microphone        to hear you. macOS asks the first time by itself; only a
 *                     refusal needs explaining.
 *   Accessibility     to press ⌘V (and ⌘C) in the app you were in, and for the
 *                     event tap that hears the key.
 *   Input Monitoring  to hear the key while another app is in front.
 *   Automation        System Events, to read the text around the caret and the
 *                     selection without touching the clipboard: screen context,
 *                     and learning the words you correct. Without it everything
 *                     still works, less well -- so macOS's own prompt is the only
 *                     ask, sent once the others are on, and a refusal stands.
 *
 * No app can grant itself any of these. It can only ask, and for three of them
 * the answer is a switch the person flips by hand. So: one native dialog naming
 * the switches that are off and why, one button that opens the right pane, and
 * then a quiet poll that opens the next pane as each switch goes on. No
 * dashboard, no tour (ROADMAP, Law 2).
 *
 * Whose switch it is: the installed app's, listed as "Typd". Run from source,
 * macOS holds the app Typd was started from responsible -- Terminal, iTerm,
 * VS Code -- and the switch is that app's. The dialog names whichever it is.
 */

const log = (...args) => console.log('[typd:permissions]', ...args);

const PANES = {
  microphone: 'Privacy_Microphone',
  accessibility: 'Privacy_Accessibility',
  input: 'Privacy_ListenEvent',
  automation: 'Privacy_Automation'
};

const POLL_MS = 1500;
const WATCH_MS = 5 * 60 * 1000;   // how long to keep opening the next pane after "Open System Settings"
const QUIET_MS = 10 * 60 * 1000;  // after a dialog, how long before another one for a later failure

let checking = null;        // the check in progress, shared by everyone who asks meanwhile
let dialogOpen = false;
let lastShown = 0;
let watcher = null;
let primed = false;
let automationDenied = false;
let micHooked = false;

/** inject-mac.js, through inject.js; required late because it requires this file back. */
const inject = () => require('./inject');

/** The name macOS lists the switches under. */
function holder() {
  if (app.isPackaged) return 'Typd';
  const terminals = {
    Apple_Terminal: 'Terminal', 'iTerm.app': 'iTerm', vscode: 'Visual Studio Code', WarpTerminal: 'Warp',
    ghostty: 'Ghostty', WezTerm: 'WezTerm', Hyper: 'Hyper', Tabby: 'Tabby'
  };
  return terminals[process.env.TERM_PROGRAM || ''] || 'Terminal';
}

function keyName() {
  try {
    return require('./hotkeys').label(require('./settings').get('hotkey'));
  } catch {
    return 'the Typd key';
  }
}

function why(kind) {
  switch (kind) {
    case 'microphone': return 'Microphone — to hear you. It is turned off for ' + holder() + '.';
    case 'accessibility': return 'Accessibility — to paste what you say into the app you were using, and to read what you highlighted.';
    case 'input': return 'Input Monitoring — to hear ' + keyName() + ' while another app is in front. Typd acts on that key alone and keeps nothing you type.';
    case 'automation': return 'Automation › System Events — to read the text around your cursor, so Typd can learn the words you correct.';
    default: return kind;
  }
}

function micStatus() {
  try { return systemPreferences.getMediaAccessStatus('microphone'); } catch { return 'unknown'; }
}

/** True, false, or null when it cannot be told. `prompt` also puts Typd in the list. */
function axTrusted(prompt) {
  try { return systemPreferences.isTrustedAccessibilityClient(Boolean(prompt)); } catch { return null; }
}

/** Which of `kinds` are off right now. Input Monitoring that cannot be read is not reported. */
async function missing(kinds = ['microphone', 'accessibility', 'input', 'automation']) {
  const off = [];
  if (kinds.includes('microphone')) {
    const mic = micStatus();
    if (mic === 'denied' || mic === 'restricted') off.push('microphone');
  }
  if (kinds.includes('accessibility') && axTrusted(false) === false) off.push('accessibility');
  if (kinds.includes('input') && typeof inject().listenAccess === 'function') {
    const listen = await inject().listenAccess();
    if (listen && listen !== 'granted') off.push('input');
  }
  if (kinds.includes('automation') && automationDenied) {
    await probeAutomation();   // decided already, so this answers at once
    if (automationDenied) off.push('automation');
  }
  return off;
}

function openPane(kind) {
  const anchor = PANES[kind];
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?' + anchor)
    .catch(() => shell.openExternal('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?' + anchor))
    .catch((err) => log('cannot open System Settings:', err && err.message));
}

/** Put Typd in the pane's list if a call can (macOS may add its own prompt), then open the pane. */
function request(kind) {
  if (kind === 'accessibility') axTrusted(true);
  if (kind === 'input') {
    inject().requestListen().then((r) => {
      if (r && r.ok === false) log('Input Monitoring request:', r.error);
    });
  }
  openPane(kind);
}

function icon() {
  try {
    const img = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'typd.png'));
    return img.isEmpty() ? undefined : img;
  } catch {
    return undefined;
  }
}

function how(off) {
  const lists = off.length === 1 ? 'that list' : 'each list';
  let text = `In Privacy & Security, turn on “${holder()}” in ${lists}. Typd notices each switch by itself`;
  text += off.length > 1 ? ' and opens the next list for you.' : '.';
  if (!app.isPackaged) {
    text += `\n\nRunning from source, these switches belong to ${holder()}, the app Typd was started from. ` +
      `If macOS offers to quit and reopen ${holder()}, that stops Typd too: start it again afterwards.`;
  } else if (off.includes('accessibility') || off.includes('input')) {
    text += '\n\nAlready on? Each new build of Typd is a new app to macOS. Select Typd in the list, ' +
      'remove it with –, then add it again with +.';
  }
  return text;
}

/** The one dialog. True when the person chose to open System Settings. */
async function ask(off) {
  dialogOpen = true;
  try {
    // A menu-bar app is never frontmost by itself; without this the dialog can open behind the
    // window the person is looking at.
    try { app.focus({ steal: true }); } catch { /* it still shows */ }
    const count = ['', 'one switch', 'two switches', 'three switches', 'four switches'][off.length] || 'some switches';
    const { response } = await dialog.showMessageBox({
      type: 'none',
      icon: icon(),
      title: 'Typd',
      message: `Typd needs ${count} turned on`,
      detail: off.map(why).join('\n\n') + '\n\n' + how(off),
      buttons: ['Open System Settings', 'Not Now'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    return response === 0;
  } finally {
    dialogOpen = false;
    lastShown = Date.now();
  }
}

function stopWatching() {
  clearInterval(watcher);
  watcher = null;
}

/**
 * After "Open System Settings": watch the switches that were off, and as each
 * one goes on, open the pane for the next. Gives up quietly after WATCH_MS.
 */
function watch(off) {
  stopWatching();
  let current = off[0];
  let busy = false;
  const until = Date.now() + WATCH_MS;
  watcher = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (Date.now() > until) { stopWatching(); return; }
      const still = await missing(off);
      if (!still.length) {
        log('every switch Typd asked for is on');
        stopWatching();
        prime();
        return;
      }
      if (still.includes(current)) return;   // not this one yet
      current = still[0];
      request(current);
    } catch (err) {
      log('watch:', err && err.message);
    } finally {
      busy = false;
    }
  }, POLL_MS);
}

/** Re-read Automation after a refusal; quick, because macOS has its answer. */
async function probeAutomation() {
  const r = await inject().prime();
  if (r && r.ok) automationDenied = false;
  else if (r && r.error === 'automation') automationDenied = true;
}

/**
 * The first Apple event to System Events, once Accessibility is on (reading the
 * screen needs both): macOS asks about Automation now, when Typd chose, rather
 * than in the middle of a dictation.
 */
async function prime() {
  if (primed || axTrusted(false) === false) return;
  primed = true;
  const r = await inject().prime();
  if (r && r.ok) {
    automationDenied = false;
  } else if (r && r.error === 'automation') {
    automationDenied = true;
    log('System Events automation is off for ' + holder() + ': no screen context, and corrections are not learned. ' +
      'Privacy & Security › Automation › ' + holder() + ' › System Events turns it on.');
  } else {
    primed = false;   // no answer (a timeout, a restarted helper): ask again next time
  }
}

/**
 * Should a check for `reason` be allowed to put a dialog on screen? At launch,
 * yes; after that, not while one is open or a pane is being walked through,
 * and not within QUIET_MS of the last one.
 */
function showable() {
  return !dialogOpen && !watcher && Date.now() - lastShown > QUIET_MS;
}

async function check(reason) {
  // The microphone first, through macOS's own prompt: the first time, that is all it takes.
  if (micStatus() === 'not-determined') {
    try {
      await systemPreferences.askForMediaAccess('microphone');
    } catch (err) {
      log('microphone request failed:', err && err.message);
    }
  }

  const off = await missing();
  if (!off.length) {
    prime();
    return true;
  }
  log('off for ' + holder() + ':', off.join(', '), '(checked for ' + reason + ')');

  // Automation on its own is a refusal the person already gave macOS; it rides
  // along with the others but never brings the dialog up by itself.
  if (!off.some((k) => k !== 'automation') || !showable()) return false;

  if (await ask(off)) {
    request(off[0]);
    watch(off);
  }
  return false;
}

/** The overlay reports a microphone that would not open; on a Mac that is often the privacy switch. */
function hookMic() {
  if (micHooked) return;
  micHooked = true;
  ipcMain.on('overlay:mic', (_e, kind) => {
    if (kind !== 'silent') ensure('microphone');
  });
}

/**
 * Check every permission and explain whatever is off. Safe to call often: it
 * shares a check in progress, and the dialog keeps quiet for QUIET_MS after it
 * was last shown.
 *
 * @param {string} [reason] what prompted the check -- 'startup', 'accessibility',
 *   'automation', 'microphone' -- for the log.
 * @returns {Promise<boolean>} true when everything needed is on
 */
function ensure(reason = 'startup') {
  if (process.platform !== 'darwin') return Promise.resolve(true);
  hookMic();
  if (!checking) {
    checking = check(reason)
      .catch((err) => { log('check failed:', err && err.message); return false; })
      .finally(() => { checking = null; });
  }
  return checking;
}

/** Every switch, for anything that wants to show it (the Settings window, one day). */
async function status() {
  const off = await missing();
  const out = {};
  for (const kind of Object.keys(PANES)) out[kind] = !off.includes(kind);
  return out;
}

/** Is the permissions dialog on screen? (appUpdate.js never quits for an update under it.) */
function isAsking() { return dialogOpen; }

module.exports = { ensure, status, openPane, isAsking };
