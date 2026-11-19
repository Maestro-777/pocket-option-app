'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {MarketDataService,normalizeTimestamp,normalizeAsset}=require('../core/market-data');
test('normalizes asset aliases and timestamps',()=>{assert.equal(normalizeAsset('eur/usd otc'),'EURUSD_OTC');assert.equal(normalizeAsset('??'),null);assert.equal(normalizeTimestamp(1700000000),1700000000000);assert.equal(normalizeTimestamp(Date.now()+999999),null);});
test('aggregates independent live streams for several assets',()=>{const s=new MarketDataService(),base=1700000000000;s.ingestEvent('updateAssets',[['x','EURUSD_otc','EUR/USD OTC'],['x','GBPUSD_otc','GBP/USD OTC']]);const r=s.ingestEvent('updateStream',[['EURUSD_otc',base/1000,1.1],['EURUSD_otc',base/1000+2,1.2],['GBPUSD_otc',base/1000,1.3],['GBPUSD_otc',base/1000+2,1.25]]);assert.equal(r.accepted,4);assert.equal(s.getStatus().tickAssetCount,2);assert.equal(s.getCandles('EURUSD_OTC','S5',{asOf:base+5000})[0].close,1.2);assert.equal(s.getCandles('GBPUSD_OTC','S5',{asOf:base+5000})[0].close,1.25);});
test('rejects malformed ticks, bounds memory and validates requests',()=>{const s=new MarketDataService({maxAssets:2,maxTicksPerAsset:2}),now=Date.now();assert.equal(s.ingestTicks([['EURUSD_OTC',now,1],['EURUSD_OTC',now+1,1.1],['EURUSD_OTC',now+2,1.2],['BAD',now,'NaN']]),3);assert.equal(s.getStatus().tickCount,2);assert.throws(()=>s.getCandles('EURUSD_OTC','M4'),/таймфрейм/);assert.throws(()=>s.getCandles('EURUSD_OTC','S5',{limit:0}),/limit/);});

test('ingests historical OHLC candles only when field layout is verified',()=>{
 const service=new MarketDataService(),base=1700000000000;
 const history=[[base/1000,1.1,1.2,1.0,1.15],[(base+5000)/1000,1.15,1.25,1.1,1.2],[(base+10000)/1000,1.2,1.3,1.15,1.25]];
 const result=service.ingestEvent('history/list/v2',[{asset:'EURUSD_otc',period:5,history}]);
 assert.equal(result.accepted,3);
 const candles=service.getCandles('EURUSD_OTC','S5',{asOf:base+20000});
 assert.equal(candles.length,3);
 assert.equal(candles[0].open,1.1);
 assert.equal(candles[0].high,1.2);
 assert.equal(candles[0].low,1.0);
 assert.equal(candles[0].close,1.15);
});
test('keeps close-only historical samples as ticks instead of fabricating OHLC',()=>{
 const service=new MarketDataService(),base=1700000000000;
 service.ingestEvent('updateHistoryNewFast',{asset:'GBPUSD_otc',period:5,history:[[base/1000,1.25],[(base+1000)/1000,1.3]]});
 const candles=service.getCandles('GBPUSD_OTC','S5',{asOf:base+5000});
 assert.equal(candles.length,1);
 assert.equal(candles[0].open,1.25);
 assert.equal(candles[0].high,1.3);
 assert.equal(candles[0].close,1.3);
});
test('enforces a global tick memory ceiling across assets',()=>{
 const service=new MarketDataService({maxTotalTicks:3,maxTicksPerAsset:10}),now=Date.now();
 service.ingestTicks([['EURUSD_OTC',now,1],['GBPUSD_OTC',now+1,2],['USDJPY_OTC',now+2,3],['AUDUSD_OTC',now+3,4]]);
 assert.equal(service.getStatus().tickCount,3);
});
