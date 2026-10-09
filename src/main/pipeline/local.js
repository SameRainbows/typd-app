'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

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
 *   <resources>/models/typd-dictate/   model.json + the two GGUF files it names
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

const MODEL_DIR = process.env.TYPD_MODEL_DIR ||
  (RESOURCES ? path.join(RESOURCES, 'models', 'typd-dictate') : path.join(root(), 'models', 'typd-dictate'));
const SERVER = process.env.TYPD_LLAMA_SERVER || defaultServer();
/*
 * model.json beside the weights says which files to load and what the model was
 * trained to do, so a better model is a drop-in: copy the files, edit the json.
 *   { "model": "...gguf", "mmproj": "...gguf", "context": true, "revise": true }
 * context -- it reads Typd's screen-context block for spelling names and identifiers.
 * revise  -- it applies a spoken instruction to highlighted text by itself.
 * stream  -- it was trained on audio in pause-split pieces, so the pieces can be
 *            sent while the user is still talking (see openStream).
 * A model without a flag is never sent that prompt: an untrained prompt is noise.
 */
function readSpec() {
  const fallback = { model: 'typd-dictate-0.6b-q4_k_m.gguf', mmproj: 'mmproj-qwen3-asr-0.6b-q8_0.gguf', context: false, revise: false };
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'model.json'), 'utf8')) };
  } catch {
    return fallback;
  }
}
const SPEC = readSpec();
const MODEL = path.join(MODEL_DIR, SPEC.model);
const MMPROJ = path.join(MODEL_DIR, SPEC.mmproj);

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

// The fine-tuning prompt, exactly: an empty system turn, the audio, and the
// assistant turn opened with the language tag. Anything else is a prompt the
// model never saw in training.
//
// Models up to round 10 were always told "English" here, which made Turkish come
// out misspelt or translated. From round 11 the model writes the tag itself
// ("language Turkish<asr_text>..."); their model.json says "prefill": "" and the
// tag is stripped from what is shown.
const PREFILL = typeof SPEC.prefill === 'string' ? SPEC.prefill : 'language English<asr_text>';

let proc = null;
let starting = null;
let startError = null;

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

/** Start the model server and wait until it answers. Safe to call more than once. */
function warm() {
  if (starting) return starting;
  if (proc && !startError) return Promise.resolve();

  starting = (async () => {
    startError = null;
    for (const [what, file] of [['model', MODEL], ['audio projector', MMPROJ], ['llama-server', SERVER]]) {
      if (!fs.existsSync(file)) throw new Error(`Dictation ${what} missing at ${file}`);
    }

    // A server left behind by a crashed run would hold the port; reuse it
    // rather than fail, since it is serving the same files.
    if (await health()) {
      debug('reusing server on', PORT);
      return;
    }

    // On macOS a GPU that is present but refuses the work (Metal in a VM, say) kills the
    // server during load rather than falling back on its own; one retry on the CPU covers
    // it. Only for the default layer count: an explicit TYPD_GPU_LAYERS is obeyed as given.
    let layers = process.env.TYPD_GPU_LAYERS || '99';   // no GPU at all: llama.cpp uses the CPU
    const cpuRetry = process.platform === 'darwin' && !process.env.TYPD_GPU_LAYERS;
    const launch = () => {
      const child = spawn(SERVER, [
        '-m', MODEL, '--mmproj', MMPROJ,
        '--host', '127.0.0.1', '--port', String(PORT),
        '-ngl', layers,
        // Under 1 GB of VRAM in total (1,011 MiB measured, 2026-10-05) with no measurable quality
        // change: 8-bit KV cache, smaller micro-batches, and a 2,048-token window. The worst real
        // dictation piece (71 s + the longest screen context) needs ~2,014 tokens; long revise
        // selections are refused up front in pipeline/index.js instead of overflowing.
        '-c', '2048', '-ctk', 'q8_0', '-ctv', 'q8_0', '-ub', '256', '-np', '1',
        '--cache-ram', '0',                           // no host prompt cache: every dictation is new audio
        // The built-in warm-up reserves ~550 MB for a 30 s audio window that a dictation never
        // needs at once; the silent request below warms it instead (1.76 -> 1.35 GB, same speed).
        '--no-warmup',
        '--no-webui'
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
    };
    proc = launch();

    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      if (!proc && cpuRetry && layers !== '0') {
        debug('server died while loading on the GPU; retrying on the CPU');
        layers = '0';
        proc = launch();
      }
      if (!proc) throw new Error('The dictation model failed to start');
      if (await health()) {
        await nudge('', 30000);   // the first dictation would otherwise pay for the warm-up
        debug('ready in', Date.now() - t0, 'ms');
        return;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('The dictation model took too long to start');
  })()
    .catch((err) => { startError = err; throw err; })
    .finally(() => { starting = null; });

  // warm() is called during launch and nobody awaits it there; a failure is
  // surfaced on the first dictation instead of as an unhandled rejection.
  starting.catch(() => {});
  return starting;
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
  let done = '';
  for (const piece of splitLong(samples, sr)) {
    let part = '';
    for await (const t of dictateParts([toWav(piece, sr).toString('base64')], signal, system, dictationBudget(piece, sr))) {
      part = t;
      yield joinPieces(done, part);
    }
    done = joinPieces(done, part);
  }
}

const LONG_S = 75, PIECE_MIN_S = 45, PIECE_MAX_S = 70;

/** Cut at the quietest 100 ms between 45 and 70 s into each piece, until the rest is short. */
function splitLong(samples, sr) {
  const pieces = [];
  const win = Math.round(0.1 * sr), hop = Math.floor(win / 2);
  let start = 0;
  while (samples.length - start > LONG_S * sr) {
    const lo = start + PIECE_MIN_S * sr, hi = start + PIECE_MAX_S * sr;
    let best = lo + hop, low = Infinity;
    for (let i = lo; i + win <= hi; i += hop) {
      let e = 0;
      for (let k = i; k < i + win; k++) e += samples[k] * samples[k];
      if (e < low) { low = e; best = i + hop; }
    }
    pieces.push(samples.subarray(start, best));
    start = best;
  }
  pieces.push(samples.subarray(start));
  return pieces;
}

/** A sentence that ended at the cut starts a new paragraph; a cut mid-sentence just continues. */
function joinPieces(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.trimEnd() + (/[.!?:]$/.test(a.trimEnd()) ? '\n\n' : ' ') + b.trimStart();
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

/** The request body for audio in one or more pieces (base64 WAVs, in order). */
function body(parts, system, extra) {
  return JSON.stringify({
    messages: [
      { role: 'system', content: system || '' },
      { role: 'user', content: parts.map((data) => ({ type: 'input_audio', input_audio: { data, format: 'wav' } })) },
      ...(PREFILL ? [{ role: 'assistant', content: PREFILL }] : [])
    ],
    temperature: 0,
    cache_prompt: true,
    ...extra
  });
}

async function* dictateParts(parts, signal, system = '', maxTokens = 1024) {
  await warm();

  const payload = body(parts, system, { stream: true, max_tokens: maxTokens });

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

/** The whole text at once -- for revise mode, where the words are an instruction. */
async function transcribe(samples, sampleRate, signal, system = '') {
  let text = '';
  for await (const t of dictate(samples, sampleRate, signal, system)) text = t;
  return text.trim();
}

module.exports = {
  warm, stop, ping, dictate, transcribe, openStream, dictationBudget, loopCut, splitLong, joinPieces, contextPrompt, revisePrompt,
  canRevise: () => Boolean(SPEC.revise),
  usesContext: () => Boolean(SPEC.context),
  streams: () => Boolean(SPEC.stream),
  MODEL, PORT
};
