'use strict';

/**
 * Model updates, for every packaged Typd and the developer's own machines: follow the dictation
 * model the developer publishes, without ever making a dictation wait for it.
 *
 * Where it reads the model from (findConfig), in order:
 *   <userData>/model-updates.json   {endpoint, key}: the developer's own machines (a READER_ key
 *                                   from typd-collect/keys.mjs; it can read the model, nothing else)
 *   <resources>/tester.json         tester builds (the file sharing.js reads; development:
 *                                   the repo's tester.json, only with TYPD_TESTER_DEV=1)
 *   neither, in a packaged build    the public routes, with no key (the public beta): the same
 *                                   manifest and files, under the server's public ceilings
 * A key reads /v1/model/manifest and /v1/model/file/; no key, /v1/model/public/manifest and
 * /v1/model/public/file/ (only the live version's files), and no Authorization header is sent.
 * (The public beta's install key, sharing.js, is never used here: it uploads, nothing else.)
 * Run from source with neither file, it is off, as before. TYPD_MODEL_DIR (eval tools, a fixed
 * model folder) and TYPD_NO_MODEL_UPDATE=1 (CI, tests) turn it off.
 *
 * 60 s after launch and every 6 hours it reads the manifest (typd-collect, GET <routes>/manifest);
 * in a packaged build that request also carries the version counts' headers (versionStats.js),
 * keyed or not.
 * If it names a version this machine is not running, its files are downloaded into
 * <userData>/models/<version>.partial/ -- one file at a time, resumable with Range, held to
 * RATE so the connection stays the user's, retried with backoff -- while dictation goes on with
 * the old model. The files are the model, its mmproj and, if model_json names one in
 * "revise_lora", the revise adapter (local.js). Every file is checked against the manifest's
 * size and sha256; then the folder
 * becomes <userData>/models/<version>/ (with model.json and manifest.json written beside the
 * files) and <userData>/models/current.json names it. local.js loads the version current.json
 * names, if its folder is complete; otherwise the bundled model.
 *
 * The switch waits until no dictation or revision is in progress (and none for IDLE_MS), then
 * restarts llama-server (local.switchModel). A file already on this machine with the same
 * sha256 -- the mmproj, which rarely changes, or the bundled model itself -- is copied rather
 * than downloaded. After one good warm start (the server answered and passed its self-test) the
 * previous downloaded version is deleted; the bundled model in the app's resources never is.
 *
 * If the new model does not start, current.json goes back to the previous model and the version
 * is remembered as bad (state.json), not retried until the manifest changes. A switch that
 * crashed the app counts the same: an unconfirmed current.json whose model fails at the next
 * launch is reverted. Too little disk (1.2 x what is left to download) skips the update until
 * the next check. A 429 from the server is retried after its Retry-After, never sooner.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');

const FIRST_CHECK_MS = 60e3;
const CHECK_EVERY_MS = 6 * 3600e3;
const BACKOFF_MIN_MS = 60e3;
const BACKOFF_MAX_MS = 3600e3;
const RATE = 2 * 1024 * 1024;            // bytes a second (~16 Mbit/s): ~10 minutes for the 1.7B model
const IDLE_MS = 5000;                    // no session for this long before the server restarts
const STALL_MS = 60e3;                   // no bytes for a minute: drop the connection, resume later
const SPACE_FACTOR = 1.2;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED = ['manifest.json', 'model.json'];
const ENDPOINT = 'https://typd-collect.mehmetdedeler.com';   // as sharing.js and appUpdate.js

/* ------------------------------------------------------------ on-disk layout */

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function writeAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, text);
  await renameRetry(tmp, file);
}

/** Windows: a virus scanner can hold a file just written for a moment. */
async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return await fsp.rename(from, to); } catch (err) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
}

/** <modelsDir>/current.json: {version, previous, confirmed, manifest}, or null. */
function readCurrent(modelsDir) {
  const c = readJson(path.join(modelsDir, 'current.json'));
  return c && typeof c.version === 'string' && VERSION_RE.test(c.version) ? c : null;
}

/**
 * A downloaded version's folder is complete when its manifest.json and model.json are there and
 * every file has the manifest's size. (Its sha256 was checked before the folder got this name.)
 * Returns that manifest, or null.
 */
function isComplete(dir) {
  const m = readJson(path.join(dir, 'manifest.json'));
  const spec = readJson(path.join(dir, 'model.json'));
  if (!m || checkManifest(m) || !spec) return null;
  const names = m.files.map((f) => f.name);
  if (!names.includes(spec.model) || !names.includes(spec.mmproj)) return null;
  if (spec.revise_lora != null && !names.includes(spec.revise_lora)) return null;
  for (const f of m.files) {
    try { if (fs.statSync(path.join(dir, f.name)).size !== f.size) return null; } catch { return null; }
  }
  return m;
}

/** The downloaded model local.js should load: {dir, version}, or null for the bundled one. */
function activeModel(modelsDir) {
  const c = readCurrent(modelsDir);
  if (!c) return null;
  const dir = path.join(modelsDir, c.version);
  return isComplete(dir) ? { dir, version: c.version } : null;
}

/** null if `m` is a manifest this app can follow, else what is wrong (the Worker's own rules). */
function checkManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'not an object';
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) return 'bad version';
  if (!Array.isArray(m.files) || m.files.length < 1 || m.files.length > 8) return 'bad files';
  const names = new Set();
  for (const f of m.files) {
    if (!f || typeof f.name !== 'string' || !FILE_RE.test(f.name) || RESERVED.includes(f.name) || names.has(f.name)) return 'bad file name';
    if (!Number.isSafeInteger(f.size) || f.size < 1) return 'bad size';
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return 'bad sha256';
    names.add(f.name);
  }
  const mj = m.model_json;
  if (!mj || typeof mj !== 'object' || Array.isArray(mj) || !names.has(mj.model) || !names.has(mj.mmproj)) return 'bad model_json';
  // The revise adapter, when there is one, is one more of the version's files (local.js loads it).
  if (mj.revise_lora != null && (!names.has(mj.revise_lora) || mj.revise_lora === mj.model || mj.revise_lora === mj.mmproj)) return 'bad model_json';
  if (m.min_app !== undefined && (typeof m.min_app !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.min_app))) return 'bad min_app';
  return null;
}

/** '0.1.0' older than '0.2.0'? Anything unreadable counts as current. */
function older(a, b) {
  const pa = String(a || '').split('.').map(Number), pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x !== y) return x < y;
  }
  return false;
}

/** typd-dictate-1.7b-r24_1p7b-q4_k_m.gguf -> r24_1p7b: what the tray calls a bundled model. */
function labelOf(modelFile) {
  const base = path.basename(String(modelFile || '')).replace(/\.gguf$/i, '');
  return base.replace(/^typd-dictate-/, '').replace(/^\d+(\.\d+)?b-/, '').replace(/-q\d[\w]*$/i, '') || base || 'unknown';
}

/**
 * The exact version of the model in the folder `dir`, for the data a dictation carries and the
 * update checks' version counts (collect.js, versionStats.js):
 *   a downloaded version         its name, as current.json and the manifest give it (`version`)
 *   any other folder (bundled)   model.json "version" if it names one; else the published version
 *                                the updater found the bundled files to be (state.json "bundled");
 *                                else a label from the file names -- r24_1p7b, plus "+<adapter>"
 *                                when model.json adds a revise adapter (never a published name,
 *                                which cannot hold "+")
 */
function versionOf(dir, { version = null, modelsDir = null } = {}) {
  if (version && VERSION_RE.test(version)) return version;
  const spec = dir ? readJson(path.join(dir, 'model.json')) : null;
  if (!spec || typeof spec.model !== 'string') return 'unknown';
  if (typeof spec.version === 'string' && VERSION_RE.test(spec.version)) return spec.version;
  const s = modelsDir ? readJson(path.join(modelsDir, 'state.json')) : null;
  if (s && s.bundled && s.bundled.model === spec.model && VERSION_RE.test(String(s.bundled.version))) return s.bundled.version;
  const label = labelOf(spec.model);
  return (spec.revise && typeof spec.revise_lora === 'string' && spec.revise_lora ? label + '+' + labelOf(spec.revise_lora) : label).slice(0, 64);
}

/** The version the updater has active: current.json's, if its folder is complete; else the bundled model's. */
function activeVersion(modelsDir, bundledDir) {
  const a = modelsDir ? activeModel(modelsDir) : null;
  return a ? a.version : versionOf(bundledDir, { modelsDir });
}

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) h.update(chunk);
  return h.digest('hex');
}

function readConfig(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!c || typeof c.key !== 'string' || c.key.length < 16) return null;
    const url = new URL(c.endpoint);
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !local) return null;
    return { endpoint: url.href.replace(/\/+$/, ''), key: c.key };
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- the updater */

class Retry extends Error {
  constructor(message, after) { super(message); this.after = after; }
}

/**
 * Electron-free, so tests and typd-collect/models.test.mjs drive it directly.
 *
 *   config        {endpoint, key}: the keyed routes; {endpoint, key: null}: the public ones, no
 *                 Authorization header; or null: then it never touches the network (startup guard only)
 *   modelsDir     <userData>/models
 *   bundledDir    the model shipped with the app (never modified)
 *   busy          () => boolean: a dictation or revision is in progress
 *   switchModel   () => Promise: restart the server on what current.json now names; rejects
 *                 if it does not come up and pass its self-test
 *   stats         () => headers for the manifest check: the version counts' app version, model
 *                 version, OS and anonymous install id (versionStats.js), or {} -- a source run,
 *                 TYPD_NO_APP_UPDATE=1. Never sent with a file download.
 */
function createUpdater({
  config, modelsDir, bundledDir, appVersion = '0.0.0', fetch = globalThis.fetch, busy = () => false,
  switchModel = async () => {}, log = () => {}, online = () => true, statfs = (p) => fsp.statfs(p),
  rate = RATE, idleMs = IDLE_MS, firstCheckMs = FIRST_CHECK_MS, everyMs = CHECK_EVERY_MS, stats = () => ({})
}) {
  const stateFile = path.join(modelsDir, 'state.json');
  const dirOf = (v) => path.join(modelsDir, v);
  let state = 'idle';             // what line() says: idle, current, downloading, ready, failed, app, space, stopped, none
  let progress = { done: 0, total: 0 };
  let target = null;              // the version being fetched or switched to
  let running = null;
  let switching = false;
  let failures = 0;
  let revoked = false;
  let timer = null;
  let notBefore = 0;              // a 429's Retry-After: no request before this
  const listeners = [];
  let lastLine = null;

  const readState = () => readJson(stateFile) || {};
  const writeState = (s) => writeAtomic(stateFile, JSON.stringify(s, null, 1));

  function changed() {
    const l = line();
    if (l === lastLine) return;
    lastLine = l;
    for (const fn of listeners) { try { fn(l); } catch { /* a listener's problem */ } }
  }
  function set(s, extra = {}) { state = s; changed(); return { state: s, ...extra }; }
  // Bytes arrive in small chunks; the tray line only changes with the whole percent.
  let lastPct = -1;
  function progressed() {
    const pct = progress.total ? Math.floor((100 * progress.done) / progress.total) : 0;
    if (pct !== lastPct) { lastPct = pct; changed(); }
  }

  /* ------------------------------------------------- what this machine runs */

  function bundledSpec() { return readJson(path.join(bundledDir, 'model.json')); }

  /** sha256 of a file we did not download, cached by path, size and mtime (state.json). */
  async function knownSha(file) {
    let st;
    try { st = await fsp.stat(file); } catch { return null; }
    const s = readState();
    const c = s.hashes && s.hashes[file];
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.sha256;
    const sha = await sha256File(file);
    const fresh = readState();
    fresh.hashes = { ...(fresh.hashes || {}), [file]: { size: st.size, mtimeMs: st.mtimeMs, sha256: sha } };
    await writeState(fresh);
    return sha;
  }

  /** Is the bundled model exactly this manifest's? (After an app update it may be.) */
  async function bundledIs(m) {
    const spec = bundledSpec();
    if (!spec || spec.model !== m.model_json.model || spec.mmproj !== m.model_json.mmproj) return false;
    if ((spec.revise_lora || null) !== (m.model_json.revise_lora || null)) return false;   // same weights, adapter added or dropped
    for (const f of m.files) {
      const p = path.join(bundledDir, f.name);
      try { if ((await fsp.stat(p)).size !== f.size) return false; } catch { return false; }
    }
    for (const f of m.files) if ((await knownSha(path.join(bundledDir, f.name))) !== f.sha256) return false;
    return true;
  }

  /** The version the tray names: the downloaded one, else the bundled one's. */
  function activeLabel() {
    const a = activeModel(modelsDir);
    if (a) return a.version;
    const spec = bundledSpec();
    const s = readState();
    if (spec && s.bundled && s.bundled.model === spec.model) return s.bundled.version;
    return labelOf(spec && spec.model);
  }

  /**
   * Delete every downloaded version but `keep`, and every partial download but the one in
   * progress (`target`'s). Never the bundled model: it is not in modelsDir.
   */
  async function tidy(keep) {
    let names = [];
    try { names = await fsp.readdir(modelsDir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (!e.isDirectory()) continue;
      const v = e.name.replace(/\.partial$/, '');
      if (!VERSION_RE.test(v) || e.name === keep || (target && e.name === target + '.partial')) continue;
      await fsp.rm(path.join(modelsDir, e.name), { recursive: true, force: true }).then(
        () => log('deleted', e.name),
        (err) => log('could not delete', e.name, err && err.message));   // still open: next time
    }
  }

  /* ------------------------------------------------------------ the network */

  // A key reads the keyed routes; a packaged build without one, the public routes (findConfig).
  const routes = () => config.endpoint + (config.key ? '/v1/model' : '/v1/model/public');
  const auth = () => (config.key ? { Authorization: 'Bearer ' + config.key } : {});

  function retryAfter(res) {
    const s = Number(res.headers.get('retry-after'));
    return Number.isFinite(s) && s > 0 ? Math.min(s, 86400) * 1000 : null;
  }

  async function refused(res, what) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 401) { revoked = true; throw new Error('key refused'); }
    if (res.status === 429) throw new Retry(what + ': the server is busy (429)', retryAfter(res) || everyMs);
    throw new Retry(what + ': HTTP ' + res.status);
  }

  let windowAt = 0, windowBytes = 0;
  async function throttle(n) {
    if (!rate) return;
    const now = Date.now();
    if (now - windowAt > 10e3) { windowAt = now; windowBytes = 0; }
    windowBytes += n;
    const ahead = (windowBytes / rate) * 1000 - (now - windowAt);
    if (ahead > 5) await new Promise((r) => setTimeout(r, ahead));
  }

  /** One file into `file`, resuming from what is already there. */
  async function download(version, f, file) {
    let have = 0;
    try { have = (await fsp.stat(file)).size; } catch { /* not started */ }
    if (have > f.size) { await fsp.rm(file, { force: true }); have = 0; }
    if (have === f.size) return;
    const ctrl = new AbortController();
    let stall;
    const arm = () => { clearTimeout(stall); stall = setTimeout(() => ctrl.abort(), STALL_MS); };
    arm();
    try {
      const headers = auth();
      if (have) headers.Range = `bytes=${have}-`;
      const url = `${routes()}/file/${encodeURIComponent(version)}/${encodeURIComponent(f.name)}`;
      const res = await fetch(url, { headers, signal: ctrl.signal });
      if (res.status === 416) {
        // What we hold is not a prefix of this file (it ends past it): start over.
        await res.body?.cancel().catch(() => {});
        await fsp.rm(file, { force: true });
        throw new Retry(f.name + ': range refused; starting over', 1000);
      }
      if (res.status !== 200 && res.status !== 206) await refused(res, f.name);
      if (res.status === 206) {
        const m = /^bytes (\d+)-/.exec(res.headers.get('content-range') || '');
        if (!m || Number(m[1]) !== have) { await res.body?.cancel().catch(() => {}); await fsp.rm(file, { force: true }); throw new Retry(f.name + ': unexpected Content-Range', 1000); }
      } else if (have) {
        have = 0;   // the server sent the whole file; write it from the start
      }
      progress.done -= (await fsp.stat(file).then((s) => s.size, () => 0)) - have;
      const out = fs.createWriteStream(file, { flags: have ? 'a' : 'w' });
      const closed = once(out, 'close').catch(() => {});
      try {
        for await (const chunk of res.body) {
          arm();
          have += chunk.length;
          if (have > f.size) throw new Error(f.name + ': more bytes than the manifest says');
          if (!out.write(chunk)) await once(out, 'drain');
          progress.done += chunk.length;
          progressed();
          await throttle(chunk.length);
        }
      } finally {
        out.end();
        await closed;
      }
      if (have !== f.size) throw new Retry(f.name + ': the download ended early');
    } catch (err) {
      if (err instanceof Retry || revoked) throw err;
      throw new Retry(f.name + ': ' + (ctrl.signal.aborted ? 'stalled' : (err && err.message) || err));
    } finally {
      clearTimeout(stall);
    }
  }

  /** A copy of this file already on the machine (the mmproj, usually), if its sha256 matches. */
  async function localCopy(f) {
    const places = [];
    const a = activeModel(modelsDir);
    if (a) places.push(path.join(a.dir, f.name));
    if (bundledDir) places.push(path.join(bundledDir, f.name));
    for (const p of places) {
      try { if ((await fsp.stat(p)).size !== f.size) continue; } catch { continue; }
      const known = a && p.startsWith(a.dir) ? (isComplete(a.dir).files.find((x) => x.name === f.name) || {}).sha256 : await knownSha(p);
      if (known === f.sha256) return p;
    }
    return null;
  }

  /** Every file of `m` into <version>.partial/, checked; then the folder takes the version's name. */
  async function fetchVersion(m, tag) {
    const partial = dirOf(m.version) + '.partial';
    await fsp.mkdir(partial, { recursive: true });
    const sizes = await Promise.all(m.files.map((f) => fsp.stat(path.join(partial, f.name)).then((s) => Math.min(s.size, f.size), () => 0)));
    const total = m.files.reduce((s, f) => s + f.size, 0);
    const left = total - sizes.reduce((a, b) => a + b, 0);
    let free = Infinity;
    try { const s = await statfs(modelsDir); free = Number(s.bavail) * Number(s.bsize); } catch { /* unknown: try */ }
    if (free < left * SPACE_FACTOR) {
      log('not enough disk space for', m.version, '- need', Math.round((left * SPACE_FACTOR) / 1e6), 'MB, have', Math.round(free / 1e6));
      throw Object.assign(new Retry('no space', everyMs), { space: true });
    }
    progress = { done: total - left, total };
    set('downloading');
    for (const f of m.files) {
      const file = path.join(partial, f.name);
      const have = await fsp.stat(file).then((s) => s.size, () => 0);
      if (have === 0) {
        const copy = await localCopy(f);
        if (copy) {
          log('copying', f.name, 'from', copy, 'instead of downloading it');
          await fsp.copyFile(copy, file + '.copy', fs.constants.COPYFILE_FICLONE);
          await renameRetry(file + '.copy', file);
          progress.done += f.size;
          progressed();
          continue;
        }
      }
      log('downloading', f.name, have ? `from byte ${have}` : '');
      await download(m.version, f, file);
    }
    for (const f of m.files) {
      const file = path.join(partial, f.name);
      const size = (await fsp.stat(file)).size;
      const sha = size === f.size ? await sha256File(file) : null;
      if (sha !== f.sha256) {
        await fsp.rm(file, { force: true });
        throw new Retry(`${f.name} failed verification (${size} bytes, sha256 ${sha && sha.slice(0, 12)}); downloading it again`);
      }
    }
    await fsp.writeFile(path.join(partial, 'model.json'), JSON.stringify(m.model_json, null, 2) + '\n');
    await fsp.writeFile(path.join(partial, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
    await fsp.rm(dirOf(m.version), { recursive: true, force: true });
    await renameRetry(partial, dirOf(m.version));
    log('verified', m.version, '- every file matches the manifest');
    return tag;
  }

  /* ----------------------------------------------------------------- switch */

  async function waitIdle() {
    let quietSince = busy() ? 0 : Date.now();
    while (!quietSince || Date.now() - quietSince < idleMs) {
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(50, idleMs / 5))));
      if (busy()) quietSince = 0;
      else if (!quietSince) quietSince = Date.now();
    }
  }

  async function writeCurrent(c) {
    if (!c) return fsp.rm(path.join(modelsDir, 'current.json'), { force: true });
    return writeAtomic(path.join(modelsDir, 'current.json'), JSON.stringify(c, null, 1));
  }

  /**
   * Point current.json at `version` (null: the bundled model, which is `label`), restart the
   * server once nothing is being dictated, then confirm or revert.
   */
  async function activate(version, tag, label = version) {
    target = label;
    set('ready');
    await waitIdle();
    const cur = readCurrent(modelsDir);
    const previous = cur && activeModel(modelsDir) ? cur.version : null;
    switching = true;
    try {
      await writeCurrent(version ? { version, previous, confirmed: false, manifest: tag, at: new Date().toISOString() } : null);
      log('switching to', label, 'from', previous || 'the bundled model');
      try {
        await switchModel();
      } catch (err) {
        return await revert(version, previous, tag, label, err);
      }
      await confirm();
      if (!version) { const s = readState(); s.bundled = { version: label, model: (bundledSpec() || {}).model }; await writeState(s); }
      log('now running', label);
      target = null;
      return set('current');
    } finally {
      switching = false;
    }
  }

  async function confirm() {
    const cur = readCurrent(modelsDir);
    if (cur && !cur.confirmed) await writeCurrent({ ...cur, previous: null, confirmed: true });
    await tidy(cur ? cur.version : null);
  }

  async function revert(version, previous, tag, label, err) {
    log('model', label, 'did not start (' + ((err && err.message) || err) + '); back to', previous || 'the bundled model');
    const back = previous && isComplete(dirOf(previous)) ? previous : null;
    await writeCurrent(back ? { version: back, previous: null, confirmed: true, at: new Date().toISOString() } : null);
    const s = readState();
    s.bad = { version: label, manifest: tag || null, why: String((err && err.message) || err).slice(0, 200), at: new Date().toISOString() };
    await writeState(s);
    if (version) await fsp.rm(dirOf(version), { recursive: true, force: true }).catch(() => {});
    target = null;
    try { await switchModel(); } catch (e) { log('the previous model did not start either:', e && e.message); }
    return set('failed');
  }

  /** local.js reports every warm start; the first one after an unfinished switch decides it. */
  function warmed({ ok, version, error } = {}) {
    if (switching) return;
    const cur = readCurrent(modelsDir);
    if (!cur || cur.confirmed || cur.version !== version) return;
    switching = true;
    (ok ? confirm() : revert(cur.version, cur.previous, cur.manifest, cur.version, error || 'failed to start'))
      .catch((e) => log('after warm start:', e && e.message))
      .finally(() => { switching = false; changed(); });
  }

  /* ------------------------------------------------------------------ check */

  async function run() {
    if (!config) return { state: 'off' };
    if (revoked) return set('stopped');
    if (!online()) throw new Retry('offline');
    let res;
    try {
      let extra = {};
      try { extra = stats() || {}; } catch { extra = {}; }   // counting must never stop a check
      res = await fetch(routes() + '/manifest', { headers: { ...extra, ...auth() }, signal: AbortSignal.timeout(30e3) });
    } catch (err) {
      throw new Retry('manifest: ' + ((err && err.message) || err));
    }
    if (res.status === 404) { await res.body?.cancel().catch(() => {}); return set('none'); }
    if (!res.ok) await refused(res, 'manifest');
    const text = await res.text();
    let m;
    try { m = JSON.parse(text); } catch { m = null; }
    const bad = checkManifest(m);
    if (bad) { log('manifest refused:', bad); return set('none'); }
    const tag = crypto.createHash('sha256').update(text).digest('hex');

    const s = readState();
    if (s.bad && s.bad.manifest === tag) return set('failed');
    if (s.bad) { delete s.bad; await writeState(s); }
    if (older(appVersion, m.min_app)) { log(m.version, 'needs Typd', m.min_app); return set('app'); }

    const cur = readCurrent(modelsDir);
    const active = activeModel(modelsDir);
    if (active && active.version === m.version) {
      if (!cur.confirmed) return set('current');   // its first warm start decides (warmed)
      await tidy(m.version);
      return set('current');
    }
    if (await bundledIs(m)) {
      if (!active) {
        target = null;
        if (!s.bundled || s.bundled.version !== m.version) { const t = readState(); t.bundled = { version: m.version, model: m.model_json.model }; await writeState(t); }
        await tidy(null);
        return set('current');
      }
      return activate(null, tag, m.version);   // an app update brought it: no download
    }
    target = m.version;
    if (!isComplete(dirOf(m.version))) {
      await tidy(active && active.version);
      await fetchVersion(m, tag);
    }
    return activate(m.version, tag);
  }

  /** One check, never two at once. Resolves {state, next}: when the next check is due. */
  function check() {
    if (running) return running;
    running = (async () => {
      try {
        const r = await run();
        failures = 0;
        return { ...r, next: everyMs };
      } catch (err) {
        if (revoked) { log('the server refused the key; updates stopped until restart'); return { ...set('stopped'), next: null }; }
        if (!(err instanceof Retry)) log('update error:', (err && err.stack) || err);
        failures++;
        let next = err.after || Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (failures - 1));
        if (!err.after) next = next / 2 + Math.random() * (next / 2);
        next = Math.min(Math.max(next, 1000), err.after ? 86400e3 : everyMs);
        if (/429/.test(err.message)) notBefore = Date.now() + next;
        log((err && err.message) || err, '- next try in', Math.round(next / 1000), 's');
        if (err.space) return { ...set('space'), next };
        if (state === 'downloading' || state === 'ready') set('retrying');
        return { state: 'retry', next, why: err.message };
      }
    })().finally(() => { running = null; });
    return running;
  }

  function schedule(ms) {
    clearTimeout(timer);
    if (ms === null) return;
    timer = setTimeout(async () => schedule((await check()).next), Math.max(ms, notBefore - Date.now(), 0));
    if (timer.unref) timer.unref();
  }

  /** The line under the tray's status: null when updates are off. */
  function line() {
    if (!config) return null;
    const label = activeLabel();
    const pct = progress.total ? Math.floor((100 * progress.done) / progress.total) : 0;
    switch (state) {
      case 'current': return `Model ${label} · up to date`;
      case 'downloading': return `Model ${label} · updating ${pct} %`;
      case 'retrying': return `Model ${label} · updating ${pct} % (paused)`;
      case 'ready': return `Model ${label} · switching to ${target} when idle`;
      case 'failed': return `Model ${label} · update failed`;
      case 'app': return `Model ${label} · update needs a newer Typd`;
      case 'space': return `Model ${label} · update needs more disk space`;
      default: return `Model ${label}`;
    }
  }

  return {
    check,
    warmed,
    line,
    onChange: (fn) => listeners.push(fn),
    /** Launch: first check after FIRST_CHECK_MS, then every 6 hours. */
    start() { if (config) schedule(firstCheckMs); },
    /** Back from sleep or offline: check soon (never before a 429's Retry-After). */
    wake(ms = firstCheckMs) { if (config && !running) schedule(ms); },
    stop() { clearTimeout(timer); timer = null; },
    get state() { return state; }
  };
}

/* ------------------------------------------------------------- the app's instance */

let electron = null;
try {
  const e = require('electron');
  if (e && typeof e === 'object' && e.app) electron = e;   // under plain Node this is a path string
} catch { /* not running in Electron */ }

const debug = (...a) => { if (process.env.TYPD_DEBUG) console.log('[typd:models]', ...a); };
let main = null;

/**
 * What to follow: the developer's own machine's key first, then a tester build's, then -- in a
 * packaged build with neither -- the public routes ({endpoint, key: null}). Run from source with
 * neither, nothing (null), as before. Electron-free, for bench/updates.js:
 *   userData        app.getPath('userData')
 *   packaged        app.isPackaged
 *   resourcesPath   process.resourcesPath (packaged)
 *   repoDir         the checkout (source runs: its tester.json, only with TYPD_TESTER_DEV=1)
 *   env             process.env
 */
function findConfig({ userData, packaged, resourcesPath, repoDir = path.join(__dirname, '..', '..'), env = process.env }) {
  const own = readConfig(path.join(userData, 'model-updates.json'));
  if (own) return own;
  if (!packaged && env.TYPD_TESTER_DEV !== '1') return null;
  const tester = readConfig(packaged ? path.join(resourcesPath, 'tester.json') : path.join(repoDir, 'tester.json'));
  if (tester) return tester;
  return packaged ? { endpoint: ENDPOINT, key: null } : null;
}

/**
 * Called once by src/main/index.js.
 *   bundledDir    local.BUNDLED_DIR
 *   busy          () => boolean: a session is open
 *   switchModel   () => Promise: restart the server on the model current.json names
 *   onWarm        local.onWarm: subscribes to every warm start's outcome
 *   changed       (line) => void: the tray line changed
 */
function start({ bundledDir, busy, switchModel, onWarm, changed }) {
  if (main || !electron || process.env.TYPD_MODEL_DIR) return main;
  if (process.env.TYPD_NO_MODEL_UPDATE === '1') { debug('model updates off: TYPD_NO_MODEL_UPDATE=1'); return main; }
  const { app, powerMonitor, net } = electron;
  const config = findConfig({ userData: app.getPath('userData'), packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  main = createUpdater({
    config,
    modelsDir: path.join(app.getPath('userData'), 'models'),
    bundledDir,
    appVersion: app.getVersion(),
    busy,
    switchModel,
    log: debug,
    online: () => !net || typeof net.isOnline !== 'function' || net.isOnline(),
    // Packaged builds only, and never with TYPD_NO_APP_UPDATE=1 (versionStats.js decides): the
    // developer's own machine runs from source and is never counted.
    stats: () => require('./versionStats').statsHeaders()
  });
  if (onWarm) onWarm((r) => main.warmed(r));
  if (changed) main.onChange(changed);
  if (config) {
    debug('model updates on, from', config.endpoint, config.key ? '(with a key)' : '(public routes, no key)');
    main.start();
    powerMonitor.on('resume', () => main.wake());
  }
  return main;
}

/** For the tray: one line, or null when this build does not follow model updates. */
function line() {
  return main ? main.line() : null;
}

module.exports = { start, line, createUpdater, activeModel, activeVersion, versionOf, readCurrent, isComplete, checkManifest, labelOf, older, sha256File, readConfig, findConfig, ENDPOINT };
