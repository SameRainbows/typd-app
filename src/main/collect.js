'use strict';

/**
 * Tester builds only: share finished dictations with the developer, with consent.
 *
 * Law 1 says your voice never leaves the machine, and in every ordinary build it does not:
 * this module is inert unless a tester.json sits beside the app's resources (packaged:
 * <resources>/tester.json; development: the repo root, git-ignored) holding
 * {tester, endpoint, key}. The few people who have one agreed, explicitly, to their recordings
 * and transcripts being used to develop and benchmark the model. Settings says so in one line,
 * and pausing there queues and sends nothing.
 *
 * One item is: the captured audio as a 16 kHz mono 16-bit WAV, the text Typd pasted, the mode,
 * the model file, the name of the app it went into, timestamps and durations, OS and app
 * version. NEVER the screen context, the highlighted span or a window title -- those are other
 * people's words. For a revision the pasted text is left out too (SEND_REVISE_TEXT): it is the
 * highlighted span rewritten, so it would carry the very text that rule keeps out. The spoken
 * instruction's audio is kept.
 *
 * Nothing here is on the critical path. add() returns at once; a tick later the item is written
 * to an outbox on disk, and one uploader sends one item at a time, deleting the local copy only
 * after the server answers 2xx. Failures back off exponentially; the outbox survives restarts,
 * sleep and being offline, and is capped at 2 GB, oldest dropped first.
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
const START_DELAY_MS = 20e3;               // a restart resumes the outbox once launch has settled
const SEND_REVISE_TEXT = false;

/** tester.json, checked; null (and the module stays inert) unless it is complete and sane. */
function readConfig(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!c || !/^[a-z0-9_]{1,32}$/.test(c.tester) || typeof c.key !== 'string' || c.key.length < 16) return null;
    const url = new URL(c.endpoint);
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !local) return null;
    return {
      tester: c.tester,
      endpoint: url.href.replace(/\/+$/, ''),
      key: c.key,
      with: typeof c.with === 'string' && c.with.trim() ? c.with.trim().slice(0, 40) : 'the developer'
    };
  } catch {
    return null;
  }
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

/**
 * The outbox and its uploader. Electron-free so a plain Node script can drive it (the
 * end-to-end check in typd-collect does).
 *
 *   config   readConfig() result
 *   dir      the outbox folder; <name>.wav + <name>.json per item, <name> = <stamp>-<id>
 *   paused   () => boolean; while true nothing is queued and nothing is sent
 */
function createCollector({ config, dir, paused = () => false, log = () => {}, about = {}, fetch = globalThis.fetch, cap = OUTBOX_CAP }) {
  const rejectedDir = path.join(dir, 'rejected');
  let busy = false;
  let timer = null;
  let failures = 0;
  let revoked = false;   // the server refused the key: this tester was removed

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(pass, ms);
    if (timer.unref) timer.unref();
  }

  /** Back off: 10 s, 20 s, 40 s ... 15 min, with jitter; longer if the server asks. */
  function retry(after) {
    failures++;
    let ms = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (failures - 1));
    ms = ms / 2 + Math.random() * (ms / 2);
    const asked = Number(after) * 1000;
    if (asked > 0) ms = Math.max(ms, Math.min(asked, 6 * 3600e3));
    schedule(ms);
  }

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

  async function send(name) {
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
    const res = await fetch(config.endpoint + '/v1/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + config.key, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
    });
    await res.text().catch(() => '');   // free the connection
    return res;
  }

  /** One uploader: one item at a time, oldest first, until the outbox is empty or a send fails. */
  async function pass() {
    if (busy) return;
    busy = true;
    clearTimeout(timer);
    timer = null;
    try {
      for (;;) {
        if (revoked || paused()) return;
        const [next] = await ready();
        if (!next) { failures = 0; return; }
        let res;
        try {
          res = await send(next);
        } catch (err) {
          log('send failed, will retry', next, err && err.message);   // offline, asleep, timed out
          return retry();
        }
        if (res.ok) {
          await drop(next);
          failures = 0;
          log('sent', next);
          continue;
        }
        if (res.status === 401) {
          revoked = true;
          log('key refused; sharing stopped until restart');
          return;
        }
        if ([400, 413, 415, 422].includes(res.status)) {
          log('refused', next, res.status, '-> rejected/');
          await setAside(next);
          continue;
        }
        log('server said', res.status, '- will retry');
        return retry(res.headers.get('retry-after'));
      }
    } catch (err) {
      log('outbox error', err && err.message);
      retry();
    } finally {
      busy = false;
    }
  }

  /** Oldest items go first once the outbox (sent-pending and rejected) passes 2 GB. */
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
        const name = n.replace(/\.(wav|json)(\.tmp)?$/, '');
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
      log('outbox over 2 GB, dropped', name);
    }
  }

  /** After a crash: half-written files, and a .wav whose .json never landed (or was deleted after a send). */
  async function tidy() {
    let names;
    try { names = await fsp.readdir(dir); } catch { return; }
    const have = new Set(names);
    for (const n of names) {
      const orphan = n.endsWith('.wav') && !have.has(n.slice(0, -4) + '.json');
      if (n.endsWith('.tmp') || orphan) await fsp.unlink(path.join(dir, n)).catch(() => {});
    }
  }

  async function write(rec) {
    const created = new Date();
    const id = crypto.randomBytes(8).toString('hex');
    const name = `${stamp(created)}-${id}`;
    const wav = encodeWav(to16k(rec.samples, rec.sampleRate));
    if (wav.length >= MAX_WAV) { log('too long to send, skipped', name); return; }
    const seconds = Math.round(((wav.length - 44) / (RATE * 2)) * 100) / 100;
    const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
    const meta = {
      v: 1,
      id,
      tester: config.tester,
      createdAt: created.toISOString(),
      mode: rec.mode,
      output: rec.mode === 'revise' && !SEND_REVISE_TEXT ? null : rec.text,
      outputChars: rec.text.length,
      model: rec.model || null,
      engine: rec.engine || null,
      app: rec.app || null,                                   // process name only, never the window title
      audioSeconds: seconds,
      recordedAt: iso(rec.endedAt && rec.endedAt - seconds * 1000),   // stop time minus the audio's length
      endedAt: iso(rec.endedAt),                              // the second key press
      pastedAt: iso(rec.pastedAt),
      latencyMs: rec.endedAt && rec.pastedAt ? rec.pastedAt - rec.endedAt : null,
      os: { platform: process.platform, release: os.release(), arch: process.arch },
      appVersion: about.appVersion || null,
      electron: process.versions.electron || null
    };
    if (rec.test) meta.test = true;
    await fsp.mkdir(dir, { recursive: true });
    await writeAtomic(path.join(dir, name + '.wav'), wav);
    await writeAtomic(path.join(dir, name + '.json'), JSON.stringify(meta, null, 1));
    log('queued', name);
    await enforceCap();
  }

  return {
    /** Queue one finished dictation. Returns at once; the disk write happens a tick later. */
    add(rec) {
      if (revoked || paused()) return false;
      setImmediate(() => {
        write(rec).then(
          () => { if (!failures) schedule(2000); },   // mid-backoff, the pending retry stands
          (err) => log('could not queue', err && err.message)
        );
      });
      return true;
    },
    /** Launch: clean up after any crash, then send whatever a previous run left behind. */
    async start() {
      await tidy();
      await enforceCap();
      schedule(0);
    },
    /** Back from sleep, a lock screen or a pause: try now instead of waiting out the backoff. */
    wake(ms = 3000) {
      failures = 0;
      schedule(ms);
    },
    pending: async () => (await ready()).length,
    status: () => ({ tester: config.tester, with: config.with, state: revoked ? 'stopped' : paused() ? 'paused' : 'on' })
  };
}

/* ------------------------------------------------------------- the app's instance */

let electron = null;
try {
  const e = require('electron');
  if (e && typeof e === 'object' && e.app) electron = e;   // under plain Node this is a path string
} catch { /* not running in Electron */ }

const debug = (...a) => { if (process.env.TYPD_DEBUG) console.log('[typd:collect]', ...a); };
let main;   // undefined until first asked; false when this is not a tester build

function instance() {
  if (main !== undefined) return main;
  main = false;
  if (!electron) return main;
  const { app, powerMonitor } = electron;
  // A development run collects only when asked to (TYPD_TESTER_DEV=1). The repo root is also
  // where the developer runs their own Typd every day, and a stray tester.json there once
  // queued the developer's dictations under a tester's name (2026-10-09). A packaged build
  // carries tester.json only when it was built as a tester build (scripts/after-pack.js).
  if (!app.isPackaged && process.env.TYPD_TESTER_DEV !== '1') return main;
  const file = app.isPackaged ? path.join(process.resourcesPath, 'tester.json') : path.join(__dirname, '..', '..', 'tester.json');
  const config = readConfig(file);
  if (!config) return main;

  const settings = require('./settings');
  main = createCollector({
    config,
    dir: path.join(app.getPath('userData'), 'outbox'),
    paused: () => settings.get('sharePaused'),
    log: debug,
    about: { appVersion: app.getVersion() }
  });
  app.whenReady().then(() => {
    const t = setTimeout(() => main.start(), START_DELAY_MS);
    if (t.unref) t.unref();
    for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, () => main.wake());
    settings.onChange((key, value) => { if (key === 'sharePaused' && !value) main.wake(1000); });
  });
  return main;
}

// Built at load, so an outbox left by the previous run resumes without waiting for a dictation.
instance();

/**
 * Called once per session, after its text was pasted successfully (src/main/index.js).
 * Never throws and never waits.
 */
function add(session, text) {
  try {
    const c = instance();
    // A stub session's text never came from its audio; it would be a wrong label.
    if (!c || process.argv.includes('--stub')) return;
    if (!session || !session.audio || !session.audio.samples || typeof text !== 'string') return;
    let model = null, engine = null;
    try { model = path.basename(require('./pipeline/local').MODEL); } catch { /* unknown */ }
    try { engine = require('./pipeline').ENGINE; } catch { /* unknown */ }
    c.add({
      samples: session.audio.samples,
      sampleRate: session.audio.sampleRate,
      text,
      mode: session.mode,
      app: session.target && session.target.process ? session.target.process : null,
      model,
      engine,
      endedAt: session.endedAt || null,
      pastedAt: Date.now()
    });
  } catch (err) {
    debug('add failed', err && err.message);
  }
}

/** For Settings: null in an ordinary build, else {tester, with, state: 'on'|'paused'|'stopped'}. */
function status() {
  const c = instance();
  return c ? c.status() : null;
}

module.exports = { add, status, createCollector, readConfig, encodeWav };
