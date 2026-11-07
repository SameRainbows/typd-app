'use strict';

/**
 * Self-checks (src/main/selfcheck.js and their wiring): what a real-use audit of the founder's own Typd
 * (dictation-research reports/real_use_audit_2026-10-31.md) found missing.
 *
 *   - the paste helper's handshake at launch, in the life log either way, and the tray + pill when it is
 *     not up (0.2.11 packaged copied every dictation for 22 hours and said only "restart Typd")
 *   - two pastes in a row that fell back to the clipboard flag paste as broken; a real paste clears it;
 *     the copy pop-up's "no text field" offer never counts
 *   - "Didn't catch that" split into too quiet / the model wrote nothing, in counts, and the recording
 *     kept (marked failed) -- never shared by the backfill
 *   - a run that ended without quitting: session end, a restart, a crash dump, or "kept running"
 *   - Check for updates: the answer in the log, "Checked at", and "Checking…" held for a moment
 *   - a sleep is not a main-thread stall
 *
 *   node bench/self-check.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const sc = require(path.join(root, 'src', 'main', 'selfcheck.js'));
const life = require(path.join(root, 'src', 'main', 'lifelog.js'));

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (ok || detail === undefined ? '' : '  (' + JSON.stringify(detail).slice(0, 300) + ')'));
  if (!ok) failures++;
}
const section = (s) => console.log('\n' + s);

(async () => {
  section('the paste helper at launch');
  {
    // A fake clock: the helper answers after 400 ms; polling every 250 ms.
    let t = 0;
    const clock = { now: () => t, wait: async (ms) => { t += ms; } };
    let r = await sc.waitForHelper(() => t >= 400, { limitMs: 15000, everyMs: 250, ...clock });
    check('ready after its handshake: {ready: true, ms}', r.ready === true && r.ms === 500, r);
    check('the line says it is running and when', sc.helperLine(r, { platform: 'win32' }) === 'the paste helper is running (ready 0.5 s after launch)', sc.helperLine(r, { platform: 'win32' }));
    t = 0;
    r = await sc.waitForHelper(() => false, { limitMs: 15000, everyMs: 250, ...clock });
    check('never ready: gives up at the limit, ready false', r.ready === false && r.ms >= 15000 && r.ms < 15300, r);
    check('... and the line says dictations will be copied, not pasted', /^the paste helper is NOT running 15\.0 s after launch: dictations will be copied, not pasted$/.test(sc.helperLine(r, { platform: 'win32' })), sc.helperLine(r, { platform: 'win32' }));
    t = 0;
    r = await sc.waitForHelper(() => { throw new Error('gone'); }, { limitMs: 1000, everyMs: 250, ...clock });
    check('an isReady() that throws counts as not ready (never rejects)', r.ready === false, r);
    check('macOS names its helper as the key and paste helper', /^the key and paste helper is running/.test(sc.helperLine({ ready: true, ms: 100 }, { platform: 'darwin' })));
  }

  section('the paste watch');
  {
    const lines = [];
    let broken = 0, fixed = 0;
    const w = sc.createPasteWatch({ log: (l) => lines.push(l), onBroken: () => broken++, onFixed: () => fixed++ });
    w.note('copied', { reason: 'restart Typd', helperReady: false });
    check('one copy is not yet "broken"', !w.broken && broken === 0 && lines.length === 0);
    w.note('copied', { reason: 'restart Typd', helperReady: false });
    check('two in a row: broken, once, with the helper state and the reason', w.broken && broken === 1 && lines.length === 1 &&
      lines[0] === '2 dictations in a row were copied, not pasted (the paste helper is not running); the reason given: restart Typd', lines);
    w.note('copied', { helperReady: false });
    check('a third adds no second line', broken === 1 && lines.length === 1);
    w.note('pasted');
    check('a real paste clears it, once', !w.broken && fixed === 1 && lines[1] === 'paste works again: a dictation was pasted', lines);
    w.note('offered'); w.note('offered'); w.note('offered');
    check('"no text field" offers never count as paste failures', !w.broken && broken === 1 && w.run === 0);
    w.note('copied'); w.note('pasted'); w.note('copied');
    check('copies that are not in a row do not trip it', !w.broken && broken === 1);
  }

  section("\"Didn't catch that\", in counts");
  {
    check('fewer than 3 voiced frames: quiet', sc.caughtKind(0) === 'quiet' && sc.caughtKind(2) === 'quiet');
    check('3 or more: the model wrote nothing (empty)', sc.caughtKind(3) === 'empty' && sc.caughtKind(31) === 'empty');
    check('quiet line', sc.caughtLine({ kind: 'quiet', audioSeconds: 0.94, voiced: 1 }) === 'too quiet to be speech: 1 voiced 30 ms frame in 0.9 s of audio (a tap, or the microphone opened late)', sc.caughtLine({ kind: 'quiet', audioSeconds: 0.94, voiced: 1 }));
    check('empty line', sc.caughtLine({ kind: 'empty', audioSeconds: 1.4, voiced: 31 }) === 'the model wrote nothing for 1.4 s of audio with 31 voiced 30 ms frames');
    // The pipeline's own counter decides, the same one that throws (pipeline/index.js).
    const pipeSrc = read('src/main/pipeline/index.js');
    check('pipeline exports voicedFrames, the counter its silence gate throws on', /\r?\n  voicedFrames,\r?\n/.test(pipeSrc) && /if \(voicedFrames\(audio\) < 3\) throw new Error\("Didn't catch that"\)/.test(pipeSrc));
    check('selfcheck.caughtKind uses the same threshold (3)', /voiced < 3 \? 'quiet' : 'empty'/.test(read('src/main/selfcheck.js')));
  }

  section('how a run that never said goodbye ended');
  {
    const last = { pid: 1, started: '2026-10-25T21:25:35.976Z', alive: '2026-10-25T21:28:35.999Z' };
    check('Windows ended the session (marked in run.json)', /^Windows ended the session \(shutting down, restarting or signing out\) at 2026/.test(life.howEnded({ ...last, sessionEnd: '2026-10-25T21:28:50.000Z' }, {})));
    check('a crash dump: a crash', life.howEnded(last, { dumps: 1 }) === 'a crash: it left a crash dump (below)');
    check('the computer started up after it was last seen: shut down or restarted', /^the computer was shut down or restarted \(it started up again at 2026-10-25T21:40:00\.000Z\)$/.test(life.howEnded(last, { bootAt: Date.parse('2026-10-25T21:40:00Z') })), life.howEnded(last, { bootAt: Date.parse('2026-10-25T21:40:00Z') }));
    check('otherwise: the computer kept running, no dump -- something ended it', /^the computer kept running and no crash dump was left: something ended Typd \(Task Manager, a script, an installer\)/.test(life.howEnded(last, { bootAt: Date.parse('2026-10-20T08:00:00Z') })));
    check('no boot time known: the same, never a guess', /^the computer kept running/.test(life.howEnded(last, { bootAt: null })));
    const lsrc = read('src/main/lifelog.js'), idx = read('src/main/index.js');
    check('index.js marks session-end on every window it makes', /app\.on\('browser-window-created', \(_e, w\) => w\.on\('session-end', \(\) => life\.sessionEnding\(\)\)\)/.test(idx));
    check('the launch line still opens "last run ended without quitting" (older parsers)', /log\('last run ended without quitting', 'pid ' \+ last\.pid/.test(lsrc) && /howEnded\(last, \{ bootAt: bootTime\(\), dumps: left\.length \}\)/.test(lsrc));
  }

  section('Check for updates');
  {
    check('the answer in the log', sc.updatesAnswerLine({ outcome: 'current' }, { outcome: 'current' }, 312) === 'answer after 312 ms: Typd up to date, model up to date');
    check('... with why, when it could not check', sc.updatesAnswerLine({ outcome: 'offline', why: 'fetch failed' }, { outcome: 'busy' }, 40) === 'answer after 40 ms: Typd offline, model asked to wait (busy) (fetch failed)', sc.updatesAnswerLine({ outcome: 'offline', why: 'fetch failed' }, { outcome: 'busy' }, 40));
    check('an unknown answer reads as could not check', sc.updatesAnswerLine(null, { outcome: 'weird' }, 1) === 'answer after 1 ms: Typd could not check, model could not check');
    const at = sc.checkedAt('2026-10-30T19:18:56.202Z', { locale: 'en-GB' });
    check('"Checked at HH:MM." from the check\'s time', /^ Checked at \d{2}:\d{2}\.$/.test(at), at);
    check('no time, no words', sc.checkedAt(null) === '' && sc.checkedAt('nonsense') === '');
    const idx = read('src/main/index.js'), js = read('src/renderer/home.js');
    const fn = (idx.match(/async function checkForUpdates[\s\S]*?\n\}/) || [''])[0];
    check('checkForUpdates logs the answer with its time', /life\.log\('updates', selfcheck\.updatesAnswerLine\(a, m, Date\.now\(\) - t0\)\)/.test(fn));
    check('updatesInfo appends "Checked at" to an answer', /text \+= selfcheck\.checkedAt\(updatesUi\.at\);/.test((idx.match(/function updatesInfo[\s\S]*?\n\}/) || [''])[0]));
    check('Settings holds "Checking…" for a moment after a click', /var UPDATES_HOLD_MS = 700;/.test(js) && /updatesHoldUntil = Date\.now\(\) \+ UPDATES_HOLD_MS;/.test(js) && /if \(!u\.checking && Date\.now\(\) < updatesHoldUntil\)/.test(js));
  }

  section('the model\'s warm start');
  {
    check('ready line', sc.modelLine({ ok: true, ms: 7420, device: 'GPU', version: 'p2g_1p7b' }) === 'ready in 7.4 s on the GPU (p2g_1p7b)', sc.modelLine({ ok: true, ms: 7420, device: 'GPU', version: 'p2g_1p7b' }));
    check('a switch says so', sc.modelLine({ ok: true, ms: 3000, device: 'CPU', what: 'switch' }) === 'ready after a switch in 3.0 s on the CPU');
    check('failure line keeps one line of why', sc.modelLine({ ok: false, ms: 12000, why: 'Error: The dictation model took too long to start\nstack' }) === 'did not start after 12.0 s: Error: The dictation model took too long to start');
    const idx = read('src/main/index.js');
    check('warmModel and switchModel log it', (idx.match(/logModel\(true, Date\.now\(\) - t0, /g) || []).length === 2 && (idx.match(/logModel\(false, Date\.now\(\) - t0, /g) || []).length === 2);
  }

  section('the wiring');
  {
    const idx = read('src/main/index.js');
    check('launch: the paste helper is checked (not with --stub or --preview)', /if \(!stub && !preview\) checkPasteHelper\(\);/.test(idx));
    const cph = (idx.match(/function checkPasteHelper\(\) \{[\s\S]*?\n\}/) || [''])[0];
    check('... logged either way, tray + pill only when it is down, and on Windows only', /life\.log\('self-check', selfcheck\.helperLine\(r\)\)/.test(cph) &&
      /if \(r\.ready \|\| MAC\) return;/.test(cph) && /status\.set\(\{ paste: 'failed' \}\)/.test(cph) && /note\('Typd can’t paste right now/.test(cph));
    check('every landed dictation feeds the paste watch, with the helper state', /pasteWatch\.note\(result\.ok \? 'pasted' : result\.offered \? 'offered' : 'copied', \{ reason: result\.reason, helperReady: helperReady\(\) \}\);/.test(idx));
    check('a landed paste clears the tray line', /if \(result\.ok\) status\.set\(\{ paste: 'ok' \}\);/.test(idx));
    check('a failed dictation names why it was not caught', /life\.log\('dictation failed', life\.errorLine\(err\) \+ notCaught\(current, err\)\);/.test(idx));
    const nc = (idx.match(/function notCaught\(current, err\) \{[\s\S]*?\n\}/) || [''])[0];
    check('... and keeps its recording, marked failed, with no text', /current\.failed = kind;/.test(nc) && /keepRecording\(current, ''\)/.test(nc) && /failed: current\.failed/.test(idx));
    check('the backfill never shares a failed recording', /if \(meta && meta\.failed\) return \{ skip: /.test(read('src/main/backfill.js')));
    const wmt = (idx.match(/function watchMainThread\(\) \{[\s\S]*?\n\}/) || [''])[0];
    check('a sleep is not a stall: the late line waits 3 s for a power event', /setTimeout\(\(\) => \{ if \(Date\.now\(\) - lastWake > 6000\) life\.log\('main thread late'/.test(wmt));
  }

  section('the tray line');
  {
    // status.js is a module-level singleton: a fresh copy for this check.
    delete require.cache[require.resolve(path.join(root, 'src', 'main', 'status.js'))];
    const status = require(path.join(root, 'src', 'main', 'status.js'));
    status.set({ model: 'ready' });
    check('all well: ready', status.describe().state === 'ready');
    status.set({ paste: 'failed' });
    const d = status.describe();
    check('paste failed: the first line says so and how to paste', d.state === 'paste' && /^Paste isn't working — press (Ctrl\+V|⌘V) after you dictate$/.test(d.line) && d.icon === 'dim', d);
    status.set({ live: true });
    check('while dictating it still says Listening', status.describe().state === 'live');
    status.set({ live: false, model: 'failed', modelWhy: 'x' });
    check('a model that did not start outranks it', status.describe().state === 'model');
    status.set({ model: 'ready', paste: 'ok' });
    check('cleared: ready again', status.describe().state === 'ready');
  }

  section('privacy: the new lines carry counts and fixed words only');
  {
    const lines = [
      sc.helperLine({ ready: false, ms: 15000 }), sc.modelLine({ ok: true, ms: 1, device: 'GPU', version: 'v"<b>' }),
      sc.caughtLine({ kind: 'empty', audioSeconds: 2, voiced: 9 }), sc.updatesAnswerLine({ outcome: 'current' }, { outcome: 'current' }, 5)
    ];
    check('no quotes or markup get through (the version keeps [A-Za-z0-9._+-] only)', lines.every((l) => !/["<>]/.test(l)), lines);
    const idx = read('src/main/index.js');
    const calls = [...idx.matchAll(/life\.log\('self-check', ([^;]*)\);/g)].map((m) => m[1]);
    check('self-check log calls pass no text, context, span or title', calls.length >= 2 && calls.every((c) => !/\b(text|event\.text|output|span|context|contextBlock|title)\b/.test(c.replace(/'[^']*'/g, ''))), calls);
  }

  console.log('\n' + (failures ? failures + ' FAILED' : 'all self-check checks passed') + '\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
