'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The "That was wrong" window's bridge (main/ask-window.js): one named call per thing the
// page does. Main checks every call comes from that window's own page.
const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

const EVENTS = ['ask:refresh'];

contextBridge.exposeInMainWorld('typdAsk', {
  state: call('ask:state'),
  flag: call('ask:flag'),
  share: call('ask:share'),
  close: call('ask:close'),

  on(event, handler) {
    if (!EVENTS.includes(event)) throw new Error('typdAsk.on: unknown event "' + event + '"');
    const wrapped = (_e, payload) => handler(payload || {});
    ipcRenderer.on(event, wrapped);
    return () => ipcRenderer.removeListener(event, wrapped);
  }
});
