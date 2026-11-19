(() => {
'use strict';
if(window.__PT_MARKET_DATA_BRIDGE__)return;
window.__PT_MARKET_DATA_BRIDGE__=true;
const NativeWebSocket=window.WebSocket;
if(typeof NativeWebSocket!=='function')return;
const ALLOWED=new Set(['updateAssets','updateStream','quotes/stream','updateHistoryNewFast','updateHistoryNew','loadHistoryPeriod','loadHistoryPeriodFast','history/list/v2','successcloseOrder','s_orders/close']);
const MAX_ROWS=5000,MAX_HISTORY=10000;
let sequence=0,activeSocket=null;const cancelledTradeCommands=new Set();
function publish(name,payload,ws){
 if(!ALLOWED.has(name))return;
 if(ws&&ws.readyState===1)activeSocket=ws;
 const rows=Array.isArray(payload)?payload:[payload];
 if(!rows.length||rows.length>MAX_ROWS)return;
 const safe=[],bounded=v=>typeof v==='string'?v.slice(0,32):v;
 for(const row of rows){
  if(safe.length>=MAX_ROWS)break;
  if(name==='successcloseOrder'||name==='s_orders/close'){
   const deals=Array.isArray(row)?row:Array.isArray(row&&row.deals)?row.deals:null;
   const cleanDeal=item=>{
    if(!item||typeof item!=='object')return null;const out={},str=(v,n)=>v==null?undefined:String(v).slice(0,n),num=v=>Number.isFinite(Number(v))?Number(v):undefined;
    for(const key of ['id','ticket']){const v=str(item[key],128);if(v!==undefined)out[key]=v;}
    for(const key of ['asset','symbol','pair']){const v=str(item[key],64);if(v!==undefined)out[key]=v;}
    for(const key of ['direction','status','result']){const v=str(item[key],24);if(v!==undefined)out[key]=v;}
    for(const key of ['amount','investment','profit','netProfit','percentProfit','timestamp','time']){const v=num(item[key]);if(v!==undefined)out[key]=v;}
    return out;
   };
   if(deals){const clean=deals.map(cleanDeal).filter(Boolean);if(clean.length){const wrapper={deals:clean},balance=Number((row&&row.balance)??(row&&row.wallet));if(Number.isFinite(balance)&&balance>=0)wrapper.balance=balance;safe.push(wrapper);}}
   else{const clean=cleanDeal(row);if(clean)safe.push(clean);}
  }else if(name.startsWith('updateHistory')||name.startsWith('loadHistory')||name==='history/list/v2'){
   const data=Array.isArray(row)?row[0]:row;
   if(data&&typeof data==='object'){
    const asset=data.asset||data.symbol,history=Array.isArray(data.history)?data.history:Array.isArray(data.data)?data.data:null;
    if(typeof asset==='string'&&asset.length<=64&&history&&history.length<=MAX_HISTORY){
     const clean=history.map(item=>Array.isArray(item)?item.slice(0,5).map(v=>typeof v==='string'?v.slice(0,32):v):item&&typeof item==='object'?{time:bounded(item.time),t:bounded(item.t),ts:bounded(item.ts),timestamp:bounded(item.timestamp),open:bounded(item.open),o:bounded(item.o),high:bounded(item.high),h:bounded(item.h),low:bounded(item.low),l:bounded(item.l),close:bounded(item.close),c:bounded(item.c),price:bounded(item.price),p:bounded(item.p)}:null).filter(Boolean);
     safe.push({asset,period:data.period,history:clean});
    }
   }
  }else if(name==='updateAssets'){
   if(Array.isArray(row)&&row.length>=2&&typeof row[1]==='string'&&row[1].length<=64)safe.push([row[0],row[1],typeof row[2]==='string'?row[2].slice(0,100):row[2]]);
   else if(row&&typeof row==='object'){const symbol=row.rawSymbol||row.symbol||row.asset||row.code||row.s;if(typeof symbol==='string'&&symbol.length<=64)safe.push({rawSymbol:symbol,symbol,name:String(row.name||row.title||row.label||row.n||symbol).slice(0,100)});}
  }else if(Array.isArray(row)&&row.length>=3&&typeof row[0]==='string'&&row[0].length<=64)safe.push([row[0],bounded(row[1]),bounded(row[2])]);
  else if(row&&typeof row==='object'){
   const asset=row.asset||row.symbol;if(typeof asset!=='string'||asset.length>64)continue;
   if(Array.isArray(row.prices)){for(const t of row.prices){if(t&&typeof t==='object')safe.push({asset,timestamp:bounded(t.timestamp??t.time??t.ts),price:bounded(t.price??t.p)});if(safe.length>=MAX_ROWS)break;}}
   else safe.push({asset,timestamp:bounded(row.timestamp??row.ts??row.time),price:bounded(row.price??row.close??row.p)});
  }
 }
 if(!safe.length)return;
 sequence++;
 window.postMessage({type:'PT_MARKET_DATA',version:1,eventName:name,payload:safe,sequence,receivedAt:Date.now()},location.origin);
}
function parseText(text,ws){
 if(typeof text!=='string')return null;const i=text.search(/[\[{]/);if(i<0)return null;
 try{const p=JSON.parse(text.slice(i));if(Array.isArray(p)&&typeof p[0]==='string')return{name:p[0],payload:p[1],ws};}catch(_){}
 return null;
}
function decodeBinary(data){
 try{
  if(data instanceof Blob){if(data.size>2000000)return null;return data.arrayBuffer().then(decodeBinary);}
  if(data instanceof ArrayBuffer&&data.byteLength>2000000)return null;
  let b=data;if(data instanceof ArrayBuffer)b=new Uint8Array(data);
  if(ArrayBuffer.isView(data))b=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
  if(!(b instanceof Uint8Array))return null;
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));
 }catch(_){return null;}
}
const Patched=new Proxy(NativeWebSocket,{construct(target,args,newTarget){
 const ws=Reflect.construct(target,args,newTarget);let pending=null;
 ws.addEventListener('message',event=>{
  try{
   if(typeof event.data==='string'){
    const p=parseText(event.data,ws);if(!p)return;
    if(p.payload&&p.payload._placeholder===true){pending=p.name;return;}
    pending=null;publish(p.name,p.payload,ws);return;
   }
   if(event.data instanceof ArrayBuffer||event.data instanceof Blob||ArrayBuffer.isView(event.data)){
    const expected=pending;pending=null;if(!expected||!ALLOWED.has(expected))return;
    const decoded=decodeBinary(event.data);
    if(decoded&&typeof decoded.then==='function')decoded.then(v=>publish(expected,v,ws)).catch(()=>{});
    else if(decoded!==null)publish(expected,decoded,ws);
   }
  }catch(_){/* do not break Pocket Option */}
 });
 return ws;
}});
window.WebSocket=Patched;

function normalizeAssetName(raw){
 if(!raw)return'';let value=String(raw).trim().toUpperCase();
 const otc=/\bOTC\b/.test(value)||/_OTC$/.test(value);
 value=value.replace(/\bOTC\b/g,'').replace(/_OTC$/,'').replace(/\s+/g,'').replace(/[^A-Z0-9_]/g,'');
 if(otc&&value&&!value.endsWith('_OTC'))value+='_OTC';return value;
}
function extractAsset(el){
 if(!el)return'';const data=el.getAttribute&&(el.getAttribute('data-asset')||el.getAttribute('data-symbol')||el.getAttribute('data-pair'));
 if(data){const normalized=normalizeAssetName(data);if(normalized.length>=4)return normalized;}
 let text=(el.textContent||'').trim().split(/\n/)[0].trim().replace(/\s*\(?\s*OTC\s*\)?\s*$/i,' OTC');
 const normalized=normalizeAssetName(text);return normalized.length>=4?normalized:'';
}
function visible(el){if(!el||!el.getBoundingClientRect)return false;const r=el.getBoundingClientRect();return r.width>0&&r.height>0;}
function readCurrentAsset(){
 try{
  const active=document.querySelector('.assets-block__item--active, .assets-block__item.active, [class*="asset-item"].active, [class*="asset-item--active"], .pairs-list__item.active, .pairs-list__item--active');
  if(active){const asset=extractAsset(active);if(asset)return asset;}
  const selectors=['.current-symbol','.pair-number-wrap .pair','.block__title-pair','[class*="current-pair"]','[class*="currentPair"]','[class*="symbol-name"]','[class*="symbolName"]','[class*="asset-name"]','[class*="assetName"]','[class*="pair-name"]','[class*="pairName"]','.a-symbol__name','.chart-symbol','[class*="instrument-name"]','[class*="current-asset"]'];
  for(const selector of selectors)for(const el of document.querySelectorAll(selector)){if(!visible(el))continue;const asset=extractAsset(el);if(asset)return asset;}
  for(const el of document.querySelectorAll('[data-asset], [data-symbol], [data-pair]')){if(!visible(el))continue;const asset=extractAsset(el);if(asset)return asset;}
 }catch(_){}
 return'UNKNOWN';
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForAsset(expected,timeout=6000,isCancelled=()=>false){
 const start=Date.now();while(Date.now()-start<timeout){if(isCancelled())return false;if(readCurrentAsset()===expected)return true;await sleep(100);}return false;
}
function findBetInput(){
 const selectors=['.value__val input[type="text"]','.value__val input','.control__value input[type="text"]','.control__value input','.block__control.control input[type="text"]','.block__control input','input[inputmode="decimal"]','.bet-input','input[class*="bet"]','input[class*="amount"]'];
 for(const selector of selectors){const input=document.querySelector(selector);if(input&&input.offsetParent!==null)return input;}return null;
}
function setInputValue(input,value){
 input.focus();const descriptor=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
 if(descriptor&&descriptor.set)descriptor.set.call(input,String(value));else input.value=String(value);
 input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));input.dispatchEvent(new Event('blur',{bubbles:true}));
}
function formatAmount(value){const n=Number(value);return Number.isInteger(n)?String(n):n.toFixed(2).replace(/\.?0+$/,'');}
function setAmount(amount){
 const input=findBetInput();if(!input)return false;const formatted=formatAmount(amount);
 try{setInputValue(input,formatted);return Math.abs(Number(String(input.value).replace(',','.'))-amount)<0.000001;}catch(_){return false;}
}
const PO_TIMEFRAMES={S3:3,S15:15,S30:30,M1:60,M3:180,M5:300,M30:1800,H1:3600,H4:14400};
function getExpirationLabels(sec){
 const map={3:['S3','3S','00:00:03','0:00:03','3SEC'],15:['S15','15S','00:00:15','0:00:15','15SEC'],30:['S30','30S','00:00:30','0:00:30','30SEC'],60:['M1','1M','00:01:00','01:00','1MIN'],180:['M3','3M','00:03:00','03:00','3MIN'],300:['M5','5M','00:05:00','05:00','5MIN'],1800:['M30','30M','00:30:00','30:00','30MIN'],3600:['H1','1H','01:00:00','1:00:00','60MIN'],14400:['H4','4H','04:00:00','4:00:00']};
 return(map[sec]||[String(sec)]).slice().sort((a,b)=>b.length-a.length);
}
function normExpLabel(text){return String(text||'').trim().toUpperCase().replace(/\s+/g,'');}
function labelMatchesExpiration(el,targets,exact){
 const chunks=[el.textContent,el.innerText,el.getAttribute('data-time'),el.getAttribute('data-value'),el.getAttribute('data-period'),el.getAttribute('title')];
 for(const chunk of chunks){const text=normExpLabel(chunk);if(!text)continue;for(const target of targets){const value=normExpLabel(target);if(text===value)return true;if(!exact&&value.length>=2&&text.indexOf(value)>=0)return true;}}
 return false;
}
function clickExpirationEl(el){
 if(!el||el.offsetParent===null)return false;
 try{el.scrollIntoView({block:'nearest',inline:'center',behavior:'instant'});el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window}));el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window}));el.click();return true;}catch(_){return false;}
}
function parseExpirationDisplay(text){
 const value=String(text||'').trim();if(!value)return null;const parts=value.split(':').map(x=>parseInt(x,10));if(parts.some(Number.isNaN))return null;
 if(parts.length===3)return parts[0]*3600+parts[1]*60+parts[2];if(parts.length===2)return parts[0]*60+parts[1];return null;
}
function getExpirationDisplayEl(){return document.querySelector('.block--expiration-inputs .value__val')||document.querySelector('.block--expiration-inputs .control__value .value__val');}
function readExpiration(){
 const display=getExpirationDisplayEl();if(display){const seconds=parseExpirationDisplay(display.textContent);if(seconds!=null)return seconds;}
 const active=document.querySelector('.dops__timeframes-item--active, .dops__timeframes-item.active');if(active){const key=normExpLabel(active.textContent);if(PO_TIMEFRAMES[key]!=null)return PO_TIMEFRAMES[key];}
 return null;
}
function expirationAlreadySet(seconds,targets){
 const current=readExpiration();if(current!=null)return current===seconds;
 const display=getExpirationDisplayEl();return!!(display&&labelMatchesExpiration(display,targets,true));
}
function isExpirationDropdownOpen(){
 const modal=document.querySelector('.trading-panel-modal__dops .dops__timeframes, .dops__timeframes');if(modal&&modal.offsetParent!==null)return true;
 for(const item of document.querySelectorAll('.dops__timeframes-item'))if(item.offsetParent!==null)return true;return false;
}
function openExpirationDropdown(){
 const triggers=['.block--expiration-inputs .control__value.value','.block--expiration-inputs .control__value','.block--expiration-inputs .value__val','.block--expiration-inputs'];
 for(const selector of triggers){const el=document.querySelector(selector);if(el&&el.offsetParent!==null&&clickExpirationEl(el))return true;}return false;
}
function clickExpirationItem(seconds,targets){
 const items=document.querySelectorAll('.trading-panel-modal__dops .dops__timeframes-item, .dops__timeframes .dops__timeframes-item, .dops__timeframes-item');let fallback=null;
 for(let pass=0;pass<2;pass++){for(const el of items){if(!labelMatchesExpiration(el,targets,pass===0))continue;if(el.className&&/active|selected|current|checked/i.test(String(el.className))&&expirationAlreadySet(seconds,targets))return true;if(!fallback)fallback=el;if(clickExpirationEl(el))return true;}if(fallback)break;}
 return fallback?clickExpirationEl(fallback):false;
}
async function setExpiration(seconds){
 const targets=getExpirationLabels(seconds);if(expirationAlreadySet(seconds,targets))return true;
 if(!isExpirationDropdownOpen()){openExpirationDropdown();await sleep(140);}
 if(clickExpirationItem(seconds,targets)){await sleep(120);if(expirationAlreadySet(seconds,targets))return true;}
 openExpirationDropdown();await sleep(160);
 if(clickExpirationItem(seconds,targets)){await sleep(120);return expirationAlreadySet(seconds,targets);}
 return false;
}
function findTradeButton(direction){
 const selectors=direction==='UP'?['a.btn.btn-call','.btn.btn-call','a.btn-call','.btn-call','[data-test="call-button"]','[data-x-test="up"]']:['a.btn.btn-put','.btn.btn-put','a.btn-put','.btn-put','[data-test="put-button"]','[data-x-test="down"]'];
 for(const selector of selectors){const button=document.querySelector(selector);if(button&&button.offsetParent!==null&&!button.classList.contains('disabled')&&button.getAttribute('aria-disabled')!=='true')return button;}
 return null;
}
window.__PT_CANCEL_TRADE_COMMAND__=tradeId=>{const id=String(tradeId||'');if(!id)return false;cancelledTradeCommands.add(id);return true;};
window.__PT_CLEAR_TRADE_COMMAND__=tradeId=>cancelledTradeCommands.delete(String(tradeId||''));
window.__PT_TRADE_COMMAND__=async request=>{
 const tradeId=String(request&&request.tradeId||'');
 try{
  if(!request||request.version!==1||!tradeId||!['UP','DOWN'].includes(request.direction))return{ok:false,reason:'invalid_request'};
  const isCancelled=()=>cancelledTradeCommands.has(tradeId);if(isCancelled())return{ok:false,reason:'cancelled_by_pause'};
  const asset=normalizeAssetName(request.asset),rawAsset=String(request.rawAsset||'');
  const amount=Number(request.amount),expiry=Number(request.expirySeconds);
  if(!asset||!rawAsset||!Number.isFinite(amount)||amount<=0||amount>100000||!Number.isInteger(expiry)||expiry<1||expiry>86400)return{ok:false,reason:'invalid_trade_parameters'};
  if(!activeSocket||activeSocket.readyState!==1)return{ok:false,reason:'market_socket_not_ready'};
  let actualAsset=readCurrentAsset();
  if(actualAsset!==asset){
   activeSocket.send('42["changeSymbol",'+JSON.stringify({asset:rawAsset,period:60})+']');
   if(!await waitForAsset(asset,Number(request.switchTimeoutMs)||6000,isCancelled))return{ok:false,reason:isCancelled()?'cancelled_by_pause':'asset_switch_not_confirmed',actualAsset:readCurrentAsset()};
   actualAsset=readCurrentAsset();
  }
  if(isCancelled())return{ok:false,reason:'cancelled_by_pause'};
  if(actualAsset!==asset)return{ok:false,reason:'asset_mismatch_before_order',actualAsset};
  if(!setAmount(amount))return{ok:false,reason:'amount_not_applied'};
  if(!await setExpiration(expiry))return{ok:false,reason:'expiration_not_applied',actualExpiration:readExpiration()};
  if(isCancelled())return{ok:false,reason:'cancelled_by_pause'};
  actualAsset=readCurrentAsset();if(actualAsset!==asset)return{ok:false,reason:'asset_changed_before_click',actualAsset};
  const button=findTradeButton(request.direction);if(!button)return{ok:false,reason:'trade_button_unavailable'};
  if(isCancelled())return{ok:false,reason:'cancelled_by_pause'};
  button.click();
  const result={ok:true,submitted:true,confirmed:false,asset,direction:request.direction,amount,expirySeconds:expiry,submittedAt:Date.now(),confirmation:'awaiting_platform_result'};
  window.__PT_LAST_TRADE_SUBMISSION__=result;return result;
 }catch(error){return{ok:false,reason:'trade_command_error',message:String(error&&error.message||error)};}finally{if(tradeId)cancelledTradeCommands.delete(tradeId);}
};
})();