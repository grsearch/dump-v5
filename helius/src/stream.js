'use strict';
const EventEmitter=require('node:events'),WebSocket=require('ws'),{ADDRESS}=require('./providers');
class Stream extends EventEmitter{
 constructor(c,store,Socket=WebSocket){super();this.c=c;this.store=store;this.Socket=Socket;this.running=false;this.wanted=new Set();this.active=new Map();this.requests=new Map();this.seq=0;}
 setPools(pools){if(pools.some(p=>!ADDRESS.test(p)))throw Error('Invalid pool');const next=new Set(pools);for(const p of this.wanted)if(!next.has(p))this.emit('removed',p);this.wanted=next;if(!this.running)return;if(!next.size){this.ws?.close();return;}if(!this.ws&&!this.retry)this.connect();else this.sync();}
 start(){this.running=true;if(this.wanted.size)this.connect();}
 send(method,params,pool){const id=++this.seq;this.requests.set(id,{method,pool,at:Date.now()});this.ws.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));}
 sync(){if(this.ws?.readyState!==1)return;for(const [pool,id] of this.active)if(!this.wanted.has(pool)&&![...this.requests.values()].some(r=>r.pool===pool))this.send('transactionUnsubscribe',[id],pool);for(const pool of this.wanted)if(!this.active.has(pool)&&![...this.requests.values()].some(r=>r.pool===pool))this.send('transactionSubscribe',[{vote:false,failed:false,accountInclude:[pool]},{commitment:'processed',encoding:'base64',transactionDetails:'full',showRewards:false,maxSupportedTransactionVersion:0}],pool);}
 connect(){if(!this.running||!this.wanted.size)return;const day=new Date().toISOString().slice(0,10);if((this.store.data.streamDays[day]||0)>=this.c.maxBytesPerDay){this.retry=setTimeout(()=>{this.retry=null;this.connect();},60000);return;}
  const ws=this.ws=new this.Socket(this.c.wsUrl,{perMessageDeflate:false,handshakeTimeout:10000,maxPayload:32*1024*1024});let last=Date.now();
  ws.on('open',()=>{this.sync();this.timer=setInterval(()=>{if(Date.now()-last>30000||[...this.requests.values()].some(r=>Date.now()-r.at>15000)){ws.terminate();return;}ws.ping();},10000);});ws.on('pong',()=>last=Date.now());
  ws.on('message',raw=>{last=Date.now();const day=new Date().toISOString().slice(0,10);this.store.data.streamDays[day]=(this.store.data.streamDays[day]||0)+raw.length;if(this.store.data.streamDays[day]>=this.c.maxBytesPerDay){this.store.log('stream_budget_reached',{day,bytes:this.store.data.streamDays[day]});ws.terminate();return;}
   try{const m=JSON.parse(raw);if(m.error){this.store.log('subscription_error',{code:m.error.code});ws.terminate();return;}if(this.requests.has(m.id)){const r=this.requests.get(m.id);this.requests.delete(m.id);if(r.method==='transactionSubscribe'){if(!Number.isInteger(m.result))return ws.terminate();this.active.set(r.pool,m.result);this.emit('connection',true);}else{if(m.result!==true)return ws.terminate();this.active.delete(r.pool);}this.sync();return;}
    if(m.method==='transactionNotification'&&[...this.active].some(([p,id])=>id===m.params?.subscription&&this.wanted.has(p)))this.emit('transaction',{...m.params.result,receivedAt:Date.now()});
   }catch{this.store.log('stream_decode_error');}});
  ws.on('error',()=>this.store.log('stream_network_error'));ws.on('close',()=>{clearInterval(this.timer);this.ws=null;this.active.clear();this.requests.clear();this.emit('connection',false);if(this.running&&this.wanted.size)this.retry=setTimeout(()=>{this.retry=null;this.connect();},3000);});
 }
 stop(){this.running=false;clearTimeout(this.retry);clearInterval(this.timer);this.ws?.removeAllListeners();this.ws?.terminate();this.ws=null;}
}
module.exports=Stream;
