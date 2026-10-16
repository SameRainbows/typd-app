'use strict';

/**
 * App updates: a packaged Typd keeps itself current, quietly, the way modelUpdate.js keeps its
 * model current. Every packaged build follows them -- tester and public alike; no key is needed,
 * because what is installed is decided by a signature, not by who may download. Run from source
 * (`npm start`), with TYPD_NO_APP_UPDATE=1, or from a place it cannot write (a dmg, App
 * Translocation), it never replaces itself.
 *
 *   1. Check. 2 minutes after launch and every 6 hours, GET <endpoint>/v1/app/manifest
 *      (typd-collect), with the version counts' headers (versionStats.js: app and model version,
 *      OS, an anonymous install id). The answer is {typd_app_update: 1, key, payload, sig}: `payload` is JSON
 *      text and `sig` its Ed25519 signature by the key named `key`, which must be one of
 *      appUpdateKey.js's. Anything else is refused, as is a payload whose `seq` is lower than one
 *      already seen (an old manifest replayed).
 *   2. Decide. payload.version newer than this app (or `downgrade`, which only
 *      publish_app_update.py --activate sets), this app at least `min_version`, a package for this
 *      platform, and not the version that already failed here with this very manifest.
 *   3. Download platforms[<platform>].file into <userData>/app-update/<version>/, resumable with
 *      Range, at the model downloader's 2 MB/s, retried with backoff; then size and sha256 against
 *      the signed manifest. A wrong file is deleted and fetched again.
 *   4. Stage. Unzip (ditto on macOS, tar.exe on Windows) into <version>/staged/. The zip holds
 *      typd-update.json {version, platform, app} and the app (Typd.app, or the Typd folder):
 *      both must match the manifest.
 *   5. Wait until the user is away: no dictation or revision, no Typd window open, for IDLE_MS, and
 *      no keyboard or mouse for SYSTEM_IDLE_S; the model server's first start has settled.
 *   6. Apply. Write pending.json, write the helper script (app-update/helper-mac.sh or
 *      helper-win.ps1) beside it, start it detached, wait until it says it runs, and quit. The
 *      helper waits for Typd (and anything else running from inside it, llama-server) to exit,
 *      carries over from the installed app what the package leaves out (the dictation model, a
 *      tester build's tester.json; on Windows llama.cpp and the uninstaller), swaps the two
 *      (rename the old one to a backup, the new one into place), and starts the new one.
 *   7. Self-test. The new version finds pending.json naming its own version and writes
 *      verdict.json: "started" at once, then "ok" when its window has loaded and its model has
 *      passed the start-up self-test (local.js) -- or "failed". The helper deletes the backup on
 *      "ok" and writes result.json; on "failed", a crash or silence, it puts the old version back,
 *      starts it, and writes result.json "bad". The old version then remembers that version and
 *      manifest (state.json) and does not try them again until the manifest changes.
 *
 * The packages are thin on purpose (scripts/app-update-package.js): the dictation model and the
 * CUDA llama.cpp are most of an installer, and the bucket has 9 GB for everything. So an app update
 * never changes the bundled model: every packaged build gets new models from modelUpdate.js (a public
 * build through the keyless public routes). A Windows package leaves llama.cpp out when it is unchanged
 * and says which tree it needs (`requires`); an install with another one is told to reinstall.
 *
 * Settings, history, dictionary, downloaded models: all in userData, which an update never touches.
 * README.md "App updates" has the whole picture, the publishing side and the tests.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { once } = require('events');

const ENDPOINT = 'https://typd-collect.mehmetdedeler.com';
const DOWNLOAD_PAGE = 'https://typd.mehmetdedeler.com/download/';
const FIRST_CHECK_MS = 2 * 60e3;
const CHECK_EVERY_MS = 6 * 3600e3;
const BACKOFF_MIN_MS = 60e3;
const BACKOFF_MAX_MS = 3600e3;
const RATE = 2 * 1024 * 1024;           // bytes a second: the model downloader's cap (modelUpdate.js)
const IDLE_MS = 10e3;                   // no session and no Typd window for this long
const SYSTEM_IDLE_S = 60;               // and no keyboard or mouse input for this long
const WARM_WAIT_MS = 5 * 60e3;          // the model's first start settles (or this passes) before an apply
const STALL_MS = 60e3;
const SPACE_FACTOR = 4;                 // the zip, what it unpacks to, room to spare
const STARTED_TIMEOUT_S = 120;          // the new version must say it started within this...
const VERDICT_TIMEOUT_S = 600;          // ...and pass its start-up self-test within this
const HELPER_START_MS = 20e3;           // the helper must say it runs before Typd quits
const RESULT_WAIT_MS = 120e3;           // the new version waits this long for the helper's result
const UPDATED_LINE_MS = 24 * 3600e3;    // "Updated to x" stays in the tray this long
const MAX_ABORTS = 3;                   // an update the helper could not apply this often waits for a new manifest

const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PLATFORM_RE = /^(darwin|win32)-(arm64|x64)$/;
const SEG_RE = /^[A-Za-z0-9._ -]{1,100}$/;

/* ----------------------------------------------------------------- helpers */

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
      await sleep(250 * (i + 1));
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

/** -1, 0 or 1: '0.1.0' against '0.2.0'. Both must look like x.y.z. */
function cmp(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  return 0;
}

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) h.update(chunk);
  return h.digest('hex');
}

/** A relative path, '/'-separated, with no '.', '..' or empty segments: what a package may carry. */
function safeRel(s) {
  if (typeof s !== 'string' || s.length > 200) return false;
  const segs = s.split('/');
  return segs.length >= 1 && segs.every((x) => SEG_RE.test(x) && x !== '.' && x !== '..' && x.trim() === x);
}

/**
 * One sha256 for a whole folder: every file's relative path, size and sha256, sorted by path.
 * Packages say which llama.cpp they need with it (scripts/app-update-package.js computes the same).
 */
async function treeHash(root) {
  const lines = [];
  async function walk(rel) {
    const abs = path.join(root, rel);
    const st = await fsp.lstat(abs);
    if (st.isDirectory()) {
      for (const name of await fsp.readdir(abs)) await walk(rel ? rel + '/' + name : name);
    } else if (st.isSymbolicLink()) {
      lines.push(`${rel}\0link\0${await fsp.readlink(abs)}\n`);
    } else if (st.isFile()) {
      lines.push(`${rel}\0${st.size}\0${await sha256File(abs)}\n`);
    }
  }
  await walk('');
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return crypto.createHash('sha256').update(lines.join('')).digest('hex');
}

/* ------------------------------------------------------- the signed manifest */

class Refused extends Error {}
class Retry extends Error {
  constructor(message, after) { super(message); this.after = after; }
}

/** null if `e` is a platform entry this app can follow, else what is wrong. */
function checkPlatform(name, e) {
  if (!PLATFORM_RE.test(name)) return 'unknown platform';
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'not an object';
  if (typeof e.file !== 'string' || !FILE_RE.test(e.file) || !/\.zip$/i.test(e.file)) return 'bad file';
  if (!Number.isSafeInteger(e.size) || e.size < 1) return 'bad size';
  if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) return 'bad sha256';
  if (typeof e.app !== 'string' || !FILE_RE.test(e.app)) return 'bad app';
  if (e.carry !== undefined && (!Array.isArray(e.carry) || e.carry.length > 16 || !e.carry.every(safeRel))) return 'bad carry';
  if (e.requires !== undefined) {
    if (!e.requires || typeof e.requires !== 'object' || Array.isArray(e.requires)) return 'bad requires';
    for (const [p, h] of Object.entries(e.requires)) {
      if (!(e.carry || []).includes(p) || typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) return 'bad requires';
    }
  }
  return null;
}

/** null if `p` (the signed payload) is one this app can follow, else what is wrong. */
function checkPayload(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'not an object';
  if (p.schema !== 1) return 'unknown schema';
  if (!Number.isSafeInteger(p.seq) || p.seq < 1) return 'bad seq';
  if (typeof p.version !== 'string' || !VERSION_RE.test(p.version)) return 'bad version';
  if (p.min_version !== undefined && (typeof p.min_version !== 'string' || !VERSION_RE.test(p.min_version))) return 'bad min_version';
  if (p.downgrade !== undefined && typeof p.downgrade !== 'boolean') return 'bad downgrade';
  if (p.notes !== undefined && (typeof p.notes !== 'string' || p.notes.length > 2000)) return 'bad notes';
  if (!p.platforms || typeof p.platforms !== 'object' || Array.isArray(p.platforms)) return 'bad platforms';
  const names = Object.keys(p.platforms);
  if (names.length < 1 || names.length > 8) return 'bad platforms';
  for (const n of names) {
    const bad = checkPlatform(n, p.platforms[n]);
    if (bad) return n + ': ' + bad;
  }
  return null;
}

/**
 * The manifest as served -> {payload, key}. Throws Refused unless it is signed by one of `keys`
 * ({id: PEM}) and the payload passes checkPayload. Nothing in it is trusted before that.
 */
function verifyManifest(text, keys) {
  let w;
  try { w = JSON.parse(text); } catch { throw new Refused('not JSON'); }
  if (!w || typeof w !== 'object' || w.typd_app_update !== 1 || typeof w.key !== 'string' ||
      typeof w.payload !== 'string' || typeof w.sig !== 'string') throw new Refused('not a signed app manifest');
  if (!Object.prototype.hasOwnProperty.call(keys, w.key)) throw new Refused('signed by an unknown key');
  const sig = Buffer.from(w.sig, 'base64');
  let ok = false;
  if (sig.length === 64 && sig.toString('base64') === w.sig) {
    try { ok = crypto.verify(null, Buffer.from(w.payload, 'utf8'), crypto.createPublicKey(keys[w.key]), sig); } catch { ok = false; }
  }
  if (!ok) throw new Refused('bad signature');
  let p;
  try { p = JSON.parse(w.payload); } catch { throw new Refused('payload is not JSON'); }
  const bad = checkPayload(p);
  if (bad) throw new Refused('payload: ' + bad);
  return { payload: p, key: w.key };
}

/* --------------------------------------------------------- platform tools */

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || '').slice(0, 2000); reject(err); } else resolve(String(stdout));
    });
  });
}

const winSys = (...p) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...p);

/** Unzip `zip` into `dest`: ditto keeps a bundle's symlinks; Windows 10+ has bsdtar, which reads zip. */
async function defaultExtract(zip, dest, platform) {
  await fsp.mkdir(dest, { recursive: true });
  if (platform.startsWith('darwin')) return run('/usr/bin/ditto', ['-x', '-k', zip, dest]);
  try {
    await run(winSys('tar.exe'), ['-x', '-f', zip, '-C', dest]);
  } catch (err) {
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    await run(winSys('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(dest)} -Force`]);
  }
}

/**
 * Start the helper so that it outlives Typd. macOS: its own session. Windows: not `detached` --
 * PowerShell without a console exits at once -- so the helper starts itself again outside the job
 * object Node keeps its children in (helper-win.ps1, step 0).
 */
async function defaultLaunchHelper({ script, dir, platform }) {
  const out = fs.openSync(path.join(dir, 'helper.log'), 'a');
  try {
    const child = platform.startsWith('darwin')
      ? spawn('/bin/sh', [script, dir], { detached: true, stdio: ['ignore', out, out], cwd: dir })
      : spawn(winSys('WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, dir],
        { stdio: ['ignore', out, out], cwd: dir, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return child;
  } finally {
    fs.closeSync(out);
  }
}

/** sh single quotes: the helper sources helper.vars, so nothing in a value is ever run. */
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

/** Where the helper puts the new app while carrying into it, and the old one while the new one proves itself. */
function sidePaths(app, platform) {
  const parent = path.dirname(app);
  if (platform.startsWith('darwin')) {
    const base = path.basename(app, '.app');
    return { newIn: path.join(parent, `.${base}-update-new.app`), old: path.join(parent, `.${base}-update-old.app`), failed: path.join(parent, `.${base}-update-failed.app`) };
  }
  const base = path.basename(app);
  return { newIn: path.join(parent, `${base}.update-new`), old: path.join(parent, `${base}.update-old`), failed: path.join(parent, `${base}.update-failed`) };
}

/* --------------------------------------------------------------- the updater */

/**
 * Electron-free, so bench/app-update.js and typd-collect's test drive it directly.
 *
 *   keys          {id: PEM}: the public keys a manifest may be signed with (appUpdateKey.js)
 *   appVersion    this app's version, x.y.z
 *   platform      'darwin-arm64' | 'darwin-x64' | 'win32-x64'
 *   dir           <userData>/app-update
 *   app           the installed app: the Typd.app bundle, or the folder holding Typd.exe
 *   problem       why this copy cannot replace itself (read-only, translocated), or null
 *   busy          () => boolean: a dictation, a revision or a Typd window is open
 *   systemIdle    () => seconds since the last keyboard or mouse input
 *   warmSettled   () => boolean: the model server's first start has finished, either way
 *   modelOk       () => true | false | null: how that start went
 *   quit          () => void: leave, so the helper can swap
 *   stats         () => headers for the manifest check: the version counts' app version, model
 *                 version, OS and anonymous install id (versionStats.js), or {}. Never sent with a
 *                 package download.
 */
function createAppUpdater(o) {
  const {
    keys, appVersion, platform, dir,
    endpoint = ENDPOINT, app = null, problem = null, fetch = globalThis.fetch,
    rate = RATE, idleMs = IDLE_MS, systemIdleS = SYSTEM_IDLE_S, firstCheckMs = FIRST_CHECK_MS, everyMs = CHECK_EVERY_MS,
    busy = () => false, systemIdle = () => Infinity, warmSettled = () => true, modelOk = () => null,
    extract = defaultExtract, launchHelper = defaultLaunchHelper, quit = () => {},
    log = () => {}, online = () => true, statfs = (p) => fsp.statfs(p),
    helperScript = null, startedTimeoutS = STARTED_TIMEOUT_S, verdictTimeoutS = VERDICT_TIMEOUT_S,
    helperStartMs = HELPER_START_MS, resultWaitMs = RESULT_WAIT_MS, warmWaitMs = WARM_WAIT_MS,
    failVersion = null, reportFile = null, reportExtra = () => ({}), relaunchEnv = null, stats = () => ({})
  } = o;
  const F = {
    state: path.join(dir, 'state.json'),
    pending: path.join(dir, 'pending.json'),
    verdict: path.join(dir, 'verdict.json'),
    result: path.join(dir, 'result.json'),
    started: path.join(dir, 'helper.started')
  };
  const vdir = (v) => path.join(dir, v);
  let state = 'idle';
  let target = null;               // the version being fetched, staged or applied
  let progress = { done: 0, total: 0 };
  let running = null;
  let timer = null;
  let failures = 0;
  let notBefore = 0;
  let stopped = false;
  let postUpdate = null;           // pending.json, when this launch is the first of a new version
  let settled = false;
  const listeners = [];
  const updatedListeners = [];
  let lastLine;

  const readState = () => readJson(F.state) || {};
  const writeState = (s) => writeAtomic(F.state, JSON.stringify(s, null, 1));
  const patchState = async (fn) => { const s = readState(); fn(s); await writeState(s); };

  function changed() {
    const l = JSON.stringify(line());
    if (l !== lastLine) {
      lastLine = l;
      for (const fn of listeners) { try { fn(line()); } catch { /* a listener's problem */ } }
    }
    report();
  }
  function set(s, extra = {}) { state = s; changed(); return { state: s, ...extra }; }
  let lastPct = -1;
  function progressed() {
    const pct = progress.total ? Math.floor((100 * progress.done) / progress.total) : 0;
    if (pct !== lastPct) { lastPct = pct; changed(); }
  }

  /** TYPD_APP_UPDATE_REPORT: a JSON line of where things stand, for the Mac CI's update test. */
  function report() {
    if (!reportFile) return;
    try {
      const s = readState();
      fs.mkdirSync(path.dirname(reportFile), { recursive: true });
      fs.writeFileSync(reportFile + '.tmp', JSON.stringify({
        version: appVersion, state, target, postUpdate: Boolean(postUpdate), settled,
        line: line(), bad: s.bad || null, updated: s.updated || null, pid: process.pid, at: iso(), ...reportExtra()
      }));
      fs.renameSync(reportFile + '.tmp', reportFile);
    } catch { /* a test aid only */ }
  }

  /* ------------------------------------------------------------ the network */

  function retryAfter(res) {
    const s = Number(res.headers.get('retry-after'));
    return Number.isFinite(s) && s > 0 ? Math.min(s, 86400) * 1000 : null;
  }

  async function refused(res, what) {
    await res.body?.cancel().catch(() => {});
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
    if (ahead > 5) await sleep(ahead);
  }

  /** The package into `file`, resuming from what is already there. */
  async function download(version, e, file) {
    let have = 0;
    try { have = (await fsp.stat(file)).size; } catch { /* not started */ }
    if (have > e.size) { await fsp.rm(file, { force: true }); have = 0; }
    progress = { done: have, total: e.size };
    if (have === e.size) return;
    const ctrl = new AbortController();
    let stall;
    const arm = () => { clearTimeout(stall); stall = setTimeout(() => ctrl.abort(), STALL_MS); };
    arm();
    try {
      const headers = {};
      if (have) headers.Range = `bytes=${have}-`;
      const url = `${endpoint}/v1/app/file/${encodeURIComponent(version)}/${encodeURIComponent(e.file)}`;
      const res = await fetch(url, { headers, signal: ctrl.signal });
      if (res.status === 416) {
        await res.body?.cancel().catch(() => {});
        await fsp.rm(file, { force: true });
        throw new Retry(e.file + ': range refused; starting over', 1000);
      }
      if (res.status !== 200 && res.status !== 206) await refused(res, e.file);
      if (res.status === 206) {
        const m = /^bytes (\d+)-/.exec(res.headers.get('content-range') || '');
        if (!m || Number(m[1]) !== have) {
          await res.body?.cancel().catch(() => {});
          await fsp.rm(file, { force: true });
          throw new Retry(e.file + ': unexpected Content-Range', 1000);
        }
      } else if (have) {
        have = 0;   // the whole file came back; write it from the start
        progress.done = 0;
      }
      const out = fs.createWriteStream(file, { flags: have ? 'a' : 'w' });
      const closed = once(out, 'close').catch(() => {});
      try {
        for await (const chunk of res.body) {
          arm();
          have += chunk.length;
          if (have > e.size) throw new Error(e.file + ': more bytes than the manifest says');
          if (!out.write(chunk)) await once(out, 'drain');
          progress.done += chunk.length;
          progressed();
          await throttle(chunk.length);
          if (stopped) throw new Error('stopped');
        }
      } finally {
        out.end();
        await closed;
      }
      if (have !== e.size) throw new Retry(e.file + ': the download ended early');
    } catch (err) {
      if (err instanceof Retry) throw err;
      throw new Retry(e.file + ': ' + (ctrl.signal.aborted ? 'stalled' : (err && err.message) || err));
    } finally {
      clearTimeout(stall);
    }
  }

  /* --------------------------------------------------------------- staging */

  /** <version>/staged/<app>, unzipped from this very package (staged.sha256) and checked, or null. */
  function stagedApp(p, e) {
    const staged = path.join(vdir(p.version), 'staged');
    let from = '';
    try { from = fs.readFileSync(staged + '.sha256', 'utf8').trim(); } catch { return null; }
    if (from !== e.sha256) return null;
    const meta = readJson(path.join(staged, 'typd-update.json'));
    if (!meta || meta.version !== p.version || meta.platform !== platform || meta.app !== e.app) return null;
    const a = path.join(staged, e.app);
    const exe = platform.startsWith('darwin') ? path.join(a, 'Contents', 'Info.plist') : path.join(a, 'Typd.exe');
    return exists(exe) ? a : null;
  }

  /** Download, verify and unzip `p`'s package for this platform; returns the staged app. */
  async function stage(p, e, tag) {
    const already = stagedApp(p, e);
    if (already) return already;
    const vd = vdir(p.version);
    await fsp.mkdir(vd, { recursive: true });
    const zip = path.join(vd, e.file);
    const part = zip + '.partial';
    let have = 0;
    try { have = (await fsp.stat(exists(zip) ? zip : part)).size; } catch { /* nothing yet */ }
    let free = Infinity;
    try { const s = await statfs(dir); free = Number(s.bavail) * Number(s.bsize); } catch { /* unknown: try */ }
    const need = e.size * SPACE_FACTOR - have;
    if (free < need) {
      log('not enough disk space for', p.version, '- need', Math.round(need / 1e6), 'MB, have', Math.round(free / 1e6));
      throw Object.assign(new Retry('no space', everyMs), { space: true });
    }
    if (!exists(zip)) {
      set('downloading');
      log('downloading', e.file, have ? `from byte ${have}` : '', `(${Math.round(e.size / 1e6)} MB)`);
      await download(p.version, e, part);
      const sha = await sha256File(part);
      if (sha !== e.sha256) {
        await fsp.rm(part, { force: true });
        throw new Retry(`${e.file} failed verification (sha256 ${sha.slice(0, 12)}); downloading it again`);
      }
      await renameRetry(part, zip);
      log('verified', e.file, '- size and sha256 match the signed manifest');
    } else {
      // Verified when it got its name; a file changed since is caught here.
      const st = await fsp.stat(zip);
      if (st.size !== e.size || (await sha256File(zip)) !== e.sha256) {
        await fsp.rm(zip, { force: true });
        throw new Retry(e.file + ' changed on disk; downloading it again', 1000);
      }
    }
    const staged = path.join(vd, 'staged');
    const tmp = staged + '.partial';
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.rm(staged, { recursive: true, force: true });
    await fsp.rm(staged + '.sha256', { force: true });
    try {
      await extract(zip, tmp, platform);
    } catch (err) {
      await fsp.rm(tmp, { recursive: true, force: true });
      throw new Retry('unzip failed: ' + ((err && (err.stderr || err.message)) || err).toString().slice(0, 200));
    }
    await renameRetry(tmp, staged);
    await fsp.writeFile(staged + '.sha256', e.sha256);
    const a = stagedApp(p, e);
    if (!a) {
      // A package that is not what its signed manifest says: a publishing mistake. Same as a failed start.
      await fsp.rm(vd, { recursive: true, force: true });
      await remember(p.version, tag, 'the package does not hold Typd ' + p.version + ' for ' + platform);
      throw new Refused('the package does not match its manifest');
    }
    // Nothing downloaded should carry a quarantine mark; the helper removes it again after the move.
    if (platform.startsWith('darwin')) await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', a]).catch(() => {});
    log('staged', p.version, 'at', a);
    return a;
  }

  /** Delete every version folder but `keep`'s. */
  async function tidy(keep) {
    let names = [];
    try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (!e.isDirectory() || e.name === keep || !VERSION_RE.test(e.name)) continue;
      await fsp.rm(path.join(dir, e.name), { recursive: true, force: true }).then(
        () => log('deleted', e.name), (err) => log('could not delete', e.name, err && err.message));
    }
  }

  async function remember(version, tag, why) {
    await patchState((s) => { s.bad = { version, tag, why: String(why).slice(0, 300), at: iso() }; delete s.aborts; });
  }

  /* ------------------------------------------------------------------ apply */

  const idleNow = () => !busy() && systemIdle() >= systemIdleS;

  async function waitIdle() {
    const t0 = Date.now();
    while (!warmSettled() && Date.now() - t0 < warmWaitMs) { await sleep(500); if (stopped) throw new Retry('stopped'); }
    let quietSince = idleNow() ? Date.now() : 0;
    while (!quietSince || Date.now() - quietSince < idleMs) {
      await sleep(Math.min(1000, Math.max(50, idleMs / 5)));
      if (stopped) throw new Retry('stopped');
      if (!idleNow()) quietSince = 0;
      else if (!quietSince) quietSince = Date.now();
    }
  }

  function helperVars(pending) {
    const side = sidePaths(app, platform);
    const env = relaunchEnv || Object.entries(process.env).filter(([k]) => /^TYPD_[A-Z0-9_]+$/.test(k));
    const v = {
      OLD_PID: String(process.pid), APP: app, NEW: pending.newApp, DIR: dir, VERSION: pending.version, FROM: appVersion,
      NEWIN: side.newIn, OLD: side.old, FAILED: side.failed,
      STARTED_TIMEOUT_S: String(startedTimeoutS), VERDICT_TIMEOUT_S: String(verdictTimeoutS),
      CARRY: pending.carry.join('\n'),
      LAUNCH_ENV: env.filter(([, val]) => !/[\r\n]/.test(val)).map(([k, val]) => k + '=' + val).join('\n')
    };
    return v;
  }

  async function apply(p, e, tag, staged) {
    target = p.version;
    set('ready');
    await waitIdle();
    set('applying');
    const pending = {
      version: p.version, from: appVersion, tag, platform, app, newApp: staged, carry: e.carry || [],
      sides: sidePaths(app, platform), modelOk: modelOk(), pid: process.pid, at: iso()
    };
    for (const f of [F.verdict, F.result, F.started]) await fsp.rm(f, { force: true });
    await writeAtomic(F.pending, JSON.stringify(pending, null, 1));
    const mac = platform.startsWith('darwin');
    const scriptName = mac ? 'helper.sh' : 'helper.ps1';
    const script = path.join(dir, scriptName);
    const source = helperScript || path.join(__dirname, 'app-update', mac ? 'helper-mac.sh' : 'helper-win.ps1');
    await fsp.writeFile(script, fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, mac ? '\n' : '\r\n'));
    const vars = helperVars(pending);
    if (mac) await fsp.writeFile(path.join(dir, 'helper.vars'), Object.entries(vars).map(([k, v]) => `${k}=${shq(v)}`).join('\n') + '\n');
    else await fsp.writeFile(path.join(dir, 'helper.json'), JSON.stringify(vars, null, 1));
    const child = await launchHelper({ script, dir, platform });
    const t0 = Date.now();
    while (!exists(F.started) && Date.now() - t0 < helperStartMs) await sleep(100);
    if (!exists(F.started)) {
      try { child && child.kill && child.kill(); } catch { /* gone */ }
      await fsp.rm(F.pending, { force: true });
      await countAbort(p.version, tag, 'the update helper did not start');
      throw new Retry('the update helper did not start');
    }
    log('the helper runs; quitting so it can install', p.version);
    quit();
    return set('applying');
  }

  async function countAbort(version, tag, why) {
    let n = 0;
    await patchState((s) => {
      const a = s.aborts && s.aborts.tag === tag ? s.aborts : { version, tag, n: 0 };
      a.n += 1; a.why = String(why).slice(0, 300); a.at = iso();
      n = a.n;
      s.aborts = a;
    });
    if (n >= MAX_ABORTS) await remember(version, tag, `could not be installed ${n} times: ${why}`);
  }

  /* ------------------------------------------------------------------ check */

  async function run() {
    if (stopped) return { state: 'off' };
    if (!online()) throw new Retry('offline');
    let res;
    try {
      let headers = {};
      try { headers = stats() || {}; } catch { headers = {}; }   // counting must never stop a check
      res = await fetch(endpoint + '/v1/app/manifest', { headers, signal: AbortSignal.timeout(30e3) });
    } catch (err) {
      throw new Retry('manifest: ' + ((err && err.message) || err));
    }
    if (res.status === 404) { await res.body?.cancel().catch(() => {}); return set('none'); }
    if (!res.ok) await refused(res, 'manifest');
    const text = await res.text();
    let p;
    try {
      p = verifyManifest(text, keys).payload;
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      log('manifest refused:', err.message);
      return set('refused', { why: err.message });
    }
    const s = readState();
    if (Number.isSafeInteger(s.seq) && p.seq < s.seq) {
      log('manifest refused: seq', p.seq, 'is older than', s.seq, 'already seen');
      return set('refused', { why: 'an older manifest than one already seen' });
    }
    if (s.seq !== p.seq) await patchState((x) => { x.seq = p.seq; });
    const tag = crypto.createHash('sha256').update(text).digest('hex');

    const e = p.platforms[platform];
    const c = cmp(p.version, appVersion);
    if (c === 0 || (c < 0 && !p.downgrade)) {
      target = null;
      await tidy(null);
      return set(state === 'updated' ? 'updated' : 'current');
    }
    if (!e) { log('no', platform, 'package in', p.version); return set('none'); }
    target = p.version;
    if (p.min_version && cmp(appVersion, p.min_version) < 0) { log(p.version, 'needs Typd', p.min_version, 'or newer to update itself'); return set('reinstall'); }
    if (s.bad && s.bad.tag === tag) return set('failed');
    if (s.bad) await patchState((x) => { delete x.bad; });
    if (problem) { log('cannot update in place:', problem); return set('manual'); }
    for (const [rel, want] of Object.entries(e.requires || {})) {
      const have = await treeHash(path.join(app, ...rel.split('/'))).catch(() => null);
      if (have !== want) { log(p.version, 'needs another', rel, 'than this install has; reinstall'); return set('reinstall'); }
    }
    await tidy(p.version);
    const staged = await stage(p, e, tag);
    return apply(p, e, tag, staged);
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
        if (err instanceof Refused) { log('update refused:', err.message); return { ...set('failed'), next: everyMs }; }
        if (!(err instanceof Retry)) log('update error:', (err && err.stack) || err);
        failures++;
        let next = err.after || Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (failures - 1));
        if (!err.after) next = next / 2 + Math.random() * (next / 2);
        next = Math.min(Math.max(next, 1000), err.after ? 86400e3 : everyMs);
        if (/429/.test(err.message)) notBefore = Date.now() + next;
        log((err && err.message) || err, '- next try in', Math.round(next / 1000), 's');
        if (err.space) return { ...set('space'), next };
        if (['downloading', 'ready', 'applying'].includes(state)) set('retrying');
        return { state: 'retry', next, why: err.message };
      }
    })().finally(() => { running = null; });
    return running;
  }

  function schedule(ms) {
    clearTimeout(timer);
    if (ms === null || stopped) return;
    timer = setTimeout(async () => schedule((await check()).next), Math.max(ms, notBefore - Date.now(), 0));
    if (timer.unref) timer.unref();
  }

  /* --------------------------------------------------- after the swap, either way */

  function writeVerdict(v, why) {
    try {
      fs.writeFileSync(F.verdict + '.tmp', JSON.stringify({ version: appVersion, state: v, pid: process.pid, why: why ? String(why).replace(/[\r\n"\\]/g, ' ').slice(0, 200) : '' }) + '\n');
      fs.renameSync(F.verdict + '.tmp', F.verdict);
    } catch (err) { log('could not write the verdict:', err && err.message); }
  }

  /** Is the helper that started this version still waiting for its verdict? (helper.started holds its pid) */
  function helperAlive() {
    const pid = Number(String(fs.existsSync(F.started) ? fs.readFileSync(F.started, 'utf8') : '').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
  }

  /** Carried folders the helper did not put back (it was killed halfway): back into this app. */
  function recoverCarry(pending) {
    if (!app || !pending || !Array.isArray(pending.carry)) return;
    const places = [pending.sides && pending.sides.newIn, pending.sides && pending.sides.failed, pending.newApp].filter(Boolean);
    for (const rel of pending.carry) {
      if (!safeRel(rel)) continue;
      const mine = path.join(app, ...rel.split('/'));
      if (exists(mine)) continue;
      for (const place of places) {
        const there = path.join(place, ...rel.split('/'));
        if (!exists(there)) continue;
        try { fs.mkdirSync(path.dirname(mine), { recursive: true }); fs.renameSync(there, mine); log('recovered', rel, 'from', place); break; } catch (err) { log('could not recover', rel, err && err.message); }
      }
    }
  }

  async function finishUpdated(pending) {
    await patchState((s) => { s.updated = { from: pending.from, to: appVersion, at: iso() }; delete s.bad; delete s.aborts; });
    for (const f of [F.pending, F.verdict, F.result, F.started]) await fsp.rm(f, { force: true });
    if (pending.sides && pending.sides.old && exists(pending.sides.old)) await fsp.rm(pending.sides.old, { recursive: true, force: true }).catch(() => {});
    await tidy(null);
    postUpdate = null;
    log('updated from', pending.from, 'to', appVersion);
    set('updated');
    for (const fn of updatedListeners) { try { fn({ from: pending.from, to: appVersion }); } catch { /* a listener's problem */ } }
  }

  /**
   * Call once, first thing at launch. Returns {postUpdate}: true when this is the first start of a
   * version just installed (its self-test decides; see settle()).
   */
  function startup() {
    const pending = readJson(F.pending);
    const result = readJson(F.result);
    const s = readState();
    if (s.updated && Date.now() - Date.parse(s.updated.at) < UPDATED_LINE_MS && s.updated.to === appVersion) state = 'updated';
    if (pending && pending.version === appVersion) {
      if (result && result.version === appVersion && result.outcome === 'ok') {
        finishUpdated(pending).catch((err) => log('after the update:', err && err.message));
        return { postUpdate: false };
      }
      postUpdate = pending;
      writeVerdict('started');
      log('first start of', appVersion, 'after an update from', pending.from, '- self-test decides');
      report();
      return { postUpdate: true };
    }
    if (pending) {
      // Still the version the update tried to leave: the new one failed, or the helper gave up.
      const r = result && result.version === pending.version ? result : { outcome: 'aborted', why: 'the update did not finish' };
      recoverCarry(pending);
      (async () => {
        if (r.outcome === 'bad') {
          log('the update to', pending.version, 'was undone:', r.why);
          await remember(pending.version, pending.tag, r.why || 'failed its start-up self-test');
          await fsp.rm(vdir(pending.version), { recursive: true, force: true }).catch(() => {});
          target = pending.version;
          set('failed');
        } else {
          log('the update to', pending.version, 'did not happen:', r.why);
          await countAbort(pending.version, pending.tag, r.why || 'aborted');
          await fsp.rm(path.join(vdir(pending.version), 'staged'), { recursive: true, force: true }).catch(() => {});
          const bad = readState().bad;
          if (bad && bad.tag === pending.tag) { target = pending.version; set('failed'); } else set('idle');
        }
        for (const f of [F.pending, F.verdict, F.result, F.started]) await fsp.rm(f, { force: true });
      })().catch((err) => log('after the update attempt:', err && err.message));
      return { postUpdate: false };
    }
    for (const f of [F.verdict, F.result, F.started]) fs.rmSync(f, { force: true });
    report();
    return { postUpdate: false };
  }

  /**
   * The first start of a new version has a verdict: `ok` when its window loaded and, if the model
   * was working before the update (pending.modelOk), the model passed its self-test here too. A
   * model that was already failing does not hold an update back: the update may be the fix.
   * The helper acts on the verdict. Resolves 'ok' once the helper has deleted the backup, or
   * 'failed' (the caller quits, and the helper puts the old version back).
   */
  async function settle({ windowOk = true, modelOk: modelNow = true, why = '' } = {}) {
    if (!postUpdate || settled) return null;
    settled = true;
    let ok = Boolean(windowOk) && (Boolean(modelNow) || postUpdate.modelOk !== true);
    if (!windowOk) why = why || 'the window did not load';
    else if (!ok) why = why || 'the dictation model failed its self-test';
    if (failVersion && failVersion === appVersion) { ok = false; why = 'TYPD_APP_UPDATE_SELFTEST_FAIL'; }
    writeVerdict(ok ? 'ok' : 'failed', why);
    report();
    const pending = postUpdate;
    if (!ok && !helperAlive()) {
      // The helper is gone (the computer was shut down mid-update, say): quitting would leave no
      // Typd at all, at every launch. Stay, as after any model failure (the tray says so).
      log('this version failed its start-up self-test:', why, '- but no helper is waiting to put the old one back; staying');
      await finishUpdated(pending);
      return 'kept';
    }
    if (!ok) { log('this version failed its start-up self-test:', why, '- the helper puts the old one back'); return 'failed'; }
    const t0 = Date.now();
    while (Date.now() - t0 < resultWaitMs) {
      const r = readJson(F.result);
      if (r && r.version === appVersion) break;
      await sleep(250);
    }
    await finishUpdated(pending);
    return 'ok';
  }

  /** The tray's line: {label, action} or null. action: 'download' opens the download page. */
  function line() {
    const v = target;
    const pct = progress.total ? Math.floor((100 * progress.done) / progress.total) : 0;
    switch (state) {
      case 'downloading': return { label: `Typd ${v} · downloading ${pct} %` };
      case 'retrying': return { label: `Typd ${v} · downloading ${pct} % (paused)` };
      case 'ready': return { label: `Typd ${v} · installs when you step away` };
      case 'applying': return { label: `Typd ${v} · installing…` };
      case 'failed': return v ? { label: `Typd ${v} didn't start · still on ${appVersion}` } : null;
      case 'reinstall': return { label: `Typd ${v} is out · reinstall to update`, action: 'download' };
      case 'manual': return { label: `Typd ${v} is out · can't update itself here`, action: 'download' };
      case 'space': return { label: `Typd ${v} · update needs more disk space` };
      case 'updated': {
        const u = readState().updated;
        return u && u.to === appVersion && Date.now() - Date.parse(u.at) < UPDATED_LINE_MS ? { label: `Updated to ${appVersion}` } : null;
      }
      default: return null;
    }
  }

  return {
    check,
    startup,
    settle,
    line,
    onChange: (fn) => listeners.push(fn),
    onUpdated: (fn) => updatedListeners.push(fn),
    /** Launch: the first check after FIRST_CHECK_MS, then every 6 hours. */
    start() { stopped = false; schedule(firstCheckMs); },
    /** Back from sleep or offline: check soon (never before a 429's Retry-After). */
    wake(ms = firstCheckMs) { if (!running) schedule(ms); },
    stop() { stopped = true; clearTimeout(timer); timer = null; },
    report,
    get state() { return state; },
    get postUpdate() { return Boolean(postUpdate); }
  };
}

/* ------------------------------------------------------------- the app's instance */

let electron = null;
try {
  const e = require('electron');
  if (e && typeof e === 'object' && e.app) electron = e;   // under plain Node this is a path string
} catch { /* not running in Electron */ }

const debug = (...a) => { if (process.env.TYPD_DEBUG) console.log('[typd:app-update]', ...a); };
let main = null;

/** The installed app and whether it can replace itself: {app, problem}. */
function installation(app) {
  const exe = process.execPath;
  if (process.platform === 'darwin') {
    const bundle = path.resolve(exe, '..', '..', '..');
    if (!/\.app$/i.test(bundle)) return { app: null, problem: 'not inside an app bundle' };
    if (bundle.includes('/AppTranslocation/')) return { app: bundle, problem: 'App Translocation: move Typd to Applications' };
    if (bundle.startsWith('/Volumes/') && !writable(path.dirname(bundle))) return { app: bundle, problem: 'running from a disk image' };
    if (!writable(path.dirname(bundle)) || !writable(path.join(bundle, 'Contents', 'Resources'))) return { app: bundle, problem: 'no permission to write ' + path.dirname(bundle) };
    return { app: bundle, problem: null };
  }
  if (process.platform === 'win32') {
    const folder = path.dirname(exe);
    if (!writable(path.dirname(folder)) || !writable(path.join(folder, 'resources'))) return { app: folder, problem: 'no permission to write ' + path.dirname(folder) };
    return { app: folder, problem: null };
  }
  return { app: null, problem: 'unsupported platform' };
}

function writable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); } catch { return false; }
  if (process.platform !== 'win32') return true;
  // Windows: W_OK only reads the read-only flag; Program Files says yes and then refuses.
  const probe = path.join(dir, '.typd-write-test-' + process.pid);
  try { fs.writeFileSync(probe, ''); fs.rmSync(probe, { force: true }); return true; } catch { return false; }
}

function endpointFromEnv() {
  const raw = process.env.TYPD_APP_UPDATE_URL;
  if (!raw) return ENDPOINT;
  try {
    const u = new URL(raw);
    const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
    if (u.protocol === 'https:' || local) return u.href.replace(/\/+$/, '');
  } catch { /* fall through */ }
  debug('TYPD_APP_UPDATE_URL ignored (https, or http on localhost only)');
  return ENDPOINT;
}

const envMs = (name, d) => { const n = Number(process.env[name]); return process.env[name] !== undefined && Number.isFinite(n) && n >= 0 ? n : d; };

/**
 * Called once by src/main/index.js, first thing when ready. Returns the updater, or null when this
 * copy never updates itself (run from source, TYPD_NO_APP_UPDATE=1).
 *   busy          () => boolean: a session is open, or a Typd window or dialog is on screen
 *   onWarm        local.onWarm: every model start's outcome
 *   changed       () => void: the tray line changed
 *   quit          () => void: leave for the update (the helper waits for this process to end)
 *   reportExtra   () => object: what the CI's report adds (windows, dock)
 */
function start({ busy, onWarm, changed, quit, reportExtra }) {
  if (main || !electron) return main;
  const { app, powerMonitor, net } = electron;
  if (!app.isPackaged) { debug('off: run from source'); return null; }   // never: from source the "app" would be node_modules/electron
  if (process.env.TYPD_NO_APP_UPDATE === '1') { debug('off: TYPD_NO_APP_UPDATE=1'); return null; }
  const where = installation(app);
  let warm = null;   // the first model start: {ok}
  if (onWarm) onWarm((r) => { if (!warm) warm = r; });
  main = createAppUpdater({
    keys: require('./appUpdateKey').keys,
    appVersion: app.getVersion(),
    platform: `${process.platform}-${process.arch}`,
    dir: path.join(app.getPath('userData'), 'app-update'),
    endpoint: endpointFromEnv(),
    app: where.app,
    problem: where.problem,
    rate: envMs('TYPD_APP_UPDATE_RATE', RATE),
    idleMs: envMs('TYPD_APP_UPDATE_IDLE_MS', IDLE_MS),
    systemIdleS: envMs('TYPD_APP_UPDATE_SYSTEM_IDLE_S', SYSTEM_IDLE_S),
    firstCheckMs: envMs('TYPD_APP_UPDATE_FIRST_MS', FIRST_CHECK_MS),
    everyMs: envMs('TYPD_APP_UPDATE_EVERY_MS', CHECK_EVERY_MS),
    busy,
    systemIdle: () => { try { return powerMonitor.getSystemIdleTime(); } catch { return Infinity; } },
    warmSettled: () => Boolean(warm),
    modelOk: () => (warm ? Boolean(warm.ok) : null),
    quit,
    log: debug,
    online: () => !net || typeof net.isOnline !== 'function' || net.isOnline(),
    failVersion: process.env.TYPD_APP_UPDATE_SELFTEST_FAIL || null,
    reportFile: process.env.TYPD_APP_UPDATE_REPORT || null,
    reportExtra,
    stats: () => require('./versionStats').statsHeaders()
  });
  if (changed) main.onChange(changed);
  const s = main.startup();
  debug('app updates on:', main.line() ? main.line().label : 'nothing to say', where.problem ? '(cannot install here: ' + where.problem + ')' : '', 'from', endpointFromEnv());
  main.firstStart = s.postUpdate;
  main.start();
  powerMonitor.on('resume', () => main.wake());
  return main;
}

/**
 * Run `fn` once the person is back at the keyboard (no input for less than 10 s), checking every
 * 5 s: something that must be said after a quiet relaunch waits until someone is there to read it.
 */
function whenUserActive(fn) {
  if (!electron) return fn();
  const t = setInterval(() => {
    let idle = 0;
    try { idle = electron.powerMonitor.getSystemIdleTime(); } catch { idle = 0; }
    if (idle < 10) { clearInterval(t); fn(); }
  }, 5000);
}

/** For the tray: {label, action} or null. */
function line() {
  return main ? main.line() : null;
}

module.exports = {
  start, line, whenUserActive, createAppUpdater, verifyManifest, checkPayload, treeHash, cmp, sidePaths, safeRel,
  ENDPOINT, DOWNLOAD_PAGE
};
