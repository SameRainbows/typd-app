'use strict';

/**
 * The files a packaged Typd hands to another program by path, and the checks that each one is a real
 * file outside app.asar (src/main/unpacked.js says why that matters). Build time only: not shipped.
 *
 *   checkApp({ resources, platform })  scripts/after-pack.js, on the packaged app; bench/packaged-paths.js
 *                                      on fake ones. -> { problems, notes }; the build is refused unless
 *                                      problems is empty.
 *   checkSource({ root })              bench/packaged-paths.js, on this checkout -> { problems, notes }
 *   scanSpawns(source)                 the static part of checkSource, for one file's text
 *
 * checkApp, for the platform being packaged:
 *   1. every file in SPAWNED is a real file where the shipping code looks for it. The path comes from
 *      the code's own resolver (inject.js helperPath(), say) called with the packaged __dirname, and is
 *      checked with this plain Node's fs, which -- like PowerShell, sh or osascript, and unlike
 *      Electron's -- cannot see inside app.asar. 0.2.11 fails this: its inject.js asked PowerShell for
 *      <resources>\app.asar\src\main\inject.ps1, although build.asarUnpack had put the script beside the
 *      archive. The file there must be this checkout's, and so must the resolver's module in app.asar.
 *   2. nothing another program runs or loads is left inside app.asar: no file named like a script or
 *      native code (RUNNABLE) and none that starts like a PE, ELF or Mach-O binary, unless COPIED_OUT
 *      says the code copies it somewhere real before it runs. Every entry the archive marks unpacked
 *      is really in app.asar.unpacked (uiohook-napi's .node files, inject.ps1).
 * Resources outside the archive from the start (llama-server, typd-mic, the model) are after-pack.js's
 * own checks.
 *
 * checkSource:
 *   1. package.json build.asarUnpack covers every file in SPAWNED, and every one exists.
 *   2. every file under src/ and assets/ (what build.files packs) named like a script or native code is
 *      in SPAWNED or COPIED_OUT: a new helper cannot be added without saying how it gets out of the
 *      archive.
 *   3. no spawn, exec or shell call in src/main takes a path built from __dirname or app.getAppPath()
 *      unless it goes through unpacked() (scanSpawns), except the calls REVIEWED lists, each with why
 *      it is safe.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

/**
 * A main-process module loaded as it loads on `platform`, with Electron stubbed: build time is plain
 * Node, and inject.js hands over to inject-mac.js on a Mac. Loaded fresh and not left in the cache.
 */
function loadAs(rel, platform, root = ROOT) {
  const file = path.join(root, rel);
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const realLoad = Module._load;
  Module._load = function (request, ...rest) { return request === 'electron' ? {} : realLoad.call(this, request, ...rest); };
  Object.defineProperty(process, 'platform', { ...realPlatform, value: platform });
  try {
    delete require.cache[file];
    return require(file);
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
    Module._load = realLoad;
    delete require.cache[file];
  }
}

/**
 * Every file of the app itself (not a resource) that the code hands to another program by path.
 *   file       its place in the app, as build.asarUnpack names it
 *   module     the file whose resolver says where the code looks for it
 *   resolve    (appDir, root) => that place, for the app's files in appDir (<resources>/app.asar packaged)
 */
const SPAWNED = [
  {
    file: 'src/main/inject.ps1',
    platforms: ['win32'],
    by: 'powershell.exe -File (the paste helper, src/main/inject.js)',
    module: 'src/main/inject.js',
    resolve: (appDir, root = ROOT) => loadAs('src/main/inject.js', 'win32', root).helperPath(path.join(appDir, 'src', 'main'))
  }
];

/** Files inside app.asar that another program runs, but only from a copy the code makes first, so they may stay packed. */
const COPIED_OUT = {
  'src/main/app-update/helper-win.ps1': 'appUpdate.js apply() writes it to <userData>/app-update/helper.ps1 and runs that',
  'src/main/app-update/helper-mac.sh': 'appUpdate.js apply() writes it to <userData>/app-update/helper.sh and runs that'
  // Not named like a script, so not checked here, the same way: src/main/mac/inject-helper.js (osascript runs a copy in
  // the temp folder, inject-mac.js script()).
};

/** Named like a script for an interpreter or like native code: something another program would run or load. */
const RUNNABLE = /\.(node|dll|exe|dylib|so|ps1|psm1|bat|cmd|sh|command|py|vbs|scpt|applescript)$/i;

/** 'PE', 'ELF' or 'Mach-O' when `b` starts like one; null otherwise. */
function nativeMagic(b) {
  if (!b || b.length < 4) return null;
  if (b[0] === 0x4d && b[1] === 0x5a) return 'PE';
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return 'ELF';
  const le = b.readUInt32LE(0), be = b.readUInt32BE(0);
  if (le === 0xfeedface || le === 0xfeedfacf || be === 0xfeedface || be === 0xfeedfacf) return 'Mach-O';
  // Java class files share 0xcafebabe; a fat Mach-O has a small arch count after it.
  if ((be === 0xcafebabe || be === 0xcafebabf) && b.length >= 8 && b.readUInt32BE(4) > 0 && b.readUInt32BE(4) < 20) return 'Mach-O';
  return null;
}

const asarPath = (resources, p) => path.join(resources, 'app.asar.unpacked', ...p.split('/'));

/** See the top of this file. */
function checkApp({ resources, platform, root = ROOT, spawned = SPAWNED }) {
  const problems = [], notes = [];
  const archive = path.join(resources, 'app.asar');
  const archived = fs.existsSync(archive);
  const appDir = archived ? archive : path.join(resources, 'app');
  if (!archived && !fs.existsSync(appDir)) return { problems: [`${resources} has neither app.asar nor app/`], notes };
  const asar = archived ? require('./public-build').readAsar(archive) : null;
  try {
    // 1. every file the code spawns by path, where the shipping code looks for it
    for (const s of spawned.filter((x) => x.platforms.includes(platform))) {
      let at;
      try { at = s.resolve(appDir, root); } catch (e) { problems.push(`${s.file}: cannot work out where ${s.by} looks for it (${e.message})`); continue; }
      let st = null;
      try { st = fs.statSync(at); } catch { /* not there for a program outside Electron */ }
      const shown = (path.relative(resources, String(at)) || String(at)).replace(/\\/g, '/');
      if (/\.asar[\\/]/.test(String(at)) || !st || !st.isFile() || !st.size) {
        problems.push(`${s.by} opens <resources>/${shown}, which is not a real file outside app.asar ` +
          '(build.asarUnpack must cover it, and the code must ask for it there: src/main/unpacked.js)');
        continue;
      }
      if (!fs.readFileSync(at).equals(fs.readFileSync(path.join(root, s.file)))) problems.push(`<resources>/${shown} is not this checkout's ${s.file}`);
      if (asar) {
        const shipped = asar.read(s.module);
        if (!shipped) problems.push(`${s.module} is not in app.asar`);
        else if (!shipped.equals(fs.readFileSync(path.join(root, s.module)))) problems.push(`app.asar's ${s.module} is not this checkout's: the path above was resolved by other code`);
      }
      notes.push(`${s.file} -> <resources>/${shown} (${s.by})`);
    }

    // 2. nothing another program runs or loads is left inside the archive
    if (asar) {
      let unpacked = 0;
      const before = problems.length;
      for (const f of asar.files) {
        if (f.unpacked) {
          unpacked++;
          if (!fs.existsSync(asarPath(resources, f.path))) problems.push(`app.asar marks ${f.path} unpacked, but app.asar.unpacked has no such file`);
          continue;
        }
        if (COPIED_OUT[f.path]) continue;
        const magic = RUNNABLE.test(f.path) ? null : nativeMagic(asar.read(f.path));
        const kind = RUNNABLE.test(f.path) ? 'named like a script or native code' : magic ? 'a ' + magic + ' binary' : null;
        if (kind) problems.push(`${f.path} (${kind}) is inside app.asar, where no other program can run or load it: add it to package.json build.asarUnpack`);
      }
      if (problems.length === before) notes.push(`app.asar: ${asar.files.length} files, ${unpacked} of them unpacked (all there), no script or native code left inside`);
    }
  } finally {
    if (asar) asar.close();
  }
  return { problems, notes };
}

/* ------------------------------------------------------------------ the source */

/** Comments out, strings kept (the pill bench's rule: a // after a colon or a quote is a URL, not a comment). */
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"])\/\/.*$/gm, '$1');

// Calls that hand a path to another program (or to the shell, which is one). Not fork(): it runs Electron's own Node,
// which reads app.asar. Not exec(): Typd never uses child_process.exec, and regex .exec() would match.
const CALLS = /(?<![\w$])(spawn|spawnSync|execFile|execFileSync|execSync)\s*\(|\bshell\.(openPath|showItemInFolder|writeShortcutLink)\s*\(/g;
const FROM_APP = /__dirname|getAppPath\s*\(/;

/** The text between the parenthesis at `open` and its match. */
function argsAt(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/**
 * Calls in `source` that take a path built from __dirname or app.getAppPath() without unpacked() around it:
 * in the call itself, or through a variable assigned one. [{line, call, name, args}].
 */
function scanSpawns(source) {
  const text = code(String(source));
  const tainted = new Set();
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*)/g)) {
    if (FROM_APP.test(m[2]) && !/\bunpacked\s*\(/.test(m[2])) tainted.add(m[1]);
  }
  const found = [];
  for (const m of text.matchAll(CALLS)) {
    const args = argsAt(text, m.index + m[0].length - 1);
    const line = text.slice(0, m.index).split('\n').length;
    const call = m[1] || m[2];
    if (FROM_APP.test(args) && !/\bunpacked\s*\(/.test(args)) found.push({ line, call, name: args.match(FROM_APP)[0].replace(/\s*\($/, ''), args });
    for (const name of tainted) if (new RegExp('(?<![\\w$.])' + name.replace(/\$/g, '\\$') + '(?![\\w$])').test(args)) found.push({ line, call, name, args });
  }
  return found;
}

/**
 * Calls scanSpawns finds that were looked at and are safe packaged. `file`, `call` and `name` (the variable,
 * or __dirname/getAppPath) identify one; `why` is the review.
 */
const REVIEWED = [
  { file: 'src/main/home-window.js', call: 'openPath', name: 'file',
    why: 'the model licence: packaged it is <resources>/MODEL_LICENSE.txt (build.extraResources); the __dirname path is a source run\'s' },
  { file: 'src/main/home-window.js', call: 'writeShortcutLink', name: 'getAppPath',
    why: 'the Startup-folder shortcut is made only for a source run; the installed app uses setLoginItemSettings' }
];

/** Every file under `dir`, as paths relative to `root` with forward slashes. */
function filesUnder(root, dir) {
  const out = [];
  (function walk(rel) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel + '/' + e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  })(dir);
  return out;
}

/** An electron-builder glob (*, **, ?) as a RegExp over forward-slash paths. */
function glob(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { re += '.*'; i++; if (pattern[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** See the top of this file. */
function checkSource({ root = ROOT } = {}) {
  const problems = [], notes = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const unpack = [].concat((pkg.build && pkg.build.asarUnpack) || []).map(glob);

  // 1. every file the code spawns by path is unpacked, and is there
  for (const s of SPAWNED) {
    if (!fs.existsSync(path.join(root, s.file))) problems.push(`${s.file} (SPAWNED) does not exist`);
    if (!unpack.some((re) => re.test(s.file))) problems.push(`package.json build.asarUnpack does not cover ${s.file}, which ${s.by} needs outside app.asar`);
  }
  for (const f of Object.keys(COPIED_OUT)) if (!fs.existsSync(path.join(root, f))) problems.push(`${f} (COPIED_OUT) does not exist`);

  // 2. every script or native file that build.files packs is accounted for
  const runnable = [...filesUnder(root, 'src'), ...filesUnder(root, 'assets')].map((f) => f.replace(/^\//, '')).filter((f) => RUNNABLE.test(f));
  for (const f of runnable) {
    if (SPAWNED.some((s) => s.file === f) || COPIED_OUT[f]) continue;
    problems.push(`${f} is a script or native file the app packs, but scripts/packaged-paths.js does not say how it gets out of app.asar (SPAWNED or COPIED_OUT)`);
  }
  notes.push(`${runnable.length} script or native files in src/ and assets/, each unpacked or copied out before it runs`);

  // 3. no spawn of a path inside the archive
  const js = filesUnder(root, 'src/main').map((f) => f.replace(/^\//, '')).filter((f) => f.endsWith('.js'));
  let reviewed = 0;
  for (const f of js) {
    for (const hit of scanSpawns(fs.readFileSync(path.join(root, f), 'utf8'))) {
      if (REVIEWED.some((r) => r.file === f && r.call === hit.call && r.name === hit.name)) { reviewed++; continue; }
      problems.push(`${f}:${hit.line} ${hit.call}() takes ${hit.name}, a path built from __dirname or app.getAppPath(): inside app.asar when packaged ` +
        '(wrap it in unpacked() and add the file to SPAWNED and build.asarUnpack, or review it into REVIEWED)');
    }
  }
  notes.push(`${js.length} main-process files scanned: no spawn, exec or shell call of a path inside app.asar (${reviewed} reviewed as safe)`);
  return { problems, notes };
}

module.exports = { SPAWNED, COPIED_OUT, REVIEWED, RUNNABLE, checkApp, checkSource, scanSpawns, nativeMagic, loadAs, glob };
