import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function files(dir) {return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?files(dir+'/'+e.name):[dir+'/'+e.name]))).flat();}
// The newest documented release must be the one the package and the runtime declare.
export function changelogVersions(text) {return [...text.matchAll(/^##\s+v?(\d+\.\d+\.\d+)/gm)].map(m=>m[1]);}
export async function verifyVersion(files) {
  const [{VERSION},pkg,changelog]=await Promise.all([
    import('../src/config.mjs'),
    readFile('package.json','utf8').then(JSON.parse),
    readFile('CHANGELOG.md','utf8')]);
  const documented=changelogVersions(changelog);
  if(pkg.version!==VERSION) throw new Error(`Version mismatch: package.json=${pkg.version}, config.mjs=${VERSION}.`);
  if(!documented.length) throw new Error('CHANGELOG.md has no version headings.');
  if(documented[0]!==VERSION) throw new Error(`CHANGELOG.md documents ${documented[0]} but the code declares ${VERSION}. Update one of them.`);
  return {version:VERSION,documented};
}
if(process.argv[1]===new URL(import.meta.url).pathname) {
  for(const file of [...await files('src'),...await files('scripts'),...await files('test')].filter(f=>f.endsWith('.mjs'))) {
    const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
    if(result.status!==0) {console.error(result.stderr);process.exit(1);}
  }
  const {version}=await verifyVersion();
  console.log(`Syntax and version checks passed (${version}).`);
}
