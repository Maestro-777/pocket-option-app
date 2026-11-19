'use strict';
(() => {
  const api = window.pocketApp;
  const $ = id => document.getElementById(id);
  const timeframes = ['S5','S10','S15','S30','M1','M2','M3','M5','M10','M15'];
  let candles = [];
  let examples = [];
  let mode = 'start';
  let selection = { start: null, end: null, entry: null };
  let editingId = null;
  let liveDecisions = [];
  let tradingState = null;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function selectedAsset() { return $('annotation-pair').value; }
  function selectedTimeframe() { return $('annotation-timeframe').value; }
  function say(message) { $('annotation-save-status').textContent = message; }



  async function loadTradingState() {
    const result = await api.getTradingState();
    if (!result || !result.ok) { $('trading-state').textContent = result?.reason || 'Не удалось получить состояние торговли'; return; }
    tradingState = result;
    $('trading-base-bet').value = result.config.baseBet;
    $('trading-expiry').value = result.config.defaultExpirySeconds;
    const paused = !result.enabled || result.gate.paused;
    $('trading-badge').textContent = !result.enabled ? 'ВЫКЛЮЧЕНА' : (result.gate.paused ? 'ПАУЗА' : 'DEMO АКТИВНА');
    $('trading-badge').className = 'status-pill ' + (result.enabled && !result.gate.paused ? 'active' : '');
    $('trading-enable').textContent = result.enabled ? 'Выключить автоторговлю' : 'Включить DEMO автоторговлю';
    $('trading-enable').disabled = !result.ledgerHealthy;
    $('trading-pause').disabled = !result.enabled;
    $('trading-pause').textContent = result.gate.paused ? 'Продолжить торговлю' : 'Пауза';
    const account = result.account || {};
    $('trading-state').textContent = 'Обнаруженный счёт: ' + (account.detected || 'не определён') +
      ' · выбранный режим: ' + (account.selected || '—') + ' · баланс: ' + (account.balance == null ? '—' : account.balance) +
      ' · активных/неподтверждённых сделок: ' + result.gate.openTrades +
      (result.ledgerHealthy ? '' : ' · ОШИБКА ЖУРНАЛА СДЕЛОК: автоторговля заблокирована');
    const stats = result.stats || {};
    $('trading-stats').innerHTML = '<span>Закрыто: ' + Number(stats.total || 0) + '</span><span>WIN: ' + Number(stats.wins || 0) +
      '</span><span>LOSS: ' + Number(stats.losses || 0) + '</span><span>DRAW: ' + Number(stats.draws || 0) +
      '</span><span>Win rate: ' + Number(stats.winRate || 0).toFixed(1) + '%</span><span>Чистый результат DEMO: ' + Number(stats.netProfit || 0).toFixed(2) + '</span>';
    const curve = stats.curve || [];
    if (curve.length) {
      const values = curve.map(x => Number(x.cumulative || 0)), low = Math.min(0, ...values), high = Math.max(0, ...values), span = Math.max(high-low, 0.000001);
      const points = values.map((v,i) => (curve.length === 1 ? 50 : i/(curve.length-1)*100).toFixed(2) + ',' + (29-(v-low)/span*26).toFixed(2)).join(' ');
      $('trading-curve').innerHTML = '<small>Кривая накопленного результата по закрытым сделкам</small><svg viewBox="0 0 100 32" preserveAspectRatio="none"><polyline points="' + points + '" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>';
    } else $('trading-curve').innerHTML = '<small>Кривая доходности появится после первых закрытых сделок</small>';
    const groups = [['По валютным парам',stats.byPair],['По таймфреймам',stats.byTimeframe],['По направлениям',stats.byDirection],['По экспирации',stats.byExpiry],['По уровню сходства',stats.bySimilarity]];
    $('trading-breakdown-content').innerHTML = groups.map(([title,rows]) => '<section class="trading-stat-group"><b>' + title + '</b>' +
      ((rows || []).length ? rows.map(x => '<div class="log-entry"><span>' + esc(x.key) + '</span><span>сделок: ' + x.total +
      '</span><span>WIN: ' + x.wins + '</span><span>LOSS: ' + x.losses + '</span><span>WR: ' + Number(x.winRate).toFixed(1) +
      '%</span><span>Net: ' + Number(x.netProfit).toFixed(2) + '</span></div>').join('') : '<small>Нет закрытых сделок</small>') + '</section>').join('');
    const open = result.openTrades || [];
    $('trading-open-list').innerHTML = open.length ? open.map(t =>
      '<div class="log-entry"><b>' + esc(t.pair) + '</b><span>' + esc(t.timeframe) + '</span><span>' + esc(t.direction) +
      '</span><span>' + Number(t.amount).toFixed(2) + '</span><span>' + esc(t.status) + '</span><small>' +
      esc(new Date(t.submittedAt).toLocaleString('ru-RU')) + '</small>' +
      (t.status === 'UNKNOWN_AFTER_RESTART' ? '<button class="text-btn" data-resolve-not-opened="' + esc(t.tradeId) + '">Не открывалась</button><button class="text-btn" data-resolve-closed="' + esc(t.tradeId) + '">Закрыта вручную</button>' : '') +
      '</div>'
    ).join('') : '<div class="empty">Открытых или ожидающих сделок нет</div>';
  }

  async function saveTradingConfig() {
    const result = await api.setTradingConfig({baseBet:Number($('trading-base-bet').value),defaultExpirySeconds:Number($('trading-expiry').value)});
    $('trading-state').textContent = result && result.ok ? 'Параметры сделки сохранены.' : (result?.reason || 'Не удалось сохранить параметры');
    if (result && result.ok) await loadTradingState();
  }

  async function toggleTrading() {
    const result = await api.setTradingEnabled(!(tradingState && tradingState.enabled));
    if (!result || !result.ok) $('trading-state').textContent = result?.reason || 'Не удалось изменить режим автоторговли';
    await loadTradingState();
  }

  async function toggleTradingPause() {
    if (!tradingState || !tradingState.enabled) return;
    const result = await api.setTradingPaused(!tradingState.gate.paused);
    if (!result || !result.ok) $('trading-state').textContent = result?.reason || 'Не удалось изменить паузу';
    await loadTradingState();
  }

  async function loadAnalysisConfig() {
    const result = await api.getAnalysisConfig();
    if (!result || !result.ok) { $('analysis-monitor-status').textContent = result?.reason || 'Не удалось получить параметры анализа'; return; }
    const config = result.config;
    const selected = new Set(config.timeframes || []);
    Array.from($('analysis-timeframes').options).forEach(option => { option.selected = selected.has(option.value); });
    $('analysis-lookback').value = config.lookback;
    $('analysis-interval').value = config.scanIntervalMs;
    $('analysis-max-candidates').value = config.maxOpenTrades;
    $('matcher-topk').value = config.matcher.topK;
    $('matcher-threshold').value = config.matcher.similarityThreshold;
    $('matcher-min-examples').value = config.matcher.minExamples;
    $('matcher-min-votes').value = config.matcher.minDirectionalMatches;
    $('matcher-pattern-length').value = config.matcher.patternLength;
    $('analysis-monitor-status').textContent = 'Непрерывный анализ включён · таймфреймы: ' + config.timeframes.join(', ') +
      ' · окно: ' + config.lookback + ' свечей · период: ' + config.scanIntervalMs + ' мс';
    await loadRecentDecisions();
  }

  async function saveAnalysisConfig() {
    const timeframes = Array.from($('analysis-timeframes').selectedOptions).map(option => option.value);
    const config = {
      enabled: true, timeframes,
      lookback: Number($('analysis-lookback').value),
      scanIntervalMs: Number($('analysis-interval').value),
      maxOpenTrades: Number($('analysis-max-candidates').value),
      matcher: {
        topK: Number($('matcher-topk').value),
        similarityThreshold: Number($('matcher-threshold').value),
        minExamples: Number($('matcher-min-examples').value),
        minDirectionalMatches: Number($('matcher-min-votes').value),
        patternLength: Number($('matcher-pattern-length').value)
      }
    };
    const result = await api.setAnalysisConfig(config);
    if (!result || !result.ok) { $('analysis-monitor-status').textContent = result?.reason || 'Не удалось сохранить настройки'; return; }
    $('analysis-monitor-status').textContent = 'Параметры сохранены. Непрерывный анализ перезапущен.';
  }

  function renderLiveDecisions() {
    const host = $('live-signals');
    if (!liveDecisions.length) { host.innerHTML = '<div class="empty">Ожидание новых закрытых свечей</div>'; return; }
    host.innerHTML = liveDecisions.slice(0,100).map(item => {
      const d = item.decision || {};
      const accepted = d.accepted === true;
      const direction = accepted ? (d.direction === 'UP' ? 'ВВЕРХ' : 'ВНИЗ') : (d.reason || 'нет сигнала');
      const rank = item.rank ? '№' + item.rank + (item.withinConfiguredLimit ? ' · в лимите отбора' : '') : 'не ранжирован';
      const winRate = item.ranking && item.ranking.historicalWinRate != null ? (item.ranking.historicalWinRate * 100).toFixed(1) + '%' : 'нет размеченных исходов';
      const matches = (d.matches || []).map(m =>
        '<div class="log-entry"><b>' + esc(m.sourcePair) + '</b><span>' + esc(m.direction) +
        '</span><span>' + Number(m.similarity || 0).toFixed(2) + '%</span><span>' + esc(m.outcome || 'UNKNOWN') +
        '</span><small>' + esc(m.exampleId) + '</small></div>'
      ).join('');
      const detail = matches ? '<details class="signal-match-details"><summary>Исторические совпадения (' + d.matchCount + ')</summary>' + matches + '</details>' : '';
      return '<article class="signal-decision"><div class="log-entry"><span class="level ' + (accepted ? 'accepted' : 'rejected') + '">' +
        (accepted ? 'СИГНАЛ' : 'ОТКАЗ') + '</span><b>' + esc(item.asset) + '</b><span>' + esc(item.timeframe) +
        '</span><span>' + esc(direction) + '</span><span>' + Number(d.averageSimilarity || 0).toFixed(2) +
        '% · ' + Number(d.matchCount || 0) + ' совп.</span><span>' + esc(rank) + '</span></div>' +
        '<small class="signal-meta">ВВЕРХ: ' + Number(d.upVotes || 0) + ' · ВНИЗ: ' + Number(d.downVotes || 0) +
        ' · Исторический win rate размеченных совпадений: ' + esc(winRate) + '</small>' + detail + '</article>';
    }).join('');
  }

  async function loadRecentDecisions() {
    const result = await api.getRecentDecisions();
    if (result && result.ok) {
      const known = new Set(liveDecisions.map(item => item.signalId));
      liveDecisions = liveDecisions.concat((result.decisions || []).filter(item => !known.has(item.signalId))).slice(0,100);
      renderLiveDecisions();
    }
  }

  async function scanNow() {
    $('analysis-monitor-status').textContent = 'Проверяем новые закрытые свечи…';
    const result = await api.scanNow();
    if (!result || !result.ok) { $('analysis-monitor-status').textContent = result?.reason || 'Сканирование не выполнено'; return; }
    $('analysis-monitor-status').textContent = 'Проверка завершена · проанализировано: ' + result.result.scanned +
      ' · решений: ' + result.result.decisions + ' · подтверждённых сигналов: ' + result.result.signals.length;
    await loadRecentDecisions();
  }

  async function loadAssets() {
    const select = $('annotation-pair');
    const previous = select.value;
    let result = await api.listMarketAssets({ otcOnly: true });
    if (!Array.isArray(result) || !result.length) result = await api.listMarketAssets({});
    select.innerHTML = (result || []).map(a => '<option value="' + esc(a.symbol) + '">' + esc(a.name || a.symbol) + ' · ' + esc(a.symbol) + '</option>').join('');
    if (previous && Array.from(select.options).some(o => o.value === previous)) select.value = previous;
    if (!select.options.length) select.innerHTML = '<option value="">Сначала открой Pocket Option и дождись каталога активов</option>';
  }

  async function loadCandles() {
    const asset = selectedAsset(), timeframe = selectedTimeframe();
    const limit = Number($('annotation-lookback').value);
    if (!asset) { $('annotation-chart-status').textContent = 'Нет доступных активов'; return; }
    if (!Number.isInteger(limit) || limit < 20 || limit > 10000) { $('annotation-chart-status').textContent = 'Размер окна должен быть от 20 до 10000'; return; }
    $('annotation-chart-status').textContent = 'Загрузка свечей…';
    const result = await api.getMarketCandles({ asset, timeframe, limit, includeIncomplete: false });
    if (!result || !result.ok) {
      candles = [];
      $('annotation-chart').innerHTML = '<div class="empty">' + esc(result?.reason || 'Не удалось загрузить свечи') + '</div>';
      $('annotation-chart-status').textContent = 'Ошибка загрузки';
      return;
    }
    candles = result.candles || [];
    selection = { start: null, end: null, entry: null };
    renderChart();
    await refreshExamples();
  }

  function renderChart() {
    const host = $('annotation-chart');
    if (!candles.length) {
      host.innerHTML = '<div class="empty">Для этой пары и таймфрейма пока нет закрытых свечей. История поступает из графика Pocket Option; текущие тики собираются после запуска приложения.</div>';
      $('annotation-chart-status').textContent = 'Нет свечей';
      renderSelection();
      return;
    }
    const max = Math.max(...candles.map(c => Number(c.high)));
    const min = Math.min(...candles.map(c => Number(c.low)));
    const span = Math.max(max - min, Math.abs(max) * 1e-8, 1e-8);
    const bars = candles.map((c, i) => {
      const open = Number(c.open), close = Number(c.close), high = Number(c.high), low = Number(c.low);
      const wickTop = Math.max(0, Math.min(100, (max - high) / span * 100));
      const wickHeight = Math.max(1, Math.min(100, (high - low) / span * 100));
      const bodyTop = Math.max(0, Math.min(100, (max - Math.max(open, close)) / span * 100));
      const bodyHeight = Math.max(1.5, Math.min(100, Math.abs(open - close) / span * 100));
      const title = new Date(c.startAt).toLocaleString('ru-RU') + ' · O ' + open + ' H ' + high + ' L ' + low + ' C ' + close;
      return '<button type="button" class="candle ' + (close >= open ? 'up' : 'down') + '" data-index="' + i + '" title="' + esc(title) + '">' +
        '<i class="wick" style="top:' + wickTop + '%;height:' + wickHeight + '%"></i>' +
        '<i class="body" style="top:' + bodyTop + '%;height:' + bodyHeight + '%"></i>' +
        '<small>' + (i % Math.max(1, Math.ceil(candles.length / 12)) === 0 ? esc(new Date(c.startAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})) : '') + '</small></button>';
    }).join('');
    host.innerHTML = '<div class="candle-chart-inner">' + bars + '</div>';
    $('annotation-chart-status').textContent = candles.length + ' закрытых свечей · ' + selectedAsset() + ' · ' + selectedTimeframe() + ' · ' +
      new Date(candles[0].startAt).toLocaleString('ru-RU') + ' — ' + new Date(candles[candles.length - 1].endAt).toLocaleString('ru-RU');
    renderSelection();
  }

  function renderSelection() {
    const names = ['Начало участка','Конец участка','Точка входа'];
    const values = [selection.start,selection.end,selection.entry];
    $('annotation-selection').textContent = names.map((n,i) => n + ': ' + (values[i] == null ? '—' : new Date(candles[values[i]].startAt).toLocaleTimeString('ru-RU'))).join(' · ');
    document.querySelectorAll('#annotation-chart .candle').forEach(el => {
      const i = Number(el.dataset.index);
      el.classList.toggle('selected-start', i === selection.start);
      el.classList.toggle('selected-end', i === selection.end);
      el.classList.toggle('selected-entry', i === selection.entry);
    });
  }

  async function refreshExamples() {
    const result = await api.listExamples({ timeframe: selectedTimeframe() });
    if (!result || !result.ok) {
      $('annotation-examples-list').innerHTML = '<div class="empty">' + esc(result?.reason || 'Не удалось загрузить примеры') + '</div>';
      return;
    }
    examples = result.examples || [];
    renderExamples();
  }

  function renderExamples() {
    const host = $('annotation-examples-list');
    if (!examples.length) { host.innerHTML = '<div class="empty">Для выбранного таймфрейма примеров пока нет</div>'; return; }
    host.innerHTML = examples.slice().sort((a,b) => b.entryAt - a.entryAt).map(ex =>
      '<div class="log-entry annotation-example-row"><span class="level">' + esc(ex.direction === 'UP' ? 'ВВЕРХ' : 'ВНИЗ') + '</span>' +
      '<b>' + esc(ex.pair) + '</b><span>' + esc(ex.timeframe) + ' · ' + esc(new Date(ex.entryAt).toLocaleString('ru-RU')) + '</span>' +
      '<span>эксп.: ' + esc(ex.expirySeconds) + 'с · ' + esc(ex.outcome || 'UNKNOWN') + '</span>' +
      '<button class="text-btn" data-edit-example="' + esc(ex.id) + '">Изменить</button>' +
      '<button class="text-btn danger" data-delete-example="' + esc(ex.id) + '">Удалить</button></div>'
    ).join('');
  }

  function getDraft() {
    if (![selection.start,selection.end,selection.entry].every(Number.isInteger)) throw new Error('Отметь начало, конец участка и точку входа на графике.');
    if (selection.start > selection.entry || selection.entry > selection.end) throw new Error('Порядок должен быть: начало участка → точка входа → конец участка.');
    const selected = candles.slice(selection.start, selection.end + 1);
    const entryAt = candles[selection.entry].startAt;
    const preEntryCandles = selected.filter(c => c.endAt <= entryAt);
    const outcomeCandles = selected.filter(c => c.startAt >= entryAt);
    if (preEntryCandles.length < 2) throw new Error('До точки входа должно быть минимум две закрытые свечи.');
    return {
      pair: selectedAsset(), timeframe: selectedTimeframe(),
      startAt: selected[0].startAt, endAt: selected[selected.length - 1].endAt,
      entryAt, direction: $('annotation-direction').value,
      expirySeconds: Number($('annotation-expiry').value),
      outcome: $('annotation-outcome').value,
      preEntryCandles, outcomeCandles
    };
  }

  async function saveExample() {
    try {
      const draft = getDraft();
      if (!Number.isInteger(draft.expirySeconds) || draft.expirySeconds < 1 || draft.expirySeconds > 86400) throw new Error('Экспирация должна быть от 1 до 86400 секунд.');
      const result = editingId
        ? await api.updateExample({ id: editingId, patch: draft })
        : await api.addExample(draft);
      if (!result || !result.ok) throw new Error(result?.reason || 'Не удалось сохранить пример');
      say(editingId ? 'Пример обновлён.' : 'Пример сохранён.');
      editingId = null;
      $('annotation-editor-title').textContent = 'Новый пример';
      $('annotation-save').textContent = 'Сохранить пример';
      $('annotation-cancel-edit').hidden = true;
      selection = { start:null,end:null,entry:null };
      renderSelection();
      await refreshExamples();
    } catch (error) { say(String(error.message || error)); }
  }

  async function editExample(id) {
    const ex = examples.find(x => x.id === id);
    if (!ex) return;
    if (!Array.from($('annotation-pair').options).some(o => o.value === ex.pair)) {
      const option = document.createElement('option'); option.value = ex.pair; option.textContent = ex.pair; $('annotation-pair').appendChild(option);
    }
    $('annotation-pair').value = ex.pair;
    $('annotation-timeframe').value = ex.timeframe;
    await loadCandles();
    const start = candles.findIndex(c => c.startAt === ex.startAt);
    const entry = candles.findIndex(c => c.startAt === ex.entryAt);
    const end = candles.findIndex(c => c.endAt === ex.endAt);
    if (start < 0 || entry < 0 || end < 0) {
      say('Для редактирования загрузи более широкий диапазон свечей, содержащий исходный участок.');
      return;
    }
    selection = { start, entry, end };
    $('annotation-direction').value = ex.direction;
    $('annotation-expiry').value = ex.expirySeconds;
    $('annotation-outcome').value = ex.outcome || 'UNKNOWN';
    editingId = id;
    $('annotation-editor-title').textContent = 'Редактирование примера';
    $('annotation-save').textContent = 'Сохранить изменения';
    $('annotation-cancel-edit').hidden = false;
    renderSelection();
    $('annotation-chart').scrollLeft = Math.max(0, (start - 5) * 18);
  }

  async function deleteExample(id) {
    if (!window.confirm('Удалить этот исторический пример?')) return;
    const result = await api.removeExample(id);
    if (!result || !result.ok) { say(result?.reason || 'Не удалось удалить пример'); return; }
    if (editingId === id) cancelEdit();
    await refreshExamples();
  }

  function cancelEdit() {
    editingId = null;
    selection = { start:null,end:null,entry:null };
    $('annotation-editor-title').textContent = 'Новый пример';
    $('annotation-save').textContent = 'Сохранить пример';
    $('annotation-cancel-edit').hidden = true;
    renderSelection();
    say('Редактирование отменено.');
  }

  async function analyze() {
    const config = {
      topK: Number($('matcher-topk').value),
      patternLength: Number($('matcher-pattern-length').value),
      similarityThreshold: Number($('matcher-threshold').value),
      minExamples: Number($('matcher-min-examples').value),
      minDirectionalMatches: Number($('matcher-min-votes').value)
    };
    $('annotation-analysis-result').textContent = 'Анализ…';
    const result = await api.analyzeSituation({
      asset: selectedAsset(), timeframe: selectedTimeframe(),
      lookback: Number($('annotation-lookback').value), config
    });
    if (!result || !result.ok) {
      $('annotation-analysis-result').innerHTML = '<div class="empty">' + esc(result?.reason || 'Анализ не выполнен') + '</div>';
      return;
    }
    const d = result.decision;
    const header = '<div class="analysis-summary"><b>' + (d.accepted ? 'Сигнал: ' + esc(d.direction === 'UP' ? 'ВВЕРХ' : 'ВНИЗ') : 'Сигнал не подтверждён') +
      '</b><span>Причина: ' + esc(d.reason) + '</span><span>Совпадений: ' + d.matchCount + ' · ВВЕРХ: ' + d.upVotes + ' · ВНИЗ: ' + d.downVotes +
      '</span><span>Среднее сходство: ' + d.averageSimilarity.toFixed(2) + '%</span><small>' + esc(d.disclaimer) + '</small></div>';
    const rows = d.matches.map(m => '<div class="log-entry"><b>' + esc(m.sourcePair) + '</b><span>' + esc(m.direction) +
      '</span><span>сходство: ' + Number(m.similarity).toFixed(2) + '%</span><span>результат: ' + esc(m.outcome || 'UNKNOWN') +
      '</span><small>ID ' + esc(m.exampleId) + '</small></div>').join('');
    $('annotation-analysis-result').innerHTML = header + (rows || '<div class="empty">Подходящих примеров не найдено</div>');
  }

  $('trading-save-config').addEventListener('click', () => saveTradingConfig().catch(e => { $('trading-state').textContent = String(e.message || e); }));
  $('trading-enable').addEventListener('click', () => toggleTrading().catch(e => { $('trading-state').textContent = String(e.message || e); }));
  $('trading-pause').addEventListener('click', () => toggleTradingPause().catch(e => { $('trading-state').textContent = String(e.message || e); }));
  $('trading-open-list').addEventListener('click', async event => {
    const notOpened = event.target.closest('[data-resolve-not-opened]');
    const closed = event.target.closest('[data-resolve-closed]');
    let request = null;
    if (notOpened && window.confirm('Подтверждаешь, что эта сделка фактически НЕ была открыта?')) request = {tradeId:notOpened.dataset.resolveNotOpened,action:'not_opened'};
    if (closed) {
      const value = window.prompt('Введи фактический чистый результат сделки (прибыль положительным числом, убыток отрицательным):','0');
      if (value != null && value.trim() !== '') request = {tradeId:closed.dataset.resolveClosed,action:'closed',profit:Number(value)};
    }
    if (request) { const result = await api.resolveTrade(request); $('trading-state').textContent = result && result.ok ? 'Запись сделки сверена.' : (result?.reason || 'Не удалось сверить сделку'); await loadTradingState(); }
  });
  $('analysis-save').addEventListener('click', () => saveAnalysisConfig().catch(e => { $('analysis-monitor-status').textContent = String(e.message || e); }));
  $('analysis-scan-now').addEventListener('click', () => scanNow().catch(e => { $('analysis-monitor-status').textContent = String(e.message || e); }));
  $('annotation-load').addEventListener('click', () => loadCandles().catch(e => say(String(e.message || e))));
  $('annotation-refresh-examples').addEventListener('click', refreshExamples);
  $('annotation-save').addEventListener('click', saveExample);
  $('annotation-cancel-edit').addEventListener('click', cancelEdit);
  $('annotation-analyze').addEventListener('click', analyze);
  $('annotation-clear').addEventListener('click', () => { selection={start:null,end:null,entry:null};renderSelection(); });
  $('annotation-timeframe').addEventListener('change', () => { selection={start:null,end:null,entry:null};refreshExamples(); });
  $('annotation-pair').addEventListener('change', () => { selection={start:null,end:null,entry:null}; });
  document.querySelectorAll('[data-annotation-mode]').forEach(button => button.addEventListener('click', () => {
    mode = button.dataset.annotationMode;
    document.querySelectorAll('[data-annotation-mode]').forEach(x => x.classList.toggle('active', x === button));
  }));
  $('annotation-chart').addEventListener('click', event => {
    const button = event.target.closest('[data-index]');
    if (!button) return;
    const index = Number(button.dataset.index);
    if (!Number.isInteger(index) || index < 0 || index >= candles.length) return;
    selection[mode] = index;
    renderSelection();
  });
  $('annotation-examples-list').addEventListener('click', event => {
    const edit = event.target.closest('[data-edit-example]');
    const del = event.target.closest('[data-delete-example]');
    if (edit) editExample(edit.dataset.editExample).catch(e => say(String(e.message || e)));
    if (del) deleteExample(del.dataset.deleteExample).catch(e => say(String(e.message || e)));
  });
  document.querySelector('[data-page="annotation"]').addEventListener('click', async () => {
    await loadAssets();
    await refreshExamples();
    await loadAnalysisConfig();
    await loadTradingState();
  });
  api.onSignalDecision(item => { liveDecisions = [item].concat(liveDecisions.filter(x => x.signalId !== item.signalId)).slice(0,100); renderLiveDecisions(); });
  api.onTradeUpdate(() => loadTradingState().catch(() => {}));
  api.onMarketData(() => {
    if ($('page-annotation').classList.contains('active') && !selectedAsset()) loadAssets();
  });
  loadAssets().catch(() => {});
  loadRecentDecisions().catch(() => {});
  loadTradingState().catch(() => {});
})();