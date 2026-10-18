'use strict';

/**
 * When Typd looks for a newer app or model (appUpdate.js, modelUpdate.js), since 0.2.5:
 *
 *   - every hour (DEFAULT_EVERY_MS), each wait JITTER (10 %) longer or shorter at random, so installs
 *     started together drift apart instead of asking the server at the same minute;
 *   - at the interval the server asks for, if it does: the manifest response's checkEverySec -- the
 *     X-Typd-Check-Every-Sec header (typd-collect's CHECK_EVERY_SEC sets it on every manifest route), or
 *     a `checkEverySec` field in the manifest's JSON -- honoured within [15 min, 6 h] (MIN_EVERY_MS,
 *     MAX_EVERY_MS), so every install can be slowed down from the server if traffic grows. The latest
 *     response decides: one without it means the default again;
 *   - once on launch (each updater's first check comes seconds after start);
 *   - on wake from sleep or on unlock, if the last check was more than 15 minutes ago (WAKE_AFTER_MS);
 *   - when someone presses "Check for updates" (index.js).
 *
 * A check is one GET of the manifest ("is there anything newer?"), which typd-collect answers from its
 * edge cache (5 minutes in each data centre), so a check costs a Worker request and no storage read.
 * Electron-free: the clock and the randomness are passed in (bench/update-cadence.js).
 */

const DEFAULT_EVERY_MS = 3600e3;
const MIN_EVERY_MS = 15 * 60e3;
const MAX_EVERY_MS = 6 * 3600e3;
const JITTER = 0.1;
const WAKE_AFTER_MS = 15 * 60e3;
const WAKE_DELAY_MS = 10e3;            // after a wake, a moment for the network to come back
const HEADER = 'x-typd-check-every-sec';

/** checkEverySec (a number of seconds, or its text) -> milliseconds within [MIN, MAX]; null if it is not a positive number. */
function clampSec(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_EVERY_MS, Math.max(MIN_EVERY_MS, Math.round(n * 1000)));
}

/** The server's interval from a response: its header first, else the JSON's checkEverySec; null without one. */
function hintOf(headers, json) {
  let h = null;
  try { h = headers && typeof headers.get === 'function' ? headers.get(HEADER) : null; } catch { h = null; }
  const fromHeader = clampSec(h);
  if (fromHeader) return fromHeader;
  return json && typeof json === 'object' && !Array.isArray(json) ? clampSec(json.checkEverySec) : null;
}

/** `ms`, JITTER longer or shorter: random() 0 -> 0.9 x, 0.5 -> 1 x, 1 -> 1.1 x. */
function jittered(ms, random = Math.random) {
  let r = 0.5;
  try { r = Number(random()); } catch { r = 0.5; }
  if (!Number.isFinite(r)) r = 0.5;
  r = Math.min(1, Math.max(0, r));
  return Math.round(ms * (1 - JITTER + 2 * JITTER * r));
}

/**
 * One updater's cadence.
 *   everyMs   the regular interval (DEFAULT_EVERY_MS; tests pass a short one)
 *   now       () => ms
 *   random    () => [0, 1)
 */
function createCadence({ everyMs = DEFAULT_EVERY_MS, now = () => Date.now(), random = Math.random } = {}) {
  let hint = null;     // ms, from the last response that carried one
  let last = 0;        // when the last request for the manifest was made
  return {
    /** The interval now: the server's, else the regular one. */
    every: () => hint || everyMs,
    /** How long until the next regular check: every(), give or take JITTER. */
    next: () => jittered(hint || everyMs, random),
    /** Read a response's hint (headers, and the parsed JSON if there is one). Returns the interval now. */
    fromResponse(headers, json) {
      hint = hintOf(headers, json);
      return hint || everyMs;
    },
    /** A request for the manifest is being made now. */
    checked() { last = now(); },
    get last() { return last; },
    get hint() { return hint; },
    /** Woken or unlocked: is a check due (none yet, or the last one more than WAKE_AFTER_MS ago)? */
    wakeDue: () => !last || now() - last >= WAKE_AFTER_MS
  };
}

module.exports = { createCadence, clampSec, hintOf, jittered, DEFAULT_EVERY_MS, MIN_EVERY_MS, MAX_EVERY_MS, JITTER, WAKE_AFTER_MS, WAKE_DELAY_MS, HEADER };
