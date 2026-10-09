'use strict';

/**
 * The Typd window's data: does History keep only what it should, for as long as it
 * should, and give back exactly what Undo promises? Does the Dictionary round-trip?
 * Can a release note or a dictation ever become live markup?
 *
 * Runs store.js, dictionary.js, the window's search and markdown.js against a
 * throwaway folder. No Electron, no window, and the user's own files are never touched.
 *
 *   node bench/home.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-home-'));
// dictionary.js reads its path from the environment (pipeline/context.js); point it here.
process.env.APPDATA = tmp;
process.env.HOME = tmp;
process.env.XDG_CONFIG_HOME = tmp;

const { createStore, dayKey } = require('../src/main/store');
const dictionary = require('../src/main/dictionary');
const { VOCAB_FILE } = require('../src/main/pipeline/context');
const { fold, matches } = require('../src/renderer/search');
const { renderMarkdown } = require('../src/renderer/markdown');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail && !ok ? '   ' + detail : ''));
}
const section = (s) => console.log('\n' + s);

const DAY = 86400000;
let clock = Date.parse('2026-10-09T12:00:00Z');
const file = path.join(tmp, 'typd', 'history.json');
const make = () => createStore({ file, now: () => clock });

/* ------------------------------------------------------------------ history */

section('history keeps what landed, and nothing else');
{
  const s = make();
  const item = s.record({
    mode: 'dictate', text: 'Thanks for the update, I will send the draft tonight.', seconds: 4.2, waitMs: 400,
    app: 'chrome', outcome: 'pasted',
    // None of these may reach the file: other people's words, and private detail.
    context: 'SECRET SCREEN TEXT', span: 'SECRET SPAN', title: 'Inbox - private@example.com', contextBlock: 'X'
  });
  const raw = fs.readFileSync(file, 'utf8');
  check('the item is written', item && raw.includes('Thanks for the update'));
  check('screen context, span and title are dropped', !/SECRET|private@example|contextBlock/.test(raw));
  check('words are counted', item.words === 10, String(item && item.words));
  check('an id is made', /^[0-9TZ-]+-[0-9a-f]{4}$/.test(item.id), item.id);
  check('empty text is not recorded', s.record({ mode: 'dictate', text: '' }) === null);
}

section('keep: 30 days, forever, off');
{
  fs.rmSync(file, { force: true });
  const s = make();
  clock = Date.parse('2026-09-01T12:00:00Z');
  s.record({ text: 'old one', seconds: 1 });
  clock = Date.parse('2026-09-12T12:00:00Z');
  s.record({ text: 'twenty-seven days old', seconds: 1 });
  clock = Date.parse('2026-10-09T12:00:00Z');
  s.record({ text: 'today', seconds: 1 });
  s.reload();
  const texts = s.list().map((i) => i.text);
  check('30 days (the default) drops a 38-day-old item', !texts.includes('old one'), JSON.stringify(texts));
  check('and keeps a 27-day-old one', texts.includes('twenty-seven days old'));
  check('newest first', texts[0] === 'today');

  s.setKeep('forever');
  clock += 400 * DAY;
  s.reload();
  check('forever keeps everything', s.list().length === 2);
  clock -= 400 * DAY;

  s.setKeep('off');
  check('off deletes what was kept', s.list().length === 0);
  s.record({ text: 'not kept', seconds: 2, mode: 'dictate' });
  check('off keeps no new items', s.list().length === 0);
  check('but still counts the day', s.counts().dictations === 4, JSON.stringify(s.counts()));
  check('a bad keep value is refused', s.setKeep('sometimes') === false && s.keep() === 'off');
}

section('delete one, undo, delete all');
{
  fs.rmSync(file, { force: true });
  const s = make();
  const a = s.record({ text: 'first', seconds: 1 });
  clock += 60000;
  const b = s.record({ text: 'second', seconds: 1 });
  clock += 60000;
  s.record({ text: 'third', seconds: 1 });
  const before = fs.readFileSync(file, 'utf8');
  check('remove takes it out', s.remove(b.id) && !s.list().some((i) => i.id === b.id));
  check('restore puts it back in its place', s.restore(b.id) && s.list().map((i) => i.text).join(',') === 'third,second,first');
  check('the file is as it was', JSON.parse(fs.readFileSync(file, 'utf8')).items.length === JSON.parse(before).items.length);
  check('an unknown id restores nothing', s.restore('20260101T000000Z-0000') === false);
  check('a removed id cannot be restored twice', s.remove(a.id) && s.restore(a.id) && !s.restore(a.id));
  const n = s.clear();
  check('delete all removes every item', n === 3 && s.list().length === 0);
  check('and the Home counts stay', s.counts().dictations === 3, JSON.stringify(s.counts()));
}

section('the counts Home shows');
{
  fs.rmSync(file, { force: true });
  clock = Date.parse('2026-10-09T12:00:00Z');
  const s = make();
  // 120 words in 30 s of speech: typing at 40 wpm would take 180 s, so 150 s saved (minus the wait).
  s.record({ mode: 'dictate', text: Array(120).fill('word').join(' '), seconds: 30, waitMs: 0 });
  // A revision saves no typing: its words are mostly the span you already had.
  s.record({ mode: 'revise', text: Array(50).fill('word').join(' '), seconds: 3 });
  clock -= 8 * DAY;
  s.record({ mode: 'dictate', text: Array(40).fill('word').join(' '), seconds: 60 });   // slower than typing
  clock += 8 * DAY;
  const c = s.counts();
  check('dictations so far', c.dictations === 3, JSON.stringify(c));
  check('words this week (last 7 days only)', c.weekWords === 170, JSON.stringify(c));
  check('time saved is never negative and skips revisions', c.savedSeconds === 150, JSON.stringify(c));
  check('the assumption travels with the number', c.typingWpm === 40);
  check('days are local days', dayKey(Date.parse('2026-10-09T12:00:00Z')).length === 10);
}

section('files');
{
  fs.rmSync(file, { force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The parked window's v1 file, as it sits on the developer's machine.
  fs.writeFileSync(file, JSON.stringify({ retentionDays: 0, sessions: [
    { at: new Date(clock - DAY).toISOString(), mode: 'dictate', words: 3, seconds: 2, app: 'notepad', text: 'hello there you' }
  ] }));
  const s = make();
  check('a v1 file migrates', s.list().length === 1 && s.list()[0].text === 'hello there you');
  check('to v2, on the new default', JSON.parse(fs.readFileSync(file, 'utf8')).v === 2 && s.keep() === '30d');

  fs.writeFileSync(file, '{"v":2,"keep":"30d","items":[{"text":"good"');   // a torn write
  const t = make();
  check('a damaged file is not fatal', Array.isArray(t.list()));

  fs.rmSync(file, { force: true });
  const u = make();
  for (let i = 0; i < 5010; i++) { clock += 1000; u.record({ text: 'n' + i, seconds: 1 }); }
  check('history is capped at 5,000', u.list().length === 5000 && u.list()[0].text === 'n5009');
  check('no .tmp is left behind', !fs.existsSync(file + '.tmp'));
}

/* --------------------------------------------------------------- dictionary */

section('dictionary round trip (a throwaway dictionary.json)');
{
  check('the bench writes inside its own folder', VOCAB_FILE.startsWith(tmp), VOCAB_FILE);
  const r = dictionary.add('Kaggle', 'cable', 'auto');
  check('add', r && r.created);
  check('the same word, another case, widens rather than duplicates',
    dictionary.add('kaggle', 'kegel', 'auto') && dictionary.load().length === 1 && dictionary.load()[0].heardAs.length === 2);
  const entry = dictionary.load()[0];
  check('remove', dictionary.remove('KAGGLE') && dictionary.load().length === 0);
  check('restore brings back "heard as", source and date',
    dictionary.restore(entry) && JSON.stringify(dictionary.load()[0]) === JSON.stringify(entry));
  // A hand edit between two writes is re-read, never overwritten.
  const list = dictionary.load();
  list.push({ term: 'Aysel', heardAs: ['Ayşe'], source: 'manual', addedAt: '2026-10-01T00:00:00.000Z' });
  fs.writeFileSync(VOCAB_FILE, JSON.stringify(list));
  dictionary.add('Nebius', null, 'manual');
  check('a hand edit survives the next add', dictionary.load().some((e) => e.term === 'Aysel'));
  check('over 64 characters is refused', dictionary.add('x'.repeat(65)) === null);
}

/* ------------------------------------------------------------ search, notes */

section('search forgives how a word is typed');
check('istanbul finds İstanbul', matches('Meeting in İstanbul on Friday', 'istanbul'));
check('ayse finds Ayşe', matches('Tell Ayşe the draft is ready', 'ayse'));
check('ISIK finds ışık', matches('ışık', 'ISIK'));
check('every word must match, in any order', matches('send the draft tonight', 'tonight draft') && !matches('send the draft', 'draft tomorrow'));
check('fold is stable', fold('ÇĞİÖŞÜ çğıöşü') === 'cgiosu cgiosu', fold('ÇĞİÖŞÜ çğıöşü'));

section("What's new never renders live markup");
{
  const html = renderMarkdown('## 0.2\n- <img src=x onerror=alert(1)> **bold**\n- [x](javascript:alert(1))\n<script>alert(2)</script>');
  check('no tag from the text survives', !/<img|<script/i.test(html), html);
  check('its own markup does', /<strong>bold<\/strong>/.test(html) && /<h3>0\.2<\/h3>/.test(html));
  check('only http(s) links become links', !/javascript:/.test(html.replace(/\[x\]\(javascript:alert\(1\)\)/, '')) && !/data-href="javascript/.test(html));
  const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  check('the bundled CHANGELOG.md renders', renderMarkdown(changelog).includes('<li>'));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + (failures ? failures + ' FAILED' : 'all home checks passed') + '\n');
process.exit(failures ? 1 : 0);
