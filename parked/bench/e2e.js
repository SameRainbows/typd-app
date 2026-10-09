'use strict';

/**
 * The whole pipeline, all three modes, on real recorded audio.
 *
 * formatting.js exercises the cleanup prompts and asr.py exercises the
 * recogniser, but nothing checked that src/main/pipeline/index.js wires them
 * together correctly per mode — that dictate and translate end in `done` and get
 * pasted, while ask ends in `answer` and goes to the card instead. That branch
 * is ten lines and every one of them is a way to paste a question into someone's
 * document.
 *
 *   $env:POOLSIDE_API_KEY = 'sky_...'
 *   node bench/e2e.js
 */

const sherpa = require('sherpa-onnx-node');
const pipeline = require('../src/main/pipeline');

const CONTEXT =
  '<active_application>Code</active_application>\n' +
  '<window_title>transport.ts — Typd</window_title>';

async function drive(mode, wav, contextBlock) {
  const wave = sherpa.readWave(wav);
  const audio = { samples: wave.samples, sampleRate: wave.sampleRate };
  const controller = new AbortController();

  const events = [];
  const started = Date.now();
  let firstPartial = null;

  for await (const event of pipeline.run(mode, {
    audio, contextBlock, signal: controller.signal
  })) {
    if (event.type === 'partial' && firstPartial === null) {
      firstPartial = Date.now() - started;
    }
    events.push(event);
  }

  const last = events[events.length - 1];
  const order = [];
  for (const e of events) if (order[order.length - 1] !== e.type) order.push(e.type);

  console.log('\n=== ' + mode + '   ' + (Date.now() - started) + ' ms' +
    (firstPartial !== null ? ', first partial ' + firstPartial + ' ms' : ''));
  console.log('  events : ' + order.join(' → '));
  if (last.type === 'answer') {
    console.log('  asked  : ' + last.question);
    console.log('  answer : ' + last.answer);
  } else {
    console.log('  text   : ' + (last.text || '').replace(/\n/g, '\n           '));
  }
  return last;
}

(async () => {
  await pipeline.warm();

  const dictated = 'recordings/00.wav';
  const wav = require('path').join(__dirname, dictated);

  const d = await drive('dictate', wav, CONTEXT);
  const t = await drive('translate', wav, CONTEXT);
  const a = await drive('ask',
    require('path').join(__dirname, 'models/parakeet/test_wavs/en.wav'), null);

  const problems = [];
  if (d.type !== 'done') problems.push('dictate did not end in done — nothing would be pasted');
  if (t.type !== 'done') problems.push('translate did not end in done');
  if (a.type !== 'answer') problems.push('ask ended in ' + a.type + ' — a question would be pasted into the document');
  if (a.type === 'answer' && !a.question) problems.push('ask answer carries no question, so the card has no header');
  if (t.type === 'done' && !/[şğıöçüŞĞİÖÇÜ]|\b(bir|için|ve|ile)\b/i.test(t.text || '')) {
    problems.push('translate output does not look like Turkish');
  }

  console.log('\n' + '-'.repeat(60));
  console.log(problems.length
    ? 'PROBLEMS:\n  ' + problems.join('\n  ')
    : 'all three modes wired correctly');
  process.exit(problems.length ? 1 : 0);
})().catch((err) => {
  console.error('FAILED: ' + err.message);
  process.exit(1);
});
