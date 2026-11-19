'use strict';

function normalizeAsset(value, otcHint = false) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const isOtc = otcHint || /\bOTC\b/i.test(raw) || /_OTC$/i.test(raw);
  let base = raw.toUpperCase().replace(/\bOTC\b/gi, '').replace(/_OTC$/gi, '');
  base = base.replace(/\s+/g, '').replace(/[^A-Z0-9_]/g, '');
  if (!base || base.length > 64) return null;
  return isOtc ? base + '_OTC' : base;
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && Array.isArray(payload.assets)) return payload.assets;
  return payload && typeof payload === 'object' ? [payload] : [];
}

function readRow(row) {
  if (Array.isArray(row)) return { symbol: row[1], label: row[2] ?? row[1] };
  if (!row || typeof row !== 'object') return null;
  const symbol = row.symbol ?? row.asset ?? row.code ?? row.s;
  return { symbol, label: row.name ?? row.title ?? row.label ?? row.n ?? symbol };
}

class AssetCatalog {
  constructor() {
    this._entries = new Map();
    this._byBase = new Map();
    this.stats = { rowsSeen: 0, entriesAccepted: 0, rowsIgnored: 0 };
  }

  ingest(payload) {
    const rows = extractRows(payload);
    let accepted = 0, ignored = 0;
    for (const rawRow of rows) {
      this.stats.rowsSeen++;
      const row = readRow(rawRow);
      if (!row || row.symbol == null) { ignored++; continue; }
      const symbolText = String(row.symbol).trim();
      const labelText = String(row.label ?? '').trim();
      const asset = normalizeAsset(symbolText, /\bOTC\b/i.test(labelText));
      if (!asset) { ignored++; continue; }
      const isOTC = asset.endsWith('_OTC');
      const base = asset.replace(/_OTC$/, '');
      const previous = this._entries.get(asset);
      const entry = { asset, rawSymbol: symbolText, label: labelText || symbolText, isOTC, source: 'updateAssets' };
      this._entries.set(asset, entry);
      if (!this._byBase.has(base)) this._byBase.set(base, new Set());
      this._byBase.get(base).add(asset);
      if (!previous || previous.rawSymbol !== entry.rawSymbol || previous.label !== entry.label) accepted++;
    }
    this.stats.entriesAccepted += accepted;
    this.stats.rowsIgnored += ignored;
    return { accepted, ignored, total: this._entries.size, otc: this.listOTC().length };
  }

  resolve(rawAsset) {
    const raw = String(rawAsset || '').trim();
    const direct = normalizeAsset(raw);
    if (!direct) return null;
    const exact = this._entries.get(direct);
    const explicitOtc = direct.endsWith('_OTC');
    const base = direct.replace(/_OTC$/, '');
    const candidates = this._byBase.get(base);
    if (!explicitOtc && candidates && candidates.size > 1) {
      return { asset: null, isOTC: false, known: false, ambiguous: true };
    }
    if (exact) return { ...exact, known: true, ambiguous: false };
    if (candidates && candidates.size === 1) {
      const only = this._entries.get(candidates.values().next().value);
      return only ? { ...only, known: true, ambiguous: false } : null;
    }
    if (candidates && candidates.size > 1) return { asset: null, isOTC: false, known: false, ambiguous: true };
    if (explicitOtc) return { asset: direct, rawSymbol: raw, label: raw, isOTC: true, known: false, ambiguous: false, source: 'explicit-otc-suffix' };
    return null;
  }

  listOTC() {
    return [...this._entries.values()].filter(entry => entry.isOTC).map(entry => ({ ...entry })).sort((a, b) => a.asset.localeCompare(b.asset));
  }

  listAll() { return [...this._entries.values()].map(entry => ({ ...entry })).sort((a, b) => a.asset.localeCompare(b.asset)); }
  get size() { return this._entries.size; }
}

module.exports = { AssetCatalog, normalizeAsset, extractRows };
