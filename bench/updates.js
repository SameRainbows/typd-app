'use strict';

/**
 * Model updates and the model self-test, without Electron, a model or the network.
 *
 *   - which model folder local.js loads (TYPD_MODEL_DIR, a complete downloaded version, else the
 *     bundled one) and what counts as complete
 *   - the manifest rules the app enforces (no path tricks in file names)
 *   - the self-test's check and its GPU -> CPU decision, with fake servers
 *   - modelUpdate.js against a local fake of typd-collect: download, resume with Range after a
 *     cut connection, a server that ignores Range, sha256 verification, reuse of a file already
 *     on disk, waiting for idle before switching, deleting the previous version (never the
 *     bundled one), revert and "bad version" memory, a crashed switch judged at the next launch,
 *     disk space, 429 Retry-After, 401, min_app, and an ordinary build making no request at all
 *
 * Everything runs in a throwaway folder.
 *
 *   node bench/updates.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { createUpdater, activeModel, checkManifest, older, labelOf } = require('../src/main/modelUpdate');
const local = require('../src/main/pipeline/local');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
}
const section = (s) => console.log('\n' + s);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-updates-'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function versionDir(root, version, files, spec) {
  const dir = path.join(root, version);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
  const manifest = { version, files: Object.entries(files).map(([name, b]) => ({ name, size: b.length, sha256: sha(b) })), model_json: spec };
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(spec));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

/* ------------------------------------------------------------ which model */

section('which model folder local.js loads');
{
  const models = path.join(tmp, 'resolve', 'models');
  const bundled = path.join(tmp, 'resolve', 'bundled');
  fs.mkdirSync(models, { recursive: true });
  const spec = { model: 'm.gguf', mmproj: 'p.gguf' };
  const r = (env = {}) => local.resolveModel({ env, modelsDir: models, bundled });
  check('no current.json -> the bundled model', r().dir === bundled && r().version === null);
  check('TYPD_MODEL_DIR wins over everything', r({ TYPD_MODEL_DIR: 'X:/eval' }).dir === 'X:/eval');
  const v1 = versionDir(models, 'v1', { 'm.gguf': Buffer.from('model'), 'p.gguf': Buffer.from('proj') }, spec);
  fs.writeFileSync(path.join(models, 'current.json'), JSON.stringify({ version: 'v1', confirmed: true }));
  check('current.json naming a complete version -> that folder', r().dir === v1 && r().version === 'v1');
  check('TYPD_MODEL_DIR still wins', r({ TYPD_MODEL_DIR: 'X:/eval' }).dir === 'X:/eval');
  fs.writeFileSync(path.join(v1, 'm.gguf'), 'model!');
  check('a file of the wrong size -> the bundled model', r().dir === bundled);
  fs.writeFileSync(path.join(v1, 'm.gguf'), 'model');
  fs.rmSync(path.join(v1, 'manifest.json'));
  check('no manifest.json in the folder -> the bundled model', r().dir === bundled);
  fs.writeFileSync(path.join(models, 'current.json'), JSON.stringify({ version: 'v2' }));
  fs.mkdirSync(path.join(models, 'v2.partial'));
  check('only a partial download -> the bundled model', r().dir === bundled);
  fs.writeFileSync(path.join(models, 'current.json'), JSON.stringify({ version: '../../etc' }));
  check('a version with a path in it -> the bundled model', r().dir === bundled);
  fs.writeFileSync(path.join(models, 'current.json'), '{not json');
  check('an unreadable current.json -> the bundled model', r().dir === bundled);
  check('activeModel(missing folder) -> null', activeModel(path.join(tmp, 'nowhere')) === null);
}

section('manifest rules');
{
  const good = { version: 'r24_1p7b', files: [{ name: 'a.gguf', size: 1, sha256: 'a'.repeat(64) }, { name: 'b.gguf', size: 2, sha256: 'b'.repeat(64) }], model_json: { model: 'a.gguf', mmproj: 'b.gguf' }, min_app: '0.1.0' };
  check('a good manifest', checkManifest(good) === null);
  check('a file name with ../ is refused', checkManifest({ ...good, files: [{ ...good.files[0], name: '../a.gguf' }, good.files[1]] }) !== null);
  check('a file name with a slash is refused', checkManifest({ ...good, files: [{ ...good.files[0], name: 'x/a.gguf' }, good.files[1]] }) !== null);
  check('a file called model.json is refused', checkManifest({ ...good, files: [{ ...good.files[0], name: 'model.json' }, good.files[1]] }) !== null);
  check('a version with a path is refused', checkManifest({ ...good, version: '../x' }) !== null);
  check('model_json naming a missing file is refused', checkManifest({ ...good, model_json: { model: 'a.gguf', mmproj: 'c.gguf' } }) !== null);
  check('a short sha256 is refused', checkManifest({ ...good, files: [{ ...good.files[0], sha256: 'abc' }, good.files[1]] }) !== null);
  check('older(0.1.0, 0.2.0) / not older(0.1.0, 0.1.0) / not older(0.10.0, 0.9.9)', older('0.1.0', '0.2.0') && !older('0.1.0', '0.1.0') && !older('0.10.0', '0.9.9'));
  check('labelOf(typd-dictate-1.7b-r24_1p7b-q4_k_m.gguf) = r24_1p7b', labelOf('typd-dictate-1.7b-r24_1p7b-q4_k_m.gguf') === 'r24_1p7b');
}

/* -------------------------------------------------------------- self-test */

section('self-test: the check');
{
  const fixture = readJson(path.join(__dirname, '..', 'test', 'fixtures', 'dictation-3s.json'));
  check('the fixture clip ships with the app (package.json build.files)', require('../package.json').build.files.includes('test/fixtures/dictation-3s.wav') && fs.existsSync(local.FIXTURE));
  check('the clean fixture text passes', local.selfTestPasses(fixture.clean));
  check('what the 0.6B and 1.7B models write passes', local.selfTestPasses('Can you remind me what time the train to the airport leaves on Sunday?') && local.selfTestPasses('can you remind me what time the train to the airport leaves on sunday'));
  check('the Metal failure ("8888...") fails', !local.selfTestPasses('8'.repeat(200)));
  check('the cut-off loop ("8") fails', !local.selfTestPasses('8'));
  check('empty text fails', !local.selfTestPasses(''));
  check('two content words are not enough', !local.selfTestPasses('the train to the airport'));
  check('right words with a 21-character run fail', !local.selfTestPasses('Remind me what time the train to the airport leaves aaaaaaaaaaaaaaaaaaaaa'));
  check('right words with a 20-character run pass', local.selfTestPasses('Remind me what time the train to the airport leaves aaaaaaaaaaaaaaaaaaaa'));
}

section('self-test: GPU -> CPU');
(async () => {
  const fake = ({ gpuOk, cpuOk, explicit, remembered }) => {
    const calls = [];
    let layers = null;
    return {
      calls,
      opts: {
        explicit, remembered,
        serve: async (l) => { calls.push('serve ' + l); layers = l; return l; },
        stopServer: async () => { calls.push('stop'); },
        test: async () => { calls.push('test'); const ok = layers === '0' ? cpuOk : gpuOk; return { ok, text: ok ? 'fine' : '8888' }; },
        remember: async (e) => { calls.push('remember ' + e.gpuSaid); }
      }
    };
  };
  let f = fake({ gpuOk: true, cpuOk: true });
  let r = await local.bringUp(f.opts);
  check('GPU passes: stays on the GPU, nothing remembered', r.layers === '99' && f.calls.join() === 'serve 99,test', f.calls);
  f = fake({ gpuOk: false, cpuOk: true });
  r = await local.bringUp(f.opts);
  check('GPU writes garbage: restarted on the CPU, tested again, remembered', r.layers === '0' && f.calls.join() === 'serve 99,test,stop,serve 0,test,remember 8888', f.calls);
  f = fake({ gpuOk: false, cpuOk: true, remembered: true });
  r = await local.bringUp(f.opts);
  check('remembered as CPU-only: straight to the CPU, tested once', r.layers === '0' && f.calls.join() === 'serve 0,test', f.calls);
  f = fake({ gpuOk: false, cpuOk: false });
  let err = null;
  try { await local.bringUp(f.opts); } catch (e) { err = e; }
  check('wrong on both: stopped, and warm() fails (so an update is reverted)', err && /self-test/.test(err.message) && f.calls.join() === 'serve 99,test,stop,serve 0,test,stop', f.calls);
  f = fake({ gpuOk: false, cpuOk: true, explicit: '99' });
  err = null;
  try { await local.bringUp(f.opts); } catch (e) { err = e; }
  check('an explicit TYPD_GPU_LAYERS is never changed: fails instead', err && f.calls.join() === 'serve 99,test,stop', f.calls);
  f = fake({ gpuOk: false, cpuOk: false });
  r = await local.bringUp({ ...f.opts, enabled: false });
  check('TYPD_SELFTEST=0: started, not tested', r.tested === false && f.calls.join() === 'serve 99', f.calls);

  await updaterTests();
})().catch((e) => { failures++; console.log('  FAIL  ' + (e && e.stack)); }).finally(finish);

/* ------------------------------------------------------- the fake server */

function fakeServer() {
  const s = {
    key: 'tk_test_0123456789abcdef',
    manifest: null,        // object, or null for 404
    manifestStatus: 200,
    files: {},             // "<version>/<name>" -> Buffer
    cutNext: {},           // name -> bytes after which the next response for it is cut off
    ignoreRange: false,
    corrupt: {},           // name -> true: serve a flipped byte
    fileStatus: null,      // {status, retryAfter}: every file request answers this
    requests: []
  };
  s.server = http.createServer((req, res) => {
    s.requests.push({ url: req.url, range: req.headers.range || null });
    if (req.headers.authorization !== 'Bearer ' + s.key) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
    if (req.url === '/v1/model/manifest') {
      if (s.manifestStatus !== 200) { res.writeHead(s.manifestStatus, s.manifestStatus === 429 ? { 'Retry-After': '120' } : {}); return res.end('{}'); }
      if (!s.manifest) { res.writeHead(404); return res.end('{"error":"no model published"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(s.manifest));
    }
    const m = /^\/v1\/model\/file\/([^/]+)\/([^/]+)$/.exec(req.url);
    if (!m) { res.writeHead(404); return res.end(); }
    if (s.fileStatus) { res.writeHead(s.fileStatus.status, s.fileStatus.retryAfter ? { 'Retry-After': String(s.fileStatus.retryAfter) } : {}); return res.end('{}'); }
    const name = decodeURIComponent(m[2]);
    let body = s.files[decodeURIComponent(m[1]) + '/' + name];
    if (!body) { res.writeHead(404); return res.end(); }
    if (s.corrupt[name]) { body = Buffer.from(body); body[body.length - 1] ^= 0xff; }
    const r = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    let start = 0, status = 200;
    const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' };
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
    if (cut) {
      delete s.cutNext[name];
      res.write(part.subarray(0, cut), () => setTimeout(() => res.destroy(), 50));
      return;
    }
    res.end(part);
  });
  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => { s.endpoint = `http://127.0.0.1:${s.server.address().port}`; resolve(s); }));
}

function publish(s, version, files, extra = {}) {
  for (const [name, b] of Object.entries(files)) s.files[version + '/' + name] = b;
  const names = Object.keys(files);
  s.manifest = {
    version,
    files: Object.entries(files).map(([name, b]) => ({ name, size: b.length, sha256: sha(b) })),
    model_json: { model: names[0], mmproj: names[1], context: true, revise: true, stream: false, prefill: '' },
    min_app: '0.1.0', notes: '', ...extra
  };
}

const fileRequests = (s, name) => s.requests.filter((q) => q.url.includes('/v1/model/file/') && (!name || q.url.endsWith('/' + name)));

/* ------------------------------------------------------------ the updater */

async function updaterTests() {
  const s = await fakeServer();
  const root = path.join(tmp, 'updater');
  const modelsDir = path.join(root, 'userData', 'models');
  const bundledDir = path.join(root, 'resources', 'models', 'typd-dictate');
  fs.mkdirSync(bundledDir, { recursive: true });
  const oldModel = crypto.randomBytes(300000), oldProj = crypto.randomBytes(200000);
  fs.writeFileSync(path.join(bundledDir, 'old.gguf'), oldModel);
  fs.writeFileSync(path.join(bundledDir, 'old-mmproj.gguf'), oldProj);
  fs.writeFileSync(path.join(bundledDir, 'model.json'), JSON.stringify({ model: 'old.gguf', mmproj: 'old-mmproj.gguf' }));
  const bundledBefore = sha(fs.readFileSync(path.join(bundledDir, 'old.gguf')));

  let busy = false;
  let switches = [];
  let failSwitchTo = null;
  const make = (over = {}) => createUpdater({
    config: { endpoint: s.endpoint, key: s.key }, modelsDir, bundledDir, appVersion: '0.1.0',
    busy: () => busy,
    switchModel: async () => {
      const a = activeModel(modelsDir);
      const v = a ? a.version : 'bundled';
      switches.push(v);
      if (failSwitchTo && v === failSwitchTo) throw new Error('the model failed its self-test');
    },
    rate: 0, idleMs: 100, ...over
  });
  const current = () => { try { return readJson(path.join(modelsDir, 'current.json')); } catch { return null; } };

  section('an ordinary build (no key) never contacts the server');
  {
    s.requests = [];
    const u = createUpdater({ config: null, modelsDir, bundledDir, fetch: () => { throw new Error('network used'); } });
    const r = await u.check();
    u.start();
    await sleep(50);
    check('check() does nothing, start() schedules nothing, no tray line', r.state === 'off' && s.requests.length === 0 && u.line() === null);
  }

  section('nothing published, then a new model: download, verify, wait for idle, switch');
  {
    const u = make();
    let r = await u.check();
    check('404 manifest -> nothing to do', r.state === 'none' && r.next === 6 * 3600e3, r);
    const big = crypto.randomBytes(3 * 1024 * 1024 + 17), proj = crypto.randomBytes(1024 * 1024);
    publish(s, 'v2', { 'typd-v2.gguf': big, 'mmproj-a.gguf': proj });
    busy = true;
    setTimeout(() => { busy = false; }, 400);
    const t0 = Date.now();
    switches = [];
    r = await u.check();
    check('downloaded, verified and switched -> up to date', r.state === 'current' && u.line() === 'Model v2 · up to date', { r, line: u.line() });
    check('the switch waited for the session to end (and a quiet 100 ms)', Date.now() - t0 >= 450 && switches.join() === 'v2', { ms: Date.now() - t0, switches });
    const c = current();
    check('current.json names v2, confirmed after the good start', c.version === 'v2' && c.confirmed === true && c.previous === null, c);
    const dir = path.join(modelsDir, 'v2');
    check('the files are there, byte for byte', sha(fs.readFileSync(path.join(dir, 'typd-v2.gguf'))) === sha(big) && sha(fs.readFileSync(path.join(dir, 'mmproj-a.gguf'))) === sha(proj));
    const mj = fs.readFileSync(path.join(dir, 'model.json'), 'utf8');
    check('model.json written from the manifest, LF line endings', !mj.includes('\r') && JSON.parse(mj).model === 'typd-v2.gguf' && mj.endsWith('}\n'));
    check('no .partial folder left', !fs.existsSync(path.join(modelsDir, 'v2.partial')));
    check('local.js would now load it', local.resolveModel({ env: {}, modelsDir, bundled: bundledDir }).dir === dir);
    s.requests = [];
    r = await u.check();
    check('checked again: up to date, nothing downloaded', r.state === 'current' && fileRequests(s).length === 0);
  }

  section('a cut connection resumes with Range; a file already here is copied, not downloaded');
  {
    const u = make();
    const big = crypto.randomBytes(2 * 1024 * 1024 + 3);
    publish(s, 'v3', { 'typd-v3.gguf': big, 'mmproj-a.gguf': s.files['v2/mmproj-a.gguf'] });
    s.cutNext['typd-v3.gguf'] = 700000;
    s.requests = [];
    switches = [];
    let r = await u.check();
    const partial = path.join(modelsDir, 'v3.partial', 'typd-v3.gguf');
    check('the cut leaves a partial file and a retry, still on v2', r.state === 'retry' && fs.existsSync(partial) && current().version === 'v2' && switches.length === 0, { r, cur: current() });
    const have = fs.statSync(partial).size;
    check('the progress line says so', /^Model v2 · updating \d+ %/.test(u.line()), u.line());
    r = await u.check();
    const last = fileRequests(s, 'typd-v3.gguf').pop();
    check('the retry asks for the rest only: Range: bytes=<have>-', last.range === `bytes=${have}-` && have > 0, { last, have });
    check('then verifies and switches', r.state === 'current' && current().version === 'v3' && switches.join() === 'v3', r);
    check('the mmproj was copied from v2 (same sha256), never requested', fileRequests(s, 'mmproj-a.gguf').length === 0);
    check('v2 deleted after the good start; the bundled model untouched',
      !fs.existsSync(path.join(modelsDir, 'v2')) && sha(fs.readFileSync(path.join(bundledDir, 'old.gguf'))) === bundledBefore);
  }

  section('a server that ignores Range, and bytes that fail verification');
  {
    const u = make();
    const big = crypto.randomBytes(1024 * 1024 + 9);
    publish(s, 'v4', { 'typd-v4.gguf': big, 'mmproj-a.gguf': s.files['v3/mmproj-a.gguf'] });
    s.cutNext['typd-v4.gguf'] = 300000;
    let r = await u.check();
    s.ignoreRange = true;
    s.corrupt['typd-v4.gguf'] = true;
    r = await u.check();
    check('a resume answered 200 is written from the start; a wrong sha256 is caught and deleted',
      r.state === 'retry' && /failed verification/.test(r.why) && !fs.existsSync(path.join(modelsDir, 'v4.partial', 'typd-v4.gguf')) && current().version === 'v3', r);
    s.ignoreRange = false;
    delete s.corrupt['typd-v4.gguf'];
    r = await u.check();
    check('the next try downloads it again and switches', r.state === 'current' && current().version === 'v4', r);
  }

  section('a model that fails to start is reverted and not retried until the manifest changes');
  {
    const u = make();
    publish(s, 'v5', { 'typd-v5.gguf': crypto.randomBytes(500000), 'mmproj-a.gguf': s.files['v4/mmproj-a.gguf'] });
    failSwitchTo = 'v5';
    switches = [];
    let r = await u.check();
    check('the switch to v5 failed: back on v4', r.state === 'failed' && current().version === 'v4' && switches.join() === 'v5,v4', { r, switches, cur: current() });
    check('v5 is deleted and remembered as bad', !fs.existsSync(path.join(modelsDir, 'v5')) && readJson(path.join(modelsDir, 'state.json')).bad.version === 'v5');
    check('the tray says so', u.line() === 'Model v4 · update failed', u.line());
    s.requests = [];
    r = await u.check();
    check('the same manifest again: nothing downloaded, nothing switched', r.state === 'failed' && fileRequests(s).length === 0 && switches.length === 2);
    failSwitchTo = null;
    s.manifest = { ...s.manifest, notes: 'fixed the server flags' };
    r = await u.check();
    check('a changed manifest is tried again', r.state === 'current' && current().version === 'v5' && !readJson(path.join(modelsDir, 'state.json')).bad, r);
  }

  section('a switch the app did not live through is judged at the next launch');
  {
    const u = make();
    // The app wrote current.json for v6 and quit before the warm start.
    versionDir(modelsDir, 'v6', { 'typd-v6.gguf': Buffer.from('six'), 'mmproj-a.gguf': Buffer.from('mm') }, { model: 'typd-v6.gguf', mmproj: 'mmproj-a.gguf' });
    fs.writeFileSync(path.join(modelsDir, 'current.json'), JSON.stringify({ version: 'v6', previous: 'v5', confirmed: false, manifest: 'abc' }));
    switches = [];
    u.warmed({ ok: false, version: 'v6', error: new Error('The dictation model failed its self-test') });
    await sleep(300);
    check('it fails to start: back to v5, v6 deleted, v6 remembered as bad', current().version === 'v5' && !fs.existsSync(path.join(modelsDir, 'v6')) &&
      readJson(path.join(modelsDir, 'state.json')).bad.version === 'v6' && switches.join() === 'v5', { cur: current(), switches });
    versionDir(modelsDir, 'v7', { 'typd-v7.gguf': Buffer.from('seven'), 'mmproj-a.gguf': Buffer.from('mm') }, { model: 'typd-v7.gguf', mmproj: 'mmproj-a.gguf' });
    fs.writeFileSync(path.join(modelsDir, 'current.json'), JSON.stringify({ version: 'v7', previous: 'v5', confirmed: false, manifest: 'def' }));
    u.warmed({ ok: true, version: 'v7' });
    await sleep(300);
    check('it starts: confirmed, the previous version deleted', current().confirmed === true && !fs.existsSync(path.join(modelsDir, 'v5')), current());
    u.warmed({ ok: false, version: 'v7' });
    await sleep(200);
    check('a confirmed model that fails later is left alone (Try again is the user\'s)', current().version === 'v7');
  }

  section('limits: disk space, 429, 401, min_app');
  {
    publish(s, 'v8', { 'typd-v8.gguf': crypto.randomBytes(400000), 'mmproj-b.gguf': crypto.randomBytes(100000) });
    s.requests = [];
    let u = make({ statfs: async () => ({ bavail: 100, bsize: 4096 }) });
    let r = await u.check();
    check('not enough disk: skipped until the next check, nothing downloaded', r.state === 'space' && r.next === 6 * 3600e3 && fileRequests(s).length === 0 && u.line() === 'Model v7 · update needs more disk space', { r, line: u.line() });
    u = make();
    s.manifestStatus = 429;
    r = await u.check();
    check('manifest 429 Retry-After: 120 -> next try in 120 s', r.state === 'retry' && r.next === 120e3, r);
    s.manifestStatus = 200;
    s.fileStatus = { status: 429, retryAfter: 7200 };
    r = await u.check();
    check('file 429 Retry-After: 7200 -> next try in 2 hours, not sooner', r.state === 'retry' && r.next === 7200e3, r);
    s.fileStatus = { status: 429 };
    r = await u.check();
    check('file 429 without Retry-After -> the next 6-hour check', r.state === 'retry' && r.next === 6 * 3600e3, r);
    s.fileStatus = null;
    s.manifest = { ...s.manifest, min_app: '9.0.0' };
    r = await u.check();
    check('a model for a newer app: not downloaded', r.state === 'app' && current().version === 'v7', r);
    s.manifest = { ...s.manifest, min_app: '0.1.0' };
    const saved = s.key;
    s.key = 'tk_some_other_key_00000';
    r = await u.check();
    check('401: updates stop until restart (no next check)', r.state === 'stopped' && r.next === null, r);
    s.key = saved;
  }

  section('the bundled model is the published one: nothing to download');
  {
    fs.rmSync(modelsDir, { recursive: true, force: true });
    s.manifest = {
      version: 'r-old', min_app: '0.1.0', notes: '',
      files: [{ name: 'old.gguf', size: oldModel.length, sha256: sha(oldModel) }, { name: 'old-mmproj.gguf', size: oldProj.length, sha256: sha(oldProj) }],
      model_json: { model: 'old.gguf', mmproj: 'old-mmproj.gguf' }
    };
    s.requests = [];
    switches = [];
    const u = make();
    const r = await u.check();
    check('hashes the bundled files once, finds them equal: up to date, no download, no switch',
      r.state === 'current' && fileRequests(s).length === 0 && switches.length === 0 && u.line() === 'Model r-old · up to date', { r, line: u.line() });
    check('and caches those hashes (state.json)', Object.keys(readJson(path.join(modelsDir, 'state.json')).hashes || {}).length === 2);
  }

  section('one check at a time; the download is held to its rate');
  {
    fs.rmSync(modelsDir, { recursive: true, force: true });
    publish(s, 'v9', { 'typd-v9.gguf': crypto.randomBytes(1024 * 1024), 'mmproj-c.gguf': crypto.randomBytes(1024 * 1024) });
    const u = make({ rate: 4 * 1024 * 1024 });
    const t0 = Date.now();
    const a = u.check(), b = u.check();
    check('two calls share one run', a === b);
    const r = await a;
    const ms = Date.now() - t0;
    check('2 MiB at 4 MiB/s takes about half a second, not less', r.state === 'current' && ms >= 400, { ms, r });
  }

  s.server.close();
}

function finish() {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a file still held open: the OS cleans its temp folder */ }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}
