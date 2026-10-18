'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The copy pop-up (src/main/copy-popup.js, renderer/popup.*): what main says, and three things back.
const CHANNELS = ['popup:show', 'popup:timer', 'popup:copied', 'popup:leave'];

contextBridge.exposeInMainWorld('typdPopup', {
  on(channel, handler) {
    if (!CHANNELS.includes(channel)) throw new Error(`typdPopup.on: unknown channel "${channel}"`);
    const wrapped = (_event, payload) => handler(payload || {});
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  // Where the card is ({x, y, w, h} in CSS px; [] when it is gone): main's click gate takes clicks
  // there, and the pointer over it pauses the timer.
  hitAreas(list) { ipcRenderer.send('popup:hit', Array.isArray(list) ? list.slice(0, 1) : []); },
  copy() { ipcRenderer.send('popup:copy'); },
  dismiss() { ipcRenderer.send('popup:dismiss'); }
});
