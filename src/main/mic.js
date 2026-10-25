'use strict';

/**
 * The native microphone helper, typd-mic (native/mic/typd-mic.c), seen from the main process (0.2.12).
 *
 * Chromium's capture (getUserMedia + an AudioContext in the pill's page) took 1.1-8 s to hand over the
 * first sample on a busy Windows laptop; the helper opens the same microphone through WASAPI (Core Audio
 * on a Mac) in ~0.15-0.2 s. It is started once, at launch, and waits with the microphone CLOSED. A
 * dictation's key press sends `open`; its audio comes back as framed blocks of 16 kHz mono float32.
 *
 * After a dictation the device stays open for WARM_MS (the warm window) so that a dictation right
 * after it starts at once. The helper drops that audio in its capture callback -- nothing is copied,
 * kept or sent -- and closes the device when the window is over (the operating system's microphone
 * light goes off then). The window is a constant here; TYPD_MIC_WARM_MS overrides it (tests).
 *
 * Anything wrong -- no helper file, a helper that will not start, exits, says "error", or gives no
 * audio within OPEN_TIMEOUT_MS -- and the caller (capture.js) takes Chromium's path instead, as every
 * version before 0.2.12 did. The helper is started again at most MAX_RESTARTS times per run.
 *
 * Protocol (typd-mic.c says it in full): JSON lines in; frames out, 0xA5 <type> <u32 LE length>
 * <payload>: 'A' = <u32 LE gen> + float32 samples, 'S' = a JSON status.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WARM_MS = 30 * 1000;          // after a dictation, the microphone stays open (audio dropped) this long
const OPEN_TIMEOUT_MS = 3000;       // no audio this long after `open`: Chromium's path takes over
const SYNC_TIMEOUT_MS = 300;        // the last samples, at the end of a dictation
const LIST_TIMEOUT_MS = 3000;
const MAX_RESTARTS = 3;
const MAGIC = 0xa5;
const MAX_FRAME = 1 << 22;

/** The helper's file: in the app's resources when packaged, in vendor/ from source. */
function helperPath({ packaged, resourcesPath, root, platform = process.platform, arch = process.arch } = {}) {
  const exe = platform === 'win32' ? 'typd-mic.exe' : 'typd-mic';
  if (packaged) return path.join(resourcesPath, 'mic', exe);
  if (platform === 'darwin') return path.join(root, 'vendor', 'mic-mac', arch === 'arm64' ? 'arm64' : 'x64', exe);
  return path.join(root, 'vendor', 'mic', exe);
}

/**
 * The device the helper should open for a microphone chosen in Settings (its Chromium label), from the
 * helper's own list. Chromium adds to the system's name: " (046d:0825)" for a USB device, and on a Mac
 * the transport (" (Built-in)", " (Bluetooth)", ...). '' = the system default (null). A label with no
 * device: undefined (the caller uses Chromium's path, which then finds the same device or the default,
 * exactly as before).
 */
const SUFFIX = /\s*\((?:[0-9a-f]{4}:[0-9a-f]{4}|built-in|bluetooth|usb|virtual|aggregate|thunderbolt|displayport|hdmi|airplay|pci|firewire|continuity|unknown)\)\s*$/i;
function normLabel(s) {
  let t = String(s || '').trim();
  for (let i = 0; i < 2 && SUFFIX.test(t); i++) t = t.replace(SUFFIX, '').trim();
  return t.toLowerCase();
}
function pickDevice(devices, label) {
  if (!label) return null;
  const list = Array.isArray(devices) ? devices : [];
  const exact = list.find((d) => d.name === label);
  if (exact) return exact;
  const n = normLabel(label);
  const same = list.filter((d) => normLabel(d.name) === n);
  return same.length === 1 ? same[0] : undefined;
}

/** Frames off the helper's stdout. push(chunk) -> [{type:'A', gen, samples} | {type:'S', status}]; throws on garbage. */
function createParser() {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const out = [];
      while (buf.length >= 6) {
        if (buf[0] !== MAGIC) throw new Error('typd-mic: bad frame (byte ' + buf[0] + ')');
        const type = String.fromCharCode(buf[1]);
        const len = buf.readUInt32LE(2);
        if (len > MAX_FRAME) throw new Error('typd-mic: frame too long (' + len + ')');
        if (buf.length < 6 + len) break;
        const body = buf.subarray(6, 6 + len);
        if (type === 'A') {
          if (len < 4 || (len - 4) % 4) throw new Error('typd-mic: bad audio frame');
          const gen = body.readUInt32LE(0);
          // A copy, aligned: the Buffer's offset need not be a multiple of 4.
          const samples = new Float32Array((len - 4) / 4);
          Buffer.from(samples.buffer).set(body.subarray(4));
          out.push({ type: 'A', gen, samples });
        } else if (type === 'S') {
          let status;
          try { status = JSON.parse(body.toString('utf8')); } catch { throw new Error('typd-mic: bad status'); }
          out.push({ type: 'S', status });
        } else {
          throw new Error('typd-mic: unknown frame type ' + buf[1]);
        }
        buf = buf.subarray(6 + len);
      }
      return out;
    }
  };
}

/**
 * The helper, from start to quit.
 *   o.exe        the helper's file
 *   o.log(line)  the life log (one line per thing worth knowing; never audio)
 *   o.debug      console lines (TYPD_DEBUG)
 *   o.warmMs     the warm window (WARM_MS)
 *   o.spawn      child_process.spawn (benches pass a fake)
 */
function createNativeMic(o = {}) {
  const exe = o.exe;
  const log = o.log || (() => {});
  const debug = o.debug || (() => {});
  const spawnImpl = o.spawn || spawn;
  const warmMs = Number.isFinite(o.warmMs) ? o.warmMs : WARM_MS;
  const now = o.now || (() => performance.now());

  let proc = null, parser = null;
  let ready = false;         // "hello" heard
  let disabled = null;       // why the helper is not used for the rest of this run
  let restarts = 0;
  let gen = 0;
  let cap = null;            // the capture being delivered: {gen, handlers, first, opened}
  let devices = [];
  let info = null;           // the hello: version, backend
  let deviceOpen = false;    // as far as the helper last said
  let stopped = false;       // quit: never started again
  const waiting = { synced: new Map(), list: [] };

  function fail(c, why) {
    if (!c || c.failed) return;
    c.failed = why;
    if (cap === c) cap = null;
    try { c.handlers.onFail && c.handlers.onFail(why); } catch (err) { debug('onFail threw', err); }
  }

  function onStatus(s) {
    const ev = s && s.ev;
    if (ev === 'hello') {
      ready = true;
      info = { version: s.version, backend: s.backend, miniaudio: s.miniaudio };
      log('helper ready (typd-mic ' + s.version + ', ' + s.backend + ')');
      send({ cmd: 'list' });
    } else if (ev === 'devices') {
      devices = Array.isArray(s.list) ? s.list.filter((d) => d && typeof d.name === 'string').slice(0, 64) : [];
      for (const w of waiting.list.splice(0)) w(devices);
    } else if (ev === 'opened') {
      deviceOpen = true;
      if (cap && s.gen === cap.gen) {
        cap.opened = { how: s.how, name: s.name, ms: s.ms, deviceRate: s.deviceRate, deviceChannels: s.deviceChannels };
        if (/asked-for device not found/.test(String(s.how))) log('helper: the chosen microphone was not found; the default one is used');
      }
    } else if (ev === 'first-audio') {
      if (cap && s.gen === cap.gen) cap.helperFirstMs = s.ms;
    } else if (ev === 'synced') {
      const w = waiting.synced.get(s.gen);
      if (w) { waiting.synced.delete(s.gen); w(true); }
    } else if (ev === 'error') {
      log('helper error: ' + String(s.stage || '?') + ' ' + String(s.msg || '').slice(0, 80) + (s.code ? ' (' + s.code + ')' : ''));
      if (cap && s.gen === cap.gen) fail(cap, 'error: ' + String(s.msg || s.stage || '?').slice(0, 80));
    } else if (ev === 'closed') {
      deviceOpen = false;
      debug('helper closed the device: ' + s.why);
    } else if (ev === 'stopped') {
      deviceOpen = false;
      log('helper: the microphone stopped (unplugged or taken away)');
      if (cap) {
        if (cap.first === null) fail(cap, 'the microphone stopped');
        else cap.stopped = true;
      }
      send({ cmd: 'list' });
    } else if (ev === 'device-changed') {
      debug('helper: the default device changed');
      send({ cmd: 'list' });
    } else if (ev === 'overflow') {
      log('helper: audio dropped (Typd did not read it in time)');
    } else if (ev === 'held') {
      deviceOpen = Boolean(s.open);
    }
  }

  function onAudio(f) {
    const c = cap;
    if (!c || f.gen !== c.gen || c.failed) return;   // another capture's, or the warm window's tail
    if (c.first === null) {
      c.first = now() - c.t0;
      clearTimeout(c.timer);
      try { c.handlers.onFirst && c.handlers.onFirst(c.first); } catch (err) { debug('onFirst threw', err); }
    }
    try { c.handlers.onAudio(f.samples); } catch (err) { debug('onAudio threw', err); }
  }

  function send(obj) {
    if (!proc || !proc.stdin || proc.stdin.destroyed) return false;
    try { proc.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
  }

  function gone(why) {
    const p = proc;
    proc = null; parser = null; ready = false; deviceOpen = false;
    if (p) { try { p.kill(); } catch { /* already gone */ } }
    for (const w of waiting.synced.values()) w(false);
    waiting.synced.clear();
    for (const w of waiting.list.splice(0)) w(devices);
    if (cap) fail(cap, why);
    if (stopped) return;
    if (restarts >= MAX_RESTARTS) {
      disabled = 'it stopped ' + (restarts + 1) + ' times';
      log('helper: ' + why + '; not used again in this run (Chromium\'s capture from now on)');
      return;
    }
    restarts++;
    log('helper: ' + why + '; starting it again (' + restarts + ' of ' + MAX_RESTARTS + ')');
    setTimeout(start, 500).unref?.();
  }

  function start() {
    if (proc || stopped || disabled) return;
    if (!exe || !fs.existsSync(exe)) {
      disabled = 'no helper file';
      log('helper missing (' + (exe ? path.basename(exe) : 'no path') + '): Chromium\'s capture, as before 0.2.12');
      return;
    }
    let p;
    try {
      p = spawnImpl(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) {
      disabled = 'could not start';
      log('helper could not start (' + String(err && err.message || err).slice(0, 80) + '): Chromium\'s capture');
      return;
    }
    proc = p;
    parser = createParser();
    const mine = p;
    p.on('error', (err) => { if (proc === mine) gone('could not start (' + String(err && err.code || err && err.message || err).slice(0, 40) + ')'); });
    p.on('exit', (code, signal) => { if (proc === mine) gone('exited (' + (signal || 'code ' + code) + ')'); });
    if (p.stdin) p.stdin.on('error', () => { /* the exit handler says why */ });
    p.stdout.on('data', (chunk) => {
      if (proc !== mine) return;
      let frames;
      try { frames = parser.push(chunk); } catch (err) { gone(String(err.message || err)); return; }
      for (const f of frames) {
        if (f.type === 'A') onAudio(f); else onStatus(f.status);
      }
    });
  }

  return {
    start,
    /** Can a dictation use the helper now? */
    usable() { return Boolean(proc && ready && !disabled); },
    get disabled() { return disabled; },
    get info() { return info; },
    get devices() { return devices.slice(); },
    get deviceOpen() { return deviceOpen; },
    get warmMs() { return warmMs; },
    /** The device list, fresh from the helper (the cached one if it does not answer). */
    list() {
      return new Promise((resolve) => {
        if (!send({ cmd: 'list' })) return resolve(devices);
        const t = setTimeout(() => { const i = waiting.list.indexOf(done); if (i >= 0) waiting.list.splice(i, 1); resolve(devices); }, LIST_TIMEOUT_MS);
        const done = (l) => { clearTimeout(t); resolve(l); };
        waiting.list.push(done);
      });
    },
    /** Refresh the cached list (a device came or went). */
    refresh() { send({ cmd: 'list' }); },
    /**
     * Start delivering audio for one capture. `device`: {id, name} from pickDevice, or null for the
     * default. handlers: onAudio(Float32Array), onFirst(ms), onFail(why). Returns the capture, or null
     * when the helper cannot take it (the caller uses Chromium's path).
     */
    open(device, handlers) {
      if (!this.usable()) return null;
      if (cap) fail(cap, 'superseded');
      const c = { gen: ++gen, handlers, t0: now(), first: null, opened: null, failed: null, timer: null, helperFirstMs: null };
      const msg = { cmd: 'open', gen: c.gen };
      if (device && device.id) msg.id = device.id;
      if (device && device.name) msg.name = device.name;
      c.warm = deviceOpen;
      cap = c;
      if (!send(msg)) { cap = null; return null; }
      c.timer = setTimeout(() => { if (cap === c && c.first === null) fail(c, 'no audio ' + OPEN_TIMEOUT_MS / 1000 + ' s after the key'); }, OPEN_TIMEOUT_MS);
      if (c.timer.unref) c.timer.unref();
      return c;
    },
    /** Every sample of capture `c` up to now has been delivered (true), or the helper did not say so in time. */
    sync(c) {
      if (!c || c.failed || cap !== c) return Promise.resolve(false);
      return new Promise((resolve) => {
        if (!send({ cmd: 'sync', gen: c.gen })) return resolve(false);
        const t = setTimeout(() => { waiting.synced.delete(c.gen); resolve(false); }, SYNC_TIMEOUT_MS);
        waiting.synced.set(c.gen, (ok) => { clearTimeout(t); resolve(ok); });
      });
    },
    /** The capture is over: no more audio to Typd; the device stays open for the warm window, its audio dropped. */
    release(c, ms) {
      if (c) { clearTimeout(c.timer); if (cap === c) cap = null; c.failed = c.failed || 'released'; }
      if (cap) return;   // a newer capture is running
      send({ cmd: 'hold', ms: Number.isFinite(ms) ? ms : warmMs });
    },
    /** Close the device now (the warm window ends early). */
    close() { if (cap) fail(cap, 'closed'); send({ cmd: 'close' }); },
    /** For good: Typd is quitting. */
    quit() {
      stopped = true;
      const p = proc;
      if (cap) fail(cap, 'quit');
      if (!p) return;
      send({ cmd: 'quit' });
      try { p.stdin.end(); } catch { /* gone */ }
      const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 600);
      if (t.unref) t.unref();
      proc = null;
    }
  };
}

module.exports = { createNativeMic, createParser, helperPath, pickDevice, normLabel, WARM_MS, OPEN_TIMEOUT_MS, SYNC_TIMEOUT_MS, MAX_RESTARTS };
