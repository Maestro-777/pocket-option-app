'use strict';

const { SUPPORTED_EVENTS } = require('./market-data');

const MAX_BATCH_ITEMS = 8;
const MAX_BATCH_BYTES = 512 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;

function isAllowedPocketOptionUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'pocketoption.com' || host.endsWith('.pocketoption.com'));
  } catch (_) {
    return false;
  }
}

function isTrustedPocketOptionFrame(event, expectedSender, fallbackUrl) {
  if (!event || !expectedSender || event.sender !== expectedSender) return false;
  const frameUrl = event.senderFrame?.url || fallbackUrl;
  return isAllowedPocketOptionUrl(frameUrl);
}

function validateBalancePayload(payload, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const lastMessageAt = Number(options.lastMessageAt) || 0;
  const lastTimestamp = Number(options.lastTimestamp) || 0;
  const maxAgeMs = Number(options.maxAgeMs) || 10_000;
  const maxFutureMs = Number(options.maxFutureMs) || 2_000;
  const minIntervalMs = Number(options.minIntervalMs) || 250;

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!['demo', 'real'].includes(payload.accountType)) return null;
  if (!Number.isFinite(payload.balance) || payload.balance < 0) return null;
  const ts = Number(payload.ts);
  if (!Number.isFinite(ts) || ts > now + maxFutureMs || now - ts > maxAgeMs) return null;
  if (now - lastMessageAt < minIntervalMs || ts < lastTimestamp) return null;

  return {
    accountType: payload.accountType,
    balance: payload.balance,
    currency: String(payload.currency || '').slice(0, 8),
    ts
  };
}

function validateMarketBatch(batch, now = Date.now()) {
  if (!Array.isArray(batch) || batch.length === 0 || batch.length > MAX_BATCH_ITEMS) return [];
  let encoded;
  try {
    encoded = JSON.stringify(batch);
  } catch (_) {
    return [];
  }
  if (!encoded || encoded.length > MAX_BATCH_BYTES) return [];

  const safe = [];
  for (const item of batch) {
    if (!item || !SUPPORTED_EVENTS.has(item.eventName) || item.payload == null) continue;
    let payloadText;
    try {
      payloadText = JSON.stringify(item.payload);
    } catch (_) {
      continue;
    }
    if (!payloadText || payloadText.length > MAX_EVENT_BYTES) continue;
    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch (_) {
      continue;
    }
    const receivedAt = Number(item.receivedAt);
    const safeReceivedAt = Number.isFinite(receivedAt) && receivedAt <= now + 5000 && receivedAt >= now - 60_000
      ? receivedAt
      : now;
    safe.push({ eventName: item.eventName, payload, receivedAt: safeReceivedAt });
  }
  return safe;
}

module.exports = {
  MAX_BATCH_ITEMS,
  MAX_BATCH_BYTES,
  MAX_EVENT_BYTES,
  isAllowedPocketOptionUrl,
  isTrustedPocketOptionFrame,
  validateBalancePayload,
  validateMarketBatch
};
