'use strict';

const { globalShortcut, systemPreferences } = require('electron');

/**
 * Two hotkeys, one session.
 *
 * Press to start, press again to finish. That is a deliberate gesture rather
 * than a limitation to work around: a toggle survives long dictation without a
 * held finger, leaves both hands free, and gives the pill's confirm and cancel
 * controls something to mean.
 *
 * globalShortcut fires on key down only and cannot tell left from right
 * modifiers, so the default key, Right Alt, comes from a native keyboard hook
 * instead (see BINDING below).
 *
 * Dictate inserts; revise rewrites what is highlighted. These are separate keys
 * rather than one key and a classifier, because the distinction is the one that
 * cannot be got wrong: "make this shorter" is a perfectly ordinary sentence to
 * want typed into a document, and a model deciding case by case would sometimes
 * overwrite a paragraph the user meant to add to. A second chord costs nothing
 * and is never ambiguous.
 *
 * Either key closes a session opened by the other. There is one session, and
 * whichever key is pressed while it is open means "finish".
 */

/*
 * One key, two modes -- and the mode is not a guess.
 *
 * Dictation and revision were briefly separate chords, on the argument that a
 * model deciding "is this text to insert or an instruction about text" would
 * sometimes overwrite a paragraph the user meant to add to. That argument was
 * right about models and wrong about this problem. Whether something is
 * highlighted is not an inference, it is a fact we already read at the start of
 * every session: if there is a selection you are revising it, and if there is
 * not you are dictating. Nothing is being classified.
 *
 * So the second chord bought nothing and cost a thing to learn. Every feature
 * after this one has the same bar to clear: a new hotkey has to be the only way
 * to express something the current state cannot already say.
 *
 * Ctrl+Alt+* is not an option for any future binding regardless of what it
 * spells: AltGr is Ctrl+Alt, so on a Turkish layout every such chord collides
 * with a character the user needs to type.
 */
/*
 * Right Alt, tapped on its own.
 *
 * globalShortcut cannot see it, so this uses a native keyboard hook
 * (uiohook-napi) that reports key down and key up with left and right told
 * apart. A toggle fires only on a clean tap: Right Alt pressed and released
 * within TAP_MS with no other key in between. That keeps AltGr working -- on a
 * Turkish layout Right Alt *is* AltGr, and AltGr+Q has to keep typing "@" --
 * because a chord always has another key in it. The control key Windows fakes
 * alongside AltGr is ignored for the same reason.
 *
 * A bare Alt tap also opens the menu bar in many apps (on the US layout, where
 * Right Alt is plain Alt). The injector masks it the way AutoHotkey does: an
 * unassigned virtual key is pressed while Alt is still down, so Windows no
 * longer sees a lone Alt.
 *
 * TYPD_HOTKEY still takes an Electron accelerator ("CommandOrControl+Shift+D")
 * for anyone who wants a chord instead.
 */
/*
 * Right ⌘ on macOS, tapped on its own.
 *
 * Not Right Option. On most Mac layouts Option is how special characters are
 * typed -- Turkish Q included -- which is the AltGr trap again, one key over.
 * Command types nothing by itself, and every ⌘ shortcut has another key in it,
 * so the same clean-tap rule leaves ⌘C, ⌘V and the rest exactly as they were.
 * ⌘-click is everyday on a Mac (a link in a new tab, a second file in Finder),
 * so on macOS a mouse button or a scroll while the key is down makes a chord
 * too.
 *
 * The hook is the same uiohook, which on macOS is an event tap. It cannot start
 * until Typd is trusted for Accessibility, and asking for that is
 * permissions-mac.js's job, not this file's: here the hook simply waits, without
 * prompting, and starts by itself the moment the switch is turned on.
 */

const MAC = process.platform === 'darwin';

/*
 * The keys a bare tap can be bound to, per platform: the setting's name for the
 * key, the uiohook key it arrives as, what people call it, and keys that do not
 * count as "another key" while it is held. One table, so a key picker can offer
 * exactly these and label them the same way everywhere.
 *
 * Names are positions, not platform words: RightAlt is the key right of the
 * space bar on both, which macOS calls Right Option. Anything not in the table
 * is an Electron accelerator for globalShortcut.
 */
const TAP_KEYS = {
  win32: {
    // The control key Windows fakes alongside AltGr is not "another key".
    RightAlt: { key: 'AltRight', label: 'Right Alt', ignore: ['Ctrl', 'CtrlRight'] }
  },
  darwin: {
    RightMeta: { key: 'MetaRight', label: 'Right ⌘ (Command)', ignore: [] },
    RightAlt: { key: 'AltRight', label: 'Right Option', ignore: [] }
  }
};
const TAPS = TAP_KEYS[process.platform] || TAP_KEYS.win32;
const DEFAULT_BINDING = MAC ? 'RightMeta' : 'RightAlt';

const BINDING = process.env.TYPD_HOTKEY || DEFAULT_BINDING;
const TAP_MS = 600;

/** The tap-key entry a binding names (case does not matter), or null for an accelerator. */
function tapKey(binding) {
  const want = String(binding || '').toLowerCase();
  const name = Object.keys(TAPS).find((k) => k.toLowerCase() === want);
  return name ? { name, ...TAPS[name] } : null;
}

/* '⇧⌘Space': the glyphs and the order macOS menus use (⌃ ⌥ ⇧ ⌘, then the key). */
const MAC_MODIFIERS = [
  ['⌃', /^(control|ctrl)$/i],
  ['⌥', /^(alt|option|altgr)$/i],
  ['⇧', /^shift$/i],
  ['⌘', /^(command|cmd|commandorcontrol|cmdorctrl|super|meta)$/i]
];

function macAccelerator(b) {
  const parts = String(b).split('+');
  const key = parts.pop() || '';
  const mods = MAC_MODIFIERS.filter(([, re]) => parts.some((p) => re.test(p))).map(([glyph]) => glyph).join('');
  return mods + (key.length === 1 ? key.toUpperCase() : key);
}

const label = (b) => {
  const tap = tapKey(b);
  if (tap) return tap.label;
  return MAC ? macAccelerator(b) : b.replace('CommandOrControl', 'Ctrl');
};

/** macOS: may the event tap start? Never prompts -- see permissions-mac.js. */
function macTrusted() {
  try {
    return systemPreferences.isTrustedAccessibilityClient(false);
  } catch {
    return true;   // cannot tell: try, and let the hook's own error speak
  }
}

/** `binding` comes from Settings ('RightAlt', 'RightMeta' or an accelerator); TYPD_HOTKEY still wins. */
function registerHotkeys({ onPress, onRelease, onCancel, onAltDown, binding }) {
  const BOUND = process.env.TYPD_HOTKEY || binding || BINDING;
  const TAP = tapKey(BOUND);
  const NATIVE = Boolean(TAP);
  let open = false;

  const releaseEscape = () => {
    if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape');
  };

  const toggle = () => {
    if (process.env.TYPD_DEBUG) console.log('[typd:hotkey]', open ? 'finish' : 'start');
    if (open) {
      open = false;
      releaseEscape();
      onRelease();
      return;
    }

    open = true;
    // Escape is only held while a session is live, so we are not keeping a
    // global Escape hostage for the rest of the OS. A previous session may still
    // hold it while its model works (holdWork); this recording takes it over.
    releaseEscape();
    globalShortcut.register('Escape', () => {
      if (!open) return;
      open = false;
      releaseEscape();
      onCancel();
    });
    onPress();
  };

  let ok = true;
  let hook = null;
  let onDown = null, onUp = null;   // this binding's listeners, removed again by close()
  let onMouse = null;   // macOS: a click or scroll while the key is down is a chord
  let attached = null;  // macOS: the hook the listeners are on, started or not
  let waiting = null;   // macOS: the timer that starts the hook once it is allowed to
  let downAt = 0;       // when the key went down, 0 while it is up
  let chord = false;    // another key was pressed while it was held

  /*
   * macOS: start the event tap once Typd is trusted for Accessibility, and keep
   * trying if it refuses to start even then. A key that is not working yet is
   * not "taken by another application" -- nothing can take a key from an event
   * tap -- so this is never reported as a failed binding; permissions-mac.js
   * tells the user which switch to turn on.
   */
  const startWhenAllowed = (uIOhook, why) => {
    if (waiting) return;
    console.log('[typd:hotkey] ' + label(BOUND) + ' is waiting: ' + why);
    waiting = setInterval(() => {
      if (!macTrusted()) return;
      try {
        uIOhook.start();
        clearInterval(waiting);
        waiting = null;
        hook = uIOhook;
        downAt = 0; chord = false;
        console.log('[typd:hotkey] ' + label(BOUND) + ' is listening');
      } catch (err) {
        if (process.env.TYPD_DEBUG) console.log('[typd:hotkey] start', err && err.message);
      }
    }, 2000);
  };

  if (NATIVE) {
    let uio = null;
    try {
      uio = require('uiohook-napi');
      const { uIOhook, UiohookKey } = uio;
      const KEY = UiohookKey[TAP.key];
      const IGNORE = new Set([...TAP.ignore.map((k) => UiohookKey[k]), 0]);

      onDown = (e) => {
        if (e.keycode === KEY) {
          // Auto-repeat while held. macOS never repeats a modifier, so there a
          // press that finds the key long "down" means its release was lost
          // (Left ⌘ was held across it) and this is a fresh press.
          if (downAt && !(MAC && Date.now() - downAt >= TAP_MS)) return;
          downAt = Date.now();
          chord = false;
          if (onAltDown) onAltDown();
          return;
        }
        if (downAt && !IGNORE.has(e.keycode)) chord = true;
      };

      onUp = (e) => {
        if (e.keycode !== KEY || !downAt) return;
        const held = Date.now() - downAt;
        downAt = 0;
        if (!chord && held < TAP_MS) toggle();
      };
      uIOhook.on('keydown', onDown);
      uIOhook.on('keyup', onUp);

      if (MAC) {
        onMouse = () => { if (downAt) chord = true; };
        uIOhook.on('mousedown', onMouse);
        uIOhook.on('wheel', onMouse);
        attached = uIOhook;
      }

      if (MAC && !macTrusted()) {
        // libuiohook would show macOS's Accessibility prompt itself and then
        // throw; wait quietly instead and let permissions-mac.js do the asking.
        startWhenAllowed(uIOhook, 'Accessibility is not on for Typd yet');
      } else {
        uIOhook.start();
        hook = uIOhook;
      }
    } catch (err) {
      if (process.env.TYPD_DEBUG) console.log('[typd:hotkey]', err);
      if (MAC && uio && attached) startWhenAllowed(uio.uIOhook, String((err && err.message) || err));
      else ok = false;
    }
  } else {
    ok = globalShortcut.register(BOUND, toggle);
  }

  return {
    binding: label(BOUND),
    failed: ok ? [] : [label(BOUND)],
    isOpen: () => open,

    /**
     * The pill's own controls can finish or abandon a session. When they do,
     * this clears the hotkey state so the next keypress opens rather than
     * closing something that is already gone.
     */
    settle() {
      const was = open;
      open = false;
      releaseEscape();
      return was;
    },

    /**
     * Windows can drop a low-level keyboard hook across sleep and lock without telling the
     * process; the key then silently stops working until Typd restarts (Spokenly and Wispr
     * both shipped fixes for exactly this). Re-installing the hook is cheap, so do it on
     * resume and unlock. A half-seen keypress from before is forgotten.
     *
     * macOS keeps an event tap across sleep, and libuiohook re-enables one the system
     * switched off for being slow, so there a restart would only risk the hook for nothing.
     */
    rearm() {
      if (MAC) { downAt = 0; chord = false; return; }
      if (!hook) return;
      downAt = 0; chord = false;
      try { hook.stop(); } catch { /* already stopped */ }
      try { hook.start(); } catch (err) { if (process.env.TYPD_DEBUG) console.log('[typd:hotkey] rearm', err); }
    },

    /**
     * While the model is working, Escape abandons the result: nothing is pasted. Held only
     * from the end of capture until the session settles (usually well under a second), and
     * always given back by releaseWork().
     */
    holdWork(onAbandon) {
      releaseEscape();
      globalShortcut.register('Escape', () => {
        releaseEscape();
        onAbandon();
      });
    },

    releaseWork() {
      if (!open) releaseEscape();   // a new recording owns Escape now; leave it
    },

    close() {
      open = false;
      if (!NATIVE && globalShortcut.isRegistered(BOUND)) globalShortcut.unregister(BOUND);
      releaseEscape();
      if (waiting) { clearInterval(waiting); waiting = null; }   // macOS: still waiting for permission
      if (MAC && attached) {
        try { attached.off('mousedown', onMouse); attached.off('wheel', onMouse); } catch { /* none */ }
        if (!hook) {
          try { attached.off('keydown', onDown); attached.off('keyup', onUp); } catch { /* none */ }
        }
        attached = null;
      }
      if (hook) {
        // uIOhook is one shared object: drop this binding's listeners too, or a later
        // Right Alt binding would hear every key twice.
        try { hook.off('keydown', onDown); hook.off('keyup', onUp); } catch { /* none */ }
        try { hook.stop(); } catch { /* already stopped */ }
        hook = null;
      }
    }
  };
}

module.exports = { registerHotkeys, BINDING: label(BINDING), label, tapKey, TAP_KEYS: TAPS, DEFAULT_BINDING };
