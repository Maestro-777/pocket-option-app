'use strict';
const {TIMEFRAME_MS,getTimeframeDuration}=require('./timeframes');
const {DEFAULTS,normalizeConfig,analyzeSituation}=require('./matcher');
const DEFAULT_TIMEFRAMES=Object.freeze(Object.keys(TIMEFRAME_MS));
function normalizeSchedulerConfig(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('Конфигурация анализа должна быть объектом');
 if(input.enabled!=null&&typeof input.enabled!=='boolean')throw new TypeError('enabled должен быть boolean');
 if(input.matcher!=null&&(!input.matcher||typeof input.matcher!=='object'||Array.isArray(input.matcher)))throw new TypeError('matcher должен быть объектом');
 const timeframes=Array.isArray(input.timeframes)?Array.from(new Set(input.timeframes.map(x=>String(x).toUpperCase()))):DEFAULT_TIMEFRAMES.slice();
 if(!timeframes.length||timeframes.some(tf=>!Object.prototype.hasOwnProperty.call(TIMEFRAME_MS,tf)))throw new RangeError('Выбери один или несколько поддерживаемых таймфреймов');
 const matcher=normalizeConfig(input.matcher||{});
 const lookback=input.lookback==null?300:Number(input.lookback);
 const maxOpenTrades=input.maxOpenTrades==null?1:Number(input.maxOpenTrades);
 const scanIntervalMs=input.scanIntervalMs==null?1000:Number(input.scanIntervalMs);
 if(!Number.isInteger(lookback)||lookback<matcher.patternLength||lookback>10000)throw new RangeError('lookback должен быть не меньше patternLength и не больше 10000');
 if(!Number.isInteger(maxOpenTrades)||maxOpenTrades<1||maxOpenTrades>10)throw new RangeError('maxOpenTrades должен быть от 1 до 10');
 if(!Number.isInteger(scanIntervalMs)||scanIntervalMs<250||scanIntervalMs>10000)throw new RangeError('scanIntervalMs должен быть от 250 до 10000');
 return Object.freeze({enabled:input.enabled!==false,timeframes,matcher,lookback,maxOpenTrades,scanIntervalMs});
}
function candidateMetrics(decision){
 const matches=decision.matches||[],wins=matches.filter(x=>x.outcome==='WIN').length,losses=matches.filter(x=>x.outcome==='LOSS').length;
 const known=wins+losses,winRate=known?wins/known:null;
 const votes=Math.max(decision.upVotes||0,decision.downVotes||0);
 return{averageSimilarity:decision.averageSimilarity||0,votes,consensus:decision.matchCount?votes/decision.matchCount:0,historicalWinRate:winRate};
}
function rankCandidates(candidates){
 return candidates.map(item=>({...item,ranking:candidateMetrics(item.decision)})).sort((a,b)=>
  b.ranking.averageSimilarity-a.ranking.averageSimilarity||
  b.ranking.votes-a.ranking.votes||
  b.ranking.consensus-a.ranking.consensus||
  (b.ranking.historicalWinRate==null?-1:b.ranking.historicalWinRate)-(a.ranking.historicalWinRate==null?-1:a.ranking.historicalWinRate)||
  a.asset.localeCompare(b.asset)||a.timeframe.localeCompare(b.timeframe)
 ).map((item,index)=>({...item,rank:index+1}));
}
class SignalScheduler{
 constructor({marketData,exampleStore,journal,getConfig,onDecision,onError}={}){
  if(!marketData||typeof marketData.listAssets!=='function'||typeof marketData.getCandles!=='function')throw new TypeError('Не передан MarketDataService');
  if(!exampleStore||typeof exampleStore.list!=='function')throw new TypeError('Не передан ExampleStore');
  this.marketData=marketData;this.exampleStore=exampleStore;this.journal=journal||null;this.getConfig=typeof getConfig==='function'?getConfig:()=>({});this.onDecision=typeof onDecision==='function'?onDecision:()=>{};this.onError=typeof onError==='function'?onError:()=>{};
  this.timer=null;this.scanning=false;this.lastScanned=new Map();this.lastScanAt=null;this.lastError=null;this.lastSummary={scanned:0,signals:0};this.recentDecisions=[];
 }
 restoreProcessedDecisions(events=[]){
  if(!Array.isArray(events))throw new TypeError('events должен быть массивом');
  const decisions=events.filter(event=>event&&event.type==='DECISION'&&event.payload&&typeof event.payload==='object');
  const restored=[];
  for(const event of decisions){const p=event.payload,asset=String(p.asset||''),timeframe=String(p.timeframe||'').toUpperCase(),barEndAt=Number(p.barEndAt);if(!asset||!Object.prototype.hasOwnProperty.call(TIMEFRAME_MS,timeframe)||!Number.isFinite(barEndAt)||barEndAt<=0)continue;const key=asset+'|'+timeframe;this.lastScanned.set(key,Math.max(this.lastScanned.get(key)||0,barEndAt));restored.push({...p,rank:null,withinConfiguredLimit:false,restored:true,journalAt:event.at||null});}
  this.recentDecisions=restored.slice(-200).reverse().concat(this.recentDecisions).slice(0,200);
  if(decisions.length)this.lastScanAt=decisions[decisions.length-1].at||this.lastScanAt;
  return{restored:restored.length,trackedBars:this.lastScanned.size};
 }
 start(){if(this.timer)return false;const config=normalizeSchedulerConfig(this.getConfig());this.timer=setInterval(()=>this.scan().catch(error=>{this.lastError=String(error.message||error);this.onError(error);}),config.scanIntervalMs);this.scan().catch(error=>{this.lastError=String(error.message||error);this.onError(error);});return true;}
 stop(){if(!this.timer)return false;clearInterval(this.timer);this.timer=null;return true;}
 async scan(){
  if(this.scanning)return{skipped:true,reason:'scan_in_progress'};
  this.scanning=true;
  try{
   const config=normalizeSchedulerConfig(this.getConfig());if(!config.enabled)return{scanned:0,signals:[],disabled:true};
   const now=Date.now(),assets=this.marketData.listAssets({otcOnly:true}),exampleCache=new Map(),candidates=[],decisions=[],journalEvents=[];let scanned=0;
   for(const assetInfo of assets){
    const asset=assetInfo.symbol;
    for(const timeframe of config.timeframes){
     const duration=getTimeframeDuration(timeframe),barEndAt=this.marketData.getLatestDataTime(asset,timeframe);
     if(!barEndAt)continue;
     const key=asset+'|'+timeframe;
     if(barEndAt<=(this.lastScanned.get(key)||0))continue;
     this.lastScanned.set(key,barEndAt);
     const freshness=Math.max(duration*2,10000);
     if(barEndAt>now+5000||now-barEndAt>freshness)continue;
     const candles=this.marketData.getCandles(asset,timeframe,{asOf:barEndAt,limit:config.lookback});
     scanned++;
     if(candles.length<config.matcher.patternLength){
      const signalId=asset+'|'+timeframe+'|'+barEndAt;
      const decision={accepted:false,reason:'insufficient_market_data',timeframe,direction:null,matchCount:0,upVotes:0,downVotes:0,averageSimilarity:0,matches:[],settingsSnapshot:{...config.matcher},entryAt:barEndAt,analyzedAt:new Date().toISOString()};
      const record={signalId,asset,timeframe,barEndAt,decision};decisions.push(record);
      if(this.journal){const snapshot={...config.matcher,asset,timeframe,barEndAt,lookback:config.lookback,maxOpenTrades:config.maxOpenTrades,analysisTimeframes:config.timeframes.slice(),algorithmVersion:1};journalEvents.push({type:'DECISION',payload:record,settingsSnapshot:snapshot});}
      continue;
     }
     let examples=exampleCache.get(timeframe);
     if(!examples){examples=await this.exampleStore.list({timeframe});exampleCache.set(timeframe,examples);}
     const decision=analyzeSituation({candles,timeframe,entryAt:barEndAt,examples,config:config.matcher});
     const signalId=asset+'|'+timeframe+'|'+barEndAt;
     const record={signalId,asset,timeframe,barEndAt,decision};
     decisions.push(record);
     if(decision.accepted)candidates.push(record);
     if(this.journal){
      const snapshot={...decision.settingsSnapshot,asset,timeframe,barEndAt,lookback:config.lookback,maxOpenTrades:config.maxOpenTrades,analysisTimeframes:config.timeframes.slice(),algorithmVersion:1};
      journalEvents.push({type:'DECISION',payload:{signalId,asset,timeframe,barEndAt,decision},settingsSnapshot:snapshot});
     }
    }
   }
   if(this.journal&&journalEvents.length){try{if(typeof this.journal.appendMany==='function')await this.journal.appendMany(journalEvents);else for(const item of journalEvents)await this.journal.append(item.type,item.payload,item.settingsSnapshot);}catch(error){this.onError(error);}}
   const ranked=rankCandidates(candidates);
   const selected=ranked.slice(0,config.maxOpenTrades).map(x=>x.signalId),rankedById=new Map(ranked.map(x=>[x.signalId,x]));
   const allDecisions=decisions.map(item=>{const rankedItem=rankedById.get(item.signalId);return rankedItem?{...rankedItem,withinConfiguredLimit:selected.includes(item.signalId)}:{...item,rank:null,withinConfiguredLimit:false};});
   const result={scanned,decisions:decisions.length,signals:ranked.map(x=>({...x,withinConfiguredLimit:selected.includes(x.signalId)})),allDecisions,topCandidateSignalIds:selected,at:new Date().toISOString()};
   this.lastScanAt=result.at;this.lastError=null;this.lastSummary={scanned,signals:ranked.length};this.recentDecisions=allDecisions.concat(this.recentDecisions).slice(0,200);
   for(const item of allDecisions){try{this.onDecision(item);}catch(error){this.onError(error);}}
   return result;
  }finally{this.scanning=false;}
 }
 getRecentDecisions(){return this.recentDecisions.map(item=>JSON.parse(JSON.stringify(item)));}
 getStatus(){return Object.freeze({running:!!this.timer,scanning:this.scanning,lastScanAt:this.lastScanAt,lastError:this.lastError,...this.lastSummary,trackedBars:this.lastScanned.size});}
}
module.exports={SignalScheduler,DEFAULT_TIMEFRAMES,normalizeSchedulerConfig,candidateMetrics,rankCandidates};
