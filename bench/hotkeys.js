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

section('the "That was wrong" shortcut (flags the last dictation; sharing.js)');
for (const p of ['win32', 'darwin']) {
  const flag = logic.flagDefaultFor(p);
  const v = logic.validate(flag, p);
  check(`${p}: ${flag} is a combination Typd accepts`, v.ok && v.kind === 'chord' && logic.validFlag(flag, p) === v.binding, v);
  check(`${p}: never the dictation key or the suggested combination`,
    v.binding !== logic.defaultFor(p) && v.binding !== logic.validate(p === 'darwin' ? 'Command+Shift+Space' : 'Ctrl+Shift+Space', p).binding);
  const acc = logic.parseAccelerator(flag, p);
  check(`${p}: no Ctrl+Alt (AltGr), no Win or Command key (Finder's Empty Trash is Shift+Command+Delete)`, !(acc.mods.ctrl && acc.mods.alt) && !acc.mods.cmd);
}
check("a single key is never the flag (the native hook is dictation's)",
  logic.validFlag('RightAlt', 'win32') === null && logic.validFlag('F13', 'win32') === null && logic.validFlag('RightMeta', 'darwin') === null);
check('Ctrl+Alt+Backspace is refused as the flag too', logic.validFlag('Ctrl+Alt+Backspace', 'win32') === null);
check('another combination can be chosen', logic.validFlag('Ctrl+Shift+F9', 'win32') === 'Ctrl+Shift+F9');
{
  // Pressed with Right Alt as its Alt: Right Alt held with Shift and Backspace is a chord, never
  // a tap, so the flag cannot also start a dictation.
  const t = logic.createTrigger({ kind: 'modifier', isOpen: () => false });
  t.down(0); t.other(); t.other();
  check('Right Alt + Shift + Backspace does not toggle dictation', t.up(120) === null);
  t.down(1000);
  check('a clean Right Alt tap still does', t.up(1100) === 'toggle');
}

console.log('\n' + (failures ? failures + ' FAILED' : 'all hotkey checks passed') + '\n');
process.exit(failures ? 1 : 0);
