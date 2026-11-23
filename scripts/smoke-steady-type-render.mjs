// Standalone, offline acceptance run: six local media files, then a new output path.
import { constants } from 'node:fs';
import { access, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkbench } from '../engines/montage15/src/server.mjs';

const files=process.argv.slice(2);
if(files.length!==7)throw new Error('需要六个本地素材和一个新的输出 MP4 路径');
const destination=path.resolve(files.pop());
if(await access(destination).then(()=>true,()=>false))throw new Error('输出文件已存在');
const dataDir=await mkdtemp(path.join(os.tmpdir(),'steady-render-'));
const app=await startWorkbench({port:0,dataDir});
try {
  const {sessionToken}=await (await fetch(app.url+'/api/bootstrap')).json();
  async function request(url,method='GET',body,extra={}){
    const res=await fetch(app.url+url,{method,headers:{Origin:app.url,'x-workbench-token':sessionToken,'Content-Type':'application/json',...extra},body:Buffer.isBuffer(body)?body:JSON.stringify(body)});
    const data=await res.json();
    assert.ok(res.ok,`${url}: ${JSON.stringify(data)}`);
    return data;
  }
  const assets=[];
  for(const [i,file] of files.entries()){
    const {asset}=await request('/api/assets','POST',await readFile(file),{'Content-Type':'application/octet-stream','x-file-name':'shot-'+i+path.extname(file)});
    assets.push(asset);
  }
  const {project}=await request('/api/projects','POST',{templateId:'steady-type',name:'稳镜字动 · 导出验收',format:'portrait'});
  const saved=(await request('/api/projects/'+project.id,'PUT',{
    expectedRevision:project.revision,
    settings:{...project.settings,colorCards:false},
    fields:{...project.fields,beat4:'交流一下',beat5:'下一堂课见'},
    slots:project.slots.map((s,i)=>({...s,assetId:assets[i].id,focusX:[.413,.5,.5,.60,.474,.54][i]}))
  })).project;
  assert.equal((await request('/api/projects/'+project.id)).project.fields.beat5,'下一堂课见');
  let {job}=await request('/api/projects/'+project.id+'/render','POST',{expectedRevision:saved.revision});
  const deadline=Date.now()+1000*60*16;
  let progress=-1;
  while(['queued','rendering'].includes(job.status)&&Date.now()<deadline){
    const step=Math.floor(job.progress*10);
    if(step!==progress){console.log(job.status,step*10+'%');progress=step;}
    await delay(1500);
    ({job}=await request('/api/jobs/'+job.id));
  }
  assert.equal(job.status,'succeeded',job.error||'渲染超时');
  const stored=await app.store.get('jobs',job.id);
  await copyFile(stored.outputFile,destination,constants.COPYFILE_EXCL);
  console.log(JSON.stringify({duration:job.durationSeconds,bytes:job.bytes,sha256:job.sha256}));
} finally {
  await app.close();app.server.close();
  await rm(dataDir,{recursive:true,force:true});
}
