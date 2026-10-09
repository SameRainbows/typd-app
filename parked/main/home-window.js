'use strict';

const path = require('path');
const { BrowserWindow, ipcMain, nativeTheme, shell } = require('electron');

const store = require('./store');
const dictionary = require('./dictionary');

/**
 * The app's own window: stats, history, dictionary.
 *
 * Everything the overlay does is deliberately invisible, which leaves nowhere to
 * see what has been dictated, nowhere to read what was learned, and nowhere to
 * turn history off. This is that place.
 */

let win = null;

function create({ bindings }) {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return win;
  }

  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Typd',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0E0F12' : '#FFFFFF',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'home.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'home.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  // Links in the window go to the real browser, never inside the app frame.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.__bindings = bindings;
  return win;
}

function registerIpc({ bindings }) {
  ipcMain.handle('home:data', () => ({
    stats: store.stats(),
    sessions: store.sessions(200),
    dictionary: dictionary.all(),
    retentionDays: store.retention(),
    bindings,
    dark: nativeTheme.shouldUseDarkColors
  }));

  ipcMain.handle('home:dictionary-add', (_e, term) => {
    const r = dictionary.add(term, null, 'manual');
    return { ok: !!r, dictionary: dictionary.all() };
  });

  ipcMain.handle('home:dictionary-remove', (_e, term) => {
    dictionary.remove(term);
    return { ok: true, dictionary: dictionary.all() };
  });

  ipcMain.handle('home:set-retention', (_e, days) => {
    store.setRetention(days);
    return { ok: true, retentionDays: store.retention(), sessions: store.sessions(200) };
  });

  ipcMain.handle('home:clear-history', () => {
    store.clear();
    return { ok: true, stats: store.stats(), sessions: [] };
  });

  ipcMain.handle('home:set-theme', (_e, mode) => {
    nativeTheme.themeSource = mode === 'light' ? 'light' : mode === 'system' ? 'system' : 'dark';
    return { dark: nativeTheme.shouldUseDarkColors };
  });
}

/** Push a refresh when a session lands while the window is open. */
function notifyChanged() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('home:changed');
  }
}

module.exports = { create, registerIpc, notifyChanged, get: () => win };
