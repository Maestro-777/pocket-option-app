'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHistoryCandles } = require('../core/pocketoption-protocol');

test('normalizes historical OHLC rows in the observed OHLC order', () => {
  const result = normalizeHistoryCandles('updateHistoryNewFast', {
    asset: 'EURUSD_otc', period: 5,
    history: [[1700000000, 1.1, 1.3, 1.0, 1.2], [1700000005, 1.2, 1.4, 1.1, 1.3]]
  });
  assert.equal(result.timeframe, 'S5');
  assert.equal(result.candles.length, 2);
  assert.deepEqual({ open: result.candles[0].open, high: result.candles[0].high, low: result.candles[0].low, close: result.candles[0].close },
    { open: 1.1, high: 1.3, low: 1.0, close: 1.2 });
});

test('detects alternate OHLC array order and object-shaped candles', () => {
  const arrayResult = normalizeHistoryCandles('history/list/v2', {
    asset: 'GBPUSD_otc', period: 5, history: [[1700000000, 1.1, 1.2, 1.3, 1.0]]
  });
  assert.deepEqual({ high: arrayResult.candles[0].high, low: arrayResult.candles[0].low, close: arrayResult.candles[0].close },
    { high: 1.3, low: 1.0, close: 1.2 });
  const objectResult = normalizeHistoryCandles('loadHistoryPeriod', {
    asset: 'EURUSD_otc', period: 60,
    history: [{ time: 1700000000, open: 1.1, high: 1.3, low: 1.0, close: 1.2 }]
  });
  assert.equal(objectResult.timeframe, 'M1');
  assert.equal(objectResult.candles.length, 1);
});

test('skips close-only rows, unsupported periods, future bars and unrelated events', () => {
  const result = normalizeHistoryCandles('history/list/v2', {
    asset: 'EURUSD_otc', period: 60,
    history: [[1700000000, 1.2, 1], [9999999999, 1.2, 1]]
  }, { asOf: 1700000200000 });
  assert.equal(result.candles.length, 0);
  assert.equal(result.skippedRows, 2);
  assert.equal(normalizeHistoryCandles('loadHistoryPeriod', { asset: 'EURUSD_otc', period: 7, history: [] }).timeframe, null);
  assert.equal(normalizeHistoryCandles('unrelated', {}).candles.length, 0);
});

test('limits passive history ingestion to the 300-bar rolling cache', () => {
  const history = Array.from({ length: 400 }, (_, i) => [1700000000 + i * 5, 1.1, 1.3, 1.0, 1.2]);
  const result = normalizeHistoryCandles('updateHistoryNewFast', { asset: 'EURUSD_otc', period: 5, history });
  assert.equal(result.candles.length, 300);
  assert.equal(result.skippedRows, 100);
  assert.equal(result.candles[0].startAt, Math.floor((1700000000 + 100 * 5) * 1000 / 5000) * 5000);
});
