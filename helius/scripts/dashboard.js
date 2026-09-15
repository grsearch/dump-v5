'use strict';
const path=require('node:path'),fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto');require('dotenv').config({path:path.join(__dirname,'../.env')});
const host=process.env.DASHBOARD_HOST||'127.0.0.1',port=Number(process.env.DASHBOARD_PORT||8787),token=process.env.DASHBOARD_TOKEN||'';
if(!['127.0.0.1','::1','localhost'].includes(host)&&token.length<24)throw new Error('Public dashboard requires token');
const html=fs.readFileSync(path.join(__dirname,'../src/dashboard.html'));
http.createServer((req,res)=>{res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');const url=new URL(req.url,'http://localhost');if(url.pathname==='/'){res.setHeader('content-type','text/html; charset=utf-8');res.end(html);return;}if(url.pathname!=='/api/state'){res.writeHead(404).end();return;}
 const supplied=(req.headers.authorization||'').replace(/^Bearer /,'');if(token&&(supplied.length!==token.length||!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(token)))){res.writeHead(401).end();return;}
 try{const d=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/dashboard.json')));const page=Math.max(1,Math.min(1000,Number(url.searchParams.get('page'))||1)),events=d.events||[];d.pagination={page,pageSize:20,total:events.length};d.events=events.slice((page-1)*20,page*20);res.setHeader('content-type','application/json');res.end(JSON.stringify(d));}catch{res.writeHead(503).end('{"error":"waiting_for_shadow"}');}
}).listen(port,host,()=>console.log('Shadow dashboard listening'));
