import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { writeFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { config, ensure, hash, safeError } from './config.mjs';
import { Store } from './store.mjs';
import { Service } from './service.mjs';
const [command,...args]=process.argv.slice(2);
let store;
try {
  if(command==='setup-local') {
    ensure(process.env.NODE_ENV!=='production' && process.env.MIGRATION_DATABASE_URL?.includes('127.0.0.1:55471/jovememory_dev'),'CONFIG','Local setup only targets jovememory development.');
    const password=(await readFile('private/database-app-password','utf8')).trim();
    ensure(/^[a-f0-9]{64}$/.test(password),'CONFIG','Invalid generated runtime password.');
    const client=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});await client.connect();
    try {await client.query(`ALTER ROLE jovememory_app LOGIN PASSWORD '${password}'`);}finally {await client.end();}
    const c=config();const s3=new S3Client({...c.s3,forcePathStyle:true,maxAttempts:1});
    try {await s3.send(new HeadBucketCommand({Bucket:c.s3.bucket}));}
    catch {await s3.send(new CreateBucketCommand({Bucket:c.s3.bucket}));}
    console.log('Local runtime role and private bucket ready. Provision an explicit workspace next.');
  } else if(command==='workspace') {
    const name=args[0];ensure(/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name || ''),'INPUT','Supply an explicit workspace name.');
    ensure(process.env.MIGRATION_DATABASE_URL,'CONFIG','Administrative database configuration is required.');
    const client=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});await client.connect();
    try {await client.query('INSERT INTO workspaces(name) VALUES($1) ON CONFLICT DO NOTHING',[name]);}finally {await client.end();}
    console.log('Workspace provisioned.');
  } else if(command==='profile') {
    const [id,role,...workspaces]=args;
    ensure(/^[a-z0-9_-]{1,64}$/.test(id || '') && ['reader','writer','reviewer','admin'].includes(role) && workspaces.length && workspaces.every(w=>/^(\*|[a-z0-9][a-z0-9_-]{0,62})$/.test(w)),
      'INPUT','Usage: profile <id> <reader|writer|reviewer|admin> <workspace...>');
    await mkdir('private',{recursive:true,mode:0o700});await chmod('private',0o700);
    const token=randomBytes(32).toString('base64url');
    await writeFile(`private/${id}.token`,token+'\n',{mode:0o600,flag:'wx'});
    await writeFile(`private/${id}.profile.json`,JSON.stringify({id,role,workspaces,sha256:hash(token)},null,2)+'\n',{mode:0o600,flag:'wx'});
    console.log('Token and profile saved under private/. Add the profile JSON to AUTH_PROFILES through private configuration.');
  } else if(command==='call') {
    const [name,profileId]=args;
    const c=config();const profile=c.profiles.find(p=>p.id===profileId);ensure(profile,'CONFIG','Choose an explicit configured profile.');
    const chunks=[];let size=0;for await(const part of process.stdin) {size+=part.length;ensure(size<=8388608,'LIMIT','Input exceeds 8 MiB.');chunks.push(part);}
    const input=JSON.parse(Buffer.concat(chunks).toString());store=new Store(c.databaseUrl);
    console.log(JSON.stringify(await new Service(store,c).call(name,input,profile),null,2));
  } else {console.log('Commands: setup-local | workspace <name> | profile <id> <role> <workspaces...> | call <tool> <profile> (JSON stdin)');}
} catch(error) {console.error(JSON.stringify(safeError(error)));process.exitCode=1;} finally {await store?.close();}
