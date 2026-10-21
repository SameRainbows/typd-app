'use strict';

/**
 * The language guard (src/main/pipeline/local.js, guardGrammar), headless.
 *
 *   1. The grammar's letters (no model): the scripts it bars -- the outputs that started it (P2d's
 *      "20年。", "ピアノ。かっこいい？", "わからない。"; P2c's "dokunушlarla") and a word of each
 *      barred script -- and what it keeps: English, Turkish, every Latin letter, Greek, punctuation,
 *      symbols, emoji. llama.cpp rejects a token that ends inside a character when any character
 *      it could complete to is barred (llama_grammar_match_partial_char), so each kept character is
 *      also checked byte by byte: every proper prefix of its UTF-8 must stay open.
 *   2. Request bodies (a fake llama-server; no model): a dictation from a model that names the
 *      language itself carries the grammar (the tag, then the text rule); work while you talk's
 *      continuations, whose opening already holds the tag, the text rule alone; revise, models
 *      given their tag, and TYPD_LANG_GUARD=0 none; otherwise the body is what it was. A server
 *      that refuses the grammar gets the request again without it (the same text, no error) and no
 *      grammar after; any other refusal is the error it always was, and the guard stays.
 *   3. With the model on this machine: the real llama-server (vendor/llama) on the CPU (CUDA
 *      hidden, -ngl 0) and a free port, started by local.js. It parses the grammar; the test clip
 *      comes back right; and, with the research data beside this repo, the three clips that came
 *      out Japanese come out in English and a FLEURS Turkish clip in Turkish. Skipped when the
 *      files are absent (CI).
 *
 *   node bench/lang-guard.js              all three parts (~1 min on a laptop CPU)
 *   node bench/lang-guard.js --no-model   parts 1 and 2 (part of npm run bench)
 *
 * Part 3's files: TYPD_GUARD_BENCH_MODEL, a folder whose model.json names a model that writes its own
 * tag ("prefill": "") [../dictation-research/models/try/p2d]; TYPD_LLAMA_SERVER [vendor/llama/llama-server.exe;
 * vendor/llama-mac/<arch>/llama-server]. The Mac CI runs part 3 with the published model (scripts/fetch-model.js).
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { fakeLlama } = require('./fake-llama');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', 'dictation-research');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'dictation-3s.wav');
const TYPD_PORT = 8737;
const GIVEN = { ...process.env };
const SR = 16000;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
}
const section = (s) => console.log('\n' + s);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-guard-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function collect(gen) { let t = ''; for await (const x of gen) t = x; return t; }

// Every completion request local.js sends, parsed, as it leaves (local.js calls http.request
// through the module object).
const sent = [];
const realRequest = http.request;
http.request = function request(opts, cb) {
  const req = realRequest.call(this, opts, cb);
  if (opts && opts.method === 'POST' && opts.path === '/v1/chat/completions') {
    const end = req.end;
    req.end = function (payload, ...rest) {
      try { sent.push(JSON.parse(payload)); } catch { sent.push({ unparsed: String(payload).slice(0, 200) }); }
      return end.call(this, payload, ...rest);
    };
  }
  return req;
};
const since = (n) => sent.slice(n);
const isRevise = (b) => /^Revise the highlighted text/.test(b.messages[0].content);
const opening = (b) => { const m = b.messages[b.messages.length - 1]; return m.role === 'assistant' ? m.content : ''; };

const instances = [];
function freshLocal(env) {
  for (const k of ['TYPD_MODEL_DIR', 'TYPD_LLAMA_PORT', 'TYPD_LLAMA_SERVER', 'TYPD_GPU_LAYERS', 'TYPD_SELFTEST', 'CUDA_VISIBLE_DEVICES', 'TYPD_LANG_GUARD']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../src/main/pipeline/local')];
  const local = require('../src/main/pipeline/local');
  instances.push(local);
  return local;
}
process.on('exit', () => { for (const l of instances) { try { l.stop(); } catch { /* gone */ } } });

/* ------------------------------------------------------------ 1. the letters */

/** [lo, hi] code point ranges of the grammar's barred class. */
function barredRanges(scripts) {
  return [...scripts.matchAll(/\\u([0-9A-F]{4})-\\u([0-9A-F]{4})/gi)].map((m) => [parseInt(m[1], 16), parseInt(m[2], 16)]);
}

/** llama_grammar_match_partial_char's range for a character cut after `k` of its UTF-8 bytes. */
function partialRange(bytes, k) {
  const n = bytes.length;
  const lead = bytes[0];
  let value = n === 2 ? lead & 0x1f : n === 3 ? lead & 0x0f : lead & 0x07;
  for (let i = 1; i < k; i++) value = (value << 6) | (bytes[i] & 0x3f);
  const remain = n - k;
  let low = value * 2 ** (6 * remain);
  const high = low + 2 ** (6 * remain) - 1;
  if (low === 0) low = remain === 2 ? 1 << 11 : remain === 3 ? 1 << 16 : low;
  return [low, high];
}

function letterTests(local) {
  section('1. the grammar\'s letters (no model)');
  const g = local.languageGuard;
  const ranges = barredRanges(g.scripts);
  const barred = new RegExp('[' + g.scripts + ']', 'u');
  check(`the opening: "language " + ${g.languages.join(' or ')} + "<asr_text>", then the text rule; continuations: the text rule alone`,
    g.open.startsWith('root ::= "language " ("English" | "Turkish") "<asr_text>" text\n') && g.rest.startsWith('root ::= text\n') &&
    g.open.endsWith('text ::= [^' + g.scripts + ']*') && g.rest.endsWith('text ::= [^' + g.scripts + ']*'), { open: g.open, rest: g.rest });
  check(`${ranges.length} barred ranges, all well formed`, ranges.length >= 8 && ranges.every(([a, b]) => a <= b) && barredRanges(g.scripts).length === (g.scripts.match(/-/g) || []).length);

  const bad = {
    'P2d cv_76321': '20年。', 'P2d cv_77856': 'ピアノ。かっこいい？', 'P2d cv_77995': 'わからない。', 'P2c cv_78453': '知りません。',
    'P2c Cyrillic in Turkish': 'ustaca dokunушlarla', Korean: '안녕하세요', Russian: 'Привет', Arabic: 'مرحبا', Persian: 'سلام دوست',
    Hindi: 'नमस्ते', Thai: 'สวัสดี', 'CJK punctuation': 'Yes。', Cantonese: '唔該'
  };
  const caught = Object.entries(bad).filter(([, t]) => barred.test(t)).map(([k]) => k);
  check(`barred: ${Object.keys(bad).join(', ')}`, caught.length === Object.keys(bad).length, Object.keys(bad).filter((k) => !caught.includes(k)));

  const keep = [
    'I think filler words are literally one of the biggest parts of cleaning up your dictations.',
    'Apia, Samoa\'nın başkentidir. Şehir Upolu adasındadır ve 40.000\'in biraz altında bir nüfusa sahiptir.',
    'ÇĞİÖŞÜ çğıöşü İstanbul\'da ılık bir gün; Ağustos, Eylül.',
    'café naïve façade jalapeño Straße smørrebrød Ærø œuvre Łódź Dvořák Mikuláš Ödön Győr Ţară',
    'Nguyễn Thị Ngọc, ọ ở ṣ ệ, Ṭ ḥ ʻokina ə',
    'µm, μ π Δ Ω λ σ, α-β', '— – … ‘ ’ “ ” • · € £ ¥ ₹ ₺ ° ± × ÷ → ← ↑ ✓ ✔ ™ © ® ½ ¼ ⁴ ⁻ №',
    '🎉 🚀 💪 🙂 💡 🚫 🙌 🎃 ❤️ 🚶‍♂️ 👍🏽 🇹🇷', 'tabs\tand\nnew lines\n\n- list item', 'x² + y³ ≤ z, ∑, √2, ∞', '  '
  ];
  check('kept: English, Turkish, Latin letters of every European language and Vietnamese, Greek, punctuation, currency, symbols, emoji, white space',
    keep.every((t) => !barred.test(t)), keep.filter((t) => barred.test(t)));

  // Byte by byte: every proper prefix of a kept character's UTF-8 must leave a completion open.
  const chars = new Set();
  for (const t of keep) for (const ch of t) if (ch.codePointAt(0) > 0x7f) chars.add(ch);
  for (let cp = 0x80; cp <= 0x24f; cp++) chars.add(String.fromCodePoint(cp));          // Latin-1, Extended-A/B
  for (let cp = 0x370; cp <= 0x3ff; cp++) chars.add(String.fromCodePoint(cp));         // Greek
  for (let cp = 0x1e00; cp <= 0x1eff; cp++) chars.add(String.fromCodePoint(cp));       // Latin Extended Additional
  for (let cp = 0x2000; cp <= 0x2bff; cp++) chars.add(String.fromCodePoint(cp));       // punctuation, currency, arrows, math, symbols
  for (let cp = 0x1f300; cp <= 0x1faff; cp++) chars.add(String.fromCodePoint(cp));     // emoji
  for (const cp of [0xfe0f, 0x200d, 0xfffd]) chars.add(String.fromCodePoint(cp));
  const shut = [];
  for (const ch of chars) {
    if (barred.test(ch)) { shut.push([ch, 'barred']); continue; }
    const bytes = [...Buffer.from(ch, 'utf8')];
    for (let k = 1; k < bytes.length; k++) {
      const [lo, hi] = partialRange(bytes, k);
      if (ranges.some(([a, b]) => a <= hi && lo <= b)) { shut.push([ch, 'U+' + ch.codePointAt(0).toString(16), k]); break; }
    }
  }
  check(`${chars.size} kept characters can be written byte by byte (no UTF-8 prefix of one may complete to a barred letter)`, shut.length === 0, shut.slice(0, 10));
  // and the other way: a barred script's own lead bytes are shut, so the model cannot start one.
  const leads = ['年', 'ピ', '안', 'П', 'م', 'न', 'ส'].map((ch) => partialRange([...Buffer.from(ch, 'utf8')], 1));
  check('a token ending in the first byte of a barred letter (年 ピ 안 П م न ส) is shut', leads.every(([lo, hi]) => ranges.some(([a, b]) => a <= hi && lo <= b)), leads);
}

/* --------------------------------------------------------- 2. request bodies */

function modelDir(name, spec) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['m.gguf', 'p.gguf']) fs.writeFileSync(path.join(dir, f), 'x');
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(spec));
  return dir;
}

/** Speech-like audio: `seconds` of 0.6 s bursts with 0.45 s pauses; one word per burst. */
function speech(seconds) {
  const s = new Float32Array(Math.round(seconds * SR));
  for (let t = 0; t < seconds; t += 1.05) {
    const a = Math.round(t * SR), b = Math.min(s.length, Math.round((t + 0.6) * SR));
    for (let i = a; i < b; i++) s[i] = 0.25 * Math.sin(i / 6) * Math.sin(Math.PI * (i - a) / (b - a));
  }
  return s;
}
function bursts(audio) {
  let n = 0, on = false, quiet = 0;
  for (let i = 0; i < audio.length; i += 160) {
    let e = 0;
    for (let j = i; j < Math.min(audio.length, i + 160); j++) e = Math.max(e, Math.abs(audio[j]));
    if (e > 0.05) { if (!on) n++; on = true; quiet = 0; } else if (++quiet > 3) on = false;
  }
  return n;
}
// The fake model: the tag, then one word per burst it hears; a prefilled answer continues.
const WORDS = 'the quick brown fox jumps over a lazy dog while we talk about plans for the week ahead'.split(' ');
function tagged(req) {
  const n = bursts(req.audio);
  const text = 'language English<asr_text>' + Array.from({ length: n }, (_, i) => WORDS[i % WORDS.length] + (i % 9 === 8 ? '.' : '')).join(' ');
  return req.assistant && !text.startsWith(req.assistant) ? req.assistant + ' x' : text;
}

async function bodyTests() {
  section('2. request bodies (a fake llama-server; no model)');
  const server = path.join(tmp, 'llama-server-never-started');
  fs.writeFileSync(server, '');
  const own = modelDir('own-tag', { model: 'm.gguf', mmproj: 'p.gguf', context: true, revise: true, stream: false, prefill: '' });
  const given = modelDir('given-tag', { model: 'm.gguf', mmproj: 'p.gguf', context: true, revise: true, stream: false });
  const fake = await fakeLlama({ answer: tagged });
  const env = (dir, extra = {}) => ({ TYPD_MODEL_DIR: dir, TYPD_LLAMA_PORT: String(fake.port), TYPD_LLAMA_SERVER: server, TYPD_SELFTEST: '0', ...extra });
  const short = speech(3);

  let local = freshLocal(env(own));
  await local.warm();
  const G = local.languageGuard;
  check('guardGrammar: no opening -> the tag rule; an opening holding an English or Turkish tag -> the text rule; revise, any other opening -> none',
    local.guardGrammar('', false) === G.open && local.guardGrammar('language English<asr_text>Hello there', false) === G.rest &&
    local.guardGrammar('language Turkish<asr_text>Merhaba', false) === G.rest && local.guardGrammar('', true) === null &&
    local.guardGrammar('language Japanese<asr_text>', false) === null && local.guardGrammar('Hello', false) === null);

  let n = sent.length;
  const text = await collect(local.dictate(short, SR, null, 'ctx', 200));
  let b = since(n);
  check('a dictation: one request with the grammar, the body otherwise as before (no opening, temperature 0, cached prompt, streamed, its budget)',
    b.length === 1 && b[0].grammar === G.open && !opening(b[0]) &&
    JSON.stringify(Object.keys(b[0])) === JSON.stringify(['messages', 'temperature', 'cache_prompt', 'grammar', 'stream', 'max_tokens']) &&
    b[0].temperature === 0 && b[0].cache_prompt === true && b[0].stream === true && b[0].max_tokens === 200, b.map((x) => Object.keys(x)));
  check('its text without the tag', text === 'the quick brown', text);

  n = sent.length;
  await collect(local.revise(short, SR, null, 'The meeting is on Monday.'));
  b = since(n);
  check('a revise: no grammar (as before)', b.length === 1 && isRevise(b[0]) && !('grammar' in b[0]), b.map((x) => x.grammar || 'none'));

  n = sent.length;
  local.ping('ctx');
  for (let i = 0; i < 50 && sent.length < n + 1; i++) await sleep(20);
  b = since(n);
  check('the wake-up ping (one token): the grammar, harmless', b.length === 1 && b[0].max_tokens === 1 && b[0].grammar === G.open);

  // Work while you talk: steps from 20 s, each continuing what two answers agree on, then release.
  const talk = speech(41);
  n = sent.length;
  const want = await collect(local.dictate(talk, SR, null, 'ctx', local.dictationBudget(talk, SR)));
  const n1 = sent.length;
  const st = local.openLong(null, () => 'ctx');
  const chunk = Math.round(0.256 * SR);
  for (let at = 0; at < talk.length; at += chunk) {
    st.push(talk.slice(at, Math.min(talk.length, at + chunk)));
    for (let i = 0; i < 2000 && st.timings.some((t) => t.ms === null); i++) await sleep(2);
  }
  const got = await collect(st.finish(talk, SR, null, 'ctx', local.dictationBudget(talk, SR)));
  b = since(n1);
  const cont = b.filter((x) => opening(x)), fresh = b.filter((x) => !opening(x));
  check(`work while you talk (41 s): ${st.plan.steps} steps, ${cont.length} continuing an answer -- those with the text rule alone, the rest with the tag rule`,
    st.plan.steps >= 2 && cont.length >= 1 && cont.every((x) => /^language English<asr_text>/.test(opening(x)) && x.grammar === G.rest) &&
    fresh.every((x) => x.grammar === G.open), b.map((x) => (opening(x) ? 'cont:' : 'new:') + (x.grammar === G.rest ? 'rest' : x.grammar === G.open ? 'open' : 'none')));
  check('work while you talk: the text is dictate()\'s', got === want && got.split(' ').length > 30, { got: got.slice(-80), want: want.slice(-80) });

  // Models given their tag, and the switch: nothing changes.
  for (const [why, e] of [['a model given its tag (older than round 11)', env(given)], ['TYPD_LANG_GUARD=0', env(own, { TYPD_LANG_GUARD: '0' })]]) {
    local = freshLocal(e);
    await local.warm();
    n = sent.length;
    await collect(local.dictate(short, SR, null, 'ctx', 200));
    await collect(local.revise(short, SR, null, 'The meeting is on Monday.'));
    const st2 = local.openLong(null, () => 'ctx');
    for (let at = 0; at < talk.length; at += chunk) {
      st2.push(talk.slice(at, Math.min(talk.length, at + chunk)));
      for (let i = 0; i < 2000 && st2.timings.some((t) => t.ms === null); i++) await sleep(2);
    }
    await collect(st2.finish(talk, SR, null, 'ctx', local.dictationBudget(talk, SR)));
    b = since(n);
    check(`${why}: no grammar in any of its ${b.length} requests`, b.length >= 3 && b.every((x) => !('grammar' in x)), b.map((x) => x.grammar ? 'grammar' : '-'));
  }
  await fake.close();

  // A server that refuses the grammar, and one that refuses for another reason.
  let mode = 'grammar';
  const refusing = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"ok"}'); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      if (j.grammar && mode) {
        res.writeHead(mode === 'grammar' ? 400 : 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 400, message: mode === 'grammar' ? 'failed to parse grammar' : 'the request exceeds the available context size' } }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"language English<asr_text>Fine."}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((r) => refusing.listen(0, '127.0.0.1', r));
  const rport = refusing.address().port;
  local = freshLocal({ ...env(own), TYPD_LLAMA_PORT: String(rport) });
  await local.warm();
  mode = 'other';
  n = sent.length;
  let err = null;
  try { await collect(local.dictate(short, SR, null, 'ctx', 200)); } catch (e) { err = e; }
  b = since(n);
  check('a refusal for another reason: the error it always was, sent once', err && /refused the audio \(500\)/.test(err.message) && b.length === 1, { err: err && err.message, sent: b.length });
  mode = 'grammar';
  n = sent.length;
  const t1 = await collect(local.dictate(short, SR, null, 'ctx', 200));
  b = since(n);
  check('a server that refuses the grammar: the same request again without it, and its text (no error)',
    t1 === 'Fine.' && b.length === 2 && b[0].grammar === G.open && !('grammar' in b[1]) &&
    JSON.stringify({ ...b[0], grammar: undefined }) === JSON.stringify(b[1]), { t1, sent: b.map((x) => x.grammar ? 'grammar' : '-') });
  n = sent.length;
  const t2 = await collect(local.dictate(short, SR, null, 'ctx', 200));
  b = since(n);
  check('... and no grammar from then on', t2 === 'Fine.' && b.length === 1 && !('grammar' in b[0]));
  await new Promise((r) => refusing.close(r));
}

/* -------------------------------------------- 3. the real model, on the CPU */

function getJson(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 3000, agent: false }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    if (port !== TYPD_PORT && !(await getJson(port, '/health'))) return port;
  }
}
function readWav(file) {
  const b = fs.readFileSync(file);
  let off = 12;
  while (b.toString('ascii', off, off + 4) !== 'data') off += 8 + b.readUInt32LE(off + 4);
  const n = b.readUInt32LE(off + 4) / 2, s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = b.readInt16LE(off + 8 + 2 * i) / 32768;
  return s;
}
/** A FLAC from the research data, as 16 kHz samples (its Python and soundfile), or null. */
function readFlac(file) {
  const py = path.join(RESEARCH, '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(py) || !fs.existsSync(file)) return null;
  try {
    const out = execFileSync(py, ['-I', '-c', 'import sys,soundfile as sf,numpy as np;w,sr=sf.read(sys.argv[1],dtype="float32");assert sr==16000 and w.ndim==1;sys.stdout.buffer.write(w.astype(np.float32).tobytes())', file], { maxBuffer: 1 << 27 });
    return new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.length));
  } catch { return null; }
}

async function modelTests() {
  section('3. the real model on the CPU (vendor/llama, -ngl 0, CUDA hidden)');
  const dir = GIVEN.TYPD_GUARD_BENCH_MODEL || path.join(RESEARCH, 'models', 'try', 'p2d');
  const server = GIVEN.TYPD_LLAMA_SERVER || (process.platform === 'darwin'
    ? path.join(ROOT, 'vendor', 'llama-mac', process.arch === 'arm64' ? 'arm64' : 'x64', 'llama-server')
    : path.join(ROOT, 'vendor', 'llama', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'));
  let spec = null;
  try { spec = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8')); } catch { /* absent */ }
  if (!spec || spec.prefill !== '' || !fs.existsSync(path.join(dir, spec.model)) || !fs.existsSync(server)) {
    console.log('  skip: no model that writes its own tag at ' + dir + ' (or no llama-server)');
    return;
  }
  const port = await freePort();
  const local = freshLocal({ TYPD_MODEL_DIR: dir, TYPD_LLAMA_PORT: String(port), TYPD_LLAMA_SERVER: server, TYPD_GPU_LAYERS: '0', CUDA_VISIBLE_DEVICES: '-1', TYPD_LLAMA_THREADS: String(Math.max(2, Math.min(8, os.cpus().length - 2))) });
  const t0 = Date.now();
  await local.warm();   // the self-test: a guarded request, the fixture heard
  console.log(`  (${path.basename(dir)} up and self-tested in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const G = local.languageGuard;
  const barred = new RegExp('[' + G.scripts + ']', 'u');
  const fx = readWav(FIXTURE);
  let n = sent.length;
  const t = await collect(local.dictate(fx, SR, null, '', local.dictationBudget(fx, SR)));
  let b = since(n);
  check('the server parses the grammar: the test clip with it, heard', b.length === 1 && b[0].grammar === G.open && local.selfTestPasses(t), t);
  const cv = path.join(RESEARCH, 'data', 'rs', 'cvss_eval_audio');
  const clips = [['cv_76321', /\b20\b/i], ['cv_77856', /piano/i], ['cv_77995', /know/i]];
  for (const [id, want] of clips) {
    const s = readFlac(path.join(cv, id + '.flac'));
    if (!s) { console.log('  skip ' + id + ' (research data absent)'); continue; }
    n = sent.length;
    const out = await collect(local.dictate(s, SR, null, '', local.dictationBudget(s, SR)));
    b = since(n);
    check(`${id} (P2d unguarded: Japanese) -> ${JSON.stringify(out)}: English`, b.length === 1 && b[0].grammar === G.open && !barred.test(out) && want.test(out), out);
  }
  const fl = path.join(RESEARCH, 'data', 'fleurs_tr', 'eval', 'audio', 'fleurs_tr_test_10153339660659037735.flac');
  const s = readFlac(fl);
  if (s) {
    const out = await collect(local.dictate(s, SR, null, '', local.dictationBudget(s, SR)));
    check(`FLEURS Turkish -> ${JSON.stringify(out.slice(0, 60))}...: still Turkish`, /[şğıİ]/.test(out) && /Samoa/.test(out), out);
  } else console.log('  skip FLEURS Turkish (research data absent)');
  local.stop();
}

(async () => {
  const local = freshLocal({});
  letterTests(local);
  await bodyTests();
  if (!process.argv.includes('--no-model')) await modelTests();
  console.log('\n' + (failures ? failures + ' FAILED' : 'all passed'));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* in use */ }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
