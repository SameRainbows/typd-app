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
 *   - the automatic run (0.2.7, autoOnce): once, for a public install that shares and never shared,
 *     against a server that will not list its items (403, as typd-collect answers a key it did not
 *     ask): every recording kept before it began, not the live item that waited in the outbox, not
 *     one kept since; decided once and remembered -- not again on the next launch, not when off, after
 *     a delete, when the install shared before, with no recordings; waits while not answered
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
    backfillFor: new Set(), uploadStatus: null, enrollDown: false, requests: [] };
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
        if (s.enrollDown) return send(res, 503, { error: 'busy' });
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
const MARK_CONTEXT = 'CONTEXT-FROM-ANOTHER-APP-7731';
const MARK_SPAN = 'HIGHLIGHTED-SPAN-TEXT-9124';
const baseMeta = (extra) => ({ mode: 'dictate', output: 'hello there', seconds: 1, ms: 420, model: 'r24_1p7b-q4_k_m.gguf', app: 'notes', context: MARK_CONTEXT, span: null, ...extra });

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
    const r4 = keep(S.recDir, T0 + 180e3, baseMeta({ mode: 'revise', output: 'the rewrite of ' + MARK_SPAN, span: MARK_SPAN }));
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
    check('never the screen context or the highlighted span, in any request', !all.includes(MARK_CONTEXT) && !all.includes(MARK_SPAN) && !/"context"|"span"/.test(all));
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

  section('the automatic run (0.2.7): once, for a public install that shares and never shared');
  {
    const S = setup('auto', { tester: false });
    const OLD = T0 + 6 * 86400e3;
    for (let i = 0; i < 4; i++) keep(S.recDir, OLD + i * 30e3, baseMeta({ output: 'auto ' + i }));
    keep(S.recDir, OLD + 200e3, baseMeta({ mode: 'revise', guard: 'deleted too much', output: 'refused' }));
    // 0.2.6 queued one live dictation that never went (no key yet: it never reached the server).
    const a = S.make({ endpoint: 'http://127.0.0.1:9' });
    const liveAt = Date.now() - 1500;
    const liveName = keep(S.recDir, liveAt, baseMeta({ output: 'live, waiting' }));
    a.sharing.add({ samples: new Float32Array(16000), sampleRate: 16000, text: 'live, waiting', mode: 'dictate', endedAt: liveAt - 400, pastedAt: liveAt + 300 });
    await until(async () => (await a.sharing.pending()) === 1);
    a.bf.stop();
    const before = server.items.size;

    // The first launch of 0.2.7.
    const b = S.make(server);
    check('never shared (no key): it is for this install', b.sharing.autoBackfillWhy() === null);
    const r = await b.bf.autoOnce(() => b.sharing.autoBackfillWhy());
    check('decided and started: by itself, 6 kept recordings', r.decided && r.ran && r.recordings === 6 && b.bf.status().state === 'running' && b.bf.status().by === 'auto', r);
    // Kept after it began: shared live, so never by the run.
    const lateName = keep(S.recDir, Date.now() + 5000, baseMeta({ output: 'kept after the start' }));
    await until(() => b.bf.status().state === 'done', 30000);
    await until(async () => (await b.sharing.pending()) === 0, 20000);
    await sleep(300);
    const got = backfilled(server).filter((m) => /^auto \d$/.test(m.output) || m.output === 'live, waiting' || m.output === 'kept after the start');
    check('the server would not list its items (403), and the run went on: all 4 past dictations went', got.filter((m) => /^auto /.test(m.output)).length === 4, got.map((m) => m.output));
    check('not the live item that waited in the outbox (it went live, once), not the one kept since, not the refused revision',
      !got.some((m) => m.output === 'live, waiting' || m.output === 'kept after the start') &&
      [...server.items.values()].filter((m) => m.output === 'live, waiting').length === 1 && !backfilled(server).some((m) => m.output === 'refused'),
      [...server.items.values()].map((m) => m.output + (m.backfill ? ' (backfill)' : '')));
    check('each with consent all, backfill true, its keptAt', got.every((m) => m.consent === 'all' && m.backfill === true && m.keptAt), got[0]);
    check('enrolled once (by the run), nothing else new on the server', [...server.keys.values()].length >= 1 && server.items.size === before + 5, server.items.size - before);
    const led = JSON.parse(fs.readFileSync(path.join(S.userData, 'backfill.json'), 'utf8'));
    check('the ledger remembers it: auto ran, done', led.auto && led.auto.ran === true && led.state === 'done' && led.by === 'auto', led.auto);
    void liveName; void lateName;

    // The next launch: never again.
    const c = S.make(server);
    const r2 = await c.bf.autoOnce(() => c.sharing.autoBackfillWhy());
    await sleep(300);
    check('the second launch: decided before, nothing new', !r2.decided && c.bf.status().state === 'done' && server.items.size === before + 5, r2);
  }
  {
    const cases = [
      ['sharing off', (S) => { S.state.share = 'off'; }, 'sharing is off'],
      ['the install shared before (a key at launch)', async (S, server) => { const x = S.make(server); await x.sharing.choose('on'); x.bf.stop(); }, 'this install has shared before'],
      ['"Delete what I\'ve shared" before', async (S, server) => { const x = S.make(server); await x.sharing.deleteShared(); x.bf.stop(); S.state.share = 'on'; }, 'this install deleted what it shared'],
      ['no kept recordings', (S) => { fs.rmSync(S.recDir, { recursive: true, force: true }); }, 'no kept recordings']
    ];
    for (const [label, prep, why] of cases) {
      const S = setup('auto-no-' + label.replace(/[^a-z]+/gi, '-'), { tester: false });
      keep(S.recDir, T0 + 7 * 86400e3, baseMeta({ output: 'never ' + label }));
      await prep(S, server);
      const x = S.make(server);
      const r = await x.bf.autoOnce(() => x.sharing.autoBackfillWhy());
      check(label + ': not run, and remembered ("' + why + '")', r.decided && !r.ran && r.why === why && x.bf.status().auto && x.bf.status().auto.ran === false, r);
      S.state.share = 'on';
      const y = S.make(server);
      const r2 = await y.bf.autoOnce(() => y.sharing.autoBackfillWhy());
      await sleep(200);
      check(label + ': not on a later launch either, sharing on or not', !r2.decided && y.bf.status().state !== 'running' && !backfilled(server).some((m) => m.output === 'never ' + label), r2);
      x.bf.stop(); y.bf.stop();
    }
  }
  {
    // Not answered yet (an install from after the cutoff): it waits, remembers nothing, and runs once
    // the answer is Share.
    const S = setup('auto-ask', { tester: false });
    for (let i = 0; i < 2; i++) keep(S.recDir, T0 + 8 * 86400e3 + i * 30e3, baseMeta({ output: 'asked ' + i }));
    S.state.share = 'ask';
    const x = S.make(server);
    const r = await x.bf.autoOnce(() => x.sharing.autoBackfillWhy());
    check('not answered: it waits, nothing remembered, nothing queued', !r.decided && !r.ran && !x.bf.status().auto && (await x.sharing.pending()) === 0, r);
    await x.sharing.answer('on');   // Share: enrolls now
    const r2 = await x.bf.autoOnce(() => x.sharing.autoBackfillWhy());
    check('answered Share: it runs (the key is from this run)', r2.decided && r2.ran, r2);
    await until(() => x.bf.status().state === 'done', 20000);
    await until(async () => (await x.sharing.pending()) === 0, 20000);
    check('and its 2 past dictations went', backfilled(server).filter((m) => /^asked /.test(m.output)).length === 2);
    const S2 = setup('auto-ask-no', { tester: false });
    keep(S2.recDir, T0 + 9 * 86400e3, baseMeta({ output: 'refused share' }));
    S2.state.share = 'ask';
    const z = S2.make(server);
    await z.sharing.answer('off');
    const r3 = await z.bf.autoOnce(() => z.sharing.autoBackfillWhy());
    check("answered Don't share: never", r3.decided && !r3.ran && r3.why === 'sharing is off' && !backfilled(server).some((m) => m.output === 'refused share'), r3);
    x.bf.stop(); z.bf.stop();
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
