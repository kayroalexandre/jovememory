import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdir,symlink } from 'node:fs/promises';
import { authenticateProject } from '../src/project-auth.mjs';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { S3Client, CreateBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } from '@aws-sdk/client-s3';
import { config, hash } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Service } from '../src/service.mjs';
import { createApp } from '../src/http.mjs';
import { migrate } from '../scripts/migrate.mjs';
import { createBackup, verifyRestore, externalDirectory } from '../scripts/backup-lib.mjs';
const suffix=randomBytes(8).toString('hex'),dbName='jovememory_test_'+suffix;
const database=(url,name)=>{const u=new URL(url);u.pathname='/'+name;return u.href;};
test('Isolated database, object storage, MCP and backup lifecycle',async t=>{
  assert.match(process.env.MIGRATION_DATABASE_URL,/127\.0\.0\.1:55471\/jovememory_dev/);
  const admin=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const adminUrl=database(process.env.MIGRATION_DATABASE_URL,dbName),appUrl=database(process.env.DATABASE_URL,dbName);
  const restoreName='jovememory_restore_'+suffix;
  const c=config({...process.env,PROJECT_TOKEN_SECRET:randomBytes(32).toString('hex'),DATABASE_URL:appUrl,ENABLE_PROVIDER:'false',S3_BUCKET:'test-'+suffix,MEMORY_REVIEW_MODE:'manual'});
  const reader={id:'test-reader',role:'reader',workspaces:['synthetic-a']},writer={id:'test-writer',role:'writer',workspaces:['synthetic-a']},
    reviewer={id:'test-reviewer',role:'reviewer',workspaces:['synthetic-a']},operator={id:'test-admin',role:'admin',workspaces:['synthetic-a','synthetic-b']};
  let store,server,bucketCreated=false,restoreCreated=false,backupDir;
  const s3=new S3Client({...c.s3,forcePathStyle:true,maxAttempts:1});
  try {
    await migrate(adminUrl);await migrate(adminUrl);
    const owner=new pg.Client({connectionString:adminUrl});await owner.connect();
    try {await owner.query("INSERT INTO workspaces(name) VALUES('synthetic-a'),('synthetic-b')");} finally {await owner.end();}
    await s3.send(new CreateBucketCommand({Bucket:c.s3.bucket}));bucketCreated=true;
    store=new Store(appUrl);const service=new Service(store,c);
    const called=new Set();
    const call=async(name,args={},profile=writer)=>{const result=await service.call(name,args,profile);called.add(name);return result;};
    const accept=async id=>call('memory_review',{workspace:'synthetic-a',id,action:'accept',reason:'Synthetic test review'},reviewer);
    let itemId,otherId,sourceIds,mediaId;
    await t.test('Workspace provisioning is scoped, idempotent and audited without admin database credentials',async()=>{
      await assert.rejects(call('memory_create_workspace',{workspace:'synthetic-c'},writer),{code:'FORBIDDEN'});
      await assert.rejects(call('memory_create_workspace',{workspace:'synthetic-c'},operator),{code:'FORBIDDEN'});
      const provisioner={id:'synthetic-provisioner',role:'admin',workspaces:['synthetic-c']};
      await Promise.all(Array.from({length:8},()=>call('memory_create_workspace',{workspace:'synthetic-c'},provisioner)));
      await call('memory_create_workspace',{workspace:'synthetic-c'},provisioner);
      assert.deepEqual((await store.stats('synthetic-c')).counts,[]);
      const events=await store.mutations('synthetic-c',{limit:10});assert.equal(events.length,1);assert.equal(events[0].operation,'workspace_create');
      const scoped={id:'synthetic-scoped',role:'writer',workspaces:['synthetic-c']};
      const own=await call('memory_propose_write',{workspace:'synthetic-c',content:'Synthetic isolated project.'},scoped);
      assert.equal((await call('memory_read',{workspace:'synthetic-c',id:own.item.id},scoped)).item.workspace,'synthetic-c');
      await assert.rejects(call('memory_read',{workspace:'synthetic-a',id:own.item.id},scoped),{code:'FORBIDDEN'});
      assert.equal((await call('memory_read',{workspace:'synthetic-a',id:own.item.id},reader)).item,null);
    });
    await t.test('RLS prevents cross-workspace reads even without WHERE, and cannot alter audit',async()=>{
      await call('memory_propose_write',{workspace:'synthetic-b',content:'Isolated private synthetic value'},operator);
      const client=new pg.Client({connectionString:appUrl});await client.connect();
      try {
        await client.query('BEGIN');await client.query("SELECT set_config('app.workspace','synthetic-a',true)");
        assert.equal((await client.query('SELECT * FROM items')).rowCount,0);
        await client.query('COMMIT');
        await assert.rejects(client.query("UPDATE audit SET actor='changed'"));
        const role=(await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
        assert.deepEqual(role,{rolsuper:false,rolbypassrls:false});
      } finally {await client.end();}
      await assert.rejects(call('memory_read',{workspace:'synthetic-b',id:randomUUID()},reader),{code:'FORBIDDEN'});
      await assert.rejects(call('memory_propose_write',{workspace:'synthetic-a',content:'Denied'},reader),{code:'FORBIDDEN'});
    });
    await t.test('Proposals stay hidden, IDs are immutable and independent review is enforced',async()=>{
      const proposal=await call('memory_write',{workspace:'synthetic-a',content:'A synthetic cobalt telescope architecture decision.'});itemId=proposal.item.id;
      assert.equal(proposal.outcome,'proposed');assert.equal(proposal.gate.status,'unavailable');
      assert.equal((await call('memory_search',{workspace:'synthetic-a',query:'cobalt telescope'},reader)).results.length,0);
      await assert.rejects(service.call('memory_review',{workspace:'synthetic-a',id:itemId,action:'accept',reason:'Same actor'}, {...operator,id:writer.id}),{code:'REVIEW'});
      await assert.rejects(call('memory_propose_write',{workspace:'synthetic-a',id:itemId,content:'Overwrite'}),{code:'EXISTS'});
      assert.equal((await call('memory_list_proposed',{workspace:'synthetic-a'})).items.length,1);
      await accept(itemId);
      assert.equal((await call('memory_search',{workspace:'synthetic-a',query:'cobalt telescope'},reader)).results[0].id,itemId);
      const row=(await call('memory_read',{workspace:'synthetic-a',id:itemId},reader)).item;assert.equal(row.content_hash,hash(row.content));
      const pending=await call('memory_propose_write',{workspace:'synthetic-a',content:'Reject this synthetic section'});
      await call('memory_review',{workspace:'synthetic-a',id:pending.item.id,action:'reject',reason:'Rejected example'},reviewer);
      assert.equal((await call('memory_read',{workspace:'synthetic-a',id:pending.item.id},reader)).item.content,'');
      await assert.rejects(call('memory_propose_write',{workspace:'synthetic-a',content:'Reject this synthetic section'}),{code:'EXISTS'});
    });
    await t.test('Node movement, feedback and concurrent replacement review preserve predecessor',async()=>{
      await call('memory_create_node',{workspace:'synthetic-a',node:'design',label:'Synthetic design'});
      await call('memory_move_item',{workspace:'synthetic-a',id:itemId,node:'design',reason:'Group by topic'});
      await call('memory_feedback',{workspace:'synthetic-a',id:itemId,useful:true,reason:'Useful synthetic decision'});
      assert.equal((await call('memory_read',{workspace:'synthetic-a',id:itemId},reader)).item.importance,0.55);
      assert.equal((await call('memory_tree',{workspace:'synthetic-a'},reader)).nodes[0].item_count,1);
      const replacement=await call('memory_update_item',{workspace:'synthetic-a',id:itemId,content:'Updated cobalt telescope decision.',reason:'Revised source'});
      assert.equal((await call('memory_read',{workspace:'synthetic-a',id:itemId},reader)).item.status,'active');
      const concurrent=await Promise.allSettled([accept(replacement.item.id),accept(replacement.item.id)]);
      assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);
      assert.equal((await call('memory_read',{workspace:'synthetic-a',id:itemId},reader)).item.status,'invalidated');
      itemId=replacement.item.id;
    });
    await t.test('Temporal validity is enforced before retrieval and recent unrelated rows do not prove a match',async()=>{
      const expired=await call('memory_propose_write',{workspace:'synthetic-a',content:'Expired synthetic quartz information.',valid_until:'2000-01-01T00:00:00Z'});await accept(expired.item.id);
      const future=await call('memory_propose_write',{workspace:'synthetic-a',content:'Future synthetic quartz information.',valid_from:'2099-01-01T00:00:00Z'});await accept(future.item.id);
      assert.equal((await call('memory_search',{workspace:'synthetic-a',query:'quartz'},reader)).results.length,0);
      assert.equal((await call('memory_search',{workspace:'synthetic-a',query:'unknownunlikelyword'},reader)).results.length,0);
    });
    await t.test('Ingestion preview hash, tombstones, idempotency and atomic application',async()=>{
      const input={workspace:'synthetic-a',source:'docs/synthetic.md',content:'# First\nSynthetic archival material.\n# Second\nSynthetic operating constraints.\n'};
      const preview=await call('memory_ingest_markdown',input);
      await assert.rejects(call('memory_ingest_markdown',{...input,content:input.content+'change',dry_run:false,plan_hash:preview.plan_hash}),{code:'PLAN'});
      const result=await call('memory_ingest_markdown',{...input,dry_run:false,plan_hash:preview.plan_hash});sourceIds=result.results.map(r=>r.id);
      const duplicate=await call('memory_ingest_markdown',{...input,dry_run:false,plan_hash:preview.plan_hash});assert.ok(duplicate.results.every(r=>r.skipped));
      for(const id of sourceIds) await accept(id);
      const project={workspace:'synthetic-a',files:[{source:'docs/other.md',content:'# Project\nAnother synthetic document.\n'}]};
      const plan=await call('memory_ingest_project',project);
      const output=await call('memory_ingest_project',{...project,dry_run:false,plan_hash:plan.plan_hash});otherId=output.results[0].id;await accept(otherId);
    });
    await t.test('Continuity, typed evidence, ambiguity diagnosis and byte budgets',async()=>{
      const checkpoint=await call('memory_checkpoint',{workspace:'synthetic-a',session:'synthetic-session',title:'Synthetic checkpoint',summary:'Resume only with source verification.',next_steps:['Review source'],references:[itemId]});await accept(checkpoint.item.id);
      assert.equal((await call('memory_resume',{workspace:'synthetic-a',session:'synthetic-session'},reader)).checkpoints[0].reference_diagnostics[0].unchanged,true);
      await assert.rejects(call('memory_record',{workspace:'synthetic-a',kind:'evidence',key:'example.measurement',title:'Measurement',statement:'Synthetic measured value',basis:'measured'}),{code:'RECORD'});
      for(const statement of ['Synthetic value one','Synthetic value two']) {
        const record=await call('memory_record',{workspace:'synthetic-a',kind:'evidence',key:'example.measurement',title:'Synthetic measurement',statement,replace_key:false,basis:'measured',observed_at:'2026-01-01T00:00:00Z',references:[itemId]});await accept(record.item.id);
      }
      const view=await call('memory_project',{workspace:'synthetic-a'},reader);assert.equal(view.ambiguities.length,1);
      const context=await call('memory_context',{workspace:'synthetic-a',query:'synthetic',max_bytes:1024},reader);
      assert.ok(Buffer.byteLength(JSON.stringify(context))<=1024);assert.equal(context.evidence.answer_verified,false);
      const page=await call('memory_list',{workspace:'synthetic-a',limit:1},reader);assert.ok(page.next_cursor);
      const next=await call('memory_list',{workspace:'synthetic-a',limit:1,cursor:page.next_cursor,as_of:page.as_of},reader);assert.notEqual(next.items[0].id,page.items[0].id);
      await assert.rejects(call('memory_list',{workspace:'synthetic-a',limit:1,cursor:page.next_cursor,as_of:page.as_of,status:'proposed'},reader),{code:'CURSOR'});
    });
    await t.test('Lossless consolidation retains immutable sources and invalidates only after review',async()=>{
      const plan=await call('memory_consolidate',{workspace:'synthetic-a',ids:sourceIds});
      const proposed=await call('memory_consolidate',{workspace:'synthetic-a',ids:sourceIds,dry_run:false,plan_hash:plan.plan_hash});
      assert.ok(proposed.item.content.includes('Synthetic archival material.'));assert.equal((await service.store.read('synthetic-a',sourceIds[0])).status,'active');
      await accept(proposed.item.id);
      for(const id of sourceIds) assert.equal((await service.store.read('synthetic-a',id)).status,'invalidated');
      assert.equal(proposed.item.metadata.consolidation.sources.length,2);
    });
    await t.test('Private media roundtrip, lexical search, hash integrity and parent eligibility',async()=>{
      const bytes=Buffer.from('Synthetic cobalt media transcript.');
      const attachment=await call('memory_attach_media',{workspace:'synthetic-a',item_id:itemId,base64:bytes.toString('base64'),mime:'text/plain'});mediaId=attachment.media.id;
      const repeated=await call('memory_attach_media',{workspace:'synthetic-a',item_id:itemId,base64:bytes.toString('base64'),mime:'text/plain'});assert.equal(repeated.media.id,mediaId);assert.equal(repeated.media.deduplicated,true);
      const result=await call('memory_read_media',{workspace:'synthetic-a',id:mediaId},reader);assert.ok(Buffer.from(result.base64,'base64').equals(bytes));
      assert.equal(result.sha256,hash(bytes));assert.equal((await call('memory_search_media',{workspace:'synthetic-a',query:'cobalt transcript'},reader)).results[0].id,mediaId);
      await assert.rejects(call('memory_read_media',{workspace:'synthetic-b',id:mediaId},reader),{code:'FORBIDDEN'});
    });
    await t.test('PDF parser extracts a synthetic text layer without cloud calls',async()=>{
      const stream='BT /F1 12 Tf 72 720 Td (Synthetic PDF copper evidence.) Tj ET';
      const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
      let pdf='%PDF-1.4\n';const offsets=[];
      objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;});
      const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      const attachment=await call('memory_attach_media',{workspace:'synthetic-a',item_id:otherId,base64:Buffer.from(pdf).toString('base64'),mime:'application/pdf'});
      assert.equal(attachment.extraction_status,'pdf_text');
      assert.equal((await call('memory_search_media',{workspace:'synthetic-a',query:'copper evidence'},reader)).results[0].id,attachment.media.id);
    });
    await t.test('Declared graph, fail-closed cross-workspace gate and semantic indexing with mock provider',async()=>{
      await call('memory_link',{workspace:'synthetic-a',target_workspace:'synthetic-a',source_id:itemId,target_id:otherId,relation:'Synthetic relation'},operator);
      assert.ok((await call('memory_search',{workspace:'synthetic-a',query:'cobalt'},reader)).results.some(r=>r.provenance.includes('graph')));
      await call('memory_link',{workspace:'synthetic-a',target_workspace:'synthetic-b',relation:'Synthetic shared technical material'},operator);
      const cross=await call('memory_cross_workspace',{workspace:'synthetic-a',query:'synthetic'},operator);assert.equal(cross.traversal[0].status,'gate_unavailable_closed');
      const mocked=new Service(store,{...c,provider:{...c.provider,enabled:true,dimensions:3,embeddingModel:'synthetic-model'}},{provider:{embed:async()=>[1,0,0],decision:async()=>0.9}});
      await mocked.call('memory_index',{workspace:'synthetic-a',id:itemId},operator);called.add('memory_index');
      const search=await mocked.call('memory_search',{workspace:'synthetic-a',query:'cobalt',rerank:true},reader);
      assert.ok(search.results.some(r=>r.provenance.includes('semantic')));
      assert.equal((await mocked.call('memory_cross_workspace',{workspace:'synthetic-a',query:'synthetic'},operator)).traversal[0].status,'traversed');
    });
    await t.test('Diagnostics, audit and scoped catalog do not reveal credentials',async()=>{
      await call('memory_stats',{workspace:'synthetic-a'},reader);assert.equal((await call('memory_doctor',{workspace:'synthetic-a'},reader)).schema,3);
      assert.ok((await call('memory_mutations',{workspace:'synthetic-a',id:itemId},reader)).mutations.length>0);
      assert.deepEqual((await call('memory_version',{},reader)).workspaces,['synthetic-a']);
      const capabilities=await call('memory_capabilities',{},reader);assert.ok(!capabilities.tools.includes('memory_review'));
      assert.ok(!JSON.stringify(capabilities).includes(c.s3.credentials.secretAccessKey));
    });
    await t.test('Actual SDK HTTP client authenticates, respects policies, rejects Origin and strict args',async()=>{
      const token=randomBytes(32).toString('base64url');c.profiles=[{...reader,sha256:hash(token)}];
      server=createApp(service,c).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
      const base=`http://127.0.0.1:${server.address().port}`;
      assert.equal((await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
      assert.equal((await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.example',Authorization:`Bearer ${token}`},body:'{}'})).status,403);
      assert.equal((await fetch(base+'/health',{headers:{Host:'untrusted.example',Origin:'https://untrusted.example'}})).status,403);
      const client=new Client({name:'synthetic-test',version:'1'});
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
        const catalog=await client.listTools();assert.ok(catalog.tools.some(x=>x.name==='memory_search'));assert.ok(!catalog.tools.some(x=>x.name==='memory_write'));
        const version=await client.callTool({name:'memory_version',arguments:{}});assert.equal(version.structuredContent.name,'jovememory');
        assert.equal((await client.callTool({name:'memory_search',arguments:{workspace:'synthetic-b',query:'synthetic'}})).isError,true);
        assert.equal((await client.callTool({name:'memory_search',arguments:{workspace:'synthetic-a',query:'synthetic',unexpected:'synthetic'}})).isError,true);
      } finally {await client.close();}
    });
    await t.test('Automatic writes activate immediately without a reviewer, including continuity and version replacement',async()=>{
      const automatic=new Service(store,{...c,reviewMode:'automatic'});
      const profile={id:'automatic-writer',role:'writer',workspaces:['synthetic-b']},w='synthetic-b';
      const auto=(name,args)=>automatic.call(name,{workspace:w,...args},profile);
      const capabilities=await automatic.call('memory_capabilities',{},profile);
      assert.equal(capabilities.review,'automatic');assert.equal(capabilities.review_mode,'automatic');
      assert.ok(!capabilities.tools.includes('memory_review'));
      const first=await auto('memory_write',{content:'Automatic nebula memory.'});
      assert.equal(first.outcome,'accepted');assert.equal(first.review_required,false);
      assert.equal(first.item.status,'active');assert.equal(first.item.reviewer,'system:auto');
      assert.equal(first.gate.status,'unavailable');
      assert.equal((await auto('memory_search',{query:'nebula'})).results[0].id,first.item.id);
      const audit=(await auto('memory_mutations',{id:first.item.id})).mutations;
      assert.deepEqual(audit.map(x=>x.operation),['propose','accept']);
      assert.equal(audit[1].actor,'system:auto');assert.equal(audit[1].payload.automatic,true);
      const checkpoint=await auto('memory_checkpoint',{session:'automatic-session',title:'Automatic continuity',summary:'Continue synthetic nebula work.',references:[first.item.id]});
      assert.equal((await auto('memory_resume',{session:'automatic-session'})).checkpoints[0].id,checkpoint.item.id);
      const record=await auto('memory_record',{kind:'decision',key:'automatic.storage',title:'Automatic decision',statement:'Use the synthetic nebula store.',basis:'asserted',references:[first.item.id]});
      assert.equal((await auto('memory_project',{})).records[0].id,record.item.id);
      const before=(await store.stats(w)).counts;
      await assert.rejects(auto('memory_record',{kind:'evidence',key:'invalid.measurement',title:'Invalid',statement:'Synthetic measurement',basis:'measured'}),{code:'RECORD'});
      assert.deepEqual((await store.stats(w)).counts,before);
      const concurrent=await Promise.allSettled([
        auto('memory_update_item',{id:first.item.id,content:'Updated automatic nebula one.',reason:'Synthetic change'}),
        auto('memory_update_item',{id:first.item.id,content:'Updated automatic nebula two.',reason:'Synthetic concurrent change'})]);
      assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);
      const replacement=concurrent.find(x=>x.status==='fulfilled').value.item;
      assert.equal(replacement.status,'active');assert.equal((await store.read(w,first.item.id)).status,'invalidated');
      assert.equal((await auto('memory_list_proposed',{})).items.some(x=>x.supersedes===first.item.id),false);
      for(const [tool,input] of [
        ['memory_ingest_markdown',{source:'docs/automatic.md',content:'# One\nAutomatic pulsar material.\n# Two\nAutomatic pulsar constraints.'}],
        ['memory_ingest_project',{files:[{source:'docs/automatic-project.md',content:'# Three\nAutomatic pulsar project.'}]}]]) {
        const plan=await auto(tool,input);assert.equal(plan.review_required,false);
        const applied=await auto(tool,{...input,dry_run:false,plan_hash:plan.plan_hash});
        assert.ok(applied.results.every(x=>x.status==='active'));
        assert.ok((await auto(tool,{...input,dry_run:false,plan_hash:plan.plan_hash})).results.every(x=>x.skipped));
      }
      const extra=await auto('memory_propose_write',{content:'Automatic quasar second source.'});
      assert.equal(extra.item.status,'active');
      const plan=await auto('memory_consolidate',{ids:[replacement.id,extra.item.id]});
      assert.equal(plan.review_required,false);
      const merged=await auto('memory_consolidate',{ids:[replacement.id,extra.item.id],dry_run:false,plan_hash:plan.plan_hash});
      assert.equal(merged.item.status,'active');assert.ok(merged.item.content.includes(extra.item.content));
      assert.equal((await store.read(w,replacement.id)).status,'invalidated');assert.equal((await store.read(w,extra.item.id)).status,'invalidated');
      const expires=await auto('memory_write',{content:'Automatic expired comet fact.',valid_until:'2000-01-01T00:00:00Z'});
      assert.equal(expires.item.status,'active');assert.equal((await auto('memory_search',{query:'comet'})).results.length,0);
      const expiredCounts=(await store.stats(w)).counts;
      await assert.rejects(auto('memory_update_item',{id:expires.item.id,content:'Invalid automatic successor.',reason:'Expired predecessor'}),{code:'CONFLICT'});
      assert.deepEqual((await store.stats(w)).counts,expiredCounts);
      assert.equal((await store.read(w,expires.item.id)).status,'active');
      await assert.rejects(automatic.call('memory_write',{workspace:'synthetic-a',content:'Outside scope'},profile),{code:'FORBIDDEN'});
      await assert.rejects(automatic.call('memory_write',{workspace:w,content:'Reader denied'},reader),{code:'FORBIDDEN'});
      await assert.rejects(auto('memory_review',{id:merged.item.id,action:'accept',reason:'Do not grant review'}),{code:'FORBIDDEN'});
      for(const score of [0.1,0.9]) {
        const gated=new Service(store,{...c,reviewMode:'automatic'},{provider:{decision:async()=>score}});
        const result=await gated.call('memory_write',{workspace:w,content:'Synthetic advisory gate '+score},profile);
        assert.equal(result.item.status,'active');assert.equal(result.gate.score,score);
      }
      // Any failure in the batch rolls back both insertion and automatic activation.
      const count=(await store.stats(w)).counts;
      const mutationsBefore=await store.mutations(w,{limit:100});
      await assert.rejects(store.ingestion(w,{plan_hash:'synthetic',sections:[
        {id:randomUUID(),source:'rollback',content:'Automatic rollback example.'},
        {id:randomUUID(),source:'rollback',content:null}]},profile.id,true));
      assert.deepEqual((await store.stats(w)).counts,count);
      assert.deepEqual(await store.mutations(w,{limit:100}),mutationsBefore);
    });
    await t.test('Actual SDK HTTP writer activates memory and makes it immediately searchable',async()=>{
      const token=randomBytes(32).toString('base64url'),profile={id:'automatic-http',role:'writer',workspaces:['synthetic-b'],sha256:hash(token)};
      const autoConfig={...c,reviewMode:'automatic',profiles:[profile]};
      const autoServer=createApp(new Service(store,autoConfig),autoConfig).listen(0,'127.0.0.1');
      await new Promise(resolve=>autoServer.once('listening',resolve));
      const client=new Client({name:'synthetic-auto-http',version:'1'});
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${autoServer.address().port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
        const written=await client.callTool({name:'memory_write',arguments:{workspace:'synthetic-b',content:'Automatic HTTP magnetar continuity.'}});
        assert.equal(written.structuredContent.item.status,'active');assert.equal(written.structuredContent.review_required,false);
        const search=await client.callTool({name:'memory_search',arguments:{workspace:'synthetic-b',query:'magnetar'}});
        assert.equal(search.structuredContent.results[0].id,written.structuredContent.item.id);
      } finally {await client.close();autoServer.closeAllConnections();await new Promise(resolve=>autoServer.close(resolve));}
    });
    await t.test('Actual SDK stdio client negotiates and receives only MCP frames',async()=>{
      const token=randomBytes(32).toString('base64url');
      const client=new Client({name:'synthetic-stdio',version:'1'});
      const transport=new StdioClientTransport({command:process.execPath,args:['src/stdio.mjs'],env:{...process.env,DATABASE_URL:appUrl,
        AUTH_PROFILES:JSON.stringify([{...reader,sha256:hash(token)}]),STDIO_PROFILE:reader.id,ENABLE_PROVIDER:'false'},stderr:'pipe'});
      try {await client.connect(transport);const result=await client.callTool({name:'memory_version',arguments:{}});assert.equal(result.structuredContent.name,'jovememory');}
      finally {await client.close();}
    });
    await t.test('Specialized model flows index active writes, preserve history and degrade safely',async()=>{
      const calls=[],w='synthetic-b',profile={id:'model-writer',role:'writer',workspaces:[w]};
      const provider={
        embed:async text=>{calls.push(['embedding',text]);return [1,0,0];},
        decision:async()=>{calls.push(['decision']);return 0.8;},
        extract:async()=>{calls.push(['knowledge']);return {model:'synthetic-knowledge',summary:'Auxiliary analysis',keywords:[],entities:[]};},
        rerank:async(query,items)=>{calls.push(['rerank']);return {model:'synthetic-rerank',scores:new Map(items.map(x=>[x.id,0.9]))};},
        synthesize:async(query,items)=>{calls.push(['synthesis']);return {model:'synthetic-synthesis',summary:'Auxiliary context',cited_ids:items.map(x=>x.id)};},
        consolidate:async sources=>{calls.push(['consolidation']);return {model:'synthetic-knowledge',summary:'Auxiliary consolidation',source_ids:sources.map(x=>x.id)};}
      };
      const enabled={...c,reviewMode:'automatic',provider:{...c.provider,enabled:true,dimensions:3,embeddingModel:'synthetic-model'}};
      const service=new Service(store,enabled,{provider});const auto=(name,args)=>service.call(name,{workspace:w,...args},profile);
      const first=await auto('memory_write',{content:'Synthetic modelflow cobalt observatory.',enrich:true});
      assert.equal(first.indexing[0].status,'indexed');assert.equal(first.gate.probability_calibrated,false);
      assert.equal(first.item.metadata.model_analysis.model,'synthetic-knowledge');
      const search=await auto('memory_search',{query:'modelflow'});
      assert.ok(search.results.some(x=>x.id===first.item.id&&x.provenance.includes('semantic')));
      assert.ok(search.results.every(x=>x.rerank_model==='synthetic-rerank'));
      const before=calls.length;await auto('memory_search',{query:'modelflow',rerank:false});assert.ok(!calls.slice(before).some(x=>x[0]==='rerank'));
      const inferenceCount=calls.filter(x=>x[0]==='synthesis').length;
      const evidenceOnly=await auto('memory_context',{query:'modelflow',max_bytes:262144});
      assert.equal(evidenceOnly.synthesis,null);assert.equal(calls.filter(x=>x[0]==='synthesis').length,inferenceCount);
      const context=await auto('memory_context',{query:'modelflow',max_bytes:262144,synthesize:true});assert.equal(context.synthesis.model,'synthetic-synthesis');
      provider.synthesize=async(query,items)=>({model:'synthetic-synthesis',summary:'Synthetic context '.repeat(200),cited_ids:items.map(x=>x.id)});
      const small=await auto('memory_context',{query:'modelflow',max_bytes:1024,synthesize:true});assert.ok(Buffer.byteLength(JSON.stringify(small))<=1024);
      assert.ok(!small.synthesis || small.synthesis.cited_ids.every(id=>small.results.some(x=>x.id===id)));
      const fullContent='Synthetic compactprobe evidência íntegra 🛰️. '.repeat(1000);
      const large=await auto('memory_propose_write',{content:fullContent});
      provider.synthesize=async(query,items)=>({model:'synthetic-synthesis',summary:'Compact synthetic evidence for the caller.',cited_ids:items.map(x=>x.id)});
      const compact=await auto('memory_context',{query:'compactprobe',limit:1,max_bytes:4096,synthesize:true});
      assert.equal(compact.results[0].id,large.item.id);assert.ok(compact.synthesis);
      assert.equal(compact.results[0].content_truncated,true);assert.equal(compact.results[0].content_bytes,Buffer.byteLength(fullContent));
      assert.equal(compact.results[0].content_hash,hash(fullContent));assert.ok(fullContent.startsWith(compact.results[0].content));
      assert.ok(Buffer.byteLength(JSON.stringify(compact))<=4096);assert.ok(compact.bytes_used<Buffer.byteLength(fullContent));
      assert.equal((await auto('memory_read',{id:large.item.id})).item.content,fullContent);
      const freeService=new Service(store,{...enabled,provider:{...enabled.provider,synthesisModel:'openrouter/free'}},{provider});
      provider.synthesize=async(query,items)=>({model:'synthetic/large:free',summary:'Synthetic free evidence',cited_ids:items.map(x=>x.id),routing:{requested_model:'openrouter/free',effective_model:'synthetic/large:free',tier:'free',paid_fallback:false}});
      const freeContext=await freeService.call('memory_context',{workspace:w,query:'compactprobe',limit:1,max_bytes:4096,synthesize:true},profile);
      assert.equal(freeContext.synthesis.model,'synthetic/large:free');assert.ok(!freeContext.degraded.includes('synthesis_fallback'));
      provider.synthesize=async(query,items)=>({model:'synthetic/paid',summary:'Synthetic paid evidence',cited_ids:items.map(x=>x.id),routing:{requested_model:'openrouter/free',effective_model:'synthetic/paid',tier:'paid_fallback',paid_fallback:true}});
      const paidContext=await freeService.call('memory_context',{workspace:w,query:'compactprobe',limit:1,max_bytes:4096,synthesize:true},profile);
      assert.ok(paidContext.degraded.includes('synthesis_fallback'));assert.equal(paidContext.synthesis.routing.paid_fallback,true);
      const replacement=await auto('memory_update_item',{id:first.item.id,content:'Updated synthetic modelflow observatory.',reason:'Synthetic revision'});
      assert.equal(replacement.indexing[0].status,'indexed');assert.equal((await store.read(w,first.item.id)).status,'invalidated');
      assert.equal(replacement.enrichment.status,'skipped');assert.equal(replacement.item.metadata.model_analysis,undefined);assert.equal(replacement.gate.score,0.8);
      const checkpoint=await auto('memory_checkpoint',{session:'model-test',title:'Synthetic',summary:'Synthetic checkpoint modelflow.'});assert.equal(checkpoint.indexing[0].status,'indexed');
      const record=await auto('memory_record',{kind:'decision',key:'model-test',title:'Synthetic',statement:'Synthetic record modelflow.',basis:'asserted'});assert.equal(record.indexing[0].status,'indexed');
      const input={source:'docs/models.md',content:'# Models\nSynthetic ingestion modelflow.'};const plan=await auto('memory_ingest_markdown',input);
      const ingest=await auto('memory_ingest_markdown',{...input,dry_run:false,plan_hash:plan.plan_hash});assert.equal(ingest.indexing[0].status,'indexed');
      const n=calls.length;await auto('memory_ingest_markdown',{...input,dry_run:false,plan_hash:plan.plan_hash});assert.equal(calls.length,n);
      const proposal=await auto('memory_propose_write',{content:'Synthetic second source modelflow.'});assert.equal(proposal.indexing[0].status,'indexed');
      const mergePlan=await auto('memory_consolidate',{ids:[replacement.item.id,proposal.item.id]});
      const merge=await auto('memory_consolidate',{ids:[replacement.item.id,proposal.item.id],dry_run:false,plan_hash:mergePlan.plan_hash,summarize:true});
      assert.equal(merge.indexing[0].status,'indexed');assert.equal(merge.model_summary.model,'synthetic-knowledge');assert.ok(merge.item.content.includes(proposal.item.content));
      const summaryCalls=calls.filter(x=>x[0]==='consolidation').length;
      const defaultPlan=await auto('memory_consolidate',{ids:[merge.item.id,large.item.id]});
      const defaultMerge=await auto('memory_consolidate',{ids:[merge.item.id,large.item.id],dry_run:false,plan_hash:defaultPlan.plan_hash});
      assert.equal(defaultMerge.model_summary,null);assert.equal(calls.filter(x=>x[0]==='consolidation').length,summaryCalls);
      assert.ok(defaultMerge.item.content.includes(fullContent));
      const manual=new Service(store,{...enabled,reviewMode:'manual'},{provider});const oldCalls=calls.length;
      const pending=await manual.call('memory_propose_write',{workspace:w,content:'Synthetic pending modelflow.'},profile);assert.equal(calls.length,oldCalls);
      const accepted=await manual.call('memory_review',{workspace:w,id:pending.item.id,action:'accept',reason:'Synthetic independent review'},{id:'model-reviewer',role:'reviewer',workspaces:[w]});assert.equal(accepted.indexing[0].status,'indexed');
      const unavailable=new Service(store,enabled,{provider:{...provider,embed:async()=>{throw new Error('synthetic');}}});
      const modelCallsBefore=calls.filter(x=>x[0]==='knowledge').length;
      const saved=await unavailable.call('memory_write',{workspace:w,content:'Synthetic outage modelflow.'},profile);
      assert.equal(calls.filter(x=>x[0]==='knowledge').length,modelCallsBefore);assert.equal(saved.enrichment.status,'skipped');
      assert.equal(saved.item.status,'active');assert.deepEqual(saved.degraded,['semantic_index_unavailable']);assert.equal(saved.indexing[0].status,'unavailable');
      const expired=await auto('memory_propose_write',{content:'Synthetic expired modelflow.',valid_until:'2000-01-01T00:00:00Z'});assert.equal(expired.indexing[0].status,'ineligible');
      const audit=await store.mutations(w,{id:replacement.item.id,limit:20});assert.ok(audit.some(x=>x.operation==='embed'&&x.actor===profile.id));
      assert.ok(['embedding','decision','knowledge','rerank','synthesis'].every(role=>calls.some(x=>x[0]===role)));
    });
    await t.test('Automatic enrollment binds repository identity, prevents collisions and supports immediate credential revocation',async()=>{
      const controller={id:'synthetic-controller',role:'provisioner',workspaces:['*']};
      const input={repository_id:hash('synthetic-owned-repository'),repository_name:'Synthetic.App'};
      await assert.rejects(call('memory_open_project',input,writer),{code:'FORBIDDEN'});
      const enrolled=await call('memory_open_project',input,controller);
      const repeated=await call('memory_open_project',input,controller);assert.equal(enrolled.workspace,repeated.workspace);
      const scoped=await authenticateProject('Bearer '+enrolled.token,c,store);assert.deepEqual(scoped.workspaces,['Synthetic.App']);
      await assert.rejects(call('memory_open_project',{...input,repository_id:hash('another-owner')},controller),{code:'PROJECT_COLLISION'});
      await assert.rejects(call('memory_stats',{workspace:'synthetic-a'},scoped),{code:'FORBIDDEN'});
      await assert.rejects(call('memory_version',{},controller),{code:'FORBIDDEN'});
      assert.equal((await store.mutations('Synthetic.App',{limit:100})).filter(x=>x.operation==='project_enroll').length,1);
      await call('memory_revoke_project',{workspace:'Synthetic.App',reason:'Synthetic credential revocation'},{...operator,workspaces:['*']});
      assert.equal(await authenticateProject('Bearer '+enrolled.token,c,store),null);
    });
    await t.test('Source changes are observed without content, revalidation checks hashes, and retirement preserves audit',async()=>{
      const automatic=new Service(store,{...c,reviewMode:'automatic'}),w='synthetic-a';
      const auto=(name,args,profile=writer)=>{called.add(name);return automatic.call(name,{workspace:w,...args},profile);};
      const firstHash=hash('source one'),nextHash=hash('source two'),locator='docs/lifecycle.md';
      const observe=sha256=>auto('memory_sync_sources',{sources:[{locator,sha256,present:true}],revision:'a'.repeat(40)});
      await observe(firstHash);
      const item=(await auto('memory_write',{content:'Synthetic lifecycle orchid architecture.',source_refs:[{locator,sha256:firstHash}]})).item;
      assert.equal((await auto('memory_read',{id:item.id})).item.lifecycle.status,'matches_observation');
      await observe(nextHash);
      const maintenance=await auto('memory_maintenance',{limit:100});assert.equal(maintenance.items.find(x=>x.id===item.id).lifecycle.status,'needs_revalidation');
      const context=await auto('memory_context',{query:'orchid',max_bytes:16384});assert.equal(context.results[0].lifecycle.status,'needs_revalidation');
      await assert.rejects(auto('memory_revalidate',{id:item.id,content_hash:item.content_hash,source_refs:[{locator,sha256:firstHash}],reason:'Stale observation'}),{code:'SOURCE_CHANGED'});
      const fresh=await auto('memory_revalidate',{id:item.id,content_hash:item.content_hash,source_refs:[{locator,sha256:nextHash}],reason:'Read current synthetic source; fact still applies'});assert.equal(fresh.truth_verified,false);
      assert.equal((await auto('memory_read',{id:item.id})).item.lifecycle.status,'matches_observation');
      await assert.rejects(auto('memory_revalidate',{id:item.id,content_hash:hash('wrong memory'),source_refs:[{locator,sha256:nextHash}],reason:'Concurrent stale item'}),{code:'CONFLICT'});
      await auto('memory_sync_sources',{sources:[],complete:true});
      assert.equal((await auto('memory_read',{id:item.id})).item.lifecycle.source_diagnostics[0].status,'missing');
      await observe(firstHash);
      const replacement=await auto('memory_update_item',{id:item.id,content:'Revised synthetic orchid implementation.',reason:'Source reverted and architecture changed',source_refs:[{locator,sha256:firstHash}]});
      assert.equal(replacement.item.status,'active');assert.equal((await store.read(w,item.id)).status,'invalidated');
      await auto('memory_retire',{id:replacement.item.id,reason:'Implementation explicitly removed'});
      assert.equal((await auto('memory_search',{query:'orchid'})).results.length,0);
      assert.ok((await store.mutations(w,{id:replacement.item.id,limit:100})).some(x=>x.operation==='retire'));
      const feed=await auto('memory_changes',{limit:100});assert.ok(feed.changes.some(x=>x.operation==='sources_change'));assert.ok(feed.changes.every(x=>!('item' in x.details) && !('content' in x.details)));
      const sources=await auto('memory_sources',{limit:100});assert.ok(sources.sources.some(x=>x.locator===locator));
      const guide=await auto('memory_agent_guide',{});assert.equal(guide.boundaries.cross_project_content_implicit,false);
      const expired=(await auto('memory_write',{content:'Expired orchid experiment.',valid_until:'2000-01-01T00:00:00Z'})).item;
      assert.equal((await auto('memory_maintenance',{limit:100})).items.find(x=>x.id===expired.id).lifecycle.status,'expired');
      const owner=new pg.Client({connectionString:appUrl});await owner.connect();
      try{await owner.query('BEGIN');await owner.query("SELECT set_config('app.workspace','synthetic-b',true)");for(const table of ['sources','projects','telemetry'])assert.ok((await owner.query('SELECT workspace FROM '+table)).rows.every(x=>x.workspace==='synthetic-b'));await owner.query('COMMIT');}finally{await owner.end();}
      await assert.rejects(auto('memory_overview',{}),{code:'INPUT'});
      const observer={id:'synthetic-observer',role:'observer',workspaces:['*']};
      assert.deepEqual(service.available(observer).map(x=>x.name),['memory_overview']);
      await assert.rejects(call('memory_read',{workspace:w,id:item.id},observer),{code:'FORBIDDEN'});
      const global=await call('memory_overview',{limit:100},observer);assert.equal(global.memory_content_included,false);assert.ok(global.projects.some(x=>x.workspace===w && x.usage.calls>0 && x.lifecycle.expired>0));
      assert.ok(!JSON.stringify(global).includes('Synthetic lifecycle orchid architecture.'));
      await assert.rejects(call('memory_overview',{},reader),{code:'FORBIDDEN'});
    });
    await t.test('Keyed records replace current state atomically, preserve explicit ambiguity and recover expired keys',async()=>{
      const automatic=new Service(store,{...c,reviewMode:'automatic'}),w='synthetic-a';
      const record=statement=>automatic.call('memory_record',{workspace:w,kind:'decision',key:'synthetic.lifecycle-key',title:'Current decision',statement,basis:'asserted'},writer);
      const first=await record('Synthetic original system.'),same=await record('Synthetic original system.');assert.equal(first.item.id,same.item.id);
      const second=await record('Synthetic revised system.');assert.equal(second.item.supersedes,first.item.id);assert.equal((await store.read(w,first.item.id)).status,'invalidated');
      const expired=await automatic.call('memory_record',{workspace:w,kind:'issue',key:'synthetic.expired-key',title:'Old issue',statement:'Expired issue',basis:'asserted',expires_at:'2000-01-01T00:00:00Z'},writer);
      const fresh=await automatic.call('memory_record',{workspace:w,kind:'issue',key:'synthetic.expired-key',title:'New issue',statement:'Current issue',basis:'asserted'},writer);assert.equal(fresh.item.status,'active');assert.equal((await store.read(w,expired.item.id)).status,'invalidated');
      await automatic.call('memory_record',{workspace:w,kind:'decision',key:'synthetic.lifecycle-key',title:'Explicit alternative',statement:'A divergent assertion.',basis:'asserted',replace_key:false},writer);
      await assert.rejects(record('Do not silently discard divergent assertions.'),{code:'AMBIGUITY'});
    });
    await t.test('Real Git broker enrolls automatically, sends hashes only, injects scope and withholds controller tools',async()=>{
      const folder=await mkdtemp(tmpdir()+'/jovememory-broker-'),root=folder+'/repo';await mkdir(root);
      const git=args=>execFileSync('git',['-C',root,...args],{stdio:['ignore','pipe','ignore']});
      git(['init']);git(['remote','add','origin','https://github.com/example/synthetic-bridge.git']);
      await writeFile(root+'/README.md','Synthetic broker source.');await writeFile(root+'/.env','Synthetic private source.');git(['add','README.md','.env']);
      await symlink('/etc/hostname',root+'/outside');git(['add','outside']);
      const token=randomBytes(32).toString('base64url'),controller={id:'synthetic-controller',role:'provisioner',workspaces:['*'],sha256:hash(token)};
      const config={...c,reviewMode:'automatic',profiles:[controller]};const http=createApp(new Service(store,config),config).listen(0,'127.0.0.1');await new Promise(resolve=>http.once('listening',resolve));
      const endpoint=`http://127.0.0.1:${http.address().port}/mcp`;await writeFile(folder+'/controller.token',token,{mode:0o600});await writeFile(folder+'/broker.json',JSON.stringify({endpoint,provisioner_token_file:folder+'/controller.token'}),{mode:0o600});
      const client=new Client({name:'synthetic-bound-agent',version:'1'});
      try {
        const transport=new StdioClientTransport({command:process.execPath,args:[process.cwd()+'/src/project-bridge.mjs'],cwd:root,env:{...process.env,JOVEMEMORY_BROKER_CONFIG:folder+'/broker.json'},stderr:'pipe'});await client.connect(transport);
        const catalog=await client.listTools();assert.ok(catalog.tools.some(x=>x.name==='memory_write'));assert.ok(!catalog.tools.some(x=>['memory_open_project','memory_overview','memory_cross_workspace'].includes(x.name)));assert.ok(!catalog.tools.find(x=>x.name==='memory_write').inputSchema.properties.workspace);
        const status=(await client.callTool({name:'memory_connection_status',arguments:{}})).structuredContent;assert.equal(status.workspace,'synthetic-bridge');assert.equal(status.bound,true);
        const source=(await client.callTool({name:'memory_sources',arguments:{limit:100}})).structuredContent;assert.deepEqual(source.sources.map(x=>x.locator),['README.md']);
        const written=await client.callTool({name:'memory_write',arguments:{content:'Synthetic broker orchid knowledge.',source_refs:[{locator:'README.md',sha256:hash('Synthetic broker source.')}]}});assert.equal(written.structuredContent.workspace,'synthetic-bridge');
        const denied=await client.callTool({name:'memory_read',arguments:{workspace:'synthetic-a',id:written.structuredContent.item.id}});assert.equal(denied.isError,true);
        await writeFile(root+'/README.md','Updated synthetic broker source.');
        const updated=await client.callTool({name:'memory_read',arguments:{id:written.structuredContent.item.id}});assert.equal(updated.structuredContent.item.lifecycle.status,'needs_revalidation');
        assert.equal((await client.callTool({name:'memory_overview',arguments:{}})).isError,true);
      }finally {await client.close();http.closeAllConnections();await new Promise(resolve=>http.close(resolve));await rm(folder,{recursive:true,force:true});}
    });
    await t.test('Full snapshot backup includes media; scratch restore compares exact table fingerprints',async()=>{
      backupDir=await mkdtemp(tmpdir()+'/jovememory-backup-');
      await assert.rejects(externalDirectory(process.cwd()),{code:'BACKUP'});
      const result=await createBackup(adminUrl,c.s3,backupDir);assert.equal(result.objects,2);
      await admin.query(`CREATE DATABASE ${restoreName}`);restoreCreated=true;
      const restored=await verifyRestore(backupDir,database(process.env.MIGRATION_DATABASE_URL,restoreName));assert.equal(restored.database_fingerprints,'matched');
      await assert.rejects(verifyRestore(backupDir,database(process.env.MIGRATION_DATABASE_URL,restoreName)),{code:'RESTORE'});
      const manifest=JSON.parse(await readFile(backupDir+'/manifest.json','utf8'));
      await writeFile(backupDir+'/'+manifest.objects[0].file,'tampered');
      await assert.rejects(verifyRestore(backupDir,database(process.env.MIGRATION_DATABASE_URL,restoreName)),{code:'INTEGRITY'});
    });
    await t.test('Soft deletion removes parent media from retrieval without erasing history',async()=>{
      await call('memory_delete',{workspace:'synthetic-a',id:itemId,reason:'Synthetic deletion'},reviewer);
      assert.equal((await call('memory_read',{workspace:'synthetic-a',id:itemId},reader)).item.status,'deleted');
      assert.equal((await call('memory_search_media',{workspace:'synthetic-a',query:'cobalt transcript'},reader)).results.length,0);
      await assert.rejects(call('memory_read_media',{workspace:'synthetic-a',id:mediaId},reader),{code:'MEDIA'});
    });
    assert.equal(called.size,43,`Missing tools: ${Object.keys((await import('../src/schemas.mjs')).TOOLS).filter(x=>!called.has(x))}`);
  } finally {
    if(server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await store?.close();
    if(bucketCreated) {
      const objects=await s3.send(new ListObjectsV2Command({Bucket:c.s3.bucket}));
      if(objects.Contents?.length) await s3.send(new DeleteObjectsCommand({Bucket:c.s3.bucket,Delete:{Objects:objects.Contents.map(x=>({Key:x.Key}))}}));
      await s3.send(new DeleteBucketCommand({Bucket:c.s3.bucket}));
    }
    if(backupDir) await rm(backupDir,{recursive:true,force:true});
    if(restoreCreated) await admin.query(`DROP DATABASE ${restoreName}`);
    await admin.query(`DROP DATABASE ${dbName}`);await admin.end();
  }
});
