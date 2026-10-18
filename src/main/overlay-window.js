'use strict';

const path = require('path');
const { BrowserWindow, screen, ipcMain } = require('electron');

// Two footprints. The pill needs almost nothing; an answer with a code block in
// it needs room to be read, and the window has to be big enough to contain the
// panel or it gets clipped rather than scrolled.
const SIZES = {
  compact: { width: 460, height: 240 },
  answer: { width: 700, height: 560 }
};

const WIDTH = SIZES.compact.width;
const HEIGHT = SIZES.compact.height;

// How far the pill floats above the work area. Small on purpose -- it should sit
// just clear of the taskbar, close enough to read as part of the system chrome.
const LIFT = 6;

/*
 * macOS: a non-activating panel. `focusable: false` keeps the window from taking
 * focus, but on a Mac clicking any ordinary window still activates its app --
 * so a click on the pill's tick would pull focus out of the app being dictated
 * into, and the ⌘V would land nowhere. A panel with the non-activating style
 * takes the click and leaves the app in front alone; it is also what lets a
 * window float over another app's full-screen space. TYPD_MAC_PANEL=0 turns it
 * off, should a macOS release disagree.
 */
const MAC = process.platform === 'darwin';
const MAC_PANEL = MAC && process.env.TYPD_MAC_PANEL !== '0';

/**
 * The overlay is a transparent, frameless, click-through window that floats
 * above everything and never takes focus.
 *
 * `focusable: false` is the load-bearing option. If the overlay steals focus
 * from the app you are dictating into, the caret moves and the paste lands in
 * the wrong place -- and the illusion that this is part of the OS is gone.
 */
function createOverlayWindow({ dev }) {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    // macOS: the window never becomes key (focusable: false), so every click on it is a click on
    // an inactive window -- which, with this false, is not passed on to the page ("whether
    // clicking an inactive window will also click through to the web contents"): the tick and the
    // X could never be clicked. The non-activating panel (MAC_PANEL) is what keeps the app being
    // dictated into in front. Not configurable on other platforms.
    acceptFirstMouse: true,
    backgroundColor: '#00000000',
    // macOS: see MAC_PANEL above. Out of Mission Control as well -- it is not a window anyone switches to.
    ...(MAC_PANEL ? { type: 'panel' } : {}),
    ...(MAC ? { hiddenInMissionControl: true } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  // 'screen-saver' floats above almost everything on Windows, including most
  // fullscreen apps. Anything lower and the overlay disappears behind games.
  // On macOS it is the screen-saver window level: above full-screen apps and the
  // menu bar.
  win.setAlwaysOnTop(true, 'screen-saver');
  // macOS: on every Space and over full-screen apps. Electron would hide the Dock
  // icon to allow the latter; index.js has already done that, before this window
  // existed, so it is told not to do it again.
  win.setVisibleOnAllWorkspaces(true, MAC
    ? { visibleOnFullScreen: true, skipTransformProcessType: true }
    : { visibleOnFullScreen: true });

  // Click-through, except over the pill's two controls while they are live: the click gate below
  // decides, from the cursor, with no mouse hook and no help from the page's mouse events.
  win.setIgnoreMouseEvents(true);
  watchClicks(win);

  win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));

  if (dev) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}

/**
 * Park the overlay near the bottom of whichever display the cursor is on, so it
 * follows the user across monitors without being asked to.
 */
function positionOverlay(win, size = 'compact') {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width, height } = display.workArea;

  const box = SIZES[size] || SIZES.compact;

  // Never taller than the display it is on -- a small laptop screen would
  // otherwise push the pill off the bottom to make room for the panel.
  const h = Math.min(box.height, height - LIFT * 2);

  win.setBounds({
    x: Math.round(x + (width - box.width) / 2),
    y: Math.round(y + height - h - LIFT),
    width: box.width,
    height: h
  });
}

/**
 * Show the overlay on top of everything, without taking focus.
 *
 * `alwaysOnTop` at creation is not a promise Windows keeps by itself. Topmost
 * is a place in the z-order, and once anything re-slots the window below
 * ordinary ones it stays there -- even with WS_EX_TOPMOST still set, which is
 * the state a long-running session was found in. showInactive reveals the
 * window wherever it already sits, so the pill came up behind the very app it
 * was dictating into. Re-asserting topmost on every show costs two
 * SetWindowPos calls and makes that state impossible to see.
 *
 * Topmost is set before the show so the pill never paints a frame underneath;
 * moveTop afterwards puts it above other apps' always-on-top windows too.
 * Neither activates. A minimized overlay is not restore()d -- that activates,
 * and focus theft breaks the paste -- showInactive un-minimizes it without.
 */
function showOverlay(win) {
  win.setAlwaysOnTop(true, 'screen-saver');
  win.showInactive();
  win.moveTop();
}

/* --------------------------------------------------------------- click gate */

/*
 * Where the pill takes clicks: over its two controls, while they are live, and nowhere else.
 *
 * Until 0.2.6 this was `setIgnoreMouseEvents(true, { forward: true })` plus the page turning
 * click-through off when a forwarded mousemove landed on a control. On Windows that broke the X
 * and the tick for real users (0.2.5: "the buttons do nothing"), three ways:
 *
 *  1. `forward` is a global low-level mouse hook (WH_MOUSE_LL) that Electron installs on the main
 *     thread and never re-installs while forwarding stays on (native_window_views_win.cc,
 *     `if (!mouse_hook_)`). Windows silently removes such a hook the first time the thread
 *     misses LowLevelHooksTimeout (at most 1 s) -- a busy main thread at launch, a stall -- "and
 *     there is no way for the application to know" (LowLevelMouseProc docs). From then on no
 *     mousemove reaches the page, it never turns click-through off, and every click on the pill
 *     goes through it to the app underneath, for the rest of the run.
 *  2. The forwarded moves are posted to Chromium's legacy child HWND, which Electron remembers
 *     once; Chromium hides and re-parents that window while the view is hidden (between
 *     dictations), so where the moves go is Chromium's business, not ours.
 *  3. The same hook ran every mouse move on the whole PC through Typd's main thread: with the
 *     model busy on the processor, the cursor itself lagged.
 *
 * So the page only says where its controls are (overlay:hit, CSS px from the window's top-left);
 * main watches the cursor itself, ~40 times a second and only while there are controls to
 * watch, and lets the window take clicks while the cursor is over one. getCursorScreenPoint and
 * getBounds are both DIPs, so the difference is CSS px at any display scaling. Nothing here
 * shows, focuses or activates the window: the app being dictated into keeps the keyboard.
 * (What reaches the page once the window takes the click is overlay.js's half: see act().)
 */
const GATE_MS = 25;
const MAX_AREAS = 4;
const gates = new WeakMap();

/** The page's rectangles, checked: {x, y, w, h} in CSS px, small and finite, at most MAX_AREAS. */
function cleanAreas(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_AREAS)
    .filter((r) => r && [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && Number.isFinite(v)) &&
      r.w > 0 && r.h > 0 && r.w <= 400 && r.h <= 400)
    .map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
}

/** Is the point (window-relative CSS px) inside any of the rectangles? Edges count. */
function overArea(areas, x, y) {
  return areas.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
}

/**
 * The gate itself, with everything it touches passed in (bench/pill.js runs it without Electron).
 *   setIgnore(bool)  win.setIgnoreMouseEvents
 *   cursor()         {x, y}, DIP;  bounds() {x, y}, DIP;  visible() bool
 */
function createClickGate({ setIgnore, cursor, bounds, visible, every = GATE_MS, timers = { setInterval, clearInterval } }) {
  let areas = [];
  let timer = null;
  let takes = false;   // false: click-through (how the window is made)

  const set = (on) => {
    if (on === takes) return;
    takes = on;
    setIgnore(!on);
  };

  const tick = () => {
    if (!areas.length || !visible()) { set(false); return; }
    let c, b;
    try { c = cursor(); b = bounds(); } catch { set(false); return; }
    set(Boolean(c && b) && overArea(areas, c.x - b.x, c.y - b.y));
  };

  const stop = () => {
    if (timer) { timers.clearInterval(timer); timer = null; }
  };

  return {
    /** The page's latest rectangles; an empty list means no live controls: click-through. */
    areas(list) {
      areas = cleanAreas(list);
      if (!areas.length) { stop(); set(false); return; }
      if (!timer) {
        timer = timers.setInterval(tick, every);
        if (timer && timer.unref) timer.unref();
      }
      tick();
    },
    /** Click-through everywhere, now, whatever the gate thought (index.js passThrough). */
    release() {
      areas = [];
      stop();
      takes = false;
      setIgnore(true);
    },
    tick,
    get takesClicks() { return takes; },
    get watching() { return Boolean(timer); }
  };
}

/** Give a new overlay window its gate, fed by its own page's overlay:hit and nobody else's. */
function watchClicks(win) {
  const wc = win.webContents;
  const alive = () => !win.isDestroyed();
  const gate = createClickGate({
    setIgnore: (ignore) => { if (alive()) win.setIgnoreMouseEvents(ignore); },
    cursor: () => screen.getCursorScreenPoint(),
    bounds: () => win.getBounds(),
    visible: () => alive() && win.isVisible()
  });
  gates.set(win, gate);
  const onHit = (e, list) => { if (e.sender === wc) gate.areas(list); };
  ipcMain.on('overlay:hit', onHit);
  win.on('hide', () => gate.release());
  win.on('closed', () => {
    ipcMain.removeListener('overlay:hit', onHit);
    gate.release();
  });
  return gate;
}

/** Click-through everywhere on this overlay, now. */
function releaseClicks(win) {
  if (!win || win.isDestroyed()) return;
  const gate = gates.get(win);
  if (gate) gate.release();
  else win.setIgnoreMouseEvents(true);
}

module.exports = {
  createOverlayWindow, positionOverlay, showOverlay, releaseClicks, SIZES, WIDTH, HEIGHT,
  // bench/pill.js
  createClickGate, cleanAreas, overArea, GATE_MS
};
