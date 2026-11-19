'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MarketDataStore, validateCandle } = require('../core/market-data-store');

function candle(overrides = {}) {
  return { asset: 'EURUSD_OTC', timeframe: 'S5', startAt: 5000, endAt: 10000,
    open: 1.1, high: 1.3, low: 1.0, close: 1.2, tickCount: 4, complete: true, ...overrides };
}

test('persists and returns candles in chronological order', () => {
  const store = new MarketDataStore(':memory:');
  store.upsertCandles([candle({ startAt: 10000, endAt: 15000 }), candle()]);
  const rows = store.getCandles('eurusd_otc', 'S5');
  assert.deepEqual(rows.map(row => row.startAt), [5000, 10000]);
  assert.equal(rows[0].complete, true);
  assert.equal(store.getStats().candles, 2);
  store.close();
});

test('upserts corrections but prevents older snapshots from overwriting newer rows', () => {
  const store = new MarketDataStore(':memory:');
  store.upsertCandles([candle()], 2000);
  store.upsertCandles([candle({ high: 1.5, close: 1.4 })], 3000);
  store.upsertCandles([candle({ high: 1.35, close: 1.25 })], 2500);
  const [row] = store.getCandles('EURUSD_OTC', 'S5');
  assert.equal(row.high, 1.5);
  assert.equal(row.close, 1.4);
  store.close();
});

test('rejects incomplete candles and invalid OHLC before writing anything', () => {
  const store = new MarketDataStore(':memory:');
  assert.throws(() => store.upsertCandles([candle({ complete: false })]), /только закрытые/);
  assert.throws(() => validateCandle(candle({ high: 0.9 })), /OHLC/);
  assert.equal(store.getStats().candles, 0);
  store.close();
});

test('stores and lists OTC catalog entries separately', () => {
  const store = new MarketDataStore(':memory:');
  store.upsertCatalog([
    { asset: 'EURUSD_OTC', rawSymbol: 'EURUSD_otc', label: 'EUR/USD OTC', isOTC: true },
    { asset: 'EURUSD', rawSymbol: 'EURUSD', label: 'EUR/USD', isOTC: false }
  ]);
  assert.deepEqual(store.listCatalog({ otcOnly: true }).map(row => row.asset), ['EURUSD_OTC']);
  assert.equal(store.listCatalog().length, 2);
  assert.equal(store.getStats().otcCatalogEntries, 1);
  store.close();
});

test('filters by range and timeframe and validates query bounds', () => {
  const store = new MarketDataStore(':memory:');
  store.upsertCandles([
    candle({ startAt: 5000, endAt: 10000 }), candle({ startAt: 10000, endAt: 15000 }),
    candle({ asset: 'GBPUSD_OTC', startAt: 5000, endAt: 10000 }),
    candle({ timeframe: 'M1', startAt: 60000, endAt: 120000 })
  ]);
  assert.deepEqual(store.getCandles('EURUSD_OTC', 'S5', { fromAt: 10000 }).map(row => row.startAt), [10000]);
  assert.equal(store.getCandles('EURUSD_OTC', 'M1').length, 1);
  assert.throws(() => store.getCandles('EURUSD_OTC', 'M4'), /таймфрейм/);
  assert.throws(() => store.getCandles('EURUSD_OTC', 'S5', { fromAt: 20000, toAt: 10000 }), /fromAt/);
  store.close();
});

test('persists data across database close and reopen', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'po-market-store-'));
  const file = path.join(directory, 'market.sqlite');
  try {
    const first = new MarketDataStore(file); first.upsertCandles([candle()]); first.close();
    const second = new MarketDataStore(file);
    assert.equal(second.getCandles('EURUSD_OTC', 'S5').length, 1);
    assert.equal(second.integrityCheck(), true);
    second.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('rejects unsupported future schema version', () => {
  const { DatabaseSync } = require('node:sqlite');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'po-market-schema-'));
  const file = path.join(directory, 'future.sqlite');
  try {
    const future = new DatabaseSync(file); future.exec('PRAGMA user_version = 99'); future.close();
    assert.throws(() => new MarketDataStore(file), /более новой версией/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('close is idempotent and later reads fail clearly', () => {
  const store = new MarketDataStore(':memory:'); store.close(); store.close();
  assert.throws(() => store.getStats(), /уже закрыто/);
});

test('loads only recent OTC candles per series for recovery', () => {
  const store = new MarketDataStore(':memory:');
  store.upsertCatalog([{ asset: 'EURUSD_OTC', rawSymbol: 'EURUSD_otc', label: 'EUR/USD OTC', isOTC: true }]);
  store.upsertCandles([
    candle({ startAt: 5000, endAt: 10000 }), candle({ startAt: 10000, endAt: 15000 }),
    candle({ startAt: 15000, endAt: 20000 }), candle({ asset: 'GBPUSD_OTC', startAt: 5000, endAt: 10000 })
  ]);
  const recent = store.getRecentCandles(2);
  assert.equal(recent.filter(row => row.asset === 'EURUSD_OTC').length, 2);
  assert.equal(recent.some(row => row.asset === 'GBPUSD_OTC'), true);
  assert.deepEqual(recent.filter(row => row.asset === 'EURUSD_OTC').map(row => row.startAt), [10000, 15000]);
  store.close();
});

test('prunes old candles independently for every asset and timeframe', () => {
  const store = new MarketDataStore(':memory:');
  const rows = [];
  for (let i = 1; i <= 5; i++) rows.push(candle({ startAt: i * 5000, endAt: (i + 1) * 5000 }));
  for (let i = 1; i <= 4; i++) rows.push(candle({ asset: 'GBPUSD_OTC', startAt: i * 5000, endAt: (i + 1) * 5000 }));
  store.upsertCandles(rows);
  assert.equal(store.pruneCandles(2), 5);
  assert.deepEqual(store.getCandles('EURUSD_OTC', 'S5').map(row => row.startAt), [20000, 25000]);
  assert.deepEqual(store.getCandles('GBPUSD_OTC', 'S5').map(row => row.startAt), [15000, 20000]);
  store.close();
});

function manualExample(overrides = {}) {
  return {
    id: 'sample-001', asset: 'EURUSD_OTC', timeframe: 'S5',
    segmentStart: 5000, segmentEnd: 20000, entryAt: 10000,
    direction: 'UP', expirySeconds: 15, entryPrice: 1.2, expiryPrice: 1.1,
    inputCandles: [candle({ startAt: 5000, endAt: 10000 })],
    postCandles: [candle({ startAt: 10000, endAt: 15000 }), candle({ startAt: 15000, endAt: 20000 })],
    notes: 'manual sample', ...overrides
  };
}

test('creates an independent manual example with pre-entry and post-entry snapshots', () => {
  const store = new MarketDataStore(':memory:');
  const saved = store.createManualExample(manualExample(), 30000);
  assert.equal(saved.id, 'sample-001');
  assert.equal(saved.outcome, 'LOSS');
  assert.equal(saved.inputCandles.length, 1);
  assert.equal(saved.postCandles.length, 2);
  assert.equal(saved.createdAt, 30000);
  assert.equal(store.getStats().manualExamples, 1);
  assert.equal(store.getStats().candles, 0);
  store.close();
});

test('rejects future leakage into input features and post-entry candles outside the segment', () => {
  const store = new MarketDataStore(':memory:');
  assert.throws(() => store.createManualExample(manualExample({
    inputCandles: [candle({ startAt: 10000, endAt: 15000 })]
  })), /Предвходящие признаки/);
  assert.throws(() => store.createManualExample(manualExample({
    postCandles: [candle({ startAt: 15000, endAt: 20000 }), candle({ startAt: 20000, endAt: 25000 })]
  })), /Поствходящие свечи/);
  assert.throws(() => store.createManualExample(manualExample({ segmentStart: 5001 })), /границы участка/);
  assert.equal(store.getStats().manualExamples, 0);
  store.close();
});

test('edits and deletes a manual example without changing its identity or creation time', () => {
  const store = new MarketDataStore(':memory:');
  const created = store.createManualExample(manualExample(), 30000);
  assert.throws(() => store.updateManualExample(created.id, ['bad'], 35000), /должны быть объектом/);
  const updated = store.updateManualExample(created.id, { notes: 'reviewed', direction: 'DOWN' }, 40000);
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.updatedAt, 40000);
  assert.equal(updated.notes, 'reviewed');
  assert.equal(updated.direction, 'DOWN');
  assert.equal(store.deleteManualExample(created.id), true);
  assert.equal(store.deleteManualExample(created.id), false);
  assert.equal(store.listManualExamples().length, 0);
  store.close();
});

test('filters manual examples by asset and timeframe and never mixes them with market candles', () => {
  const store = new MarketDataStore(':memory:');
  store.createManualExample(manualExample(), 30000);
  store.createManualExample(manualExample({
    id: 'sample-002', asset: 'GBPUSD_OTC', timeframe: 'M1',
    segmentStart: 60000, segmentEnd: 180000, entryAt: 120000,
    inputCandles: [candle({ asset: 'GBPUSD_OTC', timeframe: 'M1', startAt: 60000, endAt: 120000 })],
    postCandles: [candle({ asset: 'GBPUSD_OTC', timeframe: 'M1', startAt: 120000, endAt: 180000 })]
  }), 31000);
  assert.equal(store.listManualExamples({ asset: 'EURUSD_OTC' }).length, 1);
  assert.equal(store.listManualExamples({ timeframe: 'M1' }).length, 1);
  assert.throws(() => store.createManualExample(manualExample({ asset: 'EURUSD' })), /OTC/);
  assert.equal(store.getStats().candles, 0);
  assert.equal(store.getStats().manualExamples, 2);
  store.close();
});

test('migrates schema version 1 to version 2 without losing market candles', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'po-market-migration-'));
  const file = path.join(directory, 'migration.sqlite');
  try {
    const first = new MarketDataStore(file);
    first.upsertCandles([candle()]);
    first.db.exec('DROP TABLE manual_examples; PRAGMA user_version = 1');
    first.close();
    const upgraded = new MarketDataStore(file);
    assert.equal(upgraded.getStats().schemaVersion, 2);
    assert.equal(upgraded.getStats().manualExamples, 0);
    assert.equal(upgraded.getCandles('EURUSD_OTC', 'S5').length, 1);
    upgraded.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
