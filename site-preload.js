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
  // Track history requests per socket. A response may inherit the requested
  // asset/period only when exactly one outstanding request can own it.
  const historyRequests = new WeakMap();
  const HISTORY_REQUEST_TTL_MS = 20_000;
  let queue = [];
  let flushTimer = null;

  function readHistoryEnvelope(payload) {
    if (Array.isArray(payload)) {
      const row = payload.find(item => item && typeof item === 'object' && !Array.isArray(item));
      return row || null;
    }
    return payload && typeof payload === 'object' ? payload : null;
  }
  function correlateHistory(eventName, payload, socket) {
    if (!/history|loadHistoryPeriod/i.test(eventName) || eventName === 'updateStream') return payload;
    const requests = (historyRequests.get(socket) || []).filter(item => Date.now() - item.sentAt <= HISTORY_REQUEST_TTL_MS);
    historyRequests.set(socket, requests);
    if (!requests.length) return payload;
    const envelope = readHistoryEnvelope(payload);
    const responseAsset = normalizeAsset(envelope?.asset || envelope?.symbol || '');
    const responseIndex = envelope?.index ?? envelope?.requestId ?? envelope?.request_id;
    let candidates = requests;
    if (responseIndex != null) {
      candidates = candidates.filter(item => String(item.index) === String(responseIndex) || item.requestId === String(responseIndex));
    }
    if (responseAsset) candidates = candidates.filter(item => item.asset === responseAsset);
    if (envelope?.period != null) candidates = candidates.filter(item => item.period === Number(envelope.period));
    // Never guess when multiple requests could own an unlabelled response.
    if (candidates.length !== 1) return payload;
    const request = candidates[0];
    requests.splice(requests.indexOf(request), 1);
    if (!envelope) return payload;
    const enriched = { ...envelope };
    if (!responseAsset) enriched.asset = request.rawAsset;
    if (enriched.period == null) enriched.period = request.period;
    enriched.__ptRequest = { requestId: request.requestId, index: request.index, asset: request.asset, period: request.period, sentAt: request.sentAt };
    if (Array.isArray(payload)) return payload.map(item => item === envelope ? enriched : item);
    return enriched;
  }

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
    if (eventName === 'updateAssets') rememberAssets(payload);
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
      // Prefer the socket that actually carries Pocket Option market events;
      // the page may keep analytics/auth sockets open alongside the market socket.
      window.__PT_ACTIVE_MARKET_SOCKET__ = socket;
      if (payload && payload._placeholder === true) {
        const list = pending.get(socket) || [];
        list.push(eventName);
        pending.set(socket, list);
        return;
      }
      publish(eventName, correlateHistory(eventName, payload, socket));
      return;
    }

    const list = pending.get(socket) || [];
    if (list.length) {
      const eventName = list.shift();
      pending.set(socket, list);
      publish(eventName, correlateHistory(eventName, parsed, socket));
    }
  }

  const rawAssets = new Map();
  const normalizeAsset = value => {
    let v = String(value || '').trim().toUpperCase();
    const otc = /\\bOTC\\b|_OTC$/.test(v);
    v = v.replace(/\\bOTC\\b/g, '').replace(/_OTC$/, '').replace(/[^A-Z0-9]/g, '');
    return v ? v + (otc ? '_OTC' : '') : '';
  };
  function rememberAssets(payload) {
    const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.assets) ? payload.assets : [payload]);
    for (const row of rows.slice(0, 500)) {
      const raw = Array.isArray(row) ? (row[1] || row[0]) :
        row && typeof row === 'object' ? (row.rawSymbol || row.symbol || row.asset || row.code || row.s) : null;
      if (typeof raw === 'string' && raw.length <= 64) {
        const normalized = normalizeAsset(raw);
        if (normalized) rawAssets.set(normalized, raw);
      }
    }
  }
  function requestHistory(data) {
    const asset = normalizeAsset(data && data.asset);
    const period = Number(data && data.period);
    if (!asset || !asset.endsWith('_OTC') || !Number.isInteger(period) || period < 5 || period > 900) return false;
    const sockets = window.__PT_ACTIVE_MARKET_SOCKETS__ || [];
    const preferred = window.__PT_ACTIVE_MARKET_SOCKET__;
    const ws = preferred && preferred.readyState === 1 ? preferred : sockets.slice().reverse().find(item => item && item.readyState === 1);
    if (!ws) return false;
    const raw = rawAssets.get(asset) || asset.replace(/_OTC$/, '_otc');
    const now = Math.floor(Date.now() / 1000);
    const offset = Math.max(period * 90, period <= 30 ? 9000 : 45000);
    const requestId = String(data && data.requestId || '');
    const request = { requestId, asset, rawAsset: raw, period, index: now, sentAt: Date.now() };
    const requests = historyRequests.get(ws) || [];
    // Expire abandoned requests, but preserve concurrent requests so an
    // unlabelled response cannot be silently assigned to the newest pair.
    const active = requests.filter(item => Date.now() - item.sentAt <= HISTORY_REQUEST_TTL_MS);
    active.push(request);
    historyRequests.set(ws, active);
    try { ws.send('42["changeSymbol",' + JSON.stringify({ asset: raw, period }) + ']'); } catch (_) {
      active.splice(active.indexOf(request), 1); return false;
    }
    try {
      ws.send('42["loadHistoryPeriod",' + JSON.stringify({ asset: raw, index: now, time: now, offset, period }) + ']');
      return true;
    } catch (_) {
      active.splice(active.indexOf(request), 1);
      return false;
    }
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || !event.data || event.data.type !== 'PT_REQUEST_HISTORY') return;
    const ok = requestHistory(event.data);
    window.postMessage({ type: 'PT_HISTORY_REQUEST_RESULT', requestId: String(event.data.requestId || ''), ok }, location.origin);
  });

  class MarketTapWebSocket extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      if (!Array.isArray(window.__PT_ACTIVE_MARKET_SOCKETS__)) window.__PT_ACTIVE_MARKET_SOCKETS__ = [];
      window.__PT_ACTIVE_MARKET_SOCKETS__.push(this);
      if (window.__PT_ACTIVE_MARKET_SOCKETS__.length > 8) window.__PT_ACTIVE_MARKET_SOCKETS__.shift();
      try { this.binaryType = 'arraybuffer'; } catch (_) {}
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
  if (event.source !== window || event.origin !== location.origin || !event.data || event.data.type !== 'PT_HISTORY_REQUEST_RESULT') return;
  ipcRenderer.send('site:log', { message: 'History request bridge: ' + (event.data.ok ? 'sent to market socket' : 'no active market socket') + '; request=' + String(event.data.requestId || ''), level: event.data.ok ? 'info' : 'error' });
});

ipcRenderer.on('site:request-history', (_event, request) => {
  if (!request || typeof request.asset !== 'string') return;
  const asset = request.asset.slice(0, 64);
  const period = Number(request.period);
  if (!['pocketoption.com'].some(host => location.hostname === host || location.hostname.endsWith('.' + host)) ||
      !/_OTC$/i.test(asset) || !Number.isInteger(period) || period < 5 || period > 900) return;
  window.postMessage({ type: 'PT_REQUEST_HISTORY', asset, period, requestId: String(request.requestId || '').slice(0, 80) }, location.origin);
});

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
