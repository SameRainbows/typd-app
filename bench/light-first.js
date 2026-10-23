'use strict';

/**
 * Only the model the hardware picks (0.2.9), and never the full model on the processor while the GPU
 * path is pending (0.2.6). Without Electron, a GPU or the network: the real updater (modelUpdate.js), the
 * real hardware and model-choice code fed a fake nvidia-smi, the real CUDA pack code with a fake pack,
 * against a local fake of typd-collect (bench/fake-model-server.js), in throwaway profiles. The fake
 * server's `slow` makes a link slow.
 *
 *   - a fast link, good hardware (fake NVIDIA 4 GB): the full model and the pack, one start with both
 *   - a slow link, good hardware: the same -- the full model only, the light one never requested (0.2.6-0.2.8
 *     fetched the light model first here; the user's rule since 0.2.9: only the model the hardware picks)
 *   - an install 0.2.6-0.2.8 left with the light model standing in and the full download paused: finished,
 *     not repeated -- the pack (a backend switch on the light model), the full model resumed with Range,
 *     the switch when nothing is dictated, then the light model and the marker gone
 *   - a first start of full + pack that fails: the pack set aside, then the light model (Automatic's pick
 *     once the GPU path is gone), never the full model left on the processor
 *   - a metered connection: asked as today, nothing fetched without an OK, no light model
 *   - updates from 0.2.5 with a model (full with CUDA, light, full without the pack): nothing re-downloaded
 *   - weak hardware (no NVIDIA GPU), slow link: the light model only; a pin of Full: no light model
 *   - status.js's stand-in lines (an install finishing light first), and the app's wiring (source checks)
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
    networkCost: async () => 'unmetered',
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

  section('a fast link, good hardware (fake NVIDIA 4 GB): the full model and the pack, no light model at all');
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
    check('no light-first marker, nothing about a light model in the log', !p.state().lightFirst && !p.logs.some((l) => /light/.test(l)), p.logs.filter((l) => /light/.test(l)));
    check('current.json records the variant', p.current().variant === 'full', p.current());
  }

  section('a slow link, good hardware (fake NVIDIA 4 GB): the full model only, the light one never downloaded');
  {
    publishAll(s);
    s.requests = [];
    s.slow = 40;   // ~1.6 MB/s: the full model takes ~1.2 s; 0.2.6-0.2.8 would have fetched the light model first
    const p = profile(s);
    const seen = [];
    p.u.onChange(() => { const nd = p.u.needed(); if (nd) seen.push({ variant: nd.variant, lightFirst: Boolean(nd.lightFirst), state: nd.state }); });
    const r = await p.u.check();
    s.slow = 0;
    check('current: the full model with the pack', r.state === 'current' && p.current().version === 'full_a' && p.u.packState === 'current', { r, ps: p.u.packState });
    check('not one request for the light model', lightReqs(s).length === 0, s.fileRequests().map((q) => q.url));
    check('the full model file fetched once, from the start (never paused)', fullModelFileReqs(s).length === 1 && fullModelFileReqs(s)[0].range === null, fullModelFileReqs(s));
    check('one start, of the full model with the pack installed (never on the processor)', models(p).length === 1 && models(p)[0].version === 'full_a' && models(p)[0].cuda === 'installed' && backends(p).length === 0, p.ev);
    check('the first-run progress named the full model the whole time (never "light first")', seen.length > 0 && seen.every((x) => x.variant === 'full' && !x.lightFirst), seen.slice(0, 4));
    check('no light-first marker, no light model on disk', !p.state().lightFirst && !exists(path.join(p.modelsDir, 'light_a')) && !exists(path.join(p.modelsDir, 'light_a.partial')), fs.readdirSync(p.modelsDir));
  }

  section('an install 0.2.6-0.2.8 left with the light model standing in: finished, not repeated');
  {
    publishAll(s);
    s.requests = [];
    s.slow = 40;
    const p = profile(s, { installed: 'light' });
    // As light first left it: the light model current (and recorded as light), the marker, the full
    // download paused 300 kB into its model file, the pack not here yet.
    const cur = p.current();
    fs.writeFileSync(path.join(p.modelsDir, 'current.json'), JSON.stringify({ ...cur, variant: 'light' }));
    fs.writeFileSync(path.join(p.modelsDir, 'state.json'), JSON.stringify({ lightFirst: { light: 'light_a', full: 'full_a', at: new Date().toISOString() } }));
    const partial = path.join(p.modelsDir, 'full_a.partial');
    fs.mkdirSync(partial, { recursive: true });
    fs.writeFileSync(path.join(partial, FULL_MODEL), MODELS.full.files[FULL_MODEL].subarray(0, 300000));
    status.set({ model: 'ready', modelFetch: null, interim: p.u.interim() });
    check('Home says the light model stands in', /^Ready: using the light model/.test(status.describe().card), status.describe().card);
    // A dictation in progress while the pack and the rest of the full model come in.
    p.box.dictating = true;
    const going = p.u.check();
    await until(() => packReqs(s).length === 1 && fullModelFileReqs(s).length >= 1, 15000);
    await sleep(1500);
    check('nothing is switched while a dictation is in progress', p.ev.every((e) => !e.dictating), p.ev);
    const released = Date.now();
    p.box.dictating = false;
    const r = await going;
    s.slow = 0;
    const fulls = models(p).filter((e) => e.version === 'full_a');
    check('then the full model, started only with the pack installed (never on the processor), after the dictation',
      r.state === 'current' && p.current().version === 'full_a' && fulls.length >= 1 && fulls.every((e) => e.cuda === 'installed' && !e.dictating) && packReqs(s).length === 1 && packReqs(s)[0].at < fulls[0].at,
      { r, ev: p.ev, released });
    check('the full model file resumed with Range from 300000, never fetched from zero', fullModelFileReqs(s).length === 1 && fullModelFileReqs(s)[0].range === 'bytes=300000-', fullModelFileReqs(s).map((q) => q.range));
    check('the light model never fetched again', lightReqs(s).length === 0, lightReqs(s));
    check('afterwards: the light model deleted, the marker gone, Home back to "Ready."',
      !exists(path.join(p.modelsDir, 'light_a')) && exists(path.join(p.modelsDir, 'full_a')) && !p.state().lightFirst && p.u.interim() === null,
      { dir: fs.readdirSync(p.modelsDir), st: p.state() });
    s.requests = [];
    const r2 = await p.u.check();
    check('the next check: nothing to do', r2.state === 'current' && s.fileRequests().length === 0, { r2, reqs: s.fileRequests() });
  }

  section('a first start of full + pack that fails: the pack set aside, then the light model (no full model on the processor)');
  {
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
    check('approved: the full model downloads; no light model, not even asked for',
      lightReqs(s).length === 0 && fullReqs(s).length === 3, { reqs: s.fileRequests().map((q) => q.url), logs: p.logs.filter((l) => /light/.test(l)) });
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

  section('weak hardware (no NVIDIA GPU), slow link: the light model only, as before; a pin of Full: no light model');
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

  section('status.js: the stand-in lines (an install finishing light first)');
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
    check('light first never starts (0.2.9): no timing, no stand-in step left in the updater',
      !/PROBE_MS|LIGHT_FIRST_ABOVE_MS|lightCandidate|fetchTimed|function standIn/.test(mu) && /Only the model the hardware picks \(0\.9\)|Only the model the hardware picks \(0\.2\.9\)/.test(mu));
  }

  s.server.close();
  if (!process.argv.includes('--keep')) fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + (failures ? failures + ' FAILED' : 'all light-first checks passed') + ' (' + passes + ' ok)\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
