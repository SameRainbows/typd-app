'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require('electron');
const settings = require('./settings');

/**
 * Settings: one small window for the five things Typd cannot learn (ROADMAP, Law 2).
 *
 * It exists only while it is open -- created on demand, destroyed on close -- so it costs
 * nothing the rest of the time. It never opens on its own: the tray's "Settings…" and
 * launching Typd again from Start or Windows search (which is how people look for an app
 * whose tray icon Windows has hidden) are the only ways in.
 *
 * The renderer gets exactly four calls through its preload, and every one checks that it
 * came from this window's own page: a window that can switch the microphone and open a
 * folder is worth that care.
 */

const PAGE = path.join(__dirname, '..', 'renderer', 'settings.html');
const STARTUP = () => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Typd.lnk');
const PARKED = () => path.join(app.getPath('appData'), 'typd', 'Typd.startup.lnk');
let win = null;
let deps = null;   // { recordingsDir, modelName }

function fromPage(e) {
  return win && !win.isDestroyed() && e.sender === win.webContents && /settings\.html$/.test(e.senderFrame && e.senderFrame.url || '');
}

/** Start with Windows is the Startup-folder shortcut. Off parks it rather than deleting it. */
function startAtLogin(on) {
  const live = STARTUP(), parked = PARKED();
  try {
    if (on) {
      if (fs.existsSync(live)) return true;
      if (fs.existsSync(parked)) { fs.renameSync(parked, live); return true; }
      return shell.writeShortcutLink(live, 'create', {
        target: process.execPath, args: `"${app.getAppPath()}"`, cwd: app.getAppPath(),
        description: 'Typd', icon: path.join(app.getAppPath(), 'assets', 'typd.ico'), iconIndex: 0
      });
    }
    if (!fs.existsSync(live)) return true;
    fs.mkdirSync(path.dirname(parked), { recursive: true });
    fs.renameSync(live, parked);
    return true;
  } catch {
    return false;
  }
}

function recordingsInfo() {
  const dir = path.join(app.getPath('appData'), 'Typd', 'recordings');
  let count = 0, bytes = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.wav')) continue;
      count++;
      bytes += fs.statSync(path.join(dir, f)).size;
    }
  } catch { /* no folder yet */ }
  return { count, mb: Math.round(bytes / 1e6) };
}

function state() {
  return {
    ...settings.get(),
    startAtLogin: fs.existsSync(STARTUP()),
    recordings: recordingsInfo(),
    model: deps.modelName(),
    version: app.getVersion()
  };
}

function register(d) {
  deps = d;
  ipcMain.handle('settings:get', (e) => (fromPage(e) ? state() : null));
  ipcMain.handle('settings:set', (e, key, value) => {
    if (!fromPage(e)) return false;
    if (key === 'startAtLogin') {
      if (typeof value !== 'boolean' || !startAtLogin(value)) return false;
      return settings.set('startAtLogin', value);
    }
    if (key === 'hotkey') {   // swap the live binding first; keep the old one if the new key is taken
      if (!settings.HOTKEYS.includes(value) || !deps.applyHotkey(value)) return false;
      return settings.set('hotkey', value);
    }
    return settings.set(key, value);
  });
  ipcMain.handle('settings:open-recordings', (e) => {
    if (!fromPage(e)) return false;
    const dir = path.join(app.getPath('appData'), 'Typd', 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir).then((err) => !err);
  });
}

function open() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    return;
  }
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 440, height: 600, useContentSize: true, resizable: false, maximizable: false, fullscreenable: false,
    title: 'Typd Settings', show: false, autoHideMenuBar: true,
    backgroundColor: dark ? '#17191E' : '#FBFBFC',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: dark ? '#17191E' : '#FBFBFC', symbolColor: dark ? '#E6E8EC' : '#14161B', height: 36 },
    icon: path.join(app.getAppPath(), 'assets', 'typd.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false
    }
  });
  win.setMenu(null);
  // Nothing in this window navigates or opens windows; refuse both outright.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.loadFile(PAGE);
}

module.exports = { register, open };
