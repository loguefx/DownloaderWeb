'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Safe, minimal API surface exposed to the renderer.
contextBridge.exposeInMainWorld('api', {
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  defaultDownloadDir: () => ipcRenderer.invoke('default-download-dir'),

  snifferList: (webContentsId) => ipcRenderer.invoke('sniffer-list', webContentsId),
  snifferClear: (webContentsId) => ipcRenderer.invoke('sniffer-clear', webContentsId),

  downloadSingle: (payload) => ipcRenderer.invoke('download-single', payload),
  bulkStart: (payload) => ipcRenderer.invoke('bulk-start', payload),

  queuePause: () => ipcRenderer.invoke('queue-pause'),
  queueResume: () => ipcRenderer.invoke('queue-resume'),
  queueStop: () => ipcRenderer.invoke('queue-stop'),
  queueRemove: (ids) => ipcRenderer.invoke('queue-remove', ids),
  queueClear: () => ipcRenderer.invoke('queue-clear'),
  queueSnapshot: () => ipcRenderer.invoke('queue-snapshot'),
  vpnStatus: () => ipcRenderer.invoke('vpn-status'),

  scheduleList: () => ipcRenderer.invoke('schedule-list'),
  scheduleAdd: (spec) => ipcRenderer.invoke('schedule-add', spec),
  scheduleRemove: (key) => ipcRenderer.invoke('schedule-remove', key),
  scheduleCheck: () => ipcRenderer.invoke('schedule-check'),

  // Event subscriptions (return an unsubscribe function).
  onDetected: (cb) => subscribe('sniffer:detected', cb),
  onVpnStatus: (cb) => subscribe('vpn:status', cb),
  onQueueUpdate: (cb) => subscribe('queue:update', cb),
  onQueueLog: (cb) => subscribe('queue:log', cb),
  onQueueStopped: (cb) => subscribe('queue:stopped', cb),
  onScheduleUpdate: (cb) => subscribe('schedule:update', cb)
});

function subscribe(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
