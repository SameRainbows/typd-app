'use strict';

const { globalShortcut } = require('electron');

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
const BINDING = process.env.TYPD_HOTKEY || 'RightAlt';
const TAP_MS = 600;
const label = (b) => (b.toLowerCase() === 'rightalt' ? 'Right Alt' : b.replace('CommandOrControl', 'Ctrl'));

/** `binding` comes from Settings ('RightAlt' or an accelerator); TYPD_HOTKEY still wins. */
function registerHotkeys({ onPress, onRelease, onCancel, onAltDown, binding }) {
  const BOUND = process.env.TYPD_HOTKEY || binding || BINDING;
  const NATIVE = BOUND.toLowerCase() === 'rightalt';
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
  let downAt = 0;       // when Right Alt went down, 0 while it is up
  let chord = false;    // another key was pressed while it was held

  if (NATIVE) {
    try {
      const { uIOhook, UiohookKey } = require('uiohook-napi');
      const IGNORE = new Set([UiohookKey.Ctrl, UiohookKey.CtrlRight, 0]);

      onDown = (e) => {
        if (e.keycode === UiohookKey.AltRight) {
          if (downAt) return;                // auto-repeat while held
          downAt = Date.now();
          chord = false;
          if (onAltDown) onAltDown();
          return;
        }
        if (downAt && !IGNORE.has(e.keycode)) chord = true;
      };

      onUp = (e) => {
        if (e.keycode !== UiohookKey.AltRight || !downAt) return;
        const held = Date.now() - downAt;
        downAt = 0;
        if (!chord && held < TAP_MS) toggle();
      };
      uIOhook.on('keydown', onDown);
      uIOhook.on('keyup', onUp);

      uIOhook.start();
      hook = uIOhook;
    } catch (err) {
      if (process.env.TYPD_DEBUG) console.log('[typd:hotkey]', err);
      ok = false;
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
     */
    rearm() {
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

module.exports = { registerHotkeys, BINDING: label(BINDING), label };
