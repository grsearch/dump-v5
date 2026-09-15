'use strict';
const {WSOL}=require('./config'),{ReadApi,ADDRESS}=require('./providers'),{layouts}=require('./cross-dex');
const SOURCES=['/token-profiles/latest/v1','/token-profiles/recent-updates/v1','/token-boosts/latest/v1','/token-boosts/top/v1'];
class Discovery {
 constructor(c,store,rpc,jupiter,dex=new ReadApi('api.dexscreener.com',c.dexPerMinute)){this.c=c;this.store=store;this.rpc=rpc;this.jupiter=jupiter;this.dex=dex;this.selected=new Map();this.metadata=new Map();this.owners=new Map();this.catalog=store.data.catalog??={};this.next=0;this.busy=false;this.sourceIndex=0;this.queue=new Map();this.stats={eligible:0,unsupported:0,unknown:0};}
 eligible(pair,meta,now){const at=Date.parse(meta?.firstPool?.createdAt);return pair?.chainId==='solana'&&ADDRESS.test(pair.pairAddress||'')&&ADDRESS.test(pair.baseToken?.address||'')&&ADDRESS.test(pair.quoteToken?.address||'')&&pair.baseToken.address!==pair.quoteToken.address&&meta?.id===pair.baseToken.address&&Number.isFinite(at)&&now-at>=this.c.minAgeMs&&now-at<=this.c.maxAgeMs&&Number.isFinite(pair.fdv)&&pair.fdv>this.c.minFdvUsd;}
 old(pool,mint,now){const p=this.selected.get(pool);return !!p&&p.mint===mint&&now-p.checkedAt<=this.c.metadataTtlMs&&now-p.firstPoolAt>=this.c.minAgeMs&&now-p.firstPoolAt<=this.c.maxAgeMs;}
 request(){}
 usd(mint,now){const m=this.metadata.get(mint);return m&&now-m.fetchedAt<=120000&&m.usdPrice>0?m.usdPrice:null;}
 usablePrice(now){const usd=this.usd(WSOL,now);return usd?{usd,fetchedAt:this.metadata.get(WSOL).fetchedAt,source:'jupiter_tokens_v2'}:null;}
 async tokens(ids){const requested=new Set(ids),rows=await this.jupiter.tokens(ids);for(const x of Array.isArray(rows)?rows:[])if(requested.has(x.id))this.metadata.set(x.id,{...x,fetchedAt:Date.now()});}
 async tick(){if(this.busy||Date.now()<this.next)return;this.busy=true;this.next=Date.now()+this.c.discoveryMs;try{
  const now=Date.now();let seed=[];try{const path=SOURCES[this.sourceIndex++%SOURCES.length],r=await this.dex.get(path);seed=Array.isArray(r)?r:[];}catch{this.store.log('discovery_source_unavailable');}
  if(this.sourceIndex%4===1)try{const r=await this.dex.get('/latest/dex/search',{q:'SOL'});seed.push(...(r.pairs||[]).filter(p=>p.chainId==='solana').map(p=>({chainId:'solana',tokenAddress:p.baseToken?.address})));}catch{}
  for(const s of seed)if(s.chainId==='solana'&&ADDRESS.test(s.tokenAddress||''))this.catalog[s.tokenAddress]??={firstSeenAt:now,checkedAt:0};
  const all=Object.entries(this.catalog).sort((a,b)=>a[1].checkedAt-b[1].checkedAt);for(const [mint,x] of all)if(now-x.firstSeenAt>15*86400000)delete this.catalog[mint];
  const ids=[...new Set([...this.selected.values()].map(p=>p.mint).concat(all.filter(([m])=>this.catalog[m]).slice(0,30).map(([m])=>m)))].slice(0,95);
  if(!ids.length){await this.tokens([WSOL]);return;}
  let pairs=[];for(let i=0;i<ids.length;i+=30){const r=await this.dex.get('/tokens/v1/solana/'+ids.slice(i,i+30).join(','));if(Array.isArray(r))pairs.push(...r);}
  await this.tokens([...new Set([WSOL,...ids])]);
  const viable=pairs.filter(p=>ids.includes(p.baseToken?.address)&&this.eligible(p,this.metadata.get(p.baseToken.address),now));
  const quoteMints=[...new Set(viable.map(p=>p.quoteToken.address))].filter(m=>!this.usd(m,now));if(quoteMints.length)await this.tokens(quoteMints.slice(0,100));
  const pools=[...new Set(viable.map(p=>p.pairAddress))].filter(p=>!this.owners.has(p)).slice(0,100);
  if(pools.length){const r=await this.rpc.call('getMultipleAccounts',[pools,{encoding:'base64',dataSlice:{offset:0,length:0},commitment:'confirmed'}]);if(r?.value?.length===pools.length)r.value.forEach((a,i)=>{if(a)this.owners.set(pools[i],a.owner);});}
  for(const id of ids)this.catalog[id]&&(this.catalog[id].checkedAt=now);
  const next=new Map(),seen=new Set();this.stats={eligible:viable.length,unsupported:0,unknown:ids.filter(m=>!this.metadata.get(m)?.firstPool?.createdAt).length};
  viable.sort((a,b)=>Number(this.selected.has(b.pairAddress))-Number(this.selected.has(a.pairAddress))||(b.liquidity?.usd||0)-(a.liquidity?.usd||0));
  for(const p of viable){const owner=this.owners.get(p.pairAddress);if(!layouts.some(l=>l.program===owner)){this.stats.unsupported++;continue;}if(!this.usd(p.quoteToken.address,now)||seen.has(p.baseToken.address)||next.size>=this.c.maxSelectedPools)continue;seen.add(p.baseToken.address);next.set(p.pairAddress,{pool:p.pairAddress,mint:p.baseToken.address,quoteMint:p.quoteToken.address,owner,dex:p.dexId,fdv:p.fdv,firstPoolAt:Date.parse(this.metadata.get(p.baseToken.address).firstPool.createdAt),checkedAt:now});}
  this.selected=next;this.store.data.selected=[...next.values()];this.store.log('discovery_refresh',{catalog:Object.keys(this.catalog).length,selected:this.store.data.selected,...this.stats,coverage:'dexscreener_discovered_subset',ageDefinition:'token_first_pool'});
  for(const [m] of Object.entries(this.catalog).sort((a,b)=>b[1].firstSeenAt-a[1].firstSeenAt).slice(5000))delete this.catalog[m];
  for(const [m,x] of this.metadata)if(now-x.fetchedAt>3600000)this.metadata.delete(m);if(this.owners.size>10000)this.owners.clear();
 }catch{this.store.log('discovery_refresh_failed');}finally{this.busy=false;}}
 active(now=Date.now()){return new Map([...this.selected].filter(([pool,p])=>this.old(pool,p.mint,now)));}
 view(){return {discovered:Object.keys(this.catalog).length,selected:this.active().size,...this.stats,dex:this.dex.view(),jupiter:this.jupiter.view(),coverage:'DexScreener发现子集，非全网枚举'};}
}
module.exports=Discovery;
