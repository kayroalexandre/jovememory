import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { authenticate, authorize, hash, bounded, validateEndpoint, config } from '../src/config.mjs';
import { planIngestion } from '../src/ingest.mjs';
import { fuse, isEligible } from '../src/service.mjs';
import { Provider, readBounded, selectFreeModels } from '../src/provider.mjs';
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
test('Write policy defaults to automatic, accepts manual opt-in and rejects an unknown policy',()=>{
  const env={DATABASE_URL:'unused',AUTH_PROFILES:JSON.stringify([{id:'synthetic-writer',role:'writer',workspaces:['synthetic-a'],sha256:hash('synthetic-token')}])};
  assert.equal(config(env).reviewMode,'automatic');
  assert.equal(config({...env,MEMORY_REVIEW_MODE:'manual'}).reviewMode,'manual');
  assert.throws(()=>config({...env,MEMORY_REVIEW_MODE:'unknown'}));
});
test('OpenRouter model roles default to the planned specialized matrix',()=>{
  const env={DATABASE_URL:'unused',AUTH_PROFILES:JSON.stringify([{id:'synthetic-writer',role:'writer',workspaces:['synthetic-a'],sha256:hash('synthetic-token')}])};
  assert.throws(()=>config({...env,ENABLE_PROVIDER:'true'}),{code:'CONFIG'});
  const models=config(env).provider;
  assert.equal(models.embeddingModel,'google/gemini-embedding-2');
  assert.equal(models.decisionModel,'upstage/solar-decide');
  assert.equal(models.rerankModel,'qwen/qwen3.8-flash');
  assert.equal(models.knowledgeModel,'deepseek/deepseek-v4-flash');
  assert.equal(models.synthesisModel,'openrouter/free');
  assert.equal(models.inferenceFallbackModels[0],'deepseek/deepseek-v4-pro');
  assert.equal(models.inferenceMaxInputPrice,undefined);assert.equal(models.inferenceMaxOutputPrice,undefined);
  assert.match(models.decisionEndpoint,/\/api\/alpha\/decisions$/);
});
test('Strict tools reject unknown fields and out-of-range limits without coercion',()=>{
  assert.equal(Object.keys(TOOLS).length,43);
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
  const input={results:[{id:'1',content:'ação'.repeat(1000)},{id:'2',content:'large'.repeat(1000)}]};
  const result=bounded(input,1024);
  assert.equal(input.results.length,2);
  assert.deepEqual(bounded(result,1024).omitted_ids,result.omitted_ids);
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

test('Provider wire contract routes embeddings, decisions, rerank, knowledge and synthesis without leaking remote errors',async()=>{
  const {createServer}=await import('node:http');
  const key='synthetic-private-value',requests=[];
  const server=createServer(async(req,res)=>{if(req.method==='GET') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[]}));return;}const chunks=[];for await(const part of req) chunks.push(part);const body=JSON.parse(Buffer.concat(chunks));requests.push({path:req.url,body});
    res.setHeader('Content-Type','application/json');
    if(body.input==='fail') {res.writeHead(401);res.end(JSON.stringify({error:key}));return;}
    if(req.url==='/decisions') {res.end(JSON.stringify({answers:{score:{type:'noul',noul:0.84}}}));return;}
    if(req.url==='/chat/completions') {
      const byModel={
        'qwen/qwen3.8-flash':{scores:[{id:'a',score:0.9},{id:'b',score:0.2}]},
        'deepseek/deepseek-v4-flash':{summary:'Synthetic summary',keywords:['memory'],entities:['Jove']},
        'openrouter/free':{summary:'Synthetic context',cited_ids:['a']}
      };
      res.end(JSON.stringify({model:body.model==='openrouter/free'?'synthetic/large:free':body.model,choices:[{message:{content:JSON.stringify(byModel[body.model])}}]}));return;
    }
    res.end(JSON.stringify({data:[{embedding:[1,0,0]}]}));
  });
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    const p=new Provider({enabled:true,key,endpoint:base,decisionEndpoint:base+'/decisions',embeddingModel:'google/gemini-embedding-2',dimensions:3,
      decisionModel:'upstage/solar-decide',rerankModel:'qwen/qwen3.8-flash',knowledgeModel:'deepseek/deepseek-v4-flash',synthesisModel:'openrouter/free'});
    assert.deepEqual(await p.embed('synthetic text'),[1,0,0]);await p.embed('synthetic text');
    assert.deepEqual(await p.embedImage('c3ludGhldGlj','image/png'),[1,0,0]);
    assert.equal(await p.decision({content:'fact'},'Is this durable?'),0.84);
    const ranked=await p.rerank('query',[{id:'a',content:'one'},{id:'b',content:'two'}]);
    assert.equal(ranked.model,'qwen/qwen3.8-flash');assert.equal(ranked.scores.get('a'),0.9);
    const extracted=await p.extract('synthetic');assert.equal(extracted.model,'deepseek/deepseek-v4-flash');
    const synthesized=await p.synthesize('query',[{id:'a',content:'one'}]);assert.equal(synthesized.model,'synthetic/large:free');assert.equal(synthesized.routing.tier,'free');
    assert.ok(requests.some(x=>x.path==='/decisions' && x.body.model==='upstage/solar-decide'));
    const qwen=requests.find(x=>x.body.model==='qwen/qwen3.8-flash');
    assert.equal(qwen.body.response_format.type,'json_schema');assert.equal(qwen.body.response_format.json_schema.strict,true);assert.equal(qwen.body.reasoning.enabled,false);
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


test('Malformed model contracts trigger fallback and cannot introduce unknown citations',async()=>{
  const p=new Provider({enabled:true,key:'synthetic',synthesisModel:'synthetic-primary',knowledgeModel:'synthetic-fallback'});
  const models=[];
  p.request=async(path,input)=>{models.push(input.model);return {choices:[{message:{content:JSON.stringify({summary:'Synthetic answer',cited_ids:[input.model==='synthetic-primary'?'unknown':'source']})}}]};};
  const result=await p.synthesize('query',[{id:'source',content:'Synthetic source'}]);
  assert.deepEqual(models,['synthetic-primary','synthetic-fallback']);assert.equal(result.model,'synthetic-fallback');
  p.request=async()=>({choices:[{message:{content:JSON.stringify({summary:'Synthetic answer',cited_ids:['unknown']})}}]});
  await assert.rejects(p.synthesize('query',[{id:'source',content:'Synthetic source'}]),{code:'PROVIDER'});
});


test('Auxiliary inference is opt-in and additional scoped profiles preserve existing credentials',()=>{
  assert.equal(TOOLS.memory_context.schema.parse({workspace:'synthetic-a',query:'context'}).synthesize,false);
  assert.equal(TOOLS.memory_write.schema.parse({workspace:'synthetic-a',content:'fact'}).enrich,false);
  assert.equal(TOOLS.memory_consolidate.schema.parse({workspace:'synthetic-a',ids:[crypto.randomUUID(),crypto.randomUUID()]}).summarize,false);
  const base={id:'synthetic-base',role:'writer',workspaces:['synthetic-a'],sha256:hash('base')};
  const extra={id:'synthetic-extra',role:'writer',workspaces:['synthetic-b'],sha256:hash('extra')};
  const env={DATABASE_URL:'unused',AUTH_PROFILES:JSON.stringify([base]),EXTRA_AUTH_PROFILES:JSON.stringify([extra])};
  assert.deepEqual(config(env).profiles,[base,extra]);
  assert.throws(()=>config({...env,EXTRA_AUTH_PROFILES:JSON.stringify([base])}),{code:'CONFIG'});
});


test('Free routing filters live zero-price text models and prefers configured capacity before smaller models',()=>{
  const entry=(id,context_length=100000,price='0',output=['text'])=>({id,name:id,context_length,pricing:{prompt:price,completion:price},architecture:{input_modalities:['text'],output_modalities:output}});
  const rows=[null,{},entry('synthetic/a-small-8b:free'),entry('synthetic/z-huge-550b:free'),entry('synthetic/music',100000,'0',['audio']),entry('synthetic/paid',100000,'0.01'),entry('synthetic/mispriced:free',100000,null),entry('synthetic/short-999b:free',2048),entry('openrouter/free')];
  assert.deepEqual(selectFreeModels(rows,[],1000),['synthetic/z-huge-550b:free','synthetic/a-small-8b:free']);
  assert.deepEqual(selectFreeModels(rows,['synthetic/a-small-8b:free'],1000),['synthetic/a-small-8b:free','synthetic/z-huge-550b:free']);
  assert.deepEqual(selectFreeModels(rows,[],200000),[]);
});

test('Native free routing tries preferred free models, validates citations and does not cap paid fallback prices',async()=>{
  const p=new Provider({enabled:true,key:'synthetic',synthesisModel:'openrouter/free',inferenceFallbackModels:['deepseek/deepseek-v4-pro','deepseek/deepseek-v4-flash'],inferenceMaxInputPrice:0.001,inferenceMaxOutputPrice:0.001});
  p.freeModels=async()=>['synthetic/large-550b:free','synthetic/large-120b:free'];
  const requests=[];p.request=async(path,input)=>{requests.push(input);return {model:input.models?.[0] ?? input.model,choices:[{message:{content:JSON.stringify({summary:'Synthetic compact evidence',cited_ids:[input.model==='deepseek/deepseek-v4-pro'?'source':'unknown']})}}]};};
  const result=await p.synthesize('query',[{id:'source',content:'Synthetic source'}]);
  assert.deepEqual(requests[0].models,['synthetic/large-550b:free','synthetic/large-120b:free']);assert.equal(requests[1].model,'openrouter/free');
  assert.deepEqual(requests[0].provider.max_price,{prompt:0,completion:0,request:0});assert.deepEqual(requests[1].provider.max_price,{prompt:0,completion:0,request:0});
  assert.equal(requests[2].provider.max_price,undefined);assert.equal(requests[2].provider.sort,'price');assert.equal(requests[2].response_format.type,'json_schema');
  assert.equal(result.model,'deepseek/deepseek-v4-pro');assert.equal(result.routing.paid_fallback,true);
  requests.length=0;p.request=async(path,input)=>{requests.push(input);return {model:'synthetic/large-550b:free',usage:{cost:0},choices:[{message:{content:JSON.stringify({summary:'Synthetic evidence',cited_ids:['source']})}}]};};
  const free=await p.synthesize('query',[{id:'source',content:'Synthetic source'}]);assert.equal(free.routing.tier,'free');assert.equal(free.routing.paid_fallback,false);assert.equal(requests.length,1);
  const disabled=new Provider({enabled:false,key:'synthetic',synthesisModel:'openrouter/free'});disabled.freeModels=async()=>{throw new Error('Catalog must not be contacted.');};
  await assert.rejects(disabled.synthesize('query',[{id:'source',content:'Synthetic'}]),{code:'PROVIDER_DISABLED'});
});

test('Unavailable model catalog uses the free router without inventing its effective model',async()=>{
  const p=new Provider({enabled:true,key:'synthetic',synthesisModel:'openrouter/free',inferenceFallbackModels:[]});p.freeModels=async()=>[];
  const requests=[];p.request=async(path,input)=>{requests.push(input);return {model:'synthetic/actual:free',choices:[{message:{content:'{"summary":"Synthetic","cited_ids":["source"]}'}}]};};
  const output=await p.synthesize('query',[{id:'source',content:'Synthetic'}]);assert.equal(output.model,'synthetic/actual:free');assert.equal(requests[0].model,'openrouter/free');
  p.request=async()=>({choices:[{message:{content:'{"summary":"Synthetic","cited_ids":["source"]}'}}]});
  await assert.rejects(p.synthesize('query',[{id:'source',content:'Synthetic'}]),{code:'PROVIDER'});
});

test('Git identity unifies SSH/HTTPS, distinguishes owners and rejects credential-bearing origins',async()=>{
  const {remoteIdentity}=await import('../src/repository.mjs');
  const a=remoteIdentity('git@github.com:example/Synthetic.App.git');
  assert.equal(a.repository_name,'Synthetic.App');
  assert.equal(a.repository_id,remoteIdentity('https://github.com/EXAMPLE/synthetic.app').repository_id);
  assert.notEqual(a.repository_id,remoteIdentity('https://github.com/other/synthetic.app').repository_id);
  for(const value of ['https://user:password@github.com/example/synthetic','https://github.com/example/synthetic?token=value','/tmp/local','git@github.com:example/../synthetic'])assert.throws(()=>remoteIdentity(value),{code:'REPOSITORY'});
});

test('Lifecycle separates observations from truth and age does not invalidate facts',async()=>{
  const {lifecycle}=await import('../src/lifecycle.mjs');
  const item={status:'active',created_at:'2000-01-01',metadata:{source_refs:[{locator:'README.md',sha256:hash('one')}]}};
  const sources=new Map([['README.md',{sha256:hash('one'),present:true}]]);
  assert.equal(lifecycle(item,sources).status,'matches_observation');assert.equal(lifecycle(item,sources).truth_verified,false);
  sources.get('README.md').sha256=hash('two');assert.equal(lifecycle(item,sources).status,'needs_revalidation');
  sources.get('README.md').present=false;assert.equal(lifecycle(item,sources).source_diagnostics[0].status,'missing');
  assert.equal(lifecycle({...item,status:'invalidated'},sources).status,'historical');
  assert.equal(lifecycle({...item,valid_until:'2000-01-01'},sources).status,'expired');
});

test('Signed project credentials validate signature, expiration, audience and revocation epoch',async()=>{
  const {issueProjectToken,authenticateProject}=await import('../src/project-auth.mjs');
  const key=randomBytes(32),project={workspace:'Synthetic.App',repository_id:hash('repository'),credential_epoch:1};
  const settings={projectKey:key,profiles:[]},store={project:async()=>project};
  const {token}=await issueProjectToken(project,key);
  const profile=await authenticateProject('Bearer '+token,settings,store);assert.deepEqual(profile.workspaces,['Synthetic.App']);assert.equal(profile.role,'writer');
  assert.equal(await authenticateProject('Bearer '+token,{...settings,projectKey:randomBytes(32)},store),null);
  const parts=token.split('.');parts[1]=Buffer.from(JSON.stringify({workspace:'another',role:'admin'})).toString('base64url');assert.equal(await authenticateProject('Bearer '+parts.join('.'),settings,store),null);
  project.credential_epoch=2;assert.equal(await authenticateProject('Bearer '+token,settings,store),null);
  const expired=await issueProjectToken(project,key,-10);assert.equal(await authenticateProject('Bearer '+expired.token,settings,store),null);
  const {SignJWT}=await import('jose');const wrong=await new SignJWT({workspace:project.workspace,repository_id:project.repository_id,epoch:2,role:'writer'}).setProtectedHeader({alg:'HS256',typ:'JWT'}).setIssuer('jovememory-project').setAudience('wrong').setSubject('project-'+project.repository_id.slice(0,24)).setJti('synthetic').setIssuedAt().setExpirationTime('1h').sign(key);
  assert.equal(await authenticateProject('Bearer '+wrong,settings,store),null);
});

test('Native project key derivation is domain-separated, stable and rotates with the private runtime credential',()=>{
  const token=randomBytes(32).toString('hex');const url=new URL('postgresql://127.0.0.1:5432/synthetic');url.username='synthetic';url.password=token;
  const profile={id:'synthetic-base',role:'writer',workspaces:['synthetic'],sha256:hash('synthetic')},controller={id:'synthetic-controller',role:'provisioner',workspaces:['*'],sha256:hash('controller')};
  const env={DATABASE_URL:url.href,AUTH_PROFILES:JSON.stringify([profile]),CONTROL_AUTH_PROFILES:JSON.stringify([controller]),PROJECT_TOKEN_KEY_MODE:'database-derived'};
  const first=config(env);assert.deepEqual(first.profiles,[profile,controller]);assert.equal(first.projectKey.length,32);assert.notEqual(first.projectKey.toString('hex'),token);
  assert.deepEqual(first.projectKey,config(env).projectKey);url.password=randomBytes(32).toString('hex');assert.notDeepEqual(first.projectKey,config({...env,DATABASE_URL:url.href}).projectKey);
  const explicit=randomBytes(32).toString('hex');assert.equal(config({...env,PROJECT_TOKEN_SECRET:explicit}).projectKey.toString('hex'),explicit);
});
