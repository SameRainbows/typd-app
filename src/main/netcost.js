'use strict';

/**
 * Is this connection metered? Asked before a big model download (modelUpdate.js: over 300 MB, Typd
 * asks first on a metered connection and downloads by itself on an unmetered one).
 *
 *   'unmetered'   the system says the connection costs nothing per byte
 *   'metered'     it says it does: a data plan, a phone's hotspot, roaming, Low Data Mode
 *   'unknown'     no answer, or not one we can read -- Typd asks, as on a metered one
 *
 * Windows: the connection profile's cost, from Windows PowerShell 5.1 (WinRT; PowerShell 7 lost
 * that projection), the same value Settings > Network shows as "Metered connection":
 *   Windows.Networking.Connectivity.NetworkInformation::GetInternetConnectionProfile().GetConnectionCost()
 *   NetworkCostType Unrestricted -> unmetered (unless Roaming or OverDataLimit); Fixed or Variable ->
 *   metered; Unknown, or no internet profile -> unknown.
 * macOS: the system's own path flags, through JavaScript for Automation (osascript; nothing native
 * to build): NWPathEvaluator's path -- isExpensive (a phone's hotspot, cellular) and isConstrained
 * (Low Data Mode). If that path is not evaluated, a HEAD request that refuses expensive and
 * constrained networks (NSURLRequest allowsExpensiveNetworkAccess / allowsConstrainedNetworkAccess
 * = NO) asks the URL loading system, which names the reason when it refuses. Anything else: unknown.
 * Other systems: unknown.
 *
 * Electron-free; the runner is passed in, so bench/model-choice.js drives it with fakes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const TIMEOUT_MS = 10000;

const WIN_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[void][Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]',
  '$p = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()',
  "if ($p -eq $null) { 'typd-cost none' } else { $c = $p.GetConnectionCost(); 'typd-cost {0} {1} {2}' -f $c.NetworkCostType, $c.Roaming, $c.OverDataLimit }"
].join('; ');

/** One line of JXA per statement; `url` is checked by the caller (https only). */
function macScript(url) {
  return [
    "ObjC.import('Foundation');",
    'function flag(v) { try { v = ObjC.unwrap(v); } catch (e) {} return v === true || v === 1; }',
    'function viaPath() {',
    "  try { ObjC.import('NetworkExtension'); } catch (e) { return null; }",
    '  try {',
    '    var p = $.NWPathEvaluator.alloc.init.path;',
    '    if (!p || p.isNil()) return null;',
    '    var st = Number(ObjC.unwrap(p.status));',
    '    if (st !== 1 && st !== 3) return null;',
    "    return (flag(p.isExpensive) ? 'expensive' : 'cheap') + ' ' + (flag(p.isConstrained) ? 'constrained' : 'open') + ' path';",
    '  } catch (e) { return null; }',
    '}',
    'function viaRequest(url) {',
    '  try {',
    '    var req = $.NSMutableURLRequest.requestWithURL($.NSURL.URLWithString(url));',
    "    req.HTTPMethod = 'HEAD';",
    '    req.timeoutInterval = 8;',
    '    req.allowsExpensiveNetworkAccess = false;',
    '    req.allowsConstrainedNetworkAccess = false;',
    '    var resp = Ref(), err = Ref();',
    '    $.NSURLConnection.sendSynchronousRequestReturningResponseError(req, resp, err);',
    '    var e = err[0];',
    "    if (!e || e.isNil()) return 'cheap open request';",
    "    var why = e.userInfo.objectForKey('NSURLErrorNetworkUnavailableReasonKey');",
    '    if (!why || why.isNil()) return null;',
    '    var r = Number(ObjC.unwrap(why));',
    "    return r === 2 ? 'cheap constrained request' : 'expensive open request';",
    '  } catch (x) { return null; }',
    '}',
    'function run() {',
    '  var a = viaPath() || viaRequest(' + JSON.stringify(url) + ');',
    "  return 'typd-cost ' + (a || 'unknown');",
    '}'
  ].join('\n');
}

/** 'typd-cost Unrestricted False False' -> 'unmetered', etc. */
function parseWindows(stdout) {
  const m = /typd-cost\s+(\S+)(?:\s+(\S+)\s+(\S+))?/.exec(String(stdout || ''));
  if (!m) return 'unknown';
  const type = m[1].toLowerCase();
  const yes = (s) => String(s || '').toLowerCase() === 'true';
  if (type === 'unrestricted') return yes(m[2]) || yes(m[3]) ? 'metered' : 'unmetered';
  if (type === 'fixed' || type === 'variable') return 'metered';
  return 'unknown';   // Unknown, none (no internet profile)
}

/** 'typd-cost expensive open path' -> 'metered'; 'typd-cost cheap open request' -> 'unmetered'. */
function parseMac(stdout) {
  const m = /typd-cost\s+(expensive|cheap)\s+(constrained|open)\b/.exec(String(stdout || ''));
  if (!m) return 'unknown';
  return m[1] === 'expensive' || m[2] === 'constrained' ? 'metered' : 'unmetered';
}

function runFile(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 }, (err, stdout) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || '') });
      });
    } catch {
      resolve({ code: -1, stdout: '' });
    }
  });
}

/** The JXA script in a file of its own (osascript reads a multi-line script best from a file). */
function macScriptFile(url) {
  const text = macScript(url);
  const file = path.join(os.tmpdir(), 'typd-netcost-' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 12) + '.js');
  try { if (fs.readFileSync(file, 'utf8') === text) return file; } catch { /* not written yet */ }
  fs.writeFileSync(file, text);
  return file;
}

/**
 * 'metered' | 'unmetered' | 'unknown'. Never throws.
 *   url    macOS: what the fallback HEAD request asks (https; the model manifest route)
 */
async function probe({ platform = process.platform, run = runFile, env = process.env, url = 'https://typd-collect.mehmetdedeler.com/v1/model/public/manifest' } = {}) {
  try {
    if (platform === 'win32') {
      const ps = path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const r = await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_SCRIPT]);
      return r.code === 0 ? parseWindows(r.stdout) : 'unknown';
    }
    if (platform === 'darwin') {
      if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9/._-]*$/.test(url)) url = 'https://typd-collect.mehmetdedeler.com/v1/model/public/manifest';
      const r = await run('/usr/bin/osascript', ['-l', 'JavaScript', macScriptFile(url)]);
      return r.code === 0 ? parseMac(r.stdout) : 'unknown';
    }
  } catch { /* fall through */ }
  return 'unknown';
}

module.exports = { probe, parseWindows, parseMac, macScript, WIN_SCRIPT };
