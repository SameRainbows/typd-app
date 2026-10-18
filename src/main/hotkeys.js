'use strict';

const { globalShortcut, systemPreferences } = require('electron');
const logic = require('./hotkey-logic');
const life = require('./lifelog');

/**
 * One key, one session.
 *
 * Press to start, press again to finish. A toggle survives long dictation
 * without a held finger, leaves both hands free, and gives the pill's confirm and
 * cancel controls something to mean. Dedicated keys (F13-F24, a side button) can
 * also be held while you talk; hotkey-logic.js says which key gets which gesture,
 * and why modifiers are tap-only.
 *
 * One key, two modes -- and the mode is not a guess. Whether something is
 * highlighted is a fact read at the start of every session: if there is a
 * selection you are revising it, and if there is not you are dictating. Every
 * feature after this one has the same bar to clear: a new hotkey has to be the
 * only way to express something the current state cannot already say.
 *
 * Ctrl+Alt+* is never a binding, whatever it spells: AltGr is Ctrl+Alt, so on a
 * Turkish layout every such chord collides with a character the user needs to
 * type. hotkey-logic.validate refuses it.
 */
/*
 * Single keys come from a native keyboard hook (uiohook-napi), which reports key
 * down and key up with left and right told apart -- globalShortcut cannot see
 * Right Alt at all. A modifier toggles only on a clean tap: pressed and released
 * within TAP_MS with no other key, click or scroll in between. That keeps AltGr
 * working -- on a Turkish layout Right Alt *is* AltGr, and AltGr+Q has to keep
 * typing "@" -- because a chord always has another key in it. The control key
 * Windows fakes alongside AltGr is ignored for the same reason.
 *
 * A bare Alt tap also opens the menu bar in many apps (on the US layout, where
 * Right Alt is plain Alt). The injector masks it the way AutoHotkey does: an
 * unassigned virtual key is pressed while Alt is still down, so Windows no
 * longer sees a lone Alt.
 *
 * Combinations ("Ctrl+Shift+Space") go to globalShortcut, which hands them to
 * Typd alone. TYPD_HOTKEY still overrides Settings, for testing.
 */
/*
 * Right ⌘ on macOS, tapped on its own.
 *
 * Not Right Option. On most Mac layouts Option is how special characters are
 * typed -- Turkish Q included -- which is the AltGr trap again, one key over.
 * Command types nothing by itself, and every ⌘ shortcut has another key in it,
 * so the same clean-tap rule leaves ⌘C, ⌘V and the rest exactly as they were.
 * ⌘-click is everyday on a Mac (a link in a new tab, a second file in Finder),
 * so a mouse button or a scroll while the key is down makes a chord too -- on
 * Windows as well, where Ctrl-click and Shift-click are just as ordinary.
 *
 * The hook is the same uiohook, which on macOS is an event tap. It cannot start
 * until Typd is trusted for Accessibility, and asking for that is
 * permissions-mac.js's job, not this file's: here the hook simply waits, without
 * prompting, and starts by itself the moment the switch is turned on.
 */

const PLATFORM = process.platform;
const MAC = PLATFORM === 'darwin';
const DEFAULT_BINDING = logic.defaultFor(PLATFORM);
const BINDING = process.env.TYPD_HOTKEY || DEFAULT_BINDING;
const TAP_MS = logic.TAP_MS;

const label = (b) => logic.label(b, PLATFORM);
/** The single-key entry a binding names, or null for a combination (kept for permissions-mac.js). */
const tapKey = (b) => logic.single(b, PLATFORM);

/*
 * uiohook calls its listeners from native code, and it treats an exception coming back as
 * fatal: its callback hands the pending exception to napi_fatal_error, which aborts the
 * process. No dialog, no log line -- Typd, its menu-bar icon and its key are simply gone.
 * Everything a key press sets off (a dictation starting, the Typd window hearing the key)
 * runs inside these listeners, so each one is wrapped: a bug there costs one key press,
 * never the app.
 */
function guard(fn) {
  return (e) => {
    try {
      fn(e);
    } catch (err) {
      console.log('[typd:hotkey] a key handler threw (Typd keeps running):', (err && err.stack) || err);
    }
  };
}

/*
 * macOS: the event tap is started once and kept until Typd quits, even when the key
 * changes (the listeners are swapped instead). Stopping it joins libuiohook's thread from
 * this one, and on a Mac that thread waits on this one (dispatch_sync to the main queue)
 * for every key press: a press at that moment hangs Typd for good. Windows restarts its
 * hook freely (rearm), so there close() still stops it.
 */
let macTap = null;

/*
 * macOS: what the event tap's watchdog in Typd's uiohook build saw (scripts/build-uiohook-mac.js):
 * { running, enabled (1 on, 0 off, -1 none, -2 port gone), timeouts and userInput (times macOS
 * switched the tap off, each switched straight back on), rearmed (times the watchdog found it off
 * and switched it on), checks (watchdog ticks: a count that stops means the tap's thread is stuck) }.
 * null where the build has no such function (Windows' prebuild, an unpatched build).
 */
let nativeAddon;
function tapHealth() {
  if (!MAC) return null;
  if (nativeAddon === undefined) {
    try {
      const dir = require('path').dirname(require.resolve('uiohook-napi/package.json'));
      nativeAddon = require(require.resolve('node-gyp-build', { paths: [dir] }))(dir);
    } catch {
      nativeAddon = null;
    }
  }
  if (!nativeAddon || typeof nativeAddon.tapHealth !== 'function') return null;
  try { return nativeAddon.tapHealth(); } catch { return null; }
}

/** Stop the shared hook for good: at quit only. */
function stopHook() {
  if (!macTap) return;
  const tap = macTap;
  macTap = null;
  try { tap.stop(); } catch { /* already stopped */ }
}

/** macOS: may the event tap start? Never prompts -- see permissions-mac.js. */
function macTrusted() {
  try {
    return systemPreferences.isTrustedAccessibilityClient(false);
  } catch {
    return true;   // cannot tell: try, and let the hook's own error speak
  }
}

/**
 * @param {object} o
 * @param {() => void} o.onPress     a dictation starts
 * @param {() => void} o.onRelease   it finishes
 * @param {() => void} o.onCancel    Escape while it records
 * @param {() => void} [o.onAltDown] Windows: Right Alt went down (mask the menu bar)
 * @param {string} [o.binding]       from Settings; TYPD_HOTKEY still wins
 * @param {() => boolean} [o.intercept] asked before a dictation starts; true means
 *   the press was taken for something else (the Typd window hearing the key)
 * @param {{on: Function, off: Function, arm: Function}} [o.buttons] Windows: the
 *   injector's mouse hook, which swallows side buttons (needed for Mouse4/Mouse5)
 */
function registerHotkeys({ onPress, onRelease, onCancel, onAltDown, binding, intercept, buttons }) {
  const BOUND = process.env.TYPD_HOTKEY || binding || BINDING;
  const ONE = logic.single(BOUND, PLATFORM);
  const NATIVE = Boolean(ONE);
  let open = false;
  let paused = false;

  const releaseEscape = () => {
    if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape');
  };

  const start = () => {
    if (open) return;
    if (intercept && intercept()) return;
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
    try {
      onPress();
    } catch (err) {
      // No dictation started, so none is open: the next press starts one rather than
      // "finishing" nothing. guard() logs it.
      open = false;
      releaseEscape();
      throw err;
    }
  };

  const finish = () => {
    if (!open) return;
    open = false;
    releaseEscape();
    onRelease();
  };

  let seen = 0;   // key events this binding's listeners heard, for state() (the CI check reads it)

  const act = (what) => {
    if (!what || paused) return;
    if (process.env.TYPD_DEBUG) console.log('[typd:hotkey]', what, open ? '(open)' : '(closed)', 'at', (Date.now() / 1000).toFixed(3));
    if (what === 'toggle') { if (open) finish(); else start(); }
    else if (what === 'start') start();
    else if (what === 'finish') finish();
  };

  const trigger = NATIVE
    ? logic.createTrigger({ kind: ONE.kind, isOpen: () => open, lostReleaseMs: MAC ? TAP_MS : 0 })
    : null;

  let ok = true;
  let why = '';         // when not ok: what to tell the person
  let hook = null;
  let onDown = null, onUp = null;   // this binding's listeners, removed again by close()
  let onMouse = null;   // a click or scroll while the key is down is a chord
  let onButton = null;  // Windows: side buttons, from the injector's mouse hook
  let attached = null;  // the hook the listeners are on, started or not
  let waiting = null;   // macOS: the timer that starts the hook once it is allowed to

  /*
   * macOS: start the event tap once Typd is trusted for Accessibility, and keep
   * trying if it refuses to start even then. A key that is not working yet is
   * not "taken by another application" -- nothing can take a key from an event
   * tap -- so this is never reported as a failed binding; permissions-mac.js
   * tells the user which switch to turn on.
   */
  const startWhenAllowed = (uIOhook, reason) => {
    if (waiting) return;
    console.log('[typd:hotkey] ' + label(BOUND) + ' is waiting: ' + reason);
    life.log('key', label(BOUND) + ' waiting: ' + reason);
    waiting = setInterval(() => {
      if (!macTrusted()) return;
      try {
        uIOhook.start();   // a no-op when the tap already runs
        clearInterval(waiting);
        waiting = null;
        hook = uIOhook;
        macTap = uIOhook;
        trigger.reset();
        console.log('[typd:hotkey] ' + label(BOUND) + ' is listening');
        life.log('key', label(BOUND) + ' listening (the event tap started once allowed)');
      } catch (err) {
        if (process.env.TYPD_DEBUG) console.log('[typd:hotkey] start', err && err.message);
      }
    }, 2000);
  };

  if (NATIVE && ONE.kind === 'button') {
    // Side buttons cannot come from uiohook: it only listens, and Back would still go
    // back in the browser underneath. The injector's hook swallows them (inject.ps1).
    if (buttons && typeof buttons.on === 'function') {
      onButton = (b, down) => {
        if (b !== ONE.button) return;
        act(down ? trigger.down(Date.now()) : trigger.up(Date.now()));
      };
      buttons.on(onButton);
      buttons.arm(ONE.button);
    } else {
      ok = false;
      why = "Typd couldn't take over the " + ONE.label.toLowerCase() + '.';
    }
  } else if (NATIVE) {
    let uio = null;
    try {
      uio = require('uiohook-napi');
      const { uIOhook, UiohookKey } = uio;
      const KEY = UiohookKey[ONE.key];
      const IGNORE = new Set([...(ONE.ignore || []).map((k) => UiohookKey[k]), 0]);

      onDown = guard((e) => {
        seen++;
        if (e.keycode === KEY) {
          const fresh = !trigger.isDown();
          const what = trigger.down(Date.now());
          if (fresh && ONE.alt && onAltDown) onAltDown();
          act(what);
          return;
        }
        if (!IGNORE.has(e.keycode)) trigger.other();
      });
      onUp = guard((e) => {
        seen++;
        if (e.keycode === KEY) act(trigger.up(Date.now()));
      });
      onMouse = guard(() => trigger.other());

      uIOhook.on('keydown', onDown);
      uIOhook.on('keyup', onUp);
      uIOhook.on('mousedown', onMouse);
      uIOhook.on('wheel', onMouse);
      attached = uIOhook;

      if (MAC && !macTrusted()) {
        // libuiohook would show macOS's Accessibility prompt itself and then
        // throw; wait quietly instead and let permissions-mac.js do the asking.
        startWhenAllowed(uIOhook, 'Accessibility is not on for Typd yet');
      } else {
        const already = MAC && macTap === uIOhook;
        uIOhook.start();   // macOS: a no-op when the tap already runs (kept across key changes)
        hook = uIOhook;
        if (MAC) macTap = uIOhook;
        if (MAC && !already) { console.log('[typd:hotkey] ' + label(BOUND) + ' is listening'); life.log('key', label(BOUND) + ' listening'); }
      }
    } catch (err) {
      if (process.env.TYPD_DEBUG) console.log('[typd:hotkey]', err);
      life.log('key', label(BOUND) + ' could not start: ' + life.errorLine(err));
      if (MAC && uio && attached) startWhenAllowed(uio.uIOhook, String((err && err.message) || err));
      else { ok = false; why = "Typd couldn't listen for " + label(BOUND) + '.'; }
    }
  } else {
    ok = globalShortcut.register(BOUND, () => act('toggle'));
    if (!ok) why = 'Another app is already using ' + label(BOUND) + '.';
  }

  const detach = () => {
    if (attached) {
      try {
        attached.off('keydown', onDown); attached.off('keyup', onUp);
        attached.off('mousedown', onMouse); attached.off('wheel', onMouse);
      } catch { /* none */ }
    }
  };

  return {
    /** What people call the key ('Right Alt'), as before. */
    binding: label(BOUND),
    /** The stored form ('RightAlt', 'Ctrl+Shift+Space'). */
    name: ONE ? ONE.name : BOUND,
    failed: ok ? [] : [label(BOUND)],
    reason: why,
    isOpen: () => open,

    /** Key events this binding has heard (the CI check in mac.yml compares them). */
    get keysHeard() { return seen; },

    /** macOS: the event tap's health (tapHealth above), with whether this binding uses it. */
    health() {
      const h = tapHealth();
      return h ? { ...h, running: Boolean(hook && hook === macTap) } : null;
    },

    /** One line on whether the key can be heard right now (debug logs, the CI check). */
    state() {
      const how = !ok ? 'failed (' + why + ')'
        : !NATIVE ? 'shortcut' + (globalShortcut.isRegistered(BOUND) ? ' registered' : ' not registered')
        : hook ? 'listening' : waiting ? 'waiting for Accessibility' : attached ? 'not started' : 'closed';
      return label(BOUND) + ': ' + how + (paused ? ', paused' : '') + (NATIVE ? ', ' + seen + ' key events heard' : '');
    },

    /**
     * The key picker is listening: ignore the key meanwhile. A combination is
     * given back to the system, or the page could never see it to capture it.
     */
    pause(on) {
      paused = Boolean(on);
      if (trigger) trigger.reset();
      if (!NATIVE && ok) {
        if (paused && globalShortcut.isRegistered(BOUND)) globalShortcut.unregister(BOUND);
        if (!paused && !globalShortcut.isRegistered(BOUND)) globalShortcut.register(BOUND, () => act('toggle'));
      }
    },

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
      if (trigger) trigger.reset();
      if (MAC) return;
      if (onButton && buttons) buttons.arm(ONE.button);
      if (!hook) return;
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
      if (onButton && buttons) { buttons.off(onButton); buttons.arm(0); onButton = null; }
      // uIOhook is one shared object: drop this binding's listeners, or a later binding
      // would hear every key twice.
      detach();
      attached = null;
      if (hook) {
        // macOS keeps the tap for the next binding (see macTap); stopHook() ends it at quit.
        if (!MAC) { try { hook.stop(); } catch { /* already stopped */ } }
        hook = null;
      }
    }
  };
}

/**
 * "That was wrong": one combination, pressed, that flags the last dictation (sharing.js). Always a
 * combination through globalShortcut -- never the native hook, which is dictation's -- and never
 * the same keys as dictation: if the dictation key is that very combination, the flag shortcut
 * stands down (the tray item still works). TYPD_FLAG_HOTKEY overrides Settings, for testing.
 *
 * @param {string} binding      settings 'flagHotkey' ('' = none)
 * @param {string} dictationKey the dictation binding in use
 * @param {() => void} onFlag
 * @returns {{binding: string|null, label: string|null, ok: boolean, close: () => void}}
 */
function registerFlagHotkey(binding, dictationKey, onFlag) {
  const want = logic.validFlag(process.env.TYPD_FLAG_HOTKEY || binding || '', PLATFORM);
  const none = { binding: null, label: null, ok: false, close() {} };
  if (!want) return none;
  const main = logic.validate(dictationKey, PLATFORM);
  if (main.ok && main.binding.toLowerCase() === want.toLowerCase()) return none;
  let ok = false;
  try { ok = globalShortcut.register(want, guard(() => onFlag())); } catch { ok = false; }
  if (process.env.TYPD_DEBUG) console.log('[typd:hotkey] flag', want, ok ? 'registered' : 'taken by another app');
  return {
    binding: ok ? want : null,
    label: ok ? label(want) : null,
    ok,
    close() { if (ok && globalShortcut.isRegistered(want)) globalShortcut.unregister(want); ok = false; }
  };
}

module.exports = { registerHotkeys, registerFlagHotkey, stopHook, tapHealth, BINDING: label(BINDING), label, tapKey, DEFAULT_BINDING };
