'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAllowedPocketOptionUrl,
  validateBalancePayload,
  validateMarketBatch
} = require('../core/ipc-validation');

test('allows only HTTPS Pocket Option hosts', () => {
  assert.equal(isAllowedPocketOptionUrl('https://pocketoption.com/'), true);
  assert.equal(isAllowedPocketOptionUrl('https://www.pocketoption.com/'), true);
  assert.equal(isAllowedPocketOptionUrl('https://evilpocketoption.com/'), false);
  assert.equal(isAllowedPocketOptionUrl('http://pocketoption.com/'), false);
  assert.equal(isAllowedPocketOptionUrl('not a url'), false);
});

test('accepts fresh valid balance payloads and sanitizes currency', () => {
  const now = 1_700_000_000_000;
  const result = validateBalancePayload({
    accountType: 'demo', balance: 123.45, currency: 'USDT-LONG', ts: now
  }, { now, lastMessageAt: now - 1000, lastTimestamp: now - 1000 });
  assert.deepEqual(result, { accountType: 'demo', balance: 123.45, currency: 'USDT-LON', ts: now });
});

test('rejects stale, future, negative, invalid and too-frequent balance messages', () => {
  const now = 1_700_000_000_000;
  const valid = { accountType: 'real', balance: 1, ts: now };
  assert.equal(validateBalancePayload({ ...valid, ts: now - 10_001 }, { now }), null);
  assert.equal(validateBalancePayload({ ...valid, ts: now + 2_001 }, { now }), null);
  assert.equal(validateBalancePayload({ ...valid, balance: -1 }, { now }), null);
  assert.equal(validateBalancePayload({ ...valid, accountType: 'paper' }, { now }), null);
  assert.equal(validateBalancePayload({ ...valid, ts: 'not-a-time' }, { now }), null);
  assert.equal(validateBalancePayload(valid, { now, lastMessageAt: now - 100 }), null);
  assert.equal(validateBalancePayload(valid, { now, lastTimestamp: now + 1 }), null);
});

test('validates market batch event allow-list, size and timestamp', () => {
  const now = 1_700_000_000_000;
  const batch = [
    { eventName: 'updateStream', payload: [['EURUSD_otc', now / 1000, 1.1]], receivedAt: now - 1000 },
    { eventName: 'trade/open', payload: { amount: 1 }, receivedAt: now },
    { eventName: 'updateAssets', payload: { assets: [] }, receivedAt: now + 60_000 }
  ];
  const result = validateMarketBatch(batch, now);
  assert.equal(result.length, 2);
  assert.equal(result[0].eventName, 'updateStream');
  assert.equal(result[0].receivedAt, now - 1000);
  assert.equal(result[1].receivedAt, now);
});

test('rejects oversized, empty and overlong market batches', () => {
  assert.deepEqual(validateMarketBatch([], Date.now()), []);
  assert.deepEqual(validateMarketBatch(Array.from({ length: 9 }, () => ({
    eventName: 'updateAssets', payload: []
  })), Date.now()), []);
  assert.deepEqual(validateMarketBatch([{
    eventName: 'updateAssets', payload: 'x'.repeat(300_000)
  }], Date.now()), []);
});
