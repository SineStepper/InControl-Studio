/*
 * preload.js — exposes a minimal, safe MIDI bridge to the renderer as
 * window.electronMIDI. js/midi.js detects this and uses it instead of Web MIDI.
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronMIDI', {
  list: () => ipcRenderer.invoke('midi:list'),
  send: (port, bytes) => ipcRenderer.send('midi:send', { port, bytes }),
  listen: (port, enable) => ipcRenderer.send('midi:listen', { port, enable }),
  onMessage: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('midi:message', h);
    return () => ipcRenderer.removeListener('midi:message', h);
  },
  onPorts: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('midi:ports', h);
    return () => ipcRenderer.removeListener('midi:ports', h);
  },
});
