'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planTradeIntents, signalKey } = require('../core/trade-coordinator');

function signal(asset, direction, similarity, votes = { UP: 6, DOWN: 2 }, startAt = 10000) {
  return {
    status: 'SIGNAL', asset, timeframe: 'S5', direction,
    averageSimilarity: similarity, votes, historical: { winRate: 70 },
    queryCandles: [{ startAt, endAt: startAt + 5000, open: 1, high: 1.1, low: 0.9, close: 1.05 }]
  };
}

test('trading pause and disabled state block intents without affecting signal analysis', () => {
  const signals = [signal('EURUSD_OTC', 'UP', 90)];
  assert.equal(planTradeIntents(signals).rejected[0].reason, 'trading_disabled');
  assert.equal(planTradeIntents(signals, { tradingEnabled: true, paused: true }).rejected[0].reason, 'trading_paused');
});

test('selects the highest-ranked signals within the 1-to-10 open trade limit', () => {
  const signals = [
    signal('EURUSD_OTC', 'UP', 88),
    signal('GBPUSD_OTC', 'DOWN', 95, { UP: 2, DOWN: 8 }),
    signal('AUDUSD_OTC', 'UP', 91)
  ];
  const result = planTradeIntents(signals, { tradingEnabled: true, maxOpenTrades: 3, openTradeCount: 1 });
  assert.equal(result.availableSlots, 2);
  assert.deepEqual(result.selected.map(item => item.asset), ['GBPUSD_OTC', 'AUDUSD_OTC']);
  assert.equal(result.rejected[0].reason, 'open_trade_limit');
});

test('blocks previously seen and repeated signals in the same batch', () => {
  const one = signal('EURUSD_OTC', 'UP', 90);
  const duplicate = signal('EURUSD_OTC', 'UP', 91);
  const result = planTradeIntents([one, duplicate], {
    tradingEnabled: true, maxOpenTrades: 5, existingSignalKeys: [signalKey(one)]
  });
  assert.equal(result.selected.length, 0);
  assert.deepEqual(result.rejected.map(item => item.reason), ['duplicate_signal', 'duplicate_signal']);
});

test('blocks opposite directions for the same candle from creating a second entry', () => {
  const up = signal('EURUSD_OTC', 'UP', 90);
  const down = signal('EURUSD_OTC', 'DOWN', 95, { UP: 2, DOWN: 6 });
  const result = planTradeIntents([up, down], { tradingEnabled: true, maxOpenTrades: 5 });
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].direction, 'UP');
  assert.equal(result.rejected[0].reason, 'duplicate_signal');
});

test('rejects malformed signal keys and non-signal decisions', () => {
  assert.throws(() => signalKey({ asset: 'EURUSD', timeframe: 'M4', direction: 'UP' }), /валидную OTC/);
  const result = planTradeIntents([{ status: 'NO_SIGNAL', direction: null }], { tradingEnabled: true });
  assert.equal(result.rejected[0].reason, 'not_a_signal');
});

test('validates configured open trade limits and current position count', () => {
  assert.throws(() => planTradeIntents([], { maxOpenTrades: 11 }), /от 1 до 10/);
  assert.throws(() => planTradeIntents([], { openTradeCount: -1 }), /неотрицательным/);
});

test('treats an opposite-direction revision on the same bar as the same signal slot', () => {
  const up = signal('EURUSD_OTC', 'UP', 90);
  const down = signal('EURUSD_OTC', 'DOWN', 91);
  assert.equal(signalKey(up), signalKey(down));
  const result = planTradeIntents([up, down], { tradingEnabled: true, maxOpenTrades: 2 });
  assert.equal(result.selected.length, 1);
  assert.equal(result.rejected[0].reason, 'duplicate_signal');
});
