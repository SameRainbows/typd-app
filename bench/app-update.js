'use strict';

/**
 * App updates without Electron, a model or a window (src/main/appUpdate.js, its helper scripts and
 * scripts/app-update-package.js):
 *
 *   1. the signed manifest: a good signature, a wrong key, a tampered payload, an unknown key id,
 *      a malformed one, and the payload rules (paths that could escape, versions, platforms)
 *   2. the updater against a fake typd-collect: download with Range resume, sha256 verification,
 *      an old manifest replayed, waiting for idle (session, input, the model's first start), the
 *      apply (pending.json, helper vars, the helper's "I run", quit), the new version's verdict and
 *      the "Updated to" line, the model rule, a failed update remembered and skipped until the
 *      manifest changes, aborts, min_version, downgrade, can't-install, a llama.cpp that differs,
 *      429, disk space, the rate cap, and a helper killed halfway
 *   3. installs with the real helper on this platform (Windows: helper-win.ps1 with node.exe as a
 *      stand-in Typd.exe; macOS: helper-mac.sh with a stand-in Typd.app): A -> B, a version that
 *      fails its self-test, one that crashes -- each put back, with the model, llama.cpp,
 *      tester.json and the uninstaller carried over and nothing left behind
 *
 * Everything runs in a throwaway folder; nothing touches %APPDATA%\typd, Typd itself or port 8737,
 * and nothing opens a window.
 *
 *   node bench/app-update.js              all of it
 *   node bench/app-update.js --no-install  1 and 2 only
 *   node bench/app-update.js --keep        leave the throwaway folder (helper.log, fake.log) to read
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync, spawnSync } = require('child_process');

const au = require('../src/main/appUpdate');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + JSON.stringify(detail).slice(0, 500) : ''));
}
const section = (s) => console.log('\n' + s);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-app-update-'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const exists = (p) => fs.existsSync(p);

const K1 = crypto.generateKeyPairSync('ed25519');
const K2 = crypto.generateKeyPairSync('ed25519');
const pem = (k) => k.publicKey.export({ type: 'spki', format: 'pem' });
const KEYS = { 'test-1': pem(K1) };

/** The manifest as publish_app_update.py writes it. */
function signed(payload, { key = K1, id = 'test-1', text = JSON.stringify(payload) } = {}) {
  return JSON.stringify({ typd_app_update: 1, key: id, payload: text, sig: crypto.sign(null, Buffer.from(text, 'utf8'), key.privateKey).toString('base64') });
}

let seq = 100;
function payload(version, platforms, extra = {}) {
  return { schema: 1, seq: ++seq, version, min_version: '0.0.1', notes: '', published_at: new Date().toISOString(), platforms, ...extra };
}

/* ------------------------------------------------------------ 1. the manifest */

section('the signed manifest');
{
  const p = payload('0.2.0', { 'win32-x64': { file: 'Typd-0.2.0-update-win-x64.zip', size: 10, sha256: 'a'.repeat(64), app: 'Typd', carry: ['resources/models/typd-dictate'] } });
  const good = signed(p);
  let r = null, err = null;
  try { r = au.verifyManifest(good, KEYS); } catch (e) { err = e; }
  check('a manifest signed with the embedded key verifies', r && r.payload.version === '0.2.0' && r.key === 'test-1', err && err.message);
  const refused = (text, keys = KEYS) => { try { au.verifyManifest(text, keys); return null; } catch (e) { return e.message; } };
  check('signed with another key under the same id: refused', /bad signature/.test(refused(signed(p, { key: K2 }))));
  const w = JSON.parse(good);
  w.payload = w.payload.replace('"0.2.0"', '"0.9.0"');
  check('payload changed after signing (tampered): refused', /bad signature/.test(refused(JSON.stringify(w))));
  check('an unknown key id: refused', /unknown key/.test(refused(signed(p, { key: K2, id: 'someone-else' }))));
  check('no signature / not the format / not JSON: refused',
    /bad signature/.test(refused(JSON.stringify({ ...JSON.parse(good), sig: '' }))) && /not a signed/.test(refused(JSON.stringify(p))) && /not JSON/.test(refused('<html>')));
  check('a signature that is not 64 bytes of strict base64: refused', /bad signature/.test(refused(JSON.stringify({ ...JSON.parse(good), sig: JSON.parse(good).sig + '=' }))));
  check('the key list is only the embedded one: no key from the manifest itself', refused(good, {}) === 'signed by an unknown key');
  const embedded = require('../src/main/appUpdateKey').keys;
  check('the app embeds an Ed25519 public key', Object.values(embedded).every((k) => crypto.createPublicKey(k).asymmetricKeyType === 'ed25519') && Object.keys(embedded).length >= 1);

  const e = p.platforms['win32-x64'];
  const bad = (patch, plat = 'win32-x64') => au.checkPayload({ ...p, ...patch, platforms: patch.platforms || { [plat]: { ...e, ...(patch.entry || {}) } } });
  check('payload rules: a good one passes', au.checkPayload(p) === null);
  check('carry with ".." is refused', bad({ entry: { carry: ['resources/../../x'] } }) !== null);
  check('carry with an absolute path or backslash is refused', bad({ entry: { carry: ['/etc/x'] } }) !== null && bad({ entry: { carry: ['a\\b'] } }) !== null);
  check('a file name with a slash, or not a zip, is refused', bad({ entry: { file: 'x/y.zip' } }) !== null && bad({ entry: { file: 'Typd.exe' } }) !== null);
  check('requires naming a path it does not carry is refused', bad({ entry: { requires: { 'resources/llama': 'b'.repeat(64) } } }) !== null);
  check('an unknown platform is refused', bad({}, 'linux-x64') !== null);
  check('a version that is not x.y.z, or no seq, is refused', bad({ version: '1.0' }) !== null && bad({ seq: 0 }) !== null && bad({ schema: 2 }) !== null);
  check('cmp: 0.10.0 > 0.9.9, 0.1.0 < 0.2.0', au.cmp('0.10.0', '0.9.9') === 1 && au.cmp('0.1.0', '0.2.0') === -1 && au.cmp('1.2.3', '1.2.3') === 0);
}

/* ------------------------------------------------------- 2. the fake server */

function fakeServer() {
  const s = { manifest: null, manifestStatus: 200, files: {}, cutNext: {}, corrupt: {}, ignoreRange: false, fileStatus: null, requests: [] };
  s.server = http.createServer((req, res) => {
    s.requests.push({ url: req.url, range: req.headers.range || null });
    if (req.url === '/v1/app/manifest') {
      if (s.manifestStatus !== 200) { res.writeHead(s.manifestStatus, s.manifestStatus === 429 ? { 'Retry-After': '120' } : {}); return res.end('{}'); }
      if (!s.manifest) { res.writeHead(404); return res.end('{"error":"no app update published"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(s.manifest);
    }
    const m = /^\/v1\/app\/file\/([^/]+)\/([^/]+)$/.exec(req.url);
    if (!m) { res.writeHead(404); return res.end(); }
    if (s.fileStatus) { res.writeHead(s.fileStatus.status, s.fileStatus.retryAfter ? { 'Retry-After': String(s.fileStatus.retryAfter) } : {}); return res.end('{}'); }
    const name = decodeURIComponent(m[2]);
    let body = s.files[decodeURIComponent(m[1]) + '/' + name];
    if (!body) { res.writeHead(404); return res.end(); }
    if (s.corrupt[name]) { body = Buffer.from(body); body[body.length - 1] ^= 0xff; }
    const r = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    let start = 0, status = 200;
    const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'application/zip' };
    if (r && !s.ignoreRange) {
      start = Number(r[1]);
      if (start >= body.length) { res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }); return res.end(); }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${body.length - 1}/${body.length}`;
    }
    const part = body.subarray(start);
    headers['Content-Length'] = String(part.length);
    res.writeHead(status, headers);
    const cut = s.cutNext[name];
    if (cut) { delete s.cutNext[name]; res.write(part.subarray(0, cut), () => setTimeout(() => res.destroy(), 50)); return; }
    res.end(part);
  });
  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => { s.endpoint = `http://127.0.0.1:${s.server.address().port}`; resolve(s); }));
}
const fileRequests = (s) => s.requests.filter((q) => q.url.startsWith('/v1/app/file/'));

/* --------------------------------------------------------------- 2. the updater */

async function updaterTests() {
  const s = await fakeServer();
  const root = path.join(tmp, 'unit');
  const dir = path.join(root, 'userData', 'app-update');
  const app = path.join(root, 'Programs', 'typd');
  // The installed app, as far as the updater looks at it: the folder, its llama.cpp and model.
  fs.mkdirSync(path.join(app, 'resources', 'llama'), { recursive: true });
  fs.mkdirSync(path.join(app, 'resources', 'models', 'typd-dictate'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Typd.exe'), 'exe');
  fs.writeFileSync(path.join(app, 'resources', 'llama', 'llama-server.exe'), 'llama v1');
  fs.writeFileSync(path.join(app, 'resources', 'models', 'typd-dictate', 'model.json'), '{}');
  const llamaTree = await au.treeHash(path.join(app, 'resources', 'llama'));

  /** A package: its bytes (what the server serves) and what the fake unzip produces. */
  const packages = {};
  function publish(version, extra = {}, entryExtra = {}) {
    const bytes = crypto.randomBytes(300000 + Math.floor(Math.random() * 1000));
    const file = `Typd-${version}-update-win-x64.zip`;
    s.files[version + '/' + file] = bytes;
    packages[sha(bytes)] = version;
    const entry = { file, size: bytes.length, sha256: sha(bytes), app: 'Typd', carry: ['resources/models/typd-dictate', 'resources/llama'], requires: { 'resources/llama': llamaTree }, ...entryExtra };
    const p = payload(version, { 'win32-x64': entry }, extra);
    s.manifest = signed(p);
    return { p, entry, bytes };
  }
  /** "Unzip": a staged Typd folder for whichever version the zip's bytes are. */
  const extract = async (zip, dest) => {
    const version = packages[sha(fs.readFileSync(zip))] || 'unknown';
    fs.mkdirSync(path.join(dest, 'Typd', 'resources'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'Typd', 'Typd.exe'), 'exe ' + version);
    fs.writeFileSync(path.join(dest, 'typd-update.json'), JSON.stringify({ version, platform: 'win32-x64', app: 'Typd' }));
  };
  let helperStarts = 0, quits = 0, helperWorks = true;
  const launchHelper = async ({ script, dir: d }) => {
    helperStarts++;
    if (helperWorks) setTimeout(() => fs.writeFileSync(path.join(d, 'helper.started'), '1'), 50);
    return { kill() {} };
  };
  let busy = false, idleS = 999, warm = true;
  const make = (over = {}) => au.createAppUpdater({
    keys: KEYS, appVersion: '0.1.0', platform: 'win32-x64', dir, endpoint: s.endpoint, app,
    rate: 0, idleMs: 100, systemIdleS: 60, busy: () => busy, systemIdle: () => idleS, warmSettled: () => warm, modelOk: () => true,
    extract, launchHelper, quit: () => { quits++; }, helperStartMs: 1500, resultWaitMs: 1500,
    helperScript: path.join(__dirname, '..', 'src', 'main', 'app-update', 'helper-win.ps1'),
    ...over
  });
  const state = () => readJson(path.join(dir, 'state.json')) || {};
  const patchStateBench = async (fn) => { const st = state(); fn(st); fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st)); };

  section('nothing published, then a new version: download, verify, stage, wait for idle, apply');
  {
    let u = make();
    let r = await u.check();
    check('404 manifest -> nothing to do, no tray line', r.state === 'none' && u.line() === null, r);
    const { entry } = publish('0.2.0');
    s.cutNext[entry.file] = 100000;
    r = await u.check();
    const part = path.join(dir, '0.2.0', entry.file + '.partial');
    check('a cut connection leaves a partial file and a retry', r.state === 'retry' && exists(part) && quits === 0, r);
    check('the tray says it is downloading (paused)', /^Typd 0\.2\.0 · downloading \d+ % \(paused\)$/.test((u.line() || {}).label), u.line());
    const have = fs.statSync(part).size;
    busy = true;
    setTimeout(() => { busy = false; }, 500);
    const t0 = Date.now();
    r = await u.check();
    const resumed = fileRequests(s).pop();
    check('the retry asks only for the rest: Range bytes=<have>-', resumed.range === `bytes=${have}-` && have > 0, resumed);
    check('then waits for the session to end (and a quiet 100 ms) before applying', r.state === 'applying' && Date.now() - t0 >= 550 && quits === 1 && helperStarts === 1, { r, ms: Date.now() - t0, quits });
    const pending = readJson(path.join(dir, 'pending.json'));
    check('pending.json: the version, where from, the staged app, what to carry, the model was fine',
      pending && pending.version === '0.2.0' && pending.from === '0.1.0' && pending.newApp === path.join(dir, '0.2.0', 'staged', 'Typd') &&
      pending.carry.join() === 'resources/models/typd-dictate,resources/llama' && pending.modelOk === true && pending.app === app, pending);
    const vars = readJson(path.join(dir, 'helper.json'));
    check('helper.json: the paths and timeouts the helper needs, the old pid',
      vars && vars.APP === app && vars.NEW === pending.newApp && vars.NEWIN === app + '.update-new' && vars.OLD === app + '.update-old' &&
      vars.OLD_PID === String(process.pid) && vars.CARRY === 'resources/models/typd-dictate\nresources/llama' && Number(vars.VERDICT_TIMEOUT_S) > 0, vars);
    check('the helper script is written beside it, CRLF for Windows PowerShell', exists(path.join(dir, 'helper.ps1')) && fs.readFileSync(path.join(dir, 'helper.ps1'), 'utf8').includes('\r\n'));
    check('the zip was verified and kept, the partial file is gone', exists(path.join(dir, '0.2.0', entry.file)) && !exists(part));

    // The helper swapped the apps and started 0.2.0, which finds pending.json naming itself.
    u = make({ appVersion: '0.2.0' });
    const st = u.startup();
    const verdict = readJson(path.join(dir, 'verdict.json'));
    check('the new version knows it is the first start after an update and says "started" at once',
      st.postUpdate === true && verdict && verdict.version === '0.2.0' && verdict.state === 'started' && verdict.pid === process.pid, { st, verdict });
    setTimeout(() => fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ version: '0.2.0', from: '0.1.0', outcome: 'ok' })), 300);
    const v = await u.settle({ windowOk: true, modelOk: true });
    check('its self-test passes: verdict "ok", and it waits for the helper\'s result', v === 'ok' && readJson(path.join(dir, 'verdict.json')) === null);
    check('then: "Updated to 0.2.0" in the tray, everything cleaned up',
      u.state === 'updated' && (u.line() || {}).label === 'Updated to 0.2.0' && !exists(path.join(dir, 'pending.json')) && !exists(path.join(dir, '0.2.0')) &&
      state().updated.from === '0.1.0', { line: u.line(), files: fs.readdirSync(dir) });
    s.requests = [];
    r = await u.check();
    check('checked again on 0.2.0: up to date, nothing downloaded, the line stays', r.state === 'updated' && fileRequests(s).length === 0 && (u.line() || {}).label === 'Updated to 0.2.0', r);
  }

  section('a bad or replayed manifest is refused before anything is downloaded');
  {
    const u = make({ appVersion: '0.2.0' });
    const { p } = publish('0.3.0');
    s.requests = [];
    s.manifest = signed(p, { key: K2 });
    let r = await u.check();
    check('signed by the wrong key: refused, nothing downloaded', r.state === 'refused' && fileRequests(s).length === 0, r);
    const w = JSON.parse(signed(p));
    w.payload = w.payload.replace(/"sha256":"[0-9a-f]+"/, '"sha256":"' + 'c'.repeat(64) + '"');
    s.manifest = JSON.stringify(w);
    r = await u.check();
    check('a sha256 swapped in the payload: the signature fails, nothing downloaded', r.state === 'refused' && fileRequests(s).length === 0, r);
    s.manifest = signed(p);
    const seen = state().seq;
    const old = { ...p, seq: seen - 1 };
    s.manifest = signed(old);
    r = await u.check();
    check('an older manifest (lower seq) replayed: refused', r.state === 'refused' && /older/.test(r.why) && fileRequests(s).length === 0, { r, seen });
  }

  section('a package that fails sha256 is deleted and fetched again');
  {
    const u = make({ appVersion: '0.2.0' });
    const { entry } = publish('0.3.0');
    s.corrupt[entry.file] = true;
    quits = 0;
    let r = await u.check();
    check('wrong sha256: a retry, the file deleted, nothing applied', r.state === 'retry' && /failed verification/.test(r.why) &&
      !exists(path.join(dir, '0.3.0', entry.file + '.partial')) && !exists(path.join(dir, '0.3.0', entry.file)) && quits === 0, r);
    delete s.corrupt[entry.file];
    r = await u.check();
    check('the next try downloads it again and applies', r.state === 'applying' && quits === 1, r);
  }

  section('a version that failed its self-test is remembered, and skipped until the manifest changes');
  {
    // The helper put 0.2.0 back: it starts again and reads result.json.
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ version: '0.3.0', from: '0.2.0', outcome: 'bad', why: 'Typd 0.3.0 failed its start-up self-test' }));
    let u = make({ appVersion: '0.2.0' });
    const st = u.startup();
    await sleep(200);
    check('the old version learns it was put back: failed, remembered with this manifest', st.postUpdate === false && u.state === 'failed' &&
      state().bad.version === '0.3.0' && !exists(path.join(dir, 'pending.json')) && !exists(path.join(dir, '0.3.0')), { state: u.state, s: state() });
    check('the tray says so', (u.line() || {}).label === "Typd 0.3.0 didn't start · still on 0.2.0", u.line());
    s.requests = []; quits = 0;
    let r = await u.check();
    check('the same manifest again: not downloaded, not applied', r.state === 'failed' && fileRequests(s).length === 0 && quits === 0, r);
    const p = JSON.parse(JSON.parse(s.manifest).payload);
    s.manifest = signed({ ...p, seq: ++seq, notes: 'fixed' });
    u = make({ appVersion: '0.2.0' });
    r = await u.check();
    check('a new manifest: tried again', r.state === 'applying' && quits === 1 && !state().bad, r);
  }

  section('the new version\'s verdict: the model rule');
  {
    // A helper is waiting for the verdict: helper.started names a live process (this one).
    const pend = (modelOk) => {
      fs.writeFileSync(path.join(dir, 'pending.json'), JSON.stringify({ version: '0.4.0', from: '0.3.0', tag: 't', app, carry: [], modelOk }));
      fs.writeFileSync(path.join(dir, 'helper.started'), String(process.pid));
    };
    pend(true);
    let u = make({ appVersion: '0.4.0' });
    u.startup();
    let v = await u.settle({ windowOk: true, modelOk: false });
    check('the model worked before the update and fails now: "failed" (the helper puts the old one back)', v === 'failed' && readJson(path.join(dir, 'verdict.json')).state === 'failed');
    pend(false);
    u = make({ appVersion: '0.4.0' });
    u.startup();
    setTimeout(() => fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ version: '0.4.0', outcome: 'ok' })), 100);
    v = await u.settle({ windowOk: true, modelOk: false });
    check('the model was already failing before the update: the update is not blamed', v === 'ok');
    pend(null);
    u = make({ appVersion: '0.4.0', failVersion: '0.4.0' });
    u.startup();
    v = await u.settle({ windowOk: true, modelOk: true });
    check('TYPD_APP_UPDATE_SELFTEST_FAIL=<this version>: "failed" (the CI\'s rollback test)', v === 'failed');
    pend(true);
    u = make({ appVersion: '0.4.0' });
    u.startup();
    v = await u.settle({ windowOk: false, modelOk: true });
    check('the window did not load: "failed"', v === 'failed' && /window/.test(readJson(path.join(dir, 'verdict.json')).why));
    pend(true);
    const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(dir, 'helper.started'), gone);
    u = make({ appVersion: '0.4.0' });
    u.startup();
    v = await u.settle({ windowOk: true, modelOk: false });
    check('it fails, but the helper is gone (shut down mid-update): it stays rather than leave no Typd at all',
      v === 'kept' && !exists(path.join(dir, 'pending.json')), { v, files: fs.readdirSync(dir) });
    for (const f of ['pending.json', 'verdict.json', 'result.json']) fs.rmSync(path.join(dir, f), { force: true });
  }

  section('waiting for the person to be away');
  {
    publish('0.5.0');
    quits = 0;
    busy = false; idleS = 5; warm = false;
    const u = make({ appVersion: '0.4.0', warmWaitMs: 3000 });
    const done = u.check();
    await sleep(700);
    check('downloaded and staged, but the model\'s first start has not settled: waiting', u.state === 'ready' && quits === 0, u.state);
    check('the tray: "installs when you step away"', (u.line() || {}).label === 'Typd 0.5.0 · installs when you step away', u.line());
    warm = true;
    await sleep(600);
    check('someone typed 5 s ago (under 60 s): still waiting', u.state === 'ready' && quits === 0);
    idleS = 120;
    const r = await done;
    check('no input for 2 minutes: applied', r.state === 'applying' && quits === 1, r);
    for (const f of ['pending.json']) fs.rmSync(path.join(dir, f), { force: true });
  }

  section('a helper that does not start: nothing is quit; three times and the version waits for a new manifest');
  {
    helperWorks = false; quits = 0;
    publish('0.6.0');
    for (let i = 1; i <= 3; i++) {
      const u = make({ appVersion: '0.5.0' });
      const r = await u.check();
      if (i === 1) check('no "I run" from the helper within the limit: a retry, Typd keeps running', r.state === 'retry' && quits === 0 && !exists(path.join(dir, 'pending.json')), r);
    }
    check('after three: remembered as failed', state().bad && state().bad.version === '0.6.0' && /3 times/.test(state().bad.why), state());
    helperWorks = true;
    const r = await make({ appVersion: '0.5.0' }).check();
    check('and not tried again with the same manifest', r.state === 'failed' && quits === 0, r);
  }

  section('versions: same, older, downgrade, min_version, platform, can\'t install, another llama.cpp');
  {
    let u = make({ appVersion: '0.7.0' });
    publish('0.7.0');
    s.requests = [];
    let r = await u.check();
    check('the same version: up to date, nothing downloaded', r.state === 'current' && fileRequests(s).length === 0, r);
    publish('0.6.5');
    r = await u.check();
    check('an older version: left alone', r.state === 'current' && fileRequests(s).length === 0, r);
    publish('0.6.5', { downgrade: true });
    quits = 0;
    r = await u.check();
    check('an older version with downgrade (publish --activate): installed', r.state === 'applying' && quits === 1, r);
    fs.rmSync(path.join(dir, 'pending.json'), { force: true });
    publish('0.8.0', { min_version: '0.7.5' });
    s.requests = [];
    r = await u.check();
    check('this app is older than min_version: "reinstall to update", nothing downloaded', r.state === 'reinstall' && fileRequests(s).length === 0 &&
      (u.line() || {}).action === 'download', { r, line: u.line() });
    publish('0.8.1');
    s.manifest = signed({ ...JSON.parse(JSON.parse(s.manifest).payload), seq: ++seq, platforms: { 'darwin-arm64': { file: 'x.zip', size: 1, sha256: 'd'.repeat(64), app: 'Typd.app' } } });
    r = await u.check();
    check('no package for this platform: nothing to do', r.state === 'none' && fileRequests(s).length === 0, r);
    publish('0.8.2');
    u = make({ appVersion: '0.7.0', problem: 'App Translocation: move Typd to Applications' });
    r = await u.check();
    check('a copy that cannot replace itself: told, nothing downloaded', r.state === 'manual' && fileRequests(s).length === 0 && /can't update itself/.test(u.line().label), r);
    fs.writeFileSync(path.join(app, 'resources', 'llama', 'llama-server.exe'), 'llama v2, hand-copied');
    u = make({ appVersion: '0.7.0' });
    r = await u.check();
    check('an install whose llama.cpp is not the one the package needs: "reinstall", nothing downloaded', r.state === 'reinstall' && fileRequests(s).length === 0, r);
    fs.writeFileSync(path.join(app, 'resources', 'llama', 'llama-server.exe'), 'llama v1');
  }

  section('the same version published again with other bytes: fetched and staged again, never the old copy');
  {
    helperWorks = false;   // the apply stops short, so the first staged copy stays on disk
    const first = publish('1.1.0');
    await make({ appVersion: '0.7.0' }).check();
    const before = fs.readFileSync(path.join(dir, '1.1.0', 'staged.sha256'), 'utf8');
    const second = publish('1.1.0');
    helperWorks = true; quits = 0; s.requests = [];
    let r = await make({ appVersion: '0.7.0' }).check();
    if (r.state === 'retry') r = await make({ appVersion: '0.7.0' }).check();   // the old zip is noticed and deleted first
    const after = fs.readFileSync(path.join(dir, '1.1.0', 'staged.sha256'), 'utf8');
    check('the new bytes are downloaded and staged; what is installed is the new package',
      before === first.entry.sha256 && after === second.entry.sha256 && fileRequests(s).length >= 1 && r.state === 'applying' && quits === 1 &&
      readJson(path.join(dir, 'pending.json')).newApp === path.join(dir, '1.1.0', 'staged', 'Typd'), { r, before: before.slice(0, 8), after: after.slice(0, 8) });
    fs.rmSync(path.join(dir, 'pending.json'), { force: true });
    await patchStateBench((st) => { delete st.aborts; delete st.bad; });
  }

  section('limits: 429, disk space, the rate cap, one check at a time');
  {
    publish('0.9.0');
    let u = make({ appVersion: '0.7.0' });
    s.manifestStatus = 429;
    let r = await u.check();
    check('manifest 429 Retry-After: 120 -> next try in 120 s', r.state === 'retry' && r.next === 120e3, r);
    s.manifestStatus = 200;
    s.fileStatus = { status: 429, retryAfter: 7200 };
    r = await u.check();
    check('file 429 Retry-After: 7200 -> next try in 2 hours', r.state === 'retry' && r.next === 7200e3, r);
    s.fileStatus = null;
    u = make({ appVersion: '0.7.0', statfs: async () => ({ bavail: 10, bsize: 4096 }) });
    r = await u.check();
    check('not enough disk: skipped until the next check, nothing downloaded', r.state === 'space' && r.next === 6 * 3600e3 && /disk space/.test(u.line().label), r);
    fs.rmSync(path.join(dir, '0.9.0'), { recursive: true, force: true });
    const { bytes } = publish('0.9.1');
    u = make({ appVersion: '0.7.0', rate: 1024 * 1024 });
    const t0 = Date.now();
    const a = u.check(), b = u.check();
    check('two calls share one check', a === b);
    r = await a;
    const ms = Date.now() - t0;
    check(`the download is held to its rate (${Math.round(bytes.length / 1024)} KiB at 1 MiB/s >= ${Math.round(bytes.length / 1048.576 * 0.9)} ms)`, r.state === 'applying' && ms >= (bytes.length / 1048576) * 900, { ms, r });
    fs.rmSync(path.join(dir, 'pending.json'), { force: true });
  }

  section('a helper killed halfway: the next start of the old version puts the carried files back');
  {
    const newIn = app + '.update-new';
    fs.mkdirSync(path.join(newIn, 'resources', 'models'), { recursive: true });
    fs.renameSync(path.join(app, 'resources', 'models', 'typd-dictate'), path.join(newIn, 'resources', 'models', 'typd-dictate'));
    fs.writeFileSync(path.join(dir, 'pending.json'), JSON.stringify({ version: '1.0.0', from: '0.7.0', tag: 'zz', app, carry: ['resources/models/typd-dictate'], sides: au.sidePaths(app, 'win32-x64'), newApp: path.join(dir, '1.0.0', 'staged', 'Typd') }));
    const u = make({ appVersion: '0.7.0' });
    u.startup();
    await sleep(200);
    check('the model is back in the installed app; counted as an abort, not a failure', exists(path.join(app, 'resources', 'models', 'typd-dictate', 'model.json')) &&
      state().aborts && state().aborts.n === 1 && u.state === 'idle' && !exists(path.join(dir, 'pending.json')), { state: state(), st: u.state });
    fs.rmSync(newIn, { recursive: true, force: true });
  }

  section('outside Electron, or never packaged: no updater at all');
  check('start() under plain Node returns nothing and schedules nothing', au.start({}) === null && au.line() === null);

  s.server.close();
}

/* ------------------------------------------------- 3. installs with the real helper */

/** A real asar archive holding just package.json, so the packaging script can read the version. */
function asarWith(pkg) {
  const data = Buffer.from(JSON.stringify(pkg));
  const header = Buffer.from(JSON.stringify({ files: { 'package.json': { size: data.length, offset: '0' } } }));
  const padded = Math.ceil(header.length / 4) * 4;
  const hp = Buffer.alloc(8 + padded);
  hp.writeUInt32LE(4 + padded, 0);
  hp.writeInt32LE(header.length, 4);
  header.copy(hp, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(hp.length, 4);
  return Buffer.concat([size, hp, data]);
}

function link(from, to) { fs.mkdirSync(path.dirname(to), { recursive: true }); try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); } }

/** A stand-in packaged Typd for Windows: node.exe as Typd.exe (and as llama-server.exe). */
function fakeWinApp(dir, version, { model = true, tester = false, uninstaller = false } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  link(process.execPath, path.join(dir, 'Typd.exe'));
  link(process.execPath, path.join(dir, 'resources', 'llama', 'llama-server.exe'));
  fs.writeFileSync(path.join(dir, 'resources', 'llama', 'ggml.dll'), 'the same llama.cpp in every version');
  fs.writeFileSync(path.join(dir, 'resources', 'app.asar'), asarWith({ name: 'typd', version }));
  fs.writeFileSync(path.join(dir, 'resources', 'fake.json'), JSON.stringify({ version }));
  if (model) {
    fs.mkdirSync(path.join(dir, 'resources', 'models', 'typd-dictate'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'resources', 'models', 'typd-dictate', 'model.json'), JSON.stringify({ model: 'm.gguf', mmproj: 'p.gguf' }));
    fs.writeFileSync(path.join(dir, 'resources', 'models', 'typd-dictate', 'm.gguf'), 'the bundled model of ' + version);
  }
  if (tester) fs.writeFileSync(path.join(dir, 'resources', 'tester.json'), JSON.stringify({ tester: 'bench', key: 'tk_not_a_real_key_0000' }));
  if (uninstaller) fs.writeFileSync(path.join(dir, 'Uninstall Typd.exe'), 'uninstaller');
  return dir;
}

/** A stand-in Typd.app: a compiled launcher that execs node on app-update-fake.js. */
function fakeMacApp(bundle, version, launcher, { model = true, tester = false } = {}) {
  fs.rmSync(bundle, { recursive: true, force: true });
  const C = path.join(bundle, 'Contents');
  fs.mkdirSync(path.join(C, 'MacOS'), { recursive: true });
  fs.copyFileSync(launcher, path.join(C, 'MacOS', 'Typd'));
  fs.chmodSync(path.join(C, 'MacOS', 'Typd'), 0o755);
  fs.writeFileSync(path.join(C, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Typd</string><key>CFBundleIdentifier</key><string>ai.typd.bench</string>
<key>CFBundleName</key><string>Typd</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string>
<key>LSUIElement</key><true/></dict></plist>
`);
  const R = path.join(C, 'Resources');
  fs.mkdirSync(path.join(R, 'llama'), { recursive: true });
  fs.copyFileSync('/bin/sleep', path.join(R, 'llama', 'llama-server'));
  fs.chmodSync(path.join(R, 'llama', 'llama-server'), 0o755);
  fs.writeFileSync(path.join(R, 'fake.json'), JSON.stringify({ version }));
  if (model) {
    fs.mkdirSync(path.join(R, 'models', 'typd-dictate'), { recursive: true });
    fs.writeFileSync(path.join(R, 'models', 'typd-dictate', 'model.json'), JSON.stringify({ model: 'm.gguf', mmproj: 'p.gguf' }));
    fs.writeFileSync(path.join(R, 'models', 'typd-dictate', 'm.gguf'), 'the bundled model of ' + version);
  }
  if (tester) fs.writeFileSync(path.join(R, 'tester.json'), JSON.stringify({ tester: 'bench', key: 'tk_not_a_real_key_0000' }));
  execFileSync('codesign', ['--force', '--sign', '-', bundle]);
  return bundle;
}

async function installTests() {
  const mac = process.platform === 'darwin', win = process.platform === 'win32';
  if (!mac && !win) { section('installs with the real helper: skipped (Windows and macOS only)'); return; }
  section(`installs with the real ${mac ? 'helper-mac.sh' : 'helper-win.ps1'}`);
  const root = path.join(tmp, 'install');
  const userData = path.join(root, 'userData');
  const reportFile = path.join(root, 'report.json');
  const installed = mac ? path.join(root, 'Applications', 'Typd.app') : path.join(root, 'Programs', 'typd');
  const builds = path.join(root, 'builds');
  const out = path.join(root, 'update');
  const platform = `${process.platform}-${process.arch}`;
  let launcher = null;
  if (mac) {
    launcher = path.join(root, 'launcher');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(launcher + '.c', '#include <stdlib.h>\n#include <unistd.h>\nint main(int c, char **v) { const char *n = getenv("TYPD_FAKE_NODE"), *s = getenv("TYPD_FAKE_SCRIPT");\n' +
      '  if (!n || !s) return 9; char *a[] = { (char *)n, (char *)s, v[0], 0 }; execv(n, a); return 8; }\n');
    const cc = spawnSync('cc', ['-O1', '-o', launcher, launcher + '.c'], { encoding: 'utf8' });
    if (cc.status !== 0) { check('a C compiler for the stand-in app\'s launcher', false, cc.stderr); return; }
  }
  const s = await fakeServer();
  const pkgScript = path.join(__dirname, '..', 'scripts', 'app-update-package.js');

  /** Build `version` as a packaged app and make its update package, as a release would. */
  function build(version) {
    const dir = mac ? path.join(builds, version, 'Typd.app') : path.join(builds, version, 'win-unpacked');
    if (mac) fakeMacApp(dir, version, launcher); else fakeWinApp(dir, version);
    const a = ['win', '--app', dir, '--out', out, '--version', version];
    if (mac) a.splice(0, 1, 'mac'), a.push('--arch', process.arch);
    const r = spawnSync(process.execPath, [pkgScript, ...a], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error('packaging failed: ' + r.stdout + r.stderr);
    const zipName = `Typd-${version}-update-${mac ? 'mac-' + process.arch : 'win-x64'}.zip`;
    return readJson(path.join(out, zipName + '.json'));
  }
  function publish(rec) {
    s.files[rec.version + '/' + rec.file] = fs.readFileSync(path.join(out, rec.file));
    const entry = { file: rec.file, size: rec.size, sha256: rec.sha256, app: rec.app, carry: rec.carry, ...(rec.requires ? { requires: rec.requires } : {}) };
    s.manifest = signed(payload(rec.version, { [platform]: entry }));
  }

  const procs = [];
  function launch(env = {}) {
    const e = {
      ...process.env, TYPD_FAKE_USERDATA: userData, TYPD_FAKE_KEYS_B64: Buffer.from(JSON.stringify(KEYS)).toString('base64'),
      TYPD_APP_UPDATE_URL: s.endpoint, TYPD_APP_UPDATE_REPORT: reportFile, TYPD_APP_UPDATE_FIRST_MS: '300', TYPD_APP_UPDATE_EVERY_MS: '1500', ...env
    };
    let child;
    if (mac) {
      e.TYPD_FAKE_NODE = process.execPath;
      e.TYPD_FAKE_SCRIPT = path.join(__dirname, 'app-update-fake.js');
      child = spawn(path.join(installed, 'Contents', 'MacOS', 'Typd'), [], { env: e, stdio: 'ignore', detached: true });
    } else {
      e.NODE_OPTIONS = '--require ' + path.join(__dirname, 'app-update-fake.js');
      child = spawn(path.join(installed, 'Typd.exe'), [], { env: e, stdio: 'ignore', windowsHide: true });
    }
    procs.push(child.pid);
    return child;
  }
  async function waitReport(pred, ms) {
    const t0 = Date.now();
    let r = null;
    while (Date.now() - t0 < ms) {
      r = readJson(reportFile);
      if (r && pred(r)) return r;
      await sleep(250);
    }
    return r;
  }
  function killAll() {
    const r = readJson(reportFile);
    const pids = new Set([...procs, ...(r && r.pid ? [r.pid] : [])]);
    for (const pid of pids) {
      if (win) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    if (mac) spawnSync('pkill', ['-f', 'app-update-fake.js'], { stdio: 'ignore' });
  }
  const carried = () => mac
    ? { model: exists(path.join(installed, 'Contents/Resources/models/typd-dictate/m.gguf')), tester: exists(path.join(installed, 'Contents/Resources/tester.json')) }
    : { model: exists(path.join(installed, 'resources/models/typd-dictate/m.gguf')), tester: exists(path.join(installed, 'resources/tester.json')),
      llama: exists(path.join(installed, 'resources/llama/llama-server.exe')), uninstaller: exists(path.join(installed, 'Uninstall Typd.exe')) };
  const installedVersion = () => (readJson(path.join(installed, mac ? 'Contents/Resources/fake.json' : 'resources/fake.json')) || {}).version;
  const leftovers = () => fs.readdirSync(path.dirname(installed)).filter((n) => n !== path.basename(installed));
  const helperLog = () => { try { return fs.readFileSync(path.join(userData, 'app-update', 'helper.log'), 'utf8'); } catch { return ''; } };

  try {
    // A is installed (a tester build, with an uninstaller on Windows), B is published.
    if (mac) fakeMacApp(installed, '1.0.0', launcher, { tester: true }); else fakeWinApp(installed, '1.0.0', { tester: true, uninstaller: true });
    const bundledModel = fs.readFileSync(path.join(installed, mac ? 'Contents/Resources/models/typd-dictate/m.gguf' : 'resources/models/typd-dictate/m.gguf'), 'utf8');
    const B = build('2.0.0');
    check('the package leaves out the model and tester.json' + (win ? ' and llama.cpp, naming the llama.cpp tree it needs' : ''),
      B && B.left_out.some((p) => /models/.test(p)) && (mac || (B.requires && /^[0-9a-f]{64}$/.test(B.requires['resources/llama']))), B);
    if (win) check('...and that tree hash is the one the app computes', B.requires['resources/llama'] === await au.treeHash(path.join(installed, 'resources', 'llama')));
    publish(B);
    const t0 = Date.now();
    launch();
    let r = await waitReport((x) => x.version === '2.0.0' && x.state === 'updated', 90e3);
    check(`A (1.0.0) updated itself to B (2.0.0), which passed its self-test and reports "Updated to 2.0.0" (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
      r && r.version === '2.0.0' && r.state === 'updated' && r.line && r.line.label === 'Updated to 2.0.0', { r, log: helperLog().slice(-1500) });
    check('the installed app is now B', installedVersion() === '2.0.0');
    const c = carried();
    check('the model, tester.json' + (win ? ', llama.cpp and the uninstaller' : '') + ' were carried over', Object.values(c).every(Boolean), c);
    check('the model is the one A was installed with (an app update never changes it)',
      fs.readFileSync(path.join(installed, mac ? 'Contents/Resources/models/typd-dictate/m.gguf' : 'resources/models/typd-dictate/m.gguf'), 'utf8') === bundledModel);
    check('no backup or staging folder left next to the app', leftovers().length === 0, leftovers());
    const left = fs.readdirSync(path.join(userData, 'app-update')).filter((n) => !['state.json', 'helper.log', 'helper.started', 'helper.json', 'helper.ps1', 'helper.sh', 'helper.vars'].includes(n));
    check('nothing left in app-update/ but its state and the helper\'s log', left.length === 0, left);
    check('the helper waited for the app and its llama-server, then reported ok', /result: ok/.test(helperLog()), helperLog().slice(-800));
    if (mac) check('B is validly signed after the model was carried in', spawnSync('codesign', ['--verify', '--strict', installed]).status === 0);
    killAll();
    await sleep(1500);

    // C fails its self-test: B is put back and remembers C.
    const C = build('3.0.0');
    publish(C);
    launch({ TYPD_APP_UPDATE_SELFTEST_FAIL: '3.0.0' });
    r = await waitReport((x) => x.version === '2.0.0' && x.state === 'failed', 90e3);
    check('C (3.0.0) failed its self-test: B was put back and started, and remembers C as failed',
      r && r.version === '2.0.0' && r.state === 'failed' && r.bad && r.bad.version === '3.0.0', { r, log: helperLog().slice(-1500) });
    check('the installed app is B again, with everything it carried', installedVersion() === '2.0.0' && Object.values(carried()).every(Boolean), carried());
    check('nothing left next to the app', leftovers().length === 0, leftovers());
    s.requests = [];
    await sleep(3500);
    check('B checks again (every 1.5 s here): the same manifest is not downloaded again', fileRequests(s).length === 0, s.requests);
    killAll();
    await sleep(1500);

    // D crashes right after it starts: B is put back.
    const D = build('4.0.0');
    publish(D);
    launch({ TYPD_FAKE_CRASH: '4.0.0' });
    r = await waitReport((x) => x.version === '2.0.0' && x.state === 'failed' && x.bad && x.bad.version === '4.0.0', 90e3);
    check('D (4.0.0) quit before its verdict: B was put back and remembers D', r && r.bad && r.bad.version === '4.0.0' && /quit before/.test(r.bad.why), { r, log: helperLog().slice(-1500) });
    check('the installed app is B, nothing left over', installedVersion() === '2.0.0' && leftovers().length === 0 && Object.values(carried()).every(Boolean), { v: installedVersion(), l: leftovers() });
    killAll();
  } finally {
    killAll();
    s.server.close();
  }
}

function finish() {
  if (process.argv.includes('--keep')) console.log('\nkept: ' + tmp);
  else try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a file still held open: the OS cleans its temp folder */ }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

(async () => {
  await updaterTests();
  if (!process.argv.includes('--no-install')) await installTests();
})().catch((e) => { failures++; console.log('  FAIL  ' + (e && e.stack)); }).finally(finish);
