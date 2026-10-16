'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * History: what you dictated, on this machine only, and the counts Home shows.
 *
 * One file, history.json, beside settings.json and dictionary.json:
 *
 *   { v: 2, keep: '30d' | 'forever' | 'off',
 *     items: [{ id, at, mode, text, words, seconds, waitMs, app, outcome }],   oldest first
 *     days:  { 'YYYY-MM-DD': { n, words, seconds, typedSeconds } } }          counts only
 *
 * An item is what landed in your document and nothing else. The screen context, the
 * highlighted span and window titles are other people's words or private detail, and
 * are never written here -- record() copies the fields it knows and drops the rest, so
 * a caller cannot add one by accident. Audio is the separate "Keep recordings" switch.
 *
 * The day counts carry no text, so Home's numbers survive history being off or deleted;
 * "Delete all" says so. They grow by about 40 bytes a day.
 *
 * Written whole and atomically (a .tmp, then rename), like dictionary.js, so a crash
 * mid-write can never leave a half file in place of a good one.
 */

const KEEPS = { '30d': 30, forever: 0, off: -1 };
const DEFAULT_KEEP = '30d';
const CAP = 5000;
const TYPING_WPM = 40;   // the "time saved" comparison; shown next to the number, never hidden

function countWords(text) {
  const hits = String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
  return hits ? hits.length : 0;
}

/** 'YYYY-MM-DD' in local time: a "day" is the person's day, not UTC's. */
function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** What an hour of dictation would have cost to type, minus what it cost to say. */
function typedSeconds(words) {
  return (words / TYPING_WPM) * 60;
}

/**
 * @param {{file: string, now?: () => number}} o  file: where history.json lives
 */
function createStore({ file, now = () => Date.now() }) {
  let data = null;

  function blank() {
    return { v: 2, keep: DEFAULT_KEEP, items: [], days: {} };
  }

  /** The parked v1 file ({retentionDays, sessions}) becomes v2, on the new default. */
  function migrate(raw) {
    const out = blank();
    for (const s of Array.isArray(raw.sessions) ? raw.sessions : []) {
      if (!s || !s.at) continue;
      const item = clean({ at: s.at, mode: s.mode, text: s.text, seconds: s.seconds, app: s.app, outcome: 'pasted' });
      if (item) out.items.push(item);
    }
    for (const it of out.items) count(out, it);
    return out;
  }

  function load() {
    if (data) return data;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet, or unreadable */ }
    if (raw && raw.v === 2) {
      data = blank();
      data.keep = KEEPS[raw.keep] !== undefined ? raw.keep : DEFAULT_KEEP;
      data.items = (Array.isArray(raw.items) ? raw.items : []).map(clean).filter(Boolean);
      data.days = raw.days && typeof raw.days === 'object' ? raw.days : {};
    } else if (raw && Array.isArray(raw.sessions)) {
      data = migrate(raw);
      save();
    } else {
      data = blank();
    }
    prune();
    return data;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch {
      return false;   // history that cannot be written is a degraded feature, not a crash
    }
  }

  /** Only the fields an item has; anything else a caller passed is dropped here. */
  function clean(s) {
    if (!s || typeof s !== 'object') return null;
    const text = typeof s.text === 'string' ? s.text.slice(0, 100000) : '';
    const at = typeof s.at === 'string' && !Number.isNaN(Date.parse(s.at)) ? s.at : new Date(now()).toISOString();
    return {
      id: typeof s.id === 'string' && /^[0-9TZ-]{8,24}-[0-9a-f]{4}$/.test(s.id) ? s.id : makeId(Date.parse(at)),
      at,
      mode: s.mode === 'revise' ? 'revise' : 'dictate',
      text,
      words: Number.isFinite(s.words) ? Math.max(0, Math.round(s.words)) : countWords(text),
      seconds: Number.isFinite(s.seconds) ? Math.max(0, Math.round(s.seconds * 10) / 10) : 0,
      waitMs: Number.isFinite(s.waitMs) ? Math.max(0, Math.round(s.waitMs)) : 0,
      app: typeof s.app === 'string' && s.app ? s.app.slice(0, 64) : null,
      outcome: s.outcome === 'copied' ? 'copied' : 'pasted'
    };
  }

  function makeId(ms) {
    return new Date(Number.isFinite(ms) ? ms : now()).toISOString().replace(/[-:]|\.\d+/g, '') + '-' + crypto.randomBytes(2).toString('hex');
  }

  function count(d, item) {
    const key = dayKey(Date.parse(item.at));
    const day = d.days[key] || (d.days[key] = { n: 0, words: 0, seconds: 0, typedSeconds: 0 });
    day.n += 1;
    day.words += item.words;
    day.seconds += item.seconds;
    // Only dictation saves typing: a revision's words are mostly the span you already had.
    if (item.mode === 'dictate') {
      day.typedSeconds += Math.max(0, typedSeconds(item.words) - item.seconds - item.waitMs / 1000);
    }
    for (const k of ['seconds', 'typedSeconds']) day[k] = Math.round(day[k] * 10) / 10;
  }

  function prune() {
    const d = data;
    const before = d.items.length;
    if (d.keep === 'off') d.items = [];
    else if (KEEPS[d.keep] > 0) {
      const cutoff = now() - KEEPS[d.keep] * 86400000;
      d.items = d.items.filter((s) => Date.parse(s.at) >= cutoff);
    }
    if (d.items.length > CAP) d.items = d.items.slice(-CAP);
    if (d.items.length !== before) save();
  }

  // Deleted items are held here briefly so Undo can put them back; the page only ever
  // names an id, it never hands an item in.
  const recent = new Map();

  return {
    /** A dictation landed. Off the paste path: the caller schedules it. */
    record(session) {
      const d = load();
      const item = clean({ ...session, at: new Date(now()).toISOString(), id: undefined });
      if (!item || !item.text) return null;
      count(d, item);
      if (d.keep !== 'off') {
        d.items.push(item);
        if (d.items.length > CAP) d.items = d.items.slice(-CAP);
      }
      save();
      return d.keep !== 'off' ? item : null;
    },

    /** Newest first. */
    list() {
      const d = load();
      prune();
      return d.items.slice().reverse();
    },

    latest() {
      const d = load();
      return d.items.length ? d.items[d.items.length - 1] : null;
    },

    get(id) {
      return load().items.find((s) => s.id === id) || null;
    },

    remove(id) {
      const d = load();
      const i = d.items.findIndex((s) => s.id === id);
      if (i === -1) return false;
      const [gone] = d.items.splice(i, 1);
      recent.set(id, gone);
      setTimeout(() => recent.delete(id), 60000).unref?.();
      save();
      return true;
    },

    /** Undo a remove(): back in its place by time. */
    restore(id) {
      const d = load();
      const item = recent.get(id);
      if (!item || d.keep === 'off' || d.items.some((s) => s.id === id)) return false;
      recent.delete(id);
      const at = Date.parse(item.at);
      const i = d.items.findIndex((s) => Date.parse(s.at) > at);
      if (i === -1) d.items.push(item); else d.items.splice(i, 0, item);
      save();
      return true;
    },

    /** Every item goes; the day counts stay. Returns how many went. */
    clear() {
      const d = load();
      const n = d.items.length;
      d.items = [];
      save();
      return n;
    },

    keep() { return load().keep; },

    setKeep(k) {
      if (KEEPS[k] === undefined) return false;
      const d = load();
      d.keep = k;
      prune();
      save();
      return true;
    },

    /** Home's three numbers. */
    counts() {
      const d = load();
      const days = Object.entries(d.days);
      const total = days.reduce((n, [, v]) => n + (v.n || 0), 0);
      const saved = days.reduce((n, [, v]) => n + (v.typedSeconds || 0), 0);
      // This week: the last seven days, today included.
      const week = new Set();
      for (let i = 0; i < 7; i++) week.add(dayKey(now() - i * 86400000));
      const weekWords = days.filter(([k]) => week.has(k)).reduce((n, [, v]) => n + (v.words || 0), 0);
      return { dictations: total, weekWords, savedSeconds: Math.round(saved), typingWpm: TYPING_WPM };
    },

    /** For tests: forget the cache. */
    reload() { data = null; }
  };
}

let shared = null;

/** The app's store, in the same folder as settings.json and dictionary.json. */
function store() {
  if (!shared) {
    const { app } = require('electron');
    shared = createStore({ file: path.join(app.getPath('appData'), 'typd', 'history.json') });
  }
  return shared;
}

module.exports = { createStore, store, countWords, dayKey, KEEPS, TYPING_WPM };
