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
const lifeLog = (what, detail) => { try { require('./lifelog').log(what, detail); } catch { /* no log */ } };

const PANES = {
  microphone: 'Privacy_Microphone',
  accessibility: 'Privacy_Accessibility',
  input: 'Privacy_ListenEvent',
  automation: 'Privacy_Automation'
};

const BUNDLE_ID = 'ai.typd.app';   // package.json build.appId: whose entry macOS keeps
const POLL_MS = 1500;
const WATCH_MS = 5 * 60 * 1000;   // how long to keep opening the next pane after "Open System Settings"
const QUIET_MS = 10 * 60 * 1000;  // after a dialog, how long before another one for a later failure
const MIC_WAIT_MS = Number(process.env.TYPD_MIC_WAIT_MS) || 90 * 1000;   // the longest a check waits on macOS's microphone prompt
const MIC_REASK_MS = 10 * 1000;   // a request this old with no answer may be sent again when the person asks

let checking = null;        // the check in progress, shared by everyone who asks meanwhile
let dialogOpen = false;
let lastShown = 0;
let watcher = null;
let primed = false;
let automationDenied = false;
let micHooked = false;
let micAsking = null;       // macOS's microphone prompt in flight: { promise, at }
const micListeners = [];
let onUnanswered = null;    // index.js: open the Typd window (its card offers Allow / Ask again)
let recheckOnAnswer = false; // a check left macOS's prompt alone: run it again when macOS answers

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
    case 'microphone':
      return micStatus() === 'not-determined'
        ? 'Microphone — to hear you. macOS has not been told yet whether ' + holder() + ' may use it, so ' + holder() +
          ' is not in its Microphone list. “Allow Microphone” asks macOS: click Allow in its dialog.'
        : 'Microphone — to hear you. It is turned off for ' + holder() + '.';
    case 'accessibility': return 'Accessibility — to paste what you say into the app you were using, and to read what you highlighted.';
    case 'input': return 'Input Monitoring — to hear ' + keyName() + ' while another app is in front. Typd acts on that key alone and keeps nothing you type.';
    case 'automation': return 'Automation › System Events — to read the text around your cursor, so Typd can learn the words you correct.';
    default: return kind;
  }
}

function micStatus() {
  try { return systemPreferences.getMediaAccessStatus('microphone'); } catch { return 'unknown'; }
}

/**
 * The microphone as the Typd window shows it: macOS's status, or 'asking' while its prompt is up.
 * 'not-determined' means macOS was never given an answer, so Typd is not in Privacy & Security ›
 * Microphone yet: macOS lists an app there only after the app asked and the person answered.
 */
function micState() {
  const s = micStatus();
  return s === 'not-determined' && micAsking ? 'asking' : s;
}

function micChanged() {
  for (const fn of micListeners) { try { fn(micState()); } catch { /* a listener's problem */ } }
}

/**
 * Ask macOS for the microphone: its own prompt, the only way Typd gets into the Microphone list.
 * Never leaves a caller waiting on it: resolves with the status once macOS answers, or after `wait`
 * ms with 'asking' while the prompt is still up (0.2.6 waited forever, and with no answer Typd
 * never asked for anything else either). One request at a time; one older than MIC_REASK_MS with no
 * answer is sent again when the person asks (`again`). Everything goes to the life log.
 *
 * @param {string} why who asked, for the log
 * @param {{wait?: number, again?: boolean}} [o]
 * @returns {Promise<string>} 'granted' | 'denied' | 'restricted' | 'not-determined' | 'asking' | 'unknown'
 */
function requestMic(why, { wait = MIC_WAIT_MS, again = false } = {}) {
  const before = micStatus();
  if (before !== 'not-determined') return Promise.resolve(before);
  if (!micAsking || (again && Date.now() - micAsking.at > MIC_REASK_MS)) {
    const at = Date.now();
    const previous = micAsking;
    lifeLog('microphone', (previous ? 'asking macOS again' : 'asking macOS') + ' (' + why + ')');
    log('asking macOS for the microphone (' + why + ')');
    // A menu-bar app is never frontmost by itself; macOS shows its prompt for the app in front.
    try { app.focus({ steal: true }); } catch { /* it still asks */ }
    let promise;
    try {
      promise = Promise.resolve(systemPreferences.askForMediaAccess('microphone'));
    } catch (err) {
      promise = Promise.reject(err);
    }
    const entry = { at, promise: null };
    entry.promise = promise
      .then((granted) => {
        const after = micStatus();
        const line = 'macOS answered: ' + (granted ? 'allowed' : 'not allowed') + ' after ' + Math.round((Date.now() - at) / 1000) + ' s (status ' + after + ')';
        lifeLog('microphone', line);
        log('microphone: ' + line);
        return after;
      })
      .catch((err) => {
        lifeLog('microphone', 'the request failed: ' + ((err && err.message) || err));
        log('microphone request failed:', err && err.message);
        return micStatus();
      })
      .finally(() => {
        if (micAsking === entry) micAsking = null;
        micChanged();
        if (recheckOnAnswer && micStatus() !== 'not-determined') {
          recheckOnAnswer = false;
          setTimeout(() => ensure('the microphone answer'), 300);
        }
      });
    micAsking = entry;
    micChanged();
  }
  const pending = micAsking.promise;
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      const s = micStatus();
      if (s === 'not-determined') {
        lifeLog('microphone', 'no answer from macOS after ' + Math.round(wait / 1000) + ' s (' + why + '); its prompt may be hidden or unanswered');
        log('microphone: no answer after ' + Math.round(wait / 1000) + ' s');
      }
      resolve(s === 'not-determined' ? 'asking' : s);
    }, wait);
  });
  return Promise.race([pending, late]).finally(() => clearTimeout(timer));
}

function onMicChange(fn) { micListeners.push(fn); }

/** index.js: what to do when macOS's microphone prompt stays unanswered (open the Typd window). */
function whenUnanswered(fn) { onUnanswered = fn; }

/** True, false, or null when it cannot be told. `prompt` also puts Typd in the list. */
function axTrusted(prompt) {
  try { return systemPreferences.isTrustedAccessibilityClient(Boolean(prompt)); } catch { return null; }
}

/** Which of `kinds` are off right now. Input Monitoring that cannot be read is not reported. */
async function missing(kinds = ['microphone', 'accessibility', 'input', 'automation']) {
  const off = [];
  if (kinds.includes('microphone')) {
    // Never answered counts as off too: Typd cannot hear anyone, and it is not even in the list yet.
    const mic = micStatus();
    if (mic === 'denied' || mic === 'restricted' || mic === 'not-determined') off.push('microphone');
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

/**
 * Put Typd in the pane's list if a call can (macOS may add its own prompt), then open the pane.
 * The microphone has no + button in its pane: until macOS has an answer, opening the pane shows a
 * list without Typd. So a microphone never answered gets macOS's own prompt instead, and the pane
 * only if that answer is no.
 */
function request(kind) {
  if (kind === 'microphone' && micStatus() === 'not-determined') {
    requestMic('the person asked', { again: true }).then((s) => {
      if (s === 'denied' || s === 'restricted') openPane('microphone');
    });
    return;
  }
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
  const micFirst = off[0] === 'microphone' && micStatus() === 'not-determined';
  if (micFirst && off.length === 1) {
    return 'macOS shows its own dialog: click Allow there. Typd then appears in Privacy & Security › Microphone, switched on.';
  }
  const lists = off.length === 1 ? 'that list' : 'each list';
  let text = micFirst
    ? `macOS asks about the microphone in its own dialog first: click Allow there. Then, in Privacy & Security, turn on “${holder()}” in each other list. Typd notices each switch by itself`
    : `In Privacy & Security, turn on “${holder()}” in ${lists}. Typd notices each switch by itself`;
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

/**
 * The one dialog. Resolves 'open' (the first button: System Settings, or macOS's prompt for a
 * microphone never answered), 'reset' ("Ask macOS Again", offered when macOS says the microphone is
 * off for Typd) or 'later'.
 */
async function ask(off) {
  dialogOpen = true;
  try {
    // A menu-bar app is never frontmost by itself; without this the dialog can open behind the
    // window the person is looking at.
    try { app.focus({ steal: true }); } catch { /* it still shows */ }
    const count = ['', 'one switch', 'two switches', 'three switches', 'four switches'][off.length] || 'some switches';
    // The microphone first and never answered: the button asks macOS (its prompt puts Typd in the list).
    const mic = micStatus();
    const askFirst = off[0] === 'microphone' && mic === 'not-determined';
    // macOS says the microphone is off for Typd: a switch in the Microphone list -- unless Typd is not
    // in that list at all (a reporter's macOS 27: "turned off", and no Typd to turn on). Then only
    // clearing Typd's own answer in macOS and asking again helps: "Ask macOS Again".
    const offered = off.includes('microphone') && (mic === 'denied' || mic === 'restricted') && app.isPackaged;
    const buttons = [askFirst ? 'Allow Microphone' : 'Open System Settings', ...(offered ? ['Ask macOS Again'] : []), 'Not Now'];
    // The Mac CI (scripts/mac-mic-check.sh), when it cannot click Typd's own dialog: the answer it names.
    const test = process.env.TYPD_TEST_DIALOG_ANSWER;
    if (test && ['open', 'reset', 'later'].includes(test) && (test !== 'reset' || offered)) {
      lifeLog('permissions', 'test: the dialog answered ' + test + ' (TYPD_TEST_DIALOG_ANSWER; buttons ' + buttons.join(', ') + ')');
      return test;
    }
    const { response } = await dialog.showMessageBox({
      type: 'none',
      icon: icon(),
      title: 'Typd',
      message: `Typd needs ${count} turned on`,
      detail: off.map(why).join('\n\n') + '\n\n' + how(off) + (offered
        ? '\n\nTypd not in the Microphone list? “Ask macOS Again” clears Typd’s microphone answer in macOS ' +
          '(what “tccutil reset Microphone ' + BUNDLE_ID + '” does in Terminal) and asks once more.'
        : ''),
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true
    });
    return response === 0 ? 'open' : offered && response === 1 ? 'reset' : 'later';
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
  // The microphone first, through macOS's own prompt: the first time, that is all it takes. Its
  // answer is waited for, but not forever (requestMic). Still unanswered after that, Typd puts no
  // dialog of its own over macOS's prompt -- a modal dialog would also hold Typd itself up until it
  // is closed, macOS's answer included (seen in CI: the main thread 22 s late). Instead the Typd
  // window opens on its card (Allow microphone / Ask again; the walkthrough's box on a fresh
  // install), and this check runs again the moment macOS answers.
  if (micStatus() === 'not-determined') {
    const s = await requestMic('the ' + reason + ' check');
    if (s === 'asking' && micAsking) {
      lifeLog('microphone', 'macOS’s prompt still unanswered: no dialog of Typd’s over it; the Typd window offers to ask again');
      recheckOnAnswer = true;   // whichever request macOS answers (requestMic), the check runs again
      if (onUnanswered) { try { onUnanswered(); } catch { /* the window is optional */ } }
      return false;
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

  const answer = await ask(off);
  if (answer === 'open') {
    request(off[0]);
    watch(off);
  } else if (answer === 'reset') {
    const r = await resetMic('the dialog');
    if (r.refusedAtOnce) await refusedAtOnce();
    else watch(off);
  }
  return false;
}

/**
 * Clear Typd's own microphone answer in macOS -- `tccutil reset Microphone ai.typd.app`, which any
 * user may run for any app -- and ask again: for a microphone macOS says is off while Typd is not in
 * Privacy & Security › Microphone, so there is no switch to turn on. Only when the person asks for it
 * (a button), only Typd's own entry. Logged. If macOS then refuses at once, without its dialog, the
 * refusal is a rule on this Mac (a management profile, Screen Time, a policy), not an answer.
 *
 * @returns {Promise<{state: string, reset: boolean, refusedAtOnce?: boolean}>}
 */
async function resetMic(why) {
  const before = micStatus();
  if (!app.isPackaged) return { state: before, reset: false };   // from source the entry is Terminal's, not Typd's
  // LaunchServices first: a copy of Typd that is gone may still be the app macOS finds for Typd's id
  // (mac/app-location.js); this copy registered, the gone ones forgotten.
  try { await require('./mac/app-location').tidy(require('./settings'), { force: true, scan: true }); } catch { /* not here */ }
  const r = await new Promise((resolve) => {
    require('child_process').execFile('/usr/bin/tccutil', ['reset', 'Microphone', BUNDLE_ID], { timeout: 10000 }, (err, out, errOut) =>
      resolve({ ok: !err, said: String(out || errOut || (err && err.message) || '').trim().split('\n')[0].slice(0, 160) }));
  });
  lifeLog('microphone', 'tccutil reset Microphone ' + BUNDLE_ID + ': ' + (r.ok ? 'done' : 'failed') + ' (' + why + '; status was ' + before + ', now ' + micStatus() + ')');
  log('tccutil reset Microphone ' + BUNDLE_ID + ': ' + (r.ok ? 'done' : 'failed: ' + r.said));
  const at = Date.now();
  const state = await requestMic('after a reset (' + why + ')', { again: true });
  if (state === 'denied' || state === 'restricted') {
    const atOnce = Date.now() - at < 2000;
    lifeLog('microphone', atOnce ? 'macOS refused at once after the reset, without its dialog (' + state + '): a rule on this Mac, not an answer' : 'still ' + state + ' after the reset');
    return { state, reset: r.ok, refusedAtOnce: atOnce };
  }
  return { state, reset: r.ok };
}

/** macOS refused the microphone without asking, even after a reset: say so plainly, once. */
async function refusedAtOnce() {
  dialogOpen = true;
  try {
    try { app.focus({ steal: true }); } catch { /* it still shows */ }
    await dialog.showMessageBox({
      type: 'none',
      icon: icon(),
      title: 'Typd',
      message: 'macOS refuses the microphone to Typd without asking',
      detail: 'This is a rule on this Mac, not an answer you gave: a management profile (a work or school Mac), ' +
        'Screen Time, or a security setting. Typd cannot change that.\n\nTo look into it: Typd’s menu › Copy diagnostics, ' +
        'and send it to the developer.',
      buttons: ['OK'],
      noLink: true
    });
  } finally {
    dialogOpen = false;
    lastShown = Date.now();
  }
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

/** Is the permissions dialog, or macOS's microphone prompt, on screen? (appUpdate.js never quits for an update under it.) */
// The walkthrough waits on this too (with a shorter `limit`), so that its window comes after macOS's
// prompt is answered -- but a prompt nobody answers (or nobody can see) must not hold it back for long.
function isAsking(limit = MIC_WAIT_MS) { return dialogOpen || Boolean(micAsking && Date.now() - micAsking.at < limit); }

module.exports = { ensure, status, openPane, isAsking, request, requestMic, resetMic, micState, onMicChange, whenUnanswered };
