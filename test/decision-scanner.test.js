'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DecisionScanner = require('../core/decision-scanner');

function candles(asset, startAt, count = 3) {
  let price = 1.2;
  const rows = [];
  for (let i = 0; i < count; i++) {
    const start = startAt + i * 5000;
    const open = price;
    const close = open * (i % 2 ? 0.9999 : 1.0001);
    rows.push({
      asset, timeframe: 'S5', startAt: start, endAt: start + 5000,
      open, high: Math.max(open, close) * 1.0001, low: Math.min(open, close) * 0.9999,
      close, tickCount: 4, complete: true
    });
    price = close;
  }
  return rows;
}

function fixture() {
  const now = Date.now();
  const startAt = Math.floor((now - 60_000) / 5000) * 5000;
  const live = candles('EURUSD_OTC', startAt);
  const sampleStart = startAt - 15_000;
  const sample = {
    id: 'prior-sample', asset: 'GBPUSD_OTC', timeframe: 'S5',
    entryAt: sampleStart + 15_000, segmentEnd: sampleStart + 15_000,
    expirySeconds: 1, direction: 'UP', outcome: 'WIN',
    inputCandles: candles('GBPUSD_OTC', sampleStart)
  };
  const decisions = [];
  const hub = {
    getAssets: () => ['EURUSD_OTC'],
    getCandles: (asset, timeframe) => asset === 'EURUSD_OTC' && timeframe === 'S5' ? live : []
  };
  const store = {
    listManualExamples: () => [sample],
    listAnalysisDecisions: () => decisions.length ? [decisions[decisions.length - 1]] : [],
    createAnalysisDecision: value => { decisions.push(value); return value; }
  };
  const settings = {
    similarityTopK: 1, similarityMinSimilarity: 0,
    similarityMinExamples: 1, similarityMinDirectionVotes: 1,
    similarityLookback: 3, analysisTimeframes: ['S5']
  };
  const scanner = new DecisionScanner({ marketDataHub: hub, marketDataStore: store, getSettings: () => settings });
  return { scanner, decisions, live, sample };
}

test('scans a queued OTC asset and persists a decision snapshot', async () => {
  const { scanner, decisions, live } = fixture();
  scanner.enqueue('EURUSD_OTC');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].asset, 'EURUSD_OTC');
  assert.equal(decisions[0].timeframe, 'S5');
  assert.equal(decisions[0].queryCandles.length, 3);
  assert.equal(decisions[0].algorithmVersion, 'shape-v1');
  assert.equal(scanner.getStatus().decisions, 1);
  assert.ok(Array.isArray(scanner.getStatus().rankedSignals));
  if (decisions[0].status === 'SIGNAL') assert.equal(scanner.getStatus().rankedSignals[0].asset, 'EURUSD_OTC');
  assert.equal(live.length, 3);
  scanner.close();
});

test('does not write duplicate decisions for the same completed candle', async () => {
  const { scanner, decisions } = fixture();
  scanner.enqueue('EURUSD_OTC');
  await new Promise(resolve => setTimeout(resolve, 300));
  scanner.enqueue('EURUSD_OTC');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(decisions.length, 1);
  scanner.close();
});

test('re-scans a closed candle when a late tick corrects its OHLC snapshot', async () => {
  const { scanner, decisions, live } = fixture();
  scanner.enqueue('EURUSD_OTC');
  await new Promise(resolve => setTimeout(resolve, 300));
  live[2].close += 0.0002;
  live[2].high = Math.max(live[2].high, live[2].close);
  live[2].tickCount++;
  scanner.enqueue('EURUSD_OTC');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(decisions.length, 2);
  scanner.close();
});

test('re-scans the same candle after the example dataset is invalidated', async () => {
  const { scanner, decisions, sample } = fixture();
  scanner.enqueue('EURUSD_OTC');
  await new Promise(resolve => setTimeout(resolve, 300));
  sample.outcome = 'LOSS';
  scanner.invalidateExamples();
  scanner.enqueue('EURUSD_OTC');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(decisions.length, 2);
  scanner.close();
});

test('ignores non-OTC assets and stops pending work on close', async () => {
  const { scanner, decisions } = fixture();
  assert.equal(scanner.enqueue('EURUSD'), false);
  scanner.enqueue('EURUSD_OTC');
  scanner.close();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(decisions.length, 0);
  assert.equal(scanner.getStatus().running, false);
});

test('restores still-fresh ranked signals from the durable decision journal', () => {
  const now = Date.now();
  const previous = {
    asset: 'EURUSD_OTC', timeframe: 'S5', status: 'SIGNAL', direction: 'UP',
    decisionAt: now - 1000, averageSimilarity: 91,
    votes: { UP: 7, DOWN: 1 }, historical: { wins: 5, losses: 1, draws: 0, unknown: 0, winRate: 83.33 },
    matches: [], queryCandles: [{ startAt: Math.floor((now - 6000) / 5000) * 5000 }]
  };
  const scanner = new DecisionScanner({
    marketDataHub: { getAssets: () => [] },
    marketDataStore: {
      createAnalysisDecision: value => value,
      listManualExamples: () => [],
      listAnalysisDecisions: () => [previous]
    },
    getSettings: () => ({ analysisTimeframes: ['S5'] })
  });
  assert.equal(scanner.getStatus().rankedSignals.length, 1);
  assert.equal(scanner.getStatus().rankedSignals[0].asset, 'EURUSD_OTC');
  scanner.close();
});
