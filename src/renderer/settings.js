// Settings page. Every control writes through window.typdSettings and applies at once (no OK button).
(function () {
  var api = window.typdSettings;
  var $ = function (id) { return document.getElementById(id); };
  var errorEl = $('error');
  var stream = null, ctx = null, raf = 0;

  function fail(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    setTimeout(function () { errorEl.hidden = true; }, 4000);
  }

  async function save(key, value, revert) {
    var ok = await api.set(key, value);
    if (!ok) { fail("Couldn't change that setting."); if (revert) revert(); }
    return ok;
  }

  // ---- microphone: list devices, show a live level so the choice can be checked by speaking
  async function listMics(selected) {
    var sel = $('mic');
    var devices = [];
    try { devices = (await navigator.mediaDevices.enumerateDevices()).filter(function (d) { return d.kind === 'audioinput'; }); } catch (e) {}
    sel.length = 1;
    devices.forEach(function (d) {
      if (d.deviceId === 'default' || d.deviceId === 'communications') return;
      var o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || 'Microphone';
      sel.appendChild(o);
    });
    sel.value = Array.prototype.some.call(sel.options, function (o) { return o.value === selected; }) ? selected : '';
  }

  async function listen(deviceId) {
    stopListening();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
    } catch (e) { $('level').style.width = '0%'; return; }
    ctx = new AudioContext();
    var an = ctx.createAnalyser(); an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    var buf = new Float32Array(an.fftSize);
    (function tick() {
      an.getFloatTimeDomainData(buf);
      var s = 0; for (var i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      var rms = Math.sqrt(s / buf.length);
      var db = 20 * Math.log10(rms + 1e-9);   // -60 dB (room) .. -10 dB (loud speech)
      $('level').style.width = Math.max(0, Math.min(100, Math.round((db + 60) * 2))) + '%';
      raf = requestAnimationFrame(tick);
    })();
  }

  function stopListening() {
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    if (ctx) ctx.close();
    stream = null; ctx = null;
  }

  // ---- load
  async function load() {
    var s = await api.get();
    if (!s) return;
    ['sounds', 'startAtLogin', 'keepRecordings'].forEach(function (k) { $(k).checked = !!s[k]; });
    document.querySelectorAll('.seg button').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-hotkey') === s.hotkey));
    });
    $('recInfo').textContent = s.recordings.count
      ? s.recordings.count + ' recordings, ' + s.recordings.mb + ' MB on this PC. They make the model better at your voice.'
      : 'Saved on this PC to make the model better at your voice.';
    $('about').textContent = 'Model ' + s.model + ' · Typd ' + s.version;
    await listen(s.mic);           // permission first, so the device list has names
    await listMics(s.mic);
  }

  // ---- wire
  ['sounds', 'startAtLogin', 'keepRecordings'].forEach(function (k) {
    $(k).addEventListener('change', function (e) {
      var el = e.target;
      save(k, el.checked, function () { el.checked = !el.checked; });
    });
  });

  $('mic').addEventListener('change', async function (e) {
    var sel = e.target, id = sel.value;
    var label = id ? sel.options[sel.selectedIndex].textContent : '';
    if (await save('mic', id)) { save('micLabel', label); listen(id); }
  });

  document.querySelectorAll('.seg button').forEach(function (b) {
    b.addEventListener('click', async function () {
      var key = b.getAttribute('data-hotkey');
      if (b.getAttribute('aria-checked') === 'true') return;
      if (await save('hotkey', key)) {
        document.querySelectorAll('.seg button').forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); });
      } else {
        fail('That key is taken by another app.');
      }
    });
  });

  $('openRec').addEventListener('click', function () { api.openRecordings(); });
  window.addEventListener('beforeunload', stopListening);
  load();
})();
