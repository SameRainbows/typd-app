'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Four calls, named; nothing generic crosses this bridge.
contextBridge.exposeInMainWorld('typdSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  openRecordings: () => ipcRenderer.invoke('settings:open-recordings')
});
