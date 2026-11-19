'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSimilarity, extractFeatures, validateOptions, evaluateWalkForward } = require('../core/similarity-engine');

const TIMEFRAME = 'S5';
const DURATION = 5000;

function makeCandles(asset, scale = 1, startAt = 5000, count = 30) {
  let price = 1.1 * scale;
  const candles = [];
  for (let i = 0; i < count; i++) {
    const start = startAt + i * DURATION;
    const open = price;
    const change = (i % 4 === 0 ? 0.00018 : i % 4 === 1 ? -0.00011 : i % 4 === 2 ? 0.00007 : -0.00004);
    const close = open * (1 + change);
    const high = Math.max(open, close) * (1 + 0.00012);
    const low = Math.min(open, close) * (1 - 0.00009);
    candles.push({ asset, timeframe: TIMEFRAME, startAt: start, endAt: start + DURATION,
      open, high, low, close, tickCount: 5, complete: true });
    price = close;
  }
  return candles;
}

function example(id, direction, outcome = 'UNKNOWN', overrides = {}) {
  return {
    id, asset: 'GBPUSD_OTC', timeframe: TIMEFRAME, entryAt: 155000, segmentEnd: 155000,
    direction, outcome, expirySeconds: 1,
    inputCandles: makeCandles('GBPUSD_OTC', 1.7, 5000),
    ...overrides
  };
}

test('compares normalized candle shape across different OTC pairs and absolute prices', () => {
  const left = extractFeatures(makeCandles('EURUSD_OTC', 1, 5000), TIMEFRAME);
  const right = extractFeatures(makeCandles('GBPUSD_OTC', 1.7, 5000), TIMEFRAME);
  assert.equal(left.length, right.length);
  const result = analyzeSimilarity({
    timeframe: TIMEFRAME, entryAt: 160000,
    candles: makeCandles('EURUSD_OTC', 1, 5000),
    examples: Array.from({ length: 10 }, (_, i) => example('e' + i, i < 6 ? 'UP' : 'DOWN', i < 3 ? 'WIN' : i === 3 ? 'LOSS' : i === 4 ? 'DRAW' : 'UNKNOWN'))
  });
  assert.equal(result.status, 'SIGNAL');
  assert.equal(result.direction, 'UP');
  assert.equal(result.votes.UP, 6);
  assert.equal(result.votes.DOWN, 4);
  assert.equal(result.matches.length, 10);
  assert.ok(result.averageSimilarity >= 99);
  assert.equal(result.historical.wins, 3);
  assert.equal(result.historical.losses, 1);
  assert.equal(result.historical.winRate, 75);
  assert.ok(result.matches.every(match => match.asset === 'GBPUSD_OTC'));
});

test('only same-timeframe, earlier examples can vote; future examples are excluded', () => {
  const examples = [
    example('same', 'UP'),
    example('other-tf', 'DOWN', 'WIN', { timeframe: 'M1' }),
    example('future', 'DOWN', 'WIN', { entryAt: 160000 })
  ];
  const result = analyzeSimilarity({
    timeframe: TIMEFRAME, entryAt: 160000,
    candles: makeCandles('EURUSD_OTC', 1, 5000),
    examples,
    options: { topK: 3, minExamples: 1, minDirectionVotes: 1, minSimilarity: 80 }
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].id, 'same');
  assert.equal(result.votes.UP, 1);
  assert.equal(result.skippedExamples, 2);
});

test('does not use a sample before its expiry and labelled segment have completed', () => {
  const immature = example('immature', 'UP', 'WIN', { expirySeconds: 60, segmentEnd: 180000 });
  const result = analyzeSimilarity({
    timeframe: TIMEFRAME, entryAt: 200000,
    candles: makeCandles('EURUSD_OTC', 1, 5000),
    examples: [immature],
    options: { topK: 1, minExamples: 1, minDirectionVotes: 1, minSimilarity: 0 }
  });
  assert.equal(result.matches.length, 0);
  assert.equal(result.skippedExamples, 1);
});

test('returns no signal when directional votes are split', () => {
  const result = analyzeSimilarity({
    timeframe: TIMEFRAME, entryAt: 160000,
    candles: makeCandles('EURUSD_OTC', 1, 5000),
    examples: Array.from({ length: 10 }, (_, i) => example('split-' + i, i < 5 ? 'UP' : 'DOWN')),
  });
  assert.equal(result.status, 'NO_SIGNAL');
  assert.equal(result.reason, 'conflicting_directions');
  assert.equal(result.direction, 'NONE');
});

test('refuses unfinished or future candles in the live query', () => {
  const candles = makeCandles('EURUSD_OTC', 1, 5000);
  candles[29].complete = false;
  assert.throws(() => analyzeSimilarity({
    timeframe: TIMEFRAME, entryAt: 160000, candles,
    examples: [example('sample', 'UP')],
    options: { topK: 1, minExamples: 1, minDirectionVotes: 1 }
  }), /только закрытые свечи/);

  candles[29].complete = true;
  assert.throws(() => analyzeSimilarity({
    timeframe: TIMEFRAME, entryAt: 154999, candles,
    examples: [example('sample', 'UP')],
    options: { topK: 1, minExamples: 1, minDirectionVotes: 1 }
  }), /Будущая или незакрытая/);
});

test('walk-forward evaluation uses only strictly earlier examples and reports coverage', () => {
  const examples = Array.from({ length: 8 }, (_, i) => {
    const entryAt = 155000 + i * 120000;
    return {
      ...example('wf-' + i, 'UP', i === 7 ? 'LOSS' : 'WIN'),
      entryAt, segmentEnd: entryAt
    };
  });
  const report = evaluateWalkForward(examples, { topK: 10, minExamples: 3, minDirectionVotes: 6, lookback: 30, minSimilarity: 80 });
  assert.equal(report.evaluated, 8);
  assert.equal(report.signals, 2);
  assert.equal(report.noSignal, 6);
  assert.equal(report.correct, 1);
  assert.equal(report.incorrect, 1);
  assert.equal(report.accuracy, 50);
  assert.equal(report.coverage, 25);
  assert.equal(report.results[6].predictedDirection, 'UP');
  assert.equal(report.results[7].actualDirection, 'DOWN');
});

test('validates configurable thresholds and refuses unsupported timeframes', () => {
  assert.equal(validateOptions().topK, 10);
  assert.equal(validateOptions().minSimilarity, 80);
  assert.throws(() => validateOptions({ topK: 0 }), /topK/);
  assert.throws(() => validateOptions({ topK: 5, minDirectionVotes: 6 }), /minDirectionVotes/);
  assert.throws(() => analyzeSimilarity({ timeframe: 'M4', entryAt: 100000, candles: [], examples: [] }), /Неподдерживаемый таймфрейм/);
});
