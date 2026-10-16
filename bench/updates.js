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
 *     disk space, 429 Retry-After, 401, min_app, and a source run with no key making no request
 *   - which routes a build follows (findConfig): a reader key, a tester key, and a packaged build
 *     with neither -> the public routes with no key; a source run with neither -> off
 *   - a packaged build with no key against the fake's public routes: the same download, resume,
 *     verify, adapter, switch, revert and 429 handling, never an Authorization header, and only
 *     the live version's files reachable
 *   - signed manifests (0.2.2): the fake signs every manifest it serves with a throwaway key the
 *     updaters here trust, as typd-collect serves publish_model.py's signature; unsigned, a bad
 *     signature, an unknown key, another key under a known id, no seq, and an older seq replayed are
 *     all refused with nothing downloaded; an updater with the built-in key refuses the test key
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

const { createUpdater, activeModel, checkManifest, checkSignature, older, labelOf, findConfig, ENDPOINT, SIG_PREFIX } = require('../src/main/modelUpdate');
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

  // A version with a revise adapter (model.json "revise_lora"): one more file, held to the same rules.
  const lspec = { model: 'm.gguf', mmproj: 'p.gguf', revise: true, revise_lora: 'rev-lora.gguf' };
  const files = { 'm.gguf': Buffer.from('model'), 'p.gguf': Buffer.from('proj'), 'rev-lora.gguf': Buffer.from('adapter') };
  const v3 = versionDir(models, 'v3', files, lspec);
  fs.writeFileSync(path.join(models, 'current.json'), JSON.stringify({ version: 'v3', confirmed: true }));
  check('adapter: a complete version with its adapter -> that folder', r().dir === v3 && r().version === 'v3');
  check('adapter: local.js resolves it beside the weights', local.reviseLora(v3, lspec) === path.join(v3, 'rev-lora.gguf'));
  fs.writeFileSync(path.join(v3, 'rev-lora.gguf'), 'adapter, cut sh');
  check('adapter: of the wrong size -> the bundled model', r().dir === bundled);
  fs.rmSync(path.join(v3, 'rev-lora.gguf'));
  check('adapter: missing from the folder -> the bundled model', r().dir === bundled);
  const v4 = versionDir(models, 'v4', { 'm.gguf': files['m.gguf'], 'p.gguf': files['p.gguf'] }, lspec);
  fs.writeFileSync(path.join(models, 'current.json'), JSON.stringify({ version: 'v4', confirmed: true }));
  check('adapter: model.json naming an adapter the manifest does not list -> the bundled model', r().dir === bundled && fs.existsSync(v4));
  check('no adapter: model.json without revise_lora -> none', local.reviseLora(v1, spec) === null && local.reviseLora(v1, { ...spec, revise: true }) === null);
  check('no adapter: a model without revise ignores revise_lora', local.reviseLora(v3, { ...lspec, revise: false }) === null);
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
  const lora = { ...good, files: [...good.files, { name: 'c.gguf', size: 3, sha256: 'c'.repeat(64) }], model_json: { ...good.model_json, revise: true, revise_lora: 'c.gguf' } };
  check('adapter: a third file named by model_json.revise_lora', checkManifest(lora) === null);
  check('adapter: revise_lora naming a file not listed is refused', checkManifest({ ...lora, files: good.files }) !== null);
  check('adapter: revise_lora naming the model itself is refused', checkManifest({ ...lora, model_json: { ...lora.model_json, revise_lora: 'a.gguf' } }) !== null);
  check('adapter: revise_lora that is not a file name is refused', checkManifest({ ...lora, model_json: { ...lora.model_json, revise_lora: 7 } }) !== null);
  check('no adapter: revise_lora null is the same as none', checkManifest({ ...good, model_json: { ...good.model_json, revise_lora: null } }) === null);
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

// Manifests are signed (modelUpdate.js checkSignature). A throwaway key that the updaters here trust
// (keys: TEST_KEYS); OTHER_KP is a key nobody trusts.
const TEST_KP = crypto.generateKeyPairSync('ed25519');
const OTHER_KP = crypto.generateKeyPairSync('ed25519');
const TEST_KID = 'typd-model-bench';
const TEST_KEYS = { [TEST_KID]: TEST_KP.publicKey.export({ type: 'spki', format: 'pem' }) };
let SEQ = Math.floor(Date.now() / 1000);

/**
 * The manifest as typd-collect serves a published one: its exact text, with a seq that goes up
 * whenever the content changes (publish_model.py), and the signature headers. `how`: ok, none, bad
 * (signs other text), unknown (an id nobody trusts), otherkey (a trusted id, another key).
 */
function served(s) {
  const base = JSON.stringify(s.manifest);
  if (base !== s.lastBase) { s.lastBase = base; s.seq = ++SEQ; }
  const full = s.manifest.seq !== undefined || s.noSeq ? { ...s.manifest } : { ...s.manifest, seq: s.seq };
  if (s.noSeq) delete full.seq;
  const text = JSON.stringify(full, null, 2) + '\n';
  const headers = { 'Content-Type': 'application/json' };
  if (s.sign !== 'none') {
    const signer = s.sign === 'otherkey' ? OTHER_KP.privateKey : TEST_KP.privateKey;
    headers['X-Typd-Manifest-Key'] = s.sign === 'unknown' ? 'typd-model-nobody' : TEST_KID;
    headers['X-Typd-Manifest-Sig'] = crypto.sign(null, Buffer.from(SIG_PREFIX + (s.sign === 'bad' ? text + ' ' : text)), signer).toString('base64');
  }
  return { text, headers };
}

function fakeServer() {
  const s = {
    key: 'tk_test_0123456789abcdef',
    manifest: null,        // object, or null for 404
    sign: 'ok',            // served(): ok | none | bad | unknown | otherkey
    noSeq: false,
    manifestStatus: 200,
    files: {},             // "<version>/<name>" -> Buffer
    cutNext: {},           // name -> bytes after which the next response for it is cut off
    ignoreRange: false,
    corrupt: {},           // name -> true: serve a flipped byte
    fileStatus: null,      // {status, retryAfter}: every file request answers this
    requests: []
  };
  s.server = http.createServer((req, res) => {
    s.requests.push({ url: req.url, range: req.headers.range || null, auth: req.headers.authorization || null, install: req.headers['x-typd-install'] || null });
    // /v1/model/public/*: no key, as typd-collect's public routes (src/publicmodel.js): the same
    // manifest, and only the files the live manifest names.
    const pub = req.url.startsWith('/v1/model/public/');
    if (!pub && req.headers.authorization !== 'Bearer ' + s.key) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
    if (req.url === '/v1/model/manifest' || req.url === '/v1/model/public/manifest') {
      if (s.manifestStatus !== 200) { res.writeHead(s.manifestStatus, s.manifestStatus === 429 ? { 'Retry-After': '120' } : {}); return res.end('{}'); }
      if (!s.manifest) { res.writeHead(404); return res.end('{"error":"no model published"}'); }
      const { text, headers } = served(s);
      res.writeHead(200, headers);
      return res.end(text);
    }
    const m = /^\/v1\/model\/(?:public\/)?file\/([^/]+)\/([^/]+)$/.exec(req.url);
    if (!m) { res.writeHead(404); return res.end(); }
    if (pub && !(s.manifest && s.manifest.version === decodeURIComponent(m[1]) && s.manifest.files.some((f) => f.name === decodeURIComponent(m[2])))) {
      res.writeHead(404); return res.end('{"error":"not a file of the live model"}');
    }
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

const fileRequests = (s, name) => s.requests.filter((q) => /\/v1\/model\/(public\/)?file\//.test(q.url) && (!name || q.url.endsWith('/' + name)));

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
  const make = (over = {}) => createUpdater({ keys: TEST_KEYS,
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

  section('signed manifests: anything but a good signature by a trusted key is refused, nothing downloaded');
  {
    const sdir = path.join(root, 'sig', 'models');
    const su = (over = {}) => createUpdater({ keys: TEST_KEYS, config: { endpoint: s.endpoint, key: s.key }, modelsDir: sdir, bundledDir, appVersion: '0.2.2', switchModel: async () => {}, rate: 0, idleMs: 0, ...over });
    publish(s, 'vs1', { 'typd-vs1.gguf': crypto.randomBytes(5000), 'mmproj-s.gguf': crypto.randomBytes(3000) });
    for (const [how, what] of [['none', 'unsigned'], ['bad', 'a signature over other text'], ['unknown', 'a key id nobody trusts'], ['otherkey', 'a trusted key id, signed by another key']]) {
      s.sign = how;
      s.requests = [];
      const r = await su().check();
      check(`${what} -> refused, no file requested, nothing written`, r.state === 'refused' && fileRequests(s).length === 0 && !fs.existsSync(path.join(sdir, 'vs1.partial')) && !fs.existsSync(path.join(sdir, 'current.json')), r);
    }
    s.sign = 'ok';
    s.noSeq = true;
    let r = await su().check();
    check('signed, but no seq -> refused', r.state === 'none' && fileRequests(s).length === 0, r);
    s.noSeq = false;
    r = await su({ keys: undefined }).check();
    check("an updater with the built-in key (modelManifestKey.js) refuses the test key's manifest", r.state === 'refused', r);
    r = await su().check();
    const seen = readJson(path.join(sdir, 'state.json')).seq;
    check('a good signature -> downloaded and switched; state.json keeps its seq', r.state === 'current' && readJson(path.join(sdir, 'current.json')).version === 'vs1' && Number.isSafeInteger(seen), r);
    // An older manifest replayed: validly signed, seq below the one seen.
    s.manifest = { ...s.manifest, notes: 'replayed', seq: seen - 1 };
    s.requests = [];
    r = await su().check();
    check('an older seq replayed (validly signed) -> refused, nothing downloaded, seq kept', r.state === 'refused' && fileRequests(s).length === 0 && readJson(path.join(sdir, 'state.json')).seq === seen, r);
    delete s.manifest.seq;
    s.manifest = { ...s.manifest, notes: 'newer' };
    r = await su().check();
    check('a newer seq is followed again', r.state === 'current' && readJson(path.join(sdir, 'state.json')).seq > seen, r);
    const text = '{"version":"x"}\n';
    const good = crypto.sign(null, Buffer.from(SIG_PREFIX + text), TEST_KP.privateKey).toString('base64');
    check('checkSignature: good -> null; a trailing byte, a short or padded signature, no key id -> refused',
      checkSignature(text, TEST_KID, good, TEST_KEYS) === null && checkSignature(text + ' ', TEST_KID, good, TEST_KEYS) === 'bad signature' &&
      checkSignature(text, TEST_KID, good.slice(0, 40), TEST_KEYS) === 'bad signature' && checkSignature(text, TEST_KID, good + '==', TEST_KEYS) === 'bad signature' &&
      checkSignature(text, null, good, TEST_KEYS) === 'unsigned' && checkSignature(text, '../x', good, TEST_KEYS) === 'signed by an unknown key');
    const builtin = require('../src/main/modelManifestKey').keys;
    check('the built-in model key parses as an Ed25519 public key', Object.keys(builtin).length >= 1 && Object.values(builtin).every((pem) => crypto.createPublicKey(pem).asymmetricKeyType === 'ed25519'));
    check('the model key is not the app-update key', Object.values(builtin).every((pem) => !Object.values(require('../src/main/appUpdateKey').keys).includes(pem)));
    s.manifest = null;
    s.lastBase = undefined;
  }

  section('a run from source with no key (config null) never contacts the server');
  {
    s.requests = [];
    const u = createUpdater({ keys: TEST_KEYS, config: null, modelsDir, bundledDir, fetch: () => { throw new Error('network used'); } });
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

  await adapterTests(s, make, modelsDir, bundledDir, current, () => switches, (v) => { switches = v; });
  await publicTests(s);

  s.server.close();
}

/* --------------------------------------------- a version with a revise adapter */

/** Publish `files` (model, mmproj, adapter, in that order) with model_json naming the adapter. */
function publishLora(s, version, files, extra = {}) {
  publish(s, version, files, extra);
  const names = Object.keys(files);
  s.manifest.model_json = { ...s.manifest.model_json, revise_lora: names[2] };
}

async function adapterTests(s, make, modelsDir, bundledDir, current, switches, setSwitches) {
  section('a version with a revise adapter: downloaded, verified and kept like the weights');
  const lora = crypto.randomBytes(700000);
  const files = (v) => ({ ['typd-' + v + '.gguf']: crypto.randomBytes(600000), 'mmproj-c.gguf': s.files['v9/mmproj-c.gguf'], 'rev-a.gguf': lora });
  {
    const u = make();
    const before = current().version;
    publishLora(s, 'v10', files('v10'));
    s.corrupt['rev-a.gguf'] = true;
    setSwitches([]);
    let r = await u.check();
    check('corrupt adapter: caught by sha256, deleted, still on the old model, nothing switched',
      r.state === 'retry' && /rev-a\.gguf failed verification/.test(r.why) && !fs.existsSync(path.join(modelsDir, 'v10.partial', 'rev-a.gguf')) &&
      current().version === before && switches().length === 0, { r, cur: current() });
    delete s.corrupt['rev-a.gguf'];
    delete s.files['v10/rev-a.gguf'];
    s.requests = [];
    r = await u.check();
    check('adapter missing on the server: the download fails and is retried later, nothing switched',
      r.state === 'retry' && /rev-a\.gguf: HTTP 404/.test(r.why) && current().version === before && switches().length === 0, r);
    s.files['v10/rev-a.gguf'] = lora;
    r = await u.check();
    const dir = path.join(modelsDir, 'v10');
    const spec = readJson(path.join(dir, 'model.json'));
    check('then downloaded, verified and switched', r.state === 'current' && current().version === 'v10' && switches().join() === 'v10', r);
    check('the adapter is kept with the version, byte for byte', sha(fs.readFileSync(path.join(dir, 'rev-a.gguf'))) === sha(lora) &&
      readJson(path.join(dir, 'manifest.json')).files.length === 3);
    check('model.json names it, and local.js would load it', spec.revise_lora === 'rev-a.gguf' &&
      local.resolveModel({ env: {}, modelsDir, bundled: bundledDir }).dir === dir && local.reviseLora(dir, spec) === path.join(dir, 'rev-a.gguf'));
  }
  {
    const u = make();
    publishLora(s, 'v11', files('v11'));
    s.requests = [];
    const r = await u.check();
    check('the same adapter in the next version: copied from this one (same sha256), never requested',
      r.state === 'current' && current().version === 'v11' && fileRequests(s, 'rev-a.gguf').length === 0 && fileRequests(s, 'typd-v11.gguf').length === 1, r);
  }
  {
    const u = make();
    publish(s, 'v12', { 'typd-v12.gguf': crypto.randomBytes(500000), 'mmproj-c.gguf': s.files['v9/mmproj-c.gguf'] });
    const r = await u.check();
    const dir = path.join(modelsDir, 'v12');
    const spec = readJson(path.join(dir, 'model.json'));
    check('a version without an adapter: two files, no revise_lora, local.js loads none',
      r.state === 'current' && current().version === 'v12' && fs.readdirSync(dir).sort().join() === 'manifest.json,mmproj-c.gguf,model.json,typd-v12.gguf' &&
      !('revise_lora' in spec) && local.reviseLora(dir, spec) === null, { r, files: fs.readdirSync(dir) });
  }
  {
    // The bundled weights, now with an adapter the bundled model.json does not name: not "the
    // bundled model" -- running it would leave the adapter off. Every file is on disk already.
    const oldModel = fs.readFileSync(path.join(bundledDir, 'old.gguf')), oldProj = fs.readFileSync(path.join(bundledDir, 'old-mmproj.gguf'));
    fs.writeFileSync(path.join(bundledDir, 'rev-a.gguf'), lora);
    s.manifest = {
      version: 'r-old-lora', min_app: '0.1.0', notes: '',
      files: [{ name: 'old.gguf', size: oldModel.length, sha256: sha(oldModel) }, { name: 'old-mmproj.gguf', size: oldProj.length, sha256: sha(oldProj) },
        { name: 'rev-a.gguf', size: lora.length, sha256: sha(lora) }],
      model_json: { model: 'old.gguf', mmproj: 'old-mmproj.gguf', revise: true, revise_lora: 'rev-a.gguf' }
    };
    s.requests = [];
    setSwitches([]);
    const u = make();
    const r = await u.check();
    check('bundled weights + an adapter the bundled model.json lacks: installed as a version from local copies, no download',
      r.state === 'current' && current().version === 'r-old-lora' && fileRequests(s).length === 0 && switches().join() === 'r-old-lora' &&
      readJson(path.join(modelsDir, 'r-old-lora', 'model.json')).revise_lora === 'rev-a.gguf', { r, cur: current(), n: fileRequests(s).length });
    fs.rmSync(path.join(bundledDir, 'rev-a.gguf'));
  }
}

/* ------------------------------------------- a packaged build with no key */

function configTests() {
  section('which routes a build follows (findConfig)');
  const root = path.join(tmp, 'config');
  const userData = path.join(root, 'userData'), resources = path.join(root, 'resources'), repo = path.join(root, 'repo');
  for (const d of [userData, resources, repo]) fs.mkdirSync(d, { recursive: true });
  const reader = { reader: 'mehmet', endpoint: 'https://collect.example', key: 'rk_reader_0123456789abcdef' };
  const tester = { tester: 'tester_b', endpoint: 'https://collect.example', key: 'tk_tester_0123456789abcdef' };
  const find = (o) => findConfig({ userData, resourcesPath: resources, repoDir: repo, env: {}, ...o });
  let c = find({ packaged: true });
  check('a packaged build with no key file -> the public routes: the real endpoint, no key',
    c && c.endpoint === ENDPOINT && ENDPOINT === 'https://typd-collect.mehmetdedeler.com' && c.key === null, c);
  check('a source run with no key file -> off (null), as before', find({ packaged: false }) === null);
  fs.writeFileSync(path.join(resources, 'tester.json'), JSON.stringify({ ...tester, key: '' }));
  c = find({ packaged: true });
  check('a packaged build whose tester.json has no key (a template) -> the public routes', c && c.key === null, c);
  fs.writeFileSync(path.join(resources, 'tester.json'), JSON.stringify(tester));
  c = find({ packaged: true });
  check('a tester build -> its key, the keyed routes', c && c.key === tester.key && c.endpoint === tester.endpoint, c);
  fs.writeFileSync(path.join(userData, 'model-updates.json'), JSON.stringify(reader));
  c = find({ packaged: true });
  check('a reader key in userData wins over the tester key', c && c.key === reader.key, c);
  c = find({ packaged: false });
  check('a source run with a reader key (the developer\'s checkout) -> that key, as before', c && c.key === reader.key, c);
  fs.rmSync(path.join(userData, 'model-updates.json'));
  fs.writeFileSync(path.join(repo, 'tester.json'), JSON.stringify(tester));
  check('a source run with the repo\'s tester.json -> off without TYPD_TESTER_DEV=1', find({ packaged: false }) === null);
  c = find({ packaged: false, env: { TYPD_TESTER_DEV: '1' } });
  check('... and its key with TYPD_TESTER_DEV=1', c && c.key === tester.key, c);
  fs.writeFileSync(path.join(userData, 'model-updates.json'), JSON.stringify({ ...reader, endpoint: 'http://collect.example' }));
  fs.rmSync(path.join(resources, 'tester.json'));
  c = find({ packaged: true });
  check('a reader file with a plain-http endpoint is refused -> the public routes', c && c.key === null && c.endpoint === ENDPOINT, c);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'modelUpdate.js'), 'utf8');
  check('TYPD_NO_MODEL_UPDATE=1 and TYPD_MODEL_DIR turn it off in start()', /TYPD_NO_MODEL_UPDATE === '1'/.test(src) && /process\.env\.TYPD_MODEL_DIR\) return main/.test(src));
}

async function publicTests(s) {
  configTests();

  section('a packaged build with no key: the public routes');
  const root = path.join(tmp, 'public');
  const modelsDir = path.join(root, 'userData', 'models');
  const bundledDir = path.join(root, 'resources', 'models', 'typd-dictate');
  fs.mkdirSync(bundledDir, { recursive: true });
  const proj = crypto.randomBytes(300000);
  fs.writeFileSync(path.join(bundledDir, 'bundled.gguf'), crypto.randomBytes(200000));
  fs.writeFileSync(path.join(bundledDir, 'mmproj-p.gguf'), proj);
  fs.writeFileSync(path.join(bundledDir, 'model.json'), JSON.stringify({ model: 'bundled.gguf', mmproj: 'mmproj-p.gguf' }));
  let switches = [], failSwitchTo = null;
  const make = (over = {}) => createUpdater({ keys: TEST_KEYS,
    config: { endpoint: s.endpoint, key: null }, modelsDir, bundledDir, appVersion: '0.2.0',
    switchModel: async () => {
      const a = activeModel(modelsDir);
      const v = a ? a.version : 'bundled';
      switches.push(v);
      if (failSwitchTo && v === failSwitchTo) throw new Error('the model failed its self-test');
    },
    rate: 0, idleMs: 50, ...over
  });
  const current = () => { try { return readJson(path.join(modelsDir, 'current.json')); } catch { return null; } };
  const onlyPublic = () => s.requests.every((q) => q.url.startsWith('/v1/model/public/') && q.auth === null);

  s.manifest = null;
  s.requests = [];
  let u = make();
  let r = await u.check();
  check('nothing published: the public manifest\'s 404 -> nothing to do', r.state === 'none' && s.requests.length === 1 && s.requests[0].url === '/v1/model/public/manifest', { r, req: s.requests });

  const lora = crypto.randomBytes(400000), big = crypto.randomBytes(2 * 1024 * 1024 + 11);
  publish(s, 'p1', { 'typd-p1.gguf': big, 'mmproj-p.gguf': proj, 'rev-p.gguf': lora });
  s.manifest.model_json.revise_lora = 'rev-p.gguf';
  s.files['p0/typd-p0.gguf'] = crypto.randomBytes(1000);   // stored on the server, not live
  s.cutNext['typd-p1.gguf'] = 600000;
  s.requests = [];
  switches = [];
  r = await u.check();
  check('a cut connection: a partial file and a retry, still on the bundled model', r.state === 'retry' && fs.existsSync(path.join(modelsDir, 'p1.partial', 'typd-p1.gguf')) && !current() && switches.length === 0, r);
  const have = fs.statSync(path.join(modelsDir, 'p1.partial', 'typd-p1.gguf')).size;
  r = await u.check();
  const last = fileRequests(s, 'typd-p1.gguf').pop();
  check('the retry resumes with Range: bytes=<have>- from the public file route', last.range === `bytes=${have}-` && last.url === '/v1/model/public/file/p1/typd-p1.gguf' && have > 0, { last, have });
  const dir = path.join(modelsDir, 'p1');
  check('verified (model and adapter), switched once, up to date', r.state === 'current' && current().version === 'p1' && current().confirmed === true && switches.join() === 'p1' &&
    sha(fs.readFileSync(path.join(dir, 'typd-p1.gguf'))) === sha(big) && sha(fs.readFileSync(path.join(dir, 'rev-p.gguf'))) === sha(lora) && u.line() === 'Model p1 · up to date', { r, line: u.line() });
  check('local.js would load it, with its adapter', local.resolveModel({ env: {}, modelsDir, bundled: bundledDir }).dir === dir && local.reviseLora(dir, readJson(path.join(dir, 'model.json'))) === path.join(dir, 'rev-p.gguf'));
  check('the mmproj already in the app was copied, never requested', fileRequests(s, 'mmproj-p.gguf').length === 0);
  check('every request went to /v1/model/public/, with no Authorization header', onlyPublic() && s.requests.length >= 4, s.requests);

  section('no key: revert, bad-version memory, 429, and only the live version');
  publish(s, 'p2', { 'typd-p2.gguf': crypto.randomBytes(300000), 'mmproj-p.gguf': proj });
  failSwitchTo = 'p2';
  switches = [];
  r = await u.check();
  check('a model that fails to start: back on p1, p2 deleted and remembered as bad', r.state === 'failed' && current().version === 'p1' && switches.join() === 'p2,p1' &&
    !fs.existsSync(path.join(modelsDir, 'p2')) && readJson(path.join(modelsDir, 'state.json')).bad.version === 'p2', { r, switches });
  s.requests = [];
  r = await u.check();
  check('the same manifest again: no download', r.state === 'failed' && fileRequests(s).length === 0);
  failSwitchTo = null;
  s.manifestStatus = 429;
  r = await u.check();
  check('the public manifest\'s 429 Retry-After: 120 -> next try in 120 s', r.state === 'retry' && r.next === 120e3, r);
  s.manifestStatus = 200;
  s.manifest = { ...s.manifest, notes: 'p2, fixed' };
  s.fileStatus = { status: 429, retryAfter: 5400 };
  r = await u.check();
  check('a public file\'s 429 Retry-After: 5400 -> next try in 90 minutes, not sooner', r.state === 'retry' && r.next === 5400e3, r);
  s.fileStatus = null;
  r = await u.check();
  check('then p2 downloads and switches', r.state === 'current' && current().version === 'p2', r);
  const notLive = await new Promise((resolve) => http.get(s.endpoint + '/v1/model/public/file/p0/typd-p0.gguf', (res) => { res.resume(); resolve(res.statusCode); }));
  const keyedNoKey = await new Promise((resolve) => http.get(s.endpoint + '/v1/model/file/p2/typd-p2.gguf', (res) => { res.resume(); resolve(res.statusCode); }));
  check('the fake, like the Worker: a stored version that is not live -> 404; the keyed route without a key -> 401', notLive === 404 && keyedNoKey === 401, { notLive, keyedNoKey });
  check('still no request with an Authorization header, none to the keyed routes', s.requests.filter((q) => q.auth !== null || !q.url.startsWith('/v1/model/public/')).length === 1);

  section('no key: the version counts\' headers (versionStats.js) go with the manifest check only');
  publish(s, 'p3', { 'typd-p3.gguf': crypto.randomBytes(200000), 'mmproj-p.gguf': proj });
  s.requests = [];
  u = make({ stats: () => ({ 'X-Typd-App': '0.2.1', 'X-Typd-Model': 'p2', 'X-Typd-OS': 'win32-x64', 'X-Typd-Install': 'a'.repeat(32) }) });
  r = await u.check();
  const manifests = s.requests.filter((q) => q.url === '/v1/model/public/manifest');
  check('the public manifest check carries them; no file download does; still no Authorization header',
    r.state === 'current' && manifests.length === 1 && manifests[0].install === 'a'.repeat(32) && fileRequests(s).length === 1 &&
    fileRequests(s).every((q) => q.install === null) && s.requests.every((q) => q.auth === null), { r, req: s.requests });

  section('with a key, the same server: the keyed routes, as before');
  s.requests = [];
  u = createUpdater({ keys: TEST_KEYS, config: { endpoint: s.endpoint, key: s.key }, modelsDir: path.join(root, 'keyed', 'models'), bundledDir, appVersion: '0.2.0', rate: 0, idleMs: 0 });
  r = await u.check();
  check('the keyed manifest and files, every request with the key, none to /v1/model/public/',
    r.state === 'current' && s.requests.length >= 2 && s.requests.every((q) => !q.url.startsWith('/v1/model/public/') && q.auth === 'Bearer ' + s.key), { r, req: s.requests });
}

function finish() {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a file still held open: the OS cleans its temp folder */ }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}
