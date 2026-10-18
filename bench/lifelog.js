'use strict';

/**
 * The life log (src/main/lifelog.js) and "Copy diagnostics" (index.js): what they keep, that they
 * stay small, that a run that never said goodbye is reported by the next one, and that no
 * dictation text can get into them.
 *
 *   node bench/lifelog.js
 *
 * Each launch runs in a child process (the log's state is per process, as in Typd).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const LIFE = path.join(root, 'src', 'main', 'lifelog.js');

if (process.argv[2] === '--run') {
  const c = JSON.parse(process.argv[3]);
  const life = require(LIFE);
  life.init(c.userData, { info: 'Typd 0.2.4, test', crashDumps: c.dumps });
  for (const [what, detail] of c.lines || []) life.log(what, detail);
  for (let i = 0; i < (c.many || 0); i++) life.log('filler', 'x'.repeat(200) + ' ' + i);
  if (c.clean) life.ended('quit, exit code 0');
  process.stdout.write(JSON.stringify({ tail: life.tail(c.tail || 200) }));
  // Without c.clean: the process just ends, as a crash would (no ended()).
  if (c.clean) process.exit(0); else process.kill(process.pid, 'SIGKILL');
}

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (ok || detail === undefined ? '' : '  (' + JSON.stringify(detail).slice(0, 300) + ')'));
  if (!ok) failures++;
}

function run(c) {
  try {
    return JSON.parse(execFileSync(process.execPath, [__filename, '--run', JSON.stringify(c)], { encoding: 'utf8' }) || '{}');
  } catch (err) {
    // SIGKILL: the run "crashed"; whatever it printed first is still there.
    return JSON.parse(String(err.stdout || '{}') || '{}');
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-lifelog-'));
const userData = path.join(TMP, 'typd');
const dumps = path.join(userData, 'Crashpad');
const logFile = path.join(userData, 'logs', 'life.log');
const life = require(LIFE);

console.log('\nthe life log');
let r = run({ userData, dumps, clean: true, lines: [['window open', 'home, from the menu bar menu'], ['window closed', 'after 12 s; Typd keeps running']] });
const text = () => fs.readFileSync(logFile, 'utf8');
check('a launch line, the events, and a clean exit', /\] launch: Typd 0\.2\.4/.test(text()) && /window open: home, from the menu bar menu/.test(text()) && /\] exit: quit, exit code 0/.test(text()));
check('a clean exit leaves no run marker', !fs.existsSync(path.join(userData, 'logs', 'run.json')));
r = run({ userData, dumps, clean: true });
check('the next launch after a clean exit reports nothing lost', !/last run ended without quitting/.test(text()));

// A run that dies (SIGKILL: no exit handler at all), with a minidump written meanwhile.
run({ userData, dumps, clean: false, lines: [['window closed', 'after 3 s; Typd keeps running']] });
fs.mkdirSync(path.join(dumps, 'completed'), { recursive: true });
fs.writeFileSync(path.join(dumps, 'completed', 'abc123.dmp'), Buffer.alloc(1234));
r = run({ userData, dumps, clean: true });
check('the next launch says the last run ended without quitting, and when it was last seen alive',
  /last run ended without quitting: pid \d+, Typd 0\.2\.4, started \S+, last seen alive \S+/.test(text()), text().split('\n').slice(-6));
check('... and names the minidump it left', /minidump from the last run: completed\/abc123\.dmp, 1234 bytes/.test(text()));

// Nothing quoted, one line, short: a JSON error that quotes dictated text loses the quote.
const err = new SyntaxError('Unexpected token \'H\', "Hello this is my dictation" is not valid JSON');
const line = life.errorLine(err);
check('an error line keeps its kind and drops what it quoted', /^SyntaxError: Unexpected token …, … is not valid JSON/.test(line) && !/Hello|dictation/.test(line), line);
check('a multi-line message keeps its first line', life.clean('first\nsecond "secret"') === 'first');
check("apostrophes in plain words stay (Typd's, isn't)", life.clean("Typd's key isn't heard") === "Typd's key isn't heard");
check('long details are cut', life.clean('y'.repeat(1000), 300).length === 300);

// Small: rotated at 256 KB into life.1.log, never more than two files.
r = run({ userData, dumps, clean: true, many: 2600, tail: 200 });
const logs = fs.readdirSync(path.join(userData, 'logs')).filter((f) => f.endsWith('.log')).sort();
const size = logs.reduce((n, f) => n + fs.statSync(path.join(userData, 'logs', f)).size, 0);
check('rotated: life.log and life.1.log only, under 600 KB in all', logs.join(',') === 'life.1.log,life.log' && size < 600 * 1024, { logs, size });
check('tail(200): the last 200 lines across both files', r.tail && r.tail.length === 200 && /exit: quit/.test(r.tail[199]), r.tail && r.tail.length);

// What index.js puts in "Copy diagnostics", and what it must never touch.
const idx = fs.readFileSync(path.join(root, 'src', 'main', 'index.js'), 'utf8');
const diag = (idx.match(/function diagnosticsText\(\) \{[\s\S]*?\n\}/) || [''])[0];
check('diagnostics: version, OS, key, tap, status, Dock, windows, model file, minidumps, then 200 log lines',
  ['app.getVersion()', 'hotkeys.state()', 'hotkeys.health()', 'status.describe().line', 'app.dock.isVisible()', 'BrowserWindow.getAllWindows().length', 'life.dumps()', 'life.tail(200)'].every((s) => diag.includes(s)));
check('diagnostics never read a dictation, the history, the clipboard history or the screen',
  diag.length > 0 && !/session\.|store\(|lastDictation|remember|contextBlock|span|\.text\b|inject\.|history/.test(diag), diag.match(/session\.|store\(|lastDictation|remember|contextBlock|span|\.text\b|inject\.|history/));
check('the tray item copies them with the clipboard, locally (no network)', /function copyDiagnostics\(\) \{[\s\S]*?clipboard\.writeText\(diagnosticsText\(\)\)/.test(idx) &&
  /label: 'Copy diagnostics', click: \(\) => deps\.diagnostics\(\)/.test(fs.readFileSync(path.join(root, 'src', 'main', 'tray.js'), 'utf8')));
const callers = [];
for (const f of fs.readdirSync(path.join(root, 'src', 'main')).filter((x) => x.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(root, 'src', 'main', f), 'utf8');
  for (const m of src.matchAll(/life\.log\(([^;]*)\);/g)) callers.push(f + ': ' + m[1]);
}
const leaky = callers.filter((c) => /\b(text|event\.text|output|span|context|contextBlock|title|lastText|clipboard\.read)\b/.test(c.replace(/'[^']*'/g, '')));
check('no life.log call passes dictated text, context, a selection or a title', leaky.length === 0, leaky);
check('crash reports stay local: crashReporter.start with uploadToServer false and no submitURL',
  /crashReporter\.start\(\{ uploadToServer: false, compress: false \}\)/.test(idx) && !/submitURL/.test(idx));

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + (failures ? failures + ' FAILED' : 'all life-log checks passed') + '\n');
process.exit(failures ? 1 : 0);
