'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TIMEFRAME_MS,
  getTimeframeDuration,
  aggregateTicksToCandles,
  getPreEntryWindow
} = require('../core/timeframes');

test('supports exactly the required timeframes', () => {
  assert.deepEqual(Object.keys(TIMEFRAME_MS), ['S5', 'S10', 'S15', 'S30', 'M1', 'M2', 'M3', 'M5', 'M10', 'M15']);
  assert.equal(getTimeframeDuration('s5'), 5000);
  assert.throws(() => getTimeframeDuration('M4'), /Неподдерживаемый таймфрейм/);
});

test('aggregates OHLC in timestamp order and keeps assets independent', () => {
  const candles = aggregateTicksToCandles([
    { asset: 'eurusd_otc', ts: 1200, price: 1.2 },
    { asset: 'EURUSD_OTC', ts: 4200, price: 1.1 },
    { asset: 'GBPUSD_OTC', ts: 2000, price: 1.3 },
    { asset: 'EURUSD_OTC', ts: 2100, price: 1.25 }
  ], 'S5', { asOf: 5000 });

  assert.equal(candles.length, 2);
  const eur = candles.find(candle => candle.asset === 'EURUSD_OTC');
  assert.deepEqual(
    { open: eur.open, high: eur.high, low: eur.low, close: eur.close, tickCount: eur.tickCount },
    { open: 1.2, high: 1.25, low: 1.1, close: 1.1, tickCount: 3 }
  );
  assert.equal(eur.complete, true);
});

test('excludes a forming candle unless explicitly requested', () => {
  const ticks = [
    { asset: 'EURUSD_OTC', ts: 5100, price: 1.2 },
    { asset: 'EURUSD_OTC', ts: 9900, price: 1.3 }
  ];
  assert.equal(aggregateTicksToCandles(ticks, 'S5', { asOf: 9999 }).length, 0);
  const partial = aggregateTicksToCandles(ticks, 'S5', { asOf: 9999, includeIncomplete: true });
  assert.equal(partial.length, 1);
  assert.equal(partial[0].complete, false);
});

test('ignores malformed ticks and rejects invalid clock inputs', () => {
  const candles = aggregateTicksToCandles([
    null, {}, { asset: 'EURUSD_OTC', ts: 1, price: -1 },
    { asset: 'EURUSD_OTC', ts: 1000, price: 1.2 }
  ], 'S5', { asOf: 5000 });
  assert.equal(candles.length, 1);
  assert.throws(() => aggregateTicksToCandles([], 'S5', { asOf: NaN }), /asOf/);
});

test('pre-entry window never includes candles ending after the entry', () => {
  const candles = [
    { endAt: 1000, complete: true, close: 1 },
    { endAt: 2000, complete: true, close: 2 },
    { endAt: 3000, complete: true, close: 3 },
    { endAt: 4000, complete: false, close: 4 }
  ];
  const result = getPreEntryWindow(candles, 2500, 10);
  assert.deepEqual(result.map(candle => candle.close), [1, 2]);
  assert.throws(() => getPreEntryWindow(candles, 2500, 0), /lookback/);
});
