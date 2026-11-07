'use strict';

/**
 * Self-checks: what Typd can find out about itself in its first minute, and keep watching after,
 * so a failure that hits every dictation shows up at once -- in the life log, the tray's first
 * line and the pill -- instead of after a day of "it copied again".
 *
 * Why (dictation-research reports/real_use_audit_2026-10-31.md): the packaged 0.2.11 on Windows
 * never started its paste helper (inject.ps1 inside app.asar), so every dictation for 22 hours was
 * copied, never pasted, and nothing said why; a restart changed nothing. The life log had one
 * "not pasted, copied instead: restart Typd" per dictation and no line at launch.
 *
 * Everything here is counts and fixed words: never the text, the app or the context (the life
 * log's rule, lifelog.js). The functions are plain so bench/self-check.js can run them in Node.
 */

/* ------------------------------------------------------------ the paste helper at launch */

/**
 * Wait for the paste helper's handshake (inject.isReady()), polling. Resolves {ready, ms}: ready
 * after `ms`, or not ready when `limitMs` ran out. Never rejects.
 */
function waitForHelper(isReady, { limitMs = 15000, everyMs = 250, now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const t0 = now();
  return (async () => {
    for (;;) {
      let ok = false;
      try { ok = Boolean(isReady()); } catch { ok = false; }
      if (ok) return { ready: true, ms: Math.max(0, now() - t0) };
      if (now() - t0 >= limitMs) return { ready: false, ms: Math.max(0, now() - t0) };
      await wait(everyMs);
    }
  })();
}

/** The launch check's life-log detail for the paste helper. */
function helperLine(r, { platform = process.platform } = {}) {
  const what = platform === 'darwin' ? 'the key and paste helper' : 'the paste helper';
  if (r && r.ready) return what + ' is running (ready ' + secs(r.ms) + ' after launch)';
  return what + ' is NOT running ' + secs(r && r.ms) + ' after launch: dictations will be copied, not pasted';
}

/* ----------------------------------------------------------------- the model's warm start */

/** "model: ready in 7.4 s on the GPU" / "... did not start after 12.0 s: why". */
function modelLine({ ok, ms, device, version, why, what = 'launch' } = {}) {
  const v = version ? ' (' + String(version).replace(/[^A-Za-z0-9._+-]/g, '').slice(0, 60) + ')' : '';
  const by = what === 'switch' ? ' after a switch' : what === 'retry' ? ' on Try again' : '';
  if (ok) return 'ready' + by + ' in ' + secs(ms) + (device === 'GPU' || device === 'CPU' ? ' on the ' + device : '') + v;
  return 'did not start' + by + ' after ' + secs(ms) + v + (why ? ': ' + String(why).split(/\r?\n/)[0].slice(0, 120) : '');
}

/* ------------------------------------------------------ dictations that were not pasted */

/**
 * Watches every dictation's outcome. Two pastes in a row that fell back to the clipboard (never
 * the copy pop-up's "no text field" offer: that one is a choice) mean paste is broken, not unlucky:
 * one life-log line, and onBroken() (the tray says so, the pill says it once). The next real paste
 * clears it (onFixed()).
 */
function createPasteWatch({ log = () => {}, onBroken = () => {}, onFixed = () => {}, threshold = 2 } = {}) {
  let run = 0;
  let broken = false;
  return {
    /** outcome: 'pasted' | 'copied' | 'offered'; helperReady: inject.isReady() at the time. */
    note(outcome, { reason = '', helperReady = null } = {}) {
      if (outcome === 'pasted') {
        run = 0;
        if (broken) {
          broken = false;
          log('paste works again: a dictation was pasted');
          onFixed();
        }
        return;
      }
      if (outcome !== 'copied') return;   // 'offered': there was no text field -- not a paste failure
      run++;
      if (run === threshold && !broken) {
        broken = true;
        log(run + ' dictations in a row were copied, not pasted' +
          (helperReady === false ? ' (the paste helper is not running)' : helperReady === true ? ' (the paste helper is running)' : '') +
          (reason ? '; the reason given: ' + String(reason).split(/\r?\n/)[0].slice(0, 80) : ''));
        onBroken();
      }
    },
    get broken() { return broken; },
    get run() { return run; }
  };
}

/* ------------------------------------------------------------------ "Didn't catch that" */

/**
 * Why a dictation came to nothing, in counts, for the life log -- the two cases the old line told
 * apart only by a source line number (pipeline/index.js: fewer than 3 voiced 30 ms frames, or a
 * model that wrote nothing / only the dictionary for audio that had sound in it).
 *   kind 'quiet': too little sound to be speech (a tap, or the microphone opened late)
 *   kind 'empty': there was sound, and the model wrote nothing (or only the dictionary's words)
 */
function caughtKind(voiced) {
  return typeof voiced === 'number' && voiced < 3 ? 'quiet' : 'empty';
}

function caughtLine({ kind, audioSeconds, voiced }) {
  const a = typeof audioSeconds === 'number' && Number.isFinite(audioSeconds) ? audioSeconds.toFixed(1) + ' s of audio' : 'audio of unknown length';
  const v = typeof voiced === 'number' && Number.isFinite(voiced) ? Math.round(voiced) + ' voiced 30 ms frame' + (Math.round(voiced) === 1 ? '' : 's') : 'voiced frames unknown';
  if (kind === 'quiet') return 'too quiet to be speech: ' + v + ' in ' + a + ' (a tap, or the microphone opened late)';
  return 'the model wrote nothing for ' + a + ' with ' + v;
}

/* ------------------------------------------------------------------- Check for updates */

const OUTCOME_WORDS = {
  current: 'up to date', downloading: 'downloading', ready: 'ready to install', manual: 'needs a reinstall',
  failed: 'an earlier install failed', offline: 'offline', error: 'could not check', busy: 'asked to wait (busy)',
  off: 'off', ask: 'waiting for an OK', app: 'needs a newer Typd'
};

/** One life-log line for a check's answer: "answer after 340 ms: Typd up to date, model up to date". */
function updatesAnswerLine(app, model, ms) {
  const w = (x) => OUTCOME_WORDS[(x && x.outcome) || 'error'] || 'could not check';
  const why = [app, model].map((x) => (x && (x.outcome === 'error' || x.outcome === 'offline') && x.why ? String(x.why).split(/\r?\n/)[0].slice(0, 60) : null)).filter(Boolean);
  return 'answer after ' + Math.max(0, Math.round(ms || 0)) + ' ms: Typd ' + w(app) + ', model ' + w(model) + (why.length ? ' (' + why.join('; ') + ')' : '');
}

/** " Checked at 22:18." for the Updates line: the answer is fresh, even when it reads as before. */
function checkedAt(iso, { locale } = {}) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  let hm;
  try { hm = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }); } catch { hm = ''; }
  if (!hm) hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return ' Checked at ' + hm + '.';
}

/* -------------------------------------------------------------------------------- helpers */

function secs(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? (Math.round(ms / 100) / 10).toFixed(1) + ' s' : '? s';
}

module.exports = { waitForHelper, helperLine, modelLine, createPasteWatch, caughtKind, caughtLine, updatesAnswerLine, checkedAt, secs };
