'use strict';

/**
 * Nothing of Typd's stops Typd on a first run (0.2.11).
 *
 *   node bench/no-modal.js
 *
 * On a brand-new Mac (CI, 0.2.10) "Typd needs two switches turned on" opened with
 * dialog.showMessageBox and no parent window: on macOS an NSAlert in runModal, which stops the main
 * process. The speech model's download stood still while it was up (19.7 MB for 60 s; 244 MB for
 * 34 min when nobody answered) and the walkthrough's bar froze with it. Electron does the same for a
 * parent window that is not on screen, and for its own error box after an uncaught exception.
 *
 * 1. permissions-mac.js headless, with a stand-in for Electron: over the walkthrough no dialog at all
 *    (the window lists the switches); when the walkthrough ends, the same plain words as a sheet on the
 *    Typd window, and Open System Settings opens the pane; a sheet nobody answers holds nothing up (a
 *    "download" timer keeps ticking); with no Typd window on screen -- none, hidden, minimized and
 *    never restored -- showMessageBox is never called.
 * 2. from the sources, on Mac and Windows: every showMessageBox in src/ goes through mac/sheet.js
 *    with a parent window (but the parked cascade engine's, TYPD_ENGINE=cascade only); no
 *    showMessageBoxSync or showErrorBox anywhere; main has its own uncaughtException listener (so
 *    Electron's modal error box never shows); index.js wires the window and the walkthrough hold
 *    before the first dialog; the walkthrough tells main when it ends.
 * 3. the walkthrough's microphone card: no "Ask again" next to "✓ Microphone allowed."
 *    (renderMic from src/renderer/home.js, run against stand-in elements).
 * 4. package.json: the publisher (author) is set and the install identity is 0.2.10's.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

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

function world() {
  const w = {
    mic: 'granted', ax: false, listen: 'denied',
    sheets: [], modal: 0, answer: null, opened: [], life: [],
    userData: fs.mkdtempSync(path.join(os.tmpdir(), 'typd-nomodal-'))
  };
  w.win = { visible: true, minimized: false, destroyed: false, restored: 0,
    isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; }, isMinimized() { return this.minimized; },
    restore() { this.restored++; }, once() {}, removeListener() {} };
  w.windowFor = () => w.win;
  w.electron = {
    app: { isPackaged: true, focus() {}, getAppPath: () => root, getPath: () => w.userData, quit() {} },
    dialog: {
      showMessageBox(a, b) {
        if (!b) { w.modal++; return Promise.resolve({ response: (a && a.cancelId) || 0 }); }
        w.sheets.push({ parent: a, o: b });
        return w.answer === null ? new Promise(() => {}) : Promise.resolve({ response: w.answer });   // null: nobody answers
      }
    },
    shell: { openExternal: async (u) => { w.opened.push(u); } },
    systemPreferences: {
      getMediaAccessStatus: () => w.mic,
      askForMediaAccess: async () => true,
      isTrustedAccessibilityClient: () => w.ax
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    ipcMain: { on() {} }
  };
  w.inject = { listenAccess: async () => w.listen, requestListen: async () => ({ ok: true }), prime: async () => ({ ok: true }) };
  w.lifelog = { log: (what, detail) => w.life.push(what + ': ' + detail) };
  return w;
}

const PM = path.join(root, 'src', 'main', 'permissions-mac.js');
const SHEET = path.join(root, 'src', 'main', 'mac', 'sheet.js');
let current = null;
const load0 = Module._load;
Module._load = function (request, parent, isMain) {
  if (current && request === 'electron') return current.electron;
  if (current && parent && (parent.filename === PM || parent.filename === SHEET)) {
    if (request === './inject') return current.inject;
    if (request === './lifelog' || request === '../lifelog') return current.lifelog;
    if (request === './hotkeys' || request === './settings') throw new Error('not in this bench');
  }
  return load0.apply(this, arguments);
};

function fresh(w) {
  current = w;
  delete require.cache[PM];
  require(SHEET).use(() => w.windowFor());
  return require(PM);
}

async function permissionsSection() {
  section('1. permissions-mac.js: a fresh Mac, microphone allowed, Accessibility and Input Monitoring off');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  {
    const w = world();
    const pm = fresh(w);
    let walk = true;   // the walkthrough is on screen
    pm.holdWhile(() => walk);
    const r = await pm.ensure('startup');
    check('over the walkthrough: no dialog of Typd’s at all (0.2.10 put an app-modal one over it)', r === false && w.sheets.length === 0 && w.modal === 0, { sheets: w.sheets.length, modal: w.modal });
    check('...and the life log says why', w.life.some((l) => /no dialog over the walkthrough/.test(l) && /accessibility, input/.test(l)), w.life);
    await pm.ensure('accessibility');
    check('...a later check meanwhile (a paste that failed) keeps it back too', w.sheets.length === 0 && w.modal === 0);
    check('...and isAsking() stays false, so the walkthrough and app updates are not held either', pm.isAsking() === false);

    walk = false;
    w.answer = null;   // nobody answers the sheet
    pm.walkthroughEnded();
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 50);   // the model download's progress, say
    for (let i = 0; i < 40 && !w.sheets.length; i++) await sleep(100);
    const s = w.sheets[0];
    check('when the walkthrough ends: the dialog, as a sheet on the Typd window', Boolean(s && s.parent === w.win) && w.modal === 0, { sheets: w.sheets.length, modal: w.modal });
    check('...in the same plain words: "Typd needs two switches turned on", Accessibility and Input Monitoring, why and how',
      Boolean(s) && s.o.message === 'Typd needs two switches turned on' && /^Accessibility — to paste/.test(s.o.detail) && /Input Monitoring — to hear/.test(s.o.detail) && /In Privacy & Security, turn on “Typd” in each list/.test(s.o.detail), s && s.o);
    check('...with Open System Settings first and Not Now', Boolean(s) && s.o.buttons.join('|') === 'Open System Settings|Not Now' && s.o.defaultId === 0 && s.o.cancelId === 1, s && s.o.buttons);
    const before = ticks;
    await sleep(600);
    clearInterval(timer);
    check('a sheet nobody answers holds nothing up: the download timer kept ticking under it', ticks - before >= 8, { ticks: ticks - before });
    check('...and while it is up, isAsking() says so (no app update quits under it)', pm.isAsking() === true);
  }
  {
    const w = world();
    w.answer = 0;
    const pm = fresh(w);
    pm.holdWhile(() => false);   // not a fresh install: no walkthrough
    await pm.ensure('startup');
    await sleep(50);
    check('an earlier install (no walkthrough): the sheet at once; Open System Settings opens Privacy & Security › Accessibility',
      w.sheets.length === 1 && w.sheets[0].parent === w.win && w.modal === 0 && w.opened.some((u) => /Privacy_Accessibility/.test(u)), { opened: w.opened, modal: w.modal });
  }
  for (const [name, setup] of [
    ['no Typd window at all', (w) => { w.windowFor = () => null; }],
    ['a Typd window that is destroyed', (w) => { w.win.destroyed = true; }],
    ['a Typd window that never comes on screen (10 s)', (w) => { w.win.visible = false; }],
    ['a minimized Typd window that will not restore (10 s)', (w) => { w.win.minimized = true; }]
  ]) {
    const w = world();
    setup(w);
    const pm = fresh(w);
    pm.holdWhile(() => false);
    const t0 = Date.now();
    const r = await pm.ensure('startup');
    check(name + ': showMessageBox never called (Electron would make it app-modal)', r === false && w.sheets.length === 0 && w.modal === 0 && Date.now() - t0 < 12000,
      { sheets: w.sheets.length, modal: w.modal, ms: Date.now() - t0 });
    if (name.startsWith('a minimized')) check('...it was asked to restore first', w.win.restored === 1);
    check('...said in the life log', w.life.some((l) => /^dialog: not shown \(no Typd window on screen/.test(l)), w.life);
  }
  {
    const w = world();
    w.answer = 1;
    w.win.visible = false;
    setTimeout(() => { w.win.visible = true; }, 400);   // the window opened for it, shown when ready
    const pm = fresh(w);
    pm.holdWhile(() => false);
    await pm.ensure('startup');
    check('a window still opening: the sheet waits for it to be on screen, then attaches', w.sheets.length === 1 && w.modal === 0);
  }
  current = null;
}

/* ------------------------------------------------- 2. the sources */

function sourcesSection() {
  section('2. from the sources (Mac and Windows): no modal dialog can stop Typd');
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(path.join(root, d))) { const p = d + '/' + f; if (fs.statSync(path.join(root, p)).isDirectory()) walk(p); else if (/\.js$/.test(f)) files.push(p); } };
  walk('src');
  const calls = [];
  for (const f of files) {
    const s = read(f);
    for (const m of s.matchAll(/\bshowMessageBox(Sync)?\s*\(|\bshowErrorBox\s*\(/g)) calls.push({ f, at: s.slice(0, m.index).split('\n').length, call: m[0], line: s.split('\n')[s.slice(0, m.index).split('\n').length - 1].trim() });
  }
  check('no showMessageBoxSync or showErrorBox anywhere in src/', !calls.some((c) => /Sync|ErrorBox/.test(c.call)), calls.filter((c) => /Sync|ErrorBox/.test(c.call)));
  const code = calls.filter((c) => !/^(\*|\/\/)/.test(c.line));   // not the comments that name them
  calls.length = 0; calls.push(...code);
  const sheetCalls = calls.filter((c) => c.f === 'src/main/mac/sheet.js');
  check('mac/sheet.js shows its dialog with a parent window only', sheetCalls.length === 1 && /showMessageBox\(win, options\)/.test(sheetCalls[0].line), sheetCalls);
  const sheet = read('src/main/mac/sheet.js');
  check('...and only once that window is on screen (visible, not minimized)', /if \(!onScreen\(win\)\)[\s\S]{0,300}return null;[\s\S]*dialog\.showMessageBox\(win, options\)/.test(sheet) && /isVisible\(\) && !win\.isMinimized\(\)/.test(sheet));
  const other = calls.filter((c) => c.f !== 'src/main/mac/sheet.js');
  const idx = read('src/main/index.js');
  const cascade = other.length === 1 && other[0].f === 'src/main/index.js' && /if \(!stub && pipeline\.ENGINE === 'cascade' && !process\.env\.POOLSIDE_API_KEY\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*dialog\.showMessageBox\(/.test(idx);
  check('every other showMessageBox is gone but the parked cascade engine’s (TYPD_ENGINE=cascade only; async, off the main thread on Windows)', cascade, other);
  check('permissions-mac.js and mac/app-location.js ask through the sheet', /require\('\.\/mac\/sheet'\)\.show\(\{[\s\S]{0,200}Typd needs \$\{count\} turned on/.test(read('src/main/permissions-mac.js')) &&
    /sheet\.show\(\{[\s\S]{0,300}Move Typd to your Applications folder/.test(read('src/main/mac/app-location.js')) && !/\bdialog\b/.test(read('src/main/mac/app-location.js').replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '').replace(/'[^'\n]*'/g, '')));
  check('main has an uncaughtException listener of its own (Electron’s fallback is a modal error box)', /process\.on\('uncaughtException', /.test(idx));
  const useAt = idx.indexOf("require('./mac/sheet').use(");
  const holdAt = idx.indexOf("require('./permissions-mac').holdWhile(() => walkthroughDue() || home.walkthroughShowing())");
  const firstAsk = idx.indexOf('location.offerMove()');
  check('index.js gives the sheet the Typd window (opened if closed) and holds the dialog over the walkthrough, before the move offer and the first check',
    useAt > 0 && holdAt > 0 && useAt < firstAsk && holdAt < firstAsk && /if \(!home\.isOpen\(\)\) home\.open\('home'/.test(idx.slice(useAt, useAt + 300)));
  const hw = read('src/main/home-window.js');
  check('home-window.js: the walkthrough is on screen from its opening until walkthrough:closed or the window closes, then main is told',
    /handle\('walkthrough:done', \(\) => \{ walkOn = true;/.test(hw) && /handle\('walkthrough:closed', \(\) => \{ endWalk\(\);/.test(hw) && /win\.on\('closed', \(\) => \{[\s\S]{0,80}endWalk\(\);/.test(hw) && /deps\.walkthroughEnded\(\)/.test(hw) && /walkthroughEnded: \(\) => \{ if \(MAC\) require\('\.\/permissions-mac'\)\.walkthroughEnded\(\); \}/.test(idx));
  check('the renderer tells main when the walkthrough closes', /function close\(\) \{[\s\S]{0,200}api\.walkthrough\.closed\(\)/.test(read('src/renderer/home.js')) && /closed: call\('walkthrough:closed'\)/.test(read('src/preload/home.js')));
}

/* ------------------------------------------------- 3. the walkthrough's microphone card */

function micCardSection() {
  section('3. the walkthrough’s microphone card (renderMic from src/renderer/home.js)');
  const src = read('src/renderer/home.js');
  const start = src.indexOf('    var hadMic = false;');
  const end = src.indexOf('    // No speech model yet');
  const body = src.slice(start, end);
  const els = {};
  const $ = (id) => (els[id] = els[id] || { id, hidden: true, disabled: false, textContent: '', classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); } } });
  const S = { platform: { mac: true }, mic: 'asking' };
  // eslint-disable-next-line no-new-func
  const renderMic = new Function('$', 'S', body + '\nreturn renderMic;')($, S);
  renderMic();
  check('asking: "Ask again" shown', !$('walkMic').hidden && !$('walkMicAllow').hidden && $('walkMicAllow').textContent === 'Ask again');
  S.mic = 'granted';
  renderMic();
  check('then allowed: "✓ Microphone allowed." and no "Ask again" next to it (0.2.10 left the button)', !$('walkMic').hidden && $('walkMicText').textContent === '✓ Microphone allowed.' && $('walkMicAllow').hidden === true,
    { text: $('walkMicText').textContent, button: !$('walkMicAllow').hidden && $('walkMicAllow').textContent });
  S.mic = 'denied';
  renderMic();
  check('turned off again later: the button is back (Open System Settings)', !$('walkMicAllow').hidden && $('walkMicAllow').textContent === 'Open System Settings');
}

/* ------------------------------------------------- 4. the publisher */

function publisherSection() {
  section('4. package.json: the publisher, and the install identity unchanged');
  const pkg = JSON.parse(read('package.json'));
  const b = pkg.build || {};
  check('author is Mehmet Dedeler (Windows: Publisher in Installed apps)', pkg.author === 'Mehmet Dedeler' || (pkg.author && pkg.author.name === 'Mehmet Dedeler'), pkg.author);
  check('appId ai.typd.app, productName Typd, name typd (install folder %LOCALAPPDATA%\\Programs\\typd)', b.appId === 'ai.typd.app' && b.productName === 'Typd' && pkg.name === 'typd', { appId: b.appId, productName: b.productName, name: pkg.name });
  const nsis = b.nsis || {};
  check('NSIS per-user, one click, no guid of its own (the uninstall key stays the one derived from appId)', nsis.perMachine !== true && nsis.oneClick !== false && !nsis.guid, nsis);
}

(async () => {
  await permissionsSection();
  sourcesSection();
  micCardSection();
  publisherSection();
  console.log(failures ? `\n${failures} check(s) failed` : '\nnothing of Typd’s stops Typd on a first run: all checks passed');
  process.exit(failures ? 1 : 0);
})();
