'use strict';

/**
 * The revise adapter (model.json "revise_lora", src/main/pipeline/local.js), headless.
 *
 *   1. No model needed: local.js reuses a fake llama-server, and every request it makes is read
 *      on its way out. With the adapter loaded, every request names its scale -- 1 for a revise,
 *      0 for dictation, the self-test's kind of request, the ping and the primed pieces. A server
 *      without the adapter, and a model.json without revise_lora, get no "lora" field at all:
 *      the request body is what it was before adapters.
 *   2. With the model files on this machine: the real llama-server, on the CPU (CUDA hidden,
 *      -ngl 0) and a free port (never Typd's 8737), started by local.js with the adapter. The
 *      self-test, a dictation and a revise go through local.js's own body builder; each body's
 *      "lora" field is checked, and the server's /slots shows the scale it applied. A second
 *      local.js reuses that server and finds the adapter in it. Then an adapter the server
 *      cannot load: local.js starts the server without it, and the dictation is the same text as
 *      with the adapter loaded at scale 0. Skipped when the files are absent (CI).
 *
 *   node bench/lora.js              both parts (npm run bench:lora; ~20 s on a laptop CPU)
 *   node bench/lora.js --no-model   part 1 only (part of npm run bench)
 *
 * Part 2's files, defaults in brackets:
 *   TYPD_LLAMA_SERVER        llama-server [vendor/llama/llama-server.exe; vendor/llama-mac/<arch>/llama-server]
 *   TYPD_LORA_BENCH_MODEL    a folder whose model.json names the model and mmproj [models/typd-dictate]
 *   TYPD_LORA_BENCH_ADAPTER  the adapter [that folder's revise_lora if it names one, else
 *                            ../dictation-research/models/lora/r27rev_r128/r27rev_r128-f16.gguf]
 * Everything else runs in a throwaway folder (hard links to the model files, no copies).
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'dictation-3s.wav');
const TYPD_PORT = 8737;
const GIVEN = { ...process.env };   // freshLocal() rewrites the env local.js reads; part 2's settings are read from this

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
}
const section = (s) => console.log('\n' + s);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-lora-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every completion request local.js sends, parsed, captured as it leaves (local.js calls
// http.request through the module object, so this sees exactly what the server is sent).
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
const loraOf = (b) => ('lora' in b ? JSON.stringify(b.lora) : 'none');
const isRevise = (b) => /^Revise the highlighted text/.test(b.messages[0].content);

/** A new local.js module, reading `env` at load as the app's would (port, model folder, server). */
const instances = [];
function freshLocal(env) {
  for (const k of ['TYPD_MODEL_DIR', 'TYPD_LLAMA_PORT', 'TYPD_LLAMA_SERVER', 'TYPD_GPU_LAYERS', 'TYPD_SELFTEST', 'CUDA_VISIBLE_DEVICES']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../src/main/pipeline/local')];
  const local = require('../src/main/pipeline/local');
  instances.push(local);
  return local;
}
process.on('exit', () => { for (const l of instances) { try { l.stop(); } catch { /* gone */ } } });

async function text(gen) {
  let t = '';
  for await (const x of gen) t = x;
  return t.trim();
}

function getJson(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000, agent: false }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** A port nothing listens on, and never Typd's own. */
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

/* ------------------------------------------------- 1. a fake llama-server */

function fakeLlama() {
  const s = { adapters: [] };
  s.server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"ok"}'); }
    if (req.url === '/lora-adapters') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(s.adapters)); }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      let stream = false;
      try { stream = Boolean(JSON.parse(b).stream); } catch { /* answer anyway */ }
      if (!stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"choices":[{"message":{"content":""}}]}'); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"Fine."}}]}\n\ndata: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => { s.port = s.server.address().port; resolve(s); }));
}

function modelDir(name, spec, files) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(spec));
  return dir;
}

async function fakeTests() {
  const fake = await fakeLlama();
  const server = path.join(tmp, 'llama-server-never-started');
  fs.writeFileSync(server, '');
  const spec = { model: 'm.gguf', mmproj: 'p.gguf', context: true, revise: true, stream: true, prefill: '' };
  const withLora = modelDir('fake-lora', { ...spec, revise_lora: 'rev.gguf' }, ['m.gguf', 'p.gguf', 'rev.gguf']);
  const noLora = modelDir('fake-plain', spec, ['m.gguf', 'p.gguf']);
  const env = (dir) => ({ TYPD_MODEL_DIR: dir, TYPD_LLAMA_PORT: String(fake.port), TYPD_LLAMA_SERVER: server });
  const audio = new Float32Array(16000 * 2).map((_, i) => 0.1 * Math.sin(i / 7));

  /** Every kind of request local.js makes; returns the bodies. */
  async function everyRequest(local) {
    const n = sent.length;
    await text(local.dictate(audio, 16000, null, 'ctx', 200));                      // a dictation
    await text(local.revise(audio, 16000, null, 'The meeting is on Monday.'));      // a revise
    await local.transcribe(audio, 16000, null);                                      // revise's cloud path: the instruction
    local.ping('ctx');                                                               // the wake-up ping
    for (let i = 0; i < 50 && sent.length < n + 4; i++) await sleep(20);
    const st = local.openStream(null, () => 'ctx');                                 // streamed pieces, primed, then finished
    const long = new Float32Array(16000 * 9).map((_, i) => 0.1 * Math.sin(i / 5));
    st.push(long);
    await text(st.finish(long, 16000, null, 'ctx', 200));
    return { bodies: since(n), primed: st.cuts.length };
  }

  section('1. request bodies (a fake llama-server; no model)');
  fake.adapters = [{ id: 0, path: path.join(withLora, 'rev.gguf'), scale: 1, task_name: '', prompt_prefix: '' }];
  let local = freshLocal(env(withLora));
  await local.warm();
  check('the reused server has our adapter: local.js knows it', local.REVISE_ADAPTER === path.join(withLora, 'rev.gguf'), local.REVISE_ADAPTER);
  let { bodies, primed } = await everyRequest(local);
  const kinds = bodies.map((b) => (isRevise(b) ? 'revise' : b.stream ? 'stream' : 'one-token') + ':' + loraOf(b));
  check('every kind of request: dictation, revise, transcribe, ping, primed pieces, finish', primed >= 1 && bodies.length === 5 + primed, kinds);
  check('every request names the adapter\'s scale', bodies.every((b) => Array.isArray(b.lora) && b.lora.length === 1 && b.lora[0].id === 0), kinds);
  check('scale 1 for the revise and only for it', bodies.every((b) => b.lora[0].scale === (isRevise(b) ? 1 : 0)) && bodies.filter(isRevise).length === 1, kinds);
  check('the revise request is the trained prompt with the span', bodies.some((b) => isRevise(b) && b.messages[0].content.includes('<highlighted_text>\nThe meeting is on Monday.\n</highlighted_text>')));

  fake.adapters = [{ id: 0, path: '/somewhere/else/other.gguf', scale: 0 }, { id: 1, path: path.join(withLora, 'rev.gguf'), scale: 0 }];
  local = freshLocal(env(withLora));
  await local.warm();
  ({ bodies } = await everyRequest(local));
  check('our adapter at id 1 (a server with two): id 1 is the one switched', bodies.every((b) => b.lora.length === 1 && b.lora[0].id === 1 && b.lora[0].scale === (isRevise(b) ? 1 : 0)), bodies.map(loraOf));

  for (const [why, adapters] of [['a reused server started without it (it would not load)', []], ['a reused server with someone else\'s adapter', [{ id: 0, path: '/x/other.gguf', scale: 1 }]]]) {
    fake.adapters = adapters;
    local = freshLocal(env(withLora));
    await local.warm();
    ({ bodies } = await everyRequest(local));
    check(why + ': no "lora" field anywhere', local.REVISE_ADAPTER === null && bodies.length >= 6 && bodies.every((b) => !('lora' in b)), bodies.map(loraOf));
  }

  fake.adapters = [{ id: 0, path: path.join(withLora, 'rev.gguf'), scale: 1 }];
  local = freshLocal(env(noLora));
  await local.warm();
  ({ bodies } = await everyRequest(local));
  // 0.2.10's language guard adds "grammar" to every request but the revise (bench/lang-guard.js).
  const keys = bodies.map((b) => Object.keys(b).filter((k) => k !== 'grammar').join(','));
  check('model.json without revise_lora: no "lora" field, the body keys as before (+ the language guard’s grammar, never on the revise)',
    local.REVISE_ADAPTER === null && bodies.every((b) => !('lora' in b)) && bodies.every((b) => ('grammar' in b) === !isRevise(b)) &&
    keys.every((k) => k === 'messages,temperature,cache_prompt,stream,max_tokens' || k === 'messages,temperature,cache_prompt,max_tokens'), bodies.map((b) => Object.keys(b).join(',')));

  fs.rmSync(path.join(withLora, 'rev.gguf'));
  local = freshLocal(env(withLora));
  await local.warm();
  ({ bodies } = await everyRequest(local));
  check('the adapter file missing: no "lora" field (revise runs on the base model)', local.REVISE_ADAPTER === null && bodies.every((b) => !('lora' in b)), bodies.map(loraOf));
  fake.server.close();
}

/* ------------------------------------------ 2. the real server, on the CPU */

function defaultServer() {
  if (process.platform === 'darwin') return path.join(ROOT, 'vendor', 'llama-mac', process.arch === 'arm64' ? 'arm64' : 'x64', 'llama-server');
  return path.join(ROOT, 'vendor', 'llama', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
}

/** The files part 2 needs, or the reason it cannot run. */
function realFiles() {
  const server = GIVEN.TYPD_LLAMA_SERVER || defaultServer();
  const src = GIVEN.TYPD_LORA_BENCH_MODEL || path.join(ROOT, 'models', 'typd-dictate');
  let spec;
  try { spec = JSON.parse(fs.readFileSync(path.join(src, 'model.json'), 'utf8')); } catch { return { skip: 'no model.json in ' + src }; }
  const named = spec.revise_lora && path.join(src, spec.revise_lora);
  const adapter = GIVEN.TYPD_LORA_BENCH_ADAPTER ||
    (named && fs.existsSync(named) ? named : path.join(ROOT, '..', 'dictation-research', 'models', 'lora', 'r27rev_r128', 'r27rev_r128-f16.gguf'));
  const files = { server, model: path.join(src, String(spec.model)), mmproj: path.join(src, String(spec.mmproj)), adapter, fixture: FIXTURE };
  const missing = Object.entries(files).filter(([, f]) => !fs.existsSync(f));
  if (missing.length) return { skip: 'missing ' + missing.map(([k, f]) => k + ' (' + f + ')').join(', ') };
  return { ...files, spec };
}

/** A model folder of hard links (symlinks if those fail) to the real files; model.json names `lora`. */
function linkedDir(name, f, lora) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const put = (from, to) => {
    try { fs.linkSync(from, to); } catch { fs.symlinkSync(from, to); }
  };
  put(f.model, path.join(dir, path.basename(f.model)));
  put(f.mmproj, path.join(dir, path.basename(f.mmproj)));
  if (lora.from) put(lora.from, path.join(dir, lora.name));
  else fs.writeFileSync(path.join(dir, lora.name), lora.bytes);
  const spec = { ...f.spec, model: path.basename(f.model), mmproj: path.basename(f.mmproj), revise: true, revise_lora: lora.name };
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(spec, null, 2));
  return dir;
}

/** 16-bit PCM WAV -> {samples, rate}. */
function readWav(file) {
  const b = fs.readFileSync(file);
  let off = 12, fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4), at = off + 8;
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(at + 2), rate: b.readUInt32LE(at + 4), bits: b.readUInt16LE(at + 14) };
    if (id === 'data' && fmt && fmt.bits === 16) {
      const n = Math.floor(size / 2 / fmt.channels), samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = b.readInt16LE(at + i * 2 * fmt.channels) / 32768;
      return { samples, rate: fmt.rate };
    }
    off = at + size + (size & 1);
  }
  throw new Error(file + ': not 16-bit PCM');
}

async function realTests() {
  section('2. the real llama-server, on the CPU (CUDA hidden), with the adapter');
  const f = process.argv.includes('--no-model') ? { skip: '--no-model' } : realFiles();
  if (f.skip) { console.log('  skipped: ' + f.skip); return; }
  console.log('  server  ' + f.server + '\n  model   ' + f.model + '\n  adapter ' + f.adapter + ' (' + (fs.statSync(f.adapter).size / 1048576).toFixed(0) + ' MiB)');
  const { samples, rate } = readWav(f.fixture);
  const span = 'The train to the airport leaves at nine on Saturday.';
  const port = await freePort();
  const dir = linkedDir('real', f, { name: path.basename(f.adapter), from: f.adapter });
  const env = (d, p) => ({ TYPD_MODEL_DIR: d, TYPD_LLAMA_PORT: String(p), TYPD_LLAMA_SERVER: f.server, TYPD_GPU_LAYERS: '0', CUDA_VISIBLE_DEVICES: '-1' });
  const slotLora = async (p) => { const s = await getJson(p, '/slots'); return JSON.stringify(s && s[0] && s[0].params && s[0].params.lora); };

  // A: local.js starts the server with the adapter; the self-test runs inside warm().
  const a = freshLocal(env(dir, port));
  let n = sent.length, t0 = Date.now();
  await a.warm();
  const warmBodies = since(n);
  console.log(`  started and self-tested on port ${port} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const listed = await getJson(port, '/lora-adapters');
  check('the server loaded the adapter (--lora): /lora-adapters lists it at id 0',
    Array.isArray(listed) && listed.length === 1 && listed[0].id === 0 && path.basename(String(listed[0].path)) === path.basename(f.adapter), listed);
  check('local.js knows it is on', a.REVISE_ADAPTER === path.join(dir, path.basename(f.adapter)), a.REVISE_ADAPTER);
  check('the self-test ran at scale 0 (and passed: warm() resolved)', warmBodies.length >= 1 && warmBodies.every((b) => loraOf(b) === '[{"id":0,"scale":0}]'), warmBodies.map(loraOf));
  check('/slots: the server applied scale 0', (await slotLora(port)) === '[{"id":0,"scale":0}]', await slotLora(port));

  n = sent.length; t0 = Date.now();
  const dictated = await text(a.dictate(samples, rate, null, '', a.dictationBudget(samples, rate)));
  console.log(`  dictation (${((Date.now() - t0) / 1000).toFixed(1)} s): ${JSON.stringify(dictated)}`);
  check('dictation: scale 0 in the body and on the server, and the right words', since(n).map(loraOf).join() === '[{"id":0,"scale":0}]' &&
    (await slotLora(port)) === '[{"id":0,"scale":0}]' && a.selfTestPasses(dictated), since(n).map(loraOf));

  n = sent.length; t0 = Date.now();
  const revised = await text(a.revise(samples, rate, null, span));
  console.log(`  revise    (${((Date.now() - t0) / 1000).toFixed(1)} s): ${JSON.stringify(revised)}`);
  check('revise: scale 1 in the body and on the server, an answer back', since(n).map(loraOf).join() === '[{"id":0,"scale":1}]' &&
    (await slotLora(port)) === '[{"id":0,"scale":1}]' && revised.length > 0, { bodies: since(n).map(loraOf), slot: await slotLora(port) });

  n = sent.length;
  a.ping('');
  const again = await text(a.dictate(samples, rate, null, '', a.dictationBudget(samples, rate)));   // waits behind the ping (one slot)
  check('ping, then dictation again: both scale 0; the same text as before the revise', since(n).map(loraOf).join('|') === '[{"id":0,"scale":0}]|[{"id":0,"scale":0}]' &&
    again === dictated, { bodies: since(n).map(loraOf), again });

  // B: another local.js finds A's server on the port (a crashed run's, say) and reuses it.
  const b = freshLocal(env(dir, port));
  await b.warm();
  n = sent.length;
  const revisedB = await text(b.revise(samples, rate, null, span));
  check('a reused server: its /lora-adapters say the adapter is in; revise at scale 1, the same text',
    b.REVISE_ADAPTER === a.REVISE_ADAPTER && since(n).map(loraOf).join() === '[{"id":0,"scale":1}]' && revisedB === revised, { adapter: b.REVISE_ADAPTER, bodies: since(n).map(loraOf), revisedB });
  a.stop();
  for (let i = 0; i < 50 && (await getJson(port, '/health')); i++) await sleep(100);

  // C: an adapter the server cannot load (cut short): local.js starts it without, revise still works.
  const bytes = fs.readFileSync(f.adapter).subarray(0, 4 * 1048576);
  const port2 = await freePort();
  const broken = linkedDir('broken', f, { name: 'cut-short-lora.gguf', bytes });
  const c = freshLocal(env(broken, port2));
  n = sent.length; t0 = Date.now();
  await c.warm();
  console.log(`  broken adapter: up and self-tested in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check('a broken adapter: the server came up without it (/lora-adapters empty), self-test passed, no "lora" field',
    c.REVISE_ADAPTER === null && JSON.stringify(await getJson(port2, '/lora-adapters')) === '[]' && since(n).length >= 1 && since(n).every((x) => !('lora' in x)),
    { adapter: c.REVISE_ADAPTER, bodies: since(n).map(loraOf) });
  n = sent.length;
  const plain = await text(c.dictate(samples, rate, null, '', c.dictationBudget(samples, rate)));
  const plainRevise = await text(c.revise(samples, rate, null, span));
  check('without the adapter: dictation is the same text as with it loaded at scale 0', plain === dictated, { plain, dictated });
  check('without the adapter: revise still answers, no "lora" field', plainRevise.length > 0 && since(n).every((x) => !('lora' in x)));
  console.log(`  revise without the adapter: ${JSON.stringify(plainRevise)}${plainRevise === revised ? ' (same as with it)' : ''}`);
  c.stop();
}

/* -------------------------------------------------------------------- run */

(async () => {
  await fakeTests();
  await realTests();
})().catch((e) => { failures++; console.log('  FAIL  ' + (e && e.stack)); }).finally(() => {
  for (const l of instances) { try { l.stop(); } catch { /* gone */ } }
  setTimeout(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a file still held open: the OS cleans its temp folder */ }
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
  }, 500);
});
