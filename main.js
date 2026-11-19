'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, Tray, Menu, ipcMain, session, nativeImage, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const archiver = require('archiver');
const ModuleManager = require('./modules/manager');
const { MarketDataService, normalizeAsset } = require('./core/market-data');
const { ExampleStore } = require('./core/example-store');
const { DecisionJournal } = require('./core/decision-journal');
const { MarketDataStore } = require('./core/market-data-store');
const { SignalScheduler, normalizeSchedulerConfig } = require('./core/signal-scheduler');
const { analyzeSituation } = require('./core/matcher');
const { TradingGate } = require('./core/trading-gate');
const { TradeLedger } = require('./core/trade-ledger');
const { TradeExecutionAdapter } = require('./core/trade-execution');

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
let lastNetworkOk = null;
let lastNetworkCheckAt = null;
let reconnectAttempts = 0;
let reloadHistory = [];
let selectedAccount = 'DEMO';
let updateState = { status: 'idle', version: null, progress: 0, message: 'Проверка не выполнялась' };
let moduleManager = null;
const marketDataService = new MarketDataService();
let marketDataPublishTimer = null;
let marketDataSaveTimer = null;
let shutdownInProgress = false;
let allowQuit = false;
let signalScheduler = null;
let tradeExecutionAdapter = null;
let tradeLedgerHealthy = true;
const tradingGate = new TradingGate({ paused: true });
let settings = {
  showMiniWidget: false,
  monitorIntervalMinutes: 5,
  reconnectAttemptsBeforeReload: 3,
  reconnectDelaySeconds: 30,
  maxReloadsPer10Minutes: 3,
  autoCheckUpdates: true,
  autoTradingEnabled: false,
  baseBet: 1,
  defaultExpirySeconds: 15
};

const userRoot = () => app.getPath('userData');
const logsDir = () => path.join(userRoot(), 'logs');
const settingsFile = () => path.join(userRoot(), 'settings.json');
const logFile = () => path.join(logsDir(), 'application.log');
const exampleStore = new ExampleStore(path.join(userRoot(), 'data', 'examples.json'));
const decisionJournal = new DecisionJournal(path.join(logsDir(), 'decisions.jsonl'));
const marketDataStore = new MarketDataStore(marketDataService, path.join(userRoot(), 'data', 'market-data.json'));
const tradeLedger = new TradeLedger(path.join(userRoot(), 'data', 'trades.json'));

function log(level, message, data) {
  const row = { at: new Date().toISOString(), level, message: String(message), ...(data ? { data } : {}) };
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.appendFileSync(logFile(), JSON.stringify(row) + os.EOL, 'utf8');
  } catch (error) { console.error('Log write failed', error); }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:log', row);
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.webContents.send('app:status', getPublicStatus());
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
  mainWindow = new BrowserWindow({
    width: 1180, height: 820, minWidth: 980, minHeight: 680,
    show: false, title: APP_NAME, backgroundColor: '#0b1020', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.on('close', event => {
    if (!quitting) { event.preventDefault(); mainWindow.hide(); log('info', 'Главное окно скрыто в системный трей'); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
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
async function injectMarketDataBridge(win) {
  const debuggerApi = win.webContents.debugger;
  try {
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
    const source = fs.readFileSync(path.join(__dirname, 'market-data-bridge.js'), 'utf8');
    await debuggerApi.sendCommand('Page.enable');
    await debuggerApi.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source });
    log('info', 'Перехват рыночных данных установлен до запуска скриптов сайта');
    return true;
  } catch (error) {
    log('error', 'Не удалось установить перехват рыночных данных', String(error));
    return false;
  }
}
function injectSiteBridge(win) {
  try {
    const source = fs.readFileSync(path.join(__dirname, 'site-bridge.js'), 'utf8');
    win.webContents.executeJavaScript(source, true).catch(error => log('warn', 'Не удалось внедрить адаптер Pocket Option', String(error)));
  } catch (error) { log('error', 'Файл адаптера не найден', String(error)); }
}
async function launchSite() {
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
  await injectMarketDataBridge(siteWindow);
  if (!siteWindow || siteWindow.isDestroyed()) return;
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
    account: {
      type: lastBalance?.accountType || selectedAccount.toLowerCase(),
      balance: lastBalance?.balance ?? null, currency: lastBalance?.currency || '',
      updatedAt: lastBalance?.ts || null, stale: age == null || age > 15000
    },
    widgetVisible: !!(miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible()),
    reconnectAttempts, update: updateState, marketData: marketDataService.getStatus(), signalScheduler: signalScheduler ? signalScheduler.getStatus() : null, trading: { enabled: settings.autoTradingEnabled === true, ledgerHealthy: tradeLedgerHealthy, gate: tradingGate.getState(), execution: tradeExecutionAdapter ? tradeExecutionAdapter.getState() : null }
  };
}
function publishStatus() {
  const status = getPublicStatus();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:status', status);
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.webContents.send('app:status', status);
  return status;
}

ipcMain.handle('app:get-status', () => getPublicStatus());
ipcMain.handle('app:launch-site', async () => { await launchSite(); return { ok: true }; });
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
      detail: 'На реальном счёте действия на сайте могут повлечь финансовые последствия. Автоматическое исполнение в приложении разрешено только для DEMO.'
    });
    if (answer.response !== 1) return { ok: false, cancelled: true };
  }
  if (mode === 'REAL' && settings.autoTradingEnabled === true) { settings.autoTradingEnabled = false; tradingGate.setPaused(true); saveSettings(); log('warn', 'Автоторговля выключена перед переходом на REAL'); }
  log('warn', 'Запрошено переключение счёта', { from: selectedAccount, to: mode });
  try {
    await siteWindow.loadURL(ACCOUNT_URLS[mode]);
    const confirmed = await waitForAccountMode(mode, 20000);
    if (!confirmed) {
      log('error', 'Pocket Option не подтвердил переключение счёта', { target: mode, url: siteWindow.webContents.getURL() });
      return { ok: false, reason: 'Сайт не подтвердил выбранный режим. Отображаемый счёт не изменён.' };
    }
    selectedAccount = mode;
    log('info', 'Режим счёта подтверждён сайтом', { mode });
    publishStatus(); return { ok: true, mode };
  } catch (error) { log('error', 'Ошибка переключения счёта', String(error)); return { ok: false, reason: String(error) }; }
});
async function waitForAccountMode(mode, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!siteWindow || siteWindow.isDestroyed()) return false;
    try {
      const result = await siteWindow.webContents.executeJavaScript('window.__PT_PO_STATUS__ || null', true);
      if (result && result.accountType === mode.toLowerCase() && result.balance != null) return true;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}
function isTrustedPocketOptionSender(event) {
  if (!siteWindow || event.sender !== siteWindow.webContents) return false;
  try { const host = new URL(siteWindow.webContents.getURL()).hostname; return host === 'pocketoption.com' || host.endsWith('.pocketoption.com'); }
  catch (_) { return false; }
}

function isTrustedControlSender(event) {
  return !!(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}
function publishMarketDataStatus() {
  if (marketDataPublishTimer || !mainWindow || mainWindow.isDestroyed()) return;
  marketDataPublishTimer = setTimeout(() => {
    marketDataPublishTimer = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:market-data', marketDataService.getStatus());
    publishStatus();
  }, 1000);
}
ipcMain.on('site:market-data', (event, payload) => {
  if (!isTrustedPocketOptionSender(event)) return;
  if (!payload || payload.version !== 1 || !['updateAssets', 'updateStream', 'quotes/stream', 'updateHistoryNewFast', 'updateHistoryNew', 'loadHistoryPeriod', 'loadHistoryPeriodFast', 'history/list/v2', 'successcloseOrder', 's_orders/close'].includes(payload.eventName) || !Array.isArray(payload.payload) || payload.payload.length > 5000) return;
  try {
    if (payload.eventName === 'successcloseOrder' || payload.eventName === 's_orders/close') {
      if (tradeExecutionAdapter) tradeExecutionAdapter.handleCloseEvent(payload.payload).catch(error => log('error', 'Ошибка обработки результата сделки', String(error)));
      return;
    }
    const result = marketDataService.ingestEvent(payload.eventName, payload.payload);
    if (result.accepted > 0) publishMarketDataStatus();
  } catch (error) { log('warn', 'Некорректное сообщение рыночных данных', String(error)); }
});
ipcMain.handle('app:market-data:get-status', event => {
  if (!isTrustedControlSender(event)) return { connected: false, error: 'untrusted_sender' };
  return marketDataService.getStatus();
});
ipcMain.handle('app:market-data:list-assets', (event, options = {}) => {
  if (!isTrustedControlSender(event)) return [];
  return marketDataService.listAssets({ otcOnly: options && options.otcOnly === true });
});
ipcMain.handle('app:market-data:get-candles', (event, request = {}) => {
  if (!isTrustedControlSender(event)) return { ok: false, reason: 'untrusted_sender' };
  try {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Некорректный запрос');
    const candles = marketDataService.getCandles(request.asset, request.timeframe, {
      limit: request.limit == null ? 500 : request.limit,
      includeIncomplete: request.includeIncomplete === true,
      asOf: request.asOf
    });
    return { ok: true, candles };
  } catch (error) { return { ok: false, reason: String(error.message || error) }; }
});

ipcMain.handle('app:examples:list', async (event, filters = {}) => {
  if (!isTrustedControlSender(event)) return { ok: false, reason: 'untrusted_sender' };
  try {
    const timeframe = filters.timeframe == null ? undefined : String(filters.timeframe).toUpperCase();
    const pair = filters.pair == null ? undefined : normalizeAsset(filters.pair);
    if (filters.pair != null && !pair) throw new TypeError('Некорректная валютная пара');
    return { ok: true, examples: await exampleStore.list({ timeframe, pair }) };
  } catch (error) { return { ok: false, reason: String(error.message || error) }; }
});
ipcMain.handle('app:examples:add', async (event, example) => {
  if (!isTrustedControlSender(event)) return { ok: false, reason: 'untrusted_sender' };
  try { return { ok: true, example: await exampleStore.add(example) }; }
  catch (error) { return { ok: false, reason: String(error.message || error) }; }
});
ipcMain.handle('app:examples:update', async (event, request = {}) => {
  if (!isTrustedControlSender(event)) return { ok: false, reason: 'untrusted_sender' };
  try {
    if (!request || typeof request.id !== 'string' || !request.patch || typeof request.patch !== 'object' || Array.isArray(request.patch)) throw new TypeError('Некорректный запрос изменения примера');
    return { ok: true, example: await exampleStore.update(request.id, request.patch) };
  } catch (error) { return { ok: false, reason: String(error.message || error) }; }
});
ipcMain.handle('app:examples:remove', async (event, id) => {
  if (!isTrustedControlSender(event)) return { ok: false, reason: 'untrusted_sender' };
  try { return { ok: true, removed: await exampleStore.remove(String(id || '')) }; }
  catch (error) { return { ok: false, reason: String(error.message || error) }; }
});
ipcMain.handle('app:matcher:analyze', async (event, request = {}) => {
  if (!isTrustedControlSender(event)) return { ok: false, reason: 'untrusted_sender' };
  try {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Некорректный запрос анализа');
    const asset = normalizeAsset(request.asset);
    const timeframe = String(request.timeframe || '').toUpperCase();
    if (!asset) throw new TypeError('Некорректная валютная пара');
    const entryAt = request.entryAt == null ? Date.now() : Number(request.entryAt);
    const lookback = request.lookback == null ? 30 : Number(request.lookback);
    if (!Number.isFinite(entryAt) || entryAt <= 0 || !Number.isInteger(lookback) || lookback < 2 || lookback > 10000) throw new RangeError('Некорректная точка входа или размер окна');
    const candles = marketDataService.getCandles(asset, timeframe, { asOf: entryAt, limit: lookback });
    if (candles.length < 2) return { ok: false, reason: 'insufficient_market_data', availableCandles: candles.length };
    const examples = await exampleStore.list({ timeframe });
    if (request.config != null && (!request.config || typeof request.config !== 'object' || Array.isArray(request.config))) throw new TypeError('config должен быть объектом');
    const decision = analyzeSituation({ candles, timeframe, entryAt, examples, config: request.config || {} });
    const snapshot = { ...decision.settingsSnapshot, asset, timeframe, entryAt, lookback, algorithmVersion: 1 };
    const journal = await decisionJournal.append('DECISION', { asset, ...decision }, snapshot);
    return { ok: true, decision, journalId: journal.id };
  } catch (error) { return { ok: false, reason: String(error.message || error) }; }
});
ipcMain.handle('app:analysis:get-config', event => {
  if (!isTrustedControlSender(event)) return { ok: false, reason: 'untrusted_sender' };
  try { return { ok: true, config: normalizeSchedulerConfig(settings.analysisConfig || {}) }; }
  catch (error) { return { ok: false, reason: String(error.message || error) }; }
});
ipcMain.handle('app:analysis:set-config', (event, next = {}) => {
  if (!isTrustedControlSender(event)) return { ok: false, reason: 'untrusted_sender' };
  try {
    const config = normalizeSchedulerConfig(next);
    settings.analysisConfig = {
      enabled: config.enabled, timeframes: config.timeframes.slice(), lookback: config.lookback,
      maxOpenTrades: config.maxOpenTrades, scanIntervalMs: config.scanIntervalMs,
      matcher: { ...config.matcher }
    };
    saveSettings();
    if (signalScheduler) { signalScheduler.stop(); signalScheduler.start(); }
    publishStatus();
    return { ok: true, config };
  } catch (error) { return { ok: false, reason: String(error.message || error) }; }
});
ipcMain.handle('app:analysis:scan-now', async event => {
  if (!isTrustedControlSender(event)) return { ok: false, reason: 'untrusted_sender' };
  try { return { ok: true, result: signalScheduler ? await signalScheduler.scan() : null }; }
  catch (error) { return { ok: false, reason: String(error.message || error) }; }
});
ipcMain.handle('app:analysis:get-recent', event => {
  if (!isTrustedControlSender(event)) return { ok: false, reason: 'untrusted_sender' };
  return { ok: true, decisions: signalScheduler ? signalScheduler.getRecentDecisions() : [] };
});
ipcMain.handle('app:trading:get-state', event => {
  if (!isTrustedControlSender(event)) return { ok: false, reason: 'untrusted_sender' };
  return { ok: true, enabled: settings.autoTradingEnabled === true, ledgerHealthy: tradeLedgerHealthy, config: { baseBet: settings.baseBet, defaultExpirySeconds: settings.defaultExpirySeconds }, gate: tradingGate.getState(), execution: tradeExecutionAdapter ? tradeExecutionAdapter.getState() : null, account: { selected: selectedAccount, detected: lastBalance && lastBalance.accountType, balance: lastBalance && lastBalance.balance, url: siteWindow && !siteWindow.isDestroyed() ? siteWindow.webContents.getURL() : '' }, stats: tradeLedger.getStats(), openTrades: tradeLedger.listOpen() };
});
ipcMain.handle('app:trading:set-enabled', (event, enabled) => {
  if (!isTrustedControlSender(event)) return { ok: false, reason: 'untrusted_sender' };
  if (enabled !== true && enabled !== false) return { ok: false, reason: 'invalid_enabled_value' };
  if (enabled) {
    if (!tradeLedgerHealthy) return { ok: false, reason: 'trade_ledger_unavailable' };
    const url = siteWindow && !siteWindow.isDestroyed() ? siteWindow.webContents.getURL() : '';
    if (selectedAccount !== 'DEMO' || !lastBalance || lastBalance.accountType !== 'demo' || !url.includes('/demo-quick-high-low/')) return { ok: false, reason: 'demo_account_not_verified' };
    if (tradeLedger.listOpen().length >= Number(settings.analysisConfig && settings.analysisConfig.maxOpenTrades || 1)) return { ok: false, reason: 'open_trade_limit_reached_or_unresolved_trades' };
    settings.autoTradingEnabled = true; tradingGate.setPaused(false);
  } else { settings.autoTradingEnabled = false; tradingGate.setPaused(true); }
  saveSettings(); publishStatus();
  return { ok: true, enabled: settings.autoTradingEnabled, gate: tradingGate.getState() };
});
ipcMain.handle('app:trading:set-paused', (event, paused) => {
  if (!isTrustedControlSender(event)) return { ok: false, reason: 'untrusted_sender' };
  if (typeof paused !== 'boolean') return { ok: false, reason: 'invalid_paused_value' };
  if (!paused) {
    const url = siteWindow && !siteWindow.isDestroyed() ? siteWindow.webContents.getURL() : '';
    if (settings.autoTradingEnabled !== true || selectedAccount !== 'DEMO' || !lastBalance || lastBalance.accountType !== 'demo' || !url.includes('/demo-quick-high-low/')) return { ok: false, reason: 'demo_auto_trading_not_armed' };
  }
  tradingGate.setPaused(paused); publishStatus();
  return { ok: true, gate: tradingGate.getState() };
});
ipcMain.handle('app:trading:set-config', (event, config = {}) => {
  if (!isTrustedControlSender(event)) return { ok: false, reason: 'untrusted_sender' };
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { ok: false, reason: 'invalid_config' };
  const baseBet = Number(config.baseBet), expiry = Number(config.defaultExpirySeconds);
  if (!Number.isFinite(baseBet) || baseBet <= 0 || baseBet > 100000 || !Number.isInteger(expiry) || expiry < 1 || expiry > 86400) return { ok: false, reason: 'invalid_trade_settings' };
  settings.baseBet = baseBet; settings.defaultExpirySeconds = expiry; saveSettings();
  return { ok: true, baseBet, defaultExpirySeconds: expiry };
});
ipcMain.handle('app:trading:resolve', async (event, request = {}) => {
  if (!isTrustedControlSender(event)) return { ok: false, reason: 'untrusted_sender' };
  if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.tradeId !== 'string') return { ok: false, reason: 'invalid_request' };
  const trade = tradeLedger.listOpen().find(x => x.tradeId === request.tradeId);
  if (!trade || trade.status !== 'UNKNOWN_AFTER_RESTART') return { ok: false, reason: 'trade_not_recoverable_or_not_unknown' };
  try { return await tradeExecutionAdapter.resolveUnknown(request.tradeId, request.action, request.profit); }
  catch (error) { return { ok: false, reason: String(error.message || error) }; }
});



ipcMain.on('site:balance', (event, payload) => {
  if (!isTrustedPocketOptionSender(event)) return;
  if (!payload || !['demo', 'real'].includes(payload.accountType) || !Number.isFinite(payload.balance) || payload.balance < 0) return;
  if (payload.ts && payload.ts < (lastBalance?.ts || 0)) return;
  lastBalance = { accountType: payload.accountType, balance: payload.balance, currency: String(payload.currency || ''), ts: Number(payload.ts) || Date.now() };
  lastSiteSignalAt = Date.now(); selectedAccount = payload.accountType.toUpperCase();
  if (payload.accountType !== 'demo' && settings.autoTradingEnabled === true) { settings.autoTradingEnabled = false; tradingGate.setPaused(true); saveSettings(); log('warn', 'Автоторговля автоматически отключена: обнаружен не-DEMO счёт'); }
  publishStatus();
});
ipcMain.on('site:log', (event, payload) => { if (!isTrustedPocketOptionSender(event)) return; log(payload?.level === 'error' ? 'error' : 'info', 'Pocket Option: ' + String(payload?.message || '')); });
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
  checks.push({ name: 'Анализ сигналов', ok: !!signalScheduler, state: signalScheduler ? 'active' : 'not-connected', detail: 'Непрерывный анализ OTC работает; автоматическое исполнение сделок ещё не подключено' });
  checks.push({ name: 'Непрерывный анализ OTC', ok: !!(signalScheduler && signalScheduler.getStatus().running), detail: signalScheduler ? JSON.stringify(signalScheduler.getStatus()) : 'Не запущен' });
  checks.push({ name: 'Рыночные данные', ok: true, state: marketDataService.getStatus().connected ? 'connected' : 'waiting', detail: JSON.stringify(marketDataService.getStatus()) });
  const demoTradeSafe = settings.autoTradingEnabled !== true || (selectedAccount === 'DEMO' && lastBalance && lastBalance.accountType === 'demo' && siteWindow && !siteWindow.isDestroyed() && siteWindow.webContents.getURL().includes('/demo-quick-high-low/') && tradeLedgerHealthy);
  checks.push({ name: 'DEMO execution guard', ok: demoTradeSafe, detail: settings.autoTradingEnabled ? 'Автоторговля вооружена только при подтверждённом DEMO и исправном журнале' : 'Автоторговля выключена' });
  const result = { at: new Date().toISOString(), source, passed: checks.every(c => c.ok !== false), checks };
  log(result.passed ? 'info' : 'warn', 'Проверка устойчивости завершена', result);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:check-result', result);
  return result;
}

app.on('before-quit', event => {
  if (allowQuit) return;
  event.preventDefault();
  if (shutdownInProgress) return;
  shutdownInProgress = true; quitting = true;
  clearInterval(healthTimer); clearInterval(fullCheckTimer); clearInterval(updateCheckTimer);
  if (signalScheduler) signalScheduler.stop();
  clearInterval(marketDataSaveTimer); clearTimeout(updateCheckTimeout); clearTimeout(marketDataPublishTimer);
  settings.autoTradingEnabled = false; tradingGate.setPaused(true); try { saveSettings(); } catch (error) { log('error', 'Не удалось сохранить безопасное состояние торговли', String(error)); }
  log('info', 'Приложение завершает работу; сохраняем рыночные данные');
  const tasks = [marketDataStore.save().catch(error => log('error', 'Не удалось сохранить рыночные данные', String(error)))];
  if (moduleManager) tasks.push(moduleManager.stopAll().catch(error => log('error', 'Ошибка остановки модулей', String(error))));
  Promise.allSettled(tasks).then(() => { allowQuit = true; app.quit(); });
});
app.on('window-all-closed', () => { /* системный трей удерживает приложение открытым */ });
app.on('activate', showMain);
app.on('second-instance', showMain);
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else app.whenReady().then(async () => {
  app.setAppUserModelId('com.maestro777.pocketoptionbackground');
  loadSettings();
  if (settings.autoTradingEnabled === true) { settings.autoTradingEnabled = false; saveSettings(); log('warn', 'Автоторговля отключена при запуске; требуется повторное включение в DEMO'); }
  try { const restored = await marketDataStore.load(); if (restored) log('info', 'Рыночные данные восстановлены из локального снимка', { ticks: restored.tickCount, historyCandles: restored.historyCandleCount }); }
  catch (error) { log('error', 'Снимок рыночных данных повреждён или несовместим; запускаем пустой буфер', String(error)); }
  try { await tradeLedger.load(); const openTrades = tradeLedger.listOpen(); if (openTrades.length) { tradingGate.restoreOpenTrades(openTrades); log('warn', 'Обнаружены незавершённые DEMO сделки; торговля остаётся на паузе', { count: openTrades.length }); } }
  catch (error) { tradeLedgerHealthy = false; tradingGate.setPaused(true); settings.autoTradingEnabled = false; log('error', 'Не удалось восстановить журнал сделок; автоторговля заблокирована', String(error)); }
  createMainWindow(); createTray();
  moduleManager = new ModuleManager({ directory: path.join(__dirname, 'modules'), context: { app, log }, log });
  await moduleManager.loadAll();
  tradeExecutionAdapter = new TradeExecutionAdapter({
    gate: tradingGate, marketData: marketDataService, journal: decisionJournal, ledger: tradeLedger,
    getSettings: () => settings,
    getAccount: () => ({ mode: selectedAccount, accountType: lastBalance && lastBalance.accountType, balance: lastBalance && lastBalance.balance, url: siteWindow && !siteWindow.isDestroyed() ? siteWindow.webContents.getURL() : '' }),
    getSiteWindow: () => siteWindow,
    onUpdate: item => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:trade-update', item); log('info', 'Обновление состояния сделки', item); }
  });
  tradeExecutionAdapter.restore(tradeLedger.listOpen());
  signalScheduler = new SignalScheduler({
    marketData: marketDataService, exampleStore, journal: decisionJournal,
    getConfig: () => settings.analysisConfig || {},
    onDecision: item => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:signal-decision', item);
      if (settings.autoTradingEnabled === true && item.decision && item.decision.accepted === true && item.withinConfiguredLimit === true && tradeExecutionAdapter) {
        tradeExecutionAdapter.execute(item).catch(error => log('error', 'Ошибка отправки DEMO-сделки', String(error)));
      }
    },
    onError: error => log('error', 'Ошибка непрерывного анализа OTC', String(error))
  });
  try { signalScheduler.start(); }
  catch (error) { log('error', 'Сохранённые параметры анализа некорректны; применяем безопасные настройки по умолчанию', String(error)); settings.analysisConfig = {}; signalScheduler.start(); }
  if (settings.showMiniWidget) createMiniWindow().show();
  healthTimer = setInterval(() => healthTick().catch(error => log('error', 'Health tick failed', String(error))), HEALTH_INTERVAL);
  fullCheckTimer = setInterval(() => runFullCheck('scheduled').catch(error => log('error', 'Full check failed', String(error))), Math.max(5, Number(settings.monitorIntervalMinutes) || 5) * 60_000);
  marketDataSaveTimer = setInterval(() => marketDataStore.save().catch(error => log('error', 'Периодическое сохранение рыночных данных не удалось', String(error))), 60_000);
  log('info', 'Приложение запущено; Pocket Option не открывается автоматически');
  runFullCheck('startup').catch(error => log('error', 'Startup check failed', String(error)));
  configureUpdateChecks();
}).catch(error => { console.error(error); app.quit(); });
