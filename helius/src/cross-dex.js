'use strict';
const {normalize}=require('./parser'),{PUMP,WSOL}=require('./config'),pump=require('./pump-layout.json');
// Official IDL swap-only layouts. Account owner is independently checked via Helius.
const layouts=[
 {program:'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',name:'Raydium CLMM',pool:2,user:0,vaults:[5,6],tags:[[248,198,158,145,225,117,135,200],[43,4,237,11,26,201,30,98]]},
 {program:'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',name:'Orca Whirlpool',pool:2,user:1,vaults:[4,6],tags:[[248,198,158,145,225,117,135,200]]},
 {program:'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',name:'Orca Whirlpool v2',pool:4,user:3,vaults:[8,10],tags:[[43,4,237,11,26,201,30,98]]},
 {program:PUMP,name:'PumpSwap',pool:0,user:1,vaults:[7,8],tags:pump.instructions.map(i=>i.discriminator)},
 {program:'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',name:'Raydium CPMM',pool:3,user:0,vaults:[6,7],tags:[[143,190,90,218,196,30,51,222],[55,217,98,86,163,74,180,173]]},
 {program:'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',name:'Meteora DLMM',pool:0,user:10,vaults:[2,3],tags:[[248,198,158,145,225,117,135,200],[65,75,63,76,235,91,91,136],[250,73,101,33,38,207,75,184],[43,215,247,132,137,60,243,81],[56,173,230,208,173,228,156,205],[74,98,192,214,177,51,75,51]]},
 {program:'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',name:'Meteora DAMM v2',pool:1,user:8,vaults:[4,5],tags:[[248,198,158,145,225,117,135,200],[65,75,63,76,235,91,91,136]]}
];
const EVENT=Buffer.from([228,69,165,46,81,203,154,29]);
function parseNormalized(tx,selected,prices,now=Date.now(),reject=()=>{}){
 if(!tx||tx.meta?.err)return [];const out=[],sol=prices(WSOL,now);if(!(sol>0)){reject('missing_sol_price');return out;}
 for(const [pool,p] of selected){const spec=layouts.find(l=>l.program===p.owner&&tx.instructions.some(i=>i.program===l.program&&i.accounts[l.pool]===pool&&l.tags.some(t=>i.data.subarray(0,t.length).equals(Buffer.from(t)))));if(!spec)continue;
  const actions=tx.instructions.filter(i=>i.program===spec.program&&i.accounts.includes(pool)&&!i.data.subarray(0,8).equals(EVENT));if(!actions.length)continue;
  if(actions.length!==1||!spec.tags.some(t=>actions[0].data.subarray(0,t.length).equals(Buffer.from(t)))){reject('ambiguous_or_non_swap');continue;}
  const ix=actions[0],vaults=spec.vaults.map(i=>ix.accounts[i]);if(vaults.some(v=>!v)){reject('missing_vault');continue;}
  const balances=vaults.map(v=>{const pre=tx.meta.preTokenBalances?.find(b=>tx.keys[b.accountIndex]===v),post=tx.meta.postTokenBalances?.find(b=>tx.keys[b.accountIndex]===v);if(!pre||!post||pre.mint!==post.mint||pre.uiTokenAmount.decimals!==post.uiTokenAmount.decimals)return null;return {mint:pre.mint,decimals:pre.uiTokenAmount.decimals,delta:BigInt(post.uiTokenAmount.amount)-BigInt(pre.uiTokenAmount.amount)};});
  if(balances.some(b=>!b)||!balances.some(b=>b.mint===p.mint)||!balances.some(b=>b.mint===p.quoteMint)){reject('vault_mint_mismatch');continue;}
  const base=balances.find(b=>b.mint===p.mint),quote=balances.find(b=>b.mint===p.quoteMint);if(!base.delta||!quote.delta||(base.delta>0n)===(quote.delta>0n)){reject('invalid_balance_direction');continue;}
  const usd=prices(quote.mint,now);if(!(usd>0)){reject('missing_quote_price');continue;}
  const quoteUsd=Math.abs(Number(quote.delta))/10**quote.decimals*usd,quoteSol=quoteUsd/sol;if(!(quoteSol>0&&Number.isFinite(quoteSol))){reject('invalid_amount');continue;}
  out.push({pool,mint:p.mint,dex:spec.name,side:base.delta<0n?'buy':'sell',user:ix.accounts[spec.user],signature:tx.signature,slot:tx.slot,receivedAt:now,eventTime:now,quoteSol,quoteUsd,price:quoteSol/Math.abs(Number(base.delta)),decimals:base.decimals,volumeSource:'net_pool_quote_vault_delta',priceSource:'swap_average_not_reserve_ratio',timeSource:'local_receive',quoteMint:quote.mint});
 }return out;
}
function parse(result,selected,prices,reject){return parseNormalized(normalize(result),selected,prices,result.receivedAt||Date.now(),reject);}
module.exports={parse,parseNormalized,layouts};
