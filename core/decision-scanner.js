'use strict';

const { analyzeSimilarity, validateOptions } = require('./similarity-engine');
const { TIMEFRAME_MS } = require('./timeframes');

class DecisionScanner {
  constructor(options = {}) {
    if (!options.marketDataHub || typeof options.marketDataHub.getAssets !== 'function') throw new TypeError('marketDataHub обязателен');
    if (!options.marketDataStore || typeof options.marketDataStore.createAnalysisDecision !== 'function') throw new TypeError('marketDataStore обязателен');
    this.marketDataHub = options.marketDataHub;
    this.marketDataStore = options.marketDataStore;
    this.getSettings = typeof options.getSettings === 'function' ? options.getSettings : () => ({});
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.onDecision = typeof options.onDecision === 'function' ? options.onDecision : () => {};
    this.maxQueuedAssets = options.maxQueuedAssets == null ? 500 : Number(options.maxQueuedAssets);
    this.assetsPerBatch = options.assetsPerBatch == null ? 8 : Number(options.assetsPerBatch);
    if (!Number.isInteger(this.maxQueuedAssets) || this.maxQueuedAssets < 1 || this.maxQueuedAssets > 10_000) throw new RangeError('maxQueuedAssets должен быть от 1 до 10000');
    if (!Number.isInteger(this.assetsPerBatch) || this.assetsPerBatch < 1 || this.assetsPerBatch > 100) throw new RangeError('assetsPerBatch должен быть от 1 до 100');
    this._queue = new Set();
    this._timer = null;
    this._closed = false;
    this._examples = new Map();
    this._lastScanned = new Map();
    this._restoredKeys = new Set();
    this.stats = { decisions: 0, signals: 0, noSignals: 0, errors: 0, skipped: 0, lastScanAt: null };
  }

  enqueue(asset) {
    if (this._closed) return false;
    const symbol = String(asset || '').trim().toUpperCase();
    if (!symbol.endsWith('_OTC')) return false;
    if (!this._queue.has(symbol) && this._queue.size >= this.maxQueuedAssets) {
      this.stats.skipped++;
      return false;
    }
    this._queue.add(symbol);
    this._schedule(200);
    return true;
  }

  invalidateExamples(timeframe = null) {
    if (timeframe == null) this._examples.clear();
    else this._examples.delete(String(timeframe).toUpperCase());
  }

  _schedule(delay) {
    if (this._timer || this._closed) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._drain();
    }, delay);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  _selectedTimeframes(settings) {
    const source = Array.isArray(settings.analysisTimeframes) ? settings.analysisTimeframes : Object.keys(TIMEFRAME_MS);
    const unique = [...new Set(source.map(value => String(value).toUpperCase()))];
    return unique.filter(value => Object.prototype.hasOwnProperty.call(TIMEFRAME_MS, value));
  }

  _analysisOptions(settings) {
    return validateOptions({
      topK: settings.similarityTopK ?? settings.topK,
      minSimilarity: settings.similarityMinSimilarity ?? settings.minSimilarity,
      minExamples: settings.similarityMinExamples ?? settings.minExamples,
      minDirectionVotes: settings.similarityMinDirectionVotes ?? settings.minDirectionVotes,
      lookback: settings.similarityLookback ?? settings.lookback,
      maxExamples: settings.similarityMaxExamples ?? settings.maxExamples
    });
  }

  _getExamples(timeframe, maxExamples) {
    const cached = this._examples.get(timeframe);
    if (cached && cached.limit === maxExamples) return cached.items;
    const items = this.marketDataStore.listManualExamples({ timeframe, limit: maxExamples });
    this._examples.set(timeframe, { limit: maxExamples, items });
    return items;
  }

  _restoreLastScanned(key, asset, timeframe) {
    if (this._restoredKeys.has(key)) return;
    this._restoredKeys.add(key);
    const previous = this.marketDataStore.listAnalysisDecisions({ asset, timeframe, limit: 1 })[0];
    const lastCandle = previous?.queryCandles?.[previous.queryCandles.length - 1];
    this._lastScanned.set(key, Number.isSafeInteger(lastCandle?.startAt) ? lastCandle.startAt : null);
  }

  _scanAsset(asset, settings, timeframes, now) {
    let completed = 0;
    const config = this._analysisOptions(settings);
    for (const timeframe of timeframes) {
      const candles = this.marketDataHub.getCandles(asset, timeframe, { asOf: now });
      if (!candles.length) continue;
      const latest = candles[candles.length - 1];
      const key = asset + '|' + timeframe;
      this._restoreLastScanned(key, asset, timeframe);
      if (this._lastScanned.get(key) === latest.startAt) continue;

      const examples = this._getExamples(timeframe, config.maxExamples);
      let result;
      try {
        result = analyzeSimilarity({ timeframe, entryAt: now, candles, examples, options: config });
      } catch (error) {
        this.stats.errors++;
        this.log('error', 'Ошибка анализа рыночной ситуации', { asset, timeframe, error: String(error?.message || error) });
        result = {
          status: 'NO_SIGNAL', direction: 'NONE', reason: 'analysis_error',
          timeframe, entryAt: now, options: config, matches: [], qualifiedMatches: [],
          votes: { UP: 0, DOWN: 0 }, averageSimilarity: null
        };
      }

      const saved = this.marketDataStore.createAnalysisDecision({
        asset, timeframe, decisionAt: now, status: result.status,
        direction: result.direction === 'NONE' ? null : result.direction,
        reason: result.reason, paramsSnapshot: result.options,
        matches: result.matches || [], votes: result.votes || { UP: 0, DOWN: 0 },
        averageSimilarity: result.averageSimilarity ?? null,
        queryCandles: candles.slice(-config.lookback), algorithmVersion: 'shape-v1'
      });
      this._lastScanned.set(key, latest.startAt);
      this.stats.decisions++;
      if (saved.status === 'SIGNAL') this.stats.signals++;
      else this.stats.noSignals++;
      this.stats.lastScanAt = now;
      completed++;
      try { this.onDecision(saved); }
      catch (error) { this.log('warn', 'Ошибка обработчика результата сканера', String(error?.message || error)); }
    }
    return completed;
  }

  _drain() {
    if (this._closed || !this._queue.size) return;
    const settings = this.getSettings();
    const timeframes = this._selectedTimeframes(settings);
    if (!timeframes.length) {
      this.log('warn', 'Автоматический анализ остановлен: не выбран ни один таймфрейм');
      this._queue.clear();
      return;
    }
    const batch = [...this._queue].slice(0, this.assetsPerBatch);
    for (const asset of batch) this._queue.delete(asset);
    const now = Date.now();
    for (const asset of batch) {
      try { this._scanAsset(asset, settings, timeframes, now); }
      catch (error) {
        this.stats.errors++;
        this.log('error', 'Не удалось обработать актив в автоматическом анализе', { asset, error: String(error?.message || error) });
      }
    }
    if (this._queue.size) this._schedule(50);
  }

  getStatus() {
    return {
      running: !this._closed, pendingAssets: this._queue.size,
      selectedTimeframes: this._selectedTimeframes(this.getSettings()),
      ...this.stats
    };
  }

  close() {
    this._closed = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._queue.clear();
    this._examples.clear();
  }
}

module.exports = DecisionScanner;
