import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { authenticate, authorize, hash, bounded, validateEndpoint, config } from '../src/config.mjs';
import { planIngestion } from '../src/ingest.mjs';
import { fuse, isEligible } from '../src/service.mjs';
import { Provider, readBounded } from '../src/provider.mjs';
import { blockedPath, secretPatterns } from '../scripts/public-check.mjs';
import { TOOLS } from '../src/schemas.mjs';
test('Bearer authentication rejects malformed values, unknown tokens and unauthorized workspace/role',()=>{
  const token=randomBytes(32).toString('base64url'),profile={id:'synthetic-reader',role:'reader',workspaces:['synthetic-a'],sha256:hash(token)};
  assert.equal(authenticate(`Bearer ${token}`,[profile]),profile);
  assert.equal(authenticate('Bearer '+randomBytes(32).toString('base64url'),[profile]),null);
  assert.equal(authenticate('Basic abc',[profile]),null);
  assert.throws(()=>authorize(profile,'write','synthetic-a'),{code:'FORBIDDEN'});
  assert.throws(()=>authorize(profile,'read','synthetic-b'),{code:'FORBIDDEN'});
});
test('External endpoints refuse credentials, unsafe protocols, redirects to nonlocal HTTP and production HTTP',()=>{
  for(const value of ['http://example.com','https://user:pass@example.com','file:///etc/passwd','https://example.com/?token=x']) assert.throws(()=>validateEndpoint(value));
  assert.doesNotThrow(()=>validateEndpoint('http://127.0.0.1:3456'));
  assert.throws(()=>validateEndpoint('http://127.0.0.1:3456',true));
});
test('Configuration fails closed without explicit credentials and validates production origin',()=>{
  assert.throws(()=>config({DATABASE_URL:'unused'}));
  assert.throws(()=>config({NODE_ENV:'production',PUBLIC_URL:'http://localhost',AUTH_PROFILES:'[]'}));
});
test('Strict tools reject unknown fields and out-of-range limits without coercion',()=>{
  assert.equal(Object.keys(TOOLS).length,32);
  for(const value of [{workspace:'synthetic-a',query:'source',bogus:true},{workspace:'synthetic-a',query:'source',limit:'10'},{workspace:'synthetic-a',query:'source',limit:101}]) assert.equal(TOOLS.memory_search.schema.safeParse(value).success,false);
});
test('Ingestion hash commits to workspace, source and bytes; safe paths and fenced headings',()=>{
  const files=[{source:'docs/example.md',content:'# One\nFirst\n```md\n# Not a heading\n```\n# Two\nSecond\n'}];
  const a=planIngestion('synthetic-a',files);
  assert.equal(a.sections.length,2);assert.match(a.sections[0].content,/# Not a heading/);
  assert.equal(a.plan_hash,planIngestion('synthetic-a',files).plan_hash);
  assert.notEqual(a.plan_hash,planIngestion('synthetic-b',files).plan_hash);
  for(const source of ['../secret.md','/etc/password.md','.env.md','docs/../x.md','docs\\x.md']) assert.throws(()=>planIngestion('synthetic-a',[{source,content:'text'}]));
});
test('Context budget counts complete UTF-8 JSON and reports whole omitted items',()=>{
  const result=bounded({results:[{id:'1',content:'ação'.repeat(1000)},{id:'2',content:'large'.repeat(1000)}]},1024);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=1024);
  assert.deepEqual(result.omitted_ids,['1','2']);assert.equal(result.results.length,0);
});
test('RRF retains provenance and temporal eligibility excludes proposed, future and expired sources',()=>{
  const fused=fuse({lexical:[{id:'a'}],semantic:[{id:'b'},{id:'a'}]},10);
  assert.equal(fused[0].id,'a');assert.deepEqual(fused[0].provenance,['lexical','semantic']);
  assert.equal(isEligible({status:'proposed'}),false);
  assert.equal(isEligible({status:'active',valid_until:'2000-01-01'}),false);
  assert.equal(isEligible({status:'active',valid_from:'2099-01-01'}),false);
});
test('External body limit enforces actual bytes without content-length',async()=>{
  const r=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(10));c.enqueue(new Uint8Array(10));c.close();}}));
  await assert.rejects(readBounded(r,15),{code:'LIMIT'});
});
test('Disabled providers do not issue paid calls',async()=>{
  const p=new Provider({enabled:false,key:'synthetic',embeddingModel:'synthetic',dimensions:2});
  await assert.rejects(p.embed('example'),{code:'PROVIDER_DISABLED'});
});
test('Public scanner blocks private paths and known key formats without printing values',()=>{
  for(const path of ['.env','private/example.json','exports/corpus.json','backups/store.dump','x.key']) assert.equal(Boolean(blockedPath(path)),true);
  assert.equal(Boolean(blockedPath('.env.example')),false);
  assert.ok(secretPatterns.some(re=>re.test(['ghp','_'+'x'.repeat(40)].join(''))));
});

test('Evaluation distinguishes relevant retrieval from negative queries and keeps holdout separate',async()=>{
  const {retrievalMetrics,calibration}=await import('../src/metrics.mjs');
  const metrics=retrievalMetrics([{expected:['a','b'],actual:['x','a']},{expected:[],actual:[]}]);
  assert.equal(metrics.recall_at_k,0.5);assert.equal(metrics.precision_at_k,0.5);assert.equal(metrics.mrr,0.5);assert.equal(metrics.negative_empty_rate,1);
  const result=calibration([{score:0.9,relevant:true,split:'training'},{score:0.1,relevant:false,split:'training'},
    {score:0.8,relevant:true,split:'holdout'},{score:0.2,relevant:false,split:'holdout'}]);
  assert.equal(result.recommendation.threshold,0.9);assert.equal(result.holdout.fn,1);assert.equal(result.configuration_changed,false);
});

test('Provider wire contract handles text/image vectors and redacts rejected remote content',async()=>{
  const {createServer}=await import('node:http');
  const key='synthetic-private-value',requests=[];
  const server=createServer(async(req,res)=>{const chunks=[];for await(const part of req) chunks.push(part);const body=JSON.parse(Buffer.concat(chunks));requests.push(body);
    res.setHeader('Content-Type','application/json');
    if(body.input==='fail') {res.writeHead(401);res.end(JSON.stringify({error:key}));}
    else res.end(JSON.stringify({data:[{embedding:[1,0,0]}]}));});
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try {
    const p=new Provider({enabled:true,key,endpoint:`http://127.0.0.1:${server.address().port}`,embeddingModel:'synthetic-model',dimensions:3});
    assert.deepEqual(await p.embed('synthetic text'),[1,0,0]);await p.embed('synthetic text');assert.equal(requests.length,1);
    assert.deepEqual(await p.embedImage('c3ludGhldGlj','image/png'),[1,0,0]);
    assert.equal(requests[1].input[0].content[0].type,'image_url');
    await assert.rejects(p.embed('fail'),error=>error.code==='PROVIDER' && !error.message.includes(key));
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('Runtime bootstrap derives a role-specific credential without reusing or disclosing the owner password',async()=>{
  const {runtimeDatabaseUrl}=await import('../src/config.mjs');
  const admin=new URL('postgresql://127.0.0.1:5432/example');admin.username='owner';admin.password=randomBytes(32).toString('hex');
  const runtime=runtimeDatabaseUrl(admin.href);assert.equal(runtime.username,'jovememory_app');assert.notEqual(runtime.password,admin.password);
  assert.equal(runtime.password.length,64);assert.equal(runtime.href,runtimeDatabaseUrl(admin.href).href);
  admin.pathname='/another';assert.notEqual(runtime.password,runtimeDatabaseUrl(admin.href).password);
});
