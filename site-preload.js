'use strict';
const { ipcRenderer } = require('electron');
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
  if (event.data && event.data.type === 'PT_PO_LOG') ipcRenderer.send('site:log', { message: String(event.data.message || '').slice(0, 300), level: event.data.level });
});


// Market data is untrusted page data: only allowlisted event names and bounded arrays cross IPC.
const MARKET_EVENTS = new Set(['updateAssets', 'updateStream', 'quotes/stream']);
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.type !== 'PT_MARKET_DATA' || data.version !== 1 || !MARKET_EVENTS.has(data.eventName)) return;
  if (!Array.isArray(data.payload) || data.payload.length < 1 || data.payload.length > 5000) return;
  ipcRenderer.send('site:market-data', {
    version: 1,
    eventName: data.eventName,
    payload: data.payload,
    receivedAt: Number(data.receivedAt) || Date.now()
  });
});
