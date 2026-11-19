'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CandleSeries } = require('../core/candle-series');

test('builds OHLC candles and completes them by clock', () => {
  const series = new CandleSeries({ asset: 'EURUSD_otc', timeframe: 'S5' });
  series.ingest({ asset: 'EURUSD_OTC', ts: 1100, price: 1.2 });
  series.ingest({ asset: 'EURUSD_OTC', ts: 4200, price: 1.1 });
  series.ingest({ asset: 'EURUSD_OTC', ts: 6100, price: 1.3 });
  const candles = series.getCandles({ asOf: 9999, includeIncomplete: true });
  assert.equal(candles.length, 2);
  assert.deepEqual({ open: candles[0].open, high: candles[0].high, low: candles[0].low, close: candles[0].close, ticks: candles[0].tickCount, complete: candles[0].complete },
    { open: 1.2, high: 1.2, low: 1.1, close: 1.1, ticks: 2, complete: true });
  assert.equal(candles[1].complete, false);
  assert.equal(series.getCandles({ asOf: 11000 })[0].complete, true);
});

test('corrects retained candles for out-of-order ticks', () => {
  const series = new CandleSeries({ asset: 'GBPUSD_OTC', timeframe: 'S5' });
  series.ingest({ asset: 'GBPUSD_OTC', ts: 4000, price: 1.4 });
  series.ingest({ asset: 'GBPUSD_OTC', ts: 2000, price: 1.2 });
  series.ingest({ asset: 'GBPUSD_OTC', ts: 3000, price: 1.8 });
  const candle = series.getCandles({ asOf: 5000, includeIncomplete: true })[0];
  assert.deepEqual({ open: candle.open, close: candle.close, high: candle.high, low: candle.low, tickCount: candle.tickCount },
    { open: 1.2, close: 1.4, high: 1.8, low: 1.2, tickCount: 3 });
});

test('pre-entry excludes incomplete and future candles', () => {
  const series = new CandleSeries({ asset: 'EURUSD_OTC', timeframe: 'S5' });
  for (const [ts, price] of [[1000, 1], [6000, 1.1], [11000, 1.2]]) series.ingest({ asset: 'EURUSD_OTC', ts, price });
  const window = series.getPreEntryWindow(10000, 10);
  assert.deepEqual(window.map(candle => candle.startAt), [0, 5000]);
  assert.ok(window.every(candle => candle.endAt <= 10000 && candle.complete));
});

test('validates ticks and options', () => {
  const series = new CandleSeries({ asset: 'EURUSD_OTC', timeframe: 'M1' });
  assert.throws(() => series.ingest(null), /tick/);
  assert.throws(() => series.ingest({ asset: 'GBPUSD_OTC', ts: 1000, price: 1 }), /другому активу/);
  assert.throws(() => series.ingest({ asset: 'EURUSD_OTC', ts: 1000, price: NaN }), /Цена/);
  assert.throws(() => new CandleSeries({ asset: 'EURUSD_OTC', timeframe: 'M4' }), /Неподдерживаемый/);
  assert.throws(() => new CandleSeries({ asset: 'EURUSD_OTC', timeframe: 'S5', maxCandles: 0 }), /maxCandles/);
});

test('bounds memory and rejects ticks older than retained history', () => {
  const series = new CandleSeries({ asset: 'EURUSD_OTC', timeframe: 'S5', maxCandles: 2 });
  for (const ts of [1000, 6000, 11000]) series.ingest({ asset: 'EURUSD_OTC', ts, price: 1 });
  assert.equal(series.size, 2);
  assert.equal(series.ingest({ asset: 'EURUSD_OTC', ts: 2000, price: 1.2 }).reason, 'outside-retention');
  assert.equal(series.droppedLateTicks, 1);
});
