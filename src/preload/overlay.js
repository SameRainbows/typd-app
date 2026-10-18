'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// One path in, one path out. Every channel here exists because the dictation
// loop needs it; anything else belongs in parked/ until dictation is finished.
const CHANNELS = [
  'session:start',
  'session:mode',
  'session:capture-end',
  'session:thinking',
  'session:expect',
  'session:partial',
  'session:done',
  'session:cancel',
  'session:error',
  'session:note',
  'settings:changed'
];

contextBridge.exposeInMainWorld('typd', {
  on(channel, handler) {
    if (!CHANNELS.includes(channel)) {
      throw new Error(`typd.on: unknown channel "${channel}"`);
    }
    const wrapped = (_event, payload) => handler(payload || {});
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  // The overlay is click-through except over its live controls. The page says where they are
  // ({x, y, w, h} in CSS px; [] when there are none) and main decides from the cursor
  // (overlay-window.js, the click gate).
  hitAreas(list) {
    ipcRenderer.send('overlay:hit', Array.isArray(list) ? list.slice(0, 4) : []);
  },

  // Captured PCM, handed over once at the end of a session. `buffer` is the
  // ArrayBuffer behind a Float32Array of mono samples.
  sendAudio(buffer, sampleRate) {
    ipcRenderer.send('overlay:audio', { buffer, sampleRate });
  },

  // The same PCM live, one capture block at a time, for models that take audio
  // in pieces while the user is still talking.
  sendChunk(buffer, sampleRate) {
    ipcRenderer.send('overlay:chunk', { buffer, sampleRate });
  },

  // The microphone failed to open ('unavailable') or delivers digital silence ('silent'),
  // which is what a Windows privacy block or a hardware mute looks like from here.
  // `why`: the capture error's name (NotAllowedError, NotFoundError, NotReadableError...), for the log.
  micProblem(kind, why) { ipcRenderer.send('overlay:mic', kind, typeof why === 'string' ? why.slice(0, 40) : ''); },

  // The input devices ({deviceId, label}), for the tray's Microphone menu.
  devices(list) { ipcRenderer.send('overlay:devices', Array.isArray(list) ? list : []); },

  confirm() { ipcRenderer.send('overlay:confirm'); },
  cancel() { ipcRenderer.send('overlay:cancel'); },
  notifyHidden() { ipcRenderer.send('overlay:hidden'); }
});
