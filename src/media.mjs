import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { hash, ensure } from './config.mjs';
export class Media {
  constructor(config) { this.bucket=config?.bucket; this.client=config ? new S3Client({endpoint:config.endpoint,region:config.region,
    credentials:config.credentials,forcePathStyle:true,maxAttempts:1}):null; }
  async send(command) {
    ensure(this.client,'STORAGE','Private object storage is not configured.');
    return this.client.send(command,{abortSignal:AbortSignal.timeout(30000)});
  }
  async upload(workspace,itemId,base64,mime,text) {
    ensure(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64),'MEDIA','Invalid base64 data.');
    const bytes=Buffer.from(base64,'base64');ensure(bytes.length>0 && bytes.length<=4194304,'LIMIT','Media must be between 1 byte and 4 MiB.');
    ensure(['text/plain','text/markdown','application/pdf','image/png','image/jpeg','image/webp','image/gif','image/bmp','image/svg+xml','application/octet-stream','audio/mpeg','audio/wav','video/mp4'].includes(mime),'MEDIA','Unsupported media type.');
    if(mime==='application/pdf') ensure(bytes.subarray(0,5).toString()==='%PDF-','MEDIA','PDF signature does not match.');
    if(mime==='image/png') ensure(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'MEDIA','PNG signature does not match.');
    if(mime==='image/jpeg') ensure(bytes[0]===255 && bytes[1]===216,'MEDIA','JPEG signature does not match.');
    if(mime==='image/webp') ensure(bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP','MEDIA','WebP signature does not match.');
    let extractedText=text || '',extractionStatus=text ? 'client_supplied':'not_available';
    if(mime.startsWith('text/')) {extractedText=new TextDecoder('utf-8',{fatal:true}).decode(bytes);extractionStatus='utf8';}
    if(mime==='application/pdf') {
      const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
      const task=getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,verbosity:0});
      const deadline=setTimeout(()=>{void task.destroy();},10000);
      try {
        const pdf=await task.promise;ensure(pdf.numPages<=100,'LIMIT','PDF exceeds 100 pages.');
        const pages=[];let size=0;
        for(let i=1;i<=pdf.numPages;i++) {
          const page=await pdf.getPage(i);const content=await page.getTextContent();
          const value=content.items.map(x=>x.str || '').join(' ');size+=Buffer.byteLength(value);
          ensure(size<=262144,'LIMIT','PDF text exceeds extraction limit.');pages.push(value);page.cleanup();
        }
        extractedText=pages.join('\n');extractionStatus=extractedText ? 'pdf_text':'pdf_no_text';
      } catch {extractionStatus='pdf_extraction_unavailable';} finally {clearTimeout(deadline);await task.destroy();}
    }
    ensure(Buffer.byteLength(extractedText)<=262144,'LIMIT','Extracted media text exceeds 256 KiB.');
    const id=randomUUID(), objectKey=`${workspace}/${id}`;
    await this.send(new PutObjectCommand({Bucket:this.bucket,Key:objectKey,Body:bytes,ContentType:mime,Metadata:{sha256:hash(bytes)}}));
    return {id,item_id:itemId,object_key:objectKey,sha256:hash(bytes),mime,size:bytes.length,extracted_text:extractedText,extraction_status:extractionStatus};
  }
  async remove(key) { await this.send(new DeleteObjectCommand({Bucket:this.bucket,Key:key})); }
  async read(pointer) {
    const result=await this.send(new GetObjectCommand({Bucket:this.bucket,Key:pointer.object_key}));
    const chunks=[];let size=0;
    for await(const part of result.Body) {size+=part.length; if(size>4194304) {result.Body.destroy();ensure(false,'LIMIT','Stored object exceeds media limit.');}chunks.push(part);}
    const bytes=Buffer.concat(chunks);ensure(bytes.length===pointer.size && hash(bytes)===pointer.sha256,'INTEGRITY','Stored media failed its integrity check.');
    return {id:pointer.id,sha256:pointer.sha256,mime:pointer.mime,base64:bytes.toString('base64')};
  }
}
