'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const EVENT_TYPES=new Set(['DECISION','SIGNAL','TRADE_OPENED','TRADE_CLOSED','TRADE_REJECTED','TRADING_PAUSED','TRADING_RESUMED']);
const SECRET_KEY=/^(password|passwd|token|access_token|refresh_token|cookie|set-cookie|authorization|secret|privatekey)$/i;
function assertSafePayload(value,depth=0){if(depth>20)throw new RangeError('Слишком глубокий объект журнала');if(value==null||['string','number','boolean'].includes(typeof value)){if(typeof value==='number'&&!Number.isFinite(value))throw new TypeError('Журнал не принимает NaN/Infinity');if(typeof value==='string'&&value.length>100000)throw new RangeError('Строка журнала слишком длинная');return;}if(Array.isArray(value)){if(value.length>20000)throw new RangeError('Слишком большой массив журнала');for(const x of value)assertSafePayload(x,depth+1);return;}if(typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype)throw new TypeError('Недопустимый тип значения в журнале');for(const [k,v] of Object.entries(value)){if(SECRET_KEY.test(k))throw new TypeError('Запрещено сохранять секретное поле: '+k);assertSafePayload(v,depth+1);}}
class DecisionJournal{
 constructor(filePath){if(!filePath||typeof filePath!=='string')throw new TypeError('Не указан путь журнала');this.filePath=path.resolve(filePath);this.queue=Promise.resolve();}
 append(type,payload,snapshot={}){return Promise.resolve().then(()=>this.appendMany([{type,payload,settingsSnapshot:snapshot}])).then(rows=>rows[0]);}
 appendMany(items){
  if(!Array.isArray(items)||items.length>10000)return Promise.reject(new RangeError('appendMany принимает массив до 10000 событий'));
  const events=items.map(item=>{const t=String(item&&item.type||'').toUpperCase();if(!EVENT_TYPES.has(t))throw new TypeError('Неизвестный тип события журнала');const payload=item.payload??{},snapshot=item.settingsSnapshot??{};assertSafePayload(payload);assertSafePayload(snapshot);const event={id:crypto.randomUUID(),at:new Date().toISOString(),type:t,payload,settingsSnapshot:snapshot};const line=JSON.stringify(event)+'\n';if(Buffer.byteLength(line,'utf8')>1000000)throw new RangeError('Событие журнала превышает 1 МБ');return{event,line};});
  const text=events.map(x=>x.line).join('');if(Buffer.byteLength(text,'utf8')>5000000)return Promise.reject(new RangeError('Пакет журнала превышает 5 МБ'));
  const next=this.queue.then(async()=>{if(!events.length)return[];await fs.mkdir(path.dirname(this.filePath),{recursive:true});const h=await fs.open(this.filePath,'a',0o600);try{await h.writeFile(text,'utf8');await h.sync();}finally{await h.close();}return events.map(x=>x.event);});
  this.queue=next.catch(()=>{});return next;
 }
}
module.exports={DecisionJournal,EVENT_TYPES,assertSafePayload};
