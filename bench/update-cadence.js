'use strict';

/**
 * Update checks (0.2.5): hourly with jitter, the server's interval, wake checks, "Check for updates",
 * "Restart now", and always the latest version (never one step at a time). Without Electron, a window
 * or the network: checkCadence.js, the real appUpdate.js and modelUpdate.js against local fakes of
 * typd-collect.
 *
 *   - the cadence: an hour, give or take 10 %; checkEverySec (header or JSON) clamped to [15 min, 6 h];
 *     a response without it means the hour again; a wake checks only when the last check is 15 min old
 *   - both updaters: the next check follows the cadence and the server's header; wakeIfDue
 *   - Check for updates, each updater: up to date / a new version (downloading) / offline / an error
 *   - Restart now: a staged Typd installs while the person is at the keyboard with Typd's window open,
 *     but never during a dictation
 *   - always the latest: an install on 0.2.3 has 0.2.4 staged, 0.2.5 is published before it installs:
 *     it ends on 0.2.5 directly, 0.2.4 never installed; the same for a model
 *   - the app's wiring (source checks): the tray item, Settings' button and Restart now, wake/unlock
 *
 *   node bench/update-cadence.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const cad = require('../src/main/checkCadence');
const au = require('../src/main/appUpdate');
const { createUpdater } = require('../src/main/modelUpdate');
const { fakeModelServer } = require('./fake-model-server');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + JSON.stringify(detail).slice(0, 500) : ''));
}
const section = (s) => console.log('\n' + s);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-cadence-'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const H = 3600e3, MIN = 60e3;
const hdrs = (o) => ({ get: (k) => (o[k.toLowerCase()] !== undefined ? o[k.toLowerCase()] : null) });
async function until(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await sleep(25); }
  return Boolean(await cond());
}

/* ------------------------------------------------ a fake typd-collect: app updates */

const K = crypto.generateKeyPairSync('ed25519');
const KEYS = { 'bench-1': K.publicKey.export({ type: 'spki', format: 'pem' }) };
let seq = 100;
function appServer() {
  const s = { manifest: null, status: 200, headers: {}, files: {}, requests: [] };
  s.server = http.createServer((req, res) => {
    s.requests.push({ url: req.url, at: Date.now() });
    if (req.url === '/v1/app/manifest') {
      if (s.status !== 200) { res.writeHead(s.status); return res.end('{}'); }
      if (!s.manifest) { res.writeHead(404, s.headers); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json', ...s.headers });
      return res.end(s.manifest);
    }
    const m = /^\/v1\/app\/file\/([^/]+)\/([^/]+)$/.exec(req.url);
    const body = m && s.files[decodeURIComponent(m[1]) + '/' + decodeURIComponent(m[2])];
    if (!body) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Length': String(body.length) });
    res.end(body);
  });
  /** Publish `version` for win32-x64: a signed manifest, as publish_app_update.py writes it. */
  s.publish = (version) => {
    const bytes = crypto.randomBytes(200000);
    const file = `Typd-${version}-update-win-x64.zip`;
    s.files[version + '/' + file] = bytes;
    s.packages[sha(bytes)] = version;
    const text = JSON.stringify({ schema: 1, seq: ++seq, version, min_version: '0.0.1', notes: '', published_at: new Date().toISOString(),
      platforms: { 'win32-x64': { file, size: bytes.length, sha256: sha(bytes), app: 'Typd', carry: ['resources/models/typd-dictate'] } } });
    s.manifest = JSON.stringify({ typd_app_update: 1, key: 'bench-1', payload: text, sig: crypto.sign(null, Buffer.from(text), K.privateKey).toString('base64') });
  };
  s.packages = {};
  s.fileRequests = () => s.requests.filter((q) => q.url.startsWith('/v1/app/file/'));
  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => { s.endpoint = `http://127.0.0.1:${s.server.address().port}`; resolve(s); }));
}

let appN = 0;
/** An installed Typd at `version` (a stand-in folder) and its updater; quits and helpers counted. */
function appProfile(s, version, over = {}) {
  const root = path.join(tmp, 'app' + (++appN));
  const app = path.join(root, 'Programs', 'typd');
  const dir = path.join(root, 'userData', 'app-update');
  fs.mkdirSync(path.join(app, 'resources', 'models', 'typd-dictate'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Typd.exe'), 'exe ' + version);
  const p = { root, app, dir, quits: 0, helpers: 0, staged: [], busy: false, dictating: false, idleS: 999 };
  const extract = async (zip, dest) => {
    const v = s.packages[sha(fs.readFileSync(zip))] || 'unknown';
    p.staged.push(v);
    fs.mkdirSync(path.join(dest, 'Typd', 'resources'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'Typd', 'Typd.exe'), 'exe ' + v);
    fs.writeFileSync(path.join(dest, 'typd-update.json'), JSON.stringify({ version: v, platform: 'win32-x64', app: 'Typd' }));
  };
  const launchHelper = async ({ dir: d }) => { p.helpers++; setTimeout(() => fs.writeFileSync(path.join(d, 'helper.started'), '1'), 30); return { kill() {} }; };
  p.u = au.createAppUpdater({
    keys: KEYS, appVersion: version, platform: 'win32-x64', dir, endpoint: s.endpoint, app,
    rate: 0, idleMs: 100, systemIdleS: 60, busy: () => p.busy || p.dictating, dictating: () => p.dictating, systemIdle: () => p.idleS,
    warmSettled: () => true, modelOk: () => true, extract, launchHelper, quit: () => { p.quits++; }, helperStartMs: 1500,
    helperScript: path.join(__dirname, '..', 'src', 'main', 'app-update', 'helper-win.ps1'), firstCheckMs: 50,
    ...over
  });
  p.pending = () => readJson(path.join(dir, 'pending.json'));
  return p;
}

/* ------------------------------------------------------ the models' fakes */

const MODEL = (v) => ({ version: v, files: { [`typd-${v}.gguf`]: crypto.randomBytes(120000), [`mmproj-${v}.gguf`]: crypto.randomBytes(60000) },
  model_json: { model: `typd-${v}.gguf`, mmproj: `mmproj-${v}.gguf`, context: true, revise: true } });
let modelN = 0;
function modelProfile(s, over = {}) {
  const root = path.join(tmp, 'model' + (++modelN));
  const bundledDir = path.join(root, 'resources', 'models', 'typd-dictate');
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.writeFileSync(path.join(bundledDir, 'typd-old.gguf'), 'old');
  fs.writeFileSync(path.join(bundledDir, 'mmproj-old.gguf'), 'old');
  fs.writeFileSync(path.join(bundledDir, 'model.json'), JSON.stringify({ model: 'typd-old.gguf', mmproj: 'mmproj-old.gguf' }));
  const p = { root, modelsDir: path.join(root, 'userData', 'models'), switches: [], busy: false };
  p.u = createUpdater({
    keys: s.keys, config: { endpoint: s.endpoint, key: null }, modelsDir: p.modelsDir, bundledDir, appVersion: '0.2.5',
    switchModel: async () => { p.switches.push((readJson(path.join(p.modelsDir, 'current.json')) || {}).version); },
    busy: () => p.busy, rate: 0, idleMs: 50, firstCheckMs: 50, networkCost: async () => 'unmetered', ...over
  });
  p.current = () => (readJson(path.join(p.modelsDir, 'current.json')) || {}).version;
  return p;
}

(async () => {
  section('the cadence: an hour, give or take 10 %; the server\'s interval within 15 min - 6 h; wake after 15 min');
  {
    const c = cad.createCadence({ random: () => 0.5 });
    check('the regular interval is an hour', c.every() === H && cad.DEFAULT_EVERY_MS === H);
    check('jitter: random 0 -> 54 min, 0.5 -> 60 min, 1 -> 66 min', cad.jittered(H, () => 0) === 3240000 && cad.jittered(H, () => 0.5) === H && cad.jittered(H, () => 1) === 3960000);
    const draws = Array.from({ length: 2000 }, () => cad.jittered(H));
    check('2,000 real draws all within 54-66 min, and spread (not all the same)', draws.every((d) => d >= 0.9 * H && d <= 1.1 * H) && new Set(draws).size > 1000);
    check('the header: 7200 -> 2 h', c.fromResponse(hdrs({ 'x-typd-check-every-sec': '7200' })) === 2 * H && c.every() === 2 * H && c.next() === 2 * H);
    check('below 15 min is raised to 15 min (60 -> 15 min)', c.fromResponse(hdrs({ 'x-typd-check-every-sec': '60' })) === 15 * MIN);
    check('above 6 h is held to 6 h (100000 -> 6 h)', c.fromResponse(hdrs({ 'x-typd-check-every-sec': '100000' })) === 6 * H);
    check('nonsense (abc, -5, 0, empty) means the hour', ['abc', '-5', '0', ''].every((v) => c.fromResponse(hdrs({ 'x-typd-check-every-sec': v })) === H));
    check('the JSON field checkEverySec when there is no header', c.fromResponse(hdrs({}), { checkEverySec: 1800 }) === 30 * MIN);
    check('the header wins over the JSON', c.fromResponse(hdrs({ 'x-typd-check-every-sec': '10800' }), { checkEverySec: 1800 }) === 3 * H);
    check('a response without either: the hour again', c.fromResponse(hdrs({}), null) === H && c.hint === null);
    let t = 1e9;
    const w = cad.createCadence({ now: () => t });
    check('a wake before any check: due', w.wakeDue() === true);
    w.checked();
    t += 14 * MIN;
    check('14 min after a check: not due', w.wakeDue() === false);
    t += 2 * MIN;
    check('16 min after: due', w.wakeDue() === true);
  }

  const as = await appServer();
  const ms = await fakeModelServer();

  section('the app updater: next checks by the cadence and the server; wake; Check for updates');
  {
    let p = appProfile(as, '0.2.5');
    as.publish('0.2.5');
    let r = await p.u.check();
    check('up to date: the next check in an hour, give or take 10 %', r.state === 'current' && r.next >= 0.9 * H && r.next <= 1.1 * H, r);
    as.headers = { 'X-Typd-Check-Every-Sec': '10800' };
    r = await p.u.check();
    check('the server asks for 3 h (X-Typd-Check-Every-Sec: 10800): 2.7-3.3 h', r.next >= 2.7 * H && r.next <= 3.3 * H, r);
    as.headers = { 'X-Typd-Check-Every-Sec': '30' };
    r = await p.u.check();
    check('...for 30 s: held to 15 min (13.5-16.5 min)', r.next >= 13.5 * MIN && r.next <= 16.5 * MIN, r);
    as.headers = {};
    r = await p.u.check();
    check('the header gone: back to an hour', r.next >= 0.9 * H && r.next <= 1.1 * H, r);

    let t = Date.now();
    p = appProfile(as, '0.2.5', { now: () => t });
    await p.u.check();
    as.requests = [];
    check('a wake 1 min after a check: no check', p.u.wakeIfDue(50) === false);
    t += 16 * MIN;
    check('a wake 16 min after: a check is set', p.u.wakeIfDue(50) === true);
    check('...and made', await until(() => as.requests.some((q) => q.url === '/v1/app/manifest'), 3000));
    p.u.stop();

    p = appProfile(as, '0.2.5');
    let o = await p.u.checkNow();
    check('Check for updates, nothing newer: "current"', o.outcome === 'current', o);
    p.u.stop();
    p = appProfile(as, '0.2.5', { online: () => false });
    o = await p.u.checkNow();
    check('...offline: "offline"', o.outcome === 'offline', o);
    p.u.stop();
    as.status = 500;
    p = appProfile(as, '0.2.5');
    o = await p.u.checkNow();
    check('...the server failing (500): "error"', o.outcome === 'error' && /500/.test(o.why), o);
    as.status = 200;
    p.u.stop();
    p = appProfile(as, '0.2.5', { rate: 1 });   // 1 B/s: only an unthrottled ("Check for updates") download finishes
    as.publish('0.2.6');
    p.busy = true;   // someone at the keyboard: it will wait to install
    o = await p.u.checkNow();
    check('...a new version: "downloading 0.2.6" at once', o.outcome === 'downloading' && o.version === '0.2.6', o);
    check('it downloads at full speed (the 1 B/s cap is lifted for a check asked for)', await until(() => p.u.state === 'ready', 5000), p.u.state);
    o = await p.u.checkNow();
    check('asked again while it waits: "ready 0.2.6" at once, no second check', o.outcome === 'ready' && o.version === '0.2.6', o);
    p.dictating = true;
    check('Restart now: accepted', p.u.applyNow() === true);
    await sleep(600);
    check('...but not during a dictation', p.quits === 0);
    p.dictating = false;
    check('the dictation over: it installs at once, the window still open and the person still at the keyboard', await until(() => p.quits === 1, 4000) && p.pending() && p.pending().version === '0.2.6', { quits: p.quits });
    p.u.stop();
    check('Restart now with nothing waiting: false', appProfile(as, '0.2.6').u.applyNow() === false);
  }

  section('always the latest app: 0.2.4 staged on 0.2.3, then 0.2.5 published, installs 0.2.5 directly');
  {
    as.publish('0.2.4');
    const p = appProfile(as, '0.2.3');
    p.busy = true;   // 0.2.4 downloads and waits for the person to step away
    const first = p.u.check();
    check('0.2.4 downloaded and staged, waiting to install', await until(() => p.u.state === 'ready' && p.staged.includes('0.2.4'), 5000), { state: p.u.state, staged: p.staged });
    as.publish('0.2.5');
    p.busy = false;   // away: time to install
    let r = await first;
    check('just before installing it reads the manifest again: 0.2.4 dropped, 0.2.5 next, nothing installed yet',
      r.state === 'retry' && r.next <= 1000 && p.quits === 0 && /0\.2\.5 is live now/.test(r.why), r);
    check('the staged 0.2.4 is deleted', !fs.existsSync(path.join(p.dir, '0.2.4')));
    r = await p.u.check();
    check('the next check: 0.2.5 downloaded and installed, never 0.2.4', p.quits === 1 && p.pending() && p.pending().version === '0.2.5' && p.pending().from === '0.2.3', { r, pending: p.pending() });
    check('0.2.4 was staged once and never handed to the helper (one helper, for 0.2.5)', p.helpers === 1 && p.staged.join() === '0.2.4,0.2.5', p.staged);
    p.u.stop();
  }

  section('the model updater: the cadence, the server\'s interval, wake, Check for updates');
  {
    ms.publish({ full: MODEL('m1') });
    let p = modelProfile(ms);
    let r = await p.u.check();
    check('a new model fetched and switched to; the next check in an hour (+-10 %)', r.state === 'current' && p.current() === 'm1' && r.next >= 0.9 * H && r.next <= 1.1 * H, r);
    ms.manifestHeaders = { 'X-Typd-Check-Every-Sec': '21600' };
    r = await p.u.check();
    check('the server asks for 6 h: 5.4-6.6 h', r.next >= 5.4 * H && r.next <= 6.6 * H, r);
    ms.manifestHeaders = {};
    let o = await p.u.checkNow();
    check('Check for updates, nothing newer: "current"', o.outcome === 'current', o);
    ms.publish({ full: MODEL('m2') });
    o = await p.u.checkNow();
    check('...a new model: "downloading m2"', o.outcome === 'downloading' && o.what === 'model' && o.version === 'm2', o);
    await until(() => p.current() === 'm2' && p.u.state === 'current', 5000);
    await sleep(200);   // the check that switched to it ends
    ms.manifestStatus = 500;
    o = await p.u.checkNow();
    check('...the server failing: "error"', o.outcome === 'error', o);
    ms.manifestStatus = 200;
    p.u.stop();
    const q = modelProfile(ms, { online: () => false });
    o = await q.u.checkNow();
    check('...offline: "offline"', o.outcome === 'offline', o);
    let t = Date.now();
    const w = modelProfile(ms, { now: () => t });
    await w.u.check();
    check('a wake 1 min after a check: none; 16 min after: one', w.u.wakeIfDue(50) === false && ((t += 16 * MIN), w.u.wakeIfDue(50)) === true);
    w.u.stop();
  }

  section('always the latest model: m4 published while m3 waits to be switched to: m4 directly');
  {
    ms.publish({ full: MODEL('m3') });
    const p = modelProfile(ms);
    p.busy = true;   // a dictation: m3 waits
    const first = p.u.check();
    await until(() => fs.existsSync(path.join(p.modelsDir, 'm3', 'manifest.json')), 5000);
    ms.publish({ full: MODEL('m4') });
    p.busy = false;
    let r = await first;
    check('read again just before the switch: m3 not switched to, m4 next', r.state === 'retry' && r.next <= 1000 && p.switches.length === 0 && /m4/.test(r.why), r);
    r = await p.u.check();
    check('the next check: m4 downloaded and switched to; m3 deleted', p.current() === 'm4' && p.switches.join() === 'm4' && !fs.existsSync(path.join(p.modelsDir, 'm3')), { switches: p.switches, dirs: fs.readdirSync(p.modelsDir) });
  }

  section('the app\'s wiring (source checks)');
  {
    const idx = read('src/main/index.js'), tray = read('src/main/tray.js'), hw = read('src/main/home-window.js'), pre = read('src/preload/home.js');
    const html = read('src/renderer/home.html'), js = read('src/renderer/home.js'), mu = read('src/main/modelUpdate.js'), aus = read('src/main/appUpdate.js');
    check('the tray has "Check for updates": checks, then opens Settings on the answer', /label: 'Check for updates', click: \(\) => deps\.checkUpdates\(\)/.test(tray) && /checkUpdates: \(\) => \{ checkForUpdates\('the tray menu'\)/.test(idx) && /home\.open\('settings', \{ updates: true/.test(idx));
    check('Settings has the button, the answer line and Restart now, under the version', /id="updatesCheck"/.test(html) && /id="updatesLine"/.test(html) && /id="updatesRestart"/.test(html) && /api\.updates\.check\(\)/.test(js) && /api\.updates\.restart\(\)/.test(js));
    check('IPC: updates:get, updates:check, updates:restart, in the preload too', ['updates:get', 'updates:check', 'updates:restart'].every((c) => hw.includes(`handle('${c}'`) && pre.includes(`call('${c}')`)));
    check('no OS dialog for it', !/showMessageBox|showErrorBox/.test((idx.match(/async function checkForUpdates[\s\S]*?\n\}/) || [''])[0] + (idx.match(/function updatesInfo[\s\S]*?\n\}/) || [''])[0]));
    check('Restart now waits only for a dictation (dictating: () => Boolean(session))', /dictating: \(\) => Boolean\(session\)/.test(idx));
    check('wake and unlock: wakeIfDue in both updaters', [mu, aus].every((src) => /powerMonitor\.on\('resume', \(\) => main\.wakeIfDue\(\)\)/.test(src) && /powerMonitor\.on\('unlock-screen', \(\) => main\.wakeIfDue\(\)\)/.test(src)));
    check('a check on launch: the model 20 s, the app 40 s after start', /const FIRST_CHECK_MS = 20e3;/.test(mu) && /const FIRST_CHECK_MS = 40e3;/.test(aus));
  }

  as.server.close();
  ms.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + (failures ? failures + ' FAILED' : 'all update-cadence checks passed') + '\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
