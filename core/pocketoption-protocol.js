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

function normalizeStreamTicks(eventName, payload) {
  if (!['updateStream', 'quotes/stream'].includes(eventName)) return [];
  const rows = Array.isArray(payload) && (Array.isArray(payload[0]) || (payload[0] && typeof payload[0] === 'object')) ? payload : [payload];
  const ticks = [];
  for (const row of rows) {
    if (Array.isArray(row)) {
      if (row.length < 3 || typeof row[0] !== 'string') continue;
      const ts = toMilliseconds(row[1]), price = Number(row[2]);
      if (ts == null || !Number.isFinite(price) || price <= 0) continue;
      ticks.push({ asset: row[0], ts, price, sourceEvent: eventName });
      continue;
    }
    if (!row || typeof row !== 'object' || typeof row.asset !== 'string') continue;
    if (Array.isArray(row.prices)) {
      for (const point of row.prices) {
        if (!point || typeof point !== 'object') continue;
        const ts = toMilliseconds(point.time ?? point.ts ?? point.timestamp), price = Number(point.price ?? point.p);
        if (ts != null && Number.isFinite(price) && price > 0) ticks.push({ asset: row.asset, ts, price, sourceEvent: eventName });
      }
      continue;
    }
    const ts = toMilliseconds(row.time ?? row.ts ?? row.timestamp), price = Number(row.price ?? row.close);
    if (ts != null && Number.isFinite(price) && price > 0) ticks.push({ asset: row.asset, ts, price, sourceEvent: eventName });
  }
  return ticks;
}

/**
 * Decoder for Pocket Option Socket.IO frames documented in pocket-tracker 3.6.0.
 * Binary payloads are UTF-8 JSON, not MessagePack.
 */
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
      this.stats.ticks += ticks.length;
      return { eventName, payload, ticks, pendingAttachment: false };
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
    this.stats.ticks += ticks.length;
    return { eventName, payload: parsed, ticks, pendingAttachment: false };
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

module.exports = { PocketOptionProtocol, normalizeStreamTicks, toMilliseconds };
