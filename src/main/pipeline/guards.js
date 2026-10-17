'use strict';

/**
 * Revise guards: what is never pasted over a selection.
 *
 * A revision is pasted straight over writing the user already has, so a bad one destroys text
 * rather than adding a wrong word. On the user's own presses (dictation-research
 * reports/dogfood_audit_2026-10-16.md) 11 of 16 revisions failed, and four ways of failing
 * repeat:
 *
 *   noop     the selection came back unchanged, or nearly ("Make it simpler" added one paragraph
 *            break to 700 characters; "Make it more formalized" changed one letter and two marks).
 *            Pasting it is harmless but says "done" when nothing was done, so he retried 2-4 times.
 *   echo     the spoken instruction came back instead of the text, pasted over all of it.
 *   deleted  "Format the stuff I listed as a list" returned the first 57 % of the selection: the
 *            rest silently gone, twice.
 *   empty    nothing came back.
 *   short    under 40 % of a selection of 20+ words, when the instruction did not ask to shorten,
 *            summarize, cut or delete (on the real model "clean up the grammar" over 1,000 words
 *            once came back as one line; results/revise_long_check.log, 2026-10-17).
 *
 * None of these is pasted. The selection stays as it was, the pill says why, and a deletion's
 * result goes to the clipboard in case it was wanted after all.
 *
 * Telling a failure from a real revision needs the instruction: "fix the typo" over 700
 * characters is rightly a one-letter change, "make it simpler" is not; "summarize" may drop half,
 * "make it a list" may not. The local model hears the instruction and never writes it down, so
 * check() first looks at the result alone, and asks for the instruction's words (one extra short
 * decode) only when the result is suspicious: about one revise in three on the audit's presses,
 * none of the good ones that changed the text substantially.
 *
 * Thresholds are tuned on the audit's 16 real presses and on eval/revise_gold.jsonl's 160
 * reference results, every one of which must pass (bench/revise-guards.js keeps the score).
 */

// Function words: what is left when they are gone is what a selection says.
const STOP = new Set((
  'a an the and or but nor so yet if then than that this these those there here it its it\'s ' +
  'i me my mine we us our you your he him his she her they them their what which who whom whose ' +
  'is are was were be been being am do does did done have has had having will would shall should ' +
  'can could may might must of to in on at by for with from about as into onto over under up down ' +
  'out off not no just very really also too only even still some any all each every both much many ' +
  'more most other such own same one ones like well oh um uh ok okay yeah yes i\'m i\'ve i\'ll i\'d ' +
  'don\'t didn\'t doesn\'t isn\'t aren\'t wasn\'t weren\'t can\'t won\'t that\'s there\'s let\'s ' +
  've ll re s t d m bir ve bu da de ile için çok ama gibi daha'
).split(/\s+/).filter(Boolean));

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;

function words(s) {
  return (String(s || '').match(WORD) || []).map((w) => w.toLowerCase().replace(/’/g, "'"));
}

function content(list) {
  const kept = list.filter((w) => !STOP.has(w) && (w.length > 1 || /\d/.test(w)));
  return kept.length ? kept : list;
}

function counts(list) {
  const m = new Map();
  for (const w of list) m.set(w, (m.get(w) || 0) + 1);
  return m;
}

/** How many words of `a` (a multiset) `b` also has. */
function shared(a, b) {
  const cb = counts(b);
  let n = 0;
  for (const w of a) {
    const c = cb.get(w) || 0;
    if (c > 0) { n++; cb.set(w, c - 1); }
  }
  return n;
}

/** Word-level edit distance (case and punctuation ignored), stopping once past `cap`. */
function wordEdits(a, b, cap = Infinity) {
  if (Math.abs(a.length - b.length) > cap) return Math.abs(a.length - b.length);
  // Strip the common head and tail first: a near-identical pair is nearly all of it.
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const A = a.slice(s, a.length - e), B = b.slice(s, b.length - e);
  if (!A.length || !B.length) return Math.max(A.length, B.length);
  if (A.length * B.length > 4e6) return Math.max(A.length, B.length);   // far apart anyway
  let prev = new Uint32Array(B.length + 1).map((_, j) => j);
  for (let i = 1; i <= A.length; i++) {
    const row = new Uint32Array(B.length + 1);
    row[0] = i;
    let low = row[0];
    for (let j = 1; j <= B.length; j++) {
      row[j] = A[i - 1] === B[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], row[j - 1]);
      if (row[j] < low) low = row[j];
    }
    if (low > cap) return low;
    prev = row;
  }
  return prev[B.length];
}

/** Line breaks and list markers: what a "make it a list" or "split the paragraph" changes. */
function layout(s) {
  const t = String(s || '');
  return {
    breaks: (t.match(/\n/g) || []).length,
    items: (t.match(/^[ \t]*(?:[-*•–]|\d{1,2}[.)])[ \t]+/gm) || []).length
  };
}

/*
 * What an instruction asks for, by its words. English plus the Turkish the user speaks.
 *   shorten  the whole text, shorter: may drop a lot, must change something
 *   delete   one part removed ("take out the gym one"): may drop a lot, may be tiny
 *   rewrite  the whole text, worded otherwise: must change something, may not drop half
 *   layout   lists, paragraphs, formatting: must change words or layout, may not drop text
 *   targeted one thing fixed or renamed: may be tiny, may not drop text
 *   other    anything else, judged by the result alone (only gross losses are refused)
 */
const KINDS = [
  ['translate', /\b(translat\w*|in (english|turkish|german|french|spanish)|to (english|turkish|german|french|spanish)|(ingilizce|türkçe|almanca)\w*|çevir\w*)\b/iu],
  // Into another form: a table, code, a poem. Words go and come; the result is judged as-is.
  ['transform', /\b(tables?|spreadsheet|csv|json|yaml|xml|sql|regex|code|comprehension|function|script|screenplay|poem|haiku|rhym\w*|tweet|tablo\w*)\b/iu],
  ['shorten', /\b(short\w*|summar\w*|sum (it|this|that) up|tl;?dr|gist|brief\w*|concise\w*|compact\w*|condens\w*|tighten\w*|trim\w*|cut (it|this|that) down|cut down|less wordy|fewer words|wordy|too long|headline|kısalt\w*|özetle\w*|özet)\b/iu],
  ['delete', /\b(delet\w*|remov\w*|get rid|take (it |them |that |this )?out|drop\w*|eras\w*|omit\w*|strip\w*|cut (out|the)|without the|lose the|keep (it|them|that|this) once|keep only|only keep|just keep|dedup\w*|duplicat\w*|repeat\w*|redundan\w*|sil\w*|kaldır\w*|çıkar\w*)\b/iu],
  ['layout', /\b(list\w*|bullet\w*|numbered|number them|format\w*|paragraph\w*|one (sentence|line)|join\w*|merge\w*|split\w*|line breaks?|new lines?|indent\w*|columns?|headings?|title case|all caps|caps|capitali[sz]\w*|uppercase|lowercase|liste\w*|madde\w*|paragraf\w*)\b/iu],
  ['rewrite', /\b(simpl\w*|easier|clean\w* (it|this|that|them)? ?up|clean up|cleanup|rewrit\w*|rephras\w*|reword\w*|improv\w*|better|polish\w*|clear\w*|clarif\w*|understandable|readab\w*|fluent\w*|flow\w*|formal\w*|informal\w*|casual\w*|polite\w*|friendl\w*|professional\w*|tone|nicer|warmer|firmer|softer|stronger|confident\w*|sound\w*|natural\w*|filler\w*|edit (it|this)|fix (it|this) up|make sense|sadeleştir\w*|düzenle\w*|resmi\w*|toparla\w*)\b/iu],
  ['targeted', /\b(fix\w*|typo\w*|spell\w*|grammar\w*|punctuat\w*|comma\w*|period\w*|full stop|apostroph\w*|quot\w*|renam\w*|replac\w*|chang\w*|swap\w*|instead|add\w*|insert\w*|put|move\w*|correct\w*|düzelt\w*|değiştir\w*|ekle\w*)\b/iu]
];

// An instruction about one part ("the first line", "only the last sentence", "the gym one") asks
// for a small change, however general its verb.
const SCOPED = /\b(first|last|second|third|fourth|final|opening|closing|top|bottom|middle|next|previous)\s+(\w+\s+)?(line|sentence|paragraph|word|part|bit|bullet|item|point|one|step|name)s?\b|\b(only|just)\s+the\b|\bthe (part|bit|one|line|sentence|word)s? (about|with|where|that)\b|\bwhere it says\b/iu;

function kindOf(instruction) {
  const t = String(instruction || '');
  if (!t.trim()) return null;
  const hits = [];
  for (const [kind, re] of KINDS) {
    const m = re.exec(t);
    if (m) hits.push({ kind, at: m.index });
  }
  if (!hits.length) return SCOPED.test(t) ? 'targeted' : 'other';
  for (const k of ['translate', 'transform']) if (hits.some((h) => h.kind === k)) return k;
  // "Cut the part about X" is a deletion and "shorten the intro" a shortening: whichever of the
  // two comes first in the sentence.
  const cut = hits.filter((h) => h.kind === 'shorten' || h.kind === 'delete').sort((a, b) => a.at - b.at);
  if (cut.length) return cut[0].kind;
  if (SCOPED.test(t)) return 'targeted';
  for (const k of ['layout', 'rewrite', 'targeted']) if (hits.some((h) => h.kind === k)) return k;
  return 'other';
}

/** The numbers check() and verdict() decide on. */
function measure(span, out) {
  const sw = words(span), ow = words(out);
  const sc = content(sw), oc = content(ow);
  const keep = shared(sc, oc);
  return {
    spanWords: sw.length,
    outWords: ow.length,
    recall: sc.length ? keep / sc.length : 1,          // how much of the selection's content is still there
    precision: oc.length ? shared(oc, sc) / oc.length : 1,   // how much of the result came from the selection
    ratio: sw.length ? ow.length / sw.length : 1,
    chars: span.length ? out.length / span.length : 1,   // the result's length against the selection's
    sw, ow
  };
}

// Tuned on the audit's real presses and revise_gold (bench/revise-guards.js).
const NEAR_SHARE = 0.02;      // "near-identical": at most 2 % of the words changed (at least 1)
const LOST_LAYOUT = 0.3;      // layout / targeted: more than 30 % of the content gone is a deletion
const LOST_REWRITE = 0.5;     // rewrite: more than half gone, and nothing new in its place
const LOST_OTHER = 0.55;      // unknown instruction: only gross losses
const MIN_DELETION_WORDS = 20;   // the deletion guard judges selections of 20 words and more
// Under 40 % of the selection's length is a shortening, and only an instruction to shorten,
// summarize, cut or delete asks for one. On the real model (results/revise_long_check.log,
// 2026-10-17) "clean up the grammar" over 1,000 and 1,800 words came back as a few words
// (0.3-0.6 % of the length) and was pasted.
const MIN_SHARE = 0.4;
const MIN_SHARE_WORDS = 20;      // a sentence or two may rightly shrink ("make me sound more confident": 19 words to 6 in revise_gold)

const MESSAGES = {
  empty: "Couldn't revise that — text kept",
  noop: "Couldn't revise that — nothing changed",
  echo: "Couldn't revise that — text kept",
  deleted: 'Revise dropped text — kept yours, result copied',
  short: "Couldn't revise that — text kept",
  truncated: 'Too long to revise — text kept'
};

/**
 * The result alone: refuse now, pass now, or ask for the instruction first.
 * @returns {{verdict: 'refuse'|'pass'|'ask', reason?: string}}
 */
function check(span, out) {
  const s = String(span || '').trim(), o = String(out || '').trim();
  if (!o) return { verdict: 'refuse', reason: 'empty' };
  if (o.replace(/\r\n?/g, '\n') === s.replace(/\r\n?/g, '\n')) return { verdict: 'refuse', reason: 'noop' };
  const m = measure(s, o);
  const near = wordEdits(m.sw, m.ow, Math.max(1, Math.round(NEAR_SHARE * m.spanWords)) + 1) <= Math.max(1, Math.round(NEAR_SHARE * m.spanWords));
  if (near && m.spanWords >= 8) return { verdict: 'ask', reason: 'near' };
  if (m.chars < MIN_SHARE && m.spanWords >= MIN_SHARE_WORDS) return { verdict: 'ask', reason: 'short' };
  // Shorter, with much of the selection gone: a cut (what is left came from the selection) or an
  // echo (far shorter). A rewrite in other words of about the same length is neither.
  if (1 - m.recall > LOST_LAYOUT && m.ratio < 0.85 && (m.precision >= 0.7 || m.ratio < 0.5)) return { verdict: 'ask', reason: 'shrunk' };
  return { verdict: 'pass' };
}

/**
 * The full decision, given the instruction's words (null when they could not be had: then only
 * what check() can settle alone is refused).
 * @returns {{refuse: boolean, reason?: string, kind?: string|null, metrics: object}}
 */
function verdict(span, out, instruction) {
  const s = String(span || '').trim(), o = String(out || '').trim();
  const first = check(s, o);
  const m = o ? measure(s, o) : null;
  const metrics = m ? { spanWords: m.spanWords, outWords: m.outWords, recall: round(m.recall), precision: round(m.precision), ratio: round(m.ratio), chars: round(m.chars) } : {};
  if (first.verdict === 'refuse') return { refuse: true, reason: first.reason, kind: kindOf(instruction), metrics };
  if (first.verdict === 'pass') return { refuse: false, kind: kindOf(instruction), metrics };
  const kind = kindOf(instruction);
  // Far shorter than the selection: only an instruction that asks to shorten or delete may do that.
  // Unheard, it is not known to have asked.
  const tooShort = first.reason === 'short' && kind !== 'shorten' && kind !== 'delete';
  if (!kind) return tooShort ? { refuse: true, reason: 'short', kind, metrics } : { refuse: false, kind, metrics };

  if (first.reason === 'near') {
    // Changed almost nothing. Fine for a fix or a rename; a no-op for "make it simpler".
    const lay = layout(s), lay2 = layout(o);
    const layoutChanged = lay.breaks !== lay2.breaks || lay.items !== lay2.items;
    if (kind === 'rewrite' || kind === 'shorten') return { refuse: true, reason: 'noop', kind, metrics };
    if (kind === 'layout' && !layoutChanged && m.ow.join(' ') === m.sw.join(' ')) {
      // Same words, same lines: nothing a layout instruction asks for happened (case or marks
      // alone are a layout change only for title case / caps, which change the words' case).
      const caseOnly = o.toLowerCase() !== o && s !== o && s.toLowerCase() === o.toLowerCase();
      if (!caseOnly) return { refuse: true, reason: 'noop', kind, metrics };
    }
    return { refuse: false, kind, metrics };
  }

  // Much of the selection's content is gone.
  const iw = content(words(instruction));
  const oc = content(m.ow);
  if (iw.length >= 3 && oc.length) {
    const fromInstruction = shared(oc, iw) / oc.length;
    const covers = shared(iw, oc) / iw.length;
    if (fromInstruction >= 0.7 && covers >= 0.6 && m.recall < 0.5) return { refuse: true, reason: 'echo', kind, metrics };
  }
  if (tooShort) return { refuse: true, reason: 'short', kind, metrics };
  const lost = 1 - m.recall;
  if (kind === 'shorten' || kind === 'delete' || kind === 'translate' || kind === 'transform') return { refuse: false, kind, metrics };
  // A sentence or two: too few words to tell a deletion from a rewording, and little to lose.
  if (m.spanWords < MIN_DELETION_WORDS) return { refuse: false, kind, metrics };
  if ((kind === 'layout' || kind === 'targeted') && lost > LOST_LAYOUT) return { refuse: true, reason: 'deleted', kind, metrics };
  if (kind === 'rewrite' && lost > LOST_REWRITE && m.precision >= 0.8) return { refuse: true, reason: 'deleted', kind, metrics };
  if (kind === 'other' && lost > LOST_OTHER && m.precision >= 0.85 && m.ratio < 0.6) return { refuse: true, reason: 'deleted', kind, metrics };
  return { refuse: false, kind, metrics };
}

const round = (x) => Math.round(x * 1000) / 1000;

module.exports = { check, verdict, kindOf, measure, words, wordEdits, MESSAGES };
