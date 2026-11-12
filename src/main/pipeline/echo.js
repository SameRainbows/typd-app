'use strict';

/**
 * The dictionary line written out as if it had been said.
 *
 * The prompt's last line of visible text is the dictionary line (context.js): the user's terms and,
 * since 0.2.13, the names learned from use -- some 45 of them. On the founder's replay
 * (dictation-research reports/names_learning_2026-10-31.md) a 2-second "80 gigabytes of VRAM" came
 * back as 46 words: a sentence from the screen, then "...on modal for Jards, Kaggle, TPU, LLM, ASI,
 * OpenWhispr, Lightning AI, GGUF, ...". The same failure was seen live with silence ("the dictionary
 * pasted on silence", reports/model_data.md).
 *
 * Two signs, either enough:
 *   - three or more of the line's terms in a row, between commas: the line copied;
 *   - more words than anyone says in that time (5 a second, plus 12).
 * local.js then writes the recording once more without the line and choose() keeps one: the first
 * when the second has the same names (the user said the list), else the second if it is sound,
 * otherwise the first cut where the copied line began.
 */

const WORDS_PER_S = 5;
const SLACK = 12;

/** The dictionary line of a prompt: its terms, or null when the prompt has none. */
function lineOf(system) {
  const m = /\n([^\n]*)\n<\/visible_text>/.exec(String(system || ''));
  if (!m) return null;
  const items = m[1].split(', ').map((s) => s.trim()).filter(Boolean);
  // a list, not a sentence of the screen: short items, no sentence punctuation
  if (items.length < 3 || !items.every((s) => s.length <= 40 && s.split(/\s+/).length <= 4 && !/[.!?:]$/.test(s))) return null;
  return { line: m[1], items };
}

/** The same prompt without its dictionary line. */
function withoutLine(system) {
  const found = lineOf(system);
  if (!found) return system;
  return String(system).replace('\n' + found.line + '\n</visible_text>', '\n</visible_text>')
    // nothing left of the visible text: drop the block, as context.js does when there is none
    .replace(/<visible_text[^>]*>\n<\/visible_text>\n?/, '');
}

/**
 * Where `text` starts copying the line, or -1: three of its terms in a row in the line's own order,
 * or four in any order, between commas. A user's own list ("Kaggle, Colab and Modal") is neither.
 */
function echoAt(text, items) {
  const run = echoRun(text, items);
  return run ? run.at : -1;
}

/** The copied run: {at, terms} -- the line's terms written one after another from `at` -- or null. */
function echoRun(text, items) {
  if (!text || !items || items.length < 3) return null;
  const pos = new Map(items.map((s, i) => [s.toLowerCase(), i]));
  const segs = [];
  const re = /[^,\n]+/g;
  let m;
  while ((m = re.exec(text))) segs.push({ s: m[0].trim().replace(/[.;:!?]+$/, '').toLowerCase(), at: m.index + (m[0].length - m[0].trimStart().length) });
  for (let i = 0; i + 2 < segs.length; i++) {
    // the run may start inside a clause: "on modal for Jards, Kaggle, TPU" starts at "Jards"
    const lead = segs[i].s.split(/\s+/);
    for (let k = Math.min(4, lead.length); k >= 1; k--) {
      const tail = lead.slice(-k).join(' ');
      if (!pos.has(tail)) continue;
      const p0 = pos.get(tail), p1 = pos.get(segs[i + 1].s), p2 = pos.get(segs[i + 2].s);
      const inOrder = p1 === p0 + 1 && p2 === p0 + 2;
      const four = p1 !== undefined && p2 !== undefined && i + 3 < segs.length && pos.has(segs[i + 3].s);
      if (inOrder || four) {
        const idx = text.slice(segs[i].at).toLowerCase().lastIndexOf(tail);
        const terms = [items[p0]];
        for (let j = i + 1; j < segs.length && pos.has(segs[j].s); j++) terms.push(items[pos.get(segs[j].s)]);
        return { at: segs[i].at + (idx >= 0 ? idx : 0), terms };
      }
    }
  }
  return null;
}

const wordCount = (text) => (String(text || '').match(/[\p{L}\p{N}]+/gu) || []).length;

/** Is this answer suspect for this prompt and this much audio? {echo: index|-1, long: bool}, or null. */
function suspect(text, system, seconds) {
  const found = lineOf(system);
  if (!found || !text) return null;
  const echo = echoAt(text, found.items);
  const long = wordCount(text) > WORDS_PER_S * seconds + SLACK;
  return echo >= 0 || long ? { echo, long } : null;
}

/**
 * Which answer to keep, once the recording was written again without the line (`again`):
 *   - the second answer has the run's names too, as written or as sound-alikes (all but one): the list
 *     was said, not copied. The founder's "a test that will work on Typd, Wispr Flow, Typeless,
 *     SuperWhisper" came back "typed Wispr Flow, super Wispr, typeless": the first, with the listed
 *     spellings, is kept.
 *   - otherwise (his "Kaggle, Lightning AI, Modal, Typd, Tauri, Hessian.AI, Kajol, Colab, Emilia" for a
 *     said "Kaggle, Lightning AI, Modal, Deepnote") the second when it is sound, else the first cut
 *     where the copy began.
 * Returns {text, why}.
 */
function choose(first, again, system, seconds) {
  const bad = suspect(first, system, seconds);
  if (!bad) return { text: first, why: 'sound' };
  const found = lineOf(system);
  const run = bad.echo >= 0 && !bad.long ? echoRun(first, found.items) : null;
  if (again && run) {
    const { prepare, said } = require('../names');
    const prep = prepare(again);
    const missing = run.terms.filter((t) => !said(prep, t));
    if (missing.length <= 1) return { text: first, why: 'said' };
  }
  if (again && !suspect(again, system, seconds)) return { text: again, why: 'again' };
  return { text: bad.echo >= 0 ? cut(first, bad.echo) : first, why: 'cut' };
}

/** The answer cut where the copied line began, back to the last whole sentence before it. */
function cut(text, at) {
  if (at < 0) return text;
  const before = text.slice(0, at);
  const end = Math.max(before.lastIndexOf('. '), before.lastIndexOf('? '), before.lastIndexOf('! '), before.lastIndexOf('\n'));
  return (end > 0 ? before.slice(0, end + 1) : before).replace(/[\s,;:]+$/, '').trim();
}

module.exports = { lineOf, withoutLine, echoAt, echoRun, suspect, choose, cut, wordCount, WORDS_PER_S, SLACK };
