'use strict';

const { getTimeframeDuration } = require('./timeframes');

function normalizeAsset(value) {
  const asset = String(value || '').trim().toUpperCase();
  if (!asset || asset.length > 64 || !/^[A-Z0-9._-]+$/.test(asset)) {
    throw new TypeError('Некорректный идентификатор актива');
  }
  return asset;
}

function normalizeTick(tick) {
  if (!tick || typeof tick !== 'object' || Array.isArray(tick)) throw new TypeError('tick должен быть объектом');
  const asset = normalizeAsset(tick.asset ?? tick.symbol);
  const timestamp = Number(tick.ts ?? tick.timestamp);
  const price = Number(tick.price);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new TypeError('Время тика должно быть Unix timestamp в миллисекундах');
  if (!Number.isFinite(price) || price <= 0) throw new TypeError('Цена тика должна быть положительным конечным числом');
  return { asset, timestamp, price };
}

/**
 * Incremental OHLC series for one asset and one timeframe.
 * Late ticks may correct retained candles; callers should persist revisions.
 */
class CandleSeries {
  constructor(options = {}) {
    this.asset = normalizeAsset(options.asset);
    this.timeframe = String(options.timeframe || '').toUpperCase();
    this.duration = getTimeframeDuration(this.timeframe);
    this.maxCandles = options.maxCandles == null ? 10_000 : Number(options.maxCandles);
    if (!Number.isInteger(this.maxCandles) || this.maxCandles < 1 || this.maxCandles > 1_000_000) {
      throw new RangeError('maxCandles должен быть целым числом от 1 до 1000000');
    }
    this._buckets = new Map();
    this._oldestStartAt = null;
    this._sequence = 0;
    this.droppedLateTicks = 0;
  }

  canAcceptTick(rawTick) {
    const tick = normalizeTick(rawTick);
    if (tick.asset !== this.asset) throw new TypeError('Тик относится к другому активу');
    const startAt = Math.floor(tick.timestamp / this.duration) * this.duration;
    return this._oldestStartAt == null || startAt >= this._oldestStartAt;
  }

  ingest(rawTick) {
    const tick = normalizeTick(rawTick);
    if (tick.asset !== this.asset) throw new TypeError('Тик относится к другому активу');
    const startAt = Math.floor(tick.timestamp / this.duration) * this.duration;
    const endAt = startAt + this.duration;
    if (this._oldestStartAt != null && startAt < this._oldestStartAt) {
      this.droppedLateTicks++;
      return { accepted: false, reason: 'outside-retention', candle: null };
    }

    let bucket = this._buckets.get(startAt);
    if (!bucket) {
      bucket = {
        asset: this.asset, timeframe: this.timeframe, startAt, endAt,
        open: tick.price, high: tick.price, low: tick.price, close: tick.price,
        tickCount: 0, _openTs: tick.timestamp, _closeTs: tick.timestamp,
        _openSeq: -1, _closeSeq: -1
      };
      this._buckets.set(startAt, bucket);
      if (this._oldestStartAt == null || startAt < this._oldestStartAt) this._oldestStartAt = startAt;
    }

    const sequence = this._sequence++;
    bucket.tickCount++;
    if (tick.price > bucket.high) bucket.high = tick.price;
    if (tick.price < bucket.low) bucket.low = tick.price;
    if (tick.timestamp < bucket._openTs || (tick.timestamp === bucket._openTs && sequence < bucket._openSeq)) {
      bucket._openTs = tick.timestamp; bucket._openSeq = sequence; bucket.open = tick.price;
    }
    if (tick.timestamp > bucket._closeTs || (tick.timestamp === bucket._closeTs && sequence > bucket._closeSeq)) {
      bucket._closeTs = tick.timestamp; bucket._closeSeq = sequence; bucket.close = tick.price;
    }

    this._prune();
    return { accepted: true, reason: null, candle: this._toPublic(bucket, Date.now()) };
  }

  _prune() {
    if (this._buckets.size <= this.maxCandles) return;
    const starts = [...this._buckets.keys()].sort((a, b) => a - b);
    for (let i = 0; i < starts.length - this.maxCandles; i++) this._buckets.delete(starts[i]);
    this._oldestStartAt = starts[starts.length - this.maxCandles] ?? null;
  }

  _toPublic(bucket, asOf) {
    return {
      asset: bucket.asset, timeframe: bucket.timeframe, startAt: bucket.startAt, endAt: bucket.endAt,
      openAt: bucket._openTs, closeAt: bucket._closeTs,
      open: bucket.open, high: bucket.high, low: bucket.low, close: bucket.close,
      tickCount: bucket.tickCount, complete: bucket.endAt <= asOf
    };
  }

  getCandles(options = {}) {
    const asOf = options.asOf == null ? Date.now() : Number(options.asOf);
    if (!Number.isSafeInteger(asOf) || asOf <= 0) throw new TypeError('asOf должен быть Unix timestamp в миллисекундах');
    const includeIncomplete = options.includeIncomplete === true;
    return [...this._buckets.values()].sort((a, b) => a.startAt - b.startAt)
      .filter(bucket => includeIncomplete || bucket.endAt <= asOf)
      .map(bucket => this._toPublic(bucket, asOf));
  }

  restoreCandle(candle) {
    if (!candle || candle.asset !== this.asset || String(candle.timeframe).toUpperCase() !== this.timeframe) {
      throw new TypeError('Восстанавливаемая свеча не соответствует серии');
    }
    const startAt = Number(candle.startAt), endAt = Number(candle.endAt);
    const openAt = Number(candle.openAt ?? startAt), closeAt = Number(candle.closeAt ?? (endAt - 1));
    const open = Number(candle.open), high = Number(candle.high), low = Number(candle.low), close = Number(candle.close);
    const tickCount = Number(candle.tickCount);
    if (!Number.isSafeInteger(startAt) || startAt <= 0 || startAt % this.duration !== 0 || endAt !== startAt + this.duration ||
        !Number.isSafeInteger(openAt) || !Number.isSafeInteger(closeAt) || openAt < startAt || closeAt < openAt || closeAt >= endAt ||
        ![open, high, low, close].every(value => Number.isFinite(value) && value > 0) ||
        high < Math.max(open, low, close) || low > Math.min(open, high, close) ||
        !Number.isSafeInteger(tickCount) || tickCount < 1 || candle.complete !== true) {
      throw new TypeError('Некорректная восстановленная свеча');
    }
    const bucket = {
      asset: this.asset, timeframe: this.timeframe, startAt, endAt,
      open: open, high, low, close, tickCount,
      _openTs: openAt, _closeTs: closeAt, _openSeq: 0, _closeSeq: 0
    };
    this._buckets.set(startAt, bucket);
    if (this._oldestStartAt == null || startAt < this._oldestStartAt) this._oldestStartAt = startAt;
    this._prune();
    return this._toPublic(bucket, endAt);
  }

  getPreEntryWindow(entryAt, lookback) {
    const at = Number(entryAt);
    if (!Number.isSafeInteger(at) || at <= 0) throw new TypeError('entryAt должен быть Unix timestamp в миллисекундах');
    if (!Number.isInteger(lookback) || lookback < 1 || lookback > this.maxCandles) {
      throw new RangeError('lookback должен быть целым числом от 1 до maxCandles');
    }
    return this.getCandles({ asOf: at }).filter(candle => candle.complete && candle.endAt <= at).slice(-lookback);
  }

  hasCandle(startAt) { return this._buckets.has(Number(startAt)); }

  get size() { return this._buckets.size; }
}

module.exports = { CandleSeries, normalizeTick, normalizeAsset };
