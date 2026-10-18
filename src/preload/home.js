'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The Typd window's bridge: one named call per thing the page does, nothing generic.
// Main checks every call comes from this window's own page and validates its input.
const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

// Pushes from main the page may listen to, and nothing else.
const EVENTS = ['home:show', 'home:changed', 'home:status', 'hotkey:heard', 'hotkey:verified'];

contextBridge.exposeInMainWorld('typdHome', {
  get: call('home:get'),

  history: {
    list: call('history:list'),
    copy: call('history:copy'),
    remove: call('history:delete'),
    undo: call('history:undo'),
    clear: call('history:clear'),
    keep: call('history:keep')
  },

  dictionary: {
    list: call('dictionary:list'),
    add: call('dictionary:add'),
    remove: call('dictionary:remove'),
    undo: call('dictionary:undo'),
    reveal: call('dictionary:reveal')
  },

  settings: {
    state: call('settings:state'),
    set: call('settings:set'),
    openRecordings: call('settings:open-recordings')
  },

  sharing: {
    set: call('sharing:set'),
    remove: call('sharing:delete'),
    backfill: call('sharing:backfill')
  },

  hotkey: {
    pause: call('hotkey:pause'),
    set: call('hotkey:set'),
    cancel: call('hotkey:cancel')
  },

  model: {
    get: call('model:get'),
    now: call('model:now'),
    later: call('model:later')
  },

  updates: {
    get: call('updates:get'),
    check: call('updates:check'),
    restart: call('updates:restart')
  },

  walkthrough: {
    practice: call('walkthrough:practice'),
    done: call('walkthrough:done')
  },

  news: call('news:get'),
  action: call('app:action'),
  pane: call('app:pane'),
  feedback: call('app:feedback'),
  license: call('app:license'),

  on(event, handler) {
    if (!EVENTS.includes(event)) throw new Error('typdHome.on: unknown event "' + event + '"');
    const wrapped = (_e, payload) => handler(payload || {});
    ipcRenderer.on(event, wrapped);
    return () => ipcRenderer.removeListener(event, wrapped);
  }
});
