import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat,readFile,realpath } from 'node:fs/promises';
import { resolve,relative,basename } from 'node:path';
import { ensure,hash } from './config.mjs';
const execute=promisify(execFile);
async function git(directory,args) {
  try {return (await execute('git',['-C',directory,...args],{encoding:'utf8',timeout:10000,maxBuffer:4194304,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'}})).stdout.trim();}
  catch {ensure(false,'REPOSITORY','Cannot observe the local Git repository; private diagnostics were withheld.');}
}
export function remoteIdentity(remote) {
  let host,path;
  try {
    if(remote.includes('://')) {
      const u=new URL(remote);ensure(['https:','ssh:','git:'].includes(u.protocol) && !u.password && !u.search && !u.hash && (u.protocol!=='https:' || !u.username),'REPOSITORY','Remote must not contain credentials or query parameters.');
      host=u.hostname.toLowerCase()+(u.port && u.port!=='22'?':'+u.port:'');path=u.pathname;
    } else {
      const m=/^(?:[A-Za-z0-9_.-]+@)?([A-Za-z0-9.-]+):([A-Za-z0-9_./-]+)$/.exec(remote);
      ensure(m,'REPOSITORY','Configure a canonical hosted Git origin for automatic project identity.');host=m[1].toLowerCase();path=m[2];
    }
    path=path.replace(/^\/+|\/+$/g,'').replace(/\.git$/i,'');
    ensure(path.includes('/') && !path.split('/').some(x=>!x || x==='..' || x==='.'),'REPOSITORY','Remote needs an owner and repository path.');
    const name=path.split('/').at(-1);ensure(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name),'REPOSITORY','Repository name is outside the supported Git naming contract.');
    const canonical=host+'/'+(host==='github.com'?path.toLowerCase():path);
    return {repository_id:hash(canonical),repository_name:name};
  } catch(error) {if(error.code) throw error;ensure(false,'REPOSITORY','Cannot normalize the Git origin.');}
}
export async function identifyRepository(directory) {
  const root=await realpath(await git(directory,['rev-parse','--show-toplevel']));
  const origin=await git(root,['remote','get-url','origin']);
  return {root,...remoteIdentity(origin)};
}
function trackable(path) {
  return !/[\\:\x00-\x1f\x7f]/.test(path) && !path.startsWith('/') && !path.split('/').some(x=>!x || ['.','..','.git','.config','.opencode','node_modules','private','secrets','backups','exports'].includes(x) || /^\.env(?:\.|$)/.test(x)) && !/\.(?:key|pem|dump|sqlite3?|db|log|jsonl)$/i.test(path) && path.length<=512;
}
export async function observeRepository(project) {
  const current=await identifyRepository(project.root);ensure(current.repository_id===project.repository_id,'PROJECT_CHANGED','Git identity changed; reconnect memory before using another project.');
  let revision;try {revision=await git(project.root,['rev-parse','HEAD']);if(!/^[a-f0-9]{40,64}$/.test(revision)) revision=undefined;}catch { /* An empty repository can still be enrolled. */ }
  const all=(await git(project.root,['ls-files','-z'])).split('\0').filter(trackable),sources=[];let complete=all.length<=5000;
  for(const locator of all.slice(0,5000)) {
    const file=resolve(project.root,locator);
    try {
      const stat=await lstat(file);
      if(stat.isSymbolicLink() || !stat.isFile() || stat.size>16777216) {complete=false;continue;}
      const actual=await realpath(file);ensure(relative(project.root,actual)!=='..' && !relative(project.root,actual).startsWith('../'),'REPOSITORY','Source path leaves the repository.');
      sources.push({locator,sha256:hash(await readFile(actual)),present:true});
    } catch(error) {
      if(error.code==='ENOENT') sources.push({locator,sha256:null,present:false});else complete=false;
    }
  }
  return {sources,revision,complete};
}
export function repositoryLabel(project) {return project.repository_name || basename(project.root);}
