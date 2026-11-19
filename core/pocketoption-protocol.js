'use strict';

function parseJsonPayload(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 2_000_000) return null;
  const start = text.search(/[\\[{]/);
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch (_) { return null; }
}

function toMilliseconds(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const milliseconds = timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}


const { TIMEFRAME_MS } = require('./timeframes');
const crypto = require('node:crypto');
const HISTORY_EVENTS = new Set(['updateHistoryNewFast', 'updateHistoryNew', 'loadHistoryPeriod', 'loadHistoryPeriodFast', 'history/list/v2']);

function detectHistoryOhlcLayout(rows) {
  let openCloseHighLow = 0, openHighLowClose = 0, checked = 0;
  for (const row of rows) {
    if (checked >= 40) break;
    if (!Array.isArray(row) || row.length < 5) continue;
    const values = row.slice(1, 5).map(Number);
    if (!values.every(value => Number.isFinite(value) && value > 0)) continue;
    checked++;
    const high = Math.max(...values), low = Math.min(...values);
    if (values[2] === high && values[3] === low) openCloseHighLow++;
    if (values[1] === high && values[2] === low) openHighLowClose++;
  }
  if (!checked) return null;
  if (openCloseHighLow >= openHighLowClose && openCloseHighLow > 0) return { open: 1, close: 2, high: 3, low: 4 };
  if (openHighLowClose > 0) return { open: 1, high: 2, low: 3, close: 4 };
  return null;
}

function normalizeHistoryCandles(eventName, payload, options = {}) {
  if (!HISTORY_EVENTS.has(eventName)) return { asset: null, timeframe: null, candles: [], skippedRows: 0 };
  const data = Array.isArray(payload) ? payload[0] : payload;
  if (!data || typeof data !== 'object' || typeof data.asset !== 'string') {
    return { asset: null, timeframe: null, candles: [], skippedRows: Array.isArray(data) ? data.length : 1 };
  }
  const periodSeconds = Number(data.period);
  const timeframe = Object.keys(TIMEFRAME_MS).find(key => TIMEFRAME_MS[key] / 1000 === periodSeconds);
  const rows = data.history || data.data || data.candles;
  if (!timeframe || !Array.isArray(rows)) {
    return { asset: data.asset, timeframe: null, candles: [], skippedRows: Array.isArray(rows) ? rows.length : 0 };
  }
  const duration = TIMEFRAME_MS[timeframe];
  const layout = detectHistoryOhlcLayout(rows);
  const asOf = options.asOf == null ? Date.now() : Number(options.asOf);
  if (!Number.isSafeInteger(asOf) || asOf <= 0) return { asset: data.asset, timeframe, candles: [], skippedRows: rows.length };
  const candles = [];
  let skippedRows = 0;
  for (const row of rows) {
    let timestamp, open, high, low, close;
    if (Array.isArray(row)) {
      timestamp = toMilliseconds(row[0]);
      if (!layout || row.length < 5) { skippedRows++; continue; }
      open = Number(row[layout.open]); high = Number(row[layout.high]);
      low = Number(row[layout.low]); close = Number(row[layout.close]);
    } else if (row && typeof row === 'object') {
      timestamp = toMilliseconds(row.time ?? row.t ?? row.ts ?? row.timestamp);
      open = Number(row.open ?? row.o); high = Number(row.high ?? row.h);
      low = Number(row.low ?? row.l); close = Number(row.close ?? row.c);
    } else { skippedRows++; continue; }
    if (timestamp == null || ![open, high, low, close].every(value => Number.isFinite(value) && value > 0)) {
      skippedRows++; continue;
    }
    high = Math.max(open, high, low, close);
    low = Math.min(open, high, low, close);
    const startAt = Math.floor(timestamp / duration) * duration;
    const endAt = startAt + duration;
    if (endAt > asOf) { skippedRows++; continue; }
    candles.push({
      asset: data.asset, timeframe, startAt, endAt, openAt: startAt, closeAt: endAt - 1,
      open, high, low, close, tickCount: 1, complete: true
    });
  }
  candles.sort((a, b) => a.startAt - b.startAt);
  if (candles.length > 1000) {
    skippedRows += candles.length - 1000;
    candles.splice(0, candles.length - 1000);
  }
  return { asset: data.asset, timeframe, candles, skippedRows };
}

function normalizeStreamTicks(eventName, payload, receivedAt = Date.now()) {
  if (!['updateStream', 'quotes/stream'].includes(eventName)) return [];
  const rows = Array.isArray(payload) && (Array.isArray(payload[0]) || (payload[0] && typeof payload[0] === 'object')) ? payload : [payload];
  const fallbackTime = Number(receivedAt);
  if (!Number.isSafeInteger(fallbackTime) || fallbackTime <= 0) throw new TypeError('receivedAt должен быть Unix timestamp в миллисекундах');
  const normalizeLiveTime = value => value == null || value === '' || Number(value) === 0 ? fallbackTime : toMilliseconds(value);
  const ticks = [];
  for (const row of rows) {
    if (Array.isArray(row)) {
      if (row.length < 3 || typeof row[0] !== 'string') continue;
      const ts = normalizeLiveTime(row[1]), price = Number(row[2]);
      if (ts == null || !Number.isFinite(price) || price <= 0) continue;
      ticks.push({ asset: row[0], ts, price, sourceEvent: eventName });
      continue;
    }
    if (!row || typeof row !== 'object' || typeof row.asset !== 'string') continue;
    if (Array.isArray(row.prices)) {
      for (const point of row.prices) {
        if (!point || typeof point !== 'object') continue;
        const ts = normalizeLiveTime(point.time ?? point.ts ?? point.timestamp), price = Number(point.price ?? point.p);
        if (ts != null && Number.isFinite(price) && price > 0) ticks.push({ asset: row.asset, ts, price, sourceEvent: eventName });
      }
      continue;
    }
    const ts = normalizeLiveTime(row.time ?? row.ts ?? row.timestamp), price = Number(row.price ?? row.close);
    if (ts != null && Number.isFinite(price) && price > 0) ticks.push({ asset: row.asset, ts, price, sourceEvent: eventName });
  }
  return ticks;
}

/**
 * Decoder for Pocket Option Socket.IO frames documented in pocket-tracker 3.6.0.
 * Binary payloads are UTF-8 JSON, not MessagePack.
 */
function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeTimeframe(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(TIMEFRAME_MS, raw)) return raw;
  const seconds = finiteNumber(value);
  return seconds == null ? null : Object.keys(TIMEFRAME_MS).find(key => TIMEFRAME_MS[key] / 1000 === seconds) || null;
}

function normalizeTradeResults(eventName, payload, receivedAt = Date.now()) {
  const successClose = eventName === 'successcloseOrder';
  const legacyClose = eventName === 's_orders/close' ||
    (typeof eventName === 'string' && eventName.includes('close') &&
      (eventName.includes('option') || eventName.includes('deal')) && !eventName.includes('list'));
  if (!successClose && !legacyClose) return [];
  const closedAt = toMilliseconds(receivedAt) || Date.now();
  const balanceValue = successClose ? finiteNumber(payload?.balance ?? payload?.wallet) : finiteNumber(payload?.balance ?? payload?.wallet);
  let deals;
  if (successClose) deals = Array.isArray(payload?.deals) ? payload.deals : Array.isArray(payload) ? payload : [payload];
  else {
    const first = Array.isArray(payload) ? payload[0] : payload;
    deals = Array.isArray(first) ? first : [first];
  }
  const results = [];
  for (const deal of deals) {
    if (!deal || typeof deal !== 'object') continue;
    const brokerTradeId = deal.id ?? deal.ticket ?? null;
    const amount = finiteNumber(deal.amount ?? deal.investment);
    const rawProfit = finiteNumber(deal.profit ?? 0);
    if (amount == null || amount <= 0 || rawProfit == null) continue;
    let result, profit;
    if (successClose) {
      result = rawProfit > 0 ? 'WIN' : 'LOSS';
      profit = rawProfit > 0 ? rawProfit : -amount;
    } else {
      const status = String(deal.status ?? deal.result ?? deal.state ?? '').toLowerCase();
      if (status === 'draw' || status === 'equal') { result = 'DRAW'; profit = 0; }
      else if (status === 'win' || rawProfit > 0) { result = 'WIN'; profit = rawProfit; }
      else { result = 'LOSS'; profit = -amount; }
    }
    const assetRaw = deal.asset ?? deal.symbol ?? deal.active ?? deal.pair ?? null;
    const timeframeRaw = normalizeTimeframe(deal.timeframe ?? deal.period ?? deal.interval);
    const directionRaw = String(deal.direction ?? deal.action ?? deal.type ?? '').toUpperCase();
    const accountRaw = String(deal.accountMode ?? deal.account_type ?? payload?.accountMode ?? '').toUpperCase();
    results.push({
      brokerTradeId: brokerTradeId == null ? null : String(brokerTradeId),
      asset: typeof assetRaw === 'string' ? assetRaw : null,
      timeframe: timeframeRaw,
      direction: ['UP', 'CALL', 'BUY', 'HIGH'].includes(directionRaw) ? 'UP'
        : ['DOWN', 'PUT', 'SELL', 'LOW'].includes(directionRaw) ? 'DOWN' : null,
      accountMode: accountRaw.includes('DEMO') ? 'DEMO' : accountRaw.includes('REAL') ? 'REAL' : 'UNKNOWN',
      amount, profit, result,
      entryAt: toMilliseconds(deal.openTime ?? deal.open_time ?? deal.createdAt ?? deal.created_at),
      closedAt,
      expirySeconds: finiteNumber(deal.expirySeconds ?? deal.expiration ?? deal.expiry),
      payoutRate: finiteNumber(deal.percentProfit ?? deal.payout ?? deal.payoutRate),
      balanceAfter: balanceValue,
      sourceEvent: eventName
    });
  }
  return results;
}

class PocketOptionProtocol {
  constructor(options = {}) {
    this.maxFrameBytes = options.maxFrameBytes == null ? 2_000_000 : Number(options.maxFrameBytes);
    if (!Number.isInteger(this.maxFrameBytes) || this.maxFrameBytes < 1 || this.maxFrameBytes > 20_000_000) throw new RangeError('maxFrameBytes должен быть целым числом от 1 до 20000000');
    this.pendingEvent = null;
    this.stats = { textFrames: 0, binaryFrames: 0, malformedFrames: 0, events: 0, ticks: 0 };
  }

  decodeFrame(frame, encoding = 'utf8') {
    if (typeof frame === 'string' && encoding === 'base64') return this._decodeBinary(this._toBytes(frame, encoding));
    if (typeof frame === 'string') {
      this.stats.textFrames++;
      const parsed = parseJsonPayload(frame);
      if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return this._malformed();
      const eventName = parsed[0], payload = parsed[1];
      if (payload && payload._placeholder === true) {
        this.pendingEvent = eventName;
        return { eventName, payload: null, ticks: [], pendingAttachment: true };
      }
      this.stats.events++;
      const ticks = normalizeStreamTicks(eventName, payload);
      const tradeResults = normalizeTradeResults(eventName, payload);
      this.stats.ticks += ticks.length;
      return { eventName, payload, ticks, tradeResults, pendingAttachment: false };
    }
    return this._decodeBinary(this._toBytes(frame, encoding));
  }

  _decodeBinary(bytes) {
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > this.maxFrameBytes) return this._malformed();
    this.stats.binaryFrames++;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { return this._malformed(); }
    const parsed = parseJsonPayload(text);
    if (!parsed) return this._malformed();
    const eventName = this.pendingEvent;
    this.pendingEvent = null;
    if (!eventName) return this._malformed();
    this.stats.events++;
    const ticks = normalizeStreamTicks(eventName, parsed);
    const tradeResults = normalizeTradeResults(eventName, parsed);
    this.stats.ticks += ticks.length;
    return { eventName, payload: parsed, ticks, tradeResults, pendingAttachment: false };
  }

  _toBytes(frame, encoding) {
    if (frame instanceof ArrayBuffer) return new Uint8Array(frame);
    if (ArrayBuffer.isView(frame)) return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(frame)) return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    if (typeof frame === 'string' && encoding === 'base64') {
      if (typeof Buffer === 'undefined') return null;
      return new Uint8Array(Buffer.from(frame, 'base64'));
    }
    return null;
  }

  _malformed() { this.stats.malformedFrames++; return null; }
}

module.exports = { PocketOptionProtocol, normalizeStreamTicks, normalizeHistoryCandles, detectHistoryOhlcLayout, toMilliseconds };
