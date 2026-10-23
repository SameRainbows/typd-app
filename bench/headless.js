'use strict';

/**
 * A page of Typd's in a headless Chrome or Edge, over the DevTools protocol: no window, a throwaway
 * profile, the browser's process tree killed at the end. The same way bench/pill.js runs the pill's
 * page (its helpers, shared here for bench/copy-popup.js).
 *
 *   const h = await open(dir, { width, height, dpr, stub });   // dir: the folder the page loads from
 *   await h.load('popup.html'); await h.ev('1 + 1'); await h.S('Input.dispatchMouseEvent', {...});
 *   await h.close();
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  ws.onclose = (e) => {
    for (const [, p] of pending) p.rej(new Error('DevTools socket closed (' + e.code + ')'));
    pending.clear();
  };
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
      return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.delete(i)) rej(new Error(method + " timed out")); }, 10000); });
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

/** Failures that say the browser stopped answering, not that the page is wrong (retry in a fresh one). */
const INFRA = /timed out|socket closed|DevToolsActivePort|socket failed|ECONNREFUSED|fetch failed/;

async function open(dir, { width = 460, height = 240, dpr = 1, stub = '' } = {}) {
  const exe = findBrowser();
  if (!exe) return null;
  const server = await serve(dir);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-page-'));
  const child = spawn(exe, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-component-update', '--mute-audio',
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,msSleepingTabs,msEfficiencyMode',
    '--disable-gpu', '--disable-gpu-watchdog', '--disable-hang-monitor',
    'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp = null;
  const close = async () => {
    if (cdp) cdp.close();
    killTree(child);
    server.close();
    await sleep(200);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold a file */ }
  };
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
    const t0 = Date.now();
    const ev = async (expr) => {
      if (process.env.TYPD_BENCH_DEBUG) console.log('    [debug] +' + (Date.now() - t0) + ' ms ' + expr.slice(0, 70).replace(/\s+/g, ' '));
      const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
        .catch((err) => { throw new Error(err.message + ' (' + expr.slice(0, 60) + ')'); });
      if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
      return r.result.value;
    };
    await S('Page.enable');
    await S('Runtime.enable');
    if (stub) await S('Page.addScriptToEvaluateOnNewDocument', { source: stub });
    await S('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
    const base = 'http://127.0.0.1:' + server.address().port + '/';
    const load = async (page, ready = 'document.readyState === "complete"') => {
      await S('Page.navigate', { url: base + page });
      for (let i = 0; i < 100; i++) {
        if (await ev(ready).catch(() => false)) break;
        await sleep(50);
      }
      await sleep(100);
    };
    return { exe, S, ev, load, close, sleep };
  } catch (err) {
    await close();
    throw err;
  }
}

module.exports = { open, findBrowser, INFRA, sleep };
