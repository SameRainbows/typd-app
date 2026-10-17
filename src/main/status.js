'use strict';

/**
 * One answer to "is Typd working?", for the tray's first line, its icon and tooltip,
 * and the status card on Home -- so the two can never disagree.
 *
 * Main sets the facts as it learns them (the model loading, the key armed or not, the
 * microphone blocked, a session open); describe() turns them into one sentence and,
 * when something is wrong, the one action that fixes it. The worst problem wins: a Mac
 * permission before a blocked microphone before a dead key before a failed model.
 */

const facts = {
  model: 'loading',     // 'loading' | 'ready' | 'failed' | 'missing' (no model yet: a model-less install)
  modelWhy: '',
  modelFetch: null,     // with 'missing': the first model's download (modelUpdate.needed()), or null if none runs
  key: 'ok',            // 'ok' | 'failed'
  keyWhy: '',
  mic: 'ok',            // 'ok' | 'blocked'
  perms: [],            // macOS: switches that are off ('microphone', 'accessibility', 'input')
  live: false           // a dictation is recording or being written
};

const listeners = [];
let keyInfo = () => ({ label: 'Right Alt', short: 'Right Alt', verb: 'tap' });

function set(patch) {
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in facts)) continue;
    if (JSON.stringify(facts[k]) === JSON.stringify(v)) continue;
    facts[k] = v;
    changed = true;
  }
  if (changed) for (const fn of listeners) { try { fn(describe()); } catch { /* a listener's problem */ } }
}

function onChange(fn) { listeners.push(fn); }

/** Something the sentence depends on changed outside the facts (the key was swapped). */
function touch() {
  for (const fn of listeners) { try { fn(describe()); } catch { /* a listener's problem */ } }
}

/** Where the key's name comes from (hotkey-logic, through main). */
function useKey(fn) { keyInfo = fn; }

const PERM_WORDS = { microphone: 'Microphone', accessibility: 'Accessibility', input: 'Input Monitoring' };

/**
 * @returns {{state: string, line: string, card: string, action: null|{id: string, label: string},
 *            icon: 'ready'|'dim'|'live', tooltip: string}}
 *   line: the tray's first row; card: Home's sentence; action: what a click on either does
 */
function describe() {
  const k = keyInfo();
  const mac = process.platform === 'darwin';
  const mk = (state, line, card, action, icon) => ({
    state, line, card, action, icon,
    tooltip: 'Typd — ' + (state === 'ready' ? 'ready · ' + k.label : line.replace(/ — .*$/, ''))
  });

  if (facts.perms.length) {
    const first = PERM_WORDS[facts.perms[0]] || facts.perms[0];
    return mk('permissions', 'Typd needs ' + first + ' — Fix…',
      'Typd needs ' + facts.perms.map((p) => PERM_WORDS[p] || p).join(' and ') + ' turned on.',
      { id: 'permissions', label: 'Open System Settings' }, 'dim');
  }
  if (facts.mic === 'blocked') {
    return mk('mic', 'Microphone is blocked — Fix…',
      (mac ? 'macOS' : 'Windows') + ' is blocking the microphone for Typd.',
      { id: 'privacy', label: 'Open privacy settings' }, 'dim');
  }
  if (facts.key === 'failed') {
    return mk('key', k.label + " isn't working — Choose another key…",
      facts.keyWhy || "Typd couldn't listen for " + k.label + '.',
      { id: 'hotkey', label: 'Choose another key' }, 'dim');
  }
  if (facts.model === 'failed') {
    return mk('model', "Speech model didn't start — Try again",
      "The speech model didn't start." + (facts.modelWhy ? ' ' + facts.modelWhy : ''),
      { id: 'retry', label: 'Try again' }, 'dim');
  }
  if (facts.model === 'missing') return missing(mk);
  if (facts.model === 'loading') {
    return mk('loading', 'Getting ready…', 'Getting ready…', null, 'dim');
  }
  if (facts.live) {
    return mk('live', 'Listening — ' + k.verb + ' ' + k.label + ' to finish', 'Listening.', null, 'live');
  }
  return mk('ready', 'Ready — ' + k.verb + ' ' + k.label + ' to dictate',
    'Ready. ' + k.verb.charAt(0).toUpperCase() + k.verb.slice(1) + ' {key} in any app and talk.', null, 'ready');
}

/**
 * No speech model yet (a public install's first launch: its installer has none, modelUpdate.js
 * downloads it). Dictation waits for it; the line says how far the download is and what, if
 * anything, it needs from the person: an OK on a metered connection, the internet, disk space.
 */
function missing(mk) {
  const f = facts.modelFetch;
  if (!f) {
    return mk('download', 'No speech model yet', 'Typd has no speech model yet, so it cannot dictate.', { id: 'retry', label: 'Try again' }, 'dim');
  }
  const about = (f.estimate ? 'about ' : '') + f.size;
  switch (f.state) {
    case 'downloading':
      return mk('download', 'Downloading the speech model — ' + f.pct + ' %',
        'Typd is downloading its speech model: ' + f.pct + ' % of ' + f.size + '. After that it works offline.', null, 'dim');
    case 'retrying':
      return mk('download', 'Downloading the speech model — ' + f.pct + ' %, paused',
        'The download paused at ' + f.pct + ' % of ' + f.size + '. Typd tries again by itself.', null, 'dim');
    case 'ready':
      return mk('download', 'Getting the speech model ready…', 'The speech model is downloaded. Typd is getting it ready.', null, 'dim');
    case 'ask':
    case 'later':
      return mk('download', 'Speech model needed (' + f.size + ') — Download now',
        'Typd needs to download its speech model once (' + f.size + '). This connection may be metered, so Typd waits for your OK.',
        { id: 'model-now', label: 'Download now' }, 'dim');
    case 'offline':
      return mk('download', 'Speech model needed — connect to the internet',
        'Typd needs to download its model once, ' + about + '; after that it works offline.', null, 'dim');
    case 'space':
      return mk('download', 'Speech model needs more disk space',
        'Typd needs ' + about + ' of free disk space, and a little more, to download its speech model.', null, 'dim');
    case 'app':
      return mk('download', 'Speech model needs a newer Typd', 'The speech model needs a newer Typd. Typd updates itself; then it downloads the model.', null, 'dim');
    default:
      return mk('download', 'Getting the speech model…', 'Typd is getting its speech model (' + about + '). After that it works offline.', null, 'dim');
  }
}

function get() { return { ...facts }; }

module.exports = { set, get, onChange, touch, describe, useKey };
