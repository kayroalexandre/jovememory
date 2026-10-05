import { readFile,realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve,relative } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsRequestSchema,CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { VERSION,ensure,hash,safeError,validateEndpoint } from './config.mjs';
import { identifyRepository,observeRepository } from './repository.mjs';
import { AGENT_INSTRUCTIONS } from './lifecycle.mjs';
async function externalFile(file,root) {
  const actual=await realpath(file),rel=relative(root,actual);ensure(rel==='..' || rel.startsWith('../'),'CONFIG','Broker configuration and credentials must live outside the project.');return actual;
}
export async function startBridge({directory=process.cwd(),configPath=process.env.JOVEMEMORY_BROKER_CONFIG || resolve(homedir(),'.config/jovememory/broker.json'),transport}={}) {
  let project,connectionError;
  try {project=await identifyRepository(directory);}catch(e){connectionError=e.code || 'REPOSITORY';}
  const server=new Server({name:'jovememory-project',version:VERSION},{capabilities:{tools:{listChanged:true}},instructions:AGENT_INSTRUCTIONS+(project?' Current repository: '+project.repository_name+'. The broker supplies the workspace; project credentials cannot read other projects.':' No repository is bound. Memory is unavailable until the client opens a Git repository with a canonical origin.')});
  let remote,expires=0,lastDigest,lastSync=0,syncing,syncError;
  async function connect() {
    const file=await externalFile(configPath,project.root),settings=JSON.parse(await readFile(file,'utf8'));
    validateEndpoint(settings.endpoint);const endpoint=new URL(settings.endpoint);ensure(endpoint.pathname==='/mcp','CONFIG','Broker endpoint must be the MCP endpoint.');
    const tokenFile=await externalFile(settings.provisioner_token_file,project.root),token=(await readFile(tokenFile,'utf8')).trim();
    const controller=new Client({name:'trusted-project-broker',version:VERSION});
    try {
      await controller.connect(new StreamableHTTPClientTransport(endpoint,{requestInit:{headers:{Authorization:'Bearer '+token}}}));
      const r=await controller.callTool({name:'memory_open_project',arguments:{repository_id:project.repository_id,repository_name:project.repository_name}});
      ensure(!r.isError,'ENROLLMENT','Project enrollment failed; no global workspace fallback is allowed.');
      const enrollment=r.structuredContent || JSON.parse(r.content[0].text);ensure(enrollment.workspace===project.repository_name && enrollment.repository_id===project.repository_id,'ENROLLMENT','Enrollment does not match this repository.');
      if(remote) await remote.close();remote=new Client({name:'scoped-project-client',version:VERSION});
      await remote.connect(new StreamableHTTPClientTransport(endpoint,{requestInit:{headers:{Authorization:'Bearer '+enrollment.token}}}));expires=Date.parse(enrollment.expires_at);
      const recovering=Boolean(connectionError);connectionError=null;if(recovering) await server.sendToolListChanged().catch(()=>{});
    } finally {await controller.close();}
  }
  async function sync(force=false) {
    if(!force && Date.now()-lastSync<2000) return;
    if(syncing) return syncing;
    syncing=(async()=>{
      if(!remote || Date.now()>expires-60000) await connect();
      const observation=await observeRepository(project),digest=hash(JSON.stringify(observation));
      if(digest!==lastDigest) {
        const r=await remote.callTool({name:'memory_sync_sources',arguments:{workspace:project.repository_name,...observation}});
        ensure(!r.isError,'SOURCE_SYNC','Source observation could not be persisted.');lastDigest=digest;
      }
      lastSync=Date.now();syncError=null;
    })().catch(e=>{syncError=e.code || 'SOURCE_SYNC';throw e;}).finally(()=>{syncing=null;});return syncing;
  }
  if(project) try {await connect();await sync(true);}catch(e){connectionError=e.code || 'CONNECTION';}
  const statusTool={name:'memory_connection_status',description:'Current repository binding and source observation status without credentials.',inputSchema:{type:'object',properties:{},additionalProperties:false}};
  server.setRequestHandler(ListToolsRequestSchema,async()=>{
    let tools=[];
    if(project && remote && !connectionError) {
      const catalog=await remote.listTools();tools=catalog.tools.filter(t=>t.name!=='memory_cross_workspace').map(t=>{
        const properties={...t.inputSchema.properties};delete properties.workspace;
        return {...t,inputSchema:{...t.inputSchema,properties,required:(t.inputSchema.required || []).filter(x=>x!=='workspace')}};
      });
    }
    return {tools:[statusTool,...tools]};
  });
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    if(request.params.name==='memory_connection_status') {
      if(project && connectionError) try {await connect();await sync(true);}catch(e){connectionError=e.code || 'CONNECTION';}
      const status={bound:Boolean(project && remote && !connectionError),repository_name:project?.repository_name || null,workspace:project?.repository_name || null,source_observation_error:syncError || connectionError || null,automatic_source_refresh_seconds:60};
      return {content:[{type:'text',text:JSON.stringify(status)}],structuredContent:status};
    }
    try {
      ensure(project && remote && !connectionError,'REPOSITORY','Open a Git repository and reconnect. There is no shared fallback workspace.');
      const name=request.params.name,args=request.params.arguments || {};
      ensure(!['memory_open_project','memory_overview','memory_revoke_project','memory_cross_workspace','memory_create_workspace','memory_link','memory_index'].includes(name),'FORBIDDEN','Administrative and cross-project operations are not exposed by this project connection.');
      ensure(!args.workspace || args.workspace===project.repository_name,'FORBIDDEN','Requested workspace is not this project.');
      const current=await identifyRepository(project.root);ensure(current.repository_id===project.repository_id,'PROJECT_CHANGED','Repository changed; reconnect memory.');
      try {await sync(true);}catch(e){if(e.code==='PROJECT_CHANGED') throw e;}
      const hasWorkspace=!['memory_version','memory_capabilities'].includes(name);
      const result=await remote.callTool({name,arguments:{...args,...(hasWorkspace?{workspace:project.repository_name}:{})}},undefined,{timeout:240000});
      if(syncError && result.structuredContent) {
        result.structuredContent={...result.structuredContent,degraded:[...(result.structuredContent.degraded || []),'source_observation_unavailable']};
        result.content=[{type:'text',text:JSON.stringify(result.structuredContent)}];
      }
      return result;
    }catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify(safeError(error))}]};}
  });
  const timer=project?setInterval(()=>{void sync(true).catch(()=>{});},60000):null;timer?.unref();
  server.onclose=()=>{if(timer) clearInterval(timer);void remote?.close();};
  await server.connect(transport || new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:8388608}));return server;
}
if(process.argv[1]===new URL(import.meta.url).pathname) {
  console.log=console.error;console.info=console.error;console.warn=console.error;
  try {await startBridge();}catch(e){console.error(JSON.stringify(safeError(e)));process.exitCode=1;}
}
