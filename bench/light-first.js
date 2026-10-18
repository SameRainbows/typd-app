'use strict';

/**
 * Light first, full later (0.2.6), and never the full model on the processor while the GPU path is
 * pending. Without Electron, a GPU or the network: the real updater (modelUpdate.js), the real hardware
 * and model-choice code fed a fake nvidia-smi, the real CUDA pack code with a fake pack, against a local
 * fake of typd-collect (bench/fake-model-server.js), in throwaway profiles. The timing window and the
 * threshold are shrunk (probeMs, lightFirstAboveMs); the fake server's `slow` makes a link slow.
 *
 *   - a fast link: the full model and the pack, no light model at all (not one request for it), one start
 *   - a link that would finish within the threshold: timed, kept going, no light model
 *   - a slow link (fake NVIDIA 4 GB): the full download pauses, the light model is fetched, checked and
 *     switched to (dictation can start); then the CUDA pack (a backend switch on the light model); then
 *     the full model resumed with Range (never from zero); the switch to it waits for a dictation in
 *     progress; Home's card says the light model is in use and how far the full one is; afterwards the
 *     light model is deleted and the full model runs with the pack, never having run on the processor
 *   - a cut full download: the light model stays in use, the next check resumes with Range
 *   - a pack that llama-server does not start with: the light model stays, the full one is not switched to
 *     (Automatic follows the light model); a first start of full + pack that fails: set aside, then light
 *   - a metered connection: asked as today, nothing fetched without an OK, no light model
 *   - updates from 0.2.5 with a model (full with CUDA, light, full without the pack): nothing re-downloaded
 *   - no NVIDIA GPU: the light model only, as before; a pin of Full: no light model
 *   - the app's wiring (source checks)
 *
 *   node bench/light-first.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createUpdater } = require('../src/main/modelUpdate');
const { createCuda } = require('../src/main/cudaPack');
const hardware = require('../src/main/hardware');
const { createChoice } = require('../src/main/modelChoice');
const status = require('../src/main/status');
const zip = require('../src/main/zip');
const { fakeModelServer, sha } = require('./fake-model-server');

let failures = 0, passes = 0;
function check(name, ok, detail) {
  if (!ok) failures++; else passes++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + JSON.stringify(detail).slice(0, 700) : ''));
}
const section = (s) => console.log('\n' + s);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-light-first-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const exists = (p) => fs.existsSync(p);
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
async function until(cond, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await sleep(20); }
  return Boolean(await cond());
}

/* ------------------------------------------------- a fake CUDA backend and its pack */

const PACK = 'cuda-b99999-cu12.4';
const ZIP = 'cuda-pack-b99999-cu12.4.zip';
const blob = (n, seed) => { const unit = crypto.createHash('sha256').update(seed).digest(); const b = Buffer.alloc(n); for (let i = 0; i < n; i += 32) unit.copy(b, i); b.writeUInt32LE(n, 0); return Buffer.concat([b, crypto.randomBytes(1024)]); };
const DLLS = { 'ggml-cuda.dll': blob(200000, 'ggml-cuda'), 'cublas64_12.dll': blob(60000, 'cublas'), 'cublasLt64_12.dll': blob(90000, 'cublasLt'), 'cudart64_12.dll': blob(9000, 'cudart') };
const DESC = { schema: 'typd-cuda/1', pack: PACK, llama: { build: 99999, commit: 'fakecommit' }, cuda: '12.4', files: Object.entries(DLLS).map(([name, b]) => ({ name, size: b.length, sha256: sha(b) })) };
async function packZip() {
  const out = path.join(tmp, 'pack.zip');
  await zip.write(out, [{ name: 'pack.json', data: JSON.stringify(DESC), method: zip.DEFLATE }, ...Object.entries(DLLS).map(([name, b]) => ({ name, data: b, method: zip.DEFLATE }))]);
  // Padded with stored random bytes, so the pack takes a moment on a slow link like the real one.
  return fs.readFileSync(out);
}

/* --------------------------------------------------------------------- models */

const FULL_MODEL = 'typd-dictate-1.7b.gguf';
const MODELS = {
  full: { version: 'full_a', files: { [FULL_MODEL]: crypto.randomBytes(1500000), 'mmproj-1.7b.gguf': crypto.randomBytes(300000), 'typd-revise.gguf': crypto.randomBytes(100000) } },
  light: { version: 'light_a', files: { 'typd-dictate-0.6b.gguf': crypto.randomBytes(400000), 'mmproj-0.6b.gguf': crypto.randomBytes(200000) } }
};
MODELS.full.model_json = { model: FULL_MODEL, mmproj: 'mmproj-1.7b.gguf', context: true, revise: true, revise_lora: 'typd-revise.gguf' };
MODELS.light.model_json = { model: 'typd-dictate-0.6b.gguf', mmproj: 'mmproj-0.6b.gguf', context: true, revise: true };
const FULL_BYTES = Object.values(MODELS.full.files).reduce((s, b) => s + b.length, 0);

let PACKZIP = null;
const publishAll = (s) => s.publish({ full: MODELS.full, light: MODELS.light, packs: { [PACK]: { version: PACK, files: { [ZIP]: PACKZIP }, min_app: '0.2.5' } } });

/* -------------------------------------------------------------------- hardware */

const SMI = { none: null, nvidia4: 'NVIDIA GeForce RTX 3050 Ti Laptop GPU, 4096, 3900' };
function choiceFor(hw, setting = 'auto') {
  const run = async () => (SMI[hw] ? { code: 0, stdout: SMI[hw] + '\n' } : { code: -1, stdout: '' });
  return createChoice({ setting: () => setting, detect: () => hardware.detect({ platform: 'win32', run, env: { SystemRoot: path.join(tmp, 'win'), ProgramFiles: path.join(tmp, 'pf') } }) });
}

/* --------------------------------------------------------------------- profiles */

let n = 0;
/**
 * A fresh install of the public build: llama-server (CPU) with cuda.json, no model in the app, an empty
 * userData -- or, with `installed`, a model already downloaded by 0.2.5 (current.json without "variant").
 */
function profile(s, { hw = 'nvidia4', setting = 'auto', installed = null, bundledCuda = false, ...over } = {}) {
  const root = path.join(tmp, 'p' + (++n));
  const llamaDir = path.join(root, 'resources', 'llama');
  const bundledDir = path.join(root, 'resources', 'models', 'typd-dictate');
  const modelsDir = path.join(root, 'userData', 'models');
  const packsDir = path.join(root, 'userData', 'cuda');
  fs.mkdirSync(llamaDir, { recursive: true });
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.writeFileSync(path.join(llamaDir, 'llama-server.exe'), 'the CPU build');
  fs.writeFileSync(path.join(llamaDir, 'cuda.json'), JSON.stringify(DESC, null, 1));
  if (bundledCuda) for (const [name, b] of Object.entries(DLLS)) fs.writeFileSync(path.join(llamaDir, name), b);
  fs.writeFileSync(path.join(bundledDir, 'NO_MODEL.txt'), 'downloaded at first launch\n');
  if (installed) {
    const m = MODELS[installed];
    const dir = path.join(modelsDir, m.version);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, b] of Object.entries(m.files)) fs.writeFileSync(path.join(dir, name), b);
    fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(m.model_json));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: m.version, files: Object.entries(m.files).map(([name, b]) => ({ name, size: b.length, sha256: sha(b) })), model_json: m.model_json }));
    fs.writeFileSync(path.join(modelsDir, 'current.json'), JSON.stringify({ version: m.version, previous: null, confirmed: true }));
  }
  const cuda = createCuda({ llamaDir, packsDir });
  const choice = choiceFor(hw, setting);
  const ev = [];
  const logs = [];
  const box = { dictating: false };
  const u = createUpdater({
    keys: s.keys, config: { endpoint: s.endpoint, key: null }, modelsDir, bundledDir, appVersion: '0.2.6',
    switchModel: async () => { ev.push({ what: 'model', at: Date.now(), version: (readJson(path.join(modelsDir, 'current.json')) || {}).version || null, cuda: cuda.state(), dictating: box.dictating }); },
    switchBackend: async () => { ev.push({ what: 'backend', at: Date.now(), cuda: cuda.state(), version: (readJson(path.join(modelsDir, 'current.json')) || {}).version || null }); },
    busy: () => box.dictating,
    cuda, cudaWanted: () => choice.cuda(), variant: () => choice.variant(), automatic: () => choice.automatic(),
    rate: 1, idleMs: 150, firstCheckMs: 60e3, firstNeedMs: 50, needBackoffMinMs: 100, needBackoffMaxMs: 400, offlinePollMs: 150,
    networkCost: async () => 'unmetered', probeMs: 300, lightFirstAboveMs: 100,
    log: (...a) => logs.push(a.join(' ')),
    ...over
  });
  return { root, u, cuda, choice, ev, logs, box, llamaDir, bundledDir, modelsDir, packsDir, current: () => readJson(path.join(modelsDir, 'current.json')), state: () => readJson(path.join(modelsDir, 'state.json')) || {} };
}
const lightReqs = (s) => s.fileRequests().filter((q) => q.url.includes('/light_a/'));
const fullReqs = (s) => s.fileRequests().filter((q) => q.url.includes('/full_a/'));
const packReqs = (s) => s.fileRequests().filter((q) => q.url.includes('/' + PACK + '/'));
const fullModelFileReqs = (s) => s.fileRequests().filter((q) => q.url.endsWith('/full_a/' + FULL_MODEL));
const models = (p) => p.ev.filter((e) => e.what === 'model');
const backends = (p) => p.ev.filter((e) => e.what === 'backend');

(async () => {
  PACKZIP = await packZip();
  const s = await fakeModelServer();

  section('a fast link (fake NVIDIA 4 GB): the full model and the pack, no light model at all');
  {
    publishAll(s);
    s.requests = [];
    s.slow = 0;
    const p = profile(s);
    const r = await p.u.check();
    check('one check: the full model, then the pack; current', r.state === 'current' && p.u.packState === 'current' && p.current().version === 'full_a', { r, ps: p.u.packState });
    check('not one request for the light model', lightReqs(s).length === 0, s.fileRequests().map((q) => q.url));
    check('the full model\'s 3 files once each, then the pack once', fullReqs(s).length === 3 && packReqs(s).length === 1 && Math.max(...fullReqs(s).map((q) => q.at)) <= packReqs(s)[0].at, s.fileRequests().map((q) => q.url));
    check('one start, of the full model with the pack installed (never on the processor)', models(p).length === 1 && models(p)[0].version === 'full_a' && models(p)[0].cuda === 'installed' && backends(p).length === 0, p.ev);
    check('no light-first marker; the timing said nothing (it finished first)', !p.state().lightFirst && !p.logs.some((l) => /light first\?/.test(l)), p.logs.filter((l) => /light/.test(l)));
    check('current.json records the variant', p.current().variant === 'full', p.current());
  }

  section('a link that would finish within the threshold: timed, kept going, no light model');
  {
    publishAll(s);
    s.requests = [];
    s.slow = 25;
    const p = profile(s, { probeMs: 150, lightFirstAboveMs: 60e3 });
    const r = await p.u.check();
    s.slow = 0;
    check('timed, then kept going ("the full model keeps going")', p.logs.some((l) => /light first\? no: the full model keeps going/.test(l)), p.logs.filter((l) => /light/.test(l)));
    check('no light request; the full model and the pack, one start with both', r.state === 'current' && lightReqs(s).length === 0 && models(p).length === 1 && models(p)[0].cuda === 'installed', { r, ev: p.ev });
    check('the full model file was fetched once, from the start (no pause)', fullModelFileReqs(s).length === 1 && fullModelFileReqs(s)[0].range === null, fullModelFileReqs(s));
  }

  section('a slow link (fake NVIDIA 4 GB): light first, then the pack, then the full model');
  {
    publishAll(s);
    s.requests = [];
    s.slow = 40;   // ~1.6 MB/s: the full model ~1.2 s, past the shrunk 100 ms threshold
    const p = profile(s);
    const seen = [];   // what needed() and Home said, in order
    const cards = [];
    p.u.onChange(() => {
      const nd = p.u.needed();
      if (nd) seen.push({ at: Date.now(), state: nd.state, lightFirst: nd.lightFirst, variant: nd.variant, size: nd.size });
      if (p.u.haveModel()) {
        status.set({ model: 'ready', modelFetch: null, interim: p.u.interim() });
        const c = status.describe().card;
        if (cards[cards.length - 1] !== c) cards.push(c);
      }
    });
    // A dictation begins as soon as the light model has GPU acceleration and lasts until we end it.
    const going = p.u.check();
    check('the light model is switched to while the full one is not yet here', await until(() => models(p).length >= 1, 15000) && models(p)[0].version === 'light_a' && !exists(path.join(p.modelsDir, 'full_a')), { ev: p.ev });
    const lightAt = models(p)[0].at;
    const pausedAt = fs.statSync(path.join(p.modelsDir, 'full_a.partial', FULL_MODEL)).size;
    check(`the full download paused with its bytes kept (${pausedAt} of ${MODELS.full.files[FULL_MODEL].length} B of the model file)`, pausedAt > 0 && pausedAt < MODELS.full.files[FULL_MODEL].length, pausedAt);
    check('the light model on the processor: the pack was not here yet', models(p)[0].cuda === 'missing');
    check('its two files were fetched after the full model\'s first request, and checked (model.json, manifest.json)',
      lightReqs(s).length === 2 && lightReqs(s).every((q) => q.at > fullModelFileReqs(s)[0].at) && ['model.json', 'manifest.json'].every((f) => exists(path.join(p.modelsDir, 'light_a', f))), lightReqs(s));
    check('needed() said the light model came first while it downloaded', seen.some((x) => x.lightFirst && x.variant === 'light' && x.state === 'downloading'), seen.slice(-6));
    check('state.json marks the light model as standing in for the full one', p.state().lightFirst && p.state().lightFirst.light === 'light_a' && p.state().lightFirst.full === 'full_a', p.state());
    // Dictating from the moment the light model got GPU acceleration until we stop it.
    check('then the pack: a backend switch on the light model, with the pack installed', await until(() => backends(p).length === 1, 15000) && backends(p)[0].cuda === 'installed' && backends(p)[0].version === 'light_a' && packReqs(s).length === 1 && packReqs(s)[0].at > lightAt, { ev: p.ev });
    p.box.dictating = true;
    check('then the full model downloads; Home: "Ready: using the light model while the full one downloads (N %)"',
      await until(() => cards.some((c) => /^Ready: using the light model while the full one downloads \(\d+ %\)\. Tap \{key\} in any app and talk\.$/.test(c)), 15000), cards);
    check('Home said it during the pack too ("…while GPU acceleration downloads (N %); then the full model.")',
      cards.some((c) => /^Ready: using the light model while GPU acceleration downloads \(\d+ %\); then the full model\./.test(c)) || cards.some((c) => /GPU acceleration switches on/.test(c)), cards);
    check('the full model ready: it waits for the dictation (no switch while dictating)', await until(() => p.u.state === 'ready', 15000) && (await sleep(600), models(p).length === 1) && /switching to full_a when idle/.test(p.u.line()), { line: p.u.line(), ev: p.ev });
    check('Home: "Typd switches to the full one when you\'re not dictating"', cards.some((c) => /^Ready: using the light model\. Typd switches to the full one when you’re not dictating\./.test(c)), cards.slice(-3));
    const released = Date.now();
    p.box.dictating = false;
    const r = await going;
    s.slow = 0;
    const full = models(p)[1];
    check('the dictation over: the switch to the full model, after it (and idleMs), with the pack', r.state === 'current' && full && full.version === 'full_a' && full.at >= released + 100 && !full.dictating && full.cuda === 'installed', { r, ev: p.ev });
    const ranges = fullModelFileReqs(s).map((q) => q.range);
    check(`the full model file resumed with Range from ${pausedAt}, never fetched from zero twice`, ranges.length === 2 && ranges[0] === null && ranges[1] === `bytes=${pausedAt}-`, ranges);
    check('the order: full (timed), light, light switch, pack, backend switch, rest of full, full switch',
      fullModelFileReqs(s)[0].at < lightReqs(s)[0].at && lightAt < packReqs(s)[0].at && backends(p)[0].at < fullModelFileReqs(s)[1].at && fullModelFileReqs(s)[1].at < full.at, null);
    check('never the full model on the processor: every start of full_a had the pack', models(p).filter((e) => e.version === 'full_a').every((e) => e.cuda === 'installed'));
    check('afterwards: the light model deleted (only the full one kept), the marker gone, Home back to "Ready."',
      !exists(path.join(p.modelsDir, 'light_a')) && exists(path.join(p.modelsDir, 'full_a')) && !p.state().lightFirst && p.u.interim() === null && /^Ready\. Tap/.test((status.set({ interim: p.u.interim() }), status.describe().card)),
      { dir: fs.readdirSync(p.modelsDir), st: p.state() });
    check('model bytes fetched: the full model once (1.9 MB) plus the light one (0.6 MB), nothing twice',
      s.fileRequests().filter((q) => !q.url.includes(PACK)).length === 6, s.fileRequests().map((q) => [q.url, q.range]));
    s.requests = [];
    const r2 = await p.u.check();
    check('the next check: nothing to do', r2.state === 'current' && s.fileRequests().length === 0 && p.ev.length === 3, { r2, ev: p.ev });
  }

  section('a cut full download: the light model stays in use, the next check resumes with Range');
  {
    publishAll(s);
    s.requests = [];
    s.slow = 40;
    const p = profile(s, { hw: 'nvidia4' });
    // Cut the full model's resumed request (the one after the pack) 200 kB in.
    const orig = p.u;
    let armed = false;
    orig.onChange(() => { if (!armed && backends(p).length === 1) { armed = true; s.cutNext[FULL_MODEL] = 200000; } });
    let r = await p.u.check();
    check('the cut: a retry; the light model still current, with the pack; no switch to full', r.state === 'retry' && p.current().version === 'light_a' && p.u.haveModel() && models(p).length === 1 && p.cuda.state() === 'installed', { r, ev: p.ev, cur: p.current() });
    check('the tray says the full model paused; Home: "The full one paused at N % and goes on by itself."',
      /^Model light_a · updating \d+ % \(paused\)$/.test(p.u.line()) && /^Ready: using the light model\. The full one paused at \d+ % and goes on by itself\./.test((status.set({ model: 'ready', interim: p.u.interim() }), status.describe().card)),
      { line: p.u.line(), card: status.describe().card });
    check('the partial download and the marker are kept', exists(path.join(p.modelsDir, 'full_a.partial', FULL_MODEL)) && p.state().lightFirst && p.state().lightFirst.light === 'light_a');
    const before = fs.statSync(path.join(p.modelsDir, 'full_a.partial', FULL_MODEL)).size;
    s.slow = 0;
    r = await p.u.check();
    const ranges = fullModelFileReqs(s).map((q) => q.range);
    check(`the next check resumed with Range from ${before}, verified, switched to full`, ranges[ranges.length - 1] === `bytes=${before}-` && r.state === 'current' && p.current().version === 'full_a' && models(p).length === 2, { ranges, r });
    check('three requests for the full model file: from zero once, then two resumes', ranges.length === 3 && ranges[0] === null && ranges.slice(1).every((x) => /^bytes=\d+-$/.test(x)), ranges);
  }

  section('a pack llama-server does not start with: the light model stays, the full one is not switched to');
  {
    publishAll(s);
    s.requests = [];
    s.slow = 40;
    let tries = 0;
    const p = profile(s, { switchBackend: async () => { tries++; if (tries === 1) throw new Error('ggml_cuda_init failed'); } });
    const r = await p.u.check();
    s.slow = 0;
    check('the pack set aside, started again on the processor (two backend starts), "failed"', tries === 2 && p.u.packState === 'failed' && p.cuda.state() === 'missing', { tries, ps: p.u.packState });
    check('the light model stays current; the full model is never started', p.current().version === 'light_a' && models(p).every((e) => e.version === 'light_a') && r.state === 'current', { r, ev: p.ev });
    check('Automatic follows the light model now: the marker and the paused full download are gone, the reason logged',
      !p.state().lightFirst && !exists(path.join(p.modelsDir, 'full_a.partial')) && p.u.chosen.want === 'light' && p.logs.some((l) => /the CUDA pack was set aside, and the full model is too slow on the processor/.test(l)), { st: p.state(), dir: fs.readdirSync(p.modelsDir), chosen: p.u.chosen });
    s.requests = [];
    await p.u.check();
    check('the next check (same manifest): nothing fetched, still light', s.fileRequests().length === 0 && p.current().version === 'light_a', s.fileRequests());

    // A fast link: the full model and the pack start together; that start fails, the model alone starts.
    publishAll(s);
    s.requests = [];
    let starts = 0;
    const q = profile(s, { switchModel: async () => { starts++; q.ev.push({ what: 'model', at: Date.now(), version: q.current().version, cuda: q.cuda.state() }); if (q.cuda.state() === 'installed') throw new Error('CUDA error: no kernel image'); } });
    await q.u.check();
    const vs = q.ev.map((e) => e.version + '/' + e.cuda);
    check('first start of full + pack fails: the pack set aside, the full model started once on the processor, then the light one fetched and switched to',
      vs[0] === 'full_a/installed' && vs[1] === 'full_a/missing' && q.current().version === 'light_a' && q.cuda.badTag() !== null && lightReqs(s).length === 2, { vs, cur: q.current() });
    check('the full model then deleted (one downloaded version kept)', !exists(path.join(q.modelsDir, 'full_a')) && exists(path.join(q.modelsDir, 'light_a')), fs.readdirSync(q.modelsDir));
  }

  section('a metered connection: asked as today, nothing fetched without an OK, no light model');
  {
    publishAll(s);
    s.requests = [];
    s.slow = 40;
    const p = profile(s, { networkCost: async () => 'metered', askAboveBytes: 1000 });
    let r = await p.u.check();
    check('first: the full model asks, with its size; not one file requested', r.state === 'ask' && s.fileRequests().length === 0 && p.u.pending && p.u.pending.kind === 'model' && p.u.pending.bytes === FULL_BYTES && p.u.pending.first, { r, pend: p.u.pending });
    await p.u.approve();
    r = await p.u.check();
    s.slow = 0;
    check('approved: the full model downloads; the light one would need an OK, so it is not fetched (nor asked for)',
      lightReqs(s).length === 0 && fullReqs(s).length === 3 && p.logs.some((l) => /light model would need an OK/.test(l)), { reqs: s.fileRequests().map((q) => q.url), logs: p.logs.filter((l) => /light/.test(l)) });
    check('the pack waits for its own OK (not fetched); the full model is not held hostage to it: it runs, as in 0.2.5',
      packReqs(s).length === 0 && p.u.pending && p.u.pending.kind === 'pack' && p.current().version === 'full_a' && p.u.packState === 'ask', { pend: p.u.pending, ps: p.u.packState });
    await p.u.approve();
    r = await p.u.check();
    check('the pack approved: fetched, installed, a backend switch', p.cuda.state() === 'installed' && backends(p).length === 1 && p.u.packState === 'current');
  }

  section('updates from 0.2.5 with a model: nothing re-downloaded');
  {
    publishAll(s);
    s.requests = [];
    const a = profile(s, { installed: 'full', bundledCuda: true });
    let r = await a.u.check();
    check('full model + CUDA beside llama-server (NVIDIA): no file requested, no switch', r.state === 'current' && s.fileRequests().length === 0 && a.ev.length === 0 && a.cuda.state() === 'bundled', { r, reqs: s.fileRequests() });
    s.requests = [];
    const b = profile(s, { hw: 'none', installed: 'light' });
    r = await b.u.check();
    check('light model, no NVIDIA GPU: no file requested, no switch', r.state === 'current' && s.fileRequests().length === 0 && b.ev.length === 0, { r, reqs: s.fileRequests() });
    s.requests = [];
    const c = profile(s, { installed: 'full' });
    r = await c.u.check();
    check('full model, NVIDIA, pack still missing (0.2.5 on the processor): only the pack, then a backend switch; no light model, no model file',
      packReqs(s).length === 1 && s.fileRequests().length === 1 && backends(c).length === 1 && models(c).length === 0 && c.cuda.state() === 'installed', { reqs: s.fileRequests().map((q) => q.url), ev: c.ev });
    check('no light-first marker anywhere', !a.state().lightFirst && !b.state().lightFirst && !c.state().lightFirst);
  }

  section('no NVIDIA GPU: the light model only, as before; a pin of Full: no light model');
  {
    publishAll(s);
    s.requests = [];
    s.slow = 40;
    const p = profile(s, { hw: 'none' });
    let r = await p.u.check();
    check('the light model, its two files, no full model, no pack, no timing', r.state === 'current' && p.current().version === 'light_a' && lightReqs(s).length === 2 && fullReqs(s).length === 0 && packReqs(s).length === 0 && !p.logs.some((l) => /light first/.test(l)), s.fileRequests().map((q) => q.url));
    check('nothing stands in: no marker, no interim card', !p.state().lightFirst && p.u.interim() === null && p.u.packState === 'unwanted');
    s.requests = [];
    const q = profile(s, { setting: 'full' });
    r = await q.u.check();
    s.slow = 0;
    check('Full pinned (NVIDIA, slow link): only the full model, then the pack, one start with both; no light request',
      r.state === 'current' && lightReqs(s).length === 0 && fullReqs(s).length === 3 && models(q).length === 1 && models(q)[0].version === 'full_a' && models(q)[0].cuda === 'installed', { r, reqs: s.fileRequests().map((x) => x.url), ev: q.ev });
  }

  section('status.js: the light-first lines');
  {
    const cases = [
      [{ phase: 'full', state: 'downloading', pct: 37, size: '1.6 GB' }, 'Ready: using the light model while the full one downloads (37 %). Tap {key} in any app and talk.'],
      [{ phase: 'full', state: 'retrying', pct: 37, size: '1.6 GB' }, 'Ready: using the light model. The full one paused at 37 % and goes on by itself. Tap {key} in any app and talk.'],
      [{ phase: 'full', state: 'ask', pct: null, size: '1.0 GB' }, 'Ready: using the light model. The full one (1.0 GB) waits for your OK. Tap {key} in any app and talk.'],
      [{ phase: 'pack', state: 'downloading', pct: 12, size: '337 MB' }, 'Ready: using the light model while GPU acceleration downloads (12 %); then the full model. Tap {key} in any app and talk.'],
      [{ phase: 'full', state: 'waiting', pct: null, size: null }, 'Ready: using the light model until the full one is downloaded. Tap {key} in any app and talk.']
    ];
    for (const [f, want] of cases) {
      status.set({ model: 'ready', interim: f, modelFetch: null });
      const d = status.describe();
      check(f.phase + ' ' + f.state + ': "' + want + '"', d.card === want && d.state === 'ready' && d.line === 'Ready — tap Right Alt to dictate', d);
    }
    status.set({ interim: null });
    check('no stand-in: the card as before', status.describe().card === 'Ready. Tap {key} in any app and talk.');
    status.set({ model: 'missing', modelFetch: { state: 'downloading', pct: 40, size: '611 MB', estimate: false, lightFirst: true } });
    check('the light model downloading first: the card says so', /^Typd is downloading its light speech model first, so you can dictate sooner: 40 % of 611 MB\. The full one follows\.$/.test(status.describe().card), status.describe().card);
  }

  section('the app\'s wiring (source checks)');
  {
    const idx = read('src/main/index.js'), mc = read('src/main/modelChoice.js'), mu = read('src/main/modelUpdate.js');
    check('index.js hands the updater automatic: () => choice.automatic()', /automatic: \(\) => choice\.automatic\(\)/.test(idx));
    check('index.js: every model change puts interim() in the status (Home\'s card)', /function modelChanged\(\) \{[\s\S]{0,200}status\.set\(\{ interim: modelUpdate\.interim\(\) \}\);/.test(idx));
    check("modelChoice: automatic() is Settings' Automatic", /const automatic = \(\) => chosen\(\) === 'auto';/.test(mc));
    check('the defaults: a 10 s window, 3 minutes', /const PROBE_MS = 10e3;/.test(mu) && /const LIGHT_FIRST_ABOVE_MS = 180e3;/.test(mu));
  }

  s.server.close();
  if (!process.argv.includes('--keep')) fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + (failures ? failures + ' FAILED' : 'all light-first checks passed') + ' (' + passes + ' ok)\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
