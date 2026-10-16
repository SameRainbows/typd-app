'use strict';

/**
 * Version counts and version tags, without Electron, a model or the network (a local fake of
 * typd-collect):
 *
 *   1. the install id: made once in userData, the same across restarts, 32 hex, remade only if the
 *      file is unreadable, none (and nothing sent) if it cannot be kept
 *   2. when the headers go: a packaged build yes; a source run and TYPD_NO_APP_UPDATE=1 never
 *      (no header, no id file); the app's own instance under plain Node: none
 *   3. which model version they name: a downloaded version (current.json), else the bundled one's
 *      model.json "version", the updater's state.json, or a label from the file names (+ adapter)
 *   4. the requests: modelUpdate.js's and appUpdate.js's manifest checks carry the four headers
 *      (after a model update, the new version); file downloads, uploads, flags and enrollment
 *      never carry the install id; the Electron wiring passes versionStats to both updaters
 *   5. shared items: every upload records app version, the exact model version, whether the revise
 *      adapter ran (and which), and the OS; a flag on an item already sent records the versions of
 *      that moment; the session's adapter comes from the pipeline's 'done'
 *
 * Everything runs in a throwaway folder; nothing touches %APPDATA%\typd.
 *
 *   node bench/versions.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-versions-'));
// local.js reads TYPD_MODEL_DIR at load: point it at a throwaway model folder first.
const evalDir = path.join(tmp, 'eval-model');
fs.mkdirSync(evalDir, { recursive: true });
fs.writeFileSync(path.join(evalDir, 'model.json'), JSON.stringify({ model: 'typd-dictate-1.7b-r24_1p7b-q4_k_m.gguf', mmproj: 'mmproj.gguf', revise: true }));
process.env.TYPD_MODEL_DIR = evalDir;

const vs = require('../src/main/versionStats');
const { createUpdater, versionOf, activeVersion } = require('../src/main/modelUpdate');
const au = require('../src/main/appUpdate');
const { createCollector } = require('../src/main/collect');
const { createSharing } = require('../src/main/sharing');
const local = require('../src/main/pipeline/local');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
}
const section = (s) => console.log('\n' + s);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await sleep(40); }
  return Boolean(await cond());
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const STATS = ['x-typd-app', 'x-typd-model', 'x-typd-os', 'x-typd-install'];
const hasStats = (h) => STATS.some((k) => k in h);
const fakeApp = (name, isPackaged, version = '0.2.0') => {
  const userData = path.join(tmp, name);
  return { isPackaged, getPath: () => userData, getVersion: () => version, userData };
};

/* ------------------------------------------------------------- a fake typd-collect */

// The model manifest is served signed (modelUpdate.js checkSignature), with a throwaway key the
// updaters here are given.
const MKP = crypto.generateKeyPairSync('ed25519');
const MKEYS = { 'typd-model-bench': MKP.publicKey.export({ type: 'spki', format: 'pem' }) };
function signedManifest(m) {
  const text = JSON.stringify({ seq: 1000, ...m }, null, 2) + '\n';
  return { text, sig: crypto.sign(null, Buffer.from(require('../src/main/modelUpdate').SIG_PREFIX + text), MKP.privateKey).toString('base64') };
}

function fakeServer() {
  const s = { requests: [], manifest: null, files: new Map(), items: new Map(), endpoint: null };
  s.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const r = { method: req.method, path: req.url, headers: req.headers, body };
      s.requests.push(r);
      const send = (status, obj, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)); };
      if (req.url === '/v1/model/manifest') {
        if (!s.manifest) return send(404, { error: 'none' });
        const { text, sig } = signedManifest(s.manifest);
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Typd-Manifest-Key': 'typd-model-bench', 'X-Typd-Manifest-Sig': sig });
        return res.end(text);
      }
      if (req.url.startsWith('/v1/model/file/')) {
        const name = decodeURIComponent(req.url.split('/').pop());
        return s.files.has(name) ? send(200, s.files.get(name), 'application/octet-stream') : send(404, { error: 'none' });
      }
      if (req.url === '/v1/app/manifest') return send(404, { error: 'no app update published' });
      if (req.url === '/v1/enroll') {
        const key = 'ik_' + crypto.randomBytes(32).toString('base64url');
        return send(201, { key, id: 'i-' + sha(key).slice(0, 20) });
      }
      if (req.url === '/v1/upload') {
        const text = body.toString('latin1');
        const m = /name="meta"\r\n\r\n([\s\S]*?)\r\n--/.exec(text);
        const meta = JSON.parse(Buffer.from(m[1], 'latin1').toString('utf8'));
        r.meta = meta;
        s.items.set(meta.id, meta);
        return send(201, { ok: true });
      }
      if (req.url === '/v1/flag') { r.flag = JSON.parse(body.toString()); return send(200, { ok: true }); }
      send(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => { s.endpoint = `http://127.0.0.1:${s.server.address().port}`; resolve(s); }));
}

(async () => {
  /* --------------------------------------------------------------- 1. the id */

  section('the install id');
  {
    const file = path.join(tmp, 'id', vs.ID_FILE);
    check('no file yet: none is read', vs.readInstallId(file) === null);
    const a = vs.installId(file);
    check('made on first use: 32 hex, kept in userData/install-id.json', vs.ID_RE.test(a) && vs.readInstallId(file) === a, a);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('the file holds the id and when it was made, nothing else', Object.keys(j).sort().join(',') === 'created,id' && !Number.isNaN(Date.parse(j.created)), j);
    check('the same id on every call', vs.installId(file) === a && vs.installId(file) === a);
    const s1 = vs.createStats({ on: true, idFile: file, appVersion: '0.2.0' });
    const s2 = vs.createStats({ on: true, idFile: file, appVersion: '0.2.0' });   // a restart
    check('the same id after a restart (a new instance)', s1()['X-Typd-Install'] === a && s2()['X-Typd-Install'] === a);
    fs.writeFileSync(file, '{not json');
    const b = vs.installId(file);
    check('an unreadable file: a new id is made and kept', vs.ID_RE.test(b) && b !== a && vs.readInstallId(file) === b);
    fs.writeFileSync(file, JSON.stringify({ id: 'ik_not-an-id' }));
    check('a file that does not hold an id: a new one', vs.ID_RE.test(vs.installId(file)));
    const blocked = path.join(tmp, 'blocked');
    fs.writeFileSync(blocked, 'a file where the folder should be');
    check('an id that cannot be kept: none, and no headers (a new id every launch would count one install many times)',
      vs.installId(path.join(blocked, vs.ID_FILE)) === null && JSON.stringify(vs.createStats({ on: true, idFile: path.join(blocked, vs.ID_FILE), appVersion: '0.2.0' })()) === '{}');
    const ids = new Set(Array.from({ length: 50 }, (_, i) => vs.installId(path.join(tmp, 'many', String(i), vs.ID_FILE))));
    check('every install makes its own id (50 installs, 50 ids)', ids.size === 50);
  }

  /* ------------------------------------------------------- 2. when they are sent */

  section('when the headers go');
  {
    check('enabled: a packaged build', vs.enabled({ isPackaged: true, env: {} }));
    check('never: a run from source', !vs.enabled({ isPackaged: false, env: {} }));
    check('never: TYPD_NO_APP_UPDATE=1', !vs.enabled({ isPackaged: true, env: { TYPD_NO_APP_UPDATE: '1' } }));
    check('TYPD_NO_APP_UPDATE=0 does not turn them off', vs.enabled({ isPackaged: true, env: { TYPD_NO_APP_UPDATE: '0' } }));
    const src = fakeApp('source-run', false);
    const h0 = vs.fromApp(src, { env: {}, modelVersion: () => 'r24_1p7b' })();
    check('a source run: no headers, and no id file made', JSON.stringify(h0) === '{}' && !fs.existsSync(path.join(src.userData, vs.ID_FILE)));
    const off = fakeApp('no-app-update', true);
    const h1 = vs.fromApp(off, { env: { TYPD_NO_APP_UPDATE: '1' }, modelVersion: () => 'r24_1p7b' })();
    check('TYPD_NO_APP_UPDATE=1: no headers, and no id file made', JSON.stringify(h1) === '{}' && !fs.existsSync(path.join(off.userData, vs.ID_FILE)));
    const pk = fakeApp('packaged', true);
    const h2 = vs.fromApp(pk, { env: {}, modelVersion: () => 'r24_1p7b_rev128' })();
    check('a packaged build: app version, model version, OS-arch and the install id',
      h2['X-Typd-App'] === '0.2.0' && h2['X-Typd-Model'] === 'r24_1p7b_rev128' && h2['X-Typd-OS'] === `${process.platform}-${process.arch}` &&
      h2['X-Typd-Install'] === vs.readInstallId(path.join(pk.userData, vs.ID_FILE)), h2);
    check('exactly those four headers', Object.keys(h2).sort().join(',') === 'X-Typd-App,X-Typd-Install,X-Typd-Model,X-Typd-OS', Object.keys(h2));
    check('a model version the server would refuse is sent as a clean one', vs.cleanModel('r24 1p7b/../x') === 'r24_1p7b_.._x' && vs.cleanModel('') === 'unknown' && vs.cleanModel(null) === 'unknown' && vs.cleanModel('a'.repeat(80)).length === 64);
    check('an app version that is not x.y.z: nothing sent', JSON.stringify(vs.headers({ appVersion: 'dev', modelVersion: 'x', id: 'a'.repeat(32) })) === '{}');
    check("the app's own instance under plain Node (no Electron): no headers", JSON.stringify(vs.statsHeaders()) === '{}');
    check('a model version that throws still sends the rest (model "unknown")', vs.fromApp(pk, { env: {}, modelVersion: () => { throw new Error('x'); } })()['X-Typd-Model'] === 'unknown');
  }

  /* ---------------------------------------------------- 3. which model version */

  section('which model version');
  {
    const root = path.join(tmp, 'mv');
    const models = path.join(root, 'models'), bundled = path.join(root, 'bundled');
    fs.mkdirSync(models, { recursive: true });
    fs.mkdirSync(bundled, { recursive: true });
    const spec = { model: 'typd-dictate-1.7b-r24_1p7b-q4_k_m.gguf', mmproj: 'mmproj-qwen3-asr-1.7b-q8_0.gguf', revise: true };
    fs.writeFileSync(path.join(bundled, 'model.json'), JSON.stringify(spec));
    check('bundled, nothing else known: the label from the file name (r24_1p7b)', activeVersion(models, bundled) === 'r24_1p7b');
    fs.writeFileSync(path.join(bundled, 'model.json'), JSON.stringify({ ...spec, revise_lora: 'typd-revise-r27rev_r128-f16.gguf' }));
    check('bundled with a revise adapter: the label says so (r24_1p7b+typd-revise-r27rev_r128-f16)', activeVersion(models, bundled) === 'r24_1p7b+typd-revise-r27rev_r128-f16', activeVersion(models, bundled));
    fs.writeFileSync(path.join(models, 'state.json'), JSON.stringify({ bundled: { version: 'r24_1p7b_rev128', model: spec.model } }));
    check("bundled, and the updater found it to be a published version (state.json): that version's name", activeVersion(models, bundled) === 'r24_1p7b_rev128');
    fs.writeFileSync(path.join(bundled, 'model.json'), JSON.stringify({ ...spec, version: 'r24_1p7b' }));
    check('model.json naming its version: that name', activeVersion(models, bundled) === 'r24_1p7b');
    const files = { 'm.gguf': Buffer.from('model'), 'p.gguf': Buffer.from('proj'), 'a.gguf': Buffer.from('adapter') };
    const v = path.join(models, 'r24_1p7b_rev128');
    fs.mkdirSync(v);
    for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(v, n), b);
    const mj = { model: 'm.gguf', mmproj: 'p.gguf', revise: true, revise_lora: 'a.gguf' };
    fs.writeFileSync(path.join(v, 'model.json'), JSON.stringify(mj));
    fs.writeFileSync(path.join(v, 'manifest.json'), JSON.stringify({ version: 'r24_1p7b_rev128', files: Object.entries(files).map(([name, b]) => ({ name, size: b.length, sha256: sha(b) })), model_json: mj }));
    fs.writeFileSync(path.join(models, 'current.json'), JSON.stringify({ version: 'r24_1p7b_rev128', confirmed: true }));
    check('a downloaded version (current.json, folder complete): its published name, not the GGUF', activeVersion(models, bundled) === 'r24_1p7b_rev128');
    fs.writeFileSync(path.join(v, 'a.gguf'), 'cut');
    check('the same folder incomplete: back to the bundled one', activeVersion(models, bundled) === 'r24_1p7b');
    check('versionOf: a version name given wins; no model.json: unknown', versionOf(bundled, { version: 'v9' }) === 'v9' && versionOf(path.join(root, 'none')) === 'unknown');
    // local.js, loaded with TYPD_MODEL_DIR = a folder with no version: what it reports, live.
    check('local.modelVersion(): the folder it loaded (r24_1p7b)', local.modelVersion() === 'r24_1p7b', local.modelVersion());
    fs.writeFileSync(path.join(evalDir, 'model.json'), JSON.stringify({ model: 'typd-dictate-1.7b-r24_1p7b-q4_k_m.gguf', mmproj: 'mmproj.gguf', revise: true, version: 'r24_1p7b_rev128' }));
    check('local.modelVersion(): model.json "version" when it has one', local.modelVersion() === 'r24_1p7b_rev128', local.modelVersion());
  }

  /* ------------------------------------------------------------- 4. the requests */

  section('update checks carry the headers; nothing else does');
  const srv = await fakeServer();
  try {
    // modelUpdate.js, a packaged tester build: check, download a new version, switch, check again.
    const root = path.join(tmp, 'mu');
    const models = path.join(root, 'models'), bundled = path.join(root, 'bundled');
    fs.mkdirSync(bundled, { recursive: true });
    fs.writeFileSync(path.join(bundled, 'model.json'), JSON.stringify({ model: 'typd-dictate-1.7b-r24_1p7b-q4_k_m.gguf', mmproj: 'mm.gguf' }));
    const app = fakeApp('mu-user', true);
    const stats = vs.fromApp(app, { env: {}, modelVersion: () => activeVersion(models, bundled) });
    const files = { 'n.gguf': crypto.randomBytes(3000), 'mm2.gguf': crypto.randomBytes(1000) };
    for (const [n, b] of Object.entries(files)) srv.files.set(n, b);
    srv.manifest = { version: 'r30_1p7b', files: Object.entries(files).map(([name, b]) => ({ name, size: b.length, sha256: sha(b) })), model_json: { model: 'n.gguf', mmproj: 'mm2.gguf' }, min_app: '0.1.0' };
    const u = createUpdater({ keys: MKEYS, config: { endpoint: srv.endpoint, key: 'rk_test_0123456789abcdef' }, modelsDir: models, bundledDir: bundled, appVersion: '0.2.0',
      switchModel: async () => {}, idleMs: 20, rate: 0, stats });
    const first = await u.check();
    const mreq = srv.requests.filter((r) => r.path === '/v1/model/manifest');
    const h = mreq[0] && mreq[0].headers;
    check('model check: the four headers beside the key', Boolean(h) && h['x-typd-app'] === '0.2.0' && h['x-typd-model'] === 'r24_1p7b' && h['x-typd-os'] === `${process.platform}-${process.arch}` &&
      h['x-typd-install'] === vs.readInstallId(path.join(app.userData, vs.ID_FILE)) && /^Bearer /.test(h.authorization || ''), h);
    const fileReqs = srv.requests.filter((r) => r.path.startsWith('/v1/model/file/'));
    check('model file downloads carry none of them', first.state === 'current' && fileReqs.length === 2 && fileReqs.every((r) => !hasStats(r.headers)), { state: first.state, n: fileReqs.length });
    await u.check();
    const after = srv.requests.filter((r) => r.path === '/v1/model/manifest')[1];
    check('after the switch the next check names the new version (r30_1p7b), same install id',
      after && after.headers['x-typd-model'] === 'r30_1p7b' && after.headers['x-typd-install'] === h['x-typd-install'], after && after.headers);

    // The same updater in a source run (the developer's machine follows models too): no headers.
    const devModels = path.join(root, 'dev-models');
    const dev = createUpdater({ keys: MKEYS, config: { endpoint: srv.endpoint, key: 'rk_test_0123456789abcdef' }, modelsDir: devModels, bundledDir: bundled, appVersion: '0.2.0',
      switchModel: async () => {}, idleMs: 20, rate: 0, stats: vs.fromApp(fakeApp('dev-user', false), { env: {}, modelVersion: () => 'r24_1p7b' }) });
    srv.requests.length = 0;
    await dev.check();
    const devReqs = srv.requests.filter((r) => r.path === '/v1/model/manifest');
    check('a source run checks for models with its key and sends no version headers', devReqs.length === 1 && !hasStats(devReqs[0].headers) && /^Bearer /.test(devReqs[0].headers.authorization || ''));
    const nostats = createUpdater({ keys: MKEYS, config: { endpoint: srv.endpoint, key: 'rk_test_0123456789abcdef' }, modelsDir: path.join(root, 'm3'), bundledDir: bundled, appVersion: '0.2.0', switchModel: async () => {}, idleMs: 20, rate: 0 });
    srv.requests.length = 0;
    await nostats.check();
    check('an updater made without stats (older callers, tests) sends none', srv.requests.filter((r) => r.path === '/v1/model/manifest').every((r) => !hasStats(r.headers)));
    const throwing = createUpdater({ keys: MKEYS, config: { endpoint: srv.endpoint, key: 'rk_test_0123456789abcdef' }, modelsDir: path.join(root, 'm4'), bundledDir: bundled, appVersion: '0.2.0', switchModel: async () => {}, idleMs: 20, rate: 0, stats: () => { throw new Error('boom'); } });
    check('stats that throw never stop a model check', (await throwing.check()).state !== 'retry');

    // appUpdate.js: every packaged build.
    const keys = { 'test-1': crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) };
    const mk = (name, statsFn) => au.createAppUpdater({ keys, appVersion: '0.2.0', platform: 'win32-x64', dir: path.join(tmp, name), endpoint: srv.endpoint, stats: statsFn });
    const aApp = fakeApp('au-user', true);
    srv.requests.length = 0;
    const r1 = await mk('au1', vs.fromApp(aApp, { env: {}, modelVersion: () => 'r24_1p7b' })).check();
    const ah = (srv.requests.find((r) => r.path === '/v1/app/manifest') || {}).headers || {};
    check('app check: the four headers, no Authorization (the route is public)', r1.state === 'none' && ah['x-typd-app'] === '0.2.0' && ah['x-typd-model'] === 'r24_1p7b' &&
      ah['x-typd-install'] === vs.readInstallId(path.join(aApp.userData, vs.ID_FILE)) && !ah.authorization, ah);
    srv.requests.length = 0;
    await mk('au2', vs.fromApp(fakeApp('au-off', true), { env: { TYPD_NO_APP_UPDATE: '1' }, modelVersion: () => 'r24_1p7b' })).check();
    check('app check with TYPD_NO_APP_UPDATE=1 (only tests run one): no headers', srv.requests.length === 1 && !hasStats(srv.requests[0].headers));
    srv.requests.length = 0;
    await mk('au3', vs.fromApp(fakeApp('au-src', false), { env: {}, modelVersion: () => 'r24_1p7b' })).check();
    check('app check from a source run (only tests run one): no headers', srv.requests.length === 1 && !hasStats(srv.requests[0].headers));
    check('stats that throw never stop an app check', (await mk('au4', () => { throw new Error('boom'); }).check()).state === 'none');

    // The Electron wiring: both updaters get versionStats; appUpdate stays off from source.
    const mu = read('src/main/modelUpdate.js'), aus = read('src/main/appUpdate.js');
    check("wiring: modelUpdate.start passes versionStats' headers", /stats: \(\) => require\('\.\/versionStats'\)\.statsHeaders\(\)/.test(mu.slice(mu.indexOf('function start('))));
    check("wiring: appUpdate.start passes versionStats' headers", /stats: \(\) => require\('\.\/versionStats'\)\.statsHeaders\(\)/.test(aus.slice(aus.indexOf('function start('))));
    check('wiring: only the manifest requests use stats()', (mu.match(/stats\(\)/g) || []).length === 1 && (aus.match(/stats\(\)/g) || []).length === 1 &&
      // the model check: routes() + '/manifest', the keyed /v1/model/manifest or, with no key, /v1/model/public/manifest
      /extra = stats\(\)[^\n]*\n[^\n]*routes\(\) \+ '\/manifest', \{ headers: \{ \.\.\.extra, \.\.\.auth\(\) \}/.test(mu.replace(/\r\n/g, '\n')) &&
      /headers = stats\(\)[^\n]*\n[^\n]*\/v1\/app\/manifest', \{ headers, signal/.test(aus.replace(/\r\n/g, '\n')));
    check('wiring: appUpdate.start returns before anything when run from source or with TYPD_NO_APP_UPDATE=1',
      /if \(!app\.isPackaged\) \{ debug\('off: run from source'\); return null; \}/.test(aus) && /TYPD_NO_APP_UPDATE === '1'\) \{ debug/.test(aus));
    check('versionStats decides the same way for the model check (isPackaged, TYPD_NO_APP_UPDATE)',
      /on: enabled\(\{ isPackaged: app\.isPackaged, env \}\)/.test(read('src/main/versionStats.js')));

    /* -------------------------------------------------------- 5. shared items */

    section('shared items and flags carry exact versions');
    srv.requests.length = 0;
    const box = path.join(tmp, 'outbox');
    let modelNow = 'r24_1p7b_rev128';
    const c = createCollector({ config: { endpoint: srv.endpoint, key: 'tk_test_0123456789abcdef', tester: 't1' }, dir: box, about: { appVersion: '0.2.0', modelVersion: () => modelNow } });
    const samples = new Float32Array(16000).map((_, i) => 0.2 * Math.sin(i / 7));
    const base = { samples, sampleRate: 16000, text: 'hello there', app: 'notepad.exe', model: 'typd-dictate-1.7b-r24_1p7b-q4_k_m.gguf', engine: 'single', endedAt: Date.now() - 500, pastedAt: Date.now() };
    const n1 = c.queue({ ...base, mode: 'dictate', modelVersion: 'r24_1p7b_rev128', reviseAdapter: false });
    const n2 = c.queue({ ...base, mode: 'revise', modelVersion: 'r24_1p7b_rev128', reviseAdapter: 'typd-revise-r27rev_r128-f16.gguf' });
    const n3 = c.queue({ ...base, mode: 'revise', modelVersion: 'r24_1p7b', reviseAdapter: false });
    const n4 = c.queue({ ...base, mode: 'dictate' });   // an old caller: nothing known
    c.wake(0);
    await until(() => srv.items.size === 4);
    const m = (n) => srv.items.get(n.split('-').pop());
    const [m1, m2, m3, m4] = [n1, n2, n3, n4].map(m);
    check('a dictation: app version, the exact model version, adapter false, OS', m1 && m1.appVersion === '0.2.0' && m1.modelVersion === 'r24_1p7b_rev128' && m1.reviseAdapter === false && m1.reviseAdapterFile === null &&
      m1.model === base.model && m1.os && m1.os.platform === process.platform && m1.os.arch === process.arch, m1);
    check('a revision with the adapter: reviseAdapter true and its file', m2 && m2.reviseAdapter === true && m2.reviseAdapterFile === 'typd-revise-r27rev_r128-f16.gguf' && m2.output === null, m2);
    check('a revision without one: reviseAdapter false', m3 && m3.reviseAdapter === false && m3.modelVersion === 'r24_1p7b', m3);
    check('an item from a caller that knows neither: null, not a guess', m4 && m4.modelVersion === null && m4.reviseAdapter === null, m4);
    const ups = srv.requests.filter((r) => r.path === '/v1/upload');
    check('uploads carry no install id (header or meta) and no version headers', ups.length === 4 && ups.every((r) => !hasStats(r.headers)) &&
      [m1, m2, m3, m4].every((x) => !JSON.stringify(x).includes(vs.readInstallId(path.join(aApp.userData, vs.ID_FILE)))));
    modelNow = 'r30_1p7b';   // updated between the dictation and the flag
    const how = await c.mark(n1, 'wrong word');
    c.wake(0);
    await until(() => srv.requests.some((r) => r.path === '/v1/flag'));
    const fl = (srv.requests.find((r) => r.path === '/v1/flag') || {}).flag || {};
    check('a flag on an item already sent: the name, the note, and the versions when it was pressed',
      how === 'queued' && fl.name === n1 && fl.note === 'wrong word' && fl.about && fl.about.appVersion === '0.2.0' && fl.about.modelVersion === 'r30_1p7b' &&
      fl.about.os && fl.about.os.platform === process.platform && Object.keys(fl).sort().join(',') === 'about,name,note', fl);

    // The public beta: a dictation shared on its own after "That was wrong" keeps its versions.
    srv.requests.length = 0;
    srv.items.clear();
    let choice = 'off';
    const sh = createSharing({ endpoint: srv.endpoint, keyFile: path.join(tmp, 'share.json'), dir: path.join(tmp, 'beta-outbox'),
      choice: { get: () => choice, set: (v) => { choice = v; } }, about: { appVersion: '0.2.0', modelVersion: () => 'r24_1p7b_rev128' } });
    sh.add({ ...base, mode: 'revise', modelVersion: 'r24_1p7b_rev128', reviseAdapter: 'typd-revise-r27rev_r128-f16.gguf' });
    check('sharing off: nothing sent', srv.requests.length === 0);
    await sh.flag({ note: 'n', consent: true });
    await until(() => srv.items.size === 1);
    const fm = [...srv.items.values()][0] || {};
    check('a flag item shared on its own: consent flag, flagged, with app and model version, adapter and OS',
      fm.consent === 'flag' && fm.flag === true && fm.appVersion === '0.2.0' && fm.modelVersion === 'r24_1p7b_rev128' && fm.reviseAdapter === true && fm.os && fm.os.platform === process.platform, fm);
    check('enrollment and upload carry no install id', srv.requests.every((r) => !hasStats(r.headers)) &&
      srv.requests.filter((r) => r.path === '/v1/enroll').every((r) => Object.keys(JSON.parse(r.body.toString() || '{}')).join(',') === 'appVersion'));

    // Where the session's fields come from, in the app.
    const pipe = read('src/main/pipeline/index.js'), idx = read('src/main/index.js'), shs = read('src/main/sharing.js');
    check("pipeline: a local revision's 'done' says which adapter ran (local.REVISE_ADAPTER) or false",
      /yield \{ type: 'done', text: lead \+ revised \+ tail, reviseAdapter: adapter \? require\('path'\)\.basename\(adapter\) : false \};/.test(pipe) && /const adapter = local\.REVISE_ADAPTER;/.test(pipe));
    check("index.js: the session takes it from 'done' before anything is shared", /current\.reviseAdapter = event\.reviseAdapter \|\| false;/.test(idx) &&
      idx.indexOf('current.reviseAdapter = event.reviseAdapter') < idx.indexOf('sharing.add(current, event.text)'));
    check('sharing.add: the exact model version (local.modelVersion) and the adapter go with every item',
      /modelVersion = local\.modelVersion\(\);/.test(shs) && /reviseAdapter: session\.reviseAdapter \|\| false,/.test(shs) && /modelVersion,\n/.test(shs.replace(/\r\n/g, '\n')));
    check("the app's flags record the model version at the moment (about.modelVersion)", /about: \{ appVersion: app\.getVersion\(\), modelVersion: \(\) => require\('\.\/pipeline\/local'\)\.modelVersion\(\) \}/.test(shs));

    section('privacy text');
    const line = 'Update checks send the app and model version with an anonymous install ID, so the developer can count versions in use.';
    check('the consent screen says it, in one line', read('src/renderer/consent.html').includes(line));
    check('the consent screen still says what is never shared', /Never shared<\/h2>\s*<p>What’s on your screen, text you had selected, window titles, or anything when you’re not dictating\.<\/p>/.test(read('src/renderer/consent.html')));
    check('docs/TESTER_KIT.md says it too', /\*\*Update checks\*\* send the app and model version with an anonymous install ID, so I can count\s+> versions in use\./.test(read('docs/TESTER_KIT.md')));
  } finally {
    srv.server.close();
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) failed` : '\nall version checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
