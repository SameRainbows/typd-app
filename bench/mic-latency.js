'use strict';

/**
 * Key press -> first audio sample, measured in Typd's main process (0.2.12). An Electron script:
 *
 *   electron bench/mic-latency.js --path helper   [--trials 6] [--gap 1500] [--idle 10000] [--out f.json]
 *   electron bench/mic-latency.js --path chromium [--trials 6] [--gap 1500] [--idle 10000] [--out f.json]
 *
 * Nothing is typed, clicked or focused, and nothing is shown: Typd's own pill window (overlay-window.js,
 * the real overlay.html/overlay.js/preload) is made hidden, its sounds off, and the "key press" is the same
 * two calls index.js's beginSession makes for the microphone -- capture.begin(session), then
 * session:start to the pill -- through the same capture.js and mic.js. The first audio is timed where the
 * session gets it in main: the helper's first block (pipe), or the page's first overlay:chunk (IPC).
 * Audio is counted, never kept. The user data folder is a temporary one (not Typd's).
 *
 * helper:   the helper starts with the app, idle `--idle` ms; trial 1 is its first open ever; then
 *           `--trials` cold opens (the device closed 0 ms after each dictation, `--gap` apart), then
 *           `--trials` warm ones (each inside the previous dictation's warm window).
 * chromium: the page loads (it lists devices at once, as in Typd), idle `--idle` ms; trial 1 is the first
 *           open in this process (cold), then `--trials` more `--gap` apart (warm: the audio service and
 *           the AudioContext are up). Run it in several processes for several cold samples.
 * Each trial records for 1 s, then ends as a dictation does (capture-end, the recording handed over).
 * The CPU's busy share during the run (all cores) is reported beside the numbers.
 */

const { app, BrowserWindow, ipcMain, session: electronSession } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const PATH = arg('path', 'helper');
const TRIALS = Number(arg('trials', 6));
const GAP = Number(arg('gap', 1500));
const IDLE = Number(arg('idle', 10000));
const OUT = arg('out', null);
const RECORD_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'typd-miclat-')));

function cpuTimes() { return os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 }); }

app.whenReady().then(async () => {
  electronSession.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(p === 'media' || p === 'audioCapture'));
  electronSession.defaultSession.setPermissionCheckHandler((wc, p) => p === 'media');
  const { createOverlayWindow } = require(path.join(root, 'src', 'main', 'overlay-window.js'));
  const micJs = require(path.join(root, 'src', 'main', 'mic.js'));
  const { createCapture } = require(path.join(root, 'src', 'main', 'capture.js'));

  const life = [];
  const mic = micJs.createNativeMic({
    exe: PATH === 'helper' ? micJs.helperPath({ packaged: false, root }) : null,
    log: (l) => life.push(l), warmMs: micJs.WARM_MS
  });
  const t0App = performance.now();
  if (PATH === 'helper') mic.start();

  const overlay = createOverlayWindow({ dev: false });   // made hidden; never shown here
  await new Promise((r) => overlay.webContents.once('did-finish-load', r));
  const send = (c, p) => { if (!overlay.isDestroyed()) overlay.webContents.send(c, p); };
  send('settings:changed', { sounds: false, mic: '', micLabel: '' });   // the default microphone; no cues

  let current = null;
  const problems = [];
  const capture = createCapture({
    mic, send, log: (l) => life.push(l), isMac: process.platform === 'darwin',
    macMicGranted: () => true, privacyBlocked: () => false,
    settings: { id: () => '', label: () => '' },
    openStream: () => ({ push() {} }),
    problem: (cur, kind) => problems.push(kind)
  });
  for (const c of ['overlay:hit', 'overlay:hidden', 'overlay:devices', 'overlay:confirm', 'overlay:cancel']) ipcMain.on(c, () => {});
  ipcMain.on('overlay:chunk', (_e, p) => {
    if (!current || !p || !p.buffer) return;
    const raw = p.buffer;
    capture.rendererChunk(current, Buffer.isBuffer(raw) ? new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)) : new Float32Array(raw));
  });
  let pageAudio = null;
  ipcMain.on('overlay:audio', (_e, p) => {
    if (!current || !p || !p.buffer) return;
    const raw = p.buffer;
    pageAudio = capture.rendererAudio(current, Buffer.isBuffer(raw) ? new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4)) : new Float32Array(raw));
  });
  ipcMain.on('overlay:mic', (_e, kind) => problems.push(kind));

  if (PATH === 'helper') { const t = performance.now(); while (!mic.usable() && performance.now() - t < 5000) await sleep(5); }
  await sleep(Math.max(0, IDLE - (performance.now() - t0App)));

  const results = [];
  const cpu0 = cpuTimes();
  async function trial(label, warmMs) {
    const sess = { mode: 'dictate', controller: new AbortController(), stream: undefined };
    current = sess;
    pageAudio = null;
    const tKey = performance.now();
    const how = capture.begin(sess);                 // = beginSession's microphone calls
    send('session:start', { mode: 'dictate', native: how.native });
    while (sess.capture.firstMs === null && performance.now() - tKey < 15000) await sleep(1);
    const first = sess.capture.firstMs;
    await sleep(Math.max(0, RECORD_MS - (performance.now() - tKey)));
    send('session:capture-end', {});
    let audio = await capture.end(sess);
    if (!audio) { const t = performance.now(); while (!pageAudio && performance.now() - t < 4000) await sleep(5); audio = pageAudio; }
    if (sess.capture.native && !sess.capture.switched) mic.release(sess.capture.handle, warmMs);
    const timing = capture.timing(sess);
    // The first sample above -60 dBFS (|x| > 0.001): a device can deliver near-silence for a while after
    // it opens (the AMD array: ~250 ms). Its time = the first audio + its place in the recording.
    let loud = null;
    if (audio && first !== null) { const s = audio.samples; for (let i = 0; i < s.length; i++) if (Math.abs(s[i]) > 0.001) { loud = first + i / 16; break; } }
    const r = { label, how: timing.how, firstMs: first === null ? null : Math.round(first * 10) / 10, loudMs: loud === null ? null : Math.round(loud), audioMs: audio ? Math.round(audio.samples.length / 16) : 0 };
    results.push(r);
    console.log(`  ${label.padEnd(14)} ${String(r.how).padEnd(22)} first audio ${r.firstMs === null ? 'NONE' : r.firstMs.toFixed(1) + ' ms'}, first > -60 dBFS ${r.loudMs === null ? 'none' : r.loudMs + ' ms'}  (${r.audioMs} ms recorded)`);
    current = null;
  }

  console.log(`mic-latency: ${PATH}, idle ${IDLE} ms, ${TRIALS} trials each, ${GAP} ms apart`);
  if (PATH === 'helper') {
    await trial('first open', 0);                        // the device closes at once after it
    for (let i = 0; i < TRIALS; i++) { await sleep(GAP); await trial('cold', i === TRIALS - 1 ? micJs.WARM_MS : 0); }
    for (let i = 0; i < TRIALS; i++) { await sleep(GAP); await trial('warm', micJs.WARM_MS); }
    mic.close();
  } else {
    await trial('cold (first)', 0);
    for (let i = 0; i < TRIALS; i++) { await sleep(GAP); await trial('warm', 0); }
  }
  const cpu1 = cpuTimes();
  const busy = 1 - (cpu1.idle - cpu0.idle) / (cpu1.total - cpu0.total);
  console.log(`  CPU busy during the run: ${(busy * 100).toFixed(0)} % of ${os.cpus().length} logical cores; problems: ${problems.length ? problems.join(', ') : 'none'}`);
  if (life.length) console.log('  life log: ' + life.join(' | '));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ path: PATH, idleMs: IDLE, gapMs: GAP, cpuBusy: busy, cores: os.cpus().length, at: new Date().toISOString(), results, problems, life }, null, 1));
  mic.quit();
  setTimeout(() => app.exit(0), 300);
});
