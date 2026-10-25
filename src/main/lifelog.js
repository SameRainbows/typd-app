'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The life log: what happened to Typd itself, never what anyone dictated.
 *
 * <userData>/logs/life.log, one line per event, kept small: at 256 KB it becomes life.1.log and a
 * new one starts (so at most ~512 KB on disk). It records launches, the Typd window opening and
 * closing, the Dock icon, who asked Typd to quit, renderers and helper processes that died,
 * uncaught errors, the key layer's health, sleep and wake, and main-thread stalls. The tray's
 * "Copy diagnostics" puts its last 200 lines on the clipboard for a tester to send.
 *
 * Never in it: dictated or revised text, screen context, selections, window titles, file paths
 * of the user's documents, keys or tokens. Error messages are cut to their first line with
 * anything quoted removed (a JSON error quotes the text it choked on), and stack frames keep only
 * a file name and line.
 *
 * A run that ends without quitting -- a crash, a kill, a power cut -- leaves logs/run.json behind
 * (written at launch, its "alive" time refreshed every minute, deleted on a clean exit); the next
 * launch says so, with when the last run was last seen alive and any minidump written since
 * (crashReporter, local only, in app.getPath('crashDumps')).
 */

const MAX_BYTES = 256 * 1024;
const BEAT_MS = 60 * 1000;

let dir = null;
let file = null;
let runFile = null;
let dumpsDir = null;
const early = [];   // lines logged before init()
let beat = null;

function stamp() {
  return new Date().toISOString();
}

/** One line of text with nothing quoted in it, at most `max` characters. */
function clean(text, max = 200) {
  let s = String(text == null ? '' : text).split(/\r?\n/)[0];
  s = s.replace(/"[^"]*"|“[^”]*”|‘[^’]*’|`[^`]*`/g, '…').replace(/(^|[^A-Za-z])'[^']*'/g, '$1…');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** An error as one line: its name, its message cleaned, and where (file:line, up to 3 frames). */
function errorLine(err) {
  if (!err || typeof err !== 'object') return clean(String(err), 160);
  const frames = String(err.stack || '').split('\n').slice(1)
    .map((l) => (l.match(/([^\\/()\s]+\.(?:js|cjs|mjs|node)):(\d+)/) || [])).filter((m) => m[1]).slice(0, 3)
    .map((m) => m[1] + ':' + m[2]);
  return (err.name || 'Error') + (err.code ? ' [' + clean(err.code, 40) + ']' : '') + ': ' + clean(err.message, 160) +
    (frames.length ? ' @ ' + frames.join(' < ') : '');
}

function rotate() {
  try {
    if (fs.statSync(file).size < MAX_BYTES) return;
    fs.renameSync(file, path.join(dir, 'life.1.log'));
  } catch { /* no file yet */ }
}

function append(line) {
  if (!file) { early.push(line); if (early.length > 200) early.shift(); return; }
  try {
    rotate();
    fs.appendFileSync(file, line + '\n');
  } catch { /* a log must never take Typd down */ }
}

/** Record one event: `what` a short word or two, `detail` anything (cleaned to one short line). */
function log(what, detail) {
  const line = stamp() + ' [' + process.pid + '] ' + clean(what, 40) + (detail === undefined || detail === '' ? '' : ': ' + clean(detail, 300));
  append(line);
  if (process.env.TYPD_DEBUG) console.log('[typd:life] ' + clean(what, 40) + (detail === undefined || detail === '' ? '' : ': ' + clean(detail, 300)));
}

function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function writeRun(run) {
  try { fs.writeFileSync(runFile, JSON.stringify(run)); } catch { /* best effort */ }
}

/** Minidumps (crashReporter) in dumpsDir, newest first: {name, bytes, at}. */
function dumps(since = 0) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.dmp$/i.test(e.name)) {
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs >= since) out.push({ name: path.relative(dumpsDir, p).replace(/\\/g, '/'), bytes: st.size, at: new Date(st.mtimeMs).toISOString() });
        } catch { /* gone */ }
      }
    }
  };
  if (dumpsDir) walk(dumpsDir, 0);
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/**
 * Start the log in <userData>/logs. `info` is the launch line's detail. Says how the last run
 * ended if it never said goodbye, then marks this one as running.
 */
function init(userData, { info = '', crashDumps = null } = {}) {
  try {
    dir = path.join(userData, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'life.log');
    runFile = path.join(dir, 'run.json');
    dumpsDir = crashDumps;
  } catch {
    file = null;
    return;
  }
  const last = readJson(runFile);
  for (const line of early.splice(0)) append(line);
  log('launch', info);
  if (last && last.pid !== process.pid) {
    const seen = last.alive ? Math.round((Date.parse(last.alive) - Date.parse(last.started)) / 1000) : null;
    log('last run ended without quitting', 'pid ' + last.pid + ', Typd ' + (last.version || '?') + ', started ' + last.started +
      ', last seen alive ' + (last.alive || '?') + (seen !== null ? ' (' + seen + ' s after it started)' : '') +
      ' -- a crash, a kill, a forced quit or the power going off');
    for (const d of dumps(Date.parse(last.started) || 0).slice(0, 5)) log('minidump from the last run', d.name + ', ' + d.bytes + ' bytes, ' + d.at);
  }
  const run = { pid: process.pid, version: (info.match(/Typd ([0-9][^\s,]*)/) || [])[1] || null, started: stamp(), alive: stamp() };
  writeRun(run);
  beat = setInterval(() => { run.alive = stamp(); writeRun(run); }, BEAT_MS);
  if (beat.unref) beat.unref();
}

/** A clean end: the next launch will not report this run as lost. */
let over = false;
function ended(how) {
  if (over) return;
  over = true;
  if (beat) { clearInterval(beat); beat = null; }
  log('exit', how);
  try { if (runFile) fs.unlinkSync(runFile); } catch { /* already gone */ }
}

/** The last `n` lines (life.1.log first if life.log alone has fewer). */
function tail(n = 200) {
  const lines = [];
  for (const f of [path.join(dir || '', 'life.1.log'), file]) {
    if (!f) continue;
    try { lines.push(...fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)); } catch { /* none */ }
  }
  return lines.slice(-n);
}

/**
 * One dictation's timings, as the detail of a 'dictation' line (index.js logDictation):
 *   dictate, 4.2 s audio, 38 chars, release to text 820 ms, text to paste 46 ms, pasted, model 2026-10-01, GPU
 * Counts and fixed words only -- never the text, the app or the context: every field is a number
 * or one of a few known words, and the model's version keeps only [A-Za-z0-9._+-].
 */
function dictationLine(o = {}) {
  const num = (v, digits = 0) => (typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? (digits ? (Math.round(v * 10 ** digits) / 10 ** digits).toFixed(digits) : String(Math.round(v))) : '?');
  const mode = ['dictate', 'revise'].includes(o.mode) ? o.mode : 'other';
  // offered: not pasted, there was no text field; the copy pop-up offered it (0.2.10).
  const outcome = ['pasted', 'copied', 'offered'].includes(o.outcome) ? o.outcome : 'other';
  const model = String(o.model || 'unknown').replace(/[^A-Za-z0-9._+-]/g, '').slice(0, 60) || 'unknown';
  const device = o.device === 'GPU' || o.device === 'CPU' ? o.device : 'device unknown';
  // 0.2.12: the microphone path (the native helper, warm or not, or Chromium's capture) and the key press
  // to its first audio. Only when given, so older lines read the same.
  const MICS = ['helper', 'helper (warm)', 'helper, then Chromium', 'Chromium'];
  const mic = o.mic && MICS.includes(o.mic.how) ? ', mic ' + o.mic.how + ' ' + num(o.mic.firstMs) + ' ms' : '';
  return mode + ', ' + num(o.audioSeconds, 1) + ' s audio, ' + num(o.chars) + ' chars, release to text ' +
    num(o.releaseToTextMs) + ' ms, text to paste ' + num(o.textToPasteMs) + ' ms, ' + outcome +
    ', model ' + model + ', ' + device + (o.lowMemory === true ? ', low memory' : '') + mic;
}

module.exports = { init, log, ended, tail, clean, errorLine, dumps, dictationLine, get file() { return file; } };
