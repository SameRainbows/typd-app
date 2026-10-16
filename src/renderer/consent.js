'use strict';

// The consent screen's page. Two equal buttons; nothing is shared until the first is pressed.
// Closing the window is the same as the second (main/ask-window.js).
(function () {
  var api = window.typdAsk;
  var $ = function (id) { return document.getElementById(id); };

  function answer(share) {
    $('share').disabled = true;
    $('keep').disabled = true;
    $('error').hidden = true;
    api.consent(share).then(function (r) {
      // The window closes itself once the answer is stored; this only runs if it could not be.
      if (!r || !r.ok) {
        $('share').disabled = false;
        $('keep').disabled = false;
        $('error').textContent = "Typd couldn't save that. Try again.";
        $('error').hidden = false;
      }
    });
  }

  $('share').addEventListener('click', function () { answer(true); });
  $('keep').addEventListener('click', function () { answer(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') api.close();
  });

  api.state().then(function (st) {
    if (!st) return;
    var m = st.platform.machine;
    $('lede').textContent = 'Typd turns your voice into text on this ' + m + '. Nothing you say leaves it unless you choose to share.';
    if (st.choice === 'on') $('foot').textContent = 'Sharing is on now. You can change this in Settings.';
    else if (st.choice === 'off') $('foot').textContent = 'Sharing is off now. You can change this in Settings.';
  });
})();
