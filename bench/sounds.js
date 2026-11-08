'use strict';

/**
 * The pill's start and stop cues (src/renderer/sound-voices.js): every cue renders, is finite, peaks at 1,
 * has its notes where they should be, and keeps its shape -- the bloom family centred for its first
 * ~30 ms and wide after (the bloom), the plain pop mono. With the research renders at hand
 * (dictation-research scripts/typd_sounds_ref.py; TYPD_SOUND_REF=<dir>, or the default path below if it
 * exists), each cue must also match its Python twin sample for sample (correlation >= 0.999 per side;
 * the felt and click noise come from different generators, so not exactly).
 *
 *   node bench/sounds.js
 */

const fs = require('fs');
const path = require('path');
const V = require('../src/renderer/sound-voices');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
}

const rms = (a, from, to) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
};

/** Main pitch over [from, to) seconds: rising zero crossings, interpolated. */
function pitch(a, sr, from, to) {
  const cross = [];
  for (let i = Math.round(from * sr) + 1; i < Math.round(to * sr); i++) {
    if (a[i - 1] < 0 && a[i] >= 0) cross.push(i - 1 + a[i - 1] / (a[i - 1] - a[i]));
  }
  if (cross.length < 3) return 0;
  return sr * (cross.length - 1) / (cross[cross.length - 1] - cross[0]);
}

const cents = (f, ref) => 1200 * Math.log2(f / ref);

for (const sr of [48000, 44100]) {
  console.log('\n' + sr + ' Hz');
  for (const name of Object.keys(V.CUES)) {
    const cue = V.CUES[name];
    for (const which of ['start', 'stop']) {
      const t0 = Date.now();
      const r = V.render(name, which, sr);
      const ms = Date.now() - t0;
      const { left: L, right: R } = r;
      let finite = true, peak = 0;
      for (let i = 0; i < L.length; i++) {
        if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) finite = false;
        peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
      }
      const label = name + ' ' + which;
      check(label + ': finite, peaks at 1, rendered in ' + ms + ' ms', finite && Math.abs(peak - 1) < 1e-6 && ms < 400, { peak, ms });
      const [n1, n2] = cue[which].map(V.hz);
      const bloom = cue.family === 'bloom';
      // the second (main) note's pitch, well after its strike (the pluck's settle is over by then)
      const second = bloom ? [0.20, 0.30] : (which === 'start' ? [0.09, 0.14] : [0.11, 0.16]);
      const mid = L.map((v, i) => (v + R[i]) / 2);
      const f2 = pitch(mid, sr, second[0], second[1]);
      check(label + ': second note ' + cue[which][1], Math.abs(cents(f2, n2)) < 15, { got: +f2.toFixed(1), want: +n2.toFixed(1) });
      if (bloom) {
        const f1 = pitch(mid, sr, 0.04, 0.14);
        check(label + ': first note ' + cue[which][0], Math.abs(cents(f1, n1)) < 15, { got: +f1.toFixed(1), want: +n1.toFixed(1) });
        // centred until the copy arrives (32 ms after the strike at 20 ms), wide after
        const side = (a, b) => { const s = new Float32Array(b - a); for (let i = a; i < b; i++) s[i - a] = (L[i] - R[i]) / 2; return rms(s, 0, s.length); };
        const early = side(Math.round(0.02 * sr), Math.round(0.05 * sr)) / rms(mid, Math.round(0.02 * sr), Math.round(0.05 * sr));
        const later = side(Math.round(0.07 * sr), Math.round(0.14 * sr)) / rms(mid, Math.round(0.07 * sr), Math.round(0.14 * sr));
        check(label + ': blooms (side/mid before the copy, after)', early < 0.01 && later > 0.2 && later < 1,
          { early: +(20 * Math.log10(early + 1e-9)).toFixed(1), later: +(20 * Math.log10(later)).toFixed(1) });
      } else if (!cue.bloom) {
        let same = true;
        for (let i = 0; i < L.length; i++) if (L[i] !== R[i]) { same = false; break; }
        check(label + ': mono', same);
      }
    }
  }
}

const imp = V.roomImpulse(48000);
let e = 0;
for (const v of imp.left) e += v * v;
check('\nroom impulse: two sides, unit energy, 6 ms late', imp.left.length === imp.right.length && Math.abs(e - 1) < 1e-4 &&
  imp.left.slice(0, 288).every((v) => v === 0), { energy: e });

const REF = process.env.TYPD_SOUND_REF ||
  path.join(__dirname, '..', '..', '..', 'dictation-research', 'data', 'typd_sounds_2026-11-07', 'v2', 'ref');
if (fs.existsSync(path.join(REF, 'index.json'))) {
  console.log('\nagainst the research renders (' + REF + ')');
  const index = JSON.parse(fs.readFileSync(path.join(REF, 'index.json'), 'utf8'));
  for (const [key, n] of Object.entries(index.cues)) {
    const [name, which] = [key.slice(0, key.lastIndexOf('-')), key.slice(key.lastIndexOf('-') + 1)];
    const buf = fs.readFileSync(path.join(REF, key + '.f32'));
    const ref = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    const r = V.render(name, which, index.sampleRate);
    const corr = (a, b) => {
      let ab = 0, aa = 0, bb = 0;
      for (let i = 0; i < Math.min(a.length, b.length); i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
      return ab / Math.sqrt(aa * bb);
    };
    const cl = corr(r.left, ref.subarray(0, n));
    const cr = corr(r.right, ref.subarray(n, 2 * n));
    check(key + ': matches the Python render', r.left.length === n && cl >= 0.999 && cr >= 0.999,
      { length: [r.left.length, n], left: +cl.toFixed(5), right: +cr.toFixed(5) });
  }
} else {
  console.log('\n(no research renders at ' + REF + ': the sample-for-sample comparison is skipped)');
}

// ---------------------------------------------------------------- sound.js's wiring, with a stand-in AudioContext

console.log('\nsound.js plays them');
const vm = require('vm');
function fakeAudio(log) {
  class Node { constructor(kind) { this.kind = kind; this.outs = []; } connect(n) { this.outs.push(n); log.push(this.kind + '->' + n.kind); return n; } }
  class Param { constructor(v) { this.value = v; } setValueAtTime() {} exponentialRampToValueAtTime() {} }
  return class FakeContext {
    constructor() { this.sampleRate = 48000; this.currentTime = 0; this.state = 'running'; this.destination = new Node('out'); }
    resume() { this.state = 'running'; }
    suspend() { this.state = 'suspended'; }
    createGain() { const n = new Node('gain'); n.gain = new Param(1); return n; }
    createBiquadFilter() { const n = new Node('lowpass'); n.frequency = new Param(0); n.Q = new Param(0); return n; }
    createOscillator() { const n = new Node('osc'); n.frequency = new Param(0); n.start = () => log.push('osc start'); n.stop = () => {}; return n; }
    createBuffer(ch, len, sr) {
      const data = Array.from({ length: ch }, () => new Float32Array(len));
      return { numberOfChannels: ch, length: len, duration: len / sr, copyToChannel: (a, i) => data[i].set(a), data };
    }
    createBufferSource() { const n = new Node('buffer'); n.start = () => log.push('buffer start ' + n.buffer.length); return n; }
    createConvolver() { const n = new Node('room'); n.normalize = true; return n; }
  };
}
function loadSound(withVoices) {
  const log = [];
  const sandbox = { window: {}, setTimeout: () => 0, clearTimeout: () => {}, Date, Math, Float32Array };
  sandbox.window.AudioContext = fakeAudio(log);
  sandbox.AudioContext = sandbox.window.AudioContext;
  if (withVoices) sandbox.window.typdVoices = V;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'sound.js'), 'utf8'), sandbox);
  return { sound: sandbox.window.typdSound, log };
}
{
  const { sound, log } = loadSound(true);
  sound.play('start');
  check('start: one buffer, through its level to the output and the room, nothing through the old low-pass',
    log.includes('buffer->gain') && log.includes('gain->out') && log.includes('gain->room') && log.includes('room->out') &&
    log.filter((l) => l.startsWith('buffer start')).length === 1 && !log.some((l) => l.startsWith('osc')), log);
  const n = log.length;
  sound.play('commit');
  check('commit: the stop cue, the same room (made once)', log.slice(n).filter((l) => l === 'room->out').length === 0 &&
    log.slice(n).some((l) => l.startsWith('buffer start')), log.slice(n));
  sound.play('done');
  check('done: still the old tone', log.some((l) => l === 'osc start'));
}
{
  const { sound, log } = loadSound(false);
  sound.play('start');
  check('without sound-voices.js, start falls back to the old tone', log.includes('osc start') && !log.some((l) => l.startsWith('buffer')), log);
}
{
  const { sound, log } = loadSound(true);
  sound.setEnabled(false);
  sound.play('start');
  sound.play('commit');
  check('sounds off: nothing plays', log.length === 0, log);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
