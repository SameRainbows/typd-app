'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const brand = require('./brand');

/**
 * The questions sharing asks (sharing.js), each in one small window:
 *
 *   flag      "That was wrong" on the last dictation, with an optional one-line note. If it was
 *             never shared, it asks first: "Share this one dictation so it can be fixed?"
 *   share     "Help make Typd better?" -- Share / Don't share, nothing preselected (0.2.7). Once, on
 *             an install first started after the cutoff that 0.2.4-0.2.6 never asked (index.js
 *             startShareAsk); a fresh install is asked on the walkthrough's first screen instead.
 *             The answer goes through sharing.answer (index.js chooseSharing).
 *
 * Like the Typd window, it exists only while open, and every call from its page is named,
 * checked to come from that window's own page, and validated here.
 */

const PAGES = { flag: 'flag.html', share: 'share.html' };
const SIZE = { flag: [460, 360], share: [440, 210] };
const SURFACE = { dark: '#17191E', light: '#FBFBFC' };
const MAC = process.platform === 'darwin';

const wins = { flag: null, share: null };
let deps = null;

/** Which of our windows sent this, if it came from that window's own page; else null. */
function pageOf(e) {
  for (const kind of Object.keys(PAGES)) {
    const w = wins[kind];
    if (!w || w.isDestroyed() || e.sender !== w.webContents) continue;
    try {
      if (new URL(e.senderFrame.url).pathname.endsWith('/renderer/' + PAGES[kind])) return kind;
    } catch { /* not a page of ours */ }
  }
  return null;
}

/** ipcMain.handle, answering null to anything not from one of these pages. */
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    const kind = pageOf(e);
    return kind ? fn(kind, ...args) : null;
  });
}

function close(kind) {
  const w = wins[kind];
  if (w && !w.isDestroyed()) w.close();
}

function flagState() {
  const s = deps.sharing();
  const last = s ? s.lastInfo() : null;
  const st = s ? s.status() : null;
  const text = last ? String(last.text || '') : '';
  return {
    has: Boolean(last),
    text: text.length > 400 ? text.slice(0, 399) + '…' : text,
    mode: last ? last.mode : null,
    needsConsent: Boolean(last && last.needsConsent),
    sharingOn: Boolean(st && st.state === 'on'),
    platform: { mac: MAC, machine: MAC ? 'Mac' : 'PC' }
  };
}

/**
 * @param {object} d
 * @param {() => object|null} d.sharing             sharing.get()
 * @param {(result: object) => void} d.flagged       a flag went through (the pill says so)
 * @param {(share: boolean) => Promise<object>} d.answer   the share screen's answer (index.js chooseSharing)
 */
function register(d) {
  deps = d;

  handle('ask:state', (kind) => (kind === 'flag' ? flagState() : null));

  handle('ask:flag', async (kind, answer) => {
    if (kind !== 'flag' || !answer || typeof answer !== 'object') return null;
    const note = typeof answer.note === 'string' ? answer.note.slice(0, 400) : '';
    const s = deps.sharing();
    if (!s) return { state: 'failed' };
    const r = await s.flag({ note, consent: answer.share === true });
    if (r.state !== 'ask') {
      close('flag');
      deps.flagged(r);
    }
    return r;
  });

  // "Help make Typd better?": true = Share, false = Don't share. Stored (and, for Don't share on an
  // install that shared under 0.2.6's default, what it shared deleted), then the window closes.
  handle('ask:share', async (kind, share) => {
    if (kind !== 'share' || typeof share !== 'boolean' || !deps.answer) return null;
    const r = await deps.answer(share);
    close('share');
    return r;
  });

  handle('ask:close', (kind) => { close(kind); return true; });
}

/** Open (or bring forward) the window: 'flag' or 'share'. */
function open(kind) {
  if (!PAGES[kind] || !deps) return;
  const existing = wins[kind];
  if (existing && !existing.isDestroyed()) {
    if (kind === 'flag') existing.webContents.send('ask:refresh');
    existing.show();
    existing.focus();
    return;
  }
  const [width, height] = SIZE[kind];
  const w = new BrowserWindow({
    width, height, useContentSize: true, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, show: false, autoHideMenuBar: true, title: 'Typd',
    // The flag answers a key pressed in another app, and the share question comes at launch while
    // another app may be in front: keep each above it until answered or closed.
    alwaysOnTop: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? SURFACE.dark : SURFACE.light,
    icon: brand.windowIcon(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'ask.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: kind === 'flag'
    }
  });
  wins[kind] = w;
  w.setMenu(null);
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.once('ready-to-show', () => {
    w.center();
    w.show();
    w.focus();
    if (MAC) app.focus({ steal: true });   // a menu-bar app is not brought forward by showing a window
  });
  w.on('closed', () => {
    wins[kind] = null;
  });
  w.loadFile(path.join(__dirname, '..', 'renderer', PAGES[kind]));
}

const isOpen = (kind) => Boolean(wins[kind] && !wins[kind].isDestroyed());

module.exports = { register, open, isOpen };
