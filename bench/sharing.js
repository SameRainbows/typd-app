'use strict';

/**
 * Sharing, without Electron, a window or the network: sharing.js and collect.js against a local
 * fake of typd-collect.
 *
 *   - public builds ask (0.2.7): not answered ('ask') queues nothing and sends nothing, not even an
 *     enrollment; Share (answer 'on') enrolls and every dictation goes; 'on' (an install from before
 *     the cutoff) shares; an explicit 'off' stays off: nothing queued, not one request
 *   - Don't share: nothing shared yet -> off, not one request; after 0.2.6's default shared some ->
 *     DELETE /v1/me, the outbox emptied, the key forgotten; a delete that fails is retried at the
 *     next launch (deleteWanted in share.json) until it goes, unless the person turns sharing on
 *   - the automatic backfill's verdict (autoBackfillWhy): waits while not answered, never for a tester,
 *     a fresh install, 'off', or an install that had a key when the run began
 *   - turning it on in Settings: one enrollment, the key kept in share.json (never logged), every
 *     dictation uploaded with it, and never the screen context, the span or a window title
 *   - public builds' limits, all silent: at most so many dictations and bytes a UTC day (kept
 *     across restarts, a new day starts afresh), an outbox capped on disk, and the server's
 *     Retry-After (a daily cap, storage full) held through wakes; a full bucket (507) waits at
 *     least fullHoldS
 *   - enrollment refused (429) or offline: sharing stays on and enrolls with the first send
 *   - "That was wrong": marked in the outbox before it goes; sent to /v1/flag once it has gone;
 *     retried when offline; a note kept to one line; nothing to flag; and, with sharing off,
 *     'ask' and nothing sent until the person says yes -- then that one dictation only
 *   - turning sharing off empties the outbox (a dictation shared on its own still goes)
 *   - "Delete what I've shared": DELETE /v1/me, outbox emptied, key forgotten, sharing off;
 *     offline it says so and keeps the key
 *   - a refused key: stops (an old key), or retries (one made minutes ago); re-enrolls on opt-in
 *   - tester builds: the bundled key wins, no enrollment, the pause holds, no daily limit
 *   - collect.js's old API (typd-collect/e2e.mjs) still works
 *
 *   node bench/sharing.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { createSharing, readKeyFile } = require('../src/main/sharing');
const { createCollector, oneLine } = require('../src/main/collect');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
}
const section = (s) => console.log('\n' + s);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-sharing-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await sleep(40); }
  return Boolean(await cond());
}

/* ------------------------------------------------------- a fake typd-collect */

function fakeServer() {
  const s = {
    requests: [], items: new Map(), keys: new Map(), testerKeys: new Map(),
    enrollStatus: 201, uploadStatus: null, flagStatus: null, deleteStatus: null, refuse: new Set(),
    enrollRetryAfter: '30', uploadRetryAfter: '',   // the Retry-After sent with a refusal ('' none)
    endpoint: null, server: null
  };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const who = (req) => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    if (!m || s.refuse.has(m[1])) return null;
    return s.keys.get(m[1]) || s.testerKeys.get(m[1]) || null;
  };
  s.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const r = { method: req.method, path: req.url, auth: req.headers.authorization || null };
      s.requests.push(r);
      try {
        if (req.method === 'POST' && req.url === '/v1/enroll') {
          if (s.enrollStatus !== 201) return send(res, s.enrollStatus, { error: 'no' }, s.enrollRetryAfter ? { 'Retry-After': s.enrollRetryAfter } : {});
          const key = 'ik_' + crypto.randomBytes(32).toString('base64url');
          const id = 'i-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 20);
          s.keys.set(key, id);
          r.appVersion = JSON.parse(body.toString() || '{}').appVersion;
          return send(res, 201, { key, id });
        }
        const owner = who(req);
        if (req.method === 'POST' && req.url === '/v1/upload') {
          if (!owner) return send(res, 401, { error: 'unauthorized' });
          if (s.uploadStatus) return send(res, s.uploadStatus, { error: 'later' }, s.uploadRetryAfter ? { 'Retry-After': s.uploadRetryAfter } : {});
          const form = await new Response(body, { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
          const meta = JSON.parse(form.get('meta'));
          const audio = Buffer.from(await form.get('audio').arrayBuffer());
          const name = meta.createdAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + meta.id;
          s.items.set(owner + '/' + name, { meta, audio, owner, name });
          r.item = owner + '/' + name;
          return send(res, 201, { ok: true, key: owner + '/' + name });
        }
        if (req.method === 'POST' && req.url === '/v1/flag') {
          if (!owner) return send(res, 401, { error: 'unauthorized' });
          if (s.flagStatus) return send(res, s.flagStatus, { error: 'later' });
          const b = JSON.parse(body.toString());
          r.flag = b;
          const it = s.items.get(owner + '/' + b.name);
          if (!it) return send(res, 404, { error: 'not found' });
          it.meta.flag = true;
          if (b.note) it.meta.note = b.note;
          return send(res, 200, { ok: true });
        }
        if (req.method === 'DELETE' && req.url === '/v1/me') {
          if (!owner) return send(res, 401, { error: 'unauthorized' });
          if (s.deleteStatus) return send(res, s.deleteStatus, { error: 'later' });
          let n = 0;
          for (const [k, it] of s.items) if (it.owner === owner) { s.items.delete(k); n++; }
          for (const [k, id] of s.keys) if (id === owner) s.keys.delete(k);
          return send(res, 200, { ok: true, id: owner, deleted: n });
        }
        send(res, 404, { error: 'not found' });
      } catch (err) {
        send(res, 500, { error: String(err && err.message) });
      }
    });
  });
  s.count = (p, method) => s.requests.filter((q) => q.path === p && (!method || q.method === method)).length;
  s.itemsOf = (owner) => [...s.items.values()].filter((i) => i.owner === owner);
  s.reset = () => {
    s.requests.length = 0; s.items.clear(); s.enrollStatus = 201; s.uploadStatus = null; s.flagStatus = null; s.deleteStatus = null; s.refuse.clear();
    s.enrollRetryAfter = '30'; s.uploadRetryAfter = '';
  };
  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => { s.endpoint = `http://127.0.0.1:${s.server.address().port}`; resolve(s); }));
}

/* ------------------------------------------------------------------ helpers */

function dictation(text = 'Thanks, I will send the draft tonight.', extra = {}) {
  const samples = new Float32Array(16000).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 330 * i) / 16000));
  return {
    samples, sampleRate: 16000, text, mode: 'dictate', app: 'notepad', model: 'test.gguf', engine: 'local',
    endedAt: Date.now() - 500, pastedAt: Date.now(), ...extra
  };
}

let n = 0;
const logs = [];
function make(server, opts = {}) {
  const home = opts.home || path.join(tmp, 'home' + (++n));
  fs.mkdirSync(home, { recursive: true });
  let choice = opts.choice === undefined ? '' : opts.choice;
  const s = createSharing({
    tester: opts.tester || null,
    endpoint: server.endpoint,
    keyFile: path.join(home, 'share.json'),
    dir: path.join(home, 'outbox'),
    choice: { get: () => choice, set: (v) => { choice = v; } },
    paused: opts.paused || (() => false),
    about: { appVersion: '0.2.0' },
    log: (...a) => logs.push(a.map(String).join(' ')),
    now: opts.now,
    cap: opts.cap, daily: opts.daily, fullHoldS: opts.fullHoldS, dayFile: opts.dayFile
  });
  return { s, home, outbox: path.join(home, 'outbox'), keyFile: path.join(home, 'share.json'), choice: () => choice };
}
const outboxFiles = (dir, ext) => { try { return fs.readdirSync(dir).filter((f) => !ext || f.endsWith(ext)); } catch { return []; } };

(async () => {
  const server = await fakeServer();

  /* ------------------------------------------------------------- consent */

  section('public builds: sharing is asked; not answered shares nothing; Share shares; "off" stays off');
  {
    server.reset();
    const t = make(server, { choice: 'ask' });   // a fresh 0.2.7 install, or one from after the cutoff, not answered yet
    check('not answered: off, choice "ask", nothing shared', t.s.status().state === 'off' && t.s.status().choice === 'ask' && t.s.status().shared === false, t.s.status());
    check('no consent step left in the API', !('needsConsent' in t.s));
    await t.s.start();
    t.s.wake(0);
    check('not answered: a dictation is not queued', t.s.add(dictation('not yet', { context: 'SCREEN' })) === false);
    await sleep(400);
    check('not answered: not one request, not even enrollment', server.requests.length === 0, server.requests);
    check('not answered: no outbox, no key file', outboxFiles(t.outbox).length === 0 && !fs.existsSync(t.keyFile));
    check('diagnostics: not chosen yet, and why nothing was queued', /public build, not chosen yet \(off\)/.test(t.s.diagnostics()) && /not queued: sharing not chosen yet x1/.test(t.s.diagnostics()), t.s.diagnostics());
    const yes = await t.s.answer('on');
    check('Share: on, enrolled at once', yes.ok && yes.enrolled === true && t.choice() === 'on' && t.s.status().choice === 'on' && server.count('/v1/enroll') === 1, yes);
    check('a dictation is queued', t.s.add(dictation('first words', { context: 'SCREEN', span: 'SPAN', title: 'TITLE' })) === true);
    check('and uploaded with that key', await until(() => server.items.size === 1) && server.count('/v1/enroll') === 1);
    const it = [...server.items.values()][0] || { meta: {} };
    check('consent "all", never the screen context, the span or a title', it.meta.consent === 'all' &&
      !('context' in it.meta) && !('span' in it.meta) && !('title' in it.meta) && !JSON.stringify(it.meta).includes('SCREEN'), it.meta);
    check('the key is kept in share.json', Boolean(readKeyFile(t.keyFile)) && t.s.status().shared === true);
    const info = t.s.lastInfo();
    check('the last dictation is held for a flag, already shared', info && info.text === 'first words' && info.needsConsent === false, info);

    const on = make(server, { choice: 'on' });   // an install from before the cutoff (settings.js shareRule)
    check('"on": on', on.s.status().state === 'on' && on.s.add(dictation('a tester from before')) === true);
    check('and sent: the first send enrolls', await until(() => server.items.size === 2) && server.count('/v1/enroll') === 2);
    check('only "on" is on: "" and anything else is off here (settings.js turns an old "" into on or ask)',
      make(server, { choice: '' }).s.status().state === 'off' && make(server, { choice: 'yes' }).s.status().state === 'off');

    server.reset();
    const off = make(server, { choice: 'off' });   // chosen on the old consent screen, or in Settings
    check('"off": off', off.s.status().state === 'off');
    check('"off": a dictation is not queued', off.s.add(dictation('secret one')) === false);
    await off.s.start();
    off.s.wake(0);
    await sleep(400);
    check('"off": not one request was made -- not even enrollment', server.requests.length === 0, server.requests);
    check('"off": the outbox does not exist, no key file', outboxFiles(off.outbox).length === 0 && !fs.existsSync(off.keyFile));
    const r = await off.s.flag({ note: 'should be "secret won"' });
    await sleep(200);
    check('"off": a flag asks first, and sends nothing', r.state === 'ask' && server.requests.length === 0, r);
    check('"off" is never turned back on by anything but choose("on")', off.choice() === 'off' && off.s.status().state === 'off');
  }

  section("Don't share: nothing shared yet -> off; shared under 0.2.6's default -> deleted");
  {
    server.reset();
    const n0 = make(server, { choice: 'ask' });
    const r0 = await n0.s.answer('off');
    check("Don't share with nothing shared: off, not one request (no delete)", r0.ok && n0.choice() === 'off' && server.requests.length === 0 && !r0.deletedShared, r0);

    // An install from after the cutoff that 0.2.6 shared from by default: a key, two items on the
    // server, one still waiting in the outbox when 0.2.7 starts.
    server.reset();
    const old = make(server, { choice: 'on' });
    old.s.add(dictation('shared by 0.2.6 one'));
    old.s.add(dictation('shared by 0.2.6 two'));
    await until(() => server.items.size === 2);
    server.uploadStatus = 503;
    old.s.add(dictation('waiting when 0.2.7 starts'));
    await until(() => outboxFiles(old.outbox, '.json').length === 1);
    const k = readKeyFile(old.keyFile);
    server.uploadStatus = null;
    const now7 = make(server, { choice: 'ask', home: old.home });   // the 0.2.7 launch: asked, not answered yet
    const before = server.requests.length;
    await now7.s.start();
    now7.s.wake(0);
    await sleep(500);
    check('0.2.7, not answered: the waiting item does not go', server.requests.length === before && outboxFiles(old.outbox, '.json').length === 1);
    check('status: off, not answered, but something was shared', now7.s.status().state === 'off' && now7.s.status().choice === 'ask' && now7.s.status().shared === true);
    const r1 = await now7.s.answer('off');
    check("Don't share: DELETE /v1/me with this install's key", server.count('/v1/me', 'DELETE') === 1 &&
      server.requests.find((q) => q.path === '/v1/me' && q.method === 'DELETE').auth === 'Bearer ' + k.key, server.requests);
    check('the server holds nothing for it now', r1.ok && r1.deleted === 2 && r1.deletedShared === true && server.itemsOf(k.id).length === 0, r1);
    check('the outbox is empty, the key forgotten, sharing off', outboxFiles(old.outbox, '.json').length === 0 && !fs.existsSync(old.keyFile) &&
      now7.choice() === 'off' && now7.s.status().shared === false);
    now7.s.add(dictation('after'));
    now7.s.wake(0);
    await sleep(300);
    check('and nothing goes afterwards', server.count('/v1/upload') === 2);

    // The delete cannot go now (a server error, or offline): retried at the next launch.
    server.reset();
    const o2 = make(server, { choice: 'on' });
    o2.s.add(dictation('shared by 0.2.6'));
    await until(() => server.items.size === 1);
    server.deleteStatus = 500;
    const asked = make(server, { choice: 'ask', home: o2.home });
    const r2 = await asked.s.answer('off');
    check("Don't share, the delete refused: off, the key kept and marked to delete", !r2.ok && r2.deletedShared && asked.choice() === 'off' &&
      readKeyFile(o2.keyFile) && readKeyFile(o2.keyFile).deleteWanted === true, { r2, key: readKeyFile(o2.keyFile) });
    server.deleteStatus = null;
    const next = make(server, { choice: 'off', home: o2.home });   // the next launch
    const r3 = await next.s.retryDelete();
    check('the next launch deletes it: DELETE /v1/me, the key forgotten', r3 && r3.ok && server.items.size === 0 && !fs.existsSync(o2.keyFile) && server.count('/v1/me', 'DELETE') === 2, r3);
    check('a launch with nothing owed does nothing', (await make(server, { choice: 'off', home: o2.home }).s.retryDelete()) === null);
    // ... unless the person turned sharing on meanwhile: then the old request is dropped.
    server.reset();
    const o3 = make(server, { choice: 'on' });
    o3.s.add(dictation('shared by 0.2.6'));
    await until(() => server.items.size === 1);
    server.deleteStatus = 500;
    const a3 = make(server, { choice: 'ask', home: o3.home });
    await a3.s.answer('off');
    server.deleteStatus = null;
    await a3.s.choose('on');
    check('Share later drops the delete still owed', readKeyFile(o3.keyFile) && !readKeyFile(o3.keyFile).deleteWanted &&
      (await make(server, { choice: 'on', home: o3.home }).s.retryDelete()) === null && server.items.size === 1);
  }

  section('the automatic backfill: who it is for (autoBackfillWhy)');
  {
    server.reset();
    check('not answered yet: it waits', make(server, { choice: 'ask' }).s.autoBackfillWhy() === 'wait');
    check('a fresh install: never', make(server, { choice: 'on' }).s.autoBackfillWhy({ fresh: true }) === 'a fresh install');
    check('"off": never', make(server, { choice: 'off' }).s.autoBackfillWhy() === 'sharing is off');
    check('on, never shared (no key): yes', make(server, { choice: 'on' }).s.autoBackfillWhy() === null);
    const had = make(server, { choice: 'on' });
    await had.s.choose('on');
    check('on, with a key when this run began: never', make(server, { choice: 'on', home: had.home }).s.autoBackfillWhy() === 'this install has shared before');
    const fresh = make(server, { choice: 'ask' });
    await fresh.s.answer('on');   // enrolls now: the key is from this run, so it still counts as never shared before
    check('answered Share this run (enrolled just now): yes', fresh.s.autoBackfillWhy() === null);
    check('a tester build: never', make(server, { tester: { tester: 't', endpoint: server.endpoint, key: 'tk_x', with: 'M' } }).s.autoBackfillWhy() === 'a tester build');
  }

  section('"Share this one dictation so it can be fixed?" -- yes, for that one only');
  {
    server.reset();
    const t = make(server, { choice: 'off' });
    t.s.add(dictation('the first, never shared'));
    t.s.add(dictation('the cable data set', { mode: 'dictate' }));
    const r = await t.s.flag({ note: 'Kaggle,\nnot cable', consent: true });
    check('flagged as shared on its own', r.state === 'flagged' && r.how === 'shared', r);
    check('it enrolled once', await until(() => server.count('/v1/enroll') === 1));
    check('the one dictation was uploaded', await until(() => server.items.size === 1));
    const it = [...server.items.values()][0] || { meta: {} };
    check('flag, the note on one line, consent "flag"', it.meta.flag === true && it.meta.note === 'Kaggle, not cable' && it.meta.consent === 'flag', it.meta);
    check('it is the flagged one, not the one before', it.meta.output === 'the cable data set');
    check('sharing stays off', t.choice() === 'off' && t.s.status().state === 'off');
    check('the key is kept (so it can be deleted later)', Boolean(readKeyFile(t.keyFile)) && t.s.status().shared === true);
    t.s.add(dictation('after the flag'));
    t.s.wake(0);
    await sleep(400);
    check('the next dictation is not sent', server.items.size === 1 && server.count('/v1/upload') === 1);
    check('the enrollment carried the app version', server.requests.find((q) => q.path === '/v1/enroll').appVersion === '0.2.0');
  }

  /* -------------------------------------------------------------- opt in */

  section('turning it on in Settings');
  {
    server.reset();
    const t = make(server, { choice: 'off' });
    const r = await t.s.choose('on');
    check('choose("on") enrolls at once', r.ok && r.enrolled === true && server.count('/v1/enroll') === 1, r);
    const k = readKeyFile(t.keyFile);
    check('share.json holds {endpoint, key, id, enrolledAt}', k && /^ik_/.test(k.key) && /^i-[0-9a-f]{20}$/.test(k.id) && k.enrolledAt && k.endpoint === server.endpoint, k);
    check('status: on, shared, with the anonymous id', t.s.status().state === 'on' && t.s.status().id === k.id);
    for (let i = 0; i < 3; i++) t.s.add(dictation('dictation ' + i, { context: 'SCREEN TEXT', span: 'SPAN', title: 'Inbox - me@example.com', contextBlock: 'X' }));
    t.s.wake(0);
    check('three dictations uploaded', await until(() => server.items.size === 3), server.items.size);
    check('all with the install key', server.requests.filter((q) => q.path === '/v1/upload').every((q) => q.auth === 'Bearer ' + k.key));
    const metas = [...server.items.values()].map((i) => i.meta);
    check('consent "all" on each', metas.every((m) => m.consent === 'all'));
    check('never the screen context, the span or a title', metas.every((m) => !('context' in m) && !('span' in m) && !('title' in m) && !('contextBlock' in m)) &&
      [...server.items.values()].every((i) => !JSON.stringify(i.meta).includes('SCREEN')), metas[0]);
    check('16 kHz mono WAV, 1 s', [...server.items.values()].every((i) => i.audio.readUInt32LE(24) === 16000 && i.meta.audioSeconds === 1));
    check('the outbox emptied after each 2xx', await until(() => outboxFiles(t.outbox, '.json').length === 0));
    check('a second choose("on") does not enroll again', (await t.s.choose('on')).enrolled && server.count('/v1/enroll') === 1);
    check('the key never reached a log line', !logs.some((l) => l.includes(k.key)));
  }

  section('enrollment refused or offline: on, and enrolled with the first send');
  {
    server.reset();
    server.enrollStatus = 429;
    server.enrollRetryAfter = '1';
    const t = make(server, { choice: 'off' });
    const r = await t.s.choose('on');
    check('choose("on") -> on, not enrolled yet', r.ok && r.enrolled === false && t.choice() === 'on', r);
    t.s.add(dictation('waits for a key'));
    t.s.wake(0);
    await until(() => server.count('/v1/enroll') >= 2);   // choose's, then the uploader's
    await sleep(100);
    check('nothing uploaded without a key', server.count('/v1/upload') === 0 && outboxFiles(t.outbox, '.json').length === 1);
    const tries = server.count('/v1/enroll');
    server.enrollStatus = 201;
    t.s.wake(0);
    await sleep(200);
    check("a wake inside the server's Retry-After does not ask again", server.count('/v1/enroll') === tries);
    await sleep(1000);
    t.s.wake(0);
    check('after it, the server lets it in: enrolled and uploaded', await until(() => server.items.size === 1) && Boolean(readKeyFile(t.keyFile)));
  }

  /* ------------------------------------------------- public builds' limits */

  section('the daily limit (public builds)');
  {
    server.reset();
    let clock = Date.parse('2026-10-17T10:00:00Z');
    const home = path.join(tmp, 'daily');
    const dayFile = path.join(home, 'share-day.json');
    const t = make(server, { choice: 'on', daily: { items: 3, bytes: 1e9, file: dayFile }, now: () => clock });
    const got = [1, 2, 3, 4].map((i) => t.s.add(dictation('day one, ' + i)));
    check('3 a day: the fourth is not queued (add() just says false; nothing shown or thrown)', got.join() === 'true,true,true,false', got);
    check('three uploaded', await until(() => server.items.size === 3));
    await sleep(100);
    check('the count is on disk', JSON.parse(fs.readFileSync(dayFile, 'utf8')).items === 3);
    const again = make(server, { choice: 'on', daily: { items: 3, bytes: 1e9, file: dayFile }, now: () => clock });
    check('a restart does not reset it', again.s.add(dictation('after a restart')) === false);
    check('a flag on the one not queued asks, and a yes still sends it', (await again.s.flag({})).state === 'ask' &&
      (await again.s.flag({ consent: true })).state === 'flagged' && await until(() => server.items.size === 4));
    clock += 86400e3;
    check('the next UTC day starts afresh', again.s.add(dictation('day two')) === true);
    const bytesT = make(server, { choice: 'on', daily: { items: 100, bytes: 40000, file: path.join(home, 'bytes.json') } });
    check('bytes count too: one 1-s dictation (32,044 B) fits 40 kB, a second does not',
      bytesT.s.add(dictation('one second')) === true && bytesT.s.add(dictation('one more second')) === false);
    for (const x of [t, again, bytesT]) await x.s.choose('off');   // nothing of theirs reaches later sections
  }

  section('the server is full or past a daily cap (public builds): silent, held, bounded');
  {
    server.reset();
    server.uploadStatus = 507;
    server.uploadRetryAfter = '1';
    const t = make(server, { choice: 'on', fullHoldS: 2 });
    await t.s.choose('on');
    t.s.add(dictation('the bucket is full'));
    check('507: refused once', await until(() => server.count('/v1/upload') === 1));
    await sleep(300);
    for (let i = 0; i < 5; i++) t.s.wake(0);   // a laptop woken and unlocked again and again
    await sleep(700);
    check('wakes inside the hold send nothing (fullHoldS beats a shorter Retry-After)', server.count('/v1/upload') === 1, server.count('/v1/upload'));
    check('no error state: sharing still on, the item waits', t.s.status().state === 'on' && outboxFiles(t.outbox, '.json').length === 1);
    check('only logged ("server storage full")', logs.some((l) => /server storage full/.test(l)));
    server.uploadStatus = null;
    await sleep(1200);
    t.s.wake(0);
    check('after the hold, it goes', await until(() => server.items.size === 1));

    server.reset();
    server.uploadStatus = 429;
    server.uploadRetryAfter = '2';
    const d = make(server, { choice: 'on' });
    await d.s.choose('on');
    d.s.add(dictation('over the per-install cap'));
    await until(() => server.count('/v1/upload') === 1);
    for (let i = 0; i < 5; i++) d.s.wake(0);
    await sleep(800);
    check('429 with Retry-After: no retry storm on wake', server.count('/v1/upload') === 1, server.count('/v1/upload'));

    server.reset();
    server.uploadStatus = 503;
    const c = make(server, { choice: 'on', cap: 100000 });
    await c.s.choose('on');
    for (let i = 0; i < 6; i++) c.s.add(dictation('waiting ' + i));
    await until(() => server.count('/v1/upload') >= 1);
    await sleep(300);
    const bytes = outboxFiles(c.outbox).reduce((n, f) => n + fs.statSync(path.join(c.outbox, f)).size, 0);
    check('the outbox stays under its cap, oldest dropped (6 x 33 kB into 100 kB)', bytes <= 100000 && outboxFiles(c.outbox, '.json').length === 3, [bytes, outboxFiles(c.outbox, '.json').length]);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'sharing.js'), 'utf8');
    check("public builds' defaults: 50 a day, 20 MB a day, 100 MB on disk, 6 h after a 507",
      /const DAILY_ITEMS = 50;/.test(src) && /const DAILY_BYTES = 20e6;/.test(src) && /const OUTBOX_CAP_PUBLIC = 100e6;/.test(src) && /const FULL_HOLD_S = 6 \* 3600;/.test(src));
    for (const x of [t, d, c]) await x.s.choose('off');
  }

  /* ---------------------------------------------------------------- flag */

  section('"That was wrong" with sharing on');
  {
    server.reset();
    const t = make(server, { choice: 'on' });
    await t.s.choose('on');
    server.uploadStatus = 503;   // the item waits in the outbox
    t.s.add(dictation('still in the outbox'));
    await until(() => outboxFiles(t.outbox, '.json').length === 1);
    const r = await t.s.flag({ note: 'wrong name' });
    check('an item not sent yet is marked in the outbox', r.state === 'flagged' && r.how === 'marked', r);
    const name = outboxFiles(t.outbox, '.json')[0].slice(0, -5);
    const meta = JSON.parse(fs.readFileSync(path.join(t.outbox, name + '.json'), 'utf8'));
    check('its meta has flag and note', meta.flag === true && meta.note === 'wrong name');
    server.uploadStatus = null;
    t.s.wake(0);
    check('it goes with the flag', await until(() => server.items.size === 1) && [...server.items.values()][0].meta.flag === true);
    check('no separate /v1/flag call was needed', server.count('/v1/flag') === 0);

    t.s.add(dictation('sent before the flag'));
    t.s.wake(0);
    await until(() => server.items.size === 2);
    const r2 = await t.s.flag({ note: '  should\r\nbe   different  ' });
    check('an item already sent: the flag is queued for the server', r2.state === 'flagged' && r2.how === 'queued', r2);
    t.s.wake(0);
    check('POST /v1/flag with its name and the note on one line', await until(() => server.count('/v1/flag') === 1) &&
      server.requests.find((q) => q.path === '/v1/flag').flag.note === 'should be different');
    const sent = [...server.items.values()].find((i) => i.meta.output === 'sent before the flag');
    check('the server item is flagged', sent && sent.meta.flag === true);
    check('the flag record is gone from the outbox', await until(() => outboxFiles(t.outbox, '.flag').length === 0));

    server.flagStatus = 503;
    await t.s.flag({ note: 'again, offline' });
    t.s.wake(0);
    await sleep(400);
    check('offline: the flag waits in the outbox', outboxFiles(t.outbox, '.flag').length === 1);
    server.flagStatus = null;
    t.s.wake(0);
    check('and goes when the server answers', await until(() => outboxFiles(t.outbox, '.flag').length === 0) && server.count('/v1/flag') >= 3);

    check('oneLine: control characters, line breaks and length', oneLine('a\u0000b\nc\u2028d ' + 'x'.repeat(400)).length === 200 && oneLine('a\tb\nc') === 'a b c');
  }

  section('nothing to flag');
  {
    server.reset();
    let clock = Date.now();
    const t = make(server, { choice: 'off', now: () => clock });   // memory only: nothing uploads later
    check('no dictation yet -> none', (await t.s.flag({})).state === 'none' && t.s.lastInfo() === null);
    t.s.add(dictation('an hour ago'));
    clock += 3600e3 + 1;
    check('over an hour later -> none (the audio is let go)', (await t.s.flag({})).state === 'none' && t.s.lastInfo() === null);
  }

  /* ------------------------------------------------------------- opt out */

  section('turning sharing off');
  {
    server.reset();
    const t = make(server, { choice: 'on' });
    await t.s.choose('on');
    server.uploadStatus = 503;
    t.s.add(dictation('queued, then sharing off'));
    t.s.add(dictation('also queued'));
    await until(() => outboxFiles(t.outbox, '.json').length === 2);
    const r = await t.s.choose('off');
    check('choose("off") empties the outbox', r.ok && outboxFiles(t.outbox, '.json').length === 0 && outboxFiles(t.outbox, '.wav').length === 0);
    t.s.add(dictation('fix me'));
    await t.s.flag({ consent: true });
    await until(() => outboxFiles(t.outbox, '.json').length === 1);
    await t.s.choose('off');
    check('a dictation shared on its own survives "off"', outboxFiles(t.outbox, '.json').length === 1);
    server.uploadStatus = null;
    t.s.wake(0);
    check('and is the only thing sent', await until(() => server.items.size === 1) && [...server.items.values()][0].meta.output === 'fix me');
  }

  /* -------------------------------------------------------------- delete */

  section('"Delete what I\'ve shared"');
  {
    server.reset();
    const t = make(server, { choice: 'on' });
    await t.s.choose('on');
    const k = readKeyFile(t.keyFile);
    for (let i = 0; i < 2; i++) t.s.add(dictation('shared ' + i));
    t.s.wake(0);
    await until(() => server.items.size === 2);
    server.uploadStatus = 503;
    t.s.add(dictation('still waiting'));
    await until(() => outboxFiles(t.outbox, '.json').length === 1);
    server.uploadStatus = null;
    const r = await t.s.deleteShared();
    check('DELETE /v1/me with the install key', server.count('/v1/me', 'DELETE') === 1 && server.requests.find((q) => q.path === '/v1/me').auth === 'Bearer ' + k.key);
    check('the server deleted both', r.ok && r.deleted === 2 && server.items.size === 0, r);
    check('the outbox is empty (the waiting one was never sent)', outboxFiles(t.outbox, '.json').length === 0 && server.count('/v1/upload') === 2);
    check('the key is forgotten, sharing is off', !fs.existsSync(t.keyFile) && t.choice() === 'off' && t.s.status().shared === false && t.s.status().state === 'off');
    check('nothing to flag afterwards', t.s.lastInfo() === null);
    t.s.add(dictation('after deleting'));
    t.s.wake(0);
    await sleep(400);
    check('nothing is sent afterwards', server.count('/v1/upload') === 2 && server.count('/v1/enroll') === 1);

    const off = make(server, { choice: 'on' });
    await off.s.choose('on');
    server.deleteStatus = null;
    const port = server.endpoint;
    // Offline: point the key at a port nobody listens on.
    const kk = readKeyFile(off.keyFile);
    fs.writeFileSync(off.keyFile, JSON.stringify({ ...kk, endpoint: 'http://127.0.0.1:9' }));
    const off2 = createSharing({
      endpoint: port, keyFile: off.keyFile, dir: off.outbox, choice: { get: () => 'on', set: () => {} }, log: () => {}
    });
    const r2 = await off2.deleteShared();
    check('offline: it says so and keeps the key to try again', r2.ok === false && r2.reason === 'offline' && fs.existsSync(off.keyFile), r2);
    server.deleteStatus = 500;
    const r3 = await off.s.deleteShared();
    check('a server error: it says so and keeps the key', r3.ok === false && r3.reason === 'server' && fs.existsSync(off.keyFile), r3);
    server.deleteStatus = null;
    check('and deleting again works', (await off.s.deleteShared()).ok === true && !fs.existsSync(off.keyFile));
    check('with no key at all, delete only empties the outbox', (await make(server, { choice: 'on' }).s.deleteShared()).ok === true);
  }

  /* ---------------------------------------------------------- a refused key */

  section('a refused key');
  {
    server.reset();
    let clock = Date.now();
    const t = make(server, { choice: 'on', now: () => clock });
    await t.s.choose('on');
    const k = readKeyFile(t.keyFile);
    server.refuse.add(k.key);
    t.s.add(dictation('refused minutes after enrolling'));
    t.s.wake(0);
    await until(() => server.count('/v1/upload') === 1);
    await sleep(100);
    check('a key made minutes ago: 401 is retried, sharing not stopped', t.s.status().state === 'on');
    clock += 11 * 60e3;
    t.s.wake(0);
    await until(() => server.count('/v1/upload') === 2);
    await sleep(100);
    check('an older key: 401 stops sharing', t.s.status().state === 'stopped');
    const r = await t.s.choose('on');
    const k2 = readKeyFile(t.keyFile);
    check('turning it on again enrolls a new key', r.enrolled && k2 && k2.key !== k.key && server.count('/v1/enroll') === 2);
    t.s.wake(0);
    check('and what waited is sent with it', await until(() => server.items.size === 1) && server.requests.filter((q) => q.path === '/v1/upload').pop().auth === 'Bearer ' + k2.key);
  }

  /* --------------------------------------------------------- tester builds */

  section('a tester build: the bundled key wins');
  {
    server.reset();
    const testerKey = 'tk_' + crypto.randomBytes(24).toString('hex');
    server.testerKeys.set(testerKey, 'tester_a');
    let paused = false;
    const t = make(server, { tester: { tester: 'tester_a', endpoint: server.endpoint, key: testerKey, with: 'Mehmet' }, choice: '', paused: () => paused });
    check('mode tester, whatever the public choice says', t.s.mode === 'tester');
    const st = t.s.status();
    check('status as before: tester, with, on', st.mode === 'tester' && st.tester === 'tester_a' && st.with === 'Mehmet' && st.state === 'on', st);
    t.s.add(dictation('tester dictation'));
    t.s.wake(0);
    check('uploaded with the tester key, no enrollment', await until(() => server.items.size === 1) && server.count('/v1/enroll') === 0 &&
      server.requests.find((q) => q.path === '/v1/upload').auth === 'Bearer ' + testerKey);
    check('the meta names the tester', [...server.items.values()][0].meta.tester === 'tester_a');
    check('choose() does not apply', (await t.s.choose('off')).ok === false);
    check('"Delete what I\'ve shared" does not apply', (await t.s.deleteShared()).reason === 'tester');
    paused = true;
    check('paused: not queued', t.s.add(dictation('paused')) === false && t.s.status().state === 'paused');
    const r = await t.s.flag({});
    check('a flag on a dictation made while paused asks first', r.state === 'ask', r);
    await t.s.flag({ consent: true, note: 'fix' });
    t.s.wake(0);
    check('yes: that one goes, even while paused', await until(() => server.items.size === 2) && [...server.items.values()].some((i) => i.meta.consent === 'flag'));
    paused = false;
    const many = Array.from({ length: 60 }, (_, i) => t.s.add(dictation('tester ' + i)));
    check('no daily limit for a tester build (60 in a row queued)', many.every(Boolean));
  }

  /* ------------------------------------------------------------ collect API */

  section("collect.js's old API (typd-collect/e2e.mjs)");
  {
    server.reset();
    const testerKey = 'tk_' + crypto.randomBytes(24).toString('hex');
    server.testerKeys.set(testerKey, 'tester_b');
    const dir = path.join(tmp, 'old-api');
    const c = createCollector({ config: { tester: 'tester_b', endpoint: server.endpoint, key: testerKey, with: 'x' }, dir, about: { appVersion: 'e2e' } });
    check('add() returns true at once', c.add(dictation('old api')) === true);
    c.wake(0);
    check('uploaded, the outbox emptied', await until(async () => server.items.size === 1 && (await c.pending()) === 0));
    check('status() as before', c.status().state === 'on' && c.status().tester === 'tester_b');
  }

  server.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + (failures ? failures + ' FAILED' : 'all sharing checks passed') + '\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
