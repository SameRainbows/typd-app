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
 *      at a time; after release only the tail; cancel stops everything. (45-70 s pieces: low-memory
 *      mode's path, with its own sizes, and TYPD_TALK=0's.)
 *   4. Work while you talk (0.2.10), the full model: dictations under 20 s untouched (nothing sent
 *      while talking, then the very request dictate() makes); longer ones written in steps while
 *      talking, each continuing the last answer less its last 3 words, and on release one request
 *      for the whole recording (past 79 s: its last piece) continuing the last step -- the text is
 *      dictate()'s; a changed prompt or capture uses nothing early; a step in flight at release is
 *      waited for or dropped, the text the same; cancel stops it; low-memory mode and TYPD_TALK=0
 *      unchanged. The fake model continues a prefilled answer as the real one does.
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
    // The seam heard the "And" the piece dropped as an opener: it comes back, from the seam.
    want: 'basically doing R&D. And that might not be the best option for us.' },
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
  // From the first real replay (2026-10-17): what the stitching must not do.
  { name: 'a short seam that skipped words never takes them out of the pieces',
    a: 'When the connection is good, it should check whether it should refresh its model.',
    b: 'What I mean is, keep the old model for now, but look for a newer one.',
    seam: 'Good connection or something. It should keep the old model.', at: 0.58,
    wantIncludes: ['refresh its model', 'What I mean is'] },
  { name: 'a piece\'s own word the seam wrote a little otherwise stays ("looked" / "look")',
    a: 'Can you believe how odd that is?', b: 'I looked through the whole list again and found two.',
    seam: 'how odd that is? I look through the whole list again', at: 0.5,
    wantIncludes: ['how odd that is?', 'I looked through the whole list again and found two.'], wantNot: ['I look through'] },
  { name: 'a question the piece ended on stays, though the seam wrote a comma',
    a: 'So should we launch this early?', b: 'With this rough a product, we learn faster.',
    seam: 'should we launch this early, with this rough a product', at: 0.5,
    want: 'So should we launch this early? With this rough a product, we learn faster.' },
  { name: 'a restart the pieces left out is not put back ("I\'m not, and")',
    a: 'They should look into it.', b: 'If you think that is enough, we can stop.',
    seam: 'should look into it. I\'m not, and if you think that is enough', at: 0.45,
    wantIncludes: ['look into it.', 'If you think that is enough'], wantNot: ["I'm not"] },
  { name: 'a piece begun in lower case runs on after the cut\'s full stop, no seam',
    a: 'The compute we have is astronomical.', b: 'is still not much next to the big labs.', seam: '', at: 0.5,
    want: 'The compute we have is astronomical is still not much next to the big labs.' },
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
    const good = (t) => (j.want ? t.endsWith(j.want) : j.wantIncludes.every((w) => t.includes(w))) && !(j.wantNot || []).some((w) => t.includes(w));
    if (good(old)) oldOk++;
    if (good(got.text)) newOk++;
    check(j.name + '  [' + got.how + ']', good(got.text), { got: got.text.slice(-140), want: j.want });
  }
  console.log(`  joins right: 0.2.2 ${oldOk}/${JOINS.length}, now ${newOk}/${JOINS.length}`);
  check('every audit failure shape fixed, and nothing 0.2.2 got right lost', newOk === JOINS.length);

  // A join never writes a word of its own: every word comes from one of the pieces or the seam.
  // 3,000 random joins: a sentence cut somewhere, each piece's edge damaged as the model damages
  // it (a word invented, dropped, doubled, re-cased, a full stop added), the seam reworded.
  const bag = (t) => new Set((String(t).match(/[\p{L}\p{N}]+/gu) || []).map((w) => w.toLowerCase()));
  const r = rng(99);
  const vocabWords = ('we the a and of to it is that model data compute power quality really should could ' +
    'month week Kaggle Typd release crucial extremely high mistaken AMD credits upload optional PDF think').split(' ');
  const pick = () => vocabWords[Math.floor(r() * vocabWords.length)];
  let own = 0, cases = 0;
  for (let n = 0; n < 3000; n++) {
    const words = Array.from({ length: 30 + Math.floor(r() * 20) }, pick);
    const cut = 10 + Math.floor(r() * 10);
    let A = words.slice(0, cut), B = words.slice(cut);
    if (r() < 0.3) A = A.concat(pick());                    // invented completion
    if (r() < 0.3) B = B.slice(1 + Math.floor(r() * 3));   // dropped opening
    if (r() < 0.2) B = [A[A.length - 1]].concat(B);         // doubled word
    let S = words.slice(Math.max(0, cut - 8), cut + 8);
    if (r() < 0.3) S.splice(Math.floor(r() * S.length), 1, pick());   // the seam words it otherwise
    if (r() < 0.2) S.splice(Math.floor(r() * S.length), 0, 'um');
    const a = A.join(' ') + (r() < 0.6 ? '.' : ''), b = B[0][0].toUpperCase() + B.join(' ').slice(1) + '.';
    const seam = S.join(r() < 0.5 ? ' ' : ', ');
    const got = long.stitch(a, b, seam, r());
    const allowed = new Set([...bag(a), ...bag(b), ...bag(seam)]);
    own += [...bag(got.text)].filter((w) => !allowed.has(w)).length;
    cases++;
  }
  check(`no word of its own in ${cases} random joins (every word from a piece or the seam)`, own === 0, own);
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
  section('3. a fake model on synthetic speech: written after release vs while talking (45-70 s pieces: low-memory mode\'s path, TYPD_TALK=0)');
  // The 45-70 s path, as low-memory mode (with its own sizes) and TYPD_TALK=0 run it; section 4 is the full model's.
  process.env.TYPD_TALK = '0';
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
    check(`${secs} s: while talking, the same text`, early === after, firstDiff(flat(early), flat(after)));
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
  delete process.env.TYPD_TALK;
}


/* --------------------------------------------- 4. work while you talk (0.2.10, the full model) */

// The fake model continuing a prefilled answer, as the real one does: the prefill comes back, then
// what follows its last word in the text the audio gives.
function continuing(answer) {
  return (req) => {
    let out = answer(req);
    if (typeof out !== 'string') out = out.text;
    const pre = req.assistant;
    if (!pre) return out;
    const pw = pre.trim().split(/\s+/), ow = out.split(' ');
    const bare = (w) => w.toLowerCase().replace(/[^a-z]/g, '');
    const last = bare(pw[pw.length - 1]);
    let idx = -1;
    ow.forEach((w, i) => { if (bare(w) === last && (idx < 0 || Math.abs(i - pw.length + 1) < Math.abs(idx - pw.length + 1))) idx = i; });
    if (idx < 0) return pre + ' ' + out;   // nothing to continue: shows up as a wrong text
    const rest = ow.slice(idx + 1).join(' ');
    return pre + ow[idx].slice(pw[pw.length - 1].length) + (rest ? ' ' + rest : '');
  };
}
// What a request looks like but for its audio: model, prompt, budget, flags, prefill.
const shape = (r) => JSON.stringify({ ...r.body, messages: r.body.messages.map((m) => (m.role === 'user' ? { role: 'user', audio: m.content.length } : m)) });

async function talkTests() {
  section('4. work while you talk: the full model writes the dictation from 20 s on, then continues it on release (fake model)');
  const { dir, server } = modelDir();
  const fake = await fakeLlama({ answer: continuing(answerFor(true)), msPerAudioSecond: 3 });
  const local = freshLocal({ TYPD_MODEL_DIR: dir, TYPD_LLAMA_PORT: String(fake.port), TYPD_LLAMA_SERVER: server, TYPD_SELFTEST: '0' });
  await local.warm();
  const chunk = Math.round(0.256 * SR);
  // As the overlay sends the audio, with a fast GPU: each chunk, then whatever it started.
  const talkThrough = async (st, samples) => {
    for (let at = 0; at < samples.length; at += chunk) {
      st.push(samples.slice(at, Math.min(samples.length, at + chunk)));
      for (let i = 0; i < 2000 && st.timings.some((t) => t.ms === null); i++) await sleep(2);
    }
  };

  check('talkCommit: the words two answers agree on, never the newer one\'s last 2, the tag kept; under 3 words, none',
    local.talkCommit('language English<asr_text>One two three four five six seven.', 'language English<asr_text>One two three four five sixty.') === 'language English<asr_text>One two three four five' &&
    local.talkCommit('A b c d e f', 'A b c d e f') === 'A b c d' &&
    local.talkCommit('language English<asr_text>One two three four.', 'language English<asr_text>One two three four.') === null &&
    local.talkCommit('One two three four five', null) === null);

  // Short dictations: nothing sent while talking, and on release the very request dictate() makes.
  for (const secs of [3, 12, 19.9]) {
    const { samples } = synth(secs, 40 + secs);
    let n0 = fake.requests.length;
    const before = await collect(local.dictate(samples, SR, null, 'ctx', local.dictationBudget(samples, SR)));
    const beforeReqs = fake.requests.slice(n0);
    n0 = fake.requests.length;
    const st = local.openLong(null, () => 'ctx');
    await talkThrough(st, samples);
    const whileTalking = fake.requests.length - n0;
    const text = await collect(st.finish(samples, SR, null, 'ctx', local.dictationBudget(samples, SR)));
    const reqs = fake.requests.slice(n0);
    check(`${secs} s: untouched -- nothing sent while talking, then one request identical to dictate()'s, the same text`,
      whileTalking === 0 && reqs.length === 1 && beforeReqs.length === 1 && shape(reqs[0]) === shape(beforeReqs[0]) &&
      reqs[0].audio.length === samples.length && text === before && st.plan.steps === 0, { whileTalking, reqs: reqs.length, text, before });
  }

  // Longer: steps while talking, each continuing the last; on release one request continues the last.
  for (const secs of [20.5, 41.2, 70, 160]) {
    const { samples } = synth(secs, 50 + Math.round(secs));
    const n0 = fake.requests.length;
    const want = await collect(local.dictate(samples, SR, null, 'ctx', local.dictationBudget(samples, SR)));
    const n1 = fake.requests.length;
    const st = local.openLong(null, () => 'ctx');
    await talkThrough(st, samples);
    const released = fake.requests.length;
    const t0 = Date.now();
    const text = await collect(st.finish(samples, SR, null, 'ctx', local.dictationBudget(samples, SR)));
    const ms = Date.now() - t0;
    const plan = st.plan;
    const early = fake.requests.slice(n1, released), after = fake.requests.slice(released);
    const [l1, l2] = [early[early.length - 1], early[early.length - 2]];
    // A step that heard all the speech is the answer: nothing after release. Otherwise one request
    // continuing what the last two steps agree on (one step: nothing yet, all of it written again).
    const agreedWant = plan.steps >= 2 ? local.talkCommit(l1.reply, l2.reply) : undefined;
    check(`${secs} s: ${plan.final ? 'the last step heard all the speech: its answer, no request after release' : 'the release request continues from what the last two steps agree on'}`,
      plan.final ? after.length === 0 : after.length === 1 && (after[0].assistant || null) === (agreedWant || null), { got: after[0] && after[0].assistant, last: l1 && l1.reply, plan });
    const stepTimings = st.timings.filter((t) => t.kind === 'step');
    // Every prefilled request while talking continues from what two answers before it agree on.
    const chained = early.filter((r) => r.assistant).every((r) => early.some((q, i) => i > 0 && local.talkCommit(q.reply, early[i - 1].reply) === r.assistant));
    check(`${secs} s: ${plan.steps} steps while talking, the first at ${stepTimings.length ? stepTimings[0].availableS.toFixed(1) : '-'} s (not before 20 s), each continuing what the two before agree on`,
      plan.steps >= 1 && stepTimings[0].availableS >= 20 && chained && early.filter((r) => r.assistant).length >= Math.min(1, plan.steps - 1), stepTimings);
    const last = after[after.length - 1];
    check(`${secs} s: after release ${after.length} request${after.length === 1 ? '' : 's'}${last ? ` (the ${secs > 79 ? 'last piece' : 'whole recording'}, ${last.seconds.toFixed(1)} s, ${plan.agreedChars} characters agreed)` : ''}; the last step to ${plan.lastStepS} s of the ${secs > 79 ? 'last piece' : 'recording'} (${ms} ms here)`,
      plan.final ? after.length === 0 : after.length === 1 && (secs > 79 || last.audio.length === samples.length) && (plan.steps < 2 || (Boolean(last.assistant) && plan.agreedChars > 0)), { after: after.map((r) => r.seconds), plan });
    check(`${secs} s: the text is dictate()'s: one answer for the ${secs > 79 ? 'last piece' : 'whole recording'}, no cut, no seam`, text === want, firstDiff(text, want));
    check(`${secs} s: every request with the screen context and dictionary (the prompt)`, fake.requests.slice(n0).every((r) => r.system === 'ctx'));
    if (secs > 79) {
      const pieces = st.timings.filter((t) => t.kind === 'piece' && t.phase === 'early').length;
      check(`${secs} s: its 45-70 s pieces and seams still written while talking (${pieces}), as before`, pieces >= 1 && st.cuts.length === pieces);
    }
  }
  check('never two requests on the server at once', fake.maxInFlight === 1, fake.maxInFlight);

  // The prompt changed after the steps (a late screen read): nothing they wrote is used.
  {
    const { samples } = synth(41.2, 91);
    const st = local.openLong(null, () => 'early prompt');
    await talkThrough(st, samples);
    const n0 = fake.requests.length;
    const text = await collect(st.finish(samples, SR, null, 'ctx', 1024));
    const r = fake.requests.slice(n0);
    const want = await collect(local.dictate(samples, SR, null, 'ctx', 1024));
    check('another prompt at release: written from scratch with it, the steps unused', r.length === 1 && !r[0].assistant && r[0].system === 'ctx' && text === want);
  }
  // The capture differs from the chunks: nothing written early is used.
  {
    const { samples } = synth(41.2, 92);
    const st = local.openLong(null, () => 'ctx');
    await talkThrough(st, synth(41.2, 93).samples);
    const n0 = fake.requests.length;
    const text = await collect(st.finish(samples, SR, null, 'ctx', 1024));
    const r = fake.requests.slice(n0);
    const want = await collect(local.dictate(samples, SR, null, 'ctx', 1024));
    check('the chunks are not this capture: written from scratch', r.length === 1 && !r[0].assistant && text === want);
  }
  // After the last word, the key's click as it is let go is no speech: the last step is still the
  // answer. A short word after the pause is: written by one more request, from what the steps agree on.
  for (const what of ['click', 'word']) {
    const { samples: base } = synth(41.2, 98);
    const samples = new Float32Array(base.length + Math.round(1.0 * SR));
    samples.set(base);
    for (let i = base.length; i < samples.length; i++) samples[i] = 0.002 * (Math.sin(i * 12.9898) * 43758.5453 % 1);
    const at = samples.length - Math.round(0.4 * SR);
    if (what === 'click') {
      for (let i = 0; i < 0.06 * SR; i++) samples[at + i] += 0.4 * Math.sin(i * 1.7) * (1 - i / (0.06 * SR));
    } else {
      const n = Math.round(0.3 * SR), f = 150 + 12 * 77;
      for (let i = 0; i < n; i++) samples[at + i] += 0.3 * Math.sin(2 * Math.PI * f * i / SR) * Math.min(1, i / 80, (n - i) / 80);
    }
    const st = local.openLong(null, () => 'ctx');
    await talkThrough(st, samples);
    const n0 = fake.requests.length;
    const text = await collect(st.finish(samples, SR, null, 'ctx', 1024));
    const after = fake.requests.length - n0;
    const want = await collect(local.dictate(samples, SR, null, 'ctx', 1024));
    check(what === 'click' ? 'a click of the key after the last word: still the last step\'s answer, nothing sent after release'
      : 'a short word after the last pause: one request after release, the word in the text',
    text === want && (what === 'click' ? st.plan.final && after === 0 : !st.plan.final && after === 1), { plan: st.plan, after, text: text.slice(-60), want: want.slice(-60) });
  }
  await fake.close();

  // Released with a step in flight on a slow machine. Mid-word (speech after the step): waited for
  // once it is writing (it has read the audio), stopped while still reading. After a pause (only
  // silence after the step): the step is the answer, waited for, nothing more sent. The same text.
  {
    const slow = await fakeLlama({ answer: continuing(answerFor(false)), msPerAudioSecond: 10, msPerWord: 25 });
    const l2 = freshLocal({ TYPD_MODEL_DIR: dir, TYPD_LLAMA_PORT: String(slow.port), TYPD_LLAMA_SERVER: server, TYPD_SELFTEST: '0' });
    await l2.warm();
    const seen = new Set();
    const { samples: whole } = synth(46, 95);
    // Ends inside a word: the last frame loud enough to be a tone, 1 s before the recording's end or earlier.
    let cutAt = whole.length - SR;
    while (cutAt > 0 && Math.abs(whole[cutAt]) < 0.1) cutAt -= 16;
    for (const [ending, wait] of [['mid-word', 40], ['mid-word', 600], ['mid-word', 900], ['after a pause', 40], ['after a pause', 600]]) {
      const samples = ending === 'mid-word' ? whole.slice(0, cutAt) : whole;
      const st = l2.openLong(null, () => 'ctx');
      const lastBit = samples.length - Math.round(3.5 * SR);
      for (let at = 0; at < lastBit; at += chunk) {
        st.push(samples.slice(at, Math.min(lastBit, at + chunk)));
        for (let i = 0; i < 4000 && st.timings.some((t) => t.ms === null); i++) await sleep(2);
      }
      const n0 = slow.requests.length;
      st.push(samples.slice(lastBit));   // the last 3.5 s at once: a step starts at its last pause
      await sleep(wait);
      const t0 = Date.now();
      const text = await collect(st.finish(samples, SR, null, 'ctx', 1024));
      const ms = Date.now() - t0;
      const sent = slow.requests.length - n0;
      const want = await collect(l2.dictate(samples, SR, null, 'ctx', 1024));
      const p = st.plan;
      const how = p.final ? 'final' : p.waited ? 'waited' : p.dropped ? 'dropped' : 'none';
      seen.add(ending + ':' + how);
      check(`slow machine, ${ending}, released ${wait} ms after the last step began: ${p.final ? 'it heard everything: its answer, waited for' : p.waited ? 'it was writing: waited' : p.dropped ? 'it was reading: stopped' : 'none in flight'} (${ms} ms, ${sent} request${sent === 1 ? '' : 's'}); the same text`,
        text === want && (p.final ? sent === 1 : true), { p, sent, text: text.slice(-80), want: want.slice(-80) });
    }
    check('every kind of release seen: still reading, stopped; writing, waited for; all heard, the answer',
      seen.has('mid-word:dropped') && seen.has('mid-word:waited') && seen.has('after a pause:final'), [...seen]);

    // Cancelled while talking: the step in flight stops and nothing follows.
    const ctrl = new AbortController();
    const { samples: s3 } = synth(60, 96);
    const st3 = l2.openLong(ctrl.signal, () => 'ctx');
    for (let at = 0; at < s3.length; at += chunk) st3.push(s3.slice(at, Math.min(s3.length, at + chunk)));
    await sleep(100);
    const sent = slow.requests.length;
    ctrl.abort();
    await sleep(400);
    check(`cancelled while talking: the step in flight stops, none follows (${sent} sent, ${slow.requests.length - sent} after)`, sent >= 1 && slow.requests.length === sent);
    await slow.close();
  }

  // Low-memory mode and TYPD_TALK=0: nothing of this.
  for (const env of [{ TYPD_LOW_MEMORY: '1' }, { TYPD_TALK: '0' }]) {
    const f3 = await fakeLlama({ answer: answerFor(false) });
    const l3 = freshLocal({ TYPD_MODEL_DIR: dir, TYPD_LLAMA_PORT: String(f3.port), TYPD_LLAMA_SERVER: server, TYPD_SELFTEST: '0', ...env });
    await l3.warm();
    const { samples } = synth(40, 97);   // one request in either mode (low-memory mode's limit is 41 s)
    const st = l3.openLong(null, () => 'ctx');
    await talkThrough(st, samples);
    const n = f3.requests.length;
    await collect(st.finish(samples, SR, null, 'ctx', 1024));
    check(`${Object.keys(env)[0]}=${Object.values(env)[0]}: no steps; a 40 s dictation is one request after release, as before`, n === 0 && f3.requests.length === 1 && !f3.requests[0].assistant);
    for (const k of Object.keys(env)) delete process.env[k];
    await f3.close();
  }
}

(async () => {
  splitterTests();
  joinTests();
  await endToEnd();
  await talkTests();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
