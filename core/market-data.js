'use strict';

const { TIMEFRAME_MS } = require('./timeframes');
const { CandleSeries, normalizeTick } = require('./candle-series');

const DEFAULT_TIMEFRAMES = Object.freeze(Object.keys(TIMEFRAME_MS));

class MarketDataHub {
  constructor(options = {}) {
    const configured = options.timeframes == null ? DEFAULT_TIMEFRAMES : options.timeframes;
    if (!Array.isArray(configured) || configured.length === 0) throw new TypeError('timeframes должен быть непустым массивом');
    const unique = [...new Set(configured.map(value => String(value).toUpperCase()))];
    for (const timeframe of unique) {
      if (!Object.prototype.hasOwnProperty.call(TIMEFRAME_MS, timeframe)) throw new TypeError('Неподдерживаемый таймфрейм: ' + timeframe);
    }
    this.timeframes = Object.freeze(unique);
    this.maxAssets = options.maxAssets == null ? 150 : Number(options.maxAssets);
    this.maxCandlesPerSeries = options.maxCandlesPerSeries == null ? 300 : Number(options.maxCandlesPerSeries);
    if (!Number.isInteger(this.maxAssets) || this.maxAssets < 1 || this.maxAssets > 10_000) throw new RangeError('maxAssets должен быть целым числом от 1 до 10000');
    if (!Number.isInteger(this.maxCandlesPerSeries) || this.maxCandlesPerSeries < 1 || this.maxCandlesPerSeries > 1_000_000) throw new RangeError('maxCandlesPerSeries должен быть целым числом от 1 до 1000000');
    this._assets = new Map();
    this._dirty = new Map();
    this.maxDirtyCandles = options.maxDirtyCandles == null ? 100_000 : Number(options.maxDirtyCandles);
    if (!Number.isInteger(this.maxDirtyCandles) || this.maxDirtyCandles < unique.length || this.maxDirtyCandles > 5_000_000) throw new RangeError('maxDirtyCandles должен быть не меньше числа таймфреймов и не больше 5000000');
    this.stats = { acceptedTicks: 0, rejectedTicks: 0, rejectedAssets: 0, restoredCandles: 0, backpressureTicks: 0 };
  }

  ingest(rawTick) {
    let tick;
    try { tick = normalizeTick(rawTick); }
    catch (error) {
      this.stats.rejectedTicks++;
      return { accepted: false, reason: 'invalid-tick', error: error.message };
    }

    let additionalDirty = 0;
    for (const timeframe of this.timeframes) {
      const startAt = Math.floor(tick.timestamp / TIMEFRAME_MS[timeframe]) * TIMEFRAME_MS[timeframe];
      const key = `${tick.asset}\\u0000${timeframe}\\u0000${startAt}`;
      if (!this._dirty.has(key)) additionalDirty++;
    }
    if (this._dirty.size + additionalDirty > this.maxDirtyCandles) {
      this.stats.rejectedTicks++;
      this.stats.backpressureTicks++;
      return { accepted: false, reason: 'persistence-backpressure', asset: tick.asset };
    }

    let assetSeries = this._assets.get(tick.asset);
    if (!assetSeries) {
      if (this._assets.size >= this.maxAssets) {
        this.stats.rejectedAssets++;
        return { accepted: false, reason: 'asset-capacity', asset: tick.asset };
      }
      assetSeries = new Map();
      for (const timeframe of this.timeframes) {
        assetSeries.set(timeframe, new CandleSeries({ asset: tick.asset, timeframe, maxCandles: this.maxCandlesPerSeries }));
      }
      this._assets.set(tick.asset, assetSeries);
    }

    // Preflight every timeframe before mutating any series.
    for (const timeframe of this.timeframes) {
      if (!assetSeries.get(timeframe).canAcceptTick(tick)) {
        this.stats.rejectedTicks++;
        return { accepted: false, reason: 'outside-retention', asset: tick.asset, timeframe };
      }
    }

    const updates = {};
    try {
      for (const timeframe of this.timeframes) {
        const result = assetSeries.get(timeframe).ingest(tick);
        if (!result.accepted) throw new Error('Предварительная проверка и запись свечи разошлись');
        updates[timeframe] = result.candle;
        const key = `${tick.asset}\\u0000${timeframe}\\u0000${result.candle.startAt}`;
        const previous = this._dirty.get(key);
        this._dirty.set(key, { key, revision: (previous?.revision || 0) + 1, candle: result.candle });
      }
    } catch (error) {
      this.stats.rejectedTicks++;
      return { accepted: false, reason: 'series-error', error: error.message };
    }
    this.stats.acceptedTicks++;
    return { accepted: true, asset: tick.asset, timestamp: tick.timestamp, updates };
  }

  getAssets() { return [...this._assets.keys()].sort(); }

  getCandles(asset, timeframe, options = {}) {
    const series = this._assets.get(String(asset || '').trim().toUpperCase())?.get(String(timeframe || '').toUpperCase());
    return series ? series.getCandles(options) : [];
  }

  getPreEntryWindow(asset, timeframe, entryAt, lookback) {
    const series = this._assets.get(String(asset || '').trim().toUpperCase())?.get(String(timeframe || '').toUpperCase());
    return series ? series.getPreEntryWindow(entryAt, lookback) : [];
  }

  getDirtyCompletedCandles(asOf = Date.now()) {
    const timestamp = Number(asOf);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new TypeError('asOf должен быть Unix timestamp в миллисекундах');
    const dirty = [];
    for (const item of this._dirty.values()) {
      if (item.candle.endAt <= timestamp) dirty.push({ key: item.key, revision: item.revision, candle: { ...item.candle, complete: true } });
    }
    return dirty;
  }

  acknowledgePersisted(items) {
    if (!Array.isArray(items)) throw new TypeError('items должен быть массивом');
    let acknowledged = 0;
    for (const item of items) {
      if (!item || typeof item.key !== 'string' || !Number.isSafeInteger(item.revision)) continue;
      const current = this._dirty.get(item.key);
      if (current && current.revision === item.revision) { this._dirty.delete(item.key); acknowledged++; }
    }
    return acknowledged;
  }

  restoreCandles(candles) {
    if (!Array.isArray(candles)) throw new TypeError('candles должен быть массивом');
    const sorted = candles.slice().sort((a, b) => String(a.asset).localeCompare(String(b.asset)) || String(a.timeframe).localeCompare(String(b.timeframe)) || Number(a.startAt) - Number(b.startAt));
    let restored = 0, skipped = 0;
    for (const candle of sorted) {
      const asset = String(candle?.asset || '').trim().toUpperCase();
      const timeframe = String(candle?.timeframe || '').toUpperCase();
      if (!asset || !this.timeframes.includes(timeframe)) { skipped++; continue; }
      let assetSeries = this._assets.get(asset);
      if (!assetSeries) {
        if (this._assets.size >= this.maxAssets) { skipped++; continue; }
        assetSeries = new Map();
        for (const tf of this.timeframes) assetSeries.set(tf, new CandleSeries({ asset, timeframe: tf, maxCandles: this.maxCandlesPerSeries }));
        this._assets.set(asset, assetSeries);
      }
      try { assetSeries.get(timeframe).restoreCandle({ ...candle, asset, timeframe }); restored++; }
      catch (_) { skipped++; }
    }
    this.stats.restoredCandles += restored;
    return { restored, skipped, assets: this._assets.size };
  }

  getHealth() {
    let seriesCount = 0, candleCount = 0;
    for (const byTimeframe of this._assets.values()) {
      for (const series of byTimeframe.values()) { seriesCount++; candleCount += series.size; }
    }
    return { ok: true, assets: this._assets.size, timeframes: [...this.timeframes], series: seriesCount, candlesInMemory: candleCount, ...this.stats };
  }
}

module.exports = { MarketDataHub, DEFAULT_TIMEFRAMES };
