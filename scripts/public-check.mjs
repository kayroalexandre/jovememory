import { execFileSync } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
export const blockedPath=path=>/(^|\/)(private|backups|exports|\.env(?:\..*)?)(\/|$)/.test(path) && path!=='.env.example' || /\.(key|pem|dump|sqlite3?|db|log|jsonl)$/i.test(path);
export const secretPatterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\b(?:ghp_|github_pat_|gho_|sk-or-v1-)[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,/postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@/];
if(process.argv[1]===new URL(import.meta.url).pathname) {
  const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
  const violations=[];
  for(const file of files) {
    if(blockedPath(file)) {violations.push({file,rule:'private_path'});continue;}
    const info=await lstat(file);
    if(info.isSymbolicLink()) {violations.push({file,rule:'symbolic_link'});continue;}
    if(!info.isFile()) continue;
    const bytes=await readFile(file);
    let staged;try {staged=execFileSync('git',['show',':'+file],{stdio:['ignore','pipe','ignore']});}catch{}
    if(staged && secretPatterns.some(re=>re.test(staged.toString()))) violations.push({file,rule:'staged_credential_pattern'});
    if(bytes.length>2097152) {violations.push({file,rule:'large_artifact'});continue;}
    if(bytes.includes(0)) {violations.push({file,rule:'binary_artifact'});continue;}
    if(secretPatterns.some(re=>re.test(bytes.toString()))) violations.push({file,rule:'credential_pattern'});
  }
  if(violations.length) {console.error(JSON.stringify(violations));process.exit(1);}
  console.log(`Public content checks passed (${files.length} files). Review personal data separately before publishing.`);
}
