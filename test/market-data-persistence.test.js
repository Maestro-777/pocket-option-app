'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CandleSeries } = require('../core/candle-series');
const { MarketDataHub } = require('../core/market-data');

test('restores persisted candle without making it dirty', () => {
  const series = new CandleSeries({ asset: 'EURUSD_OTC', timeframe: 'S5', maxCandles: 3 });
  const restored = series.restoreCandle({
    asset: 'EURUSD_OTC', timeframe: 'S5', startAt: 5000, endAt: 10000,
    openAt: 5100, closeAt: 9900, open: 1.1, high: 1.3, low: 1.0, close: 1.2,
    tickCount: 4, complete: true
  });
  assert.equal(restored.complete, true);
  assert.equal(restored.openAt, 5100);
  assert.equal(series.getPreEntryWindow(10000, 1).length, 1);
  assert.throws(() => series.restoreCandle({ ...restored, complete: false }), /Некорректная/);
});

test('tracks dirty candle revisions until persistence acknowledges the exact snapshot', () => {
  const hub = new MarketDataHub({ timeframes: ['S5'] });
  hub.ingest({ asset: 'EURUSD_OTC', ts: 1000, price: 1.1 });
  assert.equal(hub.getDirtyCompletedCandles(4999).length, 0);
  const first = hub.getDirtyCompletedCandles(5000);
  assert.equal(first.length, 1);
  hub.ingest({ asset: 'EURUSD_OTC', ts: 2000, price: 1.2 });
  assert.equal(hub.acknowledgePersisted(first), 0);
  const latest = hub.getDirtyCompletedCandles(5000);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].candle.close, 1.2);
  assert.equal(hub.acknowledgePersisted(latest), 1);
  assert.equal(hub.getDirtyCompletedCandles(5000).length, 0);
});

test('restores historical candles into independent timeframe series', () => {
  const hub = new MarketDataHub({ timeframes: ['S5', 'M1'] });
  const result = hub.restoreCandles([
    { asset: 'EURUSD_OTC', timeframe: 'S5', startAt: 5000, endAt: 10000, openAt: 5100, closeAt: 9900, open: 1, high: 1.2, low: 0.9, close: 1.1, tickCount: 2, complete: true },
    { asset: 'EURUSD_OTC', timeframe: 'M1', startAt: 60000, endAt: 120000, openAt: 61000, closeAt: 119000, open: 1, high: 1.2, low: 0.9, close: 1.1, tickCount: 2, complete: true }
  ]);
  assert.equal(result.restored, 2);
  assert.equal(hub.getPreEntryWindow('EURUSD_OTC', 'S5', 10000, 10).length, 1);
  assert.equal(hub.getPreEntryWindow('EURUSD_OTC', 'M1', 120000, 10).length, 1);
  assert.equal(hub.getHealth().dirtyCandles, 0);
});

test('applies explicit backpressure instead of growing an unbounded persistence queue', () => {
  const hub = new MarketDataHub({ timeframes: ['S5'], maxDirtyCandles: 1 });
  assert.equal(hub.ingest({ asset: 'EURUSD_OTC', ts: 1000, price: 1 }).accepted, true);
  assert.equal(hub.ingest({ asset: 'EURUSD_OTC', ts: 2000, price: 1.1 }).accepted, true);
  const rejected = hub.ingest({ asset: 'EURUSD_OTC', ts: 6000, price: 1.2 });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'persistence-backpressure');
  assert.equal(hub.getHealth().backpressureTicks, 1);
});
