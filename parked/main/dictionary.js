'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Words the recogniser gets wrong, and what they should have been.
 *
 * The measurements say this matters more than any model choice left: every
 * remaining error in bench/RESULTS.md is a proper noun or a piece of jargon —
 * "backslash" heard as "backlash", "Typd" as "type", "Poolside" as "pullside".
 * A concentrated error profile is a dictionary problem, and a dictionary problem
 * is a config change rather than a research project.
 *
 * The entries are learned rather than typed. See learn.js: when you fix a word
 * in the text that was just pasted, that correction lands here on its own.
 */

const FILE = () => path.join(app.getPath('userData'), 'dictionary.json');

let entries = null;   // { term, heardAs: string[], source: 'auto'|'manual', addedAt }

function load() {
  if (entries) return entries;
  try {
    entries = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!Array.isArray(entries)) entries = [];
  } catch {
    entries = [];
  }
  return entries;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(entries || [], null, 2), 'utf8');
  } catch {
    // A dictionary that cannot be written is a degraded feature, not a crash.
  }
}

function all() {
  return load().slice();
}

function find(term) {
  return load().find((e) => e.term.toLowerCase() === String(term).toLowerCase()) || null;
}

/**
 * @param {string} term      the correct spelling
 * @param {string} [heardAs] what the recogniser produced instead
 * @param {'auto'|'manual'} [source]
 * @returns {{term: string, heardAs: string[], created: boolean}|null}
 */
function add(term, heardAs, source = 'manual') {
  const clean = String(term || '').trim();
  if (!clean || clean.length > 64) return null;

  load();
  const existing = find(clean);

  if (existing) {
    // Same word misheard a new way: widen the entry rather than duplicating it.
    if (heardAs && !existing.heardAs.includes(heardAs)) {
      existing.heardAs.push(heardAs);
      save();
    }
    return { term: existing.term, heardAs: existing.heardAs, created: false };
  }

  const entry = {
    term: clean,
    heardAs: heardAs ? [String(heardAs)] : [],
    source,
    addedAt: new Date().toISOString()
  };
  entries.push(entry);
  save();
  return { term: entry.term, heardAs: entry.heardAs, created: true };
}

function remove(term) {
  load();
  const before = entries.length;
  entries = entries.filter((e) => e.term.toLowerCase() !== String(term).toLowerCase());
  if (entries.length !== before) {
    save();
    return true;
  }
  return false;
}

/**
 * The block handed to the model.
 *
 * Pairs beat a bare word list: "Typd (not: type, typed)" tells the model both
 * the target spelling and the specific mistake to watch for, which is far more
 * actionable than the word alone. Capped so a long dictionary cannot crowd out
 * the screen context it sits beside.
 */
function forPrompt(limit = 60) {
  const list = load();
  if (!list.length) return null;

  const lines = list.slice(-limit).map((e) =>
    e.heardAs.length ? e.term + ' (not: ' + e.heardAs.slice(0, 4).join(', ') + ')' : e.term
  );

  return (
    '<dictionary note="Correct spellings the recogniser gets wrong. Prefer these ' +
    'over similar-sounding words.">\n' + lines.join('\n') + '\n</dictionary>'
  );
}

module.exports = { all, add, remove, find, forPrompt, load };
