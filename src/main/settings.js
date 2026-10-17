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
  // Public builds (sharing.js): 'on' or 'off'. On by default since 0.2.4 (the first walkthrough
  // screen says so, and Settings turns it off). Before 0.2.4 it was '' until a consent screen was
  // answered: an install that never answered reads as 'on', and an 'off' it chose stays off.
  share: 'on',
  // "That was wrong": a combination (globalShortcut) that flags the last dictation; '' = none.
  flagHotkey: hotkeyLogic.flagDefaultFor(process.platform),
  // macOS only: keep the Dock icon while Typd runs. Off, Typd lives in the menu bar and the
  // Dock icon shows only while the Typd window is open (home-window.js, syncDock).
  showInDock: false,
  // Which published model to follow (modelChoice.js): 'auto' (the hardware decides), 'full' or 'light'.
  modelVariant: 'auto',
  // Ask before every model download. Off: downloads over 300 MB ask first only on a metered connection.
  askBeforeModelDownload: false,
  // The first-run walkthrough (home window): '' until it has been shown once, then 'done'.
  walkthrough: ''
};

const VARIANTS = ['auto', 'full', 'light'];

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
  cache.share = shareFrom(saved);
  if (cache.flagHotkey && !hotkeyLogic.validFlag(cache.flagHotkey, process.platform)) cache.flagHotkey = DEFAULTS.flagHotkey;
  if (!VARIANTS.includes(cache.modelVariant)) cache.modelVariant = DEFAULTS.modelVariant;
  if (!['', 'done'].includes(cache.walkthrough)) cache.walkthrough = 'done';
  return cache;
}

/**
 * 'share' as saved: 'on' and 'off' as they are; never set, or '' (a consent screen from before
 * 0.2.4 never answered), is 'on'. Anything else was not written by Typd (set() refuses it): it
 * reads as 'off', so a hand edit is never taken for a yes.
 */
function shareFrom(saved) {
  if (!saved || typeof saved !== 'object' || !('share' in saved) || saved.share === '' || saved.share === 'on') return 'on';
  return 'off';
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
  if (key === 'walkthrough' && !['', 'done'].includes(value)) return false;
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

function onChange(fn) { listeners.push(fn); }

/** Where "Keep recordings" puts each dictation's audio. */
function recordingsDir() {
  return path.join(app.getPath('appData'), 'Typd', 'recordings');
}

module.exports = { get, set, onChange, isFirstRun, recordingsDir, HOTKEYS, DEFAULTS };
