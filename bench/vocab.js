'use strict';

/**
 * The dictionary is a hint, not an order (src/main/pipeline/vocab.js, local.js checkTerms).
 * Headless, no model: a fake llama-server answers the dictation and the two short requests the
 * check makes.
 *
 *   1. decide(): a term the hint put in place of a different word goes ("Kerem" written as
 *      "Aysel" because Aysel is in the dictionary -- dictation-research
 *      reports/dogfood_audit_2026-10-16.md); a term the model heard (alike in spelling or sound,
 *      a known mishearing, or the model was sure) stays.
 *   2. suspects(): only terms the prompt showed, whole words, at most three.
 *   3. Through local.dictate: off unless TYPD_VOCAB_CHECK=1; the requests made (one token with its
 *      top alternatives, then the best word-starting alternative -- never the model's "language"
 *      tag -- continued), the text that comes out, and that nothing is asked when no term is in
 *      the text -- a dictation's requests are then exactly what they were.
 *
 *   node bench/vocab.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeLlama } = require('./fake-llama');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-vocab-'));
process.env.APPDATA = tmp;   // the dictionary lives here for the bench (pipeline/context.js)
process.env.HOME = tmp;
process.env.XDG_CONFIG_HOME = tmp;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + JSON.stringify(detail).slice(0, 500) : ''));
}
const section = (s) => console.log('\n' + s);

const vocab = require('../src/main/pipeline/vocab');
const context = require('../src/main/pipeline/context');

function decideTests() {
  section('1. keep the term, or put the other word back');
  const cases = [
    // [name, args, keep]
    ['"Kerem" written as "Aysel" (the audit\'s case): put back', { term: 'Aysel', p: 0.62, alt: 'Kerem', altNext: 'ready', origNext: 'ready' }, false],
    ['"Kereem", the same name spelled otherwise: put back', { term: 'Aysel', p: 0.7, alt: 'Kereem', altNext: 'ready', origNext: 'ready' }, false],
    ['Aysel said, the model\'s other spelling "Ayşe" is how it is misheard: kept', { term: 'Aysel', heardAs: ['Ayşe'], p: 0.55, alt: 'Ayşe', altNext: 'said', origNext: 'said' }, true],
    ['Aysel said, other word "Aisel" (alike): kept', { term: 'Aysel', p: 0.5, alt: 'Aisel', altNext: 'said', origNext: 'said' }, true],
    ['"Typd" over "typed" (alike): kept', { term: 'Typd', p: 0.6, alt: 'typed', altNext: 'works', origNext: 'works' }, true],
    ['"Wispr Flow" over "whisper flow": kept', { term: 'Wispr Flow', p: 0.7, alt: 'whisper flow', altNext: 'and', origNext: 'and' }, true],
    ['"Kaggle" over "Google" (sounds alike): kept', { term: 'Kaggle', p: 0.6, alt: 'Google', altNext: 'notebook', origNext: 'notebook' }, true],
    ['"Kairos" over "Chronos" (learn.js\'s own example of a correction): kept', { term: 'Kairos', p: 0.6, alt: 'Chronos', altNext: 'is', origNext: 'is' }, true],
    ['the model was sure of the term (p 0.97): kept, whatever else', { term: 'Aysel', p: 0.97, alt: 'Kerem', altNext: 'ready', origNext: 'ready' }, true],
    ['the other word skips the slot ("for a ready"): kept', { term: 'Aysel', p: 0.6, alt: 'a', altNext: 'ready', origNext: 'ready' }, true],
    ['the other word is not in the term\'s place (a different word follows): kept', { term: 'Aysel', p: 0.6, alt: 'Kerem', altNext: 'and', origNext: 'ready' }, true],
    ['the other word is no word ("ays"): kept', { term: 'Aysel', p: 0.6, alt: 'ays', altNext: 'ready', origNext: 'ready' }, true],
    ['no other word came back: kept', { term: 'Aysel', p: 0.4, alt: null, altNext: null, origNext: 'ready' }, true],
    ['another name in a name\'s place, not alike ("Monday" for "Kairos"): put back', { term: 'Kairos', p: 0.5, alt: 'Monday', altNext: 'is', origNext: 'is' }, false],
    ['a word alike in spelling ("Monday" for "Modal") is not judged different: kept', { term: 'Modal', p: 0.5, alt: 'Monday', altNext: 'credit', origNext: 'credit' }, true]
  ];
  for (const [name, args, keep] of cases) {
    const d = vocab.decide(args);
    check(name + '  [' + d.why + ']', d.keep === keep, d);
  }
}

function suspectTests() {
  section('2. which terms are checked');
  const list = [{ term: 'Aysel', heardAs: ['Ayşe'] }, { term: 'Typd', heardAs: [] }, { term: 'Kaggle' }, { term: 'R2' }];
  const sys = '<active_application>claude</active_application>\n<visible_text note="Reference only.">\nAysel, Typd, R2\n</visible_text>';
  const s = vocab.suspects('Send Aysel the Typd build, then Kaggle. aysels and Typd again, Typd.', sys, list);
  check('terms the prompt showed, whole words, case-insensitive, at most 3', JSON.stringify(s.map((x) => x.term)) === JSON.stringify(['Aysel', 'Typd', 'Typd']), s);
  check('not a term the prompt did not show (Kaggle), nor one with a digit (R2)', !s.some((x) => x.term === 'Kaggle' || x.term === 'R2'));
  check('a prompt without screen text or vocabulary: nothing', vocab.suspects('Send Aysel the build', '', list).length === 0 && vocab.suspects('Send Aysel', 'ctx', list).length === 0);
}

/* ------------------------------------------------------------- 3. end to end */

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

async function collect(gen) { let t = ''; for await (const x of gen) t = x; return t; }

async function flow() {
  section('3. through local.dictate, with a fake model');
  fs.mkdirSync(path.join(tmp, 'typd'), { recursive: true });
  fs.writeFileSync(context.VOCAB_FILE, JSON.stringify([
    { term: 'Aysel', heardAs: ['Ayşe'], source: 'auto' },
    { term: 'Typd', heardAs: ['typed'], source: 'auto' }
  ]));
  const system = context.build({ process: 'claude', title: 'Claude', text: 'Release notes for the next build of the app, and who gets it first.' });
  check('the prompt carries the dictionary line', /Aysel, Typd/.test(system), system);

  // What the "model" says. The dictation: a sentence with the term in it. The check's requests:
  // one token with its top alternatives, then the best alternative that starts a word, continued.
  let said = '';
  let scenario = {};
  const pick = (assistant) => scenario[Object.keys(scenario).find((k) => String(assistant || '').endsWith(k))];
  const continuation = (assistant) => {
    for (const k of Object.keys(scenario)) {
      for (const a of scenario[k].alts || []) if (String(assistant || '').endsWith(k + a.token)) return a.cont;
    }
    return null;
  };
  const fake = await fakeLlama({
    answer: (req) => {
      const b = req.body;
      if (b.max_tokens === 1 && b.logprobs) {
        const s = pick(req.assistant);
        const top = [{ id: 4242, token: s.tok, logprob: Math.log(s.p) }, ...(s.alts || []).map((a, i) => ({ id: 5000 + i, token: a.token, logprob: Math.log(a.p) }))];
        return { text: s.tok, logprobs: [{ id: 4242, token: s.tok, logprob: Math.log(s.p), top_logprobs: top }] };
      }
      if (!b.stream) return { text: continuation(req.assistant) || '' };
      return 'language English<asr_text>' + said;
    }
  });
  const dir = path.join(tmp, 'model');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['m.gguf', 'p.gguf']) fs.writeFileSync(path.join(dir, f), 'x');
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ model: 'm.gguf', mmproj: 'p.gguf', context: true, revise: true, prefill: '' }));
  const server = path.join(tmp, 'never-started');
  fs.writeFileSync(server, '');
  const local = freshLocal({ TYPD_MODEL_DIR: dir, TYPD_LLAMA_PORT: String(fake.port), TYPD_LLAMA_SERVER: server, TYPD_SELFTEST: '0' });
  await local.warm();
  const audio = new Float32Array(16000 * 3).map((_, i) => 0.1 * Math.sin(i / 9));
  const log = [];
  local.setVocabLog((e) => log.push(e));

  // Off unless TYPD_VOCAB_CHECK=1 (2026-10-17: the first real run replaced nothing it should have).
  said = "Let's get the release for Aysel ready and I'll send it to him.";
  scenario = { for: { tok: ' Ays', p: 0.62, alts: [{ token: 'language', p: 0.2, cont: ' English<asr_text>Let' }, { token: ' Ker', p: 0.1, cont: 'em ready and I' }] } };
  let n = fake.requests.length;
  delete process.env.TYPD_VOCAB_CHECK;
  let text = await collect(local.dictate(audio, 16000, null, system, 200));
  let reqs = fake.requests.slice(n);
  check('off by default: one request, the text as the model wrote it', text === said && reqs.length === 1, { text, n: reqs.length });
  process.env.TYPD_VOCAB_CHECK = '1';

  // The audit's case.
  n = fake.requests.length;
  text = await collect(local.dictate(audio, 16000, null, system, 200));
  reqs = fake.requests.slice(n);
  check('"…the release for Aysel ready…" said as Kerem: "…the release for Kerem ready…"', text === "Let's get the release for Kerem ready and I'll send it to him.", text);
  check('three requests: the dictation, one token with its alternatives, the best word-starting one continued', reqs.length === 3 && reqs[1].body.max_tokens === 1 && reqs[1].body.logprobs === true &&
    reqs[2].assistant === "language English<asr_text>Let's get the release for Ker", reqs.map((r) => r.assistant));
  check("both continue the dictation's own answer up to the term (its language tag included), with its audio and prompt",
    reqs[1].assistant === "language English<asr_text>Let's get the release for" && reqs.slice(1).every((r) => r.system === system && r.seconds === reqs[0].seconds), reqs.slice(1).map((r) => r.assistant));
  check('the dictation carries the language guard; the two checks, which read the model’s own probabilities, do not',
    typeof reqs[0].body.grammar === 'string' && !('grammar' in reqs[1].body) && !('grammar' in reqs[2].body), reqs.map((r) => 'grammar' in r.body));
  check('the language tag is never the other word (the first real run replaced "Typd" with it)',
    !reqs.some((r) => /for(language| language)$/.test(r.assistant || '')), reqs.map((r) => r.assistant));

  // Only the tag, or the term's own pieces, as alternatives: nothing to put back.
  said = 'The new Typd build is ready.';
  scenario = { new: { tok: ' Typ', p: 0.7, alts: [{ token: 'language', p: 0.2, cont: ' English' }, { token: ' Ty', p: 0.05, cont: 'pd build' }] } };
  n = fake.requests.length;
  text = await collect(local.dictate(audio, 16000, null, system, 200));
  reqs = fake.requests.slice(n);
  check('only the tag or a piece of the term as alternatives: kept, no continuation asked', text === said && reqs.length === 2, { text, n: reqs.length });

  // Aysel really said: the model's other spelling is the known mishearing.
  said = 'Aysel said she can test it tonight.';
  scenario = { '<asr_text>': { tok: 'Ays', p: 0.55, alts: [{ token: 'Ay', p: 0.3, cont: 'şe said she' }] } };
  text = await collect(local.dictate(audio, 16000, null, system, 200));
  check('Aysel said (the other word is her name misheard): kept', text === said, text);

  // Typd, the model sure of it: one extra token, no second request.
  said = 'The new Typd build is ready.';
  scenario = { new: { tok: ' Typ', p: 0.99, alts: [{ token: ' typed', p: 0.01, cont: ' build' }] } };
  n = fake.requests.length;
  text = await collect(local.dictate(audio, 16000, null, system, 200));
  reqs = fake.requests.slice(n);
  check('a term the model was sure of: kept, after one one-token request', text === said && reqs.length === 2, { text, n: reqs.length });

  // No dictionary term in the text: the dictation's requests are what they always were.
  said = 'Nothing from the dictionary here.';
  n = fake.requests.length;
  text = await collect(local.dictate(audio, 16000, null, system, 200));
  reqs = fake.requests.slice(n);
  check('no term in the text: one request, its body as before (plus the language guard, bench/lang-guard.js)', text === said && reqs.length === 1 &&
    Object.keys(reqs[0].body).join(',') === 'messages,temperature,cache_prompt,grammar,stream,max_tokens', reqs.map((r) => Object.keys(r.body).join(',')));

  // A server that does not give probabilities (an older build): the text is kept as written.
  said = "Let's get the release for Aysel ready and I'll send it to him.";
  const plainFake = await fakeLlama({ answer: (req) => (req.body.stream ? 'language English<asr_text>' + said : { text: ' Ays' }) });
  const l2 = freshLocal({ TYPD_MODEL_DIR: dir, TYPD_LLAMA_PORT: String(plainFake.port), TYPD_LLAMA_SERVER: server, TYPD_SELFTEST: '0' });
  await l2.warm();
  text = await collect(l2.dictate(audio, 16000, null, system, 200));
  check('a server without token probabilities: the text as the model wrote it', text === said, text);
  check('every decision is logged for the eval tools', log.length >= 3 && log.some((e) => !e.keep && e.alt === 'Kerem'), log);
  await plainFake.close();
  await fake.close();
  delete process.env.TYPD_VOCAB_CHECK;
}

(async () => {
  decideTests();
  suspectTests();
  await flow();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
