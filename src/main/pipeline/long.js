'use strict';

/**
 * Long dictations: where to cut them, and how to join the pieces' text again. Pure functions of
 * audio and text; the requests are local.js's.
 *
 * Past what the model was trained on (90 s) it drops text silently: on a real 162 s dictation
 * 3 of 4 runs lost ~40 %. So recordings over LONG_S are written piece by piece. The model closes
 * a sentence wherever its audio ends, and people pause mid-phrase ("their AI ... quota"), so a
 * pause says nothing about punctuation. Each cut is also written once from the speech either side
 * of it (the seam), and that text decides how the pieces join.
 */

const LONG_S = 75, PIECE_MIN_S = 45, PIECE_MAX_S = 70, FRAME_S = 0.02, SEAM_S = 6, KEEP_S = 0.3;
// A cut is settled once the audio reaches its window's end plus the seam after it: the seam's
// speech runs to the first pause 3-9 s past the cut.
const LOOKAHEAD_S = SEAM_S + 3;

/**
 * Cut at the longest pause between 45 and 70 s into each piece, until the rest is short.
 * The quietest 100 ms (the old rule) could fall in the gap between two words. A pause is a run
 * of 20 ms frames under 1/30 of the median frame energy (about 15 dB below speech), or under 3x
 * its 10th percentile in a noisy room; with no pause of 60 ms or more, the quietest frame. The
 * pause itself is left out but for KEEP_S at each edge: a piece that starts or ends in seconds of
 * silence loses words (seen on a real 8 s pause). Each cut also has its seam: about SEAM_S of
 * speech either side, from and to the nearest pause of 100 ms+, so it starts and ends between
 * phrases ([seamFrom, seamTo]).
 *
 * Causal since 0.2.3: the energy statistics for a cut are those of the audio up to that cut's
 * window end plus LOOKAHEAD_S, not of the whole recording, so a cut can be settled -- and its
 * piece written -- while the user is still talking, and the cut made then is exactly the one the
 * whole recording gives at the end (local.js openLong). On the user's 15 long dictations the
 * thresholds move by a few percent and 44 of 47 cuts stay within one frame
 * (dictation-research LOG.md, 2026-10-17).
 *
 * Feed it the growing buffer; `final` settles the rest once the recording is complete.
 */
class Splitter {
  constructor(sr) {
    this.sr = sr;
    this.f = Math.round(FRAME_S * sr);
    this.e = new Float64Array(0);
    this.n = 0;            // frames measured
    this.start = 0;        // first sample of the piece being cut
    this.cuts = [];
  }

  /** Energy of every whole frame in samples[0, len). */
  measure(samples, len) {
    const f = this.f, n = Math.floor(len / f);
    if (n > this.e.length) {
      const grown = new Float64Array(Math.max(n, this.e.length * 2, 1024));
      grown.set(this.e.subarray(0, this.n));
      this.e = grown;
    }
    for (let j = this.n; j < n; j++) {
      let s = 0;
      for (let k = j * f, end = k + f; k < end; k++) s += samples[k] * samples[k];
      this.e[j] = s;
    }
    this.n = Math.max(this.n, n);
  }

  /** The cuts samples[0, len) settles that were not settled before; all of them when `final`. */
  feed(samples, len, final = false) {
    this.measure(samples, len);
    const sr = this.sr, out = [];
    while (len - this.start > LONG_S * sr) {
      if (!final && len < this.start + (PIECE_MAX_S + LOOKAHEAD_S) * sr) break;
      const cut = this.cut(len);
      this.cuts.push(cut);
      out.push(cut);
      this.start = cut.next;
    }
    return out;
  }

  cut(len) {
    const { f, sr, e } = this;
    const start = this.start;
    const n = Math.min(this.n, Math.floor((start + (PIECE_MAX_S + LOOKAHEAD_S) * sr) / f));
    const sorted = Float64Array.from(e.subarray(0, n)).sort();
    const quiet = Math.max(sorted[Math.floor(n / 2)] / 30, 3 * sorted[Math.floor(n / 10)]);
    const isGap = (j) => {   // frame j ends a run of 5+ quiet frames (100 ms)
      for (let k = j - 4; k <= j; k++) if (k < 0 || k >= n || e[k] >= quiet) return false;
      return true;
    };
    const near = (fromS, toS, fallback, pickLast) => {
      let hit = -1;
      for (let j = Math.max(0, Math.floor(fromS / f)); j < Math.min(n, Math.floor(toS / f)); j++) {
        if (isGap(j)) { hit = j * f; if (!pickLast) break; }
      }
      return hit < 0 ? fallback : hit;
    };
    const keep = Math.round(KEEP_S * sr);
    const lo = Math.ceil((start + PIECE_MIN_S * sr) / f), hi = Math.floor((start + PIECE_MAX_S * sr) / f);
    let run = 0, longest = 0, first = lo, quietest = lo;
    for (let j = lo; j < hi; j++) {
      run = e[j] < quiet ? run + 1 : 0;
      if (run > longest) { longest = run; first = j - run + 1; }
      if (e[j] < e[quietest]) quietest = j;
    }
    const [from, to] = longest >= 3 ? [first * f, (first + longest) * f] : [quietest * f, quietest * f];
    const cutA = Math.min(from + keep, Math.round((from + to) / 2)), cutB = Math.max(to - keep, cutA);
    return {
      start, end: cutA, next: cutB, from, to,
      seamFrom: near(from - (SEAM_S + 3) * sr, from - (SEAM_S - 3) * sr, Math.max(0, from - SEAM_S * sr), true),
      seamTo: near(to + (SEAM_S - 3) * sr, to + (SEAM_S + 3) * sr, Math.min(len, to + SEAM_S * sr), false)
    };
  }
}

/** The whole recording at once: {pieces, pauses}, pieces as views into `samples`. */
function splitLong(samples, sr) {
  const s = new Splitter(sr);
  const cuts = s.feed(samples, samples.length, true);
  const pieces = cuts.map((c) => samples.subarray(c.start, c.end));
  pieces.push(samples.subarray(cuts.length ? cuts[cuts.length - 1].next : 0));
  return { pieces, pauses: cuts, cuts };
}

/** The seam's audio: its speech either side of the cut, the pause between shortened to <= 2 x KEEP_S. */
function seamAudio(samples, sr, { from, to, seamFrom, seamTo }) {
  const keep = Math.min(Math.round(KEEP_S * sr), Math.floor((to - from) / 2));
  const a = samples.subarray(seamFrom, from + keep);
  const b = samples.subarray(to - keep, seamTo);
  const w = new Float32Array(a.length + b.length);
  w.set(a);
  w.set(b, a.length);
  return w;
}

/** Where the cut falls in the seam's audio, 0-1. */
function seamAt({ from, to, seamFrom, seamTo }) {
  return (from - seamFrom) / Math.max(1, from - seamFrom + seamTo - to);
}

/* ------------------------------------------------------------------ joining */

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;

function toks(s) {
  return [...String(s).matchAll(WORD)].map((m) => ({
    w: m[0].toLowerCase().replace(/’/g, "'"), raw: m[0], i: m.index, end: m.index + m[0].length
  }));
}

// Words that carry little: an anchor of two of them ("of the") lines up anywhere.
const LIGHT = new Set(('a an the and or but so to of in on at by for with from as is are was were be been it its ' +
  'i you we they he she that this these those there here what which who not no do does did have has had ' +
  'my your our their his her me us them if then than just very').split(' '));

function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], row[j - 1]);
    prev = row;
  }
  return prev[b.length];
}

/** The same word, allowing one letter's difference in a long one ("organisation" / "organization"). */
function same(x, y) {
  if (x === y) return true;
  const a = x.replace(/'/g, ''), b = y.replace(/'/g, '');
  if (a === b) return true;
  return a.length >= 5 && b.length >= 5 && editDistance(a, b) <= 1;
}

/** Two words in a row of `X` at x, x+1 match `S` at j, j+1; a third if there is one; not both light. */
function pairAt(X, x, S, j) {
  if (x < 0 || x + 1 >= X.length || j < 0 || j + 1 >= S.length) return false;
  if (!same(X[x].w, S[j].w) || !same(X[x + 1].w, S[j + 1].w)) return false;
  if (!LIGHT.has(X[x].w) || !LIGHT.has(X[x + 1].w)) return true;
  return x + 2 < X.length && j + 2 < S.length && same(X[x + 2].w, S[j + 2].w);
}

const MAX_DROP = 4;      // words of a piece's edge the seam may replace (if they are accounted for)
const MAX_BRIDGE = 10;   // words the seam may supply between the two anchors

const capital = (w) => /^\p{Lu}/u.test(w);
// "upload a... optional PDF": a speaker trailing off, not a sentence end.
const ELLIPSIS = /\.{2,}|…/g;
// After one, a capital (other than "I") says the speaker started a new sentence.
const ends = (between, next = '') => /[.!?]/.test(between.replace(ELLIPSIS, '')) ||
  (/\.{2,}|…/.test(between) && /^\p{Lu}/u.test(next) && !/^I(?![\p{L}])/u.test(next));
/** `text` with a capital first letter, unless its first word is cased on purpose ("iPhone"). */
const upper = (text) => (/^\p{Ll}[\p{Ll}'’-]*(?![\p{L}])/u.test(text) ? text[0].toUpperCase() + text.slice(1) : text);
// Fillers a piece may lose at a cut without losing anything.
const FILLER = new Set('um uh er ah yeah yep okay ok so well like oh right actually basically anyway'.split(' '));

/** The same word, or one the seam wrote a little otherwise ("looked" / "look", "an" / "a" not). */
function loose(x, y) {
  if (same(x, y)) return true;
  const n = Math.min(x.length, y.length);
  if (n >= 3 && (x.startsWith(y) || y.startsWith(x)) && Math.abs(x.length - y.length) <= 3) return true;
  return n >= 4 && editDistance(x, y) <= 1;
}

/**
 * Is every word the seam would take out of the pieces accounted for -- found again in what the
 * seam puts there, or next to the junction in either piece (a doubled word)? A filler may go, and
 * so may one word a piece ended on (the model finishing a phrase the cut left open: "extremely
 * high."). Anything else lost, and the pieces' text is kept ("…update its model. What I mean is"
 * once went because a short seam skipped it).
 */
function accounted(A, anchorA, B, anchorB, S) {
  const pool = [
    ...S.slice(anchorA.j + 1, anchorB.j),
    ...A.slice(Math.max(0, anchorA.x - 7), anchorA.x + 1),
    ...B.slice(anchorB.x, anchorB.x + 8)
  ].map((t) => t.w);
  const lost = (words) => words.filter((t) => !FILLER.has(t.w) && !pool.some((w) => loose(t.w, w)));
  const aDropped = A.slice(anchorA.x + 1), bDropped = B.slice(0, anchorB.x);
  const aLost = lost(aDropped), bLost = lost(bDropped);
  return bLost.length === 0 && (aLost.length === 0 || (aDropped.length <= 1 && aLost.length === 1));
}

/** `word` with `model`'s first-letter case -- never lower-casing a name, never "AMD", "iPhone" or "I". */
const casedFrom = (word, model) => {
  if (!model || !loose(word.toLowerCase(), model.toLowerCase())) return word;
  if (word.length > 1 && word.slice(1) !== word.slice(1).toLowerCase()) return word;
  if (word === 'I' || /^I['’]/.test(word)) return word;
  // The seam's own spelling of the word decides; a word it wrote otherwise only lends its capital.
  if (word.toLowerCase() !== model.toLowerCase() && capital(word) && !capital(model) && !ordinary(word.toLowerCase())) return word;
  return (capital(model) ? word[0].toUpperCase() : word[0].toLowerCase()) + word.slice(1);
};
const casedLike = (word, model) => {
  if (!model || word.toLowerCase() !== model.toLowerCase()) return word;
  // Only the first letter's case: "AMD", "iPhone" and the like keep their own.
  if (word.length > 1 && word.slice(1) !== word.slice(1).toLowerCase()) return word;
  return (capital(model) ? word[0].toUpperCase() : word[0].toLowerCase()) + word.slice(1);
};

/**
 * Join two pieces' text through the seam's: the model's text for the speech either side of the
 * cut, `at` being where the cut falls in it (0-1).
 *
 * The edges of a piece are where the model goes wrong: it treats them as the edges of sentences,
 * so it finishes an open phrase at the end of one ("extremely high." for "extremely [pause]
 * crucial") and repeats or drops words at the start of the next ("mistaken. Mistaken, AMD").
 * The seam heard those words in the middle. So the last words of `a` and the first words of `b`
 * are lined up with the seam -- two words in a row on each side, the nearest to the cut -- and
 * what lies between the two anchors is the seam's: its words (a word the pieces invented goes, a
 * word they both wrote appears once, a word neither wrote comes back) and its punctuation and
 * case. With no words to replace that is just the punctuation: a sentence that ends at the cut
 * starts a paragraph, as the pieces' own breaks do; one that runs on loses the full stop the
 * model put at the cut and its next word takes the seam's case.
 *
 * The pieces' own words come first (measured on the user's 15 long dictations, 2026-10-17): the
 * anchors grow over words the seam wrote a little otherwise; a word is taken out of a piece only
 * if it is accounted for -- written again by the seam, or doubled across the cut -- or is a filler,
 * or is the one word a piece ended on; a restart the pieces left out ("I'm not, and") is not put
 * back; a question or exclamation a piece ended on stays. At most MAX_DROP words of either piece
 * are replaced and MAX_BRIDGE supplied; nothing across a line break or a list marker, nothing
 * next to a number. Every word of the result is a word of a piece or of the seam (bench/long.js).
 * When the seam cannot be lined up, see fallback(). Returns {text, how}.
 */
function stitch(a, b, seam, at = 0.5) {
  if (!a) return { text: b || '', how: 'first' };
  if (!b || !b.trim()) return { text: a, how: 'empty' };
  a = a.trimEnd();
  b = b.trimStart();
  // A piece that ended in a list item: the next piece is not written into it (the model formats
  // each piece on its own); it starts on a new line, or a new paragraph unless it is an item too.
  const lastLine = a.slice(a.lastIndexOf('\n') + 1);
  if (/^\s*(?:[-*•]|\d{1,2}[.)])\s/.test(lastLine) && a.includes('\n')) {
    return { text: a + (/^\s*(?:[-*•]|\d{1,2}[.)])\s/.test(b) ? '\n' : '\n\n') + b, how: 'list' };
  }
  if (!seam || !seam.trim()) return fallback(a, b, 'no seam');

  // Only the edges matter; keep the work small on a long dictation.
  const aOff = Math.max(0, a.length - 600);
  const A = toks(a.slice(aOff)).map((t) => ({ ...t, i: t.i + aOff, end: t.end + aOff }));
  const B = toks(b.slice(0, 600));
  const S = toks(seam);
  if (A.length < 2 || B.length < 2 || S.length < 3) return fallback(a, b, 'short');
  const cut = at * seam.length, slack = 0.35 * seam.length + 20;

  // a's anchor: the last pair of its words found in the seam before the cut (nearest the cut).
  let anchorA = null;
  for (let r = 0; r <= MAX_DROP && !anchorA; r++) {
    const x = A.length - 2 - r;
    if (x < 0) break;
    let best = null;
    for (let j = 0; j + 1 < S.length; j++) {
      if (S[j + 1].end > cut + slack) break;
      if (pairAt(A, x, S, j) && (!best || Math.abs(S[j + 1].end - cut) < Math.abs(S[best + 1].end - cut))) best = j;
    }
    if (best !== null) anchorA = { x: x + 1, j: best + 1, dropped: r };   // last anchored word of a, of the seam
  }

  // b's anchor: its first pair found in the seam after a's anchor (or after the cut).
  let anchorB = null;
  for (let q = 0; q <= MAX_DROP && !anchorB; q++) {
    if (q + 1 >= B.length) break;
    for (let j = anchorA ? anchorA.j + 1 : 0; j + 1 < S.length; j++) {
      if (!anchorA && S[j].i < cut - slack) continue;
      if (pairAt(B, q, S, j)) { anchorB = { x: q, j, dropped: q }; break; }
    }
  }

  const lineBreakIn = (s) => /\n/.test(s) || /^\s*(?:[-*•]|\d{1,2}[.)])\s/m.test(s);

  if (anchorA && anchorB) {
    // The pieces' own words first: an anchor grows over words the seam wrote alike ("looked" /
    // "look"), so the seam replaces only what is really missing, doubled or invented.
    while (anchorA.x + 1 < A.length && anchorA.j + 1 < anchorB.j && loose(A[anchorA.x + 1].w, S[anchorA.j + 1].w)) {
      anchorA = { x: anchorA.x + 1, j: anchorA.j + 1, dropped: anchorA.dropped - 1 };
    }
    while (anchorB.x > 0 && anchorB.j - 1 > anchorA.j && loose(B[anchorB.x - 1].w, S[anchorB.j - 1].w)) {
      anchorB = { x: anchorB.x - 1, j: anchorB.j - 1, dropped: anchorB.dropped - 1 };
    }
  }

  // Light words the seam has between two pieces that dropped nothing: a single "and" the second
  // piece left off as an opener comes back; two or more ("I'm not, and") are a restart the
  // pieces rightly left out.
  const bridgeWords = anchorA && anchorB ? S.slice(anchorA.j + 1, anchorB.j) : [];
  const fragment = anchorA && anchorB && !anchorA.dropped && !anchorB.dropped && bridgeWords.length >= 2 &&
    bridgeWords.every((t) => LIGHT.has(t.w) || FILLER.has(t.w) || /^(i'm|it's|that's|we're|you're|they're|i've|don't|didn't)$/.test(t.w));

  if (anchorA && anchorB && !fragment && anchorB.j - anchorA.j - 1 <= MAX_BRIDGE && accounted(A, anchorA, B, anchorB, S)) {
    const aKeepEnd = A[anchorA.x].end;
    const aDropped = a.slice(aKeepEnd);
    // b's opening up to its anchor -- with anything before its first word (a quote, a marker).
    const bDropped = b.slice(0, B[anchorB.x].i) + (B[0].i > 0 ? '\n' : '');
    const closer = /["”’)\]]/.test(aDropped);
    // Numbers, amounts, addresses: the seam may write them otherwise ("$300" / "300 dollars");
    // what a piece wrote of them, or next to them, is never replaced. ("R&D" is a word.)
    const near = a.slice(A[Math.max(0, anchorA.x - 2)].i, aKeepEnd) + b.slice(B[anchorB.x].i, B[Math.min(B.length - 1, anchorB.x + 2)].end);
    const exact = /[\d$€£%@#/]/.test(aDropped + bDropped + near) ||
      (anchorA.dropped + anchorB.dropped > 0 && /\d/.test(seam.slice(S[Math.max(0, anchorA.j - 2)].i, S[Math.min(S.length - 1, anchorB.j + 2)].end)));
    if (!lineBreakIn(aDropped) && !lineBreakIn(bDropped) && !closer && !exact) {
      let mid = seam.slice(S[anchorA.j].end, S[anchorB.j].i).replace(/\s+/g, ' ');
      let rest = b.slice(B[anchorB.x].i);
      rest = casedFrom(B[anchorB.x].raw, S[anchorB.j].raw) + rest.slice(B[anchorB.x].raw.length);
      const bridged = anchorB.j - anchorA.j - 1;
      const edits = anchorA.dropped + anchorB.dropped + bridged;
      let sentenceEnd = ends(mid, S[anchorB.j].raw);
      // A question or an exclamation the piece ended on is the model's choice, not the cut's full
      // stop: it stays ("should we launch this early? With this raw...").
      const asked = !anchorA.dropped && /^[?!]/.test(aDropped);
      if (!edits && sentenceEnd && /[.!?:]$/.test(a)) {
        // A sentence that ends at the cut ended the piece too: a new paragraph, as before.
        return { text: a + '\n\n' + rest, how: 'seam: paragraph' };
      }
      if (!bridged) {
        // Nothing between the anchors but punctuation: a sentence end, or the seam's comma, or a space.
        let mark = sentenceEnd ? (/[.!?]/.exec(mid.replace(ELLIPSIS, '')) || ['.']) : /[,;:—–]/.exec(mid.replace(ELLIPSIS, ''));
        if (asked) { mark = [aDropped[0]]; sentenceEnd = true; }
        mid = mark ? mark[0] + ' ' : ' ';
        if (sentenceEnd) rest = upper(rest);
      } else if (!/\s$/.test(mid)) {
        mid += ' ';
      }
      if (!/^[\s,;:.!?—–]/.test(mid)) mid = ' ' + mid;
      return { text: a.slice(0, aKeepEnd) + mid + rest, how: edits ? `seam: ${anchorA.dropped}/${bridged}/${anchorB.dropped}` : 'seam' };
    }
  }

  // Only one side lines up, at the very edge: the seam still says what happens at the cut.
  if (anchorA && anchorA.dropped === 0 && anchorA.j + 1 < S.length && same(S[anchorA.j + 1].w, B[0].w) && !/["”’)\]]$/.test(a)) {
    const mid = seam.slice(S[anchorA.j].end, S[anchorA.j + 1].i);
    return join(a, b, ends(mid, S[anchorA.j + 1].raw), S[anchorA.j + 1].raw, 'seam: a side');
  }
  if (anchorB && anchorB.dropped === 0 && anchorB.j > 0 && same(S[anchorB.j - 1].w, A[A.length - 1].w)) {
    const mid = seam.slice(S[anchorB.j - 1].end, S[anchorB.j].i);
    return join(a, b, ends(mid, S[anchorB.j].raw), S[anchorB.j].raw, 'seam: b side');
  }
  // The old reading: the last one to three words of a, wherever the seam has them nearest the cut.
  const read = readSeam(a, seam, at);
  if (read && B.length) {
    const nextIsB = same(read.next.toLowerCase(), B[0].w);
    return join(a, b, read.sentenceEnd, nextIsB ? read.next : null, 'seam: tail');
  }
  return fallback(a, b, 'unread');
}

/** a and b with a sentence end between them or not; the next word in `next`'s case when given. */
function join(a, b, sentenceEnd, next, how) {
  const ended = /[.!?:]$/.test(a);
  const first = /^[\p{L}][\p{L}'’-]*/u.exec(b);
  if (sentenceEnd) {
    if (ended) return { text: a + '\n\n' + b, how: how + ', paragraph' };
    if (first && !capital(first[0])) b = first[0][0].toUpperCase() + b.slice(1);
    return { text: a.replace(/[,;]$/, '') + '. ' + b, how };
  }
  // A question or exclamation the piece ended on stays, and what follows starts a sentence.
  if (/[?!]$/.test(a)) return { text: a + ' ' + upper(b), how: how + ', kept ' + a.slice(-1) };
  if (/[^.]\.$/.test(a)) a = a.slice(0, -1);
  if (first && next) b = casedFrom(first[0], next) + b.slice(first[0].length);
  // The sentence runs on but the seam does not say how the next word is written: an ordinary word
  // the model capitalised only because its piece began there loses the capital ("R&D That").
  else if (first && capital(first[0]) && first[0] !== 'I' && !/^I['’]/.test(first[0]) &&
    first[0].slice(1) === first[0].slice(1).toLowerCase() && ordinary(first[0].toLowerCase())) {
    b = first[0].toLowerCase() + b.slice(first[0].length);
  }
  return { text: a + ' ' + b, how };
}

// Words a sentence does not end on: after one of these the text runs on.
const RUNS_ON = new Set(('a an the and or but nor to of in on at by for with from into onto about as than ' +
  'not no my your our their his her its this these those that which who whose whom ' +
  'is are was were be been being am will would should could can may might must shall do does did ' +
  'have has had very so such some any every each more most less few many much own same quite rather ' +
  'like just also even only really whether if because although though while when where until unless ' +
  'let\'s i\'m we\'re you\'re they\'re it\'s i\'ve we\'ve going gonna want wanna need').split(' '));

let COMMON = null;
function common(w) {
  if (!COMMON) {
    try {
      COMMON = new Set(require('fs').readFileSync(require('path').join(__dirname, '..', 'common-words.txt'), 'utf8').split(/\r?\n/).filter(Boolean));
    } catch {
      COMMON = new Set();
    }
  }
  return COMMON.has(w);
}

// Common words that are capitalised wherever they stand.
const PROPER = new Set(('monday tuesday wednesday thursday friday saturday sunday january february march april may june ' +
  'july august september october november december english turkish german french spanish american european british ' +
  'christmas easter google microsoft apple amazon facebook twitter youtube windows linux android iphone mac ' +
  'john david michael james paul mark peter george').split(' '));

/** An ordinary word, by the common list, or one built from an ordinary word ("overuse", "quickly"). */
function ordinary(w) {
  if (PROPER.has(w)) return false;
  if (common(w)) return true;
  const pre = /^(over|under|re|un|dis|pre|mis|out|up|non|co)(.{3,})$/.exec(w);
  if (pre && common(pre[2])) return true;
  const suf = /^(.{3,}?)(ly|ing|ed|s|es|er|tion|ness|ment|able|ible|ous|ive|ful|less|al)$/.exec(w);
  return Boolean(suf && (common(suf[1]) || common(suf[1] + 'e')));
}

/**
 * No seam to read. Before 0.2.3 this was a + ' ' + b, which left "R&D That might" and "should
 * not Overuse" at a third of the cuts. Now: a piece that ended a sentence keeps its end and the
 * next starts with a capital; a piece that stopped on a word a sentence cannot end on ("the",
 * "not", "and") runs on, and a common word after it loses the capital the model gave it as a
 * sentence start; any other unpunctuated end before a capital is a sentence end.
 */
function fallback(a, b, why) {
  const ended = /[.!?:]["”’)\]]*$/.test(a);
  const first = /^[\p{L}][\p{L}'’-]*/u.exec(b);
  if (!first) return { text: a + ' ' + b, how: 'fallback: ' + why };
  const word = first[0];
  if (ended) {
    // A piece the model began in lower case is, to the model, the same sentence going on: the
    // full stop at the cut was the cut's ("is astronomical. is relatively" -> one sentence). After
    // a question or an exclamation, a capital.
    if (/[^.]\.$/.test(a) && !/\.\.$/.test(a) && /^\p{Ll}/u.test(word) && word === word.toLowerCase()) {
      return { text: a.slice(0, -1) + ' ' + b, how: 'fallback: ' + why + ', runs on' };
    }
    if (!capital(word) && word === word.toLowerCase()) b = word[0].toUpperCase() + b.slice(1);
    return { text: a + ' ' + b, how: 'fallback: ' + why };
  }
  if (!capital(word) || /[,;—–-]$/.test(a)) return { text: a + ' ' + b, how: 'fallback: ' + why };
  const lastA = (a.match(/[\p{L}\p{N}'’]+$/u) || [''])[0].toLowerCase().replace(/’/g, "'");
  const lower = word.toLowerCase();
  const nameLike = word !== word[0] + word.slice(1).toLowerCase() || word === 'I' || /^I['’]/.test(word);
  if (RUNS_ON.has(lastA)) {
    if (!nameLike && ordinary(lower)) b = lower + b.slice(word.length);
    return { text: a + ' ' + b, how: 'fallback: ' + why + ', runs on' };
  }
  // A name may follow anything ("we should ask Kerem"); an ordinary word with a capital, or "I",
  // after a word a sentence can end on, starts a sentence ("doing R&D That might").
  const iWord = word === 'I' || /^I['’]/.test(word);
  if (!iWord && (nameLike || !ordinary(lower))) return { text: a + ' ' + b, how: 'fallback: ' + why + ', a name' };
  return { text: a + '. ' + b, how: 'fallback: ' + why + ', sentence end' };
}

/**
 * How the text runs across a cut, read from `seam` (0.2.2's reading, kept as stitch()'s last
 * attempt): finds the last words before the cut (the end of `a`) in the seam and returns what
 * follows them there -- a sentence end or not, and the next word as the model wrote it in
 * context -- or null when the seam cannot be lined up. `at` is where the cut falls in the seam's
 * audio (0-1); a match near that share of the text wins. The seam's first word may be a word cut
 * in half ("WTH" for "RWTH").
 */
function readSeam(a, seam, at = 0.5) {
  const words = (s) => [...s.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)]
    .map((m) => ({ w: m[0].toLowerCase(), raw: m[0], i: m.index, end: m.index + m[0].length }));
  const S = words(seam), A = words(a.slice(-600));
  const sameW = (x, y, j) => x === y || (j === 0 && y.length >= 2 && x.endsWith(y));
  for (const k of [3, 2, 1]) {
    if (A.length < k || (k === 1 && A[A.length - 1].w.length < 4)) continue;
    const tail = A.slice(-k);
    let best = null;
    for (let j = 0; j + k < S.length; j++) {
      if (!tail.every((x, q) => sameW(x.w, S[j + q].w, j + q))) continue;
      const d = Math.abs(S[j + k - 1].end - seam.length * at);
      if (!best || d < best.d) best = { d, end: S[j + k - 1].end, next: S[j + k] };
    }
    if (best) return { sentenceEnd: /[.!?]/.test(seam.slice(best.end, best.next.i)), next: best.next.raw };
  }
  return null;
}

/** 0.2.2's join, given readSeam's answer (kept for local.js's exports and the joins regression). */
function joinPieces(a, b, seam) {
  if (!a) return b;
  if (!b) return a;
  a = a.trimEnd();
  b = b.trimStart();
  const ended = /[.!?:]$/.test(a);
  if (!seam) return a + ' ' + b;
  if (seam.sentenceEnd) return ended ? a + '\n\n' + b : a.replace(/[,;]$/, '') + '. ' + b;
  if (/[^.]\.$/.test(a)) a = a.slice(0, -1);
  const first = /^[\p{L}][\p{L}'’-]*/u.exec(b);
  if (first && first[0].toLowerCase() === seam.next.toLowerCase()) b = seam.next + b.slice(first[0].length);
  return a + ' ' + b;
}

module.exports = {
  LONG_S, PIECE_MIN_S, PIECE_MAX_S, FRAME_S, SEAM_S, KEEP_S, LOOKAHEAD_S,
  Splitter, splitLong, seamAudio, seamAt, stitch, fallback, readSeam, joinPieces
};
