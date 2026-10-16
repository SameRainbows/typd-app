'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Parakeet TDT 0.6b v3, int8, via sherpa-onnx's Node bindings.
 *
 * Measured on this machine: 3.9 s to load, ~350 ms to decode a 5 s utterance,
 * 12x realtime. The load is warmed during app start so it never lands on a
 * dictation; the decode is the only part the user waits for, and even that
 * disappears once audio is fed in while they are still speaking rather than in
 * one batch at the end.
 *
 * The Node bindings mean no Python in the shipped runtime.
 */

/**
 * Resolve the model directory without hard-depending on Electron, so the bench
 * can drive this exact module from plain node. A harness that tests a copy of
 * the shipping code is a harness that eventually tests the wrong thing.
 */
function defaultModelDir() {
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getAppPath === 'function') {
      return path.join(electron.app.getAppPath(), 'bench', 'models', 'parakeet');
    }
  } catch {
    // not running under Electron
  }
  return path.join(process.cwd(), 'bench', 'models', 'parakeet');
}

const MODEL_DIR = process.env.TYPD_PARAKEET_DIR || defaultModelDir();

let recognizer = null;
let loading = null;
let loadError = null;

function build() {
  const sherpa = require('sherpa-onnx-node');

  const files = {
    encoder: path.join(MODEL_DIR, 'encoder.int8.onnx'),
    decoder: path.join(MODEL_DIR, 'decoder.int8.onnx'),
    joiner: path.join(MODEL_DIR, 'joiner.int8.onnx'),
    tokens: path.join(MODEL_DIR, 'tokens.txt')
  };

  for (const [name, file] of Object.entries(files)) {
    if (!fs.existsSync(file)) {
      throw new Error(`Parakeet ${name} missing at ${file}`);
    }
  }

  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
      tokens: files.tokens,
      modelType: 'nemo_transducer',
      numThreads: 4,
      debug: false
    }
  });
}

/** Kick the model into memory. Safe to call more than once. */
function warm() {
  if (recognizer || loading) return loading || Promise.resolve();

  loading = new Promise((resolve) => {
    // setImmediate so a 3.9 s synchronous load cannot stall app startup.
    setImmediate(() => {
      try {
        recognizer = build();
      } catch (err) {
        loadError = err;
      }
      loading = null;
      resolve();
    });
  });

  return loading;
}

function isReady() {
  return recognizer !== null;
}

/**
 * @param {Float32Array} samples mono PCM
 * @param {number} sampleRate    sherpa resamples internally if this is not 16k
 * @returns {Promise<string>}
 */
async function transcribe(samples, sampleRate) {
  if (!recognizer) await warm();
  if (loadError) throw loadError;
  if (!recognizer) throw new Error('speech model unavailable');
  if (!samples || !samples.length) return '';

  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: sampleRate || 16000, samples });
  recognizer.decode(stream);
  return (recognizer.getResult(stream).text || '').trim();
}

module.exports = { warm, transcribe, isReady, MODEL_DIR };
