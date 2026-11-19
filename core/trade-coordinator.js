'use strict';

const { TIMEFRAME_MS } = require('./timeframes');
const { rankSignals } = require('./signal-ranking');

function signalKey(signal) {
  const asset = String(signal?.asset || '').trim().toUpperCase();
  const timeframe = String(signal?.timeframe || '').trim().toUpperCase();
  const direction = String(signal?.direction || '').toUpperCase();
  const latest = Array.isArray(signal?.queryCandles) ? signal.queryCandles[signal.queryCandles.length - 1] : null;
  const barStartAt = Number(signal?.barStartAt ?? latest?.startAt);
  if (!asset.endsWith('_OTC') || !Object.prototype.hasOwnProperty.call(TIMEFRAME_MS, timeframe) ||
      !['UP', 'DOWN'].includes(direction) || !Number.isSafeInteger(barStartAt) || barStartAt <= 0) {
    throw new TypeError('Сигнал не содержит валидную OTC-пару, таймфрейм, направление и время свечи');
  }
  // One market bar is one entry opportunity; a late direction revision must not
  // permit a second, opposite-side entry for the same pair/timeframe/bar.
  return [asset, timeframe, barStartAt].join('|');
}

/**
 * Reserve available trade slots from a simultaneous signal batch.
 * This module does not execute orders; it only enforces the agreed guards.
 */
function planTradeIntents(signals, options = {}) {
  if (!Array.isArray(signals)) throw new TypeError('signals должен быть массивом');
  const maxOpenTrades = options.maxOpenTrades == null ? 1 : Number(options.maxOpenTrades);
  const openTradeCount = options.openTradeCount == null ? 0 : Number(options.openTradeCount);
  if (!Number.isInteger(maxOpenTrades) || maxOpenTrades < 1 || maxOpenTrades > 10) throw new RangeError('maxOpenTrades должен быть от 1 до 10');
  if (!Number.isInteger(openTradeCount) || openTradeCount < 0) throw new RangeError('openTradeCount должен быть неотрицательным целым числом');
  const existing = new Set(Array.isArray(options.existingSignalKeys) ? options.existingSignalKeys.map(String) : []);
  const rejected = [];
  const valid = [];

  for (const signal of signals) {
    if (signal?.status && signal.status !== 'SIGNAL') {
      rejected.push({ signal, signalKey: null, reason: 'not_a_signal' });
      continue;
    }
    const key = signalKey(signal);
    if (existing.has(key)) {
      rejected.push({ signal, signalKey: key, reason: 'duplicate_signal' });
    } else {
      existing.add(key);
      valid.push({ ...signal, signalKey: key });
    }
  }

  if (options.paused === true) {
    return { selected: [], rejected: rejected.concat(valid.map(signal => ({ signal, signalKey: signal.signalKey, reason: 'trading_paused' }))), availableSlots: Math.max(0, maxOpenTrades - openTradeCount) };
  }
  if (options.tradingEnabled !== true) {
    return { selected: [], rejected: rejected.concat(valid.map(signal => ({ signal, signalKey: signal.signalKey, reason: 'trading_disabled' }))), availableSlots: Math.max(0, maxOpenTrades - openTradeCount) };
  }

  const availableSlots = Math.max(0, maxOpenTrades - openTradeCount);
  if (availableSlots === 0) {
    return { selected: [], rejected: rejected.concat(valid.map(signal => ({ signal, signalKey: signal.signalKey, reason: 'open_trade_limit' }))), availableSlots };
  }

  const ranked = rankSignals(valid);
  const selected = ranked.slice(0, availableSlots);
  const overflow = ranked.slice(availableSlots);
  for (const signal of overflow) rejected.push({ signal, signalKey: signal.signalKey, reason: 'open_trade_limit' });
  return { selected, rejected, availableSlots };
}

module.exports = { signalKey, planTradeIntents };
