import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ensure, hash, Fault } from './config.mjs';
const active = alias => `${alias}.status='active' AND (${alias}.valid_from IS NULL OR ${alias}.valid_from <= $2::timestamptz) AND (${alias}.valid_until IS NULL OR ${alias}.valid_until > $2::timestamptz)`;
const clean = row => { if (!row) return null; const {embedding, search, page_time, ...result}=row; return result; };
// Database constraints are user-visible conditions, not infrastructure faults; map them to actionable codes.
const constraints = {
  '23505': ['CONFLICT','This item already has a pending replacement or duplicate record; review the existing proposal or accept it first.'],
  '23503': ['REFERENCE','The referenced node, workspace or item does not exist in this workspace.'],
  '23514': ['INPUT','A stored value violates its declared constraint.'],
  '40001': ['CONFLICT','A concurrent write won the race; retry with current state.'],
  '40P01': ['CONFLICT','A concurrent writer held a lock; retry with current state.']
};
// The same SQLSTATE means different things per constraint; a generic message would misdirect.
const byConstraint = {
  projects_repository_id_key:['PROJECT_COLLISION','Another workspace is already bound to this repository; no credentials were issued.'],
  projects_pkey:['PROJECT','This project record already exists.'],
  nodes_pkey:['NODE','This node already exists in the workspace.'],
  links_pkey:['EXISTS','This link already exists.']
};
export function declaredFault(error) {
  if (error instanceof Fault) return error;
  const named=error && typeof error.constraint==='string' ? byConstraint[error.constraint] : null;
  const mapped=named || (error && typeof error.code==='string' ? constraints[error.code] : null);
  return mapped ? new Fault(mapped[0],mapped[1]) : error;
}
// Reproduce the exact `page_time` rendering used by the page query so a rebuilt cursor compares identically.
function pageTime(value) {
  const d=new Date(value), pad=(n,width=2)=>String(n).padStart(width,'0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds()*1000,6)}Z`;
}
export class Store {
  constructor(url) { this.pool = new pg.Pool({connectionString:url,max:8,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,
    statement_timeout:10000,query_timeout:12000}); this.pool.on('error',()=>{}); }
  async close() { await this.pool.end(); }
  async health() {
    const role=(await this.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    ensure(role && !role.rolsuper && !role.rolbypassrls,'CONFIG','Runtime must use a non-administrative database role.');
    const result=await this.pool.query("SELECT name FROM schema_migrations ORDER BY name");
    ensure(result.rows.at(-1)?.name==='003.sql','SCHEMA','Run the declared migrations before starting.');
    return {schema:3,database:'ready'};
  }
  async workspaces() { return (await this.pool.query('SELECT name FROM workspaces ORDER BY name')).rows.map(r=>r.name); }
  async transaction(workspace, fn, {create=false}={}) {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE jovememory_app');
      await client.query("SELECT set_config('app.workspace',$1,true)",[workspace]);
      if(create) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[workspace]);
        await client.query('INSERT INTO workspaces(name) VALUES($1) ON CONFLICT DO NOTHING',[workspace]);
      }
      const exists=await client.query('SELECT name FROM workspaces WHERE name=$1',[workspace]);
      ensure(exists.rowCount,'WORKSPACE','Workspace has not been provisioned.');
      const result=await fn(client); await client.query('COMMIT'); return result;
    } catch(error) { await client.query('ROLLBACK'); throw declaredFault(error); } finally {client.release();}
  }
  async workspace(workspace,actor) {
    return this.transaction(workspace,async c=>{
      const prior=await c.query("SELECT 1 FROM audit WHERE workspace=$1 AND operation='workspace_create' LIMIT 1",[workspace]);
      if(!prior.rowCount) await this.audit(c,workspace,'workspace_create',actor,null,{workspace});
      return {workspace,provisioned:true};
    },{create:true});
  }
  async project(workspace) {return this.transaction(workspace,async c=>(await c.query('SELECT * FROM projects WHERE workspace=$1',[workspace])).rows[0] || null);}
  async enroll(workspace,repositoryId,repositoryName,actor) {
    return this.transaction(workspace,async c=>{
      const prior=(await c.query('SELECT * FROM projects WHERE workspace=$1 FOR UPDATE',[workspace])).rows[0];
      ensure(!prior || prior.repository_id===repositoryId,'PROJECT_COLLISION','Workspace is already bound to another repository; no credentials were issued.');
      if(prior) return prior;
      const project=(await c.query('INSERT INTO projects(workspace,repository_id,repository_name) VALUES($1,$2,$3) RETURNING *',[workspace,repositoryId,repositoryName])).rows[0];
      await this.audit(c,workspace,'project_enroll',actor,null,{repository_id:repositoryId,repository_name:repositoryName});return project;
    },{create:true});
  }
  async revokeProject(workspace,actor,reason) {
    return this.transaction(workspace,async c=>{
      const row=(await c.query('UPDATE projects SET credential_epoch=credential_epoch+1 WHERE workspace=$1 RETURNING credential_epoch',[workspace])).rows[0];
      ensure(row,'PROJECT','Project is not enrolled.');await this.audit(c,workspace,'project_revoke',actor,null,{reason});return row;
    });
  }
  async sourceMap(workspace) {return this.transaction(workspace,async c=>new Map((await c.query('SELECT * FROM sources WHERE workspace=$1',[workspace])).rows.map(x=>[x.locator,x])));}
  async sources(workspace,{limit=20,after=''}={}) {
    return this.transaction(workspace,async c=>{
      const rows=(await c.query('SELECT * FROM sources WHERE workspace=$1 AND locator>$2 ORDER BY locator LIMIT $3',[workspace,after,limit+1])).rows;
      return {sources:rows.slice(0,limit),next_after:rows.length>limit?rows[limit-1].locator:null};
    });
  }
  async syncSources(workspace,entries,revision,complete,actor) {
    return this.transaction(workspace,async c=>{
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[workspace+':sources']);
      const before=(await c.query('SELECT * FROM sources WHERE workspace=$1',[workspace])).rows;
      const incoming=new Map(entries.map(x=>[x.locator,x]));
      ensure(incoming.size===entries.length && entries.every(x=>x.present?Boolean(x.sha256):x.sha256===null),'INPUT','Source locators must be unique and presence must match the hash.');
      if(complete) for(const old of before) if(!incoming.has(old.locator)) incoming.set(old.locator,{locator:old.locator,sha256:null,present:false});
      // Index prior observations by locator; a linear scan per row is quadratic at 5000 sources.
      const previous=new Map(before.map(x=>[x.locator,x]));
      const changed=[...incoming.values()].filter(x=>{const old=previous.get(x.locator);return !old || old.present!==x.present || old.sha256!==x.sha256;}).map(x=>x.locator);
      await c.query(`INSERT INTO sources(workspace,locator,sha256,present,revision)
        SELECT $1,locator,sha256,present,$3 FROM jsonb_to_recordset($2::jsonb) AS x(locator text,sha256 text,present boolean)
        ON CONFLICT(workspace,locator) DO UPDATE SET sha256=EXCLUDED.sha256,present=EXCLUDED.present,revision=EXCLUDED.revision,observed_at=now()`,[workspace,JSON.stringify([...incoming.values()]),revision || null]);
      if(changed.length) await this.audit(c,workspace,'sources_change',actor,null,{locators:changed,revision:revision || null,complete});
      return {observed:incoming.size,changed:changed.length,revision:revision || null,source_truth_verified:false};
    });
  }
  async validateSources(c,workspace,refs) {
    if(!refs?.length) return;
    ensure(new Set(refs.map(x=>x.locator)).size===refs.length,'INPUT','Source references must be unique.');
    const rows=(await c.query('SELECT * FROM sources WHERE workspace=$1 AND locator=ANY($2::text[]) FOR SHARE',[workspace,refs.map(x=>x.locator)])).rows;
    ensure(refs.every(ref=>rows.some(s=>s.locator===ref.locator && s.present && s.sha256===ref.sha256)),'SOURCE_CHANGED','References require observed matching current source hashes.');
  }
  async revalidate(workspace,id,contentHash,refs,actor,reason) {
    return this.transaction(workspace,async c=>{
      const old=clean((await c.query('SELECT * FROM items WHERE workspace=$1 AND id=$2 FOR UPDATE',[workspace,id])).rows[0]);
      ensure(old?.status==='active' && old.content_hash===contentHash,'CONFLICT','Active memory changed before revalidation.');
      ensure(refs.length,'INPUT','Revalidation requires observed sources.');await this.validateSources(c,workspace,refs);
      const metadata={...old.metadata,source_refs:refs,source_revalidated_at:new Date().toISOString()};
      await c.query('UPDATE items SET metadata=$3 WHERE workspace=$1 AND id=$2',[workspace,id,metadata]);
      await this.audit(c,workspace,'revalidate',actor,id,{reason,source_refs:refs,content_hash:contentHash});return {id,source_refs:refs,truth_verified:false};
    });
  }
  async record(workspace,input,actor,automatic,replaceKey) {
    return this.transaction(workspace,async c=>{
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[workspace+':record:'+input.metadata.kind+':'+input.metadata.key]);
      const rows=replaceKey?(await c.query("SELECT * FROM items WHERE workspace=$1 AND kind='record' AND status='active' AND metadata->>'kind'=$2 AND metadata->>'key'=$3 ORDER BY id FOR UPDATE",[workspace,input.metadata.kind,input.metadata.key])).rows:[];
      ensure(rows.length<=1,'AMBIGUITY','Multiple active records share this key; resolve them explicitly before replacement.');
      const old=rows[0];
      if(old && old.content_hash===hash(input.content) && isDeepStrictEqual(old.metadata,JSON.parse(JSON.stringify(input.metadata)))) return clean(old);
      if(old?.valid_until && old.valid_until<=new Date()) {
        await c.query("UPDATE items SET status='invalidated',reason='Expired keyed record replaced.' WHERE workspace=$1 AND id=$2",[workspace,old.id]);
        await this.audit(c,workspace,'retire',actor,old.id,{reason:'Expired keyed record replaced.'});
        return this.create(c,workspace,{...input,metadata:{...input.metadata,previous_record_id:old.id}},actor,automatic);
      }
      return this.create(c,workspace,{...input,supersedes:old?.id},actor,automatic);
    });
  }
  async changes(workspace,{limit=20,after=0}={}) {
    return this.transaction(workspace,async c=>{
      const rows=(await c.query(`SELECT sequence,operation,item_id,actor,created_at,
        jsonb_build_object('reason',payload->>'reason','predecessor',payload->>'predecessor','invalidated_ids',payload->'invalidated_ids','revision',payload->>'revision','locators',payload->'locators') AS details
        FROM audit WHERE workspace=$1 AND sequence>$2 ORDER BY sequence LIMIT $3`,[workspace,after,limit+1])).rows;
      return {changes:rows.slice(0,limit),next_after:rows.length>limit?Number(rows[limit-1].sequence):null,last_sequence:rows.length?Number(rows[Math.min(rows.length,limit)-1].sequence):after};
    });
  }
  async observe(workspace,data) {
    return this.transaction(workspace,async c=>{
      await c.query('INSERT INTO telemetry(workspace,tool,success,error_code,duration_ms,model,route) VALUES($1,$2,$3,$4,$5,$6,$7)',[workspace,data.tool,data.success,data.error_code || null,Math.round(data.duration_ms),data.model || null,data.route || null]);
      await c.query("DELETE FROM telemetry WHERE workspace=$1 AND created_at<now()-interval '30 days'",[workspace]);
    });
  }
  async projectMetrics(workspace) {
    return this.transaction(workspace,async c=>({
      project:(await c.query('SELECT repository_name,created_at FROM projects WHERE workspace=$1',[workspace])).rows[0] || null,
      lifecycle:(await c.query(`SELECT count(*) FILTER (WHERE i.status='active')::int AS active,
        count(*) FILTER (WHERE i.status='invalidated')::int AS historical,
        count(*) FILTER (WHERE i.status='proposed')::int AS proposed,
        count(*) FILTER (WHERE i.status='active' AND valid_until<=now())::int AS expired,
        count(*) FILTER (WHERE i.status='active' AND embedding IS NULL)::int AS embedding_backlog,
        count(*) FILTER (WHERE i.status='active' AND jsonb_array_length(COALESCE(metadata->'source_refs','[]'))=0)::int AS untracked,
        count(*) FILTER (WHERE i.status='active' AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(i.metadata->'source_refs','[]')) r
          LEFT JOIN sources s ON s.workspace=i.workspace AND s.locator=r->>'locator' WHERE s.locator IS NULL OR NOT s.present OR s.sha256<>r->>'sha256'))::int AS needs_revalidation
        FROM items i WHERE i.workspace=$1`,[workspace])).rows[0],
      sources:(await c.query('SELECT count(*)::int AS observed,count(*) FILTER (WHERE NOT present)::int AS missing,max(observed_at) AS last_observed_at FROM sources WHERE workspace=$1',[workspace])).rows[0],
      activity:(await c.query('SELECT max(created_at) AS last_mutation_at,count(*)::int AS audited_mutations FROM audit WHERE workspace=$1',[workspace])).rows[0],
      usage:(await c.query(`SELECT count(*)::int AS calls,count(*) FILTER (WHERE NOT success)::int AS failures,
        count(*) FILTER (WHERE route='paid_fallback')::int AS paid_fallbacks,percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
        FROM telemetry WHERE workspace=$1 AND created_at>now()-interval '7 days'`,[workspace])).rows[0]
    }));
  }
  async audit(c, workspace, operation, actor, itemId, payload) {
    await c.query('INSERT INTO audit(workspace,operation,actor,item_id,payload) VALUES($1,$2,$3,$4,$5)',[workspace,operation,actor,itemId,payload]);
  }
  async node(workspace, id, label, parent, actor) {
    return this.transaction(workspace,async c=>{
      if(parent) await this.assertNode(c,workspace,parent);
      const r=await c.query('INSERT INTO nodes(workspace,id,label,parent) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *',[workspace,id,label,parent || null]);
      if(r.rowCount) await this.audit(c,workspace,'node',actor,null,{id,label,parent});
      return r.rows[0] || (await c.query('SELECT * FROM nodes WHERE workspace=$1 AND id=$2',[workspace,id])).rows[0];
    });
  }
  async assertNode(c,workspace,node) {
    const found=await c.query('SELECT 1 FROM nodes WHERE workspace=$1 AND id=$2',[workspace,node]);
    ensure(found.rowCount,'NODE','The target node does not exist in this workspace; create it with memory_create_node first.');
  }
  async create(c, workspace, input, actor, automatic=false) {
    if(input.source_refs) input={...input,metadata:{...input.metadata,source_refs:input.source_refs}};
    await this.validateSources(c,workspace,input.metadata?.source_refs);
    if(input.node) await this.assertNode(c,workspace,input.node);
    const id=input.id || randomUUID(); const digest=hash(input.content);
    const existing=await c.query('SELECT id FROM items WHERE workspace=$1 AND (id=$2 OR (content_hash=$3 AND status=\'rejected\'))',[workspace,id,digest]);
    ensure(!existing.rowCount,'EXISTS','ID already exists or identical content was rejected.');
    const r=await c.query(`INSERT INTO items(workspace,id,node,content,content_hash,kind,metadata,proposer,supersedes,valid_from,valid_until)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[workspace,id,input.node || null,input.content,digest,
      input.kind || 'note',input.metadata || {},actor,input.supersedes || null,input.valid_from || null,input.valid_until || null]);
    await this.audit(c,workspace,'propose',actor,id,{item:clean(r.rows[0]),gate:input.gate || null});
    if(automatic) {
      await this.reviewInTransaction(c,workspace,id,true,'Automatic activation under the configured write policy.','system:auto',true);
      return clean((await c.query('SELECT * FROM items WHERE workspace=$1 AND id=$2',[workspace,id])).rows[0]);
    }
    return clean(r.rows[0]);
  }
  async propose(workspace,input,actor,automatic=false) { return this.transaction(workspace,c=>this.create(c,workspace,input,actor,automatic)); }
  async read(workspace,id) {
    return this.transaction(workspace,async c=>{
      const item=clean((await c.query('SELECT * FROM items WHERE workspace=$1 AND id=$2',[workspace,id])).rows[0]);
      if(!item) return null;
      item.media=(await c.query('SELECT id,sha256,mime,size,extracted_text FROM media WHERE workspace=$1 AND item_id=$2',[workspace,id])).rows;
      item.links=(await c.query('SELECT id,target_workspace,target_id,relation FROM links WHERE workspace=$1 AND source_id=$2',[workspace,id])).rows;
      return item;
    });
  }
  // One transaction for a whole page; a per-item read loop saturates the pool on large workspaces.
  async readMany(workspace,ids) {
    if(!ids.length) return new Map();
    const unique=[...new Set(ids)];
    return this.transaction(workspace,async c=>{
      const items=(await c.query('SELECT * FROM items WHERE workspace=$1 AND id=ANY($2::uuid[])',[workspace,unique])).rows.map(clean);
      if(!items.length) return new Map();
      const media=(await c.query('SELECT item_id,id,sha256,mime,size,extracted_text FROM media WHERE workspace=$1 AND item_id=ANY($2::uuid[]) ORDER BY id',[workspace,unique])).rows;
      const links=(await c.query('SELECT source_id,id,target_workspace,target_id,relation FROM links WHERE workspace=$1 AND source_id=ANY($2::uuid[]) ORDER BY id',[workspace,unique])).rows;
      const byId=new Map(items.map(x=>[x.id,{...x,media:[],links:[]}]));
      for(const row of media) byId.get(row.item_id)?.media.push(row);
      for(const row of links) byId.get(row.source_id)?.links.push({id:row.id,target_workspace:row.target_workspace,target_id:row.target_id,relation:row.relation});
      return byId;
    });
  }
  async eligible(workspace,ids,asOf=new Date().toISOString(),client) {
    const fn=async c=>(await c.query(`SELECT * FROM items i WHERE workspace=$1 AND ${active('i')} AND id=ANY($3::uuid[]) ORDER BY id`,[workspace,asOf,ids])).rows.map(clean);
    return client ? fn(client) : this.transaction(workspace,fn);
  }
  async page(workspace,{status='active',kind,node,limit=20,cursor,as_of=new Date().toISOString(),include_ineligible=false}={}) {
    const scope=hash(JSON.stringify({workspace,status,kind:kind || null,node:node || null,as_of,include_ineligible}));
    let after=null;
    if(cursor) { try {after=JSON.parse(Buffer.from(cursor,'base64url'));} catch {} ensure(after?.scope===scope && typeof after.time==='string' && /^[a-f0-9-]{36}$/.test(after.id),'CURSOR','Cursor does not match these filters and as_of.'); }
    const encode=(time,id)=>Buffer.from(JSON.stringify({scope,time,id})).toString('base64url');
    return this.transaction(workspace,async c=>{
      const args=[workspace,as_of,status,kind || null,node || null,after?.time || null,after?.id || null,limit+1,include_ineligible];
      const r=await c.query(`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS page_time FROM items i
        WHERE workspace=$1 AND status=$3 AND ($4::text IS NULL OR kind=$4) AND ($5::text IS NULL OR node=$5)
        AND ($9::boolean OR $3!='active' OR (${active('i')})) AND ($6::timestamptz IS NULL OR (created_at,id)<($6::timestamptz,$7::uuid))
        ORDER BY created_at DESC,id DESC LIMIT $8`,args);
      const rows=r.rows.slice(0,limit), last=rows.at(-1);
      const page={items:rows.map(clean),as_of,next_cursor:r.rows.length>limit ? encode(last.page_time,last.id) : null};
      // Non-enumerable: the cursor builder is internal and must not reach a serialized tool result.
      Object.defineProperty(page,'cursorAt',{value:row=>encode(pageTime(row.created_at),row.id),enumerable:false});
      return page;
    });
  }
  async review(workspace,id,accept,reason,actor) {
    return this.transaction(workspace,c=>this.reviewInTransaction(c,workspace,id,accept,reason,actor));
  }
  async reviewInTransaction(c,workspace,id,accept,reason,actor,automatic=false) {
    const proposal=(await c.query('SELECT * FROM items WHERE workspace=$1 AND id=$2 FOR UPDATE',[workspace,id])).rows[0];
    ensure(proposal?.status==='proposed','STATE','Only a pending proposal can be reviewed.');
    ensure(proposal.proposer!==actor,'REVIEW','A different profile must review the proposal.');
    const sourceIds=proposal.metadata.consolidation?.sources.map(s=>s.id) || (proposal.supersedes ? [proposal.supersedes]:[]);
    if(accept && sourceIds.length) {
      const sources=(await c.query('SELECT * FROM items WHERE workspace=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[workspace,sourceIds])).rows;
      ensure(sources.length===sourceIds.length && sources.every(s=>s.status==='active' && (!s.valid_from || s.valid_from<=new Date()) && (!s.valid_until || s.valid_until>new Date())),'CONFLICT','Predecessors changed before review.');
      if(proposal.metadata.consolidation) ensure(sources.every(s=>proposal.metadata.consolidation.sources.some(snapshot=>snapshot.id===s.id && snapshot.content_hash===s.content_hash && snapshot.node===s.node)),
        'CONFLICT','Consolidation snapshots changed before review.');
      await c.query("UPDATE items SET status='invalidated',reason=$3 WHERE workspace=$1 AND id=ANY($2::uuid[])",[workspace,sourceIds,reason]);
    }
    await c.query(`UPDATE items SET status=$3,reviewer=$4,reason=$5,content=CASE WHEN $3='rejected' THEN '' ELSE content END,
      embedding=CASE WHEN $3='rejected' THEN NULL ELSE embedding END WHERE workspace=$1 AND id=$2`,[workspace,id,accept?'active':'rejected',actor,reason]);
    await this.audit(c,workspace,accept?'accept':'reject',actor,id,{reason,automatic,before:clean(proposal),invalidated_ids:accept?sourceIds:[]});
    return {id,status:accept?'active':'rejected',invalidated_ids:accept?sourceIds:[]};
  }
  async update(workspace,id,input,reason,actor,automatic=false) {
    return this.transaction(workspace,async c=>{
      const old=clean((await c.query('SELECT * FROM items WHERE workspace=$1 AND id=$2 FOR UPDATE',[workspace,id])).rows[0]);
      ensure(old?.status==='active','STATE','Only active items can be replaced.');
      const metadata={...old.metadata};delete metadata.model_analysis;
      Object.assign(metadata,input.metadata || {});
      // Only explicitly supplied keys replace predecessor values; an omitted window keeps the original validity.
      const proposal=await this.create(c,workspace,{...old,...input,metadata,id:undefined,supersedes:id},actor,automatic);
      await this.audit(c,workspace,'replacement',actor,proposal.id,{reason,predecessor:id});return proposal;
    });
  }
  async mutate(workspace,id,operation,actor,payload) {
    return this.transaction(workspace,async c=>{
      const old=clean((await c.query('SELECT * FROM items WHERE workspace=$1 AND id=$2 FOR UPDATE',[workspace,id])).rows[0]);
      ensure(old && !['deleted','rejected'].includes(old.status),'STATE','Item is unavailable for mutation.');
      if(operation==='delete') await c.query("UPDATE items SET status='deleted',reason=$3 WHERE workspace=$1 AND id=$2",[workspace,id,payload.reason]);
      if(operation==='retire') {ensure(old.status==='active','STATE','Only active memories can retire.');await c.query("UPDATE items SET status='invalidated',reason=$3 WHERE workspace=$1 AND id=$2",[workspace,id,payload.reason]);}
      if(operation==='move') { ensure(['active','invalidated'].includes(old.status),'STATE','Only reviewed items can move.');
        await this.assertNode(c,workspace,payload.node);
        await c.query('UPDATE items SET node=$3 WHERE workspace=$1 AND id=$2',[workspace,id,payload.node]); }
      if(operation==='feedback') { ensure(old.status==='active','STATE','Feedback requires an active item.');
        await c.query('UPDATE items SET importance=greatest(0,least(1,importance+$3)) WHERE workspace=$1 AND id=$2',[workspace,id,payload.useful?0.05:-0.05]); }
      await this.audit(c,workspace,operation,actor,id,{before:old,...payload});return {id,operation};
    });
  }
  async tree(workspace) { return this.transaction(workspace,async c=>(await c.query(`SELECT n.*,count(i.id)::int AS item_count FROM nodes n
    LEFT JOIN items i ON i.workspace=n.workspace AND i.node=n.id AND i.status='active' WHERE n.workspace=$1 GROUP BY n.workspace,n.id ORDER BY n.id`,[workspace])).rows); }
  async stats(workspace) { return this.transaction(workspace,async c=>({
    counts:(await c.query('SELECT status,count(*)::int AS count FROM items WHERE workspace=$1 GROUP BY status',[workspace])).rows,
    embeddings:(await c.query("SELECT count(*) FILTER (WHERE embedding IS NOT NULL)::int AS indexed,count(*)::int AS active FROM items WHERE workspace=$1 AND status='active'",[workspace])).rows[0]
  })); }
  async mutations(workspace,{id,operation,limit=20,after=0}={}) { return this.transaction(workspace,async c=>{
    // Audit rows store full item snapshots for replay; reading them back would return unbounded content.
    const rows=(await c.query(`SELECT sequence,operation,item_id,actor,created_at,payload - 'item' - 'before' AS payload
      FROM audit WHERE workspace=$1 AND sequence>$2 AND ($3::uuid IS NULL OR item_id=$3)
      AND ($4::text IS NULL OR operation=$4) ORDER BY sequence LIMIT $5`,[workspace,after,id || null,operation || null,limit])).rows;
    return rows;
  }); }
  async lexical(workspace,query,limit,asOf) { return this.transaction(workspace,async c=>(await c.query(`SELECT i.*,ts_rank_cd(search,websearch_to_tsquery('portuguese',$3)) AS score
    FROM items i WHERE workspace=$1 AND ${active('i')} AND search @@ websearch_to_tsquery('portuguese',$3) ORDER BY score DESC,id LIMIT $4`,[workspace,asOf,query,limit])).rows.map(clean)); }
  async semantic(workspace,embedding,model,limit,asOf) { return this.transaction(workspace,async c=>(await c.query(`SELECT i.*,1-(embedding <=> $3::vector) AS score
    FROM items i WHERE workspace=$1 AND ${active('i')} AND embedding IS NOT NULL AND embedding_model=$4 AND vector_dims(embedding)=$5
    ORDER BY embedding <=> $3::vector,id LIMIT $6`,[workspace,asOf,JSON.stringify(embedding),model,embedding.length,limit])).rows.map(clean)); }
  async graph(workspace,ids,limit,asOf) { if(!ids.length) return []; return this.transaction(workspace,async c=>(await c.query(`SELECT DISTINCT ON (i.id) i.* FROM items i
    JOIN links l ON l.workspace=i.workspace AND l.target_workspace=i.workspace AND l.target_id=i.id
    WHERE i.workspace=$1 AND ${active('i')} AND l.source_id=ANY($3::uuid[]) ORDER BY i.id LIMIT $4`,[workspace,asOf,ids,limit])).rows.map(clean)); }
  async embed(workspace,id,vector,model,contentHash,actor) { return this.transaction(workspace,async c=>{
    const r=await c.query("UPDATE items SET embedding=$3::vector,embedding_model=$4 WHERE workspace=$1 AND id=$2 AND content_hash=$5 AND status='active' RETURNING id",[workspace,id,JSON.stringify(vector),model,contentHash]);
    ensure(r.rowCount,'CONFLICT','Item changed while generating its embedding.'); await this.audit(c,workspace,'embed',actor,id,{model,dimensions:vector.length});return {id};
  }); }
  async link(workspace,targetWorkspace,sourceId,targetId,relation,actor) {
    const id=randomUUID();return this.transaction(workspace,async c=>{
      await c.query('INSERT INTO links(workspace,id,target_workspace,source_id,target_id,relation) VALUES($1,$2,$3,$4,$5,$6)',[workspace,id,targetWorkspace,sourceId || null,targetId || null,relation]);
      await this.audit(c,workspace,'link',actor,sourceId || null,{id,target_workspace:targetWorkspace,target_id:targetId,relation});return {id};
    });
  }
  async crossLinks(workspace) { return this.transaction(workspace,async c=>(await c.query('SELECT DISTINCT target_workspace,relation FROM links WHERE workspace=$1 AND target_workspace!=$1 ORDER BY target_workspace LIMIT 20',[workspace])).rows); }
  async ingestion(workspace,plan,actor,automatic=false) {
    return this.transaction(workspace,async c=>{
      const results=[];
      for(const part of plan.sections) {
        const prior=await c.query("SELECT id,status FROM items WHERE workspace=$1 AND (id=$2 OR (content_hash=$3 AND status='rejected'))",[workspace,part.id,hash(part.content)]);
        if(prior.rowCount) {results.push({...prior.rows[0],skipped:true});continue;}
        await c.query('INSERT INTO nodes(workspace,id,label) VALUES($1,$2,$2) ON CONFLICT DO NOTHING',[workspace,part.source]);
        // Persist the heading committed to the deterministic id and shown in the preview.
        results.push(await this.create(c,workspace,{...part,node:part.source,metadata:{source:part.source,heading:part.heading,plan_hash:plan.plan_hash}},actor,automatic));
      }
      return {complete:true,results};
    });
  }
  async consolidate(workspace,ids,planHash,actor,automatic=false,modelSummary=null) {
    return this.transaction(workspace,async c=>{
      const sources=await this.eligible(workspace,ids,new Date().toISOString(),c);
      ensure(sources.length===ids.length,'STATE','Consolidation requires active sources.');
      const digest=hash(JSON.stringify(sources.map(s=>({id:s.id,content_hash:s.content_hash,node:s.node}))));
      ensure(digest===planHash,'PLAN','Consolidation preview changed.');
      return this.create(c,workspace,{content:sources.map(s=>s.content).join('\n\n---\n\n'),kind:'consolidation',
        metadata:{consolidation:{plan_hash:digest,sources,model_summary:modelSummary}}},actor,automatic);
    });
  }
  async addMedia(workspace,data,actor) { return this.transaction(workspace,async c=>{
    const parent=(await c.query('SELECT status,valid_from,valid_until FROM items WHERE workspace=$1 AND id=$2 FOR UPDATE',[workspace,data.item_id])).rows[0];
    const now=new Date();ensure(parent?.status==='active' && (!parent.valid_from || parent.valid_from<=now) && (!parent.valid_until || parent.valid_until>now),'STATE','Media parent is no longer eligible.');
    const duplicate=await c.query('SELECT id,sha256,mime,size FROM media WHERE workspace=$1 AND item_id=$2 AND sha256=$3',[workspace,data.item_id,data.sha256]);
    if(duplicate.rowCount) return {...duplicate.rows[0],deduplicated:true};
    const r=await c.query(`INSERT INTO media(workspace,id,item_id,object_key,sha256,mime,size,extracted_text,embedding,embedding_model)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10) RETURNING id,sha256,mime,size`,[workspace,data.id,data.item_id,data.object_key,data.sha256,data.mime,data.size,data.extracted_text, data.embedding ? JSON.stringify(data.embedding):null,data.embedding_model || null]);
    await this.audit(c,workspace,'media',actor,data.item_id,{...r.rows[0],object_key:data.object_key,extraction_status:data.extraction_status});return r.rows[0];
  }); }
  async mediaSearch(workspace,query,limit,asOf,embedding,model) { return this.transaction(workspace,async c=>{
    const r=await c.query(`SELECT m.id,m.item_id,m.sha256,m.mime,m.extracted_text FROM media m JOIN items i ON i.workspace=m.workspace AND i.id=m.item_id
      WHERE m.workspace=$1 AND ${active('i')} AND to_tsvector('portuguese',m.extracted_text) @@ websearch_to_tsquery('portuguese',$3)
      ORDER BY m.id LIMIT $4`,[workspace,asOf,query,limit]);
    if(r.rowCount || !embedding) return {results:r.rows,arm:'lexical'};
    const vector=await c.query(`SELECT m.id,m.item_id,m.sha256,m.mime,m.extracted_text,1-(m.embedding <=> $3::vector) AS score FROM media m JOIN items i ON i.workspace=m.workspace AND i.id=m.item_id
      WHERE m.workspace=$1 AND ${active('i')} AND m.embedding_model=$4 AND vector_dims(m.embedding)=$5 ORDER BY m.embedding <=> $3::vector, m.id LIMIT $6`,[workspace,asOf,JSON.stringify(embedding),model,embedding.length,limit]);
    return {results:vector.rows,arm:'semantic'};
  }); }
  async mediaPointer(workspace,id) { return this.transaction(workspace,async c=>(await c.query(`SELECT m.* FROM media m JOIN items i ON i.workspace=m.workspace AND i.id=m.item_id
    WHERE m.workspace=$1 AND m.id=$2 AND i.status='active' AND (i.valid_from IS NULL OR i.valid_from<=now()) AND (i.valid_until IS NULL OR i.valid_until>now())`,[workspace,id])).rows[0]); }
}
