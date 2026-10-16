'use strict';

/**
 * The hotkey: does typing ever start a dictation, and does every key do what its
 * row in Settings says?
 *
 * Replays key sequences, with real timings, through hotkey-logic.createTrigger --
 * the state machine hotkeys.js runs on every key the hook sees -- and checks the
 * validator's answer for every key the picker can be given. AltGr+Q comes first:
 * on the Turkish layout it is how "@" is typed, and Windows reports it as a fake
 * Left Ctrl, Right Alt, Q. If that ever starts a dictation, nothing else matters.
 *
 * No Electron, no hook, no model.
 *
 *   node bench/hotkeys.js
 */

const fs = require('fs');
const path = require('path');
const logic = require('../src/main/hotkey-logic');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail && !ok ? '   ' + detail : ''));
}
const section = (s) => console.log('\n' + s);

/* -------------------------------------------------------------- sequences */

/**
 * Run events through a trigger the way hotkeys.js does, with `open` standing in
 * for the session. Events: ['down'|'up'|'other', ms]. Returns the actions taken.
 */
function replay(kind, events, opts = {}) {
  let open = Boolean(opts.open);
  const actions = [];
  const t = logic.createTrigger({ kind, isOpen: () => open, lostReleaseMs: opts.lostReleaseMs || 0 });
  for (const [ev, at] of events) {
    const a = ev === 'down' ? t.down(at) : ev === 'up' ? t.up(at) : t.other(at);
    if (!a) continue;
    if (a === 'toggle') open = !open;
    else if (a === 'start') open = true;
    else if (a === 'finish') open = false;
    actions.push(a);
  }
  return { actions, open };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

section('Right Alt on a Turkish keyboard (tap only)');
{
  // The fake Left Ctrl is filtered by hotkeys.js (IGNORE) before it reaches the trigger, so
  // AltGr+Q arrives here as: Right Alt down, another key (Q), Right Alt up.
  const r = replay('modifier', [['down', 0], ['other', 90], ['up', 160]]);
  check('AltGr+Q (types @) starts nothing', same(r.actions, []), JSON.stringify(r.actions));

  const slow = replay('modifier', [['down', 0], ['other', 900], ['up', 1000]]);
  check('AltGr held, hunting for the key, then Q: nothing', same(slow.actions, []), JSON.stringify(slow.actions));

  const tap = replay('modifier', [['down', 0], ['up', 120]]);
  check('a clean tap starts', same(tap.actions, ['toggle']) && tap.open, JSON.stringify(tap.actions));

  const two = replay('modifier', [['down', 0], ['up', 120], ['down', 4000], ['up', 4090]]);
  check('tap, talk, tap: starts then finishes', same(two.actions, ['toggle', 'toggle']) && !two.open);

  const held = replay('modifier', [['down', 0], ['up', 900]]);
  check('held 900 ms on its own: nothing (no hold-to-talk on a modifier)', same(held.actions, []));

  const repeat = replay('modifier', [['down', 0], ['down', 30], ['down', 60], ['up', 120]]);
  check('auto-repeat key-downs are ignored', same(repeat.actions, ['toggle']));

  const click = replay('modifier', [['down', 0], ['other', 200], ['up', 300]]);
  check('Right Ctrl + click (or ⌘-click) starts nothing', same(click.actions, []));
}

section('macOS: a lost release');
{
  // Right ⌘ released while Left ⌘ was held is never reported. The next press finds it "down".
  const r = replay('modifier', [['down', 0], ['down', 5000], ['up', 5100]], { lostReleaseMs: logic.TAP_MS });
  check('a press long after a lost release is a fresh tap', same(r.actions, ['toggle']), JSON.stringify(r.actions));
}

section('F13 and side buttons (tap or hold)');
{
  const tap = replay('key', [['down', 0], ['up', 100]]);
  check('tap starts and stays open', same(tap.actions, ['start']) && tap.open);

  const tap2 = replay('key', [['down', 0], ['up', 100], ['down', 5000], ['up', 5080]]);
  check('second tap finishes on the press', same(tap2.actions, ['start', 'finish']) && !tap2.open);

  const hold = replay('key', [['down', 0], ['up', 3000]]);
  check('held while talking: starts, finishes on release', same(hold.actions, ['start', 'finish']) && !hold.open);

  const edge = replay('key', [['down', 0], ['up', logic.HOLD_MS - 1]]);
  check('released just under HOLD_MS counts as a tap', same(edge.actions, ['start']) && edge.open);

  const rep = replay('key', [['down', 0], ['down', 40], ['down', 80], ['up', 2000]]);
  check('auto-repeat while held does not finish early', same(rep.actions, ['start', 'finish']));

  const btn = replay('button', [['down', 0], ['up', 2500]]);
  check('a side button held works like F13', same(btn.actions, ['start', 'finish']));
}

/* -------------------------------------------------------------- validator */

function accepts(platform, binding, expectBinding) {
  const v = logic.validate(binding, platform, { sideButtons: true });
  check(`${platform}: accepts ${binding}` + (expectBinding ? ` as ${expectBinding}` : ''),
    v.ok && (!expectBinding || v.binding === expectBinding), JSON.stringify(v));
}
function refuses(platform, binding, words, opts) {
  const v = logic.validate(binding, platform, opts || { sideButtons: true });
  check(`${platform}: refuses ${binding}`, !v.ok && (!words || words.test(v.reason)), JSON.stringify(v));
}

section('Windows: keys Typd takes');
accepts('win32', 'RightAlt');
accepts('win32', 'rightctrl', 'RightCtrl');
accepts('win32', 'RightShift');
accepts('win32', 'F13');
accepts('win32', 'F24');
accepts('win32', 'Mouse4');
accepts('win32', 'CommandOrControl+Shift+Space', 'Ctrl+Shift+Space');   // the old stored value
accepts('win32', 'Ctrl+Shift+D');
accepts('win32', 'Ctrl+Space');
accepts('win32', 'Alt+F9');
accepts('win32', 'Ctrl+Shift+F5');

section('Windows: keys Typd refuses, and says why');
refuses('win32', 'Ctrl+Alt+Q', /AltGr/);
refuses('win32', 'Ctrl+Alt+Shift+Space', /AltGr/);
refuses('win32', 'LeftCtrl', /Right Ctrl/);
refuses('win32', 'LeftAlt', /accident/);
refuses('win32', 'LeftMeta', /Win key/);
refuses('win32', 'RightMeta', /Win key/);
refuses('win32', 'Super+D', /Win/);
refuses('win32', 'CapsLock', /switch/);
refuses('win32', 'F5', /F13/);
refuses('win32', 'A', /types/);
refuses('win32', 'Space', /types/);
refuses('win32', 'Ctrl+C', /Shift/);
refuses('win32', 'Shift+A', /capital/);
refuses('win32', 'Alt+F', /menus/);
refuses('win32', 'Alt+F4', /Windows uses/);
refuses('win32', 'Alt+Tab', /Windows uses/);
refuses('win32', 'Escape', /Esc/);
refuses('win32', 'Mouse3', /clicking/);
refuses('win32', 'Mouse4', /side buttons/i, { sideButtons: false });
refuses('win32', 'Ctrl+Shift+', null);

section('macOS: keys Typd takes and refuses');
accepts('darwin', 'RightMeta');
accepts('darwin', 'RightAlt');
accepts('darwin', 'F13');
accepts('darwin', 'CommandOrControl+Shift+Space', 'Command+Shift+Space');
accepts('darwin', 'Ctrl+Shift+D');
refuses('darwin', 'Command+Space', /macOS uses/);
refuses('darwin', 'Command+C', /Shift/);
refuses('darwin', 'Alt+E', /character/);
refuses('darwin', 'Mouse4', /Mac/);
refuses('darwin', 'F21', /F20/);
refuses('darwin', 'LeftMeta', /Right ⌘/);

section('defaults are accepted, old values carry over');
check('Windows default is Right Alt', logic.defaultFor('win32') === 'RightAlt');
check('Mac default is Right ⌘', logic.defaultFor('darwin') === 'RightMeta');
check('a broken stored value falls back to the default', logic.normalize('Ctrl+Alt+Q', 'win32') === 'RightAlt');
check('an unknown platform behaves like Windows', logic.validate('RightAlt', 'linux').ok);

section('labels');
const labels = [
  ['win32', 'RightAlt', 'Right Alt'], ['win32', 'Ctrl+Shift+Space', 'Ctrl+Shift+Space'],
  ['win32', 'CommandOrControl+Shift+Space', 'Ctrl+Shift+Space'], ['win32', 'Mouse4', 'Mouse back button'],
  ['darwin', 'RightMeta', 'Right ⌘ (Command)'], ['darwin', 'Command+Shift+Space', '⇧⌘Space'],
  ['darwin', 'RightAlt', 'Right Option']
];
for (const [p, b, want] of labels) check(`${p} ${b} -> "${want}"`, logic.label(b, p) === want, logic.label(b, p));
check('short label for the pill', logic.shortLabel('RightMeta', 'darwin') === 'Right ⌘');
check('keycaps for a chord', same(logic.parts('Ctrl+Shift+Space', 'win32'), ['Ctrl', 'Shift', 'Space']));
check('keycaps on a Mac', same(logic.parts('Command+Shift+Space', 'darwin'), ['⇧', '⌘', 'Space']));
check('verb: tap a key, press a chord', logic.verb('RightAlt', 'win32') === 'tap' && logic.verb('Ctrl+Shift+D', 'win32') === 'press');

/* ------------------------------------------------- hotkeys.js, with fakes */

/*
 * hotkeys.js itself, with Electron and uiohook replaced by fakes. uiohook calls its listeners
 * from native code and aborts the whole process if one throws (napi_fatal_error), so nothing
 * a key press sets off may ever reach it; and on a Mac the event tap must survive a change of
 * key (stopping it can hang Typd: see hotkeys.js, macTap).
 */
section('hotkeys.js: a key press can never take Typd down');
{
  const Module = require('module');
  const { EventEmitter } = require('events');
  const realLoad = Module._load;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  const load = (platform) => {
    const hook = Object.assign(new EventEmitter(), { starts: 0, stops: 0 });
    hook.start = () => { hook.starts++; };
    hook.stop = () => { hook.stops++; };
    const codes = new Proxy({}, { get: (_, k) => (typeof k === 'string' ? 1000 + [...k].reduce((a, c) => a + c.charCodeAt(0), 0) : undefined) });
    const fakes = {
      electron: {
        globalShortcut: { register: () => true, unregister: () => {}, isRegistered: () => false },
        systemPreferences: { isTrustedAccessibilityClient: () => true }
      },
      'uiohook-napi': { uIOhook: hook, UiohookKey: codes }
    };
    Module._load = function (request, ...rest) {
      return Object.prototype.hasOwnProperty.call(fakes, request) ? fakes[request] : realLoad.call(this, request, ...rest);
    };
    Object.defineProperty(process, 'platform', { value: platform });
    const file = require.resolve('../src/main/hotkeys');
    delete require.cache[file];
    try { return { hk: require(file), hook, codes }; } finally { Object.defineProperty(process, 'platform', realPlatform); }
  };

  try {
    const { hk, hook, codes } = load('darwin');
    let presses = 0;
    const quiet = console.log;
    const keys = hk.registerHotkeys({
      binding: 'RightMeta',
      onPress: () => { presses++; throw new Error('a dictation that cannot start'); },
      onRelease: () => {}, onCancel: () => {}
    });
    let threw = null;
    console.log = () => {};
    try {
      hook.emit('keydown', { keycode: codes.MetaRight });
      hook.emit('keyup', { keycode: codes.MetaRight });
    } catch (err) { threw = err; } finally { console.log = quiet; }
    check('a throwing press never reaches uiohook', !threw && presses === 1, threw ? threw.message : 'presses ' + presses);
    check('the state line says it listens and counts keys', /Right ⌘.*: listening, 2 key events heard$/.test(keys.state()), keys.state());
    check('and keysHeard agrees', keys.keysHeard === 2);

    keys.close();
    check('macOS: a change of key keeps the event tap running', hook.stops === 0, 'stops ' + hook.stops);
    let after = 0;
    const next = hk.registerHotkeys({ binding: 'RightAlt', onPress: () => { after++; }, onRelease: () => {}, onCancel: () => {} });
    hook.emit('keydown', { keycode: codes.AltRight });
    hook.emit('keyup', { keycode: codes.AltRight });
    hook.emit('keydown', { keycode: codes.MetaRight });
    hook.emit('keyup', { keycode: codes.MetaRight });
    check('the new key works, the old one is gone', after === 1 && presses === 1, 'new ' + after + ', old ' + presses);
    next.close();
    hk.stopHook();
    check('macOS: the tap stops at quit (stopHook)', hook.stops === 1, 'stops ' + hook.stops);
    hk.stopHook();
    check('and only once', hook.stops === 1);
  } finally {
    Module._load = realLoad;
  }

  // The Mac build of uiohook-napi is patched so its start can never hang Typd's main thread
  // (scripts/build-uiohook-mac.js). The patch is exact text: say so here, on any platform,
  // the day an update to uiohook-napi stops it fitting.
  {
    const { patched, MARK } = require('../scripts/build-uiohook-mac.js');
    const dir = path.join(__dirname, '..', 'node_modules', 'uiohook-napi');
    let ok = false, why = '';
    try {
      const src = fs.readFileSync(path.join(dir, 'src', 'lib', 'uiohook_worker.c'), 'utf8');
      const out = patched(src, require(path.join(dir, 'package.json')).version);
      ok = out === null || (out.includes(MARK) && /while \(hook_state == 0\) \{\s*uv_cond_wait/.test(out) && patched(out) === null);
    } catch (err) { why = err.message; }
    check('the Mac start-handshake fix fits the installed uiohook-napi', ok, why);
  }

  try {
    const { hk, hook } = load('win32');
    const keys = hk.registerHotkeys({ binding: 'RightAlt', onPress: () => {}, onRelease: () => {}, onCancel: () => {} });
    keys.close();
    check('Windows: close() still stops its hook', hook.stops === 1, 'stops ' + hook.stops);
  } finally {
    Module._load = realLoad;
    delete require.cache[require.resolve('../src/main/hotkeys')];
  }
}

console.log('\n' + (failures ? failures + ' FAILED' : 'all hotkey checks passed') + '\n');
process.exit(failures ? 1 : 0);
