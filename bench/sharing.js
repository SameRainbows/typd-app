'use strict';

/**
 * Sharing, without Electron, a window or the network: sharing.js and collect.js against a local
 * fake of typd-collect.
 *
 *   - consent gating: before the consent screen is answered, and after "Keep everything on my
 *     computer", nothing is queued and not one request is made -- not even enrollment
 *   - opting in: one enrollment, the key kept in share.json (never logged), every dictation
 *     uploaded with it, and never the screen context, the span or a window title
 *   - enrollment refused (429) or offline: sharing stays on and enrolls with the first send
 *   - "That was wrong": marked in the outbox before it goes; sent to /v1/flag once it has gone;
 *     retried when offline; a note kept to one line; nothing to flag; and, with sharing off,
 *     'ask' and nothing sent until the person says yes -- then that one dictation only
 *   - turning sharing off empties the outbox (a dictation shared on its own still goes)
 *   - "Delete what I've shared": DELETE /v1/me, outbox emptied, key forgotten, sharing off;
 *     offline it says so and keeps the key
 *   - a refused key: stops (an old key), or retries (one made minutes ago); re-enrolls on opt-in
 *   - tester builds: the bundled key wins, no consent, no enrollment, the pause holds
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
          if (s.enrollStatus !== 201) return send(res, s.enrollStatus, { error: 'no' }, { 'Retry-After': '30' });
          const key = 'ik_' + crypto.randomBytes(32).toString('base64url');
          const id = 'i-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 20);
          s.keys.set(key, id);
          r.appVersion = JSON.parse(body.toString() || '{}').appVersion;
          return send(res, 201, { key, id });
        }
        const owner = who(req);
        if (req.method === 'POST' && req.url === '/v1/upload') {
          if (!owner) return send(res, 401, { error: 'unauthorized' });
          if (s.uploadStatus) return send(res, s.uploadStatus, { error: 'later' }, { 'Retry-After': '1' });
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
  s.reset = () => { s.requests.length = 0; s.items.clear(); s.enrollStatus = 201; s.uploadStatus = null; s.flagStatus = null; s.deleteStatus = null; s.refuse.clear(); };
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
  const home = path.join(tmp, 'home' + (++n));
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
    now: opts.now
  });
  return { s, home, outbox: path.join(home, 'outbox'), keyFile: path.join(home, 'share.json'), choice: () => choice };
}
const outboxFiles = (dir, ext) => { try { return fs.readdirSync(dir).filter((f) => !ext || f.endsWith(ext)); } catch { return []; } };

(async () => {
  const server = await fakeServer();

  /* ------------------------------------------------------------- consent */

  section('consent gating: nothing before "Share my dictations"');
  {
    server.reset();
    const t = make(server, { choice: '' });
    check('the consent screen is due (choice not made yet)', t.s.needsConsent() === true);
    check('status: unset, nothing shared', t.s.status().state === 'unset' && t.s.status().shared === false);
    check('a dictation is not queued', t.s.add(dictation('secret one', { context: 'SCREEN', span: 'SPAN', title: 'TITLE' })) === false);
    await t.s.start();
    t.s.wake(0);
    await sleep(400);
    check('not one request was made -- not even enrollment', server.requests.length === 0, server.requests);
    check('the outbox does not exist', outboxFiles(t.outbox).length === 0);
    check('no key file', !fs.existsSync(t.keyFile));
    const info = t.s.lastInfo();
    check('the last dictation is held in memory, for a flag', info && info.text === 'secret one' && info.needsConsent === true, info);
    const r = await t.s.flag({ note: 'should be "secret won"' });
    await sleep(200);
    check('a flag with sharing off asks first, and sends nothing', r.state === 'ask' && server.requests.length === 0, r);

    const off = make(server, { choice: 'off' });
    check('"Keep everything on my computer": no consent screen again', off.s.needsConsent() === false && off.s.status().state === 'off');
    off.s.add(dictation());
    off.s.wake(0);
    await sleep(300);
    check('and still nothing sent', server.requests.length === 0);
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

  section('opting in');
  {
    server.reset();
    const t = make(server, { choice: '' });
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
    const t = make(server, { choice: '' });
    const r = await t.s.choose('on');
    check('choose("on") -> on, not enrolled yet', r.ok && r.enrolled === false && t.choice() === 'on', r);
    t.s.add(dictation('waits for a key'));
    t.s.wake(0);
    await sleep(400);
    check('nothing uploaded without a key', server.count('/v1/upload') === 0 && outboxFiles(t.outbox, '.json').length === 1);
    server.enrollStatus = 201;
    t.s.wake(0);
    check('the server lets it in: enrolled and uploaded', await until(() => server.items.size === 1) && Boolean(readKeyFile(t.keyFile)));
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
    check('with no key at all, delete only empties the outbox', (await make(server, { choice: '' }).s.deleteShared()).ok === true);
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
    check('mode tester, no consent screen', t.s.mode === 'tester' && t.s.needsConsent() === false);
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
