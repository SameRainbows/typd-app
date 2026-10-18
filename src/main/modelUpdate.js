'use strict';

/**
 * Model updates, for every packaged Typd and the developer's own machines: follow the dictation
 * model the developer publishes, without ever making a dictation wait for it.
 *
 * Where it reads the model from (findConfig), in order:
 *   <userData>/model-updates.json   {endpoint, key}: the developer's own machines (a READER_ key
 *                                   from typd-collect/keys.mjs; it can read the model, nothing else)
 *   <resources>/tester.json         tester builds (the file sharing.js reads, or after a macOS app
 *                                   update its copy in <userData>/carried/, carried.js; development:
 *                                   the repo's tester.json, only with TYPD_TESTER_DEV=1)
 *   neither, in a packaged build    the public routes, with no key (the public beta): the same
 *                                   manifest and files, under the server's public ceilings
 * A key reads /v1/model/manifest and /v1/model/file/; no key, /v1/model/public/manifest and
 * /v1/model/public/file/ (only the live version's files), and no Authorization header is sent.
 * (The public beta's install key, sharing.js, is never used here: it uploads, nothing else.)
 * Run from source with neither file, it is off, as before. TYPD_MODEL_DIR (eval tools, a fixed
 * model folder) and TYPD_NO_MODEL_UPDATE=1 (CI, tests) turn it off.
 *
 * 20 s after launch, then every hour give or take 10 % (or at the interval the server asks for, within
 * 15 min to 6 h), and on wake or unlock when the last check is 15 minutes old (checkCadence.js), it reads
 * the manifest (typd-collect, GET <routes>/manifest);
 * in a packaged build that request also carries the version counts' headers (versionStats.js),
 * keyed or not. The manifest must be SIGNED: its exact text, with an Ed25519 signature over
 * SIG_PREFIX + text in the X-Typd-Manifest-Key and X-Typd-Manifest-Sig headers, by a key in
 * modelManifestKey.js (dictation-research/scripts/publish_model.py signs it). An unsigned manifest,
 * a bad signature, an unknown key, or a seq below one already seen (an old manifest replayed) is
 * refused, and nothing is downloaded. Typd up to 0.2.1 did not check; the server serves those the
 * same JSON.
 *
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
 * Always the latest: a downloaded version is switched to only if, read again just before the switch, the
 * manifest still names it; if it names a newer one, that one is fetched instead (never one step at a time).
 *
 * If the new model does not start, current.json goes back to the previous model and the version
 * is remembered as bad (state.json), not retried until the manifest changes. A switch that
 * crashed the app counts the same: an unconfirmed current.json whose model fails at the next
 * launch is reverted. Too little disk (1.2 x what is left to download) skips the update until
 * the next check. A 429 from the server is retried after its Retry-After, never sooner.
 *
 * Variants. The manifest's top level is the full model (the 1.7B), what every Typd before variants
 * follows; `variants` may add others under the same signature, e.g.
 *   {version, files, model_json, ..., seq, variants: {light: {version, files, model_json, min_app, notes}}}
 * Each check asks `variant()` which one this machine wants (hardware.js picks 'full' or 'light';
 * Settings can pin one) and follows that entry, or the top level when the manifest has no such
 * variant. Older Typd ignore the field: they read the top level as before.
 *
 * Asking first. A download over ASK_ABOVE_BYTES (counting only what is not already here: a partial
 * download's bytes and files copied from disk are not counted) starts by itself on an unmetered
 * connection; on a metered one, or one netcost.js cannot read, the updater stops at state 'ask' and
 * waits for approve() ("Update now", tray or Settings) or later() ("Later": asked again after
 * LATER_MS). With `askFirst()` (Settings: "Ask before downloading new models") every download asks.
 * An approval holds for that version (state.json "approved"), so a download it started resumes by
 * itself.
 *
 * No model at all (a public installer since 0.2.5 ships without one; tester builds still bundle
 * theirs). With nothing bundled and nothing downloaded, the first model is what Typd needs before it
 * can dictate, so the same path runs in a hurry: the first check FIRST_NEED_MS after launch instead
 * of a minute, no RATE throttle, retries every NEED_BACKOFF_MIN_MS..NEED_BACKOFF_MAX_MS, and while
 * offline a cheap look every OFFLINE_POLL_MS (no request is made until the system says it is
 * online). The variant is the hardware's pick, as for any update; the signature, the sha256 of every
 * file, resuming with Range, the disk-space check and asking first on a metered connection are
 * exactly as above. needed() tells the app how far it is (for the tray, Home and the walkthrough);
 * before any manifest was read, the size is an estimate per variant (EXPECTED_BYTES).
 *
 * The CUDA pack (Windows, since 0.2.5; cudaPack.js). The public installer has llama.cpp's CPU build and
 * no CUDA; `packs` in the same signed manifest names the CUDA backend for each llama.cpp build, e.g.
 *   packs: {"cuda-b11351-cu12.4": {version, files: [{name: "cuda-pack-b11351-cu12.4.zip", size, sha256}], min_app, notes}}
 * A machine whose hardware takes the GPU path (`cudaWanted`: hardware.js cuda()) and has no CUDA backend
 * yet fetches the entry its build names (cuda.json's "pack"), AFTER its model: only once there is a
 * model to dictate with, so dictation never waits for it. The same path as a model: the manifest's
 * signature, the zip's size and sha256, Range resume, retries, the disk-space check, asking first on a
 * metered connection (state.json "packApproved" / "packLater", apart from the model's), progress
 * (packInfo(), packLine()). Unthrottled, like the first model: until it arrives the model runs on the
 * processor. Then cudaPack.install() unpacks it and checks every file against the app's own list, and
 * once nothing is being dictated `switchBackend` restarts llama-server on it (no app restart). A pack
 * llama-server does not start with is set aside (cudaPack markBad) and not fetched again until the
 * manifest changes; Typd stays on the processor. Typd before 0.2.5 ignores the field.
 *
 * Light first, full later (0.2.6). A fresh install (no model at all) whose Automatic pick is the full
 * model starts downloading the full model as before and times it for PROBE_MS. If the rest of it -- with
 * the CUDA pack's bytes on the GPU path -- would take more than LIGHT_FIRST_ABOVE_MS at that speed, the
 * full download is paused (its partial file kept) and the light model is fetched with the whole link,
 * switched to, and dictation starts; then the CUDA pack (GPU path), then the rest of the full model,
 * resumed with Range from where it paused, never from zero (pausing rather than fetching both at once
 * gets the light model in soonest on a slow link, which is when this runs at all), and unthrottled like
 * the first model. The switch to the full model is the usual one (activate: when nothing has been
 * dictated for IDLE_MS). A fast link gets no light model at all. state.json "lightFirst" {light, full}
 * marks the light model as standing in (Home says so: interim()); it keeps the paused download through
 * tidy() and a restart, and goes once the full model has had its good start (confirm), when the light
 * model is then deleted like any previous version (the updater keeps one downloaded version; until that
 * start the light one is current.json's "previous", what a failed start goes back to). A failed or cut
 * full download leaves the light model in use and resumes at the next check.
 *   Only for Automatic (`automatic()`): a Settings pin of Full downloads only the full model, as asked.
 *   Only when the light model needs no question: on a metered connection, or with "Ask before
 * downloading new models", the light model is not fetched (nor asked for: the person has just answered
 * for the full one) and the full model comes as in 0.2.5. Only when the light model is smaller than what
 * is left of the full one (and the pack), and there is disk space for both.
 *
 * Never the full model on the processor while the GPU path is pending (0.2.6): on a machine whose
 * hardware takes the GPU path, with the CUDA pack published for this build, not here and not set aside,
 * the full model is not started before the pack is installed. With no model yet, the pack is fetched
 * after the full model and the two start together; if that start fails, the pack is set aside and the
 * model tried once on the processor (to tell which of the two failed). With the light model running, the
 * pack comes first (verified by a backend switch on the light model) and the full model after it. Where
 * the pack waits for the person's OK and there is no model yet, the full model is not held hostage to
 * the answer: it starts on the processor as in 0.2.5, and the pack is asked for. A pack set aside under
 * the current manifest makes Automatic follow the light model (the full one is too slow on the
 * processor): such a machine stays on, or goes back to, the light model; a pin of Full is obeyed. An
 * install already running the full model with the pack still missing (0.2.5) just fetches the pack: it
 * is smaller than the light model would be. current.json "variant" records which variant a version was.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { createCadence, WAKE_DELAY_MS } = require('./checkCadence');

const FIRST_CHECK_MS = 20e3;              // "check once on launch": a moment after start
const CHECK_EVERY_MS = 3600e3;            // then hourly, +-10 % (checkCadence.js), or the server's interval
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
const SIG_PREFIX = 'typd-model-manifest/1\n';                 // what the signature covers, before the text
const KID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VARIANT_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ASK_ABOVE_BYTES = 300e6;           // bigger downloads ask first on a metered connection
const LATER_MS = 24 * 3600e3;            // "Later": asked again after a day
// No model yet (a model-less public install): see "No model at all" above.
const FIRST_NEED_MS = 1500;
const NEED_BACKOFF_MIN_MS = 10e3;
const NEED_BACKOFF_MAX_MS = 120e3;
const NEED_EVERY_MS = 15 * 60e3;         // a check that found nothing to download (no manifest, refused)
const OFFLINE_POLL_MS = 15e3;
// What the first download is about, before the manifest says exactly: the live versions' sizes
// (r24_1p7b_rev128 with its mmproj and adapter: 1,602,588,192 B; light_soup_r20kd: 611,092,960 B).
const EXPECTED_BYTES = { full: 1.6e9, light: 611e6 };
// Light first, full later: see above. Tests shrink both.
const PROBE_MS = 10e3;                   // the first full-model download is timed for this long, then
const LIGHT_FIRST_ABOVE_MS = 180e3;      // if the rest (with the CUDA pack) would take longer, the light model goes first

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
  if (m.seq !== undefined && (!Number.isSafeInteger(m.seq) || m.seq < 1)) return 'bad seq';
  return null;
}

/**
 * The entry of `m` this machine follows: {entry, variant}. `want` is a variant name ('light'); the
 * top level is 'full', and also the answer when the manifest has no such variant or its entry is
 * not one this app can follow. A variant entry has its own version, files, model_json and notes, and
 * its own min_app (else the top level's).
 */
function selectVariant(m, want) {
  const vs = m && m.variants;
  if (want && want !== 'full' && VARIANT_RE.test(want) && vs && typeof vs === 'object' && !Array.isArray(vs) && Object.prototype.hasOwnProperty.call(vs, want)) {
    const v = vs[want];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const entry = { version: v.version, files: v.files, model_json: v.model_json, min_app: v.min_app !== undefined ? v.min_app : m.min_app, notes: v.notes };
      if (!checkManifest(entry)) return { entry, variant: want };
    }
  }
  return { entry: m, variant: 'full' };
}

const PACK_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;

/**
 * The manifest's entry for the CUDA pack `id` (cuda.json's "pack"): {version, files: [the one .zip],
 * min_app, notes}, or null when the manifest has none or it is not one this app can follow.
 */
function selectPack(m, id) {
  const ps = m && m.packs;
  if (!id || !PACK_ID_RE.test(id) || !ps || typeof ps !== 'object' || Array.isArray(ps) || !Object.prototype.hasOwnProperty.call(ps, id)) return null;
  const p = ps[id];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (typeof p.version !== 'string' || !VERSION_RE.test(p.version)) return null;
  if (!Array.isArray(p.files) || p.files.length !== 1) return null;
  const f = p.files[0];
  if (!f || typeof f.name !== 'string' || !FILE_RE.test(f.name) || !/\.zip$/i.test(f.name)) return null;
  if (!Number.isSafeInteger(f.size) || f.size < 1 || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return null;
  const minApp = p.min_app !== undefined ? p.min_app : m.min_app;
  if (minApp !== undefined && (typeof minApp !== 'string' || !/^\d+\.\d+\.\d+$/.test(minApp))) return null;
  return { version: p.version, files: [{ name: f.name, size: f.size, sha256: f.sha256 }], min_app: minApp, notes: typeof p.notes === 'string' ? p.notes : '' };
}

/** 1,107,404,576 -> '1.1 GB'; 611,093,000 -> '611 MB'. */
function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB';
}

/**
 * null if `text`, the manifest exactly as served, is signed by one of `keys` ({id: PEM}): `keyId`
 * and `sig` (base64) from the X-Typd-Manifest-Key and X-Typd-Manifest-Sig headers, the signature
 * over SIG_PREFIX + text. Else what is wrong. Nothing in the manifest is trusted before this.
 */
function checkSignature(text, keyId, sig, keys) {
  if (!keyId || !sig) return 'unsigned';
  if (!KID_RE.test(keyId) || !keys || !Object.prototype.hasOwnProperty.call(keys, keyId)) return 'signed by an unknown key';
  const raw = Buffer.from(String(sig), 'base64');
  if (raw.length !== 64 || raw.toString('base64') !== sig) return 'bad signature';
  try {
    return crypto.verify(null, Buffer.from(SIG_PREFIX + text, 'utf8'), crypto.createPublicKey(keys[keyId]), raw) ? null : 'bad signature';
  } catch {
    return 'bad signature';
  }
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
/** A download paused on purpose (light first): its partial file is kept for Range. */
class Paused extends Retry {
  constructor(message) { super(message, 1000); this.paused = true; }
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
 *   keys          {id: PEM}: the keys a manifest may be signed with (modelManifestKey.js; tests
 *                 pass a throwaway one)
 *   variant       () => 'full'|'light'|... (or a Promise of it): the manifest entry to follow
 *                 (modelChoice.js: the hardware's pick, or the one Settings pins); default 'full'
 *   askFirst      () => boolean: ask before every download ("Ask before downloading new models")
 *   networkCost   () => Promise<'metered'|'unmetered'|'unknown'> (netcost.js), asked only for a
 *                 download over askAboveBytes
 *   now           () => ms: the clock for "Later" (tests move it)
 *   cuda          the CUDA pack (cudaPack.createCuda()), or null: none of the pack logic runs
 *   cudaWanted    () => boolean (or a Promise of it): this machine takes the GPU path (modelChoice.cuda)
 *   switchBackend () => Promise: restart llama-server on the backend now there (the pack just installed,
 *                 or none after it was set aside); rejects if it does not come up
 *   automatic     () => boolean (or a Promise of it): `variant` is Automatic's pick, not a Settings pin
 *                 (modelChoice.automatic). Light first, and the light model when the CUDA pack is set
 *                 aside, are Automatic's only; default false (as before 0.2.6)
 *   probeMs, lightFirstAboveMs   light first's timing window and threshold (PROBE_MS, LIGHT_FIRST_ABOVE_MS)
 */
function createUpdater({
  config, modelsDir, bundledDir, appVersion = '0.0.0', fetch = globalThis.fetch, busy = () => false,
  switchModel = async () => {}, log = () => {}, online = () => true, statfs = (p) => fsp.statfs(p),
  rate = RATE, idleMs = IDLE_MS, firstCheckMs = FIRST_CHECK_MS, everyMs = CHECK_EVERY_MS, stats = () => ({}),
  keys = require('./modelManifestKey').keys,
  variant = () => 'full', askFirst = () => false, networkCost = async () => 'unknown',
  askAboveBytes = ASK_ABOVE_BYTES, laterMs = LATER_MS, now = () => Date.now(),
  firstNeedMs = FIRST_NEED_MS, needBackoffMinMs = NEED_BACKOFF_MIN_MS, needBackoffMaxMs = NEED_BACKOFF_MAX_MS,
  needEveryMs = NEED_EVERY_MS, offlinePollMs = OFFLINE_POLL_MS, expectedBytes = EXPECTED_BYTES,
  cuda = null, cudaWanted = () => false, switchBackend = async () => {}, random = Math.random,
  automatic = () => false, probeMs = PROBE_MS, lightFirstAboveMs = LIGHT_FIRST_ABOVE_MS
}) {
  const cadence = createCadence({ everyMs, now, random });
  // "Check for updates": promises waiting for this check's first verdict ({outcome, ...}; notePhase).
  let phaseWaiters = [];
  let lastOutcome = null;
  function notePhase(o) {
    lastOutcome = { ...o, at: new Date(now()).toISOString() };
    const w = phaseWaiters;
    phaseWaiters = [];
    for (const fn of w) { try { fn(lastOutcome); } catch { /* a listener's problem */ } }
  }
  const stateFile = path.join(modelsDir, 'state.json');
  const dirOf = (v) => path.join(modelsDir, v);
  let state = 'idle';             // what line() says: idle, current, downloading, ready, failed, app, space, stopped, none, refused, ask, later
  let asking = null;              // {version, variant, bytes, why}: a download waiting for "Update now" (state ask or later)
  let chosen = { want: 'full', got: null };   // the variant asked for, and the entry the last manifest gave
  let started = false;
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
  // The CUDA pack: its own state, progress and question, beside the model's.
  let packState = 'idle';         // idle, off, current, unwanted, none, app, downloading, retrying, installing, ready, failed, space, ask, later, offline
  let packAsking = null;          // {version, bytes, why, kind: 'pack'}: the pack waiting for "Update now"
  let packProgress = { done: 0, total: 0 };
  let packTarget = null;          // the pack version being fetched or switched to
  let packHurry = false;          // wanted and not here: retried and polled like the first model
  // Light first, and the CUDA pack before the full model's first start.
  let netBytes = 0;               // bytes received from the network, ever (light first times the full download with it)
  let fetchingLight = null;       // the light version being fetched to stand in for the full one (needed() says so)
  let firstPack = false;          // no model yet, and the CUDA pack comes before the full model's first start

  const readState = () => readJson(stateFile) || {};
  const writeState = (s) => writeAtomic(stateFile, JSON.stringify(s, null, 1));

  function changed() {
    const l = line();
    const both = l + '\n' + packLine();
    if (both === lastLine) return;
    lastLine = both;
    for (const fn of listeners) { try { fn(l); } catch { /* a listener's problem */ } }
  }
  function setPack(st) {
    packState = st;
    if (st !== 'ask' && st !== 'later') packAsking = null;
    changed();
    return { pack: st };
  }
  function set(s, extra = {}) {
    state = s;
    if (s !== 'ask' && s !== 'later') asking = null;
    changed();
    return { state: s, ...extra };
  }
  // Bytes arrive in small chunks; the tray line only changes with the whole percent.
  let lastPct = -1;
  function progressed(p = progress) {
    const pct = p.total ? Math.floor((100 * p.done) / p.total) : 0;
    if (pct !== lastPct) { lastPct = pct; changed(); }
  }

  /* ------------------------------------------------- what this machine runs */

  function bundledSpec() { return bundledDir ? readJson(path.join(bundledDir, 'model.json')) : null; }

  /** Is there a model to dictate with: a complete downloaded version, or a bundled model whose files are there? */
  function haveModel() {
    if (activeModel(modelsDir)) return true;
    const spec = bundledSpec();
    if (!spec || typeof spec.model !== 'string' || typeof spec.mmproj !== 'string') return false;
    try {
      return fs.statSync(path.join(bundledDir, spec.model)).size > 0 && fs.statSync(path.join(bundledDir, spec.mmproj)).size > 0;
    } catch {
      return false;
    }
  }

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
   * progress (`target`'s). Never the bundled model: it is not in modelsDir. While the light model
   * stands in for the full one (state.json "lightFirst"), neither of the two is touched, downloaded
   * or partial: the full one paused for the light one resumes from what it has.
   */
  async function tidy(keep) {
    let names = [];
    try { names = await fsp.readdir(modelsDir, { withFileTypes: true }); } catch { return; }
    const lf = readState().lightFirst;
    const hold = lf ? [lf.light, lf.full] : [];
    for (const e of names) {
      if (!e.isDirectory()) continue;
      const v = e.name.replace(/\.partial$/, '');
      if (!VERSION_RE.test(v) || e.name === keep || (target && e.name === target + '.partial') || hold.includes(v)) continue;
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
    if (res.status === 429) throw new Retry(what + ': the server is busy (429)', retryAfter(res) || cadence.every());
    throw new Retry(what + ': HTTP ' + res.status);
  }

  let windowAt = 0, windowBytes = 0;
  async function throttle(n, hurry = false) {
    if (!rate || hurry || !haveModel()) return;   // the first model (Typd cannot dictate until it is here), the CUDA pack
    const now = Date.now();
    if (now - windowAt > 10e3) { windowAt = now; windowBytes = 0; }
    windowBytes += n;
    const ahead = (windowBytes / rate) * 1000 - (now - windowAt);
    if (ahead > 5) await new Promise((r) => setTimeout(r, ahead));
  }

  /**
   * One file into `file`, resuming from what is already there. `prog` is the progress it adds to; `hurry`:
   * never throttled; `pause` (an AbortSignal): stop where it is, keep the bytes, throw Paused.
   */
  async function download(version, f, file, prog = progress, hurry = false, pause = null) {
    let have = 0;
    try { have = (await fsp.stat(file)).size; } catch { /* not started */ }
    if (have > f.size) { await fsp.rm(file, { force: true }); have = 0; }
    if (have === f.size) return;
    if (pause && pause.aborted) throw new Paused(f.name + ': paused at byte ' + have);
    const ctrl = new AbortController();
    const onPause = () => ctrl.abort();
    if (pause) pause.addEventListener('abort', onPause, { once: true });
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
      prog.done -= (await fsp.stat(file).then((s) => s.size, () => 0)) - have;
      const out = fs.createWriteStream(file, { flags: have ? 'a' : 'w' });
      const closed = once(out, 'close').catch(() => {});
      try {
        for await (const chunk of res.body) {
          arm();
          have += chunk.length;
          if (have > f.size) throw new Error(f.name + ': more bytes than the manifest says');
          if (!out.write(chunk)) await once(out, 'drain');
          prog.done += chunk.length;
          netBytes += chunk.length;
          progressed(prog);
          await throttle(chunk.length, hurry);
        }
      } finally {
        out.end();
        await closed;
      }
      if (have !== f.size) throw new Retry(f.name + ': the download ended early');
    } catch (err) {
      if (pause && pause.aborted && !revoked) throw new Paused(f.name + ': paused at byte ' + have);
      if (err instanceof Retry || revoked) throw err;
      throw new Retry(f.name + ': ' + (ctrl.signal.aborted ? 'stalled' : (err && err.message) || err));
    } finally {
      clearTimeout(stall);
      if (pause) pause.removeEventListener('abort', onPause);
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

  /** Bytes still to download for `m`: what a partial download already holds and files copied from disk not counted. */
  async function bytesToFetch(m) {
    const partial = dirOf(m.version) + '.partial';
    let need = 0;
    for (const f of m.files) {
      const have = await fsp.stat(path.join(partial, f.name)).then((st) => Math.min(st.size, f.size), () => 0);
      if (have === 0 && (await localCopy(f))) continue;
      need += f.size - have;
    }
    return need;
  }

  /**
   * Would a download of `need` bytes of `m` have to ask first? null if it may go ahead (approved,
   * small, an unmetered connection); else {s, always, why, L}. Changes nothing (askBefore stops at 'ask').
   */
  async function mustAsk(m, need, kind = 'model') {
    if (need <= 0) return null;
    const s = readState();
    const A = kind === 'pack' ? 'packApproved' : 'approved', L = kind === 'pack' ? 'packLater' : 'later';
    if (s[A] && s[A].version === m.version) return null;
    let always = false;
    try { always = Boolean(askFirst()); } catch { always = false; }
    let why = 'setting';
    if (!always) {
      if (need <= askAboveBytes) return null;
      try { why = await networkCost(); } catch { why = 'unknown'; }
      if (why === 'unmetered') return null;
    }
    return { s, always, why, L };
  }

  /**
   * Before a download of `need` bytes of `m` (the `got` variant): null to go ahead, or the result of
   * stopping at 'ask' (or 'later', inside a "Later" day). Approved versions go ahead (state.json).
   */
  async function askBefore(m, got, need, kind = 'model') {
    const q = await mustAsk(m, need, kind);
    if (!q) return null;
    const { s, always, why, L } = q;
    const until = s[L] && s[L].version === m.version ? Number(s[L].until) || 0 : 0;
    const left = until - now();
    log(m.version, 'needs', fmtSize(need), '-', always ? 'asking first (the setting is on)' : 'the connection is ' + why + '; asking first', left > 0 ? '(asked to wait until ' + new Date(until).toISOString() + ')' : '');
    if (kind === 'pack') {
      packAsking = { version: m.version, variant: 'pack', bytes: need, why, kind };
      if (left > 0) return { ...setPack('later'), next: Math.min(cadence.every(), left + 1000) };
      return setPack('ask');
    }
    asking = { version: m.version, variant: got, bytes: need, why, kind };
    if (left > 0) return { ...set('later'), next: Math.min(cadence.every(), left + 1000) };
    return set('ask');
  }

  /**
   * Every file of `m` into <version>.partial/, checked; then the folder takes the version's name.
   * `hurry`: never throttled (the full model while the light one stands in); `pause`: see download().
   */
  async function fetchVersion(m, tag, { hurry = false, pause = null } = {}) {
    const partial = dirOf(m.version) + '.partial';
    await fsp.mkdir(partial, { recursive: true });
    const sizes = await Promise.all(m.files.map((f) => fsp.stat(path.join(partial, f.name)).then((s) => Math.min(s.size, f.size), () => 0)));
    const total = m.files.reduce((s, f) => s + f.size, 0);
    const left = total - sizes.reduce((a, b) => a + b, 0);
    let free = Infinity;
    try { const s = await statfs(modelsDir); free = Number(s.bavail) * Number(s.bsize); } catch { /* unknown: try */ }
    if (free < left * SPACE_FACTOR) {
      log('not enough disk space for', m.version, '- need', Math.round((left * SPACE_FACTOR) / 1e6), 'MB, have', Math.round(free / 1e6));
      throw Object.assign(new Retry('no space', cadence.every()), { space: true });
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
      await download(m.version, f, file, progress, hurry, pause);
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
   * server once nothing is being dictated, then confirm or revert. `variant`: what current.json
   * records the version as ('full', 'light'). The first start of a model with a CUDA pack installed
   * that no model has run with yet (the GPU path, no model before): if it fails, the pack is set aside
   * under this manifest and the model tried once more on the processor before it is judged; resolves
   * with `more: true` when it then runs there (Automatic goes to the light model: run()).
   */
  async function activate(version, tag, label = version, want = null, { variant: kindOf = null } = {}) {
    const packTag = !haveModel() && cuda && cuda.id && cuda.state() === 'installed' ? tag : null;
    target = label;
    set('ready');
    if (packTag) setPack('ready');
    await waitIdle();
    if (version && want) {
      const now2 = await liveEntry(want);
      if (now2 && now2.version !== version) {
        log('the manifest names', now2.version, 'now, not', version, '- fetching that one instead');
        target = null;
        throw new Retry(`a newer model (${now2.version}) is live; fetching it instead of ${version}`, 1000);
      }
    }
    const cur = readCurrent(modelsDir);
    const previous = cur && activeModel(modelsDir) ? cur.version : null;
    switching = true;
    try {
      await writeCurrent(version ? { version, previous, confirmed: false, manifest: tag, ...(kindOf ? { variant: kindOf } : {}), at: new Date().toISOString() } : null);
      log('switching to', label, 'from', previous || 'the bundled model', packTag ? '(with the CUDA pack, just installed)' : '');
      let onCpu = false;
      try {
        await switchModel();
      } catch (err) {
        if (!packTag || !cuda) return await revert(version, previous, tag, label, err);
        // The model and the CUDA pack, both new, started together: set the pack aside and try the model
        // alone. If it starts, the pack was at fault (not fetched again until the manifest changes).
        await cuda.markBad('llama-server did not start with it (first start, with ' + label + '): ' + ((err && err.message) || err), packTag);
        packTarget = null;
        packHurry = false;
        setPack('failed');
        try {
          await switchModel();
          onCpu = true;
        } catch (e2) {
          return await revert(version, previous, tag, label, e2);
        }
        log('the model', label, 'runs on the processor: llama-server did not start with the CUDA pack, now set aside');
      }
      firstPack = false;
      await confirm();
      if (!version) { const s = readState(); s.bundled = { version: label, model: (bundledSpec() || {}).model }; await writeState(s); }
      if (packTag && !onCpu) { packTarget = null; packHurry = false; setPack('current'); log('now running with the CUDA backend'); }
      log('now running', label);
      target = null;
      return { ...set('current'), ...(onCpu ? { more: true } : {}) };
    } finally {
      switching = false;
    }
  }

  async function confirm() {
    const cur = readCurrent(modelsDir);
    if (cur && !cur.confirmed) await writeCurrent({ ...cur, previous: null, confirmed: true });
    // Light first: once another model has had its good start, the light one no longer stands in (tidy
    // then deletes it, as any previous version).
    const s = readState();
    if (s.lightFirst && (!cur || cur.version !== s.lightFirst.light)) {
      log('light first: done,', cur ? cur.version : 'the bundled model', 'runs; the light model', s.lightFirst.light, 'goes');
      delete s.lightFirst;
      await writeState(s);
    }
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

  /** Is the CUDA pack this build names wanted here and not here yet? (Not before a model exists to dictate with.) */
  async function packMissing() {
    if (!cuda || !cuda.id || !cuda.packsDir) return false;
    await cuda.prepare();
    if (cuda.have()) return false;
    try { return Boolean(await cudaWanted()); } catch { return false; }
  }

  async function run() {
    if (!config) return { state: 'off' };
    if (revoked) return set('stopped');
    const needed = !haveModel();
    // The entry this machine follows: the variant it wants (asked first, so even an offline first
    // launch names the right size), else the top level (the full model) if the manifest lacks it.
    let want = 'full';
    try { want = String((await variant()) || 'full'); } catch { want = 'full'; }
    if (chosen.want !== want) { chosen = { want, got: chosen.got }; changed(); }
    packHurry = await packMissing();
    const soon = needed || packHurry;
    if (!online()) {
      if (needed) set('offline');
      if (packHurry && !needed) setPack('offline');
      notePhase({ outcome: 'offline' });
      throw new Retry('offline', soon ? offlinePollMs : undefined);
    }
    let res;
    try {
      cadence.checked();
      let extra = {};
      try { extra = stats() || {}; } catch { extra = {}; }   // counting must never stop a check
      res = await fetch(routes() + '/manifest', { headers: { ...extra, ...auth() }, signal: AbortSignal.timeout(30e3) });
    } catch (err) {
      if (needed) set('offline');   // the server cannot be reached: to the person waiting, the same as offline
      if (packHurry && !needed) setPack('offline');
      throw new Retry('manifest: ' + ((err && err.message) || err), soon ? offlinePollMs : undefined);
    }
    if (res.status === 404) { await res.body?.cancel().catch(() => {}); notePhase({ outcome: 'current' }); return set('none'); }
    if (!res.ok) await refused(res, 'manifest');
    const text = await res.text();
    const unsigned = checkSignature(text, res.headers.get('x-typd-manifest-key'), res.headers.get('x-typd-manifest-sig'), keys);
    if (unsigned) { log('manifest refused:', unsigned); return set('refused', { why: unsigned }); }
    let m;
    try { m = JSON.parse(text); } catch { m = null; }
    cadence.fromResponse(res.headers, m);   // the server's interval, if it asks for one
    const bad = checkManifest(m) || (Number.isSafeInteger(m.seq) ? null : 'no seq');
    if (bad) { log('manifest refused:', bad); return set('none'); }
    const tag = crypto.createHash('sha256').update(text).digest('hex');

    const s = readState();
    if (Number.isSafeInteger(s.seq) && m.seq < s.seq) {
      log('manifest refused: seq', m.seq, 'is older than', s.seq, 'already seen');
      return set('refused', { why: 'an older manifest than one already seen' });
    }
    let r = await followModel(m, tag, s, await wantHere(want, tag));
    // Then the CUDA pack, once there is a model to dictate with (the first model always comes first).
    const p = haveModel() ? await followPack(m, tag) : null;
    // The model again when it asked for it: the light model standing in (light first) or a full one held
    // back for the CUDA pack, now that the pack has had its turn; or the pack just set aside (Automatic
    // then follows the light model).
    if (r.more) r = await followModel(m, tag, readState(), await wantHere(want, tag));
    return p && p.next ? { ...r, next: Math.min(p.next, r.next || Infinity) } : r;
  }

  /**
   * The variant to follow, from `want` (variant()): Automatic's 'full' becomes 'light' on a machine whose
   * CUDA pack was set aside under this manifest (`tag`): the full model is too slow on the processor.
   */
  let asideLogged = null;
  let asideTag = null;            // wantHere turned 'full' into 'light' under this manifest: that light model is fetched unthrottled
  async function wantHere(want, tag) {
    asideTag = null;
    if (want !== 'full' || !cuda || !cuda.id || !cuda.packsDir) return want;
    let auto = false;
    try { auto = Boolean(await automatic()); } catch { auto = false; }
    if (!auto) return want;
    await cuda.prepare();
    if (cuda.have() || cuda.badTag() === null || cuda.badTag() !== tag) return want;
    let wanted = false;
    try { wanted = Boolean(await cudaWanted()); } catch { wanted = false; }
    if (!wanted) return want;
    if (asideLogged !== tag) { asideLogged = tag; log('Automatic: the light model, not the full one: the CUDA pack was set aside, and the full model is too slow on the processor'); }
    asideTag = tag;
    return 'light';
  }

  /**
   * The manifest's CUDA pack entry when the GPU path is pending: this build names a pack, the hardware
   * takes the GPU path, no CUDA backend is here, the manifest has one this app can use, and it was not
   * set aside under this manifest. Else null. (followPack's own conditions.)
   */
  async function pendingPack(m, tag) {
    if (!cuda || !cuda.id || !cuda.packsDir) return null;
    await cuda.prepare();
    if (cuda.have()) return null;
    let wanted = false;
    try { wanted = Boolean(await cudaWanted()); } catch { wanted = false; }
    if (!wanted) return null;
    const e = selectPack(m, cuda.id);
    if (!e || older(appVersion, e.min_app)) return null;
    const bad = cuda.badTag();
    if (bad !== null && bad === tag) return null;
    return e;
  }

  /** Is a light model running (one standing in for the full one, or any version current.json records as light)? */
  function lightRunning(active) {
    if (!active) return false;
    const lf = readState().lightFirst;
    if (lf && lf.light === active.version) return true;
    const cur = readCurrent(modelsDir);
    return Boolean(cur && cur.version === active.version && cur.variant === 'light');
  }

  /** Is the light model running as a stand-in for the full one (state.json "lightFirst")? */
  function standingIn(active) {
    const lf = readState().lightFirst;
    return Boolean(active && lf && lf.light === active.version);
  }

  /**
   * Light first: may the light model go first on this fresh install? The light entry of `m` if the full
   * model `e` is Automatic's pick, the manifest has a light one this app can follow (not the same
   * version, not set aside as bad under this manifest); else null. (The connection is judged later.)
   */
  async function lightCandidate(m, tag, e) {
    let auto = false;
    try { auto = Boolean(await automatic()); } catch { auto = false; }
    if (!auto) return null;
    const { entry: l, variant: lv } = selectVariant(m, 'light');
    if (lv !== 'light' || l.version === e.version || older(appVersion, l.min_app)) return null;
    const s = readState();
    if (s.bad && s.bad.manifest === tag && s.bad.version === l.version) return null;
    return l;
  }

  /**
   * The full model `e`, timed: downloaded for probeMs, then -- if the rest of it and `packNeed` bytes of
   * CUDA pack would take more than lightFirstAboveMs at that speed, the light model `light` is smaller
   * than that rest, needs no question on this connection and fits on the disk with it -- paused (its
   * partial file kept). Resolves 'done' (the full model is here) or 'slow' (paused: the light one first).
   */
  async function fetchTimed(e, tag, light, packNeed) {
    const ctl = new AbortController();
    const t0 = Date.now(), b0 = netBytes;
    const left0 = await bytesToFetch(e);
    let over = false, slow = false;
    const decide = async () => {
      const ms = Math.max(1, Date.now() - t0), got = netBytes - b0;
      const rest = Math.max(0, left0 - got) + packNeed;
      const eta = got > 0 ? (rest * ms) / got : Infinity;
      const say = (...a) => log('light first?', ...a, '(' + fmtSize(rest) + ' to go, about', Number.isFinite(eta) ? Math.round(eta / 1000) + ' s' : 'forever', 'at this speed)');
      if (eta <= lightFirstAboveMs) return say('no: the full model keeps going');
      const lightNeed = await bytesToFetch(light);
      if (lightNeed >= rest) return say('no: the light model is no smaller than what is left');
      if (await mustAsk(light, lightNeed)) return say('no: the light model would need an OK on this connection');
      let free = Infinity;
      try { const st = await statfs(modelsDir); free = Number(st.bavail) * Number(st.bsize); } catch { /* unknown: try */ }
      if (free < (lightNeed + rest) * SPACE_FACTOR) return say('no: not enough disk space for both');
      if (over) return;
      say('yes: the full model pauses,', fmtSize(lightNeed), 'of light model first');
      slow = true;
      ctl.abort();
    };
    const timer = setTimeout(() => { decide().catch((err) => log('light first: could not decide:', err && err.message)); }, probeMs);
    try {
      await fetchVersion(e, tag, { pause: ctl.signal });
      return 'done';
    } catch (err) {
      if (slow && err instanceof Paused) return 'slow';
      throw err;
    } finally {
      over = true;
      clearTimeout(timer);
    }
  }

  /**
   * Light first: the light model `light` fetched (unthrottled: there is no model yet) and switched to,
   * standing in for the full model `full` (state.json "lightFirst"). True once it runs.
   */
  async function standIn(light, full, tag) {
    const s = readState();
    s.lightFirst = { light: light.version, full: full.version, at: new Date(now()).toISOString() };
    await writeState(s);
    fetchingLight = light.version;
    target = light.version;
    log('light first:', light.version, 'stands in for', full.version, 'so dictation can start');
    if (!isComplete(dirOf(light.version))) await fetchVersion(light, tag);
    const r = await activate(light.version, tag, light.version, 'light', { variant: 'light' });
    fetchingLight = null;
    return r.state === 'current';
  }

  /**
   * The CUDA pack before the full model's first start (no model yet, the GPU path pending): downloaded,
   * checked and unpacked, not switched to (there is nothing running to switch). 'installed'; 'ask' when it
   * waits for the person's OK (the full model then starts on the processor, as in 0.2.5); 'failed' when
   * its files are not this build's (set aside). Throws Retry like followPack.
   */
  async function packBeforeFull(e, tag) {
    const f = e.files[0];
    packTarget = e.version;
    const zipFile = path.join(cuda.packsDir, e.version + '.partial', f.name);
    const have = await fsp.stat(zipFile).then((st) => Math.min(st.size, f.size), () => 0);
    const waiting = await askBefore(e, 'pack', f.size - have, 'pack');
    if (waiting) {
      firstPack = false;
      log('the CUDA pack waits for an OK; the full model starts on the processor meanwhile');
      return 'ask';
    }
    try {
      await fetchPack(e, tag, zipFile);
    } catch (err) {
      if (!(err && err.badPack)) throw err;
      log((err && err.message) || err);
      firstPack = false;
      packTarget = null;
      setPack('failed');
      return 'failed';
    }
    return 'installed';
  }

  /** The model entry this machine follows, from the checked manifest `m` (its sha256 `tag`): fetched and switched to if needed. */
  async function followModel(m, tag, s, want) {
    fetchingLight = null;
    const { entry: e, variant: got } = selectVariant(m, want);
    if (chosen.got !== got || chosen.want !== want) { chosen = { want, got }; log('variant', want, want === got ? '' : '(not published: following ' + got + ')'); }

    let dirty = false;
    if (s.seq !== m.seq) { s.seq = m.seq; dirty = true; }
    // A version that failed is not tried again until the manifest changes; another variant of the same manifest may be.
    if (s.bad && s.bad.manifest === tag && (s.bad.version == null || s.bad.version === e.version)) { if (dirty) await writeState(s); return set('failed'); }
    if (s.bad && s.bad.manifest !== tag) { delete s.bad; dirty = true; }
    if (dirty) await writeState(s);
    if (older(appVersion, e.min_app)) { log(e.version, 'needs Typd', e.min_app); return set('app'); }

    const cur = readCurrent(modelsDir);
    const active = activeModel(modelsDir);
    if (active && active.version === e.version) {
      if (!cur.confirmed) return set('current');   // its first warm start decides (warmed)
      const lf = readState().lightFirst;
      if (lf && lf.light === e.version) {
        // The light model is what this machine follows now (a pin, or the CUDA pack set aside): no longer a stand-in.
        const t = readState();
        delete t.lightFirst;
        await writeState(t);
        log('light first: the light model', e.version, 'is now the one followed; the full download goes');
        target = null;
      }
      await tidy(e.version);
      return set('current');
    }
    if (await bundledIs(e)) {
      if (!active) {
        target = null;
        if (!s.bundled || s.bundled.version !== e.version) { const t = readState(); t.bundled = { version: e.version, model: e.model_json.model }; await writeState(t); }
        await tidy(null);
        return set('current');
      }
      return activate(null, tag, e.version);   // an app update brought it, or back to the bundled model: no download
    }
    const first = !haveModel();
    // Never the full model on the processor while the GPU path is pending: with a light model running,
    // the CUDA pack first (run() fetches it next, then comes back here).
    if (got === 'full' && lightRunning(active) && (await pendingPack(m, tag))) {
      log('the full model', e.version, 'waits for the CUDA pack; the light model runs meanwhile');
      target = e.version;
      if (state !== 'idle') set('idle');
      return { state, more: true };
    }
    target = e.version;
    if (!isComplete(dirOf(e.version))) {
      const lf = readState().lightFirst;
      if (lf && got === 'full' && lf.full !== e.version && standingIn(active)) {   // a newer full model while the light one stands in
        const t = readState();
        t.lightFirst = { ...lf, full: e.version };
        await writeState(t);
      }
      await tidy(active && active.version);
      const waiting = await askBefore(e, got, await bytesToFetch(e));
      if (waiting) { notePhase({ outcome: 'ask', what: 'model', version: e.version, size: fmtSize(asking && asking.bytes) }); return { ...waiting, phase: true }; }
      notePhase({ outcome: 'downloading', what: 'model', version: e.version });
      // No model yet: the CUDA pack this full model will wait for (its bytes count in needed() and the timing).
      const pack = first && got === 'full' ? await pendingPack(m, tag) : null;
      let packNeed = 0;
      if (pack) {
        const f = pack.files[0];
        const have = await fsp.stat(path.join(cuda.packsDir, pack.version + '.partial', f.name)).then((st) => Math.min(st.size, f.size), () => 0);
        packNeed = f.size - have;
        firstPack = true;
        packProgress = { done: have, total: f.size };
      }
      const light = first && got === 'full' ? await lightCandidate(m, tag, e) : null;
      if (light) {
        // Decided once already (a restart, a retry): the light model straight away.
        const decided = lf && lf.full === e.version && lf.light === light.version;
        if (decided || (await fetchTimed(e, tag, light, packNeed)) === 'slow') {
          firstPack = false;
          if (await standIn(light, e, tag)) return { state, more: true };   // the CUDA pack, then the rest of the full model
          if (pack) firstPack = true;   // the light model did not start: the full one after all
          await fetchVersion(e, tag);
        }
      } else {
        // Unthrottled: the full model while the light one stands in, and the light one replacing a full
        // model left on the processor (the CUDA pack set aside), like the first model and the pack.
        await fetchVersion(e, tag, { hurry: standingIn(active) || (got === 'light' && asideTag === tag) });
      }
    } else {
      notePhase({ outcome: 'downloading', what: 'model', version: e.version });
    }
    // No model yet and the GPU path pending: the CUDA pack, then the full model's first start with it.
    if (!haveModel() && got === 'full') {
      const pack = await pendingPack(m, tag);
      if (pack) {
        firstPack = true;
        // 'installed': activate() starts the two together; 'ask': the full model on the processor meanwhile;
        // 'failed' (set aside): the full model on the processor, and Automatic then goes to the light one.
        if ((await packBeforeFull(pack, tag)) === 'failed') return { ...(await activate(e.version, tag, e.version, want, { variant: got })), more: true };
      }
    }
    firstPack = false;
    return activate(e.version, tag, e.version, want, { variant: got });
  }

  /**
   * The entry the live manifest names for `want` now (signature checked), or null when it cannot be read
   * (offline, refused): read again just before a downloaded version is switched to, so a newer one
   * published meanwhile is fetched instead of stepping through the older one.
   */
  async function liveEntry(want) {
    try {
      const res = await fetch(routes() + '/manifest', { headers: auth(), signal: AbortSignal.timeout(30e3) });
      if (!res.ok) { await res.body?.cancel().catch(() => {}); return null; }
      const text = await res.text();
      if (checkSignature(text, res.headers.get('x-typd-manifest-key'), res.headers.get('x-typd-manifest-sig'), keys)) return null;
      const m = JSON.parse(text);
      if (checkManifest(m) || !Number.isSafeInteger(m.seq)) return null;
      return selectVariant(m, want).entry;
    } catch {
      return null;
    }
  }

  /* -------------------------------------------------------------- the CUDA pack */

  const packTotal = () => packProgress.total || (packAsking && packAsking.bytes) || 0;

  /**
   * The CUDA pack, after the model: nothing to do when this build names none, a CUDA backend is already
   * here, or the hardware does not take the GPU path. Else the manifest's entry for this build's pack is
   * downloaded (asking first on a metered connection), checked, installed and switched to. Resolves
   * {pack: state, next?}; throws Retry like a model download.
   */
  async function followPack(m, tag) {
    if (!cuda || !cuda.id || !cuda.packsDir) { if (packState !== 'off') setPack('off'); return null; }
    await cuda.prepare();
    if (cuda.have()) { packTarget = null; packHurry = false; await cuda.tidy({ partials: false }); return setPack('current'); }
    let wanted = false;
    try { wanted = Boolean(await cudaWanted()); } catch { wanted = false; }
    if (!wanted) { packTarget = null; packHurry = false; return setPack('unwanted'); }
    const e = selectPack(m, cuda.id);
    if (!e) { log('the manifest has no CUDA pack for', cuda.id, '- llama.cpp stays on the processor'); packHurry = false; return setPack('none'); }
    if (older(appVersion, e.min_app)) { log(e.version, 'needs Typd', e.min_app); packHurry = false; return setPack('app'); }
    const bad = cuda.badTag();
    if (bad !== null && bad === tag) { packHurry = false; return setPack('failed'); }   // set aside under this very manifest
    packTarget = e.version;
    const f = e.files[0];
    const zipFile = path.join(cuda.packsDir, e.version + '.partial', f.name);
    const have = await fsp.stat(zipFile).then((st) => Math.min(st.size, f.size), () => 0);
    const waiting = await askBefore(e, 'pack', f.size - have, 'pack');
    if (waiting) { packHurry = false; notePhase({ outcome: 'ask', what: 'pack', version: e.version, size: fmtSize(f.size - have) }); return waiting; }
    notePhase({ outcome: 'downloading', what: 'pack', version: e.version });
    await fetchPack(e, tag, zipFile);
    return activatePack(e, tag);
  }

  /** The zip into <packsDir>/<version>.partial/, checked against the manifest, then installed (cudaPack.install). */
  async function fetchPack(e, tag, zipFile) {
    const f = e.files[0];
    await fsp.mkdir(path.dirname(zipFile), { recursive: true });
    const have = await fsp.stat(zipFile).then((st) => Math.min(st.size, f.size), () => 0);
    const left = f.size - have;
    let free = Infinity;
    try { const st = await statfs(cuda.packsDir); free = Number(st.bavail) * Number(st.bsize); } catch { /* unknown: try */ }
    const room = (left + cuda.total()) * SPACE_FACTOR;   // the rest of the zip, then what it unpacks to
    if (free < room) {
      log('not enough disk space for the CUDA pack', e.version, '- need', Math.round(room / 1e6), 'MB, have', Math.round(free / 1e6));
      throw Object.assign(new Retry('no space for the CUDA pack', cadence.every()), { space: true, pack: true });
    }
    packProgress = { done: have, total: f.size };
    setPack('downloading');
    log('downloading the CUDA pack', f.name, have ? `from byte ${have}` : '');
    try {
      await download(e.version, f, zipFile, packProgress, true);
    } catch (err) {
      throw Object.assign(err, { pack: true });
    }
    const size = (await fsp.stat(zipFile)).size;
    const sha = size === f.size ? await sha256File(zipFile) : null;
    if (sha !== f.sha256) {
      await fsp.rm(zipFile, { force: true });
      throw Object.assign(new Retry(`${f.name} failed verification (${size} bytes, sha256 ${sha && sha.slice(0, 12)}); downloading it again`), { pack: true });
    }
    log('verified', f.name, '- it matches the manifest; unpacking');
    setPack('installing');
    try {
      await cuda.install(zipFile, e.version);
    } catch (err) {
      if (err && typeof err.code === 'string') throw Object.assign(new Retry('unpacking the CUDA pack: ' + err.message), { pack: true });   // the disk, not the pack
      // The zip is the one the manifest signed, yet its files are not this build's: a bad pack.
      await fsp.rm(path.dirname(zipFile), { recursive: true, force: true }).catch(() => {});
      await cuda.markBad('its files are not this build\'s: ' + ((err && err.message) || err), tag);
      throw Object.assign(new Error('the CUDA pack does not match this build'), { badPack: true });
    }
    await fsp.rm(path.dirname(zipFile), { recursive: true, force: true }).catch(() => {});
  }

  /** Restart llama-server on the pack once nothing is being dictated; set it aside if the server does not come up. */
  async function activatePack(e, tag) {
    setPack('ready');
    await waitIdle();
    switching = true;   // this start judges the backend, not a model (warmed() stays out of it)
    try {
      log('switching llama.cpp to the CUDA backend', e.version);
      try {
        await switchBackend();
      } catch (err) {
        await cuda.markBad('llama-server did not start with it: ' + ((err && err.message) || err), tag);
        try { await switchBackend(); } catch (e2) { log('llama-server did not start on the processor either:', e2 && e2.message); }
        packTarget = null;
        packHurry = false;
        return setPack('failed');
      }
      log('now running with the CUDA backend', e.version);
      packTarget = null;
      packHurry = false;
      return setPack('current');
    } finally {
      switching = false;
    }
  }

  /** One check, never two at once. Resolves {state, next}: when the next check is due. */
  function check() {
    if (running) return running;
    running = (async () => {
      try {
        const r = await run();
        failures = 0;
        // Still no model (no manifest, refused, a newer Typd needed, waiting for an answer): look again sooner.
        if (!r.phase) notePhase({ outcome: r.state === 'ask' || r.state === 'later' ? 'ask' : r.state === 'app' ? 'app' : r.state === 'refused' ? 'error' : 'current', why: r.why });
        return { next: haveModel() ? cadence.next() : needEveryMs, ...r };
      } catch (err) {
        if (revoked) { log('the server refused the key; updates stopped until restart'); return { ...set('stopped'), next: null }; }
        if (err && err.badPack) { log((err && err.message) || err); failures = 0; notePhase({ outcome: 'current' }); return { ...setPack('failed'), state, next: cadence.every() }; }
        notePhase({ outcome: !online() || /offline|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|timeout/i.test(String(err && err.message)) ? 'offline' : 'error', why: String((err && err.message) || err) });
        if (!(err instanceof Retry)) log('update error:', (err && err.stack) || err);
        failures++;
        // No model yet, or the CUDA pack wanted and not here: retried in seconds, not minutes.
        const hurry = !haveModel() || packHurry;
        let next = err.after || Math.min(hurry ? needBackoffMaxMs : BACKOFF_MAX_MS, (hurry ? needBackoffMinMs : BACKOFF_MIN_MS) * 2 ** (failures - 1));
        if (!err.after) next = next / 2 + Math.random() * (next / 2);
        next = Math.min(Math.max(next, 1000), err.after ? 86400e3 : cadence.every());
        if (/429/.test(err.message)) notBefore = Date.now() + next;
        log((err && err.message) || err, '- next try in', Math.round(next / 1000), 's');
        if (err.space && err.pack) return { ...setPack('space'), state, next };
        if (err.space) return { ...set('space'), next };
        if (err.pack) {
          if (['downloading', 'installing', 'ready'].includes(packState)) setPack('retrying');
          return { state: 'retry', pack: packState, next, why: err.message };
        }
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
    if (!haveModel()) {
      const n = needed();
      switch (n.state) {   // the model's state, or the CUDA pack's while it comes before the first start
        case 'downloading': return `Speech model · downloading ${n.pct} % of ${n.size}`;
        case 'retrying': return `Speech model · downloading ${n.pct} % of ${n.size} (paused)`;
        case 'ready': return 'Speech model · getting ready';
        case 'ask': case 'later': return `Speech model · ${n.size} to download`;
        case 'offline': return 'Speech model · waiting for the internet';
        case 'space': return `Speech model · needs more disk space (${n.size})`;
        case 'app': return 'Speech model · needs a newer Typd';
        default: return 'Speech model · not downloaded yet';
      }
    }
    switch (state) {
      case 'current': return `Model ${label} · up to date`;
      case 'downloading': return `Model ${label} · updating ${pct} %`;
      case 'retrying': return `Model ${label} · updating ${pct} % (paused)`;
      case 'ready': return `Model ${label} · switching to ${target} when idle`;
      case 'failed': return `Model ${label} · update failed`;
      case 'app': return `Model ${label} · update needs a newer Typd`;
      case 'space': return `Model ${label} · update needs more disk space`;
      case 'ask': return `Model ${label} · new model available (${fmtSize(asking && asking.bytes)})`;
      case 'later': return `Model ${label} · new model waiting (${fmtSize(asking && asking.bytes)})`;
      default: return `Model ${label}`;
    }
  }

  /**
   * The CUDA pack's line for the tray and Settings, or null when there is nothing to say (no pack for
   * this build, the GPU path not taken, CUDA already here, the manifest naming none).
   */
  function packLine() {
    if (!config || !cuda || !cuda.id) return null;
    const total = packTotal();
    const pct = packProgress.total ? Math.floor((100 * packProgress.done) / packProgress.total) : 0;
    switch (packState) {
      case 'downloading': return `GPU acceleration · downloading ${pct} % of ${fmtSize(total)}`;
      case 'retrying': return `GPU acceleration · downloading ${pct} % of ${fmtSize(total)} (paused)`;
      case 'installing': return 'GPU acceleration · unpacking';
      case 'ready': return 'GPU acceleration · switching on when idle';
      case 'ask': return `GPU acceleration available (${fmtSize(total)})`;
      case 'later': return `GPU acceleration waiting (${fmtSize(total)})`;
      case 'offline': return 'GPU acceleration · waiting for the internet';
      case 'space': return 'GPU acceleration · needs more disk space';
      case 'failed': return 'GPU acceleration did not start · using the processor';
      default: return null;
    }
  }

  /**
   * The CUDA pack, for Settings: {state, pct, bytes, size, version, why}, or null when this build has
   * no pack. state 'current' means a CUDA backend is here (bundled or installed).
   */
  function packInfo() {
    if (!cuda || !cuda.id) return null;
    const total = packTotal();
    return {
      state: packState, pct: packProgress.total ? Math.floor((100 * packProgress.done) / packProgress.total) : 0,
      bytes: total, size: total ? fmtSize(total) : null, version: packTarget || (packAsking && packAsking.version) || null,
      why: packAsking ? packAsking.why : null, cuda: cuda.state(), line: packLine()
    };
  }

  /** The question on screen: the model's first (it always comes first), else the CUDA pack's. */
  const askingNow = () => (asking && (state === 'ask' || state === 'later') ? asking
    : packAsking && (packState === 'ask' || packState === 'later') ? packAsking : null);

  /** "Update now": this version (the model's, or the pack's) may download, now and whenever its download resumes. */
  async function approve() {
    const a = askingNow();
    if (!a) return false;
    const s = readState();
    if (a.kind === 'pack') { s.packApproved = { version: a.version, at: new Date(now()).toISOString() }; delete s.packLater; }
    else { s.approved = { version: a.version, at: new Date(now()).toISOString() }; delete s.later; }
    await writeState(s);
    log('approved:', a.version, fmtSize(a.bytes));
    if (started) schedule(0); else changed();
    return true;
  }

  /** "Later": ask again after laterMs (the scheduled checks keep running; none asks before then). */
  async function later() {
    const a = askingNow();
    if (!a) return false;
    const s = readState();
    const key = a.kind === 'pack' ? 'packLater' : 'later';
    s[key] = { version: a.version, until: now() + laterMs };
    await writeState(s);
    log('later:', a.version, 'asked again after', new Date(s[key].until).toISOString());
    if (a.kind === 'pack') setPack('later'); else set('later');
    if (started && !running) schedule(Math.min(cadence.every(), laterMs + 1000));
    return true;
  }

  /**
   * The first model, while there is none: {state, done, total, pct, bytes, size, estimate, version,
   * variant}; null once a model is here. `bytes` is what the download is (the manifest's sizes, or
   * EXPECTED_BYTES for the variant this machine wants before any manifest was read: estimate true).
   */
  function needed() {
    if (haveModel()) return null;
    const want = fetchingLight ? 'light' : chosen.got || chosen.want || 'full';
    // On the GPU path the CUDA pack comes before the full model's first start: its bytes count too, and
    // once the model's files are all here, its state is the download's.
    const pk = firstPack && packProgress.total ? packProgress : { done: 0, total: 0 };
    const total = progress.total + pk.total, done = progress.done + pk.done;
    const known = total || (asking && asking.bytes) || 0;
    const bytes = known || expectedBytes[want] || expectedBytes.full;
    const pct = total ? Math.floor((100 * done) / total) : 0;
    let st = state;
    if (firstPack && progress.total && progress.done >= progress.total && ['downloading', 'retrying', 'installing', 'ready', 'space', 'offline'].includes(packState)) {
      st = packState === 'installing' ? 'ready' : packState;
    }
    return {
      state: st, done: total ? done : 0, total, pct, bytes, size: fmtSize(bytes),
      estimate: !known, version: target || (asking && asking.version) || null, variant: want, why: asking ? asking.why : null,
      lightFirst: Boolean(fetchingLight)   // the light model first, so dictation starts sooner (the full one follows)
    };
  }

  /**
   * Light first: while the light model stands in for the full one, what Home says about it --
   * {phase: 'pack'|'full', state: 'downloading'|'retrying'|'ready'|'ask'|'space'|'waiting', pct, size,
   * light, full} (phase 'pack': the CUDA pack comes first, on the GPU path) -- else null (no stand-in,
   * or the full model failed, needs a newer Typd, or is not published: the light model is then simply
   * the model).
   */
  function interim() {
    if (!config) return null;
    const lf = readState().lightFirst;
    if (!lf) return null;
    const a = activeModel(modelsDir);
    if (!a || a.version !== lf.light) return null;
    if (['failed', 'app', 'none', 'refused', 'stopped'].includes(state)) return null;
    const pctOf = (p) => (p.total ? Math.floor((100 * p.done) / p.total) : null);
    const map = { downloading: 'downloading', retrying: 'retrying', ready: 'ready', installing: 'ready', ask: 'ask', later: 'ask', space: 'space' };
    if (map[state]) {
      const ask = map[state] === 'ask';
      const bytes = ask ? asking && asking.bytes : progress.total;
      return { phase: 'full', state: map[state], pct: ask ? null : pctOf(progress), size: bytes ? fmtSize(bytes) : null, light: lf.light, full: target || lf.full };
    }
    if (map[packState]) {
      const ask = map[packState] === 'ask';
      const bytes = ask ? packAsking && packAsking.bytes : packProgress.total;
      return { phase: 'pack', state: map[packState], pct: ask ? null : pctOf(packProgress), size: bytes ? fmtSize(bytes) : null, light: lf.light, full: lf.full };
    }
    return { phase: 'full', state: 'waiting', pct: null, size: null, light: lf.light, full: lf.full };
  }

  return {
    check,
    warmed,
    line,
    packLine,
    packInfo,
    needed,
    interim,
    haveModel,
    approve,
    later,
    onChange: (fn) => listeners.push(fn),
    /**
     * Launch: first check after FIRST_CHECK_MS (FIRST_NEED_MS with no model at all, or with the CUDA pack
     * wanted and not here yet: a download a quit cut short), then every 6 hours.
     */
    start() {
      if (!config) return;
      started = true;
      if (!haveModel()) {
        // Which variant, before the first check: so needed() names the right size at once.
        Promise.resolve().then(() => variant()).then((w) => { if (w && !chosen.got) { chosen = { ...chosen, want: String(w) }; changed(); } }, () => {});
        schedule(firstNeedMs);
        return;
      }
      if (!cuda || !cuda.id) { schedule(firstCheckMs); return; }
      packMissing().then((h) => { if (!running) schedule(h ? firstNeedMs : firstCheckMs); }, () => schedule(firstCheckMs));
    },
    /** Back from sleep or offline, or the model choice changed: check soon (never before a 429's Retry-After). */
    wake(ms = firstCheckMs) { if (config && !running) schedule(ms); },
    /** Woken from sleep or unlocked: a check soon if the last one is 15 minutes old (checkCadence.js). True if one was set. */
    wakeIfDue(ms = WAKE_DELAY_MS) {
      if (!config || running || !cadence.wakeDue()) return false;
      schedule(ms);
      return true;
    },
    /**
     * "Check for updates": a check now. Resolves as soon as the manifest has been read: {outcome:
     * 'current' | 'downloading' | 'ask' | 'app' | 'offline' | 'error' | 'busy' | 'off', what, version,
     * why}. A check or download already under way answers at once with where it is.
     */
    checkNow() {
      if (!config) return Promise.resolve({ outcome: 'off' });
      // A download or switch under way: say where it is. A check just finishing: wait for it, then look again.
      if (running && ['downloading', 'retrying', 'ready'].includes(state)) return Promise.resolve({ outcome: 'downloading', what: 'model', version: target });
      if (running && ['downloading', 'retrying', 'installing', 'ready'].includes(packState)) return Promise.resolve({ outcome: 'downloading', what: 'pack', version: packTarget });
      return (running ? running.catch(() => {}) : Promise.resolve()).then(() => {
        if (notBefore > Date.now()) return { outcome: 'busy', retryAt: new Date(notBefore).toISOString() };
        return new Promise((resolve) => {
          phaseWaiters.push(resolve);
          // Straight away, not through the timer (a check just ending reschedules it); the next regular check after.
          check().then((r) => { if (started) schedule(r.next); }, () => {});
        });
      });
    },
    get lastOutcome() { return lastOutcome; },
    get cadence() { return cadence; },
    stop() { clearTimeout(timer); timer = null; },
    get state() { return state; },
    get packState() { return packState; },
    /**
     * A download waiting for "Update now": {version, variant, bytes, size, why, later, first, kind}, else
     * null. first: there is no model yet. kind: 'model', or 'pack' (the CUDA pack, asked after the model).
     */
    get pending() {
      const a = askingNow();
      if (!a) return null;
      const isLater = a.kind === 'pack' ? packState === 'later' : state === 'later';
      return { ...a, kind: a.kind || 'model', size: fmtSize(a.bytes), later: isLater, first: a.kind !== 'pack' && !haveModel() };
    },
    /** The variant the last check wanted, and the one the manifest gave ({want, got}). */
    get chosen() { return { ...chosen }; }
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
  const tester = readConfig(packaged ? require('./carried').pick(resourcesPath, userData, 'tester.json') : path.join(repoDir, 'tester.json'));
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
 *   variant       () => Promise<'full'|'light'>: which entry to follow (modelChoice.js)
 *   askFirst      () => boolean: Settings' "Ask before downloading new models"
 *   networkCost   () => Promise<'metered'|'unmetered'|'unknown'> (netcost.js)
 *   cuda          local.cuda: the CUDA pack for this build (cudaPack.js), or null
 *   cudaWanted    () => Promise<boolean>: the hardware takes the GPU path (modelChoice.cuda)
 *   switchBackend () => Promise: restart the model server on the backend now there
 *   automatic     () => boolean: the variant is Automatic's pick (modelChoice.automatic): light first
 */
function start({ bundledDir, busy, switchModel, onWarm, changed, variant, askFirst, networkCost, cuda, cudaWanted, switchBackend, automatic }) {
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
    stats: () => require('./versionStats').statsHeaders(),
    ...(variant ? { variant } : {}),
    ...(askFirst ? { askFirst } : {}),
    ...(networkCost ? { networkCost } : {}),
    ...(automatic ? { automatic } : {}),
    ...(cuda && cuda.id ? { cuda, ...(cudaWanted ? { cudaWanted } : {}), ...(switchBackend ? { switchBackend } : {}) } : {})
  });
  if (onWarm) onWarm((r) => main.warmed(r));
  if (changed) main.onChange(changed);
  if (config) {
    debug('model updates on, from', config.endpoint, config.key ? '(with a key)' : '(public routes, no key)');
    main.start();
    // Woken or unlocked: a check if the last one is 15 minutes old (checkCadence.js).
    powerMonitor.on('resume', () => main.wakeIfDue());
    powerMonitor.on('unlock-screen', () => main.wakeIfDue());
  }
  return main;
}

/** For the tray: one line, or null when this build does not follow model updates. */
function line() {
  return main ? main.line() : null;
}

/** The first model's download while there is no model (see createUpdater's needed()), else null. */
const needed = () => (main ? main.needed() : null);
/** Light first: the light model standing in while the full one comes (see createUpdater's interim()), else null. */
const interim = () => (main ? main.interim() : null);

/** Whether this build follows model updates at all (so the model choice means something). */
const following = () => Boolean(main && main.line() !== null);
/** A download waiting for "Update now", or null. */
const pending = () => (main ? main.pending : null);
/** "Update now" / "Later" (the tray, Settings). */
const approve = () => (main ? main.approve() : Promise.resolve(false));
const later = () => (main ? main.later() : Promise.resolve(false));
/** The model choice changed in Settings: check again soon. */
const recheck = (ms = 1500) => { if (main) main.wake(ms); };
/** {want, got} from the last check. */
const chosen = () => (main ? main.chosen : null);
/** "Check for updates" (index.js): a check now, resolved once the manifest is read (createUpdater's checkNow()). */
const checkNow = () => (main ? main.checkNow() : Promise.resolve({ outcome: 'off' }));
/** The CUDA pack's tray line, or null (see createUpdater's packLine()). */
const packLine = () => (main ? main.packLine() : null);
/** The CUDA pack, for Settings, or null (see createUpdater's packInfo()). */
const packInfo = () => (main ? main.packInfo() : null);

module.exports = {
  start, line, needed, interim, following, pending, approve, later, recheck, chosen, packLine, packInfo, checkNow,
  createUpdater, activeModel, activeVersion, versionOf, readCurrent, isComplete, checkManifest, checkSignature, selectVariant, selectPack, fmtSize, labelOf, older, sha256File, readConfig, findConfig,
  ENDPOINT, SIG_PREFIX, ASK_ABOVE_BYTES, LATER_MS, EXPECTED_BYTES, PROBE_MS, LIGHT_FIRST_ABOVE_MS
};
