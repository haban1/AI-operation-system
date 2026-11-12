import path from 'node:path';
import { createWorkbench } from '../../engines/montage15/src/server.mjs';
import { hashFile, serveFile } from '../../engines/montage15/src/media.mjs';
import { ContentLibraryError } from './content-library.js';

// Only the user-accepted template is available for new business projects.
export const acceptedMontageTemplates = ['perspective-flow', 'prism-pulse'];
const outputPattern = /^montage-([a-f0-9-]{36})$/;

export async function createMontageWorkbench({ stateDir, publicDir, library, publishingLibrary }) {
  let app;
  function describe(job) {
    return { id:`montage-${job.id}`, title:job.projectName, source:'mix',
      filename:`${job.projectName.replace(/[\\/:\x00-\x1f]/g,'_').slice(0,150)}-r${job.revision}.mp4`,
      sha256:job.sha256, bytes:job.bytes, durationSeconds:15,
      width:job.project.width, height:job.project.height,
      orientation:job.project.width>job.project.height?'landscape':'portrait',
      style:job.project.templateSnapshot.name, styleId:job.templateId,
      description:`${job.projectName} · 修订 ${job.revision}`, bundled:false };
  }
  function deliverable(job) {
    return job.status==='succeeded' && job.outputFile && job.project?.settings?.colorCards===false
      && job.project.slots.every(slot=>slot.assetId);
  }
  async function resolveOutput(id) {
    const match=outputPattern.exec(id);
    if(!match) return null;
    const job=await app.store.get('jobs',match[1]).catch(()=>null);
    if(!job || !deliverable(job)) return null;
    if(await hashFile(job.outputFile).catch(()=>null)!==job.sha256)
      throw new ContentLibraryError(409,'CONTENT_FILE_CHANGED','成片文件已改变，请重新导出');
    return {...describe(job),absolutePath:job.outputFile};
  }
  app=await createWorkbench({dataDir:stateDir,mountPath:'/video-workbench/montage',templateIds:acceptedMontageTemplates,catalogIds:acceptedMontageTemplates,
    assetLibrary:{
      async list(){const snapshot=await library.list();return [...snapshot.items,...snapshot.pendingItems]
        .filter(item=>['image','video'].includes(item.mediaType) && item.sizeBytes<=512*1024**2)
        .map(({id,title,mediaType,durationSeconds,width,height,sizeBytes})=>({id,title,mediaType,durationSeconds,width,height,sizeBytes}));},
      open:id=>library.openForEditing(id),
    },
    async receiveOutput(job){
      const item=await resolveOutput(`montage-${job.id}`);
      if(!item) throw new ContentLibraryError(409,'OUTPUT_UNAVAILABLE','请重新导出成片');
      const result=await publishingLibrary.list({items:[item]});
      const received=result.items[0];
      if(!received?.materialId) throw new ContentLibraryError(502,'OUTPUT_NOT_RECEIVED','成片暂未加入素材库，请重试');
      return {item:received};
    },
  });
  const shellFiles=new Map([['/',['index.html','text/html; charset=utf-8']],['/index.html',['index.html','text/html; charset=utf-8']],
    ['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']],
    ['/library.js',['library.js','text/javascript; charset=utf-8']],['/library.css',['library.css','text/css; charset=utf-8']],['/icon.svg',['icon.svg','image/svg+xml']],
    ['/creation.css',['creation.css','text/css; charset=utf-8']], ['/library.html',['library.html','text/html; charset=utf-8']], ['/legacy.js',['legacy.js','text/javascript; charset=utf-8']]]);
  return {
    ...app,resolveOutput,
    async listOutputs(){
      const items=[];
      for(const job of await app.store.all('jobs')){
        if(!deliverable(job))continue;
        try {const output=await resolveOutput(`montage-${job.id}`);if(output)items.push(describe(job));}catch{}
      }
      return {items};
    },
    async handle(req,res,{mountPath='/video-workbench'}={}){
      const url=new URL(req.url,`http://${req.headers.host}`),local=url.pathname.slice(mountPath.length);
      const output=local.match(/^\/api\/studio\/outputs\/([^/]+)\/file$/);
      if(output && ['GET','HEAD'].includes(req.method)){
        const item=await resolveOutput(output[1]);
        if(!item)throw new ContentLibraryError(404,'STUDIO_OUTPUT_NOT_FOUND','成片不存在');
        if(req.headers['if-match'] && req.headers['if-match']!==`"${item.sha256}"`)
          throw new ContentLibraryError(409,'CONTENT_FILE_CHANGED','成片在读取期间已改变，请重新选择');
        res.setHeader('ETag',`"${item.sha256}"`);
        return serveFile(req,res,item.absolutePath,'video/mp4');
      }
      if(local.startsWith('/montage/'))return app.handle(req,res);
      const file=shellFiles.get(local);
      if(file && ['GET','HEAD'].includes(req.method))return serveFile(req,res,path.join(publicDir,file[0]),file[1]);
      throw new ContentLibraryError(404,'NOT_FOUND','页面或接口不存在');
    },
  };
}
