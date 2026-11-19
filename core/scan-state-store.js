'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {TIMEFRAME_MS}=require('./timeframes');
const MAX_KEYS=50000;
class ScanStateStore{
 constructor(filePath){if(typeof filePath!=='string'||!filePath)throw new TypeError('Не указан путь scan state');this.filePath=path.resolve(filePath);this.queue=Promise.resolve();}
 _validate(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('scan state должен быть объектом');
  const entries=input instanceof Map?Array.from(input.entries()):Object.entries(input);if(entries.length>MAX_KEYS)throw new RangeError('Слишком много ключей scan state');
  const result={};for(const[key,value]of entries){const parts=String(key).split('|'),asset=parts[0],timeframe=parts[1],ts=Number(value);if(parts.length!==2||!asset||asset.length>64||!Object.prototype.hasOwnProperty.call(TIMEFRAME_MS,timeframe)||!Number.isFinite(ts)||ts<=0)continue;result[asset+'|'+timeframe]=ts;}
  return result;
 }
 async load(){
  let data;try{data=JSON.parse(await fs.readFile(this.filePath,'utf8'));}catch(error){if(error.code==='ENOENT')return new Map();throw error;}
  if(!data||data.schemaVersion!==1||!data.lastScanned||typeof data.lastScanned!=='object'||Array.isArray(data.lastScanned))throw new TypeError('Неизвестный формат scan state');
  const valid=this._validate(data.lastScanned);return new Map(Object.entries(valid));
 }
 save(state){
  const lastScanned=this._validate(state);
  const task=this.queue.then(async()=>{await fs.mkdir(path.dirname(this.filePath),{recursive:true});const temp=this.filePath+'.'+process.pid+'.'+crypto.randomBytes(6).toString('hex')+'.tmp',handle=await fs.open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify({schemaVersion:1,savedAt:new Date().toISOString(),lastScanned}),'utf8');await handle.sync();}catch(error){await handle.close().catch(()=>{});await fs.unlink(temp).catch(()=>{});throw error;}await handle.close();try{await fs.rename(temp,this.filePath);}catch(error){await fs.unlink(temp).catch(()=>{});throw error;}return{keys:Object.keys(lastScanned).length};});
  this.queue=task.catch(()=>{});return task;
 }
}
module.exports={ScanStateStore,MAX_KEYS};
