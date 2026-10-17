'use strict';

/**
 * The first launch of a model-less public install (0.2.5): no model in the app, so the updater
 * fetches the one the hardware suits before Typd can dictate. Without Electron, a model or the
 * network: modelUpdate.js against a local fake of typd-collect's public routes, in a fresh profile.
 *
 *   - nothing bundled, nothing downloaded: haveModel() false; needed() names the variant's size
 *     (an estimate until a manifest is read); the first check comes at once (not after a minute)
 *   - full or light, as the hardware says: only that variant's files are fetched, unthrottled,
 *     checked (signature, every sha256), then switched to; needed() goes null
 *   - a slow download: progress moves (needed().pct), the tray line and the status say so
 *   - a cut connection: retried and resumed with Range from where it stopped; a corrupt file is
 *     downloaded again
 *   - offline, or the server unreachable: state 'offline', no request, a quick look again, and the
 *     plain message "Typd needs to download its model once, about X; after that it works offline."
 *   - a metered connection: 'ask' with the exact size, no file requested, until approve()
 *   - an unsigned or badly signed manifest: refused, nothing downloaded
 *   - too little disk: 'space'
 *   - status.js's lines for each state, and the app's wiring: dictation is not started without a
 *     model (index.js beginSession), warmModel starts nothing, the first model says "Ready";
 *     the build side: before-pack/after-pack/public-build's model-less mode, tester builds bundled
 *
 *   node bench/first-run.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { createUpdater, SIG_PREFIX, EXPECTED_BYTES } = require('../src/main/modelUpdate');
const status = require('../src/main/status');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
}
const section = (s) => console.log('\n' + s);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-first-run-'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
async function until(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await sleep(25); }
  return Boolean(await cond());
}

/* ------------------------------------------------- a fake public typd-collect */

const KP = crypto.generateKeyPairSync('ed25519');
const KID = 'typd-model-first-run';
const KEYS = { [KID]: KP.publicKey.export({ type: 'spki', format: 'pem' }) };

function fakeServer() {
  const s = {
    manifest: null, seq: Math.floor(Date.now() / 1000), sign: 'ok', files: {}, cutNext: {}, corrupt: {},
    slow: 0,            // ms between 64 KB chunks
    requests: []
  };
  s.server = http.createServer((req, res) => {
    s.requests.push({ url: req.url, range: req.headers.range || null, auth: req.headers.authorization || null });
    if (req.headers.authorization) { res.writeHead(400); return res.end('{"error":"the public routes take no key"}'); }
    if (req.url === '/v1/model/public/manifest') {
      if (!s.manifest) { res.writeHead(404); return res.end('{}'); }
      const text = JSON.stringify({ ...s.manifest, seq: s.seq }, null, 2) + '\n';
      const headers = { 'Content-Type': 'application/json' };
      if (s.sign !== 'none') {
        headers['X-Typd-Manifest-Key'] = KID;
        headers['X-Typd-Manifest-Sig'] = crypto.sign(null, Buffer.from(SIG_PREFIX + (s.sign === 'bad' ? text + ' ' : text)), KP.privateKey).toString('base64');
      }
      res.writeHead(200, headers);
      return res.end(text);
    }
    const m = /^\/v1\/model\/public\/file\/([^/]+)\/([^/]+)$/.exec(req.url);
    const key = m ? decodeURIComponent(m[1]) + '/' + decodeURIComponent(m[2]) : null;
    let body = key && s.files[key];
    if (!body) { res.writeHead(404); return res.end(); }
    const name = decodeURIComponent(m[2]);
    if (s.corrupt[name]) { delete s.corrupt[name]; body = Buffer.from(body); body[body.length - 1] ^= 0xff; }
    const r = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    let start = 0, code = 200;
    const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' };
    if (r) {
      start = Number(r[1]);
      if (start >= body.length) { res.writeHead(416); return res.end(); }
      code = 206;
      headers['Content-Range'] = `bytes ${start}-${body.length - 1}/${body.length}`;
    }
    const part = body.subarray(start);
    headers['Content-Length'] = String(part.length);
    res.writeHead(code, headers);
    const cut = s.cutNext[name];
    if (cut) { delete s.cutNext[name]; res.write(part.subarray(0, cut), () => setTimeout(() => res.destroy(), 30)); return; }
    if (!s.slow) return res.end(part);
    let at = 0;
    const tick = () => {
      if (res.destroyed) return;
      const next = part.subarray(at, at + 65536);
      at += next.length;
      if (at >= part.length) return res.end(next);
      res.write(next);
      setTimeout(tick, s.slow);
    };
    tick();
  });
  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => { s.endpoint = `http://127.0.0.1:${s.server.address().port}`; resolve(s); }));
}

/** The live models as published: the full one at the top level, the light one as a variant. */
function publish(s, tag = 'a') {
  const files = {
    full: { [`typd-dictate-1.7b-${tag}.gguf`]: crypto.randomBytes(900000), [`mmproj-1.7b-${tag}.gguf`]: crypto.randomBytes(300000), [`typd-revise-${tag}.gguf`]: crypto.randomBytes(100000) },
    light: { [`typd-dictate-0.6b-${tag}.gguf`]: crypto.randomBytes(400000), [`mmproj-0.6b-${tag}.gguf`]: crypto.randomBytes(200000) }
  };
  const entry = (version, f, mj) => {
    for (const [n, b] of Object.entries(f)) s.files[version + '/' + n] = b;
    return { version, files: Object.entries(f).map(([name, b]) => ({ name, size: b.length, sha256: sha(b) })), model_json: mj, min_app: '0.1.0', notes: '' };
  };
  const fn = Object.keys(files.full), ln = Object.keys(files.light);
  const full = entry('full_' + tag, files.full, { model: fn[0], mmproj: fn[1], context: true, revise: true, revise_lora: fn[2] });
  const light = entry('light_' + tag, files.light, { model: ln[0], mmproj: ln[1], context: true, revise: true });
  s.manifest = { ...full, variants: { light } };
  s.seq++;
  return { full, light, files };
}

const fileReqs = (s) => s.requests.filter((q) => q.url.includes('/file/'));

/* ---------------------------------------------------------------- a profile */

let n = 0;
function profile(s, over = {}) {
  const root = path.join(tmp, 'p' + (++n));
  const modelsDir = path.join(root, 'userData', 'models');
  const bundledDir = path.join(root, 'resources', 'models', 'typd-dictate');
  fs.mkdirSync(bundledDir, { recursive: true });
  // What a model-less build has there (scripts/before-pack.js, TYPD_NO_BUNDLED_MODEL=1).
  fs.writeFileSync(path.join(bundledDir, 'NO_MODEL.txt'), 'downloaded at first launch\n');
  const switches = [];
  const lines = [];
  const u = createUpdater({
    keys: KEYS, config: { endpoint: s.endpoint, key: null }, modelsDir, bundledDir, appVersion: '0.2.5',
    switchModel: async () => { switches.push(Date.now()); },
    rate: 1,              // 1 byte a second: an update would crawl; the first model must not
    idleMs: 0, firstCheckMs: 60e3, firstNeedMs: 50, needBackoffMinMs: 100, needBackoffMaxMs: 400, offlinePollMs: 150,
    variant: () => 'light', networkCost: async () => 'unmetered',
    ...over
  });
  u.onChange((l) => lines.push(l));
  return { u, modelsDir, bundledDir, switches, lines, current: () => { try { return JSON.parse(fs.readFileSync(path.join(modelsDir, 'current.json'), 'utf8')); } catch { return null; } } };
}

(async () => {
  const s = await fakeServer();

  section('a fresh profile: no model anywhere');
  {
    publish(s);
    const p = profile(s);
    check('haveModel() is false (only NO_MODEL.txt where the model would be)', p.u.haveModel() === false);
    const n0 = p.u.needed();
    check('needed() before any check: an estimate (the full model\'s until the hardware is read)', Boolean(n0 && n0.estimate === true && n0.variant === 'full' && n0.bytes === EXPECTED_BYTES.full), n0);
    check('the tray line says the model is not downloaded yet', p.u.line() === 'Speech model · not downloaded yet', p.u.line());
    s.requests = [];
    const t0 = Date.now();
    p.u.start();
    check('the first check comes at once (firstNeedMs), not a minute later', await until(() => s.requests.length > 0, 3000) && Date.now() - t0 < 2000, Date.now() - t0);
    check('it downloads the light variant, switches to it', await until(() => p.switches.length === 1) && p.current() && p.current().version === 'light_a', p.current());
    const urls = fileReqs(s).map((q) => q.url);
    check('only the light files were fetched (2), from the public routes, with no key', urls.length === 2 && urls.every((u) => u.includes('/light_a/')) && s.requests.every((q) => !q.auth), urls);
    check('unthrottled: 600 kB at rate 1 B/s took under 5 s', Date.now() - t0 < 5000, Date.now() - t0);
    check('every file is in place under models/light_a with model.json and manifest.json',
      ['typd-dictate-0.6b-a.gguf', 'mmproj-0.6b-a.gguf', 'model.json', 'manifest.json'].every((f) => fs.existsSync(path.join(p.modelsDir, 'light_a', f))));
    check('haveModel() true, needed() null, the line names the model', p.u.haveModel() && p.u.needed() === null && /^Model light_a/.test(p.u.line()), p.u.line());
    check('the bundled folder is untouched', fs.readdirSync(p.bundledDir).join() === 'NO_MODEL.txt');
    p.u.stop();
  }

  section('the full model, on hardware that suits it');
  {
    s.requests = [];
    const p = profile(s, { variant: () => 'full' });
    const r = await p.u.check();
    check('the full model: its three files (model, mmproj, revise adapter)', r.state === 'current' && fileReqs(s).length === 3 && p.current().version === 'full_a', { r, n: fileReqs(s).length });
  }

  section('a slow download: progress moves, and says so');
  {
    s.slow = 15;
    const p = profile(s);
    const seen = [];
    const going = p.u.check();
    await until(() => { const x = p.u.needed(); if (x && x.state === 'downloading') seen.push(x.pct); return seen.length && seen[seen.length - 1] >= 40; }, 10000);
    const mid = p.u.needed();
    check('needed(): downloading, exact size (not an estimate), a percent between 1 and 99', mid && mid.state === 'downloading' && mid.estimate === false && mid.pct > 0 && mid.pct < 100 && mid.bytes === 600000, mid);
    check('the tray line: "Speech model · downloading N % of 600 kB"', /^Speech model · downloading \d+ % of 1 MB$/.test(p.u.line()), p.u.line());
    status.set({ model: 'missing', modelFetch: mid });
    const d = status.describe();
    check('the status: "Downloading the speech model — N %", no action, dim', d.state === 'download' && /^Downloading the speech model — \d+ %$/.test(d.line) && !d.action && d.icon === 'dim', d);
    const r = await going;
    check('it finishes and switches', r.state === 'current' && p.switches.length === 1);
    check('progress only went up', seen.every((v, i) => i === 0 || v >= seen[i - 1]), seen);
    s.slow = 0;
  }

  section('a cut connection, then a corrupt file');
  {
    publish(s, 'b');
    s.requests = [];
    s.cutNext['typd-dictate-0.6b-b.gguf'] = 150000;
    const p = profile(s);
    let r = await p.u.check();
    check('cut at 150 kB: a retry, nothing switched', r.state === 'retry' && p.switches.length === 0, r);
    check('state retrying: "(paused)" on the tray line', p.u.needed().state === 'retrying' && /\(paused\)$/.test(p.u.line()), p.u.line());
    check('the next try comes soon (needBackoff, at least 1 s), not in minutes', r.next <= 1000, r.next);
    r = await p.u.check();
    const ranges = fileReqs(s).filter((q) => q.url.endsWith('typd-dictate-0.6b-b.gguf')).map((q) => q.range);
    check('resumed with Range from 150,000', ranges.includes('bytes=150000-'), ranges);
    check('then verified and switched', r.state === 'current' && p.current().version === 'light_b', r);

    publish(s, 'c');
    s.corrupt['mmproj-0.6b-c.gguf'] = true;
    const q = profile(s);
    r = await q.u.check();
    check('a corrupt file fails its sha256: retried, nothing switched', r.state === 'retry' && q.switches.length === 0 && /verification/.test(r.why), r);
    r = await q.u.check();
    check('downloaded again, then switched', r.state === 'current' && q.current().version === 'light_c', r);
  }

  section('offline, and the server out of reach');
  {
    let online = false;
    s.requests = [];
    const p = profile(s, { online: () => online });
    let r = await p.u.check();
    check('offline: no request at all', s.requests.length === 0);
    check('state offline, a quick look again (offlinePollMs, at least 1 s)', r.state === 'retry' && p.u.needed().state === 'offline' && r.next === 1000, { r, n: p.u.needed() });
    check('the tray line: "Speech model · waiting for the internet"', p.u.line() === 'Speech model · waiting for the internet', p.u.line());
    status.set({ model: 'missing', modelFetch: p.u.needed() });
    const d = status.describe();
    check('the status card: "Typd needs to download its model once, about 611 MB; after that it works offline."',
      d.card === 'Typd needs to download its model once, about 611 MB; after that it works offline.' && d.line === 'Speech model needed — connect to the internet', d);
    online = true;
    r = await p.u.check();
    check('back online: downloaded and switched', r.state === 'current' && p.switches.length === 1, r);

    const dead = createUpdater({ keys: KEYS, config: { endpoint: 'http://127.0.0.1:9', key: null }, modelsDir: path.join(tmp, 'dead', 'models'), bundledDir: path.join(tmp, 'dead', 'none'),
      appVersion: '0.2.5', switchModel: async () => {}, variant: () => 'full', offlinePollMs: 150 });
    r = await dead.check();
    check('the server unreachable: the same "offline" state, the full model\'s estimate (1.6 GB)', r.state === 'retry' && dead.needed().state === 'offline' && dead.needed().size === '1.6 GB' && r.next === 1000, { r, n: dead.needed() });
  }

  section('a metered connection: asked first');
  {
    s.requests = [];
    const p = profile(s, { networkCost: async () => 'metered', askAboveBytes: 1000 });
    let r = await p.u.check();
    const nd = p.u.needed();
    check('state ask, no file requested', r.state === 'ask' && fileReqs(s).length === 0, r);
    check('needed(): the exact size (600 kB of the light model), why metered', nd.state === 'ask' && nd.estimate === false && nd.bytes === 600000 && nd.why === 'metered', nd);
    check('pending() marks it the first model (the tray says "Download the speech model")', p.u.pending && p.u.pending.first === true);
    status.set({ model: 'missing', modelFetch: nd });
    const d = status.describe();
    check('the status offers "Download now"', d.action && d.action.id === 'model-now' && /Download now/.test(d.line), d);
    await p.u.approve();
    r = await p.u.check();
    check('approved: downloaded and switched', r.state === 'current' && p.switches.length === 1, r);
  }

  section('signatures and disk space');
  {
    s.sign = 'bad';
    s.requests = [];
    const p = profile(s);
    let r = await p.u.check();
    check('a badly signed manifest: refused, nothing downloaded, still no model', r.state === 'refused' && fileReqs(s).length === 0 && p.u.needed() !== null, r);
    check('and looked at again in minutes, not hours', r.next === 15 * 60e3, r.next);
    s.sign = 'none';
    r = await profile(s).u.check();
    check('an unsigned one: refused too', r.state === 'refused', r);
    s.sign = 'ok';
    const q = profile(s, { statfs: async () => ({ bavail: 10, bsize: 4096 }) });
    r = await q.u.check();
    check('too little disk: state space', q.u.needed().state === 'space' && r.state === 'space', { r, n: q.u.needed() });
    status.set({ model: 'missing', modelFetch: q.u.needed() });
    check('the status says how much space', /free disk space/.test(status.describe().card), status.describe());
  }

  section('a bundled model (tester builds) changes nothing');
  {
    s.requests = [];
    const root = path.join(tmp, 'bundled');
    const bundledDir = path.join(root, 'resources', 'models', 'typd-dictate');
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.writeFileSync(path.join(bundledDir, 'm.gguf'), 'model');
    fs.writeFileSync(path.join(bundledDir, 'p.gguf'), 'proj');
    fs.writeFileSync(path.join(bundledDir, 'model.json'), JSON.stringify({ model: 'm.gguf', mmproj: 'p.gguf' }));
    const u = createUpdater({ keys: KEYS, config: { endpoint: s.endpoint, key: null }, modelsDir: path.join(root, 'models'), bundledDir, appVersion: '0.2.5', switchModel: async () => {}, firstCheckMs: 60e3, firstNeedMs: 50 });
    check('haveModel() true, needed() null', u.haveModel() && u.needed() === null);
    u.start();
    await sleep(400);
    check('no check before FIRST_CHECK_MS (a minute): nothing requested yet', s.requests.length === 0);
    u.stop();
  }

  section('status.js: the line for each first-model state');
  {
    const cases = {
      downloading: [{ state: 'downloading', pct: 42, size: '611 MB', estimate: false }, 'Downloading the speech model — 42 %'],
      retrying: [{ state: 'retrying', pct: 42, size: '611 MB', estimate: false }, 'Downloading the speech model — 42 %, paused'],
      ready: [{ state: 'ready', pct: 100, size: '611 MB' }, 'Getting the speech model ready…'],
      ask: [{ state: 'ask', size: '611 MB' }, 'Speech model needed (611 MB) — Download now'],
      offline: [{ state: 'offline', size: '1.6 GB', estimate: true }, 'Speech model needed — connect to the internet'],
      space: [{ state: 'space', size: '611 MB' }, 'Speech model needs more disk space'],
      idle: [{ state: 'idle', size: '611 MB', estimate: true }, 'Getting the speech model…']
    };
    for (const [k, [f, want]] of Object.entries(cases)) {
      status.set({ model: 'missing', modelFetch: f });
      check(k + ': "' + want + '"', status.describe().line === want, status.describe().line);
    }
    status.set({ model: 'missing', modelFetch: null });
    check('no download running (updates off): "No speech model yet", with Try again', status.describe().line === 'No speech model yet' && status.describe().action.id === 'retry');
    status.set({ model: 'failed', modelFetch: null, modelWhy: 'x' });
    check('a model that fails to start still reads as before', /didn't start/.test(status.describe().line));
  }

  section('the app: no dictation without a model, no dialogs (source checks)');
  {
    const idx = read('src/main/index.js');
    const begin = (idx.match(/function beginSession\(\) \{[\s\S]*?\n\}/) || [''])[0];
    check('beginSession: with no model, a note in the pill and nothing recorded',
      /if \(!session && modelMissing\(\)\) \{\s*note\(status\.describe\(\)\.line, 6000\);\s*return;\s*\}/.test(begin) && begin.indexOf('modelMissing()') < begin.indexOf('session = {'));
    const warm = (idx.match(/function warmModel\(\) \{[\s\S]*?\n\}/) || [''])[0];
    check('warmModel: starts nothing with no model', /if \(modelMissing\(\)\) return;/.test(warm) && warm.indexOf('modelMissing()') < warm.indexOf('pipeline.warm()'));
    check('modelMissing: the local files decide, the status carries the download', /require\('\.\/pipeline\/local'\)\.hasModel\(\)/.test(idx) && /status\.set\(\{ model: 'missing', modelWhy: '', modelFetch: fetch \}\);/.test(idx));
    check('the first model says "Ready — … and talk" once', /if \(first\) \{ const k = keyInfo\(\); note\('Ready — '/.test(idx));
    check('"Download now" from the tray or Home approves the download', /if \(id === 'model-now'\) return modelUpdate\.approve\(\)/.test(idx));
    check('no dialog anywhere on this path', !/showMessageBox|showErrorBox/.test(begin + warm));
    check("an app update's first start with no model yet is not judged by a model start that will never come",
      /if \(!local\.hasModel\(\)\) \{ warm = \{ ok: false, error: new Error\('no speech model yet: it downloads at first launch'\) \}; decide\(\); \}/.test(idx));
    check('local.hasModel(): the loaded model and mmproj are on disk', /hasModel: \(\) => fs\.existsSync\(MODEL\) && fs\.existsSync\(MMPROJ\)/.test(read('src/main/pipeline/local.js')));
    const home = read('src/renderer/home.js');
    check('the walkthrough shows the download on every step, and its practice box waits for the model',
      /function renderModel\(\)/.test(home) && /renderModel\(\);\s*\}/.test(home) && /The practice box works once the speech model is ready\./.test(home) && /id="walkModel"/.test(read('src/renderer/home.html')));
    check("the walkthrough's offline text, word for word", home.includes("'Typd needs to download its model once, ' + about + '; after that it works offline."));
  }

  section('the build: model-less public installers, tester builds bundled (source checks)');
  {
    const bp = read('scripts/before-pack.js'), ap = read('scripts/after-pack.js'), pb = read('scripts/public-build.js');
    check('before-pack: TYPD_NO_BUNDLED_MODEL=1 stages only NO_MODEL.txt', /process\.env\.TYPD_NO_BUNDLED_MODEL === '1'/.test(bp) && /NO_MODEL\.txt/.test(bp));
    check('after-pack: a tester build may not be model-less; a model-less build may hold no model.json', /A tester build bundles its model/.test(ap) && /holds a model/.test(ap));
    check('public-build win: model-less unless --with-model; verify expects the kind it built',
      /env\.TYPD_NO_BUNDLED_MODEL = '1';/.test(pb) && /expectModel: withModel \? 'yes' : 'no'/.test(pb));
    check('public-build verify: no .gguf anywhere in a model-less app', /checks\.model_absent = ggufs\.length === 0;/.test(pb));
  }

  s.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + (failures ? failures + ' FAILED' : 'all first-run checks passed') + '\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
