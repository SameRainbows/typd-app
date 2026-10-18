'use strict';

/**
 * scripts/public-build.js verify, on fake packaged apps: a clean one passes and gets its
 * .public.json; a tester.json (in resources or inside app.asar), a key file anywhere, a known key
 * inside any file, or a bad installer name each fail, remove the record, and never print the key.
 * If dictation-research is beside this checkout, publish_app.py's own record check must accept
 * the record written here. Last, the asar reader on a real app.asar if one has been built.
 *
 *   node bench/public-build.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');
const { readAsar } = require('../scripts/public-build.js');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'public-build.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-public-build-'));
const KEY = 'tk_bench_' + crypto.randomBytes(16).toString('hex');
let failed = 0;
const check = (ok, what, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + what + (!ok && detail !== undefined ? '   ' + String(detail).slice(-600) : '')); if (!ok) failed++; };

function asar(files) {
  const header = { files: {} }, blobs = [];
  let offset = 0;
  for (const [p, data] of Object.entries(files)) {
    const segs = p.split('/');
    let node = header;
    for (const s of segs.slice(0, -1)) { node.files[s] = node.files[s] || { files: {} }; node = node.files[s]; }
    node.files[segs[segs.length - 1]] = { size: data.length, offset: String(offset) };
    offset += data.length;
    blobs.push(data);
  }
  const json = Buffer.from(JSON.stringify(header));
  const padded = Math.ceil(json.length / 4) * 4;
  const hp = Buffer.alloc(8 + padded);
  hp.writeUInt32LE(4 + padded, 0);
  hp.writeUInt32LE(json.length, 4);
  json.copy(hp, 8);
  const sp = Buffer.alloc(8);
  sp.writeUInt32LE(4, 0);
  sp.writeUInt32LE(hp.length, 4);
  return Buffer.concat([sp, hp, ...blobs]);
}

const CUDA_FILES = [['ggml-cuda.dll', crypto.randomBytes(3000)], ['cublas64_12.dll', crypto.randomBytes(2000)], ['cublasLt64_12.dll', crypto.randomBytes(2500)], ['cudart64_12.dll', crypto.randomBytes(500)]];
const withCuda = (app) => { for (const [name, b] of CUDA_FILES) fs.writeFileSync(path.join(app, 'resources', 'llama', name), b); };

/** A fake win-unpacked folder and installer; `change(app)` spoils it. */
function fakeApp(name, change = () => {}, asarExtra = {}) {
  const app = path.join(tmp, name, 'win-unpacked');
  const res = path.join(app, 'resources');
  fs.mkdirSync(path.join(res, 'models', 'typd-dictate'), { recursive: true });
  fs.mkdirSync(path.join(res, 'llama'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Typd.exe'), crypto.randomBytes(4096));
  fs.writeFileSync(path.join(res, 'app.asar'), asar({
    'package.json': Buffer.from(JSON.stringify({ name: 'typd', version: '9.9.9' })),
    'src/main/index.js': Buffer.from('// main'),
    'src/main/collect.js': Buffer.from("const ENDPOINT = 'https://typd-collect.mehmetdedeler.com';"),
    ...asarExtra
  }));
  fs.writeFileSync(path.join(res, 'models', 'typd-dictate', 'model.json'), JSON.stringify({ model: 'm.gguf', mmproj: 'mm.gguf' }));
  fs.writeFileSync(path.join(res, 'models', 'typd-dictate', 'm.gguf'), crypto.randomBytes(3 * 1024 * 1024));
  fs.writeFileSync(path.join(res, 'models', 'typd-dictate', 'mm.gguf'), crypto.randomBytes(1024 * 1024));
  fs.writeFileSync(path.join(res, 'llama', 'llama-server.exe'), crypto.randomBytes(8192));
  // Since 0.2.5: cuda.json names the CUDA backend the app fetches as its pack (none of its files here).
  fs.writeFileSync(path.join(res, 'llama', 'cuda.json'), JSON.stringify({ schema: 'typd-cuda/1', pack: 'cuda-b1-cu12.4', llama: { build: 1, commit: 'abc' }, cuda: '12.4',
    files: CUDA_FILES.map(([name, b]) => ({ name, size: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') })) }));
  change(app);
  const installer = path.join(tmp, name, 'Typd-Setup-9.9.9.exe');
  fs.writeFileSync(installer, crypto.randomBytes(2 * 1024 * 1024));
  return { app, installer };
}

const keyFile = path.join(tmp, 'tester.bench.json');
fs.writeFileSync(keyFile, JSON.stringify({ tester: 'bench', key: KEY }));
function verify(app, installer, platform = 'win-x64', expect = null, expectCuda = null) {
  const r = spawnSync(process.execPath, [SCRIPT, 'verify', '--app', app, '--platform', platform, ...(installer ? ['--installer', installer] : []), ...(expect ? ['--expect-model', expect] : []),
    ...(expectCuda ? ['--expect-cuda', expectCuda] : [])], {
    encoding: 'utf8', env: { ...process.env, TYPD_PUBLIC_EXTRA_KEY_FILES: keyFile }
  });
  const out = (r.stdout || '') + (r.stderr || '');
  if (out.includes(KEY)) check(false, 'the output contains the key');
  return { status: r.status, out };
}

try {
  // 1. clean
  let a = fakeApp('clean');
  let r = verify(a.app, a.installer);
  const recPath = a.installer + '.public.json';
  const rec = fs.existsSync(recPath) ? JSON.parse(fs.readFileSync(recPath, 'utf8')) : null;
  const bytes = fs.readFileSync(a.installer);
  check(r.status === 0 && rec && rec.ok === true, 'a clean app passes and gets a .public.json', r.out);
  check(rec && rec.schema === 'typd-public-build/1' && rec.file === 'Typd-Setup-9.9.9.exe' && rec.size === bytes.length &&
    rec.sha256 === crypto.createHash('sha256').update(bytes).digest('hex') && rec.app_version === '9.9.9' && rec.model === 'm.gguf', 'the record: file, size, sha256, the version from app.asar, the model', JSON.stringify(rec));
  check(rec && rec.checks.known_keys_scanned >= 1 && rec.checks.known_keys_found === 0 && rec.checks.tester_json_absent && rec.checks.no_key_files && rec.checks.asar_clean && rec.checks.model_ok,
    'the record: every check true, at least the planted key searched for, none found', JSON.stringify(rec && rec.checks));

  // publish_app.py's own check accepts it
  const research = path.join(ROOT, '..', 'dictation-research', 'scripts');
  if (fs.existsSync(path.join(research, 'publish_app.py'))) {
    const py = `import sys, json, hashlib; sys.path.insert(0, ${JSON.stringify(research)}); import publish_app as pa; from pathlib import Path
p = Path(${JSON.stringify(a.installer)}); b = p.read_bytes()
print(json.dumps(pa.public_record_problems(p, len(b), hashlib.sha256(b).hexdigest())))`;
    const x = spawnSync('python', ['-c', py], { encoding: 'utf8' });
    check(x.status === 0 && x.stdout.trim() === '[]', "dictation-research's publish_app.py accepts the record", x.stdout + x.stderr);
    fs.appendFileSync(a.installer, 'x');
    const y = spawnSync('python', ['-c', py], { encoding: 'utf8' });
    check(/not the file that was checked/.test(y.stdout), 'and refuses it once the installer changes', y.stdout + y.stderr);
  } else {
    console.log('SKIP publish_app.py cross-check (no ../dictation-research)');
  }

  // 2. --app without --installer: checks, no record
  r = verify(a.app, null);
  check(r.status === 0 && /no record written/.test(r.out), 'without --installer: checked, no record');

  // 3. tester.json in resources
  a = fakeApp('tester', (app) => fs.writeFileSync(path.join(app, 'resources', 'tester.json'), JSON.stringify({ tester: 'x', key: 'k'.repeat(20) })));
  fs.writeFileSync(a.installer + '.public.json', '{"stale": true}');
  r = verify(a.app, a.installer);
  check(r.status === 1 && /tester build/.test(r.out) && !fs.existsSync(a.installer + '.public.json'), 'tester.json in resources: fails, and a stale record is removed', r.out);

  // 4. a known key inside a file
  a = fakeApp('key', (app) => fs.writeFileSync(path.join(app, 'resources', 'llama', 'ggml-x.dll'), Buffer.concat([crypto.randomBytes(5000), Buffer.from(KEY), crypto.randomBytes(5000)])));
  r = verify(a.app, a.installer);
  check(r.status === 1 && /the key from .*tester\.bench\.json is inside: resources[\\/]llama[\\/]ggml-x\.dll/.test(r.out) && /known_keys_found: 1/.test(r.out), 'a known key inside a dll: fails, names the file, not the key', r.out);

  // 5. a known key across the 32 MiB chunk boundary
  a = fakeApp('boundary', (app) => {
    const b = Buffer.alloc(32 * 1024 * 1024 + 4096, 7);
    Buffer.from(KEY).copy(b, 32 * 1024 * 1024 - 10);
    fs.writeFileSync(path.join(app, 'resources', 'big.bin'), b);
  });
  r = verify(a.app, a.installer);
  check(r.status === 1 && /big\.bin/.test(r.out), 'a key split across the read chunks is still found', r.out);

  // 6. tester.json inside app.asar
  a = fakeApp('asar', () => {}, { 'tester.json': Buffer.from('{}') });
  r = verify(a.app, a.installer);
  check(r.status === 1 && /inside app\.asar: tester\.json/.test(r.out), 'tester.json inside app.asar: fails', r.out);

  // 7. other key-bearing files
  a = fakeApp('files', (app) => {
    fs.writeFileSync(path.join(app, 'resources', 'model-updates.json'), '{}');
    fs.mkdirSync(path.join(app, 'resources', '.secrets'));
  });
  r = verify(a.app, a.installer);
  check(r.status === 1 && /model-updates\.json/.test(r.out) && /\.secrets/.test(r.out), 'model-updates.json and a .secrets folder: fail', r.out);

  // 8. installer names
  a = fakeApp('names');
  const spaced = path.join(path.dirname(a.installer), 'Typd Setup 9.9.9.exe');
  fs.renameSync(a.installer, spaced);
  r = verify(a.app, spaced);
  check(r.status === 1 && /no spaces/.test(r.out), 'an installer name with spaces: fails', r.out);
  const tname = path.join(path.dirname(a.installer), 'Typd-9.9.9-mac-arm64-tester.dmg');
  fs.renameSync(spaced, tname);
  r = verify(a.app, tname);
  check(r.status === 1 && /named as a tester build/.test(r.out), 'an installer named as a tester build: fails', r.out);

  // 9. a missing model
  a = fakeApp('nomodel', (app) => fs.rmSync(path.join(app, 'resources', 'models', 'typd-dictate', 'mm.gguf')));
  r = verify(a.app, a.installer);
  check(r.status === 1 && /model_ok: false/.test(r.out), 'no mmproj: fails', r.out);

  // 9b. a model-less public build (0.2.5): no model at all, llama-server there
  const modelLess = (app) => {
    const dir = path.join(app, 'resources', 'models', 'typd-dictate');
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
    fs.writeFileSync(path.join(dir, 'NO_MODEL.txt'), 'downloaded at first launch');
  };
  a = fakeApp('modelless', modelLess);
  r = verify(a.app, a.installer, 'win-x64', 'no');
  const mrec = fs.existsSync(a.installer + '.public.json') ? JSON.parse(fs.readFileSync(a.installer + '.public.json', 'utf8')) : null;
  check(r.status === 0 && mrec && mrec.ok && mrec.bundled_model === false && mrec.model === null && mrec.model_bytes === 0 &&
    mrec.checks.model_ok === true && mrec.checks.model_absent === true && mrec.checks.bundled_model === false,
  'a model-less app (no model, llama-server there): passes; the record says bundled_model false, model null', r.out);
  if (fs.existsSync(path.join(research, 'publish_app.py'))) {
    const py = `import sys, json, hashlib; sys.path.insert(0, ${JSON.stringify(research)}); import publish_app as pa; from pathlib import Path
p = Path(${JSON.stringify(a.installer)}); b = p.read_bytes()
print(json.dumps(pa.public_record_problems(p, len(b), hashlib.sha256(b).hexdigest())))`;
    const x = spawnSync('python', ['-c', py], { encoding: 'utf8' });
    check(x.status === 0 && x.stdout.trim() === '[]', "publish_app.py accepts a model-less build's record too", x.stdout + x.stderr);
  }
  r = verify(a.app, a.installer, 'win-x64', 'yes');
  check(r.status === 1 && /expected a bundled model/.test(r.out), '--expect-model yes on a model-less app: fails', r.out);
  a = fakeApp('bundled-expect');
  r = verify(a.app, a.installer, 'win-x64', 'no');
  check(r.status === 1 && /expected a model-less build/.test(r.out), '--expect-model no on an app with its model: fails', r.out);
  a = fakeApp('stray-gguf', (app) => { modelLess(app); fs.writeFileSync(path.join(app, 'resources', 'models', 'typd-dictate', 'x.gguf'), crypto.randomBytes(1000)); });
  r = verify(a.app, a.installer, 'win-x64', 'no');
  check(r.status === 1 && /model files are in the app/.test(r.out), 'no model.json but a .gguf left in the app: fails', r.out);
  a = fakeApp('no-server', (app) => { modelLess(app); fs.rmSync(path.join(app, 'resources', 'llama', 'llama-server.exe')); });
  r = verify(a.app, a.installer, 'win-x64', 'no');
  check(r.status === 1 && /llama-server is missing/.test(r.out), 'model-less without llama-server: fails', r.out);

  // 9c. the CUDA backend (0.2.5): none of it in a public app, cuda.json naming its pack
  a = fakeApp('nocuda', modelLess);
  r = verify(a.app, a.installer, 'win-x64', 'no', 'no');
  const crec = fs.existsSync(a.installer + '.public.json') ? JSON.parse(fs.readFileSync(a.installer + '.public.json', 'utf8')) : null;
  check(r.status === 0 && crec && crec.bundled_cuda === false && crec.cuda_pack === 'cuda-b1-cu12.4' && crec.checks.cuda_ok === true,
    'no CUDA file, cuda.json there: passes; the record says bundled_cuda false and names the pack', r.out);
  a = fakeApp('withcuda', (app) => { modelLess(app); withCuda(app); });
  r = verify(a.app, a.installer, 'win-x64', 'no', 'no');
  check(r.status === 1 && /expected no CUDA backend/.test(r.out), '--expect-cuda no on an app with the CUDA backend: fails', r.out);
  r = verify(a.app, a.installer, 'win-x64', 'no', 'yes');
  check(r.status === 0, '--expect-cuda yes on it: passes', r.out);
  a = fakeApp('partcuda', (app) => { modelLess(app); withCuda(app); fs.rmSync(path.join(app, 'resources', 'llama', 'cublasLt64_12.dll')); });
  r = verify(a.app, a.installer, 'win-x64', 'no');
  check(r.status === 1 && /part of the CUDA backend/.test(r.out), 'part of the CUDA backend: fails', r.out);
  a = fakeApp('nocudajson', (app) => { modelLess(app); fs.rmSync(path.join(app, 'resources', 'llama', 'cuda.json')); });
  r = verify(a.app, a.installer, 'win-x64', 'no');
  check(r.status === 1 && /cuda\.json is missing/.test(r.out), 'no cuda.json (the app would not know its pack): fails', r.out);
  a = fakeApp('straycuda', (app) => { modelLess(app); fs.writeFileSync(path.join(app, 'resources', 'cudart64_13.dll'), 'x'); });
  r = verify(a.app, a.installer, 'win-x64', 'no');
  check(r.status === 1 && /CUDA libraries cuda\.json does not name/.test(r.out), 'a CUDA library cuda.json does not name: fails', r.out);

  // 10. the asar reader on a real build, if there is one
  let main = ROOT;
  try { main = /^worktree (.+)$/m.exec(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }))[1]; } catch { /* this checkout */ }
  const real = [path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar'), path.join(main, 'dist', 'win-unpacked', 'resources', 'app.asar')].find((f) => fs.existsSync(f));
  if (real) {
    const x = readAsar(real);
    const version = JSON.parse(x.read('package.json').toString('utf8')).version;
    const n = x.files.length;
    const hasMain = x.files.some((f) => f.path === 'src/main/index.js');
    const unpacked = x.files.filter((f) => f.unpacked).map((f) => f.path);
    x.close();
    check(n > 10 && hasMain && /^\d+\.\d+\.\d+$/.test(version) && unpacked.includes('src/main/inject.ps1'),
      `a real app.asar (${path.relative(path.dirname(ROOT), real)}): ${n} files, package.json ${version}, inject.ps1 unpacked`);
  } else {
    console.log('SKIP the asar reader on a real build (none built here)');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
