'use strict';

/**
 * Revise guards (src/main/pipeline/guards.js and pipeline/index.js run()): what is never pasted
 * over a selection. Headless, no model.
 *
 *   1. The failures of the user's real revise presses (dictation-research
 *      reports/dogfood_audit_2026-10-16.md: 6 no-ops, the instruction pasted over the text, two
 *      silent deletions), rebuilt on synthetic text, are refused; the presses that worked, and
 *      the ordinary kinds of revision, pass.
 *   2. eval/revise_gold.jsonl (in ../dictation-research, when present): every reference result
 *      passes -- the 12 whose reference is the selection unchanged get the "nothing changed" note,
 *      which leaves the selection as the reference does.
 *   3. Through run() with a fake model: the 'refused' event and its message, the instruction
 *      transcribed only when the result alone cannot decide, the local log (no selection text in
 *      it); selections up to 6,000 characters, an output budget that grows with them, a span
 *      whose tokens do not fit refused up front, and an answer cut off by the budget never pasted.
 *
 *   node bench/revise-guards.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeLlama } = require('./fake-llama');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-guards-'));
process.env.APPDATA = tmp;
process.env.HOME = tmp;
process.env.XDG_CONFIG_HOME = tmp;
process.env.TYPD_GUARD_LOG = path.join(tmp, 'revise-guards.jsonl');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + JSON.stringify(detail).slice(0, 500) : ''));
}
const section = (s) => console.log('\n' + s);

const guards = require('../src/main/pipeline/guards');

/* Synthetic selections in the shape of the user's: whole dictations of 500-700 characters. */
const TRIP =
  "So I've been thinking about the trip next month and honestly I'm not sure we should drive the whole way. " +
  "It's about nine hours each direction, and with the kids in the back that's going to feel like twenty. " +
  'The train is a bit more expensive but we could actually work or sleep on the way, and the station is ten minutes from the hotel. ' +
  'On the other hand, if we drive we have the car there and we can go to the lake on the second day without renting anything. ' +
  "I'm going to bed now, so let's decide tomorrow. I'm going to bed, really. Anyway, I'm going to bed, and we can talk about the budget in the morning.";

const STATUS =
  'This week we applied to the research credits program at the university, we applied to the startup program at the cloud provider, ' +
  'and we sent the form to the regional compute center. We heard back from two of them so far. The first one said maybe next month, ' +
  'the second one gave us a small grant right away, and the third has not answered. My friend also offered his gaming PC with the ' +
  'big graphics card, running day and night, for the long training runs, which would cover most of what we need until the grants land.';

const SHARES =
  'Of the testers, about 40 percent use it every day, 25 percent a few times a week and the rest only tried it once. ' +
  'Most of the daily ones dictate long messages to their coding agents. The weekly ones mostly write emails.';

// The same length, other words: a rewrite the result alone shows to be one.
const FORMAL =
  "I have been considering next month's trip, and I am not certain that we should drive the entire way. " +
  'The journey takes approximately nine hours in each direction, which will feel considerably longer with the children. ' +
  'The train is somewhat more costly, yet it would allow us to work or rest, and the station lies ten minutes from the hotel. ' +
  'Driving, however, would give us the car on arrival, so that we could visit the lake on the second day without renting one. ' +
  'I am retiring for the night, so let us decide tomorrow and discuss the budget in the morning.';

// Thousands of characters of distinct sentences, as a long dictation is.
function longText(chars) {
  const A = ['schedule', 'budget', 'draft', 'review', 'migration', 'rollout', 'survey'];
  const B = ['design', 'data', 'support', 'sales', 'research', 'mobile', 'platform', 'finance', 'legal', 'hiring', 'infra'];
  const C = ['almost done', 'late again', 'on track', 'waiting on approval', 'blocked by a vendor'];
  const D = ['one more pass', 'a second reviewer', 'the new numbers', 'a decision from the leads', 'a test on real users', 'two more days'];
  const E = ['Friday', 'the offsite', 'the end of the month', 'the board meeting', 'the next release', 'the holidays', 'the audit', 'the launch'];
  let out = '', i = 0;
  while (out.length < chars) {
    i++;
    out += `Note ${i}: the ${A[i % 7]} for the ${B[i % 11]} team is ${C[i % 5]} and needs ${D[i % 6]} before ${E[i % 8]}. `;
  }
  return out.slice(0, chars);
}

const words = (s) => s.split(/\s+/);
const LONG = longText(5600);   // ~1,000 words
const firstShare = (s, share) => words(s).slice(0, Math.round(words(s).length * share)).join(' ');

const CASES = [
  // [name, span, instruction, result, want: 'pass' | reason]
  // -- the audit's failures, rebuilt --
  ['"Summarize" returned the selection unchanged (#59)', TRIP, 'Summarize', TRIP, 'noop'],
  ['"Clean this up" twice, unchanged (#36, #37)', STATUS, 'Clean this up.', STATUS, 'noop'],
  ['"Make it simpler": one paragraph break added, nothing else (#27)', TRIP, 'Make it simpler.', TRIP.replace('. On the other hand', '.\n\nOn the other hand'), 'noop'],
  ['"Make it more formalized and understandable": a letter and two marks (#26)', TRIP, 'Make it more formalized and understandable.',
    TRIP.replace('direction,', 'direction?').replace('Anyway,', 'Anyway.').replace('twenty', 'twentye'), 'noop'],
  ['a replacement word over one word, returned unchanged (#23)', 'cook test', 'Smoke test', 'cook test', 'noop'],
  ['the instruction pasted over the selection (#28)', TRIP, "I said I'm going to bed multiple times, get rid of it and keep it once.",
    "I said I'm going to bed multiple times, get rid of it and keep it once.", 'echo'],
  ['"Format the stuff I listed as a list": the last 43 % gone (#40)', STATUS, 'Format the stuff I listed as a list.', firstShare(STATUS, 0.57), 'deleted'],
  ['"format them well": the same cut (#39)', STATUS, 'format them well', firstShare(STATUS, 0.57), 'deleted'],
  ['nothing came back', TRIP, 'Make it shorter.', '   ', 'empty'],
  // -- what worked, and ordinary revisions --
  ['"Clean this up" that did clean it up (#34)', TRIP, 'Clean this up.',
    TRIP.replace('and honestly ', '').replace(' actually', '').replace(" I'm going to bed, really. Anyway, I'm going to bed, and", ' And'), 'pass'],
  ['"Make it more compact" a quarter shorter (#60)', TRIP, 'Make it more compact.',
    "I'm not sure we should drive the whole way next month: it's nine hours each direction, which feels like twenty with the kids. " +
    'The train costs more, but we could work or sleep, and the station is ten minutes from the hotel. Driving means we have the car ' +
    "for the lake on the second day. I'm going to bed now; let's decide tomorrow and talk about the budget in the morning.", 'pass'],
  ['"Write the percentages as a list" (#61)', SHARES, 'Write the percentages as a list.',
    'Of the testers:\n\n- about 40 percent use it every day\n- 25 percent a few times a week\n- the rest only tried it once\n\nMost of the daily ones dictate long messages to their coding agents. The weekly ones mostly write emails.', 'pass'],
  ['"Summarize" to a third', TRIP, 'Summarize',
    "Driving is nine hours each way and hard with the kids; the train costs more but lets us work and is near the hotel; driving gives us the car for the lake. Let's decide tomorrow.", 'pass'],
  ['"fix the typo": one word in 130', TRIP, 'fix the typo', TRIP.replace('twenty', 'twenty-one').replace('expensive', 'expensive'), 'pass'],
  ['"delete the last sentence"', TRIP, 'delete the last sentence', TRIP.slice(0, TRIP.lastIndexOf(' Anyway')), 'pass'],
  ['"make the first line more formal": a few words', TRIP, 'make the first line more formal',
    TRIP.replace("So I've been thinking", 'I have been considering'), 'pass'],
  ['"translate this to English"', 'Yarın sabah toplantıyı iptal edelim, herkes çok yorgun ve rapor da hazır değil.', 'translate this to English',
    "Let's cancel tomorrow morning's meeting; everyone is very tired and the report isn't ready either.", 'pass'],
  ['a sentence dictated over a short selection, replacing it (#8)', 'Lets cook test it.', 'Smoke test', "Let's smoke test it.", 'pass'],
  ['"make it a table": fewer words, the same facts', SHARES, 'make this a table',
    '| testers | use |\n|---|---|\n| 40 % | every day |\n| 25 % | a few times a week |\n| rest | tried it once |', 'pass'],
  ['"bold the second bullet" on plain text: unchanged, the "nothing changed" note', 'Two eggs and some milk.', 'bold the second bullet point', 'Two eggs and some milk.', 'noop'],
  // -- the real model on long selections (results/revise_long_check.log, 2026-10-17), rebuilt --
  ['"clean up the grammar" over ~1,000 words came back as one line (pasted in the first round)', LONG, 'uh can you clean up the grammar',
    'Sure, here is the text with the grammar cleaned up.', 'short'],
  ['"make it casual like a slack message" kept 15 %', TRIP, 'um make it casual like a slack message', firstShare(TRIP, 0.15), 'short'],
  ['"turn this into a bulleted list" kept a third', STATUS, 'turn this into a bulleted list', '- ' + firstShare(STATUS, 0.33), 'short'],
  ['"fix the grammar" kept 35 %', TRIP, 'fix the grammar', firstShare(TRIP, 0.35), 'short'],
  ['"make this a lot shorter" to 15 %: asked for', TRIP, 'um make this a lot shorter', "Driving is nine hours with the kids; the train is pricier but near the hotel.", 'pass'],
  ['"delete everything after the first sentence" to 20 %: asked for', TRIP, 'delete everything after the first sentence', TRIP.slice(0, TRIP.indexOf('.') + 1), 'pass'],
  ['"Summarize" to a tenth: asked for', LONG, 'Summarize', 'Notes on schedules, budgets and reviews across teams, most waiting on approvals or vendors before the next release.', 'pass']
];

function unitTests() {
  section('1. the audit\'s failures and the presses that worked (synthetic text)');
  let caught = 0, wrongly = 0, failuresN = 0, goodN = 0;
  for (const [name, span, instruction, result, want] of CASES) {
    const v = guards.verdict(span, result, instruction);
    const got = v.refuse ? v.reason : 'pass';
    check(`${name}  -> ${got}${v.kind ? ' (' + v.kind + ')' : ''}`, got === want, v);
    if (want !== 'pass' && !(want === 'noop' && span === result && /bold/.test(instruction))) { failuresN++; if (got === want) caught++; }
    if (want === 'pass') { goodN++; if (got !== 'pass') wrongly++; }
  }
  console.log(`  failures refused: ${caught}/${failuresN}; good revisions refused: ${wrongly}/${goodN}`);
  // The result alone settles identity and emptiness; nothing is transcribed for them.
  check('identical or empty: settled without the instruction', guards.check(TRIP, TRIP).verdict === 'refuse' && guards.check(TRIP, '').verdict === 'refuse');
  check('a rewrite of about the same length passes without the instruction (no extra decode)', guards.check(TRIP, FORMAL).verdict === 'pass');
  check('a much shorter one needs the instruction first ("compact" may; "list" may not)', guards.check(TRIP, CASES[10][3]).verdict === 'ask');
  check('without the instruction (it could not be transcribed), a suspicious result is pasted', guards.verdict(STATUS, firstShare(STATUS, 0.57), null).refuse === false);
  check('...but one under 40 % of the selection is not: nothing said it may be that short', guards.verdict(LONG, 'Sure, here it is.', null).reason === 'short');
  check('a sentence or two may shrink under 40 % (revise_gold "make me sound more confident")',
    guards.verdict('Hi, I was just wondering if you could maybe look at my draft at some point?', 'Please review my draft.', 'uh make me sound more confident').refuse === false);
}

function goldSweep() {
  const gold = path.join(__dirname, '..', '..', 'dictation-research', 'eval', 'revise_gold.jsonl');
  section('2. eval/revise_gold.jsonl: every reference passes');
  if (!fs.existsSync(gold)) { console.log('  (skipped: ../dictation-research is not here)'); return; }
  const rows = fs.readFileSync(gold, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const refused = [], unchanged = [];
  for (const g of rows) {
    const v = guards.verdict(g.span, g.result, g.spoken);
    if (!v.refuse) continue;
    if (v.reason === 'noop' && g.result.trim() === g.span.trim()) unchanged.push(g.id);
    else refused.push([g.id, g.kind, v.reason, g.spoken]);
  }
  check(`${rows.length} references: none refused (${unchanged.length} unchanged by design get the "nothing changed" note)`, refused.length === 0, refused);
}

/* ------------------------------------------------------------- 3. through run() */

const instances = [];
function freshPipeline(env) {
  for (const k of ['TYPD_MODEL_DIR', 'TYPD_LLAMA_PORT', 'TYPD_LLAMA_SERVER', 'TYPD_SELFTEST']) delete process.env[k];
  Object.assign(process.env, env);
  for (const m of ['../src/main/pipeline/local', '../src/main/pipeline/index']) delete require.cache[require.resolve(m)];
  const pipeline = require('../src/main/pipeline/index');
  instances.push(require('../src/main/pipeline/local'));
  return pipeline;
}
process.on('exit', () => { for (const l of instances) { try { l.stop(); } catch { /* gone */ } } });

async function events(gen) {
  const out = [];
  try { for await (const e of gen) out.push(e); } catch (err) { out.push({ type: 'error', message: err.message }); }
  return out;
}

async function throughRun() {
  section('3. through run(), with a fake model');
  const dir = path.join(tmp, 'model');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['m.gguf', 'p.gguf']) fs.writeFileSync(path.join(dir, f), 'x');
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ model: 'm.gguf', mmproj: 'p.gguf', context: true, revise: true, prefill: '' }));
  const server = path.join(tmp, 'never-started');
  fs.writeFileSync(server, '');

  let reviseOut = '', instruction = '', finish = 'stop';
  const fake = await fakeLlama({
    tokenChars: 4,
    answer: (req) => /^Revise the highlighted text/.test(req.system)
      ? { text: 'language English<asr_text>' + reviseOut, finish }
      : 'language English<asr_text>' + instruction
  });
  const pipeline = freshPipeline({ TYPD_MODEL_DIR: dir, TYPD_LLAMA_PORT: String(fake.port), TYPD_LLAMA_SERVER: server, TYPD_SELFTEST: '0' });
  const audio = { samples: new Float32Array(16000 * 2).map((_, i) => 0.2 * Math.sin(i / 7)), sampleRate: 16000 };
  const run = (span) => events(pipeline.run({ mode: 'revise', audio, span, signal: null, contextBlock: null }));
  const reqsSince = (n) => fake.requests.slice(n).map((r) => (/^Revise/.test(r.system) ? 'revise' : 'instruction'));

  // Identical: refused at once, no instruction needed.
  reviseOut = STATUS; instruction = 'Clean this up.';
  let n = fake.requests.length;
  let ev = await run('  ' + STATUS + '\n');
  let last = ev[ev.length - 1];
  check('unchanged: a "refused" event, "nothing changed", no paste', last.type === 'refused' && last.reason === 'noop' && last.message === "Couldn't revise that — nothing changed" && !ev.some((e) => e.type === 'done'), last);
  check('unchanged: one request (the result alone decides)', JSON.stringify(reqsSince(n)) === '["revise"]', reqsSince(n));

  // A cut: the instruction is transcribed, then the result refused and offered on the clipboard.
  reviseOut = firstShare(STATUS, 0.57); instruction = 'Format the stuff I listed as a list.';
  n = fake.requests.length;
  ev = await run(STATUS);
  last = ev[ev.length - 1];
  check('a deletion: refused, the result marked for the clipboard, the selection\'s own spaces around it', last.type === 'refused' && last.reason === 'deleted' && last.copy === true && last.text === firstShare(STATUS, 0.57), last);
  check('a deletion: two requests, the revise and the instruction (base model)', JSON.stringify(reqsSince(n)) === '["revise","instruction"]' &&
    !('lora' in fake.requests[fake.requests.length - 1].body), reqsSince(n));

  // The instruction pasted back.
  reviseOut = "I said I'm going to bed multiple times, get rid of it and keep it once."; instruction = reviseOut;
  ev = await run(TRIP);
  last = ev[ev.length - 1];
  check('the instruction came back: refused ("echo"), nothing on the clipboard', last.type === 'refused' && last.reason === 'echo' && last.copy === false, last);

  // A real revision: done, and the instruction never asked for.
  reviseOut = FORMAL; instruction = 'Make it more formal.';
  n = fake.requests.length;
  ev = await run(TRIP);
  last = ev[ev.length - 1];
  check('a real revision: "done" with the text, one request', last.type === 'done' && last.text === FORMAL && reqsSince(n).length === 1, { last, reqs: reqsSince(n) });
  // A real shortening: asked, then pasted.
  reviseOut = CASES[10][3]; instruction = 'Make it more compact.';
  n = fake.requests.length;
  ev = await run(TRIP);
  last = ev[ev.length - 1];
  check('"make it more compact", a quarter shorter: the instruction asked for, then pasted', last.type === 'done' && JSON.stringify(reqsSince(n)) === '["revise","instruction"]', { last, reqs: reqsSince(n) });

  // A typo fixed in a long selection: asked, then passed.
  reviseOut = TRIP.replace('twenty', 'twenty-one'); instruction = 'fix the typo';
  n = fake.requests.length;
  ev = await run(TRIP);
  last = ev[ev.length - 1];
  check('a one-word fix: the instruction asked for, then pasted', last.type === 'done' && JSON.stringify(reqsSince(n)) === '["revise","instruction"]', { last, reqs: reqsSince(n) });

  // The log: one line a refusal, never the selection.
  const log = fs.readFileSync(process.env.TYPD_GUARD_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check(`the local log: ${log.length} lines, one per refusal, reasons and sizes, the instruction when heard`, log.length === 3 &&
    log.map((e) => e.reason).join(',') === 'noop,deleted,echo' && log[1].instruction === 'Format the stuff I listed as a list.' && log[1].spanChars === STATUS.length, log);
  check('the log holds no selection text', !fs.readFileSync(process.env.TYPD_GUARD_LOG, 'utf8').includes('research credits program'));

  section('   longer selections (4,096-token window)');
  // 6,000 characters: accepted; the budget grows with the span, within the window.
  const big = longText(6000);
  reviseOut = big.replace(/ the /g, ' '); instruction = 'Clean this up.';
  n = fake.requests.length;
  ev = await run(big);
  last = ev[ev.length - 1];
  const rq = fake.requests.slice(n).find((r) => /^Revise/.test(r.system));
  const spanTok = 1500, promptTok = spanTok + Math.ceil(13 * 2) + 96, room = 4096 - promptTok - 16;
  const want = Math.min(room, Math.max(1024, Math.round(spanTok * 1.5) + 256));
  check('6,000 characters (~1,000 words): revised', last.type === 'done', last);
  check(`its output budget: the span's tokens and half again plus 256, within what the window has left (${rq && rq.body.max_tokens} = ${want})`,
    rq && rq.body.max_tokens === want && promptTok + rq.body.max_tokens <= 4096, rq && rq.body.max_tokens);
  ev = await run(big + 'x');
  check('6,001 characters: "Too much selected — up to ~1,000 words"', ev[ev.length - 1].message === 'Too much selected — up to ~1,000 words', ev[ev.length - 1]);
  // A span whose tokens do not fit (Turkish or code runs ~3 characters a token or fewer).
  const dense = await fakeLlama({ tokenChars: 1.5, answer: () => 'language English<asr_text>x' });
  const p2 = freshPipeline({ TYPD_MODEL_DIR: dir, TYPD_LLAMA_PORT: String(dense.port), TYPD_LLAMA_SERVER: server, TYPD_SELFTEST: '0' });
  n = dense.requests.length;
  ev = await events(p2.run({ mode: 'revise', audio, span: big, signal: null, contextBlock: null }));
  check('a span of 4,000 tokens: refused up front, nothing sent to the model', ev[ev.length - 1].message === 'Too much selected — up to ~1,000 words' && dense.requests.length === n, ev[ev.length - 1]);
  await dense.close();
  // Cut off by the budget: the end is missing, so it is never pasted.
  const p3 = freshPipeline({ TYPD_MODEL_DIR: dir, TYPD_LLAMA_PORT: String(fake.port), TYPD_LLAMA_SERVER: server, TYPD_SELFTEST: '0' });
  reviseOut = TRIP.slice(0, 300); finish = 'length';
  ev = await events(p3.run({ mode: 'revise', audio, span: TRIP, signal: null, contextBlock: null }));
  last = ev[ev.length - 1];
  check('an answer stopped by the budget ("length"): refused, "Too long to revise"', last.type === 'refused' && last.reason === 'truncated' && last.message === 'Too long to revise — text kept', last);
  finish = 'stop';
  // A long rewrite with a repeated line the selection also repeats is not cut as a loop.
  const repeated = 'Status of the build: not started yet.\n'.repeat(4) + TRIP;
  const cleaned = repeated.replace(TRIP, CASES[9][3]);
  reviseOut = cleaned; instruction = 'Clean this up.';
  ev = await events(p3.run({ mode: 'revise', audio, span: repeated, signal: null, contextBlock: null }));
  last = ev[ev.length - 1];
  check('a line the selection repeats may repeat in the rewrite (not cut as a loop)', last.type === 'done' && last.text === cleaned.trim(), last);
  await fake.close();
}

(async () => {
  unitTests();
  goldSweep();
  await throughRun();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
