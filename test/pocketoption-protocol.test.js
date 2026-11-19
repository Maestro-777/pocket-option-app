'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PocketOptionProtocol, normalizeStreamTicks, toMilliseconds } = require('../core/pocketoption-protocol');

test('decodes Socket.IO text frames with ticks for multiple assets', () => {
  const decoder = new PocketOptionProtocol();
  const result = decoder.decodeFrame('42["updateStream",[["EURUSD_otc",1700000000,1.1],["GBPUSD_otc",1700000001,1.2]]]');
  assert.equal(result.eventName, 'updateStream');
  assert.equal(result.ticks.length, 2);
  assert.deepEqual(result.ticks.map(t => t.asset), ['EURUSD_otc', 'GBPUSD_otc']);
  assert.equal(result.ticks[0].ts, 1700000000000);
});

test('decodes UTF-8 JSON binary attachment linked to placeholder', () => {
  const decoder = new PocketOptionProtocol();
  assert.equal(decoder.decodeFrame('451-["quotes/stream",{"_placeholder":true,"num":0}]').pendingAttachment, true);
  const bytes = new TextEncoder().encode('[["EURUSD_otc",1700000000,1.25]]');
  const result = decoder.decodeFrame(bytes.buffer);
  assert.equal(result.eventName, 'quotes/stream');
  assert.equal(result.ticks[0].price, 1.25);
  assert.equal(decoder.pendingEvent, null);
});

test('supports CDP base64 binary frame payloads', () => {
  const decoder = new PocketOptionProtocol();
  decoder.decodeFrame('451-["updateStream",{"_placeholder":true,"num":0}]');
  const b64 = Buffer.from('[["EURUSD_otc",1700000000,1.5]]', 'utf8').toString('base64');
  assert.equal(decoder.decodeFrame(b64, 'base64').ticks[0].price, 1.5);
});

test('normalizes seconds and milliseconds and rejects malformed frames', () => {
  assert.equal(toMilliseconds(1700000000), 1700000000000);
  assert.equal(toMilliseconds(1700000000000), 1700000000000);
  assert.equal(toMilliseconds(-1), null);
  assert.deepEqual(normalizeStreamTicks('unrelated', [['EURUSD_otc', 1700000000, 1]]), []);
  const decoder = new PocketOptionProtocol();
  assert.equal(decoder.decodeFrame('not a socket frame'), null);
  assert.equal(decoder.decodeFrame(new Uint8Array([255]).buffer), null);
  assert.equal(decoder.stats.malformedFrames, 2);
});

test('parses object-shaped stream rows only when timestamp is explicit', () => {
  const ticks = normalizeStreamTicks('updateStream', [
    { asset: 'EURUSD_otc', prices: [{ time: 1700000000, price: 1.2 }, { ts: 1700000001, p: 1.3 }] },
    { asset: 'GBPUSD_otc', price: 2 },
    { asset: 'AUDUSD_otc', price: 1, timestamp: 1700000002 }
  ]);
  assert.equal(ticks.length, 3);
  assert.equal(ticks[2].asset, 'AUDUSD_otc');
});
