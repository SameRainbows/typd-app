'use strict';

/**
 * A dictation with no text field to land in (0.2.10): detected, not pasted, offered in the copy pop-up.
 *
 *   node bench/copy-popup.js            all of it (the page part needs Chrome or Edge, headless)
 *   node bench/copy-popup.js --shots    also writes docs/copy-popup-*.png (the page, rendered headless)
 *
 * 1. pasteTarget.classify on recorded and written field trees (test/fixtures/field-facts.json):
 *    Windows (UI Automation) and macOS (Accessibility), editable / not-editable / unknown, plus the
 *    rules that keep it safe: web engines, terminals and chat apps are never "not-editable", and
 *    junk never throws.
 * 2. pasteTarget.decide / land: a "not-editable" answer is looked at again before the paste is
 *    skipped; "unknown" and "editable" paste; a revision always pastes; a superseded session pastes
 *    nothing. The bench case: a not-editable target sends no paste keystroke, leaves the clipboard
 *    alone and shows the pop-up; Copy then puts the text on the clipboard.
 * 3. the pop-up's logic (copy-popup.js createController) with fake timers: about 6 s then a fade,
 *    hover pauses and leaving resumes, × dismisses, Copy says "Copied" and leaves, a new dictation
 *    replaces the card; and main's click gate feeding the hover from the cursor.
 * 4. index.js and the life log: the line names the control type, never the text or the app.
 * 5. the page (real popup.html/css/js, a stub preload) in a headless browser: the preview is one or
 *    two lines, ellipsised; the time bar runs, freezes while paused, steps under reduced motion; Copy
 *    and × send once each (also when Windows eats the press); Esc does nothing; screen readers find a
 *    named region, named buttons and a status line.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const pt = require(path.join(root, 'src', 'main', 'pasteTarget.js'));
const popupMod = require(path.join(root, 'src', 'main', 'copy-popup.js'));
const gateMod = require(path.join(root, 'src', 'main', 'overlay-window.js'));
const life = require(path.join(root, 'src', 'main', 'lifelog.js'));
const fixtures = JSON.parse(read('test/fixtures/field-facts.json'));

let failures = 0;
let passes = 0;
let sink = null;   // the page checks, held until their attempt is known to have run through
function check(name, ok, detail) {
  if (sink) { sink.push([name, ok, detail]); return; }
  if (ok) passes++; else failures++;
  if (!ok || process.env.TYPD_BENCH_VERBOSE) console.log((ok ? '  ok    ' : '  FAIL  ') + name + (ok || detail === undefined ? '' : '  (' + JSON.stringify(detail).slice(0, 400) + ')'));
}
const section = (name) => console.log('\n' + name);

/* ------------------------------------------------------------ 1. the classifier */

section('1. is there a text field? (pasteTarget.classify on recorded and written trees)');
const counts = {};
function runSet(name, list, platform) {
  let n = 0;
  for (const c of list) {
    const r = pt.classify(c.field, platform);
    check(name + ': ' + c.label + ' -> ' + c.expect, r.kind === c.expect, r);
    counts[name + ' ' + c.expect] = (counts[name + ' ' + c.expect] || 0) + 1;
    n++;
  }
  console.log('    ' + name + ': ' + n + ' trees');
}
runSet('windows recorded', fixtures.windows.recorded, 'win32');
runSet('windows shapes', fixtures.windows.shapes, 'win32');
runSet('mac', fixtures.mac, 'darwin');
console.log('    ' + Object.entries(counts).map(([k, v]) => k + ' ' + v).join(', '));

// Safety rules, beyond the fixtures.
const winBase = { none: false, ct: 'Button', cls: 'x', fw: 'WPF', val: 'none', txt: false, tro: null, win: 'Window', fg: true, proc: 'someapp', eproc: 'someapp', root: false };
const NONTEXT = ['Button', 'CheckBox', 'List', 'ListItem', 'Tree', 'TreeItem', 'MenuItem', 'Hyperlink', 'Image', 'TabItem'];
check('a web engine (Chrome or Gecko framework) is never "not-editable", whatever the control',
  NONTEXT.every((ct) => ['Chrome', 'Gecko'].every((fw) => pt.classify({ ...winBase, ct, fw }, 'win32').kind !== 'not-editable')));
check('a Chromium/Gecko window is never "not-editable", even for a native-looking element',
  NONTEXT.every((ct) => ['Chrome_WidgetWin_1', 'MozillaWindowClass'].every((win) => pt.classify({ ...winBase, ct, win }, 'win32').kind !== 'not-editable')));
check('terminals are never "not-editable" (by window class or process)',
  NONTEXT.every((ct) => pt.classify({ ...winBase, ct, win: 'ConsoleWindowClass' }, 'win32').kind !== 'not-editable' &&
    pt.classify({ ...winBase, ct, win: 'CASCADIA_HOSTING_WINDOW_CLASS', proc: 'WindowsTerminal' }, 'win32').kind !== 'not-editable' &&
    ['cmd', 'powershell', 'pwsh', 'wezterm-gui', 'alacritty', 'mintty', 'putty'].every((proc) => pt.classify({ ...winBase, ct, proc, eproc: proc }, 'win32').kind !== 'not-editable')));
check('chat apps and browsers by process are never "not-editable"',
  ['discord', 'slack', 'Teams', 'ms-teams', 'WhatsApp', 'Telegram', 'Signal', 'chrome', 'msedge', 'firefox', 'brave', 'Code', 'Cursor'].every((proc) =>
    pt.classify({ ...winBase, proc, eproc: proc }, 'win32').kind !== 'not-editable'));
check('a writable value or an editable text pattern is "editable" anywhere, even on the desktop or in Explorer',
  ['Progman', 'WorkerW', 'CabinetWClass', 'Shell_TrayWnd'].every((win) => pt.classify({ ...winBase, ct: 'Edit', fw: 'XAML', val: 'rw', win, proc: 'explorer' }, 'win32').kind === 'editable' &&
    pt.classify({ ...winBase, ct: 'Custom', txt: true, tro: false, win, proc: 'explorer' }, 'win32').kind === 'editable'));
check('custom-drawn windows (Pane, Window, Group, Custom) in an ordinary app are "unknown": games keep pasting',
  ['Pane', 'Window', 'Group', 'Custom', 'DataItem', 'ComboBox', 'Spinner', 'Text'].every((ct) => pt.classify({ ...winBase, ct, fw: 'Win32', win: 'GameWindow', proc: 'game' }, 'win32').kind === 'unknown'));
check('a framework it does not know (Qt, Java, DirectX) is "unknown" even for a button',
  ['Qt', 'Java', '', 'NetUI', 'DirectX'].every((fw) => pt.classify({ ...winBase, fw }, 'win32').kind === 'unknown'));
const macBase = { focused: true, role: 'AXButton', subrole: '', settable: false, bundle: 'com.example.native', web: false };
check('mac: a web engine app (found by its frameworks) is never "not-editable"',
  ['AXButton', 'AXList', 'AXOutline', 'AXTable', 'AXRow'].every((role) => pt.classify({ ...macBase, role, web: true }, 'darwin').kind !== 'not-editable'));
check('mac: no focused element is "not-editable" only in Finder (the desktop)',
  pt.classify({ ...macBase, focused: false, role: '', bundle: 'com.apple.finder' }, 'darwin').kind === 'not-editable' &&
  ['com.example.native', 'com.apple.Preview', 'com.valvesoftware.steam', ''].every((bundle) => pt.classify({ ...macBase, focused: false, role: '', bundle }, 'darwin').kind === 'unknown'));
check('mac: browsers and terminals by bundle id are never "not-editable"',
  ['com.apple.Safari', 'org.mozilla.firefox', 'company.thebrowser.Browser', 'com.apple.Terminal', 'com.googlecode.iterm2', 'dev.warp.Warp-Stable', 'com.apple.MobileSMS'].every((bundle) =>
    pt.classify({ ...macBase, bundle }, 'darwin').kind !== 'not-editable'));
check('mac: a text role or a settable value is "editable" anywhere',
  ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField'].every((role) => pt.classify({ ...macBase, role, bundle: 'com.apple.finder' }, 'darwin').kind === 'editable') &&
  pt.classify({ ...macBase, role: 'AXGroup', settable: true }, 'darwin').kind === 'editable' &&
  pt.classify({ ...macBase, role: 'AXTextField', subrole: 'AXSecureTextField' }, 'darwin').kind === 'editable');

// Junk never throws, and never comes back "not-editable" by accident.
let threw = 0, junkNot = 0;
const junk = [undefined, null, 0, '', 'x', [], {}, { ct: 7 }, { win: null }, { field: {} }, { error: 'x' }, { none: 'yes' }, { focused: 'no' },
  { ct: 'Button' }, { role: 'AXButton' }, { fw: 'WPF' }, { val: 'rw', ct: {} }, { toString: null }];
for (const j of junk) for (const p of ['win32', 'darwin']) {
  try { const r = pt.classify(j, p); if (r.kind === 'not-editable') junkNot++; } catch { threw++; }
}
check('junk facts never throw (' + junk.length * 2 + ' tried)', threw === 0, threw);
check('junk facts are never "not-editable" unless they say so (a lone Button with no framework is not enough)', junkNot === 0, junkNot);

/* ---------------------------------------------- 2. decide, land: the bench case */

section('2. paste unless confident (pasteTarget.decide / land)');
const byLabel = (list, label) => list.find((c) => c.label === label).field;
const DESKTOP = byLabel(fixtures.windows.recorded, 'the desktop (Progman itself)');
const TERMINAL = byLabel(fixtures.windows.recorded, 'Windows Terminal, the focused text area (TermControl)');
const ELECTRON_DOC = byLabel(fixtures.windows.recorded, 'Claude desktop (Electron): the page (read-only document)');
const WPF_TEXT = byLabel(fixtures.windows.recorded, 'WPF: TextBox');
const FINDER = byLabel(fixtures.mac, 'Finder: list view');

function fakeInject({ fresh, pasteResult = { ok: true } } = {}) {
  const calls = { paste: [], field: 0, copy: [] };
  return {
    calls,
    paste: async (t) => { calls.paste.push(t); return pasteResult; },
    fieldState: async () => { calls.field++; if (fresh instanceof Error) throw fresh; return fresh; },
    copy: async (t) => { calls.copy.push(t); }
  };
}

(async () => {
  let d = await pt.decide({ field: DESKTOP, recheck: async () => DESKTOP, platform: 'win32' });
  check('desktop at the key press, still the desktop: no paste', d.paste === false && d.verdict.kind === 'not-editable', d);
  d = await pt.decide({ field: DESKTOP, recheck: async () => WPF_TEXT, platform: 'win32' });
  check('desktop at the key press, a text box focused by the end: paste', d.paste === true && d.verdict.kind === 'editable', d);
  d = await pt.decide({ field: DESKTOP, recheck: async () => null, platform: 'win32' });
  check('desktop at the key press, the second look gets no answer: paste', d.paste === true && d.verdict.why === 'recheck-failed', d);
  d = await pt.decide({ field: DESKTOP, recheck: async () => { throw new Error('timed out'); }, platform: 'win32' });
  check('desktop at the key press, the second look throws: paste', d.paste === true, d);
  d = await pt.decide({ field: DESKTOP, recheck: async () => ELECTRON_DOC, platform: 'win32' });
  check('desktop at the key press, an Electron page by the end ("unknown"): paste', d.paste === true && d.verdict.kind === 'unknown', d);
  let rechecks = 0;
  d = await pt.decide({ field: ELECTRON_DOC, recheck: async () => { rechecks++; return DESKTOP; }, platform: 'win32' });
  check('"unknown" pastes, and costs no second look', d.paste === true && rechecks === 0, { d, rechecks });
  d = await pt.decide({ field: TERMINAL, recheck: async () => { rechecks++; return DESKTOP; }, platform: 'win32' });
  check('"editable" pastes, and costs no second look', d.paste === true && rechecks === 0, { d, rechecks });
  d = await pt.decide({ field: undefined, recheck: async () => { rechecks++; return DESKTOP; }, platform: 'win32' });
  check('no facts at all (the context read failed or timed out): paste, no second look', d.paste === true && rechecks === 0, d);
  d = await pt.decide({ field: FINDER, recheck: async () => FINDER, platform: 'darwin' });
  check('mac: Finder, still Finder: no paste', d.paste === false && d.verdict.why === 'finder', d);

  // land(): the whole step, with a fake injector that counts paste keystrokes.
  const TEXT = 'Remind me to send the invoice to Kerem on Friday, and book the room for the review.';
  let inj = fakeInject({ fresh: DESKTOP });
  let l = await pt.land({ text: TEXT, mode: 'dictate', field: DESKTOP, inject: inj, platform: 'win32' });
  check('BENCH CASE not-editable: no paste keystroke, result offered, the clipboard untouched',
    inj.calls.paste.length === 0 && l.result.ok === false && l.result.offered === true && !l.result.copied && inj.calls.copy.length === 0 && inj.calls.field === 1, { calls: inj.calls, l });

  // ...and the pop-up shows it (index.js: offerCopy(text, result.offered ? 'offer' : 'copied')), with Copy working.
  {
    const clk = clock();
    const v = fakeView();
    const c = popupMod.createController({ view: v, copy: inj.copy, now: clk.now, timers: clk.timers });
    c.offer(TEXT, l.result.offered ? 'offer' : 'copied');
    check('BENCH CASE not-editable: the pop-up is shown, as an offer, with the text, and nothing copied yet',
      v.shows.length === 1 && v.shows[0].kind === 'offer' && v.shows[0].preview === TEXT && c.state === 'shown' && inj.calls.copy.length === 0, v.shows);
    await c.copy();
    check('BENCH CASE not-editable: Copy puts the whole text on the clipboard (inject.copy), once', inj.calls.copy.length === 1 && inj.calls.copy[0] === TEXT, inj.calls.copy);
  }

  for (const [label, field] of [['unknown (an Electron page)', ELECTRON_DOC], ['editable (Windows Terminal)', TERMINAL], ['no facts', null]]) {
    inj = fakeInject({ fresh: DESKTOP });
    l = await pt.land({ text: TEXT, mode: 'dictate', field, inject: inj, platform: 'win32' });
    check('BENCH CASE ' + label + ': still pastes, one keystroke, no pop-up result', inj.calls.paste.length === 1 && l.result.ok === true && !l.result.offered && inj.calls.field === 0, inj.calls);
  }
  inj = fakeInject({ fresh: TERMINAL });
  l = await pt.land({ text: TEXT, mode: 'dictate', field: DESKTOP, inject: inj, platform: 'win32' });
  check('desktop at the key press but a text field by the end: pastes', inj.calls.paste.length === 1 && l.result.ok === true, inj.calls);
  inj = fakeInject({ fresh: DESKTOP });
  l = await pt.land({ text: TEXT, mode: 'revise', field: DESKTOP, inject: inj, platform: 'win32' });
  check('a revision always pastes (it replaces a selection) and never asks', inj.calls.paste.length === 1 && inj.calls.field === 0, inj.calls);
  inj = fakeInject({ fresh: DESKTOP });
  l = await pt.land({ text: TEXT, mode: 'dictate', field: TERMINAL, inject: inj, current: () => false, platform: 'win32' });
  check('a session superseded before the paste: nothing pasted, null back', l === null && inj.calls.paste.length === 0, inj.calls);
  inj = fakeInject({ pasteResult: { ok: false, copied: true, reason: 'restart Typd' } });
  l = await pt.land({ text: TEXT, mode: 'dictate', field: TERMINAL, inject: inj, platform: 'win32' });
  check('a failed paste comes back as copied (the pop-up then shows it as already copied)', l.result.copied === true && !l.result.offered, l);

  await popupChecks();
  sourceChecks();
  await pageSection();

  console.log('\n' + passes + ' passed' + (failures ? ', ' + failures + ' FAILED' : '') + '\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.log('  FAIL  the bench ran to the end  (' + (err && err.stack || err) + ')'); process.exit(1); });

/* ------------------------------------------------------------- 3. the pop-up */

function clock() {
  let t = 0, seq = 0;
  const q = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => { const id = ++seq; q.set(id, { at: t + Math.max(0, ms || 0), fn }); return id; },
      clearTimeout: (id) => { q.delete(id); }
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, e] of q) if (e.at <= end && (!next || e.at < next[1].at)) next = [id, e];
        if (!next) break;
        q.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    get pending() { return q.size; }
  };
}

function fakeView() {
  const v = { shows: [], timers: [], copiedN: 0, leaves: 0, hides: 0 };
  v.show = (p) => v.shows.push(p);
  v.timer = (t) => v.timers.push(t);
  v.copied = () => { v.copiedN++; };
  v.leave = () => { v.leaves++; };
  v.hide = () => { v.hides++; };
  return v;
}

async function popupChecks() {
  section('3. the pop-up: timer, pause, copy, dismiss (copy-popup.js createController, fake timers)');
  const D = popupMod.DURATION, F = popupMod.FADE_MS, C = popupMod.COPIED_MS;
  check('it stays about 6 s (DURATION ' + D + ' ms), fades in ' + F + ' ms, and says "Copied" for ' + C + ' ms', D >= 5000 && D <= 7000 && F > 0 && F <= 300 && C >= 1000 && C <= 2500);

  const make = (over = {}) => {
    const clk = clock();
    const v = fakeView();
    const copies = [];
    const closes = [];
    const c = popupMod.createController({
      view: v, copy: over.copy || (async (t) => { copies.push(t); }), now: clk.now, timers: clk.timers,
      onClose: (r) => closes.push(r), onCopy: () => {}
    });
    return { clk, v, c, copies, closes };
  };

  // Expiry.
  let { clk, v, c, closes } = make();
  c.offer('hello there', 'offer');
  check('offer: shown at once, the bar told the full time, running', v.shows.length === 1 && c.state === 'shown' && v.timers[0].remaining === D && v.timers[0].total === D && v.timers[0].paused === false);
  clk.advance(D - 1);
  check('still there 1 ms before the end', c.state === 'shown' && v.leaves === 0);
  clk.advance(1);
  check('at ' + D + ' ms it starts to fade (leave), not yet hidden', c.state === 'leaving' && v.leaves === 1 && v.hides === 0);
  clk.advance(F);
  check('after the fade the window hides; the close was "expired"', c.state === 'hidden' && v.hides === 1 && closes[0] === 'expired', { state: c.state, closes });
  check('nothing left running after it hid', clk.pending === 0, clk.pending);

  // Hover pauses, leaving resumes.
  ({ clk, v, c, closes } = make());
  c.offer('hello', 'offer');
  clk.advance(2000);
  c.hover(true);
  const at = v.timers[v.timers.length - 1];
  check('hover at 2 s: paused, with 4 s left, and the bar told so', c.paused && at.paused === true && at.remaining === D - 2000, at);
  clk.advance(60000);
  check('paused for a minute: still there', c.state === 'shown' && v.leaves === 0);
  c.hover(false);
  const back = v.timers[v.timers.length - 1];
  check('leaving resumes with the time that was left', !c.paused && back.paused === false && back.remaining === D - 2000, back);
  clk.advance(D - 2001);
  check('...and runs it out: still there 1 ms before', c.state === 'shown');
  clk.advance(1);
  check('...then it fades', c.state === 'leaving');
  c.hover(true);
  check('hover while it fades changes nothing', c.state === 'leaving' && !c.paused);

  // Repeated hover events do not stack.
  ({ clk, v, c } = make());
  c.offer('x', 'offer');
  clk.advance(1000); c.hover(true); clk.advance(500); c.hover(true); clk.advance(500); c.hover(false); c.hover(false);
  check('hover on twice and off twice: one pause, the time left still 5 s', c.remaining() === D - 1000, c.remaining());

  // Dismiss (the ×).
  ({ clk, v, c, closes } = make());
  c.offer('x', 'offer');
  clk.advance(1000);
  c.dismiss();
  check('× : leaves at once, hides after the fade, close "dismissed"', c.state === 'leaving' && v.leaves === 1 && closes[0] === 'dismissed');
  clk.advance(F);
  check('× : hidden, nothing running', c.state === 'hidden' && v.hides === 1 && clk.pending === 0);
  c.dismiss();
  check('a second × does nothing', v.leaves === 1);

  // Copy.
  const LONG = 'word '.repeat(300).trim();
  let copies;
  ({ clk, v, c, copies, closes } = make());
  c.offer(LONG, 'offer');
  check('the page gets a preview (at most ' + popupMod.PREVIEW_CHARS + ' characters), never more', v.shows[0].preview.length === popupMod.PREVIEW_CHARS);
  check('nothing is copied before Copy is clicked', copies.length === 0);
  clk.advance(3000);
  await c.copy();
  check('Copy: the whole text, not the preview, goes to the clipboard once', copies.length === 1 && copies[0] === LONG);
  check('Copy: the button says Copied, and the bar is told so', v.copiedN === 1 && v.timers[v.timers.length - 1].copied === true);
  clk.advance(C - 1);
  check('Copy: still there for ' + C + ' ms (not the 3 s that were left)', c.state === 'shown');
  clk.advance(1);
  check('Copy: then it leaves; the close says "copied"', c.state === 'leaving' && closes[0] === 'copied', closes);

  ({ clk, v, c, copies, closes } = make({ copy: async () => { throw new Error('clipboard busy'); } }));
  c.offer('x', 'offer');
  const ok = await c.copy();
  check('a Copy that fails: the card stays, not marked Copied, the timer still runs', ok === false && !v.copiedN && c.state === 'shown');
  clk.advance(D);
  check('...and it times out as usual', c.state === 'leaving');

  // Already copied (a failed paste).
  ({ clk, v, c, copies } = make());
  c.offer('pasted text', 'copied');
  check('a failed paste shows as kind "copied"', v.shows[0].kind === 'copied' && copies.length === 0);
  await c.copy();
  check('...and Copy there copies again', copies.length === 1);

  // A new dictation replaces the card.
  ({ clk, v, c, closes } = make());
  c.offer('first', 'offer');
  clk.advance(4000);
  c.offer('second', 'offer');
  check('a new one replaces the card: shown again, full time, "replaced" logged for the first',
    v.shows.length === 2 && v.shows[1].preview === 'second' && v.timers[v.timers.length - 1].remaining === D && closes[0] === 'replaced' && c.text === 'second', closes);
  clk.advance(D - 1);
  check('the first one\'s timer is gone (no early close)', c.state === 'shown');
  clk.advance(1);
  clk.advance(F);
  check('the second runs its full time, then hides', c.state === 'hidden');

  // A new one while the old one fades.
  ({ clk, v, c } = make());
  c.offer('first', 'offer');
  c.dismiss();
  clk.advance(F - 10);
  c.offer('second', 'offer');
  clk.advance(20);
  check('a new one during the fade: the old fade does not hide it', c.state === 'shown' && v.hides === 0);

  // Screen readers: longer, still timed.
  ({ clk, v, c } = make());
  c.offer('x', 'offer', { duration: popupMod.SCREEN_READER_DURATION });
  clk.advance(D + 100);
  check('with a screen reader on it stays longer (' + popupMod.SCREEN_READER_DURATION + ' ms)...', c.state === 'shown');
  clk.advance(popupMod.SCREEN_READER_DURATION);
  check('...and is still timed', c.state !== 'shown' && v.leaves === 1);

  // Hover and Copy while hidden do nothing.
  ({ clk, v, c, copies } = make());
  c.hover(true); await c.copy(); c.dismiss();
  check('hover, Copy and × with nothing shown do nothing', v.shows.length === 0 && copies.length === 0 && v.leaves === 0);
  check('an empty dictation is never offered', c.offer('', 'offer') === false && v.shows.length === 0);

  // Main's click gate feeds the hover (copy-popup.js: setIgnore -> controller.hover(!ignore)).
  ({ clk, v, c } = make());
  const g = { fn: null };
  const w = { cursor: { x: 0, y: 0 }, bounds: { x: 700, y: 800, width: popupMod.WIDTH, height: popupMod.HEIGHT }, visible: true };
  const ignores = [];
  const gate = gateMod.createClickGate({
    setIgnore: (ignore) => { ignores.push(ignore); c.hover(!ignore); },
    cursor: () => w.cursor, bounds: () => w.bounds, visible: () => w.visible,
    timers: { setInterval: (fn) => { g.fn = fn; return { unref() {} }; }, clearInterval: () => { g.fn = null; } }
  });
  c.offer('x', 'offer');
  gate.areas([{ x: 34, y: 70, w: 372, h: 62 }]);
  w.cursor = { x: 700 + 100, y: 800 + 90 }; g.fn();
  check('gate: the pointer over the card -> the window takes clicks and the timer pauses', ignores[ignores.length - 1] === false && c.paused);
  clk.advance(20000);
  w.cursor = { x: 700 + 100, y: 800 + 10 }; g.fn();
  check('gate: the pointer above the card (still in the window) -> click-through again, the timer runs', ignores[ignores.length - 1] === true && !c.paused && c.state === 'shown');
  w.cursor = { x: 10, y: 10 }; g.fn();
  check('gate: the pointer far away -> stays click-through, still running', !c.paused);
  gate.release();
  check('gate released (the card left) -> click-through, not paused', ignores[ignores.length - 1] === true && !c.paused);

  // Where it goes.
  const areas = [
    { x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: -200, width: 2560, height: 1400 },
    { x: 0, y: 25, width: 1440, height: 875 }, { x: -1280, y: 0, width: 1280, height: 720 }, { x: 0, y: 0, width: 800, height: 220 }
  ];
  const placed = areas.map((a) => [a, popupMod.placement(a)]);
  check('placement: centred at the bottom of the work area, above the pill (its 52 px slot clear), inside the display',
    placed.every(([a, p]) => Math.abs(p.x + p.width / 2 - (a.x + a.width / 2)) <= 1 && p.y >= a.y && p.y + p.height <= a.y + a.height - 6 - 40 &&
      p.x >= a.x && p.x + p.width <= a.x + a.width), placed);
}

/* ----------------------------------------------- 4. index.js and the life log */

function sourceChecks() {
  section('4. index.js, the injectors and the life log');
  const main = read('src/main/index.js');
  check('index.js lands every finished dictation through pasteTarget.land, with the key-press field facts',
    /const landed = await pasteTarget\.land\(\{\s*text: event\.text, mode: current\.mode, field: current\.target && current\.target\.field,\s*inject, current: \(\) => session === current\s*\}\);/.test(main) &&
    (main.match(/inject\.paste\(/g) || []).length === 0);
  check('index.js offers what was not pasted: kind "offer" when there was no field, "copied" when the paste failed, and the pill leaves',
    /if \(offerCopy\(event\.text, result\.offered \? 'offer' : 'copied'\)\) \{\s*send\('session:offered', \{ failed: !result\.offered \}\);/.test(main));
  check('index.js: history keeps a not-pasted dictation as "copied" (Home can copy it later)',
    /if \(!result\.ok\) \{\s*\/\/[^\n]*\n\s*keepHistory\(current, event\.text, 'copied'\);/.test(main));
  check('index.js: with no pop-up, never lose it: an offered text is copied and the pill says so, as before',
    /if \(result\.offered\) await inject\.copy\(event\.text\);[\s\S]{0,120}send\('session:error', \{ message: 'Copied — press ' \+ \(MAC \? '⌘V' : 'Ctrl\+V'\) \+ ' to paste' \}\);/.test(main));
  check('index.js: the "Copied — press Ctrl+V" pill message is now only that fallback', (main.match(/'Copied — press '/g) || []).length === 1);
  check('inject.js and inject-mac.js both read the field facts with the context, and offer fieldState for the second look',
    ['src/main/inject.js', 'src/main/inject-mac.js'].every((f) => { const s = read(f); return /field: r\.field \|\| null/.test(s) && /async function fieldState\(\)/.test(s) && /fieldState, selection/.test(s); }));
  const ps = read('src/main/inject.ps1');
  check('inject.ps1: one FocusedElement read gives the context text and the field facts; "field" answers alone',
    /\$text = Get-FocusText \$el/.test(ps) && /field = \(Get-FieldFacts \$el \$name\)/.test(ps) && /'field'\s+\{ Get-Field \}/.test(ps));
  check('inject.ps1 stays ASCII (Windows PowerShell 5 reads it as ANSI)', !/[^\x00-\x7f]/.test(ps));
  check('inject.ps1: the field facts read no Name, Value or text', !/Current\.Name|\.Value\b|GetText/.test((ps.match(/function Get-FieldFacts[\s\S]*?\n\}\r?\n/) || [''])[0]));
  const helper = read('src/main/mac/inject-helper.js');
  check('mac helper: context carries fieldFacts; "field" is a command; facts never read AXValue\'s contents',
    /out\.field = fieldFacts\(el \|\| null\)/.test(helper) && /field: field,/.test(helper) &&
    !/attr\(el, 'AXValue'\)/.test((helper.match(/function fieldFacts[\s\S]*?\n\}\n/) || [''])[0]));

  const v = pt.classify({ ...byLabel(fixtures.windows.recorded, 'the desktop (Progman itself)'), proc: 'secretapp', cls: 'SecretClass' }, 'win32');
  const line = pt.logLine(v);
  check('life log: "' + line + '"', line === 'not pasted: no text field (UIA Pane, the desktop), offered copy', line);
  const macLine = pt.logLine(pt.classify({ focused: true, role: 'AXOutline', bundle: 'com.secret.app', web: false, settable: false }, 'darwin'));
  check('life log (mac): "' + macLine + '"', macLine === 'not pasted: no text field (AX AXOutline, not a text control), offered copy', macLine);
  const sneaky = pt.logLine(pt.classify({ ...winBase, ct: 'Button hello "my secret text"\nnext', proc: 'secret' }, 'win32'));
  const sneakyMac = pt.logLine(pt.classify({ ...macBase, role: 'AXmysecretnote', bundle: 'com.secret' }, 'darwin'));
  check('life log: a control type or role it does not know is "other": never words an app made up, no app, no class',
    sneaky === 'not pasted: no text field (UIA other), offered copy' && sneakyMac === 'not pasted: no text field (AX other), offered copy', [sneaky, sneakyMac]);
  check('the dictation line accepts "offered" and still refuses words', /offered,/.test(life.dictationLine({ mode: 'dictate', outcome: 'offered' })) &&
    /other,/.test(life.dictationLine({ mode: 'dictate', outcome: 'secret words' })));
  check('logDictation marks an offered dictation "offered"', /outcome: result && result\.ok \? 'pasted' : result && result\.offered \? 'offered' : 'copied'/.test(main));
}

/* ---------------------------------------------------------------- 5. the page */

async function pageSection() {
  section('5. the page in a headless browser (real popup.html/css/js, stub preload, real input events)');
  const headless = require('./headless');
  if (!headless.findBrowser()) { console.log('  skip  no Edge or Chrome found (set TYPD_BROWSER) -- the page checks did not run'); return; }
  for (let attempt = 1; attempt <= 4; attempt++) {
    sink = [];
    let error = null;
    try { await pageChecks(headless); await reducedChecks(headless); } catch (err) { error = err; }
    const lines = sink;
    sink = null;
    if (error && headless.INFRA.test(String(error.message)) && attempt < 4) {
      console.log('    (attempt ' + attempt + ': the browser stopped answering -- ' + error.message + '; again, in a fresh one)');
      continue;
    }
    for (const [name, ok, detail] of lines) check(name, ok, detail);
    if (error) check('the page checks ran to the end', false, String(error.stack || error));
    return;
  }
}

function stubScript() {
  const pre = read('src/preload/popup.js');
  const names = [...pre.matchAll(/^ {2}([a-zA-Z]+)\(/gm)].map((m) => m[1]).filter((n) => n !== 'on');
  return `(() => {
    const handlers = {};
    window.__calls = [];
    window.__emit = (ch, p) => (handlers[ch] || []).slice().forEach((f) => f(p || {}));
    const api = { on(ch, f) { (handlers[ch] = handlers[ch] || []).push(f); return () => {}; } };
    for (const n of ${JSON.stringify(names)}) api[n] = (...a) => { window.__calls.push({ n, a: JSON.parse(JSON.stringify(a)), t: performance.now() }); };
    window.typdPopup = api;
  })();`;
}

async function pageChecks(headless) {
  const shots = process.argv.includes('--shots');
  const h = await headless.open(path.join(root, 'src', 'renderer'), { width: popupMod.WIDTH, height: popupMod.HEIGHT, dpr: 1, stub: stubScript() });
  const { S, ev, load } = h;
  // Waits keep talking to the page: headless Chrome on a Windows PC was seen to stop answering
  // after a second or so with nothing asked of it (a blank page too), so a long quiet sleep is
  // a ping every 100 ms instead.
  const sleep = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { await ev('0'); await h.sleep(Math.min(100, Math.max(0, end - Date.now()))); } };
  try {
    console.log('    browser: ' + path.basename(h.exe) + ', headless');
    const ready = 'document.readyState === "complete" && Array.isArray(window.__calls)';
    await load('popup.html', ready);
    const { calls, emit, attr, box, mouse, centre, scale } = pageHelpers(h);
    const LONG = 'So the plan for tomorrow is to meet at nine, go over the quarterly numbers with the whole team, then ' +
      'split into two groups: one on the launch checklist and one on the support backlog, and we regroup after lunch.';
    const SHORT = 'Call the dentist on Monday.';

    check('the page loads with the stub preload, hidden', (await attr('data-visible')) === 'false');

    await emit('popup:show', { kind: 'offer', preview: LONG, total: 6000, key: 1, pasteKey: 'Ctrl+V' });
    await emit('popup:timer', { remaining: 6000, total: 6000, paused: false });
    await sleep(400);
    check('show: visible, labelled "No text field — not pasted"', (await attr('data-visible')) === 'true' &&
      (await ev('document.getElementById("label").textContent')) === 'No text field — not pasted');
    const lines = await ev('(() => { const p = document.getElementById("preview"); const lh = parseFloat(getComputedStyle(p).lineHeight); return { lines: Math.round(p.getBoundingClientRect().height / lh), clipped: p.scrollHeight > p.clientHeight + 1 }; })()');
    check('a long dictation shows as two lines, ellipsised (clamped)', lines.lines === 2 && lines.clipped, lines);
    const card = await box('card');
    check('the card sits inside the window with room for its shadow (>= 20 px at the sides and bottom)',
      card.x >= 20 && card.x + card.w <= popupMod.WIDTH - 20 && card.y + card.h <= popupMod.HEIGHT - 20 && card.y >= 0, card);
    const hits = await calls('hitAreas');
    const last = hits.length ? hits[hits.length - 1].a[0] : [];
    check('it reports the card as its one click (and hover) area, within the gate\'s 400 px limit',
      last.length === 1 && Math.abs(last[0].x - card.x) <= 3 && Math.abs(last[0].w - card.w) <= 6 && last[0].w <= 400 && last[0].h <= 400, last);
    const s1 = await scale();
    await sleep(1000);
    const s2 = await scale();
    check('the time bar runs down (linear over what is left): ~1.0 -> ~0.83 after 1 s', s1 > 0.9 && s2 > 0.72 && s2 < 0.9, { s1, s2 });

    if (shots) await shot(S, ev, 'offer');

    await emit('popup:timer', { remaining: 4000, total: 6000, paused: true });
    await sleep(50);
    const p1 = await scale();
    await sleep(600);
    const p2 = await scale();
    check('paused: the bar freezes where the time left is (4 of 6 s)', Math.abs(p1 - 4 / 6) < 0.01 && Math.abs(p2 - p1) < 0.001 && (await attr('data-paused')) === 'true', { p1, p2 });
    if (shots) await shot(S, ev, 'paused');
    await emit('popup:timer', { remaining: 4000, total: 6000, paused: false });
    await sleep(500);
    check('resumed: it runs again from there', (await scale()) < p1 - 0.03 && (await attr('data-paused')) === 'false');

    // Copy: press and release, once; Windows may eat the press, so a release alone counts too.
    const cb = await box('copy');
    await mouse('mouseMoved', ...centre(cb)); await mouse('mousePressed', ...centre(cb)); await mouse('mouseReleased', ...centre(cb));
    await sleep(80);
    check('Copy clicked: one "copy" sent (mouseup and click do not double it)', (await calls('copy')).length === 1);
    await mouse('mousePressed', ...centre(cb)); await mouse('mouseReleased', ...centre(cb));
    await sleep(80);
    check('Copy again on the same card: nothing more sent', (await calls('copy')).length === 1);
    await emit('popup:copied', {});
    await sleep(250);
    check('copied: the button says "Copied", with its tick, and a screen reader hears it',
      (await ev('document.getElementById("copyText").textContent')) === 'Copied' && (await attr('data-copied')) === 'true' &&
      (await ev('document.getElementById("announce").textContent')) === 'Copied.');
    if (shots) await shot(S, ev, 'copied');

    // Esc does nothing (it is never taken from other apps; the window never even has the keyboard).
    await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(80);
    check('Esc sends nothing', (await calls('dismiss')).length === 0 && (await calls('copy')).length === 1);

    // A new card (a failed paste: already copied), and × with the release only.
    await emit('popup:show', { kind: 'copied', preview: SHORT, total: 6000, key: 2, pasteKey: '⌘V' });
    await emit('popup:timer', { remaining: 6000, total: 6000, paused: false });
    await sleep(300);
    check('a failed paste: "Copied — press ⌘V to paste" (the words it always had), Copy reset, one line of text',
      (await ev('document.getElementById("label").textContent')) === 'Copied — press ⌘V to paste' &&
      (await ev('document.getElementById("copyText").textContent')) === 'Copy' && (await attr('data-copied')) === 'false' &&
      (await ev('(() => { const p = document.getElementById("preview"); return Math.round(p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight)); })()')) === 1);
    if (shots) { await emit('popup:show', { kind: 'copied', preview: SHORT, total: 6000, key: 2, pasteKey: 'Ctrl+V' }); await sleep(300); await shot(S, ev, 'failed-paste'); }
    const xb = await box('close');
    await mouse('mouseMoved', ...centre(xb)); await mouse('mouseReleased', ...centre(xb));
    await sleep(80);
    check('× with only the release (Windows ate the press): one "dismiss"', (await calls('dismiss')).length === 1);
    const cb2 = await box('copy');
    await mouse('mouseReleased', ...centre(cb2));
    await sleep(80);
    check('Copy on the new card counts again (one per card)', (await calls('copy')).length === 2);

    // Screen readers.
    await S('Accessibility.enable');
    const tree = (await S('Accessibility.getFullAXTree')).nodes;
    await S('Accessibility.disable');
    const named = (role, re) => tree.some((n) => n.role && n.role.value === role && n.name && re.test(n.name.value || ''));
    check('screen readers: a region named "Typd: dictation not pasted"', named('region', /Typd: dictation not pasted/));
    check('screen readers: a button "Copy the dictation again" (described by the text) and a button "Dismiss"',
      named('button', /^Copy the dictation again$/) && named('button', /^Dismiss$/));
    check('screen readers: a status line says what happened and how to paste',
      /could not paste[\s\S]*clipboard[\s\S]*(⌘V|Ctrl\+V)/.test(await ev('document.getElementById("announce").textContent')) && tree.some((n) => n.role && n.role.value === 'status'));

    await emit('popup:leave', {});
    await sleep(300);
    const hitsAfter = await calls('hitAreas');
    check('leave: hidden, and its click area given back ([])', (await attr('data-visible')) === 'false' && JSON.stringify(hitsAfter[hitsAfter.length - 1].a[0]) === '[]');
    check('the fade-out takes --dur-leave (= FADE_MS)', (await ev('getComputedStyle(document.getElementById("popup")).transitionDuration')).split(',')[0].trim() === (popupMod.FADE_MS / 1000) + 's');

  } finally {
    await h.close();
  }
}

function pageHelpers(h) {
  const { S, ev } = h;
  const calls = (n) => ev('window.__calls.filter((c) => c.n === ' + JSON.stringify(n) + ')');
  const emit = (ch, p) => ev('window.__emit(' + JSON.stringify(ch) + ', ' + JSON.stringify(p || {}) + '); 0');
  const attr = (a) => ev('document.getElementById("popup").getAttribute(' + JSON.stringify(a) + ')');
  const box = (id) => ev('(() => { const r = document.getElementById(' + JSON.stringify(id) + ').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');
  const mouse = (type, x, y) => S('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  const centre = (b) => [b.x + b.w / 2, b.y + b.h / 2];
  const scale = () => ev('(() => { const m = new DOMMatrix(getComputedStyle(document.getElementById("bar")).transform); return m.a; })()');
  return { calls, emit, attr, box, mouse, centre, scale };
}

/* Reduced motion, in a fresh browser (the emulation is per page; one long session in headless Chrome
 * sometimes stopped answering right here). */
async function reducedChecks(headless) {
  const h = await headless.open(path.join(root, 'src', 'renderer'), { width: popupMod.WIDTH, height: popupMod.HEIGHT, dpr: 1, stub: stubScript() });
  const { S, ev, load } = h;
  // Waits keep talking to the page: headless Chrome on a Windows PC was seen to stop answering
  // after a second or so with nothing asked of it (a blank page too), so a long quiet sleep is
  // a ping every 100 ms instead.
  const sleep = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { await ev('0'); await h.sleep(Math.min(100, Math.max(0, end - Date.now()))); } };
  const { emit, scale } = pageHelpers(h);
  const ready = 'document.readyState === "complete" && Array.isArray(window.__calls)';
  const SHORT = 'Call the dentist on Monday.';
  try {
    // Reduced motion: no fade, the bar steps once a second, still timed.
    await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await load('popup.html', ready);
    await emit('popup:show', { kind: 'offer', preview: SHORT, total: 6000, key: 3, pasteKey: 'Ctrl+V' });
    await emit('popup:timer', { remaining: 6000, total: 6000, paused: false });
    await sleep(100);
    check('reduced motion: shown with no transition (no fade, no slide)',
      (await ev('getComputedStyle(document.getElementById("popup")).transitionDuration')).split(',').every((d) => parseFloat(d) === 0) &&
      (await ev('getComputedStyle(document.getElementById("popup")).opacity')) === '1');
    const r0 = await scale();
    const trans = await ev('document.getElementById("bar").style.transition');
    await sleep(1150);
    const r1 = await scale();
    await sleep(1000);
    const r2 = await scale();
    check('reduced motion: the bar does not glide, it steps once a second (1 -> 5/6 -> 4/6)',
      trans === 'none' && Math.abs(r0 - 1) < 0.01 && Math.abs(r1 - 5 / 6) < 0.03 && Math.abs(r2 - 4 / 6) < 0.03, { trans, r0, r1, r2 });
    await emit('popup:leave', {});
    await sleep(20);
    check('reduced motion: gone at once on leave (no fade)', (await ev('getComputedStyle(document.getElementById("popup")).opacity')) === '0');
  } finally {
    await h.close();
  }
}

/** A screenshot of the card at 2x over a plain desktop-like backdrop, into docs/. */
async function shot(S, ev, name) {
  await S('Emulation.setDeviceMetricsOverride', { width: popupMod.WIDTH, height: popupMod.HEIGHT, deviceScaleFactor: 2, mobile: false });
  // The real window can never be focused, so no focus ring either (the bench's key presses would draw one).
  await ev('document.activeElement && document.activeElement.blur(); document.documentElement.style.background = "linear-gradient(135deg, #5b7083 0%, #8a9aa8 55%, #c7cdd2 100%)"; 0');
  await new Promise((r) => setTimeout(r, 250));
  const { data } = await S('Page.captureScreenshot', { format: 'png' });
  const out = path.join(root, 'docs', 'copy-popup-' + name + '.png');
  fs.writeFileSync(out, Buffer.from(data, 'base64'));
  console.log('    wrote ' + path.relative(root, out));
  await ev('document.documentElement.style.background = ""; 0');
  await S('Emulation.setDeviceMetricsOverride', { width: popupMod.WIDTH, height: popupMod.HEIGHT, deviceScaleFactor: 1, mobile: false });
}
