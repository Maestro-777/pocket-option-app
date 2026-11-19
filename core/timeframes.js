'use strict';

const TIMEFRAME_MS = Object.freeze({
  S5: 5_000,
  S10: 10_000,
  S15: 15_000,
  S30: 30_000,
  M1: 60_000,
  M2: 120_000,
  M3: 180_000,
  M5: 300_000,
  M10: 600_000,
  M15: 900_000
});

function getTimeframeDuration(timeframe) {
  const key = String(timeframe || '').toUpperCase();
  const duration = TIMEFRAME_MS[key];
  if (!duration) throw new TypeError('Неподдерживаемый таймфрейм: ' + key);
  return duration;
}

function normalizeTick(tick, index) {
  if (!tick || typeof tick !== 'object') return null;
  const asset = String(tick.asset || tick.symbol || '').trim().toUpperCase();
  const ts = Number(tick.ts);
  const price = Number(tick.price);
  if (!asset || asset.length > 64 || !Number.isFinite(ts) || ts <= 0 ||
      !Number.isFinite(price) || price <= 0) return null;
  return { asset, ts, price, index };
}

/**
 * Aggregate timestamped price ticks into UTC-aligned OHLC candles.
 *
 * Tick timestamps must be Unix milliseconds. By default, only candles whose
 * endAt <= asOf are returned; this prevents a still-forming candle from being
 * mistaken for a completed historical observation.
 */
function aggregateTicksToCandles(ticks, timeframe, options = {}) {
  if (!Array.isArray(ticks)) throw new TypeError('ticks должен быть массивом');
  const duration = getTimeframeDuration(timeframe);
  const asOf = options.asOf == null ? Date.now() : Number(options.asOf);
  if (!Number.isFinite(asOf) || asOf <= 0) throw new TypeError('asOf должен быть timestamp в миллисекундах');
  const includeIncomplete = options.includeIncomplete === true;
  const buckets = new Map();

  ticks.forEach((raw, index) => {
    const tick = normalizeTick(raw, index);
    if (!tick || tick.ts > asOf) return;
    const startAt = Math.floor(tick.ts / duration) * duration;
    const key = JSON.stringify([tick.asset, startAt]);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { asset: tick.asset, startAt, endAt: startAt + duration, ticks: [] };
      buckets.set(key, bucket);
    }
    bucket.ticks.push(tick);
  });

  const candles = [];
  for (const bucket of buckets.values()) {
    const complete = bucket.endAt <= asOf;
    if (!complete && !includeIncomplete) continue;
    bucket.ticks.sort((a, b) => a.ts - b.ts || a.index - b.index);
    const prices = bucket.ticks.map(tick => tick.price);
    let high = -Infinity, low = Infinity;
    for (const price of prices) { if (price > high) high = price; if (price < low) low = price; }
    candles.push({
      asset: bucket.asset,
      timeframe: String(timeframe).toUpperCase(),
      startAt: bucket.startAt,
      endAt: bucket.endAt,
      open: prices[0],
      high,
      low,
      close: prices[prices.length - 1],
      tickCount: prices.length,
      complete
    });
  }

  candles.sort((a, b) => a.asset.localeCompare(b.asset) || a.startAt - b.startAt);
  return candles;
}

/**
 * Return the last N completed candles available at entryAt.
 * A candle is usable only when its endAt is not later than the entry time.
 */
function getPreEntryWindow(candles, entryAt, lookback) {
  const at = Number(entryAt);
  const count = Number(lookback);
  if (!Number.isFinite(at) || at <= 0) throw new TypeError('entryAt должен быть timestamp в миллисекундах');
  if (!Number.isInteger(count) || count < 1 || count > 10_000) throw new RangeError('lookback должен быть целым числом от 1 до 10000');
  if (!Array.isArray(candles)) throw new TypeError('candles должен быть массивом');
  return candles
    .filter(candle => candle && candle.complete === true && Number.isFinite(Number(candle.endAt)) && Number(candle.endAt) <= at)
    .slice()
    .sort((a, b) => Number(a.endAt) - Number(b.endAt))
    .slice(-count);
}

module.exports = {
  TIMEFRAME_MS,
  getTimeframeDuration,
  aggregateTicksToCandles,
  getPreEntryWindow
};
