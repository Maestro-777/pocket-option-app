'use strict';

const { TIMEFRAME_MS } = require('./timeframes');

const DEFAULTS = Object.freeze({
  topK: 10,
  minSimilarity: 80,
  minExamples: 3,
  minDirectionVotes: 6,
  lookback: 30,
  maxExamples: 10_000
});

const FEATURE_WEIGHTS = Object.freeze([0.25, 0.15, 0.15, 0.15, 0.20, 0.10]);

function validateOptions(options = {}) {
  const value = { ...DEFAULTS, ...options };
  for (const key of ['topK', 'minExamples', 'minDirectionVotes', 'lookback', 'maxExamples']) {
    if (!Number.isInteger(value[key])) throw new TypeError(key + ' должен быть целым числом');
  }
  if (value.topK < 1 || value.topK > 100) throw new RangeError('topK должен быть от 1 до 100');
  if (value.minExamples < 1 || value.minExamples > value.topK) throw new RangeError('minExamples должен быть от 1 до topK');
  if (value.minDirectionVotes < 1 || value.minDirectionVotes > value.topK) throw new RangeError('minDirectionVotes должен быть от 1 до topK');
  if (value.lookback < 3 || value.lookback > 300) throw new RangeError('lookback должен быть от 3 до 300');
  if (value.maxExamples < value.topK || value.maxExamples > 10_000) throw new RangeError('maxExamples должен быть от topK до 10000');
  if (!Number.isFinite(value.minSimilarity) || value.minSimilarity < 0 || value.minSimilarity > 100) {
    throw new RangeError('minSimilarity должен быть от 0 до 100');
  }
  return Object.freeze(value);
}

function validateCandle(candle, timeframe, label) {
  if (!candle || typeof candle !== 'object' || Array.isArray(candle)) throw new TypeError(label + ': свеча должна быть объектом');
  const startAt = Number(candle.startAt), endAt = Number(candle.endAt);
  const open = Number(candle.open), high = Number(candle.high), low = Number(candle.low), close = Number(candle.close);
  const duration = TIMEFRAME_MS[timeframe];
  if (!Number.isSafeInteger(startAt) || startAt <= 0 || !Number.isSafeInteger(endAt) || endAt !== startAt + duration || startAt % duration !== 0) {
    throw new TypeError(label + ': неверные временные границы свечи');
  }
  if (![open, high, low, close].every(v => Number.isFinite(v) && v > 0) ||
      high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
    throw new TypeError(label + ': нарушена целостность OHLC');
  }
  if (candle.complete !== true) throw new TypeError(label + ': допускаются только закрытые свечи');
  return { startAt, endAt, open, high, low, close };
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Convert OHLC candles into scale-independent shape features.
 * Each feature is bounded to [0, 1]; absolute instrument price is never used.
 */
function extractFeatures(candles, timeframe) {
  if (!Array.isArray(candles) || candles.length < 3) throw new TypeError('Для сравнения нужны минимум 3 свечи');
  const normalized = candles.map(candle => validateCandle(candle, timeframe, 'Входные данные'));
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].startAt <= normalized[i - 1].startAt) throw new TypeError('Свечи должны идти строго по времени');
  }

  const ranges = normalized.map(c => (c.high - c.low) / c.open);
  const scale = Math.max(median(ranges.filter(v => v > 0)) || 0, 1e-8);
  return normalized.map((candle, index) => {
    const range = Math.max((candle.high - candle.low) / candle.open, scale * 1e-6);
    const body = (candle.close - candle.open) / candle.open;
    const upper = (candle.high - Math.max(candle.open, candle.close)) / candle.open;
    const lower = (Math.min(candle.open, candle.close) - candle.low) / candle.open;
    const previousClose = index ? normalized[index - 1].close : candle.open;
    const logReturn = Math.log(candle.close / previousClose);
    const gap = Math.log(candle.open / previousClose);
    const normalizedBody = clamp(body / range, -1, 1) * 0.5 + 0.5;
    const upperWick = clamp(upper / range, 0, 1);
    const lowerWick = clamp(lower / range, 0, 1);
    const volatility = clamp(Math.log1p(range / scale) / Math.log(4), 0, 1);
    const momentum = clamp(logReturn / scale, -3, 3) / 6 + 0.5;
    const openingGap = clamp(gap / scale, -3, 3) / 6 + 0.5;
    return [normalizedBody, upperWick, lowerWick, volatility, momentum, openingGap];
  });
}

function resample(features, targetLength) {
  if (features.length === targetLength) return features;
  const output = [];
  for (let i = 0; i < targetLength; i++) {
    const position = i * (features.length - 1) / (targetLength - 1);
    const left = Math.floor(position), right = Math.min(features.length - 1, left + 1);
    const fraction = position - left;
    output.push(features[left].map((value, j) => value + (features[right][j] - value) * fraction));
  }
  return output;
}

function compareFeatures(left, right) {
  if (left.length !== right.length || !left.length) throw new TypeError('Последовательности признаков несовместимы');
  let total = 0, weights = 0;
  for (let i = 0; i < left.length; i++) {
    for (let j = 0; j < FEATURE_WEIGHTS.length; j++) {
      total += Math.abs(left[i][j] - right[i][j]) * FEATURE_WEIGHTS[j];
      weights += FEATURE_WEIGHTS[j];
    }
  }
  return clamp(100 * (1 - total / weights), 0, 100);
}

function prepareExamples(examples, timeframe, options = {}) {
  if (!Array.isArray(examples)) throw new TypeError('examples должен быть массивом');
  if (!Object.prototype.hasOwnProperty.call(TIMEFRAME_MS, timeframe)) throw new TypeError('Неподдерживаемый таймфрейм');
  const config = validateOptions(options);
  const items = [];
  let skipped = 0;
  for (const example of examples.slice(0, config.maxExamples)) {
    if (!example || String(example.timeframe || '').toUpperCase() !== timeframe) { skipped++; continue; }
    const sampleEntryAt = Number(example.entryAt);
    const sampleSegmentEnd = Number(example.segmentEnd ?? example.entryAt);
    const sampleExpirySeconds = Number(example.expirySeconds);
    const outcomeKnownAt = Math.max(
      sampleSegmentEnd,
      sampleEntryAt + (Number.isFinite(sampleExpirySeconds) && sampleExpirySeconds > 0 ? sampleExpirySeconds * 1000 : 0)
    );
    if (!Number.isSafeInteger(sampleEntryAt) || !Number.isSafeInteger(sampleSegmentEnd) ||
        sampleSegmentEnd < sampleEntryAt || !Number.isSafeInteger(outcomeKnownAt)) {
      skipped++; continue;
    }
    const direction = String(example.direction || '').toUpperCase();
    const asset = String(example.asset || '').toUpperCase();
    if (!['UP', 'DOWN'].includes(direction) || !asset.endsWith('_OTC')) { skipped++; continue; }
    if (!Array.isArray(example.inputCandles) || example.inputCandles.length < 3) { skipped++; continue; }
    try {
      const sample = example.inputCandles.slice(-config.lookback).map(candle => {
        const normalized = validateCandle(candle, timeframe, 'Исторический пример');
        if (normalized.endAt > sampleEntryAt) throw new TypeError('future leakage');
        if (candle.asset && String(candle.asset).toUpperCase() !== asset) throw new TypeError('asset mismatch');
        if (candle.timeframe && String(candle.timeframe).toUpperCase() !== timeframe) throw new TypeError('timeframe mismatch');
        return { ...normalized, complete: true };
      });
      for (let i = 1; i < sample.length; i++) {
        if (sample[i].startAt !== sample[i - 1].startAt + TIMEFRAME_MS[timeframe]) throw new TypeError('gap in sample');
      }
      const features = resample(extractFeatures(sample, timeframe), config.lookback);
      items.push({
        id: String(example.id || ''), asset, timeframe, direction,
        similarityOutcome: ['WIN', 'LOSS', 'DRAW'].includes(example.outcome) ? example.outcome : 'UNKNOWN',
        expirySeconds: Number.isFinite(sampleExpirySeconds) && sampleExpirySeconds > 0 ? sampleExpirySeconds : null,
        entryAt: sampleEntryAt, outcomeKnownAt, features
      });
    } catch (_) { skipped++; }
  }
  return { items, skipped };
}

function analyzeSimilarity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Параметры анализа должны быть объектом');
  const timeframe = String(input.timeframe || '').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(TIMEFRAME_MS, timeframe)) throw new TypeError('Неподдерживаемый таймфрейм');
  const entryAt = Number(input.entryAt);
  if (!Number.isSafeInteger(entryAt) || entryAt <= 0) throw new TypeError('entryAt должен быть Unix timestamp в миллисекундах');
  const options = validateOptions(input.options);
  const queryCandles = input.candles;
  if (!Array.isArray(queryCandles) || queryCandles.length < options.lookback) {
    return { status: 'NO_SIGNAL', reason: 'insufficient_live_history', timeframe, entryAt, options, matches: [], qualifiedMatches: [], votes: { UP: 0, DOWN: 0 }, winRate: null };
  }
  const queryWindow = queryCandles.slice(-options.lookback).map(candle => {
    const normalized = validateCandle(candle, timeframe, 'Текущий график');
    if (normalized.endAt > entryAt) throw new TypeError('Будущая или незакрытая свеча попала в запрос анализа');
    if (candle.timeframe && String(candle.timeframe).toUpperCase() !== timeframe) throw new TypeError('Таймфрейм текущей свечи не совпадает с запросом');
    if (typeof candle.asset !== 'string' || !candle.asset.toUpperCase().endsWith('_OTC')) throw new TypeError('Текущий график должен относиться к OTC-активу');
    return { ...normalized, asset: candle.asset.toUpperCase(), complete: true };
  });
  if (queryWindow.some(candle => candle.asset !== queryWindow[0].asset)) throw new TypeError('В запросе смешаны разные OTC-пары');
  for (let i = 1; i < queryWindow.length; i++) {
    if (queryWindow[i].startAt <= queryWindow[i - 1].startAt) throw new TypeError('Текущие свечи должны идти строго по времени');
  }
  const queryFeatures = extractFeatures(queryWindow, timeframe);

  const prepared = Array.isArray(input.preparedExamples)
    ? { items: input.preparedExamples, skipped: Number(input.skippedExamples) || 0 }
    : prepareExamples(input.examples, timeframe, options);
  const matches = [];
  let skipped = prepared.skipped;
  for (const sample of prepared.items) {
    if (!sample || sample.timeframe !== timeframe || sample.entryAt >= entryAt || sample.outcomeKnownAt > entryAt) {
      skipped++; continue;
    }
    const similarity = compareFeatures(queryFeatures, sample.features);
    matches.push({
      id: sample.id,
      asset: sample.asset,
      timeframe,
      direction: sample.direction,
      similarity: Number(similarity.toFixed(2)),
      outcome: sample.similarityOutcome,
      expirySeconds: sample.expirySeconds,
      entryAt: sample.entryAt
    });
  }

  matches.sort((a, b) => b.similarity - a.similarity || b.entryAt - a.entryAt || a.id.localeCompare(b.id));
  const topMatches = matches.slice(0, options.topK);
  const qualifiedMatches = topMatches.filter(match => match.similarity >= options.minSimilarity);
  const votes = {
    UP: qualifiedMatches.filter(match => match.direction === 'UP').length,
    DOWN: qualifiedMatches.filter(match => match.direction === 'DOWN').length
  };
  let direction = 'NONE', reason = 'insufficient_directional_consensus';
  if (qualifiedMatches.length < options.minExamples) reason = 'insufficient_similar_examples';
  else if (votes.UP >= options.minDirectionVotes && votes.UP > votes.DOWN) { direction = 'UP'; reason = 'directional_consensus'; }
  else if (votes.DOWN >= options.minDirectionVotes && votes.DOWN > votes.UP) { direction = 'DOWN'; reason = 'directional_consensus'; }
  else if (votes.UP === votes.DOWN) reason = 'conflicting_directions';

  const directional = direction === 'NONE' ? [] : qualifiedMatches.filter(match => match.direction === direction);
  const resolved = directional.filter(match => match.outcome === 'WIN' || match.outcome === 'LOSS');
  const wins = resolved.filter(match => match.outcome === 'WIN').length;
  const losses = resolved.length - wins;
  const winRate = resolved.length ? Number((wins / resolved.length * 100).toFixed(2)) : null;

  return {
    status: direction === 'NONE' ? 'NO_SIGNAL' : 'SIGNAL',
    direction,
    reason,
    timeframe,
    entryAt,
    options,
    matches: topMatches,
    qualifiedMatches,
    votes,
    averageSimilarity: qualifiedMatches.length
      ? Number((qualifiedMatches.reduce((sum, match) => sum + match.similarity, 0) / qualifiedMatches.length).toFixed(2)) : null,
    historical: { wins, losses, draws: directional.filter(m => m.outcome === 'DRAW').length, unknown: directional.filter(m => m.outcome === 'UNKNOWN').length, winRate },
    skippedExamples: skipped
  };
}


/**
 * Chronological walk-forward evaluation over labelled examples.
 * A sample is tested only against examples whose entryAt is strictly earlier.
 * The target direction is the manually selected direction for WIN and its
 * opposite for LOSS; DRAW/UNKNOWN are excluded from accuracy.
 */
function evaluateWalkForward(examples, options = {}) {
  if (!Array.isArray(examples)) throw new TypeError('examples должен быть массивом');
  const config = validateOptions(options);
  const ordered = examples.slice().filter(example => example && Number.isSafeInteger(Number(example.entryAt)))
    .sort((a, b) => Number(a.entryAt) - Number(b.entryAt) || String(a.id || '').localeCompare(String(b.id || '')));
  let evaluated = 0, skippedInsufficientHistory = 0, skippedUnknownOutcome = 0;
  let signals = 0, noSignal = 0, correct = 0, incorrect = 0;
  const results = [];

  const preparedByTimeframe = new Map();
  for (let i = 0; i < ordered.length; i++) {
    const sample = ordered[i];
    if (!['WIN', 'LOSS'].includes(String(sample.outcome || '').toUpperCase())) {
      skippedUnknownOutcome++;
      continue;
    }
    if (!Array.isArray(sample.inputCandles) || sample.inputCandles.length < config.lookback) {
      skippedInsufficientHistory++;
      continue;
    }
    const timeframe = String(sample.timeframe || '').toUpperCase();
    if (!preparedByTimeframe.has(timeframe)) {
      preparedByTimeframe.set(timeframe, prepareExamples(ordered, timeframe, config));
    }
    const prepared = preparedByTimeframe.get(timeframe);
    const analysis = analyzeSimilarity({
      timeframe,
      entryAt: Number(sample.entryAt),
      candles: sample.inputCandles,
      preparedExamples: prepared.items,
      skippedExamples: prepared.skipped,
      options: config
    });
    evaluated++;
    if (analysis.status !== 'SIGNAL') {
      noSignal++;
      results.push({ id: sample.id, status: 'NO_SIGNAL', actualDirection: sample.outcome === 'WIN' ? sample.direction : (sample.direction === 'UP' ? 'DOWN' : 'UP') });
      continue;
    }
    signals++;
    const actualDirection = sample.outcome === 'WIN'
      ? String(sample.direction).toUpperCase()
      : (String(sample.direction).toUpperCase() === 'UP' ? 'DOWN' : 'UP');
    const isCorrect = analysis.direction === actualDirection;
    if (isCorrect) correct++; else incorrect++;
    results.push({
      id: sample.id, status: 'SIGNAL', predictedDirection: analysis.direction,
      actualDirection, correct: isCorrect, similarity: analysis.averageSimilarity,
      votes: analysis.votes
    });
  }

  return {
    timeframe: ordered[0]?.timeframe || null,
    options: config,
    totalExamples: examples.length,
    evaluated,
    skippedInsufficientHistory,
    skippedUnknownOutcome,
    signals,
    noSignal,
    correct,
    incorrect,
    accuracy: signals ? Number((correct / signals * 100).toFixed(2)) : null,
    coverage: evaluated ? Number((signals / evaluated * 100).toFixed(2)) : 0,
    results
  };
}

module.exports = { DEFAULTS, validateOptions, extractFeatures, compareFeatures, prepareExamples, analyzeSimilarity, evaluateWalkForward };
