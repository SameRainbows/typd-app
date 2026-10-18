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
 *
 * Two more patches (0.2.4, after a tester's Mac lost Typd on closing its window):
 *  - the event tap (libuiohook/src/darwin/input_hook.c): libuiohook switched the tap back on
 *    when macOS turned it off for a slow answer (kCGEventTapDisabledByTimeout) but not when
 *    macOS turned it off for user input (kCGEventTapDisabledByUserInput): that tap stayed off,
 *    and the key went deaf with Typd still running. Both are switched back on now and counted,
 *    and a watchdog timer on the tap's own run loop checks every 2 s that the tap is on (and
 *    switches it on if not), counting its ticks so a stuck tap thread shows as a count that
 *    stops. src/lib/addon.c exports the counts as tapHealth() (hotkeys.js reads it; the life log
 *    records changes).
 *  - the JS callback (src/lib/addon.c): when a listener threw, uiohook-napi passed the failed
 *    napi_call_function to napi_fatal_error, which aborts the process -- no dialog, no log, Typd
 *    and its menu-bar icon simply gone (uiohook-napi issue #50). Typd's listeners are guarded
 *    (hotkeys.js), and now a throw that gets through anyway costs that one event: the exception
 *    is cleared and the hook carries on.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'node_modules', 'uiohook-napi');
const FILE = path.join(DIR, 'src', 'lib', 'uiohook_worker.c');
const OUT = path.join(DIR, 'build', 'Release', 'uiohook_napi.node');
const MARK = '/* Typd: the start handshake waits for a state (scripts/build-uiohook-mac.js) */';
const TAP_MARK = '/* Typd: the event tap health and its watchdog (scripts/build-uiohook-mac.js) */';
const ADDON_MARK = '/* Typd: tapHealth() and a JS throw that is not fatal (scripts/build-uiohook-mac.js) */';

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

const TAP_EDITS = [
  {
    what: 'the health counters and the watchdog',
    from: 'static event_runloop_info *hook = NULL;\n',
    to: 'static event_runloop_info *hook = NULL;\n\n' + TAP_MARK + '\n' +
      '// Times macOS switched the tap off (each switched straight back on in hook_event_proc), times\n' +
      '// the watchdog found it off and switched it on, whether it is on (1, 0; -1 no tap; -2 its port\n' +
      '// is gone) and the watchdog ticks. Written on the tap thread, read by addon.c tapHealth().\n' +
      'volatile int typd_tap_timeouts = 0;\n' +
      'volatile int typd_tap_user_input = 0;\n' +
      'volatile int typd_tap_rearmed = 0;\n' +
      'volatile int typd_tap_enabled = -1;\n' +
      'volatile int typd_tap_checks = 0;\n' +
      'static CFRunLoopTimerRef typd_watchdog = NULL;\n\n' +
      'static void typd_watchdog_proc(CFRunLoopTimerRef timer, void *info) {\n' +
      '    typd_tap_checks++;\n' +
      '    if (hook == NULL || hook->port == NULL) { typd_tap_enabled = -1; return; }\n' +
      '    if (!CFMachPortIsValid(hook->port)) { typd_tap_enabled = -2; return; }\n' +
      '    if (!CGEventTapIsEnabled(hook->port)) {\n' +
      '        CGEventTapEnable(hook->port, true);\n' +
      '        typd_tap_rearmed++;\n' +
      '    }\n' +
      '    typd_tap_enabled = CGEventTapIsEnabled(hook->port) ? 1 : 0;\n' +
      '}\n'
  },
  {
    what: 'a tap switched off for user input is switched back on too, and both are counted',
    from: '            if (type == (CGEventType) kCGEventTapDisabledByTimeout) {\n' +
      '                logger(LOG_LEVEL_WARN, "%s [%u]: CGEventTap timeout!\\n",\n' +
      '                        __FUNCTION__, __LINE__);\n',
    to: '            if (type == (CGEventType) kCGEventTapDisabledByTimeout || type == (CGEventType) kCGEventTapDisabledByUserInput) {\n' +
      '                logger(LOG_LEVEL_WARN, "%s [%u]: CGEventTap timeout!\\n",\n' +
      '                        __FUNCTION__, __LINE__);\n' +
      '                if (type == (CGEventType) kCGEventTapDisabledByTimeout) { typd_tap_timeouts++; } else { typd_tap_user_input++; }\n'
  },
  {
    what: 'the watchdog runs on the tap run loop while it runs',
    from: '            // Start the hook thread runloop.\n' +
      '            CFRunLoopRun();\n',
    to: '            // Typd: the watchdog, every 2 s on this run loop (typd_watchdog_proc).\n' +
      '            typd_tap_checks = 0;\n' +
      '            typd_watchdog = CFRunLoopTimerCreate(kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + 2.0, 2.0, 0, 0, typd_watchdog_proc, NULL);\n' +
      '            if (typd_watchdog != NULL) {\n' +
      '                CFRunLoopAddTimer(event_loop, typd_watchdog, kCFRunLoopDefaultMode);\n' +
      '            }\n\n' +
      '            // Start the hook thread runloop.\n' +
      '            CFRunLoopRun();\n\n' +
      '            if (typd_watchdog != NULL) {\n' +
      '                CFRunLoopTimerInvalidate(typd_watchdog);\n' +
      '                CFRelease(typd_watchdog);\n' +
      '                typd_watchdog = NULL;\n' +
      '            }\n' +
      '            typd_tap_enabled = -1;\n'
  }
];

const ADDON_EDITS = [
  {
    what: 'a listener that throws is not fatal',
    from: '  status = napi_call_function(env, global, js_callback, 1, &event_obj, NULL);\n' +
      '  NAPI_FATAL_IF_FAILED(status, "tsfn_to_js_proxy", "napi_call_function");\n',
    to: '  status = napi_call_function(env, global, js_callback, 1, &event_obj, NULL);\n' +
      '  if (status != napi_ok) {\n' +
      '    // Typd: a throw costs this one event, never the process (it was napi_fatal_error: an abort).\n' +
      '    bool pending = false;\n' +
      '    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {\n' +
      '      napi_value ignored;\n' +
      '      napi_get_and_clear_last_exception(env, &ignored);\n' +
      '    }\n' +
      '  }\n'
  },
  {
    what: 'tapHealth()',
    from: 'NAPI_MODULE_INIT() {\n',
    to: ADDON_MARK + '\n' +
      '#ifdef __APPLE__\n' +
      'extern volatile int typd_tap_timeouts, typd_tap_user_input, typd_tap_rearmed, typd_tap_enabled, typd_tap_checks;\n' +
      '#endif\n\n' +
      'static void typd_set_int(napi_env env, napi_value obj, const char* name, int value) {\n' +
      '  napi_value v;\n' +
      '  if (napi_create_int32(env, value, &v) == napi_ok) napi_set_named_property(env, obj, name, v);\n' +
      '}\n\n' +
      'napi_value AddonTapHealth(napi_env env, napi_callback_info info) {\n' +
      '  napi_value obj;\n' +
      '  if (napi_create_object(env, &obj) != napi_ok) return NULL;\n' +
      '#ifdef __APPLE__\n' +
      '  typd_set_int(env, obj, "enabled", typd_tap_enabled);\n' +
      '  typd_set_int(env, obj, "timeouts", typd_tap_timeouts);\n' +
      '  typd_set_int(env, obj, "userInput", typd_tap_user_input);\n' +
      '  typd_set_int(env, obj, "rearmed", typd_tap_rearmed);\n' +
      '  typd_set_int(env, obj, "checks", typd_tap_checks);\n' +
      '#endif\n' +
      '  return obj;\n' +
      '}\n\n' +
      'NAPI_MODULE_INIT() {\n'
  },
  {
    what: 'tapHealth() exported',
    from: '  status = napi_set_named_property(env, exports, "keyTap", export_fn);\n' +
      '  NAPI_FATAL_IF_FAILED(status, "NAPI_MODULE_INIT", "napi_set_named_property");\n',
    to: '  status = napi_set_named_property(env, exports, "keyTap", export_fn);\n' +
      '  NAPI_FATAL_IF_FAILED(status, "NAPI_MODULE_INIT", "napi_set_named_property");\n\n' +
      '  status = napi_create_function(env, NULL, 0, AddonTapHealth, NULL, &export_fn);\n' +
      '  NAPI_FATAL_IF_FAILED(status, "NAPI_MODULE_INIT", "napi_create_function");\n' +
      '  status = napi_set_named_property(env, exports, "tapHealth", export_fn);\n' +
      '  NAPI_FATAL_IF_FAILED(status, "NAPI_MODULE_INIT", "napi_set_named_property");\n'
  }
];

/** Every patched file: where it is in uiohook-napi, its mark, its edits. */
const FILES = [
  { rel: 'src/lib/uiohook_worker.c', mark: MARK, edits: EDITS },
  { rel: 'libuiohook/src/darwin/input_hook.c', mark: TAP_MARK, edits: TAP_EDITS },
  { rel: 'src/lib/addon.c', mark: ADDON_MARK, edits: ADDON_EDITS }
];

/** `src` with `edits` applied, or null when it already has `mark`. Throws if an edit does not fit. */
function applyEdits(src, mark, edits, label) {
  src = src.replace(/\r\n/g, '\n');
  if (src.includes(mark)) return null;
  for (const e of edits) {
    const n = src.split(e.from).length - 1;
    if (n !== 1) throw new Error(`${label}: cannot apply "${e.what}" (found ${n} times); check the patch against this version`);
    src = src.replace(e.from, () => e.to);
  }
  return src;
}

/** The patched uiohook_worker.c, or null when `src` already has it. Throws if an edit does not fit. */
function patched(src, version) {
  return applyEdits(src, MARK, EDITS, `uiohook-napi ${version}`);
}

/** Every file's patched text ({rel: text|null}), from the sources in `dir` (bench/hotkeys.js). */
function patchedFiles(dir = DIR) {
  const version = require(path.join(dir, 'package.json')).version;
  const out = {};
  for (const f of FILES) out[f.rel] = applyEdits(fs.readFileSync(path.join(dir, f.rel), 'utf8'), f.mark, f.edits, `uiohook-napi ${version} ${f.rel}`);
  return out;
}

function patch() {
  const version = require(path.join(DIR, 'package.json')).version;
  const out = patchedFiles(DIR);
  for (const f of FILES) {
    if (out[f.rel] === null) { console.log(`${f.rel}: already patched`); continue; }
    fs.writeFileSync(path.join(DIR, f.rel), out[f.rel]);
    console.log(`${f.rel} (uiohook-napi ${version}): patched, ${f.edits.length} edits`);
  }
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

module.exports = { patched, patchedFiles, MARK, TAP_MARK, ADDON_MARK, FILES };   // for bench/hotkeys.js

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
