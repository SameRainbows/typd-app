'use strict';

const { app } = require('electron');

/**
 * Open at login, the macOS way: the system's own login item (SMAppService from
 * macOS 13), which also appears -- and can be switched off -- under System
 * Settings › General › Login Items.
 *
 * Only for the installed app. Run from source, "the app" is Electron itself, and
 * a login item would start a bare Electron with no Typd in it; so there it is
 * refused rather than half done.
 */

const log = (...args) => console.log('[typd:login-item]', ...args);

function supported() {
  return process.platform === 'darwin' && app.isPackaged;
}

function get() {
  if (!supported()) return false;
  try {
    return Boolean(app.getLoginItemSettings().openAtLogin);
  } catch {
    return false;
  }
}

/** True when the change was made. */
function set(on) {
  if (!supported()) {
    log('open at login needs the installed app; running from source, it is left alone');
    return false;
  }
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(on) });
    return true;
  } catch (err) {
    log('cannot change it:', err && err.message);
    return false;
  }
}

/**
 * At launch: add the login item if Settings wants one and it was never
 * registered -- the first run. One the person switched off in System Settings
 * reports another status, and that choice stands.
 */
function sync(wanted) {
  if (!supported() || !wanted) return;
  try {
    const s = app.getLoginItemSettings();
    if (s && s.status === 'not-registered') {
      app.setLoginItemSettings({ openAtLogin: true });
      log('added');
    }
  } catch (err) {
    log('cannot read it:', err && err.message);
  }
}

module.exports = { get, set, sync, supported };
