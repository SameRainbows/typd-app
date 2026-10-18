'use strict';

/**
 * Make an app-update package from a packaged Typd: what src/main/appUpdate.js downloads, checks
 * and installs, and what dictation-research/scripts/publish_app_update.py signs and uploads.
 *
 *   node scripts/app-update-package.js win [--app dist/win-unpacked] [--out dist/update] [--carry-llama]
 *   node scripts/app-update-package.js mac --app dist/mac-arm64/Typd.app [--out dist/update]   (on a Mac)
 *
 * Writes <out>/Typd-<version>-update-<mac|win>-<arch>.zip and, beside it, <zip>.json: the record
 * publish_app_update.py reads (version, platform, size, sha256, app, carry, requires).
 *
 * The zip holds typd-update.json {version, platform, app} and the app, WITHOUT:
 *   - the dictation model (resources/models/typd-dictate): 0.6-1.5 GB, and the bucket holds 9 GB
 *     for models, recordings and apps together. The helper carries the installed one over, so an
 *     app update never changes the model (tester builds follow model updates, modelUpdate.js).
 *   - tester.json: a tester's upload key. Update packages are public. A tester build keeps its own
 *     through the update (carried over like the model).
 *   - Windows: llama.cpp's CUDA backend (the files resources/llama/cuda.json names: ggml-cuda.dll,
 *     cuBLAS, cuBLASLt, the CUDA runtime, 1.14 GB). Since 0.2.5 the package holds the rest of llama.cpp
 *     (its CPU build, ~43 MB, and cuda.json) and CARRIES those files over from the installed app, one
 *     by one: an install from 0.2.4 or earlier, whose llama.cpp is the whole CUDA release, keeps its
 *     CUDA backend through the update (no download), and one without them (a 0.2.5 public install)
 *     simply has none carried (the helper skips a path the installed app lacks). The new version
 *     checks what was carried against its own cuda.json before llama-server starts and deletes files
 *     that are not its build's (src/main/cudaPack.js prepare()), then fetches the CUDA pack if the
 *     hardware wants it. Nothing is `requires`d, so any install can take the package.
 *     --carry-llama is the way before 0.2.5: llama.cpp left out whole and carried over, the package
 *     naming the tree an install must have (`requires`; another one is told to reinstall).
 * Windows also carries the NSIS uninstaller, which the unpacked app does not have.
 *
 * macOS: taking the model out breaks the bundle's seal, so the copy is signed again, the way
 * scripts/after-pack.js signs: with Typd's own certificate when TYPD_MAC_SIGN_IDENTITY is set (the
 * Mac CI), so the package's app has the same designated requirement as every other build; else ad
 * hoc, with a warning (such a package would cost every Mac its privacy switches). It carries NOTHING
 * ("carry": []): the helper installs it exactly as signed and never signs it again on the user's Mac
 * (helper-mac.sh signs only when something was carried), and the new version copies the model and
 * tester.json out of the version it replaced itself (src/main/carried.js). Windows still carries.
 * The version is read from the app itself (Info.plist, or app.asar's package.json) and must match
 * package.json's, or --version's.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const flag = (name) => args.includes(name);

function die(msg) { console.error('app-update-package: ' + msg); process.exit(1); }

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(8 * 1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/** The same tree hash as appUpdate.js's treeHash: every file's path, size and sha256, sorted. */
function treeHash(root) {
  const lines = [];
  (function walk(rel) {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) for (const name of fs.readdirSync(abs)) walk(rel ? rel + '/' + name : name);
    else if (st.isSymbolicLink()) lines.push(`${rel}\0link\0${fs.readlinkSync(abs)}\n`);
    else if (st.isFile()) lines.push(`${rel}\0${st.size}\0${sha256File(abs)}\n`);
  })('');
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return crypto.createHash('sha256').update(lines.join('')).digest('hex');
}

/** One file out of an asar archive (header: two pickles, then the files). */
function readAsarFile(asar, inner) {
  const fd = fs.openSync(asar, 'r');
  try {
    const size = Buffer.alloc(8);
    fs.readSync(fd, size, 0, 8, 0);
    const headerSize = size.readUInt32LE(4);
    const hb = Buffer.alloc(headerSize);
    fs.readSync(fd, hb, 0, headerSize, 8);
    const header = JSON.parse(hb.subarray(8, 8 + hb.readInt32LE(4)).toString('utf8'));
    let node = header;
    for (const seg of inner.split('/')) node = node && node.files && node.files[seg];
    if (!node || node.unpacked || node.size === undefined) return null;
    const out = Buffer.alloc(node.size);
    fs.readSync(fd, out, 0, node.size, 8 + headerSize + Number(node.offset));
    return out;
  } finally { fs.closeSync(fd); }
}

function walkFiles(dir, rel = '', out = []) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walkFiles(dir, r, out); else out.push(r);
  }
  return out;
}

/** Copy `src` to `dst` without the paths in `skip` (relative, '/'), as hard links where possible. */
function copyTree(src, dst, skip) {
  const skipped = [];
  (function walk(rel) {
    const from = path.join(src, rel), to = path.join(dst, rel);
    if (rel && skip.includes(rel)) { skipped.push(rel); return; }
    const st = fs.lstatSync(from);
    if (st.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) walk(rel ? rel + '/' + name : name);
    } else if (st.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to);
    } else {
      try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
    }
  })('');
  return skipped;
}

function git(...a) {
  try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

function main() {
  const kind = args[0];
  if (kind !== 'win' && kind !== 'mac') die('usage: app-update-package.js win|mac [--app <path>] [--out <dir>] [--carry-llama] [--version x.y.z]');
  const want = opt('--version', require(path.join(ROOT, 'package.json')).version);
  if (!/^\d+\.\d+\.\d+$/.test(want)) die('the version must look like 0.1.0, not ' + want);
  const out = path.resolve(opt('--out', path.join(ROOT, 'dist', 'update')));
  fs.mkdirSync(out, { recursive: true });

  let app, platform, appName, version, carry, requires = {}, skip;
  if (kind === 'win') {
    app = path.resolve(opt('--app', path.join(ROOT, 'dist', 'win-unpacked')));
    if (!fs.existsSync(path.join(app, 'Typd.exe'))) die(`${app} is not a packaged Typd for Windows (no Typd.exe)`);
    const asar = path.join(app, 'resources', 'app.asar');
    let pkg = null;
    try { pkg = JSON.parse(readAsarFile(asar, 'package.json').toString('utf8')); } catch { /* checked below */ }
    version = pkg ? pkg.version : flag('--trust-version') ? want : null;
    if (!version) die(`cannot read the version from ${asar} (pass --trust-version only for a test app)`);
    platform = 'win32-x64';
    appName = 'Typd';
    const llama = path.join(app, 'resources', 'llama');
    if (!fs.existsSync(path.join(llama, 'llama-server.exe'))) die(`${llama} has no llama-server.exe`);
    if (flag('--carry-llama')) {
      skip = ['resources/models', 'resources/tester.json', 'resources/llama'];
      carry = ['resources/models/typd-dictate', 'resources/tester.json', 'Uninstall Typd.exe', 'resources/llama'];
      console.log('  hashing resources/llama (the tree an install must have to take this package)...');
      requires = { 'resources/llama': treeHash(llama) };
    } else {
      // The CUDA backend's files, by cuda.json (an older layout without one: by name).
      let names = [];
      try { names = JSON.parse(fs.readFileSync(path.join(llama, 'cuda.json'), 'utf8')).files.map((f) => f.name); } catch { /* by name */ }
      if (!names.length) names = ['ggml-cuda.dll', 'cublas64_12.dll', 'cublasLt64_12.dll', 'cudart64_12.dll'];
      const cudaRel = names.map((n) => 'resources/llama/' + n);
      skip = ['resources/models', 'resources/tester.json', ...cudaRel];
      carry = ['resources/models/typd-dictate', 'resources/tester.json', 'Uninstall Typd.exe', ...cudaRel];
    }
  } else {
    if (process.platform !== 'darwin') die('a macOS package is made on a Mac (it is signed ad hoc again)');
    app = path.resolve(opt('--app', ''));
    if (!/\.app$/.test(app) || !fs.existsSync(path.join(app, 'Contents', 'Info.plist'))) die('--app must name a Typd.app');
    version = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
    const arch = opt('--arch', process.arch);
    const exe = path.join(app, 'Contents', 'MacOS', 'Typd');
    const lipo = execFileSync('lipo', ['-archs', exe], { encoding: 'utf8' }).trim();
    if (!lipo.split(/\s+/).includes(arch === 'x64' ? 'x86_64' : arch)) die(`${exe} is ${lipo}, not ${arch}`);
    platform = 'darwin-' + arch;
    appName = path.basename(app);
    skip = ['Contents/Resources/models', 'Contents/Resources/tester.json'];
    carry = [];   // nothing: see the top of this file (src/main/carried.js does it)
  }
  if (version !== want) die(`the app is Typd ${version}, but ${opt('--version') ? '--version' : 'package.json'} says ${want}`);

  const label = kind === 'win' ? 'win-x64' : 'mac-' + platform.split('-')[1];
  const file = `Typd-${version}-update-${label}.zip`;
  const zip = path.join(out, file);
  const stage = path.join(out, '.stage-' + label);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  console.log(`Packaging Typd ${version} for ${platform} from ${app}`);

  let skipped, signature = null;
  if (kind === 'mac') {
    execFileSync('ditto', [app, path.join(stage, appName)]);
    skipped = skip.filter((rel) => fs.existsSync(path.join(stage, appName, rel)));
    for (const rel of skipped) fs.rmSync(path.join(stage, appName, rel), { recursive: true, force: true });
    execFileSync('xattr', ['-cr', path.join(stage, appName)]);
    const { signArgs, designatedRequirement, entitlementArgs } = require('./after-pack');
    const how = signArgs();
    if (how.label === 'ad hoc') console.warn('  WARNING: no TYPD_MAC_SIGN_IDENTITY: signed ad hoc. Installed as an update, it would cost every Mac its privacy switches; publish only CI packages.');
    // The outer app only (its helpers keep after-pack's signatures); --force would drop the main
    // executable's entitlements without --entitlements.
    execFileSync('codesign', ['--force', ...how.args, ...entitlementArgs(), path.join(stage, appName)]);
    execFileSync('codesign', ['--verify', '--deep', '--strict', path.join(stage, appName)]);
    signature = { how: how.label, designated: designatedRequirement(path.join(stage, appName)), installedApp: designatedRequirement(app) };
    if (how.label !== 'ad hoc' && signature.designated !== signature.installedApp) die(`the package's designated requirement (${signature.designated}) is not the app's (${signature.installedApp})`);
    console.log(`  signed again without the model, ${how.label}; the signature verifies`);
    console.log(`  designated requirement: ${signature.designated} (the same as ${path.basename(app)}'s)`);
  } else {
    skipped = copyTree(app, path.join(stage, appName), skip);
  }
  // Update packages are public: no key may be in one.
  const keyFiles = walkFiles(stage).filter((r) => /(^|\/)tester(\.[^/]*)?\.json$/i.test(r) || /\.secret$|\.pem$/i.test(r));
  if (keyFiles.length) die('refusing: key files in the package: ' + keyFiles.join(', '));
  const meta = { version, platform, app: appName };
  fs.writeFileSync(path.join(stage, 'typd-update.json'), JSON.stringify(meta) + '\n');

  fs.rmSync(zip, { force: true });
  if (kind === 'mac') {
    execFileSync('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noacl', stage, zip]);
  } else {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-a', '-c', '-f', zip, '-C', stage, appName, 'typd-update.json'], { stdio: 'inherit' });
  }
  fs.rmSync(stage, { recursive: true, force: true });

  const size = fs.statSync(zip).size;
  const sha256 = sha256File(zip);
  const record = {
    schema: 'typd-app-update-package/1', file, version, platform, size, sha256, app: appName, carry,
    ...(Object.keys(requires).length ? { requires } : {}),
    left_out: skipped, ...(signature ? { signature } : {}), commit: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain')), built_at: new Date().toISOString()
  };
  fs.writeFileSync(zip + '.json', JSON.stringify(record, null, 2) + '\n');
  console.log(`  ${file}: ${(size / 1e6).toFixed(1)} MB, sha256 ${sha256}`);
  console.log(`  left out: ${skipped.join(', ') || 'nothing'}; carried over on install: ${carry.join(', ') || 'nothing (the new version copies what it lacks itself)'}`);
  console.log(`  record: ${zip}.json`);
}

main();
