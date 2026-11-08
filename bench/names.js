'use strict';

/**
 * Names learned without a dictionary (src/main/names.js): what is a candidate, what counts as said,
 * what reaches the prompt line, and what never does.
 *
 * The shapes are the founder's own (dictation-research reports/names_learning_2026-10-31.md): names
 * on his screens, the ways the model wrote them, and the junk the first replays learned before the
 * guards ("PMMehmet", "Lightning AIYou", "Typed", "Benchmarks", "pesyan.ai"). No Electron, no model.
 *
 *   node bench/names.js
 */

const names = require('../src/main/names');
const { vocabularyLine } = require('../src/main/pipeline/context');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
}
const terms = (text) => names.candidates(text).map((c) => c.term);

console.log('\ncandidates');
{
  const t = terms('Hey Aysel, we ran it on Kaggle and Colab. Compare with Wispr Flow and Lightning AI. ' +
    'Visit mehmetdedeler.com or Hessian.AI for the TPU and VRAM. OpenWhispr, SuperWhisper, OpenAI, ChatGPT.');
  for (const want of ['Aysel', 'Kaggle', 'Colab', 'Wispr Flow', 'Lightning AI', 'mehmetdedeler.com', 'Hessian.AI', 'TPU', 'VRAM', 'OpenWhispr', 'SuperWhisper', 'OpenAI', 'ChatGPT']) {
    check('finds ' + want, t.includes(want), t);
  }
  check('not "Hey Aysel"', !t.includes('Hey Aysel'));
  const junk = terms('Email bob@example.com or see https://x.com/AbhinavXJ/status/2113 PMMehmet AICompute hoursI ' +
    'Lightning AIYou FlowFlow a file named after.sh, The Model is good, POST KEY OK AI API and Wispr Flow The end.');
  for (const bad of ['bob', 'example.com', 'AbhinavXJ', 'x.com', 'PMMehmet', 'AICompute', 'hoursI', 'AIYou', 'Lightning AIYou', 'FlowFlow', 'after.sh', 'Model', 'POST', 'KEY', 'OK', 'API', 'Wispr Flow The']) {
    check('never ' + bad, !t.includes(bad) && !junk.includes(bad), junk);
  }
  check('window title without the app name', names.titleParts('OverDsh (DM) - Hack Club - Slack — Zen Browser') === 'OverDsh (DM)\nHack Club\nSlack');
}

console.log('\nsaid');
{
  const s = (text, term, kind) => (names.said(text, term, undefined, kind) || { how: null }).how;
  check('"Pescian.AI" is Hessian.AI misheard', s('the Pescian.AI application', 'Hessian.AI', 'web') === 'alike');
  check('"whisper flow" is Wispr Flow misheard', s('better than whisper flow', 'Wispr Flow', 'phrase') === 'alike');
  check('"Tari" is Tauri misheard', s('a Tari app', 'Tauri', 'title') === 'alike');
  check('"Kajal" is Kajol misheard', s('Kajal replied', 'Kajol', 'title') === 'alike');
  check('"model" is not Modal', s('the model is ready', 'Modal', 'title') === null);
  check('"cable" is not Kaggle', s('on cable', 'Kaggle', 'title') === null);
  check('"Kerem" is not Mehmet', s('ask Kerem', 'Mehmet', 'title') === null);
  check('"Persian" is not Hessian.AI', s('the Persian cat', 'Hessian.AI', 'web') === null);
  check('"dictation" is the word, against Dictation', s('we did dictation', 'Dictation', 'title') === 'plain');
  check('"Dictation" at a sentence start says nothing', s('Dictation is hard.', 'Dictation', 'title') === null);
  check('"SuperWhisper" spelled another way still counts', s('I use SuperWhisper too', 'Superwhisper', 'title') === 'exact');
}

console.log('\nthe store');
{
  const st = names.createStore(null);
  const t0 = Date.parse('2026-10-20T10:00:00Z');
  const day = 8.64e7;
  // seen in others' text, then said (misheard) by the user
  st.observe({ process: 'claude', title: 'Claude', text: 'The hessian.AI team approved the request. Kaggle quota is 30 hours.' }, t0);
  st.observe({ process: 'claude', title: 'Claude', text: 'Ask Hessian.AI about the A100 nodes. The Hessian.AI portal is up.' }, t0 + 1000);
  check('nothing promoted before it is said', st.promoted({ now: t0 + 2000 }).length === 0, st.promoted({ now: t0 + 2000 }));
  st.heard('Did Pescian.AI answer yet?', 'claude', t0 + 3000, '');
  const p = st.promoted({ now: t0 + 4000 }).map((x) => x.term);
  check('said as a sound-alike: promoted', p.includes('Hessian.AI'), p);
  check('the capitalised spelling wins', p.includes('Hessian.AI') && !p.includes('hessian.AI'), p);
  check('heard as recorded', st.data.terms['hessian.ai'].heardAs.includes('Pescian.AI'));
  check('Kaggle seen but never said: not promoted', !p.includes('Kaggle'), p);
  // on the screen now: already in the prompt
  // on the screen now: the likeliest to be said now, so first in the line (not left out)
  st.observe({ process: 'claude', title: 'Claude', text: 'Kaggle has 30 hours and Kaggle is free.' }, t0 + 4100);
  st.heard('We are on Kaggle.', 'claude', t0 + 4200, '');
  const onScr = st.promoted({ screen: 'The Hessian.AI portal is open', now: t0 + 5000 }).map((x) => x.term);
  check('on the screen now: first', onScr[0] === 'Hessian.AI' && onScr.includes('Kaggle'), onScr);
  const offScr = st.promoted({ screen: 'Kaggle quota', now: t0 + 5000 }).map((x) => x.term);
  check('the other one first when it is the one on the screen', offScr[0] === 'Kaggle' && offScr.includes('Hessian.AI'), offScr);
  const onAt = (screen) => st.promoted({ screen, now: t0 + 5000 }).find((x) => x.term === 'Kaggle').onScreen;
  check('on the screen means as a word ("Kaggle’s" yes, "Kagglet" no)', onAt("Kaggle's quota") === true && onAt('Kagglet quota') === false);
  // Typd's own words are never a source
  st.heard('The people who approve the pesyan.ai application are on sick leave.', 'claude', t0 + 6000, '');
  st.observe({ process: 'claude', title: 'Claude', text: 'You said: The people who approve the pesyan.ai application are on sick leave. Sorry to hear.' }, t0 + 7000);
  check('a name only in Typd\'s own pasted text is not learned', !st.data.terms['pesyan.ai'], Object.keys(st.data.terms));
  // an ordinary word in capitals is not a name the user says
  st.observe({ process: 'zen', title: 'Benchmarks — Zen Browser', text: 'Open Benchmarks and Datasets here. See Benchmarks.' }, t0 + 8000);
  st.heard('I looked at the benchmarks and the benchmark numbers.', 'zen', t0 + 9000, '');
  check('"Benchmarks" said as an ordinary word: not promoted', !st.promoted({ now: t0 + 10000 }).some((x) => x.term === 'Benchmarks'));
  // typed by the user: promoted at once; lowercase only: needs a second sign
  st.typed('FlowRate', 'flow rate', { at: t0 + 11000 });
  st.typed('diline', "Gelin'e", { weak: true, at: t0 + 12000 });
  const q = st.promoted({ now: t0 + 13000 }).map((x) => x.term);
  check('typed: promoted', q.includes('FlowRate'), q);
  check('lowercase typed once: not yet', !q.includes('diline'), q);
  // removed by the user: never back
  st.block('FlowRate');
  st.observe({ process: 'claude', title: 'Claude', text: 'We renamed it FlowRate yesterday, and FlowRate is live.' }, t0 + 14000);
  st.heard('Is FlowRate live?', 'claude', t0 + 15000, '');
  check('blocked: never learned back', !st.promoted({ now: t0 + 16000 }).some((x) => x.term === 'FlowRate'));
  // recency: said long ago ranks below said today
  st.observe({ process: 'claude', title: 'Claude', text: 'This month Colab is cheaper than Lightning AI.' }, t0);
  st.heard('Is Kolab cheaper?', 'claude', t0, '');
  st.observe({ process: 'claude', title: 'Claude', text: 'Apps built with Tauri are smaller.' }, t0 + 30 * day);
  st.heard('we use Tari now', 'claude', t0 + 30 * day, '');
  const r = st.promoted({ now: t0 + 30 * day }).map((x) => x.term);
  check('recently said ranks first', r.indexOf('Tauri') >= 0 && r.indexOf('Tauri') < r.indexOf('Colab'), r);
}

console.log('\nthe line');
{
  check('dictionary first, then learned names that fit', vocabularyLine(['Typd', 'Aysel'], ['Kaggle', 'Typd', 'Hessian.AI']) === 'Typd, Aysel, Kaggle, Hessian.AI');
  const long = Array.from({ length: 80 }, (_, i) => 'Name' + String.fromCharCode(65 + (i % 26)) + i);
  const line = vocabularyLine(['Aysel'], long);
  check('never over 400 characters', line.length <= 400, line.length);
  check('the user\'s own term is always in', line.startsWith('Aysel, '));
  // the real line (context.vocabulary): the user's terms, then at most MAX_LEARNED learned names
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-names-'));
  fs.mkdirSync(path.join(tmp, 'typd'));
  fs.writeFileSync(path.join(tmp, 'typd', 'dictionary.json'), JSON.stringify([{ term: 'Aysel' }, { term: 'Kajol' }]));
  const st = names.createStore(path.join(tmp, 'typd', 'names.json'));
  for (let i = 0; i < 30; i++) st.typed('Nom' + String.fromCharCode(65 + i % 26) + 'x' + i, null, { at: Date.now() - i * 1000 });
  st.flush();
  const out = require('child_process').execFileSync(process.execPath, ['-e',
    "const c = require(process.argv[1]); process.stdout.write(c.vocabulary({ process: 'x', text: '' }) + '|' + c.MAX_LEARNED)",
    path.join(__dirname, '../src/main/pipeline/context.js')], { env: { ...process.env, APPDATA: tmp, XDG_CONFIG_HOME: tmp } }).toString();
  const [real, max] = out.split('|');
  const parts = real.split(', ');
  check('his own terms first, then at most ' + max + ' learned names', parts[0] === 'Aysel' && parts[1] === 'Kajol' && parts.length === 2 + Number(max), parts.length);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('a whole dictation that is a recorded mishearing');
{
  const { wholeTerm } = require('../src/main/pipeline');
  const dict = [{ term: 'Typd', heardAs: ['typed', 'type'] }, { term: 'Kaggle', heardAs: [] }, { term: 'Aysel' },
    { term: 'Sol', heardAs: ['soul'] }, { term: 'Soul', heardAs: ['soul'] }];
  check('"Typed." -> Typd', wholeTerm('Typed.', dict) === 'Typd');
  check('"typed" -> Typd', wholeTerm(' typed ', dict) === 'Typd');
  check('"Type!" -> Typd', wholeTerm('Type!', dict) === 'Typd');
  check('inside a sentence it stays the ordinary word', wholeTerm('uniquely typed.', dict) === null);
  check('a word no entry records stays', wholeTerm('Done.', dict) === null);
  check('a mishearing two entries claim is left alone', wholeTerm('Soul.', dict) === null);
  check('no dictionary, nothing', wholeTerm('Typed.', []) === null && wholeTerm('Typed.', null) === null && wholeTerm('', dict) === null);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
