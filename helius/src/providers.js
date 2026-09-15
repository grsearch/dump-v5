'use strict';
const {WSOL}=require('./config');
const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
class ReadApi {
 constructor(host,limit,key='',fetcher=fetch){if(!["api.jup.ag","api.dexscreener.com"].includes(host))throw Error("provider_host_allowlist");this.host=host;this.limit=limit;this.key=key;this.fetcher=fetcher;this.calls=[];this.count=0;this.denied=0;this.errors=0;this.blockedUntil=0;}
 async get(path,params={}){
  const allowed=this.host==='api.jup.ag'?['/tokens/v2/search','/swap/v1/quote']:['/token-profiles/latest/v1','/token-profiles/recent-updates/v1','/token-boosts/latest/v1','/token-boosts/top/v1','/latest/dex/search'];
  if(!allowed.includes(path)&&!(this.host==='api.dexscreener.com'&&/^\/tokens\/v1\/solana\/[1-9A-HJ-NP-Za-km-z,]+$/.test(path)))throw Error('read_only_allowlist');
  const now=Date.now();this.calls=this.calls.filter(t=>now-t<60000);if(now<this.blockedUntil||this.calls.length>=this.limit){this.denied++;throw Error('provider_budget');}
  this.calls.push(now);this.count++;
  const u=new URL('https://'+this.host+path);for(const [k,v] of Object.entries(params))u.searchParams.set(k,String(v));
  try{const r=await this.fetcher(u,{method:'GET',redirect:'error',headers:this.key?{'x-api-key':this.key}:{},signal:AbortSignal.timeout(5000)});if(r.status===429)this.blockedUntil=now+60000;if(!r.ok)throw Error('http_'+r.status);const text=await r.text();if(text.length>8000000)throw Error('response_size');return JSON.parse(text);}catch(e){this.errors++;throw Error(/^http_\d+$/.test(e.message)?e.message:'provider_unavailable');}
 }
 view(){return {requests:this.count,budgetSkips:this.denied,errors:this.errors};}
}
class Jupiter extends ReadApi {
 constructor(c,fetcher){super('api.jup.ag',c.jupiterPerMinute,c.jupiterKey,fetcher);this.c=c;this.inflight=new Map();}
 tokens(mints){if(mints.length>100||mints.some(m=>!ADDRESS.test(m)))throw Error('invalid_mints');return this.get('/tokens/v2/search',{query:mints.join(',')});}
 quote(inputMint,outputMint,amount){
  if(!ADDRESS.test(inputMint)||!ADDRESS.test(outputMint)||!/^\d+$/.test(String(amount))||BigInt(amount)<=0n)throw Error('invalid_quote');
  const key=[inputMint,outputMint,amount].join(':');if(this.inflight.has(key))return this.inflight.get(key);
  // Share concurrent identical research arms, never reuse a pre-signal quote as a fill.
  const task=(async()=>{const requestedAt=Date.now(),r=await this.get('/swap/v1/quote',{inputMint,outputMint,amount,swapMode:'ExactIn',slippageBps:this.c.slippageBps,restrictIntermediateTokens:true});const receivedAt=Date.now();
   if(receivedAt-requestedAt>this.c.quoteMaxAgeMs||r.inputMint!==inputMint||r.outputMint!==outputMint||r.inAmount!==String(amount)||!/^\d+$/.test(r.outAmount)||!/^\d+$/.test(r.otherAmountThreshold)||BigInt(r.otherAmountThreshold)<=0n||BigInt(r.otherAmountThreshold)>BigInt(r.outAmount)||!r.routePlan?.length||!Number.isFinite(Number(r.priceImpactPct)))throw Error('invalid_or_stale_quote');
   return {requestedAt,receivedAt,inputMint,outputMint,inAmount:r.inAmount,outAmount:r.outAmount,minimumOut:r.otherAmountThreshold,priceImpactPct:Number(r.priceImpactPct),contextSlot:r.contextSlot,routes:r.routePlan.map(x=>({pool:x.swapInfo?.ammKey,label:x.swapInfo?.label,percent:x.percent})),source:'jupiter_metis_quote_v1'};
  })().finally(()=>this.inflight.delete(key));this.inflight.set(key,task);return task;
 }
 buy(mint){return this.quote(WSOL,mint,String(Math.round(this.c.sizeSol*1e9)));}
 sell(mint,raw){return this.quote(mint,WSOL,raw);}
}
module.exports={ReadApi,Jupiter,ADDRESS};
