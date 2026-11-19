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
