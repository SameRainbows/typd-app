'use strict';

/**
 * Which model a computer gets, and asking before a big download -- without Electron, a GPU, a
 * network cost API or the real server:
 *
 *   - hardware.js: nvidia-smi's output, which GPU counts, total VRAM (never free) against 3.5 GiB,
 *     Apple silicon and its memory against 16 GB, Intel Macs, no NVIDIA GPU; fake runners only
 *   - netcost.js: Windows' connection cost and macOS's path flags as the probes print them, and a
 *     probe that fails or answers nothing -> unknown (Typd then asks)
 *   - modelChoice.js: Automatic / Full / Light, the hardware read once per half hour, forget()
 *   - the manifest's variants (modelUpdate.selectVariant): the top level is Full; a variant entry is
 *     followed only when published and well formed; its own min_app
 *   - modelUpdate.js against a fake typd-collect serving a signed manifest with variants: a light
 *     machine downloads the light files; a big download on a metered (or unknown) connection stops
 *     at "ask" with nothing requested; Later holds it for 24 h (the clock is faked) and then asks
 *     again; Update now downloads, and the approval survives a restart and a cut connection; an
 *     unmetered connection or a small download never asks; "Ask before downloading new models" asks
 *     for every download; what is already here (a partial file, a file copied from disk) is not
 *     counted; switching back to the bundled Full needs no download; a light model that fails is
 *     not retried while Full still is
 *   - Typd 0.2.2's own modelUpdate.js (from git) follows the top level of a manifest with variants
 *     exactly as before, and never touches a variant's files
 *   - the walkthrough's wiring (source checks, as bench/wiring.js does): once per install, packaged
 *     builds only, never into an app update's quiet relaunch, after the consent screen
 *
 *   node bench/model-choice.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const hardware = require('../src/main/hardware');
const netcost = require('../src/main/netcost');
const { createChoice } = require('../src/main/modelChoice');
const { createUpdater, activeModel, selectVariant, fmtSize, SIG_PREFIX, ASK_ABOVE_BYTES, LATER_MS } = require('../src/main/modelUpdate');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + JSON.stringify(detail).slice(0, 500) : ''));
}
const section = (s) => console.log('\n' + s);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-model-choice-'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ------------------------------------------------------------- hardware.js */

const GiB = 1024 ** 3;
function runner(table) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([path.basename(file), ...args].join(' '));
    for (const [re, out] of table) if (re.test(path.basename(file))) return typeof out === 'function' ? out(args) : out;
    return { code: -1, stdout: '' };
  };
  return { run, calls };
}
const smi = (text) => [/nvidia-smi/, { code: 0, stdout: text }];

async function hardwareTests() {
  section('hardware.js: what nvidia-smi says');
  const parsed = hardware.parseNvidiaSmi('NVIDIA GeForce RTX 3050 Ti Laptop GPU, 4096, 2096\r\nNVIDIA GeForce GTX 1050, 2048, 1900\nnot a line\n');
  check('two GPUs read, the junk line left out', parsed.length === 2 && parsed[0].totalMiB === 4096 && parsed[0].freeMiB === 2096 && parsed[1].name === 'NVIDIA GeForce GTX 1050', parsed);
  check('free shown as [N/A] is read as unknown', hardware.parseNvidiaSmi('Tesla T4, 15360, [N/A]')[0].freeMiB === null);
  check('nothing to read -> none', hardware.parseNvidiaSmi('').length === 0 && hardware.parseNvidiaSmi('NVIDIA-SMI has failed').length === 0);
  check('Windows looks in System32 first', /System32[\\/]nvidia-smi\.exe$/i.test(hardware.nvidiaSmiPaths('win32', { SystemRoot: 'C:\\Windows' })[0]));

  const win = async (text, vendors) => {
    const r = runner([smi(text)]);
    const hw = await hardware.detect({ platform: 'linux', run: r.run, gpuInfo: vendors ? async () => ({ gpuDevice: vendors.map((v) => ({ vendorId: v })) }) : null });
    return { hw, pick: hardware.pick(hw) };
  };
  let t = await win('NVIDIA GeForce RTX 3050 Ti Laptop GPU, 4096, 2096');
  check("the developer's RTX 3050 Ti: 4,096 MiB in all, 2,096 free with Typd running -> full (total counts, not free)", t.pick.variant === 'full' && /RTX 3050 Ti/.test(t.pick.why) && /4 GB/.test(t.pick.why), t.pick);
  t = await win('NVIDIA GeForce GTX 1060 3GB, 3072, 3000');
  check('a 3 GB card -> light, and says Full needs 4 GB', t.pick.variant === 'light' && /4 GB/.test(t.pick.why), t.pick);
  t = await win('Some GPU, 3584, 100');
  check('exactly 3.5 GiB in all (3,584 MiB) -> full, however little is free', t.pick.variant === 'full', t.pick);
  t = await win('Some GPU, 3583, 3583');
  check('one MiB under 3.5 GiB, all of it free -> light', t.pick.variant === 'light', t.pick);
  t = await win('NVIDIA GeForce GTX 1050, 2048, 2000\nNVIDIA GeForce RTX 3060, 12288, 11000');
  check('two GPUs: the bigger one decides', t.pick.variant === 'full' && /RTX 3060/.test(t.pick.why), t.pick);
  const none = runner([[/nvidia-smi/, { code: 9, stdout: 'NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.' }]]);
  let hw = await hardware.detect({ platform: 'linux', run: none.run, gpuInfo: async () => ({ gpuDevice: [{ vendorId: 0x10de, deviceId: 1 }] }) });
  check('an NVIDIA card whose driver tools fail -> light', hardware.pick(hw).variant === 'light' && /driver/.test(hardware.pick(hw).why), hardware.pick(hw));
  hw = await hardware.detect({ platform: 'linux', run: none.run, gpuInfo: async () => ({ gpuDevice: [{ vendorId: 0x1002 }, { vendorId: 0x8086 }] }) });
  check('an AMD or Intel GPU only -> light (the Windows build runs the model on NVIDIA GPUs only)', hardware.pick(hw).variant === 'light' && /No NVIDIA GPU/.test(hardware.pick(hw).why) && hw.vendors.join() === 'amd,intel', hw);
  hw = await hardware.detect({ platform: 'linux', run: none.run, gpuInfo: async () => { throw new Error('no GPU process'); } });
  check('getGPUInfo failing is no GPU at all -> light', hardware.pick(hw).variant === 'light' && hw.vendors.length === 0);
  check('nothing detected at all -> light', hardware.pick(null).variant === 'light');
  const realWin = runner([smi('X, 8192, 8000')]);
  await hardware.detect({ platform: 'win32', run: realWin.run, env: { SystemRoot: path.join(tmp, 'no-windows') } });
  check('Windows with no System32 copy falls back to the PATH', realWin.calls.length === 1 && /^nvidia-smi\.exe --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits$/.test(realWin.calls[0]), realWin.calls);

  section('hardware.js: Macs');
  const mac = async (arch, bytes, sysctlOk = true) => {
    const r = runner([[/sysctl/, sysctlOk ? { code: 0, stdout: String(bytes) + '\n' } : { code: 1, stdout: '' }]]);
    const h = await hardware.detect({ platform: 'darwin', arch, run: r.run, totalmem: () => bytes });
    return { h, pick: hardware.pick(h), calls: r.calls };
  };
  let m = await mac('arm64', 16 * GiB);
  check('Apple silicon, 16 GB (sysctl hw.memsize) -> full', m.pick.variant === 'full' && /16 GB/.test(m.pick.why) && m.calls[0] === 'sysctl -n hw.memsize', m);
  m = await mac('arm64', 8 * GiB);
  check('Apple silicon, 8 GB -> light, and says Full needs 16 GB', m.pick.variant === 'light' && /16 GB/.test(m.pick.why), m.pick);
  m = await mac('arm64', 24 * GiB, false);
  check('sysctl failing -> os.totalmem(), the same number (24 GB -> full)', m.pick.variant === 'full' && m.h.memBytes === 24 * GiB, m);
  m = await mac('x64', 32 * GiB);
  check('an Intel Mac, or the x64 build under Rosetta (llama.cpp on the CPU) -> light', m.pick.variant === 'light' && /Intel/.test(m.pick.why), m.pick);
  check('a Mac never runs nvidia-smi', !m.calls.some((c) => /nvidia/.test(c)));
}

/* -------------------------------------------------------------- netcost.js */

async function netcostTests() {
  section('netcost.js: Windows connection cost');
  const W = netcost.parseWindows;
  check('Unrestricted -> unmetered', W('typd-cost Unrestricted False False\r\n') === 'unmetered');
  check('Unrestricted but roaming, or over the data limit -> metered', W('typd-cost Unrestricted True False') === 'metered' && W('typd-cost Unrestricted False True') === 'metered');
  check('Fixed or Variable (a data plan) -> metered', W('typd-cost Fixed False False') === 'metered' && W('typd-cost Variable False False') === 'metered');
  check('Unknown, no internet profile, or junk -> unknown (asks)', W('typd-cost Unknown False False') === 'unknown' && W('typd-cost none') === 'unknown' && W('') === 'unknown' && W('error') === 'unknown');
  check('the script reads GetInternetConnectionProfile().GetConnectionCost() through WinRT', /GetInternetConnectionProfile\(\)/.test(netcost.WIN_SCRIPT) && /GetConnectionCost\(\)/.test(netcost.WIN_SCRIPT) && /ContentType = WindowsRuntime/.test(netcost.WIN_SCRIPT));

  section('netcost.js: macOS path flags');
  const M = netcost.parseMac;
  check('expensive (a hotspot, cellular) -> metered', M('typd-cost expensive open path\n') === 'metered');
  check('Low Data Mode (constrained) -> metered', M('typd-cost cheap constrained path') === 'metered' && M('typd-cost cheap constrained request') === 'metered');
  check('neither -> unmetered', M('typd-cost cheap open path') === 'unmetered' && M('typd-cost cheap open request') === 'unmetered');
  check('no answer -> unknown (asks)', M('typd-cost unknown') === 'unknown' && M('') === 'unknown' && M('execution error: -2700') === 'unknown');
  const js = netcost.macScript('https://example.test/v1/model/public/manifest');
  check('the JXA reads NWPathEvaluator isExpensive / isConstrained, then a request that refuses both', /NWPathEvaluator/.test(js) && /isExpensive/.test(js) && /isConstrained/.test(js) &&
    /allowsExpensiveNetworkAccess = false/.test(js) && /allowsConstrainedNetworkAccess = false/.test(js) && /NSURLErrorNetworkUnavailableReasonKey/.test(js) && js.includes('"https://example.test/v1/model/public/manifest"'));

  section('netcost.js: the probe');
  const fake = (out) => async (file, args) => ({ code: out.code, stdout: out.stdout, file, args });
  let calls = [];
  const spy = (out) => async (file, args) => { calls.push({ file, args }); return out; };
  check('Windows: Windows PowerShell 5.1 (WinRT), no profile, no window', await netcost.probe({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run: spy({ code: 0, stdout: 'typd-cost Fixed False False' }) }) === 'metered' &&
    /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/.test(calls[0].file) && calls[0].args.includes('-NoProfile') && calls[0].args.includes('-NonInteractive'), calls);
  calls = [];
  check('macOS: osascript -l JavaScript on a script file', await netcost.probe({ platform: 'darwin', run: spy({ code: 0, stdout: 'typd-cost cheap open path' }) }) === 'unmetered' &&
    calls[0].file === '/usr/bin/osascript' && calls[0].args[0] === '-l' && calls[0].args[1] === 'JavaScript' && fs.existsSync(calls[0].args[2]), calls);
  check('a probe that fails -> unknown', await netcost.probe({ platform: 'win32', run: fake({ code: 1, stdout: '' }) }) === 'unknown' &&
    await netcost.probe({ platform: 'darwin', run: async () => { throw new Error('no osascript'); } }) === 'unknown');
  check('another system -> unknown', await netcost.probe({ platform: 'linux', run: fake({ code: 0, stdout: 'typd-cost Unrestricted False False' }) }) === 'unknown');
  if (process.platform === 'win32') {
    const real = await netcost.probe();
    check('this PC, for real: an answer (' + real + ')', ['metered', 'unmetered', 'unknown'].includes(real), real);
  }
}

/* ---------------------------------------------------------- modelChoice.js */

async function choiceTests() {
  section('modelChoice.js: Automatic, Full, Light');
  let setting = 'auto', detects = 0, clock = 1e6;
  const hw = { platform: 'win32', arch: 'x64', nvidia: { name: 'GTX 1050', totalMiB: 2048, freeMiB: 2000 }, vendors: [] };
  const c = createChoice({ setting: () => setting, detect: async () => { detects++; return hw; }, now: () => clock });
  check('Automatic on a 2 GB card -> light', await c.variant() === 'light' && detects === 1);
  setting = 'full';
  check('Full pinned -> full, whatever the hardware', await c.variant() === 'full');
  setting = 'light';
  hw.nvidia = { name: 'RTX 4090', totalMiB: 24564, freeMiB: 20000 };
  check('Light pinned -> light on a big GPU', await c.variant() === 'light');
  setting = 'auto';
  check('Automatic again: the hardware is read once per half hour (still the 2 GB answer)', await c.variant() === 'light' && detects === 1);
  clock += 31 * 60e3;
  check('... and again after it', await c.variant() === 'full' && detects === 2);
  hw.nvidia = null;
  c.forget();
  const d = await c.describe();
  check('forget() reads it at once; describe() says what Automatic picked and why', d.setting === 'auto' && d.auto === 'light' && d.variant === 'light' && /NVIDIA/.test(d.why) && detects === 3, d);
  setting = 'turbo';
  check('an unknown setting is Automatic', await c.variant() === 'light');
  const broken = createChoice({ setting: () => 'auto', detect: async () => { throw new Error('nvidia-smi crashed'); } });
  check('a detection that throws -> light, never an error', await broken.variant() === 'light');
}

/* ---------------------------------------------------- the manifest's variants */

function entryOf(version, files, extra = {}) {
  const names = Object.keys(files);
  return {
    version,
    files: Object.entries(files).map(([name, b]) => ({ name, size: b.length, sha256: sha(b) })),
    model_json: { model: names[0], mmproj: names[1], context: true, revise: true, stream: false, prefill: '', ...(names[2] ? { revise_lora: names[2] } : {}) },
    min_app: '0.1.0',
    notes: '',
    ...extra
  };
}

function variantRules() {
  section('the manifest: variants beside the top level');
  const full = entryOf('f1', { 'typd-f1.gguf': Buffer.from('f'), 'mmproj-f.gguf': Buffer.from('p') });
  const light = entryOf('l1', { 'typd-l1.gguf': Buffer.from('l'), 'mmproj-l.gguf': Buffer.from('q') });
  const m = { ...full, seq: 5, variants: { light } };
  check('no variant asked (full) -> the top level', selectVariant(m, 'full').entry === m && selectVariant(m, 'full').variant === 'full');
  const l = selectVariant(m, 'light');
  check('light asked and published -> its entry, and nothing of the top level', l.variant === 'light' && l.entry.version === 'l1' && l.entry.files[0].name === 'typd-l1.gguf' && l.entry.seq === undefined && l.entry.variants === undefined, l);
  check('light asked, manifest without variants (as today) -> the top level', selectVariant(full, 'light').variant === 'full' && selectVariant(full, 'light').entry === full);
  check('a variant not published -> the top level', selectVariant(m, 'medium').variant === 'full');
  check('a malformed variant entry (bad file name) -> the top level', selectVariant({ ...m, variants: { light: { ...light, files: [{ ...light.files[0], name: '../x' }, light.files[1]] } } }, 'light').variant === 'full');
  check('a variant whose model_json names a file it does not list -> the top level', selectVariant({ ...m, variants: { light: { ...light, model_json: { model: 'x.gguf', mmproj: 'mmproj-l.gguf' } } } }, 'light').variant === 'full');
  check('variants that are not an object -> the top level', selectVariant({ ...m, variants: [light] }, 'light').variant === 'full' && selectVariant({ ...m, variants: 'light' }, 'light').variant === 'full');
  check("a variant without min_app takes the top level's", selectVariant({ ...m, min_app: '0.2.0', variants: { light: { ...light, min_app: undefined } } }, 'light').entry.min_app === '0.2.0');
  check('a variant with its own min_app keeps it', selectVariant({ ...m, variants: { light: { ...light, min_app: '9.0.0' } } }, 'light').entry.min_app === '9.0.0');
  check("'__proto__' or a strange name is never a variant", selectVariant(m, '__proto__').variant === 'full' && selectVariant(m, 'Light!').variant === 'full');
  check('sizes say MB under a GB, GB with one decimal above', fmtSize(611093000) === '611 MB' && fmtSize(1107404576) === '1.1 GB' && fmtSize(139474272) === '139 MB' && fmtSize(1) === '1 MB');
  check('the threshold is 300 MB, Later is a day', ASK_ABOVE_BYTES === 300e6 && LATER_MS === 86400e3);
}

/* ---------------------------------------------------------- the fake server */

const TEST_KP = crypto.generateKeyPairSync('ed25519');
const TEST_KID = 'typd-model-bench';
const TEST_KEYS = { [TEST_KID]: TEST_KP.publicKey.export({ type: 'spki', format: 'pem' }) };
let SEQ = Math.floor(Date.now() / 1000);

/** typd-collect's public routes in miniature: one signed manifest, and only the files it names (top level or variant). */
function fakeServer() {
  const s = { manifest: null, files: {}, requests: [], cutNext: {}, lastBase: null, seq: 0 };
  const liveFiles = () => {
    const m = s.manifest;
    if (!m) return new Set();
    const out = new Set(m.files.map((f) => m.version + '/' + f.name));
    for (const v of Object.values(m.variants || {})) for (const f of v.files) out.add(v.version + '/' + f.name);
    return out;
  };
  s.server = http.createServer((req, res) => {
    s.requests.push({ url: req.url, range: req.headers.range || null });
    if (req.url === '/v1/model/public/manifest') {
      if (!s.manifest) { res.writeHead(404); return res.end('{}'); }
      const base = JSON.stringify(s.manifest);
      if (base !== s.lastBase) { s.lastBase = base; s.seq = ++SEQ; }
      const text = JSON.stringify({ ...s.manifest, seq: s.seq }, null, 2) + '\n';
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Typd-Manifest-Key': TEST_KID, 'X-Typd-Manifest-Sig': crypto.sign(null, Buffer.from(SIG_PREFIX + text), TEST_KP.privateKey).toString('base64') });
      return res.end(text);
    }
    const m = /^\/v1\/model\/public\/file\/([^/]+)\/([^/]+)$/.exec(req.url);
    const key = m && decodeURIComponent(m[1]) + '/' + decodeURIComponent(m[2]);
    if (!m || !liveFiles().has(key) || !s.files[key]) { res.writeHead(404); return res.end(); }
    const body = s.files[key];
    const r = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    const start = r ? Number(r[1]) : 0;
    const part = body.subarray(start);
    res.writeHead(r ? 206 : 200, { 'Content-Length': String(part.length), ...(r ? { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}) });
    const cut = s.cutNext[decodeURIComponent(m[2])];
    if (cut) { delete s.cutNext[decodeURIComponent(m[2])]; res.write(part.subarray(0, cut), () => setTimeout(() => res.destroy(), 30)); return; }
    res.end(part);
  });
  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => { s.endpoint = `http://127.0.0.1:${s.server.address().port}`; resolve(s); }));
}

function store(s, files, version) { for (const [name, b] of Object.entries(files)) s.files[version + '/' + name] = b; }
const fileRequests = (s, version) => s.requests.filter((q) => q.url.startsWith('/v1/model/public/file/') && (!version || q.url.includes('/' + version + '/')));

/* ------------------------------------------------------------- the updater */

async function updaterTests() {
  const s = await fakeServer();
  const root = path.join(tmp, 'updater');
  const bundledDir = path.join(root, 'bundled');
  fs.mkdirSync(bundledDir, { recursive: true });
  // The bundled model is the published full one (a fresh install of a build made from it).
  const fullFiles = { 'typd-full.gguf': crypto.randomBytes(400000), 'mmproj-full.gguf': crypto.randomBytes(100000) };
  for (const [n, b] of Object.entries(fullFiles)) fs.writeFileSync(path.join(bundledDir, n), b);
  fs.writeFileSync(path.join(bundledDir, 'model.json'), JSON.stringify({ model: 'typd-full.gguf', mmproj: 'mmproj-full.gguf', context: true, revise: true, stream: false, prefill: '' }));
  const lightFiles = { 'typd-light.gguf': crypto.randomBytes(300000), 'mmproj-light.gguf': crypto.randomBytes(80000) };
  const lightBytes = 380000;
  store(s, fullFiles, 'full1');
  store(s, lightFiles, 'light1');
  const fullEntry = entryOf('full1', fullFiles);
  const lightEntry = entryOf('light1', lightFiles, { notes: 'the 0.6B' });
  s.manifest = { ...fullEntry, variants: { light: lightEntry } };

  let clock = Date.parse('2026-10-17T12:00:00Z');
  let cost = 'metered';
  let want = 'light';
  let askFirst = false;
  let failSwitchTo = null;
  const switches = [];
  const modelsDir = path.join(root, 'userData', 'models');
  const make = (over = {}) => createUpdater({
    keys: TEST_KEYS, config: { endpoint: s.endpoint, key: null }, modelsDir, bundledDir, appVersion: '0.2.2',
    switchModel: async () => { const a = activeModel(modelsDir); const v = a ? a.version : 'bundled'; switches.push(v); if (failSwitchTo === v) throw new Error('the model failed its self-test'); },
    rate: 0, idleMs: 0, now: () => clock,
    variant: async () => want, askFirst: () => askFirst, networkCost: async () => cost,
    askAboveBytes: 200000,   // the 300 MB threshold, scaled to the fake files
    ...over
  });
  const current = () => readJson(path.join(modelsDir, 'current.json'));
  const state = () => readJson(path.join(modelsDir, 'state.json')) || {};

  section('a light machine on a metered connection: asks, downloads nothing');
  let u = make();
  s.requests = [];
  let r = await u.check();
  check('state "ask", no file requested, still on the bundled full model', r.state === 'ask' && fileRequests(s).length === 0 && !current(), { r, files: fileRequests(s) });
  check('pending: the light version, its size, why (metered)', u.pending && u.pending.version === 'light1' && u.pending.variant === 'light' && u.pending.bytes === lightBytes && u.pending.why === 'metered' && u.pending.later === false, u.pending);
  check('the tray line says so', /new model available \(1 MB\)$/.test(u.line()), u.line());
  check('the variant asked for and the one followed', u.chosen.want === 'light' && u.chosen.got === 'light', u.chosen);

  section('Later: not asked again for 24 hours, then asked again');
  check('later() -> state "later", remembered in state.json for a day', (await u.later()) === true && u.state === 'later' && state().later.version === 'light1' && state().later.until === clock + LATER_MS, state());
  check('pending still names it (the tray keeps "Update now"), marked later', u.pending && u.pending.later === true);
  clock += 6 * 3600e3;
  r = await make().check();
  check('6 h later (a new start, the next check): still waiting, nothing requested, the next hourly check', r.state === 'later' && fileRequests(s).length === 0 && r.next === 3600e3, r);
  clock += 14 * 3600e3;
  r = await make().check();
  check('20 h later: still hourly (the 24 h mark is 4 h away)', r.state === 'later' && r.next === 3600e3, r);
  clock += 4 * 3600e3 + 1000;
  u = make();
  r = await u.check();
  check('24 h later: asked again', r.state === 'ask' && u.pending && u.pending.later === false && fileRequests(s).length === 0, r);

  section('Update now: downloads, verifies, switches; the approval survives a restart and a cut connection');
  s.cutNext['typd-light.gguf'] = 120000;
  check('approve() -> state.json says light1 may download', (await u.approve()) === true && state().approved.version === 'light1' && !state().later, state());
  r = await make().check();
  check('a new start (the approval kept): downloading, cut off -> retry, a partial file kept', r.state === 'retry' && fs.existsSync(path.join(modelsDir, 'light1.partial', 'typd-light.gguf')), r);
  s.requests = [];
  u = make();
  r = await u.check();
  check('the next check resumes with Range, never asks again, then switches to light1', r.state === 'current' && current().version === 'light1' && switches[switches.length - 1] === 'light1' &&
    fileRequests(s).some((q) => q.range && q.range.startsWith('bytes=')), { r, req: s.requests });
  check('the light files byte for byte; no full file requested', sha(fs.readFileSync(path.join(modelsDir, 'light1', 'typd-light.gguf'))) === sha(lightFiles['typd-light.gguf']) && fileRequests(s, 'full1').length === 0);
  check('the tray names the light version', u.line() === 'Model light1 · up to date', u.line());

  section('back to Full (Settings, or a bigger GPU): the bundled model, no download');
  want = 'full';
  s.requests = [];
  r = await make().check();
  check('switched back to the bundled full model, nothing downloaded, light1 deleted after the good start', r.state === 'current' && !current() && fileRequests(s).length === 0 &&
    switches[switches.length - 1] === 'bundled' && !fs.existsSync(path.join(modelsDir, 'light1')), { r, cur: current(), switches });
  check('state.json knows the bundled model is full1', state().bundled && state().bundled.version === 'full1', state());

  section('an unmetered connection, or a small download: no question');
  want = 'light';
  cost = 'unmetered';
  s.manifest = { ...fullEntry, notes: 'n2', variants: { light: entryOf('light2', lightFiles) } };
  store(s, lightFiles, 'light2');
  r = await make().check();
  check('unmetered: light2 downloads and switches without asking', r.state === 'current' && current().version === 'light2', r);
  cost = 'metered';
  const small = { 'typd-light.gguf': lightFiles['typd-light.gguf'], 'mmproj-light.gguf': lightFiles['mmproj-light.gguf'], 'rev-small.gguf': crypto.randomBytes(50000) };
  store(s, small, 'light3');
  s.manifest = { ...fullEntry, notes: 'n3', variants: { light: entryOf('light3', small) } };
  s.requests = [];
  r = await make().check();
  check('metered, but only 50 KB to fetch (the rest copied from light2): no question, only the new file requested', r.state === 'current' && current().version === 'light3' &&
    fileRequests(s).length === 1 && fileRequests(s)[0].url.endsWith('/rev-small.gguf'), { r, req: fileRequests(s) });

  section('"Ask before downloading new models": every download asks');
  askFirst = true;
  cost = 'unmetered';
  const tiny = { ...small, 'rev-small.gguf': crypto.randomBytes(1000) };
  store(s, tiny, 'light4');
  s.manifest = { ...fullEntry, notes: 'n4', variants: { light: entryOf('light4', tiny) } };
  u = make();
  r = await u.check();
  check('unmetered and 1 KB, but the setting is on: asks', r.state === 'ask' && u.pending.why === 'setting' && u.pending.bytes === 1000 && current().version === 'light3', { r, p: u.pending });
  await u.approve();
  r = await u.check();
  check('Update now -> light4', r.state === 'current' && current().version === 'light4', r);
  askFirst = false;

  section('an unknown connection cost counts as metered (asks)');
  cost = 'unknown';
  const other = { 'typd-light5.gguf': crypto.randomBytes(250000), 'mmproj-light.gguf': lightFiles['mmproj-light.gguf'] };
  store(s, other, 'light5');
  s.manifest = { ...fullEntry, notes: 'n5', variants: { light: entryOf('light5', other) } };
  u = make();
  r = await u.check();
  check('asks, and counts only the 250 KB not already here (the mmproj is copied)', r.state === 'ask' && u.pending.why === 'unknown' && u.pending.bytes === 250000, u.pending);
  let probes = 0;
  r = await make({ networkCost: async () => { probes++; return 'metered'; }, askAboveBytes: 10e6 }).check();
  check('under the threshold the connection is not even probed', r.state === 'current' && probes === 0 && current().version === 'light5', { r, probes });

  section('a light model that fails to start: reverted, not retried while Full still is');
  cost = 'unmetered';
  const bad = { 'typd-bad.gguf': crypto.randomBytes(1000), 'mmproj-light.gguf': lightFiles['mmproj-light.gguf'] };
  store(s, bad, 'light6');
  s.manifest = { ...fullEntry, notes: 'n6', variants: { light: entryOf('light6', bad) } };
  failSwitchTo = 'light6';
  r = await make().check();
  check('light6 fails its start -> back to light5, remembered as bad', r.state === 'failed' && current().version === 'light5' && state().bad.version === 'light6', { r, bad: state().bad });
  r = await make().check();
  check('checked again, the same manifest: not retried', r.state === 'failed' && current().version === 'light5');
  want = 'full';
  r = await make().check();
  check('the same manifest, Full chosen: followed (the failure was the light one)', r.state === 'current' && !current(), { r, cur: current() });
  want = 'light';
  r = await make().check();
  check('Light again, the same manifest: still not retried', r.state === 'failed' && !current());
  failSwitchTo = null;

  section('the top level is untouched by variants: a full machine sees exactly what it saw before');
  want = 'full';
  s.requests = [];
  r = await make().check();
  check('full: current on the bundled model, no file requested', r.state === 'current' && fileRequests(s).length === 0, r);

  section("Typd 0.2.2's own modelUpdate.js (git 0f9daac) and a manifest with variants");
  const old = spawnSync('git', ['-C', ROOT, 'show', '0f9daac:src/main/modelUpdate.js'], { encoding: 'utf8', windowsHide: true });
  if (old.status !== 0) {
    check('git show 0f9daac:src/main/modelUpdate.js', false, old.stderr);
  } else {
    const dir = path.join(tmp, 'old-0.2.2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'modelUpdate.js'), old.stdout);
    const { createUpdater: oldUpdater } = require(path.join(dir, 'modelUpdate.js'));
    const oldModels = path.join(tmp, 'old-models');
    const emptyBundled = path.join(tmp, 'old-bundled');
    fs.mkdirSync(emptyBundled, { recursive: true });
    fs.writeFileSync(path.join(emptyBundled, 'model.json'), JSON.stringify({ model: 'old.gguf', mmproj: 'old-mm.gguf' }));
    s.requests = [];
    const ou = oldUpdater({ keys: TEST_KEYS, config: { endpoint: s.endpoint, key: null }, modelsDir: oldModels, bundledDir: emptyBundled, appVersion: '0.2.2', switchModel: async () => {}, rate: 0, idleMs: 0 });
    r = await ou.check();
    const oc = readJson(path.join(oldModels, 'current.json'));
    check('it downloads and switches to the top level (full1), as before', r.state === 'current' && oc && oc.version === 'full1', { r, oc });
    check('and never requests a variant file', fileRequests(s).length === 2 && fileRequests(s, 'full1').length === 2, fileRequests(s));
    r = await ou.check();
    check('a second check: up to date', r.state === 'current');
  }
  s.server.close();
}

/* ------------------------------------------------------------ the walkthrough */

function walkthroughTests() {
  section('the walkthrough: when it shows (source checks)');
  const idx = read('src/main/index.js');
  const due = (idx.match(/function walkthroughDue\(\) \{[\s\S]*?\n\}/) || [''])[0];
  const start = (idx.match(/function startWalkthrough\(afterUpdate\) \{[\s\S]*?\n\}/) || [''])[0];
  check('only in a packaged build (from source with TYPD_WALKTHROUGH=1)', /!app\.isPackaged && process\.env\.TYPD_WALKTHROUGH !== '1'/.test(due));
  check("only while settings' walkthrough is 'due' (a fresh install, once)", /settings\.get\('walkthrough'\) === 'due'/.test(due));
  check('decided by settings.walkthroughFor (fresh install, not after an update) before anything shows',
    /settings\.walkthroughFor\(\{ fresh: settings\.isFreshInstall\(\), afterUpdate: Boolean\(afterUpdate\) \}\)/.test(start) && start.indexOf('walkthroughFor') < start.indexOf('walkthroughDue()'));
  check('fresh or not is read before this launch writes anything (before isFirstRun, the overlay and the model updater)',
    idx.indexOf('settings.isFreshInstall();') > 0 && idx.indexOf('settings.isFreshInstall();') < idx.indexOf('firstRunNote = settings.isFirstRun();') &&
    idx.indexOf('settings.isFreshInstall();') < idx.indexOf('modelUpdate.start({'));
  check('never with --stub, --preview, TYPD_NO_WALKTHROUGH=1 or the CI window test', /stub \|\| preview/.test(due) && /TYPD_NO_WALKTHROUGH === '1'/.test(due) && /TYPD_TEST_CLOSE_HOME/.test(due));
  check("never after an app update: no path in startWalkthrough waits for one", !/whenUserActive/.test(start));
  check('started with afterUpdate = the first start after an app update', /startWalkthrough\(Boolean\(appUpdater && appUpdater\.firstStart\)\)/.test(idx));
  check('one question at a time: it waits while the Mac permission dialog is open (there is no consent screen)', !/consent/.test(start.replace(/\/\*[\s\S]*?\*\//g, '')) && /isAsking\(\)/.test(start));
  check('marked done as it opens (closing it early does not bring it back), in the home window', /settings\.set\('walkthrough', 'done'\);\s*home\.open\('home', \{ walkthrough: true[^}]*\}\)/.test(start));
  check("the practice box: the key dictates there, and only there, in Typd's own window", /if \(session \|\| !home\.isFocused\(\) \|\| home\.isPracticing\(\)\) return false;/.test(idx));
  const hw = read('src/main/home-window.js');
  check('isPracticing needs the box focused and the window focused', /practicing && win && !win\.isDestroyed\(\) && win\.isFocused\(\)/.test(hw) && /practicing = false;/.test(hw));
  const html = read('src/renderer/home.html'), js = read('src/renderer/home.js');
  check('five steps, each with its picture', (html.match(/data-art="[1-5]"/g) || []).length === 5 && /var STEPS = 5;/.test(js));
  check('the steps: what Typd is, a dictation, a revision, "That was wrong", done', ['Typd writes what you say', 'Try a dictation', 'Change what you wrote', 'got it wrong', 'You’re set'].every((t) => js.toLowerCase().includes(t.toLowerCase())));
  check('skippable (Skip, Esc), and Settings opens it again', /\$\('walkSkip'\)\.addEventListener\('click', close\)/.test(js) && /e\.key === 'Escape'/.test(js) && /\$\('walkAgain'\)\.addEventListener\('click', function \(\) \{ walk\.open\(1\); \}\)/.test(js));
  check("the revise step names the user's own key; the flag step the flag shortcut or the default (Alt+Shift+Backspace / Ctrl+Shift+Backspace)",
    /withKeys\(\$\('walkBody'\), body, parts\)/.test(js) && /parts = flagParts\(\)/.test(js) && /flagDefault: \{ parts: hotkeyLogic\.parts\(hotkeyLogic\.flagDefaultFor/.test(hw));
  const e2e = read('bench/app-update-e2e.js');
  check("the CI's app-update test starts as a person who has seen it (settings walkthrough 'done')", /if \(saved\.walkthrough !== 'done'\) next\.walkthrough = 'done';/.test(e2e));
  const settingsJs = read('src/main/settings.js');
  check('settings: modelVariant auto|full|light (default auto), askBeforeModelDownload off, walkthrough', /modelVariant: 'auto'/.test(settingsJs) && /askBeforeModelDownload: false/.test(settingsJs) && /walkthrough: ''/.test(settingsJs) && /const VARIANTS = \['auto', 'full', 'light'\]/.test(settingsJs));
}

/* ------------------------------------------------------------------------ run */

(async () => {
  await hardwareTests();
  await netcostTests();
  await choiceTests();
  variantRules();
  await updaterTests();
  walkthroughTests();
})().catch((e) => { failures++; console.log('  FAIL  ' + (e && e.stack)); }).finally(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* held open */ }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
});
