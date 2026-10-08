import { readFile,realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve,relative } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsRequestSchema,CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { VERSION,ensure,hash,safeError,validateEndpoint } from './config.mjs';
import { identifyRepository,observeRepository,observeRepositoryState } from './repository.mjs';
import { AGENT_INSTRUCTIONS } from './lifecycle.mjs';
async function externalFile(file,root) {
  const actual=await realpath(file),rel=relative(root,actual);ensure(rel==='..' || rel.startsWith('../'),'CONFIG','Broker configuration and credentials must live outside the project.');return actual;
}
// The only tools the broker will ever forward through the global read credential.
const OBSERVATORY_TOOLS=new Set(['memory_overview']);
export async function startBridge({directory=process.cwd(),configPath=process.env.JOVEMEMORY_BROKER_CONFIG || resolve(homedir(),'.config/jovememory/broker.json'),transport}={}) {
  let project,connectionError;
  try {project=await identifyRepository(directory);}catch(e){connectionError=e.code || 'REPOSITORY';}
  const server=new Server({name:'jovememory-project',version:VERSION},{capabilities:{tools:{listChanged:true}},instructions:AGENT_INSTRUCTIONS+(project?' Current repository: '+project.repository_name+'. The broker supplies the workspace; project credentials cannot read other projects.':' No repository is bound to a repository. The observatory, which needs no repository, may still be available.')});
  let remote,observer,observerTools=[],observerConfigured=false,observerSyncing=null,expires=0,lastDigest,lastState,lastSync=0,syncing,syncError,observerError;
  // The observatory is global, so it also works without a bound repository. With no repository
  // there is no tree to escape, so the working directory is the boundary.
  const boundaryRoot=()=>project?.root || directory;
  async function readSettings() {return JSON.parse(await readFile(await externalFile(configPath,boundaryRoot()),'utf8'));}
  async function connect() {
    const settings=await readSettings();
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
  // The observatory is a second credential of the same server, served by this process.
  // The agent sees one memory namespace and never holds the global read token itself.
  // Only these tools are ever routed through it. Relying on the credential's role alone would
  // make a misconfigured token_file a global privilege passthrough, so the role is verified too.
  async function connectObserver() {
    if(observerSyncing) return observerSyncing;
    let candidate=null;
    observerSyncing=(async()=>{
      try {
        const settings=await readSettings();
        observerConfigured=Boolean(settings?.observer);
        if(!observerConfigured) {await dropObserver();return;}
        validateEndpoint(settings.observer.endpoint || settings.endpoint);
        const endpoint=new URL(settings.observer.endpoint || settings.endpoint);ensure(endpoint.pathname==='/mcp','CONFIG','Observer endpoint must be the MCP endpoint.');
        const tokenFile=await externalFile(settings.observer.token_file,boundaryRoot()),token=(await readFile(tokenFile,'utf8')).trim();
        await dropObserver();
        candidate=new Client({name:'scoped-observer-client',version:VERSION});
        await candidate.connect(new StreamableHTTPClientTransport(endpoint,{requestInit:{headers:{Authorization:'Bearer '+token}}}));
        // Verify the credential's effective capability, not its label: an observer profile cannot
        // even call memory_capabilities, and a misconfigured token must not become a passthrough.
        const catalog=await candidate.listTools();
        const advertised=catalog.tools.map(t=>t.name);
        ensure([...OBSERVATORY_TOOLS].every(name=>advertised.includes(name)),'OBSERVER_ROLE','The observer credential does not expose the observatory tools.');
        ensure(advertised.every(name=>OBSERVATORY_TOOLS.has(name)),'OBSERVER_ROLE','The observer credential exposes tools beyond the observatory contract; use an observer profile.');
        observerTools=catalog.tools.filter(t=>OBSERVATORY_TOOLS.has(t.name));
        observer=candidate;candidate=null;observerError=null;
      } catch(error) {if(candidate) await candidate.close().catch(()=>{});await dropObserver();observerError=error.code || 'OBSERVER';}
    })().finally(()=>{observerSyncing=null;});return observerSyncing;
  }
  async function dropObserver() {if(observer) {const dead=observer;observer=null;await dead.close().catch(()=>{});}observerTools=[];}
  async function sync(force=false,knownState) {
    if(!force && Date.now()-lastSync<2000) return;
    if(syncing) return syncing;
    syncing=(async()=>{
      if(!remote || Date.now()>expires-60000) await connect();
      const state=knownState ?? await observeRepositoryState(project.root);
      // An unchanged tree yields identical hashes, so the expensive re-hash is skipped.
      if(state===lastState) {lastSync=Date.now();syncError=null;return;}
      const observation=await observeRepository(project),digest=hash(JSON.stringify(observation));
      if(digest!==lastDigest) {
        const r=await remote.callTool({name:'memory_sync_sources',arguments:{workspace:project.repository_name,...observation}});
        ensure(!r.isError,'SOURCE_SYNC','Source observation could not be persisted.');lastDigest=digest;
      }
      lastState=state;lastSync=Date.now();syncError=null;
    })().catch(e=>{syncError=e.code || 'SOURCE_SYNC';throw e;}).finally(()=>{syncing=null;});return syncing;
  }
  // A tool call re-hashes only when the working tree actually changed or the refresh window elapsed.
  const SYNC_INTERVAL_MS=60000;
  const refresh=async()=>{
    if(!project) return;
    if(Date.now()-lastSync<SYNC_INTERVAL_MS) {
      const state=await observeRepositoryState(project.root);
      if(state===lastState) return;
      return sync(true,state);
    }
    return sync(true);
  };
  if(project) try {await connect();await sync(true);}catch(e){connectionError=e.code || 'CONNECTION';}
  await connectObserver();
  const statusTool={name:'memory_connection_status',description:'Current repository binding, source observation status and observatory availability, without credentials.',inputSchema:{type:'object',properties:{},additionalProperties:false}};
  // The agent never names a workspace: the broker injects the project one and withholds every other.
  const withoutWorkspace=tool=>{
    const properties={...tool.inputSchema.properties};delete properties.workspace;
    return {...tool,inputSchema:{...tool.inputSchema,properties,required:(tool.inputSchema.required || []).filter(x=>x!=='workspace')}};
  };
  server.setRequestHandler(ListToolsRequestSchema,async()=>{
    let tools=[];
    if(project && remote && !connectionError) {
      // A failing project endpoint must not take the global observatory down with it.
      try {
        const catalog=await remote.listTools();
        // The project credential cannot see the observatory; its tools come from the observer catalog.
        tools=catalog.tools.filter(t=>t.name!=='memory_cross_workspace' && !observerTools.some(o=>o.name===t.name)).map(withoutWorkspace);
      } catch {tools=[];}
    }
    return {tools:[statusTool,...tools,...observerTools.map(withoutWorkspace)]};
  });
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    if(request.params.name==='memory_connection_status') {
      // A dropped credential nulls remote; a status probe should heal it, not just report it.
      if(project && (!remote || connectionError)) try {await connect();await sync(true);}catch(e){connectionError=e.code || 'CONNECTION';}
      if(observerConfigured && (!observer || observerError)) void connectObserver();
      const status={bound:Boolean(project && remote && !connectionError),repository_name:project?.repository_name || null,workspace:project?.repository_name || null,source_observation_error:syncError || connectionError || null,automatic_source_refresh_seconds:60,
        observatory:{configured:observerConfigured,connected:Boolean(observer && !observerError),tools:observerTools.map(t=>t.name),error:observerError}};
      return {content:[{type:'text',text:JSON.stringify(status)}],structuredContent:status};
    }
    if(OBSERVATORY_TOOLS.has(request.params.name)) {
      try {
        ensure(observer && !observerError,'OBSERVER','The observatory connection is not available; project memory still works.');
        // Forward arguments verbatim except a workspace the agent is never allowed to name.
        const forwarded=Object.fromEntries(Object.entries(request.params.arguments || {}).filter(([key])=>key!=='workspace'));
        return await observer.callTool({name:request.params.name,arguments:forwarded},undefined,{timeout:240000});
      } catch(error) {
        // A dropped or rotated credential must be noticed, or the catalog would claim a tool that fails.
        if(!error?.code || error.code==='INTERNAL') {await dropObserver();observerError='OBSERVER_UNAVAILABLE';void server.sendToolListChanged().catch(()=>{});}
        return {isError:true,content:[{type:'text',text:JSON.stringify(safeError(error))}]};
      }
    }
    try {
      // A nulled remote is a dropped or rotated credential, not a missing repository: try to
      // re-enroll before refusing, so a rotation costs one failed call instead of a restart.
      if(project && !remote && !connectionError) try {await connect();}catch(e){connectionError=e.code || 'CONNECTION';}
      ensure(project && remote && !connectionError,'REPOSITORY','Open a Git repository and reconnect. There is no shared fallback workspace.');
      const name=request.params.name,args=request.params.arguments || {};
      ensure(!['memory_open_project','memory_overview','memory_revoke_project','memory_cross_workspace','memory_create_workspace','memory_link','memory_index'].includes(name),'FORBIDDEN','Administrative and cross-project operations are not exposed by this project connection.');
      ensure(!args.workspace || args.workspace===project.repository_name,'FORBIDDEN','Requested workspace is not this project.');
      const current=await identifyRepository(project.root);ensure(current.repository_id===project.repository_id,'PROJECT_CHANGED','Repository changed; reconnect memory.');
      try {await refresh();}catch(e){if(e.code==='PROJECT_CHANGED') throw e;}
      const hasWorkspace=!['memory_version','memory_capabilities'].includes(name);
      let result;
      try {
        result=await remote.callTool({name,arguments:{...args,...(hasWorkspace?{workspace:project.repository_name}:{})}},undefined,{timeout:240000});
      } catch(error) {
        // A transport or credential failure (rotated signing key, dropped connection) must not
        // leave the broker holding a dead credential until the token expires. Drop it so the
        // next call re-enrolls; an isError result means the credential was accepted, and the
        // broker's own Faults above never reach this hook.
        remote=null;void server.sendToolListChanged().catch(()=>{});
        throw error;
      }
      if(syncError && result.structuredContent) {
        result.structuredContent={...result.structuredContent,degraded:[...(result.structuredContent.degraded || []),'source_observation_unavailable']};
        result.content=[{type:'text',text:JSON.stringify(result.structuredContent)}];
      }
      return result;
    }catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify(safeError(error))}]};}
  });
  // The observer is reconnected on the same window, so a dropped or rotated credential recovers.
  const timer=setInterval(()=>{
    void refresh().catch(()=>{});
    if(observerConfigured && (!observer || observerError)) void connectObserver();
  },SYNC_INTERVAL_MS);timer.unref();
  server.onclose=()=>{if(timer) clearInterval(timer);void remote?.close();void observer?.close();};
  await server.connect(transport || new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:8388608}));return server;
}
if(process.argv[1]===new URL(import.meta.url).pathname) {
  console.log=console.error;console.info=console.error;console.warn=console.error;
  try {await startBridge();}catch(e){console.error(JSON.stringify(safeError(e)));process.exitCode=1;}
}
