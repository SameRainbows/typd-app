'use strict';

/**
 * The overlay's voice.
 *
 * Synthesised rather than sampled — partly because a CSP that blocks external
 * resources also blocks audio files, but mostly because these are four short
 * tones and an oscillator is smaller than a WAV.
 *
 * These are placeholders pending design/sound-lab.html, which measured what is
 * wrong with them: the low cues lose ~9 dB through a laptop speaker, `start`
 * and `commit` are the same sound a transposition apart, and the 2400 Hz master
 * lowpass applied to pure sines removes nothing at all. Its recommended set
 * replaces this whole object; what is here now is the smaller fix of no longer
 * being silent on failure.
 *
 * The shape being aimed for: soft, warm, short. A sine through a low-pass with
 * a fast attack and an exponential tail reads as a wooden "pop" rather than a
 * beep, and a small upward glide makes it feel like it has been struck rather
 * than switched on. Everything is under 140 ms and well under half volume; a
 * sound you notice twice is a sound you turn off.
 */

(function () {
  var ctx = null;
  var master = null;
  var enabled = true;

  function ready() {
    if (!enabled) return null;
    if (!ctx) {
      try {
        ctx = new AudioContext();
      } catch {
        enabled = false;
        return null;
      }
      master = ctx.createGain();
      master.gain.value = 0.085;   // quiet enough to live with all day

      // Rounds off the top end so the tones sit behind whatever else is
      // playing instead of cutting through it.
      var tame = ctx.createBiquadFilter();
      tame.type = 'lowpass';
      tame.frequency.value = 2400;
      tame.Q.value = 0.6;

      master.connect(tame);
      tame.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /**
   * One struck note.
   * @param {{from:number, to?:number, dur?:number, level?:number, delay?:number, type?:string}} o
   */
  function note(o) {
    var c = ready();
    if (!c) return;

    var t = c.currentTime + (o.delay || 0);
    var dur = o.dur || 0.11;
    var level = o.level == null ? 1 : o.level;

    var osc = c.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.from, t);
    if (o.to) {
      // Exponential, not linear: pitch is heard logarithmically, and a linear
      // sweep sounds like it slows down at the top.
      osc.frequency.exponentialRampToValueAtTime(o.to, t + dur * 0.75);
    }

    var env = c.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(level, t + 0.008);   // fast strike
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);    // long-ish tail

    osc.connect(env);
    env.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    sleepAfter((o.delay || 0) + dur + 0.3);
  }

  // A running context keeps the audio device and a renderer thread awake for good
  // (~4 % of a core measured). Suspend once the last tail has played; ready() resumes.
  var sleepTimer = null;
  function sleepAfter(seconds) {
    clearTimeout(sleepTimer);
    sleepTimer = setTimeout(function () {
      if (ctx && ctx.state === 'running') ctx.suspend();
    }, seconds * 1000);
  }

  var sounds = {
    // Opening: low and warm, rising slightly. "Listening."
    start: function () {
      note({ from: 392, to: 523, dur: 0.13 });
      note({ from: 784, to: 1046, dur: 0.09, level: 0.22 });   // faint octave, adds body
    },

    // Committing: a fifth above the opening, so it answers it.
    commit: function () {
      note({ from: 587, to: 784, dur: 0.14 });
      note({ from: 1174, to: 1568, dur: 0.1, level: 0.2 });
    },

    // Landed: two quick notes, the second higher. Reads as "done".
    done: function () {
      note({ from: 659, dur: 0.07, level: 0.55 });
      note({ from: 988, dur: 0.11, level: 0.45, delay: 0.065 });
    },

    // Abandoned: falls instead of rising. Nobody has to be told what it means.
    cancel: function () {
      note({ from: 466, to: 311, dur: 0.15, level: 0.7 });
    },

    // Revision landed. The same length and timbre as 'done' with the contour
    // inverted -- the same sound backwards, not a sixth sound. It earns the
    // distinction because its *meaning* differs: text was added versus your
    // writing was replaced, and the way back from the second one is Ctrl+Z,
    // reachable only by someone who noticed. It fires seconds after the
    // keypress, when attention has already moved on.
    doneRevise: function () {
      note({ from: 988, dur: 0.07, level: 0.45 });
      note({ from: 659, dur: 0.11, level: 0.55, delay: 0.065 });
    },

    // Failure. The one moment worth interrupting for, and until now the only
    // cue that played nothing at all -- so the single state where the user has
    // certainly looked away was also the only silent one.
    //
    // Kept above 500 Hz deliberately: design/sound-lab.html measured the
    // existing low cues losing ~9 dB through a laptop speaker's roll-off, which
    // is most of the way to inaudible.
    error: function () {
      note({ from: 622, dur: 0.09, level: 0.7 });
      note({ from: 523, dur: 0.16, level: 0.75, delay: 0.085 });
    },

    // A word was learned. Lighter than 'done' -- it is a footnote, not a result.
    learned: function () {
      note({ from: 880, dur: 0.06, level: 0.3 });
      note({ from: 1318, dur: 0.09, level: 0.26, delay: 0.055 });
    }
  };

  window.typdSound = {
    play: function (name) {
      var fn = sounds[name];
      if (fn) {
        try { fn(); } catch { /* audio is never worth throwing over */ }
      }
    },
    setEnabled: function (on) { enabled = !!on; },
    isEnabled: function () { return enabled; }
  };
})();
