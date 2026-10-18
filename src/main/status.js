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
  model: 'loading',     // 'loading' | 'ready' | 'failed'
  modelWhy: '',
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
  if (facts.model === 'loading') {
    return mk('loading', 'Getting ready…', 'Getting ready…', null, 'dim');
  }
  if (facts.live) {
    return mk('live', 'Listening — ' + k.verb + ' ' + k.label + ' to finish', 'Listening.', null, 'live');
  }
  return mk('ready', 'Ready — ' + k.verb + ' ' + k.label + ' to dictate',
    'Ready. ' + k.verb.charAt(0).toUpperCase() + k.verb.slice(1) + ' {key} in any app and talk.', null, 'ready');
}

function get() { return { ...facts }; }

module.exports = { set, get, onChange, touch, describe, useKey };
