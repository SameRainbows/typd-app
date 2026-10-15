'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const brand = require('./brand');

/**
 * The two questions sharing asks (sharing.js), each in one small window:
 *
 *   consent   the public beta's first-run screen: what is shared, what never is, and two equal
 *             buttons -- "Share my dictations to improve Typd" / "Keep everything on my
 *             computer". Opened once on the first run, and from Settings ("What's shared", or
 *             turning sharing on). Closed without an answer, sharing stays off.
 *   flag      "That was wrong" on the last dictation, with an optional one-line note. If it was
 *             never shared, it asks first: "Share this one dictation so it can be fixed?"
 *
 * Like the Typd window, they exist only while open, and every call from their pages is named,
 * checked to come from that window's own page, and validated here.
 */

const PAGES = { consent: 'consent.html', flag: 'flag.html' };
const SIZE = { consent: [520, 660], flag: [460, 360] };
const SURFACE = { dark: '#17191E', light: '#FBFBFC' };
const MAC = process.platform === 'darwin';

const wins = { consent: null, flag: null };
const answered = { consent: false };
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

function consentState() {
  return {
    platform: { mac: MAC, machine: MAC ? 'Mac' : 'PC' },
    choice: deps.choice()
  };
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
 * @param {() => string} d.choice                    settings 'share'
 * @param {(share: boolean) => Promise<object>} d.choose   answer the consent screen
 * @param {(result: object) => void} d.flagged       a flag went through (the pill says so)
 */
function register(d) {
  deps = d;

  handle('ask:state', (kind) => (kind === 'consent' ? consentState() : flagState()));

  handle('ask:consent', async (kind, share) => {
    if (kind !== 'consent' || typeof share !== 'boolean') return null;
    answered.consent = true;
    const r = await deps.choose(share);
    close('consent');
    return r;
  });

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

/** Open (or bring forward) one of the two windows: 'consent' | 'flag'. */
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
  if (kind === 'consent') answered.consent = false;
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
    // Closed without an answer: nothing is shared, and the question is not asked again by itself
    // (Settings has it). The choice is recorded as off only if there was none.
    if (kind === 'consent' && !answered.consent && deps.choice() === '') deps.choose(false).catch(() => {});
  });
  w.loadFile(path.join(__dirname, '..', 'renderer', PAGES[kind]));
}

const isOpen = (kind) => Boolean(wins[kind] && !wins[kind].isDestroyed());

module.exports = { register, open, isOpen };
