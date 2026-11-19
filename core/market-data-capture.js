'use strict';

const { PocketOptionProtocol } = require('./pocketoption-protocol');
const { AssetCatalog } = require('./asset-catalog');
const { normalizeHistoryCandles } = require('./pocketoption-protocol');

class MarketDataCapture {
  constructor(options = {}) {
    const debuggerMethods = ['on', 'removeListener', 'isAttached', 'attach', 'sendCommand', 'detach'];
    if (!options.debuggerApi || debuggerMethods.some(name => typeof options.debuggerApi[name] !== 'function')) throw new TypeError('debuggerApi должен предоставлять полный интерфейс Chromium debugger');
    if (!options.marketDataHub || typeof options.marketDataHub.ingest !== 'function') throw new TypeError('marketDataHub должен предоставлять ingest()');
    this.debuggerApi = options.debuggerApi;
    this.marketDataHub = options.marketDataHub;
    this.assetCatalog = options.assetCatalog || new AssetCatalog();
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
    this.onTick = typeof options.onTick === 'function' ? options.onTick : () => {};
    this.onTradeResult = typeof options.onTradeResult === 'function' ? options.onTradeResult : () => {};
    this.maxSockets = options.maxSockets == null ? 32 : Number(options.maxSockets);
    if (!Number.isInteger(this.maxSockets) || this.maxSockets < 1 || this.maxSockets > 1024) throw new RangeError('maxSockets должен быть целым числом от 1 до 1024');
    this.status = 'idle';
    this.attached = false;
    this.lastFrameAt = null;
    this.lastTickAt = null;
    this.lastTickReceivedAt = null;
    this.lastError = null;
    this.rejectedTicks = 0;
    this.rejectedUnknownAssets = 0;
    this.rejectedNonOtcAssets = 0;
    this.rejectedAmbiguousAssets = 0;
    this.rejectedHistoryRows = 0;
    this.receivedTradeResults = 0;
    this.rejectedTradeResults = 0;
    this._ownsDebugger = false;
    this._closing = false;
    this._protocols = new Map();
    this._onMessage = this._handleMessage.bind(this);
    this._onDetach = this._handleDetach.bind(this);
  }

  async attach() {
    if (this.status === 'listening') return true;
    if (this.debuggerApi.isAttached()) {
      this.status = 'unavailable';
      this.lastError = 'К этому окну уже подключён отладчик Chromium';
      this._notify();
      return false;
    }
    this.debuggerApi.on('message', this._onMessage);
    this.debuggerApi.on('detach', this._onDetach);
    try {
      this.debuggerApi.attach('1.3');
      this._ownsDebugger = true;
      this.attached = true;
      this.status = 'attached';
      this._notify();
      await this.debuggerApi.sendCommand('Network.enable');
      if (!this.attached || this.status !== 'attached') return false;
      this.status = 'listening';
      this.log('info', 'Захват WebSocket Pocket Option включён через Chromium DevTools Protocol');
      this._notify();
      return true;
    } catch (error) {
      this.status = 'error';
      this.lastError = String(error?.message || error);
      this.log('error', 'Не удалось включить захват WebSocket Pocket Option', this.lastError);
      this.close();
      this.status = 'error';
      this.lastError = String(error?.message || error);
      this._notify();
      return false;
    }
  }

  _handleMessage(_event, method, params) {
    if (method === 'Network.webSocketCreated') {
      const id = String(params?.requestId || '');
      if (id && this._protocols.size < this.maxSockets && !this._protocols.has(id)) this._protocols.set(id, new PocketOptionProtocol());
      return;
    }
    if (method === 'Network.webSocketClosed') {
      this._protocols.delete(String(params?.requestId || ''));
      this._notify();
      return;
    }
    if (method !== 'Network.webSocketFrameReceived') return;
    const id = String(params?.requestId || ''), frame = params?.response;
    if (!id || !frame || typeof frame.payloadData !== 'string') return;
    let decoder = this._protocols.get(id);
    if (!decoder) {
      if (this._protocols.size >= this.maxSockets) return;
      decoder = new PocketOptionProtocol();
      this._protocols.set(id, decoder);
    }
    this.lastFrameAt = Date.now();
    const decoded = decoder.decodeFrame(frame.payloadData, frame.opcode === 2 ? 'base64' : 'utf8');
    if (decoded?.tradeResults?.length) {
      for (const tradeResult of decoded.tradeResults) {
        try {
          this.onTradeResult(tradeResult);
          this.receivedTradeResults++;
        } catch (error) {
          this.rejectedTradeResults++;
          this.log('warn', 'Не удалось передать результат сделки в локальный журнал', String(error?.message || error));
        }
      }
      this._notify();
    }
    if (decoded?.eventName === 'updateAssets') {
      const catalogResult = this.assetCatalog.ingest(decoded.payload);
      if (catalogResult.accepted > 0) this.log('info', 'Получен каталог активов Pocket Option', catalogResult);
      this._notify();
      return;
    }
    const history = normalizeHistoryCandles(decoded?.eventName, decoded?.payload);
    if (history?.asset) {
      this.rejectedHistoryRows += history.skippedRows || 0;
      if (history.candles.length) {
        const asset = this.assetCatalog.resolve(history.asset);
        if (asset?.source === 'explicit-otc-suffix') this.assetCatalog.rememberExplicitOtc(history.asset);
        if (asset?.isOTC && asset.asset) {
          this.marketDataHub.ingestHistoricalCandles(history.candles.map(candle => ({ ...candle, asset: asset.asset })));
        } else {
          this.rejectedHistoryRows += history.candles.length;
        }
      }
      this._notify();
      return;
    }
    if (!decoded?.ticks?.length) return;
    for (const tick of decoded.ticks) {
      const asset = this.assetCatalog.resolve(tick.asset);
      if (!asset) { this.rejectedTicks++; this.rejectedUnknownAssets++; continue; }
      if (asset.ambiguous) { this.rejectedTicks++; this.rejectedAmbiguousAssets++; continue; }
      if (!asset.isOTC || !asset.asset) { this.rejectedTicks++; this.rejectedNonOtcAssets++; continue; }
      if (asset.source === 'explicit-otc-suffix') this.assetCatalog.rememberExplicitOtc(tick.asset);
      const result = this.marketDataHub.ingest({ ...tick, asset: asset.asset });
      if (result.accepted) {
        this.lastTickAt = tick.ts;
        this.lastTickReceivedAt = Date.now();
        try { this.onTick(asset.asset, tick); }
        catch (error) { this.log('warn', 'Не удалось поставить актив в очередь анализа', String(error?.message || error)); }
      } else this.rejectedTicks++;
    }
    this._notify();
  }

  _handleDetach(_event, reason) {
    this._protocols.clear();
    this.attached = false;
    this._ownsDebugger = false;
    this.status = this._closing ? 'stopped' : 'detached';
    this.lastError = this._closing ? null : String(reason || 'Debugger detached');
    if (!this._closing) this.log('warn', 'Захват WebSocket Pocket Option остановлен', { reason: this.lastError });
    this._notify();
  }

  getStatus() {
    const protocol = { textFrames: 0, binaryFrames: 0, malformedFrames: 0, events: 0, ticks: 0 };
    for (const decoder of this._protocols.values()) {
      for (const key of Object.keys(protocol)) protocol[key] += decoder.stats[key];
    }
    return {
      status: this.status, attached: this.attached, activeSockets: this._protocols.size,
      lastFrameAt: this.lastFrameAt, lastTickAt: this.lastTickAt, lastTickReceivedAt: this.lastTickReceivedAt,
      lastError: this.lastError, rejectedTicks: this.rejectedTicks,
      rejectedUnknownAssets: this.rejectedUnknownAssets,
      rejectedNonOtcAssets: this.rejectedNonOtcAssets,
      rejectedAmbiguousAssets: this.rejectedAmbiguousAssets,
      rejectedHistoryRows: this.rejectedHistoryRows,
      receivedTradeResults: this.receivedTradeResults, rejectedTradeResults: this.rejectedTradeResults,
      catalog: { total: this.assetCatalog.size, otc: this.assetCatalog.listOTC().length, revision: this.assetCatalog.revision, ...this.assetCatalog.stats },
      protocol
    };
  }

  close() {
    this._closing = true;
    this.debuggerApi.removeListener('message', this._onMessage);
    this.debuggerApi.removeListener('detach', this._onDetach);
    this._protocols.clear();
    try {
      if (this._ownsDebugger && this.debuggerApi.isAttached()) this.debuggerApi.detach();
    } catch (error) {
      this.log('warn', 'Не удалось штатно отключить Chromium debugger', String(error));
    }
    this._ownsDebugger = false;
    this.attached = false;
    this.status = 'stopped';
    this._closing = false;
    this._notify();
  }

  _notify() {
    try { this.onStatus(this.getStatus()); }
    catch (error) { this.log('warn', 'Ошибка обновления статуса захвата рынка', String(error)); }
  }
}

module.exports = MarketDataCapture;
