'use strict';

/**
 * llama.cpp's CUDA backend on Windows, kept apart from the installer since 0.2.5: the CUDA pack.
 *
 * Why. The CUDA build of llama.cpp is 1.14 GB unpacked -- ggml-cuda.dll 568 MB, cublasLt64_12.dll
 * 474 MB, cublas64_12.dll 100 MB, cudart64_12.dll 0.5 MB -- most of a Windows installer, and useless on
 * a computer without an NVIDIA GPU. The public installer ships llama.cpp's CPU build of the same
 * release (every other file of it is byte for byte the CUDA build's) and <resources>/llama/cuda.json,
 * which names those four files with their size and sha256 and the pack that holds them
 * (scripts/before-pack.js writes it). Typd works at once on the processor; a computer whose hardware
 * wants CUDA (hardware.js cuda(): an NVIDIA GPU with enough memory) downloads the pack after its model,
 * through the model updater's signed path (modelUpdate.js: the manifest's `packs`), and llama-server
 * restarts on it when nothing is being dictated.
 *
 * Where the CUDA backend comes from (state()):
 *   'bundled'    <resources>/llama holds the four files and they match cuda.json: a tester build (which
 *                still bundles everything), or an install updated from 0.2.4 or earlier (its update
 *                package carries the four files over from the installed app: scripts/app-update-package.js).
 *                llama-server finds them beside itself, as it always did.
 *   'installed'  <userData>/cuda/<pack>/ holds them (the pack, downloaded and checked). llama-server is
 *                started with that folder as its working directory: ggml looks for a backend beside its
 *                own exe and then in the current directory (ggml-backend-reg.cpp at b11351), and Windows
 *                finds cuBLAS and the CUDA runtime there too (the folder is also first on its PATH).
 *   'missing'    neither: llama.cpp runs on the processor. modelUpdate.js fetches the pack if this
 *                machine wants it.
 *   'off'        no cuda.json: macOS, a run from source (vendor/llama is the whole CUDA build), a build
 *                before 0.2.5. Nothing here applies and nothing is touched.
 *
 * The four files must be exactly cuda.json's: a backend from another llama.cpp build would not load (or
 * worse, would load and misbehave), so files in <resources>/llama that do not match -- carried over from
 * an install whose llama.cpp was different -- are deleted before llama-server first starts (prepare()),
 * and a pack is installed only when every extracted file matches. A pack that does not let llama-server
 * start is set aside (markBad): Typd runs on the processor and does not fetch it again until the
 * manifest changes.
 *
 * Electron-free (bench/cuda-pack.js): the folders are passed in.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zip = require('./zip');

const SCHEMA = 'typd-cuda/1';
const ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DESC = 'cuda.json';      // in <resources>/llama: what this build's CUDA backend is
const PACK_JSON = 'pack.json'; // in the pack (and in its installed folder): the same list, and the pack's version

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) h.update(chunk);
  return h.digest('hex');
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

/** null if `d` is a cuda.json this app can use, else what is wrong. */
function checkDesc(d) {
  if (!d || typeof d !== 'object' || d.schema !== SCHEMA) return 'not a ' + SCHEMA + ' file';
  if (typeof d.pack !== 'string' || !ID_RE.test(d.pack)) return 'bad pack id';
  if (!Array.isArray(d.files) || d.files.length < 1 || d.files.length > 16) return 'bad files';
  const names = new Set();
  for (const f of d.files) {
    if (!f || typeof f.name !== 'string' || !FILE_RE.test(f.name) || !/\.dll$/i.test(f.name) || names.has(f.name.toLowerCase())) return 'bad file name';
    if (!Number.isSafeInteger(f.size) || f.size < 1) return 'bad size';
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return 'bad sha256';
    names.add(f.name.toLowerCase());
  }
  return null;
}

/** <dir>/cuda.json, checked; or null. */
function readDesc(llamaDir) {
  if (!llamaDir) return null;
  const d = readJson(path.join(llamaDir, DESC));
  return d && !checkDesc(d) ? d : null;
}

/**
 *   llamaDir    where llama-server is (<resources>/llama)
 *   packsDir    <userData>/cuda (null: no user folder, e.g. a bench without one)
 *   log         (...args) => void
 */
function createCuda({ llamaDir, packsDir, log = () => {} }) {
  const desc = readDesc(llamaDir);
  const stateFile = packsDir ? path.join(packsDir, 'state.json') : null;
  let bundled = false;
  let prepared = false;

  const readState = () => (stateFile && readJson(stateFile)) || {};
  async function writeState(s) {
    if (!stateFile) return;
    await fsp.mkdir(packsDir, { recursive: true });
    const tmp = stateFile + '.' + process.pid + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(s, null, 1));
    await renameRetry(tmp, stateFile);
  }

  const total = () => (desc ? desc.files.reduce((s, f) => s + f.size, 0) : 0);
  const packDir = () => (desc && packsDir ? path.join(packsDir, desc.pack) : null);

  /** Are the four files in `dir`, each with cuda.json's size? (Their sha256 was checked when they got there.) */
  function sizesMatch(dir) {
    if (!desc || !dir) return false;
    for (const f of desc.files) {
      try { if (fs.statSync(path.join(dir, f.name)).size !== f.size) return false; } catch { return false; }
    }
    return true;
  }

  /** The installed pack's folder is whole: its pack.json names this very pack, every file has its size. */
  function installed() {
    const dir = packDir();
    if (!dir) return false;
    const p = readJson(path.join(dir, PACK_JSON));
    return Boolean(p && p.pack === desc.pack && sizesMatch(dir));
  }

  function bad() {
    const s = readState();
    return Boolean(desc && s.bad && s.bad.pack === desc.pack);
  }

  /** 'off' | 'bundled' | 'installed' | 'missing' (see the top of this file). */
  function state() {
    if (!desc) return 'off';
    if (bundled) return 'bundled';
    if (installed() && !bad()) return 'installed';
    return 'missing';
  }

  /** The folder llama-server should start in for CUDA (an installed pack), or null (bundled, none, set aside). */
  function dir() {
    return state() === 'installed' ? packDir() : null;
  }

  /**
   * Once, before llama-server first starts: are the files in <resources>/llama this build's CUDA
   * backend? Each is checked by sha256 the first time (cached by size and mtime in state.json); a set
   * that is not exactly cuda.json's is deleted. Never throws.
   */
  let preparing = null;
  function prepare() {
    // One check for everyone: the first warm start and the updater's first look may ask at once, and
    // neither may go on before it has finished (llama-server would load files about to be deleted).
    if (!desc) return Promise.resolve(state());
    if (!preparing) preparing = check().catch((err) => log('CUDA backend: check failed:', err && err.message)).then(() => { prepared = true; return state(); });
    return preparing;
  }

  async function check() {
    const present = desc.files.filter((f) => fs.existsSync(path.join(llamaDir, f.name)));
    if (!present.length) { bundled = false; return state(); }
    let ok = present.length === desc.files.length;
    const s = readState();
    const seen = { ...(s.bundled || {}) };
    let dirty = false;
    for (const f of desc.files) {
      if (!ok) break;
      const p = path.join(llamaDir, f.name);
      let st;
      try { st = fs.statSync(p); } catch { ok = false; break; }
      if (st.size !== f.size) { ok = false; break; }
      const c = seen[f.name];
      if (c && c.size === st.size && c.mtimeMs === st.mtimeMs && c.sha256 === f.sha256) continue;
      const sha = await sha256File(p).catch(() => null);
      if (sha !== f.sha256) { ok = false; break; }
      seen[f.name] = { size: st.size, mtimeMs: st.mtimeMs, sha256: sha };
      dirty = true;
    }
    if (ok) {
      bundled = true;
      if (dirty) { s.bundled = seen; await writeState(s).catch(() => {}); }
      log('CUDA backend: bundled in', llamaDir, '(' + desc.pack + ')');
      return state();
    }
    // Not this build's: llama-server must not load them. Deleted (a later download brings the right ones).
    bundled = false;
    for (const f of present) {
      await fsp.rm(path.join(llamaDir, f.name), { force: true }).then(
        () => log('CUDA backend: deleted', f.name, 'from', llamaDir, '(not this build\'s)'),
        (err) => log('CUDA backend: could not delete', f.name, err && err.message));
    }
    if (s.bundled) { delete s.bundled; await writeState(s).catch(() => {}); }
    return state();
  }

  /**
   * Install the pack from the downloaded zip `zipFile` (already checked against the signed manifest):
   * extract the four files into <packsDir>/<pack>.unpack/, check each against cuda.json (size and
   * sha256), write pack.json, then make it <packsDir>/<pack>/. `version` is the manifest's version of
   * the pack. Throws if anything does not match (and leaves nothing half done).
   */
  async function install(zipFile, version) {
    if (!desc || !packsDir) throw new Error('no CUDA pack for this build');
    const want = new Map(desc.files.map((f) => [f.name.toLowerCase(), f]));
    const tmp = path.join(packsDir, desc.pack + '.unpack');
    await fsp.rm(tmp, { recursive: true, force: true });
    try {
      const got = await zip.extract(zipFile, tmp, (name) => want.has(name.toLowerCase()));
      for (const f of desc.files) {
        const g = got.find((x) => x.name.toLowerCase() === f.name.toLowerCase());
        if (!g) throw new Error(f.name + ' is not in the pack');
        if (g.size !== f.size || g.sha256 !== f.sha256) throw new Error(`${f.name} in the pack is not this build's (${g.size} bytes, sha256 ${g.sha256.slice(0, 12)})`);
        if (g.name !== f.name) await renameRetry(path.join(tmp, g.name), path.join(tmp, f.name));
      }
      await fsp.writeFile(path.join(tmp, PACK_JSON), JSON.stringify({ ...desc, version, installed_at: new Date().toISOString() }, null, 1) + '\n');
      const dest = packDir();
      await fsp.rm(dest, { recursive: true, force: true });
      await renameRetry(tmp, dest);
    } catch (err) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    const s = readState();
    if (s.bad) { delete s.bad; await writeState(s).catch(() => {}); }
    log('CUDA backend: installed', desc.pack, '(' + version + ') in', packDir());
    await tidy();
  }

  /** llama-server did not start with the pack: set it aside until the manifest changes (`tag`). */
  async function markBad(why, tag = null) {
    if (!desc) return;
    const s = readState();
    s.bad = { pack: desc.pack, tag, why: String(why || '').slice(0, 200), at: new Date().toISOString() };
    await writeState(s).catch(() => {});
    log('CUDA backend: set aside (' + s.bad.why + '); llama.cpp runs on the processor');
  }

  /** The tag (the manifest's sha256) a pack was set aside under, or null. */
  function badTag() {
    const s = readState();
    return desc && s.bad && s.bad.pack === desc.pack ? (s.bad.tag || '') : null;
  }

  /**
   * Delete every other pack folder in packsDir (an earlier llama.cpp build's, its download included) and
   * any half-unpacked one. This build's pack and its download in progress (<version>.partial, where the
   * version starts with the pack's id) stay.
   */
  async function tidy() {
    if (!packsDir) return;
    let names = [];
    try { names = await fsp.readdir(packsDir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (!e.isDirectory()) continue;
      if (desc && (e.name === desc.pack || (e.name.startsWith(desc.pack) && e.name.endsWith('.partial')))) continue;
      await fsp.rm(path.join(packsDir, e.name), { recursive: true, force: true }).then(
        () => log('CUDA backend: deleted', e.name),
        (err) => log('CUDA backend: could not delete', e.name, err && err.message));
    }
  }

  return {
    get desc() { return desc; },
    get id() { return desc ? desc.pack : null; },
    get packsDir() { return packsDir; },
    get prepared() { return prepared; },
    total, state, dir, prepare, install, markBad, badTag, tidy, installed,
    /** Is a CUDA backend there to use (bundled, or an installed pack not set aside)? */
    have: () => ['bundled', 'installed'].includes(state())
  };
}

module.exports = { createCuda, readDesc, checkDesc, sha256File, SCHEMA, DESC, PACK_JSON, ID_RE };
