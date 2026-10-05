import { spawn } from 'node:child_process';
import { mkdir, realpath, writeFile, readFile, chmod } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import pg from 'pg';
import { hash, ensure } from '../src/config.mjs';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
export const tables=['workspaces','projects','sources','telemetry','nodes','items','links','media','audit','settings','schema_migrations'];
export async function fingerprint(client) {
  const result={};
  for(const table of tables) {
    const rows=await client.query(`SELECT row_to_json(t)::text AS value FROM ${table} t ORDER BY row_to_json(t)::text COLLATE "C"`);
    result[table]={rows:rows.rowCount,sha256:hash(rows.rows.map(r=>r.value).join('\n'))};
  }
  return result;
}
export function postgresEnv(url) {
  const u=new URL(url);ensure(['postgres:','postgresql:'].includes(u.protocol),'CONFIG','Expected a PostgreSQL URL.');
  ensure(![...u.searchParams.keys()].some(k=>!['sslmode'].includes(k)),'CONFIG','Backup accepts only sslmode URL options.');
  const vars={PGHOST:u.hostname,PGPORT:u.port || '5432',PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:decodeURIComponent(u.pathname.slice(1))};
  if(u.searchParams.has('sslmode')) vars.PGSSLMODE=u.searchParams.get('sslmode');
  return {...process.env,...vars};
}
export async function pgCommand(command,args,url) {
  const child=spawn(command,args,{env:postgresEnv(url),stdio:['ignore','ignore','pipe']});
  child.stderr.resume();
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  ensure(code===0,'BACKUP','PostgreSQL backup/restore command failed. Private diagnostics were withheld.');
}
export async function externalDirectory(path,{create=false}={}) {
  const requested=resolve(path);if(create) await mkdir(requested,{recursive:true,mode:0o700});
  const root=await realpath(new URL('..',import.meta.url)),actual=await realpath(requested),rel=relative(root,actual);
  ensure(rel && (rel==='..' || rel.startsWith('..'+sep) || isAbsolute(rel)), 'BACKUP','Backup destination must be outside the repository.');
  return actual;
}
export async function createBackup(url,storage,destination) {
  const folder=await externalDirectory(destination,{create:true});await chmod(folder,0o700);
  const client=new pg.Client({connectionString:url});await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot=(await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const fingerprints=await fingerprint(client);
    const media=(await client.query('SELECT object_key,sha256,size FROM media ORDER BY workspace,id')).rows;
    const dump=resolve(folder,'database.dump');
    try {await readFile(dump);ensure(false,'BACKUP','Choose a new backup directory; existing backup was preserved.');}catch(e){if(e.code!=='ENOENT') throw e;}
    await pgCommand('pg_dump',['--format=custom','--no-owner','--snapshot',snapshot,'--file',dump],url);await chmod(dump,0o600);
    const objects=[];const s3=storage ? new S3Client({...storage,forcePathStyle:true,maxAttempts:1}):null;
    ensure(!media.length || s3,'STORAGE','Full backup requires configured private object storage.');
    await mkdir(resolve(folder,'objects'),{mode:0o700});
    for(const entry of media) {
      const r=await s3.send(new GetObjectCommand({Bucket:storage.bucket,Key:entry.object_key}),{abortSignal:AbortSignal.timeout(30000)});
      const chunks=[];let size=0;
      for await(const part of r.Body) {size+=part.length;if(size>4194304){r.Body.destroy();ensure(false,'LIMIT','Backup object exceeds supported size.');}chunks.push(part);}
      const bytes=Buffer.concat(chunks);ensure(bytes.length===entry.size && hash(bytes)===entry.sha256,'INTEGRITY','Media backup integrity mismatch.');
      const file=`objects/${hash(entry.object_key)}`;await writeFile(resolve(folder,file),bytes,{mode:0o600,flag:'wx'});objects.push({...entry,file});
    }
    const manifest={format:1,created_at:new Date().toISOString(),fingerprints,dump_sha256:hash(await readFile(dump)),objects,credentials_included:false};
    await writeFile(resolve(folder,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
    await client.query('COMMIT');return {tables:tables.length,objects:objects.length};
  } catch(error) {await client.query('ROLLBACK');throw error;}finally {await client.end();}
}
export async function verifyRestore(destination,url) {
  const folder=await externalDirectory(destination);const manifest=JSON.parse(await readFile(resolve(folder,'manifest.json'),'utf8'));
  ensure(manifest.format===1 && manifest.fingerprints && Array.isArray(manifest.objects),'BACKUP','Unknown manifest format.');
  ensure(hash(await readFile(resolve(folder,'database.dump')))===manifest.dump_sha256,'INTEGRITY','Backup dump hash mismatch.');
  for(const object of manifest.objects) {
    ensure(/^objects\/[a-f0-9]{64}$/.test(object.file),'BACKUP','Unsafe object path in manifest.');
    const bytes=await readFile(resolve(folder,object.file));ensure(bytes.length===object.size && hash(bytes)===object.sha256,'INTEGRITY','Backup media hash mismatch.');
  }
  const u=new URL(url);ensure(/^jovememory_restore_[a-z0-9_]+$/.test(u.pathname.slice(1)),'RESTORE','Verification requires an explicitly provisioned scratch database named jovememory_restore_*.');
  const client=new pg.Client({connectionString:url});await client.connect();
  try {
    const exists=await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'");
    ensure(exists.rows[0].n===0,'RESTORE','Scratch database must be empty; existing data was preserved.');
    await pgCommand('pg_restore',['--exit-on-error','--no-owner','--dbname',u.pathname.slice(1),resolve(folder,'database.dump')],url);
    const actual=await fingerprint(client);ensure(JSON.stringify(actual)===JSON.stringify(manifest.fingerprints),'RESTORE','Restored database differs from the backup snapshot.');
    return {database_fingerprints:'matched',media_hashes:'matched',objects:manifest.objects.length,media_restored_to_bucket:false};
  } finally {await client.end();}
}
