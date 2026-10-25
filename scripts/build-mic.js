#!/usr/bin/env node
'use strict';

/**
 * Build typd-mic, Typd's microphone helper (native/mic/typd-mic.c + miniaudio), into vendor/:
 *
 *   node scripts/build-mic.js win               vendor/mic/typd-mic.exe          (MSVC, Visual Studio 2022)
 *   node scripts/build-mic.js mac arm64 x64     vendor/mic-mac/<arch>/typd-mic   (on a Mac: Xcode's clang)
 *   options: --check   only report whether the vendor folders hold a helper built from this source
 *
 * Windows: one static executable (/MT: no Visual C++ runtime needed), WASAPI only; package.json
 * build.win.extraResources puts vendor/mic at <resources>/mic. macOS: one executable per architecture,
 * Core Audio only, minimum macOS = the app's (build.mac.minimumSystemVersion), with an Info.plist
 * embedded in its __TEXT,__info_plist section (identifier ai.typd.app.mic and the app's own
 * NSMicrophoneUsageDescription, so a microphone question about it can never come without words);
 * build.mac.extraResources puts vendor/mic-mac/${arch} at Contents/Resources/mic, and
 * scripts/after-pack.js signs it with Typd's identity and the audio-input entitlement.
 *
 * miniaudio.h is checked against MINIAUDIO before anything is compiled. A record (BUILD.json: the
 * sha256 of the source, the header and the executable) is written beside each executable; --check and
 * scripts/public-build.js compare it with the source in the tree.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'native', 'mic');
const C_FILE = path.join(SRC, 'typd-mic.c');
// miniaudio 0.11.25 (github.com/mackron/miniaudio, tag 0.11.25 = 9634bedb5b5a2ca38c1ee7108a9358a4e233f14d),
// miniaudio.h unmodified; public domain or MIT No Attribution (native/mic/miniaudio-LICENSE.txt).
const MINIAUDIO = { version: '0.11.25', commit: '9634bedb5b5a2ca38c1ee7108a9358a4e233f14d', sha256: 'ac7af4de748b7e26b777f37e01cee313a308a7296a3eb080e2906b320cc55c89' };
const WIN_OUT = path.join(ROOT, 'vendor', 'mic');
const MAC_OUT = (arch) => path.join(ROOT, 'vendor', 'mic-mac', arch);
const VCVARS = 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat';

const log = (...a) => console.log('[build-mic]', ...a);
function fail(msg) { console.error('[build-mic] ERROR:', msg); process.exit(1); }
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// typd-mic.c by its text: the same source checked out with CRLF (Windows) or LF records the same hash.
const sourceSha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex');

function checkHeader() {
  const h = path.join(SRC, 'miniaudio.h');
  if (!fs.existsSync(h)) fail('native/mic/miniaudio.h is missing');
  const got = sha256(h);
  if (got !== MINIAUDIO.sha256) fail(`native/mic/miniaudio.h is not miniaudio ${MINIAUDIO.version} (sha256 ${got})`);
  if (!fs.existsSync(path.join(SRC, 'miniaudio-LICENSE.txt'))) fail('native/mic/miniaudio-LICENSE.txt is missing');
}

/** What a build of the tree's source would record: compared by --check and public-build.js. */
function sourceRecord() {
  return { source: sourceSha(C_FILE), miniaudio: { ...MINIAUDIO } };
}

function record(exe, extra) {
  const rec = { file: path.basename(exe), size: fs.statSync(exe).size, sha256: sha256(exe), ...sourceRecord(), ...extra, builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(path.dirname(exe), 'BUILD.json'), JSON.stringify(rec, null, 1) + '\n');
  return rec;
}

/** Is the helper in `dir` built from this tree's source? {ok, why}. */
function check(dir, exeName) {
  const exe = path.join(dir, exeName);
  if (!fs.existsSync(exe)) return { ok: false, why: exe + ' is missing' };
  let rec;
  try { rec = JSON.parse(fs.readFileSync(path.join(dir, 'BUILD.json'), 'utf8')); } catch { return { ok: false, why: 'no BUILD.json beside ' + exe }; }
  const src = sourceRecord();
  if (rec.source !== src.source) return { ok: false, why: exe + ' was built from another typd-mic.c' };
  if (!rec.miniaudio || rec.miniaudio.sha256 !== src.miniaudio.sha256) return { ok: false, why: exe + ' was built with another miniaudio.h' };
  if (rec.sha256 !== sha256(exe)) return { ok: false, why: exe + ' changed after it was built' };
  return { ok: true, why: exe + ' = this source (' + rec.sha256.slice(0, 12) + ')' };
}

function win() {
  if (!fs.existsSync(VCVARS)) fail('Visual Studio 2022 (vcvars64.bat) not found');
  fs.mkdirSync(WIN_OUT, { recursive: true });
  const obj = path.join(ROOT, 'vendor', '.mic-obj');
  fs.mkdirSync(obj, { recursive: true });
  const exe = path.join(WIN_OUT, 'typd-mic.exe');
  // /MT: static runtime. /utf-8: the source is UTF-8. /guard:cf /Qspectre-free defaults; /DYNAMICBASE /NXCOMPAT are the linker's defaults.
  const cl = `cl /nologo /O2 /W3 /MT /utf-8 /DNDEBUG /Fo"${obj}\\\\" "${C_FILE}" /Fe"${exe}" /link /SUBSYSTEM:CONSOLE ole32.lib avrt.lib`;
  log('$', cl);
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"call "${VCVARS}" >nul 2>nul && ${cl}"`], { stdio: 'inherit', windowsVerbatimArguments: true, cwd: obj });
  if (r.status !== 0) fail('cl failed (exit ' + r.status + ')');
  const v = spawnSync(exe, ['--version'], { encoding: 'utf8' });
  if (v.status !== 0 || !/^typd-mic /.test(v.stdout)) fail('the built helper does not run: ' + (v.stderr || v.stdout));
  const rec = record(exe, { platform: 'win32', arch: 'x64', compiler: 'MSVC (Visual Studio 2022), /O2 /MT' });
  log('built', path.relative(ROOT, exe), rec.size, 'B, sha256', rec.sha256, '--', v.stdout.trim());
}

function infoPlist() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const usage = pkg.build && pkg.build.mac && pkg.build.mac.extendInfo && pkg.build.mac.extendInfo.NSMicrophoneUsageDescription;
  if (!usage) fail('package.json has no build.mac.extendInfo.NSMicrophoneUsageDescription');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>ai.typd.app.mic</string>
  <key>CFBundleName</key><string>typd-mic</string>
  <key>CFBundleShortVersionString</key><string>${esc(pkg.version)}</string>
  <key>NSMicrophoneUsageDescription</key><string>${esc(usage)}</string>
</dict>
</plist>
`;
}

function mac(archs) {
  if (process.platform !== 'darwin') fail('the macOS helper is built on a Mac (Xcode command line tools)');
  if (!archs.length) archs = ['arm64', 'x64'];
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const min = (pkg.build && pkg.build.mac && pkg.build.mac.minimumSystemVersion) || '13.3';
  for (const arch of archs) {
    if (!['arm64', 'x64'].includes(arch)) fail('unknown arch ' + arch);
    const out = MAC_OUT(arch);
    fs.mkdirSync(out, { recursive: true });
    const plist = path.join(out, 'Info.plist');
    fs.writeFileSync(plist, infoPlist());
    const exe = path.join(out, 'typd-mic');
    const args = ['-O2', '-Wall', '-DNDEBUG', '-arch', arch === 'x64' ? 'x86_64' : 'arm64', `-mmacosx-version-min=${min}`,
      C_FILE, '-o', exe, '-framework', 'CoreFoundation', '-framework', 'CoreAudio', '-framework', 'AudioToolbox', '-lpthread', '-lm',
      `-Wl,-sectcreate,__TEXT,__info_plist,${plist}`];
    log('$ clang', args.join(' '));
    const r = spawnSync('clang', args, { stdio: 'inherit' });
    if (r.status !== 0) fail('clang failed for ' + arch);
    fs.rmSync(plist, { force: true });
    fs.chmodSync(exe, 0o755);
    const lipo = spawnSync('lipo', ['-archs', exe], { encoding: 'utf8' });
    const want = arch === 'x64' ? 'x86_64' : 'arm64';
    if (lipo.stdout.trim() !== want) fail(`${exe} is ${lipo.stdout.trim()}, not ${want}`);
    const rec = record(exe, { platform: 'darwin', arch, compiler: 'clang -O2, macOS ' + min + '+', infoPlist: 'ai.typd.app.mic' });
    log('built', path.relative(ROOT, exe), rec.size, 'B, sha256', rec.sha256);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const which = args[0];
  checkHeader();
  if (args.includes('--check')) {
    const results = which === 'mac'
      ? (args.slice(1).filter((a) => !a.startsWith('--')).length ? args.slice(1).filter((a) => !a.startsWith('--')) : ['arm64', 'x64']).map((a) => check(MAC_OUT(a), 'typd-mic'))
      : [check(WIN_OUT, 'typd-mic.exe')];
    for (const r of results) log(r.ok ? 'OK' : 'NOT OK', r.why);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
  if (which === 'win') win();
  else if (which === 'mac') mac(args.slice(1));
  else fail('usage: node scripts/build-mic.js win | mac [arm64] [x64] [--check]');
}

module.exports = { check, sourceRecord, MINIAUDIO, WIN_OUT, MAC_OUT };
