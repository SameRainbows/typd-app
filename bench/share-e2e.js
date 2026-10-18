'use strict';

/**
 * Sharing end to end, as a PUBLIC packaged build runs it, against the real typd-collect Worker on a
 * local `wrangler dev --local` (throwaway KV and R2, a test admin key: nothing here reaches the real
 * server, bucket or keys).
 *
 * The app side is this checkout's src/main/sharing.js loaded exactly as the packaged app loads it:
 * electron says isPackaged, the resources folder has no tester.json (what scripts/public-build.js
 * verifies), the profile is fresh, and no TYPD_* sharing variable is set -- so the build shares by
 * default with its built-in endpoint. Only fetch is pointed elsewhere: requests for
 * https://typd-collect.mehmetdedeler.com go to the local Worker instead. One synthetic dictation goes
 * through sharing.add(session, text), the call index.js makes after a paste, and then:
 *
 *   - the install enrolls (POST /v1/enroll 201) and the item uploads (POST /v1/upload 201); the
 *     outbox empties; share.json names the production endpoint and an i- id
 *   - the Worker lists the install (GET /v1/admin/installs) with this app version, and the item under
 *     it (GET /v1/list): a dictation, consent 'all', the text, this OS, no screen context
 *   - dictation-research/scripts/pull_testers.py --list-installs shows it: enrolled, 1 on the server
 *   - the life log has said so: at launch, queued, enrolled, sent; and diagnostics() agrees
 *   - with sharing turned off ('off' in settings.json), not one request is made, and the life log
 *     says why ("not queued: sharing is off")
 *
 * Skips (exit 0, with the reason) when the Worker's source or wrangler is not on this machine (CI);
 * the pull_testers.py step skips by itself without Python or dictation-research.
 *
 *   node bench/share-e2e.js
 *   TYPD_COLLECT_DIR=..\typd-collect WRANGLER_JS=...\wrangler.js TYPD_RESEARCH_DIR=..\dictation-research node bench/share-e2e.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROD = 'https://typd-collect.mehmetdedeler.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ the app (a child process) */

if (process.argv[2] === '--app') {
  const c = JSON.parse(process.argv[3]);
  const Module = require('module');
  const { EventEmitter } = require('events');
  process.resourcesPath = c.resources;
  const ready = [];
  const app = {
    isPackaged: true,
    getPath: (k) => (k === 'appData' ? c.appData : k === 'userData' ? c.userData : path.join(c.appData, '_' + k)),
    getVersion: () => c.version,
    whenReady: () => ({ then: (fn) => { ready.push(fn); } })
  };
  const electron = { app, powerMonitor: new EventEmitter() };
  const realLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return electron;
    return realLoad.apply(this, arguments);
  };
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const to = u.startsWith(PROD + '/') ? c.base + u.slice(PROD.length) : u;
    const res = await realFetch(to, opts);
    requests.push({ method: opts.method || 'GET', host: new URL(u).host, path: new URL(u).pathname, status: res.status });
    return res;
  };

  const sharing = require(path.join(ROOT, 'src', 'main', 'sharing.js'));
  const life = require(path.join(ROOT, 'src', 'main', 'lifelog.js'));
  life.init(c.userData, { info: 'share-e2e' });
  for (const fn of ready) fn();
  const s = sharing.get();
  const out = { mode: s ? s.mode : null, status: sharing.status(), requests };

  // One dictation, as index.js hands it over once the paste landed: 2 s of a synthetic tone.
  const samples = new Float32Array(16000 * 2);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.25 * Math.sin(i / 7) * Math.sin(i / 3000);
  const session = { audio: { samples, sampleRate: 16000 }, mode: 'dictate', target: { process: 'notepad' }, endedAt: Date.now() - 400 };
  sharing.add(session, c.text);

  (async () => {
    const outbox = path.join(c.userData, 'outbox');
    const keyFile = path.join(c.userData, 'share.json');
    const waiting = () => { try { return fs.readdirSync(outbox).filter((n) => n.endsWith('.json')).length; } catch { return 0; } };
    const end = Date.now() + (c.expectSend ? 30e3 : 6e3);
    while (Date.now() < end) {
      if (c.expectSend && fs.existsSync(keyFile) && waiting() === 0 && requests.some((r) => r.path === '/v1/upload')) break;
      await sleep(100);
    }
    let key = null;
    try { const k = JSON.parse(fs.readFileSync(keyFile, 'utf8')); key = { endpoint: k.endpoint, id: k.id, hasKey: typeof k.key === 'string' }; } catch { /* none */ }
    out.key = key;
    out.waiting = waiting();
    out.diagnostics = typeof sharing.diagnostics === 'function' ? sharing.diagnostics() : '(no diagnostics() in this version)';
    out.life = life.tail(50).filter((l) => / sharing: /.test(l)).map((l) => l.replace(/^\S+ \[\d+\] /, ''));
    process.stdout.write('\n@@RESULT@@' + JSON.stringify(out) + '\n');
    process.exit(0);
  })();
  return;
}

/* ------------------------------------------------------------------ the bench */

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + JSON.stringify(detail).slice(0, 500) : ''));
}
const section = (s) => console.log('\n' + s);
function skip(why) {
  console.log('share-e2e: SKIPPED -- ' + why);
  process.exit(0);
}

const COLLECT = path.resolve(process.env.TYPD_COLLECT_DIR || path.join(ROOT, '..', 'typd-collect'));
const WRANGLER = process.env.WRANGLER_JS || path.join(COLLECT, '..', 'mehmetdedeler', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const RESEARCH = path.resolve(process.env.TYPD_RESEARCH_DIR || path.join(ROOT, '..', 'dictation-research'));
if (!fs.existsSync(path.join(COLLECT, 'wrangler.jsonc')) || !fs.existsSync(path.join(COLLECT, 'src', 'index.js'))) {
  skip(`no typd-collect source at ${COLLECT} (set TYPD_COLLECT_DIR)`);
}
if (!fs.existsSync(WRANGLER)) skip(`no wrangler at ${WRANGLER} (set WRANGLER_JS to wrangler/bin/wrangler.js)`);

const VERSION = require(path.join(ROOT, 'package.json')).version;
const ADMIN = 'ak_e2e_' + crypto.randomBytes(16).toString('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-share-e2e-'));
let worker = null;

function stopWorker() {
  if (!worker) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(worker.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else worker.kill('SIGTERM');
  worker = null;
}
process.on('exit', stopWorker);
process.on('SIGINT', () => { stopWorker(); process.exit(130); });

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startWorker() {
  const port = await freePort();
  const args = [WRANGLER, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', path.join(tmp, 'state'),
    '--show-interactive-dev-session=false', '--log-level', 'warn', '--var', 'ADMIN_KEY:' + ADMIN];
  worker = spawn(process.execPath, args, { cwd: COLLECT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  worker.stdout.on('data', (d) => { log += d; });
  worker.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 180; i++) {
    if (!worker || worker.exitCode !== null) break;
    try { if ((await fetch(base + '/v1/model/manifest')).status === 401) return base; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('wrangler dev did not start:\n' + log.slice(-2000));
}

/** A fresh profile and a public build's resources folder (no tester.json), then the app child. */
function runApp(base, name, { settings = null, expectSend = true, text } = {}) {
  const appData = path.join(tmp, name, 'Roaming');
  const userData = path.join(appData, 'Typd');
  const resources = path.join(tmp, name, 'resources');
  fs.mkdirSync(path.join(resources, 'llama'), { recursive: true });
  fs.mkdirSync(path.join(resources, 'models'), { recursive: true });
  if (settings) {
    fs.mkdirSync(path.join(appData, 'typd'), { recursive: true });
    fs.writeFileSync(path.join(appData, 'typd', 'settings.json'), JSON.stringify(settings));
  }
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^TYPD_/.test(k)) delete env[k];   // a user's PC sets none of them
  const cfg = { appData, userData, resources, base, version: VERSION, expectSend, text };
  const r = spawnSync(process.execPath, [__filename, '--app', JSON.stringify(cfg)], { env, encoding: 'utf8', timeout: 60e3, windowsHide: true });
  const m = /@@RESULT@@(.*)/.exec(r.stdout || '');
  if (!m) throw new Error('the app run gave no result:\n' + (r.stdout || '').slice(-1500) + '\n' + (r.stderr || '').slice(-1500));
  return { ...JSON.parse(m[1]), resources };
}

async function admin(base, p) {
  const res = await fetch(base + p, { headers: { Authorization: 'Bearer ' + ADMIN } });
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
}

function python() {
  for (const exe of process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']) {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return exe;
  }
  return null;
}

(async () => {
  console.log('Sharing end to end: a public packaged build, a fresh profile, one dictation, the real Worker (wrangler dev --local)');
  let base;
  try {
    base = await startWorker();
  } catch (err) {
    console.log(String(err.message).slice(0, 1500));
    skip('wrangler dev did not start here (see above)');
  }
  console.log('  Worker: ' + base);

  section('a public build, sharing on by default');
  const text = 'Typd share e2e synthetic dictation ' + crypto.randomBytes(3).toString('hex');
  const a = runApp(base, 'on', { text });
  check('no tester.json in the resources folder (as public-build.js verifies)', !fs.existsSync(path.join(a.resources, 'tester.json')));
  check('the packaged build is in public mode, sharing on', a.mode === 'beta' && a.status && a.status.state === 'on', a.status);
  const enroll = a.requests.filter((r) => r.path === '/v1/enroll');
  const upload = a.requests.filter((r) => r.path === '/v1/upload');
  check('the first dictation enrolls this install: POST /v1/enroll 201, once', enroll.length === 1 && enroll[0].status === 201, a.requests);
  check('the dictation uploads: POST /v1/upload 201', upload.length === 1 && upload[0].status === 201, a.requests);
  check('every request went to the built-in endpoint (typd-collect.mehmetdedeler.com)', a.requests.every((r) => r.host === new URL(PROD).host), a.requests);
  check('share.json: the production endpoint, an i- id and a key', a.key && a.key.endpoint === PROD && /^i-[0-9a-f]{20}$/.test(a.key.id) && a.key.hasKey, a.key);
  check('the outbox is empty', a.waiting === 0, a.waiting);
  const id = a.key && a.key.id;

  section('the server');
  const installs = await admin(base, '/v1/admin/installs');
  const inst = installs.body && (installs.body.installs || []).find((i) => i.id === id);
  check('GET /v1/admin/installs lists it, with this app version', Boolean(inst) && inst.appVersion === VERSION, installs);
  const list = await admin(base, '/v1/list?prefix=' + encodeURIComponent(id || 'i-'));
  const items = (list.body && list.body.items) || [];
  check('GET /v1/list: one item under it, a dictation', items.length === 1 && items[0].mode === 'dictate', list);
  if (items[0]) {
    const it = await admin(base, '/v1/item/' + items[0].key.split('/').map(encodeURIComponent).join('/'));
    const meta = (it.body && it.body.meta) || {};
    check("the item: consent 'all', the text, this app version and OS", meta.consent === 'all' && meta.output === text && meta.appVersion === VERSION && meta.os && meta.os.platform === process.platform, meta);
    check('the item carries no screen context, span or title', !['context', 'contextBlock', 'span', 'selection', 'title', 'screen'].some((k) => k in meta), Object.keys(meta));
    check('the item: 2 s of audio', Math.abs((meta.audioSeconds || 0) - 2) < 0.05, meta.audioSeconds);
  }

  section('pull_testers.py --list-installs');
  const script = path.join(RESEARCH, 'scripts', 'pull_testers.py');
  const py = fs.existsSync(script) ? python() : null;
  if (!py) {
    console.log('  skipped: ' + (fs.existsSync(script) ? 'no Python' : 'no ' + script + ' (set TYPD_RESEARCH_DIR)'));
  } else {
    const env = { ...process.env, TYPD_COLLECT_URL: base, TYPD_COLLECT_ADMIN_KEY: ADMIN, TYPD_PULL_DIR: path.join(tmp, 'pull'), PYTHONIOENCODING: 'utf-8' };
    const r = spawnSync(py, ['-I', script, '--list-installs'], { env, encoding: 'utf8', timeout: 60e3, windowsHide: true });
    const line = (r.stdout || '').split('\n').find((l) => id && l.startsWith(id)) || '';
    check('it lists the install: enrolled today, this app version, 1 on the server', r.status === 0 && /enrolled \d{4}-\d{2}-\d{2}/.test(line) && line.includes(VERSION) && /on server\s+1 /.test(line), { status: r.status, out: (r.stdout || '').slice(-600), err: (r.stderr || '').slice(-600) });
    check('and counts it: 1 enrolled, 1 with recordings', /1 enrolled, 1 with recordings on the server/.test(r.stdout || ''), (r.stdout || '').slice(-300));
  }

  section('what the PC itself says (life log, "Copy diagnostics")');
  const said = a.life.join(' | ');
  check('the life log: at launch, queued, enrolled, sent', /sharing: at launch: public build, on; not enrolled yet/.test(said) && /sharing: queued/.test(said) &&
    said.includes('sharing: enrolled: ' + id) && /sharing: sent: 1 this run/.test(said), a.life);
  check('diagnostics(): enrolled, nothing waiting, 1 queued and 1 sent', a.diagnostics.includes('enrolled ' + id) && /0 waiting/.test(a.diagnostics) && /1 queued, 1 sent/.test(a.diagnostics), a.diagnostics);
  check('no key in the life log or diagnostics', !/ik_[A-Za-z0-9_-]{20,}/.test(said + a.diagnostics));

  section('sharing turned off');
  const b = runApp(base, 'off', { settings: { share: 'off' }, expectSend: false, text: 'not to be shared' });
  check('state off', b.status && b.status.state === 'off', b.status);
  check('not one request, not even enrollment', b.requests.length === 0, b.requests);
  check('nothing waits, no key', b.waiting === 0 && !b.key, { waiting: b.waiting, key: b.key });
  check('the life log says why', b.life.some((l) => /sharing: not queued: sharing is off/.test(l)), b.life);
  const after = await admin(base, '/v1/admin/installs');
  check('the server still has the one install', after.body && after.body.installs && after.body.installs.length === 1, after.body);

  stopWorker();
  console.log('\n' + (failures ? failures + ' FAILED' : 'all share-e2e checks passed'));
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.log('share-e2e error: ' + (err && err.stack || err));
  stopWorker();
  process.exit(1);
});
