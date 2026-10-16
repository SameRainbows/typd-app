'use strict';

// The Typd window's page. Everything it does goes through window.typdHome (preload/home.js);
// everything it shows that came from a person -- dictations, words, device names -- is set
// as text, never as markup.
(function () {
  var api = window.typdHome;
  var fold = window.typdSearch;
  var $ = function (id) { return document.getElementById(id); };
  var S = null;                 // the last home:get
  var current = 'home';

  /* ----------------------------------------------------------------- helpers */

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function keycaps(parts) {
    var wrap = el('span', 'keys');
    (parts || []).forEach(function (p) { wrap.appendChild(el('span', 'key', p)); });
    return wrap;
  }

  /** A sentence with {key} replaced by the hotkey's keycaps. */
  function withKeys(target, sentence, parts) {
    target.textContent = '';
    var bits = String(sentence).split('{key}');
    bits.forEach(function (b, i) {
      if (b) target.appendChild(document.createTextNode(b));
      if (i < bits.length - 1) target.appendChild(keycaps(parts));
    });
  }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  function minutes(sec) {
    var m = Math.round((sec || 0) / 60);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    return h + ' h ' + (m % 60 ? (m % 60) + ' min' : '');
  }

  var toastTimer = 0;
  function toast(text, undo) {
    clearTimeout(toastTimer);
    $('toastText').textContent = text;
    var btn = $('toastUndo');
    btn.hidden = !undo;
    btn.onclick = undo ? function () { $('toast').hidden = true; undo(); } : null;
    $('toast').hidden = false;
    toastTimer = setTimeout(function () { $('toast').hidden = true; }, undo ? 6000 : 2200);
  }

  /* -------------------------------------------------------------- navigation */

  function show(section) {
    if (!document.querySelector('.section[data-section="' + section + '"]')) section = 'home';
    current = section;
    document.querySelectorAll('.section').forEach(function (s) {
      s.hidden = s.getAttribute('data-section') !== section;
    });
    document.querySelectorAll('.nav-item').forEach(function (b) {
      b.setAttribute('aria-current', String(b.getAttribute('data-section') === section));
    });
    if (section !== 'settings' && hk.mode === 'capture') cancelCapture();
    if (section === 'history') loadHistory();
    if (section === 'dictionary') loadWords();
    if (section === 'news') loadNews();
    meterWanted();
    document.querySelector('.main').scrollTop = 0;
  }

  document.querySelectorAll('.nav-item').forEach(function (b) {
    b.addEventListener('click', function () { show(b.getAttribute('data-section')); });
  });

  /* -------------------------------------------------------------------- home */

  function renderMark(mark) {
    var svg = $('mark');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!mark) return;
    svg.setAttribute('viewBox', mark.viewBox || '0 0 16 16');
    mark.paths.forEach(function (p) {
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', p.d);
      path.setAttribute('fill-rule', p.rule || 'nonzero');
      path.setAttribute('class', p.role === 'dot' ? 'dot' : 'ink');
      svg.appendChild(path);
    });
  }

  function renderStatus(status, perms) {
    var card = $('statusCard');
    card.setAttribute('data-state', status.state);
    withKeys($('statusLine'), status.card, S.hotkey.parts);
    var m = S.model || {};
    $('modelLine').textContent = status.state === 'loading'
      ? 'Loading the speech model on this ' + S.platform.machine + '.'
      : 'Speech model ' + (m.name || '') + ' · on this ' + S.platform.machine + (m.device ? ' · ' + m.device : '');
    var btn = $('statusAction');
    if (status.action) {
      btn.hidden = false;
      btn.textContent = status.action.label;
      btn.onclick = function () { doAction(status.action.id); };
    } else if (status.state === 'ready') {
      btn.hidden = false;
      btn.textContent = 'Change';
      btn.onclick = function () { show('settings'); startCapture(); };
    } else {
      btn.hidden = true;
    }
    renderPerms(perms || []);
  }

  function doAction(id) {
    if (id === 'hotkey') { show('settings'); startCapture(); return; }
    api.action(id);
  }

  var PERMS = {
    microphone: ['Microphone', 'to hear you'],
    accessibility: ['Accessibility', 'to paste and read what you highlight'],
    input: ['Input Monitoring', 'to hear your key in other apps']
  };

  function renderPerms(off) {
    var box = $('perms');
    if (!S.platform.mac || !off.length) { box.hidden = true; return; }
    box.hidden = false;
    $('permsHead').textContent = 'Before Typd can type for you';
    var rows = $('permsRows');
    rows.textContent = '';
    ['microphone', 'accessibility', 'input'].forEach(function (k) {
      var row = el('div', 'perm');
      var isOff = off.indexOf(k) !== -1;
      row.appendChild(el('span', 'tick', isOff ? '○' : '✓'));
      row.appendChild(el('span', 'what', PERMS[k][0] + ' — ' + PERMS[k][1]));
      if (isOff) {
        var b = el('button', 'btn', 'Open System Settings');
        b.type = 'button';
        b.onclick = function () { api.pane(k); };
        row.appendChild(b);
      } else {
        row.appendChild(el('span', 'dim small', 'On'));
      }
      rows.appendChild(row);
    });
    $('permsNote').textContent = 'Turn on Typd in each list. This card updates by itself.';
  }

  function renderCounts(c) {
    $('cDictations').textContent = (c.dictations || 0).toLocaleString();
    $('cWords').textContent = (c.weekWords || 0).toLocaleString();
    $('cSaved').textContent = (c.savedSeconds >= 60 ? '≈ ' : '') + minutes(c.savedSeconds);
    $('cSavedL').textContent = 'saved vs typing at ' + c.typingWpm + ' wpm';
    $('countsNote').hidden = c.dictations > 0;
  }

  function renderTip() {
    var h = S.hotkey;
    withKeys($('tip'), 'To revise, highlight text first, then ' + h.verb + ' {key} and say the change.', h.parts);
  }

  /* ----------------------------------------------------------------- history */

  var H = { items: [], keep: '30d', shown: 200, pending: null };

  function loadHistory() {
    return api.history.list().then(function (r) {
      if (!r) return;
      H.items = r.items;
      H.keep = r.keep;
      $('keep').value = r.keep;
      renderHistory();
    });
  }

  function dayLabel(iso) {
    var d = new Date(iso);
    var today = new Date();
    var yest = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yest.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function renderHistory() {
    var host = $('entries');
    host.textContent = '';
    var q = $('q').value.trim();
    var list = q ? H.items.filter(function (s) { return fold.matches(s.text + ' ' + (s.app || ''), q); }) : H.items;
    $('clearAll').hidden = !H.items.length;
    $('q').hidden = !H.items.length && !q;

    if (!list.length) {
      var msg = H.keep === 'off' ? "History is off. Typd isn't keeping your dictations."
        : q ? 'No dictation contains “' + q + '”.'
        : 'Nothing yet. Your dictations show up here, on this ' + S.platform.machine + ' only.';
      host.appendChild(el('p', 'empty', msg));
      $('more').hidden = true;
      return;
    }

    var day = null;
    list.slice(0, H.shown).forEach(function (s) {
      var label = dayLabel(s.at);
      if (label !== day) { day = label; host.appendChild(el('div', 'day', label)); }
      host.appendChild(entry(s));
    });
    $('more').hidden = list.length <= H.shown;
  }

  function entry(s) {
    var row = el('div', 'entry');
    row.appendChild(el('div', 'entry-time', new Date(s.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })));

    var body = el('div', 'entry-body');
    var text = el('div', 'entry-text', s.text);
    text.title = 'Show all';
    text.addEventListener('click', function () {
      row.setAttribute('data-open', String(row.getAttribute('data-open') !== 'true'));
    });
    body.appendChild(text);
    var meta = el('div', 'entry-meta');
    if (s.mode === 'revise') meta.appendChild(el('span', 'tag', 'Revised'));
    if (s.outcome === 'copied') meta.appendChild(el('span', 'tag', 'Copied, not pasted'));
    if (s.app) meta.appendChild(el('span', null, cap(s.app)));
    meta.appendChild(el('span', null, s.words + (s.words === 1 ? ' word' : ' words')));
    body.appendChild(meta);
    row.appendChild(body);

    var actions = el('div', 'entry-actions');
    var copy = el('button', 'btn', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', function () {
      api.history.copy(s.id).then(function (ok) { toast(ok ? 'Copied' : "Couldn't copy that"); });
    });
    var del = el('button', 'btn', 'Delete');
    del.type = 'button';
    del.addEventListener('click', function () {
      api.history.remove(s.id).then(function (ok) {
        if (!ok) return;
        H.items = H.items.filter(function (x) { return x.id !== s.id; });
        renderHistory();
        toast('Deleted', function () { api.history.undo(s.id).then(loadHistory); });
      });
    });
    actions.appendChild(copy);
    actions.appendChild(del);
    row.appendChild(actions);
    return row;
  }

  function confirmBox(text, yes, onYes, onNo) {
    $('historyConfirmText').textContent = text;
    $('historyConfirmYes').textContent = yes;
    $('historyConfirm').hidden = false;
    $('historyConfirmYes').onclick = function () { $('historyConfirm').hidden = true; onYes(); };
    $('historyConfirmNo').onclick = function () { $('historyConfirm').hidden = true; if (onNo) onNo(); };
    $('historyConfirmNo').focus();
  }

  $('q').addEventListener('input', function () { H.shown = 200; renderHistory(); });
  $('more').addEventListener('click', function () { H.shown += 200; renderHistory(); });

  $('keep').addEventListener('change', function (e) {
    var v = e.target.value;
    var apply = function () {
      api.history.keep(v).then(function (r) {
        if (!r) return;
        H.items = r.items; H.keep = r.keep;
        renderHistory();
      });
    };
    if (v === 'off' && H.items.length) {
      var n = H.items.length;
      confirmBox('Stop keeping history and delete ' + n + (n === 1 ? ' dictation' : ' dictations') + '?', 'Turn off', apply,
        function () { e.target.value = H.keep; });
    } else {
      apply();
    }
  });

  $('clearAll').addEventListener('click', function () {
    var n = H.items.length;
    confirmBox('Delete all ' + n + (n === 1 ? ' dictation' : ' dictations') + '? Your counts on Home stay.', 'Delete all', function () {
      api.history.clear().then(function () { H.items = []; renderHistory(); toast('History deleted'); });
    });
  });

  /* -------------------------------------------------------------- dictionary */

  var W = { entries: [] };

  function loadWords() {
    return api.dictionary.list().then(function (list) {
      W.entries = Array.isArray(list) ? list : [];
      renderWords();
    });
  }

  function shortDate(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function renderWords(flash) {
    var host = $('words');
    host.textContent = '';
    $('dq').hidden = W.entries.length <= 30;
    var q = $('dq').hidden ? '' : $('dq').value.trim();
    var list = W.entries.slice().sort(function (a, b) { return String(b.addedAt).localeCompare(String(a.addedAt)); });
    if (q) list = list.filter(function (e) { return fold.matches(e.term + ' ' + (e.heardAs || []).join(' '), q); });

    if (!list.length) {
      host.appendChild(el('p', 'empty', q ? 'No word matches “' + q + '”.'
        : 'Nothing yet. Fix a word after Typd pastes it and it shows up here — or add one above.'));
      return;
    }
    list.forEach(function (e) {
      var row = el('div', 'word');
      if (flash && e.term.toLowerCase() === flash.toLowerCase()) row.setAttribute('data-flash', 'true');
      row.appendChild(el('span', 'word-term', e.term));
      var heard = (e.heardAs || []).filter(Boolean);
      row.appendChild(el('span', 'word-heard', heard.length ? 'heard as ' + heard.map(function (h) { return '“' + h + '”'; }).join(', ') : ''));
      row.appendChild(el('span', 'word-meta', (e.source === 'auto' ? 'Learned' : 'Added') + (e.addedAt ? ' · ' + shortDate(e.addedAt) : '')));
      var x = el('button', 'word-remove', '×');
      x.type = 'button';
      x.title = 'Remove “' + e.term + '”';
      x.setAttribute('aria-label', 'Remove ' + e.term);
      x.addEventListener('click', function () {
        api.dictionary.remove(e.term).then(function (r) {
          if (!r) return;
          W.entries = r.entries;
          renderWords();
          if (r.ok) toast('Removed “' + e.term + '”', function () {
            api.dictionary.undo(e.term).then(function (u) { if (u) { W.entries = u.entries; renderWords(e.term); } });
          });
        });
      });
      row.appendChild(x);
      host.appendChild(row);
    });
  }

  $('addForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var input = $('newWord');
    api.dictionary.add(input.value).then(function (r) {
      if (!r) return;
      $('addError').hidden = r.ok;
      if (!r.ok) {
        $('addError').textContent = r.reason;
        if (r.entries) { W.entries = r.entries; renderWords(r.term); }
        return;
      }
      input.value = '';
      W.entries = r.entries;
      renderWords(r.term);
    });
  });
  $('newWord').addEventListener('input', function () { $('addError').hidden = true; });
  $('dq').addEventListener('input', function () { renderWords(); });
  $('reveal').addEventListener('click', function () { api.dictionary.reveal(); });

  /* ---------------------------------------------------------------- settings */

  var stream = null, actx = null, raf = 0;

  function listen(deviceId) {
    stopListening();
    return navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true })
      .then(function (s) {
        if (!meterOn) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
        stream = s;
        actx = new AudioContext();
        var an = actx.createAnalyser(); an.fftSize = 1024;
        actx.createMediaStreamSource(stream).connect(an);
        var buf = new Float32Array(an.fftSize);
        (function tick() {
          an.getFloatTimeDomainData(buf);
          var sum = 0; for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          var db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9);   // -60 dB (room) .. -10 dB (speech)
          $('level').style.width = Math.max(0, Math.min(100, Math.round((db + 60) * 2))) + '%';
          raf = requestAnimationFrame(tick);
        })();
      })
      .catch(function () { $('level').style.width = '0%'; });
  }

  function stopListening() {
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    if (actx) actx.close();
    stream = null; actx = null;
    $('level').style.width = '0%';
  }

  // The microphone is open only while Settings is on screen and the window has focus: a
  // look at History must not light the system's microphone indicator.
  var meterOn = false;
  function meterWanted() {
    var want = current === 'settings' && document.hasFocus() && !document.hidden;
    if (want === meterOn) return;
    meterOn = want;
    if (want) listen(S && S.settings.mic).then(listMics); else stopListening();
  }
  window.addEventListener('focus', meterWanted);
  window.addEventListener('blur', meterWanted);
  document.addEventListener('visibilitychange', meterWanted);

  function listMics() {
    var sel = $('mic');
    var selected = S.settings.mic;
    return navigator.mediaDevices.enumerateDevices().then(function (all) {
      sel.length = 1;
      all.filter(function (d) { return d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'; })
        .forEach(function (d) {
          var o = document.createElement('option');
          o.value = d.deviceId;
          o.textContent = d.label || 'Microphone';
          sel.appendChild(o);
        });
      var has = Array.prototype.some.call(sel.options, function (o) { return o.value === selected; });
      if (!has && selected) {
        var gone = document.createElement('option');
        gone.value = selected;
        gone.textContent = (S.settings.micLabel || 'Microphone') + ' (not connected)';
        sel.appendChild(gone);
      }
      sel.value = selected || '';
    }).catch(function () {});
  }

  $('mic').addEventListener('change', function (e) {
    var sel = e.target, id = sel.value;
    var label = id ? sel.options[sel.selectedIndex].textContent.replace(/ \(not connected\)$/, '') : '';
    api.settings.set('mic', id).then(function (ok) {
      if (!ok) { failSettings("Couldn't change the microphone."); return; }
      api.settings.set('micLabel', label);
      S.settings.mic = id; S.settings.micLabel = label;
      if (meterOn) listen(id);
    });
  });

  function failSettings(msg) {
    var e = $('settingsError');
    e.textContent = msg;
    e.hidden = false;
    setTimeout(function () { e.hidden = true; }, 5000);
  }

  ['sounds', 'startAtLogin', 'keepRecordings', 'showInDock'].forEach(function (k) {
    $(k).addEventListener('change', function (e) {
      var box = e.target;
      api.settings.set(k, box.checked).then(function (ok) {
        if (!ok) { box.checked = !box.checked; failSettings("Couldn't change that setting."); }
        else { S.settings[k] = box.checked; renderRecordings(); }
      });
    });
  });

  $('openRec').addEventListener('click', function () { api.settings.openRecordings(); });
  $('feedback').addEventListener('click', function () { api.feedback(); });

  function renderRecordings() {
    var s = S.settings, m = S.platform.machine;
    $('recInfo').textContent = s.recordings.count
      ? s.recordings.count.toLocaleString() + ' recordings, ' + s.recordings.mb.toLocaleString() + ' MB on this ' + m + '. They make the model better at your voice.'
      : 'Saved on this ' + m + ' to make the model better at your voice.';
    // A tester build: one line inside this row, with a pause (sharing.js, mode 'tester').
    var sh = s.sharing;
    var tester = Boolean(sh && sh.mode === 'tester');
    $('shareLine').hidden = !tester;
    if (tester) {
      var word = sh.state === 'stopped' ? 'stopped' : s.sharePaused ? 'paused' : 'on';
      $('shareText').textContent = 'Sharing recordings with ' + sh.with + ' for model testing — ' + word;
      $('sharePause').hidden = sh.state === 'stopped';
      $('sharePause').textContent = s.sharePaused ? 'Resume' : 'Pause';
      $('privacyRest').textContent = s.sharePaused || sh.state === 'stopped'
        ? 'Your voice is never sent anywhere while sharing is paused.'
        : 'While sharing is on, your recordings are also sent to ' + sh.with + '.';
    }
    renderBeta();
  }

  /* --------------------------------------------------------- the public beta */

  // Sharing, the public beta's way (sharing.js, mode 'beta'): off until the person picks share
  // on the consent screen. Turning the switch on opens that screen; nothing changes until it is
  // answered (main says so with home:changed 'sharing').
  function renderBeta() {
    var s = S.settings, sh = s.sharing, m = S.platform.machine;
    var beta = Boolean(sh && sh.mode === 'beta');
    $('betaRow').hidden = !beta;
    if (!beta) { $('betaConfirm').hidden = true; return; }
    var on = sh.state === 'on';
    $('betaShare').checked = on;
    $('betaHelp').textContent = sh.state === 'stopped'
      ? 'Stopped: the server no longer accepts this ' + m + '. Turn sharing off and on again to start over.'
      : on
        ? 'On: each dictation’s audio and text go to the developer to improve Typd. Never your screen, selections or window titles.'
        : 'Off: everything stays on this ' + m + '.';
    $('betaDelete').hidden = !(sh.shared || on);
    $('betaId').hidden = !sh.id;
    $('betaId').textContent = sh.id ? 'Anonymous ID ' + sh.id : '';
    var fk = s.flagKey;
    $('betaFlag').hidden = false;
    if (fk) withKeys($('betaFlag'), 'Typd got it wrong? {key} flags your last dictation, or “That was wrong” in the tray.', fk.parts);
    else $('betaFlag').textContent = 'Typd got it wrong? “That was wrong” in the tray flags your last dictation.';
    $('privacyRest').textContent = on
      ? 'While sharing is on, your dictations are also sent to the developer to improve Typd.'
      : 'Nothing you say is sent anywhere unless you choose to share it.';
  }

  function reloadSettings() {
    return api.settings.state().then(function (st) { if (st) { S.settings = st; renderRecordings(); } });
  }

  $('betaShare').addEventListener('change', function (e) {
    var want = e.target.checked;
    // On waits for the consent screen; until it is answered the switch shows what is true now.
    e.target.checked = !want;
    api.sharing.set(want).then(function (r) {
      if (!r) return;
      if (r.settings) { S.settings = r.settings; renderRecordings(); }
      if (!want) toast('Sharing is off');
    });
  });

  $('betaAbout').addEventListener('click', function () { api.sharing.about(); });

  $('betaDelete').addEventListener('click', function () {
    $('betaConfirm').hidden = false;
    $('betaConfirmNo').focus();
  });
  $('betaConfirmNo').addEventListener('click', function () { $('betaConfirm').hidden = true; });
  $('betaConfirmYes').addEventListener('click', function () {
    $('betaConfirmYes').disabled = true;
    api.sharing.remove().then(function (r) {
      $('betaConfirmYes').disabled = false;
      $('betaConfirm').hidden = true;
      if (!r) return;
      if (r.settings) { S.settings = r.settings; renderRecordings(); }
      if (r.ok) {
        toast(r.deleted ? 'Deleted ' + r.deleted.toLocaleString() + (r.deleted === 1 ? ' shared dictation' : ' shared dictations') : 'Deleted. Nothing is stored anymore');
      } else {
        failSettings(r.reason === 'offline'
          ? "Couldn't reach the server. Sharing is off; try deleting again when you're online."
          : "The server couldn't delete it just now. Sharing is off; try again later.");
      }
    });
  });

  $('sharePause').addEventListener('click', function () {
    var next = !S.settings.sharePaused;
    api.settings.set('sharePaused', next).then(function (ok) {
      if (!ok) return;
      api.settings.state().then(function (st) { if (st) { S.settings = st; renderRecordings(); } });
    });
  });

  function renderSettings() {
    var s = S.settings, p = S.platform;
    ['sounds', 'startAtLogin', 'keepRecordings', 'showInDock'].forEach(function (k) { $(k).checked = Boolean(s[k]); });
    $('dockRow').hidden = !p.mac;
    $('mic').options[0].textContent = p.mac ? 'System default' : 'Windows default';
    $('loginTitle').textContent = p.mac ? 'Open at login' : 'Start with Windows';
    $('startAtLogin').disabled = !s.loginSupported;
    renderLoginHelp();
    $('privacyHead').textContent = 'Dictation runs on this ' + p.machine + '.';
    $('aboutLine').textContent = 'Model ' + (S.model.name || '') + ' · Typd ' + S.version;
    renderRecordings();
    renderHotkey();
  }

  function renderLoginHelp() {
    var p = S.platform;
    $('loginHelp').textContent = !S.settings.loginSupported
      ? 'Only in the installed app, not when run from source.'
      : 'Ready on ' + S.hotkey.label + ' as soon as you ' + (p.mac ? 'log in.' : 'sign in.');
  }

  /* ---------------------------------------------------------------- the key */

  var hk = { mode: 'idle', held: {}, ctrlAt: 0, fakeCtrl: false, nonMod: false, helpTimer: 0 };

  function gesture(h) {
    if (h.kind === 'chord') return 'Press to start, press again to finish.';
    if (h.kind === 'key' || h.kind === 'button') return 'Tap to start, tap again to finish — or hold it while you talk.';
    if (h.binding === 'RightAlt' && !S.platform.mac) return 'Tap to start, tap again to finish. AltGr + a key still types as usual.';
    if (h.binding === 'RightMeta') return 'Tap to start, tap again to finish. ⌘ shortcuts work as usual.';
    return 'Tap to start, tap again to finish.';
  }

  function setHelp(text, ok) {
    var help = $('hotkeyHelp');
    help.textContent = text;
    help.classList.toggle('ok-line', Boolean(ok));
  }

  function hotkeyError(msg) {
    $('hotkeyError').textContent = msg || '';
    $('hotkeyError').hidden = !msg;
  }

  function renderHotkey() {
    var row = $('hotkeyRow');
    row.setAttribute('data-mode', hk.mode);
    var keys = $('hotkeyKeys');
    keys.textContent = '';
    if (hk.mode === 'capture') {
      keys.appendChild(el('span', 'waiting', 'Press a key…'));
    } else {
      S.hotkey.parts.forEach(function (p) { keys.appendChild(el('span', 'key', p)); });
    }
    $('hotkeyChange').hidden = hk.mode !== 'idle';
    $('hotkeyCancel').hidden = hk.mode === 'idle';
    var def = $('hotkeyDefault');
    def.hidden = hk.mode !== 'capture' || S.hotkey.binding === S.hotkey.defaultBinding;
    def.textContent = 'Use ' + S.hotkey.defaultLabel + ' (default)';
    if (hk.mode === 'capture') {
      var mac = S.platform.mac;
      setHelp('Press the key you want. A key like ' + (mac ? 'Right ⌘' : 'Right Ctrl') + ' or F13' +
        (S.hotkey.sideButtons ? ', a mouse side button,' : '') + ' or a combination like ' +
        (mac ? '⌘ + Shift + Space' : 'Ctrl + Shift + Space') + '. Esc cancels.');
    } else if (hk.mode === 'verify') {
      setHelp('Now press it once more, to check it works…');
    }
  }

  var MOD_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)$/;
  var SINGLE = {
    ControlRight: 'RightCtrl', ControlLeft: 'LeftCtrl', AltRight: 'RightAlt', AltLeft: 'LeftAlt',
    ShiftRight: 'RightShift', ShiftLeft: 'LeftShift', MetaRight: 'RightMeta', MetaLeft: 'LeftMeta',
    OSRight: 'RightMeta', OSLeft: 'LeftMeta'
  };
  var NAMED = {
    Space: 'Space', Enter: 'Return', NumpadEnter: 'Return', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    Insert: 'Insert', Escape: 'Escape', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Comma: ',', Period: '.', Slash: '/',
    Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=',
    Backquote: '`', CapsLock: 'CapsLock', NumLock: 'NumLock', ScrollLock: 'ScrollLock'
  };

  function keyName(code) {
    var m;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
    if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    return NAMED[code] || code;
  }

  function heldMods() {
    var out = [];
    Object.keys(hk.held).forEach(function (code) {
      if (code === 'ControlLeft' && hk.fakeCtrl) return;
      out.push(code);
    });
    return out;
  }

  function accelerator(key) {
    var mods = heldMods();
    var has = function (re) { return mods.some(function (c) { return re.test(c); }); };
    var parts = [];
    // AltGr arrives as a fake Left Ctrl plus Right Alt: that is Ctrl+Alt, and is refused as such.
    if (has(/^Control/) || hk.fakeCtrl) parts.push('Ctrl');
    if (has(/^(Meta|OS)/)) parts.push(S.platform.mac ? 'Command' : 'Super');
    if (has(/^Alt/)) parts.push('Alt');
    if (has(/^Shift/)) parts.push('Shift');
    parts.push(key);
    return parts.join('+');
  }

  function onKeyDown(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    hotkeyError('');
    if (MOD_CODES.test(e.code)) {
      if (e.code === 'AltRight' && hk.held.ControlLeft && e.timeStamp - hk.ctrlAt < 80) hk.fakeCtrl = true;
      if (e.code === 'ControlLeft') hk.ctrlAt = e.timeStamp;
      hk.held[e.code] = true;
      return;
    }
    hk.nonMod = true;
    if (e.code === 'Escape' && !heldMods().length && !hk.fakeCtrl) { cancelCapture(); return; }
    var key = keyName(e.code);
    submit(heldMods().length || hk.fakeCtrl ? accelerator(key) : key);
  }

  function onKeyUp(e) {
    e.preventDefault();
    e.stopPropagation();
    if (MOD_CODES.test(e.code) && !hk.nonMod) {
      var mods = heldMods();
      if (hk.fakeCtrl && e.code === 'AltRight') mods = ['AltRight'];
      if (mods.length === 1 && mods[0] === e.code) submit(SINGLE[e.code]);
      else if (mods.length > 1) hotkeyError('Add a key: hold ' + (S.platform.mac ? '⌘ + Shift' : 'Ctrl + Shift') + ' and press a letter or Space.');
    }
    delete hk.held[e.code];
    if (e.code === 'ControlLeft' || e.code === 'AltRight') { if (!hk.held.AltRight) hk.fakeCtrl = false; }
    if (!Object.keys(hk.held).length) { hk.nonMod = false; hk.fakeCtrl = false; }
  }

  function onMouseDown(e) {
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      submit(e.button === 3 ? 'Mouse4' : 'Mouse5');
    } else if (e.button === 1) {
      e.preventDefault();
      submit('Mouse3');
    }
  }
  // Side buttons also mean Back/Forward to the page; never let them act here while listening.
  function onMouseUp(e) { if (hk.mode === 'capture' && (e.button === 3 || e.button === 4)) e.preventDefault(); }

  function listenKeys(on) {
    var fn = on ? 'addEventListener' : 'removeEventListener';
    window[fn]('keydown', onKeyDown, true);
    window[fn]('keyup', onKeyUp, true);
    window[fn]('mousedown', onMouseDown, true);
    window[fn]('mouseup', onMouseUp, true);
    hk.held = {}; hk.fakeCtrl = false; hk.nonMod = false;
  }

  function startCapture() {
    if (hk.mode === 'verify') api.hotkey.cancel();
    hk.mode = 'capture';
    hotkeyError('');
    api.hotkey.pause(true);
    listenKeys(true);
    renderHotkey();
    $('hotkeyRow').scrollIntoView({ block: 'nearest' });
  }

  function cancelCapture() {
    if (hk.mode === 'capture') { listenKeys(false); api.hotkey.pause(false); }
    if (hk.mode === 'verify') api.hotkey.cancel();
    hk.mode = 'idle';
    hotkeyError('');
    renderHotkey();
    setHelp(gesture(S.hotkey));
  }

  function submit(binding) {
    if (!binding || hk.mode !== 'capture') return;
    api.hotkey.set(binding).then(function (r) {
      if (!r) return;
      if (!r.ok) { hotkeyError(r.reason); return; }   // still listening: press another key
      listenKeys(false);
      if (r.same) {
        api.hotkey.pause(false);
        hk.mode = 'idle';
        renderHotkey();
        setHelp('That is already your key. ' + gesture(S.hotkey), true);
        return;
      }
      // The new key is armed and the old one closed; main waits up to 10 s to hear it.
      S.hotkey = r.hotkey;
      hk.mode = 'verify';
      renderHotkey();
    });
  }

  $('hotkeyChange').addEventListener('click', startCapture);
  $('hotkeyCancel').addEventListener('click', cancelCapture);
  $('hotkeyDefault').addEventListener('click', function () { submit(S.hotkey.defaultBinding); });

  api.on('hotkey:verified', function (p) {
    hk.mode = 'idle';
    S.hotkey = p.hotkey;
    renderHotkey();
    if (p.ok) setHelp('✓ Works. ' + gesture(S.hotkey), true);
    else { setHelp(gesture(S.hotkey)); hotkeyError(p.reason); }
    afterKeyChange();
  });

  api.on('hotkey:heard', function (p) {
    if (hk.mode !== 'idle') return;
    S.hotkey = p.hotkey;
    var row = $('hotkeyRow');
    row.setAttribute('data-flash', 'true');
    $('statusCard').setAttribute('data-heard', 'true');
    setHelp('✓ Heard ' + S.hotkey.label + '. It works.', true);
    clearTimeout(hk.helpTimer);
    hk.helpTimer = setTimeout(function () {
      row.removeAttribute('data-flash');
      $('statusCard').removeAttribute('data-heard');
      if (hk.mode === 'idle') setHelp(gesture(S.hotkey));
    }, 2200);
  });

  function afterKeyChange() {
    api.get().then(function (st) {
      if (!st) return;
      S.hotkey = st.hotkey; S.status = st.status;
      renderStatus(st.status, st.perms);
      renderTip();
      renderLoginHelp();
    });
  }

  /* -------------------------------------------------------------- what's new */

  var newsLoaded = false;
  function loadNews() {
    if (newsLoaded) return;
    api.news().then(function (md) {
      newsLoaded = true;
      // markdown.js escapes everything before adding its own markup.
      // The file's own title repeats the section's; the releases are what matter here.
      var body = String(md || '').replace(/^# [^\n]*\n+/, '');
      $('notes').innerHTML = window.typdMarkdown(body || 'Nothing here yet.');
    });
  }

  /* ------------------------------------------------------------------ events */

  api.on('home:show', function (p) {
    show(p.section);
    if (p.capture) startCapture();
  });

  api.on('home:changed', function (p) {
    if (p.what === 'sharing' && S) reloadSettings();
    if (p.what === 'history' || p.what === 'counts') {
      api.get().then(function (st) { if (st) { S.counts = st.counts; renderCounts(st.counts); } });
      if (current === 'history') loadHistory();
    }
    if (p.what === 'dictionary' && current === 'dictionary') loadWords();
  });

  api.on('home:status', function (p) {
    if (!S) return;
    S.status = p.status;
    renderStatus(p.status, p.perms);
  });

  /* -------------------------------------------------------------------- boot */

  function boot() {
    api.get().then(function (st) {
      if (!st) return;
      S = st;
      document.documentElement.classList.toggle('mac', st.platform.mac);
      $('fact').textContent = 'Runs on this ' + st.platform.machine;
      $('newsVersion').textContent = 'Typd ' + st.version;
      renderMark(st.mark);
      renderStatus(st.status, st.perms);
      renderCounts(st.counts);
      renderTip();
      renderSettings();
      setHelp(gesture(st.hotkey));
      var q = new URLSearchParams(location.search);
      show(q.get('section') || 'home');
      if (q.get('capture') === '1') startCapture();
    });
  }

  window.addEventListener('beforeunload', stopListening);
  boot();
})();
