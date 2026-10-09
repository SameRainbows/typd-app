'use strict';

/**
 * The hotkey, without Electron: which keys can be bound, what they are called,
 * which are refused and why, and the state machine that turns presses into
 * "start", "finish" and "toggle". Pure, so bench/hotkeys.js can replay real key
 * sequences -- AltGr+Q above all -- against exactly the code the app runs.
 *
 * Two kinds of binding share one string in settings.json:
 *
 *   a single key, heard through the native hook (uiohook): 'RightAlt',
 *   'RightCtrl', 'F13', 'Mouse4'... -- left and right told apart, press and
 *   release both seen;
 *
 *   a key combination, an Electron accelerator for globalShortcut:
 *   'CommandOrControl+Shift+Space', 'Ctrl+Shift+D' -- press only, and Windows
 *   or macOS hands it to Typd alone.
 *
 * The gesture follows from the key, so there is no hold/toggle setting:
 *
 *   modifiers (Right Alt, Right Ctrl, Right Shift, Right ⌘) are tapped. They are
 *   also half of every shortcut and every Ctrl-click, so only a clean tap
 *   counts -- pressed and released within TAP_MS with no other key or click in
 *   between -- and holding one does nothing. That is what keeps AltGr+Q typing
 *   "@" on a Turkish keyboard, and ⌘-click opening a link on a Mac.
 *
 *   dedicated keys (F13-F24, a mouse side button) do nothing else, so they get
 *   both gestures: tap to start and tap to finish, or hold while you talk and
 *   let go to finish (HOLD_MS decides which it was).
 *
 *   combinations are pressed to start and pressed again to finish:
 *   globalShortcut never reports a release.
 */

const TAP_MS = 600;
const HOLD_MS = 400;

const F_KEYS = (from, to) => {
  const out = {};
  for (let n = from; n <= to; n++) out['F' + n] = { key: 'F' + n, label: 'F' + n, kind: 'key' };
  return out;
};

/*
 * Every single key Typd can listen for, per platform. `key` is the uiohook name,
 * `ignore` lists keys that do not count as "another key" while this one is held
 * (Windows fakes a Left Ctrl alongside AltGr), `short` is the name for tight
 * places like the pill. Names are positions, not platform words: RightAlt is the
 * same key on both, which macOS calls Right Option. RightMeta is offered only on a
 * Mac, where Right ⌘ is the default -- Option types characters on most Mac
 * layouts, the AltGr trap one key over -- and on Windows it would open Start.
 */
const KEYS = {
  win32: {
    RightAlt: { key: 'AltRight', label: 'Right Alt', kind: 'modifier', ignore: ['Ctrl', 'CtrlRight'], alt: true },
    RightCtrl: { key: 'CtrlRight', label: 'Right Ctrl', kind: 'modifier' },
    RightShift: { key: 'ShiftRight', label: 'Right Shift', kind: 'modifier' },
    ...F_KEYS(13, 24),
    Mouse4: { button: 4, label: 'Mouse back button', short: 'Back button', kind: 'button' },
    Mouse5: { button: 5, label: 'Mouse forward button', short: 'Forward button', kind: 'button' }
  },
  darwin: {
    RightMeta: { key: 'MetaRight', label: 'Right ⌘ (Command)', short: 'Right ⌘', kind: 'modifier' },
    RightAlt: { key: 'AltRight', label: 'Right Option', short: 'Right ⌥', kind: 'modifier' },
    RightCtrl: { key: 'CtrlRight', label: 'Right Control', short: 'Right ⌃', kind: 'modifier' },
    RightShift: { key: 'ShiftRight', label: 'Right Shift', short: 'Right ⇧', kind: 'modifier' },
    ...F_KEYS(13, 20)
  }
};

const DEFAULTS = { win32: 'RightAlt', darwin: 'RightMeta' };
const CHORD_EXAMPLE = { win32: 'Ctrl+Shift+Space', darwin: 'Command+Shift+Space' };

const keysFor = (platform) => KEYS[platform] || KEYS.win32;
const defaultFor = (platform) => DEFAULTS[platform] || DEFAULTS.win32;

/** The single-key entry a binding names (any case), or null for an accelerator. */
function single(binding, platform) {
  const keys = keysFor(platform);
  const want = String(binding || '').toLowerCase();
  const name = Object.keys(keys).find((k) => k.toLowerCase() === want);
  return name ? { name, ...keys[name] } : null;
}

/* ------------------------------------------------------------ accelerators */

const MODS = {
  ctrl: /^(ctrl|control)$/i,
  alt: /^(alt|option|altgr)$/i,
  shift: /^shift$/i,
  cmd: /^(command|cmd|super|meta)$/i,
  either: /^(commandorcontrol|cmdorctrl)$/i
};

// Keys globalShortcut accepts and a person can reasonably mean.
const NAMED = ['Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter', 'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc'];
const PUNCT = [',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`'];

function canonicalKey(k) {
  if (/^[a-z]$/i.test(k)) return k.toUpperCase();
  if (/^[0-9]$/.test(k)) return k;
  const f = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(k);
  if (f) return 'F' + f[1];
  const named = NAMED.find((n) => n.toLowerCase() === k.toLowerCase());
  if (named) return named === 'Enter' ? 'Return' : named === 'Esc' ? 'Escape' : named;
  if (PUNCT.includes(k)) return k;
  return null;
}

/** 'CommandOrControl+Shift+Space' -> { mods: {ctrl, alt, shift, cmd}, key: 'Space' }, or null. */
function parseAccelerator(binding, platform) {
  const parts = String(binding || '').split('+').map((p) => p.trim());
  if (parts.length < 1 || parts.some((p) => !p)) {
    // "Ctrl++" (the plus key) is not offered; a trailing empty part is malformed.
    return null;
  }
  const key = canonicalKey(parts.pop());
  if (!key) return null;
  const mods = { ctrl: false, alt: false, shift: false, cmd: false };
  for (const p of parts) {
    if (MODS.either.test(p)) mods[platform === 'darwin' ? 'cmd' : 'ctrl'] = true;
    else if (MODS.ctrl.test(p)) mods.ctrl = true;
    else if (MODS.alt.test(p)) mods.alt = true;
    else if (MODS.shift.test(p)) mods.shift = true;
    else if (MODS.cmd.test(p)) mods.cmd = true;
    else return null;
  }
  return { mods, key };
}

/** The accelerator written the one way Typd stores it ('Ctrl+Shift+Space', 'Command+Shift+Space'). */
function formatAccelerator({ mods, key }) {
  const out = [];
  if (mods.ctrl) out.push('Ctrl');
  if (mods.cmd) out.push('Command');
  if (mods.alt) out.push('Alt');
  if (mods.shift) out.push('Shift');
  out.push(key);
  return out.join('+');
}

const MAC_GLYPHS = { ctrl: '⌃', alt: '⌥', shift: '⇧', cmd: '⌘' };

/** The keys of a binding, one per keycap: ['Ctrl', 'Shift', 'Space'] or ['⇧', '⌘', 'Space']. */
function parts(binding, platform) {
  const one = single(binding, platform);
  if (one) return [one.short || one.label];
  const acc = parseAccelerator(binding, platform);
  if (!acc) return [String(binding || '')];
  if (platform === 'darwin') {
    return [...['ctrl', 'alt', 'shift', 'cmd'].filter((m) => acc.mods[m]).map((m) => MAC_GLYPHS[m]), acc.key];
  }
  const names = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', cmd: 'Win' };
  return [...['ctrl', 'alt', 'shift', 'cmd'].filter((m) => acc.mods[m]).map((m) => names[m]), acc.key];
}

/** What people call it: 'Right Alt', 'Right ⌘ (Command)', 'Ctrl+Shift+Space', '⇧⌘Space'. */
function label(binding, platform) {
  const one = single(binding, platform);
  if (one) return one.label;
  const p = parts(binding, platform);
  return platform === 'darwin' ? p.slice(0, -1).join('') + p[p.length - 1] : p.join('+');
}

/** The same, for a 30-character pill: 'Right ⌘', 'Back button'. */
function shortLabel(binding, platform) {
  const one = single(binding, platform);
  return one ? (one.short || one.label) : label(binding, platform);
}

/** 'tap' for a single key, 'press' for a combination: the verb every message uses. */
function verb(binding, platform) {
  return single(binding, platform) ? 'tap' : 'press';
}

/* -------------------------------------------------------------- refusals */

const RESERVED = {
  win32: ['Alt+F4', 'Alt+Tab', 'Alt+Escape', 'Ctrl+Escape', 'Ctrl+Shift+Escape', 'Alt+Space'],
  darwin: ['Command+Space', 'Command+Tab', 'Command+Q', 'Command+W', 'Ctrl+Space', 'Command+Escape',
    'Shift+Command+3', 'Shift+Command+4', 'Shift+Command+5', 'Alt+Command+Escape']
};

function isReserved(acc, platform) {
  const want = formatAccelerator(acc).toLowerCase();
  return (RESERVED[platform] || []).some((r) => {
    const p = parseAccelerator(r, platform);
    return p && formatAccelerator(p).toLowerCase() === want;
  });
}

// Single keys a person may press in the picker that Typd will not take, by the
// name the picker gives them, and why. Everything here either types, already
// does something the hook cannot stop, or gets pressed by accident.
function refuseSingle(name, platform) {
  const mac = platform === 'darwin';
  const ex = CHORD_EXAMPLE[platform] || CHORD_EXAMPLE.win32;
  const n = String(name || '');
  if (/^Left(Ctrl|Alt|Shift|Meta)$/i.test(n)) {
    const which = n.replace(/^Left/i, '');
    const word = { ctrl: mac ? 'Control' : 'Ctrl', alt: mac ? 'Option' : 'Alt', shift: 'Shift', meta: mac ? '⌘' : 'Win' }[which.toLowerCase()];
    if (!mac && /meta/i.test(which)) return 'Windows keeps the Win key for itself.';
    return `Left ${word} gets tapped by accident. Try Right ${word}.`;
  }
  if (/^RightMeta$/i.test(n) && !mac) return 'Windows keeps the Win key for itself.';
  if (/^(CapsLock|NumLock|ScrollLock|Insert)$/i.test(n)) {
    const nice = n.replace(/([a-z])([A-Z])/g, '$1 $2');
    return `${nice} would still switch itself on and off as well. Try Right Ctrl or F13.`;
  }
  if (/^F([1-9]|1[0-2])$/i.test(n)) return `${n.toUpperCase()} already does something in most apps. Add Ctrl or Shift, or use F13–F24.`;
  if (/^Mouse[45]$/i.test(n)) {
    return mac ? 'Mouse side buttons come to the Mac in a later update.' : 'Mouse side buttons come with the next update.';
  }
  if (/^Mouse[123]$/i.test(n)) return 'Typd needs that button for clicking.';
  if (/^Escape$/i.test(n)) return 'Esc cancels a dictation, so it cannot start one.';
  if (/^(Space|Tab|Return|Enter|Backspace|Delete)$/i.test(n) || /^[A-Z0-9]$/i.test(n) || PUNCT.includes(n)) {
    return `That key types. Hold ${mac ? '⌘ and Shift' : 'Ctrl and Shift'} with it, or pick ${mac ? 'Right ⌘' : 'Right Ctrl'} or F13.`;
  }
  if (/^F(2[1-4])$/i.test(n) && mac) return 'Mac keyboards stop at F20.';
  return `Typd can't listen for that key. Try ${mac ? 'Right ⌘' : 'Right Ctrl'}, F13, or a combination like ${ex.replace(/\+/g, ' + ')}.`;
}

/**
 * May this binding be used? Returns {ok: true, binding, label} with the binding
 * written the one way it is stored, or {ok: false, reason} with one sentence a
 * person can act on.
 *
 * @param {string} binding  a single-key name or an accelerator
 * @param {string} platform process.platform
 * @param {{sideButtons?: boolean}} [opts] sideButtons: the mouse hook that
 *   swallows side buttons is running (Windows), so Mouse4/Mouse5 are allowed
 */
function validate(binding, platform, opts = {}) {
  const raw = String(binding || '').trim();
  if (!raw) return { ok: false, reason: 'Press a key.' };
  if (raw.length > 64) return { ok: false, reason: "Typd can't use that key." };

  const one = single(raw, platform);
  if (one) {
    if (one.kind === 'button' && !opts.sideButtons) return { ok: false, reason: refuseSingle(one.name, platform) };
    return { ok: true, binding: one.name, label: one.label, kind: one.kind };
  }

  if (!raw.includes('+') || /^\+|\+\+$/.test(raw)) {
    // A lone key the table does not have: say why it was refused.
    return { ok: false, reason: refuseSingle(raw, platform) };
  }

  const acc = parseAccelerator(raw, platform);
  if (!acc) return { ok: false, reason: "Typd can't use that combination. Try " + (CHORD_EXAMPLE[platform] || CHORD_EXAMPLE.win32).replace(/\+/g, ' + ') + '.' };
  const { mods, key } = acc;
  const mac = platform === 'darwin';
  const count = ['ctrl', 'alt', 'shift', 'cmd'].filter((m) => mods[m]).length;
  const typing = /^[A-Z0-9]$/.test(key) || PUNCT.includes(key);
  const nice = formatAccelerator(acc);
  const shown = label(nice, platform);

  if (!count) return { ok: false, reason: refuseSingle(key, platform) };
  if (!mac && mods.ctrl && mods.alt) {
    return { ok: false, reason: 'Ctrl+Alt is AltGr on many keyboards and would block typing @. Try Ctrl+Shift+Space.' };
  }
  if (!mac && mods.cmd) return { ok: false, reason: 'Windows keeps Win shortcuts for itself.' };
  if (count === 1 && mods.shift && (typing || key === 'Space' || key === 'Tab' || key === 'Return')) {
    return { ok: false, reason: 'Shift and a key types a capital. Add Ctrl: Ctrl+Shift+' + key + '.' };
  }
  if (mac && mods.alt && !mods.ctrl && !mods.cmd && typing) {
    return { ok: false, reason: 'Option and a letter types a character on a Mac. Add ⌘: ⌥⌘' + key + '.' };
  }
  if (count === 1 && (mods.ctrl || mods.cmd) && typing) {
    const m = mods.cmd ? (mac ? '⌘' : 'Win') : 'Ctrl';
    return { ok: false, reason: `${m}+${key} is already used in most apps. Add Shift: ${mac ? '⇧' + m + key : m + '+Shift+' + key}.` };
  }
  if (!mac && count === 1 && mods.alt && typing) {
    return { ok: false, reason: `Alt+${key} opens menus in many apps. Add Shift: Alt+Shift+${key}.` };
  }
  if (key === 'Escape') return { ok: false, reason: 'Esc cancels a dictation, so it cannot start one.' };
  if (isReserved(acc, platform)) {
    return { ok: false, reason: `${mac ? 'macOS' : 'Windows'} uses ${shown} itself. Try ${(CHORD_EXAMPLE[platform] || CHORD_EXAMPLE.win32).replace(/\+/g, ' + ')}.` };
  }
  return { ok: true, binding: nice, label: shown, kind: 'chord' };
}

/**
 * A stored binding brought up to date: the old 'CommandOrControl+Shift+Space'
 * keeps working, an unknown value falls back to the platform default.
 */
function normalize(binding, platform, opts) {
  const v = validate(binding, platform, opts);
  return v.ok ? v.binding : defaultFor(platform);
}

/* ---------------------------------------------------------- state machine */

/**
 * One key's presses, turned into what they mean. Feed it what the hook saw;
 * it answers 'toggle', 'start', 'finish' or null. `isOpen()` says whether a
 * dictation is running -- a dedicated key finishes one on its next press.
 *
 * @param {{kind: 'modifier'|'key'|'button', tapMs?: number, holdMs?: number,
 *          lostReleaseMs?: number, isOpen: () => boolean}} o
 *   lostReleaseMs: macOS never auto-repeats a modifier, so there a press that
 *   finds the key long "down" means its release was lost and it is a new press.
 */
function createTrigger(o) {
  const tapMs = o.tapMs || TAP_MS;
  const holdMs = o.holdMs || HOLD_MS;
  let down = false;
  let downAt = 0;
  let chord = false;
  let startedHere = false;

  return {
    down(now) {
      if (down && !(o.lostReleaseMs && now - downAt >= o.lostReleaseMs)) return null;   // auto-repeat
      down = true;
      downAt = now;
      chord = false;
      if (o.kind === 'modifier') return null;
      // A dedicated key acts on the press: finish what is running, or start.
      if (o.isOpen()) { startedHere = false; return 'finish'; }
      startedHere = true;
      return 'start';
    },

    /** Another key, a click or a scroll while this one is down. */
    other() {
      if (down && o.kind === 'modifier') chord = true;
      return null;
    },

    up(now) {
      if (!down) return null;
      const held = now - downAt;
      down = false;
      if (o.kind === 'modifier') return !chord && held < tapMs ? 'toggle' : null;
      const was = startedHere;
      startedHere = false;
      // Held: push-to-talk, so letting go finishes. Tapped: it stays open until the next press.
      return was && held >= holdMs && o.isOpen() ? 'finish' : null;
    },

    /** Forget a half-seen press (sleep, a lost hook). */
    reset() { down = false; chord = false; startedHere = false; },
    isDown: () => down
  };
}

module.exports = {
  KEYS, TAP_MS, HOLD_MS, keysFor, defaultFor, single, parseAccelerator, formatAccelerator,
  parts, label, shortLabel, verb, validate, normalize, refuseSingle, createTrigger
};
