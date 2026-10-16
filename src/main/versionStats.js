'use strict';

/**
 * Version counts: so the developer knows which app and model versions installs are running.
 *
 * A packaged Typd's update checks -- the app manifest (appUpdate.js, every packaged build) and the
 * model manifest (modelUpdate.js, builds that follow model updates) -- carry four headers:
 *
 *   X-Typd-App       this app's version, e.g. 0.2.0
 *   X-Typd-Model     the model version it runs: a published version's name (current.json, e.g.
 *                    r24_1p7b_rev128), else the bundled model's (modelUpdate.versionOf)
 *   X-Typd-OS        platform-arch, e.g. win32-x64
 *   X-Typd-Install   an anonymous install id: 16 random bytes, hex, made here the first time and
 *                    kept in <userData>/install-id.json
 *
 * typd-collect keeps only daily counts of distinct installs per (app, model, OS); the id itself is
 * never stored there, nor any IP (typd-collect/src/versions.js). The id is its own random value:
 * never the sharing key (share.json) or its id, never sent with an upload, a flag or an enrollment,
 * and nothing else about the person goes with it. Only the manifest requests carry it, never a
 * file download.
 *
 * Off -- no header, no id file -- when run from source (`npm start`: the developer's own machine
 * is never counted) and with TYPD_NO_APP_UPDATE=1.
 *
 * The core is Electron-free (bench/versions.js drives it against a fake server).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_FILE = 'install-id.json';
const ID_RE = /^[0-9a-f]{32}$/;
const APP_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** Counted at all? Only a packaged build, and not with TYPD_NO_APP_UPDATE=1. */
function enabled({ isPackaged, env = process.env } = {}) {
  return Boolean(isPackaged) && env.TYPD_NO_APP_UPDATE !== '1';
}

/** <userData>/install-id.json's id, or null when absent or not one. */
function readInstallId(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && ID_RE.test(j.id) ? j.id : null;
  } catch {
    return null;
  }
}

/**
 * The install id, made once: read it, or make a new random one and keep it. Null if it cannot be
 * kept (a new id on every launch would count one install many times, so nothing is sent then).
 */
function installId(file, { now = () => new Date() } = {}) {
  const have = readInstallId(file);
  if (have) return have;
  const id = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ id, created: now().toISOString() }, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    return null;
  }
  return readInstallId(file) === id ? id : null;
}

/** A header value the server accepts: what the model version is, or 'unknown'. */
function cleanModel(v) {
  const s = String(v || '').replace(/[^A-Za-z0-9._+-]/g, '_').slice(0, 64);
  return MODEL_RE.test(s) ? s : 'unknown';
}

/** The four headers, or {} if any part is missing (the server would not count it anyway). */
function headers({ appVersion, modelVersion, platform = process.platform, arch = process.arch, id }) {
  if (!id || !ID_RE.test(id) || !APP_RE.test(String(appVersion || ''))) return {};
  return {
    'X-Typd-App': String(appVersion),
    'X-Typd-Model': cleanModel(modelVersion),
    'X-Typd-OS': `${platform}-${arch}`,
    'X-Typd-Install': id
  };
}

/**
 * () => headers, for the updaters' manifest checks ({} when off).
 *   on            enabled(...)
 *   idFile        <userData>/install-id.json
 *   appVersion    this app's version
 *   modelVersion  () => the model version running now (read at each check: a model update changes it)
 */
function createStats({ on, idFile, appVersion, modelVersion = () => null, platform = process.platform, arch = process.arch }) {
  if (!on) return () => ({});
  let id = null;   // made at the first check, then the same for this run
  return () => {
    if (!id) id = installId(idFile);
    if (!id) return {};
    let model = null;
    try { model = modelVersion(); } catch { model = null; }
    return headers({ appVersion, modelVersion: model, platform, arch, id });
  };
}

/** The same, from Electron's app (and the environment): what the running Typd uses. */
function fromApp(app, { env = process.env, modelVersion } = {}) {
  return createStats({
    on: enabled({ isPackaged: app.isPackaged, env }),
    idFile: path.join(app.getPath('userData'), ID_FILE),
    appVersion: app.getVersion(),
    modelVersion: modelVersion || (() => require('./pipeline/local').modelVersion())
  });
}

/* ------------------------------------------------------------- the app's instance */

let electron = null;
try {
  const e = require('electron');
  if (e && typeof e === 'object' && e.app) electron = e;   // under plain Node this is a path string
} catch { /* not running in Electron */ }

let main = null;

/** The headers for an update check right now: {} unless a packaged build counts (enabled()). */
function statsHeaders() {
  try {
    if (!main) main = electron ? fromApp(electron.app) : () => ({});
    return main();
  } catch {
    return {};
  }
}

module.exports = { statsHeaders, createStats, fromApp, enabled, installId, readInstallId, headers, cleanModel, ID_FILE, ID_RE };
