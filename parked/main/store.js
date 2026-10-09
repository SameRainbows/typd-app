'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Session history and the numbers derived from it.
 *
 * Everything stays on this machine, in one JSON file under userData. Nothing is
 * uploaded, and the transcript is only kept because History is useless without
 * it -- see `setRetention` for turning that off.
 */

const FILE = () => path.join(app.getPath('userData'), 'history.json');

// What an average person types at. Used only for the "time saved" figure, which
// is a comparison rather than a measurement -- and is labelled as one.
const TYPING_WPM = 40;

const DEFAULTS = { retentionDays: 0, sessions: [] };  // 0 = keep forever

let data = null;

function load() {
  if (data) return data;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    data = { ...DEFAULTS, ...raw };
    if (!Array.isArray(data.sessions)) data.sessions = [];
  } catch {
    data = { ...DEFAULTS, sessions: [] };
  }
  prune();
  return data;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // History that cannot be written is a degraded feature, not a crash.
  }
}

function prune() {
  if (!data || !data.retentionDays) return;
  const cutoff = Date.now() - data.retentionDays * 86400000;
  const before = data.sessions.length;
  data.sessions = data.sessions.filter((s) => new Date(s.at).getTime() >= cutoff);
  if (data.sessions.length !== before) save();
}

function countWords(text) {
  const hits = String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
  return hits ? hits.length : 0;
}

/**
 * @param {{mode: string, text?: string, seconds?: number, app?: string}} session
 */
function record(session) {
  load();
  const words = countWords(session.text);
  data.sessions.push({
    at: new Date().toISOString(),
    mode: session.mode || 'dictate',
    words,
    seconds: Math.max(0, Math.round(session.seconds || 0)),
    app: session.app || null,
    text: session.text || ''
  });
  // Unbounded growth in a file we rewrite whole is the one failure mode here.
  if (data.sessions.length > 5000) data.sessions = data.sessions.slice(-5000);
  save();
}

function sessions(limit = 200) {
  return load().sessions.slice(-limit).reverse();
}

function stats() {
  const list = load().sessions;
  const seconds = list.reduce((n, s) => n + (s.seconds || 0), 0);
  const words = list.reduce((n, s) => n + (s.words || 0), 0);

  // Only count spoken time against spoken words: an Ask session has a long
  // answer and a short question, and would flatter the WPM into nonsense.
  const spoken = list.filter((s) => s.mode === 'dictate' || s.mode === 'translate');
  const spokenWords = spoken.reduce((n, s) => n + (s.words || 0), 0);
  const spokenSeconds = spoken.reduce((n, s) => n + (s.seconds || 0), 0);

  const wpm = spokenSeconds > 0 ? Math.round(spokenWords / (spokenSeconds / 60)) : 0;
  const typedSeconds = (spokenWords / TYPING_WPM) * 60;

  return {
    seconds,
    words,
    wpm,
    savedSeconds: Math.max(0, Math.round(typedSeconds - spokenSeconds)),
    count: list.length
  };
}

function retention() {
  return load().retentionDays;
}

function setRetention(days) {
  load();
  data.retentionDays = Math.max(0, Number(days) || 0);
  prune();
  save();
}

function clear() {
  load();
  data.sessions = [];
  save();
}

module.exports = { record, sessions, stats, retention, setRetention, clear, countWords };
