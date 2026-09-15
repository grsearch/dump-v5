'use strict';
const path=require('node:path');
const PUMP='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',WSOL='So11111111111111111111111111111111111111112';
function readConfig(e=process.env){
 const n=(k,d,a,b)=>{const v=Number(e[k]??d);if(!Number.isFinite(v)||v<a||v>b)throw new Error('Invalid '+k);return v;};
 const endpoint=(v,p)=>{const u=new URL(v);if(u.protocol!==p||!['helius-rpc.com','helius.xyz'].some(h=>u.hostname.endsWith('.'+h))||u.username||u.password)throw new Error('Helius endpoint required');return u.href;};
 return {mode:'shadow_only',strategy:'selected_pool_momentum_v2',jupiterKey:e.JUPITER_API_KEY||'',maxAgeMs:14*86400000,minFdvUsd:30000,discoveryMs:60000,metadataTtlMs:300000,maxSelectedPools:n('TREND_SELECTED_POOLS',20,1,100),jupiterPerMinute:n('TREND_JUPITER_PER_MINUTE',120,10,600),dexPerMinute:30,quoteMaxAgeMs:4000,quotePollMs:2000,rpcUrl:endpoint(e.HELIUS_RPC_URL||`https://mainnet.helius-rpc.com/?api-key=${e.HELIUS_API_KEY||''}`,'https:'),wsUrl:endpoint(e.HELIUS_WS_URL||`wss://mainnet.helius-rpc.com/?api-key=${e.HELIUS_API_KEY||''}`,'wss:'),dataDir:path.resolve(__dirname,'../data'),minAgeMs:86400000,baselineMs:360000,volumeLevels:[10000,20000],volumeMultiple:3,minBuyers:3,minTrades:5,sizeSol:n('TREND_SIZE_SOL',.05,.001,10),maxImpactPct:n('TREND_MAX_IMPACT_PCT',2,.1,20),feeBps:n('TREND_FEE_BPS',100,0,500),slippageBps:n('TREND_SLIPPAGE_BPS',100,0,1000),networkSol:.000305,entryDelayMs:500,exitDelayMs:500,maxGapMs:15000,candidateTtlMs:180000,maxPools:100,maxEvents:200000,maxPoolEvents:20000,maxPositions:40,maxBytesPerDay:n('TREND_STREAM_GB_PER_DAY',20,.1,1000)*1e9,rpcPerMinute:n('TREND_RPC_PER_MINUTE',6,2,60),maxAgePages:20,exitVariants:[{id:'trail20_8',arm:20,drop:8},{id:'trail40_12',arm:40,drop:12}]};
}
module.exports={readConfig,PUMP,WSOL};
