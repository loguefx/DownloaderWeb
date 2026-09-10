'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Safe, minimal API surface exposed to the renderer.
contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  linuxBrowser: {
    setBounds: (bounds) => ipcRenderer.invoke('linux-browser:bounds', bounds),
    setVisible: (show) => ipcRenderer.invoke('linux-browser:set-visible', show),
    loadURL: (url) => ipcRenderer.invoke('linux-browser:load-url', url),
    goBack: () => ipcRenderer.invoke('linux-browser:go-back'),
    goForward: () => ipcRenderer.invoke('linux-browser:go-forward'),
    reload: () => ipcRenderer.invoke('linux-browser:reload'),
    getURL: () => ipcRenderer.invoke('linux-browser:get-url'),
    getWebContentsId: () => ipcRenderer.invoke('linux-browser:get-wc-id'),
    exec: (code) => ipcRenderer.invoke('linux-browser:exec', code),
    onEvent: (cb) => subscribe('linux-browser:event', cb)
  },
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  defaultDownloadDir: () => ipcRenderer.invoke('default-download-dir'),

  snifferList: (webContentsId) => ipcRenderer.invoke('sniffer-list', webContentsId),
  snifferClear: (webContentsId) => ipcRenderer.invoke('sniffer-clear', webContentsId),

  downloadSingle: (payload) => ipcRenderer.invoke('download-single', payload),
  downloadEpisode: (payload) => ipcRenderer.invoke('download-episode', payload),
  bulkStart: (payload) => ipcRenderer.invoke('bulk-start', payload),

  queuePause: () => ipcRenderer.invoke('queue-pause'),
  queueResume: () => ipcRenderer.invoke('queue-resume'),
  queueStop: () => ipcRenderer.invoke('queue-stop'),
  queueRemove: (ids) => ipcRenderer.invoke('queue-remove', ids),
  queueClear: () => ipcRenderer.invoke('queue-clear'),
  queueSnapshot: () => ipcRenderer.invoke('queue-snapshot'),
  logSnapshot: () => ipcRenderer.invoke('queue-log-snapshot'),
  logClear: () => ipcRenderer.invoke('queue-log-clear'),
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
