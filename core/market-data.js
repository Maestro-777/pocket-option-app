'use strict';

const { aggregateTicksToCandles } = require('./timeframes');

const MAX_ASSETS = 300;
const MAX_TICKS_PER_ASSET = 12_000;
const MAX_CANDLES_PER_ASSET_PERIOD = 2_000;
const MAX_ROWS_PER_EVENT = 5_000;
const SUPPORTED_EVENTS = new Set([
  'updateAssets', 'updateStream', 'quotes/stream', 'updateHistoryNewFast',
  'updateHistoryNew', 'loadHistoryPeriod', 'loadHistoryPeriodFast', 'history/list/v2'
]);

function normalizeAssetName(raw) {
  if (raw == null) return '';
  let value = String(raw).trim().toUpperCase();
  if (!value || value.length > 80) return '';
  const isOtc = /\bOTC\b|_OTC$/i.test(value);
  value = value.replace(/\bOTC\b/gi, '').replace(/_OTC$/i, '');
  value = value.replace(/^#/, '').replace(/[^A-Z0-9]/g, '');
  if (!value || value.length > 32) return '';
  return isOtc ? value + '_OTC' : value;
}

function normalizeTimestamp(value, fallback) {
  const raw = Number(value);
  if (value == null || value === '') return fallback || null;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const timestamp = raw > 1e12 ? raw : raw * 1000;
  if (!Number.isFinite(timestamp) || timestamp > Date.now() + 5 * 60_000) return null;
  return timestamp;
}

function normalizeTick(assetRaw, timestampRaw, priceRaw, receivedAt) {
  const asset = normalizeAssetName(assetRaw);
  const ts = normalizeTimestamp(timestampRaw, receivedAt);
  const price = Number(priceRaw);
  if (!asset || !ts || !Number.isFinite(price) || price <= 0) return null;
  return { asset, ts, price };
}

function detectOhlcLayout(rows) {
  let ochl = 0, ohlc = 0, checked = 0;
  for (const row of rows.slice(0, 40)) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const values = row.slice(1, 5).map(Number);
    if (values.some(value => !Number.isFinite(value) || value <= 0)) continue;
    checked++;
    const high = Math.max(...values), low = Math.min(...values);
    if (values[2] >= high && values[3] <= low) ochl++;
    if (values[1] >= high && values[2] <= low) ohlc++;
  }
  if (!checked) return null;
  if (ochl >= ohlc && ochl > 0) return { open: 1, close: 2, high: 3, low: 4 };
  if (ohlc > 0) return { open: 1, high: 2, low: 3, close: 4 };
  return null;
}

function normalizeHistoryRows(assetRaw, rows, periodRaw, receivedAt) {
  if (!Array.isArray(rows)) return { ticks: [], candles: [] };
  const periodSec = Math.floor(Number(periodRaw));
  const periodMs = Number.isFinite(periodSec) && periodSec >= 1 && periodSec <= 86_400 ? periodSec * 1000 : 0;
  const layout = periodMs ? detectOhlcLayout(rows) : null;
  const ticks = [], candles = [];
  for (const row of rows.slice(0, MAX_ROWS_PER_EVENT)) {
    if (!row) continue;
    let timestampRaw, priceRaw, ohlc = null;
    if (Array.isArray(row)) {
      timestampRaw = row[0];
      if (layout && row.length >= 5) {
        const open = Number(row[layout.open]), high = Number(row[layout.high]);
        const low = Number(row[layout.low]), close = Number(row[layout.close]);
        if ([open, high, low, close].every(value => Number.isFinite(value) && value > 0) &&
            high >= Math.max(open, close, low) && low <= Math.min(open, close, high)) {
          ohlc = { open, high, low, close };
          priceRaw = close;
        }
      }
      // A five-column provider row is a candle, not a tick. If its OHLC
      // layout cannot be validated, reject it rather than inventing a close
      // and later rebuilding a different candle from sparse ticks.
      if (priceRaw == null && row.length >= 5) continue;
      if (priceRaw == null) priceRaw = row[1];
    } else if (typeof row === 'object') {
      timestampRaw = row.time ?? row.t ?? row.ts;
      priceRaw = row.close ?? row.c ?? row.price ?? row.p;
      const open = Number(row.open ?? row.o), high = Number(row.high ?? row.h);
      const low = Number(row.low ?? row.l), close = Number(row.close ?? row.c ?? priceRaw);
      if (periodMs && [open, high, low, close].every(value => Number.isFinite(value) && value > 0)) {
        if (high >= Math.max(open, close, low) && low <= Math.min(open, close, high)) ohlc = { open, high, low, close };
      }
    } else continue;
    const tick = normalizeTick(assetRaw, timestampRaw, priceRaw, receivedAt);
    if (!tick) continue;
    ticks.push(tick);
    if (ohlc && periodMs) {
      const startAt = Math.floor(tick.ts / periodMs) * periodMs;
      candles.push({ asset: tick.asset, periodSec, startAt, endAt: startAt + periodMs, ...ohlc, complete: startAt + periodMs <= receivedAt });
    }
  }
  return { ticks, candles };
}

function normalizeCatalog(payload) {
  const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.assets) ? payload.assets : [payload]);
  const assets = [];
  for (const row of rows.slice(0, MAX_ASSETS)) {
    if (!row) continue;
    let symbol, label;
    if (Array.isArray(row)) { symbol = row.length >= 2 ? row[1] : row[0]; label = row[2] || symbol; }
    else if (typeof row === 'object') { symbol = row.symbol || row.asset || row.code || row.s; label = row.name || row.title || row.label || row.n || symbol; }
    const asset = normalizeAssetName(symbol);
    if (!asset) continue;
    assets.push({ asset, label: String(label || asset).slice(0, 80), raw: String(symbol).slice(0, 80), isOtc: /_OTC$/.test(asset) });
  }
  return assets;
}

function parseMarketEvent(eventName, payload, receivedAt = Date.now()) {
  if (!SUPPORTED_EVENTS.has(eventName)) return null;
  if (eventName === 'updateAssets') {
    const assets = normalizeCatalog(payload);
    return assets.length ? { kind: 'catalog', assets, receivedAt } : null;
  }
  if (eventName === 'updateStream' || eventName === 'quotes/stream') {
    let rows = Array.isArray(payload) ? payload : [payload];
    if (rows.length >= 2 && typeof rows[0] === 'string') rows = [rows];
    const ticks = [];
    for (const row of rows.slice(0, MAX_ROWS_PER_EVENT)) {
      if (Array.isArray(row) && typeof row[0] === 'string' && row.length >= 3) {
        const tick = normalizeTick(row[0], row[1], row[2], receivedAt);
        if (tick) ticks.push(tick);
      } else if (row && typeof row === 'object' && row.asset && Array.isArray(row.prices)) {
        for (const item of row.prices.slice(0, MAX_ROWS_PER_EVENT - ticks.length)) {
          const tick = normalizeTick(row.asset, item.time ?? item.ts, item.price ?? item.p, receivedAt);
          if (tick) ticks.push(tick);
        }
      } else if (row && typeof row === 'object' && row.asset) {
        const tick = normalizeTick(row.asset, row.timestamp ?? row.time ?? row.ts, row.price ?? row.close, receivedAt);
        if (tick) ticks.push(tick);
      }
    }
    return ticks.length ? { kind: 'ticks', ticks, receivedAt } : null;
  }
  const data = Array.isArray(payload) && payload.length === 1 && payload[0] && typeof payload[0] === 'object' ? payload[0] : payload;
  const asset = data?.asset || data?.a;
  let rows = data?.history || data?.data || data?.candles;
  const period = data?.period;
  if (!asset && Array.isArray(payload) && payload.length && Array.isArray(payload[0])) return null;
  if (!Array.isArray(rows) && Array.isArray(data)) rows = data;
  if (!asset || !Array.isArray(rows)) return null;
  const normalized = normalizeHistoryRows(asset, rows, period, receivedAt);
  return normalized.ticks.length ? { kind: 'history', ...normalized, receivedAt } : null;
}

class MarketDataStore {
  constructor(options = {}) {
    this.maxAssets = options.maxAssets || MAX_ASSETS;
    this.maxTicksPerAsset = options.maxTicksPerAsset || MAX_TICKS_PER_ASSET;
    this.maxCandlesPerAssetPeriod = options.maxCandlesPerAssetPeriod || MAX_CANDLES_PER_ASSET_PERIOD;
    this.assets = new Map();
    this.catalog = new Map();
    this.eventCount = 0;
    this.acceptedTickCount = 0;
    this.lastEventAt = null;
    this.lastTickAt = null;
    this.lastEventName = null;
  }
  _assetState(asset) {
    if (!this.assets.has(asset)) {
      if (this.assets.size >= this.maxAssets) {
        const oldest = [...this.assets.entries()].sort((a, b) => (a[1].lastTickAt || 0) - (b[1].lastTickAt || 0))[0];
        if (oldest) this.assets.delete(oldest[0]);
      }
      this.assets.set(asset, { ticks: [], seen: new Set(), candles: new Map(), lastTickAt: null, lastPrice: null });
    }
    return this.assets.get(asset);
  }
  ingest(eventName, payload, receivedAt = Date.now()) {
    const event = parseMarketEvent(eventName, payload, receivedAt);
    if (!event) return { accepted: false, reason: 'unsupported-or-invalid-payload' };
    this.eventCount++;
    this.lastEventAt = receivedAt;
    this.lastEventName = eventName;
    if (event.kind === 'catalog') {
      for (const item of event.assets) this.catalog.set(item.asset, item);
      while (this.catalog.size > this.maxAssets) this.catalog.delete(this.catalog.keys().next().value);
    }
    if (event.kind === 'ticks' || event.kind === 'history') {
      for (const tick of event.ticks) this._ingestTick(tick);
      for (const candle of event.candles || []) this._ingestCandle(candle);
    }
    return { accepted: true, kind: event.kind, count: event.assets?.length || event.ticks?.length || 0 };
  }
  _ingestTick(tick) {
    const state = this._assetState(tick.asset);
    const key = tick.ts + ':' + tick.price;
    if (state.seen.has(key)) return;
    state.seen.add(key);
    const last = state.ticks[state.ticks.length - 1];
    if (!last || tick.ts >= last.ts) {
      state.ticks.push(tick);
    } else {
      let low = 0, high = state.ticks.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (state.ticks[mid].ts <= tick.ts) low = mid + 1;
        else high = mid;
      }
      state.ticks.splice(low, 0, tick);
    }
    if (state.ticks.length > this.maxTicksPerAsset) {
      const removed = state.ticks.splice(0, state.ticks.length - this.maxTicksPerAsset);
      for (const item of removed) state.seen.delete(item.ts + ':' + item.price);
    }
    if (state.lastTickAt == null || tick.ts >= state.lastTickAt) { state.lastTickAt = tick.ts; state.lastPrice = tick.price; }
    this.acceptedTickCount++;
    this.lastTickAt = Math.max(this.lastTickAt || 0, tick.ts);
  }
  _ingestCandle(candle) {
    const state = this._assetState(candle.asset);
    const key = String(candle.periodSec);
    if (!state.candles.has(key)) state.candles.set(key, new Map());
    const store = state.candles.get(key);
    store.set(candle.startAt, candle);
    while (store.size > this.maxCandlesPerAssetPeriod) {
      const oldest = Math.min(...store.keys());
      store.delete(oldest);
    }
  }
  getTicks(asset, limit = 500) {
    const state = this.assets.get(normalizeAssetName(asset));
    if (!state) return [];
    return state.ticks.slice(-Math.max(1, Math.min(5000, Number(limit) || 500))).map(tick => ({ ...tick }));
  }
  getAggregatedCandles(asset, timeframe, options = {}) {
    const state = this.assets.get(normalizeAssetName(asset));
    if (!state) return [];
    return aggregateTicksToCandles(state.ticks, timeframe, options);
  }
  getCandles(asset, periodSec, limit = 500) {
    const state = this.assets.get(normalizeAssetName(asset));
    const store = state?.candles.get(String(Math.floor(Number(periodSec))));
    if (!store) return [];
    return [...store.values()].sort((a, b) => a.startAt - b.startAt)
      .slice(-Math.max(1, Math.min(2000, Number(limit) || 500))).map(candle => ({ ...candle }));
  }
  getSnapshot(now = Date.now()) {
    const assets = [...this.assets.entries()].map(([asset, state]) => ({
      asset, tickCount: state.ticks.length, lastPrice: state.lastPrice, lastTickAt: state.lastTickAt,
      ageMs: state.lastTickAt == null ? null : Math.max(0, now - state.lastTickAt), isOtc: /_OTC$/.test(asset)
    })).sort((a, b) => (b.lastTickAt || 0) - (a.lastTickAt || 0)).slice(0, 50);
    return {
      eventCount: this.eventCount, acceptedTickCount: this.acceptedTickCount,
      assetCount: this.assets.size, catalogAssetCount: this.catalog.size,
      lastEventAt: this.lastEventAt, lastEventName: this.lastEventName, lastTickAt: this.lastTickAt, assets
    };
  }
}

function normalizeAsset(raw) {
  const value = normalizeAssetName(raw);
  return value || null;
}

// Compatibility facade for the analytics modules. It delegates parsing and
// bounded in-memory buffering to the application's existing MarketDataStore.
class MarketDataService {
  constructor(options = {}) {
    this.store = new MarketDataStore(options);
    this.connected = false;
  }
  ingestAssets(payload) {
    const result = this.store.ingest('updateAssets', payload);
    return result.accepted ? result.count : 0;
  }
  ingestTicks(rows) {
    if (!Array.isArray(rows)) throw new TypeError('ticks должен быть массивом');
    const normalized = rows.map(row => {
      if (Array.isArray(row)) return [row[0], row[1], row[2]];
      return [row && (row.asset || row.symbol), row && (row.ts || row.time), row && row.price];
    }).filter(row => row[0] != null);
    const result = this.store.ingest('updateStream', normalized);
    return result.accepted ? result.count : 0;
  }
  ingestEvent(eventName, payload, receivedAt = Date.now()) {
    if (eventName === 'updateAssets') return this.ingestAssets(payload);
    const event = parseMarketEvent(eventName, payload, receivedAt);
    if (!event) return { accepted: false, reason: 'unsupported-or-invalid-payload' };
    if (event.kind === 'history') {
      // Historical OHLC is kept in the candle store, not counted as live ticks.
      this.store.eventCount++;
      this.store.lastEventAt = receivedAt;
      this.store.lastEventName = eventName;
      for (const candle of event.candles || []) this.store._ingestCandle(candle);
      return { accepted: true, kind: 'history', count: (event.candles || []).length };
    }
    return this.store.ingest(eventName, payload, receivedAt);
  }
  ingest(tick) {
    const count = this.ingestTicks([[tick.asset, tick.ts, tick.price]]);
    return { accepted: count > 0, count };
  }
  listAssets(options = {}) {
    const rows = new Map();
    for (const item of this.store.catalog.values()) {
      rows.set(item.asset, { symbol: item.asset, rawSymbol: item.raw, label: item.label, otc: item.isOtc });
    }
    for (const item of this.store.getSnapshot().assets) {
      if (!rows.has(item.asset)) rows.set(item.asset, { symbol: item.asset, rawSymbol: item.asset, label: item.asset, otc: item.isOtc });
    }
    return Array.from(rows.values()).filter(item => options.otcOnly !== true || item.otc)
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
  }
  getCandles(asset, timeframe, options = {}) {
    const limit = Math.max(1, Math.min(2000, Number(options.limit) || 500));
    const asOf = options.asOf == null ? Date.now() : Number(options.asOf);
    const duration = require('./timeframes').getTimeframeDuration(timeframe);
    const historical = this.store.getCandles(asset, duration / 1000, 2000)
      .filter(candle => candle.endAt <= asOf && (options.includeIncomplete === true || candle.complete))
      .map(candle => ({ ...candle, timeframe: String(timeframe).toUpperCase() }));
    // The workbench is a source-of-truth chart: show only provider OHLC
    // candles. Tick aggregation is useful for diagnostics, but it is not
    // interchangeable with Pocket Option's candle history.
    return historical.sort((a, b) => a.startAt - b.startAt).slice(-limit);
  }
  getLatestDataTime(asset, timeframe) {
    const rows = this.getCandles(asset, timeframe, { limit: 2000 });
    return rows.length ? rows[rows.length - 1].endAt : null;
  }
  getStatus() {
    const snapshot = this.store.getSnapshot();
    let historyCandleCount = 0;
    for (const state of this.store.assets.values()) for (const candles of state.candles.values()) historyCandleCount += candles.size;
    return { connected: this.connected, tickCount: snapshot.acceptedTickCount, assetCount: snapshot.assetCount,
      historyCandleCount, catalogAssetCount: snapshot.catalogAssetCount, lastTickAt: snapshot.lastTickAt };
  }
  exportSnapshot() {
    const ticks = [], history = [];
    for (const [asset, state] of this.store.assets) {
      for (const tick of state.ticks) ticks.push({ asset, ts: tick.ts, price: tick.price });
      for (const candles of state.candles.values()) for (const candle of candles.values()) history.push({ ...candle });
    }
    return { schemaVersion: 1, savedAt: new Date().toISOString(), connected: false,
      catalog: Array.from(this.store.catalog.values()).map(item => ({ ...item })), ticks, history };
  }
  restoreSnapshot(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.ticks) ||
        !Array.isArray(snapshot.history) || !Array.isArray(snapshot.catalog)) {
      throw new TypeError('Некорректный снимок рыночных данных');
    }
    const next = new MarketDataStore();
    for (const item of snapshot.catalog) {
      if (!item || typeof item.asset !== 'string') throw new TypeError('Некорректный каталог в снимке');
      next.catalog.set(item.asset, { ...item });
    }
    for (const tick of snapshot.ticks) {
      const normalized = normalizeTick(tick.asset, tick.ts, tick.price, Date.now());
      if (!normalized) throw new TypeError('Некорректный тик в снимке');
      next._ingestTick(normalized);
    }
    for (const candle of snapshot.history) {
      if (!candle || !Number.isFinite(Number(candle.startAt)) || !Number.isFinite(Number(candle.endAt))) {
        throw new TypeError('Некорректная свеча в снимке');
      }
      next._ingestCandle({ ...candle });
    }
    this.store = next;
    this.connected = false;
    return this.getStatus();
  }
}

module.exports = { SUPPORTED_EVENTS, normalizeAssetName, normalizeAsset, normalizeTimestamp, normalizeTick, normalizeHistoryRows, parseMarketEvent, MarketDataStore, MarketDataService };
