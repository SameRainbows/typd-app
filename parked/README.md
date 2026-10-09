# parked

Working, tested code removed from the app to get back to one thing done well.

Nothing here is broken. It was taken out because dictation has to be right
before anything sits on top of it, and each of these was competing for attention
with that:

- `main/agent.js`, `main/tools.js` — the Ask/agent tool loop: web search,
  open app, play music, write text. 25/25 routing tests passed.
- `main/dictionary.js`, `main/learn.js` — the dictionary and the
  learn-from-corrections watcher. 9/9 detection tests passed; it took four
  errors off one clip.
- `bench/agent.js`, `bench/e2e.js` — the suites covering the above.

Put back one at a time, and only once the step below it is finished.

Already back: the home window (`store.js`, `home-window.js`, `renderer/home.*`,
`preload/home.js`) returned on 2026-10-09 as the Typd window, rewritten; the
Markdown renderer went with it, for What's new. The dictionary and learning
returned on 2026-10-06 (`src/main/dictionary.js`, `src/main/learn.js`).
