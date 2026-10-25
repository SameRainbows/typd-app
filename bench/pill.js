'use strict';

/**
 * The pill's two controls, the X and the tick (0.2.5, Windows: "they do nothing when clicked").
 *
 *   node bench/pill.js
 *
 * 1. the click gate (src/main/overlay-window.js), with fake timers: main lets the window take
 *    clicks only while the cursor is over a live control, and makes it click-through again the
 *    moment it leaves, the controls go, or index.js asks.
 * 2. the wiring, from the sources: the channels the page sends are the ones main listens to, the
 *    preload and the page are in the packaged files, and no `forward` (a global mouse hook) is left.
 * 3. the life log's per-dictation line: its format, and that no text can get into it.
 * 4. the page (the real overlay.html, overlay.js, overlay.css, sound.js) in a headless Chrome or
 *    Edge, with a stub of the preload's API, driven by real input events (DevTools protocol):
 *    the rectangles it reports are where the buttons are, and fed to the real gate they open it
 *    over the buttons only; a press and release on the X sends cancel and on the tick confirm --
 *    once, also when Windows ate the press -- and nothing is sent while the controls are not live;
 *    the meter draws at most ~95 frames a second. Headless: no window, a throwaway profile, the
 *    browser's process tree killed at the end. TYPD_BROWSER=<exe> picks the browser; with none
 *    found this part is skipped (and says so).
 *
 * What only a real window can show (Windows' WM_MOUSEACTIVATE with a real click, focus staying in
 * the app underneath) is bench/pill-electron.js, for CI or a spare machine -- never on a PC in use.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failures = 0;
let sink = null;   // the page checks' lines, held until their attempt is known to have run through
function check(name, ok, detail) {
  if (sink) { sink.push([name, ok, detail]); return; }
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (ok || detail === undefined ? '' : '  (' + JSON.stringify(detail).slice(0, 400) + ')'));
  if (!ok) failures++;
}
const section = (name) => console.log('\n' + name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gateMod = require(path.join(root, 'src', 'main', 'overlay-window.js'));
const life = require(path.join(root, 'src', 'main', 'lifelog.js'));

/* ------------------------------------------------------------- 1. the click gate */

function fakeGate(over = {}) {
  const t = { fn: null, every: 0, cleared: 0 };
  const calls = [];
  const w = { cursor: { x: 0, y: 0 }, bounds: { x: 1000, y: 700, width: 460, height: 240 }, visible: true };
  const gate = gateMod.createClickGate({
    setIgnore: (ignore) => calls.push(ignore),
    cursor: () => w.cursor,
    bounds: () => w.bounds,
    visible: () => w.visible,
    timers: { setInterval: (fn, ms) => { t.fn = fn; t.every = ms; return { unref() {} }; }, clearInterval: () => { t.fn = null; t.cleared++; } },
    ...over
  });
  return { gate, calls, t, w, at: (x, y) => { w.cursor = { x: w.bounds.x + x, y: w.bounds.y + y }; if (t.fn) t.fn(); } };
}

function gateChecks(areas, label) {
  // `areas` are window-relative CSS px, as the page reports them.
  const centre = (r) => [r.x + r.w / 2, r.y + r.h / 2];
  const f = fakeGate();
  check(label + 'made click-through: nothing is watched before the page reports controls', !f.gate.watching && !f.gate.takesClicks);
  f.at(...centre(areas[0]));
  check(label + 'the cursor over a control with nothing reported: still click-through', f.calls.length === 0 && !f.gate.takesClicks);
  f.gate.areas(areas);
  check(label + 'controls reported: the cursor is watched (every ' + gateMod.GATE_MS + ' ms)', f.gate.watching && f.t.every === gateMod.GATE_MS && f.t.every <= 33);
  f.at(...centre(areas[0]));
  check(label + 'pointer over the X: click-through off (setIgnoreMouseEvents(false))', f.gate.takesClicks && f.calls[f.calls.length - 1] === false);
  const n = f.calls.length;
  f.at(...centre(areas[0])); f.at(centre(areas[0])[0] + 1, centre(areas[0])[1]);
  check(label + 'staying over it costs no further window calls', f.calls.length === n);
  f.at(...centre(areas[1]));
  check(label + 'over the tick: still taking clicks', f.gate.takesClicks);
  f.at((areas[0].x + areas[0].w + areas[1].x) / 2, centre(areas[0])[1]);
  check(label + 'over the meter between them: click-through again', !f.gate.takesClicks && f.calls[f.calls.length - 1] === true);
  f.at(-50, -50);
  check(label + 'outside the window: click-through', !f.gate.takesClicks);
  f.at(...centre(areas[1]));
  f.w.visible = false; f.t.fn();
  check(label + 'the window hidden: click-through', !f.gate.takesClicks);
  f.w.visible = true; f.t.fn();
  f.gate.areas([]);
  check(label + 'the controls go ([]): click-through at once, and the watching stops', !f.gate.takesClicks && !f.gate.watching && f.calls[f.calls.length - 1] === true);
  f.gate.areas(areas); f.at(...centre(areas[0]));
  f.gate.release();
  check(label + 'release() (index.js passThrough): click-through and not watching, whatever it thought', !f.gate.takesClicks && !f.gate.watching && f.calls[f.calls.length - 1] === true);
  // The window moved to another display: the page's rectangles are window-relative, so they follow.
  f.gate.areas(areas); f.w.bounds = { x: -1920 + 730, y: 900, width: 460, height: 240 }; f.at(...centre(areas[1]));
  check(label + 'on a display left of the main one (negative x): still found', f.gate.takesClicks);
  f.gate.release();
}

section('1. the click gate (main), with fake timers');
gateChecks([{ x: 173, y: 194, w: 34, h: 34 }, { x: 253, y: 194, w: 34, h: 34 }], '');
{
  const junk = gateMod.cleanAreas([{ x: 1, y: 2, w: 3, h: 4 }, { x: 'a', y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: -1, h: 5 },
    { x: 0, y: 0, w: 1, h: 1, extra: 'x' }]).concat(gateMod.cleanAreas([null, { x: 0, y: 0, w: 5000, h: 10 }, { x: NaN, y: 0, w: 1, h: 1 }]));
  check('junk from the page is dropped; only {x, y, w, h} is kept', junk.length === 2 && JSON.stringify(junk[1]) === '{"x":0,"y":0,"w":1,"h":1}', junk);
  check('not a list: nothing', gateMod.cleanAreas('x').length === 0 && gateMod.cleanAreas(null).length === 0);
  check('at most 4 areas', gateMod.cleanAreas(Array.from({ length: 9 }, () => ({ x: 0, y: 0, w: 1, h: 1 }))).length === 4);
  const f = fakeGate({ cursor: () => { throw new Error('no screen'); } });
  f.gate.areas([{ x: 0, y: 0, w: 10, h: 10 }]);
  check('a cursor read that throws leaves it click-through', !f.gate.takesClicks);
}

/* ------------------------------------------------------------------- 2. the wiring */

section('2. the wiring (sources)');
const pre = read('src/preload/overlay.js');
const ow = read('src/main/overlay-window.js');
const main = read('src/main/index.js');
const pageJs = read('src/renderer/overlay.js');
const pageHtml = read('src/renderer/overlay.html');
const css = read('src/renderer/overlay.css');
const pkg = JSON.parse(read('package.json'));

const preSends = [...pre.matchAll(/ipcRenderer\.send\('([^']+)'/g)].map((m) => m[1]);
const listened = new Set([...(main + '\n' + ow).matchAll(/ipcMain\.on\('([^']+)'/g)].map((m) => m[1]));
const unheard = preSends.filter((c) => !listened.has(c));
check('every channel the overlay preload sends has a listener in main (' + preSends.length + ')', preSends.length >= 8 && !unheard.length, unheard);
check('hitAreas -> overlay:hit, heard by overlay-window.js (the gate), from this window only',
  /hitAreas\(list\) \{\s*ipcRenderer\.send\('overlay:hit'/.test(pre) && /ipcMain\.on\('overlay:hit', onHit\)/.test(ow) && /e\.sender === wc/.test(ow));
check('confirm -> overlay:confirm and cancel -> overlay:cancel, heard by index.js',
  /confirm\(\) \{ ipcRenderer\.send\('overlay:confirm'\)/.test(pre) && /cancel\(\) \{ ipcRenderer\.send\('overlay:cancel'\)/.test(pre) &&
  /ipcMain\.on\('overlay:confirm'/.test(main) && /ipcMain\.on\('overlay:cancel'/.test(main));
const apiNames = new Set([...(pre.match(/exposeInMainWorld\('typd', \{([\s\S]*)\}\);/) || [, ''])[1].matchAll(/^ {2}([a-zA-Z]+)\(/gm)].map((m) => m[1]));
const used = [...new Set([...pageJs.matchAll(/window\.typd\.([a-zA-Z]+)/g)].map((m) => m[1]))];
const missing = used.filter((u) => !apiNames.has(u));
check('every window.typd.* the page calls is exposed by the preload (' + used.length + ')', used.length >= 8 && !missing.length, missing);
check('the old hover channel is gone everywhere (overlay:interactive, setInteractive)',
  !/overlay:interactive|setInteractive/.test(pre + ow + main + pageJs));
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');   // comments out
const srcMain = fs.readdirSync(path.join(root, 'src', 'main')).filter((f) => f.endsWith('.js')).map((f) => code(read('src/main/' + f))).join('\n');
check('no setIgnoreMouseEvents(..., { forward }) left in src/main (it is a global mouse hook on the main thread)',
  /setIgnoreMouseEvents\(/.test(srcMain) && !/setIgnoreMouseEvents\([^)]*forward/.test(srcMain));
check('index.js passThrough goes through the gate (releaseClicks)', /function passThrough\(\) \{\s*releaseClicks\(overlay\);\s*\}/.test(main) &&
  /releaseClicks \} = require\('\.\/overlay-window'\)/.test(main));
check('the window still never takes focus: focusable false, shown inactive, nothing focuses or activates it',
  /focusable: false,/.test(ow) && /win\.showInactive\(\);/.test(ow) && !/\.focus\(|\.show\(\)|\.restore\(\)|setFocusable\(true/.test(ow));
check('macOS: acceptFirstMouse true (a click on the never-key panel reaches the page)', /acceptFirstMouse: true,/.test(ow) && !/acceptFirstMouse: false/.test(ow));
check('the page acts on the release (mouseup), not only on click', /addEventListener\('mouseup'/.test(pageJs) && /function act\(which\)/.test(pageJs));

// Packaged: electron-builder's files globs must take the preload and the page; nothing may exclude them.
const globRe = (g) => new RegExp('^' + g.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\{([^}]*)\}/g, (_m, alt) => '(?:' + alt.split(',').join('|') + ')')
  .replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*') + '$');
const files = pkg.build.files;
// In order, as electron-builder reads them: a later pattern wins over an earlier one.
const shipped = (f) => files.reduce((inc, g) => (g.startsWith('!') ? (globRe(g.slice(1)).test(f) ? false : inc) : (globRe(g).test(f) ? true : inc)), false);
check('glob check sanity: CHANGELOG.md ships, README.md and sherpa do not',
  shipped('CHANGELOG.md') && !shipped('README.md') && !shipped('node_modules/sherpa-onnx-node/index.js') && shipped('src/main/index.js'));
const preloadRel = (ow.match(/preload: path\.join\(__dirname, '\.\.', 'preload', '([^']+)'\)/) || [])[1];
const pageRel = (ow.match(/loadFile\(path\.join\(__dirname, '\.\.', 'renderer', '([^']+)'\)\)/) || [])[1];
const needed = ['src/preload/' + preloadRel, 'src/renderer/' + pageRel, 'src/main/overlay-window.js',
  ...[...pageHtml.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => 'src/renderer/' + m[1])];
const notShipped = needed.filter((f) => !fs.existsSync(path.join(root, f)) || !shipped(f));
check('the packaged app has the overlay preload, page and its scripts (' + needed.join(', ') + ')',
  preloadRel === 'overlay.js' && pageRel === 'overlay.html' && needed.length >= 5 && !notShipped.length, notShipped);
check('one overlay preload: no dev-only path, no second preload for the packaged build',
  (ow.match(/preload:/g) || []).length === 1 && !/app\.isPackaged|process\.resourcesPath/.test(ow));
check('the pill has no backdrop-filter (no pixel to blur behind it in a transparent window)', !/^\s*backdrop-filter/m.test(css) && !/^\s*-webkit-backdrop-filter/m.test(css));

/* ---------------------------------------------------------------- 3. the life log */

section('3. the per-dictation line in the life log');
{
  const line = life.dictationLine({ mode: 'dictate', audioSeconds: 4.23, chars: 38, releaseToTextMs: 820.4, textToPasteMs: 46.2,
    outcome: 'pasted', model: '2026-10-01', device: 'GPU', lowMemory: false });
  check('format: mode, audio, chars, release to text, text to paste, outcome, model, device',
    line === 'dictate, 4.2 s audio, 38 chars, release to text 820 ms, text to paste 46 ms, pasted, model 2026-10-01, GPU', line);
  const re = /^(dictate|revise|other), (\d+\.\d|\?) s audio, (\d+|\?) chars, release to text (\d+|\?) ms, text to paste (\d+|\?) ms, (pasted|copied|other), model [A-Za-z0-9._+-]+, (GPU|CPU|device unknown)(, low memory)?$/;
  const odd = [
    life.dictationLine({}),
    life.dictationLine({ mode: 'revise', audioSeconds: 0, chars: 0, releaseToTextMs: 0, textToPasteMs: 0, outcome: 'copied', model: 'unknown', device: 'CPU', lowMemory: true }),
    life.dictationLine({ mode: 'hello world', audioSeconds: -1, chars: NaN, releaseToTextMs: Infinity, outcome: 'my secret', model: 'a "secret" text\nnext', device: 'my GPU' })
  ];
  check('every line matches the format, whatever it is given', odd.every((l) => re.test(l)), odd);
  check('unknowns are "?" and "device unknown"; low memory is said', /\? s audio, \? chars, release to text \? ms/.test(odd[0]) && /device unknown$/.test(odd[0]) && /CPU, low memory$/.test(odd[1]));
  check('words given for mode, outcome or device never get through; the model keeps no space, quote or newline',
    !/hello|world|my secret|my GPU|"|\n/.test(odd[2]) && / model [A-Za-z0-9._+-]+, device unknown$/.test(odd[2]), odd[2]);
  check('it survives life.log unchanged (nothing in it is cleaned away)', life.clean(line, 300) === line);
  // index.js: one line per paste, counts only.
  const call = (main.match(/life\.log\('dictation', life\.dictationLine\(\{([\s\S]*?)\}\)\);/) || [])[1] || '';
  const keys = [...call.matchAll(/^\s+([a-zA-Z]+)(?::|,?\s*$)/gm)].map((m) => m[1]);
  check('index.js logs it after the paste with counts only: no text, app, title or context passed',
    keys.length >= 8 && keys.every((k) => ['mode', 'audioSeconds', 'chars', 'releaseToTextMs', 'textToPasteMs', 'outcome', 'model', 'device', 'lowMemory', 'mic'].includes(k)) &&
    /^\s+chars,$/m.test(call) && /logDictation\(current, text\.length, result, pastedAt\)/.test(main) && !/text/.test(call), keys);
  check('index.js: the text-ready stamp is taken before the paste, and the recording is written after it',
    // 0.2.10: the paste is inside pasteTarget.land (or skipped when there is no text field: the copy pop-up).
    /current\.textAt = Date\.now\(\);[\s\S]{0,2600}const landed = await pasteTarget\.land\(\{[\s\S]{0,200}\}\);\s*if \(!landed\) return;\s*const \{ result, verdict \} = landed;\s*const pastedAt = Date\.now\(\)/.test(main) &&
    /setImmediate\(\(\) => \{ keepRecording\(current, text\);/.test(main));
  check('index.js reads local.device / local.lowMemory without needing them (works with the 0.2.5 local.js too)',
    /try \{ device = local\.device \|\| null; lowMemory = local\.lowMemory \|\| null; \} catch/.test(main));
}

/* ------------------------------------------------------------------- 4. the page */

function findBrowser() {
  if (process.env.TYPD_BROWSER) return fs.existsSync(process.env.TYPD_BROWSER) ? process.env.TYPD_BROWSER : null;
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const list = process.platform === 'win32'
    ? [...pf.map((p) => path.join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')), ...pf.map((p) => path.join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return list.find((p) => fs.existsSync(p)) || null;
}

/** The preload's API as the page sees it, every call recorded: built from preload/overlay.js itself. */
function stubScript() {
  const names = [...apiNames].filter((n) => n !== 'on');
  return `(() => {
    const handlers = {};
    window.__calls = [];
    window.__typdSynthetic = true;   // no microphone here: the meter's own envelope, and no mic error
    window.__emit = (ch, p) => (handlers[ch] || []).slice().forEach((f) => f(p || {}));
    const keep = (v) => (v instanceof ArrayBuffer ? '[audio]' : v);
    const api = { on(ch, f) { (handlers[ch] = handlers[ch] || []).push(f); return () => {}; } };
    for (const n of ${JSON.stringify(names)}) {
      api[n] = (...a) => { if (n !== 'sendChunk') window.__calls.push({ n, a: JSON.parse(JSON.stringify(a.map(keep))), t: performance.now() }); };
    }
    window.typd = api;
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('no microphone in the bench'));
    // No sound either: an AudioContext asks the audio service for the output device synchronously,
    // which stalled this page for seconds now and then. sound.js still loads; its cues are kept.
    window.__cues = [];
    let sound = null;
    Object.defineProperty(window, 'typdSound', {
      configurable: true,
      set(v) { sound = v; },
      get() { return sound && { play: (c) => window.__cues.push(c), setEnabled() {} }; }
    });
    // Draw counting for the frame-rate check: every meter frame starts with one clearRect.
    window.__draws = [];
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...a) { window.__draws.push(performance.now()); return clear.apply(this, a); };
    window.__rafs = 0;
    const raf = window.requestAnimationFrame.bind(window);
    // __hz set: frames come at that rate (setTimeout), as on a 240 Hz display.
    window.__hz = 0;
    window.requestAnimationFrame = (f) => (window.__hz
      ? setTimeout(() => { window.__rafs++; f(performance.now()); }, 1000 / window.__hz)
      : raf((t) => { window.__rafs++; f(t); }));
  })();`;
}

function serve(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
    const file = path.join(dir, name);
    if (!/^[a-z.-]+$/i.test(name) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools socket failed')); });
  let id = 0;
  const pending = new Map();
  ws.onclose = (e) => {
    if (process.env.TYPD_BENCH_DEBUG) console.log('    [debug] DevTools socket closed', e.code, e.reason);
    for (const [, p] of pending) p.rej(new Error('DevTools socket closed (' + e.code + ')'));
    pending.clear();
  };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (!msg.id && process.env.TYPD_BENCH_DEBUG && /crash|exception|detached|console/i.test(msg.method || '')) console.log('    [cdp]', JSON.stringify(msg).slice(0, 300));
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result);
  };
  return {
    send(method, params = {}, sessionId) {
      const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.delete(i)) rej(new Error(method + ' timed out')); }, 20000); });
    },
    close() { try { ws.close(); } catch { /* gone */ } }
  };
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* already gone */ }
}

/*
 * A headless browser on a busy machine sometimes stops answering altogether (seen here at ~90 %
 * CPU: even Browser.getVersion went unanswered for 30 s). That says nothing about the pill, so
 * such an attempt is thrown away and run again in a fresh browser, up to three times; a check
 * that fails in an attempt that ran through is a failure like any other.
 */
const INFRA = /timed out|socket closed|DevToolsActivePort|socket failed|ECONNREFUSED|fetch failed/;

async function pageSection() {
  section('4. the page in a headless browser (real overlay.html/js/css, stub preload, real input events)');
  const exe = findBrowser();
  if (!exe) { console.log('  skip  no Edge or Chrome found (set TYPD_BROWSER) -- the page checks did not run'); return; }
  console.log('    browser: ' + path.basename(exe) + ', headless');
  for (let attempt = 1; attempt <= 3; attempt++) {
    sink = [];
    const notes = [];
    let infra = null;
    try {
      await pageChecks(exe, notes);
    } catch (err) {
      if (INFRA.test(String(err && err.message))) infra = err;
      else sink.push(['the page checks ran to the end', false, String(err && err.stack || err)]);
    }
    const lines = sink;
    sink = null;
    if (infra && attempt < 3) { console.log('    (attempt ' + attempt + ': the browser stopped answering -- ' + infra.message + '; again, in a fresh one)'); continue; }
    if (infra) { check('the headless browser answered through a whole run (3 attempts)', false, infra.message); return; }
    for (const n of notes) console.log(n);
    for (const [name, ok, detail] of lines) check(name, ok, detail);
    return;
  }
}

async function pageChecks(exe, notes) {

  const server = await serve(path.join(root, 'src', 'renderer'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-pill-'));
  const child = spawn(exe, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-component-update', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    // As puppeteer launches: a page nobody looks at must not be throttled, frozen or put to sleep.
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,msSleepingTabs,msEfficiencyMode',
    // Software drawing without the GPU process's watchdog, which on a loaded machine killed it.
    '--disable-gpu', '--disable-gpu-watchdog', '--disable-hang-monitor',
    'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp = null;
  child.on('exit', (code, sig) => { if (process.env.TYPD_BENCH_DEBUG) console.log('    [debug] browser exited', code, sig); });
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 150 && !fs.existsSync(portFile); i++) await sleep(100);
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
    const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
    cdp = await connect(version.webSocketDebuggerUrl);
    // The tab the browser opened (the active one), rather than a new background tab.
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const first = pages.find((t) => t.type === 'page');
    const targetId = first ? first.id : (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m, p) => cdp.send(m, p, sessionId);
    const ev = async (expr) => {
      const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
        .catch(async (err) => {
          if (process.env.TYPD_BENCH_DEBUG) {
            const t0 = Date.now();
            const b = await cdp.send('Browser.getVersion').then(() => 'browser answers', (e) => 'browser: ' + e.message);
            const p = await S('Runtime.evaluate', { expression: '1+1', returnByValue: true }).then((r) => 'page answers ' + r.result.value, (e) => 'page: ' + e.message);
            console.log('    [debug] ' + b + '; ' + p + ' (' + (Date.now() - t0) + ' ms)');
          }
          throw new Error(err.message + ' (' + expr.slice(0, 60) + ')');
        });
      if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
      return r.result.value;
    };
    await S('Page.enable');
    await S('Runtime.enable');
    await S('Page.addScriptToEvaluateOnNewDocument', { source: stubScript() });
    const url = 'http://127.0.0.1:' + server.address().port + '/overlay.html';

    const load = async (dpr) => {
      await S('Emulation.setDeviceMetricsOverride', { width: 460, height: 240, deviceScaleFactor: dpr, mobile: false });
      await S('Page.navigate', { url });
      for (let i = 0; i < 100; i++) {
        if (await ev('document.readyState === "complete" && Array.isArray(window.__calls) && !!window.typdSound').catch(() => false)) break;
        await sleep(50);
      }
      await sleep(150);
    };
    const calls = () => ev('window.__calls');
    const named = async (n) => (await calls()).filter((c) => c.n === n);
    const lastHits = async () => { const h = await named('hitAreas'); return h.length ? h[h.length - 1].a[0] : null; };
    const boxes = () => ev('["cancel","confirm"].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })');
    const mouse = async (type, x, y, extra = {}) => S('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, ...extra });
    const click = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(30); };
    const centre = (b) => [b.x + b.w / 2, b.y + b.h / 2];
    const start = async () => { await ev('window.__calls.length = 0; window.__emit("session:start", { mode: "dictate" }); 0'); await sleep(450); };
    const count = async (n) => (await named(n)).length;

    await load(1);
    check('the page loads with the stub preload and no errors', (await ev('document.getElementById("overlay").dataset.state')) === 'idle');
    check('at rest it reports no controls', JSON.stringify(await lastHits()) === '[]' || (await lastHits()) === null);

    // A session: the controls unfold, and the page says where they ended up.
    await start();
    let hits = await lastHits();
    let b = await boxes();
    check('listening: two areas reported', Array.isArray(hits) && hits.length === 2, hits);
    const covers = (h, bx) => h.x <= bx.x && h.y <= bx.y && h.x + h.w >= bx.x + bx.w && h.y + h.h >= bx.y + bx.h && h.w <= bx.w + 12 && h.h <= bx.h + 12;
    check('each area covers its button (24 px, padded 5) and no more', hits && hits.length === 2 && covers(hits[0], b[0]) && covers(hits[1], b[1]) && b[0].w >= 23, { hits, b });
    const hitReports = (await named('hitAreas')).length;
    await sleep(300);
    check('settled: no more reports while nothing moves', (await named('hitAreas')).length === hitReports);

    // (a) the page's real rectangles through the real gate: pointer over a button -> takes clicks.
    gateChecks(hits, 'with the page\'s areas: ');

    // (b) real input events on the real buttons.
    await click(...centre(b[0]));
    let c = await calls();
    const iCancel = c.findIndex((x) => x.n === 'cancel');
    const iOff = c.findIndex((x) => x.n === 'hitAreas' && x.a[0].length === 0);
    check('a click on the X sends cancel, once, and nothing else', (await count('cancel')) === 1 && (await count('confirm')) === 0, c.map((x) => x.n));
    check('...and the page withdraws its areas ([]) before it does, so main goes click-through at once', iOff >= 0 && iOff < iCancel);
    await ev('window.__emit("session:cancel"); 0');
    await sleep(350);
    check('main\'s session:cancel: the pill leaves and reports itself hidden', (await count('notifyHidden')) === 1 && (await ev('document.getElementById("overlay").dataset.state')) === 'idle');

    await start();
    b = await boxes();
    await click(...centre(b[1]));
    check('a click on the tick sends confirm, once', (await count('confirm')) === 1 && (await count('cancel')) === 0);
    await click(...centre(b[1]));
    check('a second click before main answers sends nothing more', (await count('confirm')) === 1);

    // Windows: Chromium can eat the press (MA_NOACTIVATEANDEAT); only the release reaches the page.
    await start();
    b = await boxes();
    await mouse('mouseMoved', ...centre(b[1]));
    await mouse('mouseReleased', ...centre(b[1]));
    await sleep(30);
    check('the press eaten, only the release arrives (Windows): confirm is still sent, once', (await count('confirm')) === 1 && (await count('cancel')) === 0);

    await start();
    b = await boxes();
    await mouse('mouseMoved', ...centre(b[0]));
    await mouse('mouseReleased', ...centre(b[0]));
    await sleep(30);
    check('...and the same for the X: cancel', (await count('cancel')) === 1 && (await count('confirm')) === 0);

    // Places that are not a control, and controls that are not live.
    await start();
    b = await boxes();
    const meter = [(b[0].x + b[0].w + b[1].x) / 2, centre(b[0])[1]];
    await click(...meter);
    await click(5, 5);
    check('a click on the meter or the empty window sends nothing', (await count('cancel')) + (await count('confirm')) === 0);
    await mouse('mouseMoved', ...centre(b[0]));
    await mouse('mousePressed', ...centre(b[0]));
    await mouse('mouseMoved', ...meter, { buttons: 1 });
    await mouse('mouseReleased', ...meter);
    await sleep(30);
    check('pressed on the X, let go off it: nothing (an ordinary button)', (await count('cancel')) === 0);

    await ev('window.__emit("session:capture-end"); 0');
    await sleep(30);
    check('capture ended (the key): areas withdrawn at once', JSON.stringify(await lastHits()) === '[]');
    await click(...centre(b[1]));
    check('...and the tick, still on screen until "thinking", sends nothing', (await count('confirm')) === 0);
    await ev('window.__emit("session:thinking"); 0');
    await sleep(400);
    b = await boxes();
    check('working: the controls have folded away (width 0)', b[0].w < 2 && b[1].w < 2, b);
    await click(...centre(b[1])); await click(...centre(b[0]));
    check('working: clicks where they were send nothing, and no areas come back', (await count('confirm')) + (await count('cancel')) === 0 && JSON.stringify(await lastHits()) === '[]');
    await ev('window.__emit("session:done"); 0');
    await sleep(350);

    await ev('window.__calls.length = 0; window.__emit("session:note", { message: "Learned", ms: 600 }); 0');
    await sleep(150);
    await click(230 - 40, 211); await click(230 + 40, 211);
    check('a note between sessions: no areas, and clicks send nothing', (await count('hitAreas')) === 0 && (await count('confirm')) + (await count('cancel')) === 0);
    const d0 = await ev('window.__draws.length');
    await sleep(200);
    check('a note does not run the meter loop', (await ev('window.__draws.length')) - d0 <= 1);
    // (the next session:start supersedes the note and the error: no need to wait them out)

    await start();
    await ev('window.__emit("session:error", { message: "Mic silent" }); 0');
    await sleep(30);
    check('an error while listening withdraws the areas', JSON.stringify(await lastHits()) === '[]');

    // The meter's frame rate on a 240 Hz display (frames offered at 240/s): draws are capped.
    await ev('window.__hz = 240; 0');
    await start();
    const r0 = await ev('[window.__rafs, window.__draws.length, performance.now()]');
    await sleep(1000);
    const r1 = await ev('[window.__rafs, window.__draws.length, performance.now()]');
    const secs = (r1[2] - r0[2]) / 1000;
    const rafRate = (r1[0] - r0[0]) / secs, drawRate = (r1[1] - r0[1]) / secs;
    notes.push('    listening: ' + Math.round(rafRate) + ' animation frames/s offered, ' + Math.round(drawRate) + ' meter frames/s drawn');
    check('the meter draws at most ~95 frames a second, whatever the display offers', drawRate <= 100 && drawRate >= 20 &&
      (rafRate < 90 || drawRate < rafRate * 0.85), { rafRate, drawRate });
    if (rafRate < 90) notes.push('    (this machine delivered only ' + Math.round(rafRate) + ' frames/s, so the cap was not exercised)');
    await ev('window.__hz = 0; 0');
    check('the pill has no backdrop-filter at run time', (await ev('getComputedStyle(document.querySelector(".pill")).backdropFilter')) === 'none');

    // Display scaling: the areas are CSS px, the same numbers at 150 % (main compares them with DIPs).
    await load(1.5);
    await start();
    const hits15 = await lastHits();
    check('at 150 % scaling the reported areas are the same CSS px', JSON.stringify(hits15) === JSON.stringify(hits), { hits, hits15 });
    b = await boxes();
    await click(...centre(b[0]));
    check('...and a click on the X still sends cancel', (await count('cancel')) === 1);
  } finally {
    if (cdp) { try { await cdp.send('Browser.close'); } catch { /* closing */ } cdp.close(); }
    await sleep(300);
    killTree(child);
    server.close();
    if (process.env.TYPD_BENCH_KEEP) console.log("    [debug] profile kept: " + profile);
    else for (let i = 0; i < 10; i++) { try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); } }
  }
}

pageSection()
  .catch((err) => { sink = null; check('the page checks ran to the end', false, String(err && err.stack || err)); })
  .then(() => {
    console.log('\n' + (failures ? failures + ' FAILED' : 'all pill checks passed') + '\n');
    process.exit(failures ? 1 : 0);
  });
