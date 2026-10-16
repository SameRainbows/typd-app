#!/usr/bin/env node
'use strict';

/**
 * Smoke test for a dictation server: start it exactly as the app does, send it a short
 * recording, and require finished text back.
 *
 *   node scripts/smoke-llama.js [wav] [--server <llama-server>] [--models <dir>]
 *                               [--gpu-layers N] [--port N] [--expect <word>]
 *
 * It drives src/main/pipeline/local.js itself -- the same spawn flags, request body and
 * prefill the app uses -- rather than a copy that could drift from it. --server and
 * --models point it at a packaged app's resources (Typd.app/Contents/Resources/llama and
 * .../models/typd-dictate) so the files that ship are the files tested. If a server is
 * already answering on the port, local.js reuses it, which tests a running app's server.
 *
 * Exit 0 only if the text is non-empty and contains --expect (default: "airport", from
 * test/fixtures/dictation-3s.wav: "Can you remind me what time the train to the airport
 * leaves on Sunday?").
 *
 * warm() itself now ends with the app's self-test on the same clip (local.js): without
 * --gpu-layers, wrong text on the GPU restarts the server on the CPU, and the log (TYPD_DEBUG)
 * says which path was chosen; with --gpu-layers it is tested but never changed.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const server = opt('--server');
const models = opt('--models');
const layers = opt('--gpu-layers');
const port = opt('--port');
const expect = opt('--expect', 'airport');
const wav = path.resolve(args[0] || path.join(__dirname, '..', 'test', 'fixtures', 'dictation-3s.wav'));

if (server) process.env.TYPD_LLAMA_SERVER = path.resolve(server);
if (models) process.env.TYPD_MODEL_DIR = path.resolve(models);
if (layers !== undefined) process.env.TYPD_GPU_LAYERS = String(layers);
if (port) process.env.TYPD_LLAMA_PORT = String(port);
if (!process.env.TYPD_DEBUG) process.env.TYPD_DEBUG = '1';   // server log on stderr, for CI

const local = require('../src/main/pipeline/local');

/** 16-bit PCM WAV -> Float32 mono samples + rate. */
function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(file + ' is not a WAV file');
  let off = 12, fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4), body = off + 8;
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) throw new Error(file + ': need 16-bit PCM');
      const frames = Math.floor(size / (2 * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) out[i] = b.readInt16LE(body + i * 2 * fmt.channels) / 32768;
      return { samples: out, rate: fmt.rate };
    }
    off = body + size + (size & 1);
  }
  throw new Error(file + ': no data chunk');
}

async function main() {
  const { samples, rate } = readWav(wav);
  console.log(`[smoke] model  ${local.MODEL}`);
  console.log(`[smoke] audio  ${wav} (${(samples.length / rate).toFixed(2)} s @ ${rate} Hz)`);
  console.log(`[smoke] port   ${local.PORT}, gpu layers ${process.env.TYPD_GPU_LAYERS || 'default (99)'}`);

  const t0 = Date.now();
  await local.warm();
  const t1 = Date.now();
  const text = await local.transcribe(samples, rate);
  const t2 = Date.now();
  local.stop();

  console.log(`[smoke] ready in ${t1 - t0} ms, answered in ${t2 - t1} ms`);
  console.log(`[smoke] text   ${JSON.stringify(text)}`);
  if (!text) throw new Error('empty text');
  if (expect && !text.toLowerCase().includes(expect.toLowerCase())) throw new Error(`text does not contain "${expect}"`);
  console.log('[smoke] PASS');
}

main().then(() => process.exit(0), (err) => {
  console.error('[smoke] FAIL:', err && err.message);
  try { local.stop(); } catch { /* already gone */ }
  process.exit(1);
});
