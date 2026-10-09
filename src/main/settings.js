'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * The five things that cannot be learned or inferred (ROADMAP, Law 2), in one small file
 * beside the dictionary: %APPDATA%\typd\settings.json. Anything not in DEFAULTS is ignored,
 * so the file cannot grow into a junk drawer by accident.
 */
const DEFAULTS = {
  mic: '',              // '' = the Windows default device; otherwise a deviceId the overlay asks for
  micLabel: '',         // shown in Settings; the id alone means nothing to a person
  sounds: true,
  startAtLogin: true,
  keepRecordings: true, // the user's own recordings feed training (consent 2026-10-05)
  hotkey: 'RightAlt',   // or 'CommandOrControl+Shift+Space' where Right Alt is busy as AltGr
  sharePaused: false    // tester builds only (collect.js): true queues and sends nothing
};
const HOTKEYS = ['RightAlt', 'CommandOrControl+Shift+Space'];

// macOS: Right ⌘ rather than Right Option, which types characters on most Mac layouts
// (hotkeys.js, TAP_KEYS). The chord is the same on both: ⇧⌘Space there.
if (process.platform === 'darwin') {
  DEFAULTS.hotkey = 'RightMeta';
  HOTKEYS[0] = 'RightMeta';
}

const file = () => path.join(app.getPath('appData'), 'typd', 'settings.json');
let cache = null;
const listeners = [];

function read() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* first run */ }
  cache = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) cache[k] = saved[k];
  if (!HOTKEYS.includes(cache.hotkey)) cache.hotkey = DEFAULTS.hotkey;
  return cache;
}

function get(key) {
  return key ? read()[key] : { ...read() };
}

/** Set one known key to a value of the right type; returns false for anything else. */
function set(key, value) {
  const s = read();
  if (!(key in DEFAULTS) || typeof value !== typeof DEFAULTS[key]) return false;
  if (key === 'hotkey' && !HOTKEYS.includes(value)) return false;
  if (typeof value === 'string' && value.length > 512) return false;
  if (s[key] === value) return true;
  s[key] = value;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(s, null, 2));
  } catch { /* still applies for this run */ }
  for (const fn of listeners) fn(key, value);
  return true;
}

function onChange(fn) { listeners.push(fn); }

module.exports = { get, set, onChange, HOTKEYS };
