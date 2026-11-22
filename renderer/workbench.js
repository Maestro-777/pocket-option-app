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
  // Heikin Ashi is a display-only transform. Keep provider OHLC untouched in
  // candles so saved examples and the decision engine always use source data.
  function toHeikinAshi(source) {
    let previousOpen = null, previousClose = null;
    return source.map(bar => {
      const open = Number(bar.open), high = Number(bar.high), low = Number(bar.low), close = Number(bar.close);
      const haClose = (open + high + low + close) / 4;
      const haOpen = previousOpen == null ? (open + close) / 2 : (previousOpen + previousClose) / 2;
      const ha = {
        ...bar,
        open: haOpen,
        close: haClose,
        high: Math.max(high, haOpen, haClose),
        low: Math.min(low, haOpen, haClose)
      };
      previousOpen = haOpen;
      previousClose = haClose;
      return ha;
    });
  }
  function renderSelection() {
    $('wb-start').textContent=selectionText('start'); $('wb-entry').textContent=selectionText('entry'); $('wb-end').textContent=selection.end==null||!candles[selection.end]?'—':stamp(candles[selection.end].endAt);
    if(!candles.length){$('wb-candles').innerHTML='<div class="empty">Нет закрытых свечей для отображения</div>';return;}
    const displayCandles=toHeikinAshi(candles);
    const width=Math.max(320,($('wb-candles').clientWidth||960)-2),height=310,pad=12;
    const step=(width-pad*2)/displayCandles.length;
    const bodyWidth=Math.max(2,Math.min(9,step*0.62));
    const lows=displayCandles.map(x=>Number(x.low)),highs=displayCandles.map(x=>Number(x.high));
    const min=Math.min(...lows),max=Math.max(...highs),range=max-min||1;
    const y=value=>height-pad-(Number(value)-min)/range*(height-pad*2);
    const markers={start:'#60a5fa',entry:'#facc15',end:'#c084fc'};
    const bars=displayCandles.map((bar,i)=>{
      const x=pad+(i+0.5)*step,open=y(bar.open),close=y(bar.close),top=Math.min(open,close),body=Math.max(1,Math.abs(close-open));
      const selected=Object.keys(selection).filter(k=>selection[k]===i);
      const fill=selected.length?markers[selected[0]]:(bar.close>=bar.open?'#22c55e':'#ef4444');
      const marker=selected.length?'<text x="'+x+'" y="10" text-anchor="middle" fill="'+fill+'" font-size="9">'+selected.map(k=>k[0].toUpperCase()).join('/')+'</text>':'';
      return '<g data-wb-index="'+i+'" style="cursor:pointer">'+marker+'<line x1="'+x+'" x2="'+x+'" y1="'+y(bar.high)+'" y2="'+y(bar.low)+'" stroke="'+fill+'" stroke-width="1"/><rect x="'+(x-1.5)+'" y="'+top+'" width="3" height="'+body+'" fill="'+fill+'"><title>'+esc(stamp(bar.startAt))+' O '+bar.open+' H '+bar.high+' L '+bar.low+' C '+bar.close+'</title></rect></g>';
    }).join('');
    $('wb-candles').innerHTML='<div style="width:100%;overflow:hidden"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+width+' '+height+'" width="100%" height="'+height+'" role="img" aria-label="График Heikin Ashi; нажми на свечу для отметки"><line x1="0" x2="'+width+'" y1="'+(height/2)+'" y2="'+(height/2)+'" stroke="#64748b" stroke-opacity=".25"/>'+bars+'</svg></div><small>Нажми на свечу, чтобы поставить текущую отметку. Синий — начало, жёлтый — вход, фиолетовый — конец.</small>';
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
    say('Запрашиваю исторические свечи у Pocket Option…');
    const history=await api.requestAnalysisHistory({asset,timeframe});
    candles=await api.getAnalysisCandles({asset,timeframe,limit});
    const diagnostics=await api.getAnalysisDiagnostics({asset,timeframe});
    if(!candles.length)throw new Error(history.reason || 'История свечей пока не получена. Проверь, что Pocket Option загружен и выбранная OTC-пара доступна.');

    selection={start:null,entry:null,end:null};renderSelection();
    const first=candles[0],last=candles[candles.length-1];
    const events=diagnostics.historyEvents||[];
    const eventSummary=events.slice(-3).map(x=>x.eventName+': '+x.acceptedCandles+'/'+x.inputRows+' OHLC, layout '+(x.detectedLayout||'не определён')+', отброшено '+x.rejectedRows).join(' | ');
    say('Свечей: '+candles.length+' · '+asset+' · '+timeframe+' · диапазон '+stamp(first.startAt)+' — '+stamp(last.endAt)+' · последняя C='+last.close+' H='+last.high+' L='+last.low+'. '+(eventSummary||'Нет диагностических событий истории.'));
    console.info('[Pocket Tracker] История Pocket Option', diagnostics);
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
