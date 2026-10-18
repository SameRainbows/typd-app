'use strict';

/**
 * A local stand-in for typd-collect's public model routes, for the benches (bench/cuda-pack.js,
 * bench/app-update.js): GET /v1/model/public/manifest, signed like the real one (Ed25519 over
 * SIG_PREFIX + text, X-Typd-Manifest-Key / -Sig), and GET /v1/model/public/file/<version>/<name> with
 * Range. Faults on request: cut a file's connection after N bytes (cutNext), send it once with its last
 * byte flipped (corrupt), go slowly (slow: ms between 64 KB chunks), sign badly or not at all.
 *
 *   const s = await fakeModelServer();   s.endpoint, s.keys (what the app should trust), s.requests
 *   s.publish({full, light, packs})      each entry {version, files: {name: Buffer}, model_json?}
 */

const http = require('http');
const crypto = require('crypto');
const { SIG_PREFIX } = require('../src/main/modelUpdate');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function fakeModelServer() {
  const KP = crypto.generateKeyPairSync('ed25519');
  const KID = 'typd-model-bench';
  const s = {
    keys: { [KID]: KP.publicKey.export({ type: 'spki', format: 'pem' }) },
    manifest: null, seq: Math.floor(Date.now() / 1000), sign: 'ok', files: {}, cutNext: {}, corrupt: {}, slow: 0, requests: [],
    manifestHeaders: {},   // extra headers on the manifest (X-Typd-Check-Every-Sec)
    manifestStatus: 200    // another status for the manifest (500: the server failing)
  };
  s.server = http.createServer((req, res) => {
    s.requests.push({ url: req.url, range: req.headers.range || null, auth: req.headers.authorization || null, at: Date.now() });
    if (req.url === '/v1/model/public/manifest') {
      if (s.manifestStatus !== 200) { res.writeHead(s.manifestStatus); return res.end('{}'); }
      if (!s.manifest) { res.writeHead(404, s.manifestHeaders); return res.end('{}'); }
      const text = JSON.stringify({ ...s.manifest, seq: s.seq }, null, 2) + '\n';
      const headers = { 'Content-Type': 'application/json', ...s.manifestHeaders };
      if (s.sign !== 'none') {
        headers['X-Typd-Manifest-Key'] = KID;
        headers['X-Typd-Manifest-Sig'] = crypto.sign(null, Buffer.from(SIG_PREFIX + (s.sign === 'bad' ? text + ' ' : text)), KP.privateKey).toString('base64');
      }
      res.writeHead(200, headers);
      return res.end(text);
    }
    const m = /^\/v1\/model\/public\/file\/([^/]+)\/([^/]+)$/.exec(req.url);
    const key = m ? decodeURIComponent(m[1]) + '/' + decodeURIComponent(m[2]) : null;
    let body = key && s.files[key];
    if (!body) { res.writeHead(404); return res.end(); }
    const name = decodeURIComponent(m[2]);
    if (s.corrupt[name]) { delete s.corrupt[name]; body = Buffer.from(body); body[body.length - 1] ^= 0xff; }
    const r = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    let start = 0, code = 200;
    const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' };
    if (r) {
      start = Number(r[1]);
      if (start >= body.length) { res.writeHead(416); return res.end(); }
      code = 206;
      headers['Content-Range'] = `bytes ${start}-${body.length - 1}/${body.length}`;
    }
    const part = body.subarray(start);
    headers['Content-Length'] = String(part.length);
    res.writeHead(code, headers);
    const cut = s.cutNext[name];
    if (cut) { delete s.cutNext[name]; res.write(part.subarray(0, cut), () => setTimeout(() => res.destroy(), 30)); return; }
    if (!s.slow) return res.end(part);
    let at = 0;
    const tick = () => {
      if (res.destroyed) return;
      const next = part.subarray(at, at + 65536);
      at += next.length;
      if (at >= part.length) return res.end(next);
      res.write(next);
      setTimeout(tick, s.slow);
    };
    tick();
  });

  /** One manifest entry from {version, files: {name: Buffer}, model_json}: its files go on the server. */
  function entry(e) {
    for (const [n, b] of Object.entries(e.files)) s.files[e.version + '/' + n] = b;
    return {
      version: e.version, files: Object.entries(e.files).map(([name, b]) => ({ name, size: b.length, sha256: sha(b) })),
      ...(e.model_json ? { model_json: e.model_json } : {}), min_app: e.min_app || '0.1.0', notes: e.notes || ''
    };
  }

  /** Publish: the full model at the top level, optional variants and packs; a new seq. */
  s.publish = ({ full, light = null, packs = null }) => {
    s.manifest = { ...entry(full), ...(light ? { variants: { light: entry(light) } } : {}) };
    if (packs) s.manifest.packs = Object.fromEntries(Object.entries(packs).map(([id, p]) => [id, entry(p)]));
    s.seq++;
    return s.manifest;
  };
  s.fileRequests = () => s.requests.filter((q) => q.url.includes('/file/'));

  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => { s.endpoint = `http://127.0.0.1:${s.server.address().port}`; resolve(s); }));
}

module.exports = { fakeModelServer, sha };
