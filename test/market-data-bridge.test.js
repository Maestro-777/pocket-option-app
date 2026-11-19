'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','market-data-bridge.js'),'utf8');
class FakeWebSocket{constructor(url){this.url=url;this.listeners={};}addEventListener(name,fn){(this.listeners[name] ||= []).push(fn);}emit(data){for(const fn of this.listeners.message||[])fn({data});}}
function setup(){const messages=[],window={WebSocket:FakeWebSocket,postMessage:(data,origin)=>messages.push({data,origin})};const context={window,location:{origin:'https://pocketoption.com'},TextDecoder,TextEncoder,ArrayBuffer,Blob,Set,Proxy,Reflect,Uint8Array,JSON,Date};vm.runInNewContext(source,context);return{window,messages,context};}
test('captures allowlisted multi-asset market events only',()=>{const{window,messages}=setup(),ws=new window.WebSocket('wss://market.invalid');ws.emit('42["updateStream",[["EURUSD_otc",1700000000,1.1],["GBPUSD_otc",1700000001,1.2]]]');ws.emit('42["successauth",{"balance":100}]');assert.equal(messages.length,1);assert.equal(messages[0].data.payload.length,2);assert.equal(messages[0].origin,'https://pocketoption.com');});
test('handles Socket.IO binary attachment payloads',()=>{const{window,messages}=setup(),ws=new window.WebSocket('wss://market.invalid');ws.emit('451-["updateStream",{"_placeholder":true,"num":0}]');ws.emit(new TextEncoder().encode('[["EURUSD_otc",1700000000,1.234]]').buffer);assert.equal(messages.length,1);assert.equal(messages[0].data.payload[0][0],'EURUSD_otc');});
test('ignores malformed frames and duplicate injection',()=>{const{window,messages,context}=setup();vm.runInNewContext(source,context);const ws=new window.WebSocket('wss://market.invalid');ws.emit('bad frame');ws.emit('42["updateStream",[]]');assert.equal(messages.length,0);});

test('forwards bounded historical candle payloads without rewriting OHLC fields',()=>{
 const {window,messages}=setup(),ws=new window.WebSocket('wss://market.invalid');
 ws.emit('42["history/list/v2",{"asset":"EURUSD_otc","period":5,"history":[[1700000000,1.1,1.2,1.0,1.15]]}]');
 assert.equal(messages.length,1);
 assert.equal(messages[0].data.eventName,'history/list/v2');
 assert.deepEqual(Array.from(messages[0].data.payload[0].history[0]),[1700000000,1.1,1.2,1.0,1.15]);
});
