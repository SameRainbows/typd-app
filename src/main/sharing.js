'use strict';

/**
 * Sharing dictations with the developer, to improve Typd's model. Dictating itself never needs
 * the network: an item is queued only after its text landed (pasted, or copied when the paste fell
 * back to the clipboard), and sent from the outbox later.
 *
 *   Public builds (any packaged build without a tester key). Sharing is ASKED (settings 'share':
 *   'on', 'off', or 'ask' = not answered yet, which queues nothing and sends nothing), and since
 *   0.2.12 it is on only where a person chose it -- the walkthrough's first screen, the small
 *   screen or Settings' switch (settings 'shareChosen', recorded with the choice). A fresh install
 *   is asked on the walkthrough's first screen; every other install that never chose is asked once,
 *   in one small screen at its next launch (ask-window.js 'share'; after an app update's quiet
 *   relaunch, once someone is at the keyboard): "Help make Typd better?", Share / Don't share,
 *   nothing preselected. That is every 'on' an earlier Typd left without a recorded choice --
 *   0.2.4-0.2.6's default, and the installs 0.2.7-0.2.11 kept on without asking because they were
 *   first started before 2026-10-18 15:00 UTC (no exemption any more) -- since settings.json cannot
 *   tell such an 'on' from a choice (settings.js shareRule). An explicit 'off' stays off, a recorded
 *   'on' stays on. Settings > "Share dictations" switches it either way at once (off deletes what still
 *   waits in the outbox). Answering Don't share on an install not answered yet that holds a key (it
 *   shared before this run) deletes what it shared, as "Delete what I've shared" does (answer());
 *   offline, that delete is retried at later launches until it goes.
 *   The first item to send enrolls this install with typd-collect (POST /v1/enroll): an
 *   anonymous, random key, kept in <userData>/share.json and nowhere else. "Delete what I've
 *   shared" deletes everything stored for that key on the server (DELETE /v1/me), empties the
 *   outbox here, forgets the key and turns sharing off. A public install shares at most
 *   DAILY_ITEMS dictations / DAILY_BYTES of audio a UTC day, keeps at most OUTBOX_CAP_PUBLIC
 *   waiting on disk, and waits FULL_HOLD_S after the server says its storage is full -- all
 *   silently, with nothing shown.
 *
 *   A tester build (a tester.json bundled in the app's resources: README "Tester builds"). The
 *   tester agreed in person; the bundled key wins, and Settings keeps its one line with a
 *   pause -- exactly as before.
 *
 * "That was wrong" (the tray, or a hotkey): flags the last dictation. If it was shared, it is
 * marked -- in the outbox if it has not gone yet, else on the server (POST /v1/flag) -- with an
 * optional one-line note. If it was not (sharing off, or past the day's limit), Typd asks once,
 * for that dictation only: "Share this one dictation so it can be fixed?" Only a yes sends it,
 * marked consent 'flag'. The last dictation's audio is held in memory for that, never written
 * anywhere, and forgotten after an hour or at the next dictation.
 *
 * What one item carries, and never carries, is collect.js's business; so is the outbox.
 *
 * Past dictations (backfill.js): kept recordings never shared go out once, slowly -- from
 * Settings > "Send my past dictations", or when the server asks for this key (GET /v1/me says
 * {backfill: true}; typd-collect's allowlist). Never while sharing is off or not answered; never
 * again after "Delete what I've shared". And once by itself (0.2.7, autoBackfillWhy): on an install
 * that shares and never shared anything -- its 0.2.4-0.2.6 recordings, kept while sharing was meant
 * to be on -- decided only once it is answered, so an install not answered yet sends nothing.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { createCollector, readConfig, checkEndpoint, oneLine, writeAtomic, why } = require('./collect');

const ENDPOINT = 'https://typd-collect.mehmetdedeler.com';
const KEY_RE = /^ik_[A-Za-z0-9_-]{40,64}$/;
const ID_RE = /^i-[0-9a-f]{20}$/;
const FRESH_KEY_MS = 10 * 60e3;   // a new key can take a minute to reach every data centre
const LAST_KEEP_MS = 3600e3;      // the last dictation's audio is forgotten after an hour
const ENROLL_TIMEOUT_MS = 20e3;
const START_DELAY_MS = 20e3;      // a restart resumes the outbox once launch has settled
const ASK_DELAY_MS = 40e3;        // then GET /v1/me: does the server ask for past dictations?
const ASK_EVERY_MS = 6 * 3600e3;  // and again every 6 hours while Typd runs
// Public builds only (testers keep collect.js's defaults): what one install may send a UTC day,
// what may wait on disk, and how long to wait once the server's storage is full (507).
const DAILY_ITEMS = 50;
const DAILY_BYTES = 20e6;
const OUTBOX_CAP_PUBLIC = 100e6;
const FULL_HOLD_S = 6 * 3600;

/** <userData>/share.json: {endpoint, key, id, enrolledAt}, checked; null if absent or not sane. */
function readKeyFile(file) {
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8'));
    const endpoint = checkEndpoint(k && k.endpoint);
    if (!endpoint || !KEY_RE.test(k.key) || !ID_RE.test(k.id)) return null;
    const rec = { endpoint, key: k.key, id: k.id, enrolledAt: typeof k.enrolledAt === 'string' ? k.enrolledAt : null };
    if (k.deleteWanted === true) rec.deleteWanted = true;   // Don't share answered, the delete not through yet
    return rec;
  } catch {
    return null;
  }
}

async function writeKeyFile(file, rec) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });   // a rename an antivirus holds is retried
}

// What the collector logs that means something did not go (the life log keeps these, once each
// until the next success), and an item's name, which the life log never needs.
const PROBLEMS = new Set([
  'no key yet, will retry', 'send failed, will retry', 'server said', 'server storage full - waiting', 'refused',
  'key refused; sharing stopped', 'key not accepted yet; will retry', 'could not queue', 'too long to send, skipped',
  'daily sharing limit reached; not queued', 'outbox error', 'outbox over its cap, dropped'
]);
const ITEM_RE = /^\d{8}T\d{6}Z-[0-9a-f]{16}$/;

/**
 * The policy, Electron-free (bench/sharing.js drives it against a fake server).
 *
 *   tester     readConfig(tester.json) or null: a bundled tester key wins over everything
 *   endpoint   the public builds' server
 *   keyFile    <userData>/share.json
 *   dir        the outbox
 *   choice     {get, set}: settings 'share' -- 'on', 'off' or 'ask' (not answered: off). Only 'on'
 *              is on (settings.js turns an earlier Typd's '' or unchosen 'on' into 'ask'); set()
 *              takes 'on' or 'off', and the app's settings record it as a choice (shareChosen)
 *   paused     () => boolean: a tester build's pause (settings 'sharePaused')
 *   dayFile    public builds: where the daily limit's count is kept (default <dir>/../share-day.json)
 *   cap, daily, fullHoldS   override the public builds' limits (bench/sharing.js); testers get
 *              collect.js's defaults (2 GB, no daily limit, the server's Retry-After)
 *   note       (what, detail) => void: the few events worth keeping in the life log (lifelog.js), so
 *              "Copy diagnostics" can say why nothing was shared: the first dictation queued and the
 *              first sent this run, an enrollment, and each kind of failure once until it succeeds
 *              again. Never a key, an item's name or any dictated text.
 */
function createSharing({
  tester = null, endpoint = ENDPOINT, keyFile, dir, choice, paused = () => false,
  about = {}, fetch = globalThis.fetch, log = () => {}, now = Date.now, cap, daily, fullHoldS, dayFile,
  onOff = () => {}, onDeleted = () => {}, note = () => {}
}) {
  const mode = tester ? 'tester' : 'beta';
  let keyRec = mode === 'beta' ? readKeyFile(keyFile) : null;
  // Whether this install had shared before this run began (a key is made by the first send): the
  // one automatic backfill is only for installs that never shared (autoBackfillWhy).
  const hadKey = Boolean(keyRec);
  let enrolling = null;
  let last = null;   // {rec, name, at}: the last finished dictation, in memory only

  // This run, for diagnostics(): dictations queued, kept back (and why) and sent, and the last problem.
  const run = { queued: 0, notQueued: {}, sent: 0, lastSentAt: null, problem: null, problemAt: null };
  const noted = new Set();   // problems already in the life log since the last success
  function tell(what, detail) { try { note(what, detail); } catch { /* the log's problem */ } }
  function track(what, ...rest) {
    const detail = rest.filter((x) => x !== undefined && x !== null && x !== '' && !ITEM_RE.test(String(x))).join(' ');
    if (what === 'queued') {
      if (run.queued++ === 0) tell('queued', 'the first dictation this run');
    } else if (what === 'sent') {
      run.sent++;
      run.lastSentAt = new Date(now()).toISOString();
      if (run.sent === 1 || run.problem) tell('sent', run.sent + ' this run' + (run.problem ? ', after: ' + run.problem : ''));
      run.problem = null;
      noted.clear();
    } else if (PROBLEMS.has(what)) {
      run.problem = (what + (detail ? ' ' + detail : '')).slice(0, 160);
      run.problemAt = new Date(now()).toISOString();
      const k = what + '|' + detail;
      if (!noted.has(k) && noted.size < 20) { noted.add(k); tell(what, detail); }
    }
    log(what, ...rest);
  }
  /** A dictation that was not queued, and why ('sharing is off', ...): counted, and in the life log once a run. */
  function kept(reason) {
    run.notQueued[reason] = (run.notQueued[reason] || 0) + 1;
    if (run.notQueued[reason] === 1) tell('not queued', reason + ' (the first this run)');
  }

  const sharingOn = () => (mode === 'tester' ? !paused() : choice.get() === 'on');
  const unanswered = () => mode === 'beta' && choice.get() === 'ask';
  const limits = mode === 'beta'
    ? {
        cap: cap === undefined ? OUTBOX_CAP_PUBLIC : cap,
        daily: daily === undefined ? { items: DAILY_ITEMS, bytes: DAILY_BYTES, file: dayFile || path.join(path.dirname(dir), 'share-day.json') } : daily,
        fullHoldS: fullHoldS === undefined ? FULL_HOLD_S : fullHoldS
      }
    : { cap, daily: null, fullHoldS: 0 };

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
    collector.reset();
    log('enrolled', body.id);   // the id is safe to show; the key never is
    tell('enrolled', body.id);
    await writeKeyFile(keyFile, keyRec);   // after: a key file that cannot be written still leaves this run its key
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
    log: track, about, fetch, now,
    cap: limits.cap, daily: limits.daily, fullHoldS: limits.fullHoldS,
    // A tester key refused means the tester was removed: stop. An install key refused within
    // minutes of its enrollment has probably not reached that data centre yet: try again.
    on401: () => !(mode === 'beta' && keyRec && keyRec.enrolledAt && now() - Date.parse(keyRec.enrolledAt) < FRESH_KEY_MS)
  });

  async function forgetKey() {
    keyRec = null;
    await fsp.unlink(keyFile).catch(() => {});
  }

  /** GET <endpoint><route> with this build's key: its JSON, or null (no key, offline, refused, an older server). */
  async function askServer(route, { enroll = false } = {}) {
    let cfg = mode === 'tester' ? tester : keyRec ? { endpoint: keyRec.endpoint, key: keyRec.key } : null;
    if (!cfg && enroll && mode === 'beta') {
      try { cfg = await ensureKey(); } catch { return null; }
    }
    if (!cfg) return null;
    try {
      const res = await fetch(cfg.endpoint + route, { headers: { Authorization: 'Bearer ' + cfg.key }, signal: AbortSignal.timeout(20e3) });
      if (!res.ok) { await res.text().catch(() => ''); return null; }
      return await res.json();
    } catch {
      return null;
    }
  }

  const lastLive = () => (last && now() - last.at < LAST_KEEP_MS ? last : null);

  return {
    mode,

    /**
     * For Settings. Tester: {mode, tester, with, state: 'on'|'paused'|'stopped'} as before.
     * Public: {mode: 'beta', state: 'on'|'off'|'stopped', shared, id}; `shared` says a key
     * exists, so something may be stored on the server and "Delete what I've shared" applies.
     */
    status() {
      if (mode === 'tester') return { mode, ...collector.status(), with: tester.with, tester: tester.tester };
      return {
        mode,
        state: collector.isRevoked() ? 'stopped' : sharingOn() ? 'on' : 'off',
        // 'on', 'off', or 'ask': not answered yet (the walkthrough's first screen, the small screen).
        choice: unanswered() ? 'ask' : sharingOn() ? 'on' : 'off',
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
      if (!sharingOn()) { kept(mode === 'tester' ? 'sharing is paused' : unanswered() ? 'sharing not chosen yet' : 'sharing is off'); return false; }
      if (collector.isRevoked()) { kept('the server refused this key'); return false; }
      const name = collector.queue(mode === 'beta' ? { ...rec, consent: 'all' } : rec);
      last.name = name;
      return Boolean(name);
    },

    /** A dictation that never reached add() (no audio, a stub run): counted for diagnostics. */
    kept,

    /**
     * One line for "Copy diagnostics" (index.js): the mode and state, the install id, what waits in
     * the outbox, and this run's dictations queued, kept back and sent, and the last problem. No key.
     */
    diagnostics() {
      let waiting = 0;
      try { waiting = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length; } catch { /* no outbox yet */ }
      const state = collector.isRevoked() ? 'stopped' : sharingOn() ? 'on' : mode === 'tester' ? 'paused' : unanswered() ? 'not chosen yet (off)' : 'off';
      const held = collector.heldUntil();
      const notQueued = Object.entries(run.notQueued).map(([k, v]) => k + ' x' + v).join(', ');
      return [
        (mode === 'tester' ? 'tester build (' + tester.tester + ')' : 'public build') + ', ' + state,
        mode === 'beta' ? (keyRec ? 'enrolled ' + keyRec.id + (keyRec.enrolledAt ? ' at ' + keyRec.enrolledAt : '') : 'not enrolled yet') : null,
        waiting + ' waiting',
        'this run: ' + run.queued + ' queued, ' + run.sent + ' sent' + (run.lastSentAt ? ' (last ' + run.lastSentAt + ')' : '') +
          (notQueued ? ', not queued: ' + notQueued : ''),
        held ? 'the server asked to wait until ' + new Date(held).toISOString() : null,
        run.problem ? 'last problem: ' + run.problem + ' at ' + run.problemAt : null
      ].filter(Boolean).join('; ');
    },

    /**
     * Public builds, from Settings: 'on' (enrolls now if it can; if offline, at the first send)
     * or 'off' (what is still waiting in the outbox is deleted; a dictation shared on its own
     * still goes). Returns {ok, enrolled?}.
     */
    async choose(value) {
      if (mode !== 'beta' || !['on', 'off'].includes(value)) return { ok: false };
      if (value === 'off') {
        choice.set('off');
        await collector.clear({ keepOneOff: true });
        try { await onOff(); } catch { /* past dictations stop anyway: they need sharing on */ }
        return { ok: true };
      }
      if (collector.isRevoked()) { await forgetKey(); collector.reset(); }   // refused before: start afresh
      if (keyRec && keyRec.deleteWanted) {   // a Don't share whose delete never went: superseded by this yes
        keyRec = { endpoint: keyRec.endpoint, key: keyRec.key, id: keyRec.id, enrolledAt: keyRec.enrolledAt };
        await writeKeyFile(keyFile, keyRec).catch(() => {});
      }
      choice.set('on');
      try {
        await ensureKey();
        collector.wake(1000);
        return { ok: true, enrolled: true };
      } catch (err) {
        track('no key yet, will retry', why(err));
        return { ok: true, enrolled: false };
      }
    },

    /**
     * The person's answer, from the walkthrough's first screen, the small screen or Settings' switch:
     * 'on' or 'off', as choose(). Don't share on an install not answered yet that shared before
     * (it had a key when this run began: something went, under 0.2.4-0.2.6's default or an 'on' no
     * one chose) also deletes what it shared (deleteShared: DELETE /v1/me -- everything stored for
     * the key, a dictation flagged and shared on its own since included -- the outbox emptied, the
     * key forgotten). If that delete cannot go now, the key file says so (deleteWanted) and
     * retryDelete() tries again at later launches. Returns choose()'s answer, or deleteShared()'s
     * with deletedShared: true.
     */
    async answer(value) {
      if (mode !== 'beta' || !['on', 'off'].includes(value)) return { ok: false };
      if (value === 'off' && unanswered() && hadKey && keyRec) {
        log('answered: do not share; deleting what this install shared');
        tell('answered', "don't share; deleting what this install shared");
        const r = await this.deleteShared();
        if (!r.ok && keyRec) {
          keyRec = { ...keyRec, deleteWanted: true };
          await writeKeyFile(keyFile, keyRec).catch(() => {});
        }
        return { ...r, deletedShared: true };
      }
      if (unanswered()) tell('answered', value === 'on' ? 'share' : "don't share");
      return this.choose(value);
    },

    /** Launch: a Don't share whose delete did not go through (offline) is tried again. */
    async retryDelete() {
      if (mode !== 'beta' || !keyRec || !keyRec.deleteWanted) return null;
      const r = await this.deleteShared();
      tell('delete after "don\'t share"', r.ok ? 'done' : 'not yet: ' + (r.reason || 'failed'));
      return r;
    },

    /**
     * The one automatic backfill (0.2.7, backfill.js autoOnce): null when it should run now, 'wait'
     * while sharing is not answered yet (it is decided once the person answers), else why not. Only
     * a public install that shares, is not a fresh one, and never shared anything before this run.
     */
    autoBackfillWhy({ fresh = false } = {}) {
      if (mode !== 'beta') return 'a tester build';
      if (fresh) return 'a fresh install';
      if (unanswered()) return 'wait';
      if (!sharingOn()) return 'sharing is off';
      if (collector.isRevoked()) return 'the server refused this key';
      if (hadKey) return 'this install has shared before';
      return null;
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
     * "Delete what I've shared" (public builds): stop the uploader, empty the outbox, delete
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
        // Past dictations: never again on this install, whether or not the server delete goes through.
        try { await onDeleted(); } catch { /* best effort */ }
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
    pending: () => collector.pending(),

    /** What the server asks of this key (GET /v1/me): {backfill}, or null. */
    asks: () => askServer('/v1/me'),

    /**
     * What backfill.js needs: whether sharing is on, a way to queue one past dictation (consent
     * 'all' in a public build, as a live one), the outbox, the day's limit, and the names of the
     * items the server holds for this key (GET /v1/me/items; a public build enrolls first).
     */
    backfillPort() {
      return {
        on: () => sharingOn() && !collector.isRevoked(),
        queue: (rec) => collector.queue(mode === 'beta' ? { ...rec, consent: 'all' } : rec),
        pending: () => collector.pending(),
        waiting: () => collector.waiting(),
        dailyLeft: () => collector.dailyLeft(),
        serverItems: async () => {
          const b = await askServer('/v1/me/items', { enroll: true });
          return b && Array.isArray(b.names) ? b.names.filter((n) => typeof n === 'string') : null;
        }
      };
    }
  };
}

/* ------------------------------------------------------------- the app's instance */

let electron = null;
try {
  const e = require('electron');
  if (e && typeof e === 'object' && e.app) electron = e;   // under plain Node this is a path string
} catch { /* not running in Electron */ }

const debug = (...a) => { if (process.env.TYPD_DEBUG) console.log('[typd:share]', ...a); };
// The life log (lifelog.js, "Copy diagnostics"): sharing's few events, so a PC that shares nothing
// says why -- off, not enrolled, refused, offline, a write that failed -- instead of nothing at all.
const lifeNote = (what, detail) => { try { require('./lifelog').log('sharing', what + (detail ? ': ' + detail : '')); } catch { /* no log */ } };
let main;   // undefined until first asked; false when sharing is not available in this build

function instance() {
  if (main !== undefined) return main;
  main = false;
  if (!electron) return main;
  const { app, powerMonitor } = electron;
  // Development: a tester key only with TYPD_TESTER_DEV=1 -- the repo root is where the developer
  // runs their own Typd every day, and a stray tester.json there once queued the developer's
  // dictations under a tester's name (2026-10-09) -- and the public builds' sharing only with
  // TYPD_SHARE_DEV=1. Once sharing is on it shares, so point it at a local wrangler dev with
  // TYPD_COLLECT_URL, or it shares with the real server.
  const devTester = !app.isPackaged && process.env.TYPD_TESTER_DEV === '1';
  const devBeta = !app.isPackaged && process.env.TYPD_SHARE_DEV === '1';
  // TYPD_NO_SHARE=1: no sharing at all in this run, whatever settings say -- nothing queued, no
  // request, no flag shortcut (CI's launches of a packaged build: scripts/mac-close-check.sh,
  // mac-launch-loop.sh, mac.yml). Settings are not changed by it.
  if (process.env.TYPD_NO_SHARE === '1') return main;
  // Packaged: <resources>/tester.json, or after a macOS app update the copy kept from the version it
  // replaced (src/main/carried.js).
  const tester = app.isPackaged || devTester
    ? readConfig(app.isPackaged ? (require('./carried').resource('tester.json') || path.join(process.resourcesPath, 'tester.json')) : path.join(__dirname, '..', '..', 'tester.json'))
    : null;
  if (!tester && !app.isPackaged && !devBeta) return main;
  const endpoint = (!app.isPackaged && checkEndpoint(process.env.TYPD_COLLECT_URL)) || ENDPOINT;

  const settings = require('./settings');
  const userData = app.getPath('userData');
  let backfill = null;
  main = createSharing({
    tester,
    endpoint,
    keyFile: path.join(userData, 'share.json'),
    dir: path.join(userData, 'outbox'),
    choice: { get: () => settings.get('share'), set: (v) => settings.set('share', v) },
    paused: () => settings.get('sharePaused'),
    log: debug,
    note: lifeNote,
    // A flag on an item already sent records the versions running when it was pressed (collect.js).
    about: { appVersion: app.getVersion(), modelVersion: () => require('./pipeline/local').modelVersion() },
    onOff: () => backfill && backfill.cancel(),
    onDeleted: () => backfill && backfill.forbid()
  });
  // Past dictations (backfill.js): resumed at launch, started by Settings or by the server's request.
  backfill = require('./backfill').createBackfill({
    dir: settings.recordingsDir(),
    ledgerFile: path.join(userData, 'backfill.json'),
    sharing: main.backfillPort(),
    history: () => { try { return require('./store').store().list(); } catch { return []; } },
    log: (...a) => { debug('backfill', ...a); if (a[0] === 'done' || a[0] === 'to send') require('./lifelog').log('backfill', a.join(' ')); }
  });
  main.backfill = backfill;
  app.whenReady().then(() => {
    // Where sharing stands at launch: the first line to read when a PC's dictations never arrive.
    lifeNote('at launch', main.diagnostics());
    const t = setTimeout(() => main.start(), START_DELAY_MS);
    if (t.unref) t.unref();
    backfill.resume();
    // Don't share answered while offline: the delete it owes goes as soon as it can.
    const td = setTimeout(() => { main.retryDelete().catch(() => {}); }, START_DELAY_MS / 2);
    if (td.unref) td.unref();
    // 0.2.7: past dictations, once by itself, for an install that shares and never shared anything
    // (autoBackfillWhy; backfill.autoOnce remembers the decision in its ledger). Decided now -- the
    // run's first step waits as any run's does -- or, while sharing is not answered, once it is.
    const autoBackfill = () => backfill.autoOnce(() => main.autoBackfillWhy({ fresh: settings.isFreshInstall() })).then((r) => {
      if (r && r.decided) require('./lifelog').log('backfill', r.ran ? 'past dictations: sending them once, by itself (' + r.recordings + ' kept recordings; this install never shared)' : 'past dictations: not sent by itself: ' + r.why);
    }).catch((err) => lifeNote('auto backfill failed', why(err)));
    autoBackfill();
    // Does the server ask this key for its past dictations? Once a while after launch, then every
    // ASK_EVERY_MS; only while sharing is on, and only until a run has started (backfill.request).
    const ask = () => {
      if (!main.backfillPort().on() || backfill.status().state !== 'none') return;
      main.asks().then((r) => {
        if (r && r.backfill === true) {
          require('./lifelog').log('backfill', 'the server asked for past dictations');
          return backfill.request('server');
        }
        return null;
      }).catch(() => {});
    };
    const t2 = setTimeout(ask, START_DELAY_MS + ASK_DELAY_MS);
    if (t2.unref) t2.unref();
    const t3 = setInterval(ask, ASK_EVERY_MS);
    if (t3.unref) t3.unref();
    for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, () => main.wake());
    settings.onChange((key, value) => {
      if (key === 'sharePaused' && !value) main.wake(1000);
      if (key === 'share') autoBackfill();   // answered: the automatic backfill is decided now
    });
  });
  return main;
}

// Built at load, so an outbox left by the previous run resumes without waiting for a dictation.
instance();

/**
 * Called once per session, after its text landed (src/main/index.js): pasted, or -- { pasted: false }
 * -- copied to the clipboard when the paste fell back ("Copied — press Ctrl+V"). Never throws and
 * never waits.
 */
function add(session, text, { pasted = true } = {}) {
  try {
    const s = instance();
    // A stub session's text never came from its audio; it would be a wrong label.
    if (!s || process.argv.includes('--stub')) return;
    if (!session || !session.audio || !session.audio.samples || typeof text !== 'string') { s.kept('no audio or no text'); return; }
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
      // Never the program it went into (0.2.12): that stays in History and the kept recordings here.
      model,
      modelVersion,
      // The adapter file a local revision ran with, or false: set from the pipeline's 'done' (index.js).
      reviseAdapter: session.reviseAdapter || false,
      engine,
      endedAt: session.endedAt || null,
      // The item says which: pasted (pastedAt) or only copied (pasted: false, copiedAt).
      pasted: pasted !== false,
      pastedAt: pasted !== false ? Date.now() : null,
      copiedAt: pasted !== false ? null : Date.now()
    });
  } catch (err) {
    debug('add failed', err && err.message);
    lifeNote('add failed', why(err));
  }
}

/** Null when this build cannot share (development without TYPD_SHARE_DEV), else the instance. */
function get() {
  return instance() || null;
}

/** For Settings: null when sharing is not available here, else sharing's status() with the past dictations'. */
function status() {
  const s = instance();
  if (!s) return null;
  return { ...s.status(), backfill: s.backfill ? s.backfill.status() : null };
}

/** For "Copy diagnostics" (index.js): one line on where sharing stands, or why there is none in this build. */
function diagnostics() {
  try {
    const s = instance();
    if (s) return s.diagnostics();
    if (process.env.TYPD_NO_SHARE === '1') return 'off for this run (TYPD_NO_SHARE=1)';
    return electron && !electron.app.isPackaged ? 'not in a run from source (TYPD_SHARE_DEV=1 turns it on)' : 'not available in this build';
  } catch (err) {
    return 'unknown (' + why(err) + ')';
  }
}

module.exports = { add, get, status, diagnostics, createSharing, readKeyFile, ENDPOINT };
