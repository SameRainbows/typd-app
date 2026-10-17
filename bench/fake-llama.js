'use strict';

/**
 * A stand-in llama-server for the benches: local.js talks to it exactly as to the real one
 * (it finds a server already up on TYPD_LLAMA_PORT and reuses it). Every request's audio is
 * decoded back to samples and handed to `answer`, which says what the "model" writes.
 *
 *   const fake = await fakeLlama({ answer: (req) => ({ text, logprobs }), msPerAudioSecond })
 *   fake.port, fake.requests (every body, parsed, with its audio), fake.maxInFlight, fake.close()
 *
 * `req` = {body, system, assistant (the answer's opening, if any), audio (Float32Array, 16 kHz),
 * seconds}. `answer` may return a string or {text, logprobs, finish}. Streamed requests get the
 * text in word-sized chunks; one-shot requests one JSON reply (with `logprobs` when given).
 */

const http = require('http');

function readWav(buf) {
  let off = 12;
  while (off + 8 <= buf.length && buf.toString('ascii', off, off + 4) !== 'data') off += 8 + buf.readUInt32LE(off + 4);
  const n = Math.floor(buf.readUInt32LE(off + 4) / 2);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = buf.readInt16LE(off + 8 + 2 * i) / 32768;
  return s;
}

function fakeLlama({ answer, msPerAudioSecond = 0, tokenChars = 4 } = {}) {
  const fake = { requests: [], inFlight: 0, maxInFlight: 0 };
  fake.server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"ok"}'); }
    if (req.url === '/lora-adapters') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('[]'); }
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', async () => {
      if (req.url === '/tokenize') {
        let content = '';
        try { content = JSON.parse(b).content || ''; } catch { /* empty */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ tokens: new Array(Math.ceil(content.length / tokenChars)).fill(1) }));
      }
      if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
      let body = {};
      try { body = JSON.parse(b); } catch { /* answered below */ }
      const msgs = body.messages || [];
      const user = msgs.find((m) => m.role === 'user');
      const parts = user && Array.isArray(user.content) ? user.content.filter((c) => c.type === 'input_audio') : [];
      const chunks = parts.map((c) => readWav(Buffer.from(c.input_audio.data, 'base64')));
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const audio = new Float32Array(total);
      let at = 0;
      for (const c of chunks) { audio.set(c, at); at += c.length; }
      const last = msgs[msgs.length - 1];
      const r = {
        body, audio, seconds: total / 16000,
        system: (msgs.find((m) => m.role === 'system') || {}).content || '',
        assistant: last && last.role === 'assistant' ? last.content : null
      };
      fake.requests.push(r);
      fake.inFlight++;
      fake.maxInFlight = Math.max(fake.maxInFlight, fake.inFlight);
      let aborted = false;
      res.on('close', () => { aborted = !res.writableEnded; });
      try {
        let out = answer ? await answer(r) : 'Fine.';
        if (typeof out === 'string') out = { text: out };
        const wait = msPerAudioSecond * r.seconds;
        if (wait > 0 && body.max_tokens !== 1) await new Promise((ok) => setTimeout(ok, wait));
        if (aborted) return;
        if (!body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: out.finish || 'stop', message: { role: 'assistant', content: out.text }, ...(out.logprobs ? { logprobs: { content: out.logprobs } } : {}) }] }));
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const pieces = String(out.text).match(/\s*\S+/g) || [];
        for (const p of pieces) res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: p }, finish_reason: null }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: out.finish || 'stop' }] }) + '\n\n');
        res.end('data: [DONE]\n\n');
      } finally {
        fake.inFlight--;
      }
    });
  });
  return new Promise((resolve) => fake.server.listen(0, '127.0.0.1', () => {
    fake.port = fake.server.address().port;
    fake.close = () => new Promise((ok) => fake.server.close(() => ok()));
    resolve(fake);
  }));
}

module.exports = { fakeLlama, readWav };
