'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, ipcMain } = require('electron');
const { MarketDataStore } = require('../core/market-data-store');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let window;
  let siteWindow;
  let fixturePath;
  const receivedBalances = [];
  const onSiteBalance = (_event, payload) => receivedBalances.push(payload);
  try {
    const store = new MarketDataStore(':memory:');
    if (!store.integrityCheck() || store.getStats().schemaVersion !== 5) throw new Error('SQLite schema v5 did not initialize correctly');
    const now = Date.now();
    store.createAnalysisDecision({
      asset: 'EURUSD_OTC', timeframe: 'S5', decisionAt: now,
      status: 'NO_SIGNAL', direction: null, reason: 'insufficient_similar_examples',
      paramsSnapshot: { topK: 10, minSimilarity: 80 }, matches: [],
      votes: { UP: 0, DOWN: 0 }, averageSimilarity: null,
      queryCandles: [], algorithmVersion: 'shape-v1'
    }, now);
    if (store.listAnalysisDecisions({ limit: 1 }).length !== 1) throw new Error('SQLite decision journal did not persist');
    store.close();

    ipcMain.handle('app:market:assets', () => []);
    ipcMain.handle('app:settings:get', () => ({}));
    ipcMain.handle('app:analysis-decisions:list', () => []);
    ipcMain.handle('app:trade-results:list', () => []);
    ipcMain.handle('app:trade-statistics:get', () => ({ overall: { total: 0, netProfit: 0, wins: 0, losses: 0, draws: 0, winRate: null }, byAsset: [], byTimeframe: [], byDirection: [], byAccountMode: [], byExpiry: [] }));
    ipcMain.handle('app:get-status', () => ({ marketData: { scanner: { running: false, pendingAssets: 0, selectedTimeframes: [], decisions: 0, errors: 0, rankedSignals: [] } } }));
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
      "typeof window.pocketApp?.getMarketAssets === 'function' && typeof window.pocketApp?.createManualExample === 'function' && typeof window.pocketApp?.analyzeSimilarity === 'function' && typeof window.pocketApp?.evaluateSimilarityBacktest === 'function' && typeof window.pocketApp?.getAnalysisDecisions === 'function' && typeof window.pocketApp?.getStatus === 'function' && !!document.getElementById('chart')"
    );
    if (!rendererReady) throw new Error('Manual labeling renderer or restricted preload API did not initialize');
    await window.webContents.executeJavaScript('window.pocketApp.getMarketAssets()');
    await window.webContents.executeJavaScript('Promise.all([window.pocketApp.getTradeResults(), window.pocketApp.getTradeStatistics()])');
    window.destroy();
    window = null;

    // Electron's sandboxed renderer does not consistently navigate to data: URLs
    // in Windows CI. Use a real local file so the isolated preload is exercised
    // under the same file:// origin policy as the packaged application.
    fixturePath = path.join(os.tmpdir(), 'pocket-option-preload-fixture-' + process.pid + '.html');
    fs.writeFileSync(fixturePath, '<!doctype html><html><body><span class="js-balance-real-USD">123.45</span></body></html>', 'utf8');
    ipcMain.on('site:balance', onSiteBalance);
    siteWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'site-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    await siteWindow.loadFile(fixturePath);
    await new Promise(resolve => setTimeout(resolve, 200));
    if (receivedBalances.length !== 1 || receivedBalances[0]?.accountType !== 'real' ||
        receivedBalances[0]?.balance !== 123.45) {
      throw new Error('Isolated site preload did not read and normalize the balance fixture');
    }
    await siteWindow.webContents.executeJavaScript(
      "window.postMessage({type:'PT_PO_BALANCE',accountType:'real',balance:999999,ts:Date.now()}, '*')"
    );
    await new Promise(resolve => setTimeout(resolve, 200));
    if (receivedBalances.length !== 1 || receivedBalances[0].balance !== 123.45) {
      throw new Error('Page postMessage must not be able to forge privileged balance IPC');
    }

    console.log('Electron SQLite, labeling renderer, and isolated site-preload security smoke tests passed');
    app.exit(0);
  } catch (error) {
    console.error('Electron runtime smoke test failed:', error);
    app.exit(1);
  } finally {
    ipcMain.removeListener('site:balance', onSiteBalance);
    try { if (window && !window.isDestroyed()) window.destroy(); } catch (_) {}
    try { if (siteWindow && !siteWindow.isDestroyed()) siteWindow.destroy(); } catch (_) {}
    if (fixturePath) {
      try { fs.rmSync(fixturePath, { force: true }); } catch (_) {}
    }
  }
}).catch(error => {
  console.error('Electron startup failed:', error);
  app.exit(1);
});
