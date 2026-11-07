'use strict';

/**
 * The microphone helper, typd-mic, and main's side of it, mic.js (0.2.12).
 *
 *   node bench/mic-helper.js              protocol + client; a real microphone if this machine has one
 *   TYPD_MIC_BENCH_DEVICE=0               never open a real device (CI without a microphone)
 *   TYPD_MIC_BENCH_DEVICE=1               open one even on a Mac (the Mac CI's informational step)
 *   TYPD_MIC_BENCH_SILENT_DEVICE=<name>   also: exact-zero capture through the real helper from a device that
 *                                         delivers digital silence (Windows' "Stereo Mix" with nothing playing)
 *
 * 1. The real helper (vendor/mic, vendor/mic-mac/<arch>; skipped with a note if it is not built): hello,
 *    --version, list, a bad line answered with an error and the helper still alive, close with nothing
 *    open. With a microphone: open -> opened + first-audio + audio of that capture only, ~16,000 samples
 *    a second, every frame well formed; sync answered after the audio before it; hold: NOT ONE audio byte
 *    while held (the warm window's audio never leaves the helper), the device closed by itself when the
 *    window ends ("warm window over") at about the time asked; a second open inside the window is "warm"
 *    and hears within 100 ms; a third open after the window is a cold open again; close; stdin closing
 *    ends the helper.
 * 2. mic.js against the real helper: start -> usable; a capture's onFirst/onAudio; sync; release = hold
 *    with the warm window; a capture never gets another capture's audio.
 * 3. mic.js against bench/fake-mic.js (the fall backs): no helper file -> not usable, open() null, said in
 *    the log; error on open -> onFail; exits on open -> onFail, started again, and after MAX_RESTARTS not
 *    used again; no audio within OPEN_TIMEOUT_MS -> onFail; garbage on stdout -> the helper is dropped;
 *    no hello -> never usable; quit ends it. pickDevice: exact name, Chromium's " (vid:pid)" and macOS
 *    transport suffixes, ambiguity and unknown names.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const micJs = require(path.join(root, 'src', 'main', 'mic.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0, skipped = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (ok || detail === undefined ? '' : '  -- ' + JSON.stringify(detail).slice(0, 400)));
  if (!ok) failures++;
}
function skip(name, why) { skipped++; console.log('  skip  ' + name + ' -- ' + why); }
function section(t) { console.log('\n' + t); }

const exe = micJs.helperPath({ packaged: false, root });
const FAKE = path.join(__dirname, 'fake-mic.js');

/** The real helper, driven raw: every frame recorded with its arrival time. */
function raw() {
  const p = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const parser = micJs.createParser();
  const h = { p, frames: [], audioBytes: 0, bad: null, exited: null, t0: performance.now() };
  p.stdout.on('data', (c) => {
    try {
      for (const f of parser.push(c)) {
        f.at = performance.now();
        if (f.type === 'A') h.audioBytes += f.samples.length * 4;
        h.frames.push(f);
      }
    } catch (err) { h.bad = String(err.message); }
  });
  p.on('exit', (code) => { h.exited = code; });
  h.send = (o) => p.stdin.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
  h.wait = async (pred, ms = 3000) => { const end = performance.now() + ms; while (performance.now() < end) { const f = h.frames.find(pred); if (f) return f; await sleep(5); } return null; };
  h.status = (ev, extra = () => true) => h.wait((f) => f.type === 'S' && f.status.ev === ev && extra(f.status));
  return h;
}

async function realHelper() {
  section('1. the real helper (' + path.relative(root, exe) + ')');
  if (!fs.existsSync(exe)) { skip('the real helper', 'not built here (node scripts/build-mic.js ' + (process.platform === 'darwin' ? 'mac' : 'win') + ')'); return { device: false }; }
  const v = spawnSync(exe, ['--version'], { encoding: 'utf8' });
  check('--version: typd-mic 1.0.0 with miniaudio 0.11.25', v.status === 0 && /^typd-mic 1\.0\.0 \(miniaudio 0\.11\.25\)/.test(v.stdout), v.stdout);

  const h = raw();
  const hello = await h.status('hello');
  check('hello within 3 s, the platform\'s backend', hello && hello.status.backend === (process.platform === 'darwin' ? 'Core Audio' : 'WASAPI'), hello && hello.status);
  h.send({ cmd: 'list' });
  const list = await h.status('devices');
  check('list: devices, each with an id and a name', list && Array.isArray(list.status.list) && list.status.list.every((d) => typeof d.id === 'string' && typeof d.name === 'string'), list && list.status);
  const devices = list ? list.status.list : [];
  h.send('this is not json');
  const err = await h.status('error', (s) => s.stage === 'command');
  h.send({ cmd: 'list' });
  const again = await h.wait((f) => f.type === 'S' && f.status.ev === 'devices' && f !== list);
  check('a bad line: an error status, and the helper keeps answering', Boolean(err && again), err && err.status);
  h.send({ cmd: 'close' });
  check('close with nothing open: "not open"', Boolean(await h.status('closed', (s) => s.why === 'not open')));

  const want = process.env.TYPD_MIC_BENCH_DEVICE;
  const useDevice = want === '1' || (want !== '0' && process.platform !== 'darwin' && devices.length > 0);
  if (!useDevice) {
    skip('capture from a real microphone', want === '0' ? 'TYPD_MIC_BENCH_DEVICE=0' : devices.length ? 'a Mac (macOS would ask for this terminal\'s microphone): TYPD_MIC_BENCH_DEVICE=1 to open one' : 'no capture device on this machine');
  } else {
    // A cold open of the default microphone.
    const tOpen = performance.now();
    h.send({ cmd: 'open', gen: 7 });
    const opened = await h.status('opened', (s) => s.gen === 7);
    const first = await h.status('first-audio', (s) => s.gen === 7);
    const a1 = await h.wait((f) => f.type === 'A' && f.gen === 7);
    check('open: "opened" and "first-audio" for capture 7', Boolean(opened && first), { opened: opened && opened.status, first: first && first.status });
    if (opened) console.log(`        ${opened.status.name}: ${opened.status.deviceRate} Hz x ${opened.status.deviceChannels} -> 16000 Hz mono; first audio ${(a1 ? a1.at - tOpen : NaN).toFixed(0)} ms after the open (helper: ${first ? first.status.ms : '?'} ms)`);
    check('first audio within 1 s of a cold open', a1 && a1.at - tOpen < 1000, a1 && a1.at - tOpen);
    await sleep(1000);
    const mine = h.frames.filter((f) => f.type === 'A');
    const n = mine.reduce((s, f) => s + f.samples.length, 0);
    const span = (mine[mine.length - 1].at - mine[0].at) / 1000;
    check('every audio frame is capture 7\'s', mine.every((f) => f.gen === 7), mine.map((f) => f.gen).slice(0, 5));
    check('~16,000 samples a second (16 kHz mono)', span > 0.5 && Math.abs(n / span - 16000) < 2400, { samples: n, seconds: span });
    check('samples are finite and in [-1, 1]', mine.every((f) => f.samples.every((x) => Number.isFinite(x) && x >= -1.0001 && x <= 1.0001)));

    h.send({ cmd: 'sync', gen: 7 });
    const synced = await h.status('synced', (s) => s.gen === 7);
    const lastAudio = h.frames.filter((f) => f.type === 'A').pop();
    check('sync answered, after the audio captured before it', synced && lastAudio && h.frames.indexOf(synced) > h.frames.indexOf(mine[mine.length - 1]), Boolean(synced));

    // The warm window: hold 1200 ms.
    h.send({ cmd: 'hold', ms: 1200 });
    const held = await h.status('held');
    const tHeld = held ? held.at : performance.now();
    const bytesAtHeld = h.audioBytes;
    check('hold: "held", device still open', held && held.status.open === true, held && held.status);
    await sleep(700);
    check('not one audio byte written while held (the warm window\'s audio never leaves the helper)', h.audioBytes === bytesAtHeld, h.audioBytes - bytesAtHeld);

    // A second capture inside the window: warm.
    const tWarm = performance.now();
    h.send({ cmd: 'open', gen: 8 });
    const o8 = await h.status('opened', (s) => s.gen === 8);
    const a8 = await h.wait((f) => f.type === 'A' && f.gen === 8);
    check('a second open inside the window is "warm"', o8 && o8.status.how === 'warm', o8 && o8.status);
    check('... and hears within 100 ms', a8 && a8.at - tWarm < 100, a8 && a8.at - tWarm);
    if (a8) console.log(`        warm: first audio ${(a8.at - tWarm).toFixed(1)} ms after the open`);
    check('no capture 7 audio after capture 8 began', !h.frames.some((f) => f.type === 'A' && f.gen === 7 && f.at > (o8 ? o8.at : 0) + 50));

    // Hold 500 ms and let it run out.
    h.send({ cmd: 'hold', ms: 500 });
    const held2 = await h.status('held', (s) => s.ms === 500);
    const closed = await h.wait((f) => f.type === 'S' && f.status.ev === 'closed' && f.status.why === 'warm window over', 3000);
    const after = closed && held2 ? closed.at - held2.at : null;
    check('the device closes by itself when the warm window is over', Boolean(closed), after);
    check('... at about the time asked (500 ms, within 450-900)', after !== null && after >= 450 && after <= 900, after);
    const bytesAtClose = h.audioBytes;

    const tCold = performance.now();
    h.send({ cmd: 'open', gen: 9 });
    const o9 = await h.status('opened', (s) => s.gen === 9);
    const a9 = await h.wait((f) => f.type === 'A' && f.gen === 9);
    check('after the window, an open is a cold open again', o9 && o9.status.how !== 'warm', o9 && o9.status);
    if (a9) console.log(`        cold again: first audio ${(a9.at - tCold).toFixed(0)} ms after the open`);
    check('nothing was written between the close and this open', h.frames.filter((f) => f.type === 'A' && f.at < (o9 ? o9.at : 0) && f.at > (closed ? closed.at : 0)).length === 0 && bytesAtClose <= h.audioBytes);
    h.send({ cmd: 'close' });
    check('close: "closed"', Boolean(await h.status('closed', (s) => s.why === 'closed')));

    // Open by name, and by an id that does not exist (falls back to the default, and says so).
    const named = devices.find((d) => d.default) || devices[0];
    h.send({ cmd: 'open', gen: 10, name: named.name });
    const o10 = await h.status('opened', (s) => s.gen === 10);
    check('open by name: that device', o10 && o10.status.name === named.name && o10.status.how === 'name', o10 && o10.status);
    h.send({ cmd: 'open', gen: 11, id: 'no-such-device', name: 'No Such Microphone' });
    const o11 = await h.status('opened', (s) => s.gen === 11);
    check('an unknown id and name: the default device, said so', o11 && /not found/.test(o11.status.how), o11 && o11.status);
    h.send({ cmd: 'close' });
    await h.status('closed', (s) => s.why === 'closed');

    if (process.env.TYPD_MIC_BENCH_SILENT_DEVICE) await silentDevice(h, devices, process.env.TYPD_MIC_BENCH_SILENT_DEVICE);
  }
  check('no bad frame from the helper', !h.bad, h.bad);
  const tq = performance.now();
  h.p.stdin.end();
  while (h.exited === null && performance.now() - tq < 3000) await sleep(10);
  check('stdin closing ends the helper (Typd gone: the device closes with it)', h.exited === 0, h.exited);
  return { device: useDevice, devices };
}

/** Exact zeros through the real helper, then through mic.js + capture.js: the "silent" problem. */
async function silentDevice(h, devices, name) {
  const d = devices.find((x) => x.name === name);
  if (!d) { skip('silent device', name + ' is not in the list'); return; }
  h.send({ cmd: 'open', gen: 20, id: d.id, name: d.name });
  await h.status('opened', (s) => s.gen === 20);
  await sleep(1800);
  h.send({ cmd: 'close' });
  await h.status('closed', (s) => s.why === 'closed');
  const fr = h.frames.filter((f) => f.type === 'A' && f.gen === 20);
  const n = fr.reduce((s, f) => s + f.samples.length, 0);
  const zeros = fr.every((f) => f.samples.every((x) => x === 0));
  if (!zeros) { skip('silent device', name + ' delivered sound (something is playing): not digital silence'); return; }
  check(`"${name}": ${n} samples, every one exactly 0, through the real helper`, n > 16000);
  const { createCapture } = require(path.join(root, 'src', 'main', 'capture.js'));
  const mic = micJs.createNativeMic({ exe, warmMs: 0 });
  mic.start();
  for (let i = 0; i < 200 && !mic.usable(); i++) await sleep(10);
  await mic.list();
  const sent = [], problems = [];
  const cap = createCapture({ mic, send: (c, p) => sent.push(c), settings: { id: () => 'x', label: () => name }, openStream: () => null, problem: (cur, kind, why) => problems.push(kind + '/' + why) });
  const cur = { mode: 'dictate', controller: new AbortController() };
  const r = cap.begin(cur);
  const t = performance.now();
  while (!problems.length && performance.now() - t < 4000) await sleep(10);
  check('capture.js through the real helper: native, then "silent" after ~1.5 s of exact zeros', r.native && problems[0] === 'silent/helper', { r, problems, ms: performance.now() - t });
  cap.stop(cur);
  mic.quit();
}

async function clientReal(info) {
  section('2. mic.js with the real helper');
  if (!fs.existsSync(exe)) { skip('mic.js with the real helper', 'not built'); return; }
  const log = [];
  const mic = micJs.createNativeMic({ exe, log: (l) => log.push(l), warmMs: 800 });
  mic.start();
  for (let i = 0; i < 300 && !mic.usable(); i++) await sleep(10);
  check('start -> usable, the helper said hello', mic.usable() && mic.info && /^1\./.test(mic.info.version), mic.info);
  check('"helper ready" in the life log', log.some((l) => /^helper ready \(typd-mic 1\./.test(l)), log);
  const list = await mic.list();
  check('list() resolves with the helper\'s devices', Array.isArray(list));
  if (!info.device) { skip('a capture through mic.js', 'no real microphone in this run'); mic.quit(); return; }
  const got = [];
  let first = null, failed = null;
  const c = mic.open(null, { onAudio: (s) => got.push(s), onFirst: (ms) => { first = ms; }, onFail: (w) => { failed = w; } });
  const t = performance.now();
  while (first === null && performance.now() - t < 2000) await sleep(5);
  check('open(default): onFirst within 1 s', first !== null && first < 1000, first);
  await sleep(500);
  const ok = await mic.sync(c);
  const n = got.reduce((s, x) => s + x.length, 0);
  check('sync(): true; ~0.5 s of audio delivered', ok && n > 6000, { ok, n });
  mic.release(c);
  const before = got.length;
  await sleep(300);
  check('release(): nothing more delivered to that capture', got.length === before && !failed, { more: got.length - before, failed });
  check('the device is open in the warm window', mic.deviceOpen === true);
  const got2 = [];
  let first2 = null;
  const c2 = mic.open(null, { onAudio: (s) => got2.push(s), onFirst: (ms) => { first2 = ms; } });
  const t2 = performance.now();
  while (first2 === null && performance.now() - t2 < 1000) await sleep(2);
  check('a capture inside the warm window: warm, first audio within 100 ms', c2.warm === true && first2 !== null && first2 < 100, { warm: c2.warm, first2 });
  mic.release(c2);
  await sleep(1300);
  check('after the warm window (800 ms here) the helper has closed the device', mic.deviceOpen === false);
  mic.quit();
}

function fakeMic(mode, extra = {}) {
  const log = [];
  const sentLog = path.join(os.tmpdir(), 'typd-fake-mic-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.log');
  const mic = micJs.createNativeMic({
    exe: FAKE, log: (l) => log.push(l), warmMs: extra.warmMs || 45000,
    spawn: (_exe, _args, opts) => spawn(process.execPath, [FAKE], { ...opts, env: { ...process.env, FAKE_MIC_MODE: mode, FAKE_MIC_LOG: sentLog, ...(extra.env || {}) } })
  });
  return { mic, log, sent: () => { try { return fs.readFileSync(sentLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } } };
}
const until = async (pred, ms = 3000) => { const t = performance.now(); while (!pred() && performance.now() - t < ms) await sleep(5); return pred(); };

async function fallbacks() {
  section('3. mic.js fall backs (bench/fake-mic.js)');
  {
    const log = [];
    const mic = micJs.createNativeMic({ exe: path.join(os.tmpdir(), 'no-such-typd-mic.exe'), log: (l) => log.push(l) });
    mic.start();
    check('no helper file: not usable, open() is null, the log says Chromium\'s capture', !mic.usable() && mic.open(null, {}) === null && /helper missing.*Chromium/.test(log[0] || ''), log);
  }
  {
    const f = fakeMic('error-on-open');
    f.mic.start();
    await until(() => f.mic.usable());
    let failed = null;
    f.mic.open(null, { onAudio() {}, onFail: (w) => { failed = w; } });
    await until(() => failed);
    check('an error on open: onFail("error: ...") and a line in the life log', /^error: Failed to open/.test(failed || '') && f.log.some((l) => /^helper error: open/.test(l)), { failed, log: f.log });
    f.mic.quit();
  }
  {
    const f = fakeMic('exit-on-open');
    f.mic.start();
    await until(() => f.mic.usable());
    const fails = [];
    for (let i = 0; i <= micJs.MAX_RESTARTS; i++) {
      await until(() => f.mic.usable(), 3000);
      const c = f.mic.open(null, { onAudio() {}, onFail: (w) => fails.push(w) });
      if (!c) break;
      await until(() => fails.length > i, 3000);
    }
    check('a helper that exits: onFail("exited ...") each time', fails.length === micJs.MAX_RESTARTS + 1 && fails.every((w) => /^exited/.test(w)), fails);
    check('... started again ' + micJs.MAX_RESTARTS + ' times, then not used again in this run', f.log.filter((l) => /starting it again/.test(l)).length === micJs.MAX_RESTARTS && /not used again/.test(f.log[f.log.length - 1]) && !f.mic.usable() && f.mic.open(null, {}) === null, f.log);
  }
  {
    const f = fakeMic('no-audio');
    f.mic.start();
    await until(() => f.mic.usable());
    let failed = null;
    const t = performance.now();
    f.mic.open(null, { onAudio() {}, onFail: (w) => { failed = w; } });
    await until(() => failed, micJs.OPEN_TIMEOUT_MS + 2000);
    const ms = performance.now() - t;
    check(`no audio within ${micJs.OPEN_TIMEOUT_MS} ms: onFail`, /^no audio/.test(failed || '') && ms >= micJs.OPEN_TIMEOUT_MS - 50 && ms < micJs.OPEN_TIMEOUT_MS + 1000, { failed, ms });
    f.mic.quit();
  }
  {
    const f = fakeMic('garbage');
    f.mic.start();
    await sleep(400);
    check('garbage on stdout: the helper is dropped (never usable), and the log says why', !f.mic.usable() && f.log.some((l) => /bad frame/.test(l)), f.log);
    f.mic.quit();
  }
  {
    const f = fakeMic('no-hello');
    f.mic.start();
    await sleep(400);
    check('no hello: never usable (Chromium\'s capture)', !f.mic.usable() && f.mic.open(null, {}) === null);
    f.mic.quit();
  }
  {
    const f = fakeMic('ok', { warmMs: 1234 });
    f.mic.start();
    await until(() => f.mic.usable());
    const got = [];
    const c = f.mic.open({ id: '{0.0.1.00000000}.{bbbb}', name: 'Microphone (USB Audio Device)' }, { onAudio: (s) => got.push(s) });
    await until(() => got.length > 3);
    await f.mic.sync(c);
    f.mic.release(c);
    await sleep(150);
    const sent = f.sent();
    check('open sends the id and the name; release sends hold with the warm window', sent.some((m) => m.cmd === 'open' && m.id === '{0.0.1.00000000}.{bbbb}' && m.name === 'Microphone (USB Audio Device)') && sent.some((m) => m.cmd === 'hold' && m.ms === 1234), sent);
    check('the default warm window is 30-60 s', micJs.WARM_MS >= 30000 && micJs.WARM_MS <= 60000, micJs.WARM_MS);
    const pid = f.mic;
    f.mic.quit();
    await sleep(300);
    check('quit sends quit', f.sent().some((m) => m.cmd === 'quit'));
    void pid;
  }

  section('   pickDevice (a Settings microphone, by its Chromium label)');
  const L = [
    { id: 'a', name: 'Microphone Array (AMD Audio Device)' },
    { id: 'b', name: 'Microphone (USB Audio Device)' },
    { id: 'c', name: 'MacBook Pro Microphone' },
    { id: 'd', name: 'Stereo Karışımı (Realtek(R) Audio)' },
    { id: 'e', name: 'Headset' }, { id: 'f', name: 'headset' }
  ];
  const pick = (label) => { const d = micJs.pickDevice(L, label); return d === undefined ? 'none' : d === null ? 'default' : d.id; };
  check('no label: the default', pick('') === 'default');
  check('the exact name', pick('Microphone Array (AMD Audio Device)') === 'a');
  check('Chromium\'s USB " (046d:0825)" suffix', pick('Microphone (USB Audio Device) (046d:0825)') === 'b');
  check('macOS transport " (Built-in)"', pick('MacBook Pro Microphone (Built-in)') === 'c');
  check('a non-ASCII name', pick('Stereo Karışımı (Realtek(R) Audio)') === 'd');
  check('a label two devices could be: none (Chromium decides)', pick('HEADSET (Bluetooth)') === 'none');
  check('an unknown label: none (Chromium finds it by id, or the default, as before)', pick('Yeti Stereo Microphone') === 'none');
  check('a device\'s own parentheses are kept', micJs.normLabel('Microphone Array (AMD Audio Device)') === 'microphone array (amd audio device)');
}

(async () => {
  const info = await realHelper();
  await clientReal(info);
  await fallbacks();
  console.log(failures ? `\n${failures} check(s) failed` : `\nthe microphone helper: all checks passed${skipped ? ' (' + skipped + ' skipped)' : ''}`);
  process.exit(failures ? 1 : 0);
})();
