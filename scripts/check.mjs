import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function files(dir) {return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?files(dir+'/'+e.name):[dir+'/'+e.name]))).flat();}
for(const file of [...await files('src'),...await files('scripts'),...await files('test')].filter(f=>f.endsWith('.mjs'))) {
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  if(result.status!==0) {console.error(result.stderr);process.exit(1);}
}
const p=JSON.parse(await readFile('package.json','utf8'));const {VERSION}=await import('../src/config.mjs');
if(p.version!==VERSION) throw new Error('Version mismatch');
console.log('Syntax and version checks passed.');
