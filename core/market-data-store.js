'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TIMEFRAME_MS } = require('./timeframes');

const SCHEMA_VERSION = 1;
const VALID_TIMEFRAMES = new Set(Object.keys(TIMEFRAME_MS));

function validateCandle(candle) {
  if (!candle || typeof candle !== 'object' || Array.isArray(candle)) throw new TypeError('Свеча должна быть объектом');
  const asset = String(candle.asset || '').trim().toUpperCase();
  const timeframe = String(candle.timeframe || '').toUpperCase();
  const startAt = Number(candle.startAt), endAt = Number(candle.endAt);
  const openAt = Number(candle.openAt ?? startAt), closeAt = Number(candle.closeAt ?? (endAt - 1));
  const open = Number(candle.open), high = Number(candle.high), low = Number(candle.low), close = Number(candle.close);
  const tickCount = Number(candle.tickCount);
  if (!asset || asset.length > 64 || !/^[A-Z0-9._-]+$/.test(asset)) throw new TypeError('Некорректный актив свечи');
  if (!VALID_TIMEFRAMES.has(timeframe)) throw new TypeError('Неподдерживаемый таймфрейм свечи');
  if (!Number.isSafeInteger(startAt) || startAt <= 0 || !Number.isSafeInteger(endAt) || endAt <= startAt ||
      startAt % TIMEFRAME_MS[timeframe] !== 0 || endAt !== startAt + TIMEFRAME_MS[timeframe] ||
      !Number.isSafeInteger(openAt) || !Number.isSafeInteger(closeAt) || openAt < startAt || closeAt < openAt || closeAt >= endAt) {
    throw new TypeError('Некорректный интервал свечи');
  }
  if (![open, high, low, close].every(value => Number.isFinite(value) && value > 0)) throw new TypeError('OHLC должны быть положительными конечными числами');
  if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) throw new TypeError('Нарушена целостность OHLC');
  if (!Number.isSafeInteger(tickCount) || tickCount < 1) throw new TypeError('tickCount должен быть положительным целым числом');
  if (candle.complete !== true) throw new TypeError('В хранилище разрешено записывать только закрытые свечи');
  return { asset, timeframe, startAt, endAt, openAt, closeAt, open, high, low, close, tickCount };
}

class MarketDataStore {
  constructor(databasePath) {
    if (typeof databasePath !== 'string' || !databasePath.trim()) throw new TypeError('databasePath обязателен');
    this.databasePath = databasePath;
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch (error) { throw new Error('Встроенный SQLite недоступен в Node runtime Electron: ' + String(error?.message || error)); }
    if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.closed = false;
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
      this._migrate();
      this._prepareStatements();
    } catch (error) {
      try { this.db.close(); } catch (_) {}
      this.closed = true;
      throw error;
    }
  }

  _migrate() {
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (version > SCHEMA_VERSION) throw new Error('База создана более новой версией приложения');
    if (version === 0) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE market_candles (
          asset TEXT NOT NULL CHECK(length(asset) BETWEEN 1 AND 64),
          timeframe TEXT NOT NULL CHECK(timeframe IN ('S5','S10','S15','S30','M1','M2','M3','M5','M10','M15')),
          start_at INTEGER NOT NULL CHECK(start_at > 0),
          end_at INTEGER NOT NULL CHECK(end_at > start_at),
          open_at INTEGER NOT NULL CHECK(open_at >= start_at AND open_at < end_at),
          close_at INTEGER NOT NULL CHECK(close_at >= open_at AND close_at < end_at),
          open REAL NOT NULL CHECK(open > 0),
          high REAL NOT NULL CHECK(high >= open AND high >= close AND high >= low),
          low REAL NOT NULL CHECK(low > 0 AND low <= open AND low <= close),
          close REAL NOT NULL CHECK(close > 0),
          tick_count INTEGER NOT NULL CHECK(tick_count > 0),
          updated_at INTEGER NOT NULL CHECK(updated_at > 0),
          PRIMARY KEY(asset, timeframe, start_at)
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX idx_market_candles_time ON market_candles(timeframe, start_at);
        CREATE INDEX idx_market_candles_asset_time ON market_candles(asset, start_at);
        CREATE TABLE asset_catalog (
          asset TEXT PRIMARY KEY CHECK(length(asset) BETWEEN 1 AND 64),
          raw_symbol TEXT NOT NULL, label TEXT NOT NULL,
          is_otc INTEGER NOT NULL CHECK(is_otc IN (0,1)),
          updated_at INTEGER NOT NULL CHECK(updated_at > 0)
        ) STRICT, WITHOUT ROWID;
        PRAGMA user_version = 1;
        COMMIT;
      `);
    }
  }

  _prepareStatements() {
    this._upsertCandle = this.db.prepare(`
      INSERT INTO market_candles (asset,timeframe,start_at,end_at,open_at,close_at,open,high,low,close,tick_count,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(asset,timeframe,start_at) DO UPDATE SET
        end_at=excluded.end_at, open_at=excluded.open_at, close_at=excluded.close_at,
        open=excluded.open, high=excluded.high, low=excluded.low,
        close=excluded.close, tick_count=excluded.tick_count, updated_at=excluded.updated_at
      WHERE excluded.updated_at >= market_candles.updated_at
    `);
    this._upsertAsset = this.db.prepare(`
      INSERT INTO asset_catalog (asset,raw_symbol,label,is_otc,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(asset) DO UPDATE SET raw_symbol=excluded.raw_symbol, label=excluded.label,
        is_otc=excluded.is_otc, updated_at=excluded.updated_at
      WHERE excluded.updated_at >= asset_catalog.updated_at
    `);
  }

  _assertOpen() { if (this.closed) throw new Error('Хранилище уже закрыто'); }

  upsertCandles(candles, updatedAt = Date.now()) {
    this._assertOpen();
    if (!Array.isArray(candles)) throw new TypeError('candles должен быть массивом');
    if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) throw new TypeError('updatedAt должен быть Unix timestamp в миллисекундах');
    if (candles.length > 50_000) throw new RangeError('Слишком большой пакет свечей');
    const validated = candles.map(validateCandle);
    if (!validated.length) return 0;
    let changes = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const candle of validated) {
        const result = this._upsertCandle.run(candle.asset, candle.timeframe, candle.startAt, candle.endAt,
          candle.openAt, candle.closeAt, candle.open, candle.high, candle.low, candle.close, candle.tickCount, updatedAt);
        changes += Number(result.changes || 0);
      }
      this.db.exec('COMMIT');
      return changes;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  upsertCatalog(entries, updatedAt = Date.now()) {
    this._assertOpen();
    if (!Array.isArray(entries)) throw new TypeError('entries должен быть массивом');
    if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) throw new TypeError('updatedAt должен быть Unix timestamp в миллисекундах');
    const rows = entries.map(entry => {
      if (!entry || typeof entry !== 'object') throw new TypeError('Некорректная запись каталога');
      const asset = String(entry.asset || '').trim().toUpperCase();
      const rawSymbol = String(entry.rawSymbol || '').trim();
      const label = String(entry.label || rawSymbol).trim();
      if (!asset || asset.length > 64 || !/^[A-Z0-9._-]+$/.test(asset) || !rawSymbol || rawSymbol.length > 128 || !label || label.length > 256) throw new TypeError('Некорректные поля записи каталога');
      if (typeof entry.isOTC !== 'boolean') throw new TypeError('isOTC должен быть boolean');
      if (entry.isOTC !== asset.endsWith('_OTC')) throw new TypeError('isOTC не соответствует суффиксу актива');
      return { asset, rawSymbol, label, isOTC: entry.isOTC };
    });
    if (!rows.length) return 0;
    let changes = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const result = this._upsertAsset.run(row.asset, row.rawSymbol, row.label, row.isOTC ? 1 : 0, updatedAt);
        changes += Number(result.changes || 0);
      }
      this.db.exec('COMMIT');
      return changes;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  getCandles(asset, timeframe, options = {}) {
    this._assertOpen();
    const symbol = String(asset || '').trim().toUpperCase(), tf = String(timeframe || '').toUpperCase();
    if (!symbol || symbol.length > 64 || !/^[A-Z0-9._-]+$/.test(symbol)) throw new TypeError('Некорректный актив');
    if (!VALID_TIMEFRAMES.has(tf)) throw new TypeError('Неподдерживаемый таймфрейм');
    const limit = options.limit == null ? 1000 : Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new RangeError('limit должен быть от 1 до 100000');
    const fromAt = options.fromAt == null ? null : Number(options.fromAt), toAt = options.toAt == null ? null : Number(options.toAt);
    if (fromAt != null && (!Number.isSafeInteger(fromAt) || fromAt <= 0)) throw new TypeError('Некорректный fromAt');
    if (toAt != null && (!Number.isSafeInteger(toAt) || toAt <= 0)) throw new TypeError('Некорректный toAt');
    if (fromAt != null && toAt != null && fromAt > toAt) throw new RangeError('fromAt не может быть больше toAt');
    const rows = this.db.prepare(`
      SELECT asset,timeframe,start_at,end_at,open_at,close_at,open,high,low,close,tick_count
      FROM market_candles WHERE asset=? AND timeframe=?
        AND (? IS NULL OR start_at >= ?) AND (? IS NULL OR end_at <= ?)
      ORDER BY start_at DESC LIMIT ?
    `).all(symbol, tf, fromAt, fromAt, toAt, toAt, limit);
    return rows.reverse().map(row => ({
      asset: row.asset, timeframe: row.timeframe, startAt: row.start_at, endAt: row.end_at,
      openAt: row.open_at, closeAt: row.close_at, open: row.open, high: row.high, low: row.low,
      close: row.close, tickCount: row.tick_count, complete: true
    }));
  }

  getRecentCandles(limitPerSeries = 1000) {
    this._assertOpen();
    const limit = Number(limitPerSeries);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new RangeError('limitPerSeries должен быть от 1 до 100000');
    const rows = this.db.prepare(`
      WITH ranked AS (
        SELECT c.asset,c.timeframe,c.start_at,c.end_at,c.open_at,c.close_at,c.open,c.high,c.low,c.close,c.tick_count,
          ROW_NUMBER() OVER(PARTITION BY c.asset,c.timeframe ORDER BY c.start_at DESC) AS rn
        FROM market_candles c LEFT JOIN asset_catalog a ON a.asset=c.asset
        WHERE a.is_otc=1 OR substr(c.asset, -4) = '_OTC'
      )
      SELECT asset,timeframe,start_at,end_at,open_at,close_at,open,high,low,close,tick_count
      FROM ranked WHERE rn <= ? ORDER BY asset,timeframe,start_at
    `).all(limit);
    return rows.map(row => ({
      asset: row.asset, timeframe: row.timeframe, startAt: row.start_at, endAt: row.end_at,
      openAt: row.open_at, closeAt: row.close_at, open: row.open, high: row.high, low: row.low,
      close: row.close, tickCount: row.tick_count, complete: true
    }));
  }

  pruneCandles(maxCandlesPerSeries = 300) {
    this._assertOpen();
    const limit = Number(maxCandlesPerSeries);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) throw new RangeError('maxCandlesPerSeries должен быть от 1 до 1000000');
    const result = this.db.prepare(`
      DELETE FROM market_candles
      WHERE (asset,timeframe,start_at) IN (
        SELECT asset,timeframe,start_at FROM (
          SELECT asset,timeframe,start_at,
            ROW_NUMBER() OVER(PARTITION BY asset,timeframe ORDER BY start_at DESC) AS rn
          FROM market_candles
        ) WHERE rn > ?
      )
    `).run(limit);
    return Number(result.changes || 0);
  }

  listCatalog(options = {}) {
    this._assertOpen();
    const rows = options.otcOnly === true
      ? this.db.prepare('SELECT asset,raw_symbol,label,is_otc,updated_at FROM asset_catalog WHERE is_otc=1 ORDER BY asset').all()
      : this.db.prepare('SELECT asset,raw_symbol,label,is_otc,updated_at FROM asset_catalog ORDER BY asset').all();
    return rows.map(row => ({ asset: row.asset, rawSymbol: row.raw_symbol, label: row.label, isOTC: row.is_otc === 1, updatedAt: row.updated_at }));
  }

  getStats() {
    this._assertOpen();
    return {
      candles: Number(this.db.prepare('SELECT COUNT(*) AS count FROM market_candles').get().count),
      assets: Number(this.db.prepare('SELECT COUNT(DISTINCT asset) AS count FROM market_candles').get().count),
      catalogEntries: Number(this.db.prepare('SELECT COUNT(*) AS count FROM asset_catalog').get().count),
      otcCatalogEntries: Number(this.db.prepare('SELECT COUNT(*) AS count FROM asset_catalog WHERE is_otc=1').get().count),
      schemaVersion: SCHEMA_VERSION
    };
  }

  integrityCheck() {
    this._assertOpen();
    const row = this.db.prepare('PRAGMA quick_check').get();
    return row ? Object.values(row)[0] === 'ok' : false;
  }

  close() {
    if (this.closed) return;
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
    finally { this.db.close(); this.closed = true; }
  }
}

module.exports = { MarketDataStore, SCHEMA_VERSION, validateCandle };
