#!/usr/bin/env node
'use strict';

/**
 * Build llama.cpp's mtmd library (the audio encoder) from b11351 with Typd's patches, and put it in
 * place of the official one in vendor/:
 *
 *   node scripts/build-mtmd.js win               vendor/llama/mtmd.dll          (MSVC, Visual Studio 2022)
 *   node scripts/build-mtmd.js mac arm64 x64     vendor/llama-mac/<arch>/libmtmd.0.dylib   (on a Mac: Xcode tools + cmake)
 *   options: --src <dir>   an existing llama.cpp checkout to use (must be at the pinned commit)
 *            --check       only report whether the vendor folders hold the patched library
 *
 * Why only mtmd: the one patch (patches/llama.cpp/0001-mtmd-qwen3a-conv-front-end-in-groups.patch) is in
 * tools/mtmd/models/qwen3a.cpp, which is compiled into mtmd and nothing else. Every other file stays the
 * official b11351 release byte for byte -- the server, llama, ggml, every ggml-cpu variant and, on
 * Windows, the CUDA pack's ggml-cuda.dll (src/main/cudaPack.js), which loads only into the ggml build it
 * came from. mtmd talks to llama and ggml through their C APIs only; scripts/build-mtmd.js checks on
 * Windows that every function the official llama-server-impl.dll imports from mtmd is exported by the
 * new one, and on macOS that the new dylib has the official one's install name and no dependency the
 * official folder lacks.
 *
 * The patch: with MTMD_QWEN3A_CONV_GROUP=G (src/main/pipeline/local.js sets 1) Qwen3-ASR's conv front
 * end runs G chunks at a time: identical output, the encoder's compute buffer 554 -> 21 MiB on the light
 * model (dictation-research reports/sub_half_gb_plan.md). Unset, the graph is the stock one.
 *
 * The source comes from github.com/ggml-org/llama.cpp by commit (git checks every object against it),
 * into vendor/.llama-src/. A record of what was built is written beside the library
 * (vendor/llama/PATCHED.json; vendor/llama-mac/<arch>/BUILD.json gets a "patched" entry), and the
 * library carries the marker string MTMD_QWEN3A_CONV_GROUP, which --check and the build checks look for.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const COMMIT = '631109b34da437a3c4a5ebd75091d677671392e3';   // b11351, as vendor/llama and fetch-llama-mac.js
const REPO = 'https://github.com/ggml-org/llama.cpp';
const PATCHES = path.join(ROOT, 'patches', 'llama.cpp');
const MARKER = 'MTMD_QWEN3A_CONV_GROUP';
const WORK = path.join(ROOT, 'vendor', '.llama-src');

const log = (...a) => console.log('[build-mtmd]', ...a);
function fail(msg) { console.error('[build-mtmd] ERROR:', msg); process.exit(1); }
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function run(file, args, opts = {}) {
  log('$', path.basename(file), args.join(' '));
  const r = spawnSync(file, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) fail(`${path.basename(file)} ${args[0]} failed (${r.status === null ? r.error && r.error.message : 'exit ' + r.status})`);
}
const git = (args, cwd) => run('git', ['-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false', ...args], { cwd });

function patches() {
  const list = fs.existsSync(PATCHES) ? fs.readdirSync(PATCHES).filter((n) => n.endsWith('.patch')).sort() : [];
  if (!list.length) fail('no patches in ' + PATCHES);
  return list.map((n) => ({ name: n, file: path.join(PATCHES, n), sha256: sha256(fs.readFileSync(path.join(PATCHES, n))) }));
}

/** A llama.cpp checkout at COMMIT with the patches applied (each exactly once). */
function source(given) {
  const dir = given ? path.resolve(given) : path.join(WORK, 'llama.cpp-' + COMMIT.slice(0, 9));
  if (!fs.existsSync(path.join(dir, '.git'))) {
    if (given) fail(given + ' is not a git checkout');
    fs.mkdirSync(dir, { recursive: true });
    git(['init', '-q'], dir);
    git(['fetch', '-q', '--depth', '1', REPO, COMMIT], dir);
    git(['checkout', '-q', '--detach', 'FETCH_HEAD'], dir);
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  if (head !== COMMIT) fail(`${dir} is at ${head}, not ${COMMIT}`);
  for (const p of patches()) {
    const check = spawnSync('git', ['-c', 'core.autocrlf=false', 'apply', '--check', p.file], { cwd: dir, encoding: 'utf8' });
    if (check.status === 0) { git(['apply', p.file], dir); log('applied', p.name); continue; }
    const back = spawnSync('git', ['-c', 'core.autocrlf=false', 'apply', '--reverse', '--check', p.file], { cwd: dir, encoding: 'utf8' });
    if (back.status === 0) { log('already applied', p.name); continue; }
    fail(`${p.name} does not apply to ${dir}: ${check.stderr}`);
  }
  return dir;
}

function cmakeBin() {
  const onPath = spawnSync('cmake', ['--version'], { encoding: 'utf8' });
  if (onPath.status === 0) return 'cmake';
  if (process.platform === 'win32') {
    const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    let vs = null;
    try { vs = execFileSync(vswhere, ['-latest', '-property', 'installationPath'], { encoding: 'utf8' }).trim(); } catch { /* none */ }
    for (const base of [vs, 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community'].filter(Boolean)) {
      const c = path.join(base, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe');
      if (fs.existsSync(c)) return c;
    }
  }
  fail('cmake not found');
}

// Options shared by every platform: only mtmd and what it links (ggml, llama), shared, nothing else.
const COMMON = ['-DBUILD_SHARED_LIBS=ON', '-DLLAMA_BUILD_TOOLS=OFF', '-DLLAMA_BUILD_MTMD=ON', '-DLLAMA_BUILD_SERVER=OFF',
  '-DLLAMA_BUILD_TESTS=OFF', '-DLLAMA_BUILD_EXAMPLES=OFF', '-DLLAMA_CURL=OFF', '-DGGML_RPC=OFF', '-DGGML_NATIVE=OFF'];

function build(src, tag, configure) {
  const cmake = cmakeBin();
  const dir = path.join(WORK, 'build-' + tag);
  run(cmake, ['-S', src, '-B', dir, ...COMMON, ...configure]);
  run(cmake, ['--build', dir, '--config', 'Release', '--target', 'mtmd', '-j', String(Math.max(2, require('os').cpus().length))]);
  return dir;
}

function record(file, dest, extra) {
  const buf = fs.readFileSync(file);
  if (!buf.includes(Buffer.from(MARKER))) fail(`${file} has no ${MARKER}: the patch is not in it`);
  if (!buf.includes(Buffer.from('clip_graph_qwen3a')) && !buf.includes(Buffer.from('qwen3a'))) fail(`${file} has no Qwen3-ASR encoder`);
  return { source: { repo: REPO, commit: COMMIT }, patches: patches().map(({ name, sha256: s }) => ({ name, sha256: s })), file: path.basename(dest), size: buf.length, sha256: sha256(buf), builtAt: new Date().toISOString(), ...extra };
}

/* ------------------------------------------------------------------ Windows */

function exportsOf(dll) {
  // dumpbin is in the VS toolchain; through vcvars64 so it finds its DLLs.
  const vcvars = 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat';
  if (!fs.existsSync(vcvars)) return null;
  const out = spawnSync('cmd.exe', ['/d', '/s', '/c', `"call "${vcvars}" >nul 2>nul && dumpbin /exports "${dll}""`], { encoding: 'utf8', windowsVerbatimArguments: true, maxBuffer: 64 << 20 });
  if (out.status !== 0) return null;
  const names = new Set();
  let on = false;
  for (const line of out.stdout.split(/\r?\n/)) {
    if (/ordinal\s+hint/.test(line)) { on = true; continue; }
    const p = line.trim().split(/\s+/);
    if (on && p.length >= 4 && /^\d+$/.test(p[0])) names.add(p[3]);
  }
  return names;
}

function importsFrom(dll, from) {
  const vcvars = 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat';
  const out = spawnSync('cmd.exe', ['/d', '/s', '/c', `"call "${vcvars}" >nul 2>nul && dumpbin /imports "${dll}""`], { encoding: 'utf8', windowsVerbatimArguments: true, maxBuffer: 64 << 20 });
  if (out.status !== 0) return null;
  const names = [];
  let cur = null;
  for (const line of out.stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (/\.dll$/i.test(t) && !/^Dump of/.test(t)) { cur = t.toLowerCase(); continue; }
    const m = /^\s+[0-9A-F]+\s+(\S+)$/.exec(line);
    if (m && cur === from.toLowerCase()) names.push(m[1]);
  }
  return names;
}

function win(src) {
  const vendor = path.join(ROOT, 'vendor', 'llama');
  const official = path.join(vendor, 'mtmd.dll');
  if (!fs.existsSync(official)) fail('vendor/llama/mtmd.dll is missing: put llama.cpp b11351 (the CUDA 12.4 release) in vendor/llama first');
  const dir = build(src, 'win-x64', ['-G', 'Visual Studio 17 2022', '-A', 'x64']);
  const built = path.join(dir, 'bin', 'Release', 'mtmd.dll');
  if (!fs.existsSync(built)) fail('no ' + built);
  // Every function the official server takes from mtmd must be in the new one.
  const need = importsFrom(path.join(vendor, 'llama-server-impl.dll'), 'mtmd.dll');
  const have = exportsOf(built);
  if (need && have) {
    const missing = need.filter((n) => !have.has(n));
    if (missing.length) fail('the new mtmd.dll lacks ' + missing.join(', '));
    log(`llama-server-impl.dll's ${need.length} imports from mtmd: all exported`);
  } else {
    log('dumpbin not available: imports not checked');
  }
  const keep = path.join(WORK, 'official-win-mtmd.dll');
  const cur = fs.readFileSync(official);
  if (!cur.includes(Buffer.from(MARKER)) && !fs.existsSync(keep)) fs.copyFileSync(official, keep);
  const rec = record(built, official, { replaces: fs.existsSync(keep) ? { sha256: sha256(fs.readFileSync(keep)), size: fs.statSync(keep).size } : null });
  fs.copyFileSync(built, official);
  fs.writeFileSync(path.join(vendor, 'PATCHED.json'), JSON.stringify({ mtmd: rec }, null, 2) + '\n');
  log(`vendor/llama/mtmd.dll: patched build, ${rec.size} bytes, sha256 ${rec.sha256.slice(0, 16)}...`);
}

/* -------------------------------------------------------------------- macOS */

function machO(buf) {
  if (buf.readUInt32LE(0) !== 0xfeedfacf) return null;
  const n = buf.readUInt32LE(16);
  const str = (o) => { const z = buf.indexOf(0, o); return buf.subarray(o, z).toString('utf8'); };
  const out = { cputype: buf.readUInt32LE(4), deps: [], id: null, minos: null };
  let p = 32;
  for (let i = 0; i < n; i++) {
    const cmd = buf.readUInt32LE(p), size = buf.readUInt32LE(p + 4);
    if (cmd === 0x0c || cmd === 0x80000018) out.deps.push(str(p + buf.readUInt32LE(p + 8)));
    else if (cmd === 0x0d) out.id = str(p + buf.readUInt32LE(p + 8));
    else if (cmd === 0x32) { const v = buf.readUInt32LE(p + 12); out.minos = `${v >>> 16}.${(v >>> 8) & 0xff}`; }
    p += size;
  }
  return out;
}

function mac(src, arch) {
  if (process.platform !== 'darwin') fail('the macOS library is built on a Mac (CI: .github/workflows/mac.yml)');
  const vendor = path.join(ROOT, 'vendor', 'llama-mac', arch);
  const target = path.join(vendor, 'libmtmd.0.dylib');
  const manifestFile = path.join(vendor, 'BUILD.json');
  if (!fs.existsSync(target) || !fs.existsSync(manifestFile)) fail(`vendor/llama-mac/${arch} is not there: run scripts/fetch-llama-mac.js ${arch} first`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const official = machO(fs.readFileSync(target));
  const minos = (manifest.minimumMacOS || '13.3').split('.').slice(0, 2).join('.');
  const dir = build(src, 'mac-' + arch, [
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_OSX_ARCHITECTURES=${arch === 'arm64' ? 'arm64' : 'x86_64'}`,
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${minos}`,
    '-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON', '-DCMAKE_INSTALL_RPATH=@loader_path',
    // As the official builds: Metal (shaders embedded) on Apple silicon, the CPU (with Accelerate) on Intel.
    ...(arch === 'arm64' ? ['-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON'] : ['-DGGML_METAL=OFF'])
  ]);
  const bin = path.join(dir, 'bin');
  const cand = fs.readdirSync(bin).filter((n) => /^libmtmd\..*dylib$/.test(n)).map((n) => path.join(bin, n)).filter((f) => !fs.lstatSync(f).isSymbolicLink());
  if (cand.length !== 1) fail('expected one libmtmd dylib in ' + bin + ', found ' + cand.length);
  const buf = fs.readFileSync(cand[0]);
  const info = machO(buf);
  if (!info) fail(cand[0] + ' is not a 64-bit Mach-O');
  if (info.id !== official.id) fail(`install name ${info.id}, the official one is ${official.id}`);
  const extra = info.deps.filter((d) => !official.deps.includes(d) && !/^\/(usr\/lib|System)\//.test(d));
  if (extra.length) fail('the new libmtmd needs what the official folder lacks: ' + extra.join(', '));
  if (info.minos && official.minos && Number(info.minos) > Number(official.minos)) fail(`minimum macOS ${info.minos} > ${official.minos}`);
  const rec = record(cand[0], target, { arch, minimumMacOS: info.minos, replaces: manifest.files['libmtmd.0.dylib'] || null });
  fs.copyFileSync(cand[0], target);
  fs.chmodSync(target, 0o755);
  manifest.files['libmtmd.0.dylib'] = { from: 'patched build (scripts/build-mtmd.js)', size: rec.size, sha256: rec.sha256 };
  manifest.patched = { mtmd: rec };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  log(`vendor/llama-mac/${arch}/libmtmd.0.dylib: patched build, ${rec.size} bytes, macOS >= ${info.minos}`);
}

/* -------------------------------------------------------------------- check */

/** Is the library in each vendor folder the patched one? [{where, patched}] */
function check() {
  const out = [];
  const w = path.join(ROOT, 'vendor', 'llama', 'mtmd.dll');
  if (fs.existsSync(w)) out.push({ where: 'vendor/llama/mtmd.dll', patched: fs.readFileSync(w).includes(Buffer.from(MARKER)) });
  for (const a of ['arm64', 'x64']) {
    const f = path.join(ROOT, 'vendor', 'llama-mac', a, 'libmtmd.0.dylib');
    if (fs.existsSync(f)) out.push({ where: `vendor/llama-mac/${a}/libmtmd.0.dylib`, patched: fs.readFileSync(f).includes(Buffer.from(MARKER)) });
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--src');
  const src = at >= 0 ? args[at + 1] : null;
  if (args.includes('--check')) {
    const r = check();
    for (const x of r) log(x.where, x.patched ? 'patched' : 'NOT patched');
    process.exit(r.length && r.every((x) => x.patched) ? 0 : 1);
  }
  const what = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--src');
  if (what[0] === 'win') return win(source(src));
  if (what[0] === 'mac') {
    const archs = what.slice(1).filter((a) => a === 'arm64' || a === 'x64');
    const s = source(src);
    for (const a of archs.length ? archs : ['arm64']) mac(s, a);
    return;
  }
  fail('usage: node scripts/build-mtmd.js win | mac [arm64] [x64] [--src <dir>] | --check');
}

if (require.main === module) main();
module.exports = { check, MARKER, COMMIT };
