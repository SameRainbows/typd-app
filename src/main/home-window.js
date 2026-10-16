'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require('electron');
const settings = require('./settings');
const sharing = require('./sharing');
const dictionary = require('./dictionary');
const { store } = require('./store');
const status = require('./status');
const brand = require('./brand');
const hotkeyLogic = require('./hotkey-logic');
const { VOCAB_FILE } = require('./pipeline/context');

/**
 * The Typd window: Home, History, Dictionary, Settings and What's new (ROADMAP, Law 2).
 *
 * The overlay is the product; this is its quiet companion, for what the pill cannot
 * show -- what you dictated, what Typd learned, the few choices it cannot learn. It
 * opens only when asked: the tray or menu bar, or launching Typd again. The one
 * exception is a Typd that cannot work without you (a blocked microphone), and then it
 * opens on the section that fixes it.
 *
 * It exists only while it is open -- created on demand, destroyed on close -- so it
 * costs nothing the rest of the time. It can delete history and switch the microphone,
 * so every call from its page is named, checked to come from this window's own page,
 * and validated here; nothing generic crosses the bridge, and nothing navigates.
 */

const PAGE = path.join(__dirname, '..', 'renderer', 'home.html');
const SECTIONS = ['home', 'history', 'dictionary', 'settings', 'news'];
const MAC = process.platform === 'darwin';
const STARTUP = () => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Typd.lnk');
const PARKED = () => path.join(app.getPath('appData'), 'typd', 'Typd.startup.lnk');
const FEEDBACK = 'contact@mehmetdedeler.com';
const VERIFY_MS = 10000;
const SURFACE = { dark: { bg: '#17191E', sym: '#E6E8EC' }, light: { bg: '#FBFBFC', sym: '#14161B' } };

let win = null;
let deps = null;
let verify = null;          // { binding, previous, timer } while a new key waits to be heard
const removedWords = new Map();

function fromPage(e) {
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return false;
  try {
    return new URL(e.senderFrame.url).pathname.endsWith('/renderer/home.html');
  } catch {
    return false;
  }
}

/** ipcMain.handle, answering null to anything not from this window's page. */
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => (fromPage(e) ? fn(...args) : null));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload || {});
}

/* ------------------------------------------------------------- start at login */

/**
 * Windows: the installed app uses the system's Run entry; run from source, the Startup
 * folder shortcut that starts Electron with this folder (switching off parks it rather
 * than deleting it). macOS: the system login item (mac/login-item.js).
 */
function loginItem() {
  if (MAC) return require('./mac/login-item').get();
  if (app.isPackaged) {
    try { return Boolean(app.getLoginItemSettings().openAtLogin); } catch { return false; }
  }
  return fs.existsSync(STARTUP());
}

function setLoginItem(on) {
  if (MAC) return require('./mac/login-item').set(on);
  if (app.isPackaged) {
    try { app.setLoginItemSettings({ openAtLogin: Boolean(on) }); return true; } catch { return false; }
  }
  const live = STARTUP(), parked = PARKED();
  try {
    if (on) {
      if (fs.existsSync(live)) return true;
      if (fs.existsSync(parked)) { fs.renameSync(parked, live); return true; }
      return shell.writeShortcutLink(live, 'create', {
        target: process.execPath, args: `"${app.getAppPath()}"`, cwd: app.getAppPath(),
        description: 'Typd', icon: brand.windowIcon(), iconIndex: 0
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

/* ------------------------------------------------------------------- state */

function recordingsInfo() {
  let count = 0, bytes = 0;
  try {
    const dir = settings.recordingsDir();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.wav')) continue;
      count++;
      bytes += fs.statSync(path.join(dir, f)).size;
    }
  } catch { /* no folder yet */ }
  return { count, mb: Math.round(bytes / 1e6) };
}

function settingsState() {
  const flag = deps && deps.flagKey ? deps.flagKey() : null;
  return {
    ...settings.get(),
    startAtLogin: loginItem(),
    loginSupported: MAC ? require('./mac/login-item').supported() : true,
    recordings: recordingsInfo(),
    // null where sharing is not in this build; {mode: 'tester', ...} or {mode: 'beta', ...} (sharing.js)
    sharing: sharing.status(),
    flagKey: flag ? { label: hotkeyLogic.label(flag, process.platform), parts: hotkeyLogic.parts(flag, process.platform) } : null
  };
}

function hotkeyState(binding) {
  const b = binding || deps.hotkey();
  const p = process.platform;
  return {
    binding: b,
    kind: (hotkeyLogic.single(b, p) || { kind: 'chord' }).kind,
    label: hotkeyLogic.label(b, p),
    short: hotkeyLogic.shortLabel(b, p),
    verb: hotkeyLogic.verb(b, p),
    parts: hotkeyLogic.parts(b, p),
    defaultBinding: hotkeyLogic.defaultFor(p),
    defaultLabel: hotkeyLogic.label(hotkeyLogic.defaultFor(p), p),
    sideButtons: Boolean(deps.sideButtons && deps.sideButtons())
  };
}

function homeState() {
  return {
    status: status.describe(),
    perms: status.get().perms,
    hotkey: hotkeyState(),
    model: deps.model(),
    counts: store().counts(),
    platform: { mac: MAC, machine: MAC ? 'Mac' : 'PC', os: MAC ? 'macOS' : 'Windows' },
    version: app.getVersion(),
    settings: settingsState(),
    mark: brand.windowMark()
  };
}

/* ------------------------------------------------------------ the key picker */

/** The new key never answered, or the window closed first: the old one comes back. */
function revert(reason) {
  if (!verify) return;
  const { previous, binding } = verify;
  clearTimeout(verify.timer);
  verify = null;
  deps.applyHotkey(previous);
  if (reason) {
    send('hotkey:verified', {
      ok: false,
      reason: reason === 'timeout'
        ? "Didn't hear " + hotkeyLogic.label(binding, process.platform) + ' — ' + (MAC ? 'macOS' : 'Windows') +
          ' may be keeping it for itself. Try another key.'
        : reason,
      hotkey: hotkeyState(previous)
    });
  }
}

/**
 * The hotkey was pressed while this window had focus. While a new key is being
 * checked, that is the check passing; otherwise it is the "is my key working?" answer.
 */
function heard() {
  if (verify) {
    const { binding } = verify;
    clearTimeout(verify.timer);
    verify = null;
    settings.set('hotkey', binding);
    deps.hotkeyChanged();
    send('hotkey:verified', { ok: true, hotkey: hotkeyState(binding) });
    return;
  }
  send('hotkey:heard', { hotkey: hotkeyState() });
}

function setHotkey(raw) {
  if (verify) revert();
  const v = hotkeyLogic.validate(raw, process.platform, { sideButtons: Boolean(deps.sideButtons && deps.sideButtons()) });
  if (!v.ok) return { ok: false, reason: v.reason };
  const previous = deps.hotkey();
  if (v.binding === previous) return { ok: true, same: true, hotkey: hotkeyState(previous) };
  const r = deps.applyHotkey(v.binding);
  if (!r.ok) return { ok: false, reason: r.reason };
  verify = { binding: v.binding, previous, timer: setTimeout(() => revert('timeout'), VERIFY_MS) };
  return { ok: true, verifying: true, hotkey: hotkeyState(v.binding) };
}

/* -------------------------------------------------------------------- IPC */

const isString = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max;

function register(d) {
  deps = d;

  handle('home:get', () => homeState());

  // History
  handle('history:list', () => ({ keep: store().keep(), items: store().list() }));
  handle('history:copy', async (id) => {
    if (!isString(id, 40)) return false;
    const item = store().get(id);
    if (!item) return false;
    await deps.copy(item.text);
    return true;
  });
  handle('history:delete', (id) => isString(id, 40) && store().remove(id));
  handle('history:undo', (id) => isString(id, 40) && store().restore(id));
  handle('history:clear', () => {
    const n = store().clear();
    deps.historyChanged();
    return n;
  });
  handle('history:keep', (k) => {
    if (!store().setKeep(k)) return null;
    deps.historyChanged();
    return { keep: store().keep(), items: store().list() };
  });

  // Dictionary
  handle('dictionary:list', () => dictionary.load());
  handle('dictionary:add', (term) => {
    const clean = typeof term === 'string' ? term.trim().replace(/\s+/g, ' ') : '';
    if (!clean) return { ok: false, reason: 'Type a word first.' };
    if (clean.length > 64) return { ok: false, reason: 'Up to 64 characters.' };
    const lower = clean.toLowerCase();
    const existing = dictionary.load().find((e) => e && String(e.term).toLowerCase() === lower);
    if (existing) return { ok: false, reason: 'Already in your dictionary.', term: existing.term, entries: dictionary.load() };
    const r = dictionary.add(clean, null, 'manual');
    return r ? { ok: true, term: r.term, entries: dictionary.load() } : { ok: false, reason: "Couldn't save the dictionary." };
  });
  handle('dictionary:remove', (term) => {
    if (!isString(term, 64)) return null;
    const entry = dictionary.load().find((e) => e && String(e.term).toLowerCase() === term.toLowerCase());
    if (!entry) return { ok: false, entries: dictionary.load() };
    removedWords.set(entry.term.toLowerCase(), entry);
    setTimeout(() => removedWords.delete(entry.term.toLowerCase()), 60000).unref?.();
    const ok = dictionary.remove(entry.term);
    if (ok) deps.wordRemoved(entry.term);
    return { ok, entries: dictionary.load() };
  });
  handle('dictionary:undo', (term) => {
    if (!isString(term, 64)) return null;
    const entry = removedWords.get(term.toLowerCase());
    if (!entry) return { ok: false, entries: dictionary.load() };
    removedWords.delete(term.toLowerCase());
    return { ok: dictionary.restore(entry), entries: dictionary.load() };
  });
  handle('dictionary:reveal', () => {
    if (!fs.existsSync(VOCAB_FILE)) return false;
    shell.showItemInFolder(VOCAB_FILE);
    return true;
  });

  // Settings: the five controls, and the Dock on a Mac
  handle('settings:set', (key, value) => {
    if (key === 'startAtLogin') {
      if (typeof value !== 'boolean' || !setLoginItem(value)) return false;
      return settings.set('startAtLogin', value);
    }
    if (key === 'showInDock') {
      if (!MAC || !settings.set('showInDock', value)) return false;
      syncDock();
      return true;
    }
    if (!['mic', 'micLabel', 'sounds', 'keepRecordings', 'sharePaused'].includes(key)) return false;
    return settings.set(key, value);
  });
  handle('settings:state', () => settingsState());

  // Sharing (the public beta). Turning it on always goes through the consent screen; off is
  // immediate. Deleting empties the outbox and deletes what the server holds for this install.
  handle('sharing:set', async (on) => {
    if (typeof on !== 'boolean' || !sharing.get()) return null;
    if (on) { deps.askConsent(); return { asking: true, settings: settingsState() }; }
    const r = await deps.chooseSharing(false);
    return { ...r, settings: settingsState() };
  });
  handle('sharing:delete', async () => {
    const s = sharing.get();
    if (!s) return null;
    const r = await s.deleteShared();
    return { ...r, settings: settingsState() };
  });
  handle('sharing:about', () => { if (!sharing.get()) return false; deps.askConsent(); return true; });
  handle('settings:open-recordings', () => {
    const dir = settings.recordingsDir();
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir).then((err) => !err);
  });

  // The key picker
  handle('hotkey:pause', (on) => { deps.pauseHotkey(Boolean(on)); return true; });
  handle('hotkey:set', (binding) => (isString(binding, 64) ? setHotkey(binding) : { ok: false, reason: 'Press a key.' }));
  handle('hotkey:cancel', () => { revert(); return hotkeyState(); });

  // What's new
  handle('news:get', () => {
    try { return fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8'); } catch { return ''; }
  });

  // The one action a status line or card offers, and the feedback address
  handle('app:action', (id) => {
    if (id === 'privacy') return openPrivacy();
    if (id === 'retry') { deps.retryModel(); return true; }
    if (id === 'permissions' && MAC) {
      const off = status.get().perms;
      require('./permissions-mac').openPane(off[0] || 'accessibility');
      return true;
    }
    return false;
  });
  handle('app:pane', (kind) => {
    if (!MAC || !['microphone', 'accessibility', 'input', 'automation'].includes(kind)) return false;
    require('./permissions-mac').openPane(kind);
    return true;
  });
  // The model's licence (MODEL_LICENSE.txt: shipped in the app's resources, the repo's in development)
  handle('app:license', () => {
    const file = app.isPackaged ? path.join(process.resourcesPath, 'MODEL_LICENSE.txt') : path.join(__dirname, '..', '..', 'MODEL_LICENSE.txt');
    if (!fs.existsSync(file)) return false;
    return shell.openPath(file).then((err) => !err);
  });
  handle('app:feedback', () => {
    const subject = encodeURIComponent('Typd feedback (' + app.getVersion() + ', ' + (MAC ? 'macOS' : 'Windows') + ')');
    shell.openExternal('mailto:' + FEEDBACK + '?subject=' + subject).catch(() => {});
    return true;
  });

  status.onChange((s) => send('home:status', { status: s, perms: status.get().perms }));
  nativeTheme.on('updated', paintTitleBar);
}

function openPrivacy() {
  if (MAC) { require('./permissions-mac').openPane('microphone'); return true; }
  shell.openExternal('ms-settings:privacy-microphone').catch(() => {});
  return true;
}

/* ----------------------------------------------------------------- window */

function paintTitleBar() {
  if (!win || win.isDestroyed()) return;
  const c = nativeTheme.shouldUseDarkColors ? SURFACE.dark : SURFACE.light;
  win.setBackgroundColor(c.bg);
  if (!MAC) {
    try { win.setTitleBarOverlay({ color: c.bg, symbolColor: c.sym, height: 40 }); } catch { /* older Electron */ }
  }
}

function bringForward() {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (MAC) app.focus({ steal: true });   // a menu-bar app is not brought forward by showing a window
}

const debug = (...args) => { if (process.env.TYPD_DEBUG) console.log('[typd:home]', ...args); };

/**
 * macOS: the Dock icon. With "Show Typd in the Dock" on it stays while Typd runs, and a
 * click on it opens this window (index.js, 'activate'). Off (the default) Typd is a menu-bar
 * app: the icon shows only while this window is open, so it is findable with ⌘Tab, and goes
 * when the window closes. Hiding the icon never quits Typd; the menu-bar icon and the key
 * stay. Called at launch, when the setting changes, and as the window opens and closes.
 */
function syncDock() {
  if (!MAC || !app.dock) return;
  const open = Boolean(win && !win.isDestroyed());
  const want = Boolean(settings.get('showInDock')) || open;
  try {
    const shown = app.dock.isVisible();
    if (want && !shown) app.dock.show();
    else if (!want && shown) app.dock.hide();
    debug('dock', want ? 'shown' : 'hidden', open ? '(window open)' : '');
  } catch (err) {
    debug('dock:', err && err.message);
  }
}

/**
 * Open the window, or bring it forward, on a section: 'home' | 'history' | 'dictionary' |
 * 'settings' | 'news'. `capture`: the hotkey row starts listening for a key at once
 * ("Change shortcut…").
 */
function open(section = 'home', opts = {}) {
  const s = SECTIONS.includes(section) ? section : 'home';
  if (win && !win.isDestroyed()) {
    send('home:show', { section: s, capture: Boolean(opts.capture) });
    bringForward();
    return;
  }
  const c = nativeTheme.shouldUseDarkColors ? SURFACE.dark : SURFACE.light;
  win = new BrowserWindow({
    width: 860, height: 580, minWidth: 720, minHeight: 500, useContentSize: true,
    title: 'Typd', show: false, autoHideMenuBar: true, fullscreenable: false,
    backgroundColor: c.bg,
    // macOS: the native traffic lights, inset into the sidebar's top.
    ...(MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: c.bg, symbolColor: c.sym, height: 40 } }),
    icon: brand.windowIcon(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'home.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false
    }
  });
  win.setMenu(null);
  // Nothing in this window navigates or opens windows; refuse both outright.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => {
    syncDock();   // findable with ⌘Tab while it is open
    bringForward();
  });
  // Closing the window only closes the window: Typd, its menu-bar icon and its key stay
  // (nothing here or in index.js quits on a close). Each step is on its own, so one that
  // fails cannot leave the others undone -- the picker's pause above all, which would
  // leave the key deaf.
  win.on('closed', () => {
    win = null;
    const step = (name, fn) => {
      try { fn(); } catch (err) { console.log('[typd:home] on close, ' + name + ' failed:', (err && err.stack) || err); }
    };
    step('revert', () => revert());                     // a key that was never heard is not kept
    step('pause', () => deps.pauseHotkey(false));       // nor is the picker's pause
    step('dock', () => syncDock());
    debug('window closed; Typd keeps running');
  });
  win.loadFile(PAGE, { query: { section: s, capture: opts.capture ? '1' : '' } });
}

/** Close the window the way its close button does (the CI check in mac.yml uses it). */
function close() {
  if (win && !win.isDestroyed()) win.close();
}

function isOpen() {
  return Boolean(win && !win.isDestroyed());
}

function isFocused() {
  return Boolean(win && !win.isDestroyed() && win.isFocused());
}

/** Something changed that an open window should show: 'history' | 'dictionary' | 'counts'. */
function changed(what) {
  send('home:changed', { what });
}

module.exports = { register, open, close, isOpen, isFocused, heard, changed, setLoginItem, loginItem, syncDock };
