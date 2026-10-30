'use strict';

/**
 * Packaged paths: every file a packaged Typd hands to another program by path is a real file outside
 * app.asar (src/main/unpacked.js, scripts/packaged-paths.js). Every packaged Windows install up to 0.2.11
 * copied its dictations and never pasted them: inject.js ran `powershell -File <app.asar>\...\inject.ps1`,
 * which PowerShell cannot read, and every test had run from source.
 *
 *   node bench/packaged-paths.js
 *
 * 1. The paste helper: inject.js helperPath() for a packaged __dirname (Windows and macOS layouts) is
 *    in app.asar.unpacked; from source it is the checkout's own inject.ps1; inject.js starts that one.
 *    unpacked(): only an archive's folder changes, and only once.
 * 2. The injector's process (inject.js with a fake spawn): the helper's stderr reaches the life log as one
 *    clean line when it dies, with its exit code; the next command starts it again; a helper that keeps
 *    dying is left alone for a minute; quitting (stop) is not logged as a death. 2b, macOS: inject-mac.js,
 *    loaded as if from inside app.asar, hands osascript a copy of its script from the temp folder.
 * 3. checkApp on fake packaged apps: the 0.2.12 layout passes; 0.2.11's rule (the helper asked for inside
 *    app.asar) is refused, and so are inject.ps1 packed, a stale inject.ps1, a .node or a PE binary left in
 *    the archive and an "unpacked" entry missing from app.asar.unpacked; the update helpers, copied out
 *    before they run, may stay packed. scripts/after-pack.js itself refuses a Windows app without the
 *    unpacked helper and accepts one with it.
 * 4. checkSource on this checkout: build.asarUnpack covers the helper; every script or native file the
 *    app packs is accounted for; no spawn, exec or shell call takes a path inside the archive; and the
 *    scan does find 0.2.11's inject.js.
 *
 * Plain Node, no Electron, no network, nothing started but `node`. Runs on Windows and macOS.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const pp = require('../scripts/packaged-paths');
const { unpacked } = require('../src/main/unpacked');
const { fakeAppAsar, writeAsar } = require('./fake-asar');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (ok || detail === undefined ? '' : '  -- ' + JSON.stringify(detail).slice(0, 600)));
  if (!ok) failures++;
}
function section(t) { console.log('\n' + t); }
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-packaged-paths-'));

/* ----------------------------------------------------------- 1. the paste helper */

section('1. the paste helper\'s path (inject.js helperPath)');
{
  const inject = pp.loadAs('src/main/inject.js', 'win32');
  const winDir = 'C:\\Users\\me\\AppData\\Local\\Programs\\typd\\resources\\app.asar\\src\\main';
  const want = path.join('C:\\Users\\me\\AppData\\Local\\Programs\\typd\\resources\\app.asar.unpacked\\src\\main', 'inject.ps1');
  check('packaged on Windows: <resources>\\app.asar.unpacked\\src\\main\\inject.ps1', inject.helperPath(winDir) === want, inject.helperPath(winDir));
  const macDir = '/Applications/Typd.app/Contents/Resources/app.asar/src/main';
  check('the same rule for a macOS layout (forward slashes)', inject.helperPath(macDir) === path.join('/Applications/Typd.app/Contents/Resources/app.asar.unpacked/src/main', 'inject.ps1'), inject.helperPath(macDir));
  const src = path.join(root, 'src', 'main');
  check('from source: the checkout\'s own inject.ps1, unchanged, and it exists', inject.helperPath(src) === path.join(src, 'inject.ps1') && fs.existsSync(inject.helperPath(src)));
  check('never a path a program outside Electron cannot open: nothing left under app.asar\\', !/\.asar[\\/]/.test(inject.helperPath(winDir)));
  const ij = read('src/main/inject.js');
  check('inject.js starts the helper it resolves (HELPER = helperPath(); -File HELPER)',
    /const HELPER = helperPath\(\);/.test(ij) && /'-File', HELPER\]/.test(ij) && /function helperPath\(dir = __dirname\) \{\s*return unpacked\(path\.join\(dir, 'inject\.ps1'\)\);/.test(ij));

  check('unpacked(): the archive\'s folder only', unpacked('C:\\x\\resources\\app.asar\\src\\a.ps1') === 'C:\\x\\resources\\app.asar.unpacked\\src\\a.ps1' &&
    unpacked('/R/app.asar/src/a.sh') === '/R/app.asar.unpacked/src/a.sh');
  check('unpacked(): once (an unpacked path stays as it is)', unpacked(unpacked('/R/app.asar/a')) === '/R/app.asar.unpacked/a');
  check('unpacked(): a source path, a file named .asar and a look-alike folder are left alone',
    unpacked('/home/me/typd/src/main/inject.ps1') === '/home/me/typd/src/main/inject.ps1' && unpacked('/R/app.asar') === '/R/app.asar' &&
    unpacked('/R/app.asarx/a') === '/R/app.asarx/a');
}

/* ------------------------------------------------------- 2. the injector's process */

section('2. the injector\'s process: a dead helper says why, and comes back');
{
  // inject.js (the Windows one, on any platform) with a fake spawn and a fake life log: what it starts, and what it
  // logs. A fresh copy of the module each time, so each one's state starts empty.
  const spawned = [], logged = [];
  const fakeProc = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter(); p.stdout.setEncoding = () => {};
    p.stderr = new EventEmitter(); p.stderr.setEncoding = () => {};
    p.stdin = new EventEmitter(); p.stdin.lines = []; p.stdin.write = (l) => { p.stdin.lines.push(l); return true; }; p.stdin.end = () => {};
    p.kill = () => { setImmediate(() => die(p, null, 'SIGTERM')); };
    return p;
  };
  // As Node reports them: 'exit' then 'close' (stdio read to the end); a spawn that fails, 'error' then 'close'.
  const die = (p, code, signal = null) => { p.emit('exit', code, signal); p.emit('close', code, signal); };
  const fail = (p, err) => { p.emit('error', err); p.emit('close', -4058, null); };
  let spawnFails = false;   // as with no powershell.exe: every spawn fails, a moment later
  const fakes = {
    child_process: {
      spawn: (file, args, opts) => {
        const p = fakeProc();
        spawned.push({ file, args, opts, p });
        if (spawnFails) setImmediate(() => fail(p, Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' })));
        return p;
      }
    },
    electron: { clipboard: { readText: async () => '', writeText: async () => {} } },
    './lifelog': { log: (what, detail) => logged.push([what, detail]), clean: require('../src/main/lifelog').clean }
  };
  const loadInject = () => {
    const realLoad = Module._load;
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Module._load = function (request, ...rest) { return Object.prototype.hasOwnProperty.call(fakes, request) ? fakes[request] : realLoad.call(this, request, ...rest); };
    Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' });
    const file = require.resolve('../src/main/inject');
    delete require.cache[file];
    try { return require(file); } finally { Object.defineProperty(process, 'platform', realPlatform); Module._load = realLoad; delete require.cache[file]; }
  };
  const inject = loadInject();
  const tick = () => new Promise((r) => setImmediate(r));

  (async () => {
    inject.start();
    const first = spawned[0];
    check('start(): powershell.exe -File <the resolved helper>, no window', first && /powershell(\.exe)?$/i.test(first.file) &&
      first.args[first.args.indexOf('-File') + 1] === inject.helperPath() && first.opts.windowsHide === true, first && { file: first.file, args: first.args });

    // The 0.2.11 failure, word for word as Windows PowerShell 5.1 reports it on this PC (2026-10-30): the banner on stdout,
    // the error on stderr, exit code 4294770688. Told to the life log once, as one clean line.
    first.p.stdout.emit('data', 'Windows PowerShell\r\nCopyright (C) Microsoft Corporation. All rights reserved.\r\n\r\n');
    first.p.stderr.emit('data', "The argument 'C:\\Users\\me\\AppData\\Local\\Programs\\typd\\resources\\app.asar\\src\\main\\inject.ps1' to the -File parameter does not exist. Provide the path to an existing '.ps1' file as an argument to the -File parameter.\r\n");
    die(first.p, 4294770688);
    await tick();
    const line = logged.find((l) => l[0] === 'injector');
    check('a helper that dies is in the life log with its exit code and why', line && /exited \(code 4294770688\)/.test(line[1]) && /to the -File parameter does not exist/.test(line[1]), logged);
    check('...as one line, with the path (quoted) left out', line && !/\r|\n/.test(line[1]) && !/Users|someone|app\.asar/.test(line[1]), line);

    // CLIXML, which PowerShell may write on a redirected stderr: the error's own text, not the XML.
    const p2 = (inject.focusedApp(), spawned[1]);
    check('the next command starts it again (command() restarts a missing injector)', spawned.length === 2 && p2 && p2.p.stdin.lines[0] === 'focus\n', spawned.length);
    p2.p.stderr.emit('data', '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Add-Type : Cannot add type._x000D__x000A_</S><S S="Error">At line:1 char:1_x000D__x000A_</S></Objs>');
    die(p2.p, 1);
    await tick();
    const l2 = logged.filter((l) => l[0] === 'injector')[1];
    check('CLIXML on stderr: the error line itself, not the XML', l2 && /exited \(code 1\): Add-Type : Cannot add type\.$/.test(l2[1]), l2);

    // A paste with no helper: started again, the command waits for it; this one answers.
    const pasted = inject.paste('hello');
    await tick();
    const p3 = spawned[2];
    check('paste() with the helper gone starts it again instead of giving up', spawned.length === 3 && p3 && /^put /.test(p3.p.stdin.lines[0] || ''), spawned.length);
    p3.p.stdout.emit('data', '{"ready":true}\n{"ok":true}\n');
    const r = await pasted;
    check('...and the paste goes through it', r && r.ok === true, r);
    check('...given the start\'s time as well as its own (a timed-out put could still paste later)',
      /\}, ready \? timeoutMs : timeoutMs \+ START_MS\);/.test(read('src/main/inject.js')) && /const START_MS = 3000;/.test(read('src/main/inject.js')));

    // stop() is Typd quitting: its exit is not a death.
    const before = logged.length;
    inject.stop();
    await tick(); await tick();
    check('stop(): the helper ends, and that is not logged as a death', logged.length === before, logged.slice(before));
    const n1 = spawned.length;
    await new Promise((r) => setTimeout(r, 300));   // the paste's clipboard restore (250 ms) comes due
    check('...and nothing starts it again while Typd quits (the paste\'s restore does not)', spawned.length === n1, spawned.length - n1);

    // A helper that dies five times in a minute is left alone for a minute (no PowerShell per command).
    for (let i = 0; i < 6; i++) {
      inject.start();
      die(spawned[spawned.length - 1].p, 1);
      await tick();
    }
    const n = spawned.length;
    await inject.focusedApp();
    check('a helper that keeps dying is not started again on every command', spawned.length === n, { spawned: spawned.length, n });
    check('...and the life log says so once', logged.filter((l) => /not starting it again/.test(l[1])).length === 1, logged.map((l) => l[1]));

    // A spawn that fails outright (no powershell.exe): an 'error', logged, nothing thrown.
    const fresh = loadInject();
    spawnFails = true;
    const s0 = spawned.length, l0 = logged.length;
    fresh.start();
    await tick(); await tick();
    check('a helper that cannot start at all is logged (could not start, ENOENT)', logged.length === l0 + 1 && /^could not start \(ENOENT\)$/.test(logged[l0][1]), logged.slice(l0));
    const t0 = Date.now();
    const failed = await fresh.paste('hello');
    check('...and a paste tries it again, then leaves the text on the clipboard, saying so, at once', spawned.length === s0 + 2 &&
      failed && failed.ok === false && failed.copied === true && Date.now() - t0 < 1000, { failed, ms: Date.now() - t0, spawns: spawned.length - s0 });
    spawnFails = false;

    // macOS: inject-mac.js, compiled as if it were inside app.asar (a real folder of that name here, which plain Node
    // reads as any other): osascript must be handed a copy outside it, and a helper's death reaches the life log.
    section('2b. macOS: osascript runs a copy of the helper script, never the one in app.asar');
    const dir = path.join(tmp, 'mac', 'Typd.app', 'Contents', 'Resources', 'app.asar', 'src', 'main');
    fs.mkdirSync(path.join(dir, 'mac'), { recursive: true });
    fs.copyFileSync(path.join(root, 'src', 'main', 'mac', 'inject-helper.js'), path.join(dir, 'mac', 'inject-helper.js'));
    const body = fs.readFileSync(path.join(dir, 'mac', 'inject-helper.js'));
    const copy = path.join(os.tmpdir(), 'typd-inject-helper-' + require('crypto').createHash('sha1').update(body).digest('hex').slice(0, 10) + '.js');
    const hadCopy = fs.existsSync(copy);
    const file = path.join(dir, 'inject-mac.js');
    const realLoad = Module._load;
    Module._load = function (request, ...rest) { return Object.prototype.hasOwnProperty.call(fakes, request) ? fakes[request] : realLoad.call(this, request, ...rest); };
    let mac;
    try {
      const m = new Module(file, module);
      m.filename = file;
      m.paths = Module._nodeModulePaths(dir);
      m._compile(read('src/main/inject-mac.js'), file);
      mac = m.exports;
    } finally { Module._load = realLoad; }
    const from = spawned.length;
    mac.start();
    const both = spawned.slice(from);
    const arg = both[0] && both[0].args[2];
    check('both helpers start with osascript -l JavaScript <a copy outside app.asar> keys|ax',
      both.length === 2 && both.every((s) => s.file === '/usr/bin/osascript' && s.args[0] === '-l' && s.args[2] === arg) && both.map((s) => s.args[3]).join() === 'keys,ax' && !/\.asar[\\/]/.test(arg), both.map((s) => [s.file, s.args]));
    check('...the copy is in the temp folder, byte for byte the shipped script', arg === copy && fs.readFileSync(arg).equals(body), arg);
    const n0 = logged.length;
    both[0].p.stderr.emit('data', copy + ': execution error: Error: Not authorized to send Apple events to System Events. (-1743)\n');
    die(both[0].p, 1);
    await tick();
    check('a Mac helper that dies is in the life log too: which one, its exit code and osascript\'s error, without the script\'s path',
      logged.length === n0 + 1 && logged[n0][0] === 'injector' && logged[n0][1] === 'keys helper exited (code 1): execution error: Error: Not authorized to send Apple events to System Events. (-1743)', logged.slice(n0));
    mac.stop();
    await tick(); await tick();
    check('...and stop() is not logged as a death', logged.length === n0 + 1, logged.slice(n0));
    if (!hadCopy) fs.rmSync(copy, { force: true });
    rest();
  })().catch((err) => { check('the injector checks ran', false, String(err && err.stack || err)); rest(); });
}

/* --------------------------------------------- 3. checkApp on fake packaged apps */

function rest() {
  section('3. checkApp on fake packaged Windows apps, and after-pack.js itself');
  {
    const mk = (name, opts) => { const res = path.join(tmp, name, 'resources'); fs.mkdirSync(res, { recursive: true }); fakeAppAsar(res, root, opts); return res; };

    const good = mk('good');
    let r = pp.checkApp({ resources: good, platform: 'win32' });
    check('the 0.2.12 layout (inject.ps1 unpacked, inject.js asks for it there) passes', r.problems.length === 0 && r.notes.some((n) => /app\.asar\.unpacked\/src\/main\/inject\.ps1/.test(n)), r);
    r = pp.checkApp({ resources: good, platform: 'darwin' });
    check('macOS: the Windows helper is not asked for', r.problems.length === 0 && !r.notes.some((n) => /inject\.ps1 ->/.test(n)), r);

    // 0.2.11: the same archive, but the code asked for the script inside it (its HELPER = path.join(__dirname, 'inject.ps1')).
    const old = [{ ...pp.SPAWNED[0], resolve: (appDir) => path.join(appDir, 'src', 'main', 'inject.ps1') }];
    r = pp.checkApp({ resources: good, platform: 'win32', spawned: old });
    check('0.2.11\'s rule (inject.ps1 asked for inside app.asar) is refused, although asarUnpack had it', r.problems.some((p) => /not a real file outside app\.asar/.test(p)), r);

    r = pp.checkApp({ resources: mk('packed', { ps1Unpacked: false }), platform: 'win32' });
    check('inject.ps1 left inside app.asar (asarUnpack dropped) is refused, twice over', r.problems.some((p) => /not a real file outside/.test(p)) &&
      r.problems.some((p) => /src\/main\/inject\.ps1 \(named like a script/.test(p)), r.problems);

    const stale = mk('stale');
    fs.appendFileSync(path.join(stale, 'app.asar.unpacked', 'src', 'main', 'inject.ps1'), '\n# changed\n');
    r = pp.checkApp({ resources: stale, platform: 'win32' });
    check('an unpacked inject.ps1 that is not this checkout\'s is refused', r.problems.some((p) => /is not this checkout's src\/main\/inject\.ps1/.test(p)), r.problems);

    r = pp.checkApp({ resources: mk('node', { extra: [{ path: 'node_modules/uiohook-napi/prebuilds/win32-x64/uiohook-napi.node', data: 'MZ\x90\x00native' }] }), platform: 'win32' });
    check('uiohook-napi\'s .node left inside app.asar is refused', r.problems.some((p) => /uiohook-napi\.node \(named like a script or native code\) is inside app\.asar/.test(p)), r.problems);
    r = pp.checkApp({ resources: mk('pe', { extra: [{ path: 'assets/thing.bin', data: Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1') }] }), platform: 'win32' });
    check('a PE binary inside app.asar is refused whatever it is called', r.problems.some((p) => /assets\/thing\.bin \(a PE binary\)/.test(p)), r.problems);
    r = pp.checkApp({ resources: mk('nodeok', { extra: [{ path: 'node_modules/uiohook-napi/prebuilds/win32-x64/uiohook-napi.node', data: 'MZ native', unpacked: true }] }), platform: 'win32' });
    check('...and passes unpacked', r.problems.length === 0, r.problems);
    r = pp.checkApp({ resources: mk('copied', { extra: Object.keys(pp.COPIED_OUT).map((f) => ({ path: f, data: read(f) })) }), platform: 'win32' });
    check('the app-update helpers (copied out before they run) may stay packed', r.problems.length === 0, r.problems);

    const missing = mk('missing', { extra: [{ path: 'node_modules/x/y.node', data: 'x', unpacked: true }] });
    fs.rmSync(path.join(missing, 'app.asar.unpacked', 'node_modules'), { recursive: true });
    r = pp.checkApp({ resources: missing, platform: 'win32' });
    check('an entry marked unpacked that is not in app.asar.unpacked is refused', r.problems.some((p) => /marks node_modules\/x\/y\.node unpacked, but/.test(p)), r.problems);

    const drift = path.join(tmp, 'drift', 'resources');
    fs.mkdirSync(drift, { recursive: true });
    writeAsar(path.join(drift, 'app.asar'), [
      { path: 'src/main/inject.js', data: '// some other inject.js\n' },
      { path: 'src/main/inject.ps1', data: read('src/main/inject.ps1'), unpacked: true }
    ]);
    r = pp.checkApp({ resources: drift, platform: 'win32' });
    check('an app.asar whose inject.js is not this checkout\'s is refused (the path was resolved by other code)', r.problems.some((p) => /app\.asar's src\/main\/inject\.js is not this checkout's/.test(p)), r.problems);

    // after-pack.js, the electron-builder hook, on a whole fake Windows app (as bench/cuda-pack.js builds one).
    const appOut = path.join(tmp, 'win-unpacked');
    const res = path.join(appOut, 'resources');
    fs.mkdirSync(path.join(res, 'llama'), { recursive: true });
    fs.writeFileSync(path.join(res, 'llama', 'llama-server.exe'), 'llama-server');
    fs.mkdirSync(path.join(res, 'models', 'typd-dictate'), { recursive: true });
    fs.writeFileSync(path.join(res, 'models', 'typd-dictate', 'NO_MODEL.txt'), 'x');
    fs.mkdirSync(path.join(res, 'mic'), { recursive: true });
    fs.writeFileSync(path.join(res, 'mic', 'typd-mic.exe'), 'the microphone helper');
    const afterPack = () => spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(root, 'scripts', 'after-pack.js'))})({ electronPlatformName: 'win32', appOutDir: ${JSON.stringify(appOut)}, arch: 1, packager: { appInfo: { productFilename: 'Typd' } } }).then(() => {}, (e) => { console.error(e.message); process.exit(1); })`],
      { env: { ...process.env, TYPD_NO_BUNDLED_MODEL: '1', TYPD_TESTER_CONFIG: '', TYPD_NO_BUNDLED_CUDA: '' }, encoding: 'utf8', windowsHide: true });
    fakeAppAsar(res, root, { ps1Unpacked: false });
    r = afterPack();
    check('after-pack.js refuses a Windows app whose paste helper is inside app.asar', r.status !== 0 && /paste helper/.test(r.stderr) && /not a real file outside app\.asar/.test(r.stderr), (r.stdout || '') + (r.stderr || ''));
    fakeAppAsar(res, root);
    r = afterPack();
    check('...and builds one with it unpacked, saying where the helper is', r.status === 0 && /inject\.ps1 -> <resources>\/app\.asar\.unpacked\/src\/main\/inject\.ps1/.test(r.stdout), (r.stdout || '') + (r.stderr || ''));
  }

  /* ------------------------------------------------------------ 4. the source */

  section('4. checkSource on this checkout');
  {
    const r = pp.checkSource({ root });
    for (const n of r.notes) console.log('        ' + n);
    check('build.asarUnpack, the packed scripts and native files, and every spawn in src/main: nothing inside app.asar', r.problems.length === 0, r.problems);

    // The scan, against 0.2.11's inject.js and against today's.
    const v0211 = "const HELPER = path.join(__dirname, 'inject.ps1');\nfunction start() {\n  proc = spawn(\n    'powershell',\n    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER],\n    { windowsHide: true }\n  );\n}\n";
    const hits = pp.scanSpawns(v0211);
    check('the scan finds 0.2.11\'s spawn of HELPER (a path built from __dirname)', hits.length === 1 && hits[0].call === 'spawn' && hits[0].name === 'HELPER', hits);
    check('...and nothing in today\'s inject.js', pp.scanSpawns(read('src/main/inject.js')).length === 0, pp.scanSpawns(read('src/main/inject.js')));
    check('a path built in the call itself is found too', pp.scanSpawns("execFile(path.join(app.getAppPath(), 'x.exe'), [])").length === 1 &&
      pp.scanSpawns("require('child_process').spawn('/bin/sh', [path.join(__dirname, 'a.sh')])").length === 1);
    check('...but not one that goes through unpacked(), nor a comment', pp.scanSpawns("spawn(unpacked(path.join(__dirname, 'a.exe')), [])").length === 0 &&
      pp.scanSpawns("// spawn(path.join(__dirname, 'a.exe'))\n/* execFile(__dirname) */").length === 0);
    check('every reviewed call is still in the code (none stale)', pp.REVIEWED.every((rv) => pp.scanSpawns(read(rv.file)).some((h) => h.call === rv.call && h.name === rv.name)), pp.REVIEWED);
    const pkg = JSON.parse(read('package.json'));
    check('npm run bench runs this bench', /node bench\/packaged-paths\.js/.test(pkg.scripts.bench));
    check('after-pack.js runs checkApp and throws on a problem', /require\('\.\/packaged-paths'\)\.checkApp\(/.test(read('scripts/after-pack.js')) && /paths\.problems\.length/.test(read('scripts/after-pack.js')));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + (failures ? failures + ' FAILED' : 'all packaged-path checks passed') + '\n');
  process.exitCode = failures ? 1 : 0;
}
