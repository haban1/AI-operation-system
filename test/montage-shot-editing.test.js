import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {Store} from '../engines/montage15/src/store.mjs';
import {createProject} from '../engines/montage15/src/domain.mjs';
import {templates} from '../engines/montage15/src/templates.mjs';
import {AiEditing,instructionScope} from '../engines/montage15/src/ai-editing.mjs';
import {createWorkbench} from '../engines/montage15/src/server.mjs';
import {exec,FFMPEG} from '../engines/montage15/src/media.mjs';

const template=templates.find(item=>item.id==='prism-pulse');
const natural={kind:'instruction',ids:[]};
test('natural instructions identify one or several shots, while mixed requests respect explicit scope',()=>{
  assert.deepEqual(instructionScope(natural,'把第三个镜头换成老师近景，其他内容不变',template),{kind:'slots',ids:['shot-3']});
  assert.deepEqual(instructionScope(natural,'第一个镜头、第二个镜头、第三个镜头换成老师近景',template),{kind:'slots',ids:['shot-1','shot-2','shot-3']});
  assert.deepEqual(instructionScope(natural,'第1、2、3个镜头换成老师近景',template),{kind:'slots',ids:['shot-1','shot-2','shot-3']});
  assert.deepEqual(instructionScope(natural,'第一、三和第五个画面换成课堂实景',template),{kind:'slots',ids:['shot-1','shot-3','shot-5']});
  assert.deepEqual(instructionScope(natural,'第 2 个画面从原片第5秒开始',template),{kind:'slots',ids:['shot-2']});
  assert.equal(instructionScope(natural,'第三个镜头换近景，音乐轻一点',template),natural);
  assert.equal(instructionScope(natural,'除了第三个镜头，其他镜头换近景',template),natural);
  assert.deepEqual(instructionScope({kind:'slots',ids:['shot-2']},'换成老师近景',template),{kind:'slots',ids:['shot-2']});
  assert.throws(()=>instructionScope(natural,'把第99个镜头换成近景',template),{code:'AI_SCOPE_INVALID'});
  assert.throws(()=>instructionScope(natural,'把第1、99个镜头换成近景',template),{code:'AI_SCOPE_INVALID'});
});

test('queued natural shot edit changes only its exact source window and rejects an out-of-scope provider plan atomically',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'montage-shot-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new Store(root);await store.init();
  const asset={id:'teacher-video',name:'老师讲解.mp4',type:'video',duration:30,width:1920,height:1080,description:'老师讲解近景',tags:['老师','近景'],mediaSha256:'a'.repeat(64)};
  await store.put('assets',asset);
  const project=createProject(template);project.audio.trackId='template';project.brief={request:'课堂回顾',facts:'',subject:'',assetIds:[asset.id]};
  project.slots.forEach(slot=>Object.assign(slot,{assetId:asset.id,inPoint:1,focusX:.5,focusY:.5}));
  await store.saveProject(project);
  let outside=false;
  const ai=new AiEditing({store,planner:{status:async()=>({available:true}),plan:async context=>{
    assert.deepEqual(context.scope,{kind:'slots',ids:['shot-3']});
    assert.equal(context.project.slotDefinitions[2].shotNumber,3);
    return {message:'调整第三个镜头取材',warnings:[],operations:[{type:'slot',target:'shot-3',assetId:asset.id,inPoint:5,focusX:.4,focusY:.5},...(outside?[{type:'field',target:'title',text:'越界标题'}]:[])]};
  }}});
  async function wait(run){for(let i=0;i<200;i++){const saved=await store.get('ai-runs',run.id);if(!['queued','running'].includes(saved.status))return saved;await new Promise(r=>setTimeout(r,10))}assert.fail('task timeout');}
  const input={mode:'instruction',instruction:'把第三个镜头改成老师近景，从原片第5秒开始，其他内容不变',scope:natural};
  const first=await ai.enqueue(project,[asset],{...input,expectedRevision:1});
  assert.equal((await wait(first)).status,'succeeded');
  const next=await store.get('projects',project.id);
  assert.equal(next.slots[2].inPoint,5);
  assert.deepEqual(next.slots.filter(slot=>slot.id!=='shot-3'),project.slots.filter(slot=>slot.id!=='shot-3'));
  for(const key of ['fields','audio','settings','brief','locks','templateSnapshot'])assert.deepEqual(next[key],project[key]);
  outside=true;
  const second=await ai.enqueue(next,[asset],{...input,expectedRevision:2});
  const failed=await wait(second);assert.equal(failed.status,'failed');assert.equal(failed.code,'AI_SCOPE_VIOLATION');
  assert.deepEqual(await store.get('projects',project.id),next);
});

test('selected source-frame previews show different positions and reject invalid positions',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'montage-frame-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const media=path.join(root,'colors.mp4');
  await exec(FFMPEG,['-v','error','-y','-f','lavfi','-i','color=c=red:s=128x72:d=1:r=30','-f','lavfi','-i','color=c=blue:s=128x72:d=1:r=30','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[out]','-map','[out]','-c:v','libx264','-pix_fmt','yuv420p',media]);
  const app=await createWorkbench({dataDir:root,planner:{status:async()=>({available:false})}});
  await app.store.put('assets',{id:'colors',name:'colors.mp4',type:'video',duration:2,width:128,height:72,mediaFile:media});
  const server=http.createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const first=await fetch(base+'/api/assets/colors/frame?time=0.2');const last=await fetch(base+'/api/assets/colors/frame?time=1.2');
  assert.equal(first.status,200);assert.equal(last.headers.get('content-type'),'image/jpeg');
  assert.notDeepEqual(Buffer.from(await first.arrayBuffer()),Buffer.from(await last.arrayBuffer()));
  for(const value of ['-1','2','NaN','Infinity']) assert.equal((await fetch(base+'/api/assets/colors/frame?time='+value)).status,422);
  const cached=await fetch(base+'/api/assets/colors/frame?time=1.2',{method:'HEAD'});assert.equal(cached.status,200);assert.ok(Number(cached.headers.get('content-length'))>0);
});
