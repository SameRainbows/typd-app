'use strict';

// "Help make Typd better?": Share or Don't share, nothing preselected (main/ask-window.js 'share').
// Main stores the answer and closes the window; Esc or the window's X answers nothing.
(function () {
  var api = window.typdAsk;
  var $ = function (id) { return document.getElementById(id); };

  function answer(share) {
    $('shareYes').disabled = true;
    $('shareNo').disabled = true;
    $('error').hidden = true;
    api.share(share).then(function (r) {
      if (r && r.ok !== false) return;   // main closes the window
      $('shareYes').disabled = false;
      $('shareNo').disabled = false;
      if (r && r.deletedShared) return;   // off; what was shared is deleted as soon as Typd is online
      $('error').textContent = 'Typd couldn’t save that. Try again, or use Settings.';
      $('error').hidden = false;
    });
  }

  $('shareYes').addEventListener('click', function () { answer(true); });
  $('shareNo').addEventListener('click', function () { answer(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') api.close();
  });
})();
