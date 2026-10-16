'use strict';

// "That was wrong": the last dictation, an optional note, and -- only if it was never shared --
// one question for that dictation alone. The dictation's text is set as text, never as markup.
(function () {
  var api = window.typdAsk;
  var $ = function (id) { return document.getElementById(id); };
  var S = null;

  function render(st) {
    S = st;
    $('error').hidden = true;
    $('go').disabled = false;
    if (!st.has) {
      $('said').textContent = 'Nothing to flag yet: dictate something first.';
      $('form').hidden = true;
      return;
    }
    $('form').hidden = false;
    $('said').textContent = st.text || (st.mode === 'revise' ? '(a revision)' : '');
    $('onText').hidden = st.needsConsent;
    $('askText').hidden = !st.needsConsent;
    $('reviseNote').hidden = !(st.needsConsent && st.mode === 'revise');
    $('go').textContent = st.needsConsent ? 'Share this one' : 'Flag it';
    $('cancel').textContent = st.needsConsent ? 'Don’t share' : 'Cancel';
    $('note').focus();
  }

  function load() {
    api.state().then(function (st) { if (st) render(st); });
  }

  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!S || !S.has) return;
    $('go').disabled = true;
    api.flag({ note: $('note').value, share: Boolean(S.needsConsent) }).then(function (r) {
      // Done: main closes the window. Anything else is said here.
      if (!r) return;
      $('go').disabled = false;
      if (r.state === 'ask') { load(); return; }
      if (r.state === 'none') { $('error').textContent = 'That dictation is gone: flag the next one right after it lands.'; $('error').hidden = false; }
      if (r.state === 'failed') { $('error').textContent = "Typd couldn't flag that one."; $('error').hidden = false; }
    });
  });

  $('cancel').addEventListener('click', function () { api.close(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') api.close();
  });
  api.on('ask:refresh', load);

  load();
})();
