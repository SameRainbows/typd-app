'use strict';

/**
 * Low-memory mode (0.2.6): is it on for the model about to start? Pure, Electron-free (bench/low-memory.js).
 *
 * What it changes is local.js's (launch(), longLimits(), revise()): the "free levers" of
 * dictation-research reports/sub_half_gb_plan.md, measured on held-out sets with no quality change --
 *   - a 1,280-token window instead of 4,096 (1,152 asked would be padded to 1,280 by llama.cpp anyway);
 *   - the KV cache at q8_0 for K and q4_0 for V, with flash attention (llama.cpp needs it for a
 *     quantized V); never q4_0 for K: decoding breaks (+9.7 WER, empty outputs);
 *   - --no-repack: one copy of the decoder weights on the CPU instead of two (the repacked one is ~205 MiB
 *     for the light model);
 *   - long dictations in pieces small enough for that window, and revisions capped to fit it;
 *   - the audio encoder's conv front end one chunk at a time (MTMD_QWEN3A_CONV_GROUP=1, Typd's llama.cpp
 *     patch), which every mode gets: the same output, its buffer 554 -> 21 MiB.
 * The light model on the CPU: ~1.4 GB -> ~0.8 GB resident.
 *
 * Settings > Low-memory mode: 'auto' (default), 'on' or 'off'. Automatic turns it on for
 *   - the light model (the 0.6B: Typd picks it for every computer without a capable GPU, so this is
 *     where memory is short; on it the levers cost nothing measurable), or
 *   - any model on a computer with less than 8 GB of memory (os.totalmem(): RAM, or the unified memory
 *     of a Mac -- where the GPU shares it).
 * It stays off for the full model on a capable computer (a 4 GB NVIDIA GPU, a 16 GB Mac): the window and
 * the long-dictation pieces stay as they were. Which model is the light one: by the decoder's size, the
 * 0.6B's Q4_K_M is ~400 MB and the 1.7B's ~1.1 GB (LIGHT_MAX_BYTES between them).
 *
 * TYPD_LOW_MEMORY=1 / =0 (the eval tools, the bench) overrides the setting.
 */

const LIGHT_MAX_BYTES = 750 * 1024 * 1024;
// Smaller than any model Typd ships (the benches' stand-in files): the size says nothing.
const LIGHT_MIN_BYTES = 150 * 1024 * 1024;
const SMALL_MEMORY_BYTES = 8 * 1024 ** 3;
const CHOICES = ['auto', 'on', 'off'];

/**
 * {on, why}. `setting` 'auto'|'on'|'off'; `modelBytes` the decoder file's size (0 or null: unknown);
 * `totalMem` bytes of memory (os.totalmem()); `env` for TYPD_LOW_MEMORY.
 */
function decide({ setting = 'auto', modelBytes = 0, totalMem = 0, env = process.env } = {}) {
  if (env && env.TYPD_LOW_MEMORY === '1') return { on: true, why: 'TYPD_LOW_MEMORY=1' };
  if (env && env.TYPD_LOW_MEMORY === '0') return { on: false, why: 'TYPD_LOW_MEMORY=0' };
  const s = CHOICES.includes(setting) ? setting : 'auto';
  if (s === 'on') return { on: true, why: 'turned on in Settings' };
  if (s === 'off') return { on: false, why: 'turned off in Settings' };
  const gb = totalMem > 0 ? Math.round(totalMem / 1024 ** 3) : null;
  if (modelBytes >= LIGHT_MIN_BYTES && modelBytes < LIGHT_MAX_BYTES) return { on: true, why: 'the light model' };
  if (totalMem > 0 && totalMem < SMALL_MEMORY_BYTES) return { on: true, why: `${gb} GB of memory` };
  return { on: false, why: gb ? `the full model with ${gb} GB of memory` : 'the full model' };
}

module.exports = { decide, CHOICES, LIGHT_MAX_BYTES, LIGHT_MIN_BYTES, SMALL_MEMORY_BYTES };
