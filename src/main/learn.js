'use strict';

const fs = require('fs');
const path = require('path');
const dictionary = require('./dictionary');

const debug = process.env.TYPD_DEBUG
  ? (...args) => console.log('[typd:learn]', ...args)
  : () => {};

/**
 * Learning from corrections (ROADMAP 3.2).
 *
 * You fix a word in the text that was just pasted, and it is remembered -- no
 * dialog, no settings trip, no "add to dictionary" menu. The pill says what was
 * learned; the tray can forget it.
 *
 * The mechanism is the UI Automation read already used for screen context. We
 * know what we pasted; a few seconds later, and again when the next dictation
 * starts, we read the same control and diff. A word that changed is a word we
 * got wrong.
 *
 * The whole problem is telling a *correction* from an *edit*. Someone rewriting
 * a sentence is not teaching us anything, and learning from it would poison the
 * dictionary with ordinary word choice -- worse than not learning at all. So a
 * change is learned only when all of these hold:
 *
 *   1. it is the only change to our text: one span of one to three words
 *      replaced by one to three words, nothing added or removed elsewhere
 *   2. the new words include one that is not common English (common-words.txt:
 *      the 5,000 most frequent words in our speech transcripts)
 *   3. old and new are spelled alike enough to be the same sound misheard
 *   4. no digits (numbers are formatting) and no bare inflection (dog -> dogs)
 *
 * "Ayşe" -> "Aysel", "cable" -> "Kaggle", "whisper flow" -> "Wispr Flow" and
 * "type less" -> "Typeless" pass. "big" -> "large" fails 2 and 3, a rewritten
 * clause fails 1, "100 gigabytes" -> "1 gigabyte" fails 4. bench/learn.js keeps
 * the score.
 */

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

/** Levenshtein -- these are a few words, not documents. */
function distance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;

  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], row[j - 1]);
    }
    prev = row;
  }
  return prev[n];
}

function similarity(a, b) {
  const longest = Math.max(a.length, b.length);
  return longest ? 1 - distance(a, b) / longest : 0;
}

/**
 * A rough sound key: the consonant skeleton, with letters that sound alike
 * merged ("Chronos" krns, "Kairos" krs; "cable" kbl, "Kaggle" kgl). Spelling
 * distance alone lets unrelated short names through ("Kaggle" / "Kwame").
 */
function soundKey(s) {
  const t = s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/ı/g, 'i').replace(/ph/g, 'f').replace(/ck|q|c(?=[aoukrl])/g, 'k').replace(/c/g, 's')
    .replace(/x/g, 'ks').replace(/z/g, 's').replace(/w/g, 'v').replace(/[^a-z]/g, '');
  const head = /^[aeiouy]/.test(t) ? t[0] : '';
  return (head + t.slice(head.length).replace(/[aeiouyh]/g, '')).replace(/(.)\1+/g, '$1');
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

/** Words with where they sit, so a learned term keeps its exact spelling. */
function tokens(text) {
  const out = [];
  for (const m of String(text || '').matchAll(WORD)) {
    out.push({ word: m[0], key: m[0].toLowerCase().replace(/’/g, "'"), at: m.index });
  }
  return out;
}

const MAX_PASTED = 800;    // words; longer dictations are not worth an alignment per check
const MAX_SCREEN = 2500;   // words of the control, nearest the end (where the caret usually is)

/**
 * Longest common subsequence of two word lists, as matched index pairs.
 * Lowercase keys, so a word whose only change is case still anchors.
 */
function align(a, b) {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i].key === b[j].key
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].key === b[j].key) { pairs.push([i, j]); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Where our text went and what changed in it: a list of changed spans, each
 * {was: [i0, i1), now: [j0, j1)} over the pasted and screen word lists.
 * Null when our text is not recognisably on screen.
 */
function changes(P, S) {
  const pairs = align(P, S);
  if (pairs.length < Math.max(1, Math.ceil(P.length * 0.6))) return null;

  const firstS = pairs[0][1];
  const lastS = pairs[pairs.length - 1][1];
  // Matches scattered over a long document are common words, not our text.
  if (lastS - firstS + 1 > P.length * 1.5 + 6) return null;

  const spans = [];
  // Before the first anchor: a change to our opening words. Assume one-for-one,
  // since the screen words before that point are the user's own earlier text.
  const lead = pairs[0][0];
  if (lead > 0) spans.push({ was: [0, lead], now: [Math.max(0, firstS - lead), firstS] });

  for (let k = 1; k < pairs.length; k++) {
    const [pi, pj] = pairs[k - 1];
    const [ni, nj] = pairs[k];
    if (ni - pi > 1 || nj - pj > 1) spans.push({ was: [pi + 1, ni], now: [pj + 1, nj] });
  }

  const tail = P.length - 1 - pairs[pairs.length - 1][0];
  if (tail > 0) spans.push({ was: [P.length - tail, P.length], now: [lastS + 1, Math.min(S.length, lastS + 1 + tail)] });

  return { spans, pairs };
}

const INFLECTION = /^(s|es|ed|d|ing|er|ers|ly|'s|n't)$/;

function inflected(a, b) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.startsWith(short) && INFLECTION.test(long.slice(short.length));
}

/**
 * @param {string} pasted  what Typd put on screen
 * @param {string} screen  what the same control holds now
 * @returns {{term: string, heardAs: string}|null}
 */
function findCorrection(pasted, screen) {
  if (!pasted || !screen || screen.includes(pasted)) return null;   // untouched

  const P = tokens(pasted);
  let S = tokens(screen);
  if (!P.length || P.length > MAX_PASTED) return null;
  if (S.length > MAX_SCREEN) S = S.slice(-MAX_SCREEN);

  const found = changes(P, S);
  if (!found || found.spans.length !== 1) return null;
  let { was: [i0, i1], now: [j0, j1] } = found.spans[0];
  if (i1 - i0 < 1 || i1 - i0 > 3 || j1 - j0 < 1 || j1 - j0 > 3) return null;

  // A name usually arrives whole: "whisper flow" -> "Wispr Flow" changes one word
  // and recapitalises its neighbour. Take capitalised neighbours into the term.
  const caseOnly = (pi, sj) => P[pi] && S[sj] && P[pi].word !== S[sj].word && /^\p{Lu}/u.test(S[sj].word);
  const byP = new Map(found.pairs.map(([pi, sj]) => [pi, sj]));
  while (i0 > 0 && byP.get(i0 - 1) === j0 - 1 && caseOnly(i0 - 1, j0 - 1)) { i0--; j0--; }
  while (byP.get(i1) === j1 && caseOnly(i1, j1)) { i1++; j1++; }

  const was = P.slice(i0, i1);
  const now = S.slice(j0, j1);
  let heardAs = was.map((t) => t.word).join(' ');
  const end = now[now.length - 1].at + now[now.length - 1].word.length;
  const raw = screen.slice(now[0].at, end);
  let term = /^[\p{L}\p{N}'’_\-. ]+$/u.test(raw) ? raw.replace(/\s+/g, ' ') : now.map((t) => t.word).join(' ');
  // A web address is one term: "mehmetazdar.com" -> "mehmetdedeler.com".
  const domain = /^\.(com|org|net|io|ai|dev|app|co|edu|gov)\b/i.exec(screen.slice(end));
  const wasEnd = was[was.length - 1].at + was[was.length - 1].word.length;
  if (domain && pasted.slice(wasEnd, wasEnd + domain[0].length).toLowerCase() === domain[0].toLowerCase()) {
    term += domain[0];
    heardAs += domain[0];
  }

  const a = was.map((t) => t.key).join('');
  const b = now.map((t) => t.key).join('');
  if (heardAs.toLowerCase() === term.toLowerCase()) return null;   // case or spacing only
  if (term.length < 3 || term.length > 40) return null;
  if (/\d/.test(heardAs + term)) return null;                       // numbers are formatting
  const isCommon = (t) => common().has(t.key.replace(/'s$/, ''));
  if (!now.some((t) => t.key.length >= 3 && !isCommon(t))) return null;
  if (was.length === 1 && now.length === 1 && inflected(a, b)) return null;
  // A common word swapped for a rarer lowercase one is a choice of word
  // ("use" -> "utilize"); what we mishear is names and jargon, which the user
  // spells with capitals -- or a word that was not common to begin with
  // ("backlash" -> "backslash").
  if (was.every(isCommon) && now.every((t) => t.word === t.word.toLowerCase())) return null;
  // Letters read out ("VRAM") replaced by a name is the user changing who, not
  // us mishearing what.
  if (was.every((t) => /^\p{Lu}{2,5}$/u.test(t.word)) && !now.every((t) => /^[\p{Lu}\p{N}]+$/u.test(t.word))) return null;

  // Close enough to be the same sound heard wrong. By spelling, corrections
  // land at 0.29-0.89 and genuine edits at 0.00-0.25:
  //   chronos -> kairos 0.286, lydia -> nvidia 0.500, backlash -> backslash 0.889
  //   whole -> entire 0.167, layer -> consumer 0.250, transport -> queue 0.000
  // but an ordinary word can score 0.33 against a name by chance
  // ("Improving" -> "Priya"), so the weak middle band must also sound alike --
  // unless what we wrote was not a word at all and the user put a name there
  // ("Azdar" -> "Dedeler", "vingji" -> "DaVinci"). Then it was a mishearing, and
  // at worst the dictionary gains a name the user types anyway: the prompt only
  // ever sees the term, never the pairing.
  const spelled = similarity(a, b);
  if (spelled < 0.27) return null;
  const soundsAlike = similarity(soundKey(a), soundKey(b)) >= 0.5;
  const nameForNonWord = !was.some(isCommon) && now.some((t) => /^\p{Lu}/u.test(t.word) && !isCommon(t));
  if (spelled < 0.45 && !soundsAlike && !nameForNonWord) return null;

  return { term, heardAs };
}

/* --------------------------------------------------------------- watching */

// When to look back. Early enough to feel immediate, spread out enough to catch
// someone who finished reading before they fixed anything.
const CHECKS_MS = [3500, 9000, 18000];

let watching = null;
let timers = [];

function stop() {
  timers.forEach(clearTimeout);
  timers = [];
  watching = null;
}

function consider(mine, focus, onLearn) {
  debug('check', focus && focus.process, 'screen=' + (focus && focus.text ? focus.text.length : 0), 'pasted=' + mine.pasted.length);
  if (watching !== mine || !focus || !focus.text) return false;
  // Moved to a different app: whatever is on screen now is not our text.
  if (mine.appProcess && focus.process && focus.process !== mine.appProcess) {
    stop();
    return false;
  }
  const found = findCorrection(mine.pasted, focus.text);
  debug('found', found);
  if (!found) return false;
  const result = dictionary.add(found.term, found.heardAs, 'auto');
  stop();
  if (result && result.created) onLearn(found);
  return true;
}

/**
 * Start watching for a correction to text just pasted.
 *
 * @param {string} pasted      what we put on screen
 * @param {string} appProcess  where we put it
 * @param {() => Promise<{process: string, text: string}|null>} readFocus
 * @param {(learned: {term: string, heardAs: string}) => void} onLearn
 */
function watch(pasted, appProcess, readFocus, onLearn) {
  stop();
  if (!pasted || pasted.length < 3) return;

  const mine = { pasted, appProcess, onLearn };
  watching = mine;

  for (const delay of CHECKS_MS) {
    timers.push(setTimeout(async () => {
      if (watching !== mine) return;
      let focus = null;
      try {
        focus = await readFocus();
      } catch {
        return;
      }
      consider(mine, focus, onLearn);
    }, delay));
  }
}

/**
 * One last look, with a read the caller already made -- the next dictation
 * reads the control anyway, and "dictate, fix a word, dictate again" is exactly
 * when a correction happens. Then stop: the new paste starts its own watch.
 */
function settle(focus) {
  const mine = watching;
  if (mine) consider(mine, focus, mine.onLearn);
  stop();
}

// soundKey, similarity and isCommon are also pipeline/vocab.js's: one notion of "heard alike".
const isCommon = (word) => common().has(String(word).toLowerCase());

module.exports = { watch, stop, settle, findCorrection, similarity, soundKey, isCommon };
