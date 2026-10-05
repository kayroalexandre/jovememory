import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { authenticate, ensure } from './config.mjs';
const issuer='jovememory-project',audience='jovememory-mcp';
export async function issueProjectToken(project,key,ttl=86400) {
  ensure(key,'CONFIG','Automatic project enrollment needs its private signing key.');
  const token=await new SignJWT({workspace:project.workspace,repository_id:project.repository_id,epoch:project.credential_epoch,role:'writer'})
    .setProtectedHeader({alg:'HS256',typ:'JWT'}).setIssuer(issuer).setAudience(audience)
    .setSubject('project-'+project.repository_id.slice(0,24)).setJti(randomUUID()).setIssuedAt().setExpirationTime(Math.floor(Date.now()/1000)+ttl).sign(key);
  return {token,expires_at:new Date((Math.floor(Date.now()/1000)+ttl)*1000).toISOString()};
}
export async function authenticateProject(header,c,store) {
  const legacy=authenticate(header,c.profiles);if(legacy) return legacy;
  if(!c.projectKey || typeof header!=='string' || header.length>2048 || !/^Bearer [A-Za-z0-9_.-]+$/.test(header)) return null;
  try {
    const {payload}=await jwtVerify(header.slice(7),c.projectKey,{issuer,audience,algorithms:['HS256'],typ:'JWT',requiredClaims:['exp','iat','sub','jti'],maxTokenAge:'1d'});
    if(payload.role!=='writer' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(payload.workspace) || !/^[a-f0-9]{64}$/.test(payload.repository_id) || !Number.isInteger(payload.epoch)) return null;
    const project=await store.project(payload.workspace);
    if(!project || project.repository_id!==payload.repository_id || project.credential_epoch!==payload.epoch || payload.sub!=='project-'+payload.repository_id.slice(0,24)) return null;
    return {id:payload.sub,role:'writer',workspaces:[payload.workspace],repository_id:payload.repository_id};
  } catch {return null;}
}
