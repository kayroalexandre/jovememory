import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION, safeError } from './config.mjs';
import { AGENT_INSTRUCTIONS } from './lifecycle.mjs';
export function createMcp(service,profile) {
  const server=new McpServer({name:'jovememory',version:VERSION},{instructions:AGENT_INSTRUCTIONS});
  for(const tool of service.available(profile)) {
    server.registerTool(tool.name,{description:tool.description,inputSchema:tool.schema,
      annotations:{readOnlyHint:['read','observe'].includes(tool.permission),destructiveHint:tool.permission==='review',openWorldHint:['write','provision'].includes(tool.permission) || ['memory_search','memory_context','memory_review','memory_cross_workspace','memory_index','memory_read_media','memory_search_media'].includes(tool.name)}},async args=>{
      try {const result=await service.call(tool.name,args,profile);return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};}
      catch(error) {return {isError:true,content:[{type:'text',text:JSON.stringify(safeError(error))}]};}
    });
  }
  return server;
}
