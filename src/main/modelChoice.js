'use strict';

/**
 * Which published model this machine follows -- the `variant` modelUpdate.js asks for at each check:
 * Settings' Model choice (settings.modelVariant), and for Automatic, hardware.js's pick:
 *
 *   'auto'    'full' on a CUDA GPU with 3.5 GB of VRAM or more, or Apple silicon with 16 GB of
 *             memory or more; 'light' on anything else (hardware.js says why)
 *   'full'    the 1.7B, whatever the hardware
 *   'light'   the 0.6B, whatever the hardware
 *
 * The hardware is read at most once every CACHE_MS (a check runs every 6 hours, so in practice once
 * per check), and again at once after forget() -- Settings opening, the choice changing.
 * Electron-free: `setting` and `detect` are passed in (bench/model-choice.js).
 */

const hardware = require('./hardware');

const CACHE_MS = 30 * 60e3;
const CHOICES = ['auto', 'full', 'light'];

function createChoice({ setting = () => 'auto', detect = () => hardware.detect(), now = () => Date.now() } = {}) {
  let cache = null;   // {at, hw, variant, why}

  async function auto() {
    if (cache && now() - cache.at < CACHE_MS) return cache;
    let hw = null;
    try { hw = await detect(); } catch { hw = null; }
    cache = { at: now(), hw, ...hardware.pick(hw) };
    return cache;
  }

  const chosen = () => {
    let s = 'auto';
    try { s = setting(); } catch { s = 'auto'; }
    return CHOICES.includes(s) ? s : 'auto';
  };

  /** 'full' | 'light': what the next model check follows. */
  async function variant() {
    const s = chosen();
    if (s !== 'auto') return s;
    return (await auto()).variant;
  }

  /** For Settings: {setting, auto, why, variant} -- the choice, Automatic's answer and its reason, the result. */
  async function describe() {
    const a = await auto();
    const s = chosen();
    return { setting: s, auto: a.variant, why: a.why, variant: s === 'auto' ? a.variant : s };
  }

  return { variant, describe, forget: () => { cache = null; } };
}

module.exports = { createChoice, CHOICES, CACHE_MS };
