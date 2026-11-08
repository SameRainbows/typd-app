'use strict';

/**
 * Sharing, asked (0.2.7): the two places a person answers "Help make Typd better?", rendered for real
 * in a headless Chrome or Edge with a stub of each preload's API (as bench/pill.js drives the pill):
 *
 *   1. the walkthrough's first screen (home.html/js/css, preload/home.js's API stubbed): the question
 *      word for word, Share and Don't share, neither pressed nor focused, no Next until answered;
 *      Share -> sharing:set(true) and on to step 2; Don't share -> sharing:set(false) and on; back on
 *      step 1 the answer shows and Next is there; Skip closes it with nothing answered; a tester build
 *      has no question; Settings' switch shows a not-answered install as off; its "What's shared"
 *      lists no program name and says it is never shared (0.2.12)
 *   2. the small share screen (share.html/js, ask.css, preload/ask.js's API stubbed): the same words
 *      and buttons, nothing preselected or focused; Share -> ask:share(true); Don't share ->
 *      ask:share(false); Esc closes it, answering nothing
 *
 * Headless: no window, a throwaway profile, the browser's process tree killed at the end; nothing of
 * Typd's runs (no Electron). TYPD_BROWSER=<exe> picks the browser; with none found it is skipped (and
 * says so).
 *
 *   node bench/share-choice.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const hk = require(path.join(root, 'src', 'main', 'hotkey-logic.js'));
const status = require(path.join(root, 'src', 'main', 'status.js'));

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (ok || detail === undefined ? '' : '  (' + JSON.stringify(detail).slice(0, 500) + ')'));
  if (!ok) failures++;
}
const section = (name) => console.log('\n' + name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const Q = 'Help make Typd better?';
const LINE = 'Share your dictations (audio and text) to train the model. Never sold or published. You can change this anytime in Settings.';

/* ------------------------------------------------------------- the stubbed state */

function homeState(sharing, share) {
  const p = process.platform;
  const b = hk.defaultFor(p);
  const flag = hk.flagDefaultFor(p);
  return {
    status: status.describe(),
    perms: status.get().perms,
    hotkey: { binding: b, kind: 'single', label: hk.label(b, p), short: hk.shortLabel(b, p), verb: hk.verb(b, p), parts: hk.parts(b, p),
      defaultBinding: b, defaultLabel: hk.label(b, p), sideButtons: false },
    model: { name: 'typd-dictate' },
    counts: { dictations: 0, weekWords: 0, savedSeconds: 0, typingWpm: 40 },
    platform: { mac: p === 'darwin', machine: p === 'darwin' ? 'Mac' : 'PC', os: p === 'darwin' ? 'macOS' : 'Windows' },
    version: '0.2.7',
    settings: {
      mic: '', micLabel: '', sounds: true, startAtLogin: true, keepRecordings: true, hotkey: b, sharePaused: false, share, shareAsk: 'done',
      flagHotkey: flag, showInDock: false, modelVariant: 'auto', askBeforeModelDownload: false, lowMemory: 'auto', walkthrough: 'done',
      loginSupported: true, recordings: { count: 0, mb: 0 }, sharing, flagKey: { label: hk.label(flag, p), parts: hk.parts(flag, p) }, lowMemoryNow: null
    },
    mark: null,
    flagDefault: { parts: hk.parts(flag, p) }
  };
}
const beta = (choice) => ({ mode: 'beta', state: choice === 'on' ? 'on' : 'off', choice, shared: false, id: null,
  backfill: { state: 'none', total: 0, sent: 0, left: null, by: null, auto: null } });
const SCENARIOS = {
  ask: homeState(beta('ask'), 'ask'),
  tester: homeState({ mode: 'tester', state: 'on', with: 'the developer', tester: 'tester_a', backfill: null }, 'on')
};

/** preload/home.js's API, every call recorded; sharing:set answers as main does (the settings come back). */
function homeStub() {
  return `(() => {
    const SC = ${JSON.stringify(SCENARIOS)};
    const q = new URLSearchParams(location.search);
    const st = SC[q.get('scenario') || 'ask'];
    window.__calls = [];
    window.__errors = [];
    window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
    const rec = (n, v) => (...a) => { window.__calls.push({ n, a }); return Promise.resolve(typeof v === 'function' ? v(...a) : v); };
    window.typdHome = {
      get: rec('get', () => JSON.parse(JSON.stringify(st))),
      history: { list: rec('history.list', []), copy: rec('history.copy', true), remove: rec('history.remove', true), undo: rec('history.undo', true), clear: rec('history.clear', true), keep: rec('history.keep', true) },
      dictionary: { list: rec('dictionary.list', []), add: rec('dictionary.add', true), remove: rec('dictionary.remove', true), undo: rec('dictionary.undo', true), reveal: rec('dictionary.reveal', true) },
      settings: { state: rec('settings.state', () => JSON.parse(JSON.stringify(st.settings))), set: rec('settings.set', true), openRecordings: rec('settings.openRecordings', true) },
      sharing: {
        set: rec('sharing.set', (on) => {
          st.settings.share = on ? 'on' : 'off';
          if (st.settings.sharing.mode === 'beta') Object.assign(st.settings.sharing, { state: st.settings.share, choice: st.settings.share });
          return { ok: true, settings: JSON.parse(JSON.stringify(st.settings)) };
        }),
        remove: rec('sharing.remove', { ok: true, deleted: 0 }), backfill: rec('sharing.backfill', { ok: false })
      },
      hotkey: { pause: rec('hotkey.pause', true), set: rec('hotkey.set', { ok: false }), cancel: rec('hotkey.cancel', null) },
      model: { get: rec('model.get', { needed: null }), now: rec('model.now', true), later: rec('model.later', true) },
      updates: { get: rec('updates.get', null), check: rec('updates.check', null), restart: rec('updates.restart', false) },
      walkthrough: { practice: rec('walkthrough.practice', true), done: rec('walkthrough.done', true) },
      news: rec('news', ''), action: rec('action', true), pane: rec('pane', true), feedback: rec('feedback', true), license: rec('license', true),
      on() { return () => {}; }
    };
  })();`;
}

/** preload/ask.js's API, every call recorded. */
function askStub() {
  return `(() => {
    window.__calls = [];
    window.__errors = [];
    window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
    const rec = (n, v) => (...a) => { window.__calls.push({ n, a }); return Promise.resolve(v); };
    window.typdAsk = { state: rec('state', { platform: { mac: false, machine: 'PC' } }), flag: rec('flag', null), share: rec('share', { ok: true }), close: rec('close', true), on() { return () => {}; } };
  })();`;
}

/* ------------------------------------------------------------- the browser (as bench/pill.js) */

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
  ws.onclose = (e) => { for (const [, p] of pending) p.rej(new Error('DevTools socket closed (' + e.code + ')')); pending.clear(); };
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
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* already gone */ }
}

async function run(exe) {
  const server = await serve(path.join(root, 'src', 'renderer'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-share-choice-'));
  const child = spawn(exe, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-component-update', '--mute-audio', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-gpu', '--disable-gpu-watchdog', '--disable-hang-monitor', 'about:blank'],
  { stdio: 'ignore', windowsHide: true });
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
      const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
      return r.result.value;
    };
    await S('Page.enable');
    await S('Runtime.enable');
    await S('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
    const base = 'http://127.0.0.1:' + server.address().port + '/';
    let stubId = null;
    const load = async (page, stub, ready) => {
      if (stubId) await S('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubId });
      stubId = (await S('Page.addScriptToEvaluateOnNewDocument', { source: stub })).identifier;
      await S('Page.navigate', { url: base + page });
      for (let i = 0; i < 100; i++) { if (await ev(ready).catch(() => false)) break; await sleep(50); }
      await sleep(200);
    };
    const click = async (id) => {
      const b = await ev(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
      if (!b.w) throw new Error(id + ' is not on screen');
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await S('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
      }
      await sleep(250);
    };
    const shown = (id) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); return !!e && !e.hidden && e.getBoundingClientRect().width > 0; })()`);
    const calls = (n) => ev(`window.__calls.filter((c) => c.n === ${JSON.stringify(n)}).map((c) => c.a)`);
    const text = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)}).textContent || '').replace(/\\s+/g, ' ').trim()`);
    const homeReady = 'document.readyState === "complete" && !!window.typdHome && !document.getElementById("walk").hidden';

    section('1. the walkthrough\'s first screen (home.html, a public build, not answered)');
    await load('home.html?walkthrough=1&scenario=ask', homeStub(), homeReady);
    check('the walkthrough opens on step 1, without page errors', (await text('#walkCount')) === '1 of 5' && (await ev('window.__errors.length')) === 0, await ev('window.__errors'));
    check('the question, word for word', (await text('#walkShare .walk-share-q')) === Q + ' ' + LINE, await text('#walkShare .walk-share-q'));
    check('two buttons, Share and Don’t share, both shown', (await shown('walkShareYes')) && (await shown('walkShareNo')) &&
      (await text('#walkShareYes')) === 'Share' && (await text('#walkShareNo')) === 'Don’t share');
    check('neither preselected: not pressed, not focused, the same style',
      (await ev('document.getElementById("walkShareYes").getAttribute("aria-pressed")')) === 'false' &&
      (await ev('document.getElementById("walkShareNo").getAttribute("aria-pressed")')) === 'false' &&
      (await ev('!["walkShareYes", "walkShareNo"].includes(document.activeElement && document.activeElement.id)')) &&
      (await ev('getComputedStyle(document.getElementById("walkShareYes")).backgroundColor === getComputedStyle(document.getElementById("walkShareNo")).backgroundColor')));
    check('no Next until it is answered (it cannot move past this screen without an answer)', !(await shown('walkNext')));
    check('Settings\' switch shows "not answered" as off, and says so', (await ev('document.getElementById("betaShare").checked')) === false &&
      /^Off until you choose/.test(await text('#betaHelp')), await text('#betaHelp'));
    const what = await text('#betaWhat');
    check('Settings\' "What’s shared" no longer lists the program you dictated into, and says it is never shared (0.2.12)',
      /^For each dictation: the audio and the text Typd typed/.test(what) && !/Discord/.test(what) && !/For each dictation:[^.]*program/.test(what) &&
      /Never shared: [^.]*which program you dictated into/.test(what), what);
    await click('walkShareYes');
    check('Share: sharing:set(true), once', JSON.stringify(await calls('sharing.set')) === '[[true]]', await calls('sharing.set'));
    check('... and on to step 2', (await text('#walkCount')) === '2 of 5' && !(await shown('walkShare')));
    await click('walkBack');
    check('back on step 1: Share shows as the answer, and Next is there', (await ev('document.getElementById("walkShareYes").getAttribute("aria-pressed")')) === 'true' &&
      (await ev('document.getElementById("walkShareNo").getAttribute("aria-pressed")')) === 'false' && (await shown('walkNext')));
    check('Settings\' switch now on', (await ev('document.getElementById("betaShare").checked')) === true);

    await load('home.html?walkthrough=1&scenario=ask', homeStub(), homeReady);
    await click('walkShareNo');
    check('Don’t share: sharing:set(false), once, and on to step 2', JSON.stringify(await calls('sharing.set')) === '[[false]]' && (await text('#walkCount')) === '2 of 5', await calls('sharing.set'));

    await load('home.html?walkthrough=1&scenario=ask', homeStub(), homeReady);
    await click('walkSkip');
    check('Skip on step 1: the walkthrough closes, nothing answered (sharing stays off)', !(await shown('walk')) && (await calls('sharing.set')).length === 0);

    await load('home.html?walkthrough=1&scenario=tester', homeStub(), homeReady);
    check('a tester build: no question, Next as before', !(await shown('walkShare')) && (await shown('walkNext')) && (await ev('window.__errors.length')) === 0);

    section('2. the small share screen (share.html)');
    const askReady = 'document.readyState === "complete" && !!window.typdAsk';
    await load('share.html', askStub(), askReady);
    check('the same words', (await text('h1')) === Q && (await text('#shareText')) === LINE && (await ev('window.__errors.length')) === 0);
    check('the same two buttons, the same style, neither focused', (await text('#shareYes')) === 'Share' && (await text('#shareNo')) === 'Don’t share' &&
      (await ev('document.getElementById("shareYes").className === document.getElementById("shareNo").className')) &&
      (await ev('!["shareYes", "shareNo"].includes(document.activeElement && document.activeElement.id)')));
    await click('shareYes');
    check('Share: ask:share(true), once', JSON.stringify(await calls('share')) === '[[true]]', await calls('share'));
    await load('share.html', askStub(), askReady);
    await click('shareNo');
    check('Don’t share: ask:share(false), once', JSON.stringify(await calls('share')) === '[[false]]', await calls('share'));
    await load('share.html', askStub(), askReady);
    await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(200);
    check('Esc closes it, answering nothing', (await calls('close')).length === 1 && (await calls('share')).length === 0);
  } finally {
    if (cdp) cdp.close();
    killTree(child);
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* the OS cleans its temp folder */ }
  }
}

(async () => {
  console.log('Sharing, asked: the walkthrough\'s first screen and the share screen, in a headless browser');
  const exe = findBrowser();
  if (!exe) { console.log('  skip  no Edge or Chrome found (set TYPD_BROWSER) -- the page checks did not run'); process.exit(0); }
  console.log('    browser: ' + path.basename(exe) + ', headless');
  // A browser that stops answering (a busy machine; something ending browser processes) is not a
  // failure of the page: that attempt is thrown away and run again in a fresh browser, up to three
  // times, as bench/pill.js does. A check that fails in an attempt that ran through counts.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = failures;
    try {
      await run(exe);
      break;
    } catch (err) {
      const infra = /timed out|closed|ECONNRESET|socket hang up|Target closed/i.test(String(err && err.message));
      if (infra && attempt < 3) {
        failures = before;
        console.log('    (attempt ' + attempt + ': the browser stopped answering -- ' + err.message + '; again, in a fresh one)');
        continue;
      }
      check('the page checks ran to the end', false, String(err && err.stack || err));
    }
  }
  console.log('\n' + (failures ? failures + ' FAILED' : 'all share-choice checks passed') + '\n');
  process.exit(failures ? 1 : 0);
})();
