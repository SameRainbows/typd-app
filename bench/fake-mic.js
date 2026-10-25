'use strict';

/**
 * A stand-in for typd-mic (native/mic/typd-mic.c) that speaks its protocol, for bench/mic-capture.js and
 * bench/mic-helper.js: JSON lines in, 0xA5-framed audio and status out. FAKE_MIC_MODE picks how it behaves:
 *   ok             opens at once; audio every 10 ms: a ramp (sample k of the capture = ((k % 1000) + 1) / 2000)
 *   zeros          like ok, but every sample is exactly 0 (a Windows privacy switch, a muted microphone)
 *   error-on-open  answers open with an error
 *   exit-on-open   exits (code 3) when asked to open
 *   exit-after     exits after FAKE_MIC_AFTER samples of a capture
 *   no-audio       says opened, then never delivers a sample
 *   garbage        writes bytes that are not a frame
 *   no-hello       never says hello
 * FAKE_MIC_DEVICES: a JSON list for "list" (default: one default microphone and one USB one).
 * FAKE_MIC_LOG: a file each command line is appended to (the bench reads what main sent).
 */

const fs = require('fs');
const mode = process.env.FAKE_MIC_MODE || 'ok';
const after = Number(process.env.FAKE_MIC_AFTER || 3200);
const devices = process.env.FAKE_MIC_DEVICES ? JSON.parse(process.env.FAKE_MIC_DEVICES) : [
  { id: '{0.0.1.00000000}.{aaaa}', name: 'Microphone Array (AMD Audio Device)', default: true },
  { id: '{0.0.1.00000000}.{bbbb}', name: 'Microphone (USB Audio Device)', default: false }
];

function frame(type, payload) {
  const h = Buffer.alloc(6);
  h[0] = 0xa5; h[1] = type.charCodeAt(0); h.writeUInt32LE(payload.length, 2);
  process.stdout.write(Buffer.concat([h, payload]));
}
const status = (o) => frame('S', Buffer.from(JSON.stringify(o), 'utf8'));
function audio(gen, f32) {
  const g = Buffer.alloc(4); g.writeUInt32LE(gen, 0);
  frame('A', Buffer.concat([g, Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)]));
}

let gen = 0, streaming = false, open = false, timer = null, k = 0, holdTimer = null;

function tick() {
  if (!streaming) return;   // held: dropped, never written
  const n = 160;
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++, k++) b[i] = mode === 'zeros' ? 0 : ((k % 1000) + 1) / 2000;
  if (mode === 'exit-after' && k >= after) process.exit(4);
  audio(gen, b);
}

if (mode === 'garbage') { process.stdout.write(Buffer.from('this is not a frame\n')); }
if (mode !== 'no-hello' && mode !== 'garbage') status({ ev: 'hello', version: 'fake', miniaudio: 'none', backend: 'Fake', rate: 16000 });

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (process.env.FAKE_MIC_LOG) fs.appendFileSync(process.env.FAKE_MIC_LOG, line + '\n');
    let c; try { c = JSON.parse(line); } catch { status({ ev: 'error', gen: 0, stage: 'command', code: -2, msg: 'not a command' }); continue; }
    if (c.cmd === 'list') status({ ev: 'devices', list: devices });
    else if (c.cmd === 'open') {
      if (mode === 'error-on-open') { status({ ev: 'error', gen: c.gen, stage: 'open', code: -100, msg: 'Failed to open device' }); continue; }
      if (mode === 'exit-on-open') process.exit(3);
      clearTimeout(holdTimer);
      const warm = open;
      open = true; gen = c.gen; k = 0;
      status({ ev: 'opened', gen, how: warm ? 'warm' : (c.id ? 'id' : 'default'), name: (devices.find((d) => d.id === c.id) || devices[0] || {}).name || '', backend: 'Fake', rate: 16000, channels: 1, deviceRate: 48000, deviceChannels: 2, ms: 1 });
      if (mode === 'no-audio') continue;
      streaming = true;
      if (!timer) timer = setInterval(tick, 10);
    } else if (c.cmd === 'sync') status({ ev: 'synced', gen: c.gen });
    else if (c.cmd === 'hold') {
      streaming = false;
      status({ ev: 'held', open, ms: c.ms });
      clearTimeout(holdTimer);
      if (open) holdTimer = setTimeout(() => { open = false; clearInterval(timer); timer = null; status({ ev: 'closed', why: 'warm window over' }); }, c.ms);
    } else if (c.cmd === 'close') { streaming = false; open = false; clearInterval(timer); timer = null; status({ ev: 'closed', why: 'closed' }); }
    else if (c.cmd === 'quit') process.exit(0);
  }
});
process.stdin.on('end', () => process.exit(0));
