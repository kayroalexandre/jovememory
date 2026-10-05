import { access, chmod, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ensure } from '../src/config.mjs';

const envPath='.env', keyPath=resolve(process.env.PROVIDER_API_KEY_FILE || homedir()+'/.config/jovememory/secrets/openrouter.key');
ensure(!keyPath.startsWith(resolve('.')+'/'),'CONFIG','The provider key must be stored outside the project directory.');
await access(envPath).catch(()=>ensure(false,'CONFIG','Run npm run local:init before enabling the provider.'));
await access(keyPath).catch(()=>ensure(false,'CONFIG','Create the external private provider key file before enabling the provider.'));
const canonical=await realpath(keyPath);
ensure(!canonical.startsWith((await realpath('.'))+'/'),'CONFIG','The provider key must resolve outside the project directory.');
const key=(await readFile(keyPath,'utf8')).trim();
ensure(key.length>=20,'CONFIG','The OpenRouter key file is empty or invalid.');
await chmod(keyPath,0o600);
const mode=(await stat(keyPath)).mode & 0o777;
ensure(process.platform==='win32' || (mode & 0o077)===0,'CONFIG','Provider key file must not be readable by group or others.');

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
  SYNTHESIS_MODEL:'openrouter/free',
  FREE_INFERENCE_PREFERENCES:'nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-31b-it:free',
  INFERENCE_FALLBACK_MODELS:'deepseek/deepseek-v4-pro,deepseek/deepseek-v4-flash,xiaomi/mimo-v2.5',
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
console.log('OpenRouter provider enabled locally with the configured model matrix. The key was not copied or printed.');
