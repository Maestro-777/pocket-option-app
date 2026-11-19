'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const api = {
  getStatus: () => ipcRenderer.invoke('app:get-status'),
  launchSite: () => ipcRenderer.invoke('app:launch-site'),
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
  getMarketDataStatus: () => ipcRenderer.invoke('app:market-data:get-status'),
  listMarketAssets: options => ipcRenderer.invoke('app:market-data:list-assets', options || {}),
  getMarketCandles: request => ipcRenderer.invoke('app:market-data:get-candles', request || {}),
  listExamples: filters => ipcRenderer.invoke('app:examples:list', filters || {}),
  addExample: example => ipcRenderer.invoke('app:examples:add', example),
  updateExample: request => ipcRenderer.invoke('app:examples:update', request || {}),
  removeExample: id => ipcRenderer.invoke('app:examples:remove', id),
  analyzeSituation: request => ipcRenderer.invoke('app:matcher:analyze', request || {}),
  onStatus: fn => { const h = (_e, v) => fn(v); ipcRenderer.on('app:status', h); return () => ipcRenderer.removeListener('app:status', h); },
  onLog: fn => { const h = (_e, v) => fn(v); ipcRenderer.on('app:log', h); return () => ipcRenderer.removeListener('app:log', h); },
  onCheckResult: fn => { const h = (_e, v) => fn(v); ipcRenderer.on('app:check-result', h); return () => ipcRenderer.removeListener('app:check-result', h); },
  onMarketData: fn => { const h = (_e, v) => fn(v); ipcRenderer.on('app:market-data', h); return () => ipcRenderer.removeListener('app:market-data', h); }
};
contextBridge.exposeInMainWorld('pocketApp', api);
