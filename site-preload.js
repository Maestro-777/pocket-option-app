'use strict';
const { ipcRenderer, webFrame } = require('electron');

const MARKET_EVENTS = new Set([
  'updateAssets', 'updateStream', 'quotes/stream', 'updateHistoryNewFast',
  'updateHistoryNew', 'loadHistoryPeriod', 'loadHistoryPeriodFast', 'history/list/v2'
]);

// Runs in the page's MAIN world from the document-start preload. It only observes
// allow-listed market-data events; it never sends commands or modifies trade UI.
function installMarketWebSocketTap() {
  if (window.__PT_MARKET_WS_TAP__) return 'already-installed';
  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket !== 'function') return 'websocket-unavailable';
  window.__PT_MARKET_WS_TAP__ = true;

  const allowed = new Set([
    'updateAssets', 'updateStream', 'quotes/stream', 'updateHistoryNewFast',
    'updateHistoryNew', 'loadHistoryPeriod', 'loadHistoryPeriodFast', 'history/list/v2'
  ]);
  const pending = new WeakMap();
  let queue = [];
  let flushTimer = null;

  function flush() {
    flushTimer = null;
    if (!queue.length) return;
    const batch = queue.splice(0, 8);
    try {
      window.postMessage({ type: 'PT_PO_MARKET_BATCH', events: batch }, location.origin);
    } catch (_) {}
    if (queue.length) flushTimer = setTimeout(flush, 50);
  }

  function publish(eventName, payload) {
    if (!allowed.has(eventName) || payload == null) return;
    try {
      const encoded = JSON.stringify(payload);
      if (!encoded || encoded.length > 256 * 1024) return;
      queue.push({ eventName, payload: JSON.parse(encoded), receivedAt: Date.now() });
      if (queue.length >= 8) {
        if (flushTimer) clearTimeout(flushTimer);
        flush();
      } else if (!flushTimer) {
        flushTimer = setTimeout(flush, 50);
      }
    } catch (_) {}
  }

  function parsePacket(raw, socket) {
    let text;
    if (typeof raw === 'string') text = raw;
    else if (raw instanceof ArrayBuffer) text = new TextDecoder('utf-8').decode(new Uint8Array(raw));
    else return;

    const start = text.search(/[\\[{]/);
    if (start < 0) return;
    let parsed;
    try { parsed = JSON.parse(text.slice(start)); } catch (_) { return; }

    if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
      const eventName = parsed[0];
      const payload = parsed[1];
      if (!allowed.has(eventName)) return;
      if (payload && payload._placeholder === true) {
        const list = pending.get(socket) || [];
        list.push(eventName);
        pending.set(socket, list);
        return;
      }
      publish(eventName, payload);
      return;
    }

    const list = pending.get(socket) || [];
    if (list.length) {
      const eventName = list.shift();
      pending.set(socket, list);
      publish(eventName, parsed);
    }
  }

  class MarketTapWebSocket extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', event => {
        if (typeof event.data === 'string' || event.data instanceof ArrayBuffer) {
          parsePacket(event.data, this);
        } else if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
          event.data.arrayBuffer().then(buffer => parsePacket(buffer, this)).catch(() => {});
        }
      });
    }
  }
  window.WebSocket = MarketTapWebSocket;
  return 'installed';
}

window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.type !== 'PT_PO_BALANCE') return;
  const balance = Number(data.balance);
  if (!['demo', 'real'].includes(data.accountType) || !Number.isFinite(balance) || balance < 0) return;
  ipcRenderer.send('site:balance', {
    accountType: data.accountType, balance,
    currency: String(data.currency || '').slice(0, 8),
    ts: Number(data.ts) || Date.now()
  });
});

window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data && event.data.type === 'PT_PO_LOG') {
    ipcRenderer.send('site:log', { message: String(event.data.message || '').slice(0, 300), level: event.data.level });
  }
});

let marketBatchWindowAt = 0;
let marketBatchCount = 0;
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.type !== 'PT_PO_MARKET_BATCH' || !Array.isArray(data.events)) return;
  const now = Date.now();
  if (now - marketBatchWindowAt >= 1000) {
    marketBatchWindowAt = now;
    marketBatchCount = 0;
  }
  if (++marketBatchCount > 60) return;
  const events = [];
  for (const item of data.events.slice(0, 8)) {
    if (!item || !MARKET_EVENTS.has(item.eventName) || item.payload == null) continue;
    const receivedAt = Number(item.receivedAt);
    events.push({
      eventName: item.eventName,
      payload: item.payload,
      receivedAt: Number.isFinite(receivedAt) ? receivedAt : now
    });
  }
  if (!events.length) return;
  try {
    if (JSON.stringify(events).length > 512 * 1024) return;
  } catch (_) { return; }
  ipcRenderer.send('site:market-batch', events);
});

try {
  webFrame.executeJavaScript('(' + installMarketWebSocketTap.toString() + ')()')
    .then(result => ipcRenderer.send('site:log', { message: 'Market WebSocket tap: ' + String(result), level: 'info' }))
    .catch(error => ipcRenderer.send('site:log', { message: 'Market WebSocket tap failed: ' + String(error).slice(0, 240), level: 'error' }));
} catch (error) {
  ipcRenderer.send('site:log', { message: 'Market WebSocket tap unavailable: ' + String(error).slice(0, 240), level: 'error' });
}
