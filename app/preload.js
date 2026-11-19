const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  sources: () => ipcRenderer.invoke('sources'),
  select: id => ipcRenderer.invoke('select', id),
  audioStart: (mode, target) => ipcRenderer.invoke('audio-start', mode, target),
  audioStop: id => ipcRenderer.invoke('audio-stop', id),
  onPcm: cb => ipcRenderer.on('pcm', (_e, id, data) => cb(id, data)),
});
