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
 *     patch): its buffer 554 -> 21 MiB. The processor gets it in every mode (identical output there);
 *     the GPU only in low-memory mode (on CUDA the wording can move a little: local.js serverEnv()).
 * The light model on the CPU: ~1.4 GB -> ~0.8 GB resident.
 *
 * Settings > Low-memory mode: 'auto' (default), 'on' or 'off'. Automatic turns it on for
 *   - a light model left from before 0.2.13 (on it the levers cost nothing measurable),
 *   - the model on a computer with less than 8 GB of memory (os.totalmem(): RAM, or the unified memory
 *     of a Mac -- where the GPU shares it), or
 *   - a Mac under 16 GB: Metal wires the weights, and on a 7 GB Mac normal mode went critical beside a
 *     2.5 GB app while low-memory mode held it with no swap.
 * It stays off elsewhere: the window and the long-dictation pieces stay as they were. The full model on
 * the processor holds ~2.6 GB in normal mode and ~2.4 GB in low-memory mode, so a PC with 8 GB or more has room. Which model is the light one: by the decoder's size, the
 * 0.6B's Q4_K_M is ~400 MB and the 1.7B's ~1.1 GB (LIGHT_MAX_BYTES between them).
 *
 * TYPD_LOW_MEMORY=1 / =0 (the eval tools, the bench) overrides the setting.
 */

const LIGHT_MAX_BYTES = 750 * 1024 * 1024;
// Smaller than any model Typd ships (the benches' stand-in files): the size says nothing.
const LIGHT_MIN_BYTES = 150 * 1024 * 1024;
const SMALL_MEMORY_BYTES = 8 * 1024 ** 3;
const SMALL_MAC_BYTES = 15.5 * 1024 ** 3;   // a 16 GB Mac reports 17,179,869,184 bytes
const CHOICES = ['auto', 'on', 'off'];

/**
 * {on, why}. `setting` 'auto'|'on'|'off'; `modelBytes` the decoder file's size (0 or null: unknown);
 * `totalMem` bytes of memory (os.totalmem()); `env` for TYPD_LOW_MEMORY.
 */
function decide({ setting = 'auto', modelBytes = 0, totalMem = 0, env = process.env, platform = process.platform } = {}) {
  if (env && env.TYPD_LOW_MEMORY === '1') return { on: true, why: 'TYPD_LOW_MEMORY=1' };
  if (env && env.TYPD_LOW_MEMORY === '0') return { on: false, why: 'TYPD_LOW_MEMORY=0' };
  const s = CHOICES.includes(setting) ? setting : 'auto';
  if (s === 'on') return { on: true, why: 'turned on in Settings' };
  if (s === 'off') return { on: false, why: 'turned off in Settings' };
  const gb = totalMem > 0 ? Math.round(totalMem / 1024 ** 3) : null;
  if (modelBytes >= LIGHT_MIN_BYTES && modelBytes < LIGHT_MAX_BYTES) return { on: true, why: 'the light model' };
  if (totalMem > 0 && totalMem < SMALL_MEMORY_BYTES) return { on: true, why: `${gb} GB of memory` };
  if (platform === 'darwin' && totalMem > 0 && totalMem < SMALL_MAC_BYTES) return { on: true, why: `a Mac with ${gb} GB of memory` };
  return { on: false, why: gb ? `the full model with ${gb} GB of memory` : 'the full model' };
}

module.exports = { decide, CHOICES, LIGHT_MAX_BYTES, LIGHT_MIN_BYTES, SMALL_MEMORY_BYTES, SMALL_MAC_BYTES };
