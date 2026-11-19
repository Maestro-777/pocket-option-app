'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AssetCatalog, normalizeAsset } = require('../core/asset-catalog');

test('normalizes OTC marker from symbol and label', () => {
  assert.equal(normalizeAsset('EURUSD_otc'), 'EURUSD_OTC');
  assert.equal(normalizeAsset('EUR/USD', true), 'EURUSD_OTC');
  assert.equal(normalizeAsset('GBP/USD'), 'GBPUSD');
});

test('reads array and object catalog rows and lists only explicitly marked OTC assets', () => {
  const catalog = new AssetCatalog();
  const result = catalog.ingest([
    [1, 'EURUSD_otc', 'EUR/USD OTC'],
    { symbol: 'GBPUSD', name: 'GBP/USD OTC' },
    { asset: 'USDJPY', title: 'USD/JPY' },
    null,
    { name: 'missing symbol' }
  ]);
  assert.equal(result.accepted, 3);
  assert.equal(result.ignored, 2);
  assert.deepEqual(catalog.listOTC().map(row => row.asset), ['EURUSD_OTC', 'GBPUSD_OTC']);
  assert.equal(catalog.size, 3);
});

test('resolves exact and unique base symbols but rejects ambiguous OTC/non-OTC aliases', () => {
  const catalog = new AssetCatalog();
  catalog.ingest([
    { symbol: 'EURUSD', name: 'EUR/USD' },
    { symbol: 'EURUSD_otc', name: 'EUR/USD OTC' },
    { symbol: 'GBPUSD_otc', name: 'GBP/USD OTC' }
  ]);
  assert.equal(catalog.resolve('GBPUSD').asset, 'GBPUSD_OTC');
  assert.equal(catalog.resolve('EURUSD').ambiguous, true);
  assert.equal(catalog.resolve('EURUSD_otc').isOTC, true);
});

test('accepts explicit OTC suffix before catalog event but does not guess unknown normal assets', () => {
  const catalog = new AssetCatalog();
  assert.equal(catalog.resolve('AUDUSD_otc').isOTC, true);
  assert.equal(catalog.resolve('AUDUSD'), null);
});

test('updates existing entries without duplicating catalog rows', () => {
  const catalog = new AssetCatalog();
  catalog.ingest([{ symbol: 'EURUSD_otc', name: 'EUR/USD OTC' }]);
  const result = catalog.ingest([{ symbol: 'EURUSD_otc', name: 'EUR/USD OTC' }]);
  assert.equal(result.total, 1);
  assert.equal(result.accepted, 0);
  assert.equal(catalog.stats.rowsSeen, 2);
});

test('restores persisted catalog rows and remembers explicit OTC suffixes', () => {
  const catalog = new AssetCatalog();
  assert.equal(catalog.restore([{ asset: 'EURUSD_OTC', rawSymbol: 'EURUSD_otc', label: 'EUR/USD OTC', isOTC: true }]), 1);
  assert.equal(catalog.resolve('EURUSD_otc').isOTC, true);
  assert.equal(catalog.rememberExplicitOtc('GBPUSD_otc').asset, 'GBPUSD_OTC');
  assert.equal(catalog.listOTC().length, 2);
  assert.equal(catalog.revision, 1);
});

test('explicit OTC suffix overrides a same-base regular catalog symbol', () => {
  const catalog = new AssetCatalog();
  catalog.ingest([{ symbol: 'EURUSD', name: 'EUR/USD' }]);
  const resolved = catalog.resolve('EURUSD_otc');
  assert.equal(resolved.isOTC, true);
  assert.equal(resolved.asset, 'EURUSD_OTC');
  assert.equal(resolved.source, 'explicit-otc-suffix');
});
