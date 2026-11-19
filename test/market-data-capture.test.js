'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const MarketDataCapture = require('../core/market-data-capture');
const { MarketDataHub } = require('../core/market-data');

class FakeDebugger extends EventEmitter {
  constructor() { super(); this.attached = false; this.commands = []; this.failEnable = false; }
  isAttached() { return this.attached; }
  attach(version) { if (this.attached) throw new Error('already attached'); this.version = version; this.attached = true; }
  async sendCommand(command) { this.commands.push(command); if (this.failEnable) throw new Error('Network domain failed'); return {}; }
  detach() { if (!this.attached) return; this.attached = false; this.emit('detach', {}, 'target_closed'); }
  frame(requestId, payloadData, opcode = 1) { this.emit('message', {}, 'Network.webSocketFrameReceived', { requestId, response: { payloadData, opcode } }); }
  created(requestId) { this.emit('message', {}, 'Network.webSocketCreated', { requestId }); }
  closed(requestId) { this.emit('message', {}, 'Network.webSocketClosed', { requestId }); }
}

test('attaches CDP Network domain and ingests a WebSocket tick', async () => {
  const debuggerApi = new FakeDebugger(), hub = new MarketDataHub({ timeframes: ['S5'] });
  const notifiedAssets = [];
  const capture = new MarketDataCapture({ debuggerApi, marketDataHub: hub, onTick: asset => notifiedAssets.push(asset) });
  assert.equal(await capture.attach(), true);
  assert.equal(debuggerApi.version, '1.3');
  assert.deepEqual(debuggerApi.commands, ['Network.enable']);
  debuggerApi.created('socket-1');
  debuggerApi.frame('socket-1', '42["updateStream",[["EURUSD_otc",1700000000,1.1]]]');
  assert.deepEqual(hub.getAssets(), ['EURUSD_OTC']);
  assert.equal(hub.getHealth().acceptedTicks, 1);
  assert.deepEqual(notifiedAssets, ['EURUSD_OTC']);
  assert.equal(capture.getStatus().protocol.ticks, 1);
  capture.close();
  assert.equal(debuggerApi.isAttached(), false);
});

test('forwards confirmed broker trade results from WebSocket frames', async () => {
  const debuggerApi = new FakeDebugger();
  const received = [];
  const capture = new MarketDataCapture({
    debuggerApi, marketDataHub: new MarketDataHub({ timeframes: ['S5'] }),
    onTradeResult: item => received.push(item)
  });
  await capture.attach();
  debuggerApi.created('trade-socket');
  debuggerApi.frame('trade-socket', '42["successcloseOrder",{"balance":105,"deals":[{"id":77,"amount":5,"profit":4.5}]}]');
  assert.equal(received.length, 1);
  assert.equal(received[0].brokerTradeId, '77');
  assert.equal(received[0].result, 'WIN');
  assert.equal(received[0].profit, 4.5);
  assert.equal(received[0].balanceAfter, 105);
  assert.equal(capture.getStatus().receivedTradeResults, 1);
  capture.close();
});

test('keeps binary attachment state isolated per WebSocket', async () => {
  const debuggerApi = new FakeDebugger(), hub = new MarketDataHub({ timeframes: ['S5'] });
  const capture = new MarketDataCapture({ debuggerApi, marketDataHub: hub });
  await capture.attach();
  debuggerApi.created('socket-a'); debuggerApi.created('socket-b');
  debuggerApi.frame('socket-a', '451-["updateStream",{"_placeholder":true,"num":0}]');
  debuggerApi.frame('socket-b', '451-["quotes/stream",{"_placeholder":true,"num":0}]');
  debuggerApi.frame('socket-b', Buffer.from('[["GBPUSD_otc",1700000001,1.3]]').toString('base64'), 2);
  debuggerApi.frame('socket-a', Buffer.from('[["EURUSD_otc",1700000000,1.1]]').toString('base64'), 2);
  assert.deepEqual(hub.getAssets(), ['EURUSD_OTC', 'GBPUSD_OTC']);
  assert.equal(hub.getHealth().acceptedTicks, 2);
  capture.close();
});

test('enforces socket capacity and releases closed sockets', async () => {
  const debuggerApi = new FakeDebugger();
  const capture = new MarketDataCapture({ debuggerApi, marketDataHub: new MarketDataHub({ timeframes: ['S5'] }), maxSockets: 1 });
  await capture.attach(); debuggerApi.created('a'); debuggerApi.created('b');
  assert.equal(capture.getStatus().activeSockets, 1);
  debuggerApi.closed('a');
  assert.equal(capture.getStatus().activeSockets, 0);
  capture.close();
});

test('does not detach a debugger owned by another consumer', async () => {
  const debuggerApi = new FakeDebugger(); debuggerApi.attached = true;
  const capture = new MarketDataCapture({ debuggerApi, marketDataHub: new MarketDataHub() });
  assert.equal(await capture.attach(), false);
  assert.equal(capture.getStatus().status, 'unavailable');
  assert.equal(debuggerApi.isAttached(), true);
});

test('handles Network.enable failure and releases its own debugger', async () => {
  const debuggerApi = new FakeDebugger(); debuggerApi.failEnable = true;
  const capture = new MarketDataCapture({ debuggerApi, marketDataHub: new MarketDataHub() });
  assert.equal(await capture.attach(), false);
  assert.equal(capture.getStatus().status, 'error');
  assert.equal(debuggerApi.isAttached(), false);
});

test('does not report listening when the target closes during Network.enable', async () => {
  const debuggerApi = new FakeDebugger();
  let release;
  debuggerApi.sendCommand = () => new Promise(resolve => { release = resolve; });
  const capture = new MarketDataCapture({ debuggerApi, marketDataHub: new MarketDataHub() });
  const attaching = capture.attach();
  await Promise.resolve();
  capture.close();
  release({});
  assert.equal(await attaching, false);
  assert.equal(capture.getStatus().status, 'stopped');
  assert.equal(capture.getStatus().attached, false);
});

test('uses updateAssets catalog to admit only confirmed OTC assets', async () => {
  const debuggerApi = new FakeDebugger();
  const hub = new MarketDataHub({ timeframes: ['S5'] });
  const capture = new MarketDataCapture({ debuggerApi, marketDataHub: hub });
  await capture.attach();
  debuggerApi.created('socket');
  debuggerApi.frame('socket', '42["updateAssets",[[1,"EURUSD","EUR/USD"],[2,"EURUSD_otc","EUR/USD OTC"],[3,"GBPUSD_otc","GBP/USD OTC"],[4,"USDJPY","USD/JPY"]]]');
  debuggerApi.frame('socket', '42["updateStream",[["EURUSD",1700000000,1.1],["EURUSD_otc",1700000000,1.2],["GBPUSD_otc",1700000000,1.3],["USDJPY",1700000000,1.4],["AUDUSD",1700000000,1.5]]]');
  assert.deepEqual(hub.getAssets(), ['EURUSD_OTC', 'GBPUSD_OTC']);
  assert.equal(hub.getHealth().acceptedTicks, 2);
  assert.equal(capture.getStatus().rejectedAmbiguousAssets, 1);
  assert.equal(capture.getStatus().rejectedNonOtcAssets, 1);
  assert.equal(capture.getStatus().rejectedUnknownAssets, 1);
  assert.equal(capture.getStatus().catalog.otc, 2);
  capture.close();
});

test('counts rejected rows in unsupported historical timeframe payloads', async () => {
  const debuggerApi = new FakeDebugger();
  const capture = new MarketDataCapture({ debuggerApi, marketDataHub: new MarketDataHub({ timeframes: ['S5'] }) });
  await capture.attach();
  debuggerApi.created('history-socket');
  debuggerApi.frame('history-socket', '42["updateHistoryNewFast",{"asset":"EURUSD_otc","period":7,"history":[[1700000000,1.1,1.2,1.0,1.15]]}]');
  assert.equal(capture.getStatus().rejectedHistoryRows, 1);
  capture.close();
});

test('captures historical OHLC events for confirmed OTC assets', async () => {
  const debuggerApi = new FakeDebugger();
  const hub = new MarketDataHub({ timeframes: ['S5'] });
  const capture = new MarketDataCapture({ debuggerApi, marketDataHub: hub });
  await capture.attach();
  debuggerApi.created('history-socket');
  debuggerApi.frame('history-socket', '42["updateHistoryNewFast",{"asset":"EURUSD_otc","period":5,"history":[[1700000000,1.1,1.3,1.0,1.2],[1700000005,1.2,1.4,1.1,1.3]]}]');
  const candles = hub.getCandles('EURUSD_OTC', 'S5');
  assert.equal(candles.length, 2);
  assert.equal(candles[0].high, 1.3);
  assert.equal(candles[1].close, 1.3);
  assert.equal(hub.getDirtyCompletedCandles(Date.now()).length, 2);
  assert.equal(capture.getStatus().catalog.otc, 1);
  capture.close();
});

test('counts broker trade results intentionally filtered by the application', async () => {
  const debuggerApi = new FakeDebugger();
  const capture = new MarketDataCapture({
    debuggerApi, marketDataHub: new MarketDataHub({ timeframes: ['S5'] }),
    onTradeResult: () => false
  });
  await capture.attach();
  debuggerApi.created('trade-socket');
  debuggerApi.frame('trade-socket', '42["successcloseOrder",{"deals":[{"id":88,"amount":2,"profit":1.7}]}]');
  assert.equal(capture.getStatus().receivedTradeResults, 0);
  assert.equal(capture.getStatus().rejectedTradeResults, 1);
  capture.close();
});
