'use strict';

/**
 * The dictionary's terms are a hint, not an order.
 *
 * The user's dictionary goes into the prompt as one line of terms (context.js), and the model
 * spells what it hears by it: "whisper flow" becomes "Wispr Flow", "typed" becomes "Typd". But the
 * same hint pulls in a term where something else was said: "the release for Kerem" came out "the
 * release for Aysel" -- Aysel is in his dictionary, Kerem is not (dictation-research
 * reports/dogfood_audit_2026-10-16.md, worst example 4). Nothing in the text says so; the model
 * does: asked what it would have written there had the term been barred, it writes "Kerem".
 *
 * So for each dictionary term in a dictation (local.js checkTerms, two one-line requests that reuse
 * the dictation's cached prompt): how sure was the model of the term's first token, and what
 * would it have written instead? The term stays when the model was sure of it, when the other
 * word is how this term is misheard (its "heard as", or alike in spelling or sound, as learn.js
 * judges a correction), or when the other word is not a word taking the term's place. It goes
 * only when the model was unsure and the other word is a different, real word or name in the same
 * slot: what the hint replaced.
 */

const learn = require('../learn');

const MAX_CHECKS = 3;      // terms checked per piece of text, the first ones
const SURE = 0.95;         // the model's own probability of the term's first token, above which it stays

// Words that are not a word taking a term's place ("for Aysel ready" -> "for a ready").
const FUNCTION = new Set(('a an the and or but so to of in on at by for with from as is are was were be been it its ' +
  'i you we they he she that this these those there here what which who not no do does did have has had ' +
  'my your our their his her me us them if then than just very will would can could should').split(' '));

function entries() {
  try {
    const { VOCAB_FILE } = require('./context');
    const list = JSON.parse(require('fs').readFileSync(VOCAB_FILE, 'utf8'));
    return Array.isArray(list) ? list.filter((e) => e && typeof e.term === 'string' && e.term.trim()) : [];
  } catch {
    return [];
  }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plain = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ı/g, 'i').replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Dictionary terms in `text` that the prompt `system` showed the model: [{term, heardAs, index,
 * length}], in order, at most MAX_CHECKS. None without a prompt that lists them.
 */
function suspects(text, system, list = null) {
  if (!text || !system || !/<visible_text/.test(system)) return [];
  const found = [];
  for (const e of list || entries()) {
    const term = e.term.trim();
    if (term.length < 3 || /\d/.test(term) || !system.includes(term)) continue;
    const re = new RegExp('(?<![\\p{L}\\p{N}])' + esc(term) + '(?![\\p{L}\\p{N}])', 'giu');
    for (const m of text.matchAll(re)) {
      found.push({ term, heardAs: Array.isArray(e.heardAs) ? e.heardAs.map(String) : [], index: m.index, length: m[0].length });
    }
  }
  return found.sort((a, b) => a.index - b.index).slice(0, MAX_CHECKS);
}

function alike(a, b) {
  const x = plain(a), y = plain(b);
  if (!x || !y) return false;
  const spelled = learn.similarity(x, y);
  if (spelled >= 0.45) return true;
  return spelled >= 0.27 && learn.similarity(learn.soundKey(x), learn.soundKey(y)) >= 0.5;
}

/**
 * Keep the term, or put the model's other word back? {keep, why}.
 *   term     the dictionary term as written in the text
 *   heardAs  its entry's known mishearings
 *   p        the model's probability of the term's first token where it wrote it
 *   alt      the words the model wrote there with that token barred (as many as the term has)
 *   altNext  the word it wrote after them; origNext the word after the term in the dictation
 */
function decide({ term, heardAs = [], p, alt, altNext, origNext }) {
  if (typeof p === 'number' && p >= SURE) return { keep: true, why: 'sure' };
  const words = String(alt || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { keep: true, why: 'no other word' };
  if (plain(words.join('')) === plain(term)) return { keep: true, why: 'same' };
  if (heardAs.some((h) => plain(h) === plain(words.join('')))) return { keep: true, why: 'heard as' };
  if (alike(words.join(' '), term)) return { keep: true, why: 'alike' };
  const real = words.every((w) => /^\p{L}[\p{L}'’-]*$/u.test(w) && w.length >= 2 && !FUNCTION.has(w.toLowerCase()) &&
    (/^\p{Lu}/u.test(w) || learn.isCommon(w)));
  if (!real) return { keep: true, why: 'not a word' };
  // The other word must take the term's place, not skip it: the same word follows both.
  if (origNext && plain(altNext) !== plain(origNext)) return { keep: true, why: 'not in its place' };
  return { keep: false, why: 'a different word' };
}

/** `text` with the term at `occ` replaced by `alt`, in the case its place needs. */
function replace(text, occ, alt) {
  let words = String(alt).trim().split(/\s+/).join(' ');
  const before = text.slice(0, occ.index);
  if ((!before.trim() || /[.!?]\s*$/.test(before)) && /^\p{Ll}/u.test(words)) words = words[0].toUpperCase() + words.slice(1);
  return before + words + text.slice(occ.index + occ.length);
}

/** The first `n` words of `text`, and the word after them. */
function firstWords(text, n) {
  const all = String(text || '').trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
  return { alt: all.slice(0, n).join(' '), next: all[n] || null };
}

module.exports = { suspects, decide, replace, firstWords, alike, entries, SURE, MAX_CHECKS };
