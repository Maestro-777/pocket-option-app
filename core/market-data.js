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
    this.maxCandlesPerSeries = options.maxCandlesPerSeries == null ? 1_000 : Number(options.maxCandlesPerSeries);
    if (!Number.isInteger(this.maxAssets) || this.maxAssets < 1 || this.maxAssets > 10_000) throw new RangeError('maxAssets должен быть целым числом от 1 до 10000');
    if (!Number.isInteger(this.maxCandlesPerSeries) || this.maxCandlesPerSeries < 1 || this.maxCandlesPerSeries > 1_000_000) throw new RangeError('maxCandlesPerSeries должен быть целым числом от 1 до 1000000');
    this._assets = new Map();
    this.stats = { acceptedTicks: 0, rejectedTicks: 0, rejectedAssets: 0 };
  }

  ingest(rawTick) {
    let tick;
    try { tick = normalizeTick(rawTick); }
    catch (error) {
      this.stats.rejectedTicks++;
      return { accepted: false, reason: 'invalid-tick', error: error.message };
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

  getHealth() {
    let seriesCount = 0, candleCount = 0;
    for (const byTimeframe of this._assets.values()) {
      for (const series of byTimeframe.values()) { seriesCount++; candleCount += series.size; }
    }
    return { ok: true, assets: this._assets.size, timeframes: [...this.timeframes], series: seriesCount, candlesInMemory: candleCount, ...this.stats };
  }
}

module.exports = { MarketDataHub, DEFAULT_TIMEFRAMES };
