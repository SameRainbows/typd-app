'use strict';

const dictionary = require('./dictionary');

/**
 * Learning from corrections.
 *
 * The behaviour worth copying: you fix a word in the text that was just pasted,
 * and it is remembered — no dialog, no settings trip, no "add to dictionary"
 * menu. A bubble says what was learned and offers to undo it.
 *
 * The mechanism is the UI Automation read already used for screen context. We
 * know what we pasted; a few seconds later we read the same control again and
 * diff. A word that changed is a word we got wrong.
 *
 * The whole problem is telling a *correction* from an *edit*. Someone rewriting
 * a sentence is not teaching us anything, and learning from it would poison the
 * dictionary with ordinary word choice. Three filters:
 *
 *   1. one word replaced by one word — never phrases
 *   2. the replacement is not a common English word
 *   3. the two are similar enough to be plausibly the same sound
 *
 * "Chronos" → "Kairos" and "backlash" → "backslash" pass all three. "whole" →
 * "entire" fails the second and third. Rewriting a clause fails the first.
 */

// A correction replaces a word with one that sounds alike. An edit replaces it
// with one that means something else. Common words are the tell.
const COMMON = new Set((
  'the be to of and a in that have i it for not on with he as you do at this but ' +
  'his by from they we say her she or an will my one all would there their what ' +
  'so up out if about who get which go me when make can like time no just him ' +
  'know take people into year your good some could them see other than then now ' +
  'look only come its over also back after use two how our work first well way ' +
  'even new want because any these give day most us is are was were been has had ' +
  'more very such through where much before right little should still those where ' +
  'while own same too here does own off down each every own between under again ' +
  'whole entire full complete total part thing things something anything nothing'
).split(' '));

/** Levenshtein, capped — these are single words, not documents. */
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

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

function words(text) {
  return String(text || '').match(WORD) || [];
}

/**
 * Word-level alignment, returning only clean one-for-one substitutions.
 * Anything that inserts, deletes or restructures is ignored on purpose.
 */
function substitutions(before, after) {
  const a = words(before);
  const b = words(after);
  if (!a.length || !b.length) return [];

  // Same length is the overwhelmingly common case for a typo fix, and lets us
  // pair positionally without an alignment table.
  if (a.length === b.length) {
    const out = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) out.push([a[i], b[i]]);
    }
    // Exactly one changed word is a correction. Two or more is someone
    // rewriting, and "transport layer" becoming "queue consumer" must never
    // teach us that "queue" is how "transport" is spelled.
    return out.length === 1 ? out : [];
  }

  return [];
}

/**
 * @returns {{term: string, heardAs: string}|null}
 */
function findCorrection(pasted, current) {
  for (const [was, now] of substitutions(pasted, current)) {
    const wasLower = was.toLowerCase();
    const nowLower = now.toLowerCase();

    if (wasLower === nowLower) continue;
    if (now.length < 3 || now.length > 40) continue;
    if (COMMON.has(nowLower)) continue;       // ordinary word choice, not a fix
    if (/^\d+$/.test(now)) continue;          // numbers are formatting, not vocabulary

    // Close enough to be the same sound heard wrong. Measured across real
    // pairs, corrections land at 0.29–0.89 and genuine edits at 0.00–0.25:
    //
    //   chronos → kairos    0.286     whole  → entire     0.167
    //   lydia   → nvidia    0.500     layer  → consumer   0.250
    //   backlash→ backslash 0.889     transport → queue   0.000
    //
    // 0.27 sits in the gap. "Chronos" and "Kairos" are much further apart than
    // they sound, which is what sets the floor.
    if (similarity(wasLower, nowLower) < 0.27) continue;

    return { term: now, heardAs: was };
  }
  return null;
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

/**
 * Start watching for a correction to text just pasted.
 *
 * @param {string} pasted        what we put on screen
 * @param {string} appProcess    where we put it
 * @param {() => Promise<{process: string, text: string}|null>} readFocus
 * @param {(learned: {term: string, heardAs: string}) => void} onLearn
 */
function watch(pasted, appProcess, readFocus, onLearn) {
  stop();
  if (!pasted || pasted.length < 3) return;

  watching = { pasted, appProcess };
  const mine = watching;

  for (const delay of CHECKS_MS) {
    timers.push(setTimeout(async () => {
      if (watching !== mine) return;

      let focus = null;
      try {
        focus = await readFocus();
      } catch {
        return;
      }
      if (watching !== mine || !focus || !focus.text) return;

      // Moved to a different app: whatever is on screen now is not our text.
      if (appProcess && focus.process && focus.process !== appProcess) {
        stop();
        return;
      }

      // The control holds more than we pasted, so compare against the region
      // our text occupies rather than the whole document.
      const window = extractRegion(focus.text, mine.pasted);
      if (!window) return;

      const found = findCorrection(mine.pasted, window);
      if (!found) return;

      const result = dictionary.add(found.term, found.heardAs, 'auto');
      if (result && result.created) {
        stop();
        onLearn(found);
      }
    }, delay));
  }
}

/**
 * Pull the stretch of `haystack` that corresponds to `needle`.
 *
 * The focused control usually contains far more than we pasted. Anchoring on
 * the first and last few words of our own output finds where it ended up, even
 * after a word inside it changed.
 */
function extractRegion(haystack, needle) {
  if (haystack.includes(needle)) return needle;   // untouched

  const n = words(needle);
  if (n.length < 4) return null;

  const head = n.slice(0, 3).join(' ');
  const tail = n.slice(-3).join(' ');

  const start = haystack.toLowerCase().indexOf(head.toLowerCase());
  if (start === -1) return null;

  const endAt = haystack.toLowerCase().indexOf(tail.toLowerCase(), start);
  if (endAt === -1) return null;

  return haystack.slice(start, endAt + tail.length);
}

module.exports = { watch, stop, findCorrection, substitutions, similarity };
