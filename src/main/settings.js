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
  // Since 0.2.7 Typd asks (shareRule): a fresh install on the walkthrough's first screen, an install
  // first started from 2026-10-18 15:00 UTC on in one small screen. 0.2.4-0.2.6 shared by default
  // ('on' was the default, not an answer); before 0.2.4 '' meant a consent screen never answered.
  share: 'on',
  // Since 0.2.7: '' = the rule above not applied yet (an earlier Typd's file, or a fresh install);
  // 'due' = the small "Help make Typd better?" screen shows at the next launch; 'done' = no screen
  // (shown once, answered, or not needed).
  shareAsk: '',
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
  // Sharing: as saved once 0.2.7 decided it (shareAsk 'due' or 'done'); else decided now, once, and kept.
  const sh = shareRule(saved, { fresh: () => decideFresh(), firstLaunch: firstLaunchAt });
  cache.share = sh.share;
  cache.shareAsk = sh.shareAsk;
  if (cache.flagHotkey && !hotkeyLogic.validFlag(cache.flagHotkey, process.platform)) cache.flagHotkey = DEFAULTS.flagHotkey;
  if (!VARIANTS.includes(cache.modelVariant)) cache.modelVariant = DEFAULTS.modelVariant;
  if (!LOW_MEMORY.includes(cache.lowMemory)) cache.lowMemory = DEFAULTS.lowMemory;
  if (!['', 'due', 'done'].includes(cache.walkthrough)) cache.walkthrough = 'done';
  if (sh.decided && !firstRun) write(cache);   // kept, so it is decided once (a first run's file: isFirstRun())
  return cache;
}

/**
 * Sharing is asked, not assumed (0.2.7). Who still shares without being asked: only the installs
 * first started before SHARE_CUTOFF -- the people who agreed in person while 0.2.4-0.2.6 shared by
 * default. After it, 'on' in an earlier Typd's file came from that default (settings.json cannot
 * tell it from a Settings switch turned on), so it is no answer: such an install is asked once.
 */
const SHARE_CUTOFF = Date.parse('2026-10-18T15:00:00Z');

/**
 * {share, shareAsk, decided} from settings.json as saved.
 *   shareAsk 'due' or 'done' (0.2.7 or later wrote it): 'share' as saved -- 'on', 'off' or 'ask';
 *     anything else reads as 'off', so a hand edit is never taken for a yes.
 *   shareAsk '' or missing -- decided now (decided: true, and kept):
 *     a fresh install                         'ask', 'done' (the walkthrough's first screen asks)
 *     'off' (or anything Typd never wrote)    'off', 'done' (an explicit no stays no)
 *     'on', '' or none, first started
 *       before SHARE_CUTOFF                   'on',  'done' (as before; no new screen)
 *       from SHARE_CUTOFF on, or unknown      'ask', 'due'  (the small screen, once)
 * fresh and firstLaunch are functions, asked only when needed; firstLaunch() is ms, or Infinity.
 */
function shareRule(saved, { fresh, firstLaunch, cutoff = SHARE_CUTOFF }) {
  const s = saved && typeof saved === 'object' ? saved : {};
  if (s.shareAsk === 'due' || s.shareAsk === 'done') {
    return { share: ['on', 'off', 'ask'].includes(s.share) ? s.share : 'off', shareAsk: s.shareAsk, decided: false };
  }
  if (fresh()) return { share: 'ask', shareAsk: 'done', decided: true };
  if (!('share' in s) || s.share === '' || s.share === 'on') {
    return firstLaunch() < cutoff ? { share: 'on', shareAsk: 'done', decided: true } : { share: 'ask', shareAsk: 'due', decided: true };
  }
  return { share: 'off', shareAsk: 'done', decided: true };
}

/**
 * When Typd first ran here, as well as this computer can tell (ms; Infinity if nothing says): the
 * earliest of settings.json's creation time (written on the first launch and only ever rewritten in
 * place, so it keeps it), the creation time of the folders Typd made then (its settings folder and
 * userData), history.json's, the oldest kept recording's own time (its file name), and when this
 * install enrolled for sharing (share.json). None can be earlier than the first launch, only later,
 * so the earliest is the best guess; times before 2026 or in the future are ignored.
 */
function firstLaunchAt() {
  const times = [];
  const sane = (t) => Number.isFinite(t) && t > Date.parse('2026-01-01T00:00:00Z') && t < Date.now() + 60e3;
  const born = (p) => { try { return fs.statSync(p).birthtimeMs || NaN; } catch { return NaN; } };
  try {
    const appData = app.getPath('appData');
    const userData = app.getPath('userData');
    for (const p of [file(), path.dirname(file()), userData, path.join(appData, 'typd', 'history.json')]) times.push(born(p));
    try {
      for (const f of fs.readdirSync(recordingsDir())) {
        const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.wav$/.exec(f);   // index.js keepRecording's names
        if (m) times.push(Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`));
      }
    } catch { /* no recordings */ }
    try { times.push(Date.parse(JSON.parse(fs.readFileSync(path.join(userData, 'share.json'), 'utf8')).enrolledAt)); } catch { /* not enrolled */ }
  } catch { /* no paths */ }
  const good = times.filter(sane);
  return good.length ? Math.min(...good) : Infinity;
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
  if (s[key] === value) return true;
  s[key] = value;
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

module.exports = { get, set, onChange, isFirstRun, isFreshInstall, walkthroughFor, recordingsDir, shareRule, firstLaunchAt, SHARE_CUTOFF, HOTKEYS, DEFAULTS };
