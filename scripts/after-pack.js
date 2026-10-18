'use strict';

/**
 * electron-builder afterPack hook. Runs on the unpacked app, before the installer, dmg or
 * zip is made from it.
 *
 * Every platform: refuse to ship an app that cannot dictate -- the model named by the
 * packaged model.json, its mmproj and llama-server must all be in the resources folder.
 * Windows: with TYPD_NO_BUNDLED_CUDA=1 (public installers) no CUDA backend file may be in it and
 * cuda.json must name the pack the app fetches instead; otherwise every file cuda.json names is there.
 * With TYPD_TESTER_CONFIG=<path to a tester.json>, ship it as <resources>/tester.json,
 * which makes a tester build (src/main/sharing.js); without it, make sure there is none.
 *
 * macOS:
 *  1. llama-server must be built for the architecture being packaged.
 *  2. Every Mach-O file under Contents/Resources gets mode 0755. Files fetched on Windows
 *     carry no mode (scripts/fetch-llama-mac.js), and a server without its executable bit
 *     fails to spawn with EACCES.
 *  3. Signed. build.mac.identity is null, so electron-builder signs nothing; this does, because
 *     Apple Silicon refuses to run code whose signature is missing or broken, and packaging
 *     breaks Electron's (new Info.plist, renamed binary). With TYPD_MAC_SIGN_IDENTITY (the SHA-1
 *     of Typd's own self-signed code-signing certificate, which the Mac CI imports into a keychain
 *     of its own, TYPD_MAC_SIGN_KEYCHAIN: scripts/mac-signing-import.sh) it signs with that
 *     certificate, so every build has the same designated requirement and macOS keeps Typd's
 *     privacy switches across updates (docs/MAC.md "Code signing"); without it, ad hoc
 *     (`--sign -`: a local build). The loose Mach-O files in Resources (llama-server, its dylibs,
 *     native .node modules) are signed one by one first, because `--deep` only descends into
 *     nested bundles and frameworks, then the app as a whole with --deep. No hardened runtime and
 *     no entitlements, as before. Only possible on a Mac; elsewhere it warns, and that .app will
 *     not open on Apple Silicon.
 *
 * Neither is Developer ID: Gatekeeper still blocks the first open of a downloaded copy the same
 * way (docs/MAC.md says how to get past it). Both make the app's signature valid and
 * consistent, which is the difference between "cannot be opened" and "is damaged".
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
const CPU = { arm64: 0x0100000c, x64: 0x01000007 };

function machOMagic(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(8);
    if (fs.readSync(fd, b, 0, 8, 0) < 8) return null;
    const le = b.readUInt32LE(0), be = b.readUInt32BE(0);
    if (le === 0xfeedfacf || le === 0xfeedface) return { fat: false, cpu: b.readUInt32LE(4) };
    if (be === 0xcafebabe || be === 0xcafebabf) {
      // Java class files share 0xcafebabe; a fat Mach-O has a small arch count there.
      const n = b.readUInt32BE(4);
      return n > 0 && n < 20 ? { fat: true, cpu: null } : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * codesign's arguments for Typd's identity: TYPD_MAC_SIGN_IDENTITY (a SHA-1, in the keychain
 * TYPD_MAC_SIGN_KEYCHAIN) when the Mac CI has imported the certificate, else ad hoc. Shared with
 * scripts/app-update-package.js, which signs the update package's app the same way.
 */
function signArgs(env = process.env) {
  const id = (env.TYPD_MAC_SIGN_IDENTITY || '').trim();
  if (!id) return { args: ['--sign', '-'], label: 'ad hoc' };
  if (!/^[0-9A-Fa-f]{40}$/.test(id)) throw new Error('TYPD_MAC_SIGN_IDENTITY must be the certificate\'s SHA-1 (40 hex digits)');
  const kc = (env.TYPD_MAC_SIGN_KEYCHAIN || '').trim();
  return { args: ['--sign', id, '--timestamp=none', ...(kc ? ['--keychain', kc] : [])], label: 'with Typd\'s certificate ' + id.slice(0, 8) };
}

/** `codesign -d -r-`: the designated requirement, the code identity macOS privacy settings remember. */
function designatedRequirement(app) {
  const r = require('child_process').spawnSync('codesign', ['-d', '-r-', app], { encoding: 'utf8' });
  const m = /designated => (.+)/.exec((r.stdout || '') + (r.stderr || ''));
  return m ? m[1].trim() : null;
}

async function afterPack(context) {
  const { electronPlatformName: platform, appOutDir, packager } = context;
  const arch = ARCH[context.arch] || String(context.arch);
  const mac = platform === 'darwin' || platform === 'mas';
  const app = mac ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`) : null;
  const resources = mac ? path.join(app, 'Contents', 'Resources') : path.join(appOutDir, 'resources');

  // --- every platform: it must be able to dictate ---------------------------------------
  // With its bundled model, or (TYPD_NO_BUNDLED_MODEL=1, public installers) with none at all: the
  // app downloads it at first launch. llama-server is always in the app.
  const modelDir = path.join(resources, 'models', 'typd-dictate');
  const server = path.join(resources, 'llama', mac ? 'llama-server' : 'llama-server.exe');
  if (process.env.TYPD_NO_BUNDLED_MODEL === '1') {
    if (process.env.TYPD_TESTER_CONFIG) throw new Error('A tester build bundles its model: unset TYPD_NO_BUNDLED_MODEL (or TYPD_TESTER_CONFIG)');
    if (fs.existsSync(path.join(modelDir, 'model.json'))) throw new Error(`TYPD_NO_BUNDLED_MODEL=1, but ${modelDir} holds a model`);
    if (!fs.existsSync(server) || fs.statSync(server).size === 0) throw new Error(`Packaged app is missing ${server}`);
    console.log(`  • typd: ${platform}/${arch} resources ok (no model: downloaded at first launch; ${path.basename(server)})`);
  } else {
    const spec = JSON.parse(fs.readFileSync(path.join(modelDir, 'model.json'), 'utf8'));
    for (const f of [path.join(modelDir, spec.model), path.join(modelDir, spec.mmproj), server]) {
      if (!fs.existsSync(f) || fs.statSync(f).size === 0) throw new Error(`Packaged app is missing ${f}`);
    }
    console.log(`  • typd: ${platform}/${arch} resources ok (model ${spec.model}, ${path.basename(server)})`);
  }

  // --- Windows: llama.cpp's CUDA backend, in the app or (public installers) not -------------
  // cuda.json (scripts/before-pack.js) names its files; TYPD_NO_BUNDLED_CUDA=1 means none of them may
  // be in the app (the CUDA pack brings them: src/main/cudaPack.js), otherwise all of them.
  if (!mac) {
    const llama = path.dirname(server);
    let desc = null;
    try { desc = JSON.parse(fs.readFileSync(path.join(llama, 'cuda.json'), 'utf8')); } catch { /* none */ }
    const names = desc && Array.isArray(desc.files) ? desc.files.map((f) => f.name) : [];
    const present = names.filter((n) => fs.existsSync(path.join(llama, n)));
    if (process.env.TYPD_NO_BUNDLED_CUDA === '1') {
      if (!desc) throw new Error(`TYPD_NO_BUNDLED_CUDA=1, but ${llama} has no cuda.json: the app could not fetch its CUDA pack`);
      if (present.length) throw new Error(`TYPD_NO_BUNDLED_CUDA=1, but ${llama} holds ${present.join(', ')}`);
      console.log(`  • typd: llama.cpp CPU build (the CUDA backend comes as the CUDA pack ${desc.pack})`);
    } else if (desc) {
      const missing = names.filter((n) => !present.includes(n));
      if (missing.length) throw new Error(`${llama} is missing the CUDA backend's ${missing.join(', ')}`);
      console.log(`  • typd: llama.cpp with its CUDA backend (${desc.pack})`);
    }
  }

  // --- tester builds: TYPD_TESTER_CONFIG names a tester.json to ship ---------------------
  // Only <resources>/tester.json makes a tester build (src/main/sharing.js), so an ordinary
  // build (variable unset) is a public build: it shares with no tester's key (on by default,
  // off in Settings); one left over from an earlier tester build in the same output folder is
  // removed. Copied before signing so the signature
  // covers it. The file holds an upload key: its contents are never logged.
  const tester = path.join(resources, 'tester.json');
  const testerSrc = process.env.TYPD_TESTER_CONFIG;
  if (testerSrc) {
    if (!fs.existsSync(testerSrc)) throw new Error(`TYPD_TESTER_CONFIG is set, but ${testerSrc} does not exist`);
    try { JSON.parse(fs.readFileSync(testerSrc, 'utf8')); } catch { throw new Error('TYPD_TESTER_CONFIG is not valid JSON'); }
    fs.copyFileSync(testerSrc, tester);
    console.log('  • typd: TESTER BUILD -- tester.json included; this app shares dictations with the developer');
  } else {
    fs.rmSync(tester, { force: true });
  }

  if (!mac) return;

  // --- macOS: right architecture, executable, ad-hoc signed ----------------------------
  const m = machOMagic(server);
  if (!m) throw new Error(`${server} is not a Mach-O binary`);
  if (!m.fat && CPU[arch] && m.cpu !== CPU[arch]) {
    throw new Error(`${server} is not built for ${arch} (cpu type 0x${m.cpu.toString(16)}); run node scripts/fetch-llama-mac.js ${arch}`);
  }

  const machos = walk(resources).filter((f) => machOMagic(f));
  for (const f of machos) fs.chmodSync(f, 0o755);
  console.log(`  • typd: ${machos.length} Mach-O files in Resources set to 0755`);

  if (process.platform !== 'darwin') {
    console.warn('  • typd: WARNING not on macOS, so the app is NOT ad-hoc signed; it will not open on Apple Silicon');
    return;
  }

  // Extended attributes (quarantine, Finder info) make codesign refuse the bundle.
  try { run('xattr', ['-cr', app]); } catch { /* nothing to clear */ }
  const how = signArgs();
  for (const f of machos) run('codesign', ['--force', ...how.args, f]);
  run('codesign', ['--force', '--deep', ...how.args, app]);
  run('codesign', ['--verify', '--deep', '--strict', app]);
  const dr = designatedRequirement(app);
  const id = (process.env.TYPD_MAC_SIGN_IDENTITY || '').trim().toLowerCase();
  if (id && !(dr && dr.toLowerCase().includes(id) && dr.includes('identifier "ai.typd.app"'))) {
    throw new Error(`signed with ${id}, but the designated requirement is ${dr}`);
  }
  console.log(`  • typd: signed ${path.basename(app)} ${how.label} (${machos.length} loose Mach-O files + bundle), signature verifies`);
  console.log(`  • typd: designated requirement: ${dr}`);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.signArgs = signArgs;
module.exports.designatedRequirement = designatedRequirement;
