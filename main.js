'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, Tray, Menu, ipcMain, session, nativeImage, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const archiver = require('archiver');
const ModuleManager = require('./modules/manager');
const { MarketDataHub } = require('./core/market-data');
const { AssetCatalog } = require('./core/asset-catalog');
const { MarketDataStore } = require('./core/market-data-store');
const MarketDataCapture = require('./core/market-data-capture');

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
let labelerWindow = null;
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
let marketDataHub = null;
let marketDataCapture = null;
let marketDataStore = null;
let marketStatusPublishTimer = null;
let marketPersistenceTimer = null;
let marketPersistenceError = null;
let persistedCatalogRevision = -1;
let marketLastPruneAt = 0;
let settings = {
  showMiniWidget: false,
  monitorIntervalMinutes: 5,
  reconnectAttemptsBeforeReload: 3,
  reconnectDelaySeconds: 30,
  maxReloadsPer10Minutes: 3,
  autoCheckUpdates: true
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
function createLabelerWindow() {
  if (labelerWindow && !labelerWindow.isDestroyed()) {
    labelerWindow.show();
    labelerWindow.focus();
    return labelerWindow;
  }
  labelerWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1040, minHeight: 720,
    show: false, title: 'Разметка исторических OTC-ситуаций',
    backgroundColor: '#0b1020', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  labelerWindow.loadFile(path.join(__dirname, 'renderer', 'labeler.html')).catch(error => log('error', 'Не удалось открыть окно разметки', String(error)));
  labelerWindow.once('ready-to-show', () => labelerWindow && labelerWindow.show());
  labelerWindow.on('closed', () => { labelerWindow = null; });
  return labelerWindow;
}

function isTrustedDataWindowSender(event) {
  const sender = event?.sender;
  if (!sender) return false;
  const allowed = (mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents) ||
    (labelerWindow && !labelerWindow.isDestroyed() && sender === labelerWindow.webContents);
  if (!allowed) return false;
  try {
    const url = new URL(event.senderFrame?.url || sender.getURL());
    return url.protocol === 'file:';
  } catch (_) { return false; }
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
function scheduleMarketStatusPublish() {
  if (marketStatusPublishTimer) return;
  marketStatusPublishTimer = setTimeout(() => {
    marketStatusPublishTimer = null;
    publishStatus();
  }, 500);
}

function attachMarketDataCapture(win) {
  marketDataHub = new MarketDataHub();
  const assetCatalog = new AssetCatalog();
  if (marketDataStore) {
    try {
      const restoredCatalog = assetCatalog.restore(marketDataStore.listCatalog({ otcOnly: true }));
      const restored = marketDataHub.restoreCandles(marketDataStore.getRecentCandles(300));
      persistedCatalogRevision = assetCatalog.revision;
      log('info', 'Исторические рыночные данные восстановлены', { restoredCatalog, ...restored });
    } catch (error) {
      marketPersistenceError = String(error);
      log('error', 'Не удалось восстановить рыночные данные из SQLite', marketPersistenceError);
    }
  }
  marketDataCapture = new MarketDataCapture({
    debuggerApi: win.webContents.debugger,
    marketDataHub,
    assetCatalog,
    log,
    onStatus: scheduleMarketStatusPublish
  });
  marketDataCapture.attach().catch(error => log('error', 'Ошибка запуска захвата рыночных данных', String(error)));
}

function persistMarketDataSafely() {
  if (!marketDataStore || !marketDataHub) return;
  try {
    const pending = marketDataHub.getDirtyCompletedCandles(Date.now());
    if (pending.length) {
      marketDataStore.upsertCandles(pending.map(item => item.candle));
      marketDataHub.acknowledgePersisted(pending);
    }
    const catalog = marketDataCapture?.assetCatalog;
    if (catalog && catalog.revision !== persistedCatalogRevision) {
      marketDataStore.upsertCatalog(catalog.listAll());
      persistedCatalogRevision = catalog.revision;
    }
    const now = Date.now();
    if (now - marketLastPruneAt >= 60_000) {
      marketDataStore.pruneCandles(300);
      marketLastPruneAt = now;
    }
    if (marketPersistenceError) {
      marketPersistenceError = null;
      log('info', 'Сохранение рыночных данных восстановлено');
    }
  } catch (error) {
    const message = String(error?.message || error);
    if (message !== marketPersistenceError) log('error', 'Ошибка сохранения рыночных данных', message);
    marketPersistenceError = message;
  }
}

function getMarketDataStatus() {
  return {
    capture: marketDataCapture ? marketDataCapture.getStatus() : {
      status: 'stopped', attached: false, activeSockets: 0, lastFrameAt: null,
      lastTickAt: null, lastTickReceivedAt: null, lastError: null, rejectedTicks: 0,
      protocol: { textFrames: 0, binaryFrames: 0, malformedFrames: 0, events: 0, ticks: 0 }
    },
    health: marketDataHub ? marketDataHub.getHealth() : { ok: false, assets: 0, series: 0, candlesInMemory: 0, dirtyCandles: 0 },
    persistence: {
      available: !!marketDataStore,
      error: marketPersistenceError,
      database: marketDataStore ? marketDataStore.getStats() : null
    }
  };
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
  attachMarketDataCapture(siteWindow);
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
  siteWindow.on('closed', () => {
    if (marketDataCapture) marketDataCapture.close();
    persistMarketDataSafely();
    marketDataCapture = null;
    marketDataHub = null;
    persistedCatalogRevision = -1;
    siteWindow = null; refreshTrayMenu(); publishStatus();
  });
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
    account: {
      type: lastBalance?.accountType || selectedAccount.toLowerCase(),
      balance: lastBalance?.balance ?? null, currency: lastBalance?.currency || '',
      updatedAt: lastBalance?.ts || null, stale: age == null || age > 15000
    },
    widgetVisible: !!(miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible()),
    marketData: getMarketDataStatus(),
    reconnectAttempts, update: updateState
  };
}
function publishStatus() {
  const status = getPublicStatus();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:status', status);
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.webContents.send('app:status', status);
  return status;
}

ipcMain.handle('app:get-status', () => getPublicStatus());
ipcMain.handle('app:launch-site', () => { launchSite(); return { ok: true }; });
ipcMain.handle('app:labeler:open', event => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, reason: 'Недоверенный отправитель' };
  createLabelerWindow();
  return { ok: true };
});
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
      detail: 'На реальном счёте действия на сайте могут повлечь финансовые последствия. Приложение не совершает сделки автоматически.'
    });
    if (answer.response !== 1) return { ok: false, cancelled: true };
  }
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
ipcMain.on('site:balance', (event, payload) => {
  if (!isTrustedPocketOptionSender(event)) return;
  if (!payload || !['demo', 'real'].includes(payload.accountType) || !Number.isFinite(payload.balance) || payload.balance < 0) return;
  if (payload.ts && payload.ts < (lastBalance?.ts || 0)) return;
  lastBalance = { accountType: payload.accountType, balance: payload.balance, currency: String(payload.currency || ''), ts: Number(payload.ts) || Date.now() };
  lastSiteSignalAt = Date.now(); selectedAccount = payload.accountType.toUpperCase(); publishStatus();
});
ipcMain.on('site:log', (event, payload) => { if (!isTrustedPocketOptionSender(event)) return; log(payload?.level === 'error' ? 'error' : 'info', 'Pocket Option: ' + String(payload?.message || '')); });
ipcMain.handle('app:market:assets', event => {
  if (!isTrustedDataWindowSender(event)) return [];
  const liveAssets = marketDataCapture ? marketDataCapture.assetCatalog.listOTC() : [];
  if (liveAssets.length) return liveAssets;
  return marketDataStore ? marketDataStore.listCatalog({ otcOnly: true }) : [];
});
ipcMain.handle('app:market:candles', (event, asset, timeframe, options = {}) => {
  if (!isTrustedDataWindowSender(event)) throw new Error('Недоверенный отправитель');
  if (!marketDataStore) throw new Error('SQLite хранилище рыночных данных недоступно');
  const symbol = String(asset || '').trim().toUpperCase();
  if (!symbol.endsWith('_OTC')) throw new TypeError('Разметка разрешена только для OTC-активов');
  return marketDataStore.getCandles(symbol, timeframe, {
    limit: Math.min(300, Math.max(1, Number(options?.limit) || 300)),
    fromAt: options?.fromAt, toAt: options?.toAt
  });
});
ipcMain.handle('app:manual-examples:list', (event, filters = {}) => {
  if (!isTrustedDataWindowSender(event)) throw new Error('Недоверенный отправитель');
  if (!marketDataStore) throw new Error('SQLite хранилище рыночных данных недоступно');
  return marketDataStore.listManualExamples(filters);
});
ipcMain.handle('app:manual-examples:create', (event, example) => {
  if (!isTrustedDataWindowSender(event)) throw new Error('Недоверенный отправитель');
  if (!marketDataStore) throw new Error('SQLite хранилище рыночных данных недоступно');
  const saved = marketDataStore.createManualExample(example);
  log('info', 'Сохранён ручной исторический пример', { id: saved.id, asset: saved.asset, timeframe: saved.timeframe, direction: saved.direction });
  return saved;
});
ipcMain.handle('app:manual-examples:update', (event, id, changes) => {
  if (!isTrustedDataWindowSender(event)) throw new Error('Недоверенный отправитель');
  if (!marketDataStore) throw new Error('SQLite хранилище рыночных данных недоступно');
  return marketDataStore.updateManualExample(id, changes);
});
ipcMain.handle('app:manual-examples:delete', (event, id) => {
  if (!isTrustedDataWindowSender(event)) throw new Error('Недоверенный отправитель');
  if (!marketDataStore) throw new Error('SQLite хранилище рыночных данных недоступно');
  return { deleted: marketDataStore.deleteManualExample(id) };
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
    checks.push({ name: 'Хранилище рыночных данных', ok: !!marketDataStore && !marketPersistenceError, detail: marketDataStore ? (marketPersistenceError || 'SQLite доступна; свечей: ' + marketDataStore.getStats().candles) : 'SQLite недоступна' });
    const captureReady = marketDataCapture?.status === 'listening';
    checks.push({ name: 'Захват WebSocket рыночных данных', ok: captureReady, state: captureReady ? 'connected' : 'not-connected', detail: captureReady ? 'CDP слушает WebSocket; получено тиков: ' + (marketDataHub?.getHealth().acceptedTicks || 0) : 'Сбор не активен: ' + (marketDataCapture?.lastError || marketDataCapture?.status || 'stopped') });
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
  quitting = true; clearInterval(healthTimer); clearInterval(fullCheckTimer); clearInterval(updateCheckTimer); clearTimeout(updateCheckTimeout);
  if (marketStatusPublishTimer) clearTimeout(marketStatusPublishTimer);
  if (marketPersistenceTimer) clearInterval(marketPersistenceTimer);
  if (marketDataCapture) marketDataCapture.close();
  persistMarketDataSafely();
  if (marketDataStore) { try { marketDataStore.close(); } catch (error) { log('error', 'Не удалось закрыть SQLite хранилище', String(error)); } marketDataStore = null; }
  if (moduleManager) moduleManager.stopAll().catch(error => log('error', 'Ошибка остановки модулей', String(error)));
  log('info', 'Приложение завершает работу');
});
app.on('window-all-closed', () => { /* системный трей удерживает приложение открытым */ });
app.on('activate', showMain);
app.on('second-instance', showMain);
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else app.whenReady().then(async () => {
  app.setAppUserModelId('com.maestro777.pocketoptionbackground');
  try {
    marketDataStore = new MarketDataStore(path.join(userRoot(), 'market-data.sqlite'));
    marketDataStore.pruneCandles(300);
    marketLastPruneAt = Date.now();
    log('info', 'SQLite хранилище рыночных данных открыто', marketDataStore.getStats());
  } catch (error) {
    marketPersistenceError = String(error?.message || error);
    log('error', 'SQLite хранилище рыночных данных недоступно', marketPersistenceError);
  }
  loadSettings(); createMainWindow(); createTray();
  moduleManager = new ModuleManager({ directory: path.join(__dirname, 'modules'), context: { app, log }, log });
  await moduleManager.loadAll();
  if (settings.showMiniWidget) createMiniWindow().show();
  healthTimer = setInterval(() => healthTick().catch(error => log('error', 'Health tick failed', String(error))), HEALTH_INTERVAL);
  marketPersistenceTimer = setInterval(persistMarketDataSafely, 1000);
  fullCheckTimer = setInterval(() => runFullCheck('scheduled').catch(error => log('error', 'Full check failed', String(error))), Math.max(5, Number(settings.monitorIntervalMinutes) || 5) * 60_000);
  log('info', 'Приложение запущено; Pocket Option не открывается автоматически');
  runFullCheck('startup').catch(error => log('error', 'Startup check failed', String(error)));
  configureUpdateChecks();
}).catch(error => { console.error(error); app.quit(); });
