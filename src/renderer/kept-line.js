'use strict';

/**
 * Home's "kept as is" line (0.2.13): of this week's dictations whose fate was seen (store.js
 * keptWeek, from kept.js's verdicts), the share left exactly as pasted -- and, when both models
 * wrote some, each one's, so the full and the light model can be compared on real use:
 *
 *   Kept as is this week: 78% of 50 — full 80% of 41, light 67% of 9
 *   Kept as is this week: 80% of 41 (full model)
 *
 * '' when nothing was measured this week (the line is hidden). And History's small tag for an
 * item that was not kept: "Edited after: 2 words", "Deleted after", "Said again" ('' otherwise).
 * Shared by the window (window.typdKeptLine, window.typdKeptTag) and bench/kept.js (require).
 */
(function (root) {
  function keptLine(k) {
    if (!k || !k.n) return '';
    const pct = (x) => Math.round((100 * x.kept) / x.n) + '%';
    const full = k.full || { n: 0, kept: 0 };
    const light = k.light || { n: 0, kept: 0 };
    let line = 'Kept as is this week: ' + pct(k) + ' of ' + k.n;
    if (full.n && light.n) line += ' — full ' + pct(full) + ' of ' + full.n + ', light ' + pct(light) + ' of ' + light.n;
    else if (full.n === k.n) line += ' (full model)';
    else if (light.n === k.n) line += ' (light model)';
    return line;
  }

  function keptTag(k) {
    if (!k || typeof k !== 'object') return '';
    if (k.v === 'edited') return 'Edited after' + (k.words ? ': ' + k.words + (k.words === 1 ? ' word' : ' words') : '');
    if (k.v === 'deleted') return 'Deleted after';
    if (k.v === 'redone') return 'Said again';
    return '';
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { keptLine, keptTag };
  else { root.typdKeptLine = keptLine; root.typdKeptTag = keptTag; }
})(typeof window !== 'undefined' ? window : this);
