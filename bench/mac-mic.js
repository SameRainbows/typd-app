'use strict';

/**
 * The Mac microphone (0.2.7): a new Mac user could not give Typd the microphone (macOS 27, Typd 0.2.6).
 *
 *   node bench/mac-mic.js
 *
 * 1. src/main/permissions-mac.js, headless, with a stand-in for Electron (macOS's privacy answers are
 *    scripted): a prompt nobody answers no longer holds the launch check forever -- it is logged, Typd's
 *    own dialog follows with "Allow Microphone", and that button asks macOS again instead of opening a
 *    Microphone list Typd is not in; an answer is heard and logged; "denied" offers "Ask macOS Again"
 *    (tccutil reset of Typd's own entry, then macOS's prompt), and a refusal that comes at once after
 *    it is told apart from an answer.
 * 2. the pill's page (the real overlay.html/js/css) in a headless Chrome or Edge: a microphone that
 *    does not open is reported with its error and the meter stays flat (0.2.6 drew its synthetic
 *    envelope, so a Mac whose microphone macOS had not allowed looked as if it heard speech); a
 *    stream that works is recorded and delivered, non-silent, whatever the privacy status says --
 *    the page never reads it; the meter and the recording come from the same stream.
 * 3. from the sources: main never holds a dictation back on the status when a model is there; the
 *    capture result decides the pill's words; the app and helpers are signed with the microphone
 *    entitlement and without the hardened runtime; the update package keeps it; the macOS icon is
 *    Apple's iconutil's (scripts/check-icns.js on good and bad files).
 *
 * Headless: no window, a throwaway browser profile, killed at the end. TYPD_BROWSER=<exe> picks the
 * browser; with none found, part 2 is skipped (and says so).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');
const { spawn, execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (ok || detail === undefined ? '' : '  -- ' + JSON.stringify(detail).slice(0, 400)));
  if (!ok) failures++;
}
const section = (name) => console.log('\n' + name);

/* ------------------------------------------------- 1. permissions-mac.js, scripted */

const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

function world() {
  const w = {
    mic: 'not-determined', ax: true, listen: 'granted', afterReset: null,
    askImpl: () => new Promise(() => {}),       // macOS's prompt: nobody answers
    asks: 0, dialogs: [], responses: [], opened: [], execs: [], life: [], focus: 0
  };
  w.electron = {
    app: { isPackaged: true, focus() { w.focus++; }, getAppPath: () => root },
    dialog: {
      async showMessageBox(o) {
        w.dialogs.push(o);
        const r = w.responses.length ? w.responses.shift() : { response: o.cancelId };
        if (r.advance) clockOffset += r.advance;
        return { response: r.response };
      }
    },
    shell: { openExternal: async (u) => { w.opened.push(u); } },
    systemPreferences: {
      getMediaAccessStatus: () => w.mic,
      askForMediaAccess: () => { w.asks++; return w.askImpl(); },
      isTrustedAccessibilityClient: () => w.ax
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    ipcMain: { on() {} }
  };
  w.inject = { listenAccess: async () => w.listen, requestListen: async () => ({ ok: true }), prime: async () => ({ ok: true }) };
  w.lifelog = { log: (what, detail) => w.life.push(what + ': ' + detail) };
  w.dump = '';
  w.child = {
    spawn(file, args) {
      w.execs.push([file, ...args]);
      const { PassThrough } = require('stream');
      const out = new PassThrough();
      const ee = new (require('events'))();
      ee.stdout = out; ee.kill = () => {};
      setTimeout(() => { out.end(w.dump); setTimeout(() => ee.emit('close', 0), 5); }, 5);
      return ee;
    },
    execFile(file, args, _o, cb) {
      w.execs.push([file, ...args]);
      if (w.afterReset) w.mic = w.afterReset;
      setTimeout(() => cb(null, 'Successfully reset Microphone approval status for ai.typd.app', ''), 5);
    }
  };
  return w;
}

const PM = path.join(root, 'src', 'main', 'permissions-mac.js');
const LOC = path.join(root, 'src', 'main', 'mac', 'app-location.js');
let current = null;
const load0 = Module._load;
Module._load = function (request, parent, isMain) {
  if (current && request === 'electron') return current.electron;
  if (current && parent && parent.filename === LOC && request === 'child_process') return current.child;
  if (current && parent && parent.filename === PM) {
    if (request === './inject') return current.inject;
    if (request === './lifelog') return current.lifelog;
    if (request === 'child_process') return current.child;
    if (request === './hotkeys' || request === './settings') throw new Error('not in this bench');
  }
  return load0.apply(this, arguments);
};

/** A fresh permissions-mac.js in a scripted world, as on a Mac. */
function fresh(w) {
  current = w;
  delete require.cache[PM];
  return require(PM);
}

const within = (p, ms) => Promise.race([p.then((v) => ({ done: true, v })), sleep(ms).then(() => ({ done: false }))]);

async function permissionsSection() {
  section('1. permissions-mac.js: macOS\'s answers scripted (a prompt nobody answers, Allow, denied with no switch, a policy)');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  process.env.TYPD_MIC_WAIT_MS = '400';
  {
    // A. The reporter's first launch: macOS's prompt is up and nobody answers it.
    const w = world();
    let answer = null;
    w.askImpl = () => new Promise((res) => { answer = res; });   // answered only when the bench says so
    const pm = fresh(w);
    let opened = 0;
    pm.whenUnanswered(() => { opened++; });
    const r = await within(pm.ensure('startup'), 3000);
    check('a prompt nobody answers does not hold the launch check (0.2.6 waited forever)', r.done, r);
    check('...macOS was asked once at launch, Typd brought to the front for it', w.asks === 1 && w.focus >= 1, { asks: w.asks, focus: w.focus });
    check('...the request and the missing answer are in the life log', w.life.some((l) => /^microphone: asking macOS/.test(l)) && w.life.some((l) => /^microphone: no answer from macOS after/.test(l)), w.life);
    check('...no modal dialog of Typd\'s over macOS\'s prompt (a modal holds Typd up, macOS\'s answer included)', w.dialogs.length === 0, w.dialogs.map((d) => d.message));
    check('...the Typd window opens instead (its card offers Allow / Ask again), and the life log says why', opened === 1 && w.life.some((l) => /still unanswered: no dialog/.test(l)), { opened, life: w.life });
    check('...micState says "asking" while the prompt is up', pm.micState() === 'asking', pm.micState());
    check('...the walkthrough waits on it for at most its own limit', pm.isAsking(60000) === true && pm.isAsking(0) === false);
    const s0 = await pm.status();
    check('...status(): a microphone never answered counts as off (the tray and Home offer "Allow")', s0.microphone === false, s0);
    clockOffset += 11000;
    pm.request('microphone');   // Home's "Ask again", more than 10 s later
    await sleep(30);
    check('..."Ask again" asks macOS again (its prompt), it opens no list Typd is not in', w.asks === 2 && !w.opened.some((u) => /Privacy_Microphone/.test(u)), { asks: w.asks, opened: w.opened });
    // macOS answers at last: the check runs again by itself and explains the switches still off.
    w.ax = false;
    w.mic = 'granted';
    answer(true);
    await sleep(900);
    check('macOS answers later: Typd hears it and runs the check again (the other switches explained)', w.life.some((l) => /macOS answered: allowed/.test(l)) && w.dialogs.length === 1 && /Accessibility/.test(w.dialogs[0].detail) && !/Microphone —/.test(w.dialogs[0].detail), w.dialogs.map((d) => d.detail));
  }
  {
    // A2. Never answered, and no prompt pending (macOS dropped it): the dialog's first button asks macOS.
    const w = world();
    w.askImpl = () => Promise.resolve(false);   // returns at once, still not-determined
    w.responses.push({ response: 0, advance: 11000 });
    const pm = fresh(w);
    await within(pm.ensure('startup'), 3000);
    const d = w.dialogs[0];
    check('never answered, no prompt left: the dialog\'s first button is "Allow Microphone", and says why Typd is not in the list', d && d.buttons[0] === 'Allow Microphone' && /not in its Microphone list/.test(d.detail), d && { b: d.buttons, detail: d.detail });
    await sleep(30);
    check('..."Allow Microphone" asks macOS again, it opens no pane', w.asks === 2 && !w.opened.some((u) => /Privacy_Microphone/.test(u)), { asks: w.asks, opened: w.opened });
  }
  {
    // B. Allow.
    const w = world();
    w.askImpl = () => new Promise((res) => setTimeout(() => { w.mic = 'granted'; res(true); }, 50));
    const pm = fresh(w);
    const st = await pm.requestMic('the bench');
    check('Allow: requestMic resolves "granted"', st === 'granted', st);
    check('...and the life log has macOS\'s answer', w.life.some((l) => /^microphone: macOS answered: allowed after \d+ s \(status granted\)/.test(l)), w.life);
    check('...micState "granted"; status() microphone on', pm.micState() === 'granted' && (await pm.status()).microphone === true);
    check('...an answer already given is not asked again', (await pm.requestMic('again')) === 'granted' && w.asks === 1, w.asks);
  }
  {
    // C. NellowTCS's macOS 27: "It is turned off for Typd" -- and Typd is not in the list.
    const w = world();
    w.mic = 'denied';
    w.afterReset = 'not-determined';
    w.askImpl = () => new Promise((res) => setTimeout(() => { w.mic = 'granted'; res(true); }, 200));   // the person clicks Allow
    w.responses.push({ response: 1 });   // "Ask macOS Again"
    const pm = fresh(w);
    await within(pm.ensure('startup'), 4000);
    const d = w.dialogs[0];
    check('denied: the dialog offers "Open System Settings", "Ask macOS Again", "Not Now"', d && JSON.stringify(d.buttons) === JSON.stringify(['Open System Settings', 'Ask macOS Again', 'Not Now']), d && d.buttons);
    check('...and says what to do when Typd is not in the list', d && /not in the Microphone list\? “Ask macOS Again”/.test(d.detail) && /tccutil reset Microphone ai\.typd\.app/.test(d.detail), d && d.detail);
    check('..."Ask macOS Again" resets Typd\'s own entry only (tccutil reset Microphone ai.typd.app)', JSON.stringify(w.execs) === JSON.stringify([['/usr/bin/tccutil', 'reset', 'Microphone', 'ai.typd.app']]), w.execs);
    check('...then asks macOS (its prompt): granted', w.asks === 1 && w.mic === 'granted', { asks: w.asks, mic: w.mic });
    check('...logged: the reset and the answer', w.life.some((l) => /tccutil reset Microphone ai\.typd\.app: done/.test(l)) && w.life.some((l) => /macOS answered: allowed/.test(l)), w.life);
    check('...no "refused" dialog for a real answer', w.dialogs.length === 1, w.dialogs.map((x) => x.message));
  }
  {
    // D. A rule on the Mac: macOS refuses at once, with no dialog, even after the reset.
    const w = world();
    w.mic = 'denied';
    w.afterReset = 'not-determined';
    w.askImpl = () => { w.mic = 'denied'; return Promise.resolve(false); };
    w.responses.push({ response: 1 });
    const pm = fresh(w);
    await within(pm.ensure('startup'), 3000);
    const second = w.dialogs[1];
    check('a policy refusal after the reset is told apart: "macOS refuses the microphone to Typd without asking"', second && /without asking/.test(second.message), w.dialogs.map((x) => x.message));
    check('...and logged as a rule, not an answer', w.life.some((l) => /refused at once after the reset/.test(l)), w.life);
  }
  {
    // E. A real "off" switch: the Microphone pane opens (Typd is in that list).
    const w = world();
    w.mic = 'denied';
    const pm = fresh(w);
    pm.request('microphone');
    await sleep(20);
    check('denied: "Open System Settings" opens Privacy & Security › Microphone, asks nothing', w.opened.some((u) => /Privacy_Microphone/.test(u)) && w.asks === 0, { opened: w.opened, asks: w.asks });
  }
  {
    // F. Never answered: request('microphone') (tray, Home, the dialog) is macOS's prompt, not the pane.
    const w = world();
    const pm = fresh(w);
    pm.request('microphone');
    await sleep(20);
    check('never answered: request() asks macOS and opens no pane', w.asks === 1 && w.opened.length === 0, { asks: w.asks, opened: w.opened });
  }
  {
    // G. LaunchServices: a copy of Typd that is gone (first run from ~/Downloads, then moved) is
    // unregistered; this copy is registered; nothing else is touched.
    const w = world();
    current = w;
    delete require.cache[LOC];
    const loc = require(LOC);
    const home = os.homedir();
    check('location: Downloads, Desktop, a disk image and a translocated copy are offered the move; Applications is not',
      /Downloads/.test(loc.place(path.join(home, 'Downloads', 'Typd.app'))) && /Desktop/.test(loc.place(path.join(home, 'Desktop', 'Typd.app'))) &&
      /disk image/.test(loc.place('/Volumes/Typd/Typd.app')) && /Translocation/.test(loc.place('/private/var/folders/x/AppTranslocation/ABC/d/Typd.app')) &&
      loc.place('/Applications/Typd.app') === null && loc.place(path.join(root, 'dist', 'mac-arm64', 'Typd.app')) === null);
    const here = loc.bundlePath();
    const gone = path.join(home, 'Downloads', 'Typd-gone-' + process.pid + '.app');
    const store = { macAppPaths: gone };
    const settings = { get: (k) => store[k], set: (k, v) => { store[k] = v; return true; } };
    const r = await loc.tidy(settings);
    const lsr = w.execs.map((e) => e.slice(1).join(' '));
    check('tidy: the gone copy is unregistered (lsregister -u that path only)', lsr.includes('-u ' + gone) && lsr.filter((x) => x.startsWith('-u ')).length === 1, lsr);
    check('...this copy registered (lsregister -f), and remembered; the gone one forgotten', lsr.includes('-f ' + here) && store.macAppPaths === here && r.gone.length === 1, { lsr, store });
    w.execs.length = 0;
    await loc.tidy(settings);
    check('...nothing to do the next time (no lsregister at all)', w.execs.length === 0, w.execs);
    await loc.tidy(settings, { force: true });
    check('...forced (before asking macOS again): this copy registered once more, nothing unregistered', w.execs.length === 1 && w.execs[0].slice(1).join(' ') === '-f ' + here, w.execs);
    // The copies an older Typd (0.2.6) ran from: not remembered, but in LaunchServices' dump.
    const stale = path.join(home, 'Downloads', 'Typd-0.2.6-' + process.pid + '.app');
    const other = path.join(home, 'Downloads', 'Other-' + process.pid + '.app');
    w.dump = ['--------', 'path:                       ' + stale + ' (0x1700)', 'name:                       Typd', 'identifier:                 ai.typd.app', '--------',
      'path:                       ' + other + ' (0x1710)', 'identifier:                 com.example.other', '--------',
      'path:                       ' + here + ' (0x171c)', 'identifier:                 ai.typd.app', '--------',
      'path:                       ' + stale + '/Contents/Frameworks/Typd Helper.app (0x1701)', 'identifier:                 ai.typd.app.helper', ''].join(String.fromCharCode(10));
    w.execs.length = 0;
    const found = await loc.registeredPaths();
    check("registeredPaths: ai.typd.app's paths from lsregister -dump (not its helper's, not another app's)", JSON.stringify(found.sort()) === JSON.stringify([stale, here].sort()), found);
    w.execs.length = 0;
    const r2 = await loc.tidy(settings, { scan: true });
    const lsr2 = w.execs.map((e) => e.slice(1).join(' '));
    check("tidy with scan: the gone copy an older Typd left is unregistered; another app's gone entry is not touched", lsr2.includes('-u ' + stale) && !lsr2.some((x) => x.includes(other)) && r2.gone.length === 1, lsr2);
  }
  // The stand-ins stay (earlier cases' watch() timers still tick until the bench exits).
  clockOffset = 0;
}

/* --------------------------------------------------------------- 2. the page */

function findBrowser() {
  if (process.env.TYPD_BROWSER) return fs.existsSync(process.env.TYPD_BROWSER) ? process.env.TYPD_BROWSER : null;
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const list = process.platform === 'win32' || process.env.OS === 'Windows_NT'
    ? [...pf.map((p) => path.join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')), ...pf.map((p) => path.join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))]
    : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  return list.find((p) => fs.existsSync(p)) || null;
}

/** The preload's API, every call recorded; getUserMedia as the case says (window.__mic). */
function stubScript() {
  const pre = read('src/preload/overlay.js');
  const names = [...(pre.match(/exposeInMainWorld\('typd', \{([\s\S]*)\}\);/) || [, ''])[1].matchAll(/^ {2}([a-zA-Z]+)\(/gm)].map((m) => m[1]).filter((n) => n !== 'on');
  return `(() => {
    const handlers = {};
    window.__calls = []; window.__chunks = 0; window.__audio = null;
    window.__typdSynthetic = false;   // the real app: no synthetic meter
    window.__emit = (ch, p) => (handlers[ch] || []).slice().forEach((f) => f(p || {}));
    const api = { on(ch, f) { (handlers[ch] = handlers[ch] || []).push(f); return () => {}; } };
    for (const n of ${JSON.stringify(names)}) {
      api[n] = (...a) => {
        if (n === 'sendChunk') { window.__chunks++; return; }
        if (n === 'sendAudio') { const f = new Float32Array(a[0]); let peak = 0; for (const x of f) peak = Math.max(peak, Math.abs(x)); window.__audio = { samples: f.length, peak }; return; }
        window.__calls.push({ n, a: JSON.parse(JSON.stringify(a)) });
      };
    }
    window.typd = api;
    // window.__mic: 'denied' (macOS has not allowed it: NotAllowedError) or 'tone' (a working stream)
    navigator.mediaDevices.getUserMedia = async () => {
      if (window.__mic !== 'tone') throw new DOMException('Permission denied', 'NotAllowedError');
      const ac = new AudioContext({ sampleRate: 16000 });
      const o = ac.createOscillator(); o.frequency.value = 220;
      const g = ac.createGain(); g.gain.value = 0.4;
      const d = ac.createMediaStreamDestination();
      o.connect(g); g.connect(d); o.start();
      return d.stream;
    };
    window.__cues = [];
    let sound = null;
    Object.defineProperty(window, 'typdSound', { configurable: true, set(v) { sound = v; }, get() { return sound && { play: (c) => window.__cues.push(c), setEnabled() {} }; } });
    // The meter's tallest drawn bar, in canvas px, sampled on demand.
    window.__barHeight = () => {
      const c = document.getElementById('meter'); if (!c || !c.width) return -1;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let top = c.height, bottom = -1;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 40) { if (y < top) top = y; if (y > bottom) bottom = y; break; }
      return bottom < 0 ? 0 : (bottom - top + 1) / c.height;
    };
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
  ws.onclose = () => { for (const [, p] of pending) p.rej(new Error('DevTools socket closed')); pending.clear(); };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
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
    if (process.env.OS === 'Windows_NT') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* already gone */ }
}

// A headless browser on a busy machine sometimes stops answering (an AudioContext asking for the output
// device stalled pages here now and then, as bench/pill.js found): such an attempt says nothing about
// the page, so it is thrown away and run again in a fresh browser, up to three times.
const INFRA = /timed out|socket closed|DevToolsActivePort|socket failed|ECONNREFUSED|fetch failed/;

async function pageSection() {
  section('2. the pill\'s page in a headless browser (real overlay.html/js/css; getUserMedia scripted)');
  const exe = findBrowser();
  if (!exe) { console.log('  skip  no Edge or Chrome found (set TYPD_BROWSER) -- the page checks did not run'); return; }
  console.log('    browser: ' + path.basename(exe) + ', headless');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const lines = [];
    const err = await pageAttempt(exe, lines);
    if (err && INFRA.test(err) && attempt < 3) { console.log('    (attempt ' + attempt + ': the browser stopped answering -- ' + err + '; again, in a fresh one)'); continue; }
    for (const [name, ok, detail] of lines) check(name, ok, detail);
    if (err) check('the page checks ran to the end', false, err);
    return;
  }
}

async function pageAttempt(exe, lines) {
  const check = (name, ok, detail) => lines.push([name, ok, detail]);
  let failed = null;
  const server = await serve(path.join(root, 'src', 'renderer'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-mic-'));
  const child = spawn(exe, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-component-update', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,msSleepingTabs,msEfficiencyMode',
    '--disable-gpu', '--disable-gpu-watchdog', '--disable-hang-monitor', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp = null;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 150 && !fs.existsSync(portFile); i++) await sleep(100);
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
    const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
    cdp = await connect(version.webSocketDebuggerUrl);
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const first = pages.find((t) => t.type === 'page');
    const targetId = first ? first.id : (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m, p) => cdp.send(m, p, sessionId);
    const ev = async (expr) => {
      if (process.env.TYPD_BENCH_DEBUG) console.log('    [debug] eval ' + expr.slice(0, 70));
      const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
      return r.result.value;
    };
    await S('Page.enable');
    await S('Runtime.enable');
    await S('Page.addScriptToEvaluateOnNewDocument', { source: stubScript() });
    await S('Emulation.setDeviceMetricsOverride', { width: 460, height: 240, deviceScaleFactor: 2, mobile: false });
    const url = 'http://127.0.0.1:' + server.address().port + '/overlay.html';
    const load = async () => {
      await S('Page.navigate', { url });
      for (let i = 0; i < 100; i++) {
        if (await ev('document.readyState === "complete" && Array.isArray(window.__calls) && !!window.typdSound').catch(() => false)) break;
        await sleep(50);
      }
      await sleep(150);
    };
    const tallest = async (ms) => { let h = 0; for (let t = 0; t < ms; t += 60) { h = Math.max(h, await ev('window.__barHeight()')); await sleep(60); } return h; };

    // A. macOS has not allowed the microphone: getUserMedia fails.
    await load();
    await ev('window.__mic = "denied"; window.__emit("session:start", { mode: "dictate" }); 0');
    await sleep(300);
    const problems = (await ev('window.__calls')).filter((c) => c.n === 'micProblem');
    check('a microphone that does not open is reported at once, with its error', problems.length === 1 && problems[0].a[0] === 'unavailable' && problems[0].a[1] === 'NotAllowedError', problems);
    const flat = await tallest(900);
    check('...and the meter stays flat (0.2.6 animated a made-up speech envelope here)', flat >= 0 && flat < 0.3, flat);

    // B. A stream that works -- whatever macOS's status says (the page never reads it).
    await load();
    await ev('window.__mic = "tone"; window.__emit("session:start", { mode: "dictate" }); 0');
    await sleep(1200);
    const chunks = await ev('window.__chunks');
    const moved = await tallest(600);
    const probs = (await ev('window.__calls')).filter((c) => c.n === 'micProblem');
    check('a stream that works is recorded (chunks reach main) and no microphone problem is reported', chunks >= 5 && probs.length === 0, { chunks, probs });
    check('...the meter follows the same stream', moved > 0.3, moved);
    await ev('window.__emit("session:capture-end", {}); 0');
    await sleep(400);
    const audio = await ev('window.__audio');
    check('...and the recording is delivered, not silent (transcribed as any other)', audio && audio.samples > 8000 && audio.peak > 0.05, audio);
  } catch (err) {
    failed = String(err && err.message || err);
  } finally {
    if (cdp) { try { await cdp.send('Browser.close'); } catch { /* closing */ } cdp.close(); }
    await sleep(300);
    killTree(child);
    server.close();
    for (let i = 0; i < 10; i++) { try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); } }
  }
  return failed;
}

/* ------------------------------------------------------------- 3. the sources */

function sourceSection() {
  section('3. from the sources: the session, the pill\'s words, signing, the icon');
  const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  const main = code(read('src/main/index.js'));
  const begin = main.slice(main.indexOf('function beginSession()'), main.indexOf('const controller = new AbortController();', main.indexOf('function beginSession()')));
  const micBlock = begin.slice(begin.indexOf('if (MAC && !session)'), begin.indexOf('if (!session && modelMissing())'));
  const returns = [...micBlock.matchAll(/return;/g)].length;
  const guarded = /if \(modelMissing\(\)\) \{[\s\S]*?return;\s*\}/.test(micBlock);
  check('main never holds a dictation back on the privacy status when a model is there (it asks, and records)', micBlock.length > 50 && returns === 1 && guarded && /requestMic\('the key'/.test(micBlock), { returns, guarded });
  const onMic = main.slice(main.indexOf("ipcMain.on('overlay:mic'"), main.indexOf("ipcMain.on('overlay:cancel'"));
  check('the pill\'s words come from the capture (kind) and, on a Mac, macOS\'s status says which', /kind === 'silent'/.test(onMic) && /Allow the microphone in macOS’s dialog/.test(onMic) && /requestMic\(/.test(onMic));
  check('the key is bound again once Accessibility and Input Monitoring come on (as choosing it in Settings does)', /keySwitchesOff === true && !keyOff && rebindKey/.test(main) && /rebindKey = \(\) => \{[\s\S]*?applyHotkey\(/.test(main));
  check("Copy diagnostics names SIP and AMFI's boot arguments (AMFI off: macOS refuses every non-Apple app's prompt)", /securitySettings\(\)/.test(main) && /amfi_get_out_of_my_way/.test(read('src/main/permissions-mac.js')));
  const page = code(read('src/renderer/overlay.js'));
  check('the page: the synthetic envelope only in preview builds', /synthetic = Boolean\(window\.__typdSynthetic\)/.test(page) && /if \(synthetic && window\.__typdSynthetic\)/.test(page));

  const ap = read('scripts/after-pack.js');
  check('after-pack signs the bundle with scripts/mac-entitlements.plist (--deep: the helpers too)', /'--force', '--deep', \.\.\.how\.args, \.\.\.entitlementArgs\(\), app/.test(ap));
  check('...and gives every helper the main app\'s NSMicrophoneUsageDescription before signing', /helperUsageStrings\(app\)/.test(ap) && ap.indexOf('helperUsageStrings(app);') < ap.indexOf("'--force', '--deep'"));
  check('...without the hardened runtime (no --options runtime anywhere)', !/--options|runtime['"]/.test(code(ap)) && !/--options/.test(code(read('scripts/app-update-package.js'))));
  check('the update package\'s re-sign keeps the entitlement', /\.\.\.entitlementArgs\(\), path\.join\(stage, appName\)/.test(read('scripts/app-update-package.js')));
  const ent = read('scripts/mac-entitlements.plist');
  const keys = [...ent.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  check('mac-entitlements.plist: exactly com.apple.security.device.audio-input = true', JSON.stringify(keys) === '["com.apple.security.device.audio-input"]' && /<true\/>/.test(ent), keys);
  const pkg = JSON.parse(read('package.json'));
  check('package.json: hardenedRuntime false; the Mac icon is build/icon.icns (iconutil\'s)', pkg.build.mac.hardenedRuntime === false && pkg.build.mac.icon === 'build/icon.icns');
  check('...the main Info.plist keeps NSMicrophoneUsageDescription', /dictating/.test(pkg.build.mac.extendInfo.NSMicrophoneUsageDescription || ''));

  // scripts/check-icns.js on files built here: what iconutil writes passes; 0.2.6's layout fails.
  const { check: icns } = require(path.join(root, 'scripts', 'check-icns.js'));
  const png = (n) => { const b = Buffer.alloc(33); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(n, 16); b.writeUInt32BE(n, 20); return b; };
  const argb = () => Buffer.from('ARGB' + 'x'.repeat(40), 'latin1');
  const file = (entries) => {
    const parts = entries.map(([t, d]) => { const h = Buffer.alloc(8); h.write(t, 0, 'latin1'); h.writeUInt32BE(d.length + 8, 4); return Buffer.concat([h, d]); });
    const body = Buffer.concat(parts);
    const h = Buffer.alloc(8); h.write('icns', 0, 'latin1'); h.writeUInt32BE(body.length + 8, 4);
    return Buffer.concat([h, body]);
  };
  const good = file([['ic12', png(64)], ['ic07', png(128)], ['ic13', png(256)], ['ic08', png(256)], ['ic04', argb()], ['ic14', png(512)], ['ic09', png(512)], ['ic05', argb()], ['ic10', png(1024)], ['ic11', png(32)]]);
  const old = file([['icp4', png(16)], ['icp5', png(32)], ['icp6', png(64)], ['ic07', png(128)], ['ic08', png(256)], ['ic09', png(512)], ['ic10', png(1024)], ['ic11', png(32)], ['ic12', png(64)], ['ic13', png(512)], ['ic14', png(1024)]]);
  const g = icns(good), o = icns(old);
  check('check-icns: iconutil\'s layout (every size, each at its size) passes', g.faults.length === 0, g.faults);
  check('check-icns: 0.2.6\'s file fails (ic13 512 px, ic14 1024 px, no ic04/ic05)', o.faults.length === 4 && o.faults.some((f) => /ic13.*512x512/.test(f)) && o.faults.some((f) => /ic14.*1024x1024/.test(f)), o.faults);
  check('build-mac-icon.sh makes the icon with sips + iconutil from the 1024 px master', /iconutil -c icns/.test(read('scripts/build-mac-icon.sh')) && /sips -z/.test(read('scripts/build-mac-icon.sh')));
}

(async () => {
  try { await permissionsSection(); } catch (err) { check('part 1 ran to the end', false, String(err && err.stack || err)); }
  Object.defineProperty(process, 'platform', { value: process.env.OS === 'Windows_NT' ? 'win32' : 'darwin' });
  try { await pageSection(); } catch (err) { check('part 2 ran to the end', false, String(err && err.stack || err)); }
  try { sourceSection(); } catch (err) { check('part 3 ran to the end', false, String(err && err.stack || err)); }
  console.log('\n' + (failures ? failures + ' FAILED' : 'all Mac microphone checks passed') + '\n');
  process.exit(failures ? 1 : 0);
})();
