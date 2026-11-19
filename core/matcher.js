'use strict';
const {getTimeframeDuration}=require('./timeframes');
const {createPattern,comparePatterns}=require('./patterns');
const DEFAULTS=Object.freeze({topK:10,similarityThreshold:80,minExamples:3,minDirectionalMatches:6});
function normalizeConfig(input={}){const c={...DEFAULTS,...input};if(!Number.isInteger(c.topK)||c.topK<1||c.topK>100)throw new RangeError('topK должен быть от 1 до 100');if(!Number.isFinite(c.similarityThreshold)||c.similarityThreshold<0||c.similarityThreshold>100)throw new RangeError('similarityThreshold должен быть от 0 до 100');if(!Number.isInteger(c.minExamples)||c.minExamples<1||c.minExamples>c.topK)throw new RangeError('minExamples должен быть от 1 до topK');if(!Number.isInteger(c.minDirectionalMatches)||c.minDirectionalMatches<1||c.minDirectionalMatches>c.topK)throw new RangeError('minDirectionalMatches должен быть от 1 до topK');return Object.freeze(c);}
function analyzeSituation({candles,timeframe,entryAt,examples,config}){
 const tf=String(timeframe||'').toUpperCase();getTimeframeDuration(tf);if(!Array.isArray(examples))throw new TypeError('examples должен быть массивом');
 const settings=normalizeConfig(config),current=createPattern(candles,{timeframe:tf,entryAt}),matches=[];
 for(const ex of examples){if(!ex||String(ex.timeframe||'').toUpperCase()!==tf||!['UP','DOWN'].includes(ex.direction))continue;
  try{const historical=createPattern(ex.preEntryCandles,{timeframe:tf,entryAt:ex.entryAt}),score=comparePatterns(current,historical);if(score.similarity>=settings.similarityThreshold)matches.push({exampleId:String(ex.id),sourcePair:String(ex.pair||'').toUpperCase(),direction:ex.direction,similarity:Number(score.similarity.toFixed(4)),outcome:ex.outcome||null});}catch(_){/* malformed legacy samples are excluded */}
 }
 matches.sort((a,b)=>b.similarity-a.similarity||a.exampleId.localeCompare(b.exampleId));const top=matches.slice(0,settings.topK),upVotes=top.filter(x=>x.direction==='UP').length,downVotes=top.length-upVotes,winner=upVotes===downVotes?null:upVotes>downVotes?'UP':'DOWN';
 let accepted=false,reason='direction_conflict';if(top.length<settings.minExamples)reason='insufficient_matches';else if(!winner||Math.max(upVotes,downVotes)<settings.minDirectionalMatches)reason='insufficient_direction_votes';else{accepted=true;reason='direction_confirmed';}
 const average=top.length?top.reduce((s,x)=>s+x.similarity,0)/top.length:0;
 return Object.freeze({accepted,reason,timeframe:tf,direction:accepted?winner:null,matchCount:top.length,upVotes,downVotes,averageSimilarity:Number(average.toFixed(4)),matches:top,settingsSnapshot:{...settings},analyzedAt:new Date(entryAt).toISOString(),disclaimer:'Процент сходства описывает сходство формы свечей, а не вероятность прибыльной сделки.'});
}
module.exports={DEFAULTS,normalizeConfig,analyzeSituation};
