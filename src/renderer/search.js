'use strict';

/**
 * Search that forgives how a word is typed: case and accents are ignored, and Turkish
 * dotted and dotless i are one letter, so "istanbul" finds "İstanbul" and "ayse" finds
 * "Ayşe". Shared by the window (window.typdFold) and bench/home.js (require).
 */
(function (root) {
  function fold(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/ı/g, 'i');
  }

  /** Does `text` contain every word of `query`, in any order? */
  function matches(text, query) {
    const hay = fold(text);
    return fold(query).split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { fold, matches };
  else root.typdSearch = { fold, matches };
})(typeof window !== 'undefined' ? window : this);
