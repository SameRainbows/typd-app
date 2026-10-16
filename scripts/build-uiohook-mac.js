'use strict';

/**
 * uiohook-napi for macOS, built from source with its start handshake fixed.
 *
 *   node scripts/build-uiohook-mac.js [arm64] [x64]      (default: this Mac's arch)
 *
 * uIOhook.start() blocks the calling thread -- Electron's main thread -- until the hook
 * thread reports in. uiohook-napi 1.5.5 waits for that with one uv_cond_wait and no
 * condition to re-check. A wait on a condition variable may return without a signal (POSIX
 * allows spurious wakeups; libuv on macOS also returns early for pthread_cond_wait's
 * EINVAL/EBUSY). Woken early, hook_enable() takes the hook's "running" mutex, keeps the
 * control mutex, and joins the hook thread -- which then blocks taking those same mutexes to
 * say it started. Typd's main thread hangs for good: no menu-bar icon (it is made after the
 * key), no key, no quitting.
 *
 * macOS CI caught it (mac.yml, the "switches on" pass): Typd launched as Finder launches it,
 * already trusted for Accessibility, hung at launch in 2 of 3 runs, with the main thread in
 * AddonStart > uiohook_worker_start > hook_enable > uv_thread_join. On a person's Mac that
 * is every launch after the permissions are on -- at login, after "Quit & Reopen", or
 * opening Typd again.
 *
 * The fix: the hook thread records what it reached under the control mutex and hook_enable()
 * waits in a loop until it has; the thread also takes the control mutex before releasing it
 * when hook_run() fails (the original unlocked a mutex it did not hold). node-gyp-build
 * prefers build/Release over the shipped prebuilds, so the packaged app loads this build.
 * Windows keeps the prebuild.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'node_modules', 'uiohook-napi');
const FILE = path.join(DIR, 'src', 'lib', 'uiohook_worker.c');
const OUT = path.join(DIR, 'build', 'Release', 'uiohook_napi.node');
const MARK = '/* Typd: the start handshake waits for a state (scripts/build-uiohook-mac.js) */';

const EDITS = [
  {
    what: 'state the hook thread reports',
    from: 'static dispatcher_t user_dispatcher = NULL;\n',
    to: 'static dispatcher_t user_dispatcher = NULL;\n\n' + MARK + '\n' +
      '// 0 while starting, 1 once EVENT_HOOK_ENABLED was seen, 2 once hook_run() returned.\n' +
      '// Written and read under hook_control_mutex.\n' +
      'static int hook_state = 0;\n' +
      '// EVENT_HOOK_DISABLED took hook_control_mutex; hook_thread_proc() releases it.\n' +
      'static int hook_holds_control = 0;\n'
  },
  {
    what: 'EVENT_HOOK_ENABLED records it',
    from: '    // Signal control cond so hook_enable() can continue.\n' +
      '    uv_mutex_lock(&hook_control_mutex);\n' +
      '    uv_cond_signal(&hook_control_cond);\n',
    to: '    // Signal control cond so hook_enable() can continue.\n' +
      '    uv_mutex_lock(&hook_control_mutex);\n' +
      '    hook_state = 1;\n' +
      '    uv_cond_signal(&hook_control_cond);\n'
  },
  {
    what: 'EVENT_HOOK_DISABLED says it holds the control mutex',
    from: '    // Lock the control mutex until we exit.\n' +
      '    uv_mutex_lock(&hook_control_mutex);\n',
    to: '    // Lock the control mutex until we exit.\n' +
      '    uv_mutex_lock(&hook_control_mutex);\n' +
      '    hook_holds_control = 1;\n'
  },
  {
    what: 'the thread records that hook_run() returned, holding the mutex it releases',
    from: '  // Make sure we signal that we have passed any exception throwing code for\n' +
      '  // the waiting hook_enable().\n' +
      '  uv_cond_signal(&hook_control_cond);\n' +
      '  uv_mutex_unlock(&hook_control_mutex);\n',
    to: '  // Make sure we signal that we have passed any exception throwing code for\n' +
      '  // the waiting hook_enable(). A hook that never started never took the mutex.\n' +
      '  if (!hook_holds_control) uv_mutex_lock(&hook_control_mutex);\n' +
      '  hook_holds_control = 0;\n' +
      '  hook_state = 2;\n' +
      '  uv_cond_signal(&hook_control_cond);\n' +
      '  uv_mutex_unlock(&hook_control_mutex);\n'
  },
  {
    what: 'hook_enable() waits for a state, not for one wakeup',
    from: '    uv_cond_wait(&hook_control_cond, &hook_control_mutex);\n\n' +
      '    if (uv_mutex_trylock(&hook_running_mutex) == 0) {\n' +
      '      // Lock Successful; The hook is not running but the hook_control_cond \n' +
      '      // was signaled!  This indicates that there was a startup problem!\n\n' +
      '      // Get the status back from the thread.\n' +
      '      uv_thread_join(&hook_thread);\n' +
      '      status = hook_thread_status;\n' +
      '      uv_mutex_unlock(&hook_running_mutex);\n' +
      '    }\n',
    to: '    while (hook_state == 0) {\n' +
      '      uv_cond_wait(&hook_control_cond, &hook_control_mutex);\n' +
      '    }\n\n' +
      '    if (hook_state == 2) {\n' +
      '      // hook_run() returned: a startup problem. The thread is done with the\n' +
      '      // control mutex; let it finish, then get the status back from it.\n' +
      '      uv_mutex_unlock(&hook_control_mutex);\n' +
      '      uv_thread_join(&hook_thread);\n' +
      '      uv_mutex_lock(&hook_control_mutex);\n' +
      '      status = hook_thread_status;\n' +
      '    }\n'
  },
  {
    what: 'each start begins from "starting"',
    from: '  // Set the initial status.\n  int status = UIOHOOK_FAILURE;\n',
    to: '  // Set the initial status.\n  int status = UIOHOOK_FAILURE;\n  hook_state = 0;\n  hook_holds_control = 0;\n'
  }
];

/** The patched source, or null when `src` already has it. Throws if an edit does not fit. */
function patched(src, version) {
  src = src.replace(/\r\n/g, '\n');
  if (src.includes(MARK)) return null;
  for (const e of EDITS) {
    const n = src.split(e.from).length - 1;
    if (n !== 1) throw new Error(`uiohook-napi ${version}: cannot apply "${e.what}" (found ${n} times); check the patch against this version`);
    src = src.replace(e.from, () => e.to);
  }
  return src;
}

function patch() {
  const version = require(path.join(DIR, 'package.json')).version;
  const out = patched(fs.readFileSync(FILE, 'utf8'), version);
  if (out === null) { console.log('uiohook_worker.c: already patched'); return; }
  fs.writeFileSync(FILE, out);
  console.log(`uiohook_worker.c (uiohook-napi ${version}): patched, ${EDITS.length} edits`);
}

/** npm's own node-gyp, else a pinned one from the registry. */
function nodeGyp(args) {
  const npmDir = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm');
  let bin = null;
  try { bin = require.resolve('node-gyp/bin/node-gyp.js', { paths: [npmDir] }); } catch { /* not there */ }
  if (bin) execFileSync(process.execPath, [bin, ...args], { stdio: 'inherit', cwd: DIR });
  else execFileSync('npx', ['--yes', 'node-gyp@11.2.0', ...args], { stdio: 'inherit', cwd: DIR });
}

function build(archs) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uiohook-'));
  const parts = [];
  for (const arch of archs) {
    console.log(`\nbuilding uiohook-napi for ${arch}`);
    nodeGyp(['rebuild', '--arch=' + arch]);
    const part = path.join(tmp, arch + '.node');
    fs.copyFileSync(OUT, part);
    parts.push(part);
  }
  // Keep only the addon: node-gyp leaves objects, Makefiles and a static library behind.
  fs.rmSync(path.join(DIR, 'build'), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (parts.length === 1) fs.copyFileSync(parts[0], OUT);
  else execFileSync('lipo', ['-create', ...parts, '-output', OUT], { stdio: 'inherit' });
  fs.rmSync(tmp, { recursive: true, force: true });

  const have = execFileSync('lipo', ['-archs', OUT], { encoding: 'utf8' }).trim().split(/\s+/);
  const want = archs.map((a) => (a === 'x64' ? 'x86_64' : a));
  const missing = want.filter((a) => !have.includes(a));
  if (missing.length) throw new Error('the built addon lacks ' + missing.join(', ') + ' (has ' + have.join(', ') + ')');
  console.log(`\n${path.relative(process.cwd(), OUT)}: ${have.join(' + ')}`);

  // node-gyp-build must pick it over the prebuilds.
  const resolved = require(require.resolve('node-gyp-build', { paths: [DIR] })).resolve(DIR);
  if (path.resolve(resolved) !== path.resolve(OUT)) throw new Error('node-gyp-build would load ' + resolved + ', not the patched build');
  console.log('node-gyp-build loads it');
}

module.exports = { patched, MARK };   // for bench/hotkeys.js

if (require.main === module) {
  if (process.platform !== 'darwin') {
    console.error('build-uiohook-mac.js runs on macOS only');
    process.exit(1);
  }
  const archs = process.argv.slice(2).length ? process.argv.slice(2) : [process.arch];
  for (const a of archs) if (!['arm64', 'x64'].includes(a)) { console.error('unknown arch ' + a); process.exit(1); }
  try {
    patch();
    build(archs);
  } catch (err) {
    console.error(String((err && err.message) || err));
    process.exit(1);
  }
}
