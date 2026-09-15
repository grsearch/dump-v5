'use strict';
class Rpc{
 constructor(c){this.c=c;this.calls=[];this.count=0;this.denied=0;}
 async call(method,params){if(!['getAsset','getSignaturesForAddress','getTransaction'].includes(method))throw new Error('Read-only RPC allowlist');const now=Date.now();this.calls=this.calls.filter(t=>now-t<60000);if(this.calls.length>=this.c.rpcPerMinute){this.denied++;throw new Error('rpc_budget');}this.calls.push(now);this.count++;const r=await fetch(this.c.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:this.count,method,params}),signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error('rpc_http_'+r.status);const x=await r.json();if(x.error)throw new Error('rpc_code_'+x.error.code);return x.result;}
}
module.exports=Rpc;
