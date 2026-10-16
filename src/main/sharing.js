'use strict';

/**
 * Sharing dictations with the developer -- only ever with consent.
 *
 * Law 1 says your voice never leaves the machine, and by default it does not: nothing is queued
 * or sent until the person says so. There are two ways to say so.
 *
 *   The public beta (any packaged build). On first run one plain screen (consent-window) asks:
 *   "Share my dictations to improve Typd" or "Keep everything on my computer", two equal
 *   buttons, and nothing is sent until the first is picked. Settings can change it any time.
 *   Choosing to share enrolls this install with typd-collect (POST /v1/enroll): an anonymous,
 *   random key, kept in <userData>/share.json and nowhere else. "Delete what I've shared"
 *   deletes everything stored for that key on the server (DELETE /v1/me), empties the outbox
 *   here, forgets the key and turns sharing off.
 *
 *   A tester build (a tester.json bundled in the app's resources: README "Tester builds"). The
 *   tester agreed in person; the bundled key wins, there is no consent screen, and Settings
 *   keeps its one line with a pause -- exactly as before the beta.
 *
 * "That was wrong" (the tray, or a hotkey): flags the last dictation. If it was shared, it is
 * marked -- in the outbox if it has not gone yet, else on the server (POST /v1/flag) -- with an
 * optional one-line note. If it was not (sharing off), Typd asks once, for that dictation only:
 * "Share this one dictation so it can be fixed?" Only a yes sends it, marked consent 'flag'.
 * The last dictation's audio is held in memory for that, never written anywhere, and forgotten
 * after an hour or at the next dictation.
 *
 * What one item carries, and never carries, is collect.js's business; so is the outbox.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { createCollector, readConfig, checkEndpoint, oneLine } = require('./collect');

const ENDPOINT = 'https://typd-collect.mehmetdedeler.com';
const KEY_RE = /^ik_[A-Za-z0-9_-]{40,64}$/;
const ID_RE = /^i-[0-9a-f]{20}$/;
const FRESH_KEY_MS = 10 * 60e3;   // a new key can take a minute to reach every data centre
const LAST_KEEP_MS = 3600e3;      // the last dictation's audio is forgotten after an hour
const ENROLL_TIMEOUT_MS = 20e3;
const START_DELAY_MS = 20e3;      // a restart resumes the outbox once launch has settled

/** <userData>/share.json: {endpoint, key, id, enrolledAt}, checked; null if absent or not sane. */
function readKeyFile(file) {
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8'));
    const endpoint = checkEndpoint(k && k.endpoint);
    if (!endpoint || !KEY_RE.test(k.key) || !ID_RE.test(k.id)) return null;
    return { endpoint, key: k.key, id: k.id, enrolledAt: typeof k.enrolledAt === 'string' ? k.enrolledAt : null };
  } catch {
    return null;
  }
}

async function writeKeyFile(file, rec) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  await fsp.rename(tmp, file);
}

/**
 * The policy, Electron-free (bench/sharing.js drives it against a fake server).
 *
 *   tester     readConfig(tester.json) or null: a bundled tester key wins over everything
 *   endpoint   the public beta's server
 *   keyFile    <userData>/share.json
 *   dir        the outbox
 *   choice     {get, set}: settings 'share' -- '' (not asked yet), 'on' or 'off'
 *   paused     () => boolean: a tester build's pause (settings 'sharePaused')
 */
function createSharing({
  tester = null, endpoint = ENDPOINT, keyFile, dir, choice, paused = () => false,
  about = {}, fetch = globalThis.fetch, log = () => {}, now = Date.now, cap
}) {
  const mode = tester ? 'tester' : 'beta';
  let keyRec = mode === 'beta' ? readKeyFile(keyFile) : null;
  let enrolling = null;
  let last = null;   // {rec, name, at}: the last finished dictation, in memory only

  const sharingOn = () => (mode === 'tester' ? !paused() : choice.get() === 'on');

  async function enroll() {
    const res = await fetch(endpoint + '/v1/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appVersion: about.appVersion || null }),
      signal: AbortSignal.timeout(ENROLL_TIMEOUT_MS)
    });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (res.status !== 201 || !body || !KEY_RE.test(body.key) || !ID_RE.test(body.id)) {
      const err = new Error('enrollment refused');
      err.status = res.status;
      err.retryAfter = res.headers.get('retry-after');
      throw err;
    }
    keyRec = { endpoint, key: body.key, id: body.id, enrolledAt: new Date(now()).toISOString() };
    await writeKeyFile(keyFile, keyRec);
    collector.reset();
    log('enrolled', body.id);   // the id is safe to show; the key never is
    return { endpoint: keyRec.endpoint, key: keyRec.key };
  }

  /** The install key, enrolling once if there is none. Concurrent callers share one request. */
  function ensureKey() {
    if (keyRec) return Promise.resolve({ endpoint: keyRec.endpoint, key: keyRec.key });
    if (!enrolling) enrolling = enroll().finally(() => { enrolling = null; });
    return enrolling;
  }

  const collector = createCollector({
    config: () => (mode === 'tester' ? tester : keyRec ? { endpoint: keyRec.endpoint, key: keyRec.key } : null),
    ensureKey: mode === 'beta' ? ensureKey : null,
    dir,
    paused: () => !sharingOn(),
    log, about, fetch, cap,
    // A tester key refused means the tester was removed: stop. An install key refused within
    // minutes of its enrollment has probably not reached that data centre yet: try again.
    on401: () => !(mode === 'beta' && keyRec && keyRec.enrolledAt && now() - Date.parse(keyRec.enrolledAt) < FRESH_KEY_MS)
  });

  async function forgetKey() {
    keyRec = null;
    await fsp.unlink(keyFile).catch(() => {});
  }

  const lastLive = () => (last && now() - last.at < LAST_KEEP_MS ? last : null);

  return {
    mode,

    /** True until the person has answered the consent screen (public beta only). */
    needsConsent: () => mode === 'beta' && !['on', 'off'].includes(choice.get()),

    /**
     * For Settings. Tester: {mode, tester, with, state: 'on'|'paused'|'stopped'} as before.
     * Beta: {mode, state: 'unset'|'on'|'off'|'stopped', shared, id}; `shared` says a key exists,
     * so something may be stored on the server and "Delete what I've shared" applies.
     */
    status() {
      if (mode === 'tester') return { mode, ...collector.status(), with: tester.with, tester: tester.tester };
      const c = choice.get();
      return {
        mode,
        state: collector.isRevoked() ? 'stopped' : c === 'on' ? 'on' : c === 'off' ? 'off' : 'unset',
        shared: Boolean(keyRec),
        id: keyRec ? keyRec.id : null
      };
    },

    /**
     * A finished dictation (its text pasted). Held in memory as "the last one", for a flag;
     * queued only if sharing is on. Returns true when queued.
     */
    add(rec) {
      last = { rec, name: null, at: now() };
      if (!sharingOn()) return false;
      const name = collector.queue(mode === 'beta' ? { ...rec, consent: 'all' } : rec);
      last.name = name;
      return Boolean(name);
    },

    /**
     * Public beta: 'on' (enrolls now if it can; if offline, at the first send) or 'off' (what is
     * still waiting in the outbox is deleted; a dictation shared on its own still goes).
     * Returns {ok, enrolled?}.
     */
    async choose(value) {
      if (mode !== 'beta' || !['on', 'off'].includes(value)) return { ok: false };
      if (value === 'off') {
        choice.set('off');
        await collector.clear({ keepOneOff: true });
        return { ok: true };
      }
      if (collector.isRevoked()) { await forgetKey(); collector.reset(); }   // refused before: start afresh
      choice.set('on');
      try {
        await ensureKey();
        collector.wake(1000);
        return { ok: true, enrolled: true };
      } catch (err) {
        log('enrollment failed; will retry with the first dictation', err && (err.status || err.message));
        return { ok: true, enrolled: false };
      }
    },

    /** What a flag would act on: null, or {text, mode, at, needsConsent}. */
    lastInfo() {
      const l = lastLive();
      if (!l) return null;
      return { text: l.rec.text, mode: l.rec.mode, at: new Date(l.at).toISOString(), needsConsent: !l.name };
    },

    /**
     * "That was wrong" on the last dictation. Returns {state}:
     *   'none'     nothing to flag (no dictation yet, or over an hour ago)
     *   'ask'      it was never shared: ask "Share this one dictation so it can be fixed?" and
     *              call again with consent: true on a yes. Nothing was sent.
     *   'flagged'  marked (how: 'marked' in the outbox, 'queued' for the server, 'shared' as a
     *              dictation shared on its own)
     *   'failed'   could not (it was refused by the server earlier, or sharing is stopped)
     */
    async flag({ note = '', consent = false } = {}) {
      const l = lastLive();
      if (!l) return { state: 'none' };
      note = oneLine(note);
      if (l.name) {
        const how = await collector.mark(l.name, note);
        return how === 'rejected' ? { state: 'failed' } : { state: 'flagged', how };
      }
      if (!consent) return { state: 'ask' };
      const name = collector.queue({ ...l.rec, flag: true, note, consent: 'flag' });
      if (!name) return { state: 'failed' };
      l.name = name;
      if (mode === 'beta') ensureKey().catch(() => { /* the uploader retries */ });
      collector.wake(1000);
      return { state: 'flagged', how: 'shared' };
    },

    /**
     * "Delete what I've shared" (public beta): stop the uploader, empty the outbox, delete
     * everything stored for this install's key on the server, forget the key, sharing off.
     * Returns {ok, deleted} or {ok: false, reason: 'offline'|'server'}; on failure the key is
     * kept so it can be tried again (the outbox is already empty and sharing is off).
     */
    async deleteShared() {
      if (mode !== 'beta') return { ok: false, reason: 'tester' };
      collector.stop();
      try {
        await collector.idle();
        await collector.clear();
        last = null;
        choice.set('off');
        if (!keyRec) return { ok: true, deleted: 0 };
        let res;
        try {
          res = await fetch(keyRec.endpoint + '/v1/me', {
            method: 'DELETE', headers: { Authorization: 'Bearer ' + keyRec.key }, signal: AbortSignal.timeout(60e3)
          });
        } catch (err) {
          log('delete failed', err && err.message);
          return { ok: false, reason: 'offline' };
        }
        if (res.status === 401) { await forgetKey(); return { ok: true, deleted: 0 }; }   // nothing is stored for it
        if (!res.ok) { log('delete refused', res.status); return { ok: false, reason: 'server' }; }
        let body = {};
        try { body = await res.json(); } catch { /* fine */ }
        await forgetKey();
        collector.reset();
        return { ok: true, deleted: Number(body.deleted) || 0 };
      } finally {
        collector.resume();
      }
    },

    start: () => collector.start(),
    wake: (ms) => collector.wake(ms),
    pending: () => collector.pending()
  };
}

/* ------------------------------------------------------------- the app's instance */

let electron = null;
try {
  const e = require('electron');
  if (e && typeof e === 'object' && e.app) electron = e;   // under plain Node this is a path string
} catch { /* not running in Electron */ }

const debug = (...a) => { if (process.env.TYPD_DEBUG) console.log('[typd:share]', ...a); };
let main;   // undefined until first asked; false when sharing is not available in this build

function instance() {
  if (main !== undefined) return main;
  main = false;
  if (!electron) return main;
  const { app, powerMonitor } = electron;
  // Development: a tester key only with TYPD_TESTER_DEV=1 -- the repo root is where the developer
  // runs their own Typd every day, and a stray tester.json there once queued the developer's
  // dictations under a tester's name (2026-10-09) -- and the public beta's consent screen only
  // with TYPD_SHARE_DEV=1 (and TYPD_COLLECT_URL to point it at a local wrangler dev).
  const devTester = !app.isPackaged && process.env.TYPD_TESTER_DEV === '1';
  const devBeta = !app.isPackaged && process.env.TYPD_SHARE_DEV === '1';
  // Packaged: <resources>/tester.json, or after a macOS app update the copy kept from the version it
  // replaced (src/main/carried.js).
  const tester = app.isPackaged || devTester
    ? readConfig(app.isPackaged ? (require('./carried').resource('tester.json') || path.join(process.resourcesPath, 'tester.json')) : path.join(__dirname, '..', '..', 'tester.json'))
    : null;
  if (!tester && !app.isPackaged && !devBeta) return main;
  const endpoint = (!app.isPackaged && checkEndpoint(process.env.TYPD_COLLECT_URL)) || ENDPOINT;

  const settings = require('./settings');
  const userData = app.getPath('userData');
  main = createSharing({
    tester,
    endpoint,
    keyFile: path.join(userData, 'share.json'),
    dir: path.join(userData, 'outbox'),
    choice: { get: () => settings.get('share'), set: (v) => settings.set('share', v) },
    paused: () => settings.get('sharePaused'),
    log: debug,
    // A flag on an item already sent records the versions running when it was pressed (collect.js).
    about: { appVersion: app.getVersion(), modelVersion: () => require('./pipeline/local').modelVersion() }
  });
  app.whenReady().then(() => {
    const t = setTimeout(() => main.start(), START_DELAY_MS);
    if (t.unref) t.unref();
    for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, () => main.wake());
    settings.onChange((key, value) => {
      if (key === 'sharePaused' && !value) main.wake(1000);
    });
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
    const s = instance();
    // A stub session's text never came from its audio; it would be a wrong label.
    if (!s || process.argv.includes('--stub')) return;
    if (!session || !session.audio || !session.audio.samples || typeof text !== 'string') return;
    let model = null, modelVersion = null, engine = null;
    try {
      const local = require('./pipeline/local');
      model = path.basename(local.MODEL);
      modelVersion = local.modelVersion();   // the exact version: r24_1p7b_rev128, not just the GGUF's name
    } catch { /* unknown */ }
    try { engine = require('./pipeline').ENGINE; } catch { /* unknown */ }
    s.add({
      samples: session.audio.samples,
      sampleRate: session.audio.sampleRate,
      text,
      mode: session.mode,
      app: session.target && session.target.process ? session.target.process : null,
      model,
      modelVersion,
      // The adapter file a local revision ran with, or false: set from the pipeline's 'done' (index.js).
      reviseAdapter: session.reviseAdapter || false,
      engine,
      endedAt: session.endedAt || null,
      pastedAt: Date.now()
    });
  } catch (err) {
    debug('add failed', err && err.message);
  }
}

/** Null when this build cannot share (development without TYPD_SHARE_DEV), else the instance. */
function get() {
  return instance() || null;
}

/** For Settings: null when sharing is not available here, else sharing's status(). */
function status() {
  const s = instance();
  return s ? s.status() : null;
}

module.exports = { add, get, status, createSharing, readKeyFile, ENDPOINT };
