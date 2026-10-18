'use strict';

/**
 * The CUDA pack (Windows, 0.2.5): public installers have llama.cpp's CPU build and no CUDA; a PC whose
 * NVIDIA GPU takes the GPU path fetches the CUDA backend after its model, through the model updater's
 * signed path, and llama-server restarts on it (src/main/cudaPack.js, src/main/modelUpdate.js,
 * src/main/zip.js). Without Electron, a GPU or the network: the real updater, the real hardware and
 * model-choice code fed a fake nvidia-smi, a fake typd-collect (bench/fake-model-server.js), and a fake
 * CUDA backend (four "DLLs" of random bytes, packed by the real zip writer with Zstandard).
 *
 *   - a fresh profile on a PC with no NVIDIA GPU: the light model, and the CUDA pack is never fetched
 *   - fake NVIDIA hardware (4 GB), a fresh install: the full model, then the pack, unthrottled,
 *     checked, unpacked, every file checked against cuda.json, and only then the full model's one start,
 *     with the pack in place (0.2.6: never the full model on the processor while the GPU path is
 *     pending; bench/light-first.js has the rest); llama-server would start in the pack's folder
 *   - a cut pack download resumes with Range; a corrupt one is fetched again; offline waits quietly
 *   - a metered connection asks for the model first, then for the pack, each with its size
 *   - a pack whose files are not this build's, or one llama-server does not start with: set aside,
 *     the processor kept, not fetched again until the manifest changes
 *   - too little disk; a 2 GB card (Light, no pack)
 *   - an install updated from 0.2.4 with the CUDA backend already beside llama-server: nothing is
 *     downloaded; files there that are not this build's are deleted and the pack fetched instead
 *   - the zip reader and writer; the build side (before-pack's staging, after-pack, the update
 *     package's carry list); the app's wiring (source checks)
 *
 *   node bench/cuda-pack.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const { createUpdater } = require('../src/main/modelUpdate');
const { createCuda } = require('../src/main/cudaPack');
const hardware = require('../src/main/hardware');
const { createChoice } = require('../src/main/modelChoice');
const zip = require('../src/main/zip');
const { fakeModelServer, sha } = require('./fake-model-server');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + JSON.stringify(detail).slice(0, 500) : ''));
}
const section = (s) => console.log('\n' + s);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-cuda-pack-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const exists = (p) => fs.existsSync(p);
async function until(cond, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await sleep(25); }
  return Boolean(await cond());
}

/* ----------------------------------------------- a fake CUDA backend and its pack */

const PACK = 'cuda-b99999-cu12.4';
const ZIP = 'cuda-pack-b99999-cu12.4.zip';
// Compressible like the real ones (repeated blocks), so Zstandard has something to do.
const blob = (n, seed) => { const unit = crypto.createHash('sha256').update(seed).digest(); const b = Buffer.alloc(n); for (let i = 0; i < n; i += 32) unit.copy(b, i); b.writeUInt32LE(n, 0); return Buffer.concat([b, crypto.randomBytes(1024)]); };
const DLLS = {
  'ggml-cuda.dll': blob(600000, 'ggml-cuda'), 'cublas64_12.dll': blob(200000, 'cublas'),
  'cublasLt64_12.dll': blob(400000, 'cublasLt'), 'cudart64_12.dll': blob(20000, 'cudart')
};
const DESC = {
  schema: 'typd-cuda/1', pack: PACK, llama: { build: 99999, commit: 'fakecommit' }, cuda: '12.4',
  files: Object.entries(DLLS).map(([name, b]) => ({ name, size: b.length, sha256: sha(b) }))
};
const UNPACKED = DESC.files.reduce((s, f) => s + f.size, 0);

async function packZip(files = DLLS, desc = DESC) {
  const out = path.join(tmp, 'pack-' + crypto.randomBytes(4).toString('hex') + '.zip');
  const C = zlib.constants;
  await zip.write(out, [
    { name: 'pack.json', data: JSON.stringify(desc), method: zip.DEFLATE },
    ...Object.entries(files).map(([name, b]) => ({ name, data: b, method: zip.ZSTD, level: 19, params: { [C.ZSTD_c_windowLog]: 24, [C.ZSTD_c_enableLongDistanceMatching]: 1 } }))
  ]);
  return fs.readFileSync(out);
}

/* --------------------------------------------------------------- the models */

const MODELS = {
  full: { version: 'full_a', files: { 'typd-dictate-1.7b.gguf': crypto.randomBytes(500000), 'mmproj-1.7b.gguf': crypto.randomBytes(200000), 'typd-revise.gguf': crypto.randomBytes(50000) } },
  light: { version: 'light_a', files: { 'typd-dictate-0.6b.gguf': crypto.randomBytes(300000), 'mmproj-0.6b.gguf': crypto.randomBytes(150000) } }
};
MODELS.full.model_json = { model: 'typd-dictate-1.7b.gguf', mmproj: 'mmproj-1.7b.gguf', context: true, revise: true, revise_lora: 'typd-revise.gguf' };
MODELS.light.model_json = { model: 'typd-dictate-0.6b.gguf', mmproj: 'mmproj-0.6b.gguf', context: true, revise: true };

let PACKZIP = null;
function publishAll(s, zipBytes = PACKZIP, { min_app = '0.2.5', withPack = true } = {}) {
  return s.publish({ full: MODELS.full, light: MODELS.light, packs: withPack ? { [PACK]: { version: PACK, files: { [ZIP]: zipBytes }, min_app } } : null });
}

/* ---------------------------------------------------------------- hardware */

// nvidia-smi as the driver would answer, or no driver at all. The absolute paths hardware.js tries
// first point into the throwaway folder, so this PC's own nvidia-smi is never asked.
const SMI = { none: null, nvidia4: 'NVIDIA GeForce RTX 3050 Ti Laptop GPU, 4096, 3900', nvidia2: 'NVIDIA GeForce MX450, 2048, 1900' };
function choiceFor(hw) {
  const run = async () => (SMI[hw] ? { code: 0, stdout: SMI[hw] + '\n' } : { code: -1, stdout: '' });
  return createChoice({ setting: () => 'auto', detect: () => hardware.detect({ platform: 'win32', run, env: { SystemRoot: path.join(tmp, 'win'), ProgramFiles: path.join(tmp, 'pf') } }) });
}

/* ----------------------------------------------------------------- a profile */

let n = 0;
/**
 * A fresh install: resources/llama with llama-server and cuda.json (and, with `bundledCuda`, the four
 * files beside them, as an install updated from 0.2.4 has), resources/models/typd-dictate (NO_MODEL.txt,
 * or a bundled model), an empty userData.
 */
function profile(s, { hw = 'nvidia4', bundledCuda = null, bundledModel = null, online = () => true, ...over } = {}) {
  const root = path.join(tmp, 'p' + (++n));
  const llamaDir = path.join(root, 'resources', 'llama');
  const bundledDir = path.join(root, 'resources', 'models', 'typd-dictate');
  const modelsDir = path.join(root, 'userData', 'models');
  const packsDir = path.join(root, 'userData', 'cuda');
  fs.mkdirSync(llamaDir, { recursive: true });
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.writeFileSync(path.join(llamaDir, 'llama-server.exe'), 'the CPU build');
  fs.writeFileSync(path.join(llamaDir, 'ggml-base.dll'), 'the CPU build');
  fs.writeFileSync(path.join(llamaDir, 'cuda.json'), JSON.stringify(DESC, null, 1));
  if (bundledCuda) for (const [name, b] of Object.entries(bundledCuda)) fs.writeFileSync(path.join(llamaDir, name), b);
  if (bundledModel) {
    for (const [name, b] of Object.entries(bundledModel.files)) fs.writeFileSync(path.join(bundledDir, name), b);
    fs.writeFileSync(path.join(bundledDir, 'model.json'), JSON.stringify(bundledModel.model_json));
  } else {
    fs.writeFileSync(path.join(bundledDir, 'NO_MODEL.txt'), 'downloaded at first launch\n');
  }
  const cuda = createCuda({ llamaDir, packsDir });
  const choice = choiceFor(hw);
  const ev = [];   // what happened, in order: model switches, backend switches
  const u = createUpdater({
    keys: s.keys, config: { endpoint: s.endpoint, key: null }, modelsDir, bundledDir, appVersion: '0.2.5',
    switchModel: async () => { ev.push({ what: 'model', at: Date.now(), current: readJson(path.join(modelsDir, 'current.json')), cuda: cuda.state() }); },
    switchBackend: async () => { ev.push({ what: 'backend', at: Date.now(), state: cuda.state(), dir: cuda.dir() }); },
    cuda, cudaWanted: () => choice.cuda(), variant: () => choice.variant(),
    rate: 1, idleMs: 0, firstCheckMs: 60e3, firstNeedMs: 50, needBackoffMinMs: 100, needBackoffMaxMs: 400, offlinePollMs: 150,
    networkCost: async () => 'unmetered', online,
    ...over
  });
  return { root, u, cuda, choice, ev, llamaDir, bundledDir, modelsDir, packsDir };
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
const packReqs = (s) => s.fileRequests().filter((q) => q.url.includes('/' + PACK + '/'));
const modelReqs = (s) => s.fileRequests().filter((q) => !q.url.includes('/' + PACK + '/'));

(async () => {
  PACKZIP = await packZip();

  section('the zip reader and writer');
  {
    const z = path.join(tmp, 'rt.zip');
    const data = { 'a.bin': crypto.randomBytes(70000), 'b.txt': Buffer.from('hello '.repeat(5000)), 'empty.dat': Buffer.alloc(0) };
    const rep = await zip.write(z, [
      { name: 'a.bin', data: data['a.bin'], method: zip.STORED },
      { name: 'b.txt', data: data['b.txt'], method: zip.DEFLATE },
      { name: 'empty.dat', data: data['empty.dat'], method: zip.ZSTD }
    ]);
    const got = await zip.extract(z, path.join(tmp, 'rt'));
    check('stored, deflate and Zstandard entries come back byte for byte, with their sha256',
      got.length === 3 && got.every((g) => g.sha256 === sha(data[g.name]) && fs.readFileSync(path.join(tmp, 'rt', g.name)).equals(data[g.name])), got);
    check('deflate and Zstandard actually compress', rep[1].compressed < rep[1].size / 10, rep);
    const listing = await zip.list(z);
    check('the central directory lists every entry with its method', listing.map((e) => e.method).join() === '0,8,93', listing);
    // Tampered: one byte of b.txt's compressed body flipped.
    const t = fs.readFileSync(z);
    const e = listing[1];
    const bad = Buffer.from(t); bad[e.offset + 30 + 'b.txt'.length + 5] ^= 0x55;
    fs.writeFileSync(path.join(tmp, 'bad.zip'), bad);
    let err = null;
    try { await zip.extract(path.join(tmp, 'bad.zip'), path.join(tmp, 'bad')); } catch (x) { err = x; }
    check('a damaged entry is refused (CRC, size or the codec), and nothing of it is left', Boolean(err) && !exists(path.join(tmp, 'bad', 'b.txt')), err && err.message);
    err = null;
    try { await zip.list(path.join(tmp, 'rt', 'b.txt')); } catch (x) { err = x; }
    check('a file that is not a zip is refused', Boolean(err && /not a zip/.test(err.message)), err && err.message);
    // A name with a folder in it: written by hand, refused on reading.
    const evil = Buffer.from(t.toString('latin1').split('a.bin').join('../ab').replace(/b\.txt/g, 'b.txt'), 'latin1');
    fs.writeFileSync(path.join(tmp, 'evil.zip'), evil);
    err = null;
    try { await zip.list(path.join(tmp, 'evil.zip')); } catch (x) { err = x; }
    check('an entry name with a folder or ".." is refused', Boolean(err && /plain file name/.test(err.message)), err && err.message);
    err = null;
    try { await zip.write(path.join(tmp, 'w.zip'), [{ name: 'x/y', data: 'z' }]); } catch (x) { err = x; }
    check('the writer refuses such a name too', Boolean(err));
    const pz = path.join(tmp, 'p.zip');
    fs.writeFileSync(pz, PACKZIP);
    const pl = await zip.list(pz);
    check(`the fake pack: pack.json and the four files, Zstandard (${PACKZIP.length} B for ${UNPACKED} B)`, pl.length === 5 && pl.slice(1).every((x) => x.method === zip.ZSTD) && PACKZIP.length < UNPACKED / 3, pl.map((x) => [x.name, x.method]));
  }

  const s = await fakeModelServer();

  section('cudaPack: what is there, before anything is fetched');
  {
    const p = profile(s, { hw: 'none' });
    check('a public install: cuda.json is read, no CUDA anywhere: state "missing", no folder to start in', p.cuda.id === PACK && p.cuda.state() === 'missing' && p.cuda.dir() === null);
    const off = createCuda({ llamaDir: path.join(tmp, 'nowhere'), packsDir: path.join(tmp, 'nowhere-cuda') });
    check('no cuda.json (macOS, a source run): state "off", nothing applies', off.state() === 'off' && off.id === null && !off.have());
    const local = require('../src/main/pipeline/local');
    const plain = local.spawnOptions(null, { Path: 'C:\\Windows' }, p.llamaDir);
    check('without the pack, llama-server starts in its own folder, PATH untouched', plain.cwd === p.llamaDir && plain.env.Path === 'C:\\Windows');
    const withPack = local.spawnOptions(path.join(p.packsDir, PACK), { Path: 'C:\\Windows', Other: '1' }, p.llamaDir);
    check('with the pack, llama-server starts in the pack\'s folder, which is first on PATH (whatever PATH is spelt)',
      withPack.cwd === path.join(p.packsDir, PACK) && withPack.env.Path === path.join(p.packsDir, PACK) + path.delimiter + 'C:\\Windows' && !('PATH' in withPack.env) && withPack.env.Other === '1', withPack);
  }

  section('a fresh profile on a PC with no NVIDIA GPU: the light model, and the CUDA pack is never fetched');
  {
    publishAll(s);
    s.requests = [];
    const p = profile(s, { hw: 'none' });
    p.u.start();
    check('the light model is downloaded and switched to', await until(() => p.ev.some((e) => e.what === 'model')) && readJson(path.join(p.modelsDir, 'current.json')).version === 'light_a');
    await p.u.check();
    await p.u.check();
    check('three checks later: not one request for the pack', packReqs(s).length === 0, s.fileRequests().map((q) => q.url));
    check('only the light model\'s two files were fetched', modelReqs(s).length === 2 && modelReqs(s).every((q) => q.url.includes('/light_a/')), modelReqs(s).map((q) => q.url));
    check('the pack is "unwanted"; no backend switch; nothing in userData/cuda but its state', p.u.packState === 'unwanted' && !p.ev.some((e) => e.what === 'backend') && (!exists(p.packsDir) || fs.readdirSync(p.packsDir).every((x) => x === 'state.json')));
    check('no pack line in the tray; Settings says no CUDA', p.u.packLine() === null && p.u.packInfo().cuda === 'missing', p.u.packInfo());
    check('hardware: "No NVIDIA GPU" (Light, no CUDA)', (await p.choice.describe()).cuda === false && (await p.choice.describe()).auto === 'light');
    p.u.stop();
  }

  // 0.2.6: never the full model on the processor while the GPU path is pending. With no model yet, the
  // pack comes right after the full model, and the full model's first start is with the pack in place.
  section('fake NVIDIA hardware (4 GB): the full model, then the CUDA pack, then one start with both');
  {
    publishAll(s);
    s.requests = [];
    s.slow = 2;
    const p = profile(s, { hw: 'nvidia4' });
    const lines = [];
    p.u.onChange(() => { const l = p.u.packLine(); if (l && lines[lines.length - 1] !== l) lines.push(l); });
    const t0 = Date.now();
    p.u.start();
    check('the model switch comes, and the pack is current after it', await until(() => p.ev.some((e) => e.what === 'model') && p.u.packState === 'current', 20000), p.ev);
    s.slow = 0;
    const firstPack = Math.min(...packReqs(s).map((q) => q.at));
    const model = p.ev.find((e) => e.what === 'model');
    check('the full model (3 files) was fetched before the first request for the pack, and not started before the pack was installed',
      modelReqs(s).length === 3 && modelReqs(s).every((q) => q.url.includes('/full_a/') && q.at < firstPack) && model && model.at >= firstPack && model.current.version === 'full_a',
      { model: modelReqs(s).map((q) => [q.url, q.at - t0]), firstPack: firstPack - t0, model });
    check('the pack: one request, from the public route, no key', packReqs(s).length === 1 && packReqs(s).every((q) => !q.auth && !q.range), packReqs(s));
    check(`unthrottled (rate 1 B/s would take days): done in ${((Date.now() - t0) / 1000).toFixed(1)} s`, Date.now() - t0 < 20000);
    check('never the full model on the processor: its one start found the pack installed ("installed"), no separate backend switch',
      p.ev.filter((e) => e.what === 'model').length === 1 && model.cuda === 'installed' && !p.ev.some((e) => e.what === 'backend') && p.cuda.dir() === path.join(p.packsDir, PACK), p.ev);
    check('every file there is cuda.json\'s, byte for byte, with pack.json beside them',
      DESC.files.every((f) => sha(fs.readFileSync(path.join(p.packsDir, PACK, f.name))) === f.sha256) && readJson(path.join(p.packsDir, PACK, 'pack.json')).version === PACK);
    check('the zip and the unpacking folder are gone (only the pack and state.json remain)', fs.readdirSync(p.packsDir).sort().join() === [PACK, 'state.json'].sort().join() || fs.readdirSync(p.packsDir).join() === PACK, fs.readdirSync(p.packsDir));
    check('pack state "current", no pack line any more', p.u.packState === 'current' && p.u.packLine() === null);
    check('the tray said so while it ran: downloading … %, then switching on when idle',
      lines.some((l) => /^GPU acceleration · downloading \d+ % of 1 MB$/.test(l)) && lines.includes('GPU acceleration · switching on when idle'), lines);
    check('Settings: Automatic picks Full, the GPU path is CUDA', (await p.choice.describe()).auto === 'full' && (await p.choice.describe()).cuda === true);
    s.requests = [];
    const r = await p.u.check();
    check('the next check: nothing more is downloaded, no second switch', r.state === 'current' && s.fileRequests().length === 0 && p.ev.length === 1, r);
    p.u.stop();
  }

  section('a cut pack download resumes with Range; a corrupt one is fetched again');
  {
    publishAll(s);
    s.requests = [];
    const cut = Math.floor(PACKZIP.length / 3);
    s.cutNext[ZIP] = cut;
    const p = profile(s, { hw: 'nvidia4' });
    let r = await p.u.check();
    check('first check: the full model here but not started (the pack comes first); the pack cut short: a retry soon',
      r.state === 'retry' && !p.u.haveModel() && p.u.packState === 'retrying' && r.next <= 1000 && p.ev.length === 0, { r, ps: p.u.packState, ev: p.ev });
    check('the tray says the pack paused; the first-model line counts the pack in (model + pack, paused)',
      /^GPU acceleration · downloading \d+ % of 1 MB \(paused\)$/.test(p.u.packLine() || '') && /^Speech model · downloading \d+ % of \d MB \(paused\)$/.test(p.u.line()) && p.u.needed().total === 750000 + PACKZIP.length,
      { pl: p.u.packLine(), l: p.u.line(), n: p.u.needed() });
    r = await p.u.check();
    const ranges = packReqs(s).map((q) => q.range);
    check(`resumed with Range from ${cut}`, ranges.length === 2 && ranges[0] === null && ranges[1] === `bytes=${cut}-`, ranges);
    check('then checked, installed, and the full model started once, with it', p.u.packState === 'current' && p.cuda.state() === 'installed' && p.ev.length === 1 && p.ev[0].what === 'model' && p.ev[0].cuda === 'installed', { ps: p.u.packState, cs: p.cuda.state(), ev: p.ev });

    s.requests = [];
    s.corrupt[ZIP] = true;
    const q = profile(s, { hw: 'nvidia4' });
    r = await q.u.check();
    check('a corrupt pack fails its sha256: deleted, a retry, nothing installed', r.state === 'retry' && /verification/.test(r.why) && q.cuda.state() === 'missing', r);
    r = await q.u.check();
    check('downloaded again from the start, then installed', packReqs(s).length === 2 && packReqs(s).every((x) => !x.range) && q.cuda.state() === 'installed', packReqs(s));
  }

  section('offline');
  {
    publishAll(s);
    let on = false;
    s.requests = [];
    const p = profile(s, { hw: 'nvidia4', bundledModel: MODELS.full, online: () => on });
    let r = await p.u.check();
    check('a model to dictate with, the pack wanted, no internet: no request at all, a quick look again', s.requests.length === 0 && r.next === 1000, r);
    check('pack state "offline": the tray says it waits for the internet', p.u.packState === 'offline' && p.u.packLine() === 'GPU acceleration · waiting for the internet', p.u.packLine());
    on = true;
    r = await p.u.check();
    check('back online: the pack (the bundled model is the manifest\'s full one: not downloaded)', p.cuda.state() === 'installed' && modelReqs(s).length === 0 && packReqs(s).length === 1, s.fileRequests());

    on = false;
    s.requests = [];
    const q = profile(s, { hw: 'nvidia4', online: () => on });
    r = await q.u.check();
    check('a fresh profile offline: the model waits ("offline"), the pack is not even considered yet', q.u.needed().state === 'offline' && q.u.packState === 'idle' && s.requests.length === 0, { n: q.u.needed(), ps: q.u.packState });
    on = true;
    await q.u.check();
    check('online again: the model, then the pack', q.u.haveModel() && q.cuda.state() === 'installed');
  }

  section('a metered connection: asked for the model first, then for the pack');
  {
    publishAll(s);
    s.requests = [];
    const p = profile(s, { hw: 'nvidia4', networkCost: async () => 'metered', askAboveBytes: 1000 });
    let r = await p.u.check();
    let pend = p.u.pending;
    check('first: the model asks (750 kB), nothing requested, the pack not asked yet',
      r.state === 'ask' && s.fileRequests().length === 0 && pend && pend.kind === 'model' && pend.first === true && p.u.packState === 'idle', { r, pend, ps: p.u.packState });
    await p.u.approve();
    r = await p.u.check();
    pend = p.u.pending;
    check('approved: the model downloaded; now the pack asks, with its exact size', p.u.haveModel() && pend && pend.kind === 'pack' && pend.bytes === PACKZIP.length && pend.why === 'metered' && packReqs(s).length === 0, pend);
    check('the tray offers "Download GPU acceleration (…)"', p.u.packLine() === `GPU acceleration available (1 MB)`, p.u.packLine());
    await p.u.later();
    check('"Later": the pack waits, the tray keeps an "Update now" for it', p.u.packState === 'later' && p.u.pending && p.u.pending.later === true && p.u.pending.kind === 'pack');
    r = await p.u.check();
    check('a check inside the "Later" day asks nothing and fetches nothing', p.u.packState === 'later' && packReqs(s).length === 0, p.u.packState);
    await p.u.approve();
    r = await p.u.check();
    check('approved: downloaded, installed, switched to', p.cuda.state() === 'installed' && p.u.packState === 'current' && p.ev.some((e) => e.what === 'backend'));
    const st = readJson(path.join(p.modelsDir, 'state.json'));
    check('the two answers are kept apart (approved for the model, packApproved for the pack)', st.approved && st.approved.version === 'full_a' && st.packApproved && st.packApproved.version === PACK, st);
  }

  section('a pack that is not this build\'s, or that llama-server does not start with: set aside');
  {
    const wrong = await packZip({ ...DLLS, 'ggml-cuda.dll': blob(600000, 'another build') });
    publishAll(s, wrong);
    s.requests = [];
    const p = profile(s, { hw: 'nvidia4', bundledModel: MODELS.full });
    let r = await p.u.check();
    check('its zip matches the manifest, its files do not match cuda.json: "failed", nothing installed, no switch',
      p.u.packState === 'failed' && p.cuda.state() === 'missing' && !p.ev.some((e) => e.what === 'backend') && !exists(path.join(p.packsDir, PACK)), { r, ps: p.u.packState });
    check('the tray: running on the processor', p.u.packLine() === 'GPU acceleration did not start · using the processor', p.u.packLine());
    s.requests = [];
    r = await p.u.check();
    check('the same manifest: not fetched again', packReqs(s).length === 0 && p.u.packState === 'failed', s.fileRequests());
    publishAll(s);   // a new manifest (new seq), the right pack
    r = await p.u.check();
    check('a new manifest: fetched again, and this one installs', p.cuda.state() === 'installed' && p.u.packState === 'current', { ps: p.u.packState, cs: p.cuda.state() });

    publishAll(s);
    let tries = 0;
    const q = profile(s, { hw: 'nvidia4', bundledModel: MODELS.full, switchBackend: async () => { tries++; if (tries === 1) throw new Error('llama-server exited while loading'); } });
    r = await q.u.check();
    check('llama-server does not start with it: set aside, started again without it (two starts), "failed"',
      tries === 2 && q.u.packState === 'failed' && q.cuda.state() === 'missing' && q.cuda.dir() === null && q.cuda.badTag() !== null, { tries, ps: q.u.packState });
    s.requests = [];
    r = await q.u.check();
    check('...and not fetched again under the same manifest', packReqs(s).length === 0);
  }

  section('disk space, a 2 GB card, an old Typd, no pack published');
  {
    publishAll(s);
    const p = profile(s, { hw: 'nvidia4', bundledModel: MODELS.full, statfs: async () => ({ bavail: 100, bsize: 4096 }) });
    await p.u.check();
    check('too little disk: pack state "space", nothing fetched', p.u.packState === 'space' && p.u.packLine() === 'GPU acceleration · needs more disk space', p.u.packState);
    s.requests = [];
    const q = profile(s, { hw: 'nvidia2' });
    await q.u.check();
    check('a 2 GB card: the light model, no pack ("less than 4 GB")', readJson(path.join(q.modelsDir, 'current.json')).version === 'light_a' && packReqs(s).length === 0 && q.u.packState === 'unwanted' && /less than 4 GB/.test((await q.choice.describe()).cudaWhy));
    publishAll(s, PACKZIP, { min_app: '9.0.0' });
    const r = profile(s, { hw: 'nvidia4', bundledModel: MODELS.full });
    await r.u.check();
    check('a pack that needs a newer Typd: "app", nothing fetched', r.u.packState === 'app' && r.cuda.state() === 'missing');
    publishAll(s, PACKZIP, { withPack: false });
    const t = profile(s, { hw: 'nvidia4', bundledModel: MODELS.full });
    const res = await t.u.check();
    check('no pack in the manifest: "none", the processor, the next look in an hour (not minutes)', t.u.packState === 'none' && res.next >= 0.9 * 3600e3 && res.next <= 1.1 * 3600e3, { ps: t.u.packState, next: res.next });
  }

  section('an install updated from 0.2.4: the CUDA backend already beside llama-server');
  {
    publishAll(s);
    s.requests = [];
    const p = profile(s, { hw: 'nvidia4', bundledModel: MODELS.full, bundledCuda: DLLS });
    fs.mkdirSync(path.join(p.packsDir, PACK + '.partial'), { recursive: true });   // a download begun before, now not needed
    fs.writeFileSync(path.join(p.packsDir, PACK + '.partial', ZIP), PACKZIP.subarray(0, 100));
    const r = await p.u.check();
    check('a pack download left from before is deleted: the backend is here', !exists(path.join(p.packsDir, PACK + '.partial')));
    check('nothing is downloaded: the model is the manifest\'s, the CUDA backend is this build\'s ("bundled")',
      r.state === 'current' && s.fileRequests().length === 0 && p.cuda.state() === 'bundled' && p.u.packState === 'current', { r, reqs: s.fileRequests(), cs: p.cuda.state() });
    check('llama-server starts beside them as before (no pack folder)', p.cuda.dir() === null && !p.ev.length);
    check('their sha256 is remembered: the next start does not read 1 GB again', Object.keys(readJson(path.join(p.packsDir, 'state.json')).bundled || {}).length === 4);

    s.requests = [];
    const stale = { ...DLLS, 'ggml-cuda.dll': blob(600000, 'b11000') };
    const q = profile(s, { hw: 'nvidia4', bundledModel: MODELS.full, bundledCuda: stale });
    await q.cuda.prepare();
    check('files from another llama.cpp build: all four deleted before llama-server starts', DESC.files.every((f) => !exists(path.join(q.llamaDir, f.name))) && q.cuda.state() === 'missing');
    await q.u.check();
    check('then the pack is fetched and installed', packReqs(s).length === 1 && q.cuda.state() === 'installed');

    const cpu = profile(s, { hw: 'none', bundledModel: MODELS.light, bundledCuda: DLLS });   // such a PC already moved to Light under 0.2.4
    s.requests = [];
    await cpu.u.check();
    check('the same on a PC without an NVIDIA GPU: kept, nothing downloaded or deleted', cpu.cuda.state() === 'bundled' && packReqs(s).length === 0 && exists(path.join(cpu.llamaDir, 'ggml-cuda.dll')));
  }

  section('the build: staging, after-pack, the update package');
  {
    const proj = path.join(tmp, 'proj');
    const vendor = path.join(proj, 'vendor', 'llama');
    fs.mkdirSync(vendor, { recursive: true });
    for (const n of ['llama-server.exe', 'ggml-base.dll', 'ggml-cpu-haswell.dll', 'llama-server-impl.dll', 'llama-cli-impl.dll', 'llama-bench.exe']) fs.writeFileSync(path.join(vendor, n), n);
    for (const [name, b] of Object.entries(DLLS)) fs.writeFileSync(path.join(vendor, name), b);
    const env = { TYPD_LLAMA_BUILD: '99999:fakecommit', TYPD_CUDA_VERSION: '12.4', TYPD_NO_BUNDLED_MODEL: '1' };
    const stage = (extra) => spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'before-pack.js'))})({ packager: { projectDir: ${JSON.stringify(proj)} }, electronPlatformName: 'win32' }).then(() => {}, (e) => { console.error(e); process.exit(1); })`],
      { env: { ...process.env, ...env, ...extra }, encoding: 'utf8', windowsHide: true });
    let r = stage({ TYPD_NO_BUNDLED_CUDA: '1' });
    const staged = path.join(proj, 'dist', '.stage', 'llama');
    const names = () => fs.readdirSync(staged).sort();
    const cj = readJson(path.join(staged, 'cuda.json'));
    check('public build (TYPD_NO_BUNDLED_CUDA=1): llama-server and its libraries, no CUDA file, no other tool',
      r.status === 0 && names().join() === ['cuda.json', 'ggml-base.dll', 'ggml-cpu-haswell.dll', 'llama-server-impl.dll', 'llama-server.exe'].sort().join(), { out: r.stdout + r.stderr, names: names() });
    check('cuda.json names the pack (build and CUDA version) and the four files, size and sha256',
      cj && cj.pack === PACK && cj.files.length === 4 && cj.files.every((f) => DLLS[f.name] && f.sha256 === sha(DLLS[f.name]) && f.size === DLLS[f.name].length), cj);
    r = stage({});
    check('a tester build: the CUDA files too', r.status === 0 && Object.keys(DLLS).every((nme) => names().includes(nme)), names());

    // after-pack on the unpacked app
    const appOut = path.join(tmp, 'win-unpacked');
    const res = path.join(appOut, 'resources');
    fs.mkdirSync(path.join(res, 'llama'), { recursive: true });
    fs.mkdirSync(path.join(res, 'models', 'typd-dictate'), { recursive: true });
    fs.writeFileSync(path.join(res, 'models', 'typd-dictate', 'NO_MODEL.txt'), 'x');
    for (const nme of ['llama-server.exe', 'cuda.json']) fs.copyFileSync(path.join(staged, nme), path.join(res, 'llama', nme));
    const afterPack = (extra) => spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'after-pack.js'))})({ electronPlatformName: 'win32', appOutDir: ${JSON.stringify(appOut)}, arch: 1, packager: { appInfo: { productFilename: 'Typd' } } }).then(() => {}, (e) => { console.error(e.message); process.exit(1); })`],
      { env: { ...process.env, TYPD_NO_BUNDLED_MODEL: '1', TYPD_TESTER_CONFIG: '', ...extra }, encoding: 'utf8', windowsHide: true });
    r = afterPack({ TYPD_NO_BUNDLED_CUDA: '1' });
    check('after-pack: a public app with no CUDA file and cuda.json passes', r.status === 0 && /CPU build/.test(r.stdout), r.stdout + r.stderr);
    fs.copyFileSync(path.join(staged, 'ggml-cuda.dll'), path.join(res, 'llama', 'ggml-cuda.dll'));
    r = afterPack({ TYPD_NO_BUNDLED_CUDA: '1' });
    check('...and refuses one that holds a CUDA file', r.status !== 0 && /holds ggml-cuda\.dll/.test(r.stderr), r.stderr);
    r = afterPack({});
    check('a build that keeps CUDA must have all four', r.status !== 0 && /missing the CUDA backend/.test(r.stderr), r.stderr);

    // the update package: llama.cpp without the CUDA files, which are carried over
    fs.rmSync(path.join(res, 'llama', 'ggml-cuda.dll'));
    fs.writeFileSync(path.join(appOut, 'Typd.exe'), 'x');
    const asar = (pkg) => {   // a real asar holding just package.json
      const data = Buffer.from(JSON.stringify(pkg));
      const header = Buffer.from(JSON.stringify({ files: { 'package.json': { size: data.length, offset: '0' } } }));
      const padded = Math.ceil(header.length / 4) * 4;
      const hp = Buffer.alloc(8 + padded); hp.writeUInt32LE(4 + padded, 0); hp.writeInt32LE(header.length, 4); header.copy(hp, 8);
      const size = Buffer.alloc(8); size.writeUInt32LE(4, 0); size.writeUInt32LE(hp.length, 4);
      return Buffer.concat([size, hp, data]);
    };
    fs.writeFileSync(path.join(res, 'app.asar'), asar({ name: 'typd', version: '0.2.5' }));
    const out = path.join(tmp, 'update');
    r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'app-update-package.js'), 'win', '--app', appOut, '--out', out, '--version', '0.2.5'], { encoding: 'utf8', windowsHide: true });
    const rec = readJson(path.join(out, 'Typd-0.2.5-update-win-x64.zip.json'));
    check('the Windows update package carries the four CUDA files over from the installed app, needs no llama.cpp tree',
      r.status === 0 && rec && DESC.files.every((f) => rec.carry.includes('resources/llama/' + f.name)) && rec.carry.includes('resources/models/typd-dictate') && !rec.requires && rec.carry.length <= 16, { out: r.stdout + r.stderr, rec });
    const listed = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-t', '-f', path.join(out, 'Typd-0.2.5-update-win-x64.zip')], { encoding: 'utf8', windowsHide: true }).stdout || '';
    check('...and holds llama.cpp (llama-server, cuda.json), not the model', /Typd\/resources\/llama\/llama-server\.exe/.test(listed) && /Typd\/resources\/llama\/cuda\.json/.test(listed) && !/models/.test(listed), listed);
  }

  section('the app\'s wiring (source checks)');
  {
    const idx = read('src/main/index.js'), loc = read('src/main/pipeline/local.js'), tray = read('src/main/tray.js'), mu = read('src/main/modelUpdate.js');
    check('index.js hands the updater the CUDA pack, the hardware\'s GPU path and a backend switch',
      /cuda: local\.cuda,\s*cudaWanted: \(\) => choice\.cuda\(\),\s*switchBackend/.test(idx) && /function switchBackend\(\)/.test(idx));
    check('local.js: every launch reads where to start (spawnOptions), every warm start prepares the CUDA files first',
      /const run = spawnOptions\(\);/.test(loc) && /cwd: run\.cwd, env: (?:serverEnv\()?run\.env/.test(loc) && /await cuda\.prepare\(\);/.test(loc));
    check('the tray shows the pack\'s line and asks "Download GPU acceleration"', /deps\.packLine \? deps\.packLine\(\)/.test(tray) && /Download GPU acceleration/.test(tray));
    check('the pack comes after the model, only once there is one', /const p = haveModel\(\) \? await followPack\(m, tag\) : null;/.test(mu));
    check('the pack is never throttled (download(..., true))', /await download\(e\.version, f, zipFile, packProgress, true\);/.test(mu));
    check('hardware.js: CUDA only on Windows, with an NVIDIA GPU of 3.5 GB or more', hardware.cuda({ platform: 'win32', nvidia: { name: 'x', totalMiB: 4096 } }).cuda === true &&
      hardware.cuda({ platform: 'win32', nvidia: { name: 'x', totalMiB: 3000 } }).cuda === false && hardware.cuda({ platform: 'darwin', nvidia: { name: 'x', totalMiB: 8192 } }).cuda === false &&
      hardware.cuda({ platform: 'win32', nvidia: null, vendors: ['amd'] }).cuda === false);
  }

  s.server.close();
  if (!process.argv.includes('--keep')) fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + (failures ? failures + ' FAILED' : 'all CUDA pack checks passed') + '\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
