'use strict';
const fs=require('node:fs/promises'),fsSync=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
class MarketDataStore{
 constructor(service,filePath){if(!service||typeof service.exportSnapshot!=='function'||typeof service.restoreSnapshot!=='function')throw new TypeError('Некорректный MarketDataService');if(!filePath||typeof filePath!=='string')throw new TypeError('Не указан путь снимка рыночных данных');this.service=service;this.filePath=path.resolve(filePath);this.queue=Promise.resolve();}
 async load(){try{const raw=await fs.readFile(this.filePath,'utf8');const snapshot=JSON.parse(raw);return this.service.restoreSnapshot(snapshot);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
 _serialize(task){const next=this.queue.then(task);this.queue=next.catch(()=>{});return next;}
 save(){return this._serialize(async()=>{const snapshot=this.service.exportSnapshot();await fs.mkdir(path.dirname(this.filePath),{recursive:true});const temp=this.filePath+'.'+process.pid+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';const handle=await fs.open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify(snapshot),'utf8');await handle.sync();}catch(error){await handle.close().catch(()=>{});await fs.unlink(temp).catch(()=>{});throw error;}await handle.close();try{await fs.rename(temp,this.filePath);}catch(error){await fs.unlink(temp).catch(()=>{});throw error;}return{savedAt:snapshot.savedAt,ticks:snapshot.ticks.length,historyCandles:snapshot.history.length};});}
 saveSync(){const snapshot=this.service.exportSnapshot();fsSync.mkdirSync(path.dirname(this.filePath),{recursive:true});const temp=this.filePath+'.'+process.pid+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';try{fsSync.writeFileSync(temp,JSON.stringify(snapshot),{encoding:'utf8',mode:0o600,flag:'wx'});// Windows/OneDrive may reject fsync on a read-only handle (EPERM).
// writeFileSync has completed before the same-volume atomic rename.
fsSync.renameSync(temp,this.filePath);return{savedAt:snapshot.savedAt,ticks:snapshot.ticks.length,historyCandles:snapshot.history.length};}catch(error){try{fsSync.unlinkSync(temp);}catch(_){}throw error;}}
}
module.exports={MarketDataStore};
