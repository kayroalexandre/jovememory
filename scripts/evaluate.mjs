import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { config, ensure, safeError, WORKSPACE_PATTERN } from '../src/config.mjs';
import { externalDirectory } from './backup-lib.mjs';
import { retrievalMetrics, calibration } from '../src/metrics.mjs';
import { Store } from '../src/store.mjs';
import { Service } from '../src/service.mjs';
let store;
try {
  const [mode,file,profileId,...flags]=process.argv.slice(2);
  ensure(file,'EVALUATION','Supply an external private labeled JSON dataset.');
  await externalDirectory(dirname(resolve(file)));
  const bytes=await readFile(file);ensure(bytes.length<=2097152,'LIMIT','Labeled dataset exceeds 2 MiB.');
  const data=JSON.parse(bytes);
  if(mode==='calibration') {
    const schema=z.array(z.strictObject({score:z.number().min(0).max(1),relevant:z.boolean(),split:z.enum(['training','holdout'])})).min(2).max(10000);
    console.log(JSON.stringify(calibration(schema.parse(data)),null,2));
  } else {
    ensure(mode==='retrieval','EVALUATION','Modes: retrieval or calibration.');
    // The workspace naming contract is the 0.5.0 one: Git-style ASCII names with dots, case and up to 100 characters.
    const cases=z.array(z.strictObject({workspace:z.string().regex(WORKSPACE_PATTERN),query:z.string().min(1).max(8192),expected:z.array(z.uuid()).max(100)})).min(1).max(1000).parse(data);
    const c=config();ensure(!c.provider.enabled || flags.includes('--allow-provider'),'EVALUATION','Paid evaluation requires --allow-provider in addition to ENABLE_PROVIDER=true.');
    const profile=c.profiles.find(p=>p.id===profileId);ensure(profile,'CONFIG','Choose an explicit configured profile.');
    store=new Store(c.databaseUrl);const service=new Service(store,c),results=[];let degraded=0;
    for(const row of cases) {const result=await service.call('memory_search',{workspace:row.workspace,query:row.query,limit:10,rerank:flags.includes('--rerank')},profile);
      if(result.degraded.length) degraded++;results.push({expected:row.expected,actual:result.results.map(r=>r.id)});}
    console.log(JSON.stringify({...retrievalMetrics(results),degraded_queries:degraded,thresholds:c.thresholds,rerank:flags.includes('--rerank')},null,2));
  }
} catch(error) {console.error(JSON.stringify(safeError(error)));process.exitCode=1;} finally {await store?.close();}
