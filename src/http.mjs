import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config, authenticate } from './config.mjs';
import { Store } from './store.mjs';
import { Service } from './service.mjs';
import { createMcp } from './mcp.mjs';
export function createApp(service,c) {
  const app=express();app.disable('x-powered-by');let pending=0;
  app.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"});
    const host=req.headers.host?.split(':')[0];
    if(![c.publicUrl.hostname,'localhost','127.0.0.1'].includes(host) && !(req.path==='/health' && !req.headers.origin)) return res.status(403).json({error:'Unrecognized host'});
    if(req.headers.origin && req.headers.origin!==c.publicUrl.origin) return res.status(403).json({error:'Unrecognized origin'});
    next();
  });
  app.get('/health',async(req,res)=>{try {await service.store.health();res.json({status:'ready'});}catch {res.status(503).json({status:'unavailable'});}});
  app.use('/mcp',(req,res,next)=>{
    const profile=authenticate(req.headers.authorization,c.profiles);
    if(!profile) {res.set('WWW-Authenticate','Bearer realm="jovememory"');return res.status(401).json({error:'Authentication required'});}
    req.profile=profile;next();
  });
  app.post('/mcp',(req,res,next)=>{
    if(pending>=32) return res.status(429).json({error:'Capacity exceeded'});
    if(!req.is('application/json')) return res.status(415).json({error:'Use application/json'});
    pending++;res.once('close',()=>{pending--;});next();
  },express.json({limit:'8mb',strict:true}),async(req,res)=>{
    const server=createMcp(service,req.profile);
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.once('close',()=>{void transport.close();void server.close();});
    try {await server.connect(transport);await transport.handleRequest(req,res,req.body);}
    catch {if(!res.headersSent) res.status(500).json({error:'Request failed'});}
  });
  app.all('/mcp',(req,res)=>res.status(405).set('Allow','POST').json({error:'Stateless MCP accepts POST'}));
  app.use((req,res)=>res.status(404).json({error:'Not found'}));
  app.use((error,req,res,next)=>{if(res.headersSent) return next(error);res.status(error.type==='entity.too.large'?413:400).json({error:'Invalid or oversized request'});});
  return app;
}
if(process.argv[1]===new URL(import.meta.url).pathname) {
  const c=config(),store=new Store(c.databaseUrl);await store.health();
  const app=createApp(new Service(store,c),c);
  const server=app.listen(c.port,c.host,()=>console.error('jovememory HTTP started.'));
  server.requestTimeout=40000;server.headersTimeout=10000;
  let stopping=false;
  const stop=()=>{if(stopping) return;stopping=true;
    server.close(()=>{void store.close().then(()=>process.exit(0));});setTimeout(()=>process.exit(1),15000).unref();};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
