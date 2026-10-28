'use strict';

/**
 * Past dictations, shared once. A tester (or an install) who shares now may have months of kept
 * recordings on this computer ("Keep recordings", on by default: index.js keepRecording) that were
 * never shared -- recorded before sharing existed, while it was paused, or refused by a full
 * server. This sends them, through the same outbox and uploader as every dictation (collect.js),
 * slowly, and only once.
 *
 * Started two ways: Settings > "Send my past dictations" (the person asks), or the server asks for
 * this key (GET /v1/me answers {backfill: true}: typd-collect's allowlist, for a tester who agreed
 * in person). The server's request starts it once; when it is done it is done.
 *
 * Never while sharing is off (or a tester's sharing is paused: it waits), and never again on an
 * install that used "Delete what I've shared" (forbid(): the ledger says 'never').
 *
 * And once by itself (0.2.7, autoOnce): a public install that shares and never shared anything
 * (sharing.js autoBackfillWhy) sends the recordings it kept under 0.2.4-0.2.6, while sharing was
 * meant to be on. Decided once per install and remembered in the ledger (`auto`), whatever the
 * answer; while sharing is not answered yet the decision waits for the answer. Such a run ('auto')
 * takes only the recordings kept before it started (later ones were shared live) and, as the install
 * never shared, nothing of it was on the server before: when the server will not list this key's
 * items (GET /v1/me/items answers only keys it asked for past dictations), the list is empty, and
 * the live items that waited in the outbox when it started are skipped (`liveAtStart`).
 *
 * What one item carries is what a live dictation's does (collect.js makeMeta): the recording's
 * audio, the text Typd wrote (for a revision, nothing but the spoken instruction's audio), the
 * mode, the model file -- plus backfill: true and keptAt, the recording's own time. NEVER the
 * screen context, the highlighted span or (since 0.2.12) the program's name that a kept
 * recording's .json also holds (index.js keeps them for the user's own test set): they are not
 * even read into the item. A revision the guards refused (never pasted) is skipped, like the live
 * path skips it. And never while sharing is not answered: on() is false then.
 *
 * Not twice:
 *   - a fixed name per recording: its time plus an id made from its file name, so the outbox will
 *     not queue it twice and the server stores a second send over the first (same key);
 *   - the ledger (<userData>/backfill.json) records every recording queued, so a restart resumes
 *     where it stopped;
 *   - what the server already holds for this key (GET /v1/me/items, read once a run): a recording
 *     whose time is within a few seconds before an item's was shared live, and is skipped;
 *   - what waits in the outbox now, the same way.
 *
 * Paced: one item every TICK_MS at most (~40 an hour), and only while at most OUTBOX_MAX items
 * wait, so live dictations are never stuck behind a long queue and the server sees a trickle. A
 * public build keeps its daily limit (collect.js) and leaves LIVE_HEADROOM of it for live
 * dictations: past it, it waits for the next day.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const TICK_MS = 90e3;
const FIRST_MS = 30e3;
const OUTBOX_MAX = 2;
const LIVE_HEADROOM = { items: 10, bytes: 4e6 };
const LIVE_WINDOW = { before: 2000, after: 8000 };   // a live item is queued 0-2 s after its recording is kept
const REC_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;   // index.js: toISOString() with : and . as -
const SERVER_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/;

/** A kept recording's file name -> its time (ms), or NaN. */
function keptAt(name) {
  const m = REC_RE.exec(name);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
}

/** A server item's name (<stamp>-<id>) -> its time (ms, to the second), or NaN. */
function serverTime(name) {
  const m = SERVER_RE.exec(String(name).split('/').pop());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

/** The fixed id of a recording's item: 16 hex from its file name. */
function itemId(name) {
  return crypto.createHash('sha256').update('typd-backfill:' + name).digest('hex').slice(0, 16);
}

/** A 16-bit PCM mono WAV -> {samples (Float32), sampleRate}, or null. */
function readWav(buf) {
  if (!buf || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt = null, at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4), size = buf.readUInt32LE(at + 4), body = at + 8;
    if (id === 'fmt ' && size >= 16) {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16) return null;
      const n = Math.floor(Math.min(size, buf.length - body) / 2);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(body + i * 2) / 32767;
      return { samples, sampleRate: fmt.rate };
    }
    at = body + size + (size % 2);
  }
  return null;
}

const readJson = async (file) => { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; } };

/**
 *   dir          the kept recordings (settings.recordingsDir())
 *   ledgerFile   <userData>/backfill.json
 *   sharing      { on(): boolean, queue(rec): name|null, pending(): Promise<n>, waiting(): Promise<[{createdAt, keptAt}]>,
 *                  dailyLeft(): {items, bytes}|null, serverItems(): Promise<string[]|null> }  (sharing.js)
 *   history      () => [{at|createdAt, mode, text}]: the window's History, for a recording whose .json
 *                lost its text (optional)
 */
function createBackfill({ dir, ledgerFile, sharing, history = () => [], log = () => {}, now = Date.now, tickMs = TICK_MS, firstMs = FIRST_MS }) {
  let ledger = null;
  let timer = null;
  let todo = null;        // the recordings still to queue this run, oldest first (names)
  let server = null;      // the server's item times for this key, this run
  let busy = false;

  function load() {
    if (ledger) return ledger;
    let l = null;
    try { l = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); } catch { l = null; }
    ledger = l && typeof l === 'object' && l.v === 1
      ? { v: 1, state: ['none', 'running', 'done', 'cancelled', 'never'].includes(l.state) ? l.state : 'none', by: l.by || null,
          startedAt: l.startedAt || null, doneAt: l.doneAt || null, total: Number(l.total) || 0,
          sent: l.sent && typeof l.sent === 'object' ? l.sent : {}, skipped: Number(l.skipped) || 0,
          auto: l.auto && typeof l.auto === 'object' ? l.auto : null,
          liveAtStart: Array.isArray(l.liveAtStart) ? l.liveAtStart.filter(Number.isFinite) : [] }
      : { v: 1, state: 'none', by: null, startedAt: null, doneAt: null, total: 0, sent: {}, skipped: 0, auto: null, liveAtStart: [] };
    return ledger;
  }

  async function save() {
    try {
      await fsp.mkdir(path.dirname(ledgerFile), { recursive: true });
      await fsp.writeFile(ledgerFile + '.tmp', JSON.stringify(ledger, null, 1));
      await fsp.rename(ledgerFile + '.tmp', ledgerFile);
    } catch (err) {
      log('ledger not saved', err && err.message);
    }
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => { step().catch((err) => { log('step failed', err && err.message); schedule(tickMs); }); }, ms);
    if (timer.unref) timer.unref();
  }

  const near = (t, times) => times.some((s) => s - t >= -LIVE_WINDOW.before && s - t <= LIVE_WINDOW.after);

  /** The recordings not yet shared, oldest first. Null: the server could not say what it holds yet. */
  async function scan() {
    const auto = ledger.by === 'auto';
    if (!server) {
      const names = await sharing.serverItems();
      // An automatic run is for an install that never shared: nothing of it predates the run there.
      if (!names && !auto) return null;
      server = (names || []).map(serverTime).filter(Number.isFinite);
    }
    const before = auto ? Date.parse(ledger.startedAt || '') : NaN;
    let files = [];
    try { files = await fsp.readdir(dir); } catch { return []; }
    const waiting = await sharing.waiting();
    const waitingTimes = waiting.filter((w) => !w.backfill).map((w) => Date.parse(w.createdAt)).filter(Number.isFinite);
    const waitingKept = new Set(waiting.filter((w) => w.backfill && w.keptAt).map((w) => w.keptAt));
    const out = [];
    // Every recording's audio; its .json may be missing (then History may still have its text).
    for (const f of files.filter((x) => x.endsWith('.wav')).sort()) {
      const name = f.slice(0, -4);
      const t = keptAt(name);
      if (!Number.isFinite(t) || ledger.sent[name]) continue;
      if (Number.isFinite(before) && t >= before) continue;   // an automatic run: kept since it began, so shared live
      if (waitingKept.has(new Date(t).toISOString())) { ledger.sent[name] = 'waiting'; continue; }
      if (near(t, server) || near(t, waitingTimes) || (auto && near(t, ledger.liveAtStart))) { ledger.skipped++; ledger.sent[name] = 'already shared'; continue; }
      out.push(name);
    }
    return out;
  }

  /** The text a recording produced: its own .json's, else the History entry made with it. */
  function textFor(meta, t) {
    if (meta && typeof meta.output === 'string') return meta.output;
    for (const h of history() || []) {
      const at = Date.parse(h.at || h.createdAt || '');
      if (Number.isFinite(at) && Math.abs(at - t) < 10e3 && (!meta || !meta.mode || h.mode === meta.mode) && typeof h.text === 'string') return h.text;
    }
    return null;
  }

  /** One recording -> the item (only these fields: never context, span, the program or anything else). */
  async function item(name) {
    const t = keptAt(name);
    const meta = await readJson(path.join(dir, name + '.json'));
    if (meta && meta.guard) return { skip: 'refused by the guards (never pasted)' };
    const text = textFor(meta, t);
    if (typeof text !== 'string' || !text.trim()) return { skip: 'no text' };
    let wav = null;
    try { wav = readWav(await fsp.readFile(path.join(dir, name + '.wav'))); } catch { wav = null; }
    if (!wav || !wav.samples.length) return { skip: 'unreadable audio' };
    const mode = meta && meta.mode === 'revise' ? 'revise' : 'dictate';
    const ms = meta && Number.isFinite(meta.ms) ? meta.ms : null;
    return {
      rec: {
        samples: wav.samples, sampleRate: wav.sampleRate, text, mode,
        model: meta && typeof meta.model === 'string' ? meta.model.slice(0, 128) : null,
        modelVersion: null, reviseAdapter: null, engine: null,
        endedAt: ms !== null ? t - ms : null, pastedAt: t,
        backfill: true, keptAt: t, id: itemId(name)
      }
    };
  }

  async function step() {
    if (busy) return;
    busy = true;
    try {
      load();
      if (ledger.state !== 'running') return;
      if (!sharing.on()) { schedule(tickMs); return; }   // paused (a tester) or off for now: wait
      if (!todo) {
        todo = await scan();
        if (!todo) { log('the server could not say what it holds yet; will retry'); schedule(tickMs * 10); return; }
        ledger.total = Object.keys(ledger.sent).length + todo.length;
        await save();
        log('to send', todo.length, 'skipped as already shared', ledger.skipped);
      }
      if ((await sharing.pending()) > OUTBOX_MAX) { schedule(tickMs); return; }
      const left = sharing.dailyLeft();
      if (left && (left.items <= LIVE_HEADROOM.items || left.bytes <= LIVE_HEADROOM.bytes)) { schedule(tickMs * 10); return; }
      while (todo.length) {
        const name = todo[0];
        const it = await item(name);
        if (it.skip) { todo.shift(); ledger.sent[name] = 'skipped: ' + it.skip; ledger.skipped++; await save(); continue; }
        const queued = sharing.queue(it.rec);
        if (!queued) { schedule(tickMs * 10); return; }   // the day's limit, or sharing stopped meanwhile: later
        todo.shift();
        ledger.sent[name] = queued;
        await save();
        log('queued', name);
        break;
      }
      if (!todo.length) {
        ledger.state = 'done';
        ledger.doneAt = new Date(now()).toISOString();
        todo = null;
        await save();
        log('done', Object.keys(ledger.sent).length, 'recordings looked at');
        return;
      }
      schedule(tickMs);
    } finally {
      busy = false;
    }
  }

  return {
    /**
     * Start (or, from Settings, start again over what is not sent yet). by: 'settings' | 'server' |
     * 'auto' (autoOnce). Returns {ok, state, reason?}. The server's request (and the automatic one)
     * does nothing once a run has finished, was cancelled, or the install deleted what it shared.
     */
    async request(by) {
      load();
      if (ledger.state === 'never') return { ok: false, state: 'never', reason: 'this install deleted what it shared' };
      if (!sharing.on()) return { ok: false, state: ledger.state, reason: 'sharing is off' };
      if ((by === 'server' || by === 'auto') && ledger.state !== 'none') return { ok: true, state: ledger.state };
      if (ledger.state !== 'running') {
        ledger.state = 'running';
        ledger.by = by === 'server' || by === 'auto' ? by : 'settings';
        ledger.startedAt = new Date(now()).toISOString();
        ledger.doneAt = null;
        todo = null;
        server = null;
        await save();
      }
      schedule(firstMs);
      return { ok: true, state: 'running' };
    },
    /**
     * The one automatic run (0.2.7), decided once per install and remembered in the ledger.
     * decide() says null (run), 'wait' (sharing not answered yet: nothing remembered, ask again
     * later) or why not. Never when a run was ever started, the install deleted what it shared, or
     * it keeps no recordings. Returns {decided, ran, why?, recordings?}: decided is false when it
     * was decided before, or waits.
     */
    async autoOnce(decide) {
      load();
      if (ledger.auto) return { decided: false, ran: Boolean(ledger.auto.ran), why: ledger.auto.why || null };
      let why = ledger.state === 'never' ? 'this install deleted what it shared'
        : ledger.state !== 'none' ? 'past dictations were asked for before (' + ledger.state + ')' : decide();
      if (why === 'wait') return { decided: false, ran: false, why: 'waiting for an answer' };
      let recordings = 0;
      if (!why) {
        try { recordings = (await fsp.readdir(dir)).filter((f) => f.endsWith('.wav') && Number.isFinite(keptAt(f.slice(0, -4)))).length; } catch { recordings = 0; }
        if (!recordings) why = 'no kept recordings';
      }
      const at = new Date(now()).toISOString();
      if (why) {
        ledger.auto = { at, ran: false, why };
        await save();
        return { decided: true, ran: false, why };
      }
      let waiting = [];
      try { waiting = await sharing.waiting(); } catch { waiting = []; }
      ledger.liveAtStart = waiting.filter((w) => !w.backfill).map((w) => Date.parse(w.createdAt)).filter(Number.isFinite).slice(0, 1000);
      ledger.auto = { at, ran: true, recordings };
      const r = await this.request('auto');
      if (!r.ok) {
        ledger.auto = { at, ran: false, why: r.reason || 'refused' };
        await save();
        return { decided: true, ran: false, why: ledger.auto.why };
      }
      return { decided: true, ran: true, recordings };
    },
    /** Launch: a run that was going on resumes. */
    resume() {
      load();
      if (ledger.state === 'running') schedule(firstMs);
    },
    /** Sharing was turned off: stop (Settings can start it again). */
    async cancel() {
      load();
      clearTimeout(timer);
      todo = null;
      if (ledger.state === 'running') { ledger.state = 'cancelled'; await save(); }
    },
    /** "Delete what I've shared": never again on this install. */
    async forbid() {
      load();
      clearTimeout(timer);
      todo = null;
      ledger.state = 'never';
      await save();
    },
    /** For Settings: {state, total, sent, left}. */
    status() {
      load();
      const sent = Object.values(ledger.sent).filter((v) => /^\d{8}T\d{6}Z-/.test(String(v))).length;
      return { state: ledger.state, total: ledger.total, sent, left: todo ? todo.length : null, by: ledger.by, auto: ledger.auto };
    },
    step,   // the bench drives it directly
    stop() { clearTimeout(timer); }
  };
}

module.exports = { createBackfill, keptAt, serverTime, itemId, readWav, TICK_MS, OUTBOX_MAX, LIVE_WINDOW };
