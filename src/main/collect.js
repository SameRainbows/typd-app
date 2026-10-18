'use strict';

/**
 * The outbox and its uploader: finished dictations, queued on disk and sent one at a time to
 * typd-collect. Electron-free, so plain Node drives it (bench/sharing.js, and typd-collect's
 * e2e.mjs and recordings.test.mjs). WHETHER anything is queued or sent is decided by
 * sharing.js -- the person's choice in the public beta, or a tester build's bundled key -- and
 * this module only ever sends what that layer let in.
 *
 * One item is: the captured audio as a 16 kHz mono 16-bit WAV, the text Typd pasted, the mode,
 * the model file and the exact model version (modelVersion: r24_1p7b_rev128, not just the GGUF's
 * name), whether the revise adapter ran on it (reviseAdapter, reviseAdapterFile), the name of the
 * app it went into, timestamps and durations, OS and app version -- so every shared item and every
 * flag can be tied to exact versions. NEVER the screen context, the highlighted span or a window
 * title -- those are other people's words. For a revision the pasted text is left out too
 * (SEND_REVISE_TEXT): it is the highlighted span rewritten, so it would carry the very text that
 * rule keeps out. The spoken instruction's audio is kept.
 *
 * Nothing here is on the critical path. add() returns at once; a tick later the item is written
 * to an outbox on disk, and one uploader sends one item at a time, deleting the local copy only
 * after the server answers 2xx. Failures back off exponentially; the outbox survives restarts,
 * sleep and being offline, and is capped (2 GB by default, oldest dropped first; public builds
 * pass a smaller cap and a daily limit, sharing.js). When the server says when to come back
 * (Retry-After: a daily cap, storage full, busy), nothing is sent before then -- waking from
 * sleep or unlocking the screen does not cut that short -- and a full bucket (507) can be given
 * a longer wait of its own (fullHoldS). Refusals are only logged: nothing is ever shown.
 *
 * "That was wrong" (a flag) on an item still here rewrites its meta before it goes; on one
 * already sent it queues a small <name>.flag record, sent to /v1/flag after the items, with the
 * app and model version and OS of the moment it was pressed (`about`; the server keeps them as
 * the item's flaggedWith).
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const RATE = 16000;
const OUTBOX_CAP = 2 * 1024 ** 3;
const MAX_WAV = 15 * 1024 * 1024;          // the server refuses this size or larger (~8 minutes)
const BACKOFF_MIN_MS = 10e3;
const BACKOFF_MAX_MS = 15 * 60e3;          // offline for a day still retries every quarter hour
const UPLOAD_TIMEOUT_MS = 120e3;
const SEND_REVISE_TEXT = false;
const NOTE_MAX = 200;
const NAME_RE = /^\d{8}T\d{6}Z-[0-9a-f]{16}$/;

/** tester.json, checked; null (and the module stays inert) unless it is complete and sane. */
function readConfig(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!c || !/^[a-z0-9_]{1,32}$/.test(c.tester) || typeof c.key !== 'string' || c.key.length < 16) return null;
    const endpoint = checkEndpoint(c.endpoint);
    if (!endpoint) return null;
    return {
      tester: c.tester,
      endpoint,
      key: c.key,
      with: typeof c.with === 'string' && c.with.trim() ? c.with.trim().slice(0, 40) : 'the developer'
    };
  } catch {
    return null;
  }
}

/** https anywhere, or http on this machine only (tests, a local wrangler dev). Null otherwise. */
function checkEndpoint(raw) {
  try {
    const url = new URL(raw);
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !local) return null;
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** A flag's note: one line, no control characters, at most 200 characters. */
function oneLine(s) {
  return typeof s === 'string'
    ? s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX)   // \s takes U+2028/2029 too
    : '';
}

/** 2026-10-09T19:45:12.345Z -> 20261009T194512Z. The server builds the same stamp for its key. */
function stamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** The renderer captures at 16 kHz already; anything else is resampled linearly. */
function to16k(samples, rate) {
  if (!rate || rate === RATE) return samples;
  const out = new Float32Array(Math.floor((samples.length * RATE) / rate));
  const step = rate / RATE;
  for (let i = 0; i < out.length; i++) {
    const x = i * step, j = Math.floor(x), f = x - j;
    out[i] = samples[j] * (1 - f) + (j + 1 < samples.length ? samples[j + 1] : samples[j]) * f;
  }
  return out;
}

/** Float PCM at 16 kHz -> a 16-bit mono WAV file. */
function encodeWav(samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  if (os.endianness() !== 'LE') data.swap16();   // WAV is little-endian; every Typd target already is
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function writeAtomic(file, data) {
  await fsp.writeFile(file + '.tmp', data);
  await fsp.rename(file + '.tmp', file);
}

/** The WAV an item's samples become, in bytes, without encoding it (the daily limit counts it). */
function wavBytes(samples, rate) {
  const n = !rate || rate === RATE ? samples.length : Math.floor((samples.length * RATE) / rate);
  return 44 + 2 * n;
}

/** The daily limit's count, {day, items, bytes}; a fresh one if the file is absent or not sane. */
function readDay(file, day) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d && d.day === day && Number.isFinite(d.items) && Number.isFinite(d.bytes) && d.items >= 0 && d.bytes >= 0) {
      return { day, items: d.items, bytes: d.bytes };
    }
  } catch { /* none yet */ }
  return { day, items: 0, bytes: 0 };
}

/**
 * The outbox and its uploader.
 *
 *   config     {endpoint, key, tester?} -- or a function returning it, or null while there is
 *              no key yet (the public beta before enrollment)
 *   ensureKey  async () => config: called when config is null and there is something to send
 *              (enrolls). Throwing backs off, honouring err.retryAfter (seconds)
 *   dir        the outbox folder; <name>.wav + <name>.json per item, <name> = <stamp>-<id>;
 *              <name>.flag for a flag on an item already sent
 *   paused     () => boolean; while true nothing is queued and nothing is sent -- except an
 *              item the person shared on its own (consent 'flag'), which is the point of it
 *   on401      () => boolean; the key was refused: true stops sharing (the default), false
 *              backs off and tries again (a key only just made may not have reached every
 *              data centre yet)
 *   onSent     (name) => void, after the server accepted an item
 *   cap        the outbox's size on disk (sent-pending and rejected), oldest dropped first
 *   daily      {items, bytes, file} or null: at most this many dictations and WAV bytes queued a
 *              UTC day, counted in `file` so a restart does not reset it. Past it a dictation is
 *              simply not queued (an item shared on its own, consent 'flag', still is)
 *   fullHoldS  the least wait, in seconds, after the server says its storage is full (507)
 */
function createCollector({
  config, ensureKey = null, dir, paused = () => false, log = () => {}, about = {},
  fetch = globalThis.fetch, cap = OUTBOX_CAP, on401 = () => true, onSent = () => {},
  daily = null, fullHoldS = 0, now = Date.now
}) {
  const rejectedDir = path.join(dir, 'rejected');
  const configNow = typeof config === 'function' ? config : () => config;
  let busy = false;
  let running = null;    // the pass in progress, so idle() can wait for it
  let timer = null;
  let failures = 0;
  let revoked = false;   // the server refused the key: this tester or install was removed
  let stopped = false;   // stop(): nothing more is sent until resume()
  let sending = null;    // the item on the wire right now
  let holdUntil = 0;     // the server said when to come back (Retry-After): nothing goes before then
  let today = null;      // the daily limit's count, read from daily.file when first needed
  let dayWrite = Promise.resolve();   // its writes, one after another, each of the latest count

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(pass, ms);
    if (timer.unref) timer.unref();
  }

  /**
   * Back off: 10 s, 20 s, 40 s ... 15 min, with jitter; longer if the server asks (at most 6 h),
   * and then nothing at all goes before that time, wake() included.
   */
  function retry(after) {
    failures++;
    let ms = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (failures - 1));
    ms = ms / 2 + Math.random() * (ms / 2);
    const asked = Math.min(Number(after) * 1000, 6 * 3600e3);
    if (asked > 0) {
      ms = Math.max(ms, asked);
      holdUntil = Math.max(holdUntil, now() + asked);
    }
    schedule(ms);
  }

  /** May one more dictation of this many WAV bytes be queued today? Counts it if so. */
  function takeDaily(bytes) {
    if (!daily) return true;
    const day = new Date(now()).toISOString().slice(0, 10);
    if (!today || today.day !== day) today = readDay(daily.file, day);
    if (today.items + 1 > daily.items || today.bytes + bytes > daily.bytes) return false;
    today.items++;
    today.bytes += bytes;
    dayWrite = dayWrite
      .then(() => fsp.mkdir(path.dirname(daily.file), { recursive: true }))
      .then(() => writeAtomic(daily.file, JSON.stringify(today)))
      .catch(() => { /* counted in memory for this run anyway */ });
    return true;
  }

  const readJson = async (file) => { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; } };

  /** Items whose two files are both complete, oldest first (names start with a UTC stamp). */
  async function ready() {
    let names;
    try { names = await fsp.readdir(dir); } catch { return []; }
    const have = new Set(names);
    return names
      .filter((n) => n.endsWith('.json') && have.has(n.slice(0, -5) + '.wav'))
      .map((n) => n.slice(0, -5))
      .sort();
  }

  /** Flags waiting for an item already sent. */
  async function flagsWaiting() {
    let names;
    try { names = await fsp.readdir(dir); } catch { return []; }
    return names.filter((n) => n.endsWith('.flag')).map((n) => n.slice(0, -5)).sort();
  }

  /** May this item go now? Always while sharing is on; while paused, only one shared on its own. */
  async function sendable(name) {
    if (!paused()) return true;
    const meta = await readJson(path.join(dir, name + '.json'));
    return Boolean(meta && meta.consent === 'flag');
  }

  async function drop(name) {
    // The .json goes first: it is what marks an item as queued.
    await fsp.unlink(path.join(dir, name + '.json')).catch(() => {});
    await fsp.unlink(path.join(dir, name + '.wav')).catch(() => {});
  }

  /** A permanent refusal (bad request, too large) must not block everything behind it. */
  async function setAside(name) {
    await fsp.mkdir(rejectedDir, { recursive: true });
    for (const ext of ['.wav', '.json']) {
      await fsp.rename(path.join(dir, name + ext), path.join(rejectedDir, name + ext)).catch(() => {});
    }
  }

  async function send(cfg, name) {
    const [wav, meta] = await Promise.all([
      fsp.readFile(path.join(dir, name + '.wav')),
      fsp.readFile(path.join(dir, name + '.json'))
    ]);
    const boundary = '----typd' + crypto.randomBytes(12).toString('hex');
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n`),
      meta,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${name}.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      wav,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const res = await fetch(cfg.endpoint + '/v1/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
    });
    await res.text().catch(() => '');   // free the connection
    return res;
  }

  async function sendFlag(cfg, name) {
    const rec = (await readJson(path.join(dir, name + '.flag'))) || {};
    const body = { name, note: oneLine(rec.note) };
    if (rec.about && typeof rec.about === 'object') body.about = rec.about;   // the versions when it was pressed
    const res = await fetch(cfg.endpoint + '/v1/flag', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30e3)
    });
    await res.text().catch(() => '');
    return res;
  }

  /** The key to send with, enrolling first if there is none yet. Null: backed off (or no way to get one). */
  async function key() {
    const cfg = configNow();
    if (cfg || !ensureKey) return cfg || null;
    try {
      return await ensureKey();
    } catch (err) {
      log('no key yet, will retry', err && err.status ? err.status : (err && err.message));
      retry(err && err.retryAfter);
      return null;
    }
  }

  /**
   * One uploader: items one at a time, oldest first, then waiting flags, until there is nothing
   * left or a send fails (then the backoff timer is already set).
   */
  async function work() {
    for (;;) {
      if (revoked || stopped) return;
      let next = null;
      for (const name of await ready()) if (await sendable(name)) { next = name; break; }
      // A flag goes even while paused: it is about an item already sent, and pressing it is the consent.
      const flag = next ? null : (await flagsWaiting())[0];
      if (!next && !flag) { failures = 0; return; }
      const cfg = await key();
      if (!cfg) return;
      if (revoked || stopped) return;
      let res;
      // `sending` covers the send and the delete after it, so mark() knows when a rewrite of
      // this item's meta could be lost.
      sending = next;
      try {
        res = next ? await send(cfg, next) : await sendFlag(cfg, flag);
      } catch (err) {
        sending = null;
        log('send failed, will retry', next || flag, err && err.message);   // offline, asleep, timed out
        return retry();
      }
      try {
        if (next && res.ok) await drop(next);
      } finally {
        sending = null;
      }
      if (flag) {
        // Accepted, or the item is not on the server (deleted, or never got there): either way done.
        if (res.ok || res.status === 404 || res.status === 400) {
          await fsp.unlink(path.join(dir, flag + '.flag')).catch(() => {});
          failures = 0;
          log('flag sent', flag, res.status);
          continue;
        }
      } else if (res.ok) {
        failures = 0;
        log('sent', next);
        try { onSent(next); } catch { /* the listener's problem */ }
        continue;
      }
      if (res.status === 401) {
        if (on401()) {
          revoked = true;
          log('key refused; sharing stopped');
          return;
        }
        log('key not accepted yet; will retry');
        return retry(60);
      }
      if (!flag && [400, 413, 415, 422].includes(res.status)) {
        log('refused', next, res.status, '-> rejected/');
        await setAside(next);
        continue;
      }
      const after = Number(res.headers.get('retry-after')) || 0;
      if (res.status === 507) {
        // The server's storage is full: it will not empty by itself in minutes. What waits here
        // stays (within the cap) and goes once there is room.
        log('server storage full - waiting');
        return retry(Math.max(after, fullHoldS));
      }
      log('server said', res.status, '- will retry');
      return retry(after);
    }
  }

  async function pass() {
    if (busy) return;
    busy = true;
    clearTimeout(timer);
    timer = null;
    running = work().catch((err) => {
      log('outbox error', err && err.message);
      retry();
    }).finally(() => { busy = false; running = null; });
    return running;
  }

  /** Oldest items go first once the outbox (sent-pending and rejected) passes its cap. */
  async function enforceCap() {
    const groups = new Map();
    let total = 0;
    for (const d of [dir, rejectedDir]) {
      let names;
      try { names = await fsp.readdir(d); } catch { continue; }
      for (const n of names) {
        const p = path.join(d, n);
        const st = await fsp.stat(p).catch(() => null);
        if (!st || !st.isFile()) continue;
        const name = n.replace(/\.(wav|json|flag)(\.tmp)?$/, '');
        const g = groups.get(name) || { bytes: 0, files: [] };
        g.bytes += st.size;
        g.files.push(p);
        groups.set(name, g);
        total += st.size;
      }
    }
    if (total <= cap) return;
    for (const name of [...groups.keys()].sort()) {
      if (total <= cap) break;
      const g = groups.get(name);
      for (const p of g.files) await fsp.unlink(p).catch(() => {});
      total -= g.bytes;
      log('outbox over its cap, dropped', name);
    }
  }

  /**
   * After a crash: half-written files, a .wav whose .json never landed (or was deleted after a
   * send), and a .json whose .wav is gone (a flag that raced the send; its .flag record went too).
   */
  async function tidy() {
    let names;
    try { names = await fsp.readdir(dir); } catch { return; }
    const have = new Set(names);
    for (const n of names) {
      const orphan = (n.endsWith('.wav') && !have.has(n.slice(0, -4) + '.json')) ||
        (n.endsWith('.json') && !have.has(n.slice(0, -5) + '.wav'));
      if (n.endsWith('.tmp') || orphan) await fsp.unlink(path.join(dir, n)).catch(() => {});
    }
  }

  /** The app and model version and OS right now (a flag on an item already sent records them). */
  function versionsNow() {
    let modelVersion = null;
    try { modelVersion = typeof about.modelVersion === 'function' ? about.modelVersion() : about.modelVersion; } catch { modelVersion = null; }
    return {
      appVersion: about.appVersion || null,
      modelVersion: typeof modelVersion === 'string' && modelVersion ? modelVersion.slice(0, 64) : null,
      os: { platform: process.platform, arch: process.arch }
    };
  }

  function makeMeta(rec, created, id) {
    const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
    const cfg = configNow();
    const adapter = rec.reviseAdapter;
    const meta = {
      v: 1,
      id,
      createdAt: created.toISOString(),
      mode: rec.mode,
      output: rec.mode === 'revise' && !SEND_REVISE_TEXT ? null : rec.text,
      outputChars: rec.text.length,
      model: rec.model || null,
      // The exact model version that wrote it (a published version's name, or the bundled model's).
      modelVersion: typeof rec.modelVersion === 'string' && rec.modelVersion ? rec.modelVersion.slice(0, 64) : null,
      // Did the revise adapter run on this item? true (and which file) / false / null: not known.
      reviseAdapter: adapter === undefined || adapter === null ? null : Boolean(adapter),
      reviseAdapterFile: typeof adapter === 'string' && adapter ? path.basename(adapter).slice(0, 128) : null,
      engine: rec.engine || null,
      app: rec.app || null,                                   // process name only, never the window title
      audioSeconds: null,
      recordedAt: null,
      endedAt: iso(rec.endedAt),                              // the second key press
      pastedAt: iso(rec.pastedAt),
      latencyMs: rec.endedAt && rec.pastedAt ? rec.pastedAt - rec.endedAt : null,
      os: { platform: process.platform, release: os.release(), arch: process.arch },
      appVersion: about.appVersion || null,
      electron: process.versions.electron || null
    };
    if (cfg && cfg.tester) meta.tester = cfg.tester;          // the server sets this from the key anyway
    if (rec.consent === 'all' || rec.consent === 'flag') meta.consent = rec.consent;
    if (rec.flag) {
      meta.flag = true;
      const note = oneLine(rec.note);
      if (note) meta.note = note;
    }
    if (rec.test) meta.test = true;
    // A past dictation sent once (backfill.js): which kept recording it is (its file's stamp).
    if (rec.backfill) {
      meta.backfill = true;
      meta.keptAt = rec.keptAt ? new Date(rec.keptAt).toISOString() : null;
    }
    return meta;
  }

  async function write(rec, name, created, id) {
    const wav = encodeWav(to16k(rec.samples, rec.sampleRate));
    if (wav.length >= MAX_WAV) { log('too long to send, skipped', name); return false; }
    const seconds = Math.round(((wav.length - 44) / (RATE * 2)) * 100) / 100;
    const meta = makeMeta(rec, created, id);
    meta.audioSeconds = seconds;
    meta.recordedAt = rec.endedAt ? new Date(rec.endedAt - seconds * 1000).toISOString() : null;   // stop time minus the audio's length
    await fsp.mkdir(dir, { recursive: true });
    await writeAtomic(path.join(dir, name + '.wav'), wav);
    await writeAtomic(path.join(dir, name + '.json'), JSON.stringify(meta, null, 1));
    log('queued', name);
    await enforceCap();
    return true;
  }

  const writes = new Map();   // name -> the pending write, so a flag can wait for it

  /**
   * Queue one finished dictation; returns its name (<stamp>-<id>) at once, or null when nothing
   * was queued. The disk write happens a tick later. While paused only an item shared on its
   * own (rec.consent === 'flag') is taken; past the daily limit, too.
   */
  function queue(rec) {
    if (revoked || stopped || (paused() && rec.consent !== 'flag')) return null;
    if (!rec || !rec.samples || typeof rec.text !== 'string') return null;
    // A past dictation (backfill.js) has a fixed name -- its recording's time and an id made from
    // that recording -- so queuing it twice, or sending it twice, stores it once (the server's key
    // is the same name). Already waiting here: nothing new.
    const fixed = rec.backfill && /^[0-9a-f]{16}$/.test(String(rec.id || '')) && Number.isFinite(rec.keptAt);
    const created = fixed ? new Date(rec.keptAt) : new Date();
    const id = fixed ? rec.id : crypto.randomBytes(8).toString('hex');
    const name = `${stamp(created)}-${id}`;
    if (fixed && (writes.has(name) || fs.existsSync(path.join(dir, name + '.json')))) return name;
    if (rec.consent !== 'flag' && !takeDaily(wavBytes(rec.samples, rec.sampleRate))) {
      log('daily sharing limit reached; not queued');
      return null;
    }
    const p = new Promise((resolve) => setImmediate(resolve)).then(() => write(rec, name, created, id)).then(
      (ok) => { if (ok && !failures) schedule(2000); return ok; },   // mid-backoff, the pending retry stands
      (err) => { log('could not queue', err && err.message); return false; }
    ).finally(() => writes.delete(name));
    writes.set(name, p);
    return name;
  }

  /**
   * "That was wrong" on an item this outbox queued. Still here: its meta gets flag and note
   * before it goes ('marked'). Already sent (or on the wire right now): a .flag record goes to
   * /v1/flag after the items ('queued'). Set aside as refused: 'rejected'.
   */
  async function mark(name, note) {
    if (!NAME_RE.test(String(name))) return 'rejected';
    note = oneLine(note);
    if (writes.has(name)) await writes.get(name);
    const file = path.join(dir, name + '.json'), wavFile = path.join(dir, name + '.wav');
    let marked = false;
    if (sending !== name) {
      const meta = await readJson(file);
      if (meta && fs.existsSync(wavFile)) {
        meta.flag = true;
        if (note) meta.note = note;
        await writeAtomic(file, JSON.stringify(meta, null, 1));
        marked = true;
      } else if (!meta && fs.existsSync(path.join(rejectedDir, name + '.json'))) {
        return 'rejected';
      }
    }
    // Sent already, or sent while the meta was being rewritten: the server needs telling.
    const gone = !fs.existsSync(wavFile);
    if (marked && gone) await fsp.unlink(file).catch(() => {});   // the meta of an item already sent, re-created
    if (!marked || gone || sending === name) {
      await fsp.mkdir(dir, { recursive: true });
      await writeAtomic(path.join(dir, name + '.flag'), JSON.stringify({ name, note, at: new Date().toISOString(), about: versionsNow() }));
    }
    if (!failures) schedule(1000);
    return marked && !gone ? 'marked' : 'queued';
  }

  /**
   * Delete what is waiting here. keepOneOff: an item shared on its own (consent 'flag') stays --
   * turning sharing off withdraws "all of them", not that one.
   */
  async function clear({ keepOneOff = false } = {}) {
    await Promise.all([...writes.values()]);
    let names = [];
    try { names = await fsp.readdir(dir); } catch { /* nothing queued */ }
    const keep = new Set();
    if (keepOneOff) {
      for (const n of names.filter((x) => x.endsWith('.json'))) {
        const meta = await readJson(path.join(dir, n));
        if (meta && meta.consent === 'flag') keep.add(n.slice(0, -5));
      }
    }
    let removed = 0;
    for (const n of names) {
      const base = n.replace(/\.(wav|json|flag)(\.tmp)?$/, '');
      if (keep.has(base)) continue;
      const p = path.join(dir, n);
      const st = await fsp.stat(p).catch(() => null);
      if (!st || !st.isFile()) continue;
      await fsp.unlink(p).catch(() => {});
      if (n.endsWith('.json')) removed++;
    }
    if (!keepOneOff) await fsp.rm(rejectedDir, { recursive: true, force: true }).catch(() => {});
    return removed;
  }

  return {
    /** Queue one finished dictation. Returns at once (true when queued); the disk write happens a tick later. */
    add(rec) {
      return Boolean(queue(rec));
    },
    queue,
    mark,
    clear,
    /** Launch: clean up after any crash, then send whatever a previous run left behind. */
    async start() {
      await tidy();
      await enforceCap();
      schedule(0);
    },
    /**
     * Back from sleep, a lock screen or a pause: try now instead of waiting out the backoff --
     * unless the server said when to come back (a daily cap, storage full): then the retry
     * already set stands.
     */
    wake(ms = 3000) {
      if (holdUntil > now()) return;
      failures = 0;
      schedule(ms);
    },
    /** Nothing more is sent (an upload in flight finishes) until resume(). */
    stop() { stopped = true; clearTimeout(timer); timer = null; },
    resume() { stopped = false; },
    /** Resolves when no send is in progress. */
    async idle() { while (running) await running; },
    /** The key was replaced (a fresh enrollment): forget that the old one was refused, or held. */
    reset() { revoked = false; failures = 0; holdUntil = 0; },
    /** Until when the server asked for nothing more (ms since the epoch; 0: no such wait). */
    heldUntil: () => (holdUntil > now() ? holdUntil : 0),
    pending: async () => (await ready()).length,
    /** What the daily limit still allows today, {items, bytes}; null where there is none (testers). */
    dailyLeft() {
      if (!daily) return null;
      const day = new Date(now()).toISOString().slice(0, 10);
      if (!today || today.day !== day) today = readDay(daily.file, day);
      return { items: Math.max(0, daily.items - today.items), bytes: Math.max(0, daily.bytes - today.bytes) };
    },
    /** The metas of the items waiting here ({name, createdAt, keptAt, backfill}), oldest first. */
    async waiting() {
      const out = [];
      for (const name of await ready()) {
        const m = await readJson(path.join(dir, name + '.json'));
        if (m) out.push({ name, createdAt: m.createdAt || null, keptAt: m.keptAt || null, backfill: m.backfill === true });
      }
      return out;
    },
    isRevoked: () => revoked,
    status: () => {
      const cfg = configNow();
      return { tester: cfg && cfg.tester, with: cfg && cfg.with, state: revoked ? 'stopped' : paused() ? 'paused' : 'on' };
    }
  };
}

module.exports = { createCollector, readConfig, checkEndpoint, encodeWav, oneLine, stamp, NOTE_MAX };
