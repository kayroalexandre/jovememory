import { z } from 'zod';
import { WORKSPACE_PATTERN } from './config.mjs';
const workspace=z.string().regex(WORKSPACE_PATTERN);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const locator=z.string().min(1).max(512).refine(v=>!/[\\:\x00-\x1f\x7f]/.test(v) && !v.startsWith('/') && !v.split('/').some(x=>['','..','.'].includes(x)),'Expected a safe repository-relative locator.');
const source_refs=z.array(z.strictObject({locator,sha256:digest})).max(100);
const id=z.uuid();
const content=z.string().min(1).max(262144).refine(v=>Buffer.byteLength(v)<=262144,'Content exceeds 256 KiB.');
const date=z.iso.datetime({offset:true});
const reason=z.string().min(1).max(1024);
const node=z.string().min(1).max(200);
const limit=z.number().int().min(1).max(100).default(20);
const query=z.string().min(1).max(8192);
const references=z.array(id).max(50).default([]);
const max_bytes=z.number().int().min(1024).max(262144).default(16384);
const validity={valid_from:date.optional(),valid_until:date.optional()};
const page={workspace,limit,cursor:z.string().max(4096).optional(),as_of:date.optional()};
const proposal={workspace,id:id.optional(),node:node.optional(),content,...validity,source_refs:source_refs.optional()};
const file=z.strictObject({source:z.string().min(1).max(512),content:z.string().max(2097152)});
const definitions={
  memory_open_project:['provision','Enroll a Git repository and issue a short-lived writer credential. Trusted local broker only; never expose the returned token to an agent.',{repository_id:digest,repository_name:workspace}],
  memory_revoke_project:['admin','Invalidate all issued dynamic credentials for this project; static profiles are independent.',{workspace,reason}],
  memory_overview:['observe','Global authorized project health and usage metrics without memory content; observer role cannot read any project corpus.',{limit,after:workspace.optional()}],
  memory_agent_guide:['read','Project-scoped agent guidance for source verification, updates, retirement and continuity.',{workspace}],
  memory_sync_sources:['write','Observe repository-relative hashes; no file content or execution. Missing/changed files do not automatically declare facts false.',{workspace,revision:z.string().regex(/^[a-f0-9]{40,64}$/).optional(),complete:z.boolean().default(false),sources:z.array(z.strictObject({locator,sha256:digest.nullable(),present:z.boolean()})).max(5000)}],
  memory_sources:['read','Observed source hashes and revisions only, paginated by locator.',{workspace,limit,after:locator.optional()}],
  memory_changes:['read','Audited changes since a monotonic sequence; no corpus snapshots in this feed.',{workspace,limit,after:z.number().int().nonnegative().default(0)}],
  memory_maintenance:['read','Paginated lifecycle diagnostics, outdated references and ambiguous record keys; no automatic truth judgments.',{...page}],
  memory_revalidate:['write','Bind an active memory to observed current source hashes without changing its text; does not certify that tests passed.',{workspace,id,content_hash:digest,source_refs,reason}],
  memory_retire:['write','Retire an obsolete active fact with an audited reason, preserving history and corpus. Automatic policy does not need another reviewer.',{workspace,id,reason}],
  memory_create_workspace:['admin','Provision an isolated workspace idempotently and audit its creation; does not grant client permissions.',{workspace}],
  memory_version:['read','Version and authorized workspaces.',{}],
  memory_capabilities:['read','Effective permissions, real tools and limits without secrets.',{}],
  memory_search:['read','Hybrid candidates with per-arm provenance and degradation.',{workspace,query,limit,as_of:date.optional(),rerank:z.boolean().default(true)}],
  memory_read:['read','Read an item, media metadata and links.',{workspace,id}],
  memory_tree:['read','Workspace node tree and active item counts.',{workspace}],
  memory_list:['read','Cursor page of scoped metadata.',{...page,status:z.enum(['active','proposed','invalidated','deleted','rejected']).default('active'),node:node.optional()}],
  memory_write:['write','Write and index memory with an advisory decision gate. Set enrich=true only when server-side structuring adds value.',{...proposal,enrich:z.boolean().default(false)}],
  memory_propose_write:['write','Write without model analysis under the configured policy; active items are indexed when the provider is enabled.',proposal],
  memory_review:['review','Review another profile\'s proposal atomically.',{workspace,id,action:z.enum(['accept','reject']),reason}],
  memory_list_proposed:['read','Page of proposals awaiting review.',page],
  memory_update_item:['write','Create a new version under the configured write policy, preserving audited history.',{workspace,id,content,reason,...validity,source_refs:source_refs.optional(),enrich:z.boolean().default(false)}],
  memory_delete:['review','Soft-delete with an audit reason.',{workspace,id,reason}],
  memory_move_item:['write','Move a reviewed item to an existing workspace node.',{workspace,id,node,reason}],
  memory_ingest_markdown:['write','Preview or apply a content-hashed Markdown ingestion.',{workspace,source:file.shape.source,content:file.shape.content,dry_run:z.boolean().default(true),plan_hash:z.string().regex(/^[a-f0-9]{64}$/).optional()}],
  memory_ingest_project:['write','Preview or apply an atomic manifest; server never opens source paths.',{workspace,files:z.array(file).min(1).max(100),dry_run:z.boolean().default(true),plan_hash:z.string().regex(/^[a-f0-9]{64}$/).optional()}],
  memory_attach_media:['write','Attach bytes privately with a SHA-256 pointer and extracted text.',{workspace,item_id:id,base64:z.string().max(5592408),mime:z.string().max(100),extracted_text:content.optional()}],
  memory_search_media:['read','Lexical media search with optional semantic fallback and parent validity.',{workspace,query,limit,as_of:date.optional()}],
  memory_cross_workspace:['read','Traverse explicit workspace links through a fail-closed relevance gate.',{workspace,query,limit}],
  memory_consolidate:['write','Preview and apply a lossless consolidation under the configured write policy.',{workspace,ids:z.array(id).min(2).max(50),dry_run:z.boolean().default(true),plan_hash:z.string().regex(/^[a-f0-9]{64}$/).optional(),summarize:z.boolean().default(false)}],
  memory_doctor:['read','Read-only database/schema health and embedding coverage.',{workspace}],
  memory_stats:['read','Workspace counts, coverage and declared thresholds.',{workspace}],
  memory_mutations:['read','Append-only audit page projected to sequence, operation, actor and declared details; item content is not returned.',{workspace,id:id.optional(),operation:z.string().max(64).optional(),limit,after:z.number().int().nonnegative().default(0)}],
  memory_feedback:['write','Audited importance step of 0.05 with a reason.',{workspace,id,useful:z.boolean(),reason}],
  memory_context:['read','Re-read eligible candidates into a bounded evidence package.',{workspace,query,limit,max_bytes,as_of:date.optional(),rerank:z.boolean().default(true),synthesize:z.boolean().default(false)}],
  memory_checkpoint:['write','Save structured continuity with hashed references under the configured write policy.',{workspace,session:z.string().min(1).max(128),title:z.string().min(1).max(256),summary:content,next_steps:z.array(z.string().max(1024)).max(50).default([]),references}],
  memory_resume:['read','Read active checkpoints and diagnose current source eligibility.',{...page,session:z.string().max(128).optional(),max_bytes}],
  memory_record:['write','Save a typed record; replace the prior active kind/key atomically by default, preserving history. replace_key=false intentionally keeps divergent claims.',{workspace,kind:z.enum(['goal','decision','constraint','evidence','issue','procedure']),key:z.string().min(1).max(200),title:z.string().min(1).max(256),statement:content,basis:z.enum(['asserted','measured','inferred']),authority:z.enum(['canonical','supporting','historical']).default('supporting'),locator:locator.optional(),observed_at:date.optional(),expires_at:date.optional(),references,source_refs:source_refs.optional(),replace_key:z.boolean().default(true)}],
  memory_project:['read','Bounded project record page, ambiguities and reference diagnostics.',{...page,max_bytes}],
  memory_create_node:['write','Create a workspace node without overwriting existing metadata.',{workspace,node,label:z.string().min(1).max(200),parent:node.optional()}],
  memory_link:['admin','Declare a graph edge; both workspaces must be authorized.',{workspace,target_workspace:workspace,source_id:id.optional(),target_id:id.optional(),relation:z.string().min(1).max(200)}],
  memory_index:['admin','Index a reviewed item using the explicitly enabled cloud model.',{workspace,id}],
  memory_read_media:['read','Retrieve private media bytes with hash verification.',{workspace,id}]
};
export const TOOLS=Object.fromEntries(Object.entries(definitions).map(([name,[permission,description,shape]])=>[name,{name,permission,description,schema:z.strictObject(shape)}]));
