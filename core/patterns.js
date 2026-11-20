'use strict';
const { getTimeframeDuration } = require('./timeframes');
function assertPositive(value, name) { const n=Number(value); if(!Number.isFinite(n)||n<=0) throw new TypeError(name+' должен быть положительным числом'); return n; }
function validateCandles(candles, options={}) {
  if(!Array.isArray(candles)) throw new TypeError('candles должен быть массивом');
  const tf=String(options.timeframe||'').toUpperCase(), duration=tf?getTimeframeDuration(tf):null;
  const entryAt=options.entryAt==null?Infinity:Number(options.entryAt);
  if(!(entryAt>0)) throw new TypeError('entryAt должен быть положительным timestamp');
  let previous=-Infinity,previousEnd=-Infinity; const rows=[];
  for(let i=0;i<candles.length;i++){
    const c=candles[i]; if(!c||typeof c!=='object') throw new TypeError('Некорректная свеча '+i);
    const startAt=Number(c.startAt), endAt=Number(c.endAt);
    const open=assertPositive(c.open,'open'), high=assertPositive(c.high,'high'), low=assertPositive(c.low,'low'), close=assertPositive(c.close,'close');
    if(!Number.isFinite(startAt)||!Number.isFinite(endAt)||startAt<=0||endAt<=startAt) throw new TypeError('Некорректное время свечи '+i);
    if(startAt<previous) throw new RangeError('Свечи должны быть отсортированы по времени');
    if(startAt===previous) throw new RangeError('Повторяющаяся свеча');
    if(startAt<previousEnd) throw new RangeError('Свечи перекрываются по времени');
    if(duration&&endAt-startAt!==duration) throw new RangeError('Длительность свечи не соответствует '+tf);
    if(c.complete!==true) throw new RangeError('Свеча '+i+' не закрыта');
    if(endAt>entryAt) throw new RangeError('Обнаружена утечка данных после точки входа');
    if(high<Math.max(open,close,low)||low>Math.min(open,close,high)) throw new RangeError('Нарушены границы OHLC в свече '+i);
    previous=startAt; previousEnd=endAt; rows.push({startAt,endAt,open,high,low,close,complete:true});
  }
  if(rows.length<2) throw new RangeError('Для паттерна нужно минимум 2 закрытые свечи');
  return rows;
}
function createPattern(candles, options={}) {
  const rows=validateCandles(candles,options);
  const ranges=rows.map((c,i)=>{const prev=i?rows[i-1].close:c.open;return Math.max(c.high-c.low,Math.abs(c.high-prev),Math.abs(c.low-prev));});
  const scale=ranges.reduce((a,b)=>a+b,0)/ranges.length;
  if(!Number.isFinite(scale)||scale<=0) throw new RangeError('Нулевая волатильность: паттерн не нормализуется');
  const vector=[];
  for(let i=0;i<rows.length;i++){const c=rows[i],prev=i?rows[i-1].close:c.open;vector.push((c.open-prev)/scale,(c.high-Math.max(c.open,c.close))/scale,(Math.min(c.open,c.close)-c.low)/scale,(c.close-c.open)/scale);}
  return Object.freeze({version:1,candleCount:rows.length,scale,vector:Object.freeze(vector)});
}
function comparePatterns(a,b) {
  if(!a||!b||a.version!==1||b.version!==1||!Array.isArray(a.vector)||!Array.isArray(b.vector)) throw new TypeError('Неподдерживаемый формат паттерна');
  if(a.candleCount!==b.candleCount||a.vector.length!==b.vector.length||!a.vector.length) throw new RangeError('Паттерны должны иметь одинаковую длину');
  let sum=0;for(let i=0;i<a.vector.length;i++){const x=Number(a.vector[i]),y=Number(b.vector[i]);if(!Number.isFinite(x)||!Number.isFinite(y))throw new TypeError('Нечисловой признак');sum+=(x-y)**2;}
  const rmse=Math.sqrt(sum/a.vector.length), similarity=Math.max(0,Math.min(100,100*Math.exp(-rmse)));
  return Object.freeze({similarity,rmse});
}
module.exports={validateCandles,createPattern,comparePatterns};
