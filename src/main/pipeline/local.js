'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const { once } = require('events');
const { spawn } = require('child_process');
const { activeModel, versionOf } = require('../modelUpdate');
const long = require('./long');
const vocab = require('./vocab');

/**
 * The single dictation model: audio in, finished writing out, on this machine.
 *
 * Qwen3-ASR-0.6B with its language model fine-tuned to write what the speaker
 * meant rather than what they said -- fillers gone, self-corrections resolved,
 * lists, spoken commands and numbers written properly. One model replaces
 * Parakeet plus the cleanup call. Measured on this laptop (RTX 3050 Ti, 4 GB):
 * ~0.2 s from end of speech to finished text on the GPU, ~0.9 s on the CPU, and
 * better text than Parakeet plus a fine-tuned cleanup model of the same size.
 * The research is in Documents/dictation-research.
 *
 * It runs in llama.cpp's server, kept resident for the life of the app, so the
 * model loads once during launch (~1.5 s) and never on a dictation. Nothing
 * leaves the machine.
 */

function root() {
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getAppPath === 'function') {
      return electron.app.getAppPath();
    }
  } catch {
    // not running under Electron
  }
  return process.cwd();
}

/*
 * Where the weights and the server live. In development: models/ and vendor/ in the
 * checkout. Packaged: outside app.asar, in the app's resources folder, because a native
 * process cannot be spawned from inside the archive and llama-server cannot read weights
 * through it (package.json build.extraResources puts them there):
 *   <resources>/models/typd-dictate/   model.json + the GGUF files it names (two, or three with a revise adapter)
 *   <resources>/llama/                 llama-server(.exe) and its libraries
 * macOS has one llama.cpp build per architecture (scripts/fetch-llama-mac.js): Metal on
 * Apple Silicon, CPU only on Intel. Windows, since 0.2.5: the CPU build, plus the CUDA backend
 * from the CUDA pack in <userData>/cuda/<pack>/ once it is there (cudaPack.js; see launch()).
 */
function packagedResources() {
  try {
    const electron = require('electron');
    if (electron && electron.app && electron.app.isPackaged) return process.resourcesPath;
  } catch {
    // not running under Electron
  }
  return null;
}
const RESOURCES = packagedResources();

function defaultServer() {
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  if (RESOURCES) return path.join(RESOURCES, 'llama', exe);
  if (process.platform === 'darwin') {
    return path.join(root(), 'vendor', 'llama-mac', process.arch === 'arm64' ? 'arm64' : 'x64', exe);
  }
  return path.join(root(), 'vendor', 'llama', exe);
}

// Packaged: the app's own model, or after a macOS app update (which installs the app exactly as
// signed, without its model) the copy kept from the version it replaced (src/main/carried.js).
const BUNDLED_DIR = RESOURCES
  ? (require('../carried').resource('models/typd-dictate') || path.join(RESOURCES, 'models', 'typd-dictate'))
  : path.join(root(), 'models', 'typd-dictate');
const SERVER = process.env.TYPD_LLAMA_SERVER || defaultServer();

function userData() {
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') return electron.app.getPath('userData');
  } catch {
    // not running under Electron
  }
  return null;
}
const USER_DATA = userData();
const USER_MODELS = USER_DATA ? path.join(USER_DATA, 'models') : null;

// The CUDA backend (Windows): bundled beside llama-server, or the CUDA pack installed in
// <userData>/cuda; nothing at all without <llama>/cuda.json (macOS, a source run). cudaPack.js.
const cuda = require('../cudaPack').createCuda({
  llamaDir: path.dirname(SERVER),
  packsDir: USER_DATA ? path.join(USER_DATA, 'cuda') : null,
  log: (...a) => { if (process.env.TYPD_DEBUG) console.log('[typd:cuda]', ...a); }
});

/**
 * Which model folder to load: TYPD_MODEL_DIR first (development and the eval tools, which
 * point it at any folder); then the downloaded version <userData>/models/current.json names,
 * if its folder is complete (src/main/modelUpdate.js puts it there); otherwise the model
 * bundled with the app. {dir, version}: version is null for anything not downloaded.
 */
function resolveModel({ env = process.env, modelsDir = USER_MODELS, bundled = BUNDLED_DIR } = {}) {
  if (env.TYPD_MODEL_DIR) return { dir: env.TYPD_MODEL_DIR, version: null };
  return (modelsDir && activeModel(modelsDir)) || { dir: bundled, version: null };
}
/*
 * model.json beside the weights says which files to load and what the model was
 * trained to do, so a better model is a drop-in: copy the files, edit the json.
 *   { "model": "...gguf", "mmproj": "...gguf", "context": true, "revise": true }
 * context -- it reads Typd's screen-context block for spelling names and identifiers.
 * revise  -- it applies a spoken instruction to highlighted text by itself.
 * stream  -- it was trained on audio in pause-split pieces, so the pieces can be
 *            sent while the user is still talking (see openStream).
 * revise_lora -- optional, with revise: a LoRA adapter file in the same folder that is switched
 *            on for revise requests only (dictation runs the base model, unchanged). See launch()
 *            and body(). A missing file, or one the server cannot load, means revise runs on the
 *            base model, as it does without the field.
 * A model without a flag is never sent that prompt: an untrained prompt is noise.
 */
function readSpec(dir) {
  const fallback = { model: 'typd-dictate-0.6b-q4_k_m.gguf', mmproj: 'mmproj-qwen3-asr-0.6b-q8_0.gguf', context: false, revise: false };
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8')) };
  } catch {
    return fallback;
  }
}

/** The revise adapter model.json names, as a path, or null (none named, or the model does not revise). */
function reviseLora(dir, spec) {
  return spec.revise && typeof spec.revise_lora === 'string' && spec.revise_lora ? path.join(dir, spec.revise_lora) : null;
}

// The model in use. Set at load, and again by switchModel() when a model update lands.
let MODEL_DIR, VERSION, SPEC, MODEL, MMPROJ, LORA, PREFILL;
function load(m = resolveModel()) {
  MODEL_DIR = m.dir;
  VERSION = m.version;
  SPEC = readSpec(MODEL_DIR);
  MODEL = path.join(MODEL_DIR, SPEC.model);
  MMPROJ = path.join(MODEL_DIR, SPEC.mmproj);
  LORA = reviseLora(MODEL_DIR, SPEC);
  // The fine-tuning prompt, exactly: an empty system turn, the audio, and the
  // assistant turn opened with the language tag. Anything else is a prompt the
  // model never saw in training.
  //
  // Models up to round 10 were always told "English" here, which made Turkish come
  // out misspelt or translated. From round 11 the model writes the tag itself
  // ("language Turkish<asr_text>..."); their model.json says "prefill": "" and the
  // tag is stripped from what is shown.
  PREFILL = typeof SPEC.prefill === 'string' ? SPEC.prefill : 'language English<asr_text>';
}
load();

// The revise prompt the model was trained with, word for word.
const REVISE_SYSTEM = 'Revise the highlighted text by following the spoken instruction. ' +
  'Output only the replacement text.\n<highlighted_text>\n{span}\n</highlighted_text>';

// Screen context costs prompt time on every dictation; the tail nearest the caret
// carries the vocabulary that matters, and the model was trained on <=1500 chars.
const MAX_CONTEXT = 1500;

function contextPrompt(block) {
  if (!SPEC.context || !block) return '';
  if (block.length <= MAX_CONTEXT + 200) return block;
  // Keep the app and title lines; trim the visible text from the front.
  return block.replace(/(<visible_text[^>]*>\n)([\s\S]*)(\n<\/visible_text>)/, (m, open, text, close) =>
    open + '…' + text.slice(text.length - MAX_CONTEXT) + close);
}

function revisePrompt(span) {
  return REVISE_SYSTEM.replace('{span}', span);
}
const PORT = Number(process.env.TYPD_LLAMA_PORT || 8737);

let proc = null;
let starting = null;
let startError = null;
let stopping = null;      // a switch is taking the old server down; warm() waits for it
const warmListeners = [];

/*
 * The revise adapter (model.json "revise_lora") the running server has loaded: {file, id}, or
 * null. llama-server loads it at start, switched off (--lora-init-without-apply), and body() names
 * its scale in every request: 1 for a revise, 0 for everything else, so dictation, the self-test,
 * the ping and the primed pieces run the base model, bit for bit. Measured on llama.cpp 631109b34
 * (dictation-research LOG.md, 2026-10-15): with an adapter loaded, a request without the field
 * runs at whatever scale earlier requests left, so none may leave it out; a change of scale drops
 * the prompt cache (a revise's prompt is new anyway). --lora-scaled is not used: it cannot parse
 * an absolute Windows path.
 */
let adapter = null;

function debug(...args) {
  if (process.env.TYPD_DEBUG) console.log('[typd:local]', ...args);
}

function health() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 1000, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Has the server on PORT -- one this run did not start -- loaded the adapter `file`? {file, id},
 * or null: it may have been started without it (the adapter would not load), or by an eval tool.
 */
function loadedAdapter(file) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/lora-adapters', timeout: 2000, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let list = null;
        try { list = JSON.parse(text); } catch { /* not a list: none */ }
        const hit = Array.isArray(list) && list.find((a) => a && Number.isInteger(a.id) && path.basename(String(a.path)) === path.basename(file));
        resolve(hit ? { file, id: hit.id } : null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/*
 * The self-test. On a Mac in CI (run 38462461381) the Metal build of llama-server loaded the
 * 1.7B model and answered "8888..." where the CPU build wrote the sentence: a GPU path can be
 * wrong without crashing, and only a crash used to send Typd to the CPU. So every warm start
 * -- at launch, and after each model switch -- ends with the CI smoke test's clip
 * (test/fixtures/dictation-3s.wav, 3.6 s, shipped inside the app) transcribed by the server
 * just started. Wrong text on the GPU: restart on the CPU (-ngl 0) and test again; if that
 * passes, <userData>/models/gpu.json remembers it, so this model starts on the CPU from then on
 * (until the app is updated, which may bring a llama.cpp that fixes the GPU). Wrong on the CPU
 * too: the model failed, and warm() rejects -- modelUpdate.js reverts a model it has just
 * installed. It runs inside warm(), which a dictation awaits, so it never runs during one.
 * TYPD_SELFTEST=0 skips it; an explicit TYPD_GPU_LAYERS is obeyed as given (tested, never changed).
 */
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'dictation-3s.wav');
// "Can you remind me what time the train to the airport leaves on Sunday?" -- its content words.
const FIXTURE_WORDS = ['remind', 'time', 'train', 'airport', 'leaves', 'sunday'];

/** Did the model hear the fixture? 3+ of its content words, and no character run past 20. */
function selfTestPasses(text) {
  const t = String(text || '').toLowerCase();
  if (/(.)\1{20,}/su.test(t)) return false;
  const words = new Set(t.match(/\p{L}+/gu) || []);
  return FIXTURE_WORDS.filter((w) => words.has(w)).length >= 3;
}

const where = (layers) => (String(layers) === '0' ? 'CPU' : 'GPU');

/**
 * Start the server and prove it -- the decision only: warm() supplies the real steps, the bench
 * fake ones. Starts with all layers on the GPU unless this model is remembered as CPU-only, or
 * `explicit` says otherwise. Returns {layers, tested}; throws if no path passes.
 */
async function bringUp({ explicit, remembered, serve, stopServer, test, remember, log = () => {}, enabled = true }) {
  let layers = await serve(explicit || (remembered ? '0' : '99'));
  if (!enabled) return { layers, tested: false };
  let r = await test();
  log(`self-test on the ${where(layers)}: ${r.ok ? 'passed' : 'FAILED'} ${JSON.stringify(String(r.text).slice(0, 80))}`);
  if (!r.ok && String(layers) !== '0' && !explicit) {
    await stopServer();
    layers = await serve('0');
    const cpu = await test();
    log(`self-test on the CPU: ${cpu.ok ? 'passed' : 'FAILED'} ${JSON.stringify(String(cpu.text).slice(0, 80))}`);
    if (cpu.ok) await remember({ gpuSaid: String(r.text).slice(0, 80) });
    r = cpu;
  }
  if (!r.ok) {
    await stopServer();
    throw new Error('The dictation model failed its self-test');
  }
  log(`path chosen: ${where(layers)} (-ngl ${layers})`);
  return { layers, tested: true };
}

function appVersion() {
  try { return require('../../../package.json').version; } catch { return '0.0.0'; }
}

/** Models that start straight on the CPU, by version (or file name, for the bundled one). */
const gpuMemory = {
  file: USER_MODELS ? path.join(USER_MODELS, 'gpu.json') : null,
  mem: {},
  all() {
    if (!this.file) return this.mem;
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch { return {}; }
  },
  get(id) {
    const e = this.all()[id];
    return e && e.layers === '0' && e.app === appVersion() ? e : null;
  },
  set(id, entry) {
    const all = { ...this.all(), [id]: { layers: '0', app: appVersion(), at: new Date().toISOString(), ...entry } };
    if (!this.file) { this.mem = all; return; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(all, null, 1));
      fs.renameSync(this.file + '.tmp', this.file);
      debug('remembered:', id, 'starts on the CPU from now on (' + this.file + ')');
    } catch (err) {
      debug('could not save', this.file, err && err.message);
    }
  }
};
const modelId = () => VERSION || path.basename(MODEL);

/*
 * The server's window, in tokens. 4,096 since 0.2.3 (2,048 before), for revisions of whole
 * dictations up to ~1,000 words (pipeline/index.js takes up to 6,000 characters): the selection is
 * in the prompt and written again in the answer. Dictation never needs more than ~2,000 (the worst
 * real piece, 71 s plus the longest screen context, is ~1,350 prompt tokens plus its output cap).
 * 8,192 was tried: on the real model, revisions past ~500 words came back as echoes or a few words
 * (dictation-research results/revise_long_check.log, 2026-10-17), so the room was not worth it.
 *
 * What it costs is the KV cache, allocated whole at start-up: both model sizes (Qwen3 0.6B and
 * 1.7B) have 28 layers with 8 KV heads of 128, so a token holds 2 x 28 x 8 x 128 = 57,344 values,
 * 60,928 bytes at q8_0 (34 bytes per 32 values): 119 MiB at 2,048 tokens, 238 MiB at 4,096, so
 * +119 MiB of VRAM (of RAM on the CPU path). Measured: 2,048 -> 3,072 +60 MiB (LOG.md,
 * 2026-10-05), 2,048 -> 8,192 +376 MiB on the 1.7B (results/revise_long_check.log), ~61 KiB a
 * token. Flash attention (on by default with CUDA and Metal) keeps the compute buffer flat.
 */
const CONTEXT = 4096;

/**
 * Where llama-server runs, and with which PATH. With the CUDA pack installed (cuda.dir()), in its
 * folder: ggml looks for backends beside the exe and then in the current directory, and Windows
 * resolves ggml-cuda.dll's own libraries (cuBLAS, the CUDA runtime) from there too -- the folder is
 * first on PATH as well. Otherwise in llama-server's own folder, so nothing in whatever directory
 * Typd was started from is ever picked up.
 */
function spawnOptions(dir = cuda.dir(), base = process.env, serverDir = path.dirname(SERVER)) {
  if (!dir) return { cwd: serverDir, env: base };
  const env = { ...base };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[key] = dir + path.delimiter + (env[key] || '');
  return { cwd: dir, env };
}

function launch(layers) {
  const run = spawnOptions();
  if (run.cwd !== path.dirname(SERVER)) debug('starting llama-server with the CUDA pack in', run.cwd);
  const child = spawn(SERVER, [
    '-m', MODEL, '--mmproj', MMPROJ,
    '--host', '127.0.0.1', '--port', String(PORT),
    '-ngl', String(layers),
    // Low memory with no measurable quality change (2026-10-05): 8-bit KV cache and smaller
    // micro-batches. The window is CONTEXT, above.
    '-c', String(CONTEXT), '-ctk', 'q8_0', '-ctv', 'q8_0', '-ub', '256', '-np', '1',
    '--cache-ram', '0',                           // no host prompt cache: every dictation is new audio
    // The built-in warm-up reserves ~550 MB for a 30 s audio window that a dictation never
    // needs at once; the self-test (or the silent request) warms it instead (1.76 -> 1.35 GB).
    '--no-warmup',
    '--no-webui',
    ...(adapter ? ['--lora', adapter.file, '--lora-init-without-apply'] : [])
  ], { windowsHide: true, cwd: run.cwd, env: run.env, stdio: ['ignore', 'ignore', process.env.TYPD_DEBUG ? 'inherit' : 'ignore'] });
  child.on('exit', (code) => {
    debug('server exited', code);
    if (proc === child) proc = null;
  });
  // A binary that cannot be executed (lost its executable bit, quarantined) emits
  // 'error' instead of 'exit'; unhandled, that would take the whole app down.
  child.on('error', (err) => {
    debug('server could not start:', err && err.message);
    if (proc === child) proc = null;
  });
  return child;
}

/** Launch with `layers` and wait until it answers; returns the layers it ended up on. */
async function serve(layers) {
  // On macOS a GPU that is present but refuses the work (Metal in a VM, say) kills the
  // server during load rather than falling back on its own; one retry on the CPU covers
  // it. Only for the default layer count: an explicit TYPD_GPU_LAYERS is obeyed as given.
  const cpuRetry = process.platform === 'darwin' && !process.env.TYPD_GPU_LAYERS;
  proc = launch(layers);
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    if (!proc && adapter) {
      // An adapter the server cannot load (corrupt, cut short, made for another model, no memory
      // left for it) takes the whole server down. Revise works without it, on the base model.
      debug('server died while loading with the revise adapter', path.basename(adapter.file) + '; starting without it (revise runs on the base model)');
      adapter = null;
      proc = launch(layers);
      continue;
    }
    if (!proc && cpuRetry && String(layers) !== '0') {
      debug('server died while loading on the GPU; retrying on the CPU');
      layers = '0';
      proc = launch(layers);
    }
    if (!proc) throw new Error('The dictation model failed to start');
    if (await health()) {
      debug('server up in', Date.now() - t0, 'ms on the', where(layers));
      return String(layers);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('The dictation model took too long to start');
}

/** Kill `child`, and wait until it has exited and the port is free. */
async function ended(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit').catch(() => {});
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    }
  }
  for (let i = 0; i < 40 && (await health()); i++) await new Promise((r) => setTimeout(r, 100));
}

/** The fixture through the server just started: {ok, text}. A dictation, so the revise adapter is off. */
async function selfTest() {
  const wav = fs.readFileSync(FIXTURE).toString('base64');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let text = '';
  try {
    for await (const t of ask([wav], ctrl.signal, '', 160)) text = t;
  } catch (err) {
    return { ok: false, text: 'error: ' + ((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
  return { ok: selfTestPasses(text), text };
}

/** Every warm start's outcome, {ok, error, dir, version}: modelUpdate.js listens. */
function onWarm(fn) { warmListeners.push(fn); }

/** Start the model server; wait until it answers and passes its self-test. Safe to call more than once. */
function warm() {
  if (starting) return starting;
  if (proc && !startError) return Promise.resolve();

  const loaded = { dir: MODEL_DIR, version: VERSION };
  const run = (async () => {
    startError = null;
    adapter = null;
    if (stopping) await stopping;
    // Once, before llama-server first starts: CUDA files beside it that are not this build's go.
    await cuda.prepare();
    for (const [what, file] of [['model', MODEL], ['audio projector', MMPROJ], ['llama-server', SERVER]]) {
      if (!fs.existsSync(file)) throw new Error(`Dictation ${what} missing at ${file}`);
    }
    const lora = LORA && fs.existsSync(LORA) ? LORA : null;
    if (LORA && !lora) debug('revise adapter missing at', LORA, '- revise runs on the base model');

    // A server left behind by a crashed run would hold the port; reuse it
    // rather than fail, since it is serving the same files.
    if (await health()) {
      if (lora) adapter = await loadedAdapter(lora);
      debug('reusing server on', PORT, '(left by an earlier run; not self-tested)' + (adapter ? ' with the revise adapter' : ''));
      return;
    }
    adapter = lora ? { file: lora, id: 0 } : null;

    const explicit = process.env.TYPD_GPU_LAYERS;
    const memo = explicit ? null : gpuMemory.get(modelId());
    if (memo) debug(modelId(), 'starts on the CPU: its GPU self-test failed on', memo.at);
    const t0 = Date.now();
    const r = await bringUp({
      explicit,
      remembered: Boolean(memo),
      serve,
      stopServer: async () => { const old = proc; proc = null; await ended(old); },
      test: selfTest,
      remember: (entry) => gpuMemory.set(modelId(), entry),
      log: debug,
      enabled: process.env.TYPD_SELFTEST !== '0' && fs.existsSync(FIXTURE)
    });
    if (!r.tested) await nudge('', 30000);   // the first dictation would otherwise pay for the warm-up
    debug('model', modelId(), 'ready in', Date.now() - t0, 'ms');
  })();
  starting = run
    .catch((err) => { startError = err; throw err; })
    .finally(() => { starting = null; });

  // warm() is called during launch and nobody awaits it there; a failure is
  // surfaced on the first dictation instead of as an unhandled rejection.
  const tell = (outcome) => setImmediate(() => {
    for (const fn of warmListeners) { try { fn({ ...outcome, ...loaded }); } catch { /* a listener's problem */ } }
  });
  starting.then(() => tell({ ok: true }), (error) => tell({ ok: false, error }));
  return starting;
}

/**
 * Load whatever model resolves now -- modelUpdate.js has just pointed current.json elsewhere --
 * by stopping the server, waiting for it to exit, and warming it on the new files (self-test
 * included). Resolves when it is ready; rejects if it does not start or fails the self-test.
 * The caller waits until no dictation is in progress; one that begins meanwhile waits in warm().
 * The same restart puts llama-server on the CUDA pack once it is installed (or back on the
 * processor after it was set aside): launch() reads cuda.dir() each time.
 */
async function switchModel() {
  if (starting) await starting.catch(() => {});
  const old = proc;
  proc = null;
  startError = null;
  stopping = ended(old).finally(() => { stopping = null; });
  load();
  debug('switching to', MODEL_DIR, VERSION ? `(${VERSION})` : '(bundled)');
  return warm();
}

function stop() {
  if (proc) {
    proc.kill();
    proc = null;
  }
}

/** Float32 PCM -> 16 kHz mono 16-bit WAV, the format the server's audio input takes. */
function toWav(samples, sampleRate) {
  let pcm = samples;
  if (sampleRate && sampleRate !== 16000) {
    const ratio = sampleRate / 16000;
    const n = Math.floor(samples.length / ratio);
    pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) pcm[i] = samples[Math.floor(i * ratio)];
  }
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

/**
 * Finished text for a recording, streamed. Yields cumulative text; the last value is the text.
 * Over long.LONG_S the recording is written in pieces joined through their seams (long.js).
 * `opts.hooks` -- {piece(i, text), seam(i, text, cut), join(i, how)} -- sees each piece, seam
 * and join as it is made (the eval tools record them).
 *
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {AbortSignal} [signal]
 * @returns {AsyncGenerator<string>}
 */
async function* dictate(samples, sampleRate, signal, system = '', maxTokens = 1024, opts = {}) {
  const sr = sampleRate || 16000;
  if (samples.length / sr <= long.LONG_S) {
    yield* decodeOne(samples, sr, signal, system, maxTokens);
    return;
  }
  yield* dictateLong(samples, sr, signal, system, null, opts.hooks || null);
}

/** One request's worth of audio to text, streamed, then the dictionary check (vocab.js). */
async function* decodeOne(samples, sr, signal, system, maxTokens) {
  const parts = [toWav(samples, sr).toString('base64')];
  const info = {};
  let text = '';
  for await (const t of dictateParts(parts, signal, system, maxTokens, false, { info })) {
    text = t;
    yield t;
  }
  if (signal && signal.aborted) return;
  const checked = await checkTerms(parts, system, info, text, signal);
  if (checked !== text) yield checked;
}

const pieceKey = (c) => 'piece:' + c.start + ':' + c.end;
const seamKey = (c) => 'seam:' + c.seamFrom + ':' + c.from + ':' + c.to + ':' + c.seamTo;

/**
 * A long recording, piece by piece. `cache` (openLong's) holds pieces and seams already written
 * while the user talked, by audio range: those are awaited, never written twice; the rest are
 * written here, after anything still in flight (one request on the server at a time). Seam i is
 * written before piece i + 1, as the pieces arrive.
 */
async function* dictateLong(samples, sr, signal, system, cache, hooks) {
  const { pieces, cuts } = long.splitLong(samples, sr);
  let waited = false;
  // Yields partial text while it writes; its last value is the whole text.
  async function* textOf(key, kind, index, audio) {
    const job = cache && cache.take(key, system);
    if (job) {
      const r = await job;
      if (r && typeof r.text === 'string') { yield r.text; return; }
      debug('early', kind, index, 'failed (' + (r && r.error) + '); writing it now');
    }
    if (cache && !waited) { await cache.idle(); waited = true; }
    const t0 = Date.now();
    let text = '';
    for await (const t of decodeOne(audio, sr, signal, system, dictationBudget(audio, sr))) { text = t; yield t; }
    if (cache) cache.timings.push({ kind, index, phase: 'finish', ms: Date.now() - t0 });
    if (!text) yield '';
  }

  let done = '';
  for (let p = 0; p < pieces.length; p++) {
    let seam = null;
    if (p > 0) {
      const c = cuts[p - 1];
      for await (const t of textOf(seamKey(c), 'seam', p - 1, long.seamAudio(samples, sr, c))) seam = t;
      if (signal && signal.aborted) return;
      if (hooks && hooks.seam) hooks.seam(p - 1, seam, c);
    }
    // Partials are progress for the pill only; the joins are made once each piece is whole.
    const key = p < cuts.length ? pieceKey(cuts[p]) : 'piece:last';
    let part = '';
    for await (const t of textOf(key, 'piece', p, pieces[p])) {
      part = t;
      yield done ? done + ' ' + part : part;
    }
    if (signal && signal.aborted) return;
    if (hooks && hooks.piece) hooks.piece(p, part);
    if (p === 0) {
      done = part;
    } else {
      const j = long.stitch(done, part, seam, long.seamAt(cuts[p - 1]));
      debug('join', p, j.how, JSON.stringify(seam ? seam.slice(0, 160) : null));
      if (hooks && hooks.join) hooks.join(p - 1, j.how, j.text.length);
      done = j.text;
    }
    yield done;
  }
}

/**
 * Write a long dictation while the user is still talking. The model takes pieces of 45-70 s
 * (long.js); 0.2.2 wrote them all after the key was released, so a 600 s dictation waited 21.7 s
 * for its text (dictation-research reports/dogfood_audit_2026-10-16.md). Now each cut is settled
 * as soon as the audio passes its window and seam (70 + 9 s into the piece), and its piece and
 * seam are written in the background, one request at a time; on release only what follows the
 * last settled cut is left: at most ~79 s of audio and one seam.
 *
 * The cuts are long.splitLong's, made causally, so the pieces written early are exactly the
 * pieces the whole recording gives; finish() looks them up by audio range and prompt and writes
 * whatever it cannot find. Nothing is pasted until finish() has joined everything; a cancelled
 * session's signal stops the request in flight and every one after it.
 *
 * @param {AbortSignal} signal   the session's
 * @param {() => string} system  the prompt, read when each piece is sent
 */
function openLong(signal, system) {
  let buf = new Float32Array(SR * 90);
  let len = 0;
  let closed = false;
  const splitter = new long.Splitter(SR);
  const jobs = new Map();
  const timings = [];
  let chain = Promise.resolve();

  function schedule(key, kind, index, audio) {
    const sys = system();
    const t = { kind, index, phase: 'early', availableS: len / SR, ms: null };
    timings.push(t);
    const promise = chain.then(async () => {
      if (signal && signal.aborted) { t.ms = 0; return { error: 'cancelled' }; }
      const t0 = Date.now();
      t.startS = len / SR;
      try {
        let text = '';
        for await (const x of decodeOne(audio, SR, signal, sys, dictationBudget(audio, SR))) text = x;
        if (signal && signal.aborted) return { error: 'cancelled' };
        return { text };
      } catch (err) {
        return { error: (err && err.message) || String(err) };
      } finally {
        t.ms = Date.now() - t0;
      }
    });
    chain = promise;
    jobs.set(key, { sys, promise });
  }

  return {
    /** Float32 mono at 16 kHz, in capture order. */
    push(samples) {
      if (closed || (signal && signal.aborted)) return;
      if (len + samples.length > buf.length) {
        // Views handed to jobs keep the old buffer, which is never written again.
        const grown = new Float32Array(Math.max(buf.length * 2, len + samples.length));
        grown.set(buf.subarray(0, len));
        buf = grown;
      }
      buf.set(samples, len);
      len += samples.length;
      if (len <= long.LONG_S * SR) return;
      for (const c of splitter.feed(buf, len)) {
        const i = splitter.cuts.length - 1;
        debug('early: cut', i, 'settled at', (len / SR).toFixed(1), 's; piece', (c.start / SR).toFixed(1), '-', (c.end / SR).toFixed(1), 's');
        schedule(pieceKey(c), 'piece', i, buf.subarray(c.start, c.end));
        schedule(seamKey(c), 'seam', i, long.seamAudio(buf, SR, c));
      }
    },

    /** Finished text for the whole recording: `samples` is the complete capture. */
    async* finish(samples, sampleRate, sig, sys, maxTokens = 1024) {
      closed = true;
      if (!jobs.size || sampleRate !== SR) {
        await chain;
        yield* dictate(samples, sampleRate, sig, sys, maxTokens);
        return;
      }
      // What was written early must be of this very audio: the capture is the chunks, in order.
      let same = samples.length >= len;
      for (let i = 0; same && i < len; i++) if (samples[i] !== buf[i]) same = false;
      if (!same) debug('early: the capture differs from the chunks; writing it all now');
      debug('early:', jobs.size, 'requests settled while talking;', ((samples.length - splitter.start) / SR).toFixed(1), 's after the last cut');
      const cache = {
        take: (key, prompt) => {
          const j = same && jobs.get(key);
          return j && j.sys === prompt ? j.promise : null;
        },
        idle: () => chain,
        timings
      };
      yield* dictateLong(samples, SR, sig, sys, cache, null);
    },

    /** Every request's timing so far -- for the bench and the replay. */
    get timings() { return timings.map((t) => ({ ...t })); },
    get cuts() { return splitter.cuts.map((c) => c.end); }
  };
}

/* ------------------------------------------------------- the dictionary check */

/** A one-shot completion (no streaming): the parsed reply, or null. */
function complete(payload, signal, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve(null);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(b)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    if (signal) signal.addEventListener('abort', () => { req.destroy(); resolve(null); }, { once: true });
    req.end(payload);
  });
}

/**
 * The dictionary's terms in `text`, checked against what the model would have written without
 * them (vocab.js). OFF unless TYPD_VOCAB_CHECK=1: on the user's 15 long dictations (first real run,
 * 2026-10-17) the model's next word with the term barred was mostly its own "language English"
 * tag starting over, one replacement of 44 was that tag, and the Aysel case was not caught.
 *
 * For each term, two short requests that continue the dictation's own answer up to the term, so
 * the server reuses its cached prompt: one token with its probabilities and the top alternatives;
 * then -- if the model was not sure of the term -- the best alternative that starts a word (never
 * the language tag, never the term itself) continued for a few tokens. Returns `text`, with any
 * term the hint put in place of a different word put back. Any failure keeps `text` as it is.
 */
const TAG_START = /^(l|la|lan|lang|langu|langua|languag|language)$/i;

async function checkTerms(parts, system, info, text, signal) {
  if (process.env.TYPD_VOCAB_CHECK !== '1') return text;
  let found;
  try { found = vocab.suspects(text, system); } catch { return text; }
  if (!found.length) return text;
  const raw = info.raw || '';
  const lead = /^\s*(?:language \w+<asr_text>)?\s*/.exec(raw)[0].length;
  if (!raw.slice(lead).startsWith(text)) { debug('vocab: raw text does not line up; not checked'); return text; }
  const echoed = PREFILL && raw.startsWith(PREFILL);
  let out = text;
  let shift = 0;   // out's offsets against text's, after replacements
  for (const occ of found) {
    if (signal && signal.aborted) return text;
    const before = (echoed ? '' : PREFILL) + raw.slice(0, lead + occ.index).replace(/\s+$/, '');
    const t0 = Date.now();
    const first = await complete(body(parts, system, { max_tokens: 1, logprobs: true, top_logprobs: 10 }, false, before), signal);
    const lp = first && first.choices && first.choices[0] && first.choices[0].logprobs && first.choices[0].logprobs.content && first.choices[0].logprobs.content[0];
    if (!lp || typeof lp.id !== 'number') { debug('vocab:', occ.term, 'no token probabilities; kept'); continue; }
    const tok = String(lp.token || '').trim().toLowerCase();
    if (!tok || !occ.term.toLowerCase().startsWith(tok)) { debug('vocab:', occ.term, 'the model now writes', JSON.stringify(lp.token), 'there; kept'); continue; }
    const p = Math.exp(lp.logprob);
    let alt = null, altNext = null;
    if (p < vocab.SURE) {
      // The best other token that starts a word where the term starts: spaced as the term's
      // token is, not the term (or a piece of it), not the language tag the model opens with.
      const spaced = /^\s/.test(String(lp.token));
      const other = (Array.isArray(lp.top_logprobs) ? lp.top_logprobs : [])
        .filter((c) => c && typeof c.token === 'string' && c.id !== lp.id)
        .filter((c) => /^\s/.test(c.token) === spaced && /^\p{L}/u.test(c.token.trim()) && !/[<>]/.test(c.token))
        .filter((c) => !TAG_START.test(c.token.trim()) && !occ.term.toLowerCase().startsWith(c.token.trim().toLowerCase()))
        .sort((x, y) => y.logprob - x.logprob)[0];
      if (other) {
        const n = occ.term.split(/\s+/).length;
        const second = await complete(body(parts, system, { max_tokens: 6 + 3 * n }, false, before + other.token), signal);
        let content = second && second.choices && second.choices[0] && second.choices[0].message && second.choices[0].message.content;
        // llama-server answers with the opening it was given and then its own tokens (the first
        // real run took that echo, "language English<asr_text>...", for the other word).
        const opening = before + other.token;
        if (typeof content === 'string' && content.startsWith(opening)) content = content.slice(opening.length);
        else if (typeof content === 'string' && content.startsWith(before)) content = content.slice(before.length).replace(other.token, '');
        debug('vocab:', occ.term, 'other token', JSON.stringify(other.token), 'went on as', JSON.stringify(String(content).slice(0, 80)));
        if (typeof content === 'string' && !/<asr_text>/.test(content)) {
          ({ alt, next: altNext } = vocab.firstWords(other.token + content, n));
        }
      }
    }
    const origNext = vocab.firstWords(text.slice(occ.index + occ.length), 1).alt || null;
    const d = vocab.decide({ term: occ.term, heardAs: occ.heardAs, p, alt, altNext, origNext });
    debug('vocab:', occ.term, 'p=' + p.toFixed(3), 'instead:', JSON.stringify(alt), '->', d.keep ? 'kept' : 'replaced', '(' + d.why + ')', (Date.now() - t0) + ' ms');
    if (vocabLog) {
      const top = (Array.isArray(lp.top_logprobs) ? lp.top_logprobs : []).map((c) => [c.token, Math.round(Math.exp(c.logprob) * 1000) / 1000]);
      vocabLog({ term: occ.term, p, alt, keep: d.keep, why: d.why, ms: Date.now() - t0, top });
    }
    if (!d.keep) {
      const at = { index: occ.index + shift, length: occ.length };
      const next = vocab.replace(out, at, alt);
      shift += next.length - out.length;
      out = next;
    }
  }
  return out;
}

/** Eval tools listen to the dictionary check's decisions (setVocabLog). */
let vocabLog = null;
function setVocabLog(fn) { vocabLog = typeof fn === 'function' ? fn : null; }

/**
 * Output budget for dictation: nobody types more than they said. ~8 tokens per second of
 * speech covers formatting with room to spare; a model that runs past it is looping.
 * Revision has no such bound (a short instruction can rewrite a long span), so it is not capped.
 */
function dictationBudget(samples, sampleRate) {
  const seconds = samples.length / (sampleRate || 16000);
  return Math.min(1024, Math.round(96 + 8 * seconds));
}

/**
 * A model that starts repeating itself does not stop on its own (seen live: a 79 s dictation
 * that ended in the same file name written over and over). Three copies of one sentence of 12+
 * characters, or of the last 40 characters within the last 400, mean a loop: returns the text
 * cut where the repetition began, or null. `allow` is the text a revision was given: what repeats
 * there (a status line, a list's "- TBD") may repeat in its rewrite.
 */
function loopCut(text, allow = '') {
  const seen = new Map();
  const re = /[^.!?\n]+[.!?\n]+/g;
  const given = (s) => {
    if (!allow) return false;
    const first = allow.indexOf(s);
    return first !== -1 && allow.indexOf(s, first + 1) !== -1;
  };
  let m;
  while ((m = re.exec(text))) {
    const s = m[0].trim();
    if (s.length < 12) continue;
    const at = (seen.get(s) || []).concat(m.index);
    seen.set(s, at);
    if (at.length === 3 && !given(s)) return text.slice(0, at[1]).trimEnd();
  }
  const tail = text.slice(-40);
  if (tail.length === 40 && !given(tail)) {
    const win = text.slice(-400), base = text.length - win.length, at = [];
    for (let i = win.indexOf(tail); i !== -1; i = win.indexOf(tail, i + 1)) at.push(base + i);
    if (at.length >= 3) return text.slice(0, at[1]).trimEnd();
  }
  return null;
}

/**
 * Half a second of silence, one output token: ~30 ms of GPU work. Between dictations the GPU
 * drops to its lowest power state and the next dictation pays 0.25-0.3 s to clock back up;
 * sent when the hotkey is pressed, this pays it while the user is still talking (measured:
 * -120 to -140 ms with the ping 1 s ahead). It also pages back in any model memory Windows
 * moved out of VRAM, and with the session's prompt it leaves that prefix cached.
 */
let silence = null;
function nudge(system = '', timeoutMs = 5000) {
  if (!silence) silence = toWav(new Float32Array(8000), 16000).toString('base64');
  const payload = body([silence], system, { max_tokens: 1 });
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      },
      (res) => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', resolve);
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(); });
    req.end(payload);
  });
}

/** Fire and forget: wake the model for a dictation that has just begun. */
function ping(system = '') {
  if (!starting) nudge(system);   // a server that is not up just refuses the connection
}

/**
 * The request body for audio in one or more pieces (base64 WAVs, in order). Every request
 * goes through here. With a revise adapter loaded it names the adapter's scale: on only when
 * `asRevise` (see `adapter`); without one the body is what it always was.
 */
function body(parts, system, extra, asRevise = false, assistant = PREFILL) {
  return JSON.stringify({
    messages: [
      { role: 'system', content: system || '' },
      { role: 'user', content: parts.map((data) => ({ type: 'input_audio', input_audio: { data, format: 'wav' } })) },
      // The answer's opening: the language tag older models were given, or (the dictionary check)
      // the dictation's own answer up to a word.
      ...(assistant ? [{ role: 'assistant', content: assistant }] : [])
    ],
    temperature: 0,
    cache_prompt: true,
    ...(adapter ? { lora: [{ id: adapter.id, scale: asRevise ? 1 : 0 }] } : {}),
    ...extra
  });
}

async function* dictateParts(parts, signal, system = '', maxTokens = 1024, asRevise = false, opts = {}) {
  await warm();
  yield* ask(parts, signal, system, maxTokens, asRevise, opts);
}

/**
 * The request itself, to a server already up (the self-test calls it from inside warm()).
 * `opts`: {info} gets {raw, finish} at the end -- the text exactly as the model wrote it (the
 * language tag included) and why it stopped ('stop', 'length', 'loop', 'stalled'); {firstWordMs}
 * waits longer for a long prompt; {allow} is text whose own repeated sentences are not a loop.
 */
async function* ask(parts, signal, system = '', maxTokens = 1024, asRevise = false, opts = {}) {
  const info = opts.info || {};
  info.raw = '';
  info.finish = null;
  // A request for a session already cancelled would still run to the end on the server (the abort
  // listener below only fires on a change), holding the GPU from the next one.
  if (signal && signal.aborted) return;
  const payload = body(parts, system, { stream: true, max_tokens: maxTokens }, asRevise);

  const queue = [];
  let done = false;
  let failure = null;
  let wake = null;
  let finish = null;
  const poke = () => { if (wake) { wake(); wake = null; } };

  const req = http.request(
    {
      host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST',
      // A fresh connection per dictation: Node keeps sockets alive by default and
      // llama-server closes them after a streamed reply, so a reused socket hangs up.
      agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    },
    (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          debug('status', res.statusCode, body.slice(0, 400));
          failure = new Error('The dictation model refused the audio (' + res.statusCode + ')');
          done = true;
          poke();
        });
        return;
      }
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const body = line.slice(5).trim();
          if (body === '[DONE]') continue;
          try {
            const choice = JSON.parse(body).choices[0];
            const delta = choice.delta;
            if (choice.finish_reason) finish = choice.finish_reason;
            if (delta && delta.content) { queue.push(delta.content); poke(); }
          } catch {
            // partial frame; the next chunk completes it
          }
        }
      });
      res.on('end', () => { done = true; poke(); });
    }
  );

  req.on('error', (err) => {
    debug('request error', err && err.message);
    failure = new Error('The dictation model is not running');
    done = true;
    poke();
  });
  if (signal) signal.addEventListener('abort', () => req.destroy(), { once: true });
  req.end(payload);

  // Watchdog: the pill must never sit on "thinking" forever. The server takes one request at a
  // time, so anything else using it (or a GPU starved by other work) can stall a dictation.
  // No first word within FIRST_WORD_MS is an error; a stream that stops for STALL_MS keeps what
  // it already wrote (it is usually nearly complete) rather than losing it.
  // A long revise prompt (thousands of tokens) takes a while to read before the first word,
  // most of all on a CPU: opts.firstWordMs.
  const FIRST_WORD_MS = Math.max(30000, opts.firstWordMs || 0), STALL_MS = 15000;
  let text = '';
  let last = Date.now();
  let shownSoFar = '';
  // loopCut scans the whole text; on a 6,000-character revise that is every chunk times the
  // text. Checked every chunk while short, then every 200 characters (a loop is cut where it
  // began either way, so a later check loses nothing).
  let checkedAt = 0;
  while (true) {
    if (queue.length) {
      text += queue.join('');
      queue.length = 0;
      last = Date.now();
      info.raw = text;
      // The server may echo the prefilled tag on some builds; never show it.
      // A model that names the language itself streams the tag first; show nothing
      // until it is complete rather than a flash of "language Tur".
      const pending = /^\s*l(a(n(g(u(a(g(e( \w*)?)?)?)?)?)?)?)?$/.test(text);
      const shown = pending ? '' : text.replace(/^\s*language \w+<asr_text>/, '').replace(/^\s+/, '');
      if (shown.length < 2000 || shown.length - checkedAt >= 200) {
        checkedAt = shown.length;
        const cut = loopCut(shown, opts.allow);
        if (cut !== null) {
          debug('loop detected; cut', shown.length, '->', cut.length, 'chars');
          req.destroy();
          info.finish = 'loop';
          yield cut;
          return;
        }
      }
      shownSoFar = shown;
      yield shown;
      continue;
    }
    if (failure) throw failure;
    if (done) {
      if (shownSoFar.length > checkedAt) {
        const cut = loopCut(shownSoFar, opts.allow);
        if (cut !== null) { info.finish = 'loop'; yield cut; return; }
      }
      info.finish = finish || 'stop';
      return;
    }
    if (Date.now() - last > (shownSoFar ? STALL_MS : FIRST_WORD_MS)) {
      debug('watchdog:', shownSoFar ? 'stalled mid-answer, keeping ' + shownSoFar.length + ' chars' : 'no answer');
      req.destroy();
      info.finish = 'stalled';
      if (shownSoFar) return;
      throw new Error('The model did not answer — try again');
    }
    await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 1000); });
  }
}

/**
 * Send audio while the user is still talking. Each finished piece goes to the
 * server with one token of output and `cache_prompt`, so the audio encoder and
 * the prompt are done before the user stops; afterwards only the last piece and
 * the writing remain. The server recognises a piece it has seen by the hash of
 * its bytes, so every piece is encoded to WAV once and resent verbatim.
 *
 * Cuts are train.py's split_at_pauses run incrementally -- the quietest 100 ms
 * between 0.6x and 1.4x of PIECE seconds, decided once 1 s more has arrived --
 * so the app cuts exactly where the model was trained and scored to be cut.
 *
 * @param {AbortSignal} signal   the session's
 * @param {() => string} system  the prompt, read when each piece is sent
 */
const PIECE = 4;
const SR = 16000;

function openStream(signal, system) {
  let buf = new Float32Array(SR * 30);
  let len = 0;
  let start = 0;                 // first sample not yet in a piece
  const parts = [];              // base64 WAVs, in order
  const cuts = [];
  let chain = Promise.resolve();

  // Mean square of the 100 ms frame at `i` half-hops; same argmin as the RMS.
  const energy = (i) => {
    let s = 0;
    for (let k = i * 800, end = k + 1600; k < end; k++) s += buf[k] * buf[k];
    return s;
  };

  function cut() {
    for (;;) {
      const lo = start + 0.6 * PIECE * SR, hi = start + 1.4 * PIECE * SR;
      if (hi >= len - SR) return;
      let best = lo / 800, low = Infinity;
      for (let j = lo / 800; j < Math.floor(hi / 800); j++) {
        const e = energy(j);
        if (e < low) { low = e; best = j; }
      }
      const at = best * 800 + 800;
      const wav = toWav(buf.subarray(start, at), SR).toString('base64');
      parts.push(wav);
      cuts.push(at);
      start = at;
      const sent = parts.slice();
      chain = chain.then(() => prime(sent, system(), signal)).catch((err) => debug('prime failed', err && err.message));
    }
  }

  return {
    /** Float32 mono at 16 kHz, in capture order. */
    push(samples) {
      if (signal && signal.aborted) return;
      if (len + samples.length > buf.length) {
        const grown = new Float32Array(Math.max(buf.length * 2, len + samples.length));
        grown.set(buf.subarray(0, len));
        buf = grown;
      }
      buf.set(samples, len);
      len += samples.length;
      cut();
    },

    /**
     * Finished text for the whole recording. `samples` is the complete capture;
     * the pieces already sent are its prefix, so only the rest is new.
     */
    async* finish(samples, sampleRate, sig, sys, maxTokens = 1024) {
      if (!parts.length || sampleRate !== SR || samples.length < start) {
        yield* dictate(samples, sampleRate, sig, sys, maxTokens);
        return;
      }
      const last = toWav(samples.subarray(start), SR).toString('base64');
      await chain;               // the server takes one request at a time anyway
      debug('streamed', parts.length, 'pieces ahead; last', ((samples.length - start) / SR).toFixed(1), 's');
      yield* dictateParts(parts.concat([last]), sig, sys, maxTokens);
    },

    /** Sample offsets of the cuts so far -- for the bench. */
    get cuts() { return cuts.slice(); }
  };
}

/** Encode pieces now, write nothing: one token, cached prompt kept on the server. */
function prime(parts, system, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return resolve();
    const payload = body(parts, system, { max_tokens: 1 });
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    if (signal) signal.addEventListener('abort', () => { req.destroy(); resolve(); }, { once: true });
    req.end(payload);
  });
}

/**
 * Revise `span` by the spoken instruction in `samples`: the replacement text, streamed
 * (cumulative) like dictate(). The one request that runs with the revise adapter on. The
 * instruction is short (pipeline/index.js sends anything past 20 s as dictation), so it goes
 * in one piece.
 *
 * Its output budget is the span's own length and half again (a list or a fuller rewrite runs
 * longer than its source) plus 256, at least 1,024 as before 0.2.3 -- never more than the window
 * has left after the prompt. A span whose prompt leaves less than its own length for the answer
 * does not fit: `info.tooLong`, and nothing is sent. `info` also gets ask()'s {raw, finish}:
 * 'length' means the answer was cut off by the budget, and must not be pasted.
 */
async function* revise(samples, sampleRate, signal, span, info = {}) {
  const sr = sampleRate || 16000;
  await warm();   // the tokenizer is the server's
  const spanTokens = await countTokens(span);
  // The prompt: the template and instruction (~13 audio tokens a second, 20 s at most) and the span.
  const prompt = spanTokens + Math.ceil(13 * (samples.length / sr)) + 96;
  const room = CONTEXT - prompt - 16;
  if (room < spanTokens + 64) {
    info.tooLong = true;
    debug('revise: span of', spanTokens, 'tokens does not fit the', CONTEXT, 'window');
    return;
  }
  const budget = Math.min(room, Math.max(1024, Math.round(spanTokens * 1.5) + 256));
  debug('revise: span', spanTokens, 'tokens, budget', budget);
  yield* dictateParts([toWav(samples, sampleRate).toString('base64')], signal, revisePrompt(span), budget, true, {
    info,
    allow: span,
    // ~20 ms a prompt token on a slow CPU, over the usual 30 s.
    firstWordMs: 30000 + 20 * prompt
  });
}

/**
 * How many tokens the model's tokenizer makes of `text`: the server's /tokenize, which takes a
 * few milliseconds. Before the server answers (or if it cannot), an estimate that errs high:
 * 3 characters a token (English prose runs ~4.2, Turkish and code ~3).
 */
function countTokens(text) {
  const estimate = Math.ceil(String(text || '').length / 3);
  if (!text || text.length < 2000) return Promise.resolve(estimate);
  const payload = JSON.stringify({ content: text });
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/tokenize', method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try {
          const t = JSON.parse(b).tokens;
          resolve(Array.isArray(t) && t.length ? t.length : estimate);
        } catch { resolve(estimate); }
      });
    });
    req.on('error', () => resolve(estimate));
    req.setTimeout(3000, () => { req.destroy(); resolve(estimate); });
    req.end(payload);
  });
}

/** The whole text at once -- for revise mode, where the words are an instruction. */
async function transcribe(samples, sampleRate, signal, system = '') {
  let text = '';
  for await (const t of dictate(samples, sampleRate, signal, system)) text = t;
  return text.trim();
}

module.exports = {
  warm, stop, ping, dictate, revise, transcribe, openStream, openLong, dictationBudget, loopCut, contextPrompt, revisePrompt,
  countTokens, CONTEXT, setVocabLog,
  // long.js's, here too for the eval tools that load local.js
  splitLong: long.splitLong, readSeam: long.readSeam, joinPieces: long.joinPieces, stitch: long.stitch,
  canRevise: () => Boolean(SPEC.revise),
  usesContext: () => Boolean(SPEC.context),
  streams: () => Boolean(SPEC.stream),
  switchModel, onWarm, resolveModel, selfTestPasses, bringUp, reviseLora, spawnOptions,
  /** The CUDA backend for this build (cudaPack.js): state(), dir(), prepare(), install(), ... */
  cuda,
  /**
   * Are the files of the model in use there? False in a public install before its first model has
   * downloaded (public installers ship without one, modelUpdate.js fetches it): Typd cannot dictate yet.
   */
  hasModel: () => fs.existsSync(MODEL) && fs.existsSync(MMPROJ),
  get MODEL() { return MODEL; },
  get MODEL_DIR() { return MODEL_DIR; },
  get VERSION() { return VERSION; },
  /**
   * The exact version of the model loaded now: a downloaded version's name (current.json), else
   * the bundled (or TYPD_MODEL_DIR) folder's (modelUpdate.versionOf). What a shared dictation
   * and the update checks' version counts name.
   */
  modelVersion: () => versionOf(MODEL_DIR, { version: VERSION, modelsDir: USER_MODELS }),
  /** The revise adapter the running server has loaded (a path), or null. */
  get REVISE_ADAPTER() { return adapter ? adapter.file : null; },
  BUNDLED_DIR, PORT, FIXTURE
};
