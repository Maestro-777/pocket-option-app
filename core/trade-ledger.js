'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const MAX_RECORDS=10000,MAX_UNMATCHED=1000;
function validateRecord(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('Запись сделки должна быть объектом');
 const tradeId=String(input.tradeId||''),signalId=String(input.signalId||''),pair=String(input.pair||'').toUpperCase(),timeframe=String(input.timeframe||'').toUpperCase(),direction=String(input.direction||'').toUpperCase();
 const amount=Number(input.amount),expirySeconds=Number(input.expirySeconds),submittedAt=Number(input.submittedAt);
 if(!tradeId||tradeId.length>200||!signalId||signalId.length>200||!pair||pair.length>64||!timeframe||!['UP','DOWN'].includes(direction)||!Number.isFinite(amount)||amount<=0||!Number.isInteger(expirySeconds)||expirySeconds<1||!Number.isFinite(submittedAt)||submittedAt<=0)throw new TypeError('Некорректные обязательные поля сделки');
 if(input.accountMode!=='DEMO')throw new TypeError('TradeLedger принимает только DEMO сделки');
 const similarity=Number(input.similarity==null?0:input.similarity),matchCount=Number(input.matchCount==null?0:input.matchCount),upVotes=Number(input.upVotes==null?0:input.upVotes),downVotes=Number(input.downVotes==null?0:input.downVotes);
 if(!Number.isFinite(similarity)||similarity<0||similarity>100||![matchCount,upVotes,downVotes].every(Number.isInteger)||matchCount<0||matchCount>100||upVotes<0||upVotes>100||downVotes<0||downVotes>100)throw new TypeError('Некорректные показатели сигнала');
 const status=String(input.status||'PREPARING');
 if(!['PREPARING','SUBMITTED_UNCONFIRMED','CLOSED','REJECTED','UNKNOWN_AFTER_RESTART'].includes(status))throw new TypeError('Неизвестный статус сделки');
 return{tradeId,signalId,pair,timeframe,direction,amount,expirySeconds,similarity,matchCount,upVotes,downVotes,accountMode:'DEMO',submittedAt,status,platformConfirmed:input.platformConfirmed===true,platformDealId:input.platformDealId==null?null:String(input.platformDealId),closedAt:input.closedAt==null?null:Number(input.closedAt),outcome:input.outcome||null,profit:input.profit==null?null:Number(input.profit),rejectReason:input.rejectReason==null?null:String(input.rejectReason)};
}
class TradeLedger{
 constructor(filePath){if(typeof filePath!=='string'||!filePath)throw new TypeError('Не указан путь TradeLedger');this.filePath=path.resolve(filePath);this.records=new Map();this.unmatched=[];this.queue=Promise.resolve();}
 async load(){
  let data;try{data=JSON.parse(await fs.readFile(this.filePath,'utf8'));}catch(error){if(error.code==='ENOENT')return this.getStatus();throw error;}
  if(!data||data.schemaVersion!==1||!Array.isArray(data.records)||!Array.isArray(data.unmatched))throw new TypeError('Неизвестный формат журнала сделок');
  if(data.records.length>MAX_RECORDS||data.unmatched.length>MAX_UNMATCHED)throw new RangeError('Журнал сделок превышает допустимый размер');
  this.records.clear();let recovered=false;for(const raw of data.records){const record=validateRecord(raw);if(this.records.has(record.tradeId))throw new Error('Повторяющийся tradeId в журнале');if(record.status==='PREPARING'||record.status==='SUBMITTED_UNCONFIRMED'){record.status='UNKNOWN_AFTER_RESTART';recovered=true;}this.records.set(record.tradeId,record);}
  this.unmatched=data.unmatched.slice(-MAX_UNMATCHED);if(recovered)await this._write();return this.getStatus();
 }
 _serialize(task){const next=this.queue.then(task);this.queue=next.catch(()=>{});return next;}
 async _write(){
  const snapshot={schemaVersion:1,savedAt:new Date().toISOString(),records:Array.from(this.records.values()).slice(-MAX_RECORDS),unmatched:this.unmatched.slice(-MAX_UNMATCHED)};
  await fs.mkdir(path.dirname(this.filePath),{recursive:true});const temp=this.filePath+'.'+process.pid+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';const h=await fs.open(temp,'wx',0o600);
  try{await h.writeFile(JSON.stringify(snapshot),'utf8');await h.sync();}catch(error){await h.close().catch(()=>{});await fs.unlink(temp).catch(()=>{});throw error;}
  await h.close();try{await fs.rename(temp,this.filePath);}catch(error){await fs.unlink(temp).catch(()=>{});throw error;}
 }
 addPending(input){return this._serialize(async()=>{const record=validateRecord({...input,status:'PREPARING'});if(this.records.has(record.tradeId))throw new Error('Сделка уже существует');if(this.records.size>=MAX_RECORDS)throw new RangeError('Журнал сделок заполнен');this.records.set(record.tradeId,record);await this._write();return{...record};});}
 markSubmitted(tradeId){return this._serialize(async()=>{const record=this.records.get(String(tradeId));if(!record||record.status!=='PREPARING')throw new Error('Подготовленная сделка не найдена');record.status='SUBMITTED_UNCONFIRMED';await this._write();return{...record};});}
 markRejected(tradeId,reason){return this._serialize(async()=>{const record=this.records.get(String(tradeId));if(!record)return null;record.status='REJECTED';record.rejectReason=String(reason||'rejected').slice(0,200);await this._write();return{...record};});}
 closeTrade(tradeId,result){return this._serialize(async()=>{const record=this.records.get(String(tradeId));if(!record||!['SUBMITTED_UNCONFIRMED','UNKNOWN_AFTER_RESTART'].includes(record.status))return null;const profit=Number(result.profit);if(!Number.isFinite(profit))throw new TypeError('Некорректная прибыль сделки');const outcome=String(result.outcome||'').toUpperCase();if(!['WIN','LOSS','DRAW'].includes(outcome))throw new TypeError('Некорректный исход сделки');record.status='CLOSED';record.closedAt=Number(result.closedAt)||Date.now();record.outcome=outcome;record.profit=profit;record.platformDealId=result.platformDealId==null?null:String(result.platformDealId);await this._write();return{...record};});}
 recordUnmatchedClose(deal){return this._serialize(async()=>{const rawAmount=deal.amount,rawProfit=deal.profit;const row={at:Date.now(),platformDealId:deal.platformDealId||null,amount:rawAmount==null?null:Number.isFinite(Number(rawAmount))?Number(rawAmount):null,asset:deal.asset||null,profit:rawProfit==null?null:Number.isFinite(Number(rawProfit))?Number(rawProfit):null,reason:String(deal.reason||'unmatched').slice(0,200)};this.unmatched.push(row);this.unmatched=this.unmatched.slice(-MAX_UNMATCHED);await this._write();return{...row};});}
 list(options={}){return Array.from(this.records.values()).filter(x=>!options.status||x.status===options.status).sort((a,b)=>b.submittedAt-a.submittedAt).map(x=>({...x}));}
 listOpen(){return this.list().filter(x=>['PREPARING','SUBMITTED_UNCONFIRMED','UNKNOWN_AFTER_RESTART'].includes(x.status));}
 getStats(){
  const closed=this.list({status:'CLOSED'}).sort((a,b)=>(a.closedAt||0)-(b.closedAt||0)),wins=closed.filter(x=>x.outcome==='WIN').length,losses=closed.filter(x=>x.outcome==='LOSS').length,draws=closed.filter(x=>x.outcome==='DRAW').length,decisive=wins+losses;
  const group=key=>{const map=new Map();for(const trade of closed){const name=String(key(trade));let row=map.get(name);if(!row){row={key:name,total:0,wins:0,losses:0,draws:0,netProfit:0};map.set(name,row);}row.total++;row[trade.outcome==='WIN'?'wins':trade.outcome==='LOSS'?'losses':'draws']++;row.netProfit+=trade.profit||0;}return Array.from(map.values()).map(x=>({...x,winRate:(x.wins+x.losses)?x.wins/(x.wins+x.losses)*100:0})).sort((a,b)=>b.total-a.total);};
  let cumulative=0;const curve=closed.map(trade=>({at:trade.closedAt,profit:trade.profit,cumulative:(cumulative+=trade.profit||0),tradeId:trade.tradeId}));
  const similarityBand=t=>t.similarity<80?'<80':t.similarity<85?'80-84':t.similarity<90?'85-89':t.similarity<95?'90-94':'95+';
  return{total:closed.length,wins,losses,draws,winRate:decisive?wins/decisive*100:0,netProfit:closed.reduce((n,x)=>n+(x.profit||0),0),open:this.listOpen().length,byPair:group(t=>t.pair),byTimeframe:group(t=>t.timeframe),byDirection:group(t=>t.direction),byExpiry:group(t=>String(t.expirySeconds)+'s'),bySimilarity:group(similarityBand),curve};
 }
 getStatus(){return{records:this.records.size,open:this.listOpen().length,unmatchedCloseEvents:this.unmatched.length,stats:this.getStats()};}
}
module.exports={TradeLedger,validateRecord,MAX_RECORDS,MAX_UNMATCHED};
