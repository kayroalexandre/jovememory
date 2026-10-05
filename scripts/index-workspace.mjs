import { config, ensure, safeError } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Service } from '../src/service.mjs';
let store;
try {
  const [workspace,profileId,flag]=process.argv.slice(2);const c=config();
  ensure(workspace && profileId && c.provider.enabled,'CONFIG','Indexing requires explicit workspace, profile and ENABLE_PROVIDER=true.');
  const profile=c.profiles.find(p=>p.id===profileId);ensure(profile,'CONFIG','Choose a configured indexing profile.');
  store=new Store(c.databaseUrl);const service=new Service(store,c);let cursor,asOf,indexed=0,skipped=0;
  do {
    const page=await service.call('memory_list',{workspace,limit:100,...(cursor?{cursor,as_of:asOf}:{})},profile);
    for(const item of page.items) {if(item.embedding_model===c.provider.embeddingModel && flag!=='--force') {skipped++;continue;}
      await service.call('memory_index',{workspace,id:item.id},profile);indexed++;}
    cursor=page.next_cursor;asOf=page.as_of;
  } while(cursor);
  console.log(JSON.stringify({indexed,skipped}));
} catch(error) {console.error(JSON.stringify(safeError(error)));process.exitCode=1;} finally {await store?.close();}
