'use strict';

/**
 * Long dictations, headless and without a model: where they are cut, how the pieces are joined,
 * and how much is left to write once the key is released (src/main/pipeline/long.js and local.js
 * dictate / openLong).
 *
 *   1. The splitter is causal: fed a recording 256 ms at a time it settles exactly the cuts the
 *      whole recording gives, and settles each by 79 s into its piece.
 *   2. Joins: the failures the dogfood audit found at real cuts (dictation-research
 *      reports/dogfood_audit_2026-10-16.md section 6), written as synthetic text -- the pieces as
 *      the model wrote them, and the seam as it wrote the speech around the cut -- scored for the
 *      0.2.2 join and the new one.
 *   3. A fake model on synthetic speech: every "word" is a tone whose pitch names it, so the fake
 *      llama-server (fake-llama.js) writes exactly the words it was sent, closing a sentence and
 *      capitalising at its edges as the real model does, inventing a word at the end of a piece
 *      cut mid-sentence and dropping the first word of some pieces. Written after release
 *      (0.2.2) and while talking (openLong): the same text, the canonical one; every request one
 *      at a time; after release only the tail; cancel stops everything.
 *
 *   node bench/long.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeLlama } = require('./fake-llama');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-long-'));
process.env.APPDATA = tmp;                 // no dictionary here (pipeline/context.js reads it from APPDATA)
process.env.HOME = tmp;
process.env.XDG_CONFIG_HOME = tmp;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + JSON.stringify(detail).slice(0, 600) : ''));
}
const section = (s) => console.log('\n' + s);

const long = require('../src/main/pipeline/long');
const SR = 16000;

/* ------------------------------------------------------------ synthetic speech */

// Word k is a 0.35 s tone at 150 + 12 (k mod 250) Hz; words are 0.12 s apart, with a pause of
// 0.5-2.0 s after every ninth, so the splitter finds real pauses where speech would have them.
const BURST = 0.35, GAP = 0.12, MOD = 250;
const freq = (k) => 150 + 12 * (k % MOD);

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

function synth(seconds, seed = 7) {
  const r = rng(seed);
  const s = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < s.length; i++) s[i] = 0.002 * (r() * 2 - 1);
  const words = [], ends_ = [];
  let t = 0.4, k = 0;
  while (t + BURST < seconds - 0.3) {
    const a = Math.round(t * SR), n = Math.round(BURST * SR), f = freq(k);
    for (let i = 0; i < n; i++) s[a + i] += 0.3 * Math.sin(2 * Math.PI * f * i / SR) * Math.min(1, i / 80, (n - i) / 80);
    words.push(k);
    ends_.push(a + n);
    t += BURST + (k % 9 === 8 ? 0.5 + 1.5 * r() : GAP);
    k++;
  }
  // A recording ends at the end of a sentence (the model writes no cut-off there to compare).
  let last = words.length - 1;
  while (last > 0 && !ends(words[last] % MOD)) last--;
  for (let i = ends_[last] + 1; i < s.length; i++) s[i] = 0.002 * (r() * 2 - 1);
  return { samples: s, words: words.slice(0, last + 1) };
}

/** The words in a stretch of synthetic speech, by the pitch of each tone. */
function hear(audio) {
  const f = Math.round(0.01 * SR), out = [];
  let runStart = -1;
  const voiced = (j) => {
    let e = 0;
    for (let i = j * f; i < (j + 1) * f && i < audio.length; i++) e += audio[i] * audio[i];
    return e / f > 0.001;
  };
  const frames = Math.floor(audio.length / f);
  for (let j = 0; j <= frames; j++) {
    const v = j < frames && voiced(j);
    if (v && runStart < 0) runStart = j;
    if (!v && runStart >= 0) {
      const a = Math.max(0, runStart * f - f), b = Math.min(audio.length, j * f + f);
      if ((b - a) / SR >= 0.2) {
        // Crossings between +0.05 and -0.05 (the noise never reaches them): two a period.
        let state = 0, first = -1, last = -1, n = 0;
        for (let i = a; i < b; i++) {
          const s = audio[i] > 0.05 ? 1 : audio[i] < -0.05 ? -1 : 0;
          if (s && s !== state) {
            if (state) { n++; if (first < 0) first = i; last = i; }
            state = s;
          }
        }
        if (n > 4) out.push(Math.round(((n - 1) / 2 / ((last - first) / SR) - 150) / 12));
      }
      runStart = -1;
    }
  }
  return out;
}

// The fake model's writing: a sentence ends after word k when k % 7 == 6; the next word has a
// capital. Like the real model, it starts every answer with a capital and ends it with a full stop.
const ends = (k) => k % 7 === 6;
// Words of letters only, as speech is: digits would (rightly) keep the joins from touching them.
const name = (k) => String.fromCharCode(97 + Math.floor(k / 26) % 26) + String.fromCharCode(97 + (k % 26)) + 'o';
function write(ks, { invent = false, dropFirst = false } = {}) {
  if (dropFirst && ks.length > 3) ks = ks.slice(1);
  let out = '';
  ks.forEach((k, i) => {
    const w = (i === 0 || ends(ks[i - 1]) ? 'W' : 'w') + name(k);
    out += (i ? ' ' : '') + w + (ends(k) ? '.' : '');
  });
  if (invent && ks.length && !ends(ks[ks.length - 1])) out += ' high';
  return out.replace(/([^.])$/, '$1.');
}
const canonical = (ks) => write(ks);

function answerFor(quirks) {
  return (req) => {
    const ks = hear(req.audio);
    // A piece (not a seam: seams are ~12 s) cut mid-sentence gets an invented word; every third
    // piece loses its first word, as real pieces lost their opening at a cut.
    const piece = req.seconds > 30;
    const id = ks.length ? ks[0] : 0;
    return write(ks.map((k) => k % MOD), quirks && piece ? { invent: true, dropFirst: id % 3 === 1 } : {});
  };
}

/* ------------------------------------------------------------------ 1. splitter */

function splitterTests() {
  section('1. the splitter: causal, settled early, the same cuts as the whole recording');
  for (const secs of [60, 80, 150, 300, 600]) {
    const { samples } = synth(secs, secs);
    const whole = long.splitLong(samples, SR);
    const sp = new long.Splitter(SR);
    const chunk = Math.round(0.256 * SR);
    const settledAt = [];
    for (let len = chunk; len < samples.length; len += chunk) {
      for (const c of sp.feed(samples, len)) settledAt.push({ c, len });
    }
    sp.feed(samples, samples.length, true);
    check(`${secs} s: ${whole.pauses.length} cuts; fed 256 ms at a time, the same cuts and seams`, JSON.stringify(sp.cuts) === JSON.stringify(whole.pauses));
    if (whole.pauses.length) {
      const late = settledAt.filter(({ c, len }) => len - c.start > (long.PIECE_MAX_S + long.LOOKAHEAD_S) * SR + chunk);
      check(`${secs} s: every cut settled within 79 s of its piece's start (${settledAt.length} of ${whole.pauses.length} before the end)`, late.length === 0, late.length);
      check(`${secs} s: pieces 45-70 s, each cut in a pause`, whole.pauses.every((c) => (c.end - c.start) / SR >= 44.9 && (c.end - c.start) / SR <= 70.4 && c.to - c.from >= 0.06 * SR));
    }
  }
}

/* --------------------------------------------------------------------- 2. joins */

// Each: the text so far (a), the next piece (b), the seam's text, where the cut falls in the seam
// (0-1), and what the join should read. Synthetic sentences in the shape of the audit's cases.
const JOINS = [
  { name: 'invented completion ("extremely high. Crucial")',
    a: 'We finally have the power, so we should make the quality of what we do with it extremely high.',
    b: 'Crucial and the most important thing for the next month.',
    seam: 'the quality of what we do with it extremely crucial and the most important thing for',
    at: 0.55, want: 'with it extremely crucial and the most important thing for the next month.' },
  { name: 'repeated word ("mistaken. ¶ Mistaken")',
    a: 'The credits are still pending, and if I\'m not mistaken.',
    b: 'Mistaken, the vendor hasn\'t given the developer credits yet.',
    seam: 'still pending, and if I\'m not mistaken, the vendor hasn\'t given the developer',
    at: 0.5, want: 'if I\'m not mistaken, the vendor hasn\'t given the developer credits yet.' },
  { name: 'garbled ("is astronomical. is relatively")',
    a: 'But the thing is, the amount of compute we have is astronomical.',
    b: 'is relatively not high compared to the big labs.',
    seam: 'the thing is, the amount of compute we have, astronomical, is relatively not high compared',
    at: 0.55, want: 'the amount of compute we have, astronomical, is relatively not high compared to the big labs.' },
  { name: 'opening of a piece dropped ("I can, but")',
    a: 'So that is the plan for the coming month.',
    b: 'but it will take a while to set up the cluster.',
    seam: 'the plan for the coming month. Am I going to do that? I can, but it will take a while to set',
    at: 0.4, want: 'the coming month. Am I going to do that? I can, but it will take a while to set up the cluster.' },
  { name: 'sentence across the cut ("their AI ‖ quota")',
    a: 'They already used their AI.', b: 'Quota, and I wanted to ask about it.',
    seam: 'they already used their AI quota, and I wanted to ask', at: 0.5,
    want: 'They already used their AI quota, and I wanted to ask about it.' },
  { name: 'sentence ends at the cut: new paragraph',
    a: 'That is the whole plan for today.', b: 'Tomorrow we look at the numbers again.',
    seam: 'the whole plan for today. Tomorrow we look at the numbers', at: 0.5,
    want: 'That is the whole plan for today.\n\nTomorrow we look at the numbers again.' },
  { name: 'missing full stop ("R&D That"), seam reworded',
    a: 'Right now we are basically doing R&D', b: 'That might not be the best option for us.',
    seam: 'we\'re basically doing R&D. And that might not be the best option', at: 0.45,
    want: 'basically doing R&D. That might not be the best option for us.' },
  { name: 'capital mid-sentence ("should not Overuse"), seam reworded',
    a: 'I think that we should not', b: 'Overuse them for this kind of work.',
    seam: 'I think we should not overuse them for this kind', at: 0.5,
    want: 'I think that we should not overuse them for this kind of work.' },
  { name: 'capital mid-sentence ("on The weekend"), no seam',
    a: 'We could run the whole thing on', b: 'The weekend if that works for you.', seam: '', at: 0.5,
    want: 'We could run the whole thing on the weekend if that works for you.' },
  { name: 'capital mid-sentence ("go ahead and Try"), no seam',
    a: 'You can go ahead and', b: 'Try the new build tonight.', seam: '', at: 0.5,
    want: 'You can go ahead and try the new build tonight.' },
  { name: 'missing full stop ("is incredible What"), no seam',
    a: 'Honestly the speed of it is incredible', b: 'What do we do with all of it?', seam: '', at: 0.5,
    want: 'Honestly the speed of it is incredible. What do we do with all of it?' },
  { name: 'lower case after a full stop ("early? with"), no seam',
    a: 'Is it too early?', b: 'with this raw data we cannot really tell.', seam: '', at: 0.5,
    want: 'Is it too early? With this raw data we cannot really tell.' },
  { name: 'a name after "to" keeps its capital, no seam',
    a: 'I will send the notebook to', b: 'Kaggle tomorrow morning.', seam: '', at: 0.5,
    want: 'I will send the notebook to Kaggle tomorrow morning.' },
  { name: 'a name after a verb is not a sentence start, no seam',
    a: 'Before we ship it we should ask', b: 'Kerem about the installer.', seam: '', at: 0.5,
    want: 'Before we ship it we should ask Kerem about the installer.' },
  { name: 'a weekday after "on" keeps its capital, no seam',
    a: 'Let\'s meet on', b: 'Monday after lunch.', seam: '', at: 0.5,
    want: 'Let\'s meet on Monday after lunch.' },
  { name: 'an amount is never rewritten by the seam',
    a: 'The price is 300 dollars per month', b: 'And that is too much for us right now.',
    seam: 'the price is $300 a month, and that is too much for us', at: 0.5,
    want: 'The price is 300 dollars per month and that is too much for us right now.' },
  { name: 'a list item is left alone',
    a: 'Three things:\n\n- Offline mode\n- Export to Docs', b: 'Keyboard shortcuts for everything.',
    seam: 'export to docs, keyboard shortcuts for everything', at: 0.5,
    wantIncludes: ['- Export to Docs\n', '\nKeyboard shortcuts for everything.'] }
];

function joinTests() {
  section('2. joins: the audit\'s failure shapes, synthetic text');
  let oldOk = 0, newOk = 0;
  for (const j of JOINS) {
    const got = long.stitch(j.a, j.b, j.seam, j.at);
    const old = long.joinPieces(j.a, j.b, j.seam ? long.readSeam(j.a, j.seam, j.at) : null);
    const good = (t) => (j.want ? t.endsWith(j.want) : j.wantIncludes.every((w) => t.includes(w)));
    if (good(old)) oldOk++;
    if (good(got.text)) newOk++;
    check(j.name + '  [' + got.how + ']', good(got.text), { got: got.text.slice(-140), want: j.want });
  }
  console.log(`  joins right: 0.2.2 ${oldOk}/${JOINS.length}, now ${newOk}/${JOINS.length}`);
  check('every audit failure shape fixed, and nothing 0.2.2 got right lost', newOk === JOINS.length);
}

/* ------------------------------------------------ 3. a fake model, end to end */

const instances = [];
function freshLocal(env) {
  for (const k of ['TYPD_MODEL_DIR', 'TYPD_LLAMA_PORT', 'TYPD_LLAMA_SERVER', 'TYPD_SELFTEST']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../src/main/pipeline/local')];
  const local = require('../src/main/pipeline/local');
  instances.push(local);
  return local;
}
process.on('exit', () => { for (const l of instances) { try { l.stop(); } catch { /* gone */ } } });

function modelDir() {
  const dir = path.join(tmp, 'model');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['m.gguf', 'p.gguf']) fs.writeFileSync(path.join(dir, f), 'x');
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ model: 'm.gguf', mmproj: 'p.gguf', context: true, revise: true, stream: false, prefill: '' }));
  const server = path.join(tmp, 'llama-server-never-started');
  fs.writeFileSync(server, '');
  return { dir, server };
}

async function collect(gen) { let t = ''; for await (const x of gen) t = x; return t; }
function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return { at: i, got: a.slice(Math.max(0, i - 60), i + 80), want: b.slice(Math.max(0, i - 60), i + 80) };
}
const flat = (t) => t.replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function endToEnd() {
  section('3. a fake model on synthetic speech: written after release vs while talking');
  const { dir, server } = modelDir();
  const MS = 3;   // fake decode time per audio second (the 3050 Ti's 1.7B takes ~34)
  const fake = await fakeLlama({ answer: answerFor(true), msPerAudioSecond: MS });
  const local = freshLocal({ TYPD_MODEL_DIR: dir, TYPD_LLAMA_PORT: String(fake.port), TYPD_LLAMA_SERVER: server, TYPD_SELFTEST: '0' });
  await local.warm();

  for (const secs of [70, 160, 330, 600]) {
    const { samples, words } = synth(secs, secs + 1);
    const want = canonical(words.map((k) => k % MOD));

    // 0.2.2's way: everything after release.
    let n0 = fake.requests.length;
    let t0 = Date.now();
    const after = await collect(local.dictate(samples, SR, null, 'ctx', 1024));
    const afterMs = Date.now() - t0;
    const afterReqs = fake.requests.slice(n0);
    const afterAudio = afterReqs.reduce((s, r) => s + r.seconds, 0);

    // While talking: chunks as the overlay sends them, then release.
    n0 = fake.requests.length;
    const ctrl = new AbortController();
    const st = local.openLong(ctrl.signal, () => 'ctx');
    const chunk = Math.round(0.256 * SR);
    for (let at = 0; at < samples.length; at += chunk) st.push(samples.slice(at, Math.min(samples.length, at + chunk)));
    // Let the early requests finish, as they would while the user went on talking.
    for (let i = 0; i < 400 && st.timings.some((t) => t.ms === null); i++) await sleep(10);
    const released = fake.requests.length;
    t0 = Date.now();
    const early = await collect(st.finish(samples, SR, ctrl.signal, 'ctx', 1024));
    const earlyMs = Date.now() - t0;
    const tail = fake.requests.slice(released);
    const tailAudio = tail.reduce((s, r) => s + r.seconds, 0);
    const pieces = st.timings.filter((t) => t.kind === 'piece').length;

    check(`${secs} s: the text is the canonical one, after release (${afterReqs.length} requests)`, flat(after) === want, firstDiff(flat(after), want));
    check(`${secs} s: while talking, the same text`, early === after, { early: early.slice(0, 200), after: after.slice(0, 200) });
    if (secs > 79) {
      check(`${secs} s: ${pieces} pieces and their seams written while talking; after release ${tail.length} requests, ${tailAudio.toFixed(0)} s of audio (0.2.2: ${afterAudio.toFixed(0)} s)`,
        pieces >= 1 && tail.length <= 3 && tailAudio <= 79 + 13, tail.map((r) => r.seconds.toFixed(1)));
      check(`${secs} s: no audio written twice`, fake.requests.length - n0 === afterReqs.length, { early: fake.requests.length - n0, after: afterReqs.length });
      console.log(`        release -> text: ${afterMs} ms after release (0.2.2) vs ${earlyMs} ms (fake model at ${MS} ms per audio second)`);
    } else {
      check(`${secs} s: short, nothing written early`, st.timings.length === 0 && tail.length === 1);
    }
  }
  check('never two requests on the server at once', fake.maxInFlight === 1, fake.maxInFlight);

  // Cancel while early requests are queued: nothing more is sent, nothing is thrown.
  {
    const slow = await fakeLlama({ answer: answerFor(false), msPerAudioSecond: 20 });
    const l2 = freshLocal({ TYPD_MODEL_DIR: dir, TYPD_LLAMA_PORT: String(slow.port), TYPD_LLAMA_SERVER: server, TYPD_SELFTEST: '0' });
    await l2.warm();
    const { samples } = synth(330, 5);
    const ctrl = new AbortController();
    const st = l2.openLong(ctrl.signal, () => 'ctx');
    let rejected = false;
    const onRej = () => { rejected = true; };
    process.on('unhandledRejection', onRej);
    for (let at = 0; at < samples.length; at += 4096) st.push(samples.slice(at, at + 4096));
    await sleep(150);
    const sent = slow.requests.length;
    ctrl.abort();
    await sleep(1500);
    check(`cancel: the request in flight stops and none follows (${sent} sent before, ${slow.requests.length - sent} after)`, slow.requests.length === sent && sent >= 1, { sent, after: slow.requests.length });
    st.push(new Float32Array(16000));
    check('cancel: no unhandled rejection; a push after it does nothing', !rejected && slow.requests.length === sent);
    process.off('unhandledRejection', onRej);
    await slow.close();
  }

  // The capture differs from the chunks (a revise press that turned into dictation, say): all of
  // it is written after release, nothing early is used.
  {
    const { samples, words } = synth(200, 9);
    const st = local.openLong(null, () => 'ctx');
    const other = synth(200, 10).samples;
    for (let at = 0; at < other.length; at += 4096) st.push(other.slice(at, at + 4096));
    const text = await collect(st.finish(samples, SR, null, 'ctx', 1024));
    check('the chunks are not this capture: written again from the capture', flat(text) === canonical(words.map((k) => k % MOD)));
  }
  // The prompt changed after the early pieces (a late screen read): they are written again.
  {
    const { samples } = synth(200, 11);
    const n0 = fake.requests.length;
    const st = local.openLong(null, () => 'early prompt');
    for (let at = 0; at < samples.length; at += 4096) st.push(samples.slice(at, at + 4096));
    await collect(st.finish(samples, SR, null, 'ctx', 1024));
    const prompts = fake.requests.slice(n0).map((r) => r.system);
    const firstLate = prompts.indexOf('ctx');
    check('another prompt at release: nothing written with the early one is used', firstLate >= 1 && prompts.slice(firstLate).every((p) => p === 'ctx') &&
      prompts.slice(firstLate).length >= 3, prompts);
  }

  // The quirks are what the joins fix: the same dictation joined the 0.2.2 way loses words or
  // keeps invented ones.
  {
    const { samples, words } = synth(330, 12);
    const pieces = [], seams = [];
    await collect(local.dictate(samples, SR, null, 'ctx', 1024, { hooks: { piece: (i, t) => { pieces[i] = t; }, seam: (i, t, c) => { seams[i] = { t, at: long.seamAt(c) }; } } }));
    let old = pieces[0];
    for (let i = 1; i < pieces.length; i++) old = long.joinPieces(old, pieces[i], long.readSeam(old, seams[i - 1].t, seams[i - 1].at));
    const want = canonical(words.map((k) => k % MOD));
    // Word edits (inserted, dropped or changed words, case and punctuation included) from the canonical text.
    const wrong = (t) => {
      const a = flat(t).split(' '), b = want.split(' ');
      let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
      for (let i = 1; i <= a.length; i++) {
        const row = [i];
        for (let j = 1; j <= b.length; j++) row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], row[j - 1]);
        prev = row;
      }
      return prev[b.length];
    };
    console.log(`        ${pieces.length - 1} cuts joined the 0.2.2 way: ${wrong(old)} word edits from the canonical text; now: 0`);
    check('the 0.2.2 join of the same pieces is wrong where the new one is right (the bench can tell)', wrong(old) > 0);
  }
  await fake.close();
}

(async () => {
  splitterTests();
  joinTests();
  await endToEnd();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
