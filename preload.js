'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const api = {
  getStatus: () => ipcRenderer.invoke('app:get-status'),
  launchSite: () => ipcRenderer.invoke('app:launch-site'),
  openLabeler: () => ipcRenderer.invoke('app:labeler:open'),
  getMarketAssets: () => ipcRenderer.invoke('app:market:assets'),
  getMarketCandles: (asset, timeframe, options) => ipcRenderer.invoke('app:market:candles', asset, timeframe, options),
  getManualExamples: filters => ipcRenderer.invoke('app:manual-examples:list', filters),
  createManualExample: example => ipcRenderer.invoke('app:manual-examples:create', example),
  updateManualExample: (id, changes) => ipcRenderer.invoke('app:manual-examples:update', id, changes),
  deleteManualExample: id => ipcRenderer.invoke('app:manual-examples:delete', id),
  showSite: () => ipcRenderer.invoke('app:show-site'),
  hideSite: () => ipcRenderer.invoke('app:hide-site'),
  reloadSite: () => ipcRenderer.invoke('app:reload-site'),
  switchAccount: mode => ipcRenderer.invoke('app:account:switch', mode),
  toggleWidget: () => ipcRenderer.invoke('app:toggle-widget'),
  getSettings: () => ipcRenderer.invoke('app:settings:get'),
  saveSettings: value => ipcRenderer.invoke('app:settings:save', value),
  runCheck: () => ipcRenderer.invoke('app:run-check'),
  readLogs: () => ipcRenderer.invoke('app:logs:read'),
  exportLogs: () => ipcRenderer.invoke('app:logs:export'),
  checkUpdates: () => ipcRenderer.invoke('app:update:check'),
  downloadUpdate: () => ipcRenderer.invoke('app:update:download'),
  installUpdate: () => ipcRenderer.invoke('app:update:install'),
  onStatus: fn => { const h = (_e, v) => fn(v); ipcRenderer.on('app:status', h); return () => ipcRenderer.removeListener('app:status', h); },
  onLog: fn => { const h = (_e, v) => fn(v); ipcRenderer.on('app:log', h); return () => ipcRenderer.removeListener('app:log', h); },
  onCheckResult: fn => { const h = (_e, v) => fn(v); ipcRenderer.on('app:check-result', h); return () => ipcRenderer.removeListener('app:check-result', h); }
};
contextBridge.exposeInMainWorld('pocketApp', api);
