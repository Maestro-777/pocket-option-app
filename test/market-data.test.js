'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MarketDataHub, DEFAULT_TIMEFRAMES } = require('../core/market-data');

test('fans each tick into all configured timeframes', () => {
  const hub = new MarketDataHub();
  const result = hub.ingest({ asset: 'eurusd_otc', ts: 1000000, price: 1.234 });
  assert.equal(result.accepted, true);
  assert.deepEqual(Object.keys(result.updates), DEFAULT_TIMEFRAMES);
  assert.deepEqual(hub.getAssets(), ['EURUSD_OTC']);
  assert.equal(hub.getHealth().series, 10);
});

test('isolates assets and timeframes', () => {
  const hub = new MarketDataHub({ timeframes: ['S5', 'M1'] });
  hub.ingest({ asset: 'EURUSD_OTC', ts: 1000000, price: 1.1 });
  hub.ingest({ asset: 'GBPUSD_OTC', ts: 1000000, price: 1.3 });
  assert.equal(hub.getCandles('EURUSD_OTC', 'S5', { asOf: 1005000 }).length, 1);
  assert.equal(hub.getCandles('GBPUSD_OTC', 'S5', { asOf: 1005000 })[0].close, 1.3);
  assert.equal(hub.getCandles('EURUSD_OTC', 'M1', { asOf: 1005000, includeIncomplete: true })[0].timeframe, 'M1');
  assert.deepEqual(hub.getCandles('EURUSD_OTC', 'M5'), []);
});

test('late ticks update longer timeframes even after short timeframe retention expires', () => {
  const hub = new MarketDataHub({ timeframes: ['S5', 'M1'], maxCandlesPerSeries: 2 });
  for (const ts of [1000, 6000, 11000]) {
    assert.equal(hub.ingest({ asset: 'EURUSD_OTC', ts, price: 1.1 }).accepted, true);
  }
  const late = hub.ingest({ asset: 'EURUSD_OTC', ts: 1000, price: 1.2 });
  assert.equal(late.accepted, true);
  assert.deepEqual(Object.keys(late.updates), ['M1']);
  assert.deepEqual(late.rejectedTimeframes, ['S5']);
  assert.equal(hub.getHealth().partialTicks, 1);
  assert.equal(hub.getHealth().rejectedTimeframes, 1);
  assert.equal(hub.getCandles('EURUSD_OTC', 'M1', { includeIncomplete: true })[0].high, 1.2);
});

test('does not silently evict assets at capacity', () => {
  const hub = new MarketDataHub({ timeframes: ['S5'], maxAssets: 1 });
  assert.equal(hub.ingest({ asset: 'EURUSD_OTC', ts: 1000000, price: 1 }).accepted, true);
  const rejected = hub.ingest({ asset: 'GBPUSD_OTC', ts: 1000000, price: 2 });
  assert.equal(rejected.reason, 'asset-capacity');
  assert.deepEqual(hub.getAssets(), ['EURUSD_OTC']);
  assert.equal(hub.getHealth().rejectedAssets, 1);
});

test('does not reserve asset capacity when a new asset is rejected by persistence backpressure', () => {
  const hub = new MarketDataHub({ timeframes: ['S5'], maxAssets: 2, maxDirtyCandles: 1 });
  assert.equal(hub.ingest({ asset: 'EURUSD_OTC', ts: 1000, price: 1.1 }).accepted, true);
  assert.equal(hub.ingest({ asset: 'GBPUSD_OTC', ts: 1000, price: 1.2 }).reason, 'persistence-backpressure');
  assert.deepEqual(hub.getAssets(), ['EURUSD_OTC']);
  const dirty = hub.getDirtyCompletedCandles(6000);
  hub.acknowledgePersisted(dirty);
  assert.equal(hub.ingest({ asset: 'GBPUSD_OTC', ts: 6000, price: 1.2 }).accepted, true);
  assert.deepEqual(hub.getAssets(), ['EURUSD_OTC', 'GBPUSD_OTC']);
});

test('rejects invalid ticks and configuration', () => {
  const hub = new MarketDataHub({ timeframes: ['S5'] });
  assert.equal(hub.ingest({ asset: 'EURUSD_OTC', ts: 0, price: 1 }).reason, 'invalid-tick');
  assert.throws(() => new MarketDataHub({ timeframes: ['S5', 'M4'] }), /Неподдерживаемый/);
  assert.throws(() => new MarketDataHub({ maxAssets: 0 }), /maxAssets/);
});

test('pre-entry reads stay isolated by asset and timeframe', () => {
  const hub = new MarketDataHub({ timeframes: ['S5', 'M1'] });
  hub.ingest({ asset: 'EURUSD_OTC', ts: 1000, price: 1 });
  hub.ingest({ asset: 'EURUSD_OTC', ts: 6000, price: 1.1 });
  assert.equal(hub.getPreEntryWindow('EURUSD_OTC', 'S5', 10000, 10).length, 2);
  assert.equal(hub.getPreEntryWindow('EURUSD_OTC', 'M1', 10000, 10).length, 0);
});
