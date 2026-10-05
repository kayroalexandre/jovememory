import { ensure, hash } from './config.mjs';
export function planIngestion(workspace, files) {
  ensure(files.length>0 && files.length<=100,'LIMIT','Supply between 1 and 100 Markdown files.');
  ensure(new Set(files.map(f=>f.source)).size===files.length,'INPUT','Source paths must be unique.');
  ensure(files.reduce((n,f)=>n+Buffer.byteLength(f.content),0)<=2097152,'LIMIT','Ingestion content exceeds 2 MiB.');
  const sections=[];
  for(const file of files) {
    ensure(/\.md$/i.test(file.source) && !file.source.startsWith('/') && !file.source.includes('\\') &&
      file.source.split('/').every(p=>p && !p.startsWith('.') && !p.includes(':')) && !/[\x00-\x1f\x7f]/.test(file.source),
      'SOURCE','Only safe relative Markdown source paths are accepted.');
    let content='', heading='', fence=null;
    const push=()=>{
      if(!content.trim()) return;
      ensure(Buffer.byteLength(content)<=262144,'LIMIT','An ingestion section exceeds 256 KiB.');
      const digest=hash(JSON.stringify([workspace,file.source,heading,content]));
      const id=`${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
      sections.push({id,source:file.source,heading,content,content_hash:hash(content)});
    };
    for(const line of file.content.split(/(?<=\n)/)) {
      const mark=line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if(mark) {if(!fence) fence=mark[1];else if(mark[1][0]===fence[0] && mark[1].length>=fence.length) fence=null;}
      const title=!fence && line.match(/^(#{1,6})\s+(.+)/);
      if(title) {push();content='';heading=title[2].trim();}
      content+=line;
    }
    push();
  }
  ensure(sections.length<=1000,'LIMIT','Ingestion exceeds 1000 sections.');
  return {workspace,sections,plan_hash:hash(JSON.stringify({workspace,sections})),mode:'proposed'};
}
