'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAssetName, normalizeTimestamp, parseMarketEvent, MarketDataStore } = require('../core/market-data');

test('normalizes OTC symbols and keeps their suffix', () => {
  assert.equal(normalizeAssetName('eur/usd otc'), 'EURUSD_OTC');
  assert.equal(normalizeAssetName('EURUSD_otc'), 'EURUSD_OTC');
  assert.equal(normalizeAssetName('#AAPL'), 'AAPL');
  assert.equal(normalizeAssetName(''), '');
});

test('normalizes second and millisecond timestamps', () => {
  assert.equal(normalizeTimestamp(1_700_000_000, 1), 1_700_000_000_000);
  assert.equal(normalizeTimestamp(1_700_000_000_000, 1), 1_700_000_000_000);
  assert.equal(normalizeTimestamp(-1, 1), null);
  assert.equal(normalizeTimestamp(null, 1), 1);
});

test('parses multi-asset updateStream tuples', () => {
  const event = parseMarketEvent('updateStream', [
    ['EURUSD_otc', 1_700_000_000, '1.0821'], ['GBPUSD_otc', 1_700_000_001, '1.2712']
  ], 1_700_000_002_000);
  assert.equal(event.kind, 'ticks');
  assert.deepEqual(event.ticks.map(item => item.asset), ['EURUSD_OTC', 'GBPUSD_OTC']);
  assert.equal(event.ticks[0].price, 1.0821);
});

test('parses a single quotes/stream tuple', () => {
  const event = parseMarketEvent('quotes/stream', ['CADCHF_otc', 1_700_000_000, 0.6612], 1_700_000_001_000);
  assert.equal(event.ticks.length, 1);
  assert.equal(event.ticks[0].asset, 'CADCHF_OTC');
});

test('parses catalog symbols and labels', () => {
  const event = parseMarketEvent('updateAssets', [['id1', 'EURUSD_otc', 'EUR/USD OTC']], 1_700_000_000_000);
  assert.deepEqual(event.assets[0], { asset: 'EURUSD_OTC', label: 'EUR/USD OTC', raw: 'EURUSD_otc', isOtc: true });
});

test('does not attribute history without an explicit asset to the active DOM pair', () => {
  assert.equal(parseMarketEvent('history/list/v2', [[1_700_000_000, 1.2]], 1_700_000_001_000), null);
});

test('stores independent asset streams and deduplicates exact repeated ticks', () => {
  const store = new MarketDataStore({ maxTicksPerAsset: 3 });
  const at = 1_700_000_001_000;
  store.ingest('updateStream', [['EURUSD_otc', 1_700_000_000, 1.1], ['GBPUSD_otc', 1_700_000_000, 1.2]], at);
  store.ingest('updateStream', [['EURUSD_otc', 1_700_000_000, 1.1]], at);
  store.ingest('updateStream', [['EURUSD_otc', 1_700_000_002, 1.3]], at);
  const snapshot = store.getSnapshot(at);
  assert.equal(snapshot.assetCount, 2);
  assert.equal(snapshot.acceptedTickCount, 3);
  assert.equal(store.getTicks('EURUSD_OTC').length, 2);
  assert.equal(store.getTicks('GBPUSD_OTC')[0].price, 1.2);
});

test('rejects malformed and unsupported payloads', () => {
  assert.equal(parseMarketEvent('trade/open', { asset: 'EURUSD', price: 1 }, Date.now()), null);
  assert.equal(parseMarketEvent('updateStream', [['EURUSD', 0, -2]], Date.now()), null);
});

test('parses provider OHLC history without borrowing the selected DOM symbol', () => {
  const receivedAt = 1_700_000_120_000;
  const event = parseMarketEvent('history/list/v2', {
    asset: 'EURUSD_otc', period: 60,
    history: [
      [1_700_000_000, 1.10, 1.12, 1.09, 1.11],
      [1_700_000_060, 1.11, 1.13, 1.10, 1.12]
    ]
  }, receivedAt);
  assert.equal(event.kind, 'history');
  assert.equal(event.candles.length, 2);
  assert.equal(event.candles[0].asset, 'EURUSD_OTC');
  assert.equal(event.candles[0].open, 1.10);
  assert.equal(event.candles[0].high, 1.12);
  assert.equal(event.candles[0].low, 1.09);
  assert.equal(event.candles[0].close, 1.11);
});

test('stores provider OHLC candles separately from tick history', () => {
  const store = new MarketDataStore();
  const receivedAt = 1_700_000_120_000;
  const result = store.ingest('history/list/v2', {
    asset: 'EURUSD_otc', period: 60,
    history: [
      [1_700_000_000, 1.10, 1.12, 1.09, 1.11],
      [1_700_000_060, 1.11, 1.13, 1.10, 1.12]
    ]
  }, receivedAt);
  assert.equal(result.accepted, true);
  const candles = store.getCandles('EURUSD_OTC', 60);
  assert.equal(candles.length, 2);
  assert.deepEqual(
    [candles[0].open, candles[0].high, candles[0].low, candles[0].close],
    [1.10, 1.12, 1.09, 1.11]
  );
});

test('aggregates stored per-asset ticks into the agreed timeframes', () => {
  const store = new MarketDataStore();
  const base = 1_700_000_000_000;
  store.ingest('updateStream', [
    ['EURUSD_otc', base / 1000 + 1, 1.10],
    ['EURUSD_otc', base / 1000 + 3, 1.20],
    ['EURUSD_otc', base / 1000 + 6, 1.15],
    ['GBPUSD_otc', base / 1000 + 2, 1.30]
  ], base + 10_000);
  const candles = store.getAggregatedCandles('EURUSD_OTC', 'S5', { asOf: base + 10_000 });
  assert.equal(candles.length, 2);
  assert.equal(candles[0].timeframe, 'S5');
  assert.deepEqual(
    [candles[0].open, candles[0].high, candles[0].low, candles[0].close],
    [1.10, 1.20, 1.10, 1.20]
  );
  assert.equal(candles.every(candle => candle.complete), true);
});


test('does not fabricate chart candles from ticks when provider OHLC history is absent', () => {
  const service = new (require('../core/market-data').MarketDataService)();
  const base = 1_700_000_000_000;
  service.ingestEvent('updateStream', [
    ['EURUSD_otc', base / 1000 + 1, 1.10],
    ['EURUSD_otc', base / 1000 + 2, 1.20],
    ['EURUSD_otc', base / 1000 + 3, 1.05]
  ], base + 10_000);
  assert.deepEqual(service.getCandles('EURUSD_OTC', 'S5', { asOf: base + 10_000 }), []);
});

test('keeps ambiguous five-column history as price points, not provider candles', () => {
  const { normalizeHistoryRows } = require('../core/market-data');
  const parsed = normalizeHistoryRows('EURUSD_otc', [
    [1_700_000_000, 1.1, 1.2, 1.3, 1.4]
  ], 60, 1_700_000_120_000);
  assert.equal(parsed.candles.length, 0);
  assert.equal(parsed.ticks.length, 1);
  assert.equal(parsed.ticks[0].price, 1.2);
});


test('uses Pocket Tracker 3.6.0 price-point fallback for ambiguous five-column history rows', () => {
  const { normalizeHistoryRows, MarketDataService } = require('../core/market-data');
  const rows = [
    [1_700_000_000, 0.99480, 0.99490, 0.99482, 0.99470],
    [1_700_000_005, 0.99478, 0.99495, 0.99490, 0.99475],
    [1_700_000_010, 0.99488, 0.99498, 0.99492, 0.99480]
  ];
  const parsed = normalizeHistoryRows('AUDCAD_otc', rows, 5, 1_700_000_030_000);
  assert.equal(parsed.candles.length, 0);
  assert.equal(parsed.ticks.length, 3);
  assert.equal(parsed.ticks[0].price, 0.99482);

  const service = new MarketDataService();
  service.ingestEvent('loadHistoryPeriod', {
    asset: 'AUDCAD_otc', period: 5, history: rows
  }, 1_700_000_030_000);
  const candles = service.getCandles('AUDCAD_OTC', 'S5', { asOf: 1_700_000_030_000 });
  assert.equal(candles.length, 3);
  assert.equal(candles[0].source, 'history-ticks');
  assert.deepEqual([candles[0].open, candles[0].high, candles[0].low, candles[0].close],
    [0.99482, 0.99482, 0.99482, 0.99482]);
});

test('accepts object history rows with timestamp property', () => {
  const { normalizeHistoryRows } = require('../core/market-data');
  const parsed = normalizeHistoryRows('AUDCAD_otc', [
    { timestamp: 1_700_000_000, open: 0.9948, high: 0.9950, low: 0.9947, close: 0.9949 }
  ], 5, 1_700_000_010_000);
  assert.equal(parsed.candles.length, 1);
  assert.equal(parsed.candles[0].close, 0.9949);
});
