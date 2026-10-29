import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createVideoStudio } from '../server.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

async function fixture(t,{publishingLibrary}={}) {
  const root=await mkdtemp(path.join(tmpdir(),'studio-output-registry-')),stateDir=path.join(root,'private');
  await mkdir(path.join(root,'bundled','videos'),{recursive:true});
  await mkdir(path.join(root,'bundled','posters'),{recursive:true});
  await mkdir(path.join(root,'dist'));
  await writeFile(path.join(root,'dist','index.html'),'<title>Output test</title>');
  const videos=[];
  for(let n=1;n<=6;n++) {
    const filename=`sample-${n}.mp4`;
    await writeFile(path.join(root,'bundled','videos',filename),`sample-video-${n}`);
    await writeFile(path.join(root,'bundled','posters',`sample-${n}.jpg`),'poster');
    videos.push({id:`v5-0${n}`,title:`Sample ${n}`,videoPath:`/bundled/videos/${filename}`,posterPath:`/bundled/posters/sample-${n}.jpg`,durationSeconds:n,bundled:true});
  }
  await writeFile(path.join(root,'bundled','manifest.json'),JSON.stringify({videos}));
  const tasks=path.join(stateDir,'chat','workspaces');
  for(const id of ['real-task','not-started','unknown-task','escaped-task'])await mkdir(path.join(tasks,id),{recursive:true});
  await mkdir(path.join(tasks,'real-task','exports','nested'),{recursive:true});
  await mkdir(path.join(tasks,'not-started','exports'));
  await mkdir(path.join(tasks,'unknown-task','exports'));
  await writeFile(path.join(tasks,'real-task','source.mp4'),'raw-source');
  await writeFile(path.join(tasks,'real-task','exports','final.mp4'),'actual-export');
  await writeFile(path.join(tasks,'real-task','exports','nested','second.webm'),'nested-export');
  await writeFile(path.join(tasks,'real-task','exports','not-supported.mkv'),'mkv');
  await writeFile(path.join(tasks,'real-task','exports','unfinished.mp4'),'');
  await writeFile(path.join(tasks,'not-started','exports','source.mp4'),'never-ran');
  await writeFile(path.join(tasks,'unknown-task','exports','source.mp4'),'unowned');
  const outside=path.join(root,'raw-source');await mkdir(outside);await writeFile(path.join(outside,'raw.mp4'),'source-clip');
  await symlink(path.join(outside,'raw.mp4'),path.join(tasks,'real-task','exports','linked.mp4'));
  await symlink(outside,path.join(tasks,'escaped-task','exports'));
  await writeFile(path.join(stateDir,'chat','sessions.json'),JSON.stringify({sessions:[
    {id:'real-task',threadId:'native-thread',status:'idle'},
    {id:'not-started',threadId:null,status:'idle'},
    {id:'escaped-task',threadId:'native-thread-2',status:'idle'},
  ]}));
  await writeFile(path.join(stateDir,'collections.json'),JSON.stringify({collections:[{id:'raw',name:'Source',path:outside,kind:'content'}],labels:{},slogans:[],outputs:[{id:'legacy-source',collectionId:'raw',relativePath:'raw.mp4'}]}));
  const studio=createVideoStudio({root,stateDir,publishingLibrary}),server=http.createServer((req,res)=>studio.handle(req,res,{mountPath:'/video-workbench',actor:'test-admin'}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`,base=origin+'/video-workbench';
  return {root,stateDir,tasks,studio,origin,base};
}

test('registry includes six samples and actual task exports, excluding source clips and escaped paths',async t=>{
  const {base,origin}=await fixture(t);
  const response=await fetch(base+'/api/studio/outputs');assert.equal(response.status,200);
  const {items}=await response.json();assert.equal(items.length,8);
  assert.equal(items.filter(item=>item.bundled).length,6);
  assert.deepEqual(items.filter(item=>!item.bundled).map(item=>item.title).sort(),['final','second']);
  for(const item of items) {
    assert.equal(item.source,'mix');assert.equal(item.status,'pending');assert.ok(!('absolutePath' in item));
    assert.match(item.sha256,/^[a-f0-9]{64}$/);assert.ok(item.bytes>0);assert.equal(item.fingerprint,`sha256:${item.sha256}:${item.bytes}`);
    assert.match(item.videoPath,/^\/video-workbench\/api\/studio\/outputs\/[\w-]+\/file$/);
  }
  const item=items.find(item=>item.id==='v5-01');
  let media=await fetch(origin+item.videoPath,{headers:{Range:'bytes=1-5','If-Match':`"${item.sha256}"`}});
  assert.equal(media.status,206);assert.equal(media.headers.get('x-content-sha256'),item.sha256);assert.equal(await media.text(),'ample');
  media=await fetch(origin+item.videoPath,{headers:{'If-Match':'"wrong-version"'}});assert.equal(media.status,409);
  media=await fetch(origin+item.videoPath+'?path=%2Fetc%2Fpasswd');assert.equal(media.status,400);
  media=await fetch(base+'/api/studio/outputs/not-registered/file');assert.equal(media.status,404);
  const legacy=await fetch(base+'/api/outputs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({collectionId:'raw',relativePath:'raw.mp4'})});assert.equal(legacy.status,410);
  const confirm=await fetch(base+'/api/studio/outputs/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:['v5-01']})});
  const rejected=await confirm.json();assert.equal(rejected.results[0].ok,false);assert.match(rejected.results[0].error,/主系统/);
});

test('confirmed copies are idempotent and source hash changes require a new approval',async t=>{
  const approvals=new Map();let writes=0,libraryRoot;
  const adapter={
    async list({items,actor}) {
      assert.equal(actor,'test-admin');
      const result=[];
      for(const output of items) {
        const saved=approvals.get(output.id);if(!saved)continue;
        const actual=await readFile(saved.copy).catch(()=>Buffer.alloc(0));
        if(digest(actual)===saved.sha256&&actual.length===saved.bytes)result.push(saved);
      }
      return {items:result};
    },
    async confirm(output,{actor}) {
      assert.equal(actor,'test-admin');assert.equal(path.isAbsolute(output.absolutePath),true);
      await mkdir(libraryRoot,{recursive:true});
      const copy=path.join(libraryRoot,output.sha256+'.mp4');await copyFile(output.absolutePath,copy);
      const bytes=await readFile(copy);assert.equal(digest(bytes),output.sha256);assert.equal(bytes.length,output.bytes);
      const saved={id:output.id,status:'approved',materialId:`material-${++writes}`,sha256:output.sha256,bytes:output.bytes,copy};
      approvals.set(output.id,saved);return saved;
    },
  };
  const {base,root}=await fixture(t,{publishingLibrary:adapter});libraryRoot=path.join(root,'publishing-library');
  const confirm=ids=>fetch(base+'/api/studio/outputs/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})}).then(response=>response.json());
  const first=await confirm(['v5-01','not-registered']);assert.equal(first.results[0].ok,true);assert.equal(first.results[1].ok,false);assert.equal(writes,1);
  const [again,parallel]=await Promise.all([confirm(['v5-01']),confirm(['v5-01'])]);
  assert.equal(again.results[0].materialId,first.results[0].materialId);assert.equal(parallel.results[0].ok,true);assert.equal(writes,1);
  let list=await fetch(base+'/api/studio/outputs').then(r=>r.json());assert.equal(list.items.find(i=>i.id==='v5-01').status,'approved');
  // Same byte length still changes the fingerprint and invalidates approval.
  await writeFile(path.join(root,'bundled','videos','sample-1.mp4'),'changed-vid-01');
  list=await fetch(base+'/api/studio/outputs').then(r=>r.json());assert.equal(list.items.find(i=>i.id==='v5-01').status,'pending');
  const changed=await confirm(['v5-01']);assert.equal(changed.results[0].ok,true);assert.equal(writes,2);
  await writeFile(approvals.get('v5-01').copy,'tampered library');
  list=await fetch(base+'/api/studio/outputs').then(r=>r.json());assert.equal(list.items.find(i=>i.id==='v5-01').status,'pending');
  const invalid=await fetch(base+'/api/studio/outputs/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:['v5-01'],path:'/tmp/arbitrary.mp4'})});assert.equal(invalid.status,400);
  const traversal=await fetch(base+'/api/studio/outputs/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:['../source.mp4']})});assert.equal(traversal.status,400);
});

test('server-provided automatic outputs use the same fixed-ID and path boundaries',async t=>{
  const {root,stateDir}=await fixture(t);
  const automaticRoot=path.join(root,'automatic');await mkdir(automaticRoot);await writeFile(path.join(automaticRoot,'final.mp4'),'automatic-export');
  const studio=createVideoStudio({root,stateDir,automaticOutputs:async()=>[
    {id:'auto-job',title:'Automatic job',rootPath:automaticRoot,relativePath:'final.mp4',durationSeconds:15},
    {id:'escape',rootPath:automaticRoot,relativePath:'../bundled/videos/sample-1.mp4'},
  ]});
  const {items}=await studio.listOutputs();const automatic=items.filter(item=>item.source==='automatic');assert.equal(automatic.length,1);
  assert.equal(automatic[0].durationSeconds,15);assert.match(automatic[0].id,/^automatic-[a-f0-9]{32}$/);
  const actual=await studio.resolveOutput(automatic[0].id);assert.equal(await readFile(actual.absolutePath,'utf8'),'automatic-export');
});
