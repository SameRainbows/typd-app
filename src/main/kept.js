'use strict';

/**
 * Kept as pasted (0.2.13): does a dictation stay the way Typd pasted it?
 *
 * The benchmarks score Typd against reference texts. What a person feels is whether they had to
 * touch what was pasted. So after each paste Typd looks at the same text field for a minute -- the
 * way learn.js already looks back for a corrected word -- and records one verdict in that
 * dictation's History item (store.js):
 *
 *   kept      the pasted text is still there, unchanged. Writing on before or after it is not a
 *             change to it (`typed`). A chat box emptied by sending is kept, and `sent`.
 *   edited    characters inside the pasted text changed: how many (`chars`), how many words
 *             (`words`, `share` of its words), and which (`changes`, word level, at most 8)
 *   deleted   it was removed, or undone
 *   redone    it was dictated again: highlighted and spoken over (`how: 'revise'`), or deleted and
 *             the next dictation started in the same app (`how: 'dictate'`)
 *   unknown   it could not be watched (`why`): the field does not expose its text, it is a password
 *             field, the paste was not found, or it is too long for the read's window
 *
 * What is read, and for how long. The focused field's text on both sides of the caret, at most
 * 4,000 characters each way on Windows, 8,000 on a Mac (inject.ps1 and the Mac helper's `around`: the same UI Automation /
 * Accessibility read the screen context uses), about 15 times in the minute after a paste and once
 * more when the next dictation starts. Only while the focus stays in that field of the app the text
 * went to: another app or another field ends the watch, and what was read there is not used. A
 * password field is never read: the helper does not return its text. The reads live in memory for
 * that minute and are dropped. What is kept is the verdict, the counts and the changed words, in
 * History on this computer (30 days by default; "Delete all" empties it). Nothing here is shared:
 * sharing.js and backfill.js never read these fields.
 *
 * Electron-free: the reads, timers and clock are passed in (bench/kept.js).
 */

const VERDICTS = new Set(['kept', 'edited', 'deleted', 'redone', 'unknown']);
const WHYS = new Set(['unreadable', 'not-found', 'password', 'left', 'too-long', 'no-read']);
const ENDS = new Set(['window', 'left', 'sent', 'cleared', 'out-of-view', 'replaced', 'next', 'password', 'not-found', 'unreadable', 'too-long', 'stopped']);

// When to look, in ms after the paste: often at first (a chat message is often sent within
// seconds of the paste), then every 5 to 7.5 s, to a minute.
const SCHEDULE_MS = [500, 1500, 3000, 5000, 7000, 9500, 12500, 16000, 20000, 25000, 30000, 37500, 45000, 52500, 60000];
const FIRST_LOOKS = 3;      // looks that may find where the paste landed; after them, unknown
const REDO_MS = 30000;      // after a deletion or a send: how long the next dictation may still make it "redone"
const ANCHOR = 32;          // characters either side of the pasted text that find it again
const MAX_CHARS = 3500;     // Windows reads 4,000 characters before the caret: a longer paste never fits (0.5 % of the founder's dictations)
const MAX_CHANGES = 8;
const CHANGE_CHARS = 80;

/* ------------------------------------------------------------------ text */

/**
 * The text as compared: Unicode-composed, invisible characters gone, curly quotes straight, every
 * run of whitespace (line breaks included) one space. Apps render a multi-line paste in their own
 * way (\r, \r\n, a paragraph each), and none of that is the person changing it.
 */
function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFC')
    .replace(/[​-‍⁠﻿￼­]/g, '')
    .replace(/[‘’‛ʼ]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function indexesOf(hay, needle, cap = 64) {
  const out = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i !== -1 && out.length < cap; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** Space-separated tokens of normalized text, with where each starts. */
function tokens(s) {
  const out = [];
  let at = 0;
  for (const word of s ? s.split(' ') : []) {
    out.push({ word, at });
    at += word.length + 1;
  }
  return out;
}

/** A word for matching across reformatting: lowercase, no punctuation at its edges. */
const loose = (w) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/**
 * Longest common subsequence of two lists, as matched index pairs. Null when the table would be
 * too big to build (a very long dictation against a very long field): the caller falls back.
 */
function align(a, b, key = (x) => x) {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return [];
  if (n * m > 6e6 || Math.min(n, m) > 65000) return null;
  const ka = a.map(key);
  const kb = b.map(key);
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = ka[i] === kb[j] && ka[i] !== ''
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j] && ka[i] !== '') { pairs.push([i, j]); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Character edit distance, bounded: past ~1M cells the longer length stands in for it. */
function distance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  if (m * n > 1e6) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], row[j - 1]);
    }
    prev = row;
  }
  return prev[n];
}

const clip = (s) => (s.length > CHANGE_CHARS ? s.slice(0, CHANGE_CHARS - 1) + '…' : s);

/**
 * Where `P`'s words sit in `S`, near `center` (a character position): a compact run holding at
 * least 60 % of them, widened one for one over its unmatched first and last words. For text an
 * app reformatted as it landed (a bulleted list, a link, an emoji), and for finding it again when
 * the text right around it was edited. {start, end} in S, or null.
 */
function fuzzy(P, S, center) {
  const A = tokens(P);
  if (!A.length || !S) return null;
  const reach = P.length * 2 + 200;
  const all = tokens(S);
  const lo = Math.max(0, center - reach);
  const hi = center + reach;
  const B = all.filter((t) => t.at + t.word.length >= lo && t.at <= hi);
  if (!B.length) return null;
  const pairs = align(A, B, (t) => loose(t.word));
  if (!pairs || pairs.length < Math.max(1, Math.ceil(A.length * 0.6))) return null;
  const firstB = pairs[0][1];
  const lastB = pairs[pairs.length - 1][1];
  // Matches scattered over a long field are common words, not this text.
  if (lastB - firstB + 1 > A.length * 1.5 + 6) return null;
  // Widened only over words: a list marker or a lone dash the app dropped is not one.
  const real = (k0, k1) => A.slice(k0, k1).filter((t) => loose(t.word)).length;
  const j0 = Math.max(0, firstB - real(0, pairs[0][0]));
  const j1 = Math.min(B.length - 1, lastB + real(pairs[pairs.length - 1][0] + 1, A.length));
  return { start: B[j0].at, end: B[j1].at + B[j1].word.length };
}

/* ------------------------------------------------------------- the verdict */

/**
 * What happened to `landed` (the pasted text as it first appeared in the field), given `now`
 * (what sits in its place). Pure; bench/kept.js runs it on its own.
 *
 * Text written before or after it is the person writing on, not a change to it. Where the words at
 * its edges changed, the same number of words in their place are taken as their replacement and
 * anything beyond as writing on -- the same assumption learn.js makes.
 */
function compare(landedText, nowText) {
  const landed = norm(landedText);
  const T = norm(nowText);
  if (T === landed) return { v: 'kept' };
  if (landed && T.includes(landed)) return { v: 'kept', typed: T.length - landed.length };
  if (!T) return { v: 'deleted' };

  const A = landed.split(' ');
  const B = T.split(' ');
  const pairs = align(A, B);
  const spans = [];
  let typed = 0;
  const lengthOf = (j0, j1) => (j1 > j0 ? B.slice(j0, j1).join(' ').length : 0);

  if (!pairs) {
    // Too long to align word by word: what lies between the common start and end.
    let p = 0;
    while (p < landed.length && p < T.length && landed[p] === T[p]) p++;
    let q = 0;
    while (q < landed.length - p && q < T.length - p && landed[landed.length - 1 - q] === T[T.length - 1 - q]) q++;
    const was = landed.slice(p, landed.length - q);
    const now = T.slice(p, T.length - q);
    const words = Math.max(was ? was.split(' ').length : 0, now ? now.split(' ').length : 0);
    return { v: 'edited', chars: Math.max(was.length, now.length), words, share: Math.min(1, words / A.length), changes: [{ was: clip(was), now: clip(now) }], rough: true };
  }

  if (!pairs.length) {
    // None of its words is left as it was: written over, or one short word corrected.
    spans.push({ was: [0, A.length], now: [0, B.length] });
  } else {
    const [i0, j0] = pairs[0];
    const leadStart = i0 > 0 ? Math.max(0, j0 - i0) : j0;
    if (i0 > 0) spans.push({ was: [0, i0], now: [leadStart, j0] });
    typed += lengthOf(0, leadStart);
    for (let k = 1; k < pairs.length; k++) {
      const [pi, pj] = pairs[k - 1];
      const [ni, nj] = pairs[k];
      if (ni - pi > 1 || nj - pj > 1) spans.push({ was: [pi + 1, ni], now: [pj + 1, nj] });
    }
    const [iz, jz] = pairs[pairs.length - 1];
    const tail = A.length - 1 - iz;
    const tailEnd = tail > 0 ? Math.min(B.length, jz + 1 + tail) : jz + 1;
    if (tail > 0) spans.push({ was: [iz + 1, A.length], now: [jz + 1, tailEnd] });
    typed += lengthOf(tailEnd, B.length);
  }

  let chars = 0;
  let words = 0;
  const changes = [];
  for (const s of spans) {
    const was = A.slice(s.was[0], s.was[1]).join(' ');
    const now = B.slice(s.now[0], s.now[1]).join(' ');
    // Only the spaces differ ("where? How" read back as "where?How"): an app that shows two
    // paragraphs with no separator in its accessibility text, not the person changing a word.
    if (was.replace(/ /g, '') === now.replace(/ /g, '')) continue;
    chars += distance(was, now);
    words += Math.max(s.was[1] - s.was[0], s.now[1] - s.now[0]);
    if (changes.length < MAX_CHANGES) changes.push({ was: clip(was), now: clip(now) });
  }
  if (!chars) return { v: 'kept', ...(typed ? { typed } : {}) };
  return { v: 'edited', chars, words, share: Math.round(Math.min(1, words / A.length) * 100) / 100, changes, ...(typed ? { typed } : {}) };
}

/** Do two dictations say much the same? (A send, then the same words again: a redo.) */
function similar(a, b) {
  const A = norm(a).split(' ').map(loose).filter(Boolean);
  const B = norm(b).split(' ').map(loose).filter(Boolean);
  if (!A.length || !B.length) return false;
  if (Math.min(A.length, B.length) < 2) {
    const x = A.join(' ');
    const y = B.join(' ');
    return 1 - distance(x, y) / Math.max(x.length, y.length) >= 0.6;
  }
  const pairs = align(A, B);
  if (!pairs) return false;
  // Most words in common, in order, over both (Dice >= 0.5) -- or nearly all of a shorter one of 4+
  // words inside the longer (said again as part of more). Measured on the founder's 1,027 recordings
  // (2026-10-31): 0.1 % of unrelated pairs pass, against 2.6 % for "half of the shorter one",
  // which common words alone could reach; 7.1 % of back-to-back dictations pass.
  const l = pairs.length;
  const shorter = Math.min(A.length, B.length);
  return (2 * l) / (A.length + B.length) >= 0.5 || (shorter >= 4 && l / shorter >= 0.8);
}

/* -------------------------------------------------------------- where it is */

/** The first look: where the paste landed, and what around it will find it again. Null if not found. */
function baseline(P, read) {
  const raw = String(read.text || '');
  const S = norm(raw);
  if (!P || !S) return null;
  const caretAt = Number.isInteger(read.caret) && read.caret >= 0 ? norm(raw.slice(0, read.caret)).length : S.length;
  let start = -1;
  let end = -1;
  let how = 'exact';
  const found = indexesOf(S, P);
  if (found.length) {
    // Several copies (the same words dictated twice): the one ending nearest the caret.
    start = found.reduce((best, i) => (Math.abs(i + P.length - caretAt) < Math.abs(best + P.length - caretAt) ? i : best), found[0]);
    end = start + P.length;
  } else {
    const f = fuzzy(P, S, caretAt);
    if (!f) return null;
    ({ start, end } = f);
    how = 'fuzzy';
  }
  const cutBefore = Boolean(read.cutBefore);
  const cutAfter = Boolean(read.cutAfter);
  return {
    landed: S.slice(start, end).trim(),
    how,
    at: start,
    L: S.slice(Math.max(0, start - ANCHOR), start).replace(/ $/, ''),
    R: S.slice(end, end + ANCHOR).replace(/^ /, ''),
    atStart: start === 0 && !cutBefore,
    atEnd: end === S.length && !cutAfter,
    whole: start === 0 && end === S.length && !cutBefore && !cutAfter,
    // The field's other text near it, to tell "this text was removed" from "the field shows something else".
    rest: (S.slice(Math.max(0, start - 1000), start) + ' ' + S.slice(end, end + 1000)).trim()
  };
}

/** Where the left anchor ends (= where the text starts), shortening it once if it was edited. */
function starts(base, S) {
  if (!base.L) return base.atStart ? [0] : [];
  for (const L of [base.L, base.L.slice(-12)]) {
    const at = indexesOf(S, L);
    if (at.length) return at.map((i) => i + L.length);
    if (L.length <= 12) break;
  }
  return [];
}

function ends(base, S) {
  if (!base.R) return base.atEnd ? [S.length] : [];
  for (const R of [base.R, base.R.slice(0, 12)]) {
    const at = indexesOf(S, R);
    if (at.length) return at;
    if (R.length <= 12) break;
  }
  return [];
}

const wordsOf = (s) => new Set(s.split(' ').map(loose).filter(Boolean));

/** Is most of the field's other text still there? */
function restStays(rest, S) {
  if (!rest) return false;
  if (S.includes(rest)) return true;
  const have = wordsOf(S);
  const want = [...wordsOf(rest)];
  return want.length > 0 && want.filter((w) => have.has(w)).length / want.length >= 0.6;
}

/**
 * Find the pasted text in a later read: between its anchors (the nearest pair), else by its
 * words. {state: 'located', text, at} | 'cleared' (the field is empty) | 'out-of-view' (the field
 * is longer than the read and the text is not in it) | 'gone' (the whole field was read; it is not there).
 */
function locate(base, read) {
  const S = norm(read.text);
  if (!S) return { state: 'cleared', S };
  const st = starts(base, S);
  const en = ends(base, S);
  let best = null;
  for (const s of st) {
    for (const e of en) {
      if (e < s) continue;
      const score = Math.abs(e - s - base.landed.length) + Math.abs(s - base.at) / 1000;
      if (!best || score < best.score) best = { s, e, score };
    }
  }
  if (best) return { state: 'located', text: S.slice(best.s, best.e), at: best.s, S };
  const f = fuzzy(base.landed, S, base.at + base.landed.length);
  if (f) return { state: 'located', text: S.slice(f.start, f.end), at: f.start, rough: true, S };
  if (read.cutBefore || read.cutAfter) return { state: 'out-of-view', S };
  return { state: 'gone', S };
}

/* --------------------------------------------------------------- the apps */

// Apps whose text box empties when what is in it is sent: chat apps, AI chats (desktop, in an
// editor's side panel, in a browser), browsers. Process names on Windows, app names on a Mac.
const SUBMITS = new RegExp('^(' + [
  'claude', 'chatgpt', 'slack', 'discord', 'teams', 'ms-teams', 'microsoft teams', 'whatsapp', 'whatsapp\\.root',
  'telegram', 'signal', 'messenger', 'messages', 'element', 'beeper', 'zoom', 'skype',
  'chrome', 'google chrome', 'msedge', 'microsoft edge', 'firefox', 'zen', 'brave', 'brave browser', 'opera', 'opera_gx',
  'vivaldi', 'arc', 'safari', 'chromium', 'thorium', 'floorp', 'librewolf', 'waterfox',
  'code', 'cursor', 'windsurf', 'antigravity', 'zed'
].join('|') + ')$', 'i');

const submits = (app) => SUBMITS.test(String(app || ''));
const sameApp = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/* --------------------------------------------------------------- watching */

const unknown = (why) => ({ v: 'unknown', why });

/** Only the fields a verdict has, in range: what store.js writes into a History item. Null if not a verdict. */
function cleanKept(k) {
  if (!k || typeof k !== 'object' || !VERDICTS.has(k.v)) return null;
  const n = (x, max) => (Number.isFinite(x) && x >= 0 ? Math.min(max, Math.round(x)) : null);
  const out = { v: k.v };
  if (k.v === 'edited') {
    out.chars = n(k.chars, 1e6) || 0;
    out.words = n(k.words, 1e5) || 0;
    if (Number.isFinite(k.share)) out.share = Math.round(Math.max(0, Math.min(1, k.share)) * 100) / 100;
    if (Array.isArray(k.changes)) {
      out.changes = k.changes
        .filter((c) => c && typeof c.was === 'string' && typeof c.now === 'string')
        .slice(0, MAX_CHANGES)
        .map((c) => ({ was: clip(c.was), now: clip(c.now) }));
    }
  }
  if (k.v === 'kept' || k.v === 'edited') {
    if (n(k.typed, 1e6)) out.typed = n(k.typed, 1e6);
    if (k.sent === true) out.sent = true;
    if (k.fast === true) out.fast = true;
  }
  if (k.v === 'redone') {
    if (k.how === 'revise' || k.how === 'dictate') out.how = k.how;
    if (k.was === 'kept' || k.was === 'edited' || k.was === 'deleted') out.was = k.was;
  }
  if (k.v === 'unknown' && WHYS.has(k.why)) out.why = k.why;
  if (k.rough === true) out.rough = true;
  if (ENDS.has(k.end)) out.end = k.end;
  if (n(k.ms, 864e5) !== null) out.ms = n(k.ms, 864e5);
  if (n(k.reads, 1000) !== null) out.reads = n(k.reads, 1000);
  return out;
}

/**
 * The life-log line for a verdict: counts and kinds, never the words -- and how the watch ended,
 * so the log alone shows whether watching works in an app ("kept, sent (ended sent, 4 reads, 7.5 s)").
 */
function logLine(k) {
  if (!k) return 'none';
  let line = k.v;
  if (k.v === 'edited') line = 'edited: ' + k.words + (k.words === 1 ? ' word, ' : ' words, ') + k.chars + (k.chars === 1 ? ' character' : ' characters') + (k.sent ? ', sent' : '');
  if (k.v === 'kept') line = 'kept' + (k.sent ? ', sent' : '') + (k.typed ? ', written on' : '');
  if (k.v === 'redone') line = 'redone' + (k.how === 'revise' ? ' by a revision' : k.how === 'dictate' ? ' by dictating again' : '');
  if (k.v === 'unknown') line = 'unknown: ' + (k.why || 'no reason');
  if (k.rough) line += ', found by its words';
  const how = [];
  if (k.end) how.push('ended ' + k.end);
  if (Number.isFinite(k.reads)) how.push(k.reads + (k.reads === 1 ? ' read' : ' reads'));
  if (Number.isFinite(k.ms)) how.push(Math.round(k.ms / 100) / 10 + ' s');
  return how.length ? line + ' (' + how.join(', ') + ')' : line;
}

/** 'full' | 'light' | null from the model's file names: "...-0.6b-..." is the light model, "...-1.7b-..." the full one. */
function variantOf(...files) {
  for (const f of files) {
    const s = String(f || '').toLowerCase();
    if (/(^|[^0-9.])0[._p]6b/.test(s)) return 'light';
    if (/(^|[^0-9.])1[._p]7b/.test(s)) return 'full';
  }
  return null;
}

/**
 * The watcher: one paste at a time, the latest. Its parts are passed in so the bench can drive a
 * minute in a millisecond.
 *
 *   timers   {set(fn, ms), clear(handle)}
 *   now      () => ms
 */
function createKept({ timers = { set: setTimeout, clear: clearTimeout }, now = Date.now, schedule = SCHEDULE_MS, redoMs = REDO_MS } = {}) {
  let cur = null;
  // Apps where a paste has been found by a read this run: there, an empty box right after a paste
  // was sent, not unreadable.
  const readable = new Set();

  function clearReads(w) {
    for (const t of w.timers) timers.clear(t);
    w.timers = [];
  }

  /** The verdict leaves: once, to onResult. */
  function emit(w, result) {
    if (w.done) return;
    w.done = true;
    clearReads(w);
    if (w.pending && w.pending.timer) timers.clear(w.pending.timer);
    w.pending = null;
    if (cur === w) cur = null;
    const out = cleanKept({ ...result, ms: now() - w.startedAt, reads: w.reads });
    try { w.onResult(out); } catch { /* the caller's problem; the watch is over either way */ }
  }

  /**
   * The watch is over. A deletion or a send waits a little first: the next dictation may show it
   * was a redo (settle, watch).
   */
  function finish(w, result, end) {
    if (w.done || w.pending) return;
    const r = { ...result, end };
    if (r.v === 'deleted' || (r.v === 'kept' && r.sent)) {
      clearReads(w);
      w.pending = { result: r, timer: timers.set(() => emit(w, r), redoMs) };
      return;
    }
    emit(w, r);
  }

  function handle(w, read) {
    if (w.done || w.pending) return;
    // The helper is busy with a dictation's own command: not a miss, just no look this time.
    if (read && read.skip) return;
    // The helper could not answer (an app that hangs its accessibility reads): twice running, and
    // the watch stops rather than keep waiting on it.
    if (!read || !read.process) {
      if (++w.misses >= 2) finish(w, w.last || unknown('no-read'), 'stopped');
      return;
    }
    w.misses = 0;
    if (!w.app) w.app = read.process;
    if (!sameApp(w.app, read.process)) return finish(w, w.last || unknown('left'), 'left');
    // Another field of the same app: the focus left ours.
    if (w.base && w.base.fid && read.fid && read.fid !== w.base.fid) return finish(w, w.last, 'left');
    // A password field is never read (the helper sends no text for one) and ends the watch.
    if (read.pw) return w.base ? finish(w, w.last, 'left') : finish(w, unknown('password'), 'password');
    if (read.how !== 'text' && read.how !== 'value') {
      if (!w.base && ++w.looks >= FIRST_LOOKS) finish(w, unknown('unreadable'), 'unreadable');
      return;
    }
    w.reads++;

    if (!w.base) {
      w.looks++;
      const b = baseline(w.P, read);
      if (b) {
        w.base = { ...b, fid: read.fid || '' };
        w.last = { v: 'kept', ...(b.how === 'fuzzy' ? { rough: true } : {}) };
        w.lastText = b.landed;
        readable.add(String(w.app).toLowerCase());
        return;
      }
      if (w.looks < FIRST_LOOKS) return;
      // An empty box in a chat app that has shown Typd its pastes before: sent before the first look.
      if (!norm(read.text) && submits(w.app) && readable.has(String(w.app).toLowerCase())) {
        return finish(w, { v: 'kept', sent: true, fast: true }, 'sent');
      }
      return finish(w, unknown('not-found'), 'not-found');
    }

    const o = locate(w.base, read);
    if (o.state === 'located') {
      w.last = compare(w.base.landed, o.text);
      // Found by its words, at the first look or this one: the verdict is rough.
      if (o.rough || w.base.how === 'fuzzy') w.last.rough = true;
      w.lastText = norm(o.text);
      w.base.at = o.at;
      return;
    }
    if (o.state === 'cleared') {
      // Emptied: sent, in an app that sends what is typed; elsewhere, deleted.
      return submits(w.app) ? finish(w, { ...w.last, sent: true }, 'sent') : finish(w, { v: 'deleted' }, 'cleared');
    }
    if (o.state === 'out-of-view') return finish(w, w.last, 'out-of-view');
    // Not there, and the whole field was read: removed if the rest of the field stayed; if the
    // field now holds something else entirely, the person moved on (another chat's draft).
    if (restStays(w.base.rest, o.S)) return finish(w, { v: 'deleted' }, 'cleared');
    return finish(w, w.last, 'replaced');
  }

  async function look(w) {
    if (w.done || w.pending || w.inFlight) return;
    if (w.busy()) return;                                   // a newer dictation is under way: its settle decides
    w.inFlight = true;
    let read = null;
    try { read = await w.read(); } catch { read = null; }
    w.inFlight = false;
    handle(w, read);
  }

  /**
   * Start watching a paste.
   *   pasted     the text Typd pasted
   *   app        the process it went to (current.target.process), or null to take the first read's
   *   read       async () => {process, fid, pw, how, text, caret, cutBefore, cutAfter} | null (inject.fieldAround)
   *   busy       () => true while a newer dictation is under way (its reads come first)
   *   onResult   (verdict) => void, once
   */
  function watch({ pasted, app = null, read, busy = () => false, onResult = () => {} }) {
    // The next paste: a send that waited is a redo if it says the same again; a watch still open ends.
    if (cur) {
      const w = cur;
      if (w.pending) {
        const r = w.pending.result;
        if (r.v === 'kept' && r.sent && sameApp(w.app, app) && similar(w.pasted, pasted)) emit(w, { v: 'redone', how: 'dictate', was: 'kept', end: 'next' });
        else if (r.v === 'deleted' && sameApp(w.app, app)) emit(w, { v: 'redone', how: 'dictate', was: 'deleted', end: 'next' });
        else emit(w, r);
      } else {
        emit(w, { ...(w.last || unknown('no-read')), end: 'next' });
      }
    }
    if (typeof pasted !== 'string' || !norm(pasted) || typeof read !== 'function') return null;

    const w = {
      pasted, P: norm(pasted), app, read, busy, onResult,
      startedAt: now(), base: null, last: null, lastText: null, looks: 0, reads: 0, misses: 0,
      timers: [], inFlight: false, done: false, pending: null
    };
    cur = w;
    if (w.P.length > MAX_CHARS) { emit(w, { ...unknown('too-long'), end: 'too-long' }); return null; }
    schedule.forEach((ms, i) => {
      w.timers.push(timers.set(async () => {
        await look(w);
        if (i === schedule.length - 1 && !w.done && !w.pending) finish(w, w.last || unknown(w.looks ? 'not-found' : 'no-read'), 'window');
      }, ms));
    });
    return w;
  }

  /**
   * A new dictation is starting: the last word on the paste before it.
   *   selection   the highlight the new one revises ({text, process}), when it is a revision
   *   process     the app the new one is in (a dictation: its context read's)
   * A revision over the pasted text is a redo. A dictation in the same app, with the text deleted,
   * is a redo; otherwise one last look, then the verdict.
   */
  async function settle({ selection = null, process: app = null } = {}) {
    const w = cur;
    if (!w || w.done) return;

    if (selection && selection.text) {
      // Gone already (sent or deleted): whatever is highlighted now is not it.
      if (w.pending) return emit(w, w.pending.result);
      const s = norm(selection.text);
      const there = w.lastText || (w.base && w.base.landed) || w.P;
      const over = Boolean(s) && sameApp(w.app, selection.process || app) &&
        (there.includes(s) || s.includes(there) || similar(s, there));
      if (over) return emit(w, { v: 'redone', how: 'revise', was: w.last && w.last.v === 'edited' ? 'edited' : 'kept', end: 'next' });
      return emit(w, { ...(w.last || unknown('no-read')), end: 'next' });
    }

    if (w.pending) {
      if (w.pending.result.v === 'deleted' && sameApp(w.app, app)) emit(w, { v: 'redone', how: 'dictate', was: 'deleted', end: 'next' });
      // A send: whether this one says the same again is known at its paste (watch).
      return;
    }
    if (app && !sameApp(w.app, app)) return finish(w, w.last || unknown('left'), 'left');

    clearReads(w);
    let read = null;
    if (!w.inFlight) {
      w.inFlight = true;
      try { read = await w.read(); } catch { read = null; }
      w.inFlight = false;
    }
    handle(w, read);
    if (w.done) return;
    if (w.pending) {
      if (w.pending.result.v === 'deleted') emit(w, { v: 'redone', how: 'dictate', was: 'deleted', end: 'next' });
      return;
    }
    finish(w, w.last || unknown(w.looks ? 'not-found' : 'no-read'), 'next');
  }

  /** Quit, or a test: the watch ends without a verdict. */
  function stop() {
    if (!cur) return;
    const w = cur;
    clearReads(w);
    if (w.pending && w.pending.timer) timers.clear(w.pending.timer);
    w.done = true;
    cur = null;
  }

  return { watch, settle, stop, active: () => cur };
}

// The app's watcher.
const shared = createKept();

module.exports = {
  watch: shared.watch, settle: shared.settle, stop: shared.stop,
  createKept, compare, similar, norm, baseline, locate, cleanKept, logLine, variantOf, submits,
  SCHEDULE_MS, REDO_MS, MAX_CHARS, VERDICTS
};
