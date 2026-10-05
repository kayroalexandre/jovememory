import { access, chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { ensure } from '../src/config.mjs';

const envPath='.env', keyPath='private/openrouter.key';
await access(envPath).catch(()=>ensure(false,'CONFIG','Run npm run local:init before enabling the provider.'));
await access(keyPath).catch(()=>ensure(false,'CONFIG','Create private/openrouter.key before enabling the provider.'));
const key=(await readFile(keyPath,'utf8')).trim();
ensure(key.length>=20,'CONFIG','The OpenRouter key file is empty or invalid.');
await chmod(keyPath,0o600).catch(()=>{});

const updates={
  ENABLE_PROVIDER:'true',
  OPENROUTER_BASE_URL:'https://openrouter.ai/api/v1',
  OPENROUTER_DECISIONS_URL:'https://openrouter.ai/api/alpha/decisions',
  PROVIDER_API_KEY_FILE:keyPath,
  EMBEDDING_MODEL:'google/gemini-embedding-2',
  EMBEDDING_DIMENSIONS:'1536',
  DECISION_MODEL:'upstage/solar-decide',
  RERANK_MODEL:'qwen/qwen3.8-flash',
  KNOWLEDGE_MODEL:'deepseek/deepseek-v4-flash',
  SYNTHESIS_MODEL:'stealth/space-bunny-alpha'
};
const original=await readFile(envPath,'utf8');
const lines=original.split('\n');
for(const [name,value] of Object.entries(updates)) {
  const index=lines.findIndex(line=>line.startsWith(name+'='));
  if(index>=0) lines[index]=name+'='+value;
  else lines.push(name+'='+value);
}
await writeFile(envPath,lines.filter((line,index,array)=>index<array.length-1 || line!=='').join('\n')+'\n',{mode:0o600});
await chmod(envPath,0o600).catch(()=>{});
const mode=(await stat(keyPath)).mode & 0o777;
ensure(process.platform==='win32' || (mode & 0o077)===0,'CONFIG','Provider key file must not be readable by group or others.');
console.log('OpenRouter provider enabled locally with the configured model matrix. The key was not copied or printed.');
