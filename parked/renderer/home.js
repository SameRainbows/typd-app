'use strict';

(function () {
  var root = document.documentElement;
  var state = { sessions: [], dictionary: [], filter: 'all', dictFilter: 'all' };

  /* ------------------------------------------------------------ format */

  function duration(seconds) {
    var s = Math.max(0, Math.round(seconds || 0));
    if (s < 60) return [s, 'sec'];
    var m = Math.round(s / 60);
    if (m < 60) return [m, 'min'];
    var h = Math.floor(m / 60);
    return [h + 'h ' + (m % 60), 'min'];
  }

  function compact(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  function setStat(id, value, unit) {
    var el = document.getElementById(id);
    el.textContent = '';
    el.appendChild(document.createTextNode(String(value)));
    if (unit) {
      var span = document.createElement('span');
      span.className = 'unit';
      span.textContent = unit;
      el.appendChild(span);
    }
  }

  function dayLabel(iso) {
    var d = new Date(iso);
    var today = new Date();
    var yest = new Date(today.getTime() - 86400000);
    var same = function (a, b) { return a.toDateString() === b.toDateString(); };
    if (same(d, today)) return 'Today';
    if (same(d, yest)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

  /* ------------------------------------------------------------ render */

  function renderStats(stats) {
    var t = duration(stats.seconds);
    setStat('statTime', t[0], t[1]);
    setStat('statWords', compact(stats.words), 'words');
    var saved = duration(stats.savedSeconds);
    setStat('statSaved', saved[0], saved[1]);
    setStat('statWpm', stats.wpm || 0, 'wpm');
  }

  function wordCard(entry) {
    var card = document.createElement('div');
    card.className = 'word';

    var spark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    spark.setAttribute('viewBox', '0 0 24 24');
    spark.setAttribute('class', 'spark' + (entry.source === 'manual' ? ' manual' : ''));
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M12 3.5 L13.6 9.4 L19.5 11 L13.6 12.6 L12 18.5 L10.4 12.6 L4.5 11 L10.4 9.4 Z');
    spark.appendChild(p);
    card.appendChild(spark);

    var body = document.createElement('div');
    body.className = 'word-body';
    var term = document.createElement('div');
    term.className = 'word-term';
    term.textContent = entry.term;
    body.appendChild(term);

    if (entry.heardAs && entry.heardAs.length) {
      var heard = document.createElement('div');
      heard.className = 'word-heard';
      heard.textContent = 'heard as ' + entry.heardAs.join(', ');
      body.appendChild(heard);
    }
    card.appendChild(body);

    var remove = document.createElement('button');
    remove.className = 'word-remove';
    remove.type = 'button';
    remove.title = 'Remove';
    remove.textContent = '×';
    remove.addEventListener('click', function () {
      window.typdHome.removeWord(entry.term).then(function (r) {
        state.dictionary = r.dictionary;
        renderWords();
        renderRecentWords();
      });
    });
    card.appendChild(remove);

    return card;
  }

  function renderWords() {
    var host = document.getElementById('words');
    host.textContent = '';

    var list = state.dictionary.filter(function (e) {
      if (state.dictFilter === 'all') return true;
      return (e.source || 'auto') === state.dictFilter;
    });

    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = state.dictFilter === 'manual'
        ? 'Nothing added by hand yet.'
        : 'Nothing yet. Correct a word after it lands and it turns up here.';
      host.appendChild(empty);
      return;
    }

    list.slice().reverse().forEach(function (e) { host.appendChild(wordCard(e)); });
  }

  function renderRecentWords() {
    var host = document.getElementById('recentWords');
    var count = document.getElementById('learnCount');
    host.textContent = '';
    count.textContent = state.dictionary.length
      ? state.dictionary.length + (state.dictionary.length === 1 ? ' word' : ' words')
      : '';

    if (!state.dictionary.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nothing learned yet.';
      host.appendChild(empty);
      return;
    }
    state.dictionary.slice(-6).reverse().forEach(function (e) { host.appendChild(wordCard(e)); });
  }

  function renderEntries() {
    var host = document.getElementById('entries');
    host.textContent = '';

    var list = state.sessions.filter(function (s) {
      if (state.filter === 'all') return true;
      if (state.filter === 'ask') return s.mode === 'ask';
      return s.mode === 'dictate' || s.mode === 'translate';
    });

    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nothing here yet.';
      host.appendChild(empty);
      return;
    }

    var currentDay = null;
    list.forEach(function (s) {
      var label = dayLabel(s.at);
      if (label !== currentDay) {
        currentDay = label;
        var head = document.createElement('div');
        head.className = 'day';
        head.textContent = label;
        host.appendChild(head);
      }

      var row = document.createElement('div');
      row.className = 'entry';

      var time = document.createElement('div');
      time.className = 'entry-time';
      time.textContent = new Date(s.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      row.appendChild(time);

      var body = document.createElement('div');
      body.className = 'entry-body';

      var text = document.createElement('div');
      text.className = 'entry-text';
      text.textContent = s.text || '(no text kept)';
      body.appendChild(text);

      var meta = document.createElement('div');
      meta.className = 'entry-meta';
      var mode = document.createElement('span');
      mode.className = 'entry-mode';
      mode.textContent = s.mode;
      meta.appendChild(mode);
      if (s.words) {
        var w = document.createElement('span');
        w.textContent = s.words + (s.words === 1 ? ' word' : ' words');
        meta.appendChild(w);
      }
      if (s.app) {
        var a = document.createElement('span');
        a.textContent = s.app;
        meta.appendChild(a);
      }
      body.appendChild(meta);

      row.appendChild(body);
      host.appendChild(row);
    });
  }

  /* -------------------------------------------------------------- wire */

  function load() {
    return window.typdHome.data().then(function (d) {
      state.sessions = d.sessions || [];
      state.dictionary = d.dictionary || [];
      root.setAttribute('data-theme', d.dark ? 'dark' : 'light');
      document.getElementById('retention').value = String(d.retentionDays || 0);
      renderStats(d.stats);
      renderEntries();
      renderWords();
      renderRecentWords();
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (btn) {
    btn.addEventListener('click', function () {
      var pane = btn.getAttribute('data-pane');
      Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (o) {
        o.setAttribute('aria-current', String(o === btn));
      });
      Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (p) {
        p.setAttribute('data-active', String(p.getAttribute('data-pane') === pane));
      });
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('.tab[data-filter]'), function (tab) {
    tab.addEventListener('click', function () {
      state.filter = tab.getAttribute('data-filter');
      Array.prototype.forEach.call(document.querySelectorAll('.tab[data-filter]'), function (o) {
        o.setAttribute('aria-selected', String(o === tab));
      });
      renderEntries();
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('.tab[data-dict]'), function (tab) {
    tab.addEventListener('click', function () {
      state.dictFilter = tab.getAttribute('data-dict');
      Array.prototype.forEach.call(document.querySelectorAll('.tab[data-dict]'), function (o) {
        o.setAttribute('aria-selected', String(o === tab));
      });
      renderWords();
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('.theme-btn'), function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.getAttribute('data-theme');
      Array.prototype.forEach.call(document.querySelectorAll('.theme-btn'), function (o) {
        o.setAttribute('aria-pressed', String(o === btn));
      });
      window.typdHome.setTheme(mode).then(function (r) {
        root.setAttribute('data-theme', r.dark ? 'dark' : 'light');
      });
    });
  });

  document.getElementById('addWord').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = document.getElementById('newWord');
    var term = input.value.trim();
    if (!term) return;
    window.typdHome.addWord(term).then(function (r) {
      state.dictionary = r.dictionary;
      input.value = '';
      renderWords();
      renderRecentWords();
    });
  });

  document.getElementById('retention').addEventListener('change', function (e) {
    window.typdHome.setRetention(Number(e.target.value)).then(function (r) {
      state.sessions = r.sessions;
      renderEntries();
    });
  });

  document.getElementById('clearHistory').addEventListener('click', function () {
    window.typdHome.clearHistory().then(function (r) {
      state.sessions = [];
      renderStats(r.stats);
      renderEntries();
    });
  });

  window.typdHome.onChanged(load);

  document.querySelector('.theme-btn[data-theme="dark"]').setAttribute('aria-pressed', 'true');
  load();
})();
