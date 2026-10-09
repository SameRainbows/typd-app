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
- `main/store.js`, `main/home-window.js`, `renderer/home.*`, `preload/home.js`
  — the home window: stats, history, dictionary panes.
- `renderer/markdown.js` — the answer panel's Markdown renderer.
- `bench/agent.js`, `bench/e2e.js` — the suites covering the above.

Put back one at a time, and only once the step below it is finished.
