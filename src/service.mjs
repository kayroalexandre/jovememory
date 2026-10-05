import { TOOLS } from './schemas.mjs';
import { VERSION, authorize, ensure, hash, evidence, bounded, publicConfig } from './config.mjs';
import { planIngestion } from './ingest.mjs';
import { Provider } from './provider.mjs';
import { Media } from './media.mjs';
export function fuse(arms,limit) {
  const candidates=new Map();
  for(const [arm,rows] of Object.entries(arms)) rows.forEach((row,index)=>{
    const entry=candidates.get(row.id) || {...row,rrf_score:0,provenance:[]};
    entry.rrf_score+=1/(60+index+1);entry.provenance.push(arm);candidates.set(row.id,entry);
  });
  return [...candidates.values()].sort((a,b)=>b.rrf_score-a.rrf_score || a.id.localeCompare(b.id)).slice(0,limit);
}
export function isEligible(item,asOf=new Date().toISOString()) {
  return Boolean(item && item.status==='active' && (!item.valid_from || new Date(item.valid_from)<=new Date(asOf)) &&
    (!item.valid_until || new Date(item.valid_until)>new Date(asOf)));
}
export class Service {
  constructor(store,config,{provider,media}={}) {
    this.store=store;this.config=config;this.provider=provider || new Provider(config.provider);this.media=media || new Media(config.s3);
  }
  available(profile) { return Object.values(TOOLS).filter(tool=>{try {authorize(profile,tool.permission);return true;}catch{return false;}}); }
  writeResult(workspace,item,extra={}) {
    return {workspace,item,outcome:item.status==='active'?'accepted':'proposed',review_required:item.status==='proposed',...extra};
  }
  async call(name,input,profile) {
    const tool=TOOLS[name];ensure(tool,'TOOL','Unknown tool.');
    const parsed=tool.schema.safeParse(input);ensure(parsed.success,'INPUT','Arguments do not match the strict tool schema.');
    const a=parsed.data;authorize(profile,tool.permission,a.workspace);
    ensure(!(a.valid_from && a.valid_until) || new Date(a.valid_from)<new Date(a.valid_until),'DATE','Validity end must follow start.');
    const result=await this.dispatch(name,a,profile);
    ensure(Buffer.byteLength(JSON.stringify(result))<=8388608,'LIMIT','Tool result exceeds 8 MiB; reduce page or content size.');return result;
  }
  async references(workspace,ids,strict=true) {
    ensure(new Set(ids).size===ids.length,'INPUT','References must be unique.');
    const values=[];
    for(const id of ids) {
      const item=await this.store.read(workspace,id);
      if(strict) ensure(isEligible(item),'REFERENCE','References must identify currently eligible local items.');
      values.push({id,content_hash:item?.content_hash || null,eligible:isEligible(item)});
    }
    return values;
  }
  async diagnose(workspace,references) {
    const values=[];
    for(const ref of references || []) {
      const item=await this.store.read(workspace,ref.id);
      values.push({...ref,current_hash:item?.content_hash || null,eligible:isEligible(item),unchanged:item?.content_hash===ref.content_hash});
    }
    return values;
  }
  async search(a) {
    const asOf=a.as_of || new Date().toISOString(), size=Math.min(100,a.limit*3);
    const arms={},degraded=[];
    arms.lexical=await this.store.lexical(a.workspace,a.query,size,asOf);
    if(this.config.provider.enabled) {
      try { const vector=await this.provider.embed(a.query);arms.semantic=await this.store.semantic(a.workspace,vector,this.config.provider.embeddingModel,size,asOf); }
      catch {degraded.push('semantic_unavailable');}
    } else degraded.push('semantic_disabled');
    const seeds=fuse(arms,size).map(x=>x.id);
    arms.graph=await this.store.graph(a.workspace,seeds,size,asOf);
    // Recency only ranks matches; unrelated recent items must not fill an empty lexical search.
    arms.temporal=(await this.store.eligible(a.workspace,[...new Set([...seeds,...arms.graph.map(r=>r.id)])],asOf))
      .sort((x,y)=>new Date(y.created_at)-new Date(x.created_at));
    let results=fuse(arms,a.limit);
    if(a.rerank) {
      const rankings=[];
      try {
        for(const item of results) rankings.push({...item,rerank_score:await this.provider.decision({query:a.query,content:item.content},'Score relevance of this source to this query.')});
        results=rankings.sort((x,y)=>y.rerank_score-x.rerank_score);
      } catch {degraded.push('rerank_unavailable');}
    }
    return {workspace:a.workspace,results,as_of:asOf,degraded,thresholds:this.config.thresholds,evidence:{...evidence,retrieval_incomplete:degraded.length>0},
      lexical_engine:'postgresql_portuguese_fts',vector_engine:'pgvector_exact',vector_similarity_floor:null};
  }
  async dispatch(name,a,p) {
    const s=this.store,w=a.workspace,actor=p.id,automatic=this.config.reviewMode==='automatic';
    switch(name) {
      case 'memory_version': return {name:'jovememory',version:VERSION,workspaces:(await s.workspaces()).filter(x=>p.workspaces.includes('*') || p.workspaces.includes(x)),evidence};
      case 'memory_capabilities': return {...publicConfig(this.config),profile:{id:actor,role:p.role,workspaces:p.workspaces},tools:this.available(p).map(t=>t.name),review:automatic?'automatic':'separate_profile_required',transports:['stdio','streamable-http']};
      case 'memory_search': return this.search(a);
      case 'memory_read': {const item=await s.read(w,a.id);if(item) item.links=item.links.filter(link=>p.workspaces.includes('*') || p.workspaces.includes(link.target_workspace));return {workspace:w,item,evidence};}
      case 'memory_tree':return {workspace:w,nodes:await s.tree(w)};
      case 'memory_list': {const page=await s.page(w,a);return {workspace:w,...page,items:page.items.map(({content,metadata,...item})=>item)};}
      case 'memory_propose_write': return this.writeResult(w,await s.propose(w,a,actor,automatic));
      case 'memory_write': {
        let gate={status:'skipped',threshold:this.config.thresholds.write,calibrated:false};
        try {const score=await this.provider.decision({workspace:w,content:a.content},'Score whether this is durable knowledge: an explicit fact, decision, preference, constraint or procedure.');gate={...gate,status:score>=gate.threshold?'recommended':'below_threshold',score};}
        catch {gate.status='unavailable';}
        return this.writeResult(w,await s.propose(w,{...a,gate},actor,automatic),{gate});
      }
      case 'memory_review':return {workspace:w,...await s.review(w,a.id,a.action==='accept',a.reason,actor)};
      case 'memory_list_proposed':return {workspace:w,...await s.page(w,{...a,status:'proposed'})};
      case 'memory_update_item':return this.writeResult(w,await s.update(w,a.id,{content:a.content,valid_from:a.valid_from,valid_until:a.valid_until},a.reason,actor,automatic));
      case 'memory_delete':return {workspace:w,...await s.mutate(w,a.id,'delete',actor,{reason:a.reason})};
      case 'memory_move_item':return {workspace:w,...await s.mutate(w,a.id,'move',actor,{node:a.node,reason:a.reason})};
      case 'memory_feedback':return {workspace:w,...await s.mutate(w,a.id,'feedback',actor,{useful:a.useful,reason:a.reason})};
      case 'memory_ingest_markdown':case 'memory_ingest_project': {
        const plan=planIngestion(w,a.files || [{source:a.source,content:a.content}]);
        if(a.dry_run) return {...plan,mode:automatic?'automatic':'proposed',review_required:!automatic,sections:plan.sections.map(({content,...section})=>({...section,bytes:Buffer.byteLength(content)}))};
        ensure(a.plan_hash===plan.plan_hash,'PLAN','Apply requires the unchanged preview plan hash.');
        return {workspace:w,...await s.ingestion(w,plan,actor,automatic),review_required:!automatic};
      }
      case 'memory_context': {
        const search=await this.search(a),results=[];
        let gaps=0;
        for(const candidate of search.results) {
          const item=await s.read(w,candidate.id);
          if(!isEligible(item,search.as_of)) {gaps++;continue;}
          results.push({id:item.id,workspace:w,content:item.content,content_hash:item.content_hash,created_at:item.created_at,
            valid_from:item.valid_from,valid_until:item.valid_until,provenance:candidate.provenance,observed_at:new Date().toISOString()});
        }
        return bounded({workspace:w,results,gaps,as_of:search.as_of,evidence:search.evidence,degraded:search.degraded,thresholds:search.thresholds},a.max_bytes);
      }
      case 'memory_checkpoint': {
        const metadata={contract:1,session:a.session,title:a.title,next_steps:a.next_steps,references:await this.references(w,a.references)};
        return this.writeResult(w,await s.propose(w,{content:a.summary,kind:'checkpoint',metadata},actor,automatic));
      }
      case 'memory_resume': {
        const page=await s.page(w,{...a,kind:'checkpoint'}),checkpoints=[];
        for(const item of page.items) {
          if(a.session && item.metadata.session!==a.session) continue;
          checkpoints.push({...item,reference_diagnostics:await this.diagnose(w,item.metadata.references)});
        }
        return bounded({workspace:w,checkpoints,next_cursor:page.next_cursor,as_of:page.as_of,evidence},a.max_bytes);
      }
      case 'memory_record': {
        ensure(a.basis!=='measured' || (a.observed_at && a.references.length),'RECORD','Measured records require observation date and local references.');
        const {workspace,statement,references,...metadata}=a;
        metadata.references=await this.references(w,references);metadata.contract=1;
        return this.writeResult(w,await s.propose(w,{content:statement,kind:'record',metadata,valid_until:a.expires_at},actor,automatic));
      }
      case 'memory_project': {
        const page=await s.page(w,{...a,kind:'record'}),records=[],ambiguities=[],values=new Map();
        for(const item of page.items) {
          const metadata=item.metadata,logicalKey=metadata.kind+':'+metadata.key;
          if(values.has(logicalKey) && values.get(logicalKey)!==item.content) ambiguities.push({key:logicalKey,id:item.id,reason:'different_active_statements'});
          values.set(logicalKey,item.content);
          records.push({...item,contract_valid:metadata.contract===1 && Boolean(metadata.key && metadata.basis),reference_diagnostics:await this.diagnose(w,metadata.references)});
        }
        return bounded({workspace:w,records,ambiguities,page_only:true,next_cursor:page.next_cursor,as_of:page.as_of,evidence},a.max_bytes);
      }
      case 'memory_consolidate': {
        ensure(new Set(a.ids).size===a.ids.length,'INPUT','Consolidation IDs must be unique.');
        const sources=await s.eligible(w,a.ids);ensure(sources.length===a.ids.length,'STATE','Consolidation requires eligible sources.');
        ensure(Buffer.byteLength(sources.map(x=>x.content).join('\n\n---\n\n'))<=262144,'LIMIT','Consolidation exceeds content limit.');
        const planHash=hash(JSON.stringify(sources.map(x=>({id:x.id,content_hash:x.content_hash,node:x.node}))));
        if(a.dry_run) return {workspace:w,plan_hash:planHash,sources,review_required:!automatic};
        ensure(a.plan_hash===planHash,'PLAN','Consolidation requires its unchanged preview hash.');
        return this.writeResult(w,await s.consolidate(w,a.ids,planHash,actor,automatic));
      }
      case 'memory_stats':return {workspace:w,...await s.stats(w),thresholds:this.config.thresholds};
      case 'memory_doctor':return {workspace:w,...await s.health(),...await s.stats(w),storage:this.config.s3 ? 'configured_not_probed':'not_configured',provider:'not_probed'};
      case 'memory_mutations':return {workspace:w,mutations:await s.mutations(w,a)};
      case 'memory_create_node':return {workspace:w,node:await s.node(w,a.node,a.label,a.parent,actor)};
      case 'memory_link': {
        authorize(p,'admin',a.target_workspace);
        if(a.target_id) ensure(await s.read(a.target_workspace,a.target_id),'REFERENCE','Target item does not exist.');
        return {workspace:w,...await s.link(w,a.target_workspace,a.source_id,a.target_id,a.relation,actor)};
      }
      case 'memory_cross_workspace': {
        const results=[],traversal=[];
        for(const link of await s.crossLinks(w)) {
          if(!p.workspaces.includes('*') && !p.workspaces.includes(link.target_workspace)) continue;
          try {
            const score=await this.provider.decision({query:a.query,relation:link.relation},'Score whether traversing this declared workspace relationship is relevant to this query.');
            if(score<this.config.thresholds.cross) {traversal.push({workspace:link.target_workspace,status:'below_threshold',score});continue;}
            const search=await this.search({...a,workspace:link.target_workspace});
            results.push(...search.results.map(x=>({...x,workspace:link.target_workspace})));traversal.push({workspace:link.target_workspace,status:'traversed',score,degraded:search.degraded});
          } catch {traversal.push({workspace:link.target_workspace,status:'gate_unavailable_closed'});}
        }
        return {workspace:w,results:results.slice(0,a.limit),traversal,thresholds:this.config.thresholds,evidence};
      }
      case 'memory_index': {
        const item=await s.read(w,a.id);ensure(isEligible(item),'STATE','Only eligible reviewed items can be indexed.');
        const vector=await this.provider.embed(item.content);return {workspace:w,...await s.embed(w,a.id,vector,this.config.provider.embeddingModel,item.content_hash,actor)};
      }
      case 'memory_attach_media': {
        const item=await s.read(w,a.item_id);ensure(isEligible(item),'STATE','Media requires an eligible reviewed parent item.');
        const data=await this.media.upload(w,a.item_id,a.base64,a.mime,a.extracted_text);
        const degraded=[];
        try {
          if(this.config.provider.enabled && (data.extracted_text || data.mime.startsWith('image/'))) {
            try {data.embedding=data.extracted_text ? await this.provider.embed(data.extracted_text):await this.provider.embedImage(a.base64,data.mime);data.embedding_model=this.config.provider.embeddingModel;}
            catch {degraded.push('semantic_index_unavailable');}
          }
          ensure(isEligible(await s.read(w,a.item_id)),'STATE','Media parent changed during upload.');
          const saved=await s.addMedia(w,data,actor);
          if(saved.id!==data.id) await this.media.remove(data.object_key).catch(()=>{});
          return {workspace:w,media:saved,extraction_status:data.extraction_status,degraded};
        } catch(error) {await this.media.remove(data.object_key).catch(()=>{});throw error;}
      }
      case 'memory_read_media': {
        const pointer=await s.mediaPointer(w,a.id);ensure(pointer,'MEDIA','Eligible media was not found.');return {workspace:w,...await this.media.read(pointer)};
      }
      case 'memory_search_media': {
        const asOf=a.as_of || new Date().toISOString();let result=await s.mediaSearch(w,a.query,a.limit,asOf);const degraded=[];
        if(!result.results.length) {
          try {const vector=await this.provider.embed(a.query);result=await s.mediaSearch(w,a.query,a.limit,asOf,vector,this.config.provider.embeddingModel);}
          catch {degraded.push('semantic_fallback_unavailable');}
        }
        return {workspace:w,...result,degraded,evidence:{...evidence,retrieval_incomplete:degraded.length>0}};
      }
      default:ensure(false,'TOOL','Tool implementation is missing.');
    }
  }
}
