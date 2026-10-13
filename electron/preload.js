/**
 * Preload — exposes the minimum safe API to the renderer.
 * No require/fs/process/child_process. Context-isolated.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  checkForUpdate: () => ipcRenderer.invoke('app:checkForUpdate'),
  // Phase C: the full lifecycle. Each maps to a narrowly-scoped main-process
  // handler — the renderer never receives the updater object, a file path, or any
  // ability to install without the main process running its backup and schema
  // checks first. Context isolation and the absence of nodeIntegration are
  // unchanged.
  getUpdateState: () => ipcRenderer.invoke('app:getUpdateState'),
  startDownload: () => ipcRenderer.invoke('app:startDownload'),
  postponeUpdate: () => ipcRenderer.invoke('app:postponeUpdate'),
  installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
  getChannel: () => ipcRenderer.invoke('app:getChannel'),
  setChannel: (channel) => ipcRenderer.invoke('app:setChannel', String(channel)),
  onUpdateStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },
});
