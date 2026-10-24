'use strict';

/**
 * Typd's own dialogs on a Mac, as sheets on the Typd window: never app-modal (0.2.11).
 *
 * Electron's dialog.showMessageBox(options) with no parent window -- or with a parent that is not on
 * screen -- is an NSAlert in runModal on macOS: the main process stops until someone clicks. On a
 * brand-new Mac (CI, 0.2.10) "Typd needs two switches turned on" opened that way right after the
 * microphone was allowed, and the speech model's download stood still for as long as it was up
 * (19.7 MB for 60 s; 244 MB for 34 min when nobody answered), the walkthrough's bar with it.
 * Attached to a window that is on screen it is a sheet (beginSheetModalForWindow), and Typd keeps
 * running underneath.
 *
 * So every dialog of Typd's on a Mac comes through show(): it gets the Typd window from index.js
 * (use(): opened if it is closed), waits for it to be on screen, and attaches the dialog to it.
 * With no window on screen it shows nothing (resolves null): the window's own card lists the same
 * switches. It never calls showMessageBox without a visible parent.
 */

const log = (...args) => console.log('[typd:sheet]', ...args);
const lifeLog = (what, detail) => { try { require('../lifelog').log(what, detail); } catch { /* no log */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let windowFor = null;   // index.js: () => the Typd window (opened if need be), or null

function use(fn) { windowFor = fn; }

const onScreen = (win) => Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());

/** The Typd window, on screen, or null within `wait` ms. */
async function parent(wait = 10000) {
  let win = null;
  try { win = windowFor ? windowFor() : null; } catch (err) { log('no window:', err && err.message); }
  if (!win || win.isDestroyed()) return null;
  try { if (win.isMinimized()) win.restore(); } catch { /* as it is */ }
  const until = Date.now() + wait;
  while (!onScreen(win) && !win.isDestroyed() && Date.now() < until) await sleep(100);
  return onScreen(win) ? win : null;
}

/**
 * dialog.showMessageBox as a sheet on the Typd window. Resolves its { response } -- `cancelId` if the
 * window closes under it -- or null when there was no Typd window on screen to attach it to.
 */
async function show(options, { what = options && options.message, wait } = {}) {
  const { dialog } = require('electron');
  const win = await parent(wait);
  // Electron shows an NSAlert in runModal for a parent that is not visible (blocking): never that.
  if (!onScreen(win)) {
    log('no Typd window on screen: not shown:', what);
    lifeLog('dialog', 'not shown (no Typd window on screen to attach it to): ' + what);
    return null;
  }
  let onClosed = null;
  const closed = new Promise((resolve) => {
    onClosed = () => resolve({ response: options.cancelId === undefined ? -1 : options.cancelId, closed: true });
    win.once('closed', onClosed);
  });
  try {
    return await Promise.race([dialog.showMessageBox(win, options), closed]);
  } finally {
    try { if (!win.isDestroyed()) win.removeListener('closed', onClosed); } catch { /* gone */ }
  }
}

module.exports = { use, show, parent };
