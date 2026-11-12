'use strict';

/**
 * The pill's start and stop cues, drawn sample by sample (founder, 7-8 Nov 2026: the old cues were
 * "stupid and unsatisfying"; these replace `start` and `commit` in sound.js).
 *
 * Two families, chosen by ear from renders of these same voices (dictation-research
 * scripts/typd_sounds_v2.py writes them to WAV for listening):
 *
 *   bloom  two notes a fourth apart (up to start, down to stop), the second 132 ms after the first,
 *          each struck in ~1.5 ms; the first damped when the second strikes, the second ringing and then
 *          rounding off. Each note starts dead centre, and ~32 ms later a slowly drifting delayed copy
 *          is added to the left and taken from the right (mid/side): the note opens out.
 *   pluck  a quiet lead-in, then a short bright pluck a fifth away (23 ms later to start, 39 ms to stop):
 *          harmonics 2-5 gone within ~6 ms, a pitch that settles from 30 cents sharp, a tail that hangs.
 *
 * Pure math, no Web Audio: render(name, which, sampleRate) gives { left, right } Float32Arrays peaking at 1,
 * and roomImpulse(sampleRate) the small room's impulse response that sound.js plays them through
 * (a ConvolverNode, at the cue's `room` level). The same file runs in Node for bench/sounds.js.
 */

(function (root) {
  var TAU = 2 * Math.PI;
  var NOTES = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

  function hz(n) {
    var name = n.slice(0, -1);
    var oct = Number(n.slice(-1));
    return 440 * Math.pow(2, (NOTES[name] + 12 * (oct + 1) - 69) / 12);
  }

  /** A seeded generator (mulberry32) and normal deviates from it: the same cue every time. */
  function rng(seed) {
    var a = seed >>> 0;
    function next() {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return function normal() {
      var u = next() || 1e-12;
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * next());
    };
  }

  function raised(x, attack) {
    if (x < 0) return 0;
    return 0.5 - 0.5 * Math.cos(Math.PI * Math.min(x / attack, 1));
  }

  function clip01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // ---------------------------------------------------------------- tones: one note, x seconds after its strike

  // Round tone: a sine with a trace of harmonics (h2 -46, h3 -35, h4 -48, h5 -46, h6 -65, h7 -59 dB).
  var SOFT = [[2, 0.005], [3, 0.018], [4, 0.004], [5, 0.005], [6, 0.0006], [7, 0.0011]];
  function soft(p) {
    var y = Math.sin(p);
    for (var i = 0; i < SOFT.length; i++) y += SOFT[i][1] * Math.sin(SOFT[i][0] * p);
    return y;
  }

  /** Soft's body with a wooden strike: the bar's 4x mode dying in ~20 ms and a felt tick (`tick`: noise). */
  function softwood(p, x, tick) {
    return soft(p) + 0.16 * Math.sin(3.99 * p) * Math.exp(-x / 0.020) + tick;
  }

  // ---------------------------------------------------------------- envelopes

  /** Bloom family. First note: rings ~140 dB/s, damped (25 ms) at `gap`. Second: rings, then a cosine
   *  release from 90 ms over 240 ms (-8 dB at 90 ms, -44 dB at 270 ms). */
  function bloomShape(x, first, gap) {
    var e = raised(x, 0.0015);
    if (e === 0) return 0;
    if (first) {
      e *= Math.exp(-6.9078 * x / 0.43);
      if (x >= gap) e *= Math.exp(-(x - gap) / 0.025);
      return e;
    }
    var r = clip01((x - 0.09) / 0.24);
    return e * Math.exp(-6.9078 * x / 0.60) * (0.5 + 0.5 * Math.cos(Math.PI * r));
  }

  /** fast*exp(-x/tf) + ring*exp(-x/tr), a raised-cosine onset, a cosine fade from fadeAt over fadeLen. */
  function twoStage(x, attack, fast, tf, ring, tr, fadeAt, fadeLen) {
    var e = raised(x, attack);
    if (e === 0) return 0;
    var fade = 0.5 + 0.5 * Math.cos(Math.PI * clip01((x - fadeAt) / fadeLen));
    return e * (fast * Math.exp(-x / tf) + ring * Math.exp(-x / tr)) * fade;
  }

  // ---------------------------------------------------------------- the cues

  var BLOOM = { at: 0.02, gap: 0.132, len: 0.56 };

  /**
   * Every cue Typd can play as start/stop. `room` is the small room's level (sound.js); `bloom` the
   * mid/side copy: wet level, delay, its drift (s) and the drift's rate (Hz).
   * Names match the listening files (dictation-research data/typd_sounds_2026-11-07/v2/listen-*.wav).
   */
  var CUES = {
    // The founder's pick (8 Nov). Its copy's delay, level and drift are its own, per cue.
    'closer':     { family: 'bloom', tone: 'soft', start: ['G#4', 'C#5'], stop: ['G#4', 'D#4'], room: 0, at: 0.025, len: 0.44, tail: 0.012,
                    bloomStart: { wet: 0.25, delay: 0.0385, depth: 0, rate: 0.8 }, bloomStop: { wet: 0.30, delay: 0.0315, depth: 0.001, rate: 0.8 } },
    'soft-A':     { family: 'bloom', tone: 'soft', start: ['A4', 'D5'], stop: ['A4', 'E4'], room: 0.07 },
    'soft-F':     { family: 'bloom', tone: 'soft', start: ['F4', 'A#4'], stop: ['F4', 'C4'], room: 0.07 },
    'softwood-A': { family: 'bloom', tone: 'softwood', start: ['A4', 'D5'], stop: ['A4', 'E4'], room: 0.07 },
    'pop':        { family: 'pluck', start: ['E4', 'B4'], stop: ['B4', 'E4'], room: 0 },
    'pop-bloom':  { family: 'pluck', start: ['E4', 'B4'], stop: ['B4', 'E4'], room: 0.05, bloom: true }
  };

  function bloomCue(cue, which, sr) {
    var len = cue.len || BLOOM.len;
    var n = Math.round(len * sr);
    var mono = new Float32Array(n);
    var notes = cue[which].map(hz);
    var at = cue.at || BLOOM.at;
    var gap = BLOOM.gap;
    var normal = rng(3);
    // The felt tick of each note (softwood): noise dying in 1.2 ms, smoothed over 8 samples.
    var ticks = [0, 1].map(function () {
      var m = Math.round(0.012 * sr);
      var raw = new Float32Array(m);
      for (var i = 0; i < m; i++) raw[i] = normal() * Math.exp(-(i / sr) / 0.0012);
      var out = new Float32Array(m);
      var acc = 0;
      for (var j = 0; j < m; j++) {
        acc += raw[j] - (j >= 8 ? raw[j - 8] : 0);
        out[j] = acc / 8 * 0.05;
      }
      return out;
    });
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var y = 0;
      for (var k = 0; k < 2; k++) {
        var on = at + k * gap;
        var x = t - on;
        if (x < 0) continue;
        var e = bloomShape(x, k === 0, gap);
        if (e === 0) continue;
        var p = TAU * notes[k] * x;
        var tickAt = Math.round(x * sr);
        var tone = cue.tone === 'softwood'
          ? softwood(p, x, tickAt < ticks[k].length ? ticks[k][tickAt] : 0)
          : soft(p);
        y += tone * e;
      }
      mono[i] = y;
    }
    var own = which === 'start' ? cue.bloomStart : cue.bloomStop;
    return bloom(mono, sr, own || { wet: 0.20, delay: 0.032, depth: 0.0010, rate: 0.8 }, len, cue.tail);
  }

  /** The pluck: phase of a pitch settling from +cents with time constant `settle`; harmonics
   *  2..5 starting at `bright` and dying ~7 ms faster than the note; `keep2` the 2nd harmonic that stays. */
  function pluck(f, x, bright, keep2, click) {
    var cents = 30, settle = 0.020;
    var p = TAU * f * (x + Math.LN2 * cents / 1200 * settle * (1 - Math.exp(-x / settle)));
    var fade = Math.exp(-x / 0.0073);
    var y = Math.sin(p) + keep2 * Math.sin(2 * p);
    for (var k = 0; k < bright.length; k++) y += bright[k] * fade * Math.sin((k + 2) * p);
    return y + click;
  }

  function pluckCue(cue, which, sr) {
    var n = Math.round(0.24 * sr);
    var mono = new Float32Array(n);
    var start = which === 'start';
    var lead = hz(cue[which][0]);
    var main = hz(cue[which][1]);
    var at = 0.002;
    var gap = start ? 0.023 : 0.039;
    var bright = start ? [0.075, 0.010, 0.005, 0.003] : [0.30, 0.008, 0.008, 0.005];
    var keep2 = start ? 0.002 : 0.028;
    var leadBright = bright.map(function (b) { return b * 0.3; });
    // The main note's faint broadband tick (~-59 dB): the first difference of noise dying in 0.6 ms.
    var normal = rng(5);
    var m = Math.round(0.006 * sr);
    var click = new Float32Array(m);
    var prev = 0;
    for (var c = 0; c < m; c++) {
      var v = normal() * Math.exp(-(c / sr) / 0.0006);
      click[c] = 0.004 * (v - prev);
      prev = v;
    }
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var y = 0;
      var xl = t - at;
      if (xl >= 0) {
        var el = start ? twoStage(xl, 0.002, 0.025, 0.006, 0.018, 0.060, 0.11, 0.08)
                       : twoStage(xl, 0.002, 0.090, 0.009, 0.008, 0.050, 0.08, 0.06);
        if (el) y += pluck(lead, xl, leadBright, keep2, 0) * el;
      }
      var xm = t - at - gap;
      if (xm >= 0) {
        var em = start ? twoStage(xm, 0.003, 1.0, 0.006, 0.035, 0.050, 0.09, 0.07)
                       : twoStage(xm, 0.003, 1.0, 0.005, 0.025, 0.120, 0.08, 0.09);
        var ci = Math.round(xm * sr);
        if (em) y += pluck(main, xm, bright, keep2, ci < m ? click[ci] : 0) * em;
      }
      mono[i] = y;
    }
    if (cue.bloom) return bloom(mono, sr, { wet: 0.30, delay: 0.012, depth: 0.0004, rate: 0.8 }, 0.24);
    return finish(mono, mono.slice(), sr, 0.02);
  }

  /**
   * Mid/side bloom: one delayed copy whose delay drifts slowly (its pitch moves a few cents), added to the
   * left and taken from the right. The middle stays the dry note, so a note starts centred and opens up when
   * the copy arrives; on a mono speaker there is no echo at all.
   */
  function bloom(mono, sr, o, len, tail) {
    var n = mono.length;
    var left = new Float32Array(n);
    var right = new Float32Array(n);
    var phase = Math.PI - TAU * o.rate * 0.15;
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var d = o.delay + o.depth * Math.sin(TAU * o.rate * t + phase);
      var pos = (t - d) * sr;
      var c = 0;
      if (pos >= 0) {
        var j = Math.floor(pos);
        var f = pos - j;
        c = (mono[j] || 0) * (1 - f) + (j + 1 < n ? mono[j + 1] : 0) * f;
      }
      left[i] = mono[i] + o.wet * c;
      right[i] = mono[i] - o.wet * c;
    }
    return finish(left, right, sr, tail || (len >= 0.5 ? 0.04 : 0.02));
  }

  /** A squared fade over the last `tail` seconds, then both sides scaled so the louder peaks at 1. */
  function finish(left, right, sr, tail) {
    var n = left.length;
    var k = Math.round(tail * sr);
    var peak = 0;
    for (var i = 0; i < n; i++) {
      if (i >= n - k) {
        var g = (n - 1 - i) / (k - 1);
        g *= g;
        left[i] *= g;
        right[i] *= g;
      }
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    }
    if (peak > 0) for (var j = 0; j < n; j++) { left[j] /= peak; right[j] /= peak; }
    return { left: left, right: right };
  }

  /** The small room (0.45 s): decaying noise darkened by a one-pole low-pass at 3.5 kHz, 6 ms late,
   *  different per side, unit energy. Played through a ConvolverNode with normalize off. */
  function roomImpulse(sr) {
    var n = Math.round(0.45 * sr);
    var pre = Math.round(0.006 * sr);
    var a = Math.exp(-TAU * 3500 / sr);
    var normal = rng(11);
    var sides = [];
    for (var s = 0; s < 2; s++) {
      var ir = new Float32Array(n + pre);
      var acc = 0;
      var energy = 0;
      for (var i = 0; i < n; i++) {
        acc = (1 - a) * normal() * Math.exp(-6.9078 * (i / sr) / 0.40) + a * acc;
        ir[pre + i] = acc;
        energy += acc * acc;
      }
      var g = 1 / Math.sqrt(energy || 1);
      for (var j = 0; j < ir.length; j++) ir[j] *= g;
      sides.push(ir);
    }
    return { left: sides[0], right: sides[1] };
  }

  /** { left, right } (Float32Array, peak 1) for cue `name`'s 'start' or 'stop', or null for no such cue. */
  function render(name, which, sr) {
    var cue = CUES[name];
    if (!cue || (which !== 'start' && which !== 'stop')) return null;
    return cue.family === 'bloom' ? bloomCue(cue, which, sr) : pluckCue(cue, which, sr);
  }

  var api = { CUES: CUES, render: render, roomImpulse: roomImpulse, hz: hz };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.typdVoices = api;
})(typeof window !== 'undefined' ? window : this);
