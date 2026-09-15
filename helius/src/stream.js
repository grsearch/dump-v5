'use strict';
const EventEmitter=require('node:events'),WebSocket=require('ws'),{PUMP}=require('./config'),migration=require('./migration-layout.json');
class Stream extends EventEmitter{
 constructor(c,store){super();this.c=c;this.store=store;this.running=false;}
 start(){this.running=true;this.connect();}
 connect(){if(!this.running)return;const day=new Date().toISOString().slice(0,10);if((this.store.data.streamDays[day]||0)>=this.c.maxBytesPerDay){this.emit('connection',false);this.retry=setTimeout(()=>this.connect(),60000);return;}
   const ws=this.ws=new WebSocket(this.c.wsUrl,{perMessageDeflate:false,handshakeTimeout:10000,maxPayload:32*1024*1024});let last=Date.now(),ready=false;
   ws.on('open',()=>{ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'transactionSubscribe',params:[{vote:false,failed:false,accountInclude:[PUMP,migration.address]},{commitment:'processed',encoding:'base64',transactionDetails:'full',showRewards:false,maxSupportedTransactionVersion:0}]}));this.timer=setInterval(()=>{if(Date.now()-last>30000||!ready){ws.terminate();return;}ws.ping();},20000);});
   ws.on('pong',()=>{last=Date.now();});
   ws.on('message',raw=>{last=Date.now();const day=new Date().toISOString().slice(0,10);this.store.data.streamDays[day]=(this.store.data.streamDays[day]||0)+raw.length;if(this.store.data.streamDays[day]>=this.c.maxBytesPerDay){this.store.log('stream_budget_reached',{day,bytes:this.store.data.streamDays[day]});ws.terminate();return;}try{const m=JSON.parse(raw);if(m.error){this.store.log('subscription_error',{code:m.error.code});ws.terminate();return;}if(m.id===1&&Number.isInteger(m.result)){ready=true;this.emit('connection',true);return;}if(m.method==='transactionNotification'&&ready)this.emit('transaction',{...m.params.result,receivedAt:Date.now()});}catch{this.store.log('stream_decode_error');}});
   ws.on('error',()=>this.store.log('stream_network_error'));ws.on('close',()=>{clearInterval(this.timer);this.emit('connection',false);if(this.running)this.retry=setTimeout(()=>this.connect(),3000);});
 }
 stop(){this.running=false;clearTimeout(this.retry);clearInterval(this.timer);this.ws?.removeAllListeners();this.ws?.terminate();}
}
module.exports=Stream;
