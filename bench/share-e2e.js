'use strict';

/**
 * Sharing end to end, as a PUBLIC packaged build runs it, against the real typd-collect Worker on a
 * local `wrangler dev --local` (throwaway KV and R2, a test admin key: nothing here reaches the real
 * server, bucket or keys).
 *
 * The app side is this checkout's src/main/sharing.js (and settings.js, backfill.js, collect.js)
 * loaded exactly as the packaged app loads them: electron says isPackaged, the resources folder has
 * no tester.json (what scripts/public-build.js verifies), and no TYPD_* variable is set -- so the
 * build shares with its built-in endpoint once sharing is on. Only fetch is pointed elsewhere:
 * requests for https://typd-collect.mehmetdedeler.com go to the local Worker instead. Dictations go
 * through sharing.add(session, text[, {pasted: false}]), the calls index.js makes once the text
 * landed; answers through sharing.answer, as index.js chooseSharing does. Since 0.2.7 sharing is asked,
 * and since 0.2.12 every install that never chose is asked, and no item carries the program's name:
 *
 *   - a fresh install, not answered: not one request, nothing waits; the life log says why
 *   - it answers Share: enrolled (POST /v1/enroll 201), the dictation uploads (POST /v1/upload 201);
 *     the Worker lists the install and the item (consent 'all', the text, pasted, no screen context,
 *     no program name); dictation-research/scripts/pull_testers.py --list-installs shows it; the life
 *     log and diagnostics() agree; Don't share: not one request
 *   - an update from 0.2.6 first started before 0.2.7's cutoff (recordings kept on 17 Oct), never
 *     chose: asked ('ask', the small screen due), not one request, no automatic backfill; Share at the
 *     next launch: then the one automatic backfill sends its 3 kept recordings (no context, no program
 *     name; the Worker will not list a key's items unless asked: the run goes on without), and a
 *     dictation whose paste fell back to the clipboard is shared, pasted: false; the next launch: on,
 *     not asked, nothing sent again
 *   - 0.2.7-0.2.11's 'on' (kept without asking) with an item 0.2.11 queued (naming the program):
 *     asked, the item waits; after Share it reaches the Worker without "app" (the Worker accepts it)
 *   - an explicit 'on' (0.2.12 recorded the choice): not asked, shares
 *   - 'off': off, not one request, no automatic backfill
 *   - shared under 0.2.6's default, never chose: asked, nothing queued until answered; Don't share
 *     calls DELETE /v1/me and the Worker holds nothing for it, and it stays off; one that never
 *     shared: Don't share makes no request
 *   - no item on the Worker carries "app"
 *
 * Skips (exit 0, with the reason) when the Worker's source or wrangler is not on this machine (CI);
 * the pull_testers.py step skips by itself without Python or dictation-research.
 *
 *   node bench/share-e2e.js
 *   TYPD_COLLECT_DIR=..	ypd-collect WRANGLER_JS=...\wrangler.js TYPD_RESEARCH_DIR=..\dictation-research node bench/share-e2e.js
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
const { encodeWav } = require(path.join(ROOT, 'src', 'main', 'collect.js'));

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
  const settings = require(path.join(ROOT, 'src', 'main', 'settings.js'));
  const life = require(path.join(ROOT, 'src', 'main', 'lifelog.js'));
  life.init(c.userData, { info: 'share-e2e' });
  for (const fn of ready) fn();
  const s = sharing.get();
  const out = { mode: s ? s.mode : null, share: settings.get('share'), shareAsk: settings.get('shareAsk'), shareChosen: settings.get('shareChosen'), requests };

  // A dictation, as index.js hands it over once its text landed: 2 s of a synthetic tone.
  const samples = new Float32Array(16000 * 2);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.25 * Math.sin(i / 7) * Math.sin(i / 3000);
  const session = () => ({ audio: { samples, sampleRate: 16000 }, mode: 'dictate', target: { process: 'notepad' }, endedAt: Date.now() - 400 });

  (async () => {
    await sleep(500);   // the automatic backfill's decision, at launch
    out.status = sharing.status();
    out.answers = [];
    for (const a of c.actions || []) {
      if (a === 'dictate') sharing.add(session(), c.text);
      if (a === 'copied') sharing.add(session(), c.text + ' (copied)', { pasted: false });   // the paste fell back to the clipboard
      // index.js chooseSharing: the walkthrough's first screen, the share screen, Settings' switch.
      if (a === 'share' || a === 'dontshare') out.answers.push(await s.answer(a === 'share' ? 'on' : 'off'));
      await sleep(200);
    }
    const outbox = path.join(c.userData, 'outbox');
    const keyFile = path.join(c.userData, 'share.json');
    const waiting = () => { try { return fs.readdirSync(outbox).filter((n) => n.endsWith('.json')).length; } catch { return 0; } };
    const uploads = () => requests.filter((r) => r.path === '/v1/upload' && r.status === 201).length;
    const end = Date.now() + (c.uploads ? 60e3 : 6e3);
    while (Date.now() < end) {
      // The past dictations' run, driven step by step (it would take ~90 s an item by itself).
      if (c.uploads && s && s.backfill && s.backfill.status().state === 'running') await s.backfill.step();
      if (c.uploads && fs.existsSync(keyFile) && waiting() === 0 && uploads() >= c.uploads &&
        (!s || !s.backfill || s.backfill.status().state !== 'running')) break;
      await sleep(250);
    }
    let key = null;
    try { const k = JSON.parse(fs.readFileSync(keyFile, 'utf8')); key = { endpoint: k.endpoint, id: k.id, hasKey: typeof k.key === 'string' }; } catch { /* none */ }
    out.key = key;
    out.waiting = waiting();
    out.after = sharing.status();
    out.shareAfter = settings.get('share');
    out.shareChosenAfter = settings.get('shareChosen');
    out.diagnostics = typeof sharing.diagnostics === 'function' ? sharing.diagnostics() : '(no diagnostics() in this version)';
    out.life = life.tail(80).filter((l) => / (sharing|backfill): /.test(l)).map((l) => l.replace(/^\S+ \[\d+\] /, ''));
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
process.on('exit', () => { stopWorker(); try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* the OS cleans its temp folder */ } });
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
/** A profile (fresh, or as an earlier Typd left it) and a public build's resources folder (no tester.json), then the app child. */
function runApp(base, name, { settings = null, actions = [], uploads = 0, text = 'x', recordings = [], outbox = [] } = {}) {
  const appData = path.join(tmp, name, 'Roaming');
  const userData = path.join(appData, 'Typd');
  const resources = path.join(tmp, name, 'resources');
  fs.mkdirSync(path.join(resources, 'llama'), { recursive: true });
  fs.mkdirSync(path.join(resources, 'models'), { recursive: true });
  if (settings) {
    fs.mkdirSync(path.join(appData, 'typd'), { recursive: true });
    fs.writeFileSync(path.join(appData, 'typd', 'settings.json'), JSON.stringify(settings));
  }
  for (const r of recordings) {
    const dir = path.join(appData, 'Typd', 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    const tone = new Float32Array(16000).map((_, i) => 0.2 * Math.sin(i / 9));
    fs.writeFileSync(path.join(dir, r.name + '.wav'), encodeWav(tone));
    fs.writeFileSync(path.join(dir, r.name + '.json'), JSON.stringify({ mode: 'dictate', output: r.text, seconds: 1, ms: 380, model: 'r24_1p7b-q4_k_m.gguf', app: 'notepad', context: 'NEVER-SENT-CONTEXT' }));
  }
  // Items an earlier Typd queued and never sent (its meta as it wrote it).
  for (const o of outbox) {
    const dir = path.join(userData, 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, o.name + '.wav'), encodeWav(new Float32Array(16000).map((_, i) => 0.2 * Math.sin(i / 11))));
    fs.writeFileSync(path.join(dir, o.name + '.json'), JSON.stringify(o.meta, null, 1));
  }
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^TYPD_/.test(k)) delete env[k];   // a user's PC sets none of them
  const cfg = { appData, userData, resources, base, version: VERSION, actions, uploads, text };
  const r = spawnSync(process.execPath, [__filename, '--app', JSON.stringify(cfg)], { env, encoding: 'utf8', timeout: 120e3, windowsHide: true });
  const m = /@@RESULT@@(.*)/.exec(r.stdout || '');
  if (!m) throw new Error('the app run gave no result:\n' + (r.stdout || '').slice(-1500) + '\n' + (r.stderr || '').slice(-1500));
  return { ...JSON.parse(m[1]), resources, appData, userData };
}

async function admin(base, p) {
  const res = await fetch(base + p, { headers: { Authorization: 'Bearer ' + ADMIN } });
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
}
async function itemsOf(base, id) {
  const list = await admin(base, '/v1/list?prefix=' + encodeURIComponent(id || 'i-'));
  const out = [];
  for (const it of (list.body && list.body.items) || []) {
    const one = await admin(base, '/v1/item/' + it.key.split('/').map(encodeURIComponent).join('/'));
    out.push({ key: it.key, mode: it.mode, meta: (one.body && one.body.meta) || {} });
  }
  return out;
}

function python() {
  for (const exe of process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']) {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return exe;
  }
  return null;
}

// settings.json as 0.2.6 wrote it: share 'on' was its default, never an answer.
const S026 = { hotkey: 'RightAlt', sounds: true, mic: '', micLabel: '', keepRecordings: true, startAtLogin: true, showInDock: false, sharePaused: false,
  share: 'on', flagHotkey: '', modelVariant: 'auto', askBeforeModelDownload: false, lowMemory: 'auto', walkthrough: 'done' };
// Recordings 0.2.5-0.2.6 kept a day before the cutoff (2026-10-18 15:00 UTC): this install was first started before it.
const PAST = [0, 1, 2].map((i) => ({ name: '2026-10-17T1' + i + '-04-05-120Z', text: 'past dictation ' + i + ' from 0.2.6' }));

(async () => {
  console.log('Sharing end to end: a public packaged build, its profiles, the real Worker (wrangler dev --local)');
  let base;
  try {
    base = await startWorker();
  } catch (err) {
    console.log(String(err.message).slice(0, 1500));
    skip('wrangler dev did not start here (see above)');
  }
  console.log('  Worker: ' + base);

  section('a fresh install, not answered yet: nothing is shared');
  const f = runApp(base, 'fresh', { actions: ['dictate'], text: 'never to be shared' });
  check('no tester.json in the resources folder (as public-build.js verifies)', !fs.existsSync(path.join(f.resources, 'tester.json')));
  check('public mode; not answered ("ask"): off, the walkthrough asks (no small screen)', f.mode === 'beta' && f.share === 'ask' && f.shareAsk === 'done' &&
    f.status && f.status.state === 'off' && f.status.choice === 'ask', f);
  check('not one request, not even enrollment; nothing waits, no key', f.requests.length === 0 && f.waiting === 0 && !f.key, { requests: f.requests, waiting: f.waiting, key: f.key });
  check('the life log says why: not chosen yet', f.life.some((l) => /sharing: at launch: public build, not chosen yet \(off\); not enrolled yet/.test(l)) &&
    f.life.some((l) => /sharing: not queued: sharing not chosen yet/.test(l)), f.life);
  check('the automatic backfill: not for a fresh install, and remembered', f.life.some((l) => /backfill: past dictations: not sent by itself: a fresh install/.test(l)), f.life);

  section('a fresh install answers Share: enrolled, the dictation uploads');
  const text = 'Typd share e2e synthetic dictation ' + crypto.randomBytes(3).toString('hex');
  const a = runApp(base, 'share', { actions: ['share', 'dictate'], uploads: 1, text });
  check('Share: on', a.answers[0] && a.answers[0].ok && a.answers[0].enrolled === true && a.shareAfter === 'on' && a.after.state === 'on', a.answers);
  const enroll = a.requests.filter((r) => r.path === '/v1/enroll');
  const upload = a.requests.filter((r) => r.path === '/v1/upload');
  check('enrolls at the answer: POST /v1/enroll 201, once', enroll.length === 1 && enroll[0].status === 201, a.requests);
  check('the dictation uploads: POST /v1/upload 201', upload.length === 1 && upload[0].status === 201, a.requests);
  check('every request went to the built-in endpoint (typd-collect.mehmetdedeler.com)', a.requests.every((r) => r.host === new URL(PROD).host), a.requests);
  check('share.json: the production endpoint, an i- id and a key', a.key && a.key.endpoint === PROD && /^i-[0-9a-f]{20}$/.test(a.key.id) && a.key.hasKey, a.key);
  check('the outbox is empty', a.waiting === 0, a.waiting);
  const id = a.key && a.key.id;

  section('the server');
  const installs = await admin(base, '/v1/admin/installs');
  const inst = installs.body && (installs.body.installs || []).find((i) => i.id === id);
  check('GET /v1/admin/installs lists it, with this app version', Boolean(inst) && inst.appVersion === VERSION, installs);
  const items = await itemsOf(base, id);
  check('GET /v1/list: one item under it, a dictation', items.length === 1 && items[0].mode === 'dictate', items);
  if (items[0]) {
    const meta = items[0].meta;
    check("the item: consent 'all', the text, this app version and OS, pasted", meta.consent === 'all' && meta.output === text && meta.appVersion === VERSION &&
      meta.os && meta.os.platform === process.platform && meta.pasted === true, meta);
    check('the item carries no screen context, span or title', !['context', 'contextBlock', 'span', 'selection', 'title', 'screen'].some((k) => k in meta), Object.keys(meta));
    check('the item carries no program name (0.2.12): no "app", "notepad" nowhere in it', !('app' in meta) && !JSON.stringify(meta).includes('notepad'), meta);
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
  check('the life log: at launch (not chosen yet), answered share, enrolled, queued, sent', /sharing: at launch: public build, not chosen yet \(off\); not enrolled yet/.test(said) &&
    /sharing: answered: share/.test(said) && said.includes('sharing: enrolled: ' + id) && /sharing: queued/.test(said) && /sharing: sent: 1 this run/.test(said), a.life);
  check('diagnostics(): enrolled, nothing waiting, 1 queued and 1 sent', a.diagnostics.includes('enrolled ' + id) && /0 waiting/.test(a.diagnostics) && /1 queued, 1 sent/.test(a.diagnostics), a.diagnostics);
  check('no key in the life log or diagnostics', !/ik_[A-Za-z0-9_-]{20,}/.test(said + a.diagnostics));

  section("a fresh install answers Don't share");
  const n = runApp(base, 'dont', { actions: ['dontshare', 'dictate'], text: 'not to be shared' });
  check("off, not one request (nothing to delete), nothing waits, no key", n.shareAfter === 'off' && n.after.state === 'off' && n.requests.length === 0 && n.waiting === 0 && !n.key, n);

  section('an update from 0.2.6, first started before the old cutoff, never chose: asked; nothing goes until Share');
  const u0 = runApp(base, 'before', { settings: S026, recordings: PAST, actions: ['dictate', 'copied'], text: 'before the answer' });
  check("asked: not answered ('ask'), the small screen due, off -- 0.2.7-0.2.11 kept this one on without asking", u0.share === 'ask' && u0.shareAsk === 'due' &&
    u0.shareChosen === false && u0.status.state === 'off' && u0.status.choice === 'ask', { share: u0.share, shareAsk: u0.shareAsk, shareChosen: u0.shareChosen, status: u0.status });
  check('not answered: not one request, nothing queued, no key', u0.requests.length === 0 && u0.waiting === 0 && !u0.key, { requests: u0.requests, waiting: u0.waiting, key: u0.key });
  check('no automatic backfill before an answer (it waits: nothing decided, nothing sent)', u0.status.backfill && u0.status.backfill.state === 'none' && !u0.status.backfill.auto &&
    u0.life.some((l) => /sharing: not queued: sharing not chosen yet/.test(l)), { bf: u0.status.backfill, life: u0.life });
  const u = runApp(base, 'before', { actions: ['share', 'copied'], uploads: 4, text: 'copied, not pasted ' + crypto.randomBytes(3).toString('hex') });
  check('Share at the next launch: on, recorded as a choice, enrolled', u.answers[0] && u.answers[0].ok && u.answers[0].enrolled === true && u.shareAfter === 'on' &&
    u.shareChosenAfter === true, { answers: u.answers, share: u.shareAfter, chosen: u.shareChosenAfter });
  const uid = u.key && u.key.id;
  const uItems = await itemsOf(base, uid);
  const past = uItems.filter((x) => x.meta.backfill === true);
  check('then, and only then, the automatic backfill ran once: the 3 recordings kept under 0.2.6 reached the Worker', past.length === 3 &&
    PAST.every((p) => past.some((x) => x.meta.output === p.text && x.meta.consent === 'all' && x.meta.keptAt)), uItems.map((x) => x.meta.output));
  check('the past dictations carry no screen context and no program name (their .json has both)', !uItems.some((x) => JSON.stringify(x.meta).includes('NEVER-SENT-CONTEXT')) &&
    !past.some((x) => 'app' in x.meta || JSON.stringify(x.meta).includes('notepad')), past.map((x) => Object.keys(x.meta)));
  check('nothing from before the answer went (the dictation and the copy made while it was not answered)', !uItems.some((x) => x.meta.output === 'before the answer' ||
    x.meta.output === 'before the answer (copied)'), uItems.map((x) => x.meta.output));
  const copied = uItems.find((x) => x.meta.pasted === false);
  check('a dictation whose paste fell back to the clipboard is shared: pasted false, copiedAt, no pastedAt', copied && copied.meta.copiedAt && copied.meta.pastedAt === null &&
    /^copied, not pasted /.test(copied.meta.output), copied && copied.meta);
  check('the life log says so: sending them once, by itself', u.life.some((l) => /backfill: past dictations: sending them once, by itself \(3 kept recordings; this install never shared\)/.test(l)), u.life);
  check('... and done', u.after.backfill && u.after.backfill.state === 'done' && u.after.backfill.by === 'auto' && u.after.backfill.sent === 3, u.after.backfill);
  const u2 = runApp(base, 'before', {});   // its next launch
  check('the next launch: on, not asked again, the backfill not again, not one request', u2.share === 'on' && u2.shareChosen === true && u2.requests.length === 0 &&
    u2.status.backfill.state === 'done' && u2.life.filter((l) => /past dictations: sending them once/.test(l)).length === 1, { share: u2.share, requests: u2.requests, bf: u2.status.backfill });
  for (const [label, s] of [['no share key', (() => { const x = { ...S026 }; delete x.share; return x; })()], ["share ''", { ...S026, share: '' }]]) {
    const v = runApp(base, 'before-' + label.replace(/\W+/g, '-'), { settings: s, recordings: PAST.slice(0, 1), actions: ['dictate'] });
    check('before the old cutoff, ' + label + ': asked, not one request', v.share === 'ask' && v.shareAsk === 'due' && v.status.state === 'off' && v.requests.length === 0,
      { share: v.share, shareAsk: v.shareAsk, requests: v.requests });
  }

  section("0.2.7-0.2.11's 'on' (kept without asking), an item 0.2.11 queued still waiting: asked; it goes only after Share, without the program's name");
  const OLD = { name: '20261026T101010Z-0123456789abcdef', meta: { v: 1, id: '0123456789abcdef', createdAt: '2026-10-26T10:10:10.000Z', mode: 'dictate', output: 'queued by 0.2.11',
    outputChars: 16, model: 'r24_1p7b-q4_k_m.gguf', engine: 'local', app: 'Discord', audioSeconds: 1, pasted: true, appVersion: '0.2.11', consent: 'all' } };
  const x0 = runApp(base, 'exempt', { settings: { ...S026, shareAsk: 'done' }, outbox: [OLD], actions: ['dictate'], text: 'not answered yet' });
  check("asked ('ask', due), off; not one request; the old item still waits, nothing new queued", x0.share === 'ask' && x0.shareAsk === 'due' && x0.status.state === 'off' &&
    x0.requests.length === 0 && x0.waiting === 1, { share: x0.share, shareAsk: x0.shareAsk, requests: x0.requests, waiting: x0.waiting });
  const x1 = runApp(base, 'exempt', { actions: ['share'], uploads: 1 });
  const xid = x1.key && x1.key.id;
  const xItems = await itemsOf(base, xid);
  const xOld = xItems.find((x) => x.meta.output === 'queued by 0.2.11');
  check('Share: the old item reached the Worker without "app" ("Discord" nowhere in it), its other fields kept', Boolean(xOld) && !('app' in xOld.meta) &&
    !JSON.stringify(xOld.meta).includes('Discord') && xOld.meta.appVersion === '0.2.11' && xOld.meta.consent === 'all' && xItems.length === 1, xItems.map((x) => x.meta));
  check('the Worker accepted it (POST /v1/upload 201)', x1.requests.some((r) => r.path === '/v1/upload' && r.status === 201) && x1.waiting === 0, x1.requests);

  section("an explicit 'on' (0.2.12 recorded the choice), first started before the old cutoff: not asked, shares");
  const e = runApp(base, 'chosen', { settings: { ...S026, shareAsk: 'done', shareChosen: true }, actions: ['dictate'], uploads: 1, text: 'chosen before ' + crypto.randomBytes(3).toString('hex') });
  check("on, no screen (shareAsk done, 'on' kept)", e.share === 'on' && e.shareAsk === 'done' && e.shareChosen === true && e.status.state === 'on', { share: e.share, shareAsk: e.shareAsk, status: e.status });
  const eid = e.key && e.key.id;
  const eItems = await itemsOf(base, eid);
  check('its dictation reached the Worker, without a program name', eItems.length === 1 && !('app' in eItems[0].meta) && !JSON.stringify(eItems[0].meta).includes('notepad'), eItems.map((x) => x.meta));

  section("sharing turned off ('off'): off, whatever else");
  const b = runApp(base, 'off', { settings: { ...S026, share: 'off' }, recordings: PAST, actions: ['dictate', 'copied'], text: 'not to be shared' });
  check('state off, no screen', b.share === 'off' && b.shareAsk === 'done' && b.status && b.status.state === 'off', b.status);
  check('not one request, not even enrollment; nothing waits, no key', b.requests.length === 0 && b.waiting === 0 && !b.key, { requests: b.requests, waiting: b.waiting, key: b.key });
  check('the life log says why, and no automatic backfill', b.life.some((l) => /sharing: not queued: sharing is off/.test(l)) &&
    b.life.some((l) => /backfill: past dictations: not sent by itself: sharing is off/.test(l)), b.life);

  section('shared under 0.2.6 by default, never chose: asked; Don\'t share deletes it');
  // 0.2.6's run: on by default, one dictation shared (a settings file that shares, standing in for that default).
  const p1 = runApp(base, 'after', { settings: { ...S026, shareAsk: 'done', shareChosen: true }, actions: ['dictate'], uploads: 1, text: 'shared under 0.2.6 by default' });
  const pid = p1.key && p1.key.id;
  check('under 0.2.6: enrolled, one item on the Worker', Boolean(pid) && (await itemsOf(base, pid)).length === 1);
  // The update to 0.2.12: settings.json as 0.2.6 wrote it again (no shareAsk, no shareChosen), and no
  // ledger of the automatic backfill (0.2.6 had none).
  fs.writeFileSync(path.join(p1.appData, 'typd', 'settings.json'), JSON.stringify(S026));
  fs.rmSync(path.join(p1.userData, 'backfill.json'), { force: true });
  const p2 = runApp(base, 'after', { actions: ['dictate'], text: 'after the update, not answered' });
  check("the first 0.2.12 launch: not answered ('ask'), the small screen due, off", p2.share === 'ask' && p2.shareAsk === 'due' && p2.status.state === 'off' && p2.status.shared === true, { share: p2.share, shareAsk: p2.shareAsk, status: p2.status });
  check('not answered: nothing queued, not one request', p2.requests.length === 0 && p2.waiting === 0, p2.requests);
  check('no automatic backfill before an answer (it waits: nothing decided)', p2.status.backfill && p2.status.backfill.state === 'none' && !p2.status.backfill.auto, p2.status.backfill);
  const p3 = runApp(base, 'after', { actions: ['dontshare', 'dictate'], text: 'after Don\'t share' });
  const del = p3.requests.filter((r) => r.path === '/v1/me' && r.method === 'DELETE');
  check("Don't share: DELETE /v1/me, 200", del.length === 1 && del[0].status === 200, p3.requests);
  check('the Worker holds nothing for it now', (await itemsOf(base, pid)).length === 0);
  check('off, the key forgotten, the outbox empty, nothing else sent', p3.shareAfter === 'off' && !p3.key && p3.waiting === 0 &&
    p3.requests.every((r) => r.path === '/v1/me'), { share: p3.shareAfter, key: p3.key, requests: p3.requests });
  check("the answer says it deleted what was shared", p3.answers[0] && p3.answers[0].ok && p3.answers[0].deletedShared === true && p3.answers[0].deleted === 1, p3.answers);
  const p4 = runApp(base, 'after', {});
  check("the next launch: off, recorded as a choice, not asked again, not one request", p4.share === 'off' && p4.shareChosen === true && p4.requests.length === 0, { share: p4.share, chosen: p4.shareChosen, requests: p4.requests });

  section('never chose, nothing ever shared: asked; Don\'t share sends nothing');
  const q = runApp(base, 'after-none', { settings: S026, actions: ['dontshare'] });
  check("asked ('ask', due); Don't share: off, not one request", q.share === 'ask' && q.shareAsk === 'due' && q.shareAfter === 'off' && q.requests.length === 0, { share: q.share, shareAsk: q.shareAsk, after: q.shareAfter, requests: q.requests });

  const after = await admin(base, '/v1/admin/installs');
  const ids = ((after.body && after.body.installs) || []).map((i) => i.id);
  check('the server: the four installs that chose Share (and not the deleted one)', [id, uid, xid, eid].every((i) => i && ids.includes(i)) && !ids.includes(pid) && ids.length === 4, ids);
  const every = await itemsOf(base, null);
  check('no item on the Worker carries a program name ("app")', every.length === 7 && every.every((x) => !('app' in x.meta)), every.filter((x) => 'app' in x.meta).map((x) => x.key));

  stopWorker();
  console.log('\n' + (failures ? failures + ' FAILED' : 'all share-e2e checks passed'));
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.log('share-e2e error: ' + (err && err.stack || err));
  stopWorker();
  process.exit(1);
});
