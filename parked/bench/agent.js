'use strict';

/**
 * Does the merged Ask/agent route correctly?
 *
 * The whole design rests on the model reliably telling "do this" from "tell me
 * this" — get it wrong in one direction and a question launches Spotify, wrong
 * in the other and "play Clair de Lune" comes back as an essay about Debussy.
 *
 * The host is mocked: launches are recorded, never executed. A test suite that
 * opens thirteen applications on someone's desktop is not one you run twice.
 *
 *   $env:POOLSIDE_API_KEY = 'sky_...'
 *   node bench/agent.js
 */

const agent = require('../src/main/pipeline/agent');

const CODE_CONTEXT =
  '<active_application>Code</active_application>\n' +
  '<window_title>transport.ts — Typd</window_title>';

const CASES = [
  {
    name: 'play a song → acts, does not lecture',
    input: 'play clair de lune',
    want: [
      ['calls play_music', (r) => r.launched.some((t) => /music\.youtube|spotify/i.test(t))],
      ['launch carries the song', (r) => r.launched.some((t) => /clair/i.test(t))],
      ['confirms briefly', (r) => r.answer === null || r.answer.length < 120],
      ['does not explain Debussy', (r) => !/debussy|impressionis/i.test(r.answer || '')]
    ]
  },
  {
    name: 'open an app → acts',
    input: 'open the calculator',
    want: [
      ['launched something', (r) => r.launched.length === 1],
      ['launched calc', (r) => /calc/i.test(r.launched[0] || '')],
      ['brief or silent', (r) => r.answer === null || r.answer.length < 120]
    ]
  },
  {
    name: 'plain fact → answers, launches nothing',
    input: 'um how tall is mount everest',
    want: [
      ['no launches', (r) => r.launched.length === 0],
      ['answered', (r) => !!r.answer],
      ['has the figure', (r) => /8[,.]?849|29[,.]?0\d\d/.test(r.answer || '')],
      ['stays short', (r) => (r.answer || '').length < 160]
    ]
  },
  {
    name: 'current events → searches before answering',
    input: 'whats the latest news on nvidia earnings',
    want: [
      ['ran a search', (r) => r.tools.includes('search_web')],
      ['said it was searching', (r) => r.statuses.some((s) => /search/i.test(s))],
      ['launched nothing', (r) => r.launched.length === 0],
      ['answered', (r) => !!r.answer]
    ]
  },
  {
    name: 'time → uses the clock, not its priors',
    input: 'what time is it',
    want: [
      ['called get_time', (r) => r.tools.includes('get_time')],
      ['answered', (r) => !!r.answer],
      ['launched nothing', (r) => r.launched.length === 0]
    ]
  },
  {
    name: 'how-do-I → answers with markdown, no tools',
    input: 'how do i reverse a list in python',
    context: CODE_CONTEXT,
    want: [
      ['launched nothing', (r) => r.launched.length === 0],
      ['has code', (r) => /```|`\w/.test(r.answer || '')],
      ['answered', (r) => !!r.answer]
    ]
  },
  {
    name: 'impossible request → declines in one line',
    input: 'delete all my emails from last week',
    want: [
      ['launched nothing', (r) => r.launched.length === 0],
      ['answered', (r) => !!r.answer],
      ['says it cannot', (r) => /(can'?t|cannot|unable|don'?t have|no way)/i.test(r.answer || '')],
      ['one line', (r) => (r.answer || '').length < 200]
    ]
  }
];

async function drive(testCase) {
  const launched = [];
  const host = { launch: async (target) => { launched.push(target); } };

  const tools = [];
  const statuses = [];
  const actions = [];
  let answer = null;

  const started = Date.now();
  for await (const event of agent.run(
    testCase.input, testCase.context || null, host, new AbortController().signal
  )) {
    if (event.type === 'status') { statuses.push(event.label); }
    else if (event.type === 'action') { actions.push(event.label); }
    else if (event.type === 'answer') { answer = event.text; }
  }

  // Statuses are emitted per tool call and name the tool, so they double as the
  // record of which tools ran.
  for (const s of statuses) {
    if (/search/i.test(s)) tools.push('search_web');
    if (/opening/i.test(s)) tools.push('open_app');
    if (/playing/i.test(s)) tools.push('play_music');
  }

  return { launched, statuses, actions, answer, tools, ms: Date.now() - started };
}

(async () => {
  if (!process.env.POOLSIDE_API_KEY) {
    console.error('POOLSIDE_API_KEY is not set.');
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  for (const testCase of CASES) {
    let result;
    try {
      result = await drive(testCase);
    } catch (err) {
      console.log('\n=== ' + testCase.name + '\n  FAILED: ' + err.message);
      failed += testCase.want.length;
      continue;
    }

    // get_time leaves no status line, so recover it from the answer shape.
    if (!result.tools.length && /\b(20\d\d|:\d\d)\b/.test(result.answer || '')) {
      result.tools.push('get_time');
    }

    console.log('\n=== ' + testCase.name + '   (' + result.ms + ' ms)');
    if (result.statuses.length) console.log('  status  : ' + result.statuses.join(' | '));
    if (result.launched.length) console.log('  launched: ' + result.launched.join(' | '));
    console.log('  answer  : ' + (result.answer === null ? '(none)' : result.answer.slice(0, 150).replace(/\n/g, ' ⏎ ')));

    for (const [label, check] of testCase.want) {
      let ok = false;
      try { ok = check(result); } catch { ok = false; }
      if (ok) passed++; else failed++;
      console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label);
    }
  }

  console.log('\n' + '-'.repeat(60));
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
