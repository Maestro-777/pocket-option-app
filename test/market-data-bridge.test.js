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

test('fails closed when no market socket is available for a trade command',async()=>{const{window}=setup();const result=await window.__PT_TRADE_COMMAND__({version:1,tradeId:'no-socket',asset:'EURUSD_OTC',rawAsset:'EURUSD_otc',direction:'UP',amount:1,expirySeconds:15});assert.equal(result.ok,false);assert.equal(result.reason,'market_socket_not_ready');});
test('submits only after the current DOM asset, amount and expiry are verified',async()=>{
 const messages=[];let clicks=0,sent=[];
 class FakeInput{constructor(){this._value='1';this.offsetParent={};}focus(){}dispatchEvent(){}get value(){return this._value;}set value(v){this._value=v;}}
 class FakeWebSocket{constructor(){this.readyState=1;this.listeners={};}addEventListener(n,fn){(this.listeners[n] ||= []).push(fn);}send(data){sent.push(data);}emit(data){for(const fn of this.listeners.message||[])fn({data});}}
 const active={textContent:'EUR/USD OTC',offsetParent:{},getAttribute:()=>null,getBoundingClientRect:()=>({width:20,height:10})};
 const expiry={textContent:'00:00:15',offsetParent:{},getAttribute:()=>null};
 const input=new FakeInput();
 const button={offsetParent:{},classList:{contains:()=>false},getAttribute:()=>null,click(){clicks++;}};
 const document={querySelector(selector){if(selector.includes('.assets-block__item--active'))return active;if(selector.includes('.block--expiration-inputs .value__val'))return expiry;if(selector.includes('input'))return input;if(selector==='.btn.btn-call')return button;return null;},querySelectorAll(){return[];}};
 const window={WebSocket:FakeWebSocket,postMessage:(data,origin)=>messages.push({data,origin}),HTMLInputElement:FakeInput};
 const context={window,document,location:{origin:'https://pocketoption.com'},TextDecoder,TextEncoder,ArrayBuffer,Blob,Set,Proxy,Reflect,Uint8Array,JSON,Date,Event:function(){},MouseEvent:function(){},setTimeout,clearTimeout};
 vm.runInNewContext(source,context);
 const ws=new window.WebSocket();ws.emit('42["updateStream",[["EURUSD_otc",1700000000,1.2]]]');
 const result=await window.__PT_TRADE_COMMAND__({version:1,tradeId:'trade-success',asset:'EURUSD_OTC',rawAsset:'EURUSD_otc',direction:'UP',amount:1.5,expirySeconds:15});
 assert.equal(result.ok,true);assert.equal(result.confirmed,false);assert.equal(input.value,'1.5');assert.equal(clicks,1);assert.equal(sent.length,0);
});
test('does not click when the requested asset is not confirmed in the DOM',async()=>{
 let clicks=0,sent=[];
 class FakeWebSocket{constructor(){this.readyState=1;this.listeners={};}addEventListener(n,fn){(this.listeners[n] ||= []).push(fn);}send(data){sent.push(data);}emit(data){for(const fn of this.listeners.message||[])fn({data});}}
 const active={textContent:'GBP/USD OTC',offsetParent:{},getAttribute:()=>null,getBoundingClientRect:()=>({width:20,height:10})};
 const document={querySelector(selector){if(selector.includes('.assets-block__item--active'))return active;return null;},querySelectorAll(){return[];}};
 const window={WebSocket:FakeWebSocket,postMessage(){},HTMLInputElement:function(){}};
 const context={window,document,location:{origin:'https://pocketoption.com'},TextDecoder,TextEncoder,ArrayBuffer,Blob,Set,Proxy,Reflect,Uint8Array,JSON,Date,Event:function(){},MouseEvent:function(){},setTimeout,clearTimeout};
 vm.runInNewContext(source,context);const ws=new window.WebSocket();ws.emit('42["updateStream",[["GBPUSD_otc",1700000000,1.2]]]');
 const result=await window.__PT_TRADE_COMMAND__({version:1,tradeId:'trade-mismatch',asset:'EURUSD_OTC',rawAsset:'EURUSD_otc',direction:'UP',amount:1,expirySeconds:15,switchTimeoutMs:100});
 assert.equal(result.ok,false);assert.equal(result.reason,'asset_switch_not_confirmed');assert.equal(clicks,0);assert.equal(sent.length,1);
});

test('forwards only allowlisted fields from closed-trade events',()=>{
 const {window,messages}=setup(),ws=new window.WebSocket('wss://market.invalid');
 ws.emit('42["successcloseOrder",{"balance":100.5,"deals":[{"id":"broker-1","asset":"EURUSD_otc","amount":1,"profit":0.8,"direction":"call","password":"must-not-pass"}]}]');
 assert.equal(messages.length,1);assert.equal(messages[0].data.eventName,'successcloseOrder');assert.equal(messages[0].data.payload[0].balance,100.5);
 const deal=messages[0].data.payload[0].deals[0];assert.equal(deal.id,'broker-1');assert.equal(deal.asset,'EURUSD_otc');assert.equal(deal.profit,0.8);assert.equal(deal.password,undefined);
});

test('pause cancellation interrupts an asset switch before the trade button can be clicked',async()=>{
 let clicks=0,sent=[];
 class FakeWebSocket{constructor(){this.readyState=1;this.listeners={};}addEventListener(n,fn){(this.listeners[n] ||= []).push(fn);}send(data){sent.push(data);}emit(data){for(const fn of this.listeners.message||[])fn({data});}}
 const active={textContent:'GBP/USD OTC',offsetParent:{},getAttribute:()=>null,getBoundingClientRect:()=>({width:20,height:10})};
 const document={querySelector(selector){if(selector.includes('.assets-block__item--active'))return active;return null;},querySelectorAll(){return[];}};
 const window={WebSocket:FakeWebSocket,postMessage(){},HTMLInputElement:function(){}};
 const context={window,document,location:{origin:'https://pocketoption.com'},TextDecoder,TextEncoder,ArrayBuffer,Blob,Set,Proxy,Reflect,Uint8Array,JSON,Date,Event:function(){},MouseEvent:function(){},setTimeout,clearTimeout};
 vm.runInNewContext(source,context);const ws=new window.WebSocket();ws.emit('42["updateStream",[["GBPUSD_otc",1700000000,1.2]]]');
 const pending=window.__PT_TRADE_COMMAND__({version:1,tradeId:'cancel-me',asset:'EURUSD_OTC',rawAsset:'EURUSD_otc',direction:'UP',amount:1,expirySeconds:15,switchTimeoutMs:2000});
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(window.__PT_CANCEL_TRADE_COMMAND__('cancel-me'),true);
 const result=await pending;assert.equal(result.ok,false);assert.equal(result.reason,'cancelled_by_pause');assert.equal(clicks,0);assert.equal(sent.length,1);
});
