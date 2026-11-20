'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, Tray, Menu, ipcMain, session, nativeImage, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const archiver = require('archiver');
const ModuleManager = require('./modules/manager');
const { MarketDataService } = require('./core/market-data');
const { MarketDataStore: MarketDataPersistence } = require('./core/market-data-store');
const { SignalScheduler } = require('./core/signal-scheduler');
const { ScanStateStore } = require('./core/scan-state-store');
const { TradeLedger } = require('./core/trade-ledger');
const { TradingGate } = require('./core/trading-gate');
const TradeExecutionAdapter = require('./core/trade-execution');
const { ExampleStore } = require('./core/example-store');
const { DecisionJournal } = require('./core/decision-journal');
const { analyzeSituation, normalizeConfig } = require('./core/matcher');
const { getTimeframeDuration } = require('./core/timeframes');
const { isTrustedPocketOptionFrame, validateBalancePayload, validateMarketBatch } = require('./core/ipc-validation');

const APP_NAME = 'Pocket Option Background';
const ACCOUNT_URLS = {
  DEMO: 'https://pocketoption.com/ru/cabinet/demo-quick-high-low/',
  REAL: 'https://pocketoption.com/ru/cabinet/quick-high-low/RUB/'
};
const PARTITION = 'persist:pocket-option-background';
const HEALTH_INTERVAL = 30_000;
const FULL_CHECK_INTERVAL = 5 * 60_000;

let mainWindow = null;
let siteWindow = null;
let miniWindow = null;
let tray = null;
let quitting = false;
let recoveryInProgress = false;
let healthTimer = null;
let fullCheckTimer = null;
let updateCheckTimer = null;
let updateCheckTimeout = null;
let appStartedAt = Date.now();
let lastBalance = null;
let lastSiteSignalAt = 0;
let lastBalanceMessageAt = 0;
let lastNetworkOk = null;
let lastNetworkCheckAt = null;
let reconnectAttempts = 0;
let reloadHistory = [];
let selectedAccount = 'DEMO';
let updateState = { status: 'idle', version: null, progress: 0, message: 'Проверка не выполнялась' };
let moduleManager = null;
let startupStage = 'module initialization';
const marketDataStore = new MarketDataService();
let marketDataPersistence = null;
let marketDataSaveTimer = null;
let signalScheduler = null;
let scanStateStore = null;
let tradeLedger = null;
let tradingGate = null;
let tradeExecution = null;
let exampleStore = null;
let decisionJournal = null;
let marketBatchWindowAt = 0;
let marketBatchCount = 0;
let marketStatusPublishedAt = 0;
let settings = {
  showMiniWidget: false,
  monitorIntervalMinutes: 5,
  reconnectAttemptsBeforeReload: 3,
  reconnectDelaySeconds: 30,
  maxReloadsPer10Minutes: 3,
  autoCheckUpdates: true,
  analysisConfig: { topK: 10, similarityThreshold: 80, minExamples: 3, minDirectionalMatches: 6, patternLength: 30 },
  schedulerConfig: { enabled: true, timeframes: ['S5','S10','S15','S30','M1','M2','M3','M5','M10','M15'], lookback: 300, maxOpenTrades: 1, scanIntervalMs: 1500 },
  autoTradingEnabled: false
};

const userRoot = () => app.getPath('userData');
const logsDir = () => path.join(userRoot(), 'logs');
const settingsFile = () => path.join(userRoot(), 'settings.json');
const logFile = () => path.join(logsDir(), 'application.log');

function log(level, message, data) {
  const row = { at: new Date().toISOString(), level, message: String(message), ...(data ? { data } : {}) };
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.appendFileSync(logFile(), JSON.stringify(row) + os.EOL, 'utf8');
  } catch (error) { console.error('Log write failed', error); }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:log', row);
  try { if (miniWindow && !miniWindow.isDestroyed()) miniWindow.webContents.send('app:status', getPublicStatus()); } catch (error) { console.error('Mini-window log notification failed', error); }
  console[level === 'error' ? 'error' : 'log']('[PO Background]', row);
}
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch (_) {}
}
function saveSettings() {
  fs.mkdirSync(userRoot(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
}
function createMainWindow() {
  const window = new BrowserWindow({
    width: 1180, height: 820, minWidth: 980, minHeight: 680,
    show: true, title: APP_NAME, backgroundColor: '#0b1020', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow = window;
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) { window.show(); window.focus(); }
    log('info', 'Главное окно готово к отображению');
  });
  window.webContents.on('did-finish-load', () => {
    log('info', 'Интерфейс главного окна загружен');
    if (!window.isDestroyed() && !window.isVisible()) window.show();
  });
  window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) log('error', 'Не удалось загрузить интерфейс приложения', { code, description, url });
    if (!window.isDestroyed() && !window.isVisible()) window.show();
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    log('error', 'Процесс интерфейса завершился', details);
  });
  window.webContents.on('console-message', (_event, details) => {
    if (details.level >= 2) log('error', 'Ошибка JavaScript интерфейса', {
      message: details.message, line: details.lineNumber, source: details.sourceId
    });
  });
  window.on('unresponsive', () => log('error', 'Главное окно перестало отвечать'));
  window.on('close', event => {
    if (!quitting) { event.preventDefault(); window.hide(); log('info', 'Главное окно скрыто в системный трей'); }
  });
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  window.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch(error => {
    log('error', 'Ошибка открытия главного интерфейса', String(error));
    if (!window.isDestroyed()) window.show();
  });
}
function createMiniWindow() {
  if (miniWindow && !miniWindow.isDestroyed()) return miniWindow;
  miniWindow = new BrowserWindow({
    width: 270, height: 154, minWidth: 250, minHeight: 140,
    frame: false, transparent: true, resizable: true, movable: true,
    alwaysOnTop: false, show: false, skipTaskbar: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  miniWindow.loadFile(path.join(__dirname, 'renderer', 'widget.html'));
  miniWindow.on('closed', () => { miniWindow = null; });
  return miniWindow;
}
function createTray() {
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIUlEQVQ4T2NkYGD4z0ABYBw1gGE0DBgYGBgY/4EBAwMAAAgAAf8B4V4AAAAASUVORK5CYII=');
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  refreshTrayMenu();
}
function refreshTrayMenu() {
  if (!tray) return;
  const siteOpen = !!(siteWindow && !siteWindow.isDestroyed());
  const widgetOpen = !!(miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть панель управления', click: showMain },
    { label: siteOpen && siteWindow.isVisible() ? 'Скрыть Pocket Option' : 'Показать Pocket Option', enabled: siteOpen, click: toggleSite },
    { label: widgetOpen ? 'Скрыть мини-виджет' : 'Показать мини-виджет', click: toggleWidget },
    { type: 'separator' },
    { label: 'Статус: ' + (lastNetworkOk === false ? 'нет интернета' : siteOpen ? 'сайт запущен' : 'сайт не запущен'), enabled: false },
    { label: 'Проверить состояние сейчас', click: () => runFullCheck('manual') },
    { label: 'Перезапустить приложение', click: () => { app.relaunch(); app.quit(); } },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } }
  ]));
}
function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  mainWindow.show(); mainWindow.focus();
}
function toggleSite() {
  if (!siteWindow || siteWindow.isDestroyed()) return launchSite();
  if (siteWindow.isVisible()) siteWindow.hide();
  else { siteWindow.show(); siteWindow.focus(); }
  refreshTrayMenu(); publishStatus();
}
function toggleWidget() {
  if (!miniWindow || miniWindow.isDestroyed()) createMiniWindow();
  if (miniWindow.isVisible()) miniWindow.hide();
  else miniWindow.show();
  refreshTrayMenu(); publishStatus();
}
function injectSiteBridge(win) {
  try {
    const source = fs.readFileSync(path.join(__dirname, 'site-bridge.js'), 'utf8');
    win.webContents.executeJavaScript(source, true).catch(error => log('warn', 'Не удалось внедрить адаптер Pocket Option', String(error)));
  } catch (error) { log('error', 'Файл адаптера не найден', String(error)); }
}
function launchSite() {
  if (siteWindow && !siteWindow.isDestroyed()) {
    siteWindow.show(); siteWindow.focus(); refreshTrayMenu(); return;
  }
  const poSession = session.fromPartition(PARTITION);
  siteWindow = new BrowserWindow({
    width: 1440, height: 940, minWidth: 980, minHeight: 680,
    show: true, title: 'Pocket Option', backgroundColor: '#0b1020', autoHideMenuBar: true,
    webPreferences: {
      session: poSession, preload: path.join(__dirname, 'site-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, spellcheck: false
    }
  });
  siteWindow.webContents.setBackgroundThrottling(false);
  siteWindow.webContents.on('did-finish-load', () => {
    log('info', 'Страница Pocket Option загружена', { url: siteWindow.webContents.getURL() });
    injectSiteBridge(siteWindow); publishStatus();
  });
  siteWindow.webContents.on('dom-ready', () => injectSiteBridge(siteWindow));
  siteWindow.webContents.on('did-start-loading', () => { log('info', 'Pocket Option: началась загрузка'); publishStatus(); });
  siteWindow.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) log('error', 'Ошибка загрузки Pocket Option', { code, description, url });
    publishStatus();
  });
  siteWindow.webContents.on('render-process-gone', (_e, details) => {
    log('error', 'Процесс страницы завершился', details); publishStatus();
  });
  siteWindow.on('close', event => {
    if (!quitting) { event.preventDefault(); siteWindow.hide(); log('info', 'Окно Pocket Option скрыто; профиль сохранён'); }
  });
  siteWindow.on('show', () => { refreshTrayMenu(); publishStatus(); });
  siteWindow.on('hide', () => { refreshTrayMenu(); publishStatus(); });
  siteWindow.on('closed', () => { siteWindow = null; refreshTrayMenu(); publishStatus(); });
  siteWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) { shell.openExternal(url); }
    return { action: 'deny' };
  });
  selectedAccount = 'DEMO';
  siteWindow.loadURL(ACCOUNT_URLS.DEMO).catch(error => log('error', 'Не удалось открыть Pocket Option', String(error)));
  log('info', 'Пользователь запустил Pocket Option');
  refreshTrayMenu(); publishStatus();
}
function getPublicStatus() {
  const age = lastBalance ? Math.max(0, Date.now() - lastBalance.ts) : null;
  return {
    appVersion: app.getVersion(), uptimeSeconds: Math.floor((Date.now() - appStartedAt) / 1000),
    site: {
      running: !!(siteWindow && !siteWindow.isDestroyed()),
      visible: !!(siteWindow && !siteWindow.isDestroyed() && siteWindow.isVisible()),
      loading: !!(siteWindow && !siteWindow.isDestroyed() && siteWindow.webContents.isLoading()),
      url: siteWindow && !siteWindow.isDestroyed() ? siteWindow.webContents.getURL() : null
    },
    network: { online: lastNetworkOk, checkedAt: lastNetworkCheckAt },
    marketData: marketDataStore.store.getSnapshot(),
    account: {
      type: lastBalance?.accountType || selectedAccount.toLowerCase(),
      balance: lastBalance?.balance ?? null, currency: lastBalance?.currency || '',
      updatedAt: lastBalance?.ts || null, stale: age == null || age > 15000
    },
    widgetVisible: !!(miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible()),
    reconnectAttempts, update: updateState
  };
}
function publishStatus() {
  const status = getPublicStatus();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:status', status);
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.webContents.send('app:status', status);
  return status;
}

function isTrustedMainRenderer(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame;
}
function requireTrustedMainRenderer(event) {
  if (!isTrustedMainRenderer(event)) throw new Error('Недоверенный IPC-отправитель');
}
ipcMain.handle('analysis:get-assets', event => {
  requireTrustedMainRenderer(event);
  const observed = new Map(marketDataStore.getSnapshot().assets.map(item => [item.asset, item]));
  const catalog = Array.from(marketDataStore.store.catalog.values()).filter(item => item.isOtc);
  const assets = new Map(catalog.map(item => [item.asset, { asset: item.asset, label: item.label, lastPrice: null, lastTickAt: null, ageMs: null }]));
  for (const item of observed.values()) if (item.isOtc) assets.set(item.asset, { ...assets.get(item.asset), ...item });
  return Array.from(assets.values()).sort((a, b) => a.asset.localeCompare(b.asset));
});
ipcMain.handle('analysis:get-candles', (event, request = {}) => {
  requireTrustedMainRenderer(event);
  const asset = String(request.asset || '').trim().toUpperCase();
  const timeframe = String(request.timeframe || '').toUpperCase();
  const limit = Math.max(2, Math.min(2000, Number(request.limit) || 300));
  getTimeframeDuration(timeframe);
  if (!/_OTC$/.test(asset)) throw new Error('Разрешены только OTC-пары');
  return marketDataStore.getCandles(asset, timeframe, { asOf: Date.now(), limit: 2000 })
    .filter(candle => candle.complete).slice(-limit);
});
ipcMain.handle('examples:list', async (event, filters = {}) => {
  requireTrustedMainRenderer(event);
  return exampleStore.list({ timeframe: filters.timeframe, pair: filters.pair });
});
ipcMain.handle('examples:add', async (event, input) => {
  requireTrustedMainRenderer(event);
  const row = await exampleStore.add(input);
  await decisionJournal.append('DECISION', { action: 'manual_example_added', exampleId: row.id, pair: row.pair, timeframe: row.timeframe });
  return row;
});
ipcMain.handle('examples:update', async (event, request = {}) => {
  requireTrustedMainRenderer(event);
  const row = await exampleStore.update(request.id, request.patch || {});
  await decisionJournal.append('DECISION', { action: 'manual_example_updated', exampleId: row.id });
  return row;
});
ipcMain.handle('examples:remove', async (event, id) => {
  requireTrustedMainRenderer(event);
  const removed = await exampleStore.remove(id);
  if (removed) await decisionJournal.append('DECISION', { action: 'manual_example_removed', exampleId: String(id) });
  return { ok: removed };
});
ipcMain.handle('analysis:run', async (event, request = {}) => {
  requireTrustedMainRenderer(event);
  const asset = String(request.asset || '').trim().toUpperCase();
  const timeframe = String(request.timeframe || '').toUpperCase();
  getTimeframeDuration(timeframe);
  if (!/_OTC$/.test(asset)) throw new Error('Разрешены только OTC-пары');
  const config = normalizeConfig(request.config || settings.analysisConfig || {});
  const candles = marketDataStore.getAggregatedCandles(asset, timeframe, { asOf: Date.now() })
    .filter(candle => candle.complete).slice(-Math.max(config.patternLength, Math.min(2000, Number(request.lookback) || 300)));
  const examples = await exampleStore.list({ timeframe });
  const entryAt = candles.length ? candles[candles.length - 1].endAt : Date.now();
  const decision = analyzeSituation({ candles, timeframe, entryAt, examples, config });
  await decisionJournal.append('DECISION', {
    asset, timeframe, entryAt, accepted: decision.accepted, direction: decision.direction,
    reason: decision.reason, matchCount: decision.matchCount, upVotes: decision.upVotes,
    downVotes: decision.downVotes, averageSimilarity: decision.averageSimilarity,
    matches: decision.matches
  }, decision.settingsSnapshot);
  return { decision, candleCount: candles.length, exampleCount: examples.length };
});

ipcMain.handle('analysis:scheduler-status', event => {
  requireTrustedMainRenderer(event);
  return { scheduler: signalScheduler ? signalScheduler.getStatus() : null,
    recent: signalScheduler ? signalScheduler.getRecentDecisions().slice(0, 100) : [],
    market: marketDataStore.getStatus() };
});
ipcMain.handle('trades:summary', event => {
  requireTrustedMainRenderer(event);
  return tradeLedger ? { status: tradeLedger.getStatus(), trades: tradeLedger.list().slice(0, 200) } : { status: null, trades: [] };
});
ipcMain.handle('trades:pause', (event, paused) => {
  requireTrustedMainRenderer(event);
  if (!tradingGate) return { ok: false };
  return { ok: true, state: tradingGate.setPaused(paused === true), autoTradingEnabled: false };
});

ipcMain.handle('analysis:journal', async event => {
  requireTrustedMainRenderer(event);
  return decisionJournal.readRecent(200);
});

ipcMain.handle('app:get-status', () => getPublicStatus());
ipcMain.handle('app:launch-site', () => { launchSite(); return { ok: true }; });
ipcMain.handle('app:show-site', () => {
  if (!siteWindow || siteWindow.isDestroyed()) return { ok: false };
  siteWindow.show(); siteWindow.focus(); refreshTrayMenu(); return { ok: true };
});
ipcMain.handle('app:hide-site', () => {
  if (!siteWindow || siteWindow.isDestroyed()) return { ok: false };
  siteWindow.hide(); refreshTrayMenu(); publishStatus(); return { ok: true };
});
ipcMain.handle('app:reload-site', async () => {
  if (!siteWindow || siteWindow.isDestroyed()) return { ok: false };
  await siteWindow.webContents.reload(); log('warn', 'Пользователь запросил перезагрузку Pocket Option'); return { ok: true };
});
ipcMain.handle('app:toggle-widget', () => { toggleWidget(); return { ok: true }; });
ipcMain.handle('app:settings:get', () => settings);
ipcMain.handle('analysis:settings:get', event => {
  requireTrustedMainRenderer(event);
  return normalizeConfig(settings.analysisConfig || {});
});
ipcMain.handle('analysis:settings:save', (event, input = {}) => {
  requireTrustedMainRenderer(event);
  const config = normalizeConfig(input);
  settings.analysisConfig = { ...config };
  saveSettings();
  return settings.analysisConfig;
});
ipcMain.handle('app:settings:save', (_event, next) => {
  if (!next || typeof next !== 'object') return settings;
  if (typeof next.showMiniWidget === 'boolean') settings.showMiniWidget = next.showMiniWidget;
  if (typeof next.autoCheckUpdates === 'boolean') settings.autoCheckUpdates = next.autoCheckUpdates;
  if (Number.isFinite(Number(next.monitorIntervalMinutes))) settings.monitorIntervalMinutes = Math.max(5, Math.min(30, Number(next.monitorIntervalMinutes)));
  if (Number.isFinite(Number(next.reconnectAttemptsBeforeReload))) settings.reconnectAttemptsBeforeReload = Math.max(1, Math.min(10, Number(next.reconnectAttemptsBeforeReload)));
  if (Number.isFinite(Number(next.reconnectDelaySeconds))) settings.reconnectDelaySeconds = Math.max(5, Math.min(300, Number(next.reconnectDelaySeconds)));
  if (Number.isFinite(Number(next.maxReloadsPer10Minutes))) settings.maxReloadsPer10Minutes = Math.max(1, Math.min(5, Number(next.maxReloadsPer10Minutes)));
  saveSettings();
  configureUpdateChecks();
  if (healthTimer) clearInterval(healthTimer);
  if (fullCheckTimer) clearInterval(fullCheckTimer);
  healthTimer = setInterval(() => healthTick().catch(error => log('error', 'Health tick failed', String(error))), HEALTH_INTERVAL);
  fullCheckTimer = setInterval(() => runFullCheck('scheduled').catch(error => log('error', 'Full check failed', String(error))), Math.max(5, Number(settings.monitorIntervalMinutes) || 5) * 60_000);
  if (settings.showMiniWidget) createMiniWindow().show();
  else if (miniWindow && !miniWindow.isDestroyed()) miniWindow.hide();
  log('info', 'Настройки сохранены', settings); return settings;
});
ipcMain.handle('app:account:switch', async (_event, target) => {
  const mode = String(target || '').toUpperCase();
  if (!['DEMO', 'REAL'].includes(mode)) return { ok: false, reason: 'Неизвестный режим счёта' };
  if (!siteWindow || siteWindow.isDestroyed()) return { ok: false, reason: 'Сначала запусти Pocket Option' };
  if (mode === 'REAL') {
    const answer = await dialog.showMessageBox({
      type: 'warning', buttons: ['Отмена', 'Перейти на REAL'], defaultId: 0, cancelId: 0,
      title: 'Подтверждение реального счёта',
      message: 'Переключить Pocket Option на REAL?',
      detail: 'На реальном счёте действия на сайте могут повлечь финансовые последствия. Приложение не совершает сделки автоматически.'
    });
    if (answer.response !== 1) return { ok: false, cancelled: true };
  }
  log('warn', 'Запрошено переключение счёта', { from: selectedAccount, to: mode });
  const requestedAt = Date.now();
  try {
    await siteWindow.loadURL(ACCOUNT_URLS[mode]);
    const confirmed = await waitForAccountMode(mode, 20000, requestedAt);
    if (!confirmed) {
      log('error', 'Pocket Option не подтвердил переключение счёта', { target: mode, url: siteWindow.webContents.getURL() });
      return { ok: false, reason: 'Сайт не подтвердил выбранный режим. Отображаемый счёт не изменён.' };
    }
    selectedAccount = mode;
    log('info', 'Режим счёта подтверждён сайтом', { mode });
    publishStatus(); return { ok: true, mode };
  } catch (error) { log('error', 'Ошибка переключения счёта', String(error)); return { ok: false, reason: String(error) }; }
});
async function waitForAccountMode(mode, timeoutMs, afterTs = 0) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!siteWindow || siteWindow.isDestroyed()) return false;
    try {
      const result = await siteWindow.webContents.executeJavaScript('window.__PT_PO_STATUS__ || null', true);
      const now = Date.now();
      const statusTs = Number(result?.ts);
      const fresh = Number.isFinite(statusTs) && statusTs >= afterTs && statusTs <= now + 2000 && now - statusTs <= 15000;
      if (fresh && result.accountType === mode.toLowerCase() && Number.isFinite(result.balance) && result.balance >= 0) return true;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}
function isTrustedPocketOptionSender(event) {
  if (!siteWindow || siteWindow.isDestroyed()) return false;
  return isTrustedPocketOptionFrame(event, siteWindow.webContents, siteWindow.webContents.getURL());
}
ipcMain.on('site:balance', (event, payload) => {
  if (!isTrustedPocketOptionSender(event)) return;
  const now = Date.now();
  const normalized = validateBalancePayload(payload, {
    now, lastMessageAt: lastBalanceMessageAt, lastTimestamp: lastBalance?.ts
  });
  if (!normalized) return;
  lastBalanceMessageAt = now;
  lastBalance = normalized;
  lastSiteSignalAt = now; selectedAccount = normalized.accountType.toUpperCase(); publishStatus();
});
ipcMain.on('site:log', (event, payload) => { if (!isTrustedPocketOptionSender(event)) return; log(payload?.level === 'error' ? 'error' : 'info', 'Pocket Option: ' + String(payload?.message || '')); });
ipcMain.on('site:market-batch', (event, batch) => {
  if (!isTrustedPocketOptionSender(event)) return;
  const now = Date.now();
  if (now - marketBatchWindowAt >= 1000) {
    marketBatchWindowAt = now;
    marketBatchCount = 0;
  }
  if (++marketBatchCount > 60) return;
  const safeBatch = validateMarketBatch(batch, now);
  if (!safeBatch.length) return;

  let accepted = 0;
  for (const item of safeBatch) {
    const result = marketDataStore.ingestEvent(item.eventName, item.payload, item.receivedAt);
    if (result.accepted) accepted++;
  }
  if (accepted) {
    const snapshot = marketDataStore.getSnapshot(now);
    if (snapshot.acceptedTickCount && Math.floor(snapshot.acceptedTickCount / 250) !== Math.floor((snapshot.acceptedTickCount - accepted) / 250)) {
      log('info', 'Получены рыночные данные Pocket Option', {
        assets: snapshot.assetCount, catalogAssets: snapshot.catalogAssetCount,
        ticks: snapshot.acceptedTickCount, lastEvent: snapshot.lastEventName
      });
    }
    if (now - marketStatusPublishedAt >= 1000) {
      marketStatusPublishedAt = now;
      publishStatus();
    }
  }
});
ipcMain.handle('app:run-check', () => runFullCheck('manual'));
ipcMain.handle('app:logs:read', () => {
  try { return fs.readFileSync(logFile(), 'utf8').split(/\r?\n/).filter(Boolean).slice(-1000).map(line => { try { return JSON.parse(line); } catch (_) { return { message: line }; } }); }
  catch (_) { return []; }
});
ipcMain.handle('app:logs:export', async () => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('downloads'), 'pocket-option-logs.zip'),
    filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
  });
  if (!filePath) return { cancelled: true };
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve); archive.on('error', reject); archive.pipe(output);
    if (fs.existsSync(logFile())) archive.file(logFile(), { name: 'application.log' });
    if (fs.existsSync(settingsFile())) archive.file(settingsFile(), { name: 'settings.json' });
    archive.finalize();
  });
  log('info', 'Журналы экспортированы', { filePath }); return { ok: true, filePath };
});
ipcMain.handle('app:update:check', async () => {
  if (!app.isPackaged) return { ok: false, reason: 'Проверка обновлений доступна только в установленной сборке.' };
  try {
    updateState = { status: 'checking', version: null, progress: 0, message: 'Проверяем обновления…' };
    publishStatus();
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    updateState = { status: 'error', version: null, progress: 0, message: 'Не удалось проверить обновления' };
    log('error', 'Ошибка проверки обновлений', String(error));
    publishStatus();
    return { ok: false, reason: String(error) };
  }
});
ipcMain.handle('app:update:download', async () => {
  if (!app.isPackaged) return { ok: false, reason: 'Загрузка обновлений доступна только в установленной сборке.' };
  try { await autoUpdater.downloadUpdate(); return { ok: true }; }
  catch (error) {
    log('error', 'Не удалось загрузить обновление', String(error));
    return { ok: false, reason: String(error) };
  }
});
ipcMain.handle('app:update:install', () => {
  if (updateState.status !== 'downloaded') return { ok: false, reason: 'Обновление ещё не загружено.' };
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
});

// Обновления скачиваются автоматически после обнаружения релиза.
// Установка выполняется при нажатии пользователем или при следующем штатном выходе.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowDowngrade = false;
autoUpdater.on('checking-for-update', () => { updateState = { status: 'checking', version: null, progress: 0, message: 'Проверяем обновления…' }; publishStatus(); });
autoUpdater.on('update-available', info => { updateState = { status: 'downloading', version: info.version, progress: 0, message: 'Найдено обновление. Начинается автоматическая загрузка…' }; log('info', 'Найдено обновление', { version: info.version }); publishStatus(); });
autoUpdater.on('update-not-available', info => { updateState = { status: 'current', version: info.version, progress: 0, message: 'Установлена последняя версия' }; publishStatus(); });
autoUpdater.on('download-progress', p => { updateState = { status: 'downloading', version: updateState.version, progress: Math.round(p.percent), message: 'Загрузка обновления: ' + Math.round(p.percent) + '%' }; publishStatus(); });
autoUpdater.on('update-downloaded', info => { updateState = { status: 'downloaded', version: info.version, progress: 100, message: 'Версия ' + info.version + ' загружена. Нажмите «Установить и перезапустить» или закройте приложение для установки.' }; log('info', 'Обновление загружено', { version: info.version }); publishStatus(); });
autoUpdater.on('error', error => { updateState = { status: 'error', version: updateState.version, progress: 0, message: 'Ошибка обновления: ' + String(error.message || error) }; log('error', 'Updater error', String(error)); publishStatus(); });

function configureUpdateChecks() {
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (updateCheckTimeout) clearTimeout(updateCheckTimeout);
  updateCheckTimer = null;
  updateCheckTimeout = null;
  if (!app.isPackaged || !settings.autoCheckUpdates) return;

  // Даём окнам и IPC завершить запуск; затем проверяем обновления и повторяем раз в 6 часов.
  updateCheckTimeout = setTimeout(() => {
    updateCheckTimeout = null;
    autoUpdater.checkForUpdates().catch(error => log('warn', 'Автопроверка обновлений недоступна', String(error)));
  }, 12_000);
  updateCheckTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch(error => log('warn', 'Плановая проверка обновлений не удалась', String(error)));
  }, 6 * 60 * 60_000);
}

async function checkNetwork() {
  lastNetworkCheckAt = Date.now();
  try {
    const response = await fetch('https://pocketoption.com/', { signal: AbortSignal.timeout(8000), redirect: 'manual' });
    lastNetworkOk = response.status < 500;
  } catch (_) { lastNetworkOk = false; }
  return lastNetworkOk;
}
async function healthTick() {
  const online = await checkNetwork();
  if (!online) {
    reconnectAttempts++;
    log('warn', 'Проверка сети: Pocket Option недоступен', { reconnectAttempts });
  } else if (siteWindow && !siteWindow.isDestroyed() && !siteWindow.webContents.isLoading()) {
    const stale = lastSiteSignalAt > 0 && Date.now() - lastSiteSignalAt > 90_000;
    if (stale) reconnectAttempts++;
    else reconnectAttempts = 0;
  } else if (online) reconnectAttempts = 0;
  if (siteWindow && !siteWindow.isDestroyed() && reconnectAttempts >= Number(settings.reconnectAttemptsBeforeReload || 3)) await attemptRecovery();
  refreshTrayMenu(); publishStatus();
}
async function attemptRecovery() {
  if (recoveryInProgress || !siteWindow || siteWindow.isDestroyed()) return;
  recoveryInProgress = true;
  try {
    const now = Date.now(); reloadHistory = reloadHistory.filter(t => now - t < 10 * 60_000);
    if (reloadHistory.length >= Number(settings.maxReloadsPer10Minutes || 3)) {
      log('error', 'Лимит автоматических перезагрузок исчерпан'); return;
    }
    log('warn', 'Попытка восстановления Pocket Option: ожидание перед перезагрузкой');
    await new Promise(resolve => setTimeout(resolve, Number(settings.reconnectDelaySeconds || 30) * 1000));
    if (!lastNetworkOk || !siteWindow || siteWindow.isDestroyed()) return;
    reloadHistory.push(Date.now()); reconnectAttempts = 0;
    await siteWindow.webContents.reload();
    log('info', 'Страница перезагружена для восстановления');
  } catch (error) { log('error', 'Перезагрузка для восстановления не удалась', String(error)); }
  finally { recoveryInProgress = false; }
}
async function runFullCheck(source) {
  const checks = [
    { name: 'Процесс Electron', ok: app.isReady(), detail: 'Главный процесс отвечает' },
    { name: 'Папка данных', ok: fs.existsSync(userRoot()), detail: userRoot() },
    { name: 'Системный трей', ok: !!tray, detail: tray ? 'Создан' : 'Не создан' },
    { name: 'Сеть Pocket Option', ok: await checkNetwork(), detail: lastNetworkOk ? 'Сайт отвечает' : 'Нет ответа' }
  ];
  if (siteWindow && !siteWindow.isDestroyed()) {
    let responsive = false;
    try { responsive = await siteWindow.webContents.executeJavaScript('1 + 1', true) === 2; } catch (_) {}
    checks.push({ name: 'Окно сайта', ok: responsive, detail: responsive ? 'Renderer отвечает' : 'Renderer не отвечает' });
    checks.push({ name: 'Баланс и режим', ok: !!lastBalance && Date.now() - lastBalance.ts < 15000, detail: lastBalance ? lastBalance.accountType.toUpperCase() + ' / ' + Math.round((Date.now() - lastBalance.ts) / 1000) + ' сек. назад' : 'Нет подтверждённых данных адаптера' });
    const bridge = await siteWindow.webContents.executeJavaScript('window.__PT_PO_STATUS__ || null', true).catch(() => null);
    checks.push({ name: 'Адаптер Pocket Option', ok: !!bridge, detail: bridge ? 'Активен' : 'Не обнаружен' });
  } else checks.push({ name: 'Окно сайта', ok: true, detail: 'Не запускалось — это допустимо' });
  if (moduleManager) {
    const moduleChecks = await moduleManager.healthChecks();
    for (const item of moduleChecks) checks.push(item);
  }
  checks.push({ name: 'Торговое ядро', ok: true, state: 'not-connected', detail: 'Не подключено в этой сборке: приложение не содержит модуль автоторговли и не совершает сделки' });
  const result = { at: new Date().toISOString(), source, passed: checks.every(c => c.ok !== false), checks };
  log(result.passed ? 'info' : 'warn', 'Проверка устойчивости завершена', result);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:check-result', result);
  return result;
}

app.on('before-quit', () => {
  if (signalScheduler) signalScheduler.stop();
  if (marketDataSaveTimer) { clearInterval(marketDataSaveTimer); clearTimeout(marketDataSaveTimer); marketDataSaveTimer = null; }
  try { if (marketDataPersistence) marketDataPersistence.saveSync(); } catch (error) { log('error', 'Не удалось синхронно сохранить архив котировок', String(error)); }
  quitting = true; clearInterval(healthTimer); clearInterval(fullCheckTimer); clearInterval(updateCheckTimer); clearTimeout(updateCheckTimeout);
  if (moduleManager) moduleManager.stopAll().catch(error => log('error', 'Ошибка остановки модулей', String(error)));
  log('info', 'Приложение завершает работу');
});
app.on('window-all-closed', () => { /* системный трей удерживает приложение открытым */ });
app.on('activate', showMain);
app.on('second-instance', showMain);
process.on('uncaughtException', error => {
  try { log('error', 'Необработанная ошибка главного процесса', error?.stack || String(error)); }
  catch (loggingError) { console.error('Failed to record uncaught exception', loggingError, error); }
});
process.on('unhandledRejection', reason => {
  try { log('error', 'Необработанный отказ Promise', reason?.stack || String(reason)); }
  catch (loggingError) { console.error('Failed to record unhandled rejection', loggingError, reason); }
});
app.on('child-process-gone', (_event, details) => {
  try { log('error', 'Завершился дочерний процесс Electron', details); } catch (error) { console.error(error); }
});

const lock = app.requestSingleInstanceLock();
if (!lock) {
  console.error('[PO Background] Не удалось получить блокировку единственного экземпляра');
  app.quit();
} else app.whenReady().then(async () => {
  startupStage = 'set-app-id';
  app.setAppUserModelId('com.maestro777.pocketoptionbackground');
  log('info', 'Начало запуска', { version: app.getVersion(), packaged: app.isPackaged, electron: process.versions.electron, arch: process.arch, appPath: app.getAppPath() });
  startupStage = 'load-settings';
  loadSettings();
  const dataDirectory = userRoot();
  exampleStore = new ExampleStore(path.join(dataDirectory, 'examples.json'));
  decisionJournal = new DecisionJournal(path.join(dataDirectory, 'decision-journal.jsonl'));
  marketDataPersistence = new MarketDataPersistence(marketDataStore, path.join(dataDirectory, 'market-data.snapshot.json'));
  const restoredMarket = await marketDataPersistence.load();
  if (restoredMarket) log('info', 'История котировок восстановлена', restoredMarket);
  scanStateStore = new ScanStateStore(path.join(dataDirectory, 'scan-state.json'));
  tradeLedger = new TradeLedger(path.join(dataDirectory, 'trade-ledger.json'));
  await tradeLedger.load();
  tradingGate = new TradingGate();
  tradeExecution = new TradeExecutionAdapter({
    gate: tradingGate, marketData: marketDataStore, journal: decisionJournal, ledger: tradeLedger,
    getSettings: () => ({ ...settings, autoTradingEnabled: false }),
    getAccount: () => ({ mode: 'DEMO', accountType: lastBalance?.accountType, balance: lastBalance?.balance, url: siteWindow && !siteWindow.isDestroyed() ? siteWindow.webContents.getURL() : '' }),
    getSiteWindow: () => siteWindow,
    onUpdate: update => log(update.type === 'rejected' ? 'warn' : 'info', 'Состояние торгового контура', update)
  });
  tradeExecution.restore(tradeLedger.listOpen());
  if (tradeLedger.listOpen().length) tradingGate.restoreOpenTrades(tradeLedger.listOpen());
  signalScheduler = new SignalScheduler({
    marketData: marketDataStore, exampleStore, journal: decisionJournal, stateStore: scanStateStore,
    getConfig: () => ({ ...settings.schedulerConfig, matcher: settings.analysisConfig }),
    getOpenTradeCount: () => tradeLedger.listOpen().length,
    onDecision: item => { if (item.decision?.accepted) log('info', 'Планировщик обнаружил подтверждённый кандидат', { asset: item.asset, timeframe: item.timeframe, direction: item.decision.direction, similarity: item.decision.averageSimilarity, signalId: item.signalId }); },
    onError: error => log('error', 'Ошибка планировщика анализа', String(error?.stack || error))
  });
  await signalScheduler.restoreState();
  signalScheduler.restoreProcessedDecisions(await decisionJournal.readRecent(500));
  await exampleStore.list();
  startupStage = 'create-main-window';
  createMainWindow();
  startupStage = 'create-tray';
  createTray();
  startupStage = 'load-modules';
  moduleManager = new ModuleManager({ directory: path.join(__dirname, 'modules'), context: { app, log }, log });
  await moduleManager.loadAll();
  startupStage = 'create-mini-widget';
  if (settings.showMiniWidget) createMiniWindow().show();
  startupStage = 'start-analysis-scheduler';
  signalScheduler.start();
  marketDataSaveTimer = setInterval(() => marketDataPersistence.save().catch(error => log('error', 'Ошибка периодического сохранения котировок', String(error))), 15000);
  startupStage = 'start-monitoring-timers';
  healthTimer = setInterval(() => healthTick().catch(error => log('error', 'Health tick failed', error?.stack || String(error))), HEALTH_INTERVAL);
  fullCheckTimer = setInterval(() => runFullCheck('scheduled').catch(error => log('error', 'Full check failed', error?.stack || String(error))), Math.max(5, Number(settings.monitorIntervalMinutes) || 5) * 60_000);
  startupStage = 'startup-check';
  log('info', 'Приложение запущено; Pocket Option не открывается автоматически');
  runFullCheck('startup').catch(error => log('error', 'Startup check failed', error?.stack || String(error)));
  startupStage = 'configure-updates';
  configureUpdateChecks();
  startupStage = 'complete';
}).catch(error => {
  const details = { stage: startupStage, error: error?.stack || String(error) };
  try { log('error', 'Критическая ошибка запуска приложения', details); }
  catch (loggingError) { console.error('Failed to write startup error to application.log', loggingError, details); }
  app.quit();
});
