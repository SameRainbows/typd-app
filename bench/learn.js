'use strict';

/**
 * Learn-from-corrections: does it learn real fixes, and leave ordinary edits alone?
 *
 * ROADMAP 3.2 asks for the false-positive rate on ordinary edits, because a
 * poisoned dictionary is worse than none. Runs learn.findCorrection -- the pure
 * part, no UI Automation, no dictionary writes -- over:
 *
 *   - the built-in cases below (the parked suite's pairs plus the shapes that
 *     broke it: a fixed first word, a two-word name, a merged word)
 *   - optionally a JSON file of {corrections: [...], edits: [...]}, each
 *     {kind, pasted, screen, expect}. dictation-research/scripts/learn_cases.py
 *     builds one from the user's own dictations; it stays out of this repo.
 *
 *   node bench/learn.js [cases.json]
 */

const fs = require('fs');
const { findCorrection } = require('../src/main/learn');

const BUILT_IN = {
  corrections: [
    ['We should look at Chronos before Friday.', 'We should look at Kairos before Friday.', 'Kairos'],
    ['Use a backlash to escape the quote.', 'Use a backslash to escape the quote.', 'backslash'],
    ['Lydia announced a new card today.', 'NVIDIA announced a new card today.', 'NVIDIA'],
    ['Hey Ayşe, when you are at the store, get milk.', 'Hey Aysel, when you are at the store, get milk.', 'Aysel'],
    ['Ayşe, can you call me back?', 'Aysel, can you call me back?', 'Aysel'],
    ['I compared it with whisper flow and it held up.', 'I compared it with Wispr Flow and it held up.', 'Wispr Flow'],
    ['Then I tried type less for a week.', 'Then I tried Typeless for a week.', 'Typeless'],
    ['My site is Mehmet Azdar dot com for now.', 'My site is Mehmet Dedeler dot com for now.', 'Dedeler'],
    ['We ran the job on cable last night.', 'We ran the job on Kaggle last night.', 'Kaggle'],
    ['Ask Nebulous about the credits.', 'Ask Nebius about the credits.', 'Nebius']
  ],
  edits: [
    ['The whole team agreed on the plan.', 'The entire team agreed on the plan.'],
    ['We need a bigger transport layer here.', 'We need a bigger queue consumer here.'],
    ['I walked the dog this morning.', 'I walked the dogs this morning.'],
    ['It needs one gigabyte of memory.', 'It needs 1 gigabyte of memory.'],
    ['It uses 100 gigabytes of memory.', 'It uses 1 gigabyte of memory.'],
    ['Please send it to Arif tomorrow.', 'Please send it to Selin tomorrow.'],
    ['This is a good start for the draft.', 'This is a great start for the draft, I think.'],
    ['Its a good idea.', "It's a good idea."],
    ['we should ship it', 'We should ship it.'],
    ['The meeting is on Tuesday at three.', 'The meeting is on Thursday at three.']
  ]
};

function run(cases) {
  const out = { learned: 0, right: 0, n: 0, wrong: [], missed: [], fp: {}, fpN: {}, fpExamples: [] };
  for (const c of cases.corrections) {
    out.n++;
    const got = findCorrection(c.pasted, c.screen);
    if (!got) { out.missed.push(c); continue; }
    out.learned++;
    if (got.term.toLowerCase() === String(c.expect).toLowerCase()) out.right++;
    else out.wrong.push({ ...c, got: got.term });
  }
  for (const e of cases.edits) {
    const k = e.kind || 'built-in';
    out.fpN[k] = (out.fpN[k] || 0) + 1;
    const got = findCorrection(e.pasted, e.screen);
    if (got) {
      out.fp[k] = (out.fp[k] || 0) + 1;
      if (out.fpExamples.length < 12) out.fpExamples.push({ kind: k, heardAs: got.heardAs, term: got.term });
    }
  }
  return out;
}

function report(name, r) {
  const fp = Object.values(r.fp).reduce((a, b) => a + b, 0);
  const total = Object.values(r.fpN).reduce((a, b) => a + b, 0);
  console.log(`\n${name}`);
  console.log(`  corrections learned  ${r.learned}/${r.n}  (exact term ${r.right})`);
  console.log(`  edits learned (FP)   ${fp}/${total}` + (total ? `  = ${(100 * fp / total).toFixed(1)}%` : ''));
  for (const k of Object.keys(r.fpN)) console.log(`    ${k.padEnd(18)} ${r.fp[k] || 0}/${r.fpN[k]}`);
  for (const w of r.wrong) console.log(`  wrong term: "${w.heardAs || ''}" -> got "${w.got}", expected "${w.expect}"`);
  for (const m of r.missed.slice(0, 15)) console.log(`  missed: expected "${m.expect}"${m.heardAs ? ` (heard "${m.heardAs}")` : ''}`);
  for (const x of r.fpExamples) console.log(`  FP [${x.kind}]: "${x.heardAs}" -> "${x.term}"`);
}

const builtIn = run({
  corrections: BUILT_IN.corrections.map(([pasted, screen, expect]) => ({ pasted, screen, expect })),
  edits: BUILT_IN.edits.map(([pasted, screen]) => ({ pasted, screen }))
});
report('built-in cases', builtIn);

const file = process.argv[2];
if (file) report(file, run(JSON.parse(fs.readFileSync(file, 'utf8'))));

const failed = builtIn.right < builtIn.n || Object.keys(builtIn.fp).length > 0;
process.exitCode = failed ? 1 : 0;
