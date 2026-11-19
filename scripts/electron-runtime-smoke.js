'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { MarketDataStore } = require('../core/market-data-store');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let window;
  try {
    const store = new MarketDataStore(':memory:');
    if (!store.integrityCheck() || store.getStats().schemaVersion !== 2) throw new Error('SQLite schema v2 did not initialize correctly');
    store.close();

    ipcMain.handle('app:market:assets', () => []);
    ipcMain.handle('app:manual-examples:list', () => []);
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'labeler.html'));
    const rendererReady = await window.webContents.executeJavaScript(
      "typeof window.pocketApp?.getMarketAssets === 'function' && typeof window.pocketApp?.createManualExample === 'function' && !!document.getElementById('chart')"
    );
    if (!rendererReady) throw new Error('Manual labeling renderer or restricted preload API did not initialize');
    await window.webContents.executeJavaScript('window.pocketApp.getMarketAssets()');
    window.destroy();
    console.log('Electron SQLite and manual labeling renderer smoke tests passed');
    app.exit(0);
  } catch (error) {
    try { if (window && !window.isDestroyed()) window.destroy(); } catch (_) {}
    console.error('Electron runtime smoke test failed:', error);
    app.exit(1);
  }
}).catch(error => {
  console.error('Electron startup failed:', error);
  app.exit(1);
});
