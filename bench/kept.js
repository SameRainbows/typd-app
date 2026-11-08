'use strict';

/**
 * Kept as pasted (kept.js): does the watch call each paste's fate right?
 *
 * Runs the classifier (compare), the watcher (createKept) on a fake clock and a fake text field,
 * History's new fields (store.js) and Home's line (kept-line.js). No Electron, no UI Automation,
 * no window; a minute of watching runs in milliseconds. The cases are the shapes the watch has to
 * tell apart: left alone, written on, a word fixed, deleted, undone, sent from a chat box, said
 * again, highlighted and revised, a password field, the focus leaving, a field it cannot read.
 *
 *   node bench/kept.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const kept = require('../src/main/kept');
const { createKept, compare, norm, cleanKept, logLine, variantOf, similar, baseline, MAX_CHARS, SCHEDULE_MS, REDO_MS } = kept;
const { keptLine, keptTag } = require('../src/renderer/kept-line');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}
const section = (s) => console.log('\n' + s);

/* ------------------------------------------------------------ the harness */

/** A clock and timers that jump: advance(ms) runs every timer due by then, in order, awaiting each. */
function fakeClock() {
  let t = 0;
  let seq = 0;
  const q = [];
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    now: () => t,
    timers: {
      set: (fn, ms) => { const h = { fn, at: t + ms, seq: seq++ }; q.push(h); return h; },
      clear: (h) => { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); }
    },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const h = q[0];
        if (!h || h.at > end) break;
        q.shift();
        t = h.at;
        await h.fn();
        await flush();
      }
      t = end;
      await flush();
    },
    pending: () => q.length
  };
}

/**
 * A text field the fake helper reads: change its fields between advance() calls.
 * caret defaults to the end of the text (where a paste leaves it).
 */
function makeField(init) {
  const f = { process: 'notepad', fid: '42.1', pw: false, how: 'text', text: '', caret: null, cutBefore: false, cutAfter: false, ...init };
  let reads = 0;
  let answer = true;
  let busy = false;
  return {
    f,
    set(patch) { Object.assign(f, patch); },
    silent(v = true) { answer = !v; },
    helperBusy(v = true) { busy = v; },
    reads: () => reads,
    read: async () => {
      if (busy) return { skip: true };   // inject.fieldAround while another command waits on the helper
      reads++;
      if (!answer) return null;
      return { ...f, caret: Number.isInteger(f.caret) ? f.caret : f.text.length };
    }
  };
}

/** One watch on its own watcher: {k, clock, field, out()} where out() is the verdict, or undefined. */
function scenario({ pasted, field: init, app, busy } = {}) {
  const clock = fakeClock();
  const k = createKept({ timers: clock.timers, now: clock.now });
  const field = makeField(init);
  let result;
  let calls = 0;
  k.watch({ pasted, app: app === undefined ? field.f.process : app, read: field.read, busy, onResult: (r) => { calls++; result = r; } });
  return { k, clock, field, out: () => result, calls: () => calls };
}

const P = 'Thanks for the update, I will send the draft tonight.';
const BEFORE = 'Hi Sam,\n\n';
const MIN = 61000;
const WAIT = REDO_MS + 1000;
const hasWords = (o, ...words) => words.some((w) => JSON.stringify(o).includes(w));

(async () => {
  /* -------------------------------------------------------- the classifier */

  section('the classifier: what happened to the pasted text (compare)');
  {
    check('unchanged is kept', compare(P, P).v === 'kept');
    check('line breaks, curly quotes and invisible characters are not changes',
      compare('He said "fine".\nThen we left.', 'He said \u201cfine\u201d.\r\n\r\nThen\u200b we left.').v === 'kept');
    const on = compare(P, P + ' Talk soon.');
    check('writing on after it is kept, and counted as typed', on.v === 'kept' && on.typed > 0, on);
    const pre = compare(P, 'Oh, and: ' + P);
    check('writing on before it is kept too', pre.v === 'kept' && pre.typed > 0, pre);

    const one = compare(P, P.replace('tonight', 'tomorrow'));
    check('one word fixed: edited, 1 word', one.v === 'edited' && one.words === 1, one);
    check('  with the word-level change', one.changes && one.changes.length === 1 && one.changes[0].was === 'tonight.' && one.changes[0].now === 'tomorrow.', one.changes);
    check('  characters changed counted', one.chars === 6, String(one.chars));
    check('  share of its words', one.share === Math.round(100 / 10) / 100, String(one.share));

    const punct = compare(P, P.replace('tonight.', 'tonight!'));
    check('a punctuation mark changed is an edit (1 character)', punct.v === 'edited' && punct.chars === 1, punct);
    const caps = compare(P, P.replace('Thanks', 'thanks'));
    check('a capital changed is an edit', caps.v === 'edited' && caps.words === 1 && caps.changes[0].was === 'Thanks', caps);

    const two = compare(P, P.replace('update', 'news').replace('draft', 'final draft'));
    check('two places changed: two changes', two.v === 'edited' && two.changes.length === 2, two);

    const rm = compare(P, P.replace(' the draft', ''));
    check('words removed inside it: edited', rm.v === 'edited' && rm.changes.some((c) => c.was === 'the draft' && c.now === ''), rm);

    const first = compare(P, 'Thank you for the update, I will send the draft tonight. Bye');
    check('first word fixed, then written on: edited and typed', first.v === 'edited' && first.typed > 0 && first.changes[0].was === 'Thanks', first);

    const over = compare(P, 'Totally different words now.');
    check('written over entirely: edited, every word', over.v === 'edited' && over.share === 1, over);
    check('empty is deleted', compare(P, '').v === 'deleted');
    check('two paragraphs read back with no space between them are not an edit',
      compare('Where did it go? How do we know?', 'Where did it go?How do we know?').v === 'kept');

    const many = compare('a b c d e f g h i j k l m n o p q r s t', 'A b C d E f G h I j K l M n O p Q r S t');
    check('at most 8 changes kept', many.v === 'edited' && many.changes.length === 8 && many.words === 10, many);
    const long = compare('x'.repeat(200), 'y'.repeat(200));
    check('a changed word is clipped to 80 characters', long.changes[0].was.length === 80, String(long.changes[0].was.length));
  }

  section('similar: is the next dictation the same thing said again?');
  check('the same, with a word changed', similar(P, P.replace('tonight', 'tomorrow')));
  check('something else', !similar(P, 'Can you book the meeting room for Friday?'));
  check('one word, misheard', similar('Kairos', 'Kairos.') && !similar('yes', 'tomorrow'));
  check('a short follow-up sharing a few common words is not', !similar(P, 'I will send it.'), 'similar');
  check('said again as part of more', similar(P, 'Sorry, ' + P.replace('tonight', 'tomorrow') + ' And the slides too, if I can.'));

  section('where it landed (baseline)');
  {
    const twice = 'Ok. ' + P + ' Then. ' + P;
    const b = baseline(norm(P), { text: twice, caret: twice.length });
    check('the same text twice: the copy at the caret', b && b.at === norm(twice).lastIndexOf(norm(P)), b && b.at);
    const b2 = baseline(norm(P), { text: twice, caret: 4 + P.length });
    check('  or the first, when the caret is after it', b2 && b2.at === 4, b2 && b2.at);
    const list = baseline(norm('- buy milk\n- call Sam\n- book flights'), { text: 'Todo:\nbuy milk\ncall Sam\nbook flights', caret: -1 });
    check('an app that drops the list markers: found roughly', list && list.how === 'fuzzy' && list.landed === 'buy milk call Sam book flights', list);
    check('not there: null', baseline(norm(P), { text: 'Something else entirely, about the weather.', caret: -1 }) === null);
  }

  /* ---------------------------------------------------------- the watcher */

  section('kept: left alone for the minute');
  {
    const s = scenario({ pasted: P, field: { text: BEFORE + P } });
    await s.clock.advance(MIN);
    check('kept, at the end of the window', s.out() && s.out().v === 'kept' && s.out().end === 'window', s.out());
    check('  read about 15 times, then never again', s.field.reads() === SCHEDULE_MS.length && s.clock.pending() === 0, s.field.reads());
    check('  one verdict only', s.calls() === 1);
    check('  timed', s.out().ms === 60000 && s.out().reads === SCHEDULE_MS.length, s.out());
  }

  section('kept: written on after it');
  {
    const s = scenario({ pasted: P, field: { text: BEFORE + P } });
    await s.clock.advance(5000);
    s.field.set({ text: BEFORE + P + ' Talk soon, Mehmet' });
    await s.clock.advance(MIN);
    check('kept, typed counted', s.out().v === 'kept' && s.out().typed > 0, s.out());
  }

  section('kept: the text before it was changed, not it');
  {
    const s = scenario({ pasted: P, field: { text: BEFORE + P } });
    await s.clock.advance(4000);
    s.field.set({ text: 'Hello Sam, sorry for the wait.\n\n' + P });
    await s.clock.advance(MIN);
    check('kept', s.out().v === 'kept', s.out());
  }

  section('edited: one word fixed inside it');
  {
    const s = scenario({ pasted: P, field: { text: BEFORE + P + '\n\nBest,\nMehmet' , caret: (BEFORE + P).length } });
    await s.clock.advance(8000);
    s.field.set({ text: BEFORE + P.replace('tonight', 'tomorrow') + '\n\nBest,\nMehmet' });
    await s.clock.advance(MIN);
    const r = s.out();
    check('edited, 1 word', r.v === 'edited' && r.words === 1, r);
    check('  the word-level change is kept', r.changes && r.changes[0].was === 'tonight.' && r.changes[0].now === 'tomorrow.', r.changes);
  }

  section('edited, then fixed back: kept');
  {
    const s = scenario({ pasted: P, field: { text: BEFORE + P } });
    await s.clock.advance(5000);
    s.field.set({ text: BEFORE + P.replace('draft', 'drfat') });
    await s.clock.advance(5000);
    s.field.set({ text: BEFORE + P });
    await s.clock.advance(MIN);
    check('kept (what counts is how it was left)', s.out().v === 'kept', s.out());
  }

  section('deleted: removed, the rest of the field stays');
  {
    const s = scenario({ pasted: P, field: { text: BEFORE + P } });
    await s.clock.advance(6000);
    s.field.set({ text: BEFORE });
    await s.clock.advance(MIN + WAIT);
    check('deleted', s.out() && s.out().v === 'deleted', s.out());
  }

  section('deleted: undone (Ctrl+Z), in an editor whose text continues after it');
  {
    const doc = 'Notes for Friday.\n\n';
    const after = '\n\nAgenda: budget, hiring, the launch.';
    const s = scenario({ pasted: P, field: { text: doc + P + after, caret: (doc + P).length } });
    await s.clock.advance(3000);
    s.field.set({ text: doc + after, caret: doc.length });
    await s.clock.advance(MIN + WAIT);
    check('deleted', s.out() && s.out().v === 'deleted', s.out());
  }

  section('deleted: a box that is not a chat app, emptied');
  {
    const s = scenario({ pasted: P, field: { process: 'notepad', text: P } });
    await s.clock.advance(5000);
    s.field.set({ text: '' });
    await s.clock.advance(WAIT + 5000);
    check('deleted, cleared', s.out() && s.out().v === 'deleted' && s.out().end === 'cleared', s.out());
  }

  section('kept and sent: a chat box that empties itself');
  {
    const s = scenario({ pasted: P, field: { process: 'claude', fid: '7', text: P } });
    await s.clock.advance(4000);
    s.field.set({ text: '' });
    await s.clock.advance(2000);
    check('no verdict yet: the next dictation may still show a redo', s.out() === undefined, s.out());
    await s.clock.advance(WAIT);
    check('kept, sent', s.out() && s.out().v === 'kept' && s.out().sent === true && s.out().end === 'sent', s.out());
    check('  and the reads stopped at the send', s.field.reads() === 4, s.field.reads());
  }

  section('edited, then sent');
  {
    const s = scenario({ pasted: P, field: { process: 'zen', text: P } });
    await s.clock.advance(4000);
    s.field.set({ text: P.replace('tonight', 'on Monday') });
    await s.clock.advance(3000);
    s.field.set({ text: '' });
    await s.clock.advance(WAIT);
    // 'tonight.' -> 'on Monday.': its last word replaced one for one, the rest taken as written on (the documented assumption).
    check('edited and sent', s.out().v === 'edited' && s.out().sent === true && s.out().words >= 1 && s.out().changes[0].was === 'tonight.', s.out());
  }

  section('sent before the first look, in a chat app already seen to be readable');
  {
    const clock = fakeClock();
    const k = createKept({ timers: clock.timers, now: clock.now });
    const field = makeField({ process: 'claude', text: P });
    let r1;
    k.watch({ pasted: P, app: 'claude', read: field.read, onResult: (r) => { r1 = r; } });
    await clock.advance(MIN);
    const Q = 'Can you also check the logs from last night?';
    field.set({ text: '' });
    let r2;
    k.watch({ pasted: Q, app: 'claude', read: field.read, onResult: (r) => { r2 = r; } });
    await clock.advance(MIN + WAIT);
    check('the first one kept', r1 && r1.v === 'kept', r1);
    check('the second: kept, sent, fast', r2 && r2.v === 'kept' && r2.sent && r2.fast, r2);

    const s = scenario({ pasted: P, field: { process: 'claude', text: '' } });
    await s.clock.advance(MIN);
    check('the same in an app never seen readable: unknown (not found)', s.out().v === 'unknown' && s.out().why === 'not-found', s.out());
  }

  section('redone: sent, then the same said again');
  {
    const s = scenario({ pasted: P, field: { process: 'claude', text: P } });
    await s.clock.advance(3000);
    s.field.set({ text: '' });
    await s.clock.advance(5000);
    await s.k.settle({ process: 'claude' });
    check('the next dictation starting decides nothing yet', s.out() === undefined, s.out());
    s.k.watch({ pasted: P.replace('tonight', 'tomorrow'), app: 'claude', read: s.field.read });
    check('redone by dictating again, was kept', s.out() && s.out().v === 'redone' && s.out().how === 'dictate' && s.out().was === 'kept', s.out());
  }

  section('kept and sent, then something else said');
  {
    const s = scenario({ pasted: P, field: { process: 'claude', text: P } });
    await s.clock.advance(3000);
    s.field.set({ text: '' });
    await s.clock.advance(5000);
    s.k.watch({ pasted: 'And what about the budget for next quarter?', app: 'claude', read: s.field.read });
    check('kept, sent', s.out() && s.out().v === 'kept' && s.out().sent, s.out());
  }

  section('redone: deleted, then dictated again in the same app');
  {
    const s = scenario({ pasted: P, field: { text: BEFORE + P } });
    await s.clock.advance(7000);
    s.field.set({ text: BEFORE });
    await s.clock.advance(3000);
    await s.k.settle({ process: 'notepad' });
    s.k.watch({ pasted: 'Thanks, I will send it tomorrow.', app: 'notepad', read: s.field.read });
    check('redone, was deleted', s.out() && s.out().v === 'redone' && s.out().was === 'deleted', s.out());
  }

  section('redone: highlighted and spoken over (a revision)');
  {
    const s = scenario({ pasted: P, field: { text: BEFORE + P } });
    await s.clock.advance(9000);
    await s.k.settle({ selection: { text: P, process: 'notepad' } });
    check('redone by a revision, was kept', s.out() && s.out().v === 'redone' && s.out().how === 'revise' && s.out().was === 'kept', s.out());

    const t = scenario({ pasted: P, field: { text: BEFORE + P } });
    await t.clock.advance(9000);
    await t.k.settle({ selection: { text: 'the draft tonight', process: 'notepad' } });
    check('  part of it highlighted counts too', t.out() && t.out().v === 'redone', t.out());

    const u = scenario({ pasted: P, field: { text: BEFORE + P } });
    await u.clock.advance(9000);
    await u.k.settle({ selection: { text: 'Hi Sam', process: 'notepad' } });
    check('  other text highlighted: kept', u.out() && u.out().v === 'kept' && u.out().end === 'next', u.out());
  }

  section('the next dictation starts: one last look');
  {
    const s = scenario({ pasted: P, field: { text: BEFORE + P } });
    await s.clock.advance(5000);
    s.field.set({ text: BEFORE + P.replace('update', 'news') });
    await s.k.settle({ process: 'notepad' });
    check('edited, seen by the last look', s.out() && s.out().v === 'edited' && s.out().end === 'next', s.out());
    const n = s.field.reads();
    await s.clock.advance(MIN);
    check('  and no reads after it', s.field.reads() === n, s.field.reads());

    const t = scenario({ pasted: P, field: { text: BEFORE + P } });
    await t.clock.advance(5000);
    await t.k.settle({ process: 'chrome' });
    check('the next one in another app: the verdict so far, left', t.out() && t.out().v === 'kept' && t.out().end === 'left', t.out());
  }

  section('the focus leaves');
  {
    const s = scenario({ pasted: P, field: { text: BEFORE + P } });
    await s.clock.advance(5000);
    s.field.set({ process: 'chrome', text: 'some web page text' });
    await s.clock.advance(MIN);
    check('another app: the verdict as last seen, left', s.out().v === 'kept' && s.out().end === 'left', s.out());
    const r = s.field.reads();
    await s.clock.advance(MIN);
    check('  and nothing is read there after', s.field.reads() === r && s.clock.pending() === 0);

    const t = scenario({ pasted: P, field: { text: BEFORE + P } });
    await t.clock.advance(5000);
    t.field.set({ fid: '42.9', text: 'the search box' });
    await t.clock.advance(MIN);
    check('another field of the same app: left', t.out().v === 'kept' && t.out().end === 'left', t.out());
  }

  section('password fields are never read');
  {
    const s = scenario({ pasted: P, field: { pw: true, how: 'password', text: '' } });
    await s.clock.advance(MIN);
    check('a password field at once: unknown (password)', s.out().v === 'unknown' && s.out().why === 'password', s.out());
    check('  after a single read', s.field.reads() === 1, s.field.reads());

    // A helper that sent text for one anyway: the text is not used.
    const t = scenario({ pasted: P, field: { pw: true, how: 'text', text: P + ' hunter2' } });
    await t.clock.advance(MIN);
    check('  even with text in the answer, unknown and none of it kept', t.out().v === 'unknown' && !hasWords(t.out(), 'hunter2', 'Thanks'), t.out());

    const u = scenario({ pasted: P, field: { text: BEFORE + P } });
    await u.clock.advance(5000);
    u.field.set({ pw: true, how: 'password', text: '' });
    await u.clock.advance(MIN);
    check('the focus moving to a password field ends the watch', u.out().v === 'kept' && u.out().end === 'left', u.out());
  }

  section('what cannot be watched');
  {
    const s = scenario({ pasted: P, field: { how: 'no-text-pattern', text: '' } });
    await s.clock.advance(MIN);
    check('a field that does not expose its text: unknown (unreadable)', s.out().v === 'unknown' && s.out().why === 'unreadable', s.out());

    const t = scenario({ pasted: P, field: { text: 'The paste went somewhere else entirely.' } });
    await t.clock.advance(MIN);
    check('the paste is not in the field: unknown (not found)', t.out().v === 'unknown' && t.out().why === 'not-found', t.out());

    const big = 'word '.repeat(Math.ceil(MAX_CHARS / 5) + 10);
    const u = scenario({ pasted: big, field: { text: big } });
    check('too long for the read window: unknown at once, no read', u.out() && u.out().why === 'too-long' && u.field.reads() === 0, u.out());

    const v = scenario({ pasted: P, field: { text: BEFORE + P } });
    v.field.silent();
    await v.clock.advance(MIN);
    check('a helper that never answers: unknown (no read), stopped', v.out().v === 'unknown' && v.out().why === 'no-read' && v.out().end === 'stopped', v.out());

    const w = scenario({ pasted: P, field: { text: BEFORE + P } });
    await w.clock.advance(3000);
    w.field.set({ text: 'x'.repeat(100), cutBefore: true });
    await w.clock.advance(MIN);
    check('scrolled out of the read window: the verdict so far', w.out().v === 'kept' && w.out().end === 'out-of-view', w.out());

    const x = scenario({ pasted: '   \n ', field: { text: 'a' } });
    check('nothing to watch for whitespace', x.out() === undefined && x.k.active() === null);
  }

  section('reformatted by the app as it landed');
  {
    const L = '- buy milk\n- call Sam\n- book flights';
    const s = scenario({ pasted: L, field: { text: 'Todo:\nbuy milk\ncall Sam\nbook flights' } });
    await s.clock.advance(MIN);
    check('found by its words: kept, rough', s.out().v === 'kept' && s.out().rough === true, s.out());
  }

  section('a newer dictation under way: the old watch waits');
  {
    let busy = false;
    const s = scenario({ pasted: P, field: { text: BEFORE + P }, busy: () => busy });
    await s.clock.advance(2000);
    const n = s.field.reads();
    busy = true;
    await s.clock.advance(20000);
    check('no reads while busy', s.field.reads() === n, s.field.reads() + ' vs ' + n);
    busy = false;
    await s.clock.advance(MIN);
    check('  and a verdict after', s.out() && s.out().v === 'kept');
  }

  section('the helper busy with a dictation’s own commands: no look, no miss');
  {
    const s = scenario({ pasted: P, field: { text: BEFORE + P } });
    await s.clock.advance(3500);
    s.field.helperBusy();
    await s.clock.advance(30000);
    check('the watch does not stop', s.out() === undefined && s.k.active() !== null, s.out());
    s.field.helperBusy(false);
    s.field.set({ text: BEFORE + P.replace('draft', 'final draft') });
    await s.clock.advance(MIN);
    check('  and still sees an edit after', s.out() && s.out().v === 'edited', s.out());
  }

  section('the paste found only after a slow app shows it');
  {
    const s = scenario({ pasted: P, field: { text: BEFORE } });
    await s.clock.advance(1000);
    s.field.set({ text: BEFORE + P });
    await s.clock.advance(MIN);
    check('kept', s.out().v === 'kept', s.out());
  }

  section('stop() ends a watch with no verdict');
  {
    const s = scenario({ pasted: P, field: { text: BEFORE + P } });
    await s.clock.advance(2000);
    s.k.stop();
    await s.clock.advance(MIN);
    check('no verdict, no timers', s.out() === undefined && s.clock.pending() === 0);
  }

  /* ----------------------------------------------------- what is written */

  section('what is written (cleanKept) and logged (logLine)');
  {
    const c = cleanKept({ v: 'edited', chars: 5.4, words: 1, share: 1.7, changes: Array(12).fill({ was: 'a', now: 'b' }), text: 'the whole field', context: 'secret', typed: -3, sent: 'yes', ms: 1234 });
    check('only its own fields', !('text' in c) && !('context' in c) && !('typed' in c) && !('sent' in c), c);
    check('  in range', c.chars === 5 && c.share === 1 && c.changes.length === 8 && c.ms === 1234, c);
    check('not a verdict: null', cleanKept({ v: 'great' }) === null && cleanKept(null) === null && cleanKept('kept') === null);
    check('redone keeps how and was', JSON.stringify(cleanKept({ v: 'redone', how: 'revise', was: 'kept', changes: [{ was: 'x', now: 'y' }] })) === '{"v":"redone","how":"revise","was":"kept"}');
    const line = logLine(compare(P, P.replace('tonight', 'tomorrow')));
    check('the log line has counts, never words', line === 'edited: 1 word, 6 characters' && !/tonight|tomorrow/.test(line), line);
    check('  every kind has one', ['kept', 'deleted', 'redone', 'unknown'].every((v) => logLine({ v }).startsWith(v)));
    const sent = logLine(cleanKept({ v: 'kept', sent: true, end: 'sent', reads: 4, ms: 7512 }));
    check('  and says how the watch ended', sent === 'kept, sent (ended sent, 4 reads, 7.5 s)', sent);
  }

  section('which model wrote it (variantOf)');
  check('the 1.7B is full', variantOf('C:/m/typd-dictate-1.7b-p2g-q4_k_m.gguf') === 'full');
  check('the 0.6B is light', variantOf('/m/typd-dictate-0.6b-soup_r20kd_ship-q4_k_m.gguf') === 'light');
  check('a name without a size: the mmproj says', variantOf('p2g-q4_k_m.gguf', 'mmproj-qwen3-asr-1.7b-q8_0.gguf') === 'full');
  check('no size anywhere: null', variantOf('model.gguf', 'mm.gguf') === null);
  check('not fooled by 10.6b or 21.7b', variantOf('x-10.6b.gguf') === null && variantOf('x-21.7b.gguf') === null);

  section('History keeps the verdict (store.js), and older items stay as they were');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-kept-'));
    try {
      const { createStore } = require('../src/main/store');
      const file = path.join(tmp, 'history.json');
      let clock = Date.parse('2026-10-31T10:00:00Z');
      // A file written by 0.2.12, before these fields.
      fs.writeFileSync(file, JSON.stringify({ v: 2, keep: '30d', items: [{ id: '20261030T100000Z-ab12', at: '2026-10-30T10:00:00.000Z', mode: 'dictate', text: 'An older one.', words: 3, seconds: 1, waitMs: 100, app: 'notepad', outcome: 'pasted' }], days: {} }));
      const s = createStore({ file, now: () => clock });
      const old = s.list()[0];
      check('an older item reads as before, with no new fields', old && !('kept' in old) && !('model' in old) && !('variant' in old), old);
      const a = s.record({ mode: 'dictate', text: P, app: 'notepad', outcome: 'pasted', model: 'p2g_1p7b', variant: 'full' });
      check('model and variant are kept', a.model === 'p2g_1p7b' && a.variant === 'full', a);
      check('a verdict is added when the watch ends', s.annotate(a.id, { kept: { v: 'edited', chars: 5, words: 1, share: 0.1, changes: [{ was: 'tonight.', now: 'tomorrow.' }] } }) === true);
      const b = s.record({ mode: 'dictate', text: 'Second one.', app: 'claude', outcome: 'pasted', model: 'soup_r20kd', variant: 'light' });
      s.annotate(b.id, { kept: { v: 'kept', sent: true } });
      const c = s.record({ mode: 'dictate', text: 'Third one.', app: 'claude', outcome: 'pasted', model: 'p2g_1p7b', variant: 'full' });
      s.annotate(c.id, { kept: { v: 'kept' } });
      const d = s.record({ mode: 'dictate', text: 'Fourth one.', app: 'notepad', outcome: 'pasted', model: 'p2g_1p7b', variant: 'full' });
      s.annotate(d.id, { kept: { v: 'unknown', why: 'unreadable' } });
      const r = s.record({ mode: 'revise', text: 'A revision.', app: 'notepad', outcome: 'pasted', model: 'p2g_1p7b', variant: 'full' });
      s.annotate(r.id, { kept: { v: 'kept' } });
      check('a bad model name or variant is dropped', !('model' in s.record({ mode: 'dictate', text: 'x y', model: '../../etc', variant: 'huge' })));
      check('no verdict for an item that is gone', s.annotate('20991231T000000Z-ffff', { kept: { v: 'kept' } }) === false);
      check('no verdict that is not one', s.annotate(a.id, { kept: { v: 'nope' } }) === false);

      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      check('still version 2', raw.v === 2);
      check('the edit is in the file, with its words', raw.items.some((x) => x.kept && x.kept.v === 'edited' && x.kept.changes[0].now === 'tomorrow.'));

      const k = s.counts().kept;
      check('Home counts this week: unknowns and revisions left out', k.n === 3 && k.kept === 2, k);
      check('  by model size', k.full.n === 2 && k.full.kept === 1 && k.light.n === 1 && k.light.kept === 1, k);
      clock += 8 * 86400000;
      check('  and only this week', s.counts().kept.n === 0, s.counts().kept);

      // What 0.2.12's store.js (no kept fields) does with this file: reads it, and keeps its own fields.
      const sOld = createStore({ file, now: () => clock });
      check('the file still loads', sOld.list().length >= 5);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  section("Home's line (kept-line.js)");
  check('nothing measured: no line', keptLine({ n: 0, kept: 0 }) === '' && keptLine(null) === '');
  check('one model', keptLine({ n: 41, kept: 33, full: { n: 41, kept: 33 }, light: { n: 0, kept: 0 } }) === 'Kept as is this week: 80% of 41 (full model)', keptLine({ n: 41, kept: 33, full: { n: 41, kept: 33 }, light: { n: 0, kept: 0 } }));
  check('both models: each one', keptLine({ n: 50, kept: 39, full: { n: 41, kept: 33 }, light: { n: 9, kept: 6 } }) === 'Kept as is this week: 78% of 50 — full 80% of 41, light 67% of 9', keptLine({ n: 50, kept: 39, full: { n: 41, kept: 33 }, light: { n: 9, kept: 6 } }));
  check('History tag: an edit says how many words', keptTag({ v: 'edited', words: 2 }) === 'Edited after: 2 words');
  check('  kept and unknown say nothing', keptTag({ v: 'kept' }) === '' && keptTag({ v: 'unknown' }) === '' && keptTag(null) === '');
  check('  deleted and redone', keptTag({ v: 'deleted' }) === 'Deleted after' && keptTag({ v: 'redone' }) === 'Said again');

  section('the helpers never read a password field (source checks)');
  {
    const ps = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'inject.ps1'), 'utf8');
    const around = ps.slice(ps.indexOf('function Get-Around'), ps.indexOf("Emit ($out | ConvertTo-Json -Compress)", ps.indexOf('function Get-Around')));
    check('Windows: around checks IsPassword before any text read', around.indexOf('IsPassword') > 0 && around.indexOf('IsPassword') < around.indexOf('GetSelection') && /if \(\$out\.pw\) \{\s*\$out\.how = 'password'/.test(around));
    check('Windows: no window title in around', !/Title\(\)/.test(around));
    check('Windows: the text before the caret is read whole, then its tail kept (its end is never cut)',
      around.includes('GetText(4 * $lim)') && around.includes('Substring($before.Length - 2 * $lim)'));
    const ctx = ps.slice(ps.indexOf('function Get-Context'), ps.indexOf('function Get-Around'));
    check('Windows: the context read skips a password field too', /if \(-not \$pw\) \{ \$text = Get-FocusText \$el \}/.test(ctx));
    const mac = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'mac', 'inject-helper.js'), 'utf8');
    const ar = mac.slice(mac.indexOf('function around()'), mac.indexOf('// What the user has actually highlighted'));
    check('Mac: around returns before AXValue on a secure field', ar.indexOf("'AXSecureTextField'") > 0 && ar.indexOf("'AXSecureTextField'") < ar.indexOf("'AXValue'"));
    check('the helpers answer "around"', /'around'\s*\{ Get-Around \}/.test(ps) && /around: around/.test(mac));
  }

  console.log('\n' + (failures ? failures + ' FAILED' : 'all kept-as-pasted checks passed') + '\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
