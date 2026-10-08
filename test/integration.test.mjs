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
    await t.test('Replacement inherits the validity window and declared nodes are validated before writing',async()=>{
      const bounded=(await call('memory_propose_write',{workspace:'synthetic-a',content:'Synthetic lease zinnia expires next year.',valid_from:'2026-01-01T00:00:00Z',valid_until:'2099-01-01T00:00:00Z'})).item;
      await accept(bounded.id);
      assert.equal(new Date(bounded.valid_until).toISOString(),'2099-01-01T00:00:00.000Z');
      // Omitting the window must inherit it, not silently make a time-limited fact permanent.
      const successor=await call('memory_update_item',{workspace:'synthetic-a',id:bounded.id,content:'Revised synthetic lease zinnia.',reason:'Clarify the same window'});
      assert.equal(new Date(successor.item.valid_from).toISOString(),'2026-01-01T00:00:00.000Z');
      assert.equal(new Date(successor.item.valid_until).toISOString(),'2099-01-01T00:00:00.000Z');
      await accept(successor.item.id);
      // An explicit window replaces the inherited one.
      const extended=await call('memory_update_item',{workspace:'synthetic-a',id:successor.item.id,content:'Synthetic lease zinnia extended.',valid_until:'2098-01-01T00:00:00Z',reason:'Explicit new window'});
      assert.equal(new Date(extended.item.valid_until).toISOString(),'2098-01-01T00:00:00.000Z');
      assert.equal(new Date(extended.item.valid_from).toISOString(),'2026-01-01T00:00:00.000Z');
      await accept(extended.item.id);
      await assert.rejects(call('memory_move_item',{workspace:'synthetic-a',id:extended.item.id,node:'docs/does-not-exist',reason:'Missing node'}),{code:'NODE'});
      await assert.rejects(call('memory_propose_write',{workspace:'synthetic-a',content:'Synthetic orphan item.',node:'docs/absent-node'}),{code:'NODE'});
      await assert.rejects(call('memory_create_node',{workspace:'synthetic-a',node:'docs/parent',label:'Parent',parent:'docs/absent'}),{code:'NODE'});
      await call('memory_create_node',{workspace:'synthetic-a',node:'docs/parent',label:'Parent'});
      const moved=await call('memory_move_item',{workspace:'synthetic-a',id:extended.item.id,node:'docs/parent',reason:'Organised synthetic lease'});
      assert.equal(moved.operation,'move');assert.equal((await call('memory_read',{workspace:'synthetic-a',id:extended.item.id},reader)).item.node,'docs/parent');
      // A second pending replacement of the same predecessor is a conflict, not an opaque infrastructure error.
      const first=await call('memory_update_item',{workspace:'synthetic-a',id:extended.item.id,content:'Synthetic lease revision one.',reason:'First pending revision'});
      await assert.rejects(call('memory_update_item',{workspace:'synthetic-a',id:extended.item.id,content:'Synthetic lease revision two.',reason:'Competing pending revision'}),{code:'CONFLICT'});
      await call('memory_review',{workspace:'synthetic-a',id:first.item.id,action:'reject',reason:'Superseded synthetic revision'},reviewer);
    });
    await t.test('Ingestion persists the previewed section heading and audit reads exclude item content',async()=>{
      const input={workspace:'synthetic-a',source:'docs/zinnia-heading.md',content:'# Retained heading\nSynthetic zinnia heading material.\n'};
      const preview=await call('memory_ingest_markdown',input);
      assert.equal(preview.sections[0].heading,'Retained heading');
      const applied=await call('memory_ingest_markdown',{...input,dry_run:false,plan_hash:preview.plan_hash});
      await accept(applied.results[0].id);
      const stored=await call('memory_read',{workspace:'synthetic-a',id:applied.results[0].id},reader);
      assert.equal(stored.item.metadata.heading,'Retained heading');assert.equal(stored.item.metadata.source,'docs/zinnia-heading.md');
      const long='Synthetic audit body '.repeat(400);
      const written=await call('memory_propose_write',{workspace:'synthetic-a',content:long});await accept(written.item.id);
      const mutations=await call('memory_mutations',{workspace:'synthetic-a',id:written.item.id,limit:10},reader);
      assert.equal(mutations.mutations[0].operation,'propose');
      assert.ok(!JSON.stringify(mutations).includes('Synthetic audit body'));
      assert.ok(!('item' in mutations.mutations[0].payload));
      // Untracked memories declare unknown source freshness instead of claiming verification.
      assert.equal(stored.item.lifecycle.status,'untracked');
      assert.equal(stored.item.lifecycle.source_diagnostics.length,0);
    });
    await t.test('Lossless consolidation retains immutable sources and invalidates only after review',async()=>{      const plan=await call('memory_consolidate',{workspace:'synthetic-a',ids:sourceIds});
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
    await t.test('PDF parser extracts a synthetic text layer without cloud calls',async()=>{      const stream='BT /F1 12 Tf 72 720 Td (Synthetic PDF copper evidence.) Tj ET';
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
    await t.test('One broker serves project memory and the observatory without exposing the observer token',async()=>{
      const folder=await mkdtemp(tmpdir()+'/jovememory-obs-'),root=folder+'/repo';await mkdir(root);
      const git=args=>execFileSync('git',['-C',root,...args],{stdio:['ignore','pipe','ignore']});
      git(['init']);git(['remote','add','origin','https://github.com/example/synthetic-observer.git']);
      await writeFile(root+'/README.md','Synthetic observatory source.');git(['add','README.md']);
      const controllerToken=randomBytes(32).toString('base64url'),observerToken=randomBytes(32).toString('base64url'),adminToken=randomBytes(32).toString('base64url');
      const controller={id:'synthetic-obs-controller',role:'provisioner',workspaces:['*'],sha256:hash(controllerToken)};
      const observerProfile={id:'synthetic-obs-observer',role:'observer',workspaces:['*'],sha256:hash(observerToken)};
      const adminProfile={id:'synthetic-obs-admin',role:'admin',workspaces:['*'],sha256:hash(adminToken)};
      const config={...c,reviewMode:'automatic',profiles:[controller,observerProfile,adminProfile]};
      const http=createApp(new Service(store,config),config).listen(0,'127.0.0.1');await new Promise(resolve=>http.once('listening',resolve));
      const endpoint=`http://127.0.0.1:${http.address().port}/mcp`;
      await writeFile(folder+'/controller.token',controllerToken,{mode:0o600});
      await writeFile(folder+'/observer.token',observerToken,{mode:0o600});
      await writeFile(folder+'/broker.json',JSON.stringify({endpoint,provisioner_token_file:folder+'/controller.token',observer:{token_file:folder+'/observer.token'}}),{mode:0o600});
      const client=new Client({name:'synthetic-obs-agent',version:'1'});
      try {
        const transport=new StdioClientTransport({command:process.execPath,args:[process.cwd()+'/src/project-bridge.mjs'],cwd:root,env:{...process.env,JOVEMEMORY_BROKER_CONFIG:folder+'/broker.json'},stderr:'pipe'});
        await client.connect(transport);
        const catalog=await client.listTools();
        const names=catalog.tools.map(x=>x.name);
        // A single memory namespace: the observatory is served here, not as another server.
        assert.ok(names.includes('memory_write'),'Project memory is missing.');
        assert.ok(names.includes('memory_overview'),'Observatory is missing from the unified broker.');
        assert.ok(names.includes('memory_connection_status'));
        assert.ok(!names.some(x=>x.startsWith('memory_open_project')),'Enrollment stays hidden.');
        assert.ok(!names.some(x=>x.startsWith('memory_revoke_project')));
        // The agent still cannot name a workspace on any tool.
        for(const tool of catalog.tools.filter(x=>x.name!=='memory_connection_status'))
          assert.equal(tool.inputSchema.properties?.workspace,undefined,`${tool.name} still accepts workspace`);
        const status=(await client.callTool({name:'memory_connection_status',arguments:{}})).structuredContent;
        assert.equal(status.bound,true);
        assert.equal(status.observatory.configured,true);
        assert.deepEqual(status.observatory.tools,['memory_overview']);
        assert.equal(status.observatory.connected,true);
        const written=await client.callTool({name:'memory_write',arguments:{content:'Synthetic unified orchid note.'}});
        assert.equal(written.structuredContent.workspace,'synthetic-observer');
        const overview=(await client.callTool({name:'memory_overview',arguments:{limit:100}})).structuredContent;
        assert.equal(overview.memory_content_included,false);
        assert.ok(overview.projects.some(x=>x.workspace==='synthetic-observer'));
        // Aggregates only: the observer path must not leak corpus. The write result legitimately
        // holds the note the agent just wrote, so it is excluded from the content check but not
        // from the credential check.
        const observerSurfaces=[JSON.stringify(overview),JSON.stringify(status),JSON.stringify(names)];
        assert.ok(!observerSurfaces.some(s=>s.includes('Synthetic unified orchid note.')),'Observatory leaked memory content.');
        for(const token of [observerToken,controllerToken])
          assert.ok(![...observerSurfaces,JSON.stringify(written)].some(s=>s.includes(token)),'A credential leaked into a broker surface.');
        // A denied workspace on the project path stays denied.
        const denied=await client.callTool({name:'memory_read',arguments:{workspace:'synthetic-a',id:written.structuredContent.item.id}});
        assert.equal(denied.isError,true);
      } finally {await client.close();http.closeAllConnections();await new Promise(resolve=>http.close(resolve));await rm(folder,{recursive:true,force:true});}
      // Without an observer block the broker still starts and simply reports the observatory as unconfigured.
      const bare=await mkdtemp(tmpdir()+'/jovememory-bare-'),bareRoot=bare+'/repo';await mkdir(bareRoot);
      const bareGit=args=>execFileSync('git',['-C',bareRoot,...args],{stdio:['ignore','pipe','ignore']});
      bareGit(['init']);bareGit(['remote','add','origin','https://github.com/example/synthetic-bare.git']);
      await writeFile(bareRoot+'/README.md','Synthetic bare source.');bareGit(['add','README.md']);
      await writeFile(bare+'/controller.token',controllerToken,{mode:0o600});
      await writeFile(bare+'/broker.json',JSON.stringify({endpoint,provisioner_token_file:bare+'/controller.token'}),{mode:0o600});
      const bareHttp=createApp(new Service(store,config),config).listen(0,'127.0.0.1');await new Promise(resolve=>bareHttp.once('listening',resolve));
      const bareEndpoint=`http://127.0.0.1:${bareHttp.address().port}/mcp`;
      await writeFile(bare+'/broker.json',JSON.stringify({endpoint:bareEndpoint,provisioner_token_file:bare+'/controller.token'}),{mode:0o600});
      const bareClient=new Client({name:'synthetic-bare-agent',version:'1'});
      try {
        await bareClient.connect(new StdioClientTransport({command:process.execPath,args:[process.cwd()+'/src/project-bridge.mjs'],cwd:bareRoot,env:{...process.env,JOVEMEMORY_BROKER_CONFIG:bare+'/broker.json'},stderr:'pipe'}));
        const bareNames=(await bareClient.listTools()).tools.map(x=>x.name);
        assert.ok(bareNames.includes('memory_write'));
        assert.ok(!bareNames.includes('memory_overview'),'Observatory appeared without a configured credential.');
        const bareStatus=(await bareClient.callTool({name:'memory_connection_status',arguments:{}})).structuredContent;
        assert.equal(bareStatus.observatory.configured,false);assert.equal(bareStatus.observatory.connected,false);
      } finally {await bareClient.close();bareHttp.closeAllConnections();await new Promise(resolve=>bareHttp.close(resolve));await rm(bare,{recursive:true,force:true});}
      // A token that is not an observer must never become a global privilege passthrough.
      // Both directions matter: a provisioner cannot even see the observatory, while an admin
      // token would see memory_overview *plus* every read, write and admin tool.
      const escalated=await mkdtemp(tmpdir()+'/jovememory-escalate-'),escRoot=escalated+'/repo';await mkdir(escRoot);
      const escGit=args=>execFileSync('git',['-C',escRoot,...args],{stdio:['ignore','pipe','ignore']});
      escGit(['init']);escGit(['remote','add','origin','https://github.com/example/synthetic-escalated.git']);
      await writeFile(escRoot+'/README.md','Synthetic escalation source.');escGit(['add','README.md']);
      const escHttp=createApp(new Service(store,config),config).listen(0,'127.0.0.1');await new Promise(resolve=>escHttp.once('listening',resolve));
      const escEndpoint=`http://127.0.0.1:${escHttp.address().port}/mcp`;
      await writeFile(escalated+'/controller.token',controllerToken,{mode:0o600});
      await writeFile(escalated+'/admin.token',adminToken,{mode:0o600});
      // Tools the project writer legitimately does not have; their presence would mean the
      // observatory route handed its catalog over. memory_read/search are on purpose absent here:
      // they belong to the project catalog, and are checked by scope instead.
      const forbidden=['memory_revoke_project','memory_link','memory_index','memory_create_workspace','memory_cross_workspace','memory_open_project'];
      try {
        for(const [label,file,token] of [['provisioner','controller.token',controllerToken],['admin','admin.token',adminToken]]) {
          await writeFile(escalated+'/broker.json',JSON.stringify({endpoint:escEndpoint,
            provisioner_token_file:escalated+'/controller.token',observer:{token_file:escalated+'/'+file}}),{mode:0o600});
          const escClient=new Client({name:'synthetic-escalation-agent',version:'1'});
          try {
            await escClient.connect(new StdioClientTransport({command:process.execPath,args:[process.cwd()+'/src/project-bridge.mjs'],cwd:escRoot,env:{...process.env,JOVEMEMORY_BROKER_CONFIG:escalated+'/broker.json'},stderr:'pipe'}));
            const escNames=(await escClient.listTools()).tools.map(x=>x.name);
            assert.ok(escNames.includes('memory_write'),`Project memory should still work with the ${label} observer slot.`);
            assert.ok(!escNames.includes('memory_overview'),`A ${label} credential was accepted for the observatory.`);
            for(const name of forbidden) assert.ok(!escNames.includes(name),`${name} leaked through the ${label} observatory route.`);
            const escStatus=(await escClient.callTool({name:'memory_connection_status',arguments:{}})).structuredContent;
            assert.equal(escStatus.observatory.configured,true,`${label} slot should report as configured.`);
            assert.equal(escStatus.observatory.connected,false,`${label} slot must not report as connected.`);
            assert.equal(escStatus.observatory.error,'OBSERVER_ROLE');
            assert.deepEqual(escStatus.observatory.tools,[]);
            // Even asked directly, the observatory route refuses rather than forwarding.
            const escCall=await escClient.callTool({name:'memory_overview',arguments:{limit:10}});
            assert.equal(escCall.isError,true,`${label} credential reached memory_overview.`);
            assert.ok(!JSON.stringify(escCall).includes(token),`The ${label} token appeared in an error result.`);
            // The project credential must keep its own scoping even while a bad observer slot exists.
            const scoped=await escClient.callTool({name:'memory_write',arguments:{content:'Synthetic escalation probe.'}});
            assert.equal(scoped.structuredContent.workspace,'synthetic-escalated');
            const crossScope=await escClient.callTool({name:'memory_read',arguments:{workspace:'synthetic-a',id:scoped.structuredContent.item.id}});
            assert.equal(crossScope.isError,true,`${label} slot weakened project workspace scoping.`);
          } finally {await escClient.close();}
        }
      } finally {escHttp.closeAllConnections();await new Promise(resolve=>escHttp.close(resolve));await rm(escalated,{recursive:true,force:true});}
      // The observatory is global: it must work even where no repository is bound.
      // The config lives outside the working directory, mirroring ~/.config/jovememory/broker.json.
      const orphanBase=await mkdtemp(tmpdir()+'/jovememory-orphan-'),orphanWork=orphanBase+'/work',orphanConf=orphanBase+'/conf';
      await mkdir(orphanWork);await mkdir(orphanConf,{mode:0o700});
      const orphanHttp=createApp(new Service(store,config),config).listen(0,'127.0.0.1');await new Promise(resolve=>orphanHttp.once('listening',resolve));
      await writeFile(orphanConf+'/controller.token',controllerToken,{mode:0o600});
      await writeFile(orphanConf+'/observer.token',observerToken,{mode:0o600});
      await writeFile(orphanConf+'/broker.json',JSON.stringify({endpoint:`http://127.0.0.1:${orphanHttp.address().port}/mcp`,provisioner_token_file:orphanConf+'/controller.token',observer:{token_file:orphanConf+'/observer.token'}}),{mode:0o600});
      const orphanClient=new Client({name:'synthetic-orphan-agent',version:'1'});
      try {
        await orphanClient.connect(new StdioClientTransport({command:process.execPath,args:[process.cwd()+'/src/project-bridge.mjs'],cwd:orphanWork,env:{...process.env,JOVEMEMORY_BROKER_CONFIG:orphanConf+'/broker.json'},stderr:'pipe'}));
        const orphanNames=(await orphanClient.listTools()).tools.map(x=>x.name);
        assert.ok(orphanNames.includes('memory_overview'),'Observatory needs a repository to work.');
        assert.ok(!orphanNames.includes('memory_write'),'Project memory appeared without a repository.');
        const orphanStatus=(await orphanClient.callTool({name:'memory_connection_status',arguments:{}})).structuredContent;
        assert.equal(orphanStatus.bound,false);assert.equal(orphanStatus.repository_name,null);
        assert.equal(orphanStatus.observatory.connected,true);
        const orphanOverview=(await orphanClient.callTool({name:'memory_overview',arguments:{limit:100}})).structuredContent;
        assert.equal(orphanOverview.memory_content_included,false);
        const orphanWrite=await orphanClient.callTool({name:'memory_write',arguments:{content:'Synthetic orphan note.'}});
        assert.equal(orphanWrite.isError,true);
      } finally {await orphanClient.close();orphanHttp.closeAllConnections();await new Promise(resolve=>orphanHttp.close(resolve));await rm(orphanBase,{recursive:true,force:true});}
    });
    await t.test('The broker re-enrolls by itself after the server rotates the signing key',async()=>{
      const folder=await mkdtemp(tmpdir()+'/jovememory-rotate-'),root=folder+'/repo';await mkdir(root);
      const git=args=>execFileSync('git',['-C',root,...args],{stdio:['ignore','pipe','ignore']});
      git(['init']);git(['remote','add','origin','https://github.com/example/synthetic-rotation.git']);
      await writeFile(root+'/README.md','Synthetic rotation source.');git(['add','README.md']);
      const controllerToken=randomBytes(32).toString('base64url');
      const controller={id:'synthetic-rot-controller',role:'provisioner',workspaces:['*'],sha256:hash(controllerToken)};
      // Two signing keys: the second simulates a credential rotation while the broker is live.
      // config() carries the parsed key as projectKey (a Buffer), not the raw variable.
      const cfgA={...c,reviewMode:'automatic',profiles:[controller],projectKey:Buffer.from(randomBytes(32).toString('hex'),'hex')};
      const cfgB={...c,reviewMode:'automatic',profiles:[controller],projectKey:Buffer.from(randomBytes(32).toString('hex'),'hex')};
      let http=createApp(new Service(store,cfgA),cfgA).listen(0,'127.0.0.1');await new Promise(resolve=>http.once('listening',resolve));
      const port=http.address().port,endpoint=`http://127.0.0.1:${port}/mcp`;
      await writeFile(folder+'/controller.token',controllerToken,{mode:0o600});
      await writeFile(folder+'/broker.json',JSON.stringify({endpoint,provisioner_token_file:folder+'/controller.token'}),{mode:0o600});
      const client=new Client({name:'synthetic-rotation-agent',version:'1'});
      try {
        await client.connect(new StdioClientTransport({command:process.execPath,args:[process.cwd()+'/src/project-bridge.mjs'],cwd:root,env:{...process.env,JOVEMEMORY_BROKER_CONFIG:folder+'/broker.json'},stderr:'pipe'}));
        const first=await client.callTool({name:'memory_write',arguments:{content:'Synthetic rotation note one.'}});
        assert.equal(first.structuredContent.workspace,'synthetic-rotation');
        // Rotate the signing key under the live broker: the issued JWT is now invalid.
        http.closeAllConnections();await new Promise(resolve=>http.close(resolve));
        http=createApp(new Service(store,cfgB),cfgB).listen(port,'127.0.0.1');await new Promise(resolve=>http.once('listening',resolve));
        // The stale credential fails once...
        const rejected=await client.callTool({name:'memory_write',arguments:{content:'Synthetic rotation note two.'}});
        assert.equal(rejected.isError,true,'The rotated-away credential was still accepted.');
        // ...and the next call re-enrolls by itself, without restarting the broker.
        const healed=await client.callTool({name:'memory_write',arguments:{content:'Synthetic rotation note three.'}});
        assert.equal(healed.isError,undefined,`The broker did not self-heal: ${JSON.stringify(healed.content?.[0]?.text || '')}`);
        assert.equal(healed.structuredContent.workspace,'synthetic-rotation');
        const search=await client.callTool({name:'memory_search',arguments:{query:'rotation note three'}});
        assert.ok(search.structuredContent.results.some(x=>x.content.includes('Synthetic rotation note three.')),'The healed write was not retrievable.');
        const status=(await client.callTool({name:'memory_connection_status',arguments:{}})).structuredContent;
        assert.equal(status.bound,true);assert.equal(status.source_observation_error,null);
      } finally {
        await client.close();http.closeAllConnections();await new Promise(resolve=>http.close(resolve));await rm(folder,{recursive:true,force:true});
      }
    });
    await t.test('Image signatures are verified and a broken PDF degrades without losing bytes',async()=>{
      // Real 1x1 PNG: magic bytes plus IHDR/IEND, so the signature check and the object roundtrip
      // are exercised with a genuine file rather than a bare prefix.
      const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==','base64');
      const pngAttachment=await call('memory_attach_media',{workspace:'synthetic-a',item_id:itemId,base64:png.toString('base64'),mime:'image/png'});
      assert.equal(pngAttachment.extraction_status,'not_available');
      const pngBack=await call('memory_read_media',{workspace:'synthetic-a',id:pngAttachment.media.id},reader);
      assert.ok(Buffer.from(pngBack.base64,'base64').equals(png),'PNG bytes did not roundtrip.');
      // The same bytes under a mismatched MIME are refused by the signature check.
      await assert.rejects(call('memory_attach_media',{workspace:'synthetic-a',item_id:itemId,base64:png.toString('base64'),mime:'image/jpeg'}),{code:'MEDIA'});
      // A minimal RIFF/WEBP container passes its signature check.
      const webp=Buffer.concat([Buffer.from('RIFF'),Buffer.from([24,0,0,0]),Buffer.from('WEBPVP8 '),Buffer.alloc(16)]);
      const webpAttachment=await call('memory_attach_media',{workspace:'synthetic-a',item_id:itemId,base64:webp.toString('base64'),mime:'image/webp'});
      assert.equal(webpAttachment.extraction_status,'not_available');
      // A PDF that starts with the magic but cannot be parsed keeps its bytes and declares the failure.
      const broken=Buffer.from('%PDF-1.4\nthis is not a parsable document\n');
      const brokenAttachment=await call('memory_attach_media',{workspace:'synthetic-a',item_id:itemId,base64:broken.toString('base64'),mime:'application/pdf'});
      assert.equal(brokenAttachment.extraction_status,'pdf_extraction_unavailable');
      const brokenBack=await call('memory_read_media',{workspace:'synthetic-a',id:brokenAttachment.media.id},reader);
      assert.ok(Buffer.from(brokenBack.base64,'base64').equals(broken),'A broken PDF lost its bytes.');
      // It must not surface in media search: there is no extracted text to match.
      assert.equal((await call('memory_search_media',{workspace:'synthetic-a',query:'parsable document'},reader)).results.some(r=>r.id===brokenAttachment.media.id),false);
    });
    await t.test('Soft deletion removes parent media from retrieval without erasing history',async()=>{
      await call('memory_delete',{workspace:'synthetic-a',id:itemId,reason:'Synthetic deletion'},reviewer);
      assert.equal((await call('memory_read',{workspace:'synthetic-a',id:itemId},reader)).item.status,'deleted');
      assert.equal((await call('memory_search_media',{workspace:'synthetic-a',query:'cobalt transcript'},reader)).results.length,0);
      await assert.rejects(call('memory_read_media',{workspace:'synthetic-a',id:mediaId},reader),{code:'MEDIA'});
    });
    // Runs last: these writes would otherwise push earlier audit assertions out of their page.
    await t.test('Budget-trimmed rows stay reachable through the re-anchored cursor',async()=>{
      const bulky='Synthetic resume checkpoint body '.repeat(40);
      for(let i=0;i<25;i++) {const cp=await call('memory_checkpoint',{workspace:'synthetic-a',session:'budget-session',title:`Budget checkpoint ${i}`,summary:`${bulky} #${i}`});await accept(cp.item.id);}
      const trimmed=await call('memory_resume',{workspace:'synthetic-a',session:'budget-session',max_bytes:4096},reader);
      assert.ok(trimmed.checkpoints.length<20,'Expected budget trimming to drop rows.');
      assert.ok(trimmed.omitted_ids.length>0);assert.ok(Buffer.byteLength(JSON.stringify(trimmed))<=4096);
      assert.ok(trimmed.next_cursor,'Trimmed page lost its cursor.');
      assert.ok(!trimmed.omitted_ids.includes(trimmed.checkpoints.at(-1).id),'Cursor was anchored to a dropped row.');
      const recovered=await call('memory_resume',{workspace:'synthetic-a',session:'budget-session',max_bytes:131072,cursor:trimmed.next_cursor,as_of:trimmed.as_of},reader);
      assert.ok(recovered.checkpoints.length>0,'Re-anchored cursor returned no rows.');
      const reachable=new Set([...trimmed.checkpoints,...recovered.checkpoints].map(x=>x.id));
      assert.ok(trimmed.omitted_ids.some(id=>reachable.has(id)),'An omitted checkpoint is unreachable.');
      // A budget too small to retain any row of a page fails instead of stranding the whole page.
      await assert.rejects(call('memory_resume',{workspace:'synthetic-a',session:'budget-session',max_bytes:1024},reader),{code:'BUDGET'});
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
