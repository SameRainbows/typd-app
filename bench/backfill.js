'use strict';

/**
 * Past dictations, shared once (src/main/backfill.js), headless: sharing.js, collect.js and
 * backfill.js against a fake typd-collect and a fake kept-recordings folder.
 *
 *   node bench/backfill.js
 *
 *   - what goes: every kept recording with text that the server does not hold yet; not a revision
 *     the guards refused, not one shared live already (the server has an item a moment after it),
 *     not one waiting in the outbox, not a broken file; the text from History when its .json lost it
 *   - what an item carries: audio, text (none for a revision), mode, model, app, backfill and
 *     keptAt -- never the screen context or the highlighted span the recording's .json holds
 *   - never twice: a second run sends nothing; with the ledger lost, the server's list (and its
 *     key, the same name each time) still keeps it at one copy
 *   - resume after an interruption: a run cut off half way finishes after a restart, no copies
 *   - paced: at most OUTBOX_MAX + 1 items wait in the outbox at once
 *   - public builds: the daily limit holds, with room left for live dictations; the next day goes on
 *   - never while sharing is off (a tester's pause waits; a public 'off' cancels), never after
 *     "Delete what I've shared"; the server's request starts it once
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { createSharing } = require('../src/main/sharing');
const { createBackfill, itemId, keptAt, OUTBOX_MAX } = require('../src/main/backfill');
const { encodeWav } = require('../src/main/collect');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + JSON.stringify(detail).slice(0, 500) : ''));
}
const section = (s) => console.log('\n' + s);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-backfill-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await sleep(50); }
  return Boolean(await cond());
}

/* ------------------------------------------------------- a fake typd-collect */

function fakeServer() {
  const s = { items: new Map(), bodies: [], testerKeys: new Map([['tk_tester_key_0123456789', 'tester_a']]), keys: new Map(),
    backfillFor: new Set(), uploadStatus: null, requests: [] };
  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const who = (req) => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    return m ? s.testerKeys.get(m[1]) || s.keys.get(m[1]) || null : null;
  };
  const stampOf = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  s.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      s.requests.push(req.method + ' ' + req.url);
      if (req.method === 'POST' && req.url === '/v1/enroll') {
        const n = s.keys.size + 1, key = 'ik_' + 'k'.repeat(40) + n, id = 'i-' + String(n).padStart(20, '0');
        s.keys.set(key, id);
        return send(res, 201, { key, id });
      }
      const w = who(req);
      if (!w) return send(res, 401, { error: 'unauthorized' });
      if (req.method === 'GET' && req.url === '/v1/me') return send(res, 200, { backfill: s.backfillFor.has(w) });
      if (req.method === 'GET' && req.url === '/v1/me/items') {
        if (!s.backfillFor.has(w)) return send(res, 403, { error: 'not asked' });
        return send(res, 200, { names: [...s.items.keys()].filter((k) => k.startsWith(w + '/')).map((k) => k.slice(w.length + 1)) });
      }
      if (req.method === 'POST' && req.url === '/v1/upload') {
        if (s.uploadStatus) return send(res, s.uploadStatus, { error: 'later' });
        const text = body.toString('latin1');
        s.bodies.push(text);
        const meta = JSON.parse(/name="meta"\r\n\r\n([\s\S]*?)\r\n--/.exec(text)[1]);
        const key = w + '/' + stampOf(meta.createdAt) + '-' + meta.id;   // as typd-collect: the same name overwrites
        s.items.set(key, meta);
        return send(res, 201, { ok: true, key });
      }
      send(res, 404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => { s.endpoint = 'http://127.0.0.1:' + s.server.address().port; resolve(s); }));
}

/* --------------------------------------------- a fake kept-recordings folder */

const recName = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');
function keep(dir, ms, meta, { wav = true, broken = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const name = recName(ms);
  const samples = new Float32Array(16000).map((_, i) => Math.sin(i / 7) * 0.2);
  if (wav) fs.writeFileSync(path.join(dir, name + '.wav'), broken ? Buffer.from('not a wav') : encodeWav(samples));
  if (meta) fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(meta));
  return name;
}
const T0 = Date.parse('2026-10-05T09:00:00.000Z');
const SECRET_CONTEXT = 'CONTEXT-FROM-ANOTHER-APP-7731';
const SECRET_SPAN = 'HIGHLIGHTED-SPAN-TEXT-9124';
const baseMeta = (extra) => ({ mode: 'dictate', output: 'hello there', seconds: 1, ms: 420, model: 'r24_1p7b-q4_k_m.gguf', app: 'notes', context: SECRET_CONTEXT, span: null, ...extra });

function setup(label, { tester = true, daily, now } = {}) {
  const root = path.join(tmp, label);
  const userData = path.join(root, 'userData');
  const recDir = path.join(root, 'recordings');
  fs.mkdirSync(userData, { recursive: true });
  const state = { share: 'on', paused: false };
  return { root, userData, recDir, state, make: (server, opts = {}) => {
    const sharing = createSharing({
      tester: tester ? { tester: 'tester_a', endpoint: server.endpoint, key: 'tk_tester_key_0123456789', with: 'the developer' } : null,
      endpoint: server.endpoint, keyFile: path.join(userData, 'share.json'), dir: path.join(userData, 'outbox'),
      choice: { get: () => state.share, set: (v) => { state.share = v; } }, paused: () => state.paused,
      about: { appVersion: '0.2.4' }, daily, now: now || Date.now,
      onOff: () => bf.cancel(), onDeleted: () => bf.forbid()
    });
    const bf = createBackfill({ dir: recDir, ledgerFile: path.join(userData, 'backfill.json'), sharing: sharing.backfillPort(),
      history: opts.history || (() => []), tickMs: 30, firstMs: 10, now: now || Date.now });
    sharing.start();
    return { sharing, bf };
  } };
}

const backfilled = (server) => [...server.items.values()].filter((m) => m.backfill === true);

(async () => {
  const server = await fakeServer();

  section('a tester: what goes, what carries, what never goes');
  {
    const S = setup('tester');
    const r1 = keep(S.recDir, T0, baseMeta({ output: 'the first one' }));
    const r2 = keep(S.recDir, T0 + 60e3, baseMeta({ output: 'shared live' }));
    // r2 was shared live: the server holds an item made 1.2 s after it was kept.
    server.items.set('tester_a/' + new Date(T0 + 61.2e3).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-aaaaaaaaaaaaaaaa', { live: true });
    const r3 = keep(S.recDir, T0 + 120e3, baseMeta({ mode: 'revise', guard: 'deleted too much', output: 'refused' }));
    const r4 = keep(S.recDir, T0 + 180e3, baseMeta({ mode: 'revise', output: 'the rewrite of ' + SECRET_SPAN, span: SECRET_SPAN }));
    const r5 = keep(S.recDir, T0 + 240e3, { mode: 'dictate', seconds: 1, ms: 300, model: 'm.gguf', app: 'mail' });   // its text lost
    const r7 = keep(S.recDir, T0 + 300e3, baseMeta({}), { broken: true });
    const r8 = keep(S.recDir, T0 + 360e3, null);   // a .wav with no .json and nothing in History
    const history = () => [{ at: new Date(T0 + 240e3 + 900).toISOString(), mode: 'dictate', text: 'text from history' }];
    server.backfillFor.add('tester_a');
    const { sharing, bf } = S.make(server, { history });
    const asked = await sharing.asks();
    check('GET /v1/me: the server asks this tester for past dictations', asked && asked.backfill === true, asked);
    const r = await bf.request('server');
    check('the server request starts a run', r.ok && r.state === 'running', r);
    await until(() => bf.status().state === 'done' && server.items.size >= 4);
    await until(async () => (await sharing.pending()) === 0);
    const sent = backfilled(server);
    const kept = sent.map((m) => m.keptAt).sort();
    check('three go: the first, the revision (its audio), the one whose text came from History',
      kept.join() === [T0, T0 + 180e3, T0 + 240e3].map((t) => new Date(t).toISOString()).join(), kept);
    check('not the one shared live, not the refused revision, not the broken or text-less files',
      !kept.includes(new Date(T0 + 60e3).toISOString()) && !kept.includes(new Date(T0 + 120e3).toISOString()) &&
      !kept.includes(new Date(T0 + 300e3).toISOString()) && !kept.includes(new Date(T0 + 360e3).toISOString()));
    const first = sent.find((m) => m.keptAt === new Date(T0).toISOString());
    check('an item carries text, mode, model, app, backfill and keptAt, and the time of its recording',
      first && first.output === 'the first one' && first.mode === 'dictate' && first.model === 'r24_1p7b-q4_k_m.gguf' && first.app === 'notes' &&
      first.createdAt === new Date(T0).toISOString() && first.id === itemId(r1) && first.tester === 'tester_a', first);
    const rev = sent.find((m) => m.mode === 'revise');
    check('a revision carries no text (only its spoken instruction)', rev && rev.output === null && rev.outputChars > 0, rev);
    check('from History when its .json lost the text', sent.some((m) => m.output === 'text from history'));
    const all = server.bodies.join('\n');
    check('never the screen context or the highlighted span, in any request', !all.includes(SECRET_CONTEXT) && !all.includes(SECRET_SPAN) && !/"context"|"span"/.test(all));
    const led = JSON.parse(fs.readFileSync(path.join(S.userData, 'backfill.json'), 'utf8'));
    check('the ledger: done, every recording accounted for', led.state === 'done' && Object.keys(led.sent).length === 7 && led.skipped === 4, led);
    void r2; void r3; void r7; void r8;

    section('never twice');
    const before = server.items.size, bodies = server.bodies.length;
    const again = await bf.request('server');
    check('the server asking again after it is done: nothing', again.state === 'done' && bf.status().state === 'done');
    await bf.request('settings');
    await until(() => bf.status().state === 'done');
    await sleep(300);
    check('Settings again: everything is in the ledger, nothing sent', server.items.size === before && server.bodies.length === bodies);
    // The ledger lost: the server's list says what it holds.
    fs.unlinkSync(path.join(S.userData, 'backfill.json'));
    sharing.stop && sharing.stop();
    const fresh = S.make(server, { history });
    await fresh.bf.request('settings');
    await until(() => fresh.bf.status().state === 'done');
    await sleep(2500);
    check('ledger lost: the server list keeps it at one copy each', server.items.size === before && backfilled(server).length === 3, [server.items.size, before]);
    const keys = [...server.items.keys()].filter((k) => server.items.get(k).backfill);
    check('each past dictation has one fixed key (its time and an id from its file name)', new Set(keys).size === 3 && keys.every((k) => /-[0-9a-f]{16}$/.test(k)));
  }

  section('resume after an interruption');
  {
    const S = setup('resume');
    const names = [];
    for (let i = 0; i < 10; i++) names.push(keep(S.recDir, T0 + 86400e3 + i * 30e3, baseMeta({ output: 'item ' + i })));
    server.backfillFor.add('tester_a');
    const a = S.make(server);
    await a.bf.request('settings');
    await until(() => a.bf.status().sent >= 3);
    a.bf.stop();   // cut off: Typd quit or crashed here
    const sentBefore = a.bf.status().sent;
    const b = S.make(server);   // the next launch, same folders
    b.bf.resume();
    await until(() => b.bf.status().state === 'done');
    await until(async () => (await b.sharing.pending()) === 0);
    const got = backfilled(server).filter((m) => /^item \d$/.test(m.output));
    check('cut off after ' + sentBefore + ', resumed: all 10 on the server, once each', got.length === 10 && new Set(got.map((m) => m.keptAt)).size === 10, got.length);
  }

  section('paced: a slow server never sees a flood');
  {
    const S = setup('paced');
    for (let i = 0; i < 8; i++) keep(S.recDir, T0 + 2 * 86400e3 + i * 30e3, baseMeta({ output: 'slow ' + i }));
    server.uploadStatus = 503;
    const { bf, sharing } = S.make(server);
    await bf.request('settings');
    let most = 0;
    const end = Date.now() + 2500;
    while (Date.now() < end) { most = Math.max(most, await sharing.pending()); await sleep(40); }
    check('at most OUTBOX_MAX + 1 wait in the outbox while the server refuses (' + most + ')', most > 0 && most <= OUTBOX_MAX + 1, most);
    server.uploadStatus = null;
    sharing.wake(10);
    await until(() => bf.status().state === 'done', 60000);
    await until(async () => (await sharing.pending()) === 0, 30000);
    check('and all of them go once it answers', backfilled(server).filter((m) => /^slow /.test(m.output)).length === 8,
      backfilled(server).filter((m) => /^slow /.test(m.output)).length);
  }

  section('a public build: the daily limit, with room for live dictations');
  {
    let clock = Date.parse('2026-10-18T08:00:00Z');
    const S = setup('public', { tester: false, daily: { items: 13, bytes: 100e6, file: path.join(tmp, 'public', 'userData', 'share-day.json') }, now: () => clock });
    for (let i = 0; i < 6; i++) keep(S.recDir, T0 + 3 * 86400e3 + i * 30e3, baseMeta({ output: 'public ' + i }));
    const { bf, sharing } = S.make(server);
    await sharing.choose('on');   // enrolled
    const id = [...server.keys.values()].pop();
    server.backfillFor.add(id);
    const asked = await sharing.asks();
    check('GET /v1/me with an install key: asked', asked && asked.backfill === true);
    await bf.request('server');
    await sleep(1500);
    await until(async () => (await sharing.pending()) === 0, 10000);
    await sleep(500);
    const day1 = backfilled(server).filter((m) => /^public /.test(m.output)).length;
    check('day one: 3 queued (13 a day, 10 left for live dictations)', day1 === 3, day1);
    check('each with consent all and its install', backfilled(server).filter((m) => /^public /.test(m.output)).every((m) => m.consent === 'all'));
    clock += 86400e3;
    await until(() => bf.status().state === 'done', 15000);
    await until(async () => (await sharing.pending()) === 0, 10000);
    check('the next day it goes on and finishes', backfilled(server).filter((m) => /^public /.test(m.output)).length === 6);
  }

  section('never while sharing is off, never after a delete');
  {
    const S = setup('off', { tester: false });
    for (let i = 0; i < 4; i++) keep(S.recDir, T0 + 4 * 86400e3 + i * 30e3, baseMeta({ output: 'off ' + i }));
    const { bf, sharing } = S.make(server);
    S.state.share = 'off';
    const r = await bf.request('settings');
    check('sharing off: refused, nothing queued', !r.ok && r.reason === 'sharing is off' && (await sharing.pending()) === 0, r);
    S.state.share = 'on';
    await bf.request('settings');
    await sharing.choose('off');
    await sleep(300);
    check('turned off during a run: cancelled', bf.status().state === 'cancelled');
    check('the server asking after a cancel: nothing', (await bf.request('server')).state === 'cancelled' && bf.status().state === 'cancelled');
    S.state.share = 'on';
    await sharing.deleteShared();
    check('"Delete what I\'ve shared": never', bf.status().state === 'never');
    S.state.share = 'on';
    const after = await bf.request('settings');
    check('... not from Settings either', !after.ok && after.state === 'never');
    check('... nor the server', !(await bf.request('server')).ok);
    check('nothing of these went', !backfilled(server).some((m) => /^off /.test(m.output)));
  }

  section('a tester\'s pause waits');
  {
    const S = setup('pause');
    for (let i = 0; i < 2; i++) keep(S.recDir, T0 + 5 * 86400e3 + i * 30e3, baseMeta({ output: 'pause ' + i }));
    const { bf } = S.make(server);
    await bf.request('settings');
    S.state.paused = true;
    await sleep(400);
    const during = backfilled(server).filter((m) => /^pause /.test(m.output)).length;
    S.state.paused = false;
    await until(() => bf.status().state === 'done');
    await sleep(2500);
    check('paused: waits (' + during + ' sent), resumed: done', during <= 1 && backfilled(server).filter((m) => /^pause /.test(m.output)).length === 2);
  }

  section('the recording names');
  check('keptAt reads index.js file names', keptAt('2026-10-04T07-31-36-486Z') === Date.parse('2026-10-04T07:31:36.486Z'));
  check('anything else is not a recording', Number.isNaN(keptAt('notes.json')) && Number.isNaN(keptAt('2026-10-04T07-31-36Z')));

  server.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + (failures ? failures + ' FAILED' : 'all backfill checks passed') + '\n');
  process.exit(failures ? 1 : 0);
})();
