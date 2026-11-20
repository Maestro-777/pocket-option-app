'use strict';
(() => {
  const api = window.pocketApp;
  const $ = id => document.getElementById(id);
  const timeframes = ['S5','S10','S15','S30','M1','M2','M3','M5','M10','M15'];
  let candles = [], examples = [], mode = 'start', selection = { start: null, entry: null, end: null }, editingId = null;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const stamp = value => new Date(value).toLocaleString('ru-RU');
  function say(value) { $('wb-status').textContent = value; }
  function selectionText(key) { const i=selection[key]; return i==null || !candles[i] ? '—' : stamp(candles[i].startAt); }
  function renderSelection() {
    $('wb-start').textContent=selectionText('start'); $('wb-entry').textContent=selectionText('entry'); $('wb-end').textContent=selection.end==null||!candles[selection.end]?'—':stamp(candles[selection.end].endAt);
    $('wb-candles').innerHTML=candles.map((c,i)=>'<button class="log-entry" data-wb-index="'+i+'" style="width:100%;text-align:left;background:'+
      (Object.values(selection).includes(i)?'#203a5c':'transparent')+';border:0;color:inherit;cursor:pointer"><time>'+esc(stamp(c.startAt))+'</time><b>O '+c.open+'</b><b>H '+c.high+'</b><b>L '+c.low+'</b><b>C '+c.close+'</b><small>'+(c.complete?'закрыта':'формируется')+'</small></button>').join('')||'<div class="empty">Нет закрытых свечей для отображения</div>';
  }
  async function loadAssets() {
    const rows=await api.getAnalysisAssets(),select=$('wb-asset'),previous=select.value;
    select.innerHTML='<option value="">Выбери OTC-пару</option>'+rows.map(x=>'<option value="'+esc(x.asset)+'">'+esc(x.asset)+'</option>').join('');
    if(rows.some(x=>x.asset===previous))select.value=previous;
    say('В потоке обнаружено OTC-пар: '+rows.length+'.');
  }
  async function loadCandles() {
    const asset=$('wb-asset').value, timeframe=$('wb-timeframe').value, limit=Number($('wb-limit').value);
    if(!asset)throw new Error('Сначала выбери OTC-пару.');
    candles=await api.getAnalysisCandles({asset,timeframe,limit});
    selection={start:null,entry:null,end:null};renderSelection();
    say('Загружено закрытых свечей: '+candles.length+'. Таймфрейм '+timeframe+'.');
    await refreshExamples();
  }
  async function refreshExamples() {
    examples=await api.listExamples({timeframe:$('wb-timeframe').value});
    $('wb-examples').innerHTML=examples.map(x=>'<div class="check-row"><div><b>'+esc(x.pair)+' · '+esc(x.timeframe)+' · '+esc(x.direction)+'</b><br><small>'+esc(stamp(x.entryAt))+' · экспирация '+x.expirySeconds+' с · исход '+esc(x.outcome)+'</small></div><div class="button-row"><button class="btn secondary" data-wb-edit="'+esc(x.id)+'">Изменить</button><button class="btn ghost" data-wb-delete="'+esc(x.id)+'">Удалить</button></div></div>').join('')||'<div class="empty">Ручных примеров пока нет</div>';
  }
  function resetEditor() { editingId=null;selection={start:null,entry:null,end:null};$('wb-editor-title').textContent='Сохранить ручной пример';$('wb-save').textContent='Сохранить пример';$('wb-cancel').hidden=true;renderSelection();$('wb-save-status').textContent=''; }
  async function saveExample() {
    const {start,entry,end}=selection;
    if([start,entry,end].some(x=>x==null)||start>entry||entry>end)throw new Error('Отметь начало, вход и конец в правильном порядке.');
    const entryAt=candles[entry].startAt,preEntryCandles=candles.slice(start,entry).filter(c=>c.endAt<=entryAt);
    const outcomeCandles=candles.slice(entry+1,end+1).filter(c=>c.complete===true);
    if(preEntryCandles.length<30)throw new Error('До точки входа нужно не менее 30 закрытых свечей для анализа.');
    const payload={pair:$('wb-asset').value,timeframe:$('wb-timeframe').value,startAt:candles[start].startAt,endAt:candles[end].endAt,entryAt,
      direction:$('wb-direction').value,expirySeconds:Number($('wb-expiry').value),outcome:$('wb-outcome').value,preEntryCandles,outcomeCandles};
    if(editingId)await api.updateExample({id:editingId,patch:payload});else await api.addExample(payload);
    $('wb-save-status').textContent=editingId?'Изменения сохранены.':'Пример сохранён.';
    resetEditor();await refreshExamples();
  }
  async function editExample(id) {
    const ex=examples.find(x=>x.id===id);if(!ex)return;
    if($('wb-asset').value!==ex.pair)$('wb-asset').value=ex.pair;
    $('wb-timeframe').value=ex.timeframe;
    await loadCandles();
    const start=candles.findIndex(c=>c.startAt===ex.startAt),entry=candles.findIndex(c=>c.startAt===ex.entryAt),end=candles.findIndex(c=>c.endAt===ex.endAt);
    if(start<0||entry<0||end<0)throw new Error('Исторический диапазон отсутствует в текущем буфере свечей. Невозможно безопасно восстановить разметку.');
    selection={start,entry,end};editingId=id;$('wb-direction').value=ex.direction;$('wb-expiry').value=ex.expirySeconds;$('wb-outcome').value=ex.outcome;
    $('wb-editor-title').textContent='Редактирование ручного примера';$('wb-save').textContent='Сохранить изменения';$('wb-cancel').hidden=false;renderSelection();
  }
  async function refreshJournal() {
    const rows=await api.readDecisionJournal();
    const decisions=rows.filter(row=>row.type==='DECISION').reverse();
    $('wb-journal').innerHTML=decisions.map(row=>{
      const p=row.payload||{}, accepted=p.accepted===true;
      const matches=Array.isArray(p.matches)?p.matches:[];
      return '<div class="check-row"><div><b>'+esc(p.asset||'—')+' · '+esc(p.timeframe||'—')+' · '+(accepted?esc(p.direction):'ОТКАЗ')+'</b><br><small>'+esc(row.at?stamp(row.at):'')+' · причина: '+esc(p.reason||'—')+' · совпадений: '+Number(p.matchCount||0)+' · UP '+Number(p.upVotes||0)+' / DOWN '+Number(p.downVotes||0)+'</small>'+
        (matches.length?'<br><small>'+matches.map(m=>esc(m.sourcePair)+' '+esc(m.direction)+' '+Number(m.similarity).toFixed(1)+'% · '+esc(m.outcome)).join(' | ')+'</small>':'')+'</div><b>'+(accepted?'НАПРАВЛЕНИЕ':'НЕТ СИГНАЛА')+'</b></div>';
    }).join('')||'<div class="empty">Записей решений пока нет</div>';
  }
  async function loadAnalysisSettings() {
    const config=await api.getAnalysisSettings();
    $('wb-topk').value=config.topK;
    $('wb-threshold').value=config.similarityThreshold;
    $('wb-min-examples').value=config.minExamples;
    $('wb-votes').value=config.minDirectionalMatches;
    $('wb-pattern').value=config.patternLength;
  }
  async function analyze() {
    const asset=$('wb-asset').value;if(!asset)throw new Error('Выбери OTC-пару для анализа.');
    const config={topK:Number($('wb-topk').value),similarityThreshold:Number($('wb-threshold').value),minExamples:Number($('wb-min-examples').value),minDirectionalMatches:Number($('wb-votes').value),patternLength:Number($('wb-pattern').value)};
    if(!Number.isInteger(config.topK)||config.topK<1||config.topK>100)throw new Error('Top K должен быть от 1 до 100.');
    if(!Number.isFinite(config.similarityThreshold)||config.similarityThreshold<0||config.similarityThreshold>100)throw new Error('Порог сходства должен быть от 0 до 100.');
    if(!Number.isInteger(config.minExamples)||config.minExamples<1||config.minExamples>config.topK)throw new Error('Минимум примеров должен быть от 1 до Top K.');
    if(!Number.isInteger(config.minDirectionalMatches)||config.minDirectionalMatches<1||config.minDirectionalMatches>config.topK)throw new Error('Число подтверждений должно быть от 1 до Top K.');
    if(!Number.isInteger(config.patternLength)||config.patternLength<2||config.patternLength>500)throw new Error('Длина паттерна должна быть от 2 до 500.');
    await api.saveAnalysisSettings(config);
    const result=await api.analyzeSituation({asset,timeframe:$('wb-timeframe').value,lookback:Number($('wb-limit').value),config});
    const d=result.decision;
    $('wb-analysis').innerHTML='<b>'+(d.accepted?'Подтверждённое направление: '+esc(d.direction):'Сигнал не подтверждён')+'</b><br>Причина: '+esc(d.reason)+'<br>Совпадений: '+d.matchCount+' · UP: '+d.upVotes+' · DOWN: '+d.downVotes+'<br>Среднее сходство: '+d.averageSimilarity.toFixed(2)+'%<br><small>'+esc(d.disclaimer)+'</small>'+
      (d.matches.map(m=>'<div class="log-entry"><b>'+esc(m.sourcePair)+'</b><span>'+esc(m.direction)+'</span><span>'+Number(m.similarity).toFixed(2)+'%</span><span>'+esc(m.outcome)+'</span></div>').join('')||'<div class="empty">Совпадений нет</div>');
  }
  document.querySelectorAll('[data-wb-mode]').forEach(b=>b.addEventListener('click',()=>{mode=b.dataset.wbMode;say('Режим отметки: '+({start:'начало',entry:'точка входа',end:'конец'}[mode]));}));
  $('wb-candles').addEventListener('click',e=>{const b=e.target.closest('[data-wb-index]');if(!b)return;const i=Number(b.dataset.wbIndex);if(!Number.isInteger(i)||!candles[i])return;selection[mode]=i;renderSelection();});
  $('wb-load').addEventListener('click',()=>loadCandles().catch(e=>say(e.message)));
  $('wb-clear').addEventListener('click',()=>{selection={start:null,entry:null,end:null};renderSelection();});
  $('wb-save').addEventListener('click',()=>saveExample().catch(e=>$('wb-save-status').textContent=e.message));
  $('wb-cancel').addEventListener('click',resetEditor);
  $('wb-analyze').addEventListener('click',()=>analyze().catch(e=>$('wb-analysis').textContent=e.message));
  $('wb-refresh').addEventListener('click',()=>refreshExamples().catch(e=>say(e.message)));
  $('wb-journal-refresh').addEventListener('click',()=>refreshJournal().catch(e=>say(e.message)));
  $('wb-examples').addEventListener('click',async e=>{
    const edit=e.target.closest('[data-wb-edit]'),del=e.target.closest('[data-wb-delete]');
    try{if(edit)await editExample(edit.dataset.wbEdit);if(del){if(!confirm('Удалить ручной пример?'))return;await api.removeExample(del.dataset.wbDelete);await refreshExamples();}}catch(error){say(error.message);}
  });
  $('wb-timeframe').addEventListener('change',()=>{selection={start:null,entry:null,end:null};refreshExamples().catch(e=>say(e.message));});
  document.querySelector('[data-page="workbench"]').addEventListener('click',()=>{loadAssets().catch(e=>say(e.message));refreshExamples().catch(e=>say(e.message));});
  api.onStatus?.(()=>{});
  loadAssets().catch(e=>say(e.message));refreshExamples().catch(e=>say(e.message));refreshJournal().catch(e=>say(e.message));loadAnalysisSettings().catch(e=>say(e.message));
})();
