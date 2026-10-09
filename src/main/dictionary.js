'use strict';

const fs = require('fs');
const path = require('path');
const { VOCAB_FILE } = require('./pipeline/context');

/**
 * Words the recogniser gets wrong, and what they should have been: the same
 * file context.js reads into the prompt on every dictation
 * (%APPDATA%\typd\dictionary.json, entries {term, heardAs[], source, addedAt}).
 *
 * Entries are learned rather than typed -- see learn.js. The file is plain JSON
 * so what Typd thinks it knows can be read and edited by hand (ROADMAP 3.8), and
 * it is re-read before every change so a hand edit is never overwritten.
 */

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(VOCAB_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function save(entries) {
  try {
    fs.mkdirSync(path.dirname(VOCAB_FILE), { recursive: true });
    const tmp = VOCAB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
    fs.renameSync(tmp, VOCAB_FILE);
    return true;
  } catch {
    // A dictionary that cannot be written is a degraded feature, not a crash.
    return false;
  }
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * @param {string} term      the correct spelling
 * @param {string} [heardAs] what the recogniser produced instead
 * @param {'auto'|'manual'} [source]
 * @returns {{term: string, heardAs: string[], created: boolean}|null}
 */
function add(term, heardAs, source = 'manual') {
  const clean = String(term || '').trim();
  if (!clean || clean.length > 64) return null;

  const entries = load();
  const existing = entries.find((e) => e && same(e.term, clean));
  if (existing) {
    // Same word misheard a new way: widen the entry rather than duplicating it.
    existing.heardAs = Array.isArray(existing.heardAs) ? existing.heardAs : [];
    if (heardAs && !existing.heardAs.some((h) => same(h, heardAs))) {
      existing.heardAs.push(String(heardAs));
      save(entries);
    }
    return { term: existing.term, heardAs: existing.heardAs, created: false };
  }

  const entry = { term: clean, heardAs: heardAs ? [String(heardAs)] : [], source, addedAt: new Date().toISOString() };
  entries.push(entry);
  if (!save(entries)) return null;
  return { term: entry.term, heardAs: entry.heardAs, created: true };
}

function remove(term) {
  const entries = load();
  const kept = entries.filter((e) => !(e && same(e.term, term)));
  return kept.length !== entries.length && save(kept);
}

module.exports = { add, remove, load };
