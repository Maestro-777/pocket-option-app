'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PocketOptionProtocol, normalizeStreamTicks, normalizeTradeResults, toMilliseconds } = require('../core/pocketoption-protocol');

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

test('normalizes successcloseOrder results and balance without duplicating page-load history', () => {
  const results = normalizeTradeResults('successcloseOrder', {
    balance: 105.5,
    deals: [
      { id: 123, asset: 'EURUSD_otc', timeframe: 'S5', direction: 'call', amount: 5, profit: 4.5, percentProfit: 90, closeTime: 1699999999 },
      { ticket: 't-2', amount: 2, profit: 0 }
    ]
  }, 1700000000000);
  assert.equal(results.length, 2);
  assert.deepEqual(
    { id: results[0].brokerTradeId, asset: results[0].asset, timeframe: results[0].timeframe, direction: results[0].direction, amount: results[0].amount, profit: results[0].profit, result: results[0].result, balance: results[0].balanceAfter },
    { id: '123', asset: 'EURUSD_otc', timeframe: 'S5', direction: 'UP', amount: 5, profit: 4.5, result: 'WIN', balance: 105.5 }
  );
  assert.equal(results[0].closedAt, 1699999999000);
  assert.equal(results[1].profit, -2);
  assert.equal(results[1].result, 'LOSS');
  assert.deepEqual(normalizeTradeResults('orders/closed/list', [{ id: 1, profit: 5 }]), []);
});

test('normalizes legacy close events including draw results', () => {
  const results = normalizeTradeResults('s_orders/close', [[
    { id: 7, amount: 3, status: 'draw', profit: 0 },
    { id: 8, amount: 4, status: 'win', profit: 3.6 },
    { id: 9, amount: 2, status: 'lose', profit: 0 }
  ]], 1700000001000);
  assert.deepEqual(results.map(item => [item.result, item.profit]), [['DRAW', 0], ['WIN', 3.6], ['LOSS', -2]]);
});

test('uses receive time for object-shaped stream rows without timestamps', () => {
  const receivedAt = 1700000000123;
  const ticks = normalizeStreamTicks('updateStream', [
    { asset: 'EURUSD_otc', prices: [{ time: 1700000000, price: 1.2 }, { ts: 1700000001, p: 1.3 }] },
    { asset: 'GBPUSD_otc', price: 2 },
    { asset: 'AUDUSD_otc', price: 1, timestamp: 1700000002 }
  ], receivedAt);
  assert.equal(ticks.length, 4);
  assert.equal(ticks[2].asset, 'GBPUSD_otc');
  assert.equal(ticks[2].ts, receivedAt);
  assert.equal(ticks[3].asset, 'AUDUSD_otc');
});

test('uses receive time for documented live tick shapes without timestamps', () => {
  const receivedAt = 1700000000123;
  const ticks = normalizeStreamTicks('updateStream', [
    ['EURUSD_otc', 0, 1.2],
    { asset: 'GBPUSD_otc', price: 1.3 },
    { asset: 'AUDUSD_otc', prices: [{ price: 1.4 }] }
  ], receivedAt);
  assert.equal(ticks.length, 3);
  assert.ok(ticks.every(tick => tick.ts === receivedAt));
});

test('normalizes numeric broker timeframe and creates stable trade result identity', () => {
  const results = normalizeTradeResults('successcloseOrder', {
    deals: [
      { id: 'abc-1', asset: 'EURUSD_otc', period: 5, direction: 'put', amount: 2, profit: 1.7 },
      { id: 'missing-amount', asset: 'EURUSD_otc', period: 5, profit: 1.7 }
    ]
  }, 1700000000000);
  assert.equal(results.length, 1);
  assert.equal(results[0].timeframe, 'S5');
  assert.equal(results[0].direction, 'DOWN');
  assert.equal(results[0].eventKey, 'broker:abc-1');
});

test('normalizes every trade in a flat legacy close array', () => {
  const results = normalizeTradeResults('s_orders/close', [
    { id: 'flat-1', amount: 2, profit: 1.7, status: 'win' },
    { id: 'flat-2', amount: 3, profit: 0, status: 'lose' }
  ], 1700000001000);
  assert.deepEqual(results.map(item => item.brokerTradeId), ['flat-1', 'flat-2']);
  assert.deepEqual(results.map(item => item.result), ['WIN', 'LOSS']);
});
