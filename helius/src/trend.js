'use strict';
const crypto=require('node:crypto');
function sum(a,side){return a.reduce((s,e)=>s+(!side||e.side===side?e.quoteSol:0),0);}
function metrics(events,now){
 const recent=events.filter(e=>e.receivedAt>now-60000),base=events.filter(e=>e.receivedAt<=now-60000&&e.receivedAt>now-360000),ten=recent.filter(e=>e.receivedAt>now-10000);
 const volume=sum(recent),baseline=sum(base)/5;
 return {volumeSol:volume,baselineSol:baseline,multiple:baseline>0?volume/baseline:null,buySol:sum(recent,'buy'),sellSol:sum(recent,'sell'),net10:sum(ten,'buy')-sum(ten,'sell'),buyers:new Set(recent.filter(e=>e.side==='buy'&&e.user).map(e=>e.user)).size,trades:recent.length,maxSingleFraction:volume?Math.max(0,...recent.map(e=>e.quoteSol))/volume:null,breakout:base.length?Math.max(...base.map(e=>e.price)):null};
}
function reserves(s){const b=Number(s.postBase),q=Number(s.postQuote)/1e9;if(!(b>0&&q>0)||Number(s.virtual||0)!==0)return null;return {b,q};}
function buyQuote(s,c){const r=reserves(s);if(!r)return null;const input=c.sizeSol*(1-c.feeBps/10000),raw=r.b*input/(r.q+input)*(1-c.slippageBps/10000),impact=input/(r.q+input)*100;if(!(raw>0)||impact>c.maxImpactPct)return null;return {raw,cost:c.sizeSol+c.networkSol,impact};}
function sellQuote(s,raw,c){const r=reserves(s);if(!r)return null;const result=r.q*raw/(r.b+raw)*(1-c.feeBps/10000)*(1-c.slippageBps/10000)-c.networkSol;return Number.isFinite(result)?result:null;}
class Trend{
 constructor(c,store,discovery){this.c=c;this.store=store;this.discovery=discovery;this.pools=new Map();this.pending=new Map();this.connected=false;this.totalEvents=0;this.counts={swaps:0,shortlisted:0,entries:0,evictions:0,rejected:0};}
 gap(reason,now=Date.now()){this.connected=false;for(const p of [...this.store.data.positions])this.unknown(p,reason,now);for(const p of this.pending.values())this.store.log('entry_cancelled',{id:p.id,pool:p.pool,reason,at:now});this.pending.clear();this.pools.clear();this.totalEvents=0;this.store.log('coverage_gap',{reason,at:now});}
 connection(ok){if(!ok)this.gap('stream_disconnected');this.connected=ok;}
 unknown(p,reason,now){this.store.log('shadow_unknown',{...p,at:now,reason,netPnlSol:null});this.store.data.totals.unknown++;this.store.data.positions=this.store.data.positions.filter(x=>x.id!==p.id);}
 remove(pool,reason){const h=this.pools.get(pool);if(!h)return;this.totalEvents-=h.events.length;this.pools.delete(pool);for(const p of [...this.store.data.positions].filter(p=>p.pool===pool))this.unknown(p,reason,Date.now());for(const [k,p] of this.pending)if(p.pool===pool){this.store.log('entry_cancelled',{id:p.id,pool,reason});this.pending.delete(k);}this.counts.evictions++;this.store.log('history_evicted',{pool,reason});}
 onSwap(s){const now=s.receivedAt;if(!this.connected)return;if(!Number.isFinite(now)||!Number.isFinite(s.eventTime)||Math.abs(now-s.eventTime)>5000||!Number.isFinite(s.price)||s.price<=0||!Number.isFinite(s.quoteSol)||s.quoteSol<0){this.remove(s.pool,'stale_or_invalid_observation');return;}
   let h=this.pools.get(s.pool);if(h&&(s.slot<h.lastSlot||h.signatures.has(s.signature)))return;
   if(!h){if(this.pools.size>=this.c.maxPools)this.remove(this.pools.keys().next().value,'pool_capacity');h={mint:s.mint,events:[],signatures:new Set(),started:now,lastSlot:s.slot,last:now,watch:null,lastLog:0};this.pools.set(s.pool,h);}
   const removed=h.events.filter(e=>e.receivedAt<=now-this.c.baselineMs);for(const e of removed)h.signatures.delete(e.signature);h.events=h.events.filter(e=>e.receivedAt>now-this.c.baselineMs);this.totalEvents-=removed.length;
   h.events.push(s);h.signatures.add(s.signature);this.totalEvents++;h.last=now;h.lastSlot=s.slot;h.quote=s;this.counts.swaps++;
   if(h.events.length>this.c.maxPoolEvents||this.totalEvents>this.c.maxEvents){this.remove(s.pool,'event_capacity');return;}
   const m=metrics(h.events,now),price=this.discovery.usablePrice(now),ready=now-h.started>=this.c.baselineMs;
   if(price&&m.volumeSol*price.usd>=1000)this.discovery.request(s.pool,s.mint);
   const old=this.discovery.old(s.pool,s.mint,now);
   if(now-h.lastLog>=5000){h.lastLog=now;this.store.log('pool_window',{pool:s.pool,mint:s.mint,at:now,ready,ageKnown:!!this.store.data.ages[s.pool],ageMs:this.store.data.ages[s.pool]?now-this.store.data.ages[s.pool].migrationAt:null,...m,price:s.price,volumeUsd:price?m.volumeSol*price.usd:null,usd:price});}
   this.exits(s,h,now);
   for(const [key,p] of [...this.pending])if(p.pool===s.pool&&now>=p.at+this.c.entryDelayMs){this.pending.delete(key);const q=buyQuote(s,this.c);if(!q||!old||!ready||!price||s.price<p.level||m.net10<=0){this.store.log('entry_cancelled',{id:p.id,pool:s.pool,reason:'entry_revalidation',at:now});continue;}if(this.store.data.positions.length>=this.c.maxPositions){this.store.log('entry_cancelled',{id:p.id,reason:'research_capacity',at:now});continue;}const pos={...p,openedAt:now,lastAt:now,raw:q.raw,cost:q.cost,highNet:0,armed:false,lastNet:null};this.store.data.positions.push(pos);this.counts.entries++;this.store.log('shadow_entry',{...pos,at:now,fillSource:'next_stream_constant_product_proxy',assumptions:{feeBps:this.c.feeBps,slippageBps:this.c.slippageBps,networkSol:this.c.networkSol}});}
   if(h.watch&&now-h.watch.at>this.c.candidateTtlMs){this.store.log('watch_expired',{pool:s.pool,id:h.watch.id,at:now});h.watch=null;}
   if(!h.watch&&ready&&old&&price&&m.volumeSol*price.usd>=10000){h.watch={id:crypto.randomUUID(),at:now,level:m.breakout,used:new Set(),touched:false};this.counts.shortlisted++;this.store.log('shortlist',{id:h.watch.id,pool:s.pool,mint:s.mint,at:now,...m,usd:price,history:h.events,age:this.store.data.ages[s.pool]});}
   if(!h.watch)return;this.store.log('watch_swap',{...s,watchId:h.watch.id,at:now});
   const w=h.watch;if(!(w.level>0))return;
   if(w.crossedAt&&now>w.crossedAt&&s.price>=w.level*.99&&s.price<=w.level*1.01)w.touchedAt=now;
   if(!w.crossedAt&&s.price>w.level)w.crossedAt=now;
   const qualifies=ready&&old&&price&&m.multiple>=this.c.volumeMultiple&&m.buySol>m.sellSol&&m.net10>0&&m.buyers>=this.c.minBuyers&&m.trades>=this.c.minTrades&&s.price>w.level;
   if(!qualifies)return;
   for(const threshold of this.c.volumeLevels)if(m.volumeSol*price.usd>=threshold)for(const method of ['breakout','retest']){
     if(method==='retest'&&(!w.touchedAt||now<=w.touchedAt))continue;
     for(const exit of this.c.exitVariants){const arm=`${threshold}_${method}_${exit.id}`,key=s.pool+':'+arm;if(w.used.has(arm)||this.pending.has(key)||this.store.data.positions.some(p=>p.pool===s.pool&&p.arm===arm))continue;w.used.add(arm);const p={id:crypto.randomUUID(),watchId:w.id,pool:s.pool,mint:s.mint,arm,exit,method,threshold,level:w.level,at:now};this.pending.set(key,p);this.store.log('entry_signal',{...p,metrics:m,usd:price});}
   }
 }
 exits(s,h,now){for(const p of [...this.store.data.positions].filter(p=>p.pool===s.pool)){
   if(now-p.lastAt>this.c.maxGapMs){this.unknown(p,'quote_gap',now);continue;}p.lastAt=now;
   const value=sellQuote(s,p.raw,this.c);if(value===null){this.unknown(p,'unquotable',now);continue;}const pct=(value/p.cost-1)*100;p.lastNet=value-p.cost;p.highNet=Math.max(p.highNet,pct);if(p.highNet>=p.exit.arm)p.armed=true;
   if(p.exitAt&&now>=p.exitAt+this.c.exitDelayMs){const net=value-p.cost;this.store.log('shadow_exit',{...p,at:now,netPnlSol:net,returnPct:pct,heldMs:now-p.openedAt,fillSource:'next_stream_constant_product_proxy'});const t=this.store.data.totals;t.closed++;t.wins+=net>0?1:0;t.net+=net;this.store.data.positions=this.store.data.positions.filter(x=>x.id!==p.id);continue;}
   if(p.exitAt)continue;
   const thirty=h.events.filter(e=>e.receivedAt>now-30000),sellPressure=sum(thirty,'sell')>sum(thirty,'buy');
   const trailing=p.armed&&((1+p.highNet/100)-(1+pct/100))/(1+p.highNet/100)*100>=p.exit.drop;
   const broken=s.price<p.level*.97&&sellPressure;
   if(trailing||broken){p.exitAt=now;p.reason=trailing?'trailing_net_value':'breakout_failed_sell_pressure';this.store.log('exit_signal',{id:p.id,pool:p.pool,at:now,reason:p.reason,netReturnPct:pct});}
 }}
 tick(now=Date.now()){for(const p of [...this.store.data.positions])if(now-p.lastAt>this.c.maxGapMs)this.unknown(p,'quote_timeout_no_fill',now);for(const [k,p] of this.pending)if(now-p.at>this.c.maxGapMs){this.pending.delete(k);this.store.log('entry_cancelled',{id:p.id,reason:'entry_quote_timeout',at:now});}for(const [pool,h] of this.pools)if(now-h.last>this.c.baselineMs)this.remove(pool,'inactive_history');}
 view(){return {connected:this.connected,counts:this.counts,pools:this.pools.size,oldPools:[...this.pools].filter(([p,h])=>this.discovery.old(p,h.mint,Date.now())).length,ageQueue:this.discovery.queue.size,ageEvidence:Object.keys(this.store.data.ages).length,price:this.discovery.price,bytesToday:this.store.data.streamDays[new Date().toISOString().slice(0,10)]||0,rpc:{requests:this.discovery.rpc.count,budgetSkips:this.discovery.rpc.denied},watchlist:[...this.pools].filter(([,h])=>h.watch).map(([pool,h])=>({pool,mint:h.mint,since:h.watch.at,level:h.watch.level}))};}
}
module.exports={Trend,metrics,buyQuote,sellQuote};
