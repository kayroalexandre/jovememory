import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { ensure, hash } from './config.mjs';
const active = alias => `${alias}.status='active' AND (${alias}.valid_from IS NULL OR ${alias}.valid_from <= $2::timestamptz) AND (${alias}.valid_until IS NULL OR ${alias}.valid_until > $2::timestamptz)`;
const clean = row => { if (!row) return null; const {embedding, search, page_time, ...result}=row; return result; };
export class Store {
  constructor(url) { this.pool = new pg.Pool({connectionString:url,max:8,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,
    statement_timeout:10000,query_timeout:12000}); this.pool.on('error',()=>{}); }
  async close() { await this.pool.end(); }
  async health() {
    const role=(await this.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    ensure(role && !role.rolsuper && !role.rolbypassrls,'CONFIG','Runtime must use a non-administrative database role.');
    const result=await this.pool.query("SELECT name FROM schema_migrations ORDER BY name");
    ensure(result.rows.at(-1)?.name==='001.sql','SCHEMA','Run the declared migrations before starting.');
    return {schema:1,database:'ready'};
  }
  async workspaces() { return (await this.pool.query('SELECT name FROM workspaces ORDER BY name')).rows.map(r=>r.name); }
  async transaction(workspace, fn) {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE jovememory_app');
      await client.query("SELECT set_config('app.workspace',$1,true)",[workspace]);
      const exists=await client.query('SELECT name FROM workspaces WHERE name=$1',[workspace]);
      ensure(exists.rowCount,'WORKSPACE','Workspace has not been provisioned.');
      const result=await fn(client); await client.query('COMMIT'); return result;
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally {client.release();}
  }
  async audit(c, workspace, operation, actor, itemId, payload) {
    await c.query('INSERT INTO audit(workspace,operation,actor,item_id,payload) VALUES($1,$2,$3,$4,$5)',[workspace,operation,actor,itemId,payload]);
  }
  async node(workspace, id, label, parent, actor) {
    return this.transaction(workspace,async c=>{
      const r=await c.query('INSERT INTO nodes(workspace,id,label,parent) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *',[workspace,id,label,parent || null]);
      if(r.rowCount) await this.audit(c,workspace,'node',actor,null,{id,label,parent});
      return r.rows[0] || (await c.query('SELECT * FROM nodes WHERE workspace=$1 AND id=$2',[workspace,id])).rows[0];
    });
  }
  async create(c, workspace, input, actor) {
    const id=input.id || randomUUID(); const digest=hash(input.content);
    const existing=await c.query('SELECT id FROM items WHERE workspace=$1 AND (id=$2 OR (content_hash=$3 AND status=\'rejected\'))',[workspace,id,digest]);
    ensure(!existing.rowCount,'EXISTS','ID already exists or identical content was rejected.');
    const r=await c.query(`INSERT INTO items(workspace,id,node,content,content_hash,kind,metadata,proposer,supersedes,valid_from,valid_until)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[workspace,id,input.node || null,input.content,digest,
      input.kind || 'note',input.metadata || {},actor,input.supersedes || null,input.valid_from || null,input.valid_until || null]);
    await this.audit(c,workspace,'propose',actor,id,{item:clean(r.rows[0]),gate:input.gate || null});
    return clean(r.rows[0]);
  }
  async propose(workspace,input,actor) { return this.transaction(workspace,c=>this.create(c,workspace,input,actor)); }
  async read(workspace,id) {
    return this.transaction(workspace,async c=>{
      const item=clean((await c.query('SELECT * FROM items WHERE workspace=$1 AND id=$2',[workspace,id])).rows[0]);
      if(!item) return null;
      item.media=(await c.query('SELECT id,sha256,mime,size,extracted_text FROM media WHERE workspace=$1 AND item_id=$2',[workspace,id])).rows;
      item.links=(await c.query('SELECT id,target_workspace,target_id,relation FROM links WHERE workspace=$1 AND source_id=$2',[workspace,id])).rows;
      return item;
    });
  }
  async eligible(workspace,ids,asOf=new Date().toISOString(),client) {
    const fn=async c=>(await c.query(`SELECT * FROM items i WHERE workspace=$1 AND ${active('i')} AND id=ANY($3::uuid[]) ORDER BY id`,[workspace,asOf,ids])).rows.map(clean);
    return client ? fn(client) : this.transaction(workspace,fn);
  }
  async page(workspace,{status='active',kind,node,limit=20,cursor,as_of=new Date().toISOString()}={}) {
    const scope=hash(JSON.stringify({workspace,status,kind:kind || null,node:node || null,as_of}));
    let after=null;
    if(cursor) { try {after=JSON.parse(Buffer.from(cursor,'base64url'));} catch {} ensure(after?.scope===scope && typeof after.time==='string' && /^[a-f0-9-]{36}$/.test(after.id),'CURSOR','Cursor does not match these filters and as_of.'); }
    return this.transaction(workspace,async c=>{
      const args=[workspace,as_of,status,kind || null,node || null,after?.time || null,after?.id || null,limit+1];
      const r=await c.query(`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS page_time FROM items i
        WHERE workspace=$1 AND status=$3 AND ($4::text IS NULL OR kind=$4) AND ($5::text IS NULL OR node=$5)
        AND ($3!='active' OR (${active('i')})) AND ($6::timestamptz IS NULL OR (created_at,id)<($6::timestamptz,$7::uuid))
        ORDER BY created_at DESC,id DESC LIMIT $8`,args);
      const rows=r.rows.slice(0,limit), last=rows.at(-1);
      return {items:rows.map(clean),as_of,next_cursor:r.rows.length>limit ? Buffer.from(JSON.stringify({scope,time:last.page_time,id:last.id})).toString('base64url'):null};
    });
  }
  async review(workspace,id,accept,reason,actor) {
    return this.transaction(workspace,async c=>{
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
      await this.audit(c,workspace,accept?'accept':'reject',actor,id,{reason,before:clean(proposal),invalidated_ids:accept?sourceIds:[]});
      return {id,status:accept?'active':'rejected',invalidated_ids:accept?sourceIds:[]};
    });
  }
  async update(workspace,id,input,reason,actor) {
    return this.transaction(workspace,async c=>{
      const old=clean((await c.query('SELECT * FROM items WHERE workspace=$1 AND id=$2 FOR UPDATE',[workspace,id])).rows[0]);
      ensure(old?.status==='active','STATE','Only active items can be replaced.');
      const proposal=await this.create(c,workspace,{...old,...input,id:undefined,supersedes:id},actor);
      await this.audit(c,workspace,'replacement',actor,proposal.id,{reason,predecessor:id});return proposal;
    });
  }
  async mutate(workspace,id,operation,actor,payload) {
    return this.transaction(workspace,async c=>{
      const old=clean((await c.query('SELECT * FROM items WHERE workspace=$1 AND id=$2 FOR UPDATE',[workspace,id])).rows[0]);
      ensure(old && !['deleted','rejected'].includes(old.status),'STATE','Item is unavailable for mutation.');
      if(operation==='delete') await c.query("UPDATE items SET status='deleted',reason=$3 WHERE workspace=$1 AND id=$2",[workspace,id,payload.reason]);
      if(operation==='move') { ensure(['active','invalidated'].includes(old.status),'STATE','Only reviewed items can move.');
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
  async mutations(workspace,{id,operation,limit=20,after=0}={}) { return this.transaction(workspace,async c=>(await c.query(`SELECT * FROM audit
    WHERE workspace=$1 AND sequence>$2 AND ($3::uuid IS NULL OR item_id=$3) AND ($4::text IS NULL OR operation=$4) ORDER BY sequence LIMIT $5`,[workspace,after,id || null,operation || null,limit])).rows); }
  async lexical(workspace,query,limit,asOf) { return this.transaction(workspace,async c=>(await c.query(`SELECT i.*,ts_rank_cd(search,websearch_to_tsquery('portuguese',$3)) AS score
    FROM items i WHERE workspace=$1 AND ${active('i')} AND search @@ websearch_to_tsquery('portuguese',$3) ORDER BY score DESC,id LIMIT $4`,[workspace,asOf,query,limit])).rows.map(clean)); }
  async semantic(workspace,embedding,model,limit,asOf) { return this.transaction(workspace,async c=>(await c.query(`SELECT i.*,1-(embedding <=> $3::vector) AS score
    FROM items i WHERE workspace=$1 AND ${active('i')} AND embedding IS NOT NULL AND embedding_model=$4 AND vector_dims(embedding)=$5
    ORDER BY embedding <=> $3::vector,id LIMIT $6`,[workspace,asOf,JSON.stringify(embedding),model,embedding.length,limit])).rows.map(clean)); }
  async recent(workspace,limit,asOf) { return this.transaction(workspace,async c=>(await c.query(`SELECT * FROM items i WHERE workspace=$1 AND ${active('i')}
    ORDER BY created_at DESC,id LIMIT $3`,[workspace,asOf,limit])).rows.map(clean)); }
  async graph(workspace,ids,limit,asOf) { if(!ids.length) return []; return this.transaction(workspace,async c=>(await c.query(`SELECT DISTINCT i.* FROM items i
    JOIN links l ON l.workspace=i.workspace AND l.target_workspace=i.workspace AND l.target_id=i.id
    WHERE i.workspace=$1 AND ${active('i')} AND l.source_id=ANY($3::uuid[]) LIMIT $4`,[workspace,asOf,ids,limit])).rows.map(clean)); }
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
  async ingestion(workspace,plan,actor) {
    return this.transaction(workspace,async c=>{
      const results=[];
      for(const part of plan.sections) {
        const prior=await c.query("SELECT id,status FROM items WHERE workspace=$1 AND (id=$2 OR (content_hash=$3 AND status='rejected'))",[workspace,part.id,hash(part.content)]);
        if(prior.rowCount) {results.push({...prior.rows[0],skipped:true});continue;}
        await c.query('INSERT INTO nodes(workspace,id,label) VALUES($1,$2,$2) ON CONFLICT DO NOTHING',[workspace,part.source]);
        results.push(await this.create(c,workspace,{...part,node:part.source,metadata:{source:part.source,plan_hash:plan.plan_hash}},actor));
      }
      return {complete:true,results};
    });
  }
  async consolidate(workspace,ids,planHash,actor) {
    return this.transaction(workspace,async c=>{
      const sources=await this.eligible(workspace,ids,new Date().toISOString(),c);
      ensure(sources.length===ids.length,'STATE','Consolidation requires active sources.');
      const digest=hash(JSON.stringify(sources.map(s=>({id:s.id,content_hash:s.content_hash,node:s.node}))));
      ensure(digest===planHash,'PLAN','Consolidation preview changed.');
      return this.create(c,workspace,{content:sources.map(s=>s.content).join('\n\n---\n\n'),kind:'consolidation',metadata:{consolidation:{plan_hash:digest,sources}}},actor);
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
      WHERE m.workspace=$1 AND ${active('i')} AND to_tsvector('portuguese',m.extracted_text) @@ websearch_to_tsquery('portuguese',$3) LIMIT $4`,[workspace,asOf,query,limit]);
    if(r.rowCount || !embedding) return {results:r.rows,arm:'lexical'};
    const vector=await c.query(`SELECT m.id,m.item_id,m.sha256,m.mime,m.extracted_text,1-(m.embedding <=> $3::vector) AS score FROM media m JOIN items i ON i.workspace=m.workspace AND i.id=m.item_id
      WHERE m.workspace=$1 AND ${active('i')} AND m.embedding_model=$4 AND vector_dims(m.embedding)=$5 ORDER BY m.embedding <=> $3::vector LIMIT $6`,[workspace,asOf,JSON.stringify(embedding),model,embedding.length,limit]);
    return {results:vector.rows,arm:'semantic'};
  }); }
  async mediaPointer(workspace,id) { return this.transaction(workspace,async c=>(await c.query(`SELECT m.* FROM media m JOIN items i ON i.workspace=m.workspace AND i.id=m.item_id
    WHERE m.workspace=$1 AND m.id=$2 AND i.status='active' AND (i.valid_from IS NULL OR i.valid_from<=now()) AND (i.valid_until IS NULL OR i.valid_until>now())`,[workspace,id])).rows[0]); }
}
