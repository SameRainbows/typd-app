'use strict';

/**
 * electron-builder afterPack hook. Runs on the unpacked app, before the installer, dmg or
 * zip is made from it.
 *
 * Every platform: refuse to ship an app that cannot dictate -- the model named by the
 * packaged model.json, its mmproj and llama-server must all be in the resources folder.
 * With TYPD_TESTER_CONFIG=<path to a tester.json>, ship it as <resources>/tester.json,
 * which makes a tester build (src/main/sharing.js); without it, make sure there is none.
 *
 * macOS:
 *  1. llama-server must be built for the architecture being packaged.
 *  2. Every Mach-O file under Contents/Resources gets mode 0755. Files fetched on Windows
 *     carry no mode (scripts/fetch-llama-mac.js), and a server without its executable bit
 *     fails to spawn with EACCES.
 *  3. Ad-hoc signature (`codesign --sign -`). build.mac.identity is null, so
 *     electron-builder signs nothing; but Apple Silicon refuses to run code whose signature
 *     is missing or broken, and packaging breaks Electron's (new Info.plist, renamed
 *     binary). The loose Mach-O files in Resources (llama-server, its dylibs, native .node
 *     modules) are signed one by one first, because `--deep` only descends into nested
 *     bundles and frameworks, then the app as a whole with --deep. Only possible on a Mac;
 *     elsewhere it warns, and that .app will not open on Apple Silicon.
 *
 * Ad-hoc is not Developer ID: Gatekeeper still blocks the first open of a downloaded copy
 * (docs/MAC.md says how to get past it). It does make the app's signature valid and
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

module.exports = async function afterPack(context) {
  const { electronPlatformName: platform, appOutDir, packager } = context;
  const arch = ARCH[context.arch] || String(context.arch);
  const mac = platform === 'darwin' || platform === 'mas';
  const app = mac ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`) : null;
  const resources = mac ? path.join(app, 'Contents', 'Resources') : path.join(appOutDir, 'resources');

  // --- every platform: it must be able to dictate ---------------------------------------
  const modelDir = path.join(resources, 'models', 'typd-dictate');
  const spec = JSON.parse(fs.readFileSync(path.join(modelDir, 'model.json'), 'utf8'));
  const server = path.join(resources, 'llama', mac ? 'llama-server' : 'llama-server.exe');
  for (const f of [path.join(modelDir, spec.model), path.join(modelDir, spec.mmproj), server]) {
    if (!fs.existsSync(f) || fs.statSync(f).size === 0) throw new Error(`Packaged app is missing ${f}`);
  }
  console.log(`  • typd: ${platform}/${arch} resources ok (model ${spec.model}, ${path.basename(server)})`);

  // --- tester builds: TYPD_TESTER_CONFIG names a tester.json to ship ---------------------
  // Only <resources>/tester.json makes a tester build (src/main/sharing.js), so an ordinary
  // build (variable unset) shares nothing unless its user chooses to on the public beta's
  // consent screen; one left over from an earlier tester build in the same output folder is
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
  for (const f of machos) run('codesign', ['--force', '--sign', '-', f]);
  run('codesign', ['--force', '--deep', '--sign', '-', app]);
  run('codesign', ['--verify', '--deep', '--strict', app]);
  console.log(`  • typd: ad-hoc signed ${path.basename(app)} (${machos.length} loose Mach-O files + bundle), signature verifies`);
};
