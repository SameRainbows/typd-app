'use strict';

/**
 * A dictation's microphone, from the key press to the audio the pipeline gets (0.2.12).
 *
 * Two ways in, one way out:
 *   - the native helper (mic.js, typd-mic): main opens the microphone itself at the key press, and its
 *     16 kHz blocks come straight here;
 *   - Chromium's capture, as in every version before 0.2.12: the pill's page opens the microphone
 *     (overlay.js startMic) and sends its blocks by IPC (overlay:chunk, then overlay:audio at the end).
 * Either way the blocks feed the same paths: the live stream (work while you talk, pipeline.openStream)
 * for a dictation, the whole recording at the end (the pipeline, the kept recording, sharing) for both
 * modes. With the helper, main also measures the level for the pill's meter (session:level) and says
 * when the first audio has arrived (session:hearing): the pill shows "listening" only then.
 *
 * The helper is used when it is running and, on a Mac, only once macOS has said yes to the microphone
 * (permissions-mac.js asks; the helper is never the one that makes macOS ask). A microphone chosen in
 * Settings is found by its name in the helper's list; a name the helper does not know goes to Chromium,
 * which finds the device by its id or name exactly as before. If the helper fails during a dictation --
 * an error, no audio within 3 s, the helper gone -- the pill's page takes over at once (session:mic-fallback)
 * and what the helper had captured stays at the start of the recording. Each such fall back is one line
 * in the life log.
 *
 * Silence: a real microphone never delivers exact zeros. 1.5 s of nothing but zeros from the helper is
 * what a muted microphone looks like: the same "silent" problem the page reports (overlay:mic). With
 * Windows' privacy switch off the helper is not used at all: Windows marks such packets silent, which
 * Chromium turns into exact zeros and miniaudio does not look at. On a Mac the helper's zeros could also
 * mean macOS judged the helper differently from Typd, so there the page takes over instead (and the
 * helper is not used again in this run): the page's own capture then says whether it is really silent.
 */

const RATE = 16000;
const SILENT_SAMPLES = 24 * 1024;   // = the page's SILENT_BLOCKS x 1024: about 1.5 s
const STREAM_BLOCK = 1024;          // the page's block size: the stream gets the same pieces either way
const LEVEL_MS = 33;                // the pill's meter, ~30 times a second

function createCapture(o) {
  const send = o.send;
  const log = o.log || (() => {});
  const debug = o.debug || (() => {});
  const now = o.now || (() => performance.now());
  const isMac = Boolean(o.isMac);
  let nativeOff = null;   // why the helper is not used for the rest of this run (decided here)
  let notFoundLabel = null;   // said once per name

  function micReady() {
    const mic = o.mic;
    if (!mic || nativeOff || !mic.usable()) return false;
    if (isMac && !(o.macMicGranted && o.macMicGranted())) return false;
    // Windows' privacy switch off: Chromium's capture, which turns the packets Windows marks silent into
    // the exact zeros the pill reports (miniaudio passes such a packet's bytes on as they are).
    if (!isMac && o.privacyBlocked && o.privacyBlocked()) return false;
    return true;
  }

  /** The live stream: a dictation's audio while the user talks (pipeline.openStream). */
  function pushStream(current, samples) {
    if (current.mode !== 'dictate') return;
    if (current.stream === undefined) current.stream = o.openStream(current);
    if (!current.stream) return;
    current.stream.push(samples);
  }

  function flushStream(current, cap) {
    if (!cap.pending.length) return;
    const n = cap.pending.reduce((s, b) => s + b.length, 0);
    const block = new Float32Array(n);
    let at = 0;
    for (const b of cap.pending) { block.set(b, at); at += b.length; }
    cap.pending = [];
    cap.pendingN = 0;
    pushStream(current, block);
  }

  function merged(chunks, extra) {
    let n = extra ? extra.length : 0;
    for (const c of chunks) n += c.length;
    const out = new Float32Array(n);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    if (extra) out.set(extra, at);
    return out;
  }

  /** The helper's audio for this session. */
  function onNative(current, cap, samples) {
    if (cap.switched || cap.ended || current.capture !== cap) return;
    if (cap.firstMs === null) {
      cap.firstMs = now() - cap.t0;
      cap.firstFrom = 'helper';
      send('session:hearing', {});
      debug('[typd:mic] first audio ' + cap.firstMs.toFixed(0) + ' ms after the key (helper' + (cap.handle && cap.handle.warm ? ', warm' : '') + ')');
    }
    cap.chunks.push(samples);
    cap.total += samples.length;

    // The pill's meter: the RMS of what arrived since the last report.
    for (let i = 0; i < samples.length; i++) cap.sq += samples[i] * samples[i];
    cap.sqN += samples.length;
    const t = now();
    if (t - cap.levelAt >= LEVEL_MS && cap.sqN) {
      send('session:level', { rms: Math.sqrt(cap.sq / cap.sqN) });
      cap.sq = 0; cap.sqN = 0; cap.levelAt = t;
    }

    if (!cap.heard) {
      for (let i = 0; i < samples.length; i++) if (samples[i] !== 0) { cap.heard = true; break; }
      if (!cap.heard) {
        cap.zeros += samples.length;
        if (cap.zeros >= SILENT_SAMPLES && !cap.silentSaid) {
          cap.silentSaid = true;
          if (isMac) {
            nativeOff = 'only silence on a Mac';
            fallback(current, 'gave only silence (on a Mac: Chromium\'s capture decides)');
          } else {
            o.problem(current, 'silent', 'helper');
          }
          return;
        }
      }
    }

    cap.pending.push(samples);
    cap.pendingN += samples.length;
    if (cap.pendingN >= STREAM_BLOCK) flushStream(current, cap);
  }

  /** The helper failed this dictation: the page takes over, and the helper's audio so far is kept. */
  function fallback(current, why) {
    const cap = current.capture;
    // Not once the key is let go (end): the page would start recording after the dictation; what the
    // helper delivered is the recording then.
    if (!cap || !cap.native || cap.switched || cap.ended || cap.ending) return;
    cap.switched = why;
    flushStream(current, cap);
    if (o.mic && cap.handle) o.mic.release(cap.handle, 0);   // the device closes: Chromium opens it now
    log('helper ' + why + ': this dictation uses Chromium\'s capture');
    send('session:mic-fallback', {});
  }

  return {
    /** The key press: open the microphone for `current`. Returns {native} for session:start. */
    begin(current) {
      const cap = {
        native: false, handle: null, t0: now(), firstMs: null, firstFrom: null,
        chunks: [], total: 0, pending: [], pendingN: 0, sq: 0, sqN: 0, levelAt: 0,
        heard: false, zeros: 0, silentSaid: false, switched: null, ended: false
      };
      current.capture = cap;
      if (!micReady()) return { native: false };

      const label = o.settings.label();
      const id = o.settings.id();
      let device = null;
      if (id || label) {
        device = label ? pickDeviceFor(o.mic, label) : undefined;
        if (device === undefined) {
          // Not in the helper's list (or chosen before labels were kept): Chromium finds it as before.
          if (notFoundLabel !== label) log('the chosen microphone (' + String(label || 'no name').slice(0, 60) + ') is not in the helper\'s list: Chromium\'s capture');
          notFoundLabel = label;
          o.mic.refresh();
          return { native: false };
        }
      }
      const handle = o.mic.open(device, {
        onAudio: (s) => onNative(current, cap, s),
        onFirst: () => {},
        onFail: (why) => { if (current.capture === cap) fallback(current, why); }
      });
      if (!handle) return { native: false };
      cap.native = true;
      cap.handle = handle;
      return { native: true };
    },

    /** A block from the page's capture (overlay:chunk). */
    rendererChunk(current, samples) {
      const cap = current.capture;
      if (cap && cap.native && !cap.switched) return;   // the page should not be capturing
      if (cap && cap.firstMs === null) { cap.firstMs = now() - cap.t0; cap.firstFrom = 'chromium'; debug('[typd:mic] first audio ' + cap.firstMs.toFixed(0) + ' ms after the key (Chromium)'); }
      pushStream(current, samples);
    },

    /**
     * The page's recording (overlay:audio). Null when the page should not have one (the helper had
     * the microphone); after a fall back, the helper's part first.
     */
    rendererAudio(current, samples) {
      const cap = current.capture;
      if (cap && cap.native && !cap.switched) return null;
      if (cap && cap.native && cap.chunks.length) return { samples: merged(cap.chunks, samples), sampleRate: RATE };
      return { samples, sampleRate: RATE };
    },

    /**
     * The key is let go. The helper's recording ({samples, sampleRate}) once its last samples are in;
     * null when the page's capture has it (overlay:audio brings it).
     */
    async end(current) {
      const cap = current.capture;
      if (!cap || !cap.native || cap.switched) { if (cap) cap.ended = true; return null; }
      cap.ending = true;
      await o.mic.sync(cap.handle);
      cap.ended = true;
      flushStream(current, cap);
      o.mic.release(cap.handle);   // the warm window: open, its audio dropped in the helper
      return { samples: merged(cap.chunks), sampleRate: RATE };
    },

    /** Cancelled, failed or superseded: nothing more is wanted from the microphone. */
    stop(current) {
      const cap = current && current.capture;
      if (!cap || cap.ended) return;
      cap.ended = true;
      if (cap.native && !cap.switched && o.mic) o.mic.release(cap.handle);
    },

    /** For the life log's dictation line: which microphone path, and the key-to-first-audio time. */
    timing(current) {
      const cap = current && current.capture;
      if (!cap) return null;
      const how = cap.native ? (cap.switched ? 'helper, then Chromium' : 'helper' + (cap.handle && cap.handle.warm ? ' (warm)' : '')) : 'Chromium';
      return { how, firstMs: cap.firstMs };
    },

    get nativeOff() { return nativeOff; }
  };
}

function pickDeviceFor(mic, label) {
  return require('./mic').pickDevice(mic.devices, label);
}

module.exports = { createCapture, SILENT_SAMPLES, STREAM_BLOCK, RATE };
