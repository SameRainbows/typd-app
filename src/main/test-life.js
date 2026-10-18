'use strict';

/**
 * CI only (mac.yml, "Open from the menu bar, close with the red X, stay running";
 * scripts/mac-tray-close-check.sh). Runs only when TYPD_TEST_LIFE=<file> is set: nothing here
 * runs, or is even required, otherwise.
 *
 * From launch, once a second, <file> says what an outside script cannot see from outside: the
 * pid, the menu-bar icon's place on screen, the Typd window's place and state, the key layer's
 * state and how many key events it heard before the window opened, while it was open and since
 * it closed, the Dock icon, how often the app became and stopped being the active app, and how
 * late a 1 s timer fires (App Nap coalesces a background app's timers).
 *
 * TYPD_TEST_LIFE_HOW says who opens and closes the window:
 *   tray  Typd itself, 12 s after launch, through the menu-bar menu's own "Open Typd" item (the
 *         function a click on it runs), then 3 s after the window shows, win.close() -- the path
 *         of the red X;
 *   gui   the script, with real mouse clicks: the menu-bar icon, "Open Typd" in its menu, the
 *         red X (it reads where they are from <file>). Typd only reports.
 *   watch nobody: Typd only reports, and its first-run walkthrough follows the normal rule (an
 *         existing install or an update must open no window by itself; a fresh install does).
 */

const fs = require('fs');

function start({ file, how, app, home, trayUi, getOverlay, getHotkeys, getSession }) {
  const { BrowserWindow } = require('electron');
  const t0 = Date.now();
  const hot = () => getHotkeys();
  const heard = () => (hot() ? hot().keysHeard : 0);
  let phase = 'starting', openedAt = 0, closedAt = 0, atOpen = null, atClose = null;
  let openedBy = '', closeEvent = '', last = 0, late = 0, lateRecent = 0, lateRecentAt = 0;
  let active = 0, resigned = 0, dockShown = false;
  const homeWin = () => home.current();

  if (process.platform === 'darwin') {
    app.on('did-become-active', () => { active++; });
    app.on('did-resign-active', () => { resigned++; });
  }

  // The window, watched: when it shows, and when it closes, however that happens.
  let watched = null;
  setInterval(() => {
    const w = homeWin();
    if (w && w !== watched) {
      watched = w;
      w.once('show', () => { if (!openedAt) { openedAt = Date.now(); atOpen = heard(); phase = 'open'; } });
      if (w.isVisible() && !openedAt) { openedAt = Date.now(); atOpen = heard(); phase = 'open'; }
      w.once('close', () => { closeEvent = 'close'; atClose = heard(); });
      w.once('closed', () => { closedAt = Date.now(); if (atClose === null) atClose = heard(); phase = 'closed'; console.log('[typd:test] the Typd window closed'); });
    }
  }, 100);

  const box = (b) => (b ? [b.x, b.y, b.width, b.height].map(Math.round).join(',') : 'none');
  const write = () => {
    const now = Date.now();
    if (last) {
      const l = now - last - 1000;
      late = Math.max(late, l);
      if (now - lateRecentAt > 30000) { lateRecent = 0; lateRecentAt = now; }
      lateRecent = Math.max(lateRecent, l);
    }
    last = now;
    const tray = trayUi.tray;
    const w = homeWin();
    if (app.dock && app.dock.isVisible()) dockShown = true;
    const h = hot();
    let tapLine = 'none';
    try { tapLine = h && h.health ? JSON.stringify(h.health()) : 'not reported'; } catch (err) { tapLine = 'error ' + err.message; }
    const lines = [
      'pid: ' + process.pid,
      'alive',
      'how: ' + how,
      'phase: ' + phase,
      'up: ' + Math.round((now - t0) / 1000) + ' s',
      'tray: ' + (!tray ? 'none' : tray.isDestroyed() ? 'destroyed' : box(tray.getBounds())),
      'window: ' + (w ? 'open ' + box(w.getBounds()) + (w.isVisible() ? ' visible' : ' hidden') + (w.isFocused() ? ' focused' : '')
        : closedAt ? 'closed ' + Math.round((now - closedAt) / 1000) + ' s ago' : 'never opened'),
      'opened by: ' + (openedBy || '-') + ', close event: ' + (closeEvent || '-'),
      'hotkey: ' + (h ? h.state() : 'none'),
      'keys heard: ' + heard() + ' total, ' + (atOpen === null ? '-' : atOpen) + ' before the window opened, ' +
        (atClose === null ? '-' : atClose) + ' when it closed, ' + (atClose === null ? '-' : heard() - atClose) + ' since it closed',
      'dock: ' + (app.dock ? (app.dock.isVisible() ? 'shown' : 'hidden') + (dockShown ? ' (was shown)' : ' (never shown)') : 'none'),
      'activation: became active ' + active + ', resigned ' + resigned,
      'overlay: ' + (getOverlay() && !getOverlay().isDestroyed() ? 'alive' : 'gone') + ', windows: ' + BrowserWindow.getAllWindows().length,
      'dictation: ' + (getSession() ? getSession().mode + ', open' : 'none open'),
      'tap: ' + tapLine,
      'timer: up to ' + late + ' ms late, ' + lateRecent + ' ms in the last 30 s'
    ];
    try { fs.writeFileSync(file + '.tmp', lines.join('\n') + '\n'); fs.renameSync(file + '.tmp', file); } catch (err) { console.log('[typd:test]', err.message); }
  };
  setInterval(write, 1000);
  write();

  if (how === 'tray') {
    setTimeout(() => {
      // The menu-bar menu's own item, and the function a click on it runs.
      const item = trayUi.menu().items.find((i) => i.label === 'Open Typd');
      openedBy = item ? 'the menu-bar menu item' : 'no menu item found';
      phase = 'opening';
      console.log('[typd:test] clicking "Open Typd" in the menu-bar menu');
      if (item) item.click();
      const waitShown = setInterval(() => {
        if (!openedAt) return;
        clearInterval(waitShown);
        setTimeout(() => {
          phase = 'closing';
          console.log('[typd:test] closing the Typd window (win.close(), the red X path); ' + (hot() ? hot().state() : 'no hotkey'));
          home.close();
        }, 3000);
      }, 250);
    }, 12000);
  } else if (how === 'gui') {
    openedBy = 'the script (mouse clicks)';
    // When the script's clicks cannot open the menu-bar menu on a runner, it writes "open" to
    // <file>.cmd and Typd opens the window through the menu's own item; the red X is still a click.
    const cmd = file + '.cmd';
    const poll = setInterval(() => {
      let c = '';
      try { c = fs.readFileSync(cmd, 'utf8').trim(); fs.unlinkSync(cmd); } catch { return; }
      if (c !== 'open') return;
      clearInterval(poll);
      const item = trayUi.menu().items.find((i) => i.label === 'Open Typd');
      openedBy = 'the menu-bar menu item (the script asked); the red X by mouse click';
      if (item) item.click();
    }, 250);
  }
}

module.exports = { start };
