'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {getTimeframeDuration}=require('./timeframes');
const {validateCandles}=require('./patterns');
const SCHEMA_VERSION=1,DIRECTIONS=new Set(['UP','DOWN']),clone=v=>JSON.parse(JSON.stringify(v));
function validateExample(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('Пример должен быть объектом');
  const pair=String(input.pair||'').trim().toUpperCase();if(!pair||pair.length>64)throw new TypeError('Некорректная валютная пара');
  const timeframe=String(input.timeframe||'').toUpperCase();getTimeframeDuration(timeframe);
  const startAt=Number(input.startAt),endAt=Number(input.endAt),entryAt=Number(input.entryAt);
  if(![startAt,endAt,entryAt].every(Number.isFinite)||startAt<=0||endAt<=startAt||entryAt<startAt||entryAt>endAt)throw new RangeError('Некорректные границы участка или точки входа');
  const direction=String(input.direction||'').toUpperCase();if(!DIRECTIONS.has(direction))throw new TypeError('Направление должно быть UP или DOWN');
  const expirySeconds=Number(input.expirySeconds);if(!Number.isFinite(expirySeconds)||expirySeconds<=0||expirySeconds>86400)throw new RangeError('Экспирация должна быть от 1 до 86400 секунд');
  const preEntryCandles=validateCandles(input.preEntryCandles,{timeframe,entryAt});if(preEntryCandles.length>10000)throw new RangeError('Слишком много свечей');
  const outcomeCandles=input.outcomeCandles==null?[]:input.outcomeCandles;if(!Array.isArray(outcomeCandles))throw new TypeError('outcomeCandles должен быть массивом');if(outcomeCandles.length>10000)throw new RangeError('Слишком много пост-входовых свечей');
  const outcome=String(input.outcome||'UNKNOWN').toUpperCase();if(!['WIN','LOSS','DRAW','UNKNOWN'].includes(outcome))throw new TypeError('outcome должен быть WIN, LOSS, DRAW или UNKNOWN');
  let previousEnd=entryAt;const duration=getTimeframeDuration(timeframe);
  for(let i=0;i<outcomeCandles.length;i++){const c=outcomeCandles[i];if(!c||typeof c!=='object')throw new TypeError('Некорректная пост-входовая свеча');
    const start=Number(c.startAt),end=Number(c.endAt),o=Number(c.open),h=Number(c.high),l=Number(c.low),cl=Number(c.close);
    if(![start,end,o,h,l,cl].every(Number.isFinite)||start<entryAt||end<=start||end-start!==duration||start<previousEnd||c.complete!==true||o<=0||h<=0||l<=0||cl<=0||h<Math.max(o,cl,l)||l>Math.min(o,cl,h))throw new RangeError('Некорректная пост-входовая свеча: ожидаются закрытые OHLC-свечи после точки входа');
    previousEnd=end;
  }
  return {id:input.id?String(input.id):crypto.randomUUID(),pair,timeframe,startAt,endAt,entryAt,direction,expirySeconds,outcome,preEntryCandles,outcomeCandles:outcomeCandles.map(c=>({...c})),createdAt:input.createdAt?String(input.createdAt):new Date().toISOString(),updatedAt:input.updatedAt?String(input.updatedAt):new Date().toISOString()};
}
class ExampleStore{
  constructor(filePath){if(!filePath||typeof filePath!=='string')throw new TypeError('Не указан путь к хранилищу');this.filePath=path.resolve(filePath);this.queue=Promise.resolve();this.cache=null;}
  async _read(){if(this.cache)return this.cache.map(clone);try{const data=JSON.parse(await fs.readFile(this.filePath,'utf8'));if(!data||data.schemaVersion!==SCHEMA_VERSION||!Array.isArray(data.examples))throw new Error('Неизвестный формат базы примеров');this.cache=data.examples.map(validateExample);}catch(e){if(e.code!=='ENOENT')throw e;this.cache=[];}return this.cache.map(clone);}
  async _write(rows){await fs.mkdir(path.dirname(this.filePath),{recursive:true});const temp=this.filePath+'.'+process.pid+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';const h=await fs.open(temp,'wx',0o600);try{await h.writeFile(JSON.stringify({schemaVersion:SCHEMA_VERSION,examples:rows},null,2),'utf8');await h.sync();}catch(e){await h.close().catch(()=>{});await fs.unlink(temp).catch(()=>{});throw e;}await h.close();try{await fs.rename(temp,this.filePath);}catch(e){await fs.unlink(temp).catch(()=>{});throw e;}this.cache=rows;}
  _serialize(task){const next=this.queue.then(task);this.queue=next.catch(()=>{});return next;}
  async list(filters={}){const rows=await this._read();return rows.filter(r=>(!filters.timeframe||r.timeframe===String(filters.timeframe).toUpperCase())&&(!filters.pair||r.pair===String(filters.pair).toUpperCase())).map(clone);}
  add(input){return this._serialize(async()=>{const row=validateExample(input),rows=await this._read();if(rows.some(x=>x.id===row.id))throw new Error('Пример с таким id уже существует');rows.push(row);await this._write(rows);return clone(row);});}
  update(id,patch){return this._serialize(async()=>{const rows=await this._read(),i=rows.findIndex(r=>r.id===String(id));if(i<0)throw new Error('Пример не найден');const row=validateExample({...rows[i],...patch,id:rows[i].id,createdAt:rows[i].createdAt});rows[i]=row;await this._write(rows);return clone(row);});}
  remove(id){return this._serialize(async()=>{const rows=await this._read(),next=rows.filter(r=>r.id!==String(id));if(next.length===rows.length)return false;await this._write(next);return true;});}
}
module.exports={ExampleStore,validateExample,SCHEMA_VERSION};
