'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const { once } = require('events');
const { spawn } = require('child_process');
const { activeModel } = require('../modelUpdate');

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
 * Apple Silicon, CPU only on Intel.
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

const BUNDLED_DIR = RESOURCES ? path.join(RESOURCES, 'models', 'typd-dictate') : path.join(root(), 'models', 'typd-dictate');
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

function launch(layers) {
  const child = spawn(SERVER, [
    '-m', MODEL, '--mmproj', MMPROJ,
    '--host', '127.0.0.1', '--port', String(PORT),
    '-ngl', String(layers),
    // Under 1 GB of VRAM in total (1,011 MiB measured, 2026-10-05) with no measurable quality
    // change: 8-bit KV cache, smaller micro-batches, and a 2,048-token window. The worst real
    // dictation piece (71 s + the longest screen context) needs ~2,014 tokens; long revise
    // selections are refused up front in pipeline/index.js instead of overflowing.
    '-c', '2048', '-ctk', 'q8_0', '-ctv', 'q8_0', '-ub', '256', '-np', '1',
    '--cache-ram', '0',                           // no host prompt cache: every dictation is new audio
    // The built-in warm-up reserves ~550 MB for a 30 s audio window that a dictation never
    // needs at once; the self-test (or the silent request) warms it instead (1.76 -> 1.35 GB).
    '--no-warmup',
    '--no-webui',
    ...(adapter ? ['--lora', adapter.file, '--lora-init-without-apply'] : [])
  ], { windowsHide: true, stdio: ['ignore', 'ignore', process.env.TYPD_DEBUG ? 'inherit' : 'ignore'] });
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
 * Finished text for a recording, streamed. Yields cumulative text.
 *
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {AbortSignal} [signal]
 * @returns {AsyncGenerator<string>}
 */
async function* dictate(samples, sampleRate, signal, system = '', maxTokens = 1024) {
  const sr = sampleRate || 16000;
  if (samples.length / sr <= LONG_S) {
    yield* dictateParts([toWav(samples, sampleRate).toString('base64')], signal, system, maxTokens);
    return;
  }
  // Past what the model was trained on (90 s) it drops text silently: on a real 162 s
  // dictation 3 of 4 runs lost ~40 %. So long recordings are written piece by piece.
  // The model closes a sentence wherever its audio ends, and people pause mid-phrase
  // ("their AI ... quota"), so a pause says nothing about punctuation. Each cut is also written
  // once from the speech either side of it, and that text decides how the pieces join.
  const { pieces, pauses } = splitLong(samples, sr);
  let done = '';
  for (let p = 0; p < pieces.length; p++) {
    let seam = null;
    if (p > 0) {
      const w = seamAudio(samples, sr, pauses[p - 1]);
      let t = '';
      for await (const x of dictateParts([toWav(w, sr).toString('base64')], signal, system, dictationBudget(w, sr))) t = x;
      const { from, seamFrom, seamTo, to } = pauses[p - 1];
      seam = readSeam(done, t, (from - seamFrom) / Math.max(1, from - seamFrom + seamTo - to));
      debug('seam', p, seam ? JSON.stringify(seam) : 'unread', JSON.stringify(t.slice(0, 160)));
    }
    let part = '';
    for await (const t of dictateParts([toWav(pieces[p], sr).toString('base64')], signal, system, dictationBudget(pieces[p], sr))) {
      part = t;
      yield joinPieces(done, part, seam);
    }
    done = joinPieces(done, part, seam);
  }
}

const LONG_S = 75, PIECE_MIN_S = 45, PIECE_MAX_S = 70, FRAME_S = 0.02, SEAM_S = 6, KEEP_S = 0.3;

/**
 * Cut at the longest pause between 45 and 70 s into each piece, until the rest is short.
 * The quietest 100 ms (the old rule) could fall in the gap between two words. A pause is a run
 * of 20 ms frames under 1/30 of the recording's median frame energy (about 15 dB below speech),
 * or under 3x its 10th percentile in a noisy room; with no pause of 60 ms or more, the quietest
 * frame. The pause itself is left out but for KEEP_S at each edge: a piece that starts or ends in
 * seconds of silence loses words (seen on a real 8 s pause). Returns the pieces and, per cut, the
 * pause ([from, to] in samples) and the seam: about SEAM_S of speech either side, from and to
 * the nearest pause of 100 ms+, so it starts and ends between phrases ([seamFrom, seamTo]).
 */
function splitLong(samples, sr) {
  const f = Math.round(FRAME_S * sr), n = Math.floor(samples.length / f);
  const e = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let k = j * f, end = k + f; k < end; k++) s += samples[k] * samples[k];
    e[j] = s;
  }
  const sorted = Float64Array.from(e).sort();
  const quiet = Math.max(sorted[Math.floor(n / 2)] / 30, 3 * sorted[Math.floor(n / 10)]);
  const isGap = (j) => {   // frame j ends a run of 5+ quiet frames (100 ms)
    for (let k = j - 4; k <= j; k++) if (k < 0 || k >= n || e[k] >= quiet) return false;
    return true;
  };
  const near = (fromS, toS, fallback, pickLast) => {
    let hit = -1;
    for (let j = Math.max(0, Math.floor(fromS / f)); j < Math.min(n, Math.floor(toS / f)); j++) {
      if (isGap(j)) { hit = j * f; if (!pickLast) break; }
    }
    return hit < 0 ? fallback : hit;
  };
  const keep = Math.round(KEEP_S * sr);
  const pieces = [], pauses = [];
  let start = 0;
  while (samples.length - start > LONG_S * sr) {
    const lo = Math.ceil((start + PIECE_MIN_S * sr) / f), hi = Math.floor((start + PIECE_MAX_S * sr) / f);
    let run = 0, longest = 0, first = lo, quietest = lo;
    for (let j = lo; j < hi; j++) {
      run = e[j] < quiet ? run + 1 : 0;
      if (run > longest) { longest = run; first = j - run + 1; }
      if (e[j] < e[quietest]) quietest = j;
    }
    const [from, to] = longest >= 3 ? [first * f, (first + longest) * f] : [quietest * f, quietest * f];
    const cutA = Math.min(from + keep, Math.round((from + to) / 2)), cutB = Math.max(to - keep, cutA);
    pieces.push(samples.subarray(start, cutA));
    pauses.push({
      from, to,
      seamFrom: near(from - (SEAM_S + 3) * sr, from - (SEAM_S - 3) * sr, Math.max(0, from - SEAM_S * sr), true),
      seamTo: near(to + (SEAM_S - 3) * sr, to + (SEAM_S + 3) * sr, Math.min(samples.length, to + SEAM_S * sr), false)
    });
    start = cutB;
  }
  pieces.push(samples.subarray(start));
  return { pieces, pauses };
}

/** The seam's audio: its speech either side of the cut, the pause between shortened to <= 2 x KEEP_S. */
function seamAudio(samples, sr, { from, to, seamFrom, seamTo }) {
  const keep = Math.min(Math.round(KEEP_S * sr), Math.floor((to - from) / 2));
  const a = samples.subarray(seamFrom, from + keep);
  const b = samples.subarray(to - keep, seamTo);
  const w = new Float32Array(a.length + b.length);
  w.set(a);
  w.set(b, a.length);
  return w;
}

/**
 * How the text runs across a cut, read from `seam`: the model's text for the audio either side
 * of it. Finds the last words before the cut (the end of `a`) in the seam and returns what
 * follows them there -- a sentence end or not, and the next word as the model wrote it in
 * context (its case: "quota" vs "Kaggle") -- or null when the seam cannot be lined up.
 * `at` is where the cut falls in the seam's audio (0-1); a match near that share of the text
 * wins. The seam's first word may be a word cut in half ("WTH" for "RWTH").
 */
function readSeam(a, seam, at = 0.5) {
  const words = (s) => [...s.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)]
    .map((m) => ({ w: m[0].toLowerCase(), raw: m[0], i: m.index, end: m.index + m[0].length }));
  const S = words(seam), A = words(a);
  const same = (x, y, j) => x === y || (j === 0 && y.length >= 2 && x.endsWith(y));
  for (const k of [3, 2, 1]) {
    if (A.length < k || (k === 1 && A[A.length - 1].w.length < 4)) continue;
    const tail = A.slice(-k);
    let best = null;
    for (let j = 0; j + k < S.length; j++) {
      if (!tail.every((x, q) => same(x.w, S[j + q].w, j + q))) continue;
      const d = Math.abs(S[j + k - 1].end - seam.length * at);
      if (!best || d < best.d) best = { d, end: S[j + k - 1].end, next: S[j + k] };
    }
    if (best) return { sentenceEnd: /[.!?]/.test(seam.slice(best.end, best.next.i)), next: best.next.raw };
  }
  return null;
}

/**
 * Join the text of two pieces. With a read seam: a sentence that ended at the cut starts a new
 * paragraph; otherwise the sentence continues -- the full stop the model put at the cut goes, and
 * the next word takes its case from the seam. Without one, a space: a paragraph break in the
 * middle of a sentence is the worse mistake.
 */
function joinPieces(a, b, seam) {
  if (!a) return b;
  if (!b) return a;
  a = a.trimEnd();
  b = b.trimStart();
  const ended = /[.!?:]$/.test(a);
  if (!seam) return a + ' ' + b;
  if (seam.sentenceEnd) return ended ? a + '\n\n' + b : a.replace(/[,;]$/, '') + '. ' + b;
  if (/[^.]\.$/.test(a)) a = a.slice(0, -1);
  const first = /^[\p{L}][\p{L}'’-]*/u.exec(b);
  if (first && first[0].toLowerCase() === seam.next.toLowerCase()) b = seam.next + b.slice(first[0].length);
  return a + ' ' + b;
}

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
 * cut where the repetition began, or null.
 */
function loopCut(text) {
  const seen = new Map();
  const re = /[^.!?\n]+[.!?\n]+/g;
  let m;
  while ((m = re.exec(text))) {
    const s = m[0].trim();
    if (s.length < 12) continue;
    const at = (seen.get(s) || []).concat(m.index);
    seen.set(s, at);
    if (at.length >= 3) return text.slice(0, at[1]).trimEnd();
  }
  const tail = text.slice(-40);
  if (tail.length === 40) {
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
function body(parts, system, extra, asRevise = false) {
  return JSON.stringify({
    messages: [
      { role: 'system', content: system || '' },
      { role: 'user', content: parts.map((data) => ({ type: 'input_audio', input_audio: { data, format: 'wav' } })) },
      ...(PREFILL ? [{ role: 'assistant', content: PREFILL }] : [])
    ],
    temperature: 0,
    cache_prompt: true,
    ...(adapter ? { lora: [{ id: adapter.id, scale: asRevise ? 1 : 0 }] } : {}),
    ...extra
  });
}

async function* dictateParts(parts, signal, system = '', maxTokens = 1024, asRevise = false) {
  await warm();
  yield* ask(parts, signal, system, maxTokens, asRevise);
}

/** The request itself, to a server already up (the self-test calls it from inside warm()). */
async function* ask(parts, signal, system = '', maxTokens = 1024, asRevise = false) {
  const payload = body(parts, system, { stream: true, max_tokens: maxTokens }, asRevise);

  const queue = [];
  let done = false;
  let failure = null;
  let wake = null;
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
            const delta = JSON.parse(body).choices[0].delta;
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
  const FIRST_WORD_MS = 30000, STALL_MS = 15000;
  let text = '';
  let last = Date.now();
  let shownSoFar = '';
  while (true) {
    if (queue.length) {
      text += queue.shift();
      last = Date.now();
      // The server may echo the prefilled tag on some builds; never show it.
      // A model that names the language itself streams the tag first; show nothing
      // until it is complete rather than a flash of "language Tur".
      const pending = /^\s*l(a(n(g(u(a(g(e( \w*)?)?)?)?)?)?)?)?$/.test(text);
      const shown = pending ? '' : text.replace(/^\s*language \w+<asr_text>/, '').replace(/^\s+/, '');
      const cut = loopCut(shown);  // a few KB at most; cheap enough to check every chunk
      if (cut !== null) {
        debug('loop detected; cut', shown.length, '->', cut.length, 'chars');
        req.destroy();
        yield cut;
        return;
      }
      shownSoFar = shown;
      yield shown;
      continue;
    }
    if (failure) throw failure;
    if (done) return;
    if (Date.now() - last > (shownSoFar ? STALL_MS : FIRST_WORD_MS)) {
      debug('watchdog:', shownSoFar ? 'stalled mid-answer, keeping ' + shownSoFar.length + ' chars' : 'no answer');
      req.destroy();
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
 * in one piece, and like the training it has no output cap: a short instruction can rewrite a
 * long span.
 */
async function* revise(samples, sampleRate, signal, span) {
  yield* dictateParts([toWav(samples, sampleRate).toString('base64')], signal, revisePrompt(span), 1024, true);
}

/** The whole text at once -- for revise mode, where the words are an instruction. */
async function transcribe(samples, sampleRate, signal, system = '') {
  let text = '';
  for await (const t of dictate(samples, sampleRate, signal, system)) text = t;
  return text.trim();
}

module.exports = {
  warm, stop, ping, dictate, revise, transcribe, openStream, dictationBudget, loopCut, splitLong, readSeam, joinPieces, contextPrompt, revisePrompt,
  canRevise: () => Boolean(SPEC.revise),
  usesContext: () => Boolean(SPEC.context),
  streams: () => Boolean(SPEC.stream),
  switchModel, onWarm, resolveModel, selfTestPasses, bringUp, reviseLora,
  get MODEL() { return MODEL; },
  get MODEL_DIR() { return MODEL_DIR; },
  get VERSION() { return VERSION; },
  /** The revise adapter the running server has loaded (a path), or null. */
  get REVISE_ADAPTER() { return adapter ? adapter.file : null; },
  BUNDLED_DIR, PORT, FIXTURE
};
