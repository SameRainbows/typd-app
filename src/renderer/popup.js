'use strict';

/* The copy pop-up's page (src/main/copy-popup.js owns the logic: the timer, pause, copy,
 * dismiss). This page shows what main says, reports where the card is (main's click gate makes
 * the window take clicks there, and the pointer being there pauses the timer), and sends Copy
 * and × back. */
(function () {
  var popup = document.getElementById('popup');
  var card = document.getElementById('card');
  var label = document.getElementById('label');
  var preview = document.getElementById('preview');
  var copyBtn = document.getElementById('copy');
  var copyText = document.getElementById('copyText');
  var closeBtn = document.getElementById('close');
  var bar = document.getElementById('bar');
  var announce = document.getElementById('announce');

  var HIT_PAD = 2;
  var reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var shown = false;
  var key = 0;           // the card on screen; answers for an older one are ignored
  var acted = {};        // per card: Copy / × already sent (a press can arrive as mouseup and click)
  var lastHits = '';
  var stepper = null;    // reduced motion: the bar steps once a second instead of gliding

  /* ------------------------------------------------------------ the click gate */

  function hitAreas() {
    if (!shown) return [];
    var r = card.getBoundingClientRect();
    if (r.width < 2) return [];
    return [{
      x: Math.floor(r.left - HIT_PAD), y: Math.floor(r.top - HIT_PAD),
      w: Math.ceil(r.width + HIT_PAD * 2), h: Math.ceil(r.height + HIT_PAD * 2)
    }];
  }

  function reportHits(force) {
    var list = hitAreas();
    var k = JSON.stringify(list);
    if (!force && k === lastHits) return;
    lastHits = k;
    window.typdPopup.hitAreas(list);
  }

  /* --------------------------------------------------------------- the buttons */

  /* As on the pill (overlay.js act()): Windows may eat the press on a window that never
   * activates, so the release is the click; `click` stays for screen readers and keyboards. */
  function act(which) {
    if (!shown || acted[which + key]) return;
    acted[which + key] = true;
    if (which === 'copy') window.typdPopup.copy();
    else window.typdPopup.dismiss();
  }
  [[copyBtn, 'copy'], [closeBtn, 'close']].forEach(function (c) {
    c[0].addEventListener('mouseup', function (e) { if (e.button === 0) act(c[1]); });
    c[0].addEventListener('click', function () { act(c[1]); });
  });

  /* ------------------------------------------------------------------ the bar */

  function setBar(fraction, glideMs) {
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(' + Math.max(0, Math.min(1, fraction)).toFixed(4) + ')';
    if (glideMs > 0) {
      void bar.offsetWidth;   // commit the start before the glide
      bar.style.transition = 'transform ' + Math.round(glideMs) + 'ms linear';
      bar.style.transform = 'scaleX(0)';
    }
  }

  function stopStepper() { if (stepper) { clearInterval(stepper); stepper = null; } }

  function timer(t) {
    var total = t.total > 0 ? t.total : 1;
    var remaining = Math.max(0, t.remaining || 0);
    popup.setAttribute('data-paused', t.paused ? 'true' : 'false');
    stopStepper();
    if (t.paused || !remaining) { setBar(remaining / total, 0); return; }
    if (!reduced.matches) { setBar(remaining / total, remaining); return; }
    // Reduced motion: no glide. The bar drops once a second, so the time left still shows.
    var started = Date.now();
    setBar(remaining / total, 0);
    stepper = setInterval(function () {
      var left = Math.max(0, remaining - (Date.now() - started));
      setBar(left / total, 0);
      if (!left) stopStepper();
    }, 1000);
  }

  /* ------------------------------------------------------------------ messages */

  window.typdPopup.on('popup:show', function (p) {
    key = p.key || key + 1;
    shown = true;
    var copiedAlready = p.kind === 'copied';
    var paste = p.pasteKey || 'Ctrl+V';
    popup.setAttribute('data-kind', copiedAlready ? 'copied' : 'offer');
    popup.setAttribute('data-copied', 'false');
    label.textContent = copiedAlready ? 'Copied — press ' + paste + ' to paste' : 'No text field — not pasted';
    preview.textContent = String(p.preview || '').replace(/\s+/g, ' ').trim();
    copyText.textContent = 'Copy';
    copyBtn.setAttribute('aria-label', copiedAlready ? 'Copy the dictation again' : 'Copy the dictation');
    popup.setAttribute('data-visible', 'true');
    // For screen readers: what happened and what to do, once. (The preview is the Copy button's description.)
    announce.textContent = '';
    setTimeout(function () {
      announce.textContent = copiedAlready
        ? 'Typd could not paste your dictation. It is on the clipboard: press ' + paste + ' to paste.'
        : 'Typd did not paste your dictation: there was no text field. Use Copy in the Typd pop-up to copy it.';
    }, 60);
    lastHits = '';
    requestAnimationFrame(function () { reportHits(true); });
  });

  window.typdPopup.on('popup:timer', timer);

  window.typdPopup.on('popup:copied', function () {
    popup.setAttribute('data-copied', 'true');
    copyText.textContent = 'Copied';
    announce.textContent = 'Copied.';
    stopStepper();
  });

  window.typdPopup.on('popup:leave', function () {
    shown = false;
    stopStepper();
    popup.setAttribute('data-visible', 'false');
    reportHits(true);   // [] : click-through everywhere again
  });

  window.addEventListener('resize', function () { reportHits(); });
})();
