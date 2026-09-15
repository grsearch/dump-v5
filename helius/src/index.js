'use strict';
require('dotenv').config({path:require('node:path').join(__dirname,'../.env')});
const {readConfig}=require('./config'),{Store}=require('./store'),Rpc=require('./rpc'),Discovery=require('./discovery'),Stream=require('./stream'),{Trend}=require('./trend'),{parseSwaps}=require('./parser');
function main(){const c=readConfig(),store=new Store(c.dataDir),rpc=new Rpc(c),discovery=new Discovery(c,store,rpc),trend=new Trend(c,store,discovery),stream=new Stream(c,store);store.log('session',{config:{...c,rpcUrl:undefined,wsUrl:undefined},realTradingPossible:false});
 stream.on('transaction',r=>{try{for(const s of parseSwaps(r,e=>discovery.migration(e)))trend.onSwap(s);}catch{store.log('parser_error');}});stream.on('connection',ok=>{trend.connection(ok);store.log('connection',{connected:ok});});stream.start();
 const tick=setInterval(()=>{trend.tick();discovery.tick().catch(()=>store.log('discovery_error'));},1000),save=setInterval(()=>store.save(trend.view()),5000),health=setInterval(()=>{const v=trend.view();store.log('health',v);console.log(JSON.stringify({type:'trend_health',mode:'shadow_only',connected:v.connected,pools:v.pools,oldPools:v.oldPools,entries:v.counts.entries,positions:store.data.positions.length}));},60000);
 let stopping=false;const stop=()=>{if(stopping)return;stopping=true;stream.stop();clearInterval(tick);clearInterval(save);clearInterval(health);trend.gap('process_shutdown');store.close();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);console.log('Old-pool momentum: SHADOW ONLY; no wallet or transaction submission path.');
}
if(require.main===module)try{main();}catch{console.error('Shadow startup failed; check configuration and lock.');process.exitCode=1;}
module.exports={main};
