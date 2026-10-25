'use strict';

/**
 * A dictation's microphone in main, capture.js (0.2.12): the helper's audio into the same session paths
 * the pill's page fed, and every fall back to the page.
 *
 *   node bench/mic-capture.js
 *
 * capture.js runs as index.js runs it, with mic.js and bench/fake-mic.js (the protocol, a ramp of known
 * samples) in place of typd-mic, and stand-ins for the overlay (what is sent to the pill) and the pipeline
 * (the live stream).
 *
 * 1. The helper's dictation: begin -> native; session:hearing once, on the first audio; session:level
 *    ~30 times a second with the RMS of the audio; the live stream gets every sample in order, in pieces of
 *    at least 1,024 (the page's block); end -> the whole recording, exactly the samples delivered, in
 *    order, at 16 kHz; then hold with the warm window. Revision: the same recording, no stream.
 *    The life log's timing: "helper", then "helper (warm)" for a dictation inside the warm window.
 * 2. Silence through the helper: exact zeros -> "silent" once, after 24,576 samples (= the page's 24
 *    blocks), on Windows; on a Mac the page takes over instead and the helper is not used again in the run.
 *    A single non-zero sample: never silent.
 * 3. Fall backs: no helper file, a Mac before macOS has said yes, Windows' privacy switch off, a Settings
 *    microphone the helper does not know -> the page captures from the start (session:start native false;
 *    its chunks feed the stream, its recording is the recording); an error on open, the helper exiting
 *    mid-dictation, no audio in 3 s -> session:mic-fallback, one life-log line, the page's chunks then feed
 *    the stream and the recording is the helper's part followed by the page's.
 * 4. Choosing the device: a Settings label with Chromium's USB suffix opens that device's id; no label,
 *    the default (no id).
 * 5. Cancel: stop -> hold, nothing delivered after; a superseded session's audio never reaches the next.
 * 6. Sources: index.js wires begin/end/stop/rendererChunk/rendererAudio and the helper's start and quit;
 *    the page starts its own capture only when told (native false, or the fall back) and hands over a
 *    recording only when it captured; the start cue plays with the first audio; the preload lets the three
 *    new channels through.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const micJs = require(path.join(root, 'src', 'main', 'mic.js'));
const { createCapture, SILENT_SAMPLES } = require(path.join(root, 'src', 'main', 'capture.js'));
const FAKE = path.join(__dirname, 'fake-mic.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 3000) => { const t = performance.now(); while (!pred() && performance.now() - t < ms) await sleep(5); return pred(); };
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (ok || detail === undefined ? '' : '  -- ' + JSON.stringify(detail).slice(0, 400)));
  if (!ok) failures++;
}
function section(t) { console.log('\n' + t); }

/** capture.js + mic.js + the fake helper, as index.js wires them. */
async function rig(mode, o = {}) {
  const sentLog = path.join(os.tmpdir(), 'typd-fake-mic-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.log');
  const life = [];
  const mic = o.noHelper ? micJs.createNativeMic({ exe: path.join(os.tmpdir(), 'no-typd-mic'), log: (l) => life.push(l) }) : micJs.createNativeMic({
    exe: FAKE, log: (l) => life.push(l), warmMs: o.warmMs || 45000,
    spawn: (_e, _a, opts) => spawn(process.execPath, [FAKE], { ...opts, env: { ...process.env, FAKE_MIC_MODE: mode, FAKE_MIC_LOG: sentLog, ...(o.env || {}) } })
  });
  mic.start();
  if (!o.noHelper) { await until(() => mic.usable()); await mic.list(); }
  const sent = [], problems = [], streams = [];
  const settings = { mic: o.id || '', micLabel: o.label || '' };
  const capture = createCapture({
    mic, isMac: Boolean(o.mac),
    send: (c, p) => sent.push({ c, p, at: performance.now() }),
    log: (l) => life.push(l),
    macMicGranted: () => o.macGranted !== false,
    privacyBlocked: () => Boolean(o.blocked),
    settings: { id: () => settings.mic, label: () => settings.micLabel },
    openStream: (cur) => { const s = { pushes: [], push(x) { this.pushes.push(x); } }; streams.push(s); return s; },
    problem: (cur, kind, why) => problems.push({ kind, why })
  });
  const session = (mode2 = 'dictate') => ({ mode: mode2, controller: new AbortController(), stream: undefined });
  return {
    mic, capture, sent, problems, streams, life, settings, session,
    commands: () => { try { return fs.readFileSync(sentLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    done: () => mic.quit()
  };
}

const ramp = (k) => ((k % 1000) + 1) / 2000;   // fake-mic.js's sample k
function isRamp(a, from = 0) { for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - ramp(from + i)) > 1e-7) return false; return true; }
const cat = (list) => { const n = list.reduce((s, x) => s + x.length, 0); const o = new Float32Array(n); let at = 0; for (const x of list) { o.set(x, at); at += x.length; } return o; };

async function nativeSection() {
  section('1. a dictation through the helper');
  const r = await rig('ok', { warmMs: 2000 });
  const cur = r.session();
  const how = r.capture.begin(cur);
  check('begin: native', how.native === true);
  await until(() => r.sent.some((s) => s.c === 'session:hearing'));
  await sleep(600);
  const hearing = r.sent.filter((s) => s.c === 'session:hearing');
  check('session:hearing once, on the first audio', hearing.length === 1);
  const levels = r.sent.filter((s) => s.c === 'session:level');
  const span = (levels[levels.length - 1].at - levels[0].at) / 1000;
  check('session:level ~30 times a second', levels.length >= 10 && levels.length / span > 18 && levels.length / span < 40, { n: levels.length, perS: levels.length / span });
  const meanRms = levels.reduce((s, l) => s + l.p.rms, 0) / levels.length;
  check('... the RMS of the audio (the ramp\'s, ~0.29 on average)', levels.every((l) => l.p.rms > 0 && l.p.rms <= 0.5) && Math.abs(meanRms - 0.29) < 0.08, { meanRms, first: levels.slice(0, 3).map((l) => l.p) });
  const audio = await r.capture.end(cur);
  const s = r.streams[0];
  const streamed = cat(s.pushes);
  check('end: the recording, 16 kHz', audio && audio.sampleRate === 16000 && audio.samples.length > 2000, audio && audio.samples.length);
  check('... exactly the delivered samples, in order (the ramp from sample 0)', audio && isRamp(audio.samples, 0));
  check('the live stream: every sample, in order', streamed.length === audio.samples.length && isRamp(streamed, 0), { streamed: streamed.length, recorded: audio.samples.length });
  check('... in pieces of at least 1,024 but the last', s.pushes.slice(0, -1).every((p) => p.length >= 1024), s.pushes.map((p) => p.length).slice(0, 8));
  await sleep(150);
  const cmds = r.commands();
  check('end: sync, then hold with the warm window', cmds.some((c) => c.cmd === 'sync') && cmds[cmds.length - 1].cmd === 'hold' && cmds[cmds.length - 1].ms === 2000, cmds.slice(-3));
  const t1 = r.capture.timing(cur);
  check('timing: "helper", a first-audio time', t1.how === 'helper' && t1.firstMs >= 0 && t1.firstMs < 1000, t1);

  // A revision inside the warm window.
  const rev = r.session('revise');
  check('a revision: native', r.capture.begin(rev).native === true);
  await sleep(300);
  const a2 = await r.capture.end(rev);
  check('... the recording, no live stream', a2 && a2.samples.length > 800 && r.streams.length === 1 && rev.stream === undefined, { n: a2 && a2.samples.length, streams: r.streams.length });
  check('... timing "helper (warm)" (the device was still open)', r.capture.timing(rev).how === 'helper (warm)', r.capture.timing(rev));
  r.done();
}

async function silenceSection() {
  section('2. exact zeros through the helper');
  {
    const r = await rig('zeros');
    const cur = r.session();
    r.capture.begin(cur);
    await until(() => r.problems.length, 4000);
    const delivered = r.capture.timing(cur);
    check('Windows: "silent" (from the helper), once', r.problems.length === 1 && r.problems[0].kind === 'silent' && r.problems[0].why === 'helper', r.problems);
    check('... after 24,576 samples (= the page\'s 24 blocks of 1,024)', SILENT_SAMPLES === 24576 && cur.capture.zeros >= SILENT_SAMPLES && cur.capture.zeros < SILENT_SAMPLES + 2000, cur.capture.zeros);
    await sleep(300);
    check('... and no second report', r.problems.length === 1);
    void delivered;
    r.capture.stop(cur);
    r.done();
  }
  {
    const r = await rig('zeros', { mac: true });
    const cur = r.session();
    r.capture.begin(cur);
    await until(() => r.sent.some((s) => s.c === 'session:mic-fallback'), 4000);
    check('a Mac: no "silent" from the helper; the page takes over (session:mic-fallback)', !r.problems.length && r.sent.some((s) => s.c === 'session:mic-fallback'), r.problems);
    check('... and the helper is not used again in this run', r.capture.nativeOff && r.capture.begin(r.session()).native === false, r.capture.nativeOff);
    r.done();
  }
  {
    // One sound sample among zeros: never silent. Driven by hand through onNative's path (fake: ramp).
    const r = await rig('ok');
    const cur = r.session();
    r.capture.begin(cur);
    await sleep(1800);
    check('a real signal: never "silent"', !r.problems.length && cur.capture.heard === true);
    r.capture.stop(cur);
    r.done();
  }
}

async function fallbackSection() {
  section('3. the page\'s capture: from the start, and mid-dictation');
  const pageChunk = (n, v) => { const a = new Float32Array(n); a.fill(v); return a; };
  for (const [name, mode, o] of [
    ['no helper file', 'ok', { noHelper: true }],
    ['a Mac before macOS has said yes', 'ok', { mac: true, macGranted: false }],
    ['Windows\' privacy switch off', 'ok', { blocked: true }],
    ['a Settings microphone the helper does not know', 'ok', { id: 'chromium-id', label: 'Yeti Stereo Microphone' }]
  ]) {
    const r = await rig(mode, o);
    const cur = r.session();
    const how = r.capture.begin(cur);
    r.capture.rendererChunk(cur, pageChunk(1024, 0.1));
    r.capture.rendererChunk(cur, pageChunk(1024, 0.2));
    const end = await r.capture.end(cur);
    const rec = r.capture.rendererAudio(cur, pageChunk(2048, 0.3));
    const opens = r.commands().filter((c) => c.cmd === 'open').length;
    check(name + ': the page captures (native false), no open sent to the helper', how.native === false && opens === 0, { how, opens });
    check('... its chunks feed the stream; end() leaves the recording to the page; rendererAudio is it', r.streams[0] && r.streams[0].pushes.length === 2 && end === null && rec && rec.samples.length === 2048 && rec.samples[0] === Math.fround(0.3));
    check('... timing "Chromium"', r.capture.timing(cur).how === 'Chromium' && r.capture.timing(cur).firstMs >= 0, r.capture.timing(cur));
    if (name.startsWith('a Settings')) check('... said once in the life log', r.life.filter((l) => /not in the helper's list/.test(l)).length === 1 && (r.capture.begin(r.session()), r.life.filter((l) => /not in the helper's list/.test(l)).length === 1), r.life);
    r.done();
  }

  for (const [name, mode, env, wait] of [
    ['an error on open', 'error-on-open', {}, 1500],
    ['the helper exiting mid-dictation', 'exit-after', { FAKE_MIC_AFTER: '3200' }, 2000],
    ['no audio within 3 s', 'no-audio', {}, 4500]
  ]) {
    const r = await rig(mode, { env });
    const cur = r.session();
    const how = r.capture.begin(cur);
    await until(() => r.sent.some((s) => s.c === 'session:mic-fallback'), wait);
    const fb = r.sent.filter((s) => s.c === 'session:mic-fallback');
    const nativePart = cur.capture.total;
    check(name + ': native at first, then session:mic-fallback once', how.native === true && fb.length === 1, { how, fb: fb.length });
    check('... one life-log line: "helper ...: this dictation uses Chromium\'s capture"', r.life.filter((l) => /this dictation uses Chromium's capture/.test(l)).length === 1, r.life);
    r.capture.rendererChunk(cur, pageChunk(1024, 0.25));
    const end = await r.capture.end(cur);
    const rec = r.capture.rendererAudio(cur, pageChunk(4096, 0.25));
    const streamed = r.streams.length ? cat(r.streams[0].pushes) : new Float32Array(0);
    check('... the page\'s chunks feed the stream after the helper\'s part', streamed.length === nativePart + 1024 && isRamp(streamed.subarray(0, nativePart), 0) && streamed[nativePart] === 0.25, { streamed: streamed.length, nativePart });
    check('... the recording: the helper\'s part, then the page\'s', end === null && rec.samples.length === nativePart + 4096 && isRamp(rec.samples.subarray(0, nativePart), 0) && rec.samples[nativePart] === 0.25, { n: rec.samples.length, nativePart });
    check('... timing "helper, then Chromium"', r.capture.timing(cur).how === 'helper, then Chromium');
    r.done();
  }
}

async function deviceSection() {
  section('4. which device the helper opens');
  {
    const r = await rig('ok', { id: 'hash', label: 'Microphone (USB Audio Device) (0d8c:0014)' });
    const cur = r.session();
    r.capture.begin(cur);
    await sleep(100);
    const open = r.commands().find((c) => c.cmd === 'open');
    check('a Settings label with Chromium\'s USB suffix: that device\'s id', open && open.id === '{0.0.1.00000000}.{bbbb}' && open.name === 'Microphone (USB Audio Device)', open);
    r.capture.stop(cur);
    r.done();
  }
  {
    const r = await rig('ok');
    const cur = r.session();
    r.capture.begin(cur);
    await sleep(100);
    const open = r.commands().find((c) => c.cmd === 'open');
    check('no microphone chosen: the default (no id, no name)', open && open.id === undefined && open.name === undefined, open);
    r.capture.stop(cur);
    r.done();
  }
}

async function cancelSection() {
  section('5. cancel and supersede');
  const r = await rig('ok');
  const a = r.session();
  r.capture.begin(a);
  await sleep(300);
  r.capture.stop(a);
  const n = a.capture.total;
  await sleep(200);
  check('stop: hold sent; nothing more delivered to the stopped session', r.commands().some((c) => c.cmd === 'hold') && a.capture.total === n, { before: n, after: a.capture.total });
  const b = r.session();
  r.capture.begin(b);
  await sleep(300);
  const audio = await r.capture.end(b);
  check('the next session gets only its own audio (from its sample 0)', audio && isRamp(audio.samples, 0) && a.capture.total === n);
  r.done();

  // The helper gone while the dictation's last samples are fetched: no fall back to the page (it would
  // record after the key was let go); the recording is what the helper delivered.
  const r2 = await rig('ok');
  const c = r2.session();
  r2.capture.begin(c);
  await sleep(300);
  const ending = r2.capture.end(c);
  r2.mic.quit();
  const got = await ending;
  check('the helper gone during end: no session:mic-fallback, the helper\'s recording kept', !r2.sent.some((s) => s.c === 'session:mic-fallback') && got && got.samples.length > 0 && isRamp(got.samples, 0), got && got.samples.length);
}

function sourcesSection() {
  section('6. the sources');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const index = read('src/main/index.js'), page = read('src/renderer/overlay.js'), pre = read('src/preload/overlay.js');
  check('index.js: capture.begin before session:start, which carries native', /const opened = capture\.begin\(current\);[\s\S]{0,400}send\('session:start', \{ mode: current\.mode, native: opened\.native \}\)/.test(index));
  check('index.js: capture.end at capture-end feeds current.audio / onAudio', /send\('session:capture-end', \{\}\);[\s\S]{0,300}capture\.end\(current\)\.then\(\(audio\) => \{[\s\S]{0,120}current\.audio = audio;[\s\S]{0,60}current\.onAudio\(audio\)/.test(index));
  check('index.js: capture.stop on cancel, supersede and a dead microphone', (index.match(/capture\.stop\(session\)/g) || []).length >= 3);
  check('index.js: overlay:chunk and overlay:audio go through capture.js', /capture\.rendererChunk\(current,/.test(index) && /capture\.rendererAudio\(session, samples\)/.test(index));
  check('index.js: the helper starts at launch (not for --preview) and quits with Typd', /if \(!preview\) mic\.start\(\);/.test(index) && /mic\.quit\(\);/.test(index));
  check('index.js: TYPD_MIC=chromium turns the helper off', /process\.env\.TYPD_MIC === 'chromium' \? null/.test(index));
  check('the page: startMic only when not native, or on session:mic-fallback', /if \(!native\) startMic\(\);/.test(page) && /'session:mic-fallback'[\s\S]{0,200}startMic\(\);/.test(page) && (page.match(/startMic\(\);/g) || []).length === 2);
  check('the page: a recording only when it captured (owned)', /if \(!deliver \|\| !had\) \{ chunks = \[\]; return; \}/.test(page));
  check('the page: the start cue with the first audio, not at the key', /function markHearing\(\)[\s\S]{0,200}play\('start'\)/.test(page) && !/setState\('listening'\);\s*reportHits\(\);\s*window\.typdSound\.play\('start'\)/.test(page));
  check('the preload lets session:hearing, session:level and session:mic-fallback through', ['session:hearing', 'session:level', 'session:mic-fallback'].every((c) => pre.includes("'" + c + "'")));
}

(async () => {
  await nativeSection();
  await silenceSection();
  await fallbackSection();
  await deviceSection();
  await cancelSection();
  sourcesSection();
  console.log(failures ? `\n${failures} check(s) failed` : '\na dictation\'s microphone in main: all checks passed');
  process.exit(failures ? 1 : 0);
})();
