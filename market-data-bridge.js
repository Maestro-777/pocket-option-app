(() => {
'use strict';
if(window.__PT_MARKET_DATA_BRIDGE__)return;
window.__PT_MARKET_DATA_BRIDGE__=true;
const NativeWebSocket=window.WebSocket;
if(typeof NativeWebSocket!=='function')return;
const ALLOWED=new Set(['updateAssets','updateStream','quotes/stream','updateHistoryNewFast','updateHistoryNew','loadHistoryPeriod','loadHistoryPeriodFast','history/list/v2']);
const MAX_ROWS=5000,MAX_HISTORY=10000;
let sequence=0,activeSocket=null;
function publish(name,payload,ws){
 if(!ALLOWED.has(name))return;
 if(ws&&ws.readyState===1)activeSocket=ws;
 const rows=Array.isArray(payload)?payload:[payload];
 if(!rows.length||rows.length>MAX_ROWS)return;
 const safe=[];
 for(const row of rows){
  if(safe.length>=MAX_ROWS)break;
  if(name.startsWith('updateHistory')||name.startsWith('loadHistory')||name==='history/list/v2'){
   const data=Array.isArray(row)?row[0]:row;
   if(data&&typeof data==='object'){
    const asset=data.asset||data.symbol,history=Array.isArray(data.history)?data.history:Array.isArray(data.data)?data.data:null;
    if(typeof asset==='string'&&history&&history.length<=MAX_HISTORY){
     const clean=history.map(item=>Array.isArray(item)?item.slice(0,5):item&&typeof item==='object'?{time:item.time,t:item.t,ts:item.ts,timestamp:item.timestamp,open:item.open,o:item.o,high:item.high,h:item.h,low:item.low,l:item.l,close:item.close,c:item.c,price:item.price,p:item.p}:null).filter(Boolean);
     safe.push({asset,period:data.period,history:clean});
    }
   }
  }else if(name==='updateAssets'){
   if(Array.isArray(row)&&row.length>=2&&typeof row[1]==='string')safe.push(row.slice(0,3));
   else if(row&&typeof row==='object'){const symbol=row.rawSymbol||row.symbol||row.asset||row.code||row.s;if(typeof symbol==='string')safe.push({rawSymbol:symbol,symbol,name:row.name||row.title||row.label||row.n||symbol});}
  }else if(Array.isArray(row)&&row.length>=3&&typeof row[0]==='string')safe.push([row[0],row[1],row[2]]);
  else if(row&&typeof row==='object'){
   const asset=row.asset||row.symbol;if(typeof asset!=='string')continue;
   if(Array.isArray(row.prices)){for(const t of row.prices){if(t&&typeof t==='object')safe.push({asset,timestamp:t.timestamp??t.time??t.ts,price:t.price??t.p});if(safe.length>=MAX_ROWS)break;}}
   else safe.push({asset,timestamp:row.timestamp??row.ts??row.time,price:row.price??row.close??row.p});
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
async function waitForAsset(expected,timeout=6000){
 const start=Date.now();while(Date.now()-start<timeout){if(readCurrentAsset()===expected)return true;await sleep(100);}return false;
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
function expirationSecondsFromText(text){
 const value=String(text||'').trim();if(!value)return null;
 const parts=value.split(':').map(x=>Number(x));if(parts.some(x=>!Number.isInteger(x)))return null;
 if(parts.length===3)return parts[0]*3600+parts[1]*60+parts[2];
 if(parts.length===2)return parts[0]*60+parts[1];return null;
}
function readExpiration(){
 const display=document.querySelector('.block--expiration-inputs .value__val')||document.querySelector('.block--expiration-inputs .control__value .value__val');
 if(display){const seconds=expirationSecondsFromText(display.textContent);if(seconds!=null)return seconds;}
 const active=document.querySelector('.dops__timeframes-item--active, .dops__timeframes-item.active');
 if(active){const seconds=expirationSecondsFromText(active.textContent);if(seconds!=null)return seconds;}
 return null;
}
function expirationLabels(seconds){
 const h=Math.floor(seconds/3600),m=Math.floor((seconds%3600)/60),s=seconds%60;
 const clock=[h,m,s].map((x,i)=>i===0?String(x).padStart(2,'0'):String(x).padStart(2,'0')).join(':');
 const minuteClock=[m,s].map(x=>String(x).padStart(2,'0')).join(':');
 return new Set([String(seconds),String(seconds)+'S','S'+seconds,clock,minuteClock]);
}
function openExpirationDropdown(){
 const selectors=['.block--expiration-inputs .control__value.value','.block--expiration-inputs .control__value','.block--expiration-inputs .value__val','.block--expiration-inputs'];
 for(const selector of selectors){const el=document.querySelector(selector);if(el&&el.offsetParent!==null){el.click();return true;}}return false;
}
async function setExpiration(seconds){
 if(readExpiration()===seconds)return true;const labels=expirationLabels(seconds);
 for(let attempt=0;attempt<2;attempt++){
  openExpirationDropdown();await sleep(140);
  const items=document.querySelectorAll('.trading-panel-modal__dops .dops__timeframes-item, .dops__timeframes .dops__timeframes-item, .dops__timeframes-item');
  for(const el of items){
   if(el.offsetParent===null)continue;
   const chunks=[el.textContent,el.getAttribute('data-time'),el.getAttribute('data-value'),el.getAttribute('data-period'),el.getAttribute('title')];
   const match=chunks.some(text=>labels.has(String(text||'').trim().toUpperCase().replace(/\s+/g,'')));
   if(!match)continue;
   try{el.scrollIntoView({block:'nearest',inline:'center'});el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window}));el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window}));el.click();}catch(_){}
   await sleep(140);if(readExpiration()===seconds)return true;
  }
 }
 return false;
}
function findTradeButton(direction){
 const selectors=direction==='UP'?['a.btn.btn-call','.btn.btn-call','a.btn-call','.btn-call','[data-test="call-button"]','[data-x-test="up"]']:['a.btn.btn-put','.btn.btn-put','a.btn-put','.btn-put','[data-test="put-button"]','[data-x-test="down"]'];
 for(const selector of selectors){const button=document.querySelector(selector);if(button&&button.offsetParent!==null&&!button.classList.contains('disabled')&&button.getAttribute('aria-disabled')!=='true')return button;}
 return null;
}
window.__PT_TRADE_COMMAND__=async request=>{
 try{
  if(!request||request.version!==1||!['UP','DOWN'].includes(request.direction))return{ok:false,reason:'invalid_request'};
  const asset=normalizeAssetName(request.asset),rawAsset=String(request.rawAsset||'');
  const amount=Number(request.amount),expiry=Number(request.expirySeconds);
  if(!asset||!rawAsset||!Number.isFinite(amount)||amount<=0||amount>100000||!Number.isInteger(expiry)||expiry<1||expiry>86400)return{ok:false,reason:'invalid_trade_parameters'};
  if(!activeSocket||activeSocket.readyState!==1)return{ok:false,reason:'market_socket_not_ready'};
  let actualAsset=readCurrentAsset();
  if(actualAsset!==asset){
   activeSocket.send('42["changeSymbol",'+JSON.stringify({asset:rawAsset,period:60})+']');
   if(!await waitForAsset(asset,Number(request.switchTimeoutMs)||6000))return{ok:false,reason:'asset_switch_not_confirmed',actualAsset:readCurrentAsset()};
   actualAsset=readCurrentAsset();
  }
  if(actualAsset!==asset)return{ok:false,reason:'asset_mismatch_before_order',actualAsset};
  if(!setAmount(amount))return{ok:false,reason:'amount_not_applied'};
  if(!await setExpiration(expiry))return{ok:false,reason:'expiration_not_applied',actualExpiration:readExpiration()};
  actualAsset=readCurrentAsset();if(actualAsset!==asset)return{ok:false,reason:'asset_changed_before_click',actualAsset};
  const button=findTradeButton(request.direction);if(!button)return{ok:false,reason:'trade_button_unavailable'};
  button.click();
  const result={ok:true,submitted:true,confirmed:false,asset,direction:request.direction,amount,expirySeconds:expiry,submittedAt:Date.now(),confirmation:'awaiting_platform_result'};
  window.__PT_LAST_TRADE_SUBMISSION__=result;return result;
 }catch(error){return{ok:false,reason:'trade_command_error',message:String(error&&error.message||error)};}
};
})();