'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('typdHome', {
  data: () => ipcRenderer.invoke('home:data'),
  addWord: (term) => ipcRenderer.invoke('home:dictionary-add', term),
  removeWord: (term) => ipcRenderer.invoke('home:dictionary-remove', term),
  setRetention: (days) => ipcRenderer.invoke('home:set-retention', days),
  clearHistory: () => ipcRenderer.invoke('home:clear-history'),
  setTheme: (mode) => ipcRenderer.invoke('home:set-theme', mode),
  onChanged: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on('home:changed', wrapped);
    return () => ipcRenderer.removeListener('home:changed', wrapped);
  }
});
