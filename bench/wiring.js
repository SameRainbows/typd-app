'use strict';

/**
 * Does the overlay's wiring still join up?
 *
 * Every seam checked here fails *silently* at runtime rather than throwing,
 * which is why a static check earns its place:
 *
 *   - getElementById on a renamed id returns null, and the first property
 *     access on it throws deep inside an event handler, long after the cause
 *   - typdSound.play() swallows an unknown cue name by design, because audio
 *     is never worth throwing over -- so a typo is just silence
 *   - a channel missing from the preload allow-list never fires at all; main
 *     sends into nothing and the overlay simply never updates
 *   - EXIT_MS and --dur-exit are the same number written in two files; when
 *     they drift the pill is hidden mid-transition
 *
 * None of this needs Electron, a model or a key.
 *
 *   node bench/wiring.js
 */

const fs = require('fs');
const path = require('path');

const root = process.argv[2] || path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const html = read('src/renderer/overlay.html');
const js = read('src/renderer/overlay.js');
const snd = read('src/renderer/sound.js');
const pre = read('src/preload/overlay.js');
const main = read('src/main/index.js');
const pipe = read('src/main/pipeline/index.js');
const stub = read('src/main/pipeline/stub.js');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
}

function section(name) { console.log('\n' + name); }

/* ---------------------------------------------------------------- elements */

section('element ids the renderer expects');
const ids = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
[...new Set(ids)].forEach((id) => check('#' + id, html.includes('id="' + id + '"')));

/* ------------------------------------------------------------------ sounds */

section('sound cues the renderer plays');
const cueNames = new Set();
for (const m of js.matchAll(/typdSound\.play\(([^;]*?)\)\s*;/g)) {
  const arg = m[1].replace(/[=!]==?\s*'[A-Za-z]+'/g, '');   // drop comparisons
  for (const q of arg.matchAll(/'([A-Za-z]+)'/g)) cueNames.add(q[1]);
}
[...cueNames].sort().forEach((n) => {
  check(n, new RegExp('\\b' + n + ':\\s*function').test(snd));
});

/* --------------------------------------------------------------- channels */

section('IPC channels');
const listens = [...new Set([...js.matchAll(/typd\.on\('([^']+)'/g)].map((m) => m[1]))];
listens.forEach((c) => check(c + '  allowed by preload', pre.includes("'" + c + "'")));

// Anything main sends must also be allowed, or it lands nowhere.
const sends = new Set();
for (const m of main.matchAll(/send\('(session:[^']+)'/g)) sends.add(m[1]);
// The generic forwarder covers whatever the pipeline yields -- except what main handles itself and
// never forwards: a refused revision becomes a session:error (pipeline/guards.js).
const consumed = new Set([...main.matchAll(/if \(event\.type === '([a-z]+)'\) \{[^]*?\s+break;\s+\}/g)].map((m) => m[1]).filter((t) => t !== 'done'));
for (const m of pipe.matchAll(/type: '([a-z]+)'/g)) if (!consumed.has(m[1])) sends.add('session:' + m[1]);
[...sends].sort().forEach((c) => check(c + '  allowed by preload', pre.includes("'" + c + "'")));
check('a refused revision is handled in main (never forwarded as is), and ends as a session:error', consumed.has('refused') &&
  /event\.type === 'refused'[^]*?send\('session:error', \{ message: event\.message \}\);\s+break;/.test(main));

/* ----------------------------------------------------------------- states */

section('states');
const cssStates = new Set([...read('src/renderer/overlay.css').matchAll(/data-state="([a-z]+)"/g)].map((m) => m[1]));
const jsStates = new Set([...js.matchAll(/setState\('([a-z]+)'\)/g)].map((m) => m[1]));
console.log('    css knows: ' + [...cssStates].sort().join(', '));
console.log('    js  sets : ' + [...jsStates].sort().join(', '));
const BASE = new Set(['idle', 'listening']);   // idle is hidden; listening is the base look
check('every non-base state has a css rule',
  [...jsStates].every((s) => BASE.has(s) || cssStates.has(s)),
  '(base: ' + [...BASE].join(', ') + ')');
check('every css state is one the renderer can reach',
  [...cssStates].every((s) => jsStates.has(s)));
check('streaming and result are gone from both',
  !jsStates.has('streaming') && !jsStates.has('result') &&
  !cssStates.has('streaming') && !cssStates.has('result'));

/* ---------------------------------------------------------------- protocol */

section('progress protocol');
check('pipeline emits expect', /type: 'expect'/.test(pipe));
check('stub emits expect', /type: 'expect'/.test(stub));
check('renderer consumes expect', /session:expect/.test(js));
check('renderer drives width from it', /progressEl\.style\.width/.test(js));

/* ------------------------------------------------------------ the window */

// The Typd window (home-window.js, preload/home.js, renderer/home.*) fails the same
// silent ways: a renamed id, a call the preload does not expose, a channel main never
// handles -- and one more that matters more here, a handler that forgets to check
// who is calling. Every one goes through handle(), which checks fromPage().
section('the Typd window');
const hHtml = read('src/renderer/home.html');
const hJs = read('src/renderer/home.js');
const hPre = read('src/preload/home.js');
const hMain = read('src/main/home-window.js');

const hIds = [...new Set([...hJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
const missingIds = hIds.filter((id) => !hHtml.includes('id="' + id + '"'));
check('every $(id) in home.js exists in home.html (' + hIds.length + ')', !missingIds.length, missingIds.join(', '));

const preCalls = [...hPre.matchAll(/call\('([^']+)'\)/g)].map((m) => m[1]);
const handled = [...hMain.matchAll(/handle\('([^']+)'/g)].map((m) => m[1]);
const unhandled = preCalls.filter((c) => !handled.includes(c));
check('every preload call has a handler in main (' + preCalls.length + ')', !unhandled.length, unhandled.join(', '));

const directHandles = (hMain.match(/ipcMain\.handle\(/g) || []).length;
check('every handler goes through handle(), which checks fromPage()',
  directHandles === 1 && /function handle\([^)]*\)\s*\{\s*ipcMain\.handle\(channel, \(e, \.\.\.args\) => \(fromPage\(e\)/.test(hMain));

const apiUses = [...hJs.matchAll(/api\.([a-z]+)(?:\.([a-zA-Z]+))?\(/g)].map((m) => m[2] ? m[1] + '.' + m[2] : m[1]);
const exposed = new Set(['on', ...[...hPre.matchAll(/^ {2}([a-z]+): call\(/gm)].map((m) => m[1])]);   // top-level calls, and on()
for (const m of hPre.matchAll(/^ {2}([a-z]+): \{([\s\S]*?)^ {2}\}/gm)) {
  for (const k of m[2].matchAll(/^ {4}([a-zA-Z]+):/gm)) exposed.add(m[1] + '.' + k[1]);
}
const unexposed = [...new Set(apiUses)].filter((u) => !exposed.has(u));
check('every api.* the page calls is exposed by the preload', !unexposed.length, unexposed.join(', '));

const events = (hPre.match(/const EVENTS = \[([^\]]+)\]/) || [, ''])[1];
const listened = [...new Set([...hJs.matchAll(/api\.on\('([^']+)'/g)].map((m) => m[1]))];
const sent = [...new Set([...hMain.matchAll(/send\('([a-z]+:[a-z-]+)'/g)].map((m) => m[1]))];
const notAllowed = [...listened, ...sent].filter((c) => !events.includes("'" + c + "'"));
check('every event sent or listened for is allowed by the preload', !notAllowed.length, notAllowed.join(', '));

check('the overlay reports devices for the tray menu',
  /devices\(list\)/.test(pre) && /typd\.devices\(/.test(js) && /'overlay:devices'/.test(main));
check('the pill is pinned dark, whatever the system theme',
  /<html[^>]*data-scheme="dark"/.test(html) && !/@media \(prefers-color-scheme/.test(read('src/renderer/overlay.css')));

/* ------------------------------------------------ the "That was wrong" window */

// Sharing's one question (ask-window.js, preload/ask.js, renderer/flag.*): the same silent seams
// as the Typd window. Since 0.2.4 there is no consent screen (public builds share unless turned
// off in Settings; the walkthrough's first screen says so).
section('the "That was wrong" window, and no consent screen');
const aMain = read('src/main/ask-window.js');
const aPre = read('src/preload/ask.js');
for (const page of ['flag']) {
  const pHtml = read('src/renderer/' + page + '.html');
  const pJs = read('src/renderer/' + page + '.js');
  const pIds = [...new Set([...pJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  const missing = pIds.filter((id) => !pHtml.includes('id="' + id + '"'));
  check(page + ': every $(id) exists in its page (' + pIds.length + ')', !missing.length, missing.join(', '));
  const used = [...new Set([...pJs.matchAll(/api\.([a-z]+)\(/g)].map((m) => m[1]))];
  const notExposed = used.filter((u) => !new RegExp('^ {2}' + u + '(:|\\()', 'm').test(aPre));
  check(page + ': every api.* it calls is exposed by preload/ask.js', !notExposed.length, notExposed.join(', '));
  check(page + ': loads only its own script and ask.css, under the same CSP',
    pHtml.includes('<script src="' + page + '.js"></script>') && pHtml.includes('href="ask.css"') && pHtml.includes("script-src 'self'"));
}
const aCalls = [...aPre.matchAll(/call\('([^']+)'\)/g)].map((m) => m[1]);
const aHandled = [...aMain.matchAll(/handle\('([^']+)'/g)].map((m) => m[1]);
const aUnhandled = aCalls.filter((c) => !aHandled.includes(c));
check('every preload/ask.js call has a handler (' + aCalls.length + ')', !aUnhandled.length, aUnhandled.join(', '));
check('every handler goes through handle(), which checks the page',
  (aMain.match(/ipcMain\.handle\(/g) || []).length === 1 && /const kind = pageOf\(e\);\s*return kind \? fn\(kind/.test(aMain));
const aEvents = (aPre.match(/const EVENTS = \[([^\]]+)\]/) || [, ''])[1];
const aSent = [...new Set([...aMain.matchAll(/send\('([a-z]+:[a-z-]+)'/g)].map((m) => m[1]))];
const aListened = [...new Set(['flag'].flatMap((p) => [...read('src/renderer/' + p + '.js').matchAll(/api\.on\('([^']+)'/g)].map((m) => m[1])))];
const aNotAllowed = [...aSent, ...aListened].filter((c) => !aEvents.includes("'" + c + "'"));
check('every event sent or listened for is allowed by preload/ask.js', !aNotAllowed.length, aNotAllowed.join(', '));

check('flag: asks "Share this one dictation so it can be fixed?"', /Share this one dictation so it can be fixed\?/.test(read('src/renderer/flag.html')));
check('no consent screen: no page, no window kind, nothing in main opens one',
  !fs.existsSync(path.join(__dirname, '..', 'src', 'renderer', 'consent.html')) && !fs.existsSync(path.join(__dirname, '..', 'src', 'renderer', 'consent.js')) &&
  !/consent\.html/.test(aMain) && !/ask:consent/.test(aMain + aPre) && !/ask\.open\('consent'\)/.test(main) && !/needsConsent|askConsent/.test(main + read('src/main/home-window.js')));
check('main queues a dictation only through sharing.add', /sharing\.add\(current, event\.text\)/.test(main) && !/collect\.add\(/.test(main));

// Sharing on by default in public builds (0.2.4), and how it is said and undone.
section('sharing on by default (public builds)');
const sSrc = read('src/main/settings.js'), shSrc = read('src/main/sharing.js'), hwSrc = read('src/main/home-window.js');
check("settings: 'share' defaults to 'on'", /\n\s*share: 'on',/.test(sSrc.replace(/\r\n/g, '\n')));
check("settings: a saved '' (never answered) or no value reads 'on'; 'off' is kept; anything else is 'off'",
  /cache\.share = shareFrom\(saved\);/.test(sSrc) && /saved\.share === '' \|\| saved\.share === 'on'\) return 'on';\s*return 'off';/.test(sSrc));
check("settings: only 'on' or 'off' can be set", /if \(key === 'share' && !\['on', 'off'\]\.includes\(value\)\) return false;/.test(sSrc));
check("sharing: only 'off' is off for a public build; a tester build keeps its key and pause",
  /const sharingOn = \(\) => \(mode === 'tester' \? !paused\(\) : choice\.get\(\) !== 'off'\);/.test(shSrc));
check('Settings: the switch works at once both ways (no window in between)',
  /handle\('sharing:set', async \(on\) => \{[\s\S]*?const r = await deps\.chooseSharing\(on\);/.test(hwSrc) && !/sharing:about/.test(hwSrc + read('src/preload/home.js')));
const rowAt = hHtml.indexOf('id="betaRow"'), recAt = hHtml.indexOf('id="recTitle"'), modelAt = hHtml.indexOf('id="modelRow"');
check('Settings: "Share dictations" sits right after "Keep recordings", before the model rows', recAt > 0 && rowAt > recAt && rowAt < modelAt);
check('Settings: "What\u2019s shared" opens the list in place, with what is never shared and the update-check line',
  /id="betaWhat" hidden/.test(hHtml) && /\$\('betaWhat'\)\.hidden = !open;/.test(hJs) && /Never shared: what\u2019s on your screen, text you had selected, window titles, or anything when you\u2019re not dictating\./.test(hHtml));
const LINE = 'Help improve Typd: your dictations are shared to train the model. Turn off anytime in Settings.';
check('walkthrough: the line, word for word, on step 1 only, in a public build with sharing on',
  hJs.includes("var SHARE_LINE = '" + LINE + "';") && /var note = step === 1 && publicSharing\(\) \? SHARE_LINE : '';/.test(hJs) &&
  /return Boolean\(sh && sh\.mode === 'beta' && sh\.state === 'on'\);/.test(hJs) && /id="walkNote" hidden/.test(hHtml));
check('TYPD_NO_SHARE=1 turns sharing off for the run (CI launches)', /if \(process\.env\.TYPD_NO_SHARE === '1'\) return main;/.test(shSrc));
for (const f of ['scripts/mac-close-check.sh', 'scripts/mac-launch-loop.sh', '.github/workflows/mac.yml']) {
  const t = read(f);
  const launches = (t.match(/open "\$APP" --env|"\$APP\/Contents\/MacOS\/Typd" > app\.log|"\$BIN" > "\$LOG"|launchctl setenv TYPD_DEBUG/g) || []).length;
  const noShare = (t.match(/TYPD_NO_SHARE/g) || []).length;
  check(f + ': every launch of the packaged app shares nothing (TYPD_NO_SHARE=1)', launches > 0 && noShare >= launches, [launches, noShare]);
}

/* -------------------------------------------------------- staying running */

// A tester's Mac: closing the Typd window took Typd and its key with it. Closing a window
// must never quit, and nothing a key press does may reach uiohook's native callback as an
// exception (it aborts the process). mac.yml's "Close the Typd window, stay running" step
// checks the same on a real Mac; these are the seams it relies on.
section('closing the window never quits');
const hk = read('src/main/hotkeys.js');
const tray = read('src/main/tray.js');
const mainFiles = fs.readdirSync(path.join(root, 'src/main')).filter((f) => f.endsWith('.js'));
const quitters = mainFiles.filter((f) => /app\.(quit|exit)\(/.test(read('src/main/' + f)));
check('only index.js and the tray call app.quit/app.exit', quitters.join(',') === 'index.js,tray.js', quitters.join(', '));
check('index.js asks to quit in one place, quit(by), which names who asked',
  (main.match(/app\.quit\(/g) || []).length === 1 && /function quit\(by\) \{\s*quitBy = by;\s*app\.quit\(\);/.test(main));
// app.exit skips before-quit: only the preview's screenshot and an app update (its forced
// exit, and a new version that failed its first start) may use it.
const exits = main.split('\n').filter((l) => /app\.exit\(/.test(l)).map((l) => l.trim());
check('app.exit only for the preview and app updates', exits.length === 3 &&
  exits.every((l) => l === 'app.exit(0);' || /setTimeout\(\(\) => app\.exit\(0\), 8000\)/.test(l) || /v === 'failed'.*app\.exit\(1\)/.test(l)), exits.join(' | '));
check("the tray's Quit says it was the tray", /label: 'Quit Typd', click: \(\) => \(deps\.quit \? deps\.quit\(\)/.test(tray) && /quit: \(\) => quit\('the tray menu/.test(main));
check('window-all-closed keeps Typd running', /app\.on\('window-all-closed', \(e\) => e\.preventDefault\(\)\)/.test(main));
const closedHandler = (hMain.match(/win\.on\('closed', \(\) => \{([\s\S]*?)\n {2}\}\);/) || [, ''])[1];
check("the window's 'closed' handler forgets the window first and guards each step",
  /^\s*win = null;/.test(closedHandler) && /try \{ fn\(\); \} catch/.test(closedHandler) && !/quit|exit/.test(closedHandler.replace(/Typd keeps running/, '')));
check('one activate handler', (main.match(/app\.on\('activate'/g) || []).length === 1);
check('every uiohook listener is guarded', /onDown = guard\(/.test(hk) && /onUp = guard\(/.test(hk) && /onMouse = guard\(/.test(hk) &&
  (hk.match(/uIOhook\.on\('/g) || []).length === 4);
check('the CI test hook runs only with TYPD_TEST_CLOSE_HOME',
  (main.match(/testCloseHome\(/g) || []).length === 2 && /if \(process\.env\.TYPD_TEST_CLOSE_HOME\) testCloseHome\(/.test(main));
check('"Show Typd in the Dock": macOS, off by default, wired to the window',
  /showInDock: false/.test(read('src/main/settings.js')) && /key === 'showInDock'/.test(hMain) &&
  hHtml.includes('id="showInDock"') && /'showInDock'\]\.forEach/.test(hJs));

/* ------------------------------------------------------------------ timing */

section('timing constants that must agree');
const exitJs = (js.match(/var EXIT_MS = (\d+)/) || [])[1];
const exitCss = (read('src/renderer/overlay.css').match(/--dur-exit:\s*(\d+)ms/) || [])[1];
check('EXIT_MS === --dur-exit', exitJs && exitJs === exitCss, exitJs + ' vs ' + exitCss);

console.log('\n' + (failures ? failures + ' FAILED' : 'all wiring checks passed') + '\n');
process.exit(failures ? 1 : 0);
