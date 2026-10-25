#!/usr/bin/env node
'use strict';

/**
 * Public builds: an app anyone may download, so it must carry no key (docs/PUBLIC_BETA.md).
 *
 *   node scripts/public-build.js win [--dir] [--out dist/public] [--with-model] [--with-cuda]
 *       Windows: electron-builder --win nsis --x64 into dist/public as Typd-Setup-<version>.exe
 *       (no spaces: the download route takes 1-128 of A-Z a-z 0-9 . _ -), with every tester
 *       variable cleared, then `verify` on the unpacked app the installer was made from.
 *       Since 0.2.5 WITHOUT the dictation model (TYPD_NO_BUNDLED_MODEL=1): the app downloads the
 *       one its hardware suits at first launch (src/main/modelUpdate.js). --with-model bundles
 *       models/typd-dictate as before. And WITHOUT llama.cpp's CUDA backend (TYPD_NO_BUNDLED_CUDA=1,
 *       1.14 GB unpacked): the app is llama.cpp's CPU build and a PC on the GPU path fetches the
 *       CUDA pack after its model (src/main/cudaPack.js). --with-cuda bundles it as before.
 *       --dir makes only the unpacked app (no installer, no record): a quick check of the pipeline.
 *
 *   node scripts/public-build.js verify --app <app> --platform <win-x64|mac-arm64|mac-x64> [--installer <file>]
 *       Checks a packaged app (win-unpacked, or Typd.app -- the Mac CI mounts the dmg and checks
 *       the app inside it) and, with --installer, writes <installer>.public.json. That record is
 *       what dictation-research/scripts/publish_app.py --public requires; it is written only when
 *       every check passes, and a stale one is removed when they do not.
 *
 * The checks:
 *   tester_json_absent  no <resources>/tester.json (src/main/collect.js shares only with one)
 *   no_key_files        no tester*.json, model-updates.json, collect_admin.txt, *.secret or .secrets/
 *                       anywhere in the app, nor .env files
 *   asar_clean          the same names are not inside app.asar either
 *   model_ok            with a bundled model: the packaged model.json names a model and an mmproj
 *                       that are there, and llama-server is there. Without one (a model-less public
 *                       build, the default since 0.2.5): no .gguf anywhere in the app, no model.json,
 *                       and llama-server is there (also as model_absent / bundled_model: false).
 *                       --expect-model yes|no makes the kind itself a check.
 *   cuda_ok             Windows: resources/llama/cuda.json names the CUDA backend and its pack, and
 *                       either every file it names is there (bundled_cuda) or none is (the CUDA pack
 *                       is fetched: the default since 0.2.5). --expect-cuda yes|no makes the kind a check.
 *   mic_helper          since 0.2.12: the native microphone helper is at <resources>/mic (scripts/build-mic.js);
 *                       on Windows, when vendor/mic/BUILD.json is here, it is that build of this tree's source.
 *   patched_mtmd        since 0.2.7: llama.cpp's mtmd library in the app (mtmd.dll, libmtmd.0.dylib) is Typd's
 *                       patched build (scripts/build-mtmd.js: it carries MTMD_QWEN3A_CONV_GROUP), so the audio
 *                       encoder runs one conv chunk at a time (src/main/pipeline/local.js). The stock one would
 *                       still work, with a ~0.5 GB bigger encoder buffer; a public build must not ship it.
 *   known keys          every key this machine knows -- tester*.json in this checkout and the main one,
 *                       this machine's model-updates.json reader key, dictation-research's admin key,
 *                       $TYPD_COLLECT_ADMIN_KEY -- is searched for, byte for byte, in every file of
 *                       the app. None may be found. Keys are never printed; only how many were
 *                       searched for and which files held one. In CI there are none to search for.
 *   the name            the installer's name has no "tester" and fits the download route
 *
 * TYPD_PUBLIC_EXTRA_KEY_FILES (paths separated by the platform's delimiter) adds JSON files with a
 * "key", or text files that are a key, to the search (bench/public-build.js uses it).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCHEMA = 'typd-public-build/1';
const TESTER_VARS = ['TYPD_TESTER_CONFIG', 'TYPD_TESTER_DEV', 'TYPD_TESTER_JSON'];
const KEY_FILE = (name) => /^tester(\..+)?\.json$/i.test(name) || /^model-updates\.json$/i.test(name) ||
  /^collect_admin\.txt$/i.test(name) || /\.secret$/i.test(name) || /^\.env(\..+)?$/i.test(name);
const KEY_DIR = (name) => name === '.secrets';

function fail(msg) { console.error('public-build: ' + msg); process.exit(1); }

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['dir', 'with-model', 'with-cuda'].includes(k)) out[k] = true;
      else out[k] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

/* ------------------------------------------------------------------ asar */

/** The file list of an asar archive (and a reader for one file), from its header. */
function readAsar(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);      // pickle of the header
    const jsonLen = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonLen);
    fs.readSync(fd, json, 0, jsonLen, 16);
    const header = JSON.parse(json.toString('utf8'));
    const base = 8 + headerSize;
    const files = [];
    (function walk(node, prefix) {
      for (const [name, entry] of Object.entries(node.files || {})) {
        const p = prefix ? prefix + '/' + name : name;
        if (entry.files) walk(entry, p);
        else files.push({ path: p, size: entry.size, offset: entry.offset, unpacked: Boolean(entry.unpacked) });
      }
    })(header, '');
    const read = (p) => {
      const f = files.find((x) => x.path === p);
      if (!f || f.unpacked) return null;
      const b = Buffer.alloc(f.size);
      fs.readSync(fd, b, 0, f.size, base + Number(f.offset));
      return b;
    };
    return { files, read, close: () => fs.closeSync(fd) };
  } catch (e) {
    fs.closeSync(fd);
    throw new Error(`${file} is not a readable asar archive (${e.message})`);
  }
}

/* ------------------------------------------------------------ known keys */

function mainCheckout() {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /^worktree (.+)$/m.exec(out);
    return m ? path.resolve(m[1]) : ROOT;
  } catch { return ROOT; }
}

/** Every key this machine knows, as {from, value}. `from` names the file, never the value. */
function knownKeys() {
  const keys = [];
  const take = (from, value) => {
    if (typeof value === 'string' && value.trim().length >= 16 && !keys.some((k) => k.value === value.trim())) keys.push({ from, value: value.trim() });
  };
  const fromFile = (file) => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    try { const j = JSON.parse(text); if (j && typeof j === 'object') { take(file, j.key); return; } } catch { /* a plain key */ }
    if (!/\s/.test(text.trim())) take(file, text);
  };
  const roots = [...new Set([ROOT, mainCheckout()])];
  for (const r of roots) {
    let names = [];
    try { names = fs.readdirSync(r); } catch { /* none */ }
    for (const n of names) if (/^tester(\..+)?\.json$/i.test(n)) fromFile(path.join(r, n));
    fromFile(path.join(r, '..', 'dictation-research', '.secrets', 'collect_admin.txt'));
  }
  const userData = process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'typd')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'typd')
      : path.join(os.homedir(), '.config', 'typd');
  fromFile(path.join(userData, 'model-updates.json'));
  take('$TYPD_COLLECT_ADMIN_KEY', process.env.TYPD_COLLECT_ADMIN_KEY);
  for (const f of (process.env.TYPD_PUBLIC_EXTRA_KEY_FILES || '').split(path.delimiter).filter(Boolean)) fromFile(f);
  return keys;
}

/** Which of `needles` occur in `file` (chunked, overlapping by the longest needle). */
function findIn(file, needles) {
  const found = new Set();
  const max = Math.max(...needles.map((n) => n.length));
  const CHUNK = 32 * 1024 * 1024;
  const buf = Buffer.alloc(CHUNK + max);
  const fd = fs.openSync(file, 'r');
  try {
    let pos = 0, carry = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, carry, CHUNK, pos);
      if (n <= 0) break;
      const view = buf.subarray(0, carry + n);
      needles.forEach((needle, i) => { if (!found.has(i) && view.indexOf(needle) !== -1) found.add(i); });
      pos += n;
      carry = Math.min(max - 1, view.length);
      view.copy(buf, 0, view.length - carry);
    }
  } finally { fs.closeSync(fd); }
  return found;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out.push({ p, dir: true, name: e.name }); walk(p, out); }
    else if (e.isFile()) out.push({ p, dir: false, name: e.name });
  }
  return out;
}

/* ------------------------------------------------------------------ verify */

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(16 * 1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, b, 0, b.length, null)) > 0) h.update(b.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function gitInfo() {
  if (process.env.GITHUB_SHA) return { commit: process.env.GITHUB_SHA, dirty: false, ci_run: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null };
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '';
    return { commit, dirty, ci_run: null };
  } catch { return { commit: null, dirty: null, ci_run: null }; }
}

function verify({ app, platform, installer, expectModel = null, expectCuda = null }) {
  if (expectModel && !['yes', 'no'].includes(expectModel)) fail('--expect-model takes yes or no');
  if (expectCuda && !['yes', 'no'].includes(expectCuda)) fail('--expect-cuda takes yes or no');
  if (!app || !fs.existsSync(app)) fail('--app must name the packaged app (win-unpacked, or Typd.app)');
  if (!/^(win-x64|mac-arm64|mac-x64)$/.test(platform || '')) fail('--platform must be win-x64, mac-arm64 or mac-x64');
  const mac = platform.startsWith('mac');
  const resources = mac ? path.join(app, 'Contents', 'Resources') : path.join(app, 'resources');
  const checks = {}, problems = [];
  console.log(`public-build: checking ${app} (${platform})`);

  // 1. tester.json, and any key-bearing file name anywhere in the app
  checks.tester_json_absent = !fs.existsSync(path.join(resources, 'tester.json'));
  if (!checks.tester_json_absent) problems.push('tester.json is in the resources folder: this is a tester build');
  const entries = walk(app);
  const bad = entries.filter((e) => (e.dir ? KEY_DIR(e.name) : KEY_FILE(e.name))).map((e) => path.relative(app, e.p));
  checks.no_key_files = bad.length === 0;
  if (bad.length) problems.push('key-bearing files in the app: ' + bad.join(', '));

  // 2. inside app.asar
  const asarPath = path.join(resources, 'app.asar');
  let appVersion = null;
  if (!fs.existsSync(asarPath)) { checks.asar_clean = false; problems.push('no app.asar'); }
  else {
    const asar = readAsar(asarPath);
    try {
      const inAsar = asar.files.filter((f) => f.path.split('/').some((seg, i, all) => (i === all.length - 1 ? KEY_FILE(seg) : KEY_DIR(seg)))).map((f) => f.path);
      checks.asar_clean = inAsar.length === 0;
      if (inAsar.length) problems.push('key-bearing files inside app.asar: ' + inAsar.join(', '));
      try { appVersion = JSON.parse(asar.read('package.json').toString('utf8')).version; } catch { /* reported below */ }
    } finally { asar.close(); }
  }
  if (!appVersion) problems.push('app.asar has no readable package.json');

  // 3. the model and the server: a bundled model whole, or (model-less) none at all
  const modelDir = path.join(resources, 'models', 'typd-dictate');
  let spec = null;
  try { spec = JSON.parse(fs.readFileSync(path.join(modelDir, 'model.json'), 'utf8')); } catch { /* below */ }
  const server = path.join(resources, 'llama', mac ? 'llama-server' : 'llama-server.exe');
  const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  const modelBytes = spec ? sizeOf(path.join(modelDir, spec.model || '-')) : 0;
  const mmprojBytes = spec ? sizeOf(path.join(modelDir, spec.mmproj || '-')) : 0;
  const ggufs = entries.filter((e) => !e.dir && /\.gguf$/i.test(e.name)).map((e) => path.relative(app, e.p));
  checks.bundled_model = Boolean(spec);
  if (spec) {
    checks.model_ok = Boolean(modelBytes > 0 && mmprojBytes > 0 && sizeOf(server) > 0);
    if (!checks.model_ok) problems.push('the packaged model.json, its model or mmproj, or llama-server is missing');
  } else {
    checks.model_absent = ggufs.length === 0;
    checks.model_ok = checks.model_absent && sizeOf(server) > 0;
    if (!checks.model_absent) problems.push('no model.json, yet model files are in the app: ' + ggufs.join(', '));
    if (!(sizeOf(server) > 0)) problems.push('llama-server is missing');
  }
  if (expectModel && (expectModel === 'yes') !== checks.bundled_model) {
    problems.push(expectModel === 'yes' ? 'expected a bundled model; this build has none' : 'expected a model-less build; this one bundles ' + (spec && spec.model));
  }

  // 3b. Windows: llama.cpp's CUDA backend, all of it (bundled) or none of it (the CUDA pack)
  let cudaDesc = null;
  if (!mac) {
    const llama = path.dirname(server);
    try { cudaDesc = JSON.parse(fs.readFileSync(path.join(llama, 'cuda.json'), 'utf8')); } catch { /* below */ }
    const names = cudaDesc && Array.isArray(cudaDesc.files) ? cudaDesc.files.map((f) => f.name) : [];
    const present = names.filter((n) => sizeOf(path.join(llama, n)) > 0);
    const stray = entries.filter((e) => !e.dir && /^(ggml-cuda|cublas(Lt)?64_\d+|cudart64_\d+)\.dll$/i.test(e.name) && !names.includes(e.name)).map((e) => path.relative(app, e.p));
    checks.cuda_pack = cudaDesc ? cudaDesc.pack : null;
    checks.bundled_cuda = names.length > 0 && present.length === names.length;
    checks.cuda_ok = Boolean(cudaDesc && cudaDesc.pack && names.length && (present.length === 0 || present.length === names.length) && !stray.length);
    if (!cudaDesc) problems.push('resources/llama/cuda.json is missing: the app would not know its CUDA pack');
    else if (present.length && present.length !== names.length) problems.push('part of the CUDA backend is in the app: ' + present.join(', '));
    if (stray.length) problems.push('CUDA libraries cuda.json does not name: ' + stray.join(', '));
    if (expectCuda && cudaDesc && (expectCuda === 'yes') !== checks.bundled_cuda) {
      problems.push(expectCuda === 'yes' ? 'expected the CUDA backend in the app; it has none' : 'expected no CUDA backend in the app (the CUDA pack); it has ' + present.join(', '));
    }
  }

  // 3c. the patched audio encoder (scripts/build-mtmd.js)
  {
    const lib = path.join(path.dirname(server), mac ? 'libmtmd.0.dylib' : 'mtmd.dll');
    let buf = null;
    try { buf = fs.readFileSync(lib); } catch { /* below */ }
    checks.patched_mtmd = Boolean(buf && buf.includes(Buffer.from('MTMD_QWEN3A_CONV_GROUP')));
    if (!buf) problems.push(path.basename(lib) + ' is missing beside llama-server');
    else if (!checks.patched_mtmd) problems.push(path.basename(lib) + ' is the stock build: run scripts/build-mtmd.js (Windows) / scripts/fetch-llama-mac.js on a Mac');
  }

  // 3d. the native microphone helper (0.2.12, scripts/build-mic.js): there, and the build of this source
  // when its record is beside it in vendor/ (the app carries the executable only).
  {
    const exe = path.join(resources, 'mic', mac ? 'typd-mic' : 'typd-mic.exe');
    checks.mic_helper = sizeOf(exe) > 0;
    if (!checks.mic_helper) problems.push('the microphone helper (resources/mic/' + path.basename(exe) + ') is missing: run scripts/build-mic.js');
    else if (!mac) {
      let rec = null;
      try { rec = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', 'mic', 'BUILD.json'), 'utf8')); } catch { /* no record here (CI) */ }
      if (rec) {
        checks.mic_helper_sha256 = sha256File(exe);
        if (rec.sha256 !== checks.mic_helper_sha256) problems.push('resources/mic/typd-mic.exe is not vendor/mic\'s build (BUILD.json)');
        else if (rec.source !== require('./build-mic').sourceRecord().source) problems.push('vendor/mic/typd-mic.exe was built from another native/mic/typd-mic.c: run scripts/build-mic.js win');
      }
    }
  }

  // 4. every key this machine knows, byte for byte, in every file
  const keys = knownKeys();
  checks.known_keys_scanned = keys.length;
  checks.known_keys_found = 0;
  if (keys.length) {
    const needles = keys.map((k) => Buffer.from(k.value, 'utf8'));
    const files = entries.filter((e) => !e.dir);
    const total = files.reduce((s, e) => s + sizeOf(e.p), 0);
    console.log(`public-build: searching ${files.length} files (${(total / 1e9).toFixed(2)} GB) for ${keys.length} known key(s)`);
    const hits = new Map();   // key index -> files
    for (const e of files) for (const i of findIn(e.p, needles)) { if (!hits.has(i)) hits.set(i, []); hits.get(i).push(path.relative(app, e.p)); }
    checks.known_keys_found = hits.size;
    for (const [i, where] of hits) problems.push(`the key from ${keys[i].from} is inside: ${where.join(', ')}`);
  } else {
    console.log('public-build: no known keys on this machine to search for (expected in CI); the name checks above still apply');
  }

  // 5. the installer
  let record = null;
  if (installer) {
    const name = path.basename(installer);
    if (!fs.existsSync(installer)) problems.push(`no installer at ${installer}`);
    if (!NAME_RE.test(name)) problems.push(`${name}: the download route takes 1-128 of A-Z a-z 0-9 . _ - (no spaces)`);
    if (/tester/i.test(name)) problems.push(`${name} is named as a tester build`);
    if (!problems.length) {
      console.log(`public-build: hashing ${name}`);
      const git = gitInfo();
      record = {
        schema: SCHEMA, file: name, size: fs.statSync(installer).size, sha256: sha256File(installer), platform, app_version: appVersion,
        model: spec ? spec.model : null, mmproj: spec ? spec.mmproj : null, model_bytes: modelBytes + mmprojBytes, bundled_model: Boolean(spec),
        ...(mac ? {} : { bundled_cuda: Boolean(checks.bundled_cuda), cuda_pack: checks.cuda_pack || null }),
        installed_bytes: entries.filter((e) => !e.dir).reduce((s, e) => s + sizeOf(e.p), 0),
        commit: git.commit, dirty: git.dirty, ci_run: git.ci_run, built_at: new Date().toISOString(), checks, ok: true
      };
    }
  }

  const recordPath = installer ? installer + '.public.json' : null;
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v}`);
  if (problems.length) {
    if (recordPath) fs.rmSync(recordPath, { force: true });
    console.error('public-build: NOT a public build:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  if (record) {
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
    console.log(`public-build: OK -- ${record.file}, ${(record.size / 1e9).toFixed(2)} GB, sha256 ${record.sha256}`);
    console.log(`public-build: wrote ${path.relative(process.cwd(), recordPath)} (publish_app.py --public needs it beside the file)`);
  } else {
    console.log('public-build: OK (no installer given, so no record written)');
  }
  return record;
}

/* --------------------------------------------------------------------- win */

function buildWin({ dir, out, withModel, withCuda }) {
  const outDir = path.resolve(ROOT, out || path.join('dist', 'public'));
  const env = { ...process.env };
  for (const v of TESTER_VARS) if (env[v]) { console.log(`public-build: ${v} is set; ignored for a public build`); delete env[v]; }
  let spec = { model: '(none: downloaded at first launch)' };
  if (withModel) {
    delete env.TYPD_NO_BUNDLED_MODEL;
    try { spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'models', 'typd-dictate', 'model.json'), 'utf8')); } catch { fail('models/typd-dictate/model.json is not readable: the dictation model is not in place'); }
  } else {
    env.TYPD_NO_BUNDLED_MODEL = '1';
  }
  if (withCuda) delete env.TYPD_NO_BUNDLED_CUDA; else env.TYPD_NO_BUNDLED_CUDA = '1';
  if (!fs.existsSync(path.join(ROOT, 'vendor', 'llama', 'llama-server.exe'))) fail('vendor/llama/llama-server.exe is missing');
  { const m = require('./build-mic').check(path.join(ROOT, 'vendor', 'mic'), 'typd-mic.exe'); if (!m.ok) fail(m.why + ': run node scripts/build-mic.js win'); }
  const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  if (!fs.existsSync(cli)) fail('node_modules/electron-builder is missing: npm ci first');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const installer = path.join(outDir, `Typd-Setup-${version}.exe`);
  console.log(`public-build: Windows ${dir ? 'app folder only (--dir)' : 'installer'} with ${spec.model}, ${withCuda ? 'with' : 'without'} the CUDA backend, into ${path.relative(ROOT, outDir)}`);

  // A leftover win-unpacked from an earlier build would be checked instead of this one's.
  fs.rmSync(path.join(outDir, 'win-unpacked'), { recursive: true, force: true });
  fs.rmSync(installer, { force: true });
  fs.rmSync(installer + '.public.json', { force: true });
  const r = spawnSync(process.execPath, [cli, '--win', dir ? 'dir' : 'nsis', '--x64', '--publish', 'never',
    `-c.directories.output=${outDir}`, '-c.nsis.artifactName=Typd-Setup-${version}.${ext}'], { cwd: ROOT, env, stdio: 'inherit' });
  if (r.status !== 0) fail('electron-builder failed');
  const app = path.join(outDir, 'win-unpacked');
  if (!dir && !fs.existsSync(installer)) fail(`electron-builder did not make ${installer}`);
  verify({ app, platform: 'win-x64', installer: dir ? null : installer, expectModel: withModel ? 'yes' : 'no', expectCuda: withCuda ? 'yes' : 'no' });
}

/* -------------------------------------------------------------------- main */

if (require.main === module) {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  if (cmd === 'win') buildWin({ dir: a.dir, out: a.out, withModel: a['with-model'], withCuda: a['with-cuda'] });
  else if (cmd === 'verify') verify({ app: a.app, platform: a.platform, installer: a.installer, expectModel: a['expect-model'] || null, expectCuda: a['expect-cuda'] || null });
  else fail('usage: node scripts/public-build.js win [--dir] [--out dist/public] [--with-model] [--with-cuda]\n       node scripts/public-build.js verify --app <app> --platform <win-x64|mac-arm64|mac-x64> [--installer <file>] [--expect-model yes|no] [--expect-cuda yes|no]');
}

module.exports = { verify, readAsar, knownKeys, KEY_FILE };
