'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const hotkeyLogic = require('./hotkey-logic');

/**
 * The five things that cannot be learned or inferred (ROADMAP, Law 2), in one small file
 * beside the dictionary: %APPDATA%\typd\settings.json. Anything not in DEFAULTS is ignored,
 * so the file cannot grow into a junk drawer by accident.
 */
const DEFAULTS = {
  mic: '',              // '' = the system default device; otherwise a deviceId the overlay asks for
  micLabel: '',         // shown in Settings; the id alone means nothing to a person
  sounds: true,
  startAtLogin: true,
  keepRecordings: true, // the user's own recordings feed training (consent 2026-10-05)
  // Any key hotkey-logic.validate accepts: 'RightAlt', 'RightCtrl', 'F13', 'Ctrl+Shift+Space'...
  // macOS: Right ⌘ rather than Right Option, which types characters on most Mac layouts.
  hotkey: hotkeyLogic.defaultFor(process.platform),
  sharePaused: false,   // tester builds only (sharing.js): true queues and sends nothing
  // Public builds (sharing.js): 'on', 'off', or 'ask' -- not answered yet, which shares nothing.
  // Typd asks (shareRule): a fresh install on the walkthrough's first screen; since 0.2.12 every
  // other install that never chose, once, in one small screen. 0.2.4-0.2.6 shared by default ('on'
  // was the default, not an answer); before 0.2.4 '' meant a consent screen never answered.
  share: 'on',
  // Since 0.2.7: '' = the rule above not applied yet (an earlier Typd's file, or a fresh install);
  // 'due' = the small "Help make Typd better?" screen shows at the next launch; 'done' = no screen
  // (shown once, answered, or not needed).
  shareAsk: '',
  // Since 0.2.12: true once 'share' was set by a person's choice -- the walkthrough's first screen,
  // the small screen or Settings' switch (set() records it with 'share', in the same write). Only
  // an 'on' with it shares; an 'on' without it (an earlier Typd's) is no answer (shareRule).
  shareChosen: false,
  // "That was wrong": a combination (globalShortcut) that flags the last dictation; '' = none.
  flagHotkey: hotkeyLogic.flagDefaultFor(process.platform),
  // macOS only: keep the Dock icon while Typd runs. Off, Typd lives in the menu bar and the
  // Dock icon shows only while the Typd window is open (home-window.js, syncDock).
  showInDock: false,
  // Which published model to follow (modelChoice.js): 'auto' (the hardware decides), 'full' or 'light'.
  modelVariant: 'auto',
  // Ask before every model download. Off: downloads over 300 MB ask first only on a metered connection.
  askBeforeModelDownload: false,
  // Low-memory mode (0.2.6, lowMemory.js): 'auto' (on for the light model or a computer with less than
  // 8 GB of memory), 'on' or 'off'. Settings > Model, under the model choice.
  lowMemory: 'auto',
  // The first-run walkthrough (home window): 'due' on a fresh install until it has been shown once,
  // then 'done'; '' (never decided) becomes one of the two at launch (walkthroughFor). Fresh installs
  // only: an update, or any install that ran Typd before, never sees it (since 0.2.4).
  walkthrough: '',
  // macOS: the places this Typd ran from, newest first, one per line (mac/app-location.js): copies that
  // are gone are unregistered from LaunchServices, so macOS never ties Typd's permissions to them.
  macAppPaths: ''
};

const VARIANTS = ['auto', 'full', 'light'];
const LOW_MEMORY = ['auto', 'on', 'off'];

/** Two good choices, for anything that wants to suggest one: the default key and a chord. */
const HOTKEYS = [DEFAULTS.hotkey, process.platform === 'darwin' ? 'Command+Shift+Space' : 'Ctrl+Shift+Space'];

const file = () => path.join(app.getPath('appData'), 'typd', 'settings.json');
let cache = null;
let firstRun = null;
const listeners = [];

function read() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* first run */ }
  if (firstRun === null) firstRun = !fs.existsSync(file());
  cache = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) cache[k] = saved[k];
  // An old 'CommandOrControl+Shift+Space' is written the current way; anything unusable falls
  // back to the default rather than leaving Typd with no key at all.
  cache.hotkey = hotkeyLogic.normalize(cache.hotkey, process.platform, { sideButtons: true });
  // Sharing: as saved when a choice set it, or once it was asked; else decided now, once, and kept.
  const sh = shareRule(saved, { fresh: () => decideFresh() });
  cache.share = sh.share;
  cache.shareAsk = sh.shareAsk;
  cache.shareChosen = sh.shareChosen;
  if (cache.flagHotkey && !hotkeyLogic.validFlag(cache.flagHotkey, process.platform)) cache.flagHotkey = DEFAULTS.flagHotkey;
  if (!VARIANTS.includes(cache.modelVariant)) cache.modelVariant = DEFAULTS.modelVariant;
  if (!LOW_MEMORY.includes(cache.lowMemory)) cache.lowMemory = DEFAULTS.lowMemory;
  if (!['', 'due', 'done'].includes(cache.walkthrough)) cache.walkthrough = 'done';
  if (sh.decided && !firstRun) write(cache);   // kept, so it is decided once (a first run's file: isFirstRun())
  return cache;
}

/**
 * Sharing is asked, not assumed. Since 0.2.12 a public install shares only if a person chose it:
 * the walkthrough's first screen, the small "Help make Typd better?" screen or Settings' switch,
 * each of which sets 'share' through set(), and set() records shareChosen with it.
 *
 * Before 0.2.12 nothing recorded that, and settings.json cannot tell a choice from a default: an
 * earlier Typd's 'on' may be 0.2.4-0.2.6's default (written to the file with any other setting),
 * 0.2.7-0.2.11's exemption for installs first started before 2026-10-18 15:00 UTC (taken then as
 * "agreed in person", without asking), 0.2.0-0.2.3's consent screen, or a real answer or switch --
 * all the same 'on'. So an 'on' without shareChosen is no answer: such an install is asked once,
 * and shares nothing until it answers. 'off' was never a default (0.2.0-0.2.3: '' until answered;
 * since: 'on', then 'ask'), so an 'off' is someone's choice and stays.
 *
 * {share, shareAsk, shareChosen, decided} from settings.json as saved (decided: changed now, and kept):
 *   'on' with shareChosen                     'on', as saved            (a choice: no screen)
 *   'ask' (0.2.7 or later wrote it)           'ask', shareAsk as saved  (asked or due already)
 *   a fresh install (no shareAsk yet)         'ask', 'done'             (the walkthrough's first screen asks)
 *   'on' without shareChosen; or, in a file
 *     from before 0.2.7, '' or no 'share'     'ask', 'due'              (the small screen, once)
 *   'off' (or anything Typd never wrote)      'off'                     (a no stays no; a hand edit is never a yes)
 * fresh is a function, asked only for a file from before 0.2.7 (no shareAsk).
 */
function shareRule(saved, { fresh }) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const known = s.shareAsk === 'due' || s.shareAsk === 'done';   // 0.2.7 or later wrote it
  const chosen = s.shareChosen === true;
  if (s.share === 'on' && chosen) return { share: 'on', shareAsk: known ? s.shareAsk : 'done', shareChosen: true, decided: !known };
  if (known && s.share === 'ask') return { share: 'ask', shareAsk: s.shareAsk, shareChosen: false, decided: chosen };
  if (!known && fresh()) return { share: 'ask', shareAsk: 'done', shareChosen: false, decided: true };
  if (s.share === 'on' || (!known && (!('share' in s) || s.share === ''))) return { share: 'ask', shareAsk: 'due', shareChosen: false, decided: true };
  return { share: 'off', shareAsk: known ? s.shareAsk : 'done', shareChosen: chosen, decided: !known || s.share !== 'off' };
}

function write(s) {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(s, null, 2));
  } catch { /* still applies for this run */ }
}

function get(key) {
  return key ? read()[key] : { ...read() };
}

/** Set one known key to a value of the right type; returns false for anything else. */
function set(key, value) {
  const s = read();
  if (!(key in DEFAULTS) || typeof value !== typeof DEFAULTS[key]) return false;
  if (key === 'hotkey') {
    const v = hotkeyLogic.validate(value, process.platform, { sideButtons: true });
    if (!v.ok) return false;
    value = v.binding;
  }
  if (key === 'share' && !['on', 'off'].includes(value)) return false;
  if (key === 'shareChosen') return false;   // set only with 'share', below
  if (key === 'modelVariant' && !VARIANTS.includes(value)) return false;
  if (key === 'lowMemory' && !LOW_MEMORY.includes(value)) return false;
  if (key === 'walkthrough' && !['', 'due', 'done'].includes(value)) return false;
  if (key === 'shareAsk' && !['due', 'done'].includes(value)) return false;
  if (key === 'flagHotkey' && value) {
    const v = hotkeyLogic.validFlag(value, process.platform);
    if (!v) return false;
    value = v;
  }
  if (typeof value === 'string' && value.length > 512) return false;
  if (s[key] === value && (key !== 'share' || s.shareChosen)) return true;
  s[key] = value;
  // 'share' is set only by a person's choice (sharing.js: the walkthrough's first screen, the small
  // screen, Settings' switch, "Delete what I've shared"): recorded with it, in the same write, so a
  // later launch can tell a choice from a default (shareRule).
  if (key === 'share') s.shareChosen = true;
  write(s);
  for (const fn of listeners) fn(key, value);
  return true;
}

/**
 * True on the very first launch: settings.json did not exist yet. The file is written at
 * once, so the next launch is not a first run however soon Typd is quit.
 */
function isFirstRun() {
  read();
  if (firstRun && !fs.existsSync(file())) write(read());
  return firstRun;
}

/**
 * A fresh install: nothing an earlier Typd leaves behind is here -- no settings.json (as this
 * launch found it, before isFirstRun() writes one), no history, no app-update state, no model it
 * downloaded or carried over from the version it replaced, no kept recordings. Decided once, at
 * the first call (index.js makes it before anything of this launch can write them).
 */
let fresh = null;
function isFreshInstall() {
  read();
  return decideFresh();
}

/** isFreshInstall() without read(): read() asks it for 'share' (shareRule) while it builds the cache. */
function decideFresh() {
  if (fresh !== null) return fresh;
  const appData = app.getPath('appData');
  const userData = app.getPath('userData');
  const traces = [
    path.join(appData, 'typd', 'history.json'),
    path.join(userData, 'app-update'),
    path.join(userData, 'carried'),
    path.join(userData, 'models'),
    path.join(appData, 'Typd', 'recordings')
  ];
  fresh = Boolean(firstRun) && !traces.some((p) => { try { return fs.existsSync(p); } catch { return false; } });
  return fresh;
}

/**
 * What 'walkthrough' should say now. 'done' stays done. A fresh install's first start makes it
 * 'due' (and it stays due until it is shown, should that first launch end early); anything else
 * -- an update's first start, or an install that ran Typd before the walkthrough existed or before
 * this rule ('' saved) -- makes it 'done', so it never appears.
 */
function walkthroughFor({ fresh: isFresh, afterUpdate, current = get('walkthrough') }) {
  if (current === 'done' || afterUpdate) return 'done';
  if (current === 'due') return 'due';
  return isFresh ? 'due' : 'done';
}

function onChange(fn) { listeners.push(fn); }

/** Where "Keep recordings" puts each dictation's audio. */
function recordingsDir() {
  return path.join(app.getPath('appData'), 'Typd', 'recordings');
}

module.exports = { get, set, onChange, isFirstRun, isFreshInstall, walkthroughFor, recordingsDir, shareRule, HOTKEYS, DEFAULTS };
