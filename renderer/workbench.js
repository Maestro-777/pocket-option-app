'use strict';
(() => {
  const api = window.pocketApp;
  const $ = id => document.getElementById(id);
  const timeframes = ['S5','S10','S15','S30','M1','M2','M3','M5','M10','M15'];
  let candles = [], examples = [], mode = 'start', selection = { start: null, entry: null, end: null }, editingId = null, currentQuote = null, activeCandleIndex = null, quoteTimer = null;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const stamp = value => new Date(value).toLocaleString('ru-RU');
  function say(value) { $('wb-status').textContent = value; }
  function selectionText(key) { const i=selection[key]; return i==null || !candles[i] ? '—' : stamp(candles[i].startAt); }
  function priceText(value) {
    const n=Number(value);
    return Number.isFinite(n) ? n.toLocaleString('ru-RU',{minimumFractionDigits:5,maximumFractionDigits:8}) : '—';
  }
  function quoteAgeText(ts) {
    if(!Number.isFinite(Number(ts)))return 'нет отметки времени';
    const age=Math.max(0,Date.now()-Number(ts));
    return age<1000?'только что':age<60000?Math.floor(age/1000)+' с назад':Math.floor(age/60000)+' мин назад';
  }
  async function refreshCurrentQuote() {
    const asset=$('wb-asset').value;
    if(!asset)return;
    try {
      const rows=await api.getAnalysisAssets();
      const found=rows.find(x=>x.asset===asset);
      currentQuote=found&&Number.isFinite(Number(found.lastPrice))?{price:Number(found.lastPrice),ts:Number(found.lastTickAt),ageMs:found.ageMs}:null;
      const summary=$('wb-market-summary');
      if(summary) {
        if(currentQuote) {
          const stale=Date.now()-currentQuote.ts>15000;
          const last=candles[candles.length-1];
          const delta=last?currentQuote.price-Number(last.close):null;
          const pct=last&&Number(last.close)!==0?delta/Number(last.close)*100:null;
          summary.innerHTML='<div class="wb-quote-main"><div><span class="wb-kicker">ТЕКУЩАЯ ЦЕНА · '+esc(asset)+'</span><strong>'+priceText(currentQuote.price)+'</strong><small class="'+(stale?'wb-stale':'wb-fresh')+'">'+(stale?'УСТАРЕВШИЙ ТИК':'ЖИВОЙ ПОТОК')+' · '+esc(quoteAgeText(currentQuote.ts))+'</small></div><div class="wb-quote-delta"><span>К последнему закрытию</span><b class="'+(delta==null?'':delta>=0?'wb-fresh':'wb-stale')+'">'+(delta==null?'—':(delta>0?'+':'')+priceText(delta))+'</b><small>'+(pct==null?'—':(pct>0?'+':'')+pct.toFixed(4)+'%')+'</small></div></div><small class="wb-source-note">Источник: последний тик, принятый из рыночного потока Pocket Option. Это не отдельный запрос котировки с сайта.</small>';
        } else {
          summary.innerHTML='<div class="wb-quote-main"><div><span class="wb-kicker">ТЕКУЩАЯ ЦЕНА · '+esc(asset)+'</span><strong>Нет данных</strong><small class="wb-stale">В потоке пока нет цены для этой пары</small></div></div>';
        }
      }
      if(candles.length)renderSelection();
    } catch(error) { console.warn('[Pocket Tracker] Не удалось обновить текущую цену',error); }
  }
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
    if(!candles.length){$('wb-candles').innerHTML='<div class="empty">Ожидание живых тиков Pocket Option</div>';return;}
    const displayCandles=toHeikinAshi(candles);
    const width=Math.max(520,($('wb-candles').clientWidth||960)-24),height=390,left=66,right=104,top=20,bottom=42;
    const plotW=width-left-right,plotH=height-top-bottom,step=plotW/displayCandles.length;
    const bodyWidth=Math.max(1,Math.min(10,step*0.62));
    const values=displayCandles.flatMap(x=>[Number(x.low),Number(x.high)]);
    if(currentQuote&&Number.isFinite(currentQuote.price))values.push(currentQuote.price);
    const min=Math.min(...values),max=Math.max(...values),rawRange=max-min||1,range=rawRange*1.12;
    const low=min-rawRange*.06,high=max+rawRange*.06;
    const y=value=>top+plotH-(Number(value)-low)/(high-low)*plotH;
    const xAt=i=>left+(i+.5)*step;
    const markers={start:'#60a5fa',entry:'#facc15',end:'#c084fc'};
    const grid=Array.from({length:5},(_,i)=>{
      const value=low+(high-low)*i/4,yy=y(value);
      return '<line x1="'+left+'" x2="'+(width-right)+'" y1="'+yy+'" y2="'+yy+'" stroke="#64748b" stroke-opacity=".24" stroke-dasharray="3 4"/><text x="'+(left-8)+'" y="'+(yy+4)+'" text-anchor="end" fill="#91a3bd" font-size="10">'+esc(priceText(value))+'</text>';
    }).join('');
    const bars=displayCandles.map((bar,i)=>{
      const x=xAt(i),open=y(bar.open),close=y(bar.close),topBody=Math.min(open,close),body=Math.max(1,Math.abs(close-open));
      const selected=Object.keys(selection).filter(k=>selection[k]===i);
      const fill=selected.length?markers[selected[0]]:(bar.close>=bar.open?'#22c55e':'#ef4444');
      const marker=selected.length?'<text x="'+x+'" y="'+(top+9)+'" text-anchor="middle" fill="'+fill+'" font-size="9">'+selected.map(k=>k[0].toUpperCase()).join('/')+'</text>':'';
      return '<g data-wb-index="'+i+'" style="cursor:pointer"><title>'+esc(stamp(candles[i].startAt))+' · HA O '+priceText(bar.open)+' H '+priceText(bar.high)+' L '+priceText(bar.low)+' C '+priceText(bar.close)+' · источник O '+priceText(candles[i].open)+' H '+priceText(candles[i].high)+' L '+priceText(candles[i].low)+' C '+priceText(candles[i].close)+'</title>'+marker+'<line x1="'+x+'" x2="'+x+'" y1="'+y(bar.high)+'" y2="'+y(bar.low)+'" stroke="'+fill+'" stroke-width="1.2"/><rect x="'+(x-bodyWidth/2)+'" y="'+topBody+'" width="'+bodyWidth+'" height="'+body+'" rx=".6" fill="'+fill+'"/></g>';
    }).join('');
    const labels=[0,Math.floor((candles.length-1)/2),candles.length-1].filter((v,i,a)=>a.indexOf(v)===i).map(i=>'<text x="'+xAt(i)+'" y="'+(height-12)+'" text-anchor="middle" fill="#91a3bd" font-size="10">'+esc(new Date(candles[i].startAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'}))+'</text>').join('');
    const quoteLine=currentQuote&&Number.isFinite(currentQuote.price)?'<line x1="'+left+'" x2="'+(width-right)+'" y1="'+y(currentQuote.price)+'" y2="'+y(currentQuote.price)+'" stroke="#fbbf24" stroke-width="1.5" stroke-dasharray="6 4"/><rect x="'+(width-right+5)+'" y="'+(y(currentQuote.price)-10)+'" width="'+(right-9)+'" height="20" rx="4" fill="#854d0e"/><text x="'+(width-right+10)+'" y="'+(y(currentQuote.price)+4)+'" fill="#fff7d6" font-size="10">'+esc(priceText(currentQuote.price))+'</text>':'';
    const svg='<div class="wb-chart-scroll"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+width+' '+height+'" width="'+width+'" height="'+height+'" role="img" aria-label="График Heikin Ashi с линией текущей цены">'+grid+'<line x1="'+left+'" x2="'+left+'" y1="'+top+'" y2="'+(height-bottom)+'" stroke="#64748b" stroke-opacity=".4"/>'+bars+quoteLine+labels+'</svg></div>';
    const idx=activeCandleIndex!=null&&candles[activeCandleIndex]?activeCandleIndex:candles.length-1;
    const raw=candles[idx],ha=displayCandles[idx];
    const sourceLabel=raw.source==='live-ticks'?'Живой поток Pocket Option · тики':raw.source==='provider-ohlc'?'OHLC Pocket Option':raw.source==='provider-ohlc-aggregated'?'OHLC Pocket Option · агрегировано из '+raw.sourcePeriodSec+' с':'Данные котировок';
    const details='<div class="wb-candle-details"><div class="wb-detail-heading"><b>Свеча '+(idx+1)+' / '+candles.length+'</b><span>'+esc(stamp(raw.startAt))+' — '+esc(stamp(raw.endAt))+'</span></div><div class="wb-source-note">Источник этой свечи: '+esc(sourceLabel)+'</div><div class="wb-detail-grid"><div><small>Источник · OHLC</small><b>O '+priceText(raw.open)+'</b><b>H '+priceText(raw.high)+'</b><b>L '+priceText(raw.low)+'</b><b>C '+priceText(raw.close)+'</b></div><div><small>Heikin Ashi · OHLC</small><b>O '+priceText(ha.open)+'</b><b>H '+priceText(ha.high)+'</b><b>L '+priceText(ha.low)+'</b><b>C '+priceText(ha.close)+'</b></div><div><small>Изменение свечи</small><b class="'+(raw.close>=raw.open?'wb-fresh':'wb-stale')+'">'+(raw.close>=raw.open?'+':'')+priceText(raw.close-raw.open)+'</b><b>'+(raw.open?((raw.close-raw.open)/raw.open*100).toFixed(4)+'%':'—')+'</b><small>Размах: '+priceText(raw.high-raw.low)+'</small></div></div></div>';
    $('wb-candles').innerHTML=svg+details+'<small class="wb-chart-hint">Свечи отображаются в Heikin Ashi. Жёлтая пунктирная линия — текущая цена из живого тика; значения исходного OHLC и Heikin Ashi показаны отдельно. Нажми на свечу для просмотра её параметров и отметки.</small>';
  }
  async function loadAssets() {
    const rows=await api.getAnalysisAssets(),select=$('wb-asset'),previous=select.value;
    select.innerHTML='<option value="">Выбери OTC-пару</option>'+rows.map(x=>'<option value="'+esc(x.asset)+'">'+esc(x.asset)+'</option>').join('');
    if(rows.some(x=>x.asset===previous))select.value=previous;
    say('В потоке обнаружено OTC-пар: '+rows.length+'.');
    await refreshCurrentQuote();
  }
  async function loadCandles() {
    const asset=$('wb-asset').value, timeframe=$('wb-timeframe').value, limit=Number($('wb-limit').value);
    if(!asset)throw new Error('Сначала выбери OTC-пару.');
    candles=await api.getAnalysisCandles({asset,timeframe,limit});
    selection={start:null,entry:null,end:null};
    activeCandleIndex=candles.length?candles.length-1:null;
    renderSelection();
    if(!candles.length) {
      say('Ожидание живых тиков Pocket Option для '+asset+' · '+timeframe+'. Исторические данные отключены.');
      return;
    }
    const last=candles[candles.length-1];
    say('Живой график · '+asset+' · '+timeframe+' · свечей текущей сессии: '+candles.length+
      ' · последняя цена '+priceText(last.close)+' · обновляется по тикам Pocket Option.');
    await refreshExamples();
  }
  async function refreshLiveChart() {
    const asset=$('wb-asset').value;
    if(!asset)return;
    try {
      const limit=Number($('wb-limit').value)||300;
      const next=await api.getAnalysisCandles({asset,timeframe:$('wb-timeframe').value,limit});
      candles=next;
      activeCandleIndex=candles.length?candles.length-1:null;
      renderSelection();
      await refreshCurrentQuote();
      if(!candles.length) say('Ожидание первого живого тика для '+asset+'. Исторические данные не используются.');
    } catch(error) { console.warn('[Pocket Tracker] Ошибка обновления живого графика',error); }
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
  $('wb-candles').addEventListener('click',e=>{const b=e.target.closest('[data-wb-index]');if(!b)return;const i=Number(b.dataset.wbIndex);if(!Number.isInteger(i)||!candles[i])return;selection[mode]=i;activeCandleIndex=i;renderSelection();});
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
  quoteTimer=setInterval(()=>refreshLiveChart(),1000);
  $('wb-asset').addEventListener('change',()=>{candles=[];currentQuote=null;loadCandles().catch(e=>say(e.message));});
  loadAssets().catch(e=>say(e.message));refreshExamples().catch(e=>say(e.message));refreshJournal().catch(e=>say(e.message));loadAnalysisSettings().catch(e=>say(e.message));
})();
