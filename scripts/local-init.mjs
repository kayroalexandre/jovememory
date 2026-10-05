import { mkdir, writeFile, chmod, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { hash } from '../src/config.mjs';
try {await access('.env');console.error('.env already exists; local credentials were preserved.');process.exit(1);}catch(error) {if(error.code!=='ENOENT') throw error;}
await mkdir('private',{recursive:true,mode:0o700});await chmod('private',0o700);
const profiles=[];
for(const [id,role] of [['local-reader','reader'],['local-writer','writer'],['local-reviewer','reviewer'],['local-admin','admin']]) {
  const token=randomBytes(32).toString('base64url');
  await writeFile(`private/${id}.token`,token+'\n',{mode:0o600,flag:'wx'});
  profiles.push({id,role,sha256:hash(token),workspaces:['*']});
}
const password=randomBytes(32).toString('hex');
const appPassword=randomBytes(32).toString('hex');
await writeFile('private/database-app-password',appPassword+'\n',{mode:0o600,flag:'wx'});
const databaseUrl=(user,secret)=>{const url=new URL('postgresql://127.0.0.1:55471/jovememory_dev');url.username=user;url.password=secret;return url.href;};
const values={NODE_ENV:'development',HOST:'127.0.0.1',PORT:3000,PUBLIC_URL:'http://127.0.0.1:3000',LOCAL_DATABASE_PASSWORD:password,
  MIGRATION_DATABASE_URL:databaseUrl('jovememory_owner',password),
  DATABASE_URL:databaseUrl('jovememory_app',appPassword),
  AUTH_PROFILES:JSON.stringify(profiles),STDIO_PROFILE:'local-writer',ENABLE_PROVIDER:'false',MEMORY_REVIEW_MODE:'automatic',
  S3_ENDPOINT:'http://127.0.0.1:59071',S3_REGION:'us-east-1',S3_BUCKET:'jovememory-dev',
  S3_ACCESS_KEY_ID:'local-'+randomBytes(12).toString('hex'),S3_SECRET_ACCESS_KEY:randomBytes(32).toString('hex')};
await writeFile('.env',Object.entries(values).map(([key,value])=>`${key}=${value}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
console.log('Private local configuration generated. No credentials were printed. Next: npm run local:up, npm run migrate, npm run cli -- setup-local.');
