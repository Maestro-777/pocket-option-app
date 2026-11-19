'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MarketDataHub } = require('../core/market-data');

test('ingests complete historical OHLC bars and marks them dirty for SQLite', () => {
  const hub = new MarketDataHub({ timeframes: ['S5'] });
  const result = hub.ingestHistoricalCandles([
    { asset: 'EURUSD_OTC', timeframe: 'S5', startAt: 1700000000000, endAt: 1700000005000,
      openAt: 1700000000000, closeAt: 1700000004999, open: 1.1, high: 1.3, low: 1.0, close: 1.2, tickCount: 1, complete: true }
  ], 1700000010000);
  assert.deepEqual(result, { accepted: 1, skipped: 0 });
  const candles = hub.getCandles('EURUSD_OTC', 'S5', { asOf: 1700000010000 });
  assert.equal(candles.length, 1);
  assert.equal(candles[0].high, 1.3);
  assert.equal(hub.getDirtyCompletedCandles(1700000010000).length, 1);
});

test('passive history never overwrites a candle already built from live ticks', () => {
  const hub = new MarketDataHub({ timeframes: ['S5'] });
  hub.ingest({ asset: 'EURUSD_OTC', ts: 1700000001000, price: 1.1 });
  hub.ingest({ asset: 'EURUSD_OTC', ts: 1700000004000, price: 1.2 });
  const result = hub.ingestHistoricalCandles([
    { asset: 'EURUSD_OTC', timeframe: 'S5', startAt: 1700000000000, endAt: 1700000005000,
      openAt: 1700000000000, closeAt: 1700000004999, open: 1.1, high: 1.5, low: 1.0, close: 1.4, tickCount: 20, complete: true }
  ], 1700000010000);
  assert.deepEqual(result, { accepted: 0, skipped: 1 });
  const candle = hub.getCandles('EURUSD_OTC', 'S5', { asOf: 1700000010000 })[0];
  assert.equal(candle.high, 1.2);
  assert.equal(candle.low, 1.1);
  assert.equal(candle.close, 1.2);
});
