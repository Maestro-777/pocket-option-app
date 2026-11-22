'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'site-preload.js'), 'utf8');

class FakeWebSocket {
  constructor() { this.readyState = 1; this.listeners = {}; this.sent = []; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  send(data) { this.sent.push(data); }
  emit(data) { for (const fn of this.listeners.message || []) fn({ data }); }
}

function setup() {
  const preloadListeners = {};
  const pageListeners = {};
  const posted = [];
  let pageScript = '';
  const ipcRenderer = {
    on(name, fn) { (preloadListeners[name] ||= []).push(fn); },
    send() {}
  };
  const window = {
    addEventListener(name, fn) { (pageListeners[name] ||= []).push(fn); },
    postMessage(data, origin) { posted.push({ data, origin }); }
  };
  const sandbox = {
    require(name) {
      assert.equal(name, 'electron');
      return { ipcRenderer, webFrame: { executeJavaScript(script) { pageScript = script; return Promise.resolve('installed'); } } };
    },
    window, location: { origin: 'https://pocketoption.com', hostname: 'pocketoption.com' },
    URL, Date, JSON, Number, String, Math, Set, Map, WeakMap, Array, Object, RegExp,
    Promise, setTimeout, clearTimeout, TextDecoder, Uint8Array, ArrayBuffer, Blob
  };
  vm.runInNewContext(source, sandbox, { filename: 'site-preload.js' });
  const pageWindow = {
    WebSocket: FakeWebSocket,
    addEventListener(name, fn) { (pageListeners[name] ||= []).push(fn); },
    postMessage(data, origin) { posted.push({ data, origin }); },
    __PT_ACTIVE_MARKET_SOCKETS__: []
  };
  const pageContext = {
    window: pageWindow, location: sandbox.location, Date, JSON, Number, String, Math,
    Set, Map, WeakMap, Array, Object, RegExp, Promise, setTimeout, clearTimeout,
    TextDecoder, Uint8Array, ArrayBuffer, Blob
  };
  vm.runInNewContext(pageScript, pageContext, { filename: 'market-tap.js' });
  return { pageWindow, pageContext, posted, pageListeners };
}

test('associates an unlabelled history response with its sole pending request', async () => {
  const { pageWindow, posted, pageListeners } = setup();
  const ws = new pageWindow.WebSocket();
  ws.emit('42["updateStream",[["EURUSD_otc",1700000000,1.1]]]');
  for (const fn of pageListeners.message || []) {
    fn({ source: pageWindow, origin: 'https://pocketoption.com',
      data: { type: 'PT_REQUEST_HISTORY', asset: 'AUDCAD_OTC', period: 5, requestId: 'history-test-1' } });
  }
  assert.ok(ws.sent.some(frame => frame.includes('"loadHistoryPeriod"')));
  ws.emit('42["loadHistoryPeriod",{"history":[[1700000000,0.9948,0.9950,0.9947,0.9949]]}]');
  await new Promise(resolve => setTimeout(resolve, 60));
  const batch = posted.find(item => item.data?.type === 'PT_PO_MARKET_BATCH');
  assert.ok(batch);
  const event = batch.data.events.find(item => item.eventName === 'loadHistoryPeriod');
  assert.equal(event.payload.asset, 'AUDCAD_otc');
  assert.equal(event.payload.period, 5);
  assert.equal(event.payload.__ptRequest.requestId, 'history-test-1');
});

test('does not guess when multiple pending history requests have no identifying metadata', async () => {
  const { pageWindow, posted, pageListeners } = setup();
  const ws = new pageWindow.WebSocket();
  ws.emit('42["updateStream",[["EURUSD_otc",1700000000,1.1]]]');
  for (const request of [
    { asset: 'AUDCAD_OTC', period: 5, requestId: 'history-a' },
    { asset: 'EURGBP_OTC', period: 5, requestId: 'history-b' }
  ]) for (const fn of pageListeners.message || []) {
    fn({ source: pageWindow, origin: 'https://pocketoption.com', data: { type: 'PT_REQUEST_HISTORY', ...request } });
  }
  ws.emit('42["loadHistoryPeriod",{"history":[[1700000000,0.9948,0.9950,0.9947,0.9949]]}]');
  const batch = posted.find(item => item.data?.type === 'PT_PO_MARKET_BATCH');
  const event = batch.data.events.find(item => item.eventName === 'loadHistoryPeriod');
  assert.equal(event.payload.asset, undefined);
  assert.equal(event.payload.__ptRequest, undefined);
});
