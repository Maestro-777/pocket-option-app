'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rankSignals } = require('../core/signal-ranking');

test('ranks concurrent signals by similarity, votes, consistency, then historical result', () => {
  const signals = [
    { asset: 'EURUSD_OTC', timeframe: 'S5', direction: 'UP', averageSimilarity: 88, votes: { UP: 8, DOWN: 2 }, historical: { winRate: 90 } },
    { asset: 'GBPUSD_OTC', timeframe: 'S5', direction: 'UP', averageSimilarity: 92, votes: { UP: 8, DOWN: 4 }, historical: { winRate: 95 } },
    { asset: 'AUDUSD_OTC', timeframe: 'M1', direction: 'UP', averageSimilarity: 92, votes: { UP: 8, DOWN: 2 }, historical: { winRate: 55 } },
    { asset: 'USDJPY_OTC', timeframe: 'S10', direction: 'DOWN', averageSimilarity: 92, votes: { UP: 6, DOWN: 4 }, historical: { winRate: 99 } }
  ];
  const ranked = rankSignals(signals);
  assert.deepEqual(ranked.map(item => item.asset), ['AUDUSD_OTC', 'GBPUSD_OTC', 'USDJPY_OTC', 'EURUSD_OTC']);
  assert.deepEqual(ranked.map(item => item.rank), [1, 2, 3, 4]);
  assert.equal(ranked[0].ranking.directionalVotes, 8);
  assert.equal(ranked[0].ranking.directionalConsistency, 0.8);
});

test('uses historical win rate only after similarity, votes, and consistency tie', () => {
  const ranked = rankSignals([
    { asset: 'A_OTC', timeframe: 'S5', direction: 'UP', averageSimilarity: 90, votes: { UP: 6, DOWN: 2 }, historical: { winRate: null } },
    { asset: 'B_OTC', timeframe: 'S5', direction: 'UP', averageSimilarity: 90, votes: { UP: 6, DOWN: 2 }, historical: { winRate: 75 } }
  ]);
  assert.equal(ranked[0].asset, 'B_OTC');
  assert.equal(ranked[1].ranking.historicalWinRate, -1);
});

test('rejects malformed signal directions and vote counts', () => {
  assert.throws(() => rankSignals([{ direction: 'NONE' }]), /направление/);
  assert.throws(() => rankSignals([{ direction: 'UP', votes: { UP: -1, DOWN: 0 } }]), /голоса/);
});
