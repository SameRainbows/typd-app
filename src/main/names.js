'use strict';

/**
 * Names the user says, learned without a dictionary to curate.
 *
 * The recogniser can only spell a name it has been shown (context.js: the screen text and the
 * dictionary line are its prompt). The screen shows it the names that are there now; the dictionary
 * carries the rest, but only what someone typed into it or corrected (learn.js). On the founder's own
 * dictations (dictation-research reports/names_learning_2026-10-31.md) a name in the prompt came out
 * right ~90 % of the time and ~70 % without it, and his real dictionary held 6 terms.
 *
 * So Typd keeps a small local record of the names it has seen where the user works, and of which of
 * them the user then said:
 *
 *   seen   observe(focus): at every dictation the screen text and the window title (the read Typd
 *          already makes for context) give candidates -- words with capitals that are not common
 *          English ("Kaggle", "Aysel"), CamelCase ("OpenWhispr"), short capitals ("VRAM"), web names
 *          ("mehmetdedeler.com", "Hessian.AI") and runs of them ("Wispr Flow", "Lightning AI").
 *          Each is counted once per distinct screen, with the apps and titles it came from.
 *   said   heard(text): every finished dictation is checked against the record. A name written there,
 *          or a sound-alike of one ("Pescian.AI" for "Hessian.AI", "Amelia" for "Emilia"), means the
 *          user says it -- the sound-alike also that the model mishears it. Spelling comes only from
 *          the screen, never from what the model wrote.
 *   typed  typed(term): what the user typed in place of our words (learn.js) counts most.
 *
 * Only a name the user has said or typed goes into the prompt (promoted). ranked() orders them for
 * the 400-character line context.js builds: those on the screen right now first (the likeliest to be
 * said now), then misheard and recently said, names from the app being dictated into before others.
 * The user's own dictionary always comes first. A name seen but never said stays out: on his
 * history such a name was said in the next dictation 0.1-0.4 times per 1,000 (2-3 while on the
 * screen), below every promoted rank that fits the line.
 *
 * Never learned: e-mail addresses, anything with a path or digits mixed in like an id, words of more
 * than 32 characters, common English words, and a name the user removed from the dictionary
 * (block()). Everything stays in userData/names.json on this computer; nothing here is shared or sent
 * (sharing.js sends dictated text only), and contacts are never read.
 */

const fs = require('fs');
const path = require('path');

const debug = process.env.TYPD_DEBUG ? (...a) => console.log('[typd:names]', ...a) : () => {};

/* ------------------------------------------------------------ word lists */

let COMMON = null;
function common() {
  if (COMMON) return COMMON;
  try {
    COMMON = new Set(fs.readFileSync(path.join(__dirname, 'common-words.txt'), 'utf8').split(/\r?\n/).filter(Boolean));
  } catch {
    COMMON = new Set();
  }
  return COMMON;
}
function isCommon(w) {
  const t = String(w).toLowerCase().replace(/’/g, "'").replace(/'s$/, '');
  if (common().has(t)) return true;
  // a common word's plain inflection is as ordinary as the word: typed, loading, responds, cities
  const m = /^(.{3,}?)(s|es|ed|d|ing|er|ers|ies|ied)$/.exec(t);
  if (!m) return false;
  const stem = m[1];
  return common().has(stem) || common().has(stem + 'e') || (/(ies|ied)$/.test(t) && common().has(stem + 'y')) ||
    (/(.)\1$/.test(stem) && common().has(stem.slice(0, -1)));
}

// Short capitals that are ordinary vocabulary, not names to teach the model.
const PLAIN_CAPS = new Set(('AM PM OK US UK EU UN AI API URL PDF CPU GPU RAM USB FAQ CEO CTO HR IT TV PC ' +
  'ID IDS DM DMS PR PRS UI UX LOL OMG BTW FYI ASAP TBD TODO NB PS RE FW CC BCC AKA ETA DIY VS ' +
  'HTML CSS JSON XML HTTP HTTPS WWW SMS GPS ATM DNA NBA NFL USA UAE JPEG PNG GIF MP3 MP4 NEW SALE ' +
  'II III IV VI VII VIII IX XI XII').split(' '));

// Little words that start the next piece of glued text, never part of a name.
const GLUE = new Set('i you we he she it they the a an and or of to in on at for by with from is are was this that my your our'.split(' '));

// Words of interface chrome: frequent on screens, never what someone means to dictate.
const CHROME = new Set(('upvote downvote repost reorder skip subscribe unsubscribe login logout signup ' +
  'signin dropdown checkbox navbar sidebar toolbar tooltip popup darkmode').split(' '));

/* --------------------------------------------------------- sounding alike */

const fold = (s) => String(s).replace(/ı/g, 'i').replace(/İ/g, 'I').normalize('NFKD').replace(/\p{M}/gu, '');

/**
 * A rough phonetic key: letters only, common English spellings of one sound merged
 * (dictation-research scripts/names_test/terms.py phon(), which scored the names test).
 */
function phon(s) {
  let t = fold(s).toLowerCase().replace(/[^a-z]/g, '');
  for (const [a, b] of [['wh', 'w'], ['ph', 'f'], ['ck', 'k'], ['th', 't'], ['gh', 'g'], ['sch', 's'], ['sh', 's'],
    ['qu', 'kw'], ['q', 'k'], ['x', 'ks'], ['z', 's'], ['y', 'i'], ['w', 'v']]) t = t.split(a).join(b);
  t = t.replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k');
  return t.replace(/(.)\1+/g, '$1');
}

function lev(a, b, cap = 9) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Edits allowed between phonetic keys, by the term's key length. */
const allowed = (n) => (n <= 4 ? 0 : n <= 6 ? 1 : n <= 11 ? 2 : 3);

/* ------------------------------------------------------- finding candidates */

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}'’.-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu;
const DOMAIN = /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.(com|org|net|io|ai|dev|app|co|xyz|edu|gov|uk|de|fr|tr)$/iu;

/** What kind of name a single token looks like, or null. */
function shape(tok) {
  const w = tok.replace(/['’]s$/, '').replace(/[.'’-]+$/, '');
  if (w.length < 3 || w.length > 32) return null;
  if (DOMAIN.test(w)) {
    const host = w.split('.');
    // "x.com", "t.co": too short to be worth a slot; long subdomains are page addresses
    if (host[0].length < 4 || host.length > 3) return null;
    return 'web';
  }
  if (/[._]/.test(w)) return null;                           // file.names, snake_case, versions
  if (/\d/.test(w)) return null;                             // ids, times, versions
  if (/^\p{Lu}{2,6}$/u.test(w)) return PLAIN_CAPS.has(w) || (w.length >= 3 && isCommon(w)) ? null : 'caps';
  if (/^(\p{Lu}\p{Ll}+|\p{Ll}{1,2})(\p{Lu}\p{Ll}+)+$/u.test(w) || /^\p{Lu}\p{Ll}+(\p{Lu}\p{Ll}+)*\p{Lu}{2,3}$/u.test(w)) {
    // OpenWhispr, iPhone, FlowRate, OpenAI, ChatGPT. Text glued together by the accessibility read is
    // not: a part that is a little word ("LightningYou", "hoursI") or the same part twice ("FlowFlow").
    const parts = w.match(/\p{Lu}?\p{Ll}+|\p{Lu}+/gu) || [];
    if (parts.some((x) => GLUE.has(x.toLowerCase())) || new Set(parts.map((x) => x.toLowerCase())).size < parts.length) return null;
    return CHROME.has(w.toLowerCase()) ? null : 'camel';
  }
  if (/^\p{Lu}\p{Ll}+$/u.test(w) && !/^\p{Lu}\p{Ll}+-/u.test(w)) {
    return isCommon(w) || CHROME.has(w.toLowerCase()) ? 'plain' : 'title';
  }
  return null;
}

/**
 * Candidate names in a piece of text: [{term, kind, mid}], each once. `mid` is false when the only
 * sightings start a sentence (where every word has a capital).
 */
function candidates(text) {
  const out = new Map();
  const add = (term, kind, mid) => {
    const k = term.toLowerCase();
    const e = out.get(k);
    if (e) { e.mid = e.mid || mid; return; }
    out.set(k, { term, kind, mid });
  };
  for (const line of String(text || '').split(/\n|(?<=[.!?…:;|•·—–])\s+/)) {
    const toks = [...line.matchAll(TOKEN)];
    let run = [];
    const flush = () => {
      // a run of 2-3 capitalised words with at least one that is not common: "Wispr Flow", "Lightning AI"
      // a sentence's first word has a capital anyway: "Hey Aysel" is Aysel
      while (run.length && run[0].kind === 'plain') run.shift();
      while (run.length && GLUE.has(run[run.length - 1].word.toLowerCase())) run.pop();
      if (run.length >= 2 && run.length <= 3 && run.some((r) => r.kind !== 'plain')) {
        add(run.map((r) => r.word).join(' '), 'phrase', run[0].mid);
      }
      run = [];
    };
    for (let i = 0; i < toks.length; i++) {
      const m = toks[i];
      const word = m[0].replace(/['’]s$/, '').replace(/[.'’-]+$/, '');
      const before = line.slice(0, m.index);
      // an e-mail address or a handle: never
      if (/[@#]$/.test(before) || /@/.test(m[0])) { flush(); continue; }
      // part of a path or link (a slash next to it): the page address, not a name
      if (/[\\/]$/.test(before) || /^[\\/]/.test(line.slice(m.index + m[0].length))) { flush(); continue; }
      let kind = shape(m[0]);
      const mid = Boolean(before.trim()) && !/[.!?…:"“(]\s*$/.test(before);
      if (kind && kind !== 'plain') add(word, kind, mid || kind !== 'title');
      // "AI" in "Lightning AI": ordinary capitals still belong to a name around them
      if (!kind && PLAIN_CAPS.has(word)) kind = 'plain';
      // runs: adjacent tokens, separated by one space
      const adjacent = run.length && line.slice(run[run.length - 1].end, m.index) === ' ';
      if (kind && kind !== 'web' && (adjacent || !run.length)) {
        if (!adjacent) run = [];
        run.push({ word, kind, mid, end: m.index + m[0].length });
        if (run.length > 3) { run = []; }
      } else {
        flush();
        if (kind && kind !== 'web') run.push({ word, kind, mid, end: m.index + m[0].length });
      }
    }
    flush();
  }
  return [...out.values()];
}

/** The segments of a window title, without the app's own name at its end ("— Zen Browser"). */
function titleParts(title) {
  const parts = String(title || '').split(/\s+[-—–|:·]\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) parts.pop();
  return parts.join('\n');
}

/* ------------------------------------------------------- said in a dictation */

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’.-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function exactRe(term, flags = 'iu') {
  const body = esc(term).replace(/\\\.|\s+/g, (m) => (m === '\\.' ? '\\s*\\.?\\s*' : "(?:['’]s)?\\s+"));
  return new RegExp('(?<![\\p{L}\\p{N}])' + body + "(?:s|['’]\\p{L}+)?(?![\\p{L}\\p{N}])", flags);
}

/**
 * A dictation's words, ready to be checked against many names: its lowercased text and every window
 * of 1-4 words with its phonetic key. Windows of only common words are left out: a single common word
 * is never a sound-alike ("model" is not "Modal", "cable" not "Kaggle").
 */
function prepare(text) {
  const toks = [...String(text || '').matchAll(WORD)].map((m) => ({ w: m[0], at: m.index }));
  // Each distinct window once, filed by key length: a long dictation repeats itself, and a name is
  // only ever compared with windows near its own length (1,094 words against 2,000 names: 2.1 s -> ms).
  const byLen = new Map();
  const seen = new Set();
  for (let i = 0; i < toks.length; i++) {
    for (let k = 1; k <= 4 && i + k <= toks.length; k++) {
      const words = toks.slice(i, i + k).map((t) => t.w);
      if (words.every(isCommon)) continue;
      const key = phon(words.join(''));
      if (!key || seen.has(k + ':' + key)) continue;
      seen.add(k + ':' + key);
      const w = { k, key, surface: text.slice(toks[i].at, toks[i + k - 1].at + toks[i + k - 1].w.length) };
      // filed twice: by length and first sound, and by length and the sounds after the first
      for (const tag of [key.length + '|' + key[0], key.length + '~' + key.slice(1, 4)]) {
        if (!byLen.has(tag)) byLen.set(tag, []);
        byLen.get(tag).push(w);
      }
    }
  }
  return { text: String(text || ''), low: String(text || '').toLowerCase(), byLen };
}

/**
 * Where a prepared dictation has `term`:
 *   {how: 'exact'}            written with its spelling
 *   {how: 'alike', surface}   a sound-alike ("Pescian.AI" for "Hessian.AI", "whisper flow" for "Wispr Flow")
 *   {how: 'plain'}            a one-word name or a run of capitalised words written as ordinary words:
 *                             "dictation" for "Dictation" is the word, not a name, and counts against it
 *   null                      not there
 */
function said(prep, term, key = phon(term), kind = null) {
  if (!prep || !key) return null;
  if (typeof prep === 'string') prep = prepare(prep);
  const lowTerm = term.toLowerCase();
  if (prep.low.includes(lowTerm.split(/[\s.]/)[0]) && exactRe(term).test(prep.text)) {
    if (kind !== 'title' && kind !== 'phrase') return { how: 'exact' };
    // A capitalised word counts as the name only where it keeps its capital mid-sentence; written in
    // lowercase it is the ordinary word, and at a sentence's start it says nothing either way.
    let name = false, word = false;
    for (const m of prep.text.matchAll(exactRe(term, 'giu'))) {
      if (/^\p{Ll}/u.test(m[0])) { word = true; continue; }
      const caps = (x) => x.split(/\s+/).map((y) => /^\p{Lu}/u.test(y)).join();
      if (kind === 'phrase' && caps(m[0].replace(/['’]s\b/g, '')) !== caps(term)) { word = true; continue; }
      const before = prep.text.slice(0, m.index);
      if (before.trim() && !/[.!?…:"“(]\s*$/.test(before)) name = true;
    }
    if (name) return { how: 'exact' };
    return word ? { how: 'plain' } : null;
  }
  const n = term.split(/[\s.]+/).filter(Boolean).length;
  let best = null;
  const most = allowed(key.length);
  const consider = (w, room) => {
    if (w.k < n - 1 || w.k > n + 1) return;
    const d = lev(w.key, key, 4);
    if (d <= room && (!best || d < best.d)) best = { how: 'alike', surface: w.surface, d };
  };
  for (let len = key.length - most; len <= key.length + most; len++) {
    // the same first sound, within the edits its length allows
    for (const w of prep.byLen.get(len + '|' + key[0]) || []) consider(w, most);
    // another first sound -- a longer name only, one edit less, the next sounds the same
    // ("Pescian.AI" for "Hessian.AI")
    if (key.length >= 6 && Math.abs(len - key.length) <= most - 1) {
      for (const w of prep.byLen.get(len + '~' + key.slice(1, 4)) || []) if (w.key[0] !== key[0]) consider(w, most - 1);
    }
  }
  return best;
}

/* ------------------------------------------------------- our own words */

/*
 * A name is never learned from what Typd itself wrote: that is where its own mishearings are
 * ("Pescian.AI", "Typed"). Every dictation leaves the hashes of its 5-word runs (never the words), and
 * the words of a screen covered by one of them are left out before names are looked for -- whatever
 * else the screen shows around them ("You said: ...", a reply quoting it) is still read.
 */
const SHINGLE = 5;
const lowWords = (text) => [...String(text || '').matchAll(WORD)].map((m) => ({ w: m[0].toLowerCase(), at: m.index, end: m.index + m[0].length }));
function shingles(text) {
  const w = lowWords(text);
  const out = [];
  for (let i = 0; i + SHINGLE <= w.length; i++) out.push(hash(w.slice(i, i + SHINGLE).map((x) => x.w).join(' ')));
  return out;
}
/** `text` with the words of Typd's own runs replaced by line breaks. */
function withoutOwn(text, own) {
  if (!own.size) return text;
  const w = lowWords(text);
  const mine = new Uint8Array(w.length);
  for (let i = 0; i + SHINGLE <= w.length; i++) {
    if (own.has(hash(w.slice(i, i + SHINGLE).map((x) => x.w).join(' ')))) mine.fill(1, i, i + SHINGLE);
  }
  let out = '', at = 0;
  for (let i = 0; i < w.length; i++) {
    if (!mine[i]) continue;
    out += text.slice(at, w[i].at) + '\n';
    at = w[i].end;
  }
  return out + text.slice(at);
}

/* ------------------------------------------------------------------ store */

const MAX_TERMS = 3000;
const SEEN_MEMORY = 200;   // screens remembered, so one screen read twice counts once
const OWN_MEMORY = 30000;  // 5-word runs Typd wrote, remembered as hashes (the last few hundred dictations)

function createStore(file) {
  let data = null;
  let dirty = false;
  let timer = null;

  function load() {
    if (data) return data;
    data = { v: 1, terms: {}, blocked: [], screens: [], own: [] };
    if (!file) return data;
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d && d.v === 1 && d.terms) data = { v: 1, terms: d.terms, blocked: d.blocked || [], screens: d.screens || [], own: d.own || [], removed: d.removed || {} };
    } catch { /* first run, or a damaged file: start over */ }
    return data;
  }

  function save(now = false) {
    dirty = true;
    if (!file) return;
    const write = () => {
      timer = null;
      if (!dirty) return;
      dirty = false;
      prune();
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file + '.tmp', JSON.stringify(data), 'utf8');
        fs.renameSync(file + '.tmp', file);
      } catch (err) {
        debug('could not save', err && err.message);
      }
    };
    if (now) return write();
    if (!timer) {
      timer = setTimeout(write, 2000);
      if (timer.unref) timer.unref();
    }
  }

  /** Over the cap, the candidates least likely to matter go: never said, seen least, longest ago. */
  function prune() {
    const keys = Object.keys(data.terms);
    if (keys.length <= MAX_TERMS) return;
    keys.sort((a, b) => worth(data.terms[b]) - worth(data.terms[a]));
    for (const k of keys.slice(MAX_TERMS)) delete data.terms[k];
  }
  const worth = (e) => (e.said || 0) * 100 + (e.typed ? 1000 : 0) + Math.log2(1 + (e.seen || 0)) * 10 + (e.last || 0) / 8.64e7 / 30;

  const blocked = (term) => load().blocked.includes(String(term).toLowerCase());

  return {
    file,

    /**
     * A screen read at the start of a dictation: {process, title, text}. Counts each candidate once
     * per distinct screen. `at` (ms) for tests and the replay; now otherwise.
     */
    observe(focus, at = Date.now()) {
      if (!focus || !focus.process) return 0;
      const d = load();
      // Typd's own pasted words are left out: only what others wrote, and what the user typed
      const text = withoutOwn(String(focus.text || '').slice(-6000), new Set(d.own));
      const title = titleParts(focus.title);
      const sig = hash(focus.process + '\n' + title + '\n' + text);
      if (d.screens.includes(sig)) return 0;
      d.screens.push(sig);
      if (d.screens.length > SEEN_MEMORY) d.screens.splice(0, d.screens.length - SEEN_MEMORY);
      const fromTitle = new Set(candidates(title).map((c) => c.term.toLowerCase()));
      let n = 0;
      for (const c of [...candidates(title), ...candidates(text)]) {
        const k = c.term.toLowerCase();
        if (blocked(k)) continue;
        let e = d.terms[k];
        if (!e) {
          e = d.terms[k] = { term: c.term, kind: c.kind, seen: 0, mid: 0, title: 0, apps: {}, first: at, last: at, said: 0, misheard: 0, heardAs: [], spell: {} };
          n++;
        }
        if (e.lastSig === sig) continue;   // once per screen (a title word is also in the text)
        e.lastSig = sig;
        e.seen++;
        if (c.mid) e.mid++;
        if (fromTitle.has(k)) e.title++;
        e.apps[focus.process] = (e.apps[focus.process] || 0) + 1;
        e.last = Math.max(e.last, at);
        // the spelling seen most wins ("Kaggle" over "KAGGLE")
        e.spell[c.term] = (e.spell[c.term] || 0) + 1;
        e.term = spelling(e.spell);
      }
      save();
      return n;
    },

    /**
     * A finished dictation. Every candidate it says, exactly or by sound, is marked said; a
     * sound-alike also records how it was heard. Returns the names marked.
     */
    heard(text, app, at = Date.now(), prompt = '') {
      if (!text || text.length < 3) return [];
      const d = load();
      d.own.push(...shingles(text));
      if (d.own.length > OWN_MEMORY) d.own.splice(0, d.own.length - OWN_MEMORY);
      const hits = [];
      const prep = prepare(text);
      const lowPrompt = String(prompt || '').toLowerCase();
      const found = [];
      for (const e of Object.values(d.terms)) {
        if (!eligible(e)) continue;
        const key = e.key || (e.key = phon(e.term));
        const s = said(prep, e.term, key, e.kind);
        if (s) found.push([e, s]);
      }
      const exact = found.filter(([, s]) => s.how === 'exact').map(([e]) => e.term.toLowerCase());
      for (const [e, s] of found) {
        if (s.how === 'plain') { e.plain = (e.plain || 0) + 1; continue; }
        if (s.how === 'alike' && (e.kind === 'title' || e.kind === 'phrase') && s.surface === s.surface.toLowerCase()) {
          const surf = s.surface.replace(/\s+/g, '');
          const t = e.term.toLowerCase().replace(/\s+/g, '');
          if (surf.startsWith(t.slice(0, Math.max(3, t.length - 3))) || t.startsWith(surf.slice(0, Math.max(3, surf.length - 3)))) e.plain = (e.plain || 0) + 1;
          continue;   // "benchmark" for "Benchmarks", "listing" for "Lightning": no sign the name was said
        }
        if (s.how === 'alike') {
          const surf = s.surface.toLowerCase();
          if (exact.some((t) => t === surf || t.startsWith(surf + ' ') || surf.startsWith(t + ' '))) continue;
          if (e.term.toLowerCase().startsWith(surf + ' ')) continue;
        }
        // In the prompt and written right: the hint worked. Not in it and written right: the model
        // knows this name without help. Not in it and heard wrong: it needs the prompt.
        if (s.how === 'exact') {
          if (lowPrompt && lowPrompt.includes(e.term.toLowerCase())) e.helped = (e.helped || 0) + 1;
          else e.known = (e.known || 0) + 1;
        }
        e.said++;
        e.saidLast = at;
        if (app) e.saidIn = app;
        if (s.how === 'alike') {
          e.misheard++;
          if (!e.heardAs.some((h) => h.toLowerCase() === s.surface.toLowerCase()) && e.heardAs.length < 8) e.heardAs.push(s.surface);
        }
        hits.push({ term: e.term, how: s.how, surface: s.surface });
      }
      save();
      debug('heard', hits);
      return hits;
    },

    /**
     * The user typed this name in place of our words (learn.js): the strongest sign there is. A weak
     * one (all lowercase: maybe an ordinary word of another language) counts only once it is typed
     * again or said.
     */
    typed(term, heardAs, { weak = false, at = Date.now() } = {}) {
      const clean = String(term || '').trim();
      if (!clean || blocked(clean)) return;
      const d = load();
      const k = clean.toLowerCase();
      const e = d.terms[k] || (d.terms[k] = { term: clean, kind: 'typed', seen: 0, mid: 0, title: 0, apps: {}, first: at, last: at, said: 0, misheard: 0, heardAs: [], spell: {} });
      if (weak) e.weakTyped = (e.weakTyped || 0) + 1;
      else e.typed = (e.typed || 0) + 1;
      e.term = clean;
      e.last = Math.max(e.last || 0, at);
      if (heardAs && !e.heardAs.includes(heardAs)) e.heardAs.push(heardAs);
      save();
    },

    /** Never again: the user removed it from the dictionary, or told Typd to forget it. */
    block(term) {
      const d = load();
      const k = String(term || '').toLowerCase();
      if (!k) return;
      // kept aside for an undo (Home's toast), the last few only
      if (d.terms[k]) {
        d.removed = d.removed || {};
        d.removed[k] = d.terms[k];
        const ks = Object.keys(d.removed);
        if (ks.length > 20) delete d.removed[ks[0]];
      }
      delete d.terms[k];
      if (!d.blocked.includes(k)) d.blocked.push(k);
      save();
    },

    /** Learnable again: the user added it back, or undid the removal. */
    unblock(term) {
      const d = load();
      const k = String(term || '').toLowerCase();
      const i = d.blocked.indexOf(k);
      if (i >= 0) d.blocked.splice(i, 1);
      if (d.removed && d.removed[k]) { d.terms[k] = d.removed[k]; delete d.removed[k]; }
      save();
    },

    /** Forget everything learned here (Settings / the tray), keeping the blocked list. */
    clear() {
      const d = load();
      d.terms = {};
      d.screens = [];
      d.own = [];
      save(true);
    },

    /** Promoted names, best first, for the prompt (see ranked()). */
    promoted(opts = {}) {
      return ranked(Object.values(load().terms), opts);
    },

    flush() { save(true); },
    get data() { return load(); }
  };
}

/** Is this candidate one that can be said? A one-word title-case name must have been seen mid-sentence. */
function eligible(e) {
  if (e.typed || e.weakTyped) return true;
  if (e.kind === 'title' && !e.mid && !e.title) return false;
  return true;
}

/**
 * Promoted names, best first: [{term, score}]. Promoted = typed by the user, or said in a dictation.
 *   opts.app     the app being dictated into: its names first
 *   opts.screen  the text on screen now (and the title): promoted names there come first
 *   opts.now     ms
 */
function ranked(entries, { app = null, screen = '', now = Date.now() } = {}) {
  const lowScreen = String(screen || '').toLowerCase();
  const out = [];
  for (const e of entries) {
    if (!eligible(e)) continue;
    const typed = e.typed || 0;
    if (!(typed || e.said || (e.weakTyped || 0) >= 2)) continue;
    // a capitalised word the user mostly says as an ordinary word is that word ("Dictation", "Cleanup")
    if (!typed && (e.kind === 'title' || e.kind === 'phrase') && (e.plain || 0) >= (e.said || 0)) continue;
    const days = Math.max(0, (now - (e.saidLast || e.last || now)) / 8.64e7);
    // Misheard, or right with the hint, are what the prompt is for; right without any help (Kaggle,
    // Turkish) the model does not need the slot as much.
    const needs = 3 * Math.min(e.misheard || 0, 3) + 2 * Math.min(e.helped || 0, 3) + 0.5 * Math.min(e.known || 0, 2) -
      ((e.known || 0) >= 3 && !(e.misheard || 0) ? 2 : 0);
    const score = 4 * Math.min(typed, 2) + needs + Math.log2(1 + (e.seen || 0)) + (e.title ? 1 : 0) +
      (app && e.apps && e.apps[app] ? 1 : 0) - Math.log2(1 + days);
    out.push({ term: e.term, score, key: e.key || phon(e.term), seen: e.seen || 0, said: e.said || 0, typed, heardAs: e.heardAs || [], first: e.first,
      // as a word: "Alt" is not on a screen that says "although"
      onScreen: Boolean(lowScreen) && lowScreen.includes(e.term.toLowerCase()) && exactRe(e.term).test(screen) });
  }
  out.sort((a, b) => b.score - a.score);
  const byFirst = new Map();
  for (const e of entries) {
    if (!eligible(e) || !(e.seen >= 5)) continue;
    const k = e.key || phon(e.term);
    if (!byFirst.has(k[0])) byFirst.set(k[0], []);
    byFirst.get(k[0]).push({ term: e.term, key: k, seen: e.seen });
  }
  const frequent = [].concat(...byFirst.values());
  const variant = (x) => !x.typed && frequent.some((y) => y.term !== x.term && y.seen >= 5 * Math.max(1, x.seen) &&
    Math.abs(y.key.length - x.key.length) <= 3 &&
    lev(y.key, x.key, 4) <= allowed(Math.max(y.key.length, x.key.length)) - (y.key[0] === x.key[0] ? 0 : 1) &&
    !(' ' + y.term.toLowerCase() + ' ').includes(' ' + x.term.toLowerCase() + ' ') && !(' ' + x.term.toLowerCase() + ' ').includes(' ' + y.term.toLowerCase() + ' '));
  for (let i = out.length - 1; i >= 0; i--) if (variant(out[i])) out.splice(i, 1);
  // One spelling per sound: "Whisper Flow" and "WhisperFlow" are one name; the spelling typed by the
  // user, else seen on many more screens, else ranked first, is kept.
  const kept = [];
  for (const x of out) {
    const twin = kept.find((k) => k.key === x.key);
    if (twin) {
      if ((x.typed > twin.typed) || (x.typed === twin.typed && x.seen > twin.seen * 2)) Object.assign(twin, { ...x, score: twin.score });
      twin.said += x.said;
      continue;
    }
    kept.push({ ...x });
  }
  // A name inside a longer one ("Lightning" in "Lightning AI", "Wispr Flow" in "Wispr Flow Pro"): the
  // longer stays when it is said at least half as often, and the shorter goes when it is said mostly
  // inside it; otherwise the longer goes ("Kaggle CPU").
  const inside = (a, b) => (' ' + b.term.toLowerCase() + ' ').includes(' ' + a.term.toLowerCase() + ' ') && a !== b;
  const drop = new Set();
  for (const sh of kept) {
    for (const lg of kept) {
      if (!inside(sh, lg)) continue;
      if (lg.said * 2 >= sh.said) { if (sh.said <= lg.said * 1.5) drop.add(sh); } else drop.add(lg);
    }
  }
  // On the screen now: first, not out. On his history a promoted name on the screen was said in the
  // next dictation 2-8 times as often as one of the same rank off it (53 vs 14 per 1,000 in the top
  // ten), and the line still helped where the screen had the name (Kajol, Wispr Flow): the screen
  // holds it somewhere in 6,000 characters, the line names it.
  const left = kept.filter((x) => !drop.has(x));
  return [...left.filter((x) => x.onScreen), ...left.filter((x) => !x.onScreen)]
    .map(({ term, score, heardAs, first, onScreen }) => ({ term, score, heardAs, first, onScreen }));
}

function spelling(spell) {
  const all = Object.entries(spell).sort((a, b) => b[1] - a[1]);
  const top = all[0][1];
  const capital = all.find(([t, n]) => /^\p{Lu}/u.test(t) && n * 5 >= top);
  return (capital || all[0])[0];
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ':' + s.length;
}

/* -------------------------------------------------------- the app's store */

let shared = null;
/** The store beside dictionary.json (userData/names.json). */
function store() {
  if (shared) return shared;
  let file = null;
  try {
    const { VOCAB_FILE } = require('./pipeline/context');
    file = path.join(path.dirname(VOCAB_FILE), 'names.json');
  } catch { /* no userData: an in-memory store */ }
  shared = createStore(file);
  return shared;
}

module.exports = { createStore, store, candidates, titleParts, said, prepare, phon, ranked, shape, eligible, shingles, withoutOwn };
