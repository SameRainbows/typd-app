'use strict';

(function () {
  var root       = document.documentElement;
  var overlay    = document.getElementById('overlay');
  var resultEl   = document.getElementById('resultText');
  var meterLayer = document.getElementById('meterLayer');
  var progressEl = document.getElementById('progress');
  var cancelBtn  = document.getElementById('cancel');
  var confirmBtn = document.getElementById('confirm');
  var canvas     = document.getElementById('meter');
  var ctx2d      = canvas.getContext('2d');

  var EXIT_MS = 140;   // MUST equal --dur-exit, or the dismiss timer fires
                       // before the pill has finished leaving
  var LINGER_DONE_MS = 240;
  var LINGER_ERROR_MS = 2600;
  var LINGER_NOTE_MS = 1800;
  var HIT_PAD = 5;     // forgiving edges; a 24px circle is a small target

  var state = 'idle';
  var hideId = null;
  var epoch = 0;       // invalidates timers belonging to superseded sessions

  /* -------------------------------------------------------- click-through */

  /* The window is click-through except over the two controls while they are live. Main decides
   * that from the cursor (overlay-window.js, the click gate); this page only says where the
   * controls are, whenever that changes -- it hears no mouse at all while the window is
   * click-through, so it could not decide anyway. */

  var controlsLive = false;   // listening, until capture ends or the session goes
  var acted = false;          // this session's controls have been used: one answer only
  var lastHits = '';

  function hitAreas() {
    if (!controlsLive || state !== 'listening' || overlay.getAttribute('data-visible') !== 'true') return [];
    var out = [];
    var controls = [cancelBtn, confirmBtn];
    for (var i = 0; i < controls.length; i++) {
      var r = controls[i].getBoundingClientRect();
      // A folded-away control still has a box; its width is what says it is
      // gone, and a 0-width button must not keep swallowing clicks.
      if (r.width < 2) continue;
      out.push({
        x: Math.floor(r.left - HIT_PAD), y: Math.floor(r.top - HIT_PAD),
        w: Math.ceil(r.width + HIT_PAD * 2), h: Math.ceil(r.height + HIT_PAD * 2)
      });
    }
    return out;
  }

  /** Tell main where the controls are -- only when that changed (the unfold moves them). */
  function reportHits() {
    var list = hitAreas();
    var key = JSON.stringify(list);
    if (key === lastHits) return;
    lastHits = key;
    window.typd.hitAreas(list);
  }

  function controlsOff() {
    controlsLive = false;
    reportHits();
  }

  /* The release is the click. On Windows the pill can never be activated (focusable: false), and
   * Chromium answers a press on such a window with MA_NOACTIVATEANDEAT -- "does not activate the
   * window, and discards the mouse message" -- whenever the press reaches its top-level window
   * rather than the content's child window. Then no mousedown arrives, and so no `click` either:
   * only the mouseup. Acting on the mouseup works both ways; `click` stays for anything that
   * clicks without a mouse, and `acted` keeps it to one answer per session. */
  function act(which) {
    if (acted || !controlsLive || state !== 'listening') return;
    acted = true;
    controlsOff();   // main makes the window click-through again at once
    if (which === 'cancel') window.typd.cancel();
    else window.typd.confirm();
  }

  [[cancelBtn, 'cancel'], [confirmBtn, 'confirm']].forEach(function (c) {
    c[0].addEventListener('mouseup', function (e) { if (e.button === 0) act(c[1]); });
    c[0].addEventListener('click', function () { act(c[1]); });
  });

  /* ------------------------------------------------------------------ audio */

  var RATE = 16000;   // what Parakeet wants; the browser resamples for us

  var audioCtx = null;
  var analyser = null;
  var micStream = null;
  var recorder = null;
  var sampleBuf = null;
  var chunks = [];
  var capturing = false;
  var peak = 0.02;    // slow-decaying reference so quiet mics still read
  var level = 0;
  var synthetic = false;

  // A real microphone never delivers exact zeros: even a quiet room has a noise floor. A
  // stream of them means Windows' privacy switch or a mute is in the way -- say so now,
  // not after the user has talked for a minute into nothing.
  var heard = false, zeroBlocks = 0;
  var micId = '';   // from Settings ('' = Windows default)
  var micLabel = '';   // its name, to find it again if the id changes
  var SILENT_BLOCKS = 24;   // 24 x 64 ms ≈ 1.5 s

  // 0.2.12: main usually has the microphone (its native helper, src/main/capture.js) and sends only the
  // level for the meter (session:level) and the moment its first audio arrived (session:hearing). This
  // page captures only when main says so: no helper (session:start native false), or main falling back
  // to it mid-session (session:mic-fallback). `owned`: this page captured in this session, so it has a
  // recording to hand over at the end.
  var native = false;
  var nativeLevel = 0;
  var owned = false;
  var hearing = false;   // the microphone's first audio is here: "listening", and the start cue

  function markHearing() {
    if (hearing || state !== 'listening') return;
    hearing = true;
    overlay.setAttribute('data-hearing', 'true');
    window.typdSound.play('start');
  }

  async function startMic() {
    synthetic = false;
    chunks = [];
    capturing = true;
    owned = true;
    heard = false; zeroBlocks = 0;

    try {
      var raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      try {
        // The microphone chosen in Settings.
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: micId ? Object.assign({ deviceId: { exact: micId } }, raw) : raw
        });
      } catch (err) {
        if (!micId) throw err;
        // Its id can change while the device stays put (an Electron update re-keys every
        // id), so look for the same device by name before giving up on it. Falling straight
        // to the Windows default once left Typd deaf: the default was a virtual cable
        // (2026-10-09). Only if no device has that name is it really gone (unplugged).
        var same = null;
        if (micLabel) {
          var list = await navigator.mediaDevices.enumerateDevices();
          same = list.find(function (d) { return d.kind === 'audioinput' && d.label === micLabel; }) || null;
        }
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: same ? Object.assign({ deviceId: { exact: same.deviceId } }, raw) : raw
        });
      }

      // Asking the context for 16 kHz makes the browser resample on our behalf,
      // which is cheaper and better tested than doing it ourselves.
      if (!audioCtx || audioCtx.sampleRate !== RATE) {
        if (audioCtx) audioCtx.close();
        audioCtx = new AudioContext({ sampleRate: RATE });
      }
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      var source = audioCtx.createMediaStreamSource(micStream);

      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.12;
      source.connect(analyser);
      sampleBuf = new Float32Array(analyser.fftSize);

      // ScriptProcessor is deprecated but needs no module file, which an
      // AudioWorklet would -- and the page CSP forbids loading one.
      // 1024 samples = 64 ms per block. The block in flight when capture stops is lost, so the
      // block size is the most of the last word that can be cut: 4096 (256 ms) clipped audible
      // speech at the end of 4 of 101 real recordings.
      recorder = audioCtx.createScriptProcessor(1024, 1, 1);
      recorder.onaudioprocess = function (e) {
        if (!capturing) return;
        var block = new Float32Array(e.inputBuffer.getChannelData(0));
        markHearing();
        if (!heard) {
          for (var z = 0; z < block.length && !heard; z++) if (block[z] !== 0) heard = true;
          if (!heard && ++zeroBlocks === SILENT_BLOCKS) window.typd.micProblem('silent');
        }
        chunks.push(block);
        window.typd.sendChunk(block.slice().buffer, audioCtx.sampleRate);
      };
      source.connect(recorder);

      // The node only runs while connected to the destination, so route it
      // through a silent gain -- otherwise the mic comes back out of the speakers.
      var mute = audioCtx.createGain();
      mute.gain.value = 0;
      recorder.connect(mute);
      mute.connect(audioCtx.destination);
    } catch (err) {
      // No mic, no permission, or a device held exclusively elsewhere. Preview builds
      // fall back to a synthetic envelope so the motion stays tunable; the real app
      // says so at once and its meter stays flat: never a meter moving over a dead
      // microphone (0.2.6 drew the synthetic envelope here too, so a Mac whose
      // microphone macOS had not allowed yet looked as if it heard speech).
      synthetic = Boolean(window.__typdSynthetic);
      analyser = null;
      capturing = false;
      if (window.__typdSynthetic) markHearing();
      else window.typd.micProblem('unavailable', (err && err.name) || '');
    }
  }

  /** Stop capture and hand the audio to main -- only when this page had the microphone. */
  function stopMic(deliver) {
    capturing = false;
    var had = owned;
    owned = false;

    if (recorder) {
      recorder.onaudioprocess = null;
      try { recorder.disconnect(); } catch (e) { /* already torn down */ }
      recorder = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(function (t) { t.stop(); });
      micStream = null;
    }
    analyser = null;
    synthetic = false;
    // Nothing reads the context until the next startMic, which resumes it.
    if (audioCtx && audioCtx.state === 'running') audioCtx.suspend();

    if (!deliver || !had) { chunks = []; return; }

    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var merged = new Float32Array(total);
    var at = 0;
    for (var j = 0; j < chunks.length; j++) {
      merged.set(chunks[j], at);
      at += chunks[j].length;
    }
    chunks = [];
    window.typd.sendAudio(merged.buffer, RATE);
  }

  function readLevel(t) {
    // Preview builds drive the meter from the synthetic envelope so the active
    // state can be inspected without anyone having to talk into the machine.
    if (window.__typdSynthetic) synthetic = true;

    if (native && !window.__typdSynthetic) {
      // The helper's level, measured in main (session:level), read the same way as the analyser's.
      peak = Math.max(peak * 0.995, nativeLevel);
      return Math.min(1, nativeLevel / Math.max(peak, 0.015));
    }
    if (analyser && sampleBuf && !window.__typdSynthetic) {
      analyser.getFloatTimeDomainData(sampleBuf);
      var sum = 0;
      for (var i = 0; i < sampleBuf.length; i++) sum += sampleBuf[i] * sampleBuf[i];
      var rms = Math.sqrt(sum / sampleBuf.length);
      peak = Math.max(peak * 0.995, rms);
      return Math.min(1, rms / Math.max(peak, 0.015));
    }
    if (synthetic && window.__typdSynthetic) {
      var syl = Math.abs(Math.sin(t * 4.1) * Math.sin(t * 2.3 + 1.1));
      var micro = 0.55 + 0.45 * Math.sin(t * 21.7 + 0.6);
      var phrase = 0.5 + 0.5 * Math.sin(t * 0.52 - 0.4);
      return Math.min(1, syl * micro * (phrase > 0.2 ? 1 : 0.07) * 1.7);
    }
    return 0;
  }

  /* ------------------------------------------------------------------ meter */

  /* TODO(meter): the user is choosing a new meter in design/meter-study.html. Leave
   * this one exactly as it is until that choice is made, then land it here (and the
   * constants below) in one change. */

  /* Scrolling peak history, not a row of bars wiggling.
   *
   * The previous meter multiplied one amplitude by a per-bar sine, so it looked
   * busy whether or not anyone was speaking -- decoration dressed as data. Here
   * each bar holds the true peak of one 52ms window and the row glides left, so
   * a moving meter means something moved. Tuned in design/pill-lab.html; these
   * constants travel with overlay.css because the meter is drawn, not styled. */
  var BARS       = 9;      // visible slots of peak history
  var KEEP       = 12;     // stored slots; the extra ones fade out on the left
  var INTERVAL   = 52;     // ms per sample -- 9 of them is ~0.47s of history
  var FLOOR      = 0.02;   // silence is a dotted rule, not a flat line
  var MIN_HALF   = 1.35;   // px, resting half-height
  var BAR_W      = 3;      // px, capped by the slot
  var BAR_R      = 1.5;    // px corner radius (half the bar: round caps)
  var GLIDE      = 1;      // 1 scrolls continuously, 0 steps once per sample
  var DISSOLVE   = 1.3;    // slots over which the leaving bar fades
  var HEADROOM   = 1.5;    // px kept clear so a full-level cap stays round
  var PULSE_H    = 0.55;   // working pulse height; must stay under speaking
  var PULSE_RATE = 1.28;
  var PULSE_SM   = 0.3;

  var history = new Float32Array(KEEP);
  var windowPeak = 0;
  var lastPush = 0;
  var t0 = 0;

  function sizeCanvas() {
    var r = canvas.getBoundingClientRect();
    if (!r.width) return;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function meterColour() {
    return getComputedStyle(root).getPropertyValue('--meter').trim() || '#F4F5F7';
  }

  function push(v) {
    for (var i = 0; i < KEEP - 1; i++) history[i] = history[i + 1];
    history[KEEP - 1] = v;
  }

  // The loop runs only while there is something to draw: listening or working. Idle, the pill is
  // hidden, and redrawing an invisible canvas 60 times a second cost about a
  // third of a CPU core (renderer plus GPU process) with nobody dictating. A note or an error
  // shows words, not the meter, so it does not run then either.
  var drawing = false;
  var live = function () { return state === 'listening' || state === 'working'; };

  // requestAnimationFrame comes at the display's rate: 144 or 240 times a second on a gaming
  // monitor, for a meter that takes a sample every 52 ms. A frame is drawn only once at least
  // this long has passed, which settles on every frame at 60-90 Hz, every 2nd at 120-165 Hz and
  // every 3rd at 240 Hz -- an even cadence, so the glide stays smooth -- at most ~95 a second.
  var FRAME_MS = 10.5;
  var lastDraw = -1e9;

  var colour = null;   // --meter, read once per session rather than every frame

  function wake() {
    if (drawing) return;
    drawing = true;
    requestAnimationFrame(draw);
  }

  function draw(now) {
    if (!live()) {
      drawing = false;
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    requestAnimationFrame(draw);
    if (now - lastDraw < FRAME_MS) return;
    lastDraw = now;
    if (state === 'listening') reportHits();   // the controls move while they unfold

    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    var t = (now - t0) / 1000;

    if (state === 'listening') {
      level += (readLevel(t) - level) * 0.4;
      windowPeak = Math.max(windowPeak, level);
    } else if (state === 'working') {
      // A slow travelling swell, well under speaking height so the two states
      // are never mistaken for each other at a glance.
      var pulse = PULSE_H * (0.5 + 0.5 * Math.sin(t * PULSE_RATE * Math.PI));
      level += (pulse - level) * PULSE_SM;
      windowPeak = Math.max(windowPeak, level);
    }

    if (now - lastPush >= INTERVAL) {
      push(Math.max(FLOOR, windowPeak));
      windowPeak = 0;
      lastPush = now;
    }

    ctx2d.clearRect(0, 0, w, h);

    /* Crispness is three things: geometry snapped to whole device pixels,
       filled rounded rects rather than stroked lines, and no glow anywhere
       near it. All three were wrong once and the row read as smeared. */
    var dpr = ctx2d.getTransform().a || 1;
    var snap = function (v) { return Math.round(v * dpr) / dpr; };

    var slot = w / BARS;
    var barW = snap(Math.min(BAR_W, slot * 0.62));
    var mid = h / 2;
    // Headroom keeps a full-level cap round. Without it a peak bar is exactly
    // canvas height and the round caps clip flat against the edges -- the meter
    // stops being round at precisely the moment it peaks.
    var maxHalf = h / 2 - HEADROOM;

    // Fractional scroll, so the row moves continuously between samples rather
    // than stepping once every 52ms.
    var frac = GLIDE * Math.min(1, (now - lastPush) / INTERVAL);

    if (!colour) colour = meterColour();

    for (var i = 0; i < KEEP; i++) {
      var fromRight = (KEEP - 1 - i) + frac;
      var cx = w - (fromRight + 0.5) * slot;
      if (cx < -slot || cx > w + slot) continue;

      // Bars leaving on the left dissolve rather than vanishing at the edge.
      var a = 1;
      if (cx < DISSOLVE * slot) a = Math.max(0, cx / (DISSOLVE * slot));
      if (a <= 0.01) continue;

      var half = MIN_HALF + history[i] * (maxHalf - MIN_HALF);
      var x = snap(cx - barW / 2);
      var top = snap(mid - half);
      var barH = Math.max(barW, snap(half * 2));

      ctx2d.globalAlpha = a;
      ctx2d.fillStyle = colour;
      ctx2d.beginPath();
      ctx2d.roundRect(x, top, barW, barH, Math.min(BAR_R, barW / 2));
      ctx2d.fill();
    }
    ctx2d.globalAlpha = 1;
  }

  /* --------------------------------------------------------------- progress */

  /* Honest progress, or none.
   *
   * Two phases. Before any token arrives there is nothing to measure, so the
   * fill creeps asymptotically toward a quarter -- it says "alive", never "a
   * quarter done". Once text is streaming, `expect` from the pipeline gives a
   * real target: dictation output tracks the transcript closely and revision is
   * bounded by the span it replaces. It approaches but never reaches full,
   * because a bar sitting at 100% while the user waits is the one thing worse
   * than no bar. Completion is the pill leaving, not the fill arriving. */
  var expectChars = 0;
  var shown = 0;         // last width written, so it never runs backwards
  var creepFrom = 0;

  function setProgress(p) {
    var next = Math.max(shown, Math.min(1, p));
    if (next === shown) return;
    shown = next;
    progressEl.style.width = (next * 100).toFixed(1) + '%';
  }

  function creep(now) {
    if (state !== 'working') return;
    if (expectChars > 0 && shown > 0.25) return;   // real data has taken over
    var secs = (now - creepFrom) / 1000;
    setProgress(0.25 * (1 - Math.exp(-secs / 1.1)));
  }

  function resetProgress() {
    shown = 0;
    expectChars = 0;
    progressEl.style.width = '0%';
  }

  /* ------------------------------------------------------------------ state */

  var creepId = null;

  function setState(s) {
    state = s;
    overlay.setAttribute('data-state', s);
    if (live()) wake();
    // The creep only moves while working, so only then does its timer run.
    if (s === 'working' && !creepId) creepId = setInterval(function () { creep(performance.now()); }, 60);
    if (s !== 'working' && creepId) { clearInterval(creepId); creepId = null; }

    // Controls fold away rather than disappearing: display:none removes them in
    // one frame while the pill takes 260ms to travel, and the morph then reads
    // as two objects swapping instead of one object changing.
    var showControls = s === 'listening';
    cancelBtn.setAttribute('data-off', showControls ? 'false' : 'true');
    confirmBtn.setAttribute('data-off', showControls ? 'false' : 'true');

    // Only failure, and a word learned between sessions, put words in the
    // pill. Everything else is the meter.
    var words = s === 'error' || s === 'note';
    meterLayer.setAttribute('data-on', words ? 'false' : 'true');
    resultEl.setAttribute('data-on', words ? 'true' : 'false');

    if (s !== 'listening') controlsOff();
  }

  function dismiss(delay) {
    var mine = epoch;
    clearTimeout(hideId);
    hideId = setTimeout(function () {
      if (mine !== epoch) return;
      controlsOff();
      overlay.setAttribute('data-visible', 'false');
      setTimeout(function () {
        if (mine !== epoch) return;
        setState('idle');
        resetProgress();
        window.typd.notifyHidden();
      }, EXIT_MS + 40);
    }, delay);
  }

  // Which mode this session is. There is one hotkey; what decides the mode is
  // whether anything was highlighted, which main resolves a beat after the
  // session opens -- usually within ~8 ms, occasionally ~140 ms when it has to
  // ask the application by copying. So the pill opens as dictation and adopts
  // revision when told, rather than waiting to appear until the answer is in.
  //
  // Revision overwrites text the user already has, so the two must not look
  // identical: data-mode is the hook the stylesheet needs to say so, and with
  // one hotkey the pill is now the only thing that says which mode is live.
  var mode = 'dictate';

  function setMode(next) {
    mode = next === 'revise' ? 'revise' : 'dictate';
    overlay.setAttribute('data-mode', mode);
  }

  window.typd.on('session:start', function (p) {
    epoch++;
    clearTimeout(hideId);
    stopMic(false);

    setMode(p.mode);
    resetProgress();

    resultEl.textContent = '';
    t0 = performance.now();
    lastPush = t0;
    peak = 0.02;
    level = 0;
    windowPeak = 0;
    history.fill(0);

    colour = null;   // the scheme can change between sessions (TYPD_PREVIEW_THEME)
    acted = false;
    controlsLive = true;
    native = Boolean(p.native);
    nativeLevel = 0;
    hearing = false;
    overlay.setAttribute('data-hearing', 'false');
    overlay.setAttribute('data-visible', 'true');
    setState('listening');
    reportHits();
    // The start cue plays with the first audio (markHearing): it means "talk now", and now is when the
    // microphone hears. Main says so for its helper; this page's own capture says so on its first block.
    if (!native) startMic();
  });

  window.typd.on('session:hearing', function () { if (native) markHearing(); });
  window.typd.on('session:level', function (p) { if (native && typeof p.rms === 'number' && isFinite(p.rms)) nativeLevel = Math.max(0, p.rms); });
  // The helper failed during this dictation: this page captures from here on (main keeps what came before).
  window.typd.on('session:mic-fallback', function () {
    if (!native || state !== 'listening' || !controlsLive) return;   // never after the key is let go
    native = false;
    nativeLevel = 0;
    startMic();
  });

  window.typd.on('session:mode', function (p) { setMode(p.mode); });

  window.typd.on('session:capture-end', function () {
    window.typdSound.play('commit');
    stopMic(true);   // hands the captured audio to main
    controlsOff();   // they fold on 'thinking'; from here on they mean nothing
  });

  window.typd.on('session:thinking', function () {
    setState('working');
    creepFrom = performance.now();
  });

  window.typd.on('session:expect', function (p) {
    expectChars = p.chars > 0 ? p.chars : 0;
  });

  window.typd.on('session:partial', function (p) {
    // Partials no longer show text -- what they carry now is progress. The tail
    // of a sentence about to appear in the document was the pill asking to be
    // read, twice.
    if (!expectChars) return;
    var got = (p.text || '').length / expectChars;
    // 0.25 is where the creep left off; 0.97 is the ceiling, because the stream
    // routinely overshoots or undershoots the estimate and neither should show.
    setProgress(0.25 + 0.72 * Math.min(1, got));
  });

  window.typd.on('session:done', function () {
    window.typdSound.play(mode === 'revise' ? 'doneRevise' : 'done');
    setProgress(1);
    // No result state. "Pasted into Notepad" is a notification about something
    // already on screen, and the pill's whole job is not to be looked at. The
    // text landing is the confirmation.
    dismiss(LINGER_DONE_MS);
  });

  // Written, but not pasted (0.2.10): there was no text field, or the paste failed. The copy
  // pop-up (main, copy-popup.js) now carries the text and what to do, so the pill just leaves:
  // the done cue when there was simply nowhere to paste, the error cue when the paste failed.
  window.typd.on('session:offered', function (p) {
    controlsOff();
    stopMic(false);
    window.typdSound.play(p.failed ? 'error' : 'done');
    setProgress(1);
    dismiss(LINGER_DONE_MS);
  });

  window.typd.on('session:error', function (p) {
    controlsOff();
    stopMic(false);   // an error can arrive while still listening (a dead mic); never leave it open
    window.typdSound.play('error');
    setState('error');
    resultEl.textContent = p.message || 'Something went wrong';
    dismiss(LINGER_ERROR_MS);
  });

  // Between sessions only, and silent: main sends it when a correction was
  // learned ("Learned “Kaggle”"), and once on the very first launch ("Ready — tap
  // Right Alt and talk"), which stays longer (`ms`). A session that has started
  // owns the pill, and its start clears the note.
  window.typd.on('session:note', function (p) {
    if (state !== 'idle') return;
    epoch++;
    clearTimeout(hideId);
    setMode('dictate');
    resultEl.textContent = p.message || '';
    overlay.setAttribute('data-visible', 'true');
    setState('note');
    dismiss(p.ms > 0 && p.ms <= 15000 ? p.ms : LINGER_NOTE_MS);
  });

  window.typd.on('settings:changed', function (p) {
    if (typeof p.sounds === 'boolean' && window.typdSound) window.typdSound.setEnabled(p.sounds);
    if (typeof p.mic === 'string') micId = p.mic;
    if (typeof p.micLabel === 'string') micLabel = p.micLabel;
  });

  window.typd.on('session:cancel', function () {
    controlsOff();
    window.typdSound.play('cancel');
    stopMic(false);
    dismiss(0);
  });

  /* --------------------------------------------------------------- devices */

  // The input devices, for the tray's Microphone menu. This page already holds the
  // microphone permission, so the names are there; main gets a fresh list whenever
  // a device is plugged in or pulled out.
  function reportDevices() {
    if (!navigator.mediaDevices || !window.typd.devices) return;
    navigator.mediaDevices.enumerateDevices().then(function (all) {
      window.typd.devices(all
        .filter(function (d) { return d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'; })
        .map(function (d) { return { deviceId: d.deviceId, label: d.label }; }));
    }).catch(function () {});
  }
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', reportDevices);
  reportDevices();

  /* ------------------------------------------------------------------- boot */

  window.addEventListener('resize', sizeCanvas);
  new ResizeObserver(sizeCanvas).observe(canvas);
  sizeCanvas();
  setState('idle');
  requestAnimationFrame(function (n) {
    t0 = n;
    lastPush = n;
    creepFrom = n;
    draw(n);
  });

  // The creep runs on its own timer rather than inside draw(), so it keeps
  // moving even in the frames where the canvas has no size yet. setState starts
  // that timer on entering 'working' and stops it on leaving.
})();
