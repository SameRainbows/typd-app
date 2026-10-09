'use strict';

/**
 * Does the overlay's wiring still join up?
 *
 * Every seam checked here fails *silently* at runtime rather than throwing,
 * which is why a static check earns its place:
 *
 *   - getElementById on a renamed id returns null, and the first property
 *     access on it throws deep inside an event handler, long after the cause
 *   - typdSound.play() swallows an unknown cue name by design, because audio
 *     is never worth throwing over -- so a typo is just silence
 *   - a channel missing from the preload allow-list never fires at all; main
 *     sends into nothing and the overlay simply never updates
 *   - EXIT_MS and --dur-exit are the same number written in two files; when
 *     they drift the pill is hidden mid-transition
 *
 * None of this needs Electron, a model or a key.
 *
 *   node bench/wiring.js
 */

const fs = require('fs');
const path = require('path');

const root = process.argv[2] || path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const html = read('src/renderer/overlay.html');
const js = read('src/renderer/overlay.js');
const snd = read('src/renderer/sound.js');
const pre = read('src/preload/overlay.js');
const main = read('src/main/index.js');
const pipe = read('src/main/pipeline/index.js');
const stub = read('src/main/pipeline/stub.js');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
}

function section(name) { console.log('\n' + name); }

/* ---------------------------------------------------------------- elements */

section('element ids the renderer expects');
const ids = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
[...new Set(ids)].forEach((id) => check('#' + id, html.includes('id="' + id + '"')));

/* ------------------------------------------------------------------ sounds */

section('sound cues the renderer plays');
const cueNames = new Set();
for (const m of js.matchAll(/typdSound\.play\(([^;]*?)\)\s*;/g)) {
  const arg = m[1].replace(/[=!]==?\s*'[A-Za-z]+'/g, '');   // drop comparisons
  for (const q of arg.matchAll(/'([A-Za-z]+)'/g)) cueNames.add(q[1]);
}
[...cueNames].sort().forEach((n) => {
  check(n, new RegExp('\\b' + n + ':\\s*function').test(snd));
});

/* --------------------------------------------------------------- channels */

section('IPC channels');
const listens = [...new Set([...js.matchAll(/typd\.on\('([^']+)'/g)].map((m) => m[1]))];
listens.forEach((c) => check(c + '  allowed by preload', pre.includes("'" + c + "'")));

// Anything main sends must also be allowed, or it lands nowhere.
const sends = new Set();
for (const m of main.matchAll(/send\('(session:[^']+)'/g)) sends.add(m[1]);
// The generic forwarder covers whatever the pipeline yields.
for (const m of pipe.matchAll(/type: '([a-z]+)'/g)) sends.add('session:' + m[1]);
[...sends].sort().forEach((c) => check(c + '  allowed by preload', pre.includes("'" + c + "'")));

/* ----------------------------------------------------------------- states */

section('states');
const cssStates = new Set([...read('src/renderer/overlay.css').matchAll(/data-state="([a-z]+)"/g)].map((m) => m[1]));
const jsStates = new Set([...js.matchAll(/setState\('([a-z]+)'\)/g)].map((m) => m[1]));
console.log('    css knows: ' + [...cssStates].sort().join(', '));
console.log('    js  sets : ' + [...jsStates].sort().join(', '));
const BASE = new Set(['idle', 'listening']);   // idle is hidden; listening is the base look
check('every non-base state has a css rule',
  [...jsStates].every((s) => BASE.has(s) || cssStates.has(s)),
  '(base: ' + [...BASE].join(', ') + ')');
check('every css state is one the renderer can reach',
  [...cssStates].every((s) => jsStates.has(s)));
check('streaming and result are gone from both',
  !jsStates.has('streaming') && !jsStates.has('result') &&
  !cssStates.has('streaming') && !cssStates.has('result'));

/* ---------------------------------------------------------------- protocol */

section('progress protocol');
check('pipeline emits expect', /type: 'expect'/.test(pipe));
check('stub emits expect', /type: 'expect'/.test(stub));
check('renderer consumes expect', /session:expect/.test(js));
check('renderer drives width from it', /progressEl\.style\.width/.test(js));

/* ------------------------------------------------------------------ timing */

section('timing constants that must agree');
const exitJs = (js.match(/var EXIT_MS = (\d+)/) || [])[1];
const exitCss = (read('src/renderer/overlay.css').match(/--dur-exit:\s*(\d+)ms/) || [])[1];
check('EXIT_MS === --dur-exit', exitJs && exitJs === exitCss, exitJs + ' vs ' + exitCss);

console.log('\n' + (failures ? failures + ' FAILED' : 'all wiring checks passed') + '\n');
process.exit(failures ? 1 : 0);
