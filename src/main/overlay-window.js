'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');

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
    acceptFirstMouse: false,
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

  // Click-through. `forward: true` still delivers move events so hover states
  // could work later without giving up pass-through clicks.
  win.setIgnoreMouseEvents(true, { forward: true });

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

module.exports = { createOverlayWindow, positionOverlay, showOverlay, SIZES, WIDTH, HEIGHT };
