'use strict';

function metric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : -1;
}

/**
 * Stable lexicographic ranking. Factor order follows the agreed project
 * decision; no unapproved weighting coefficients are introduced.
 */
function rankSignals(signals) {
  if (!Array.isArray(signals)) throw new TypeError('signals должен быть массивом');
  const prepared = signals.map((signal, index) => {
    if (!signal || typeof signal !== 'object' || !['UP', 'DOWN'].includes(signal.direction)) {
      throw new TypeError('Каждый сигнал должен содержать направление UP или DOWN');
    }
    const votes = signal.votes || {};
    const up = Number(votes.UP), down = Number(votes.DOWN);
    if (![up, down].every(value => Number.isSafeInteger(value) && value >= 0)) throw new TypeError('Некорректные голоса направления');
    const directionalVotes = signal.direction === 'UP' ? up : down;
    const totalVotes = up + down;
    const directionalConsistency = totalVotes ? directionalVotes / totalVotes : 0;
    const historicalWinRate = metric(signal.historical?.winRate);
    return {
      signal,
      index,
      ranking: {
        similarity: metric(signal.averageSimilarity),
        directionalVotes,
        directionalConsistency,
        historicalWinRate
      }
    };
  });

  prepared.sort((a, b) =>
    b.ranking.similarity - a.ranking.similarity ||
    b.ranking.directionalVotes - a.ranking.directionalVotes ||
    b.ranking.directionalConsistency - a.ranking.directionalConsistency ||
    b.ranking.historicalWinRate - a.ranking.historicalWinRate ||
    String(a.signal.asset || '').localeCompare(String(b.signal.asset || '')) ||
    String(a.signal.timeframe || '').localeCompare(String(b.signal.timeframe || '')) ||
    a.index - b.index
  );

  return prepared.map((item, index) => ({
    ...item.signal,
    rank: index + 1,
    ranking: item.ranking
  }));
}

module.exports = { rankSignals };
