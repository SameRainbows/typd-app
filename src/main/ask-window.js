'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const brand = require('./brand');

/**
 * The one question sharing asks (sharing.js), in one small window:
 *
 *   flag      "That was wrong" on the last dictation, with an optional one-line note. If it was
 *             never shared, it asks first: "Share this one dictation so it can be fixed?"
 *
 * (Until 0.2.3 a consent screen lived here too. Since 0.2.4 public builds share unless turned
 * off in Settings, and the walkthrough's first screen says so: there is no consent screen.)
 *
 * Like the Typd window, it exists only while open, and every call from its page is named,
 * checked to come from that window's own page, and validated here.
 */

const PAGES = { flag: 'flag.html' };
const SIZE = { flag: [460, 360] };
const SURFACE = { dark: '#17191E', light: '#FBFBFC' };
const MAC = process.platform === 'darwin';

const wins = { flag: null };
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

  handle('ask:close', (kind) => { close(kind); return true; });
}

/** Open (or bring forward) the window: 'flag'. */
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
    // The flag answers a key pressed in another app: keep it above that app until answered.
    alwaysOnTop: kind === 'flag',
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
