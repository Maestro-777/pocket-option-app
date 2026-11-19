'use strict';
const {normalizeAsset}=require('./market-data');
class TradeExecutionAdapter{
 constructor({gate,marketData,journal,ledger,getSettings,getAccount,getSiteWindow,onUpdate}={}){
  if(!gate||typeof gate.reserve!=='function'||typeof gate.confirmOpened!=='function')throw new TypeError('Не передан TradingGate');
  if(!marketData||typeof marketData.listAssets!=='function')throw new TypeError('Не передан MarketDataService');
  this.gate=gate;this.marketData=marketData;this.journal=journal||null;this.ledger=ledger||null;
  this.getSettings=typeof getSettings==='function'?getSettings:()=>({});
  this.getAccount=typeof getAccount==='function'?getAccount:()=>({});
  this.getSiteWindow=typeof getSiteWindow==='function'?getSiteWindow:()=>null;
  this.onUpdate=typeof onUpdate==='function'?onUpdate:()=>{};
  this.submitted=new Map();this.executionQueue=Promise.resolve();this.correlationVerified=false;
 }
 async _journal(type,payload,snapshot={}){if(this.journal)await this.journal.append(type,payload,snapshot);}
 async _reject(signal,reason,details={}){
  const record={signalId:String(signal&&signal.signalId||''),asset:String(signal&&signal.asset||''),timeframe:String(signal&&signal.timeframe||''),reason,details,at:new Date().toISOString()};
  try{await this._journal('TRADE_REJECTED',record,{autoTradingEnabled:this.getSettings().autoTradingEnabled===true});}catch(_){}
  this.onUpdate({type:'rejected',...record});return{ok:false,reason,details};
 }
 execute(signal){const task=this.executionQueue.then(()=>this._execute(signal));this.executionQueue=task.catch(()=>{});return task;}
 async _execute(signal){
  if(!signal||typeof signal!=='object'||!signal.decision||signal.decision.accepted!==true)return this._reject(signal,'invalid_or_unconfirmed_signal');
  const settings=this.getSettings()||{},account=this.getAccount()||{};
  if(settings.autoTradingEnabled!==true)return this._reject(signal,'auto_trading_disabled');
  if(this.gate.getState().paused)return this._reject(signal,'trading_paused');
  const siteUrl=String(account.url||'');
  if(String(account.mode||'').toUpperCase()!=='DEMO'||account.accountType!=='demo'||!siteUrl.includes('/demo-quick-high-low/'))return this._reject(signal,'demo_account_not_verified');
  const asset=normalizeAsset(signal.asset),assetInfo=this.marketData.listAssets({otcOnly:true}).find(x=>x.symbol===asset);
  if(!assetInfo||!assetInfo.otc||typeof assetInfo.rawSymbol!=='string'||!assetInfo.rawSymbol)return this._reject(signal,'otc_asset_not_available');
  const amount=Number(settings.baseBet==null?1:settings.baseBet),expirySeconds=Number(settings.defaultExpirySeconds==null?15:settings.defaultExpirySeconds),balance=Number(account.balance);
  if(!Number.isFinite(amount)||amount<=0||amount>100000||!Number.isFinite(balance)||balance<=0||amount>balance)return this._reject(signal,'invalid_amount_or_insufficient_demo_balance',{amount,balance});
  if(!Number.isInteger(expirySeconds)||expirySeconds<1||expirySeconds>86400)return this._reject(signal,'invalid_expiration',{expirySeconds});
  const maxOpenTrades=Number(settings.analysisConfig&&settings.analysisConfig.maxOpenTrades||1);
  if(Array.from(this.submitted.values()).some(x=>x.pair===asset))return this._reject(signal,'pair_has_unresolved_trade');
  if(maxOpenTrades>1&&this.submitted.size>0&&!this.correlationVerified)return this._reject(signal,'multi_trade_correlation_not_verified');
  const reservation=await this.gate.reserve({signalId:signal.signalId,pair:asset,timeframe:signal.timeframe,direction:signal.decision.direction},{maxOpenTrades});
  if(!reservation.accepted)return this._reject(signal,reservation.reason);
  const win=this.getSiteWindow();
  if(!win||win.isDestroyed()||!win.webContents||win.webContents.isDestroyed()){
   await this.gate.cancelReservation(reservation.reservation.reservationId,'site_window_unavailable');
   return this._reject(signal,'site_window_unavailable');
  }
  const tradeId=String(signal.signalId),submittedAt=Date.now();
  if(this.ledger){try{await this.ledger.addPending({tradeId,signalId:tradeId,pair:asset,timeframe:String(signal.timeframe),direction:signal.decision.direction,amount,expirySeconds,similarity:Number(signal.decision.averageSimilarity||0),matchCount:Number(signal.decision.matchCount||0),upVotes:Number(signal.decision.upVotes||0),downVotes:Number(signal.decision.downVotes||0),accountMode:'DEMO',submittedAt,status:'PREPARING'});}catch(error){await this.gate.cancelReservation(reservation.reservation.reservationId,'ledger_write_failed');return this._reject(signal,'ledger_write_failed',{message:String(error.message||error)});}}
  const request={version:1,asset,rawAsset:assetInfo.rawSymbol,direction:signal.decision.direction,amount,expirySeconds,switchTimeoutMs:6000};
  let result;
  try{
   result=await win.webContents.executeJavaScript('window.__PT_TRADE_COMMAND__('+JSON.stringify(request)+')',true);
  }catch(error){
   await this.gate.cancelReservation(reservation.reservation.reservationId,'page_command_failed');if(this.ledger)await this.ledger.markRejected(tradeId,'page_command_failed').catch(()=>{});
   return this._reject(signal,'page_command_failed',{message:String(error&&error.message||error)});
  }
  if(!result||result.ok!==true||result.submitted!==true){
   await this.gate.cancelReservation(reservation.reservation.reservationId,result&&result.reason||'page_rejected');if(this.ledger)await this.ledger.markRejected(tradeId,result&&result.reason||'page_rejected').catch(()=>{});
   return this._reject(signal,result&&result.reason||'page_rejected',{pageResult:result||null});
  }
  const record={tradeId,signalId:String(signal.signalId),pair:asset,timeframe:String(signal.timeframe),direction:signal.decision.direction,amount,expirySeconds,accountMode:'DEMO',submittedAt,status:'SUBMITTED_UNCONFIRMED',platformConfirmed:false,decision:signal.decision};
  let ledgerError=null;if(this.ledger){try{await this.ledger.markSubmitted(tradeId);}catch(error){ledgerError=String(error.message||error);}}
  try{await this.gate.confirmOpened(reservation.reservation.reservationId,tradeId);}
  catch(error){this.gate.restoreOpenTrades([{...record,status:'SUBMITTED_UNCONFIRMED'}]);}
  this.submitted.set(tradeId,record);
  if(ledgerError)this.onUpdate({type:'ledger_error',tradeId,message:ledgerError,submitted:true});
  try{await this._journal('TRADE_OPENED',record,{maxOpenTrades,baseBet:amount,defaultExpirySeconds:expirySeconds,accountMode:'DEMO'});}catch(error){this.onUpdate({type:'journal_error',tradeId,message:String(error.message||error)});}
  this.onUpdate({type:'submitted',trade:record});
  return{ok:true,status:'SUBMITTED_UNCONFIRMED',trade:record,pageResult:result};
 }
 async handleCloseEvent(payload){
  const wrappers=Array.isArray(payload)?payload:[payload];const deals=wrappers.flatMap(item=>Array.isArray(item&&item.deals)?item.deals:(item&&typeof item==='object'?[item]:[]));
  const results=[];
  for(const deal of deals){
   if(!deal||typeof deal!=='object')continue;
   const amount=Number(deal.amount??deal.investment),asset=normalizeAsset(deal.asset||deal.symbol||deal.pair);
   let candidates=Array.from(this.submitted.values());
   if(asset)candidates=candidates.filter(x=>x.pair===asset);
   if(Number.isFinite(amount)&&amount>0)candidates=candidates.filter(x=>Math.abs(x.amount-amount)<0.011);
   if(candidates.length!==1){
    const rawProfit=Number(deal.profit);const unmatched={matched:false,reason:'ambiguous_or_unmatched_close_event',platformDealId:String(deal.id??deal.ticket??''),amount:Number.isFinite(amount)?amount:null,asset:asset||null,profit:Number.isFinite(rawProfit)?rawProfit:null};
    if(this.ledger)await this.ledger.recordUnmatchedClose({...unmatched,reason:unmatched.reason}).catch(()=>{});try{await this._journal('TRADE_CLOSED',unmatched,{});}catch(_){}
    results.push(unmatched);continue;
   }
   const trade=candidates[0],profit=Number(deal.profit??deal.netProfit??0);
   if(!Number.isFinite(profit)){results.push({matched:false,reason:'invalid_profit',tradeId:trade.tradeId});continue;}
   const outcome=profit>0?'WIN':profit<0?'LOSS':'DRAW';
   if(asset)this.correlationVerified=true;
   const closed=await this.gate.closeTrade(trade.tradeId,{outcome});
   if(this.ledger)await this.ledger.closeTrade(trade.tradeId,{profit,outcome,closedAt:Date.now(),platformDealId:String(deal.id??deal.ticket??'')}).catch(error=>this.onUpdate({type:'ledger_error',tradeId:trade.tradeId,message:String(error.message||error)}));
   this.submitted.delete(trade.tradeId);
   const record={matched:true,tradeId:trade.tradeId,platformDealId:String(deal.id??deal.ticket??''),pair:trade.pair,timeframe:trade.timeframe,direction:trade.direction,amount:trade.amount,profit,outcome,closedAt:Date.now(),accountMode:'DEMO'};
   try{await this._journal('TRADE_CLOSED',record,{expirySeconds:trade.expirySeconds});}catch(error){this.onUpdate({type:'journal_error',tradeId:trade.tradeId,message:String(error.message||error)});}
   this.onUpdate({type:'closed',trade:closed,result:record});results.push(record);
  }
  return results;
 }
 restore(records=[]){for(const record of records){if(!record||!['PREPARING','SUBMITTED_UNCONFIRMED','UNKNOWN_AFTER_RESTART'].includes(record.status))continue;this.submitted.set(String(record.tradeId),{...record});}return this.getState();}
 getState(){return{pendingOrSubmitted:this.submitted.size,correlationVerified:this.correlationVerified,trades:Array.from(this.submitted.values()).map(x=>({...x})),ledger:this.ledger?this.ledger.getStatus():null};}
}
module.exports={TradeExecutionAdapter};
