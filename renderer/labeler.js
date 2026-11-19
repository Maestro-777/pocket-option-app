'use strict';

const api = window.pocketApp;
const $ = id => document.getElementById(id);
const TIMEFRAMES = ['S5','S10','S15','S30','M1','M2','M3','M5','M10','M15'];
const OUTCOMES = { WIN: 'Выигрыш', LOSS: 'Проигрыш', DRAW: 'Ничья', UNKNOWN: 'Неизвестно' };
let assets = [];
let candles = [];
let examples = [];
let marks = { segmentStart: null, entryAt: null, segmentEnd: null, entryPrice: null };
let markMode = null;
let editingId = null;
let journalLoading = false;
let chartGeometry = null;
const canvas = $('chart');
const ctx = canvas.getContext('2d');

function setStatus(message, error = false) {
  $('status').textContent = message;
  $('status').style.color = error ? '#ff929b' : '#b6c6df';
}
function fmtTime(value) {
  return value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}
function fmtPrice(value) {
  return Number.isFinite(Number(value)) ? Number(value).toPrecision(7).replace(/\.?0+$/, '') : '—';
}
function selectedAsset() { return $('asset-select').value; }
function selectedTimeframe() { return $('timeframe-select').value; }

function fillTimeframes() {
  $('timeframe-select').replaceChildren();
  for (const timeframe of TIMEFRAMES) {
    const option = document.createElement('option');
    option.value = timeframe;
    option.textContent = timeframe;
    $('timeframe-select').append(option);
  }
  $('timeframe-select').value = 'S5';
}

async function loadAssets() {
  const current = selectedAsset();
  try {
    assets = await api.getMarketAssets() || [];
    const select = $('asset-select');
    select.replaceChildren();
    for (const asset of assets) {
      const option = document.createElement('option');
      option.value = asset.asset;
      option.textContent = asset.label ? asset.label + ' · ' + asset.asset : asset.asset;
      select.append(option);
    }
    if (assets.some(item => item.asset === current)) select.value = current;
    else if (assets.length) select.selectedIndex = 0;
    select.disabled = assets.length === 0;
    $('reload-chart').disabled = assets.length === 0;
    if (!assets.length) {
      candles = [];
      drawChart();
      setStatus('Нет OTC-каталога', true);
      $('history-notice').textContent = 'Откройте Pocket Option, дождитесь каталога активов и переключите график на нужную OTC-пару. Затем нажмите «Обновить».';
    }
  } catch (error) {
    setStatus('Ошибка каталога', true);
    $('history-notice').textContent = error.message;
  }
}

async function loadChart() {
  const asset = selectedAsset(), timeframe = selectedTimeframe();
  if (!asset) { candles = []; drawChart(); return; }
  setStatus('Загрузка истории…');
  try {
    candles = await api.getMarketCandles(asset, timeframe, { limit: 300 }) || [];
    candles.sort((a, b) => a.startAt - b.startAt);
    $('bar-count').textContent = candles.length + ' свечей';
    $('chart-range').textContent = candles.length
      ? fmtTime(candles[0].startAt) + ' — ' + fmtTime(candles[candles.length - 1].endAt)
      : 'Нет сохранённой истории для этой пары и таймфрейма';
    $('history-notice').textContent = candles.length
      ? 'Выберите начало участка, точку входа и конец участка. Отметки должны быть расположены в хронологическом порядке.'
      : 'Для этой пары/таймфрейма ещё нет сохранённых OHLC-свечей. Откройте Pocket Option, выберите эту OTC-пару и такой же таймфрейм, дождитесь загрузки графика и обновите данные.';
    setStatus(candles.length ? 'История загружена' : 'История отсутствует', !candles.length);
    drawChart();
    updateMarkSummary();
  } catch (error) {
    candles = [];
    drawChart();
    setStatus('Ошибка загрузки истории', true);
    $('history-notice').textContent = error.message;
  }
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawChart();
}

function drawChart() {
  const width = canvas.clientWidth || 800;
  const height = canvas.clientHeight || 420;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0b1323';
  ctx.fillRect(0, 0, width, height);
  const left = 62, right = width - 18, top = 18, bottom = height - 42;
  const plotWidth = Math.max(10, right - left), plotHeight = Math.max(10, bottom - top);
  if (!candles.length) {
    ctx.fillStyle = '#8fa2bf';
    ctx.font = '14px Segoe UI, Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Нет сохранённых свечей', width / 2, height / 2);
    chartGeometry = null;
    return;
  }
  let min = Math.min(...candles.map(c => c.low));
  let max = Math.max(...candles.map(c => c.high));
  if (max === min) { max += Math.abs(max) * 0.001 || 0.001; min -= Math.abs(min) * 0.001 || 0.001; }
  const margin = (max - min) * 0.06;
  min -= margin; max += margin;
  const yFor = price => top + ((max - price) / (max - min)) * plotHeight;
  const step = plotWidth / candles.length;
  const bodyWidth = Math.max(2, Math.min(13, step * 0.62));
  chartGeometry = { left, right, top, bottom, plotWidth, plotHeight, min, max, step, yFor };
  ctx.font = '10px Segoe UI, Arial';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 5; i++) {
    const y = top + plotHeight * i / 5;
    const price = max - (max - min) * i / 5;
    ctx.strokeStyle = '#1e2c43';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.fillStyle = '#91a3bf';
    ctx.fillText(fmtPrice(price), left - 8, y);
  }
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const x = left + step * (i + 0.5);
    const bullish = candle.close >= candle.open;
    const color = bullish ? '#29c58b' : '#f16f78';
    const yOpen = yFor(candle.open), yClose = yFor(candle.close);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, yFor(candle.high)); ctx.lineTo(x, yFor(candle.low)); ctx.stroke();
    const bodyTop = Math.min(yOpen, yClose);
    const bodyHeight = Math.max(1.5, Math.abs(yClose - yOpen));
    ctx.fillRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#91a3bf';
  const labels = Math.min(5, candles.length);
  for (let i = 0; i < labels; i++) {
    const index = Math.round(i * (candles.length - 1) / Math.max(1, labels - 1));
    const x = left + step * (index + 0.5);
    ctx.fillText(new Date(candles[index].startAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }), x, bottom + 10);
  }
  drawMarker(marks.segmentStart, '#65a0ff', 'СТАРТ', 'start');
  drawMarker(marks.entryAt, '#f5c45e', 'ВХОД', 'entry');
  drawMarker(marks.segmentEnd, '#c58bff', 'КОНЕЦ', 'end');
}

function drawMarker(timestamp, color, label, type) {
  if (!chartGeometry || timestamp == null) return;
  const { left, right, top, bottom, step } = chartGeometry;
  const index = candles.findIndex(c => type === 'end' ? c.endAt === timestamp : c.startAt <= timestamp && c.endAt > timestamp);
  if (index < 0) return;
  const candle = candles[index];
  const fraction = type === 'entry' ? Math.max(0, Math.min(1, (timestamp - candle.startAt) / (candle.endAt - candle.startAt))) : 0.5;
  const x = type === 'end' ? left + step * (index + 1) : left + step * (index + fraction);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '10px Segoe UI, Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(label, Math.max(left + 20, Math.min(right - 20, x)), top - 2);
}

function updateMarkSummary() {
  const start = marks.segmentStart, entry = marks.entryAt, end = marks.segmentEnd;
  $('mark-summary').textContent = 'Начало: ' + fmtTime(start) + ' · Вход: ' + fmtTime(entry) + ' · Конец: ' + fmtTime(end);
  $('selected-count').textContent = [start, entry, end].filter(value => value != null).length + ' / 3';
  $('save-example').disabled = !editingId && (!candles.length || [start, entry, end].some(value => value == null));
  drawChart();
}

function setMarkMode(mode) {
  markMode = markMode === mode ? null : mode;
  for (const name of ['start','entry','end']) $('mark-' + name).classList.toggle('active', markMode === name);
  const labels = { start: 'Нажмите на свечу, где начинается участок', entry: 'Нажмите на свечу и уровень цены точки входа', end: 'Нажмите на последнюю свечу участка' };
  $('mark-hint').textContent = markMode ? labels[markMode] : 'Выберите отметку, затем нажмите на соответствующую свечу';
}

function handleChartClick(event) {
  if (!markMode || !chartGeometry || !candles.length) return;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  const index = Math.floor((x - chartGeometry.left) / chartGeometry.step);
  if (index < 0 || index >= candles.length) return;
  const candle = candles[index];
  if (markMode === 'start') marks.segmentStart = candle.startAt;
  if (markMode === 'entry') {
    const fraction = Math.max(0, Math.min(0.999999, (x - (chartGeometry.left + index * chartGeometry.step)) / chartGeometry.step));
    marks.entryAt = Math.round(candle.startAt + fraction * (candle.endAt - candle.startAt));
    const boundedY = Math.max(chartGeometry.top, Math.min(chartGeometry.bottom, y));
    marks.entryPrice = chartGeometry.max - ((boundedY - chartGeometry.top) / chartGeometry.plotHeight) * (chartGeometry.max - chartGeometry.min);
    $('entry-price').value = marks.entryPrice.toPrecision(10);
  }
  if (markMode === 'end') marks.segmentEnd = candle.endAt;
  setMarkMode(null);
  updateMarkSummary();
}

function buildSnapshots() {
  if ([marks.segmentStart, marks.entryAt, marks.segmentEnd].some(value => value == null)) throw new Error('Отметьте начало участка, точку входа и конец участка');
  if (!(marks.segmentStart <= marks.entryAt && marks.entryAt < marks.segmentEnd)) throw new Error('Порядок отметок неверный: начало ≤ вход < конец');
  const inputCandles = candles.filter(c => c.startAt >= marks.segmentStart && c.endAt <= marks.entryAt);
  const postCandles = candles.filter(c => c.endAt > marks.entryAt && c.endAt <= marks.segmentEnd);
  if (!inputCandles.length) throw new Error('До точки входа нет сохранённых свечей внутри участка');
  if (!postCandles.length) throw new Error('После точки входа нет сохранённых свечей внутри участка');
  return { segmentStart: marks.segmentStart, segmentEnd: marks.segmentEnd, entryAt: marks.entryAt, inputCandles, postCandles };
}

function readForm() {
  const entryPrice = Number($('entry-price').value || marks.entryPrice);
  const expiryRaw = $('expiry-price').value.trim();
  const expiryPrice = expiryRaw ? Number(expiryRaw) : null;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) throw new Error('Укажите корректную цену входа');
  if (expiryPrice != null && (!Number.isFinite(expiryPrice) || expiryPrice <= 0)) throw new Error('Некорректная цена на экспирации');
  const expirySeconds = Number($('expiry-seconds').value);
  if (!Number.isInteger(expirySeconds) || expirySeconds < 1 || expirySeconds > 86400) throw new Error('Экспирация должна быть от 1 до 86400 секунд');
  return {
    direction: $('direction').value, expirySeconds, entryPrice, expiryPrice,
    outcome: $('outcome').value, notes: $('notes').value
  };
}

async function saveExample() {
  try {
    const form = readForm();
    if (editingId) {
      const changes = { ...form };
      try { Object.assign(changes, buildSnapshots()); } catch (_) {}
      const updated = await api.updateManualExample(editingId, changes);
      if (!updated) throw new Error('Пример не найден');
      setStatus('Пример обновлён');
    } else {
      const snapshot = buildSnapshots();
      const saved = await api.createManualExample({
        ...snapshot, ...form, asset: selectedAsset(), timeframe: selectedTimeframe()
      });
      setStatus('Пример сохранён: ' + saved.id);
    }
    resetForm();
    await loadExamples();
  } catch (error) {
    setStatus(error.message, true);
  }
}

function resetForm() {
  editingId = null;
  marks = { segmentStart: null, entryAt: null, segmentEnd: null, entryPrice: null };
  $('form-title').textContent = 'Новый пример';
  $('save-example').textContent = 'Сохранить пример';
  $('cancel-edit').hidden = true;
  $('direction').value = 'UP';
  $('expiry-seconds').value = '15';
  $('entry-price').value = '';
  $('expiry-price').value = '';
  $('outcome').value = 'UNKNOWN';
  $('notes').value = '';
  setMarkMode(null);
  updateMarkSummary();
}

async function editExample(example) {
  editingId = example.id;
  $('asset-select').value = example.asset;
  $('timeframe-select').value = example.timeframe;
  await loadChart();
  marks = {
    segmentStart: example.segmentStart, entryAt: example.entryAt,
    segmentEnd: example.segmentEnd, entryPrice: example.entryPrice
  };
  $('form-title').textContent = 'Редактирование примера';
  $('save-example').textContent = 'Сохранить изменения';
  $('cancel-edit').hidden = false;
  $('direction').value = example.direction;
  $('expiry-seconds').value = String(example.expirySeconds);
  $('entry-price').value = String(example.entryPrice);
  $('expiry-price').value = example.expiryPrice == null ? '' : String(example.expiryPrice);
  $('outcome').value = example.outcome;
  $('notes').value = example.notes || '';
  updateMarkSummary();
  setStatus('Редактируется ' + example.id);
}

async function deleteExample(example) {
  if (!confirm('Удалить ручной пример ' + example.id + '? Это действие нельзя отменить.')) return;
  try {
    const result = await api.deleteManualExample(example.id);
    if (result?.deleted) {
      if (editingId === example.id) resetForm();
      await loadExamples();
      setStatus('Пример удалён');
    }
  } catch (error) { setStatus(error.message, true); }
}

function renderExamples() {
  const list = $('examples-list');
  list.replaceChildren();
  $('example-count').textContent = String(examples.length);
  if (!examples.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Для выбранной пары и таймфрейма примеров пока нет.';
    list.append(empty);
    return;
  }
  for (const example of examples) {
    const card = document.createElement('article');
    card.className = 'example-card';
    const head = document.createElement('div'); head.className = 'example-head';
    const title = document.createElement('span'); title.className = 'example-title';
    title.textContent = example.asset + ' · ' + example.timeframe;
    const direction = document.createElement('b');
    direction.className = example.direction === 'UP' ? 'direction-up' : 'direction-down';
    direction.textContent = example.direction === 'UP' ? 'ВВЕРХ' : 'ВНИЗ';
    head.append(title, direction);
    const meta = document.createElement('div'); meta.className = 'example-meta';
    meta.textContent = 'Вход ' + fmtTime(example.entryAt) + ' · ' + example.expirySeconds + ' сек. · ' + OUTCOMES[example.outcome];
    const actions = document.createElement('div'); actions.className = 'example-actions';
    const edit = document.createElement('button'); edit.className = 'button secondary'; edit.textContent = 'Редактировать';
    edit.addEventListener('click', () => editExample(example));
    const remove = document.createElement('button'); remove.className = 'button ghost'; remove.textContent = 'Удалить';
    remove.addEventListener('click', () => deleteExample(example));
    actions.append(edit, remove);
    card.append(head, meta, actions);
    list.append(card);
  }
}

async function loadExamples() {
  try {
    examples = await api.getManualExamples({
      asset: selectedAsset() || undefined,
      timeframe: selectedTimeframe() || undefined,
      limit: 500
    }) || [];
    renderExamples();
  } catch (error) {
    $('examples-list').textContent = error.message;
    setStatus('Не удалось загрузить примеры', true);
  }
}

async function loadAnalysisSettings() {
  const saved = await api.getSettings();
  $('analysis-topk').value = String(saved.similarityTopK ?? 10);
  $('analysis-threshold').value = String(saved.similarityMinSimilarity ?? 80);
  $('analysis-min-examples').value = String(saved.similarityMinExamples ?? 3);
  $('analysis-min-votes').value = String(saved.similarityMinDirectionVotes ?? 6);
  $('analysis-lookback').value = String(saved.similarityLookback ?? 30);
  const selected = Array.isArray(saved.analysisTimeframes) && saved.analysisTimeframes.length
    ? saved.analysisTimeframes : TIMEFRAMES;
  document.querySelectorAll('.analysis-timeframe').forEach(input => {
    input.checked = selected.includes(input.value);
  });
}

function readAnalysisOptions() {
  return {
    topK: Number($('analysis-topk').value),
    minSimilarity: Number($('analysis-threshold').value),
    minExamples: Number($('analysis-min-examples').value),
    minDirectionVotes: Number($('analysis-min-votes').value),
    lookback: Number($('analysis-lookback').value),
    analysisTimeframes: [...document.querySelectorAll('.analysis-timeframe:checked')].map(input => input.value)
  };
}

function renderAnalysis(result) {
  const summary = $('analysis-summary');
  const list = $('analysis-matches');
  list.replaceChildren();
  if (!result) { summary.textContent = 'Результат анализа отсутствует.'; return; }
  const directionLabel = result.direction === 'UP' ? 'ВВЕРХ' : result.direction === 'DOWN' ? 'ВНИЗ' : 'НЕТ СИГНАЛА';
  const parts = [
    directionLabel,
    'Совпадений ≥ порога: ' + result.qualifiedMatches.length,
    'Голоса: ВВЕРХ ' + result.votes.UP + ' / ВНИЗ ' + result.votes.DOWN,
    'Среднее сходство: ' + (result.averageSimilarity == null ? '—' : result.averageSimilarity.toFixed(2) + '%'),
    'Параметры: Top-' + result.options.topK + ', порог ' + result.options.minSimilarity + '%, минимум примеров ' + result.options.minExamples +
      ', голосов ' + result.options.minDirectionVotes + ', lookback ' + result.options.lookback
  ];
  if (result.historical) {
    parts.push('Историческая результативность: ' + (result.historical.winRate == null ? 'недостаточно данных' : result.historical.winRate.toFixed(2) + '%') +
      ' (' + result.historical.wins + ' выигр. / ' + result.historical.losses + ' проигр.)');
  }
  summary.textContent = parts.join(' · ') + (result.reason ? ' · Причина: ' + result.reason : '');
  for (const match of result.matches || []) {
    const card = document.createElement('article');
    card.className = 'analysis-match';
    const head = document.createElement('div');
    head.className = 'analysis-match-head';
    const title = document.createElement('span');
    title.textContent = match.asset + ' · ' + match.direction;
    const score = document.createElement('span');
    score.className = 'analysis-score';
    score.textContent = match.similarity.toFixed(2) + '%' + (match.similarity >= result.options.minSimilarity ? ' · подходит' : ' · ниже порога');
    head.append(title, score);
    const meta = document.createElement('div');
    meta.className = 'analysis-match-meta';
    meta.textContent = 'Экспирация ' + (match.expirySeconds || '—') + ' сек. · Результат: ' + (OUTCOMES[match.outcome] || 'Неизвестно') + ' · Вход: ' + fmtTime(match.entryAt);
    card.append(head, meta);
    list.append(card);
  }
  if (!result.matches?.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = result.reason === 'insufficient_live_history'
      ? 'Недостаточно закрытых свечей для анализа. Накопите историю на выбранной паре и таймфрейме.'
      : 'Нет подходящих исторических примеров для этого таймфрейма.';
    list.append(empty);
  }
}

async function runSimilarityAnalysis() {
  const button = $('run-analysis');
  if (!selectedAsset()) { setStatus('Сначала выберите OTC-пару', true); return; }
  button.disabled = true;
  button.textContent = 'Анализ…';
  try {
    const options = readAnalysisOptions();
    await api.saveAnalysisSettings(options);
    const result = await api.analyzeSimilarity(selectedAsset(), selectedTimeframe(), options);
    renderAnalysis(result);
    await loadDecisionJournal();
    setStatus(result.status === 'SIGNAL' ? 'Найдено направление: ' + (result.direction === 'UP' ? 'ВВЕРХ' : 'ВНИЗ') : 'Совпадения проверены: сигнала нет');
  } catch (error) {
    renderAnalysis(null);
    $('analysis-summary').textContent = error.message;
    setStatus('Ошибка анализа', true);
  } finally {
    button.disabled = false;
    button.textContent = 'Найти совпадения';
  }
}

async function runSimilarityBacktest() {
  const button = $('run-backtest');
  if (!selectedTimeframe()) return;
  button.disabled = true;
  button.textContent = 'Проверка…';
  try {
    const options = readAnalysisOptions();
    await api.saveAnalysisSettings(options);
    const report = await api.evaluateSimilarityBacktest(selectedTimeframe(), options);
    const accuracy = report.accuracy == null ? 'недостаточно сигналов' : report.accuracy.toFixed(2) + '%';
    $('backtest-summary').textContent =
      'Период: ' + report.timeframe +
      ' · Проверено: ' + report.evaluated +
      ' · Сигналов: ' + report.signals +
      ' · Без сигнала: ' + report.noSignal +
      ' · Точность среди сигналов: ' + accuracy +
      ' · Покрытие: ' + report.coverage.toFixed(2) + '%' +
      ' · Пропущено без истории: ' + report.skippedInsufficientHistory +
      ' · Без бинарного исхода: ' + report.skippedUnknownOutcome +
      ' · Параметры: Top-' + report.options.topK + ', порог ' + report.options.minSimilarity + '%, минимум примеров ' +
      report.options.minExamples + ', голосов ' + report.options.minDirectionVotes + ', lookback ' + report.options.lookback;
    setStatus('Хронологическая проверка завершена');
  } catch (error) {
    $('backtest-summary').textContent = error.message;
    setStatus('Ошибка исторической проверки', true);
  } finally {
    button.disabled = false;
    button.textContent = 'Проверить на исторических примерах';
  }
}

function renderDecisionJournal(items) {
  const list = $('decision-journal');
  list.replaceChildren();
  $('decision-count').textContent = String(items.length);
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Для выбранной пары и таймфрейма решений пока нет.';
    list.append(empty);
    return;
  }
  for (const item of items) {
    const details = document.createElement('details');
    details.className = 'decision-entry';
    const summary = document.createElement('summary');
    const direction = item.direction === 'UP' ? 'ВВЕРХ' : item.direction === 'DOWN' ? 'ВНИЗ' : 'НЕТ СИГНАЛА';
    summary.textContent = fmtTime(item.decisionAt) + ' · ' + item.asset + ' · ' + item.timeframe + ' · ' + direction + ' · ' + item.reason;
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(item, null, 2);
    details.append(summary, pre);
    list.append(details);
  }
}

async function loadDecisionJournal() {
  if (journalLoading) return;
  journalLoading = true;
  try {
    const items = await api.getAnalysisDecisions({
      asset: selectedAsset() || undefined,
      timeframe: selectedTimeframe() || undefined,
      limit: 20
    });
    renderDecisionJournal(items || []);
  } catch (error) {
    $('decision-journal').textContent = error.message;
    setStatus('Не удалось загрузить журнал решений', true);
  } finally {
    journalLoading = false;
  }
}

async function reloadAll() {
  await loadAnalysisSettings();
  await loadAssets();
  await loadChart();
  await loadExamples();
  await loadDecisionJournal();
}

$('mark-start').addEventListener('click', () => setMarkMode('start'));
$('mark-entry').addEventListener('click', () => setMarkMode('entry'));
$('mark-end').addEventListener('click', () => setMarkMode('end'));
$('clear-marks').addEventListener('click', () => {
  marks = { segmentStart: null, entryAt: null, segmentEnd: null, entryPrice: null };
  $('entry-price').value = '';
  setMarkMode(null); updateMarkSummary();
});
$('save-example').addEventListener('click', saveExample);
$('run-analysis').addEventListener('click', runSimilarityAnalysis);
$('run-backtest').addEventListener('click', runSimilarityBacktest);
document.querySelectorAll('.analysis-timeframe').forEach(input => {
  input.addEventListener('change', async () => {
    try {
      await api.saveAnalysisSettings(readAnalysisOptions());
      setStatus('Таймфреймы фонового анализа сохранены');
    } catch (error) {
      input.checked = !input.checked;
      setStatus(error.message, true);
    }
  });
});
$('cancel-edit').addEventListener('click', resetForm);
$('reload-chart').addEventListener('click', loadChart);
$('refresh-all').addEventListener('click', reloadAll);
$('asset-select').addEventListener('change', async () => { resetForm(); await loadChart(); await loadExamples(); await loadDecisionJournal(); });
$('timeframe-select').addEventListener('change', async () => { resetForm(); await loadChart(); await loadExamples(); await loadDecisionJournal(); });
$('open-site').addEventListener('click', async () => {
  const result = await api.launchSite();
  setStatus(result?.ok ? 'Pocket Option открывается' : 'Не удалось открыть Pocket Option', !result?.ok);
});
canvas.addEventListener('click', handleChartClick);
window.addEventListener('resize', resizeCanvas);

fillTimeframes();
resizeCanvas();
reloadAll().catch(error => setStatus(error.message, true));
setInterval(loadDecisionJournal, 5000);
