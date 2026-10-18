'use strict';

const path = require('path');

/**
 * The copy pop-up (0.2.10): a dictation that could not be pasted, offered with a Copy button.
 *
 * Shown when there was no text field to paste into (pasteTarget.js: "not-editable"; the clipboard
 * is left alone until Copy is clicked), and in place of the pill's old "Copied — press Ctrl+V"
 * when the paste itself failed (the text is already on the clipboard; Copy puts it there again).
 *
 * A small floating card above the pill's place at the bottom of the screen, in the pill's dark
 * style. It never takes the focus or the keyboard: focusable:false, showInactive, a non-activating
 * panel on macOS, and click-through except over the card (the pill's click gate, overlay-window.js).
 * Esc is never taken from other apps; the × closes it. A thin time bar shows how long it stays:
 * DURATION, then it fades. The pointer over the card pauses the timer; leaving resumes it. With a
 * screen reader on, it stays longer (SCREEN_READER_DURATION), still timed.
 *
 * Two halves:
 *   createController  the logic -- timer, pause, copy, dismiss, expiry -- with everything it
 *                     touches passed in, so bench/copy-popup.js runs it with fake timers.
 *   createCopyPopup   the Electron window and its page (renderer/popup.*), wired to a controller.
 */

const DURATION = 6000;                // how long it stays, unpaused
const SCREEN_READER_DURATION = 20000; // the same with a screen reader on: time to get to it
const COPIED_MS = 1600;               // after Copy: "Copied", then it leaves
const FADE_MS = 180;                  // the page's fade-out (popup.css --dur-leave); then the window hides
const PREVIEW_CHARS = 400;            // what the page gets to show; two lines never need more

/**
 * The pop-up's logic.
 *
 *   view.show({kind, preview, total, key})   put the card up (the window shows, inactive)
 *   view.timer({remaining, total, paused, copied})  where the time bar is and whether it runs
 *   view.copied()                             the button says "Copied"
 *   view.leave()                              start the fade
 *   view.hide()                               the fade is over: hide the window
 *   copy(text) -> Promise                     put the text on the clipboard (inject.copy)
 *   onCopy(kind), onClose(reason)             for the life log; reasons: 'expired', 'dismissed', 'replaced', 'copied'
 */
function createController({
  view, copy, onCopy = () => {}, onClose = () => {},
  duration = DURATION, copiedMs = COPIED_MS, fadeMs = FADE_MS,
  now = Date.now, timers = { setTimeout, clearTimeout }
}) {
  let state = 'hidden';     // hidden | shown | leaving
  let current = null;       // {text, kind, key}
  let total = duration;
  let remaining = 0;
  let deadline = 0;
  let timer = null;
  let fadeTimer = null;
  let hovered = false;
  let copied = false;
  let keys = 0;

  const clear = () => { if (timer) { timers.clearTimeout(timer); timer = null; } };
  const report = () => view.timer({ remaining: Math.max(0, Math.round(remaining)), total, paused: hovered, copied });

  function run() {
    clear();
    if (state !== 'shown' || hovered) return;
    deadline = now() + remaining;
    timer = timers.setTimeout(() => { timer = null; remaining = 0; close('expired'); }, Math.max(0, remaining));
  }

  function close(reason) {
    if (state !== 'shown') return;
    clear();
    state = 'leaving';
    const was = current;
    view.leave();
    fadeTimer = timers.setTimeout(() => {
      fadeTimer = null;
      if (state !== 'leaving') return;
      state = 'hidden';
      current = null;
      view.hide();
    }, fadeMs);
    onClose(copied ? 'copied' : reason, was && was.kind);
  }

  return {
    /** Offer `text`. kind 'offer': not on the clipboard yet; 'copied': already there (a failed paste). */
    offer(text, kind = 'offer', opts = {}) {
      if (!text) return false;
      if (state === 'shown' && current) onClose('replaced', current.kind);
      clear();
      if (fadeTimer) { timers.clearTimeout(fadeTimer); fadeTimer = null; }
      current = { text: String(text), kind: kind === 'copied' ? 'copied' : 'offer', key: ++keys };
      total = opts.duration > 0 ? opts.duration : duration;
      remaining = total;
      copied = false;
      hovered = false;
      state = 'shown';
      view.show({ kind: current.kind, preview: current.text.slice(0, PREVIEW_CHARS), total, key: current.key });
      report();
      run();
      return true;
    },

    /** The pointer is over the card (true) or has left it (false): the timer pauses and resumes. */
    hover(on) {
      on = Boolean(on);
      if (state !== 'shown') { hovered = false; return; }
      if (on === hovered) return;
      if (on) {
        remaining = Math.max(0, deadline - now());
        clear();
        hovered = true;
      } else {
        hovered = false;
        run();
      }
      report();
    },

    /** Copy clicked: the text goes on the clipboard now, the button says so, and the card leaves soon after. */
    async copy() {
      if (state !== 'shown' || !current) return false;
      const mine = current;
      try {
        await copy(mine.text);
      } catch {
        return false;
      }
      if (current !== mine || state !== 'shown') return true;
      copied = true;
      onCopy(mine.kind);
      view.copied();
      remaining = Math.min(copiedMs, total);
      if (hovered) { report(); return true; }
      report();
      run();
      return true;
    },

    /** The × (or anything else that means "never mind"): leave now. */
    dismiss() { close('dismissed'); },

    /** Gone at once, no fade (the app is quitting). */
    destroy() {
      clear();
      if (fadeTimer) { timers.clearTimeout(fadeTimer); fadeTimer = null; }
      state = 'hidden';
      current = null;
    },

    get state() { return state; },
    get paused() { return hovered; },
    get copiedNow() { return copied; },
    get text() { return current ? current.text : null; },
    get kind() { return current ? current.kind : null; },
    remaining() { return state !== 'shown' ? 0 : hovered || !timer ? remaining : Math.max(0, deadline - now()); }
  };
}

/* ---------------------------------------------------------------- the window */

const WIDTH = 440;
const HEIGHT = 160;
const LIFT = 6;        // overlay-window.js: how far the pill's window sits above the work area
const PILL_SLOT = 40;  // the pill (34 px) and its 12 px of padding, less the card's own 28 px of shadow room:
                       // the card's bottom edge sits ~22 px above the pill's top
const IDLE_CLOSE_MS = 60000;   // a hidden pop-up's window is closed after this, freeing its renderer

/**
 * Where the window goes: bottom centre of the display the cursor is on, just above the pill.
 * Pure (bench/copy-popup.js): workArea {x, y, width, height} in DIP.
 */
function placement(workArea) {
  const { x, y, width, height } = workArea;
  const h = Math.min(HEIGHT, Math.max(80, height - LIFT * 2 - PILL_SLOT));
  return {
    x: Math.round(x + (width - WIDTH) / 2),
    y: Math.round(y + height - LIFT - PILL_SLOT - h),
    width: WIDTH,
    height: h
  };
}

/**
 * The pop-up window, made on first use and closed again after a minute hidden.
 *
 *   copy(text)    inject.copy: private, out of clipboard history
 *   log(line)     the life log (never the text)
 */
function createCopyPopup({ copy, log = () => {}, dev = false }) {
  const { BrowserWindow, screen, ipcMain, app } = require('electron');
  const { createClickGate } = require('./overlay-window');
  const MAC = process.platform === 'darwin';
  const MAC_PANEL = MAC && process.env.TYPD_MAC_PANEL !== '0';

  let win = null;
  let gate = null;
  let loaded = false;
  let pending = [];
  let idle = null;

  const alive = () => win && !win.isDestroyed();
  const send = (channel, payload) => {
    if (!alive()) return;
    if (!loaded) { pending.push([channel, payload]); return; }
    win.webContents.send(channel, payload);
  };

  const controller = createController({
    copy,
    onCopy: (kind) => log('Copy clicked' + (kind === 'copied' ? ' (it was already on the clipboard)' : '')),
    onClose: (reason) => log(reason === 'copied' ? 'closed after Copy' : reason === 'expired' ? 'timed out' : reason),
    view: {
      show(p) {
        ensure();
        // A new card starts un-hovered: the gate forgets, and the page reports the card's place again.
        if (gate) gate.release();
        try { win.setBounds(placement(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea)); } catch { /* keep the last place */ }
        send('popup:show', { ...p, pasteKey: MAC ? '⌘V' : 'Ctrl+V' });
        // Topmost again before every show (overlay-window.js showOverlay: Windows forgets), never activating.
        win.setAlwaysOnTop(true, 'screen-saver');
        win.showInactive();
        win.moveTop();
        clearTimeout(idle);
      },
      timer(t) { send('popup:timer', t); },
      copied() { send('popup:copied', {}); },
      leave() { send('popup:leave', {}); },
      hide() {
        if (gate) gate.release();
        if (alive()) win.hide();
        clearTimeout(idle);
        idle = setTimeout(() => { if (controller.state === 'hidden' && alive()) win.close(); }, IDLE_CLOSE_MS);
        if (idle.unref) idle.unref();
      }
    }
  });

  function ensure() {
    if (alive()) return win;
    loaded = false;
    pending = [];
    win = new BrowserWindow({
      width: WIDTH, height: HEIGHT, show: false, frame: false, transparent: true,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: false, hasShadow: false, alwaysOnTop: true, acceptFirstMouse: true,
      backgroundColor: '#00000000', title: 'Typd: not pasted',
      ...(MAC_PANEL ? { type: 'panel' } : {}),
      ...(MAC ? { hiddenInMissionControl: true } : {}),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'popup.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false
      }
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, MAC ? { visibleOnFullScreen: true, skipTransformProcessType: true } : { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true);
    const wc = win.webContents;
    const mine = win;
    // Click-through except over the card. Over it, the window takes clicks -- and the pointer is
    // there, which is what pauses the timer: the gate knows from the cursor, the page could not
    // (it hears no mouse while click-through).
    gate = createClickGate({
      setIgnore: (ignore) => { if (!mine.isDestroyed()) mine.setIgnoreMouseEvents(ignore); controller.hover(!ignore); },
      cursor: () => screen.getCursorScreenPoint(),
      bounds: () => mine.getBounds(),
      visible: () => !mine.isDestroyed() && mine.isVisible()
    });
    const from = (e) => e.sender === wc;
    const onHit = (e, list) => { if (from(e)) gate.areas(list); };
    const onCopy = (e) => { if (from(e)) controller.copy().catch(() => {}); };
    const onDismiss = (e) => { if (from(e)) controller.dismiss(); };
    ipcMain.on('popup:hit', onHit);
    ipcMain.on('popup:copy', onCopy);
    ipcMain.on('popup:dismiss', onDismiss);
    wc.on('did-finish-load', () => {
      loaded = true;
      while (pending.length) { const [c, p] = pending.shift(); wc.send(c, p); }
    });
    win.on('closed', () => {
      ipcMain.removeListener('popup:hit', onHit);
      ipcMain.removeListener('popup:copy', onCopy);
      ipcMain.removeListener('popup:dismiss', onDismiss);
      if (gate) gate.release();
      if (win === mine) { win = null; gate = null; loaded = false; }
      if (controller.state !== 'hidden') controller.destroy();
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'popup.html'));
    if (dev) wc.openDevTools({ mode: 'detach' });
    return win;
  }

  return {
    /** Offer a dictation that was not pasted. kind: 'offer' (not copied) or 'copied' (already on the clipboard). */
    offer(text, kind) {
      try {
        let sr = false;
        try { sr = app.isAccessibilitySupportEnabled(); } catch { /* no */ }
        return controller.offer(text, kind, { duration: sr ? SCREEN_READER_DURATION : DURATION });
      } catch (err) {
        log('failed: ' + String((err && err.message) || err).slice(0, 80));
        controller.destroy();   // the caller falls back to the clipboard and the pill
        return false;
      }
    },
    dismiss: () => controller.dismiss(),
    destroy() { controller.destroy(); clearTimeout(idle); if (alive()) win.destroy(); },
    get window() { return win; },
    controller
  };
}

module.exports = {
  createController, createCopyPopup, placement,
  DURATION, SCREEN_READER_DURATION, COPIED_MS, FADE_MS, PREVIEW_CHARS, WIDTH, HEIGHT
};
