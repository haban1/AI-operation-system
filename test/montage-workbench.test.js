import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const mount='/video-workbench/montage';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('main-system montage keeps auth, revision recovery, library references and media integrity', {timeout:90000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'montage-main-test-'));
  const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const base=`http://127.0.0.1:${port}`,password=randomUUID(),secret=randomUUID();let child,cookie='',token,logs='';
  async function stop(){if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(2000)]);if(child.exitCode===null)child.kill('SIGKILL');}}
  t.after(async()=>{await stop();await fs.rm(dir,{recursive:true,force:true});});
  async function start(){
    child=spawn(process.execPath,['src/server.js'],{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'test',PORT:String(port),SERVER_HOST:'127.0.0.1',AGENT_PORT:String(port+1),
      DATABASE_PATH:path.join(dir,'operations.db'),CONTENT_LIBRARY_DIR:path.join(dir,'library'),MONTAGE15_DATA_DIR:path.join(dir,'montage'),
      VIDEO_STUDIO_DATA_DIR:path.join(dir,'video-studio'),
      AUTH_ENABLED:'true',ADMIN_USERNAME:'montage-test',ADMIN_PASSWORD:password,SESSION_SECRET:secret,ALLOWED_ORIGINS:base,
      INSTANCE_LOCK_ENABLED:'false',LOCAL_AGENT_AUTO_START:'false',AUTO_COLLECT_ENABLED:'false',CONTENT_LIBRARY_SEED_ENABLED:'false',
      VIDEO_STUDIO_UPSTREAM_URL:'',CONTENT_LIBRARY_SIGNAL_ROOT:'',CONTENT_LIBRARY_EDITING_ROOT:'',CONTENT_LIBRARY_CREATION_ROOT:'',
      QWEN_MODE:'mock',QWEN_API_KEY:'',DASHSCOPE_API_KEY:'',RAG_BASE_URL:'',RAG_TOKEN:'',RAG_ADMIN_ENABLED:'false',RAG_FORMAL_ROUTING_ENABLED:'false',
      WECOM_WEBHOOK_URL:'',WECHAT_ROBOT_ADMIN_URL:'',MINI_PROGRAM_API_ENABLED:'false',BROWSER_CONTROL_ENABLED:'false',BROWSER_CONTROL_PROXY_AUTO_START:'false',
      AI_AUDIO_CONTENT_AUTO_TRIGGER:'false',AI_TRAFFIC_PREDICTION_ENABLED:'false'}});
    child.stdout.on('data',d=>logs=(logs+d).slice(-8000));child.stderr.on('data',d=>logs=(logs+d).slice(-8000));
    for(let i=0;i<200;i++){if(child.exitCode!==null)assert.fail(logs);try{if((await fetch(base+'/api/health')).ok)return;}catch{}await delay(100);}assert.fail(logs);
  }
  async function request(url,{method='GET',body,expect=200,headers={}}={}){
    const r=await fetch(base+url,{method,headers:{Cookie:cookie,Origin:base,'x-workbench-token':token||'','Content-Type':'application/json',...headers},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});
    const data=await r.json();assert.equal(r.status,expect,JSON.stringify(data));return data;
  }
  async function login(){const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'montage-test',password})});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];token=(await request(mount+'/api/bootstrap')).sessionToken;}
  await start();
  for(const p of ['/video-workbench/index.html',mount+'/',mount+'/app.js',mount+'/api/bootstrap',mount+'/template-audio/perspective-flow-music.wav'])assert.equal((await fetch(base+p)).status,401,p);
  await login();
  await t.test('mounted shell, assets and accepted template are reachable',async()=>{
    const b=await request(mount+'/api/bootstrap');assert.deepEqual(b.templates.map(t=>t.id),['perspective-flow','prism-pulse']);assert.equal(b.templates[0].status,'accepted');assert.equal(b.integration.status,'internal-system');
    const status=await request('/api/creative-workbench/status');assert.equal(status.services.find(s=>s.id==='editing').url,mount+'/');
    for(const p of ['/video-workbench/index.html','/video-workbench/content-integration.css',mount+'/',mount+'/app.js',mount+'/styles.css',mount+'/workflow.js',mount+'/workflow.css',mount+'/production.js',mount+'/integration-theme.css',mount+'/vendor/gsap.min.js',mount+'/template-audio/prism-pulse-music.wav'])assert.equal((await fetch(base+p,{headers:{Cookie:cookie}})).status,200,p);
    for(const p of ['/dev-notes/README.md','/AGENTS.md','/package.json','/.local/','/samples'])assert.equal((await fetch(base+mount+p,{headers:{Cookie:cookie}})).status,404,p);
    await request(mount+'/api/projects',{method:'POST',expect:422,body:{name:'unaccepted',templateId:'film-strip'}});
  });
  await t.test('latest main shell retains Signal settings and the shared library beside montage',async()=>{
    const html=await(await fetch(base+'/video-workbench/index.html',{headers:{Cookie:cookie}})).text();
    assert.match(html,/id="montageFrame"/);assert.match(html,/AI 热点自动生成/);assert.match(html,/成片与素材/);
    const legacy=await request('/video-workbench/api/studio/bootstrap');
    assert.equal(legacy.automaticUrl,'/integrations/ai-signal/');assert.ok(Array.isArray(legacy.collections));
    assert.ok(Array.isArray((await request('/video-workbench/api/studio/materials')).items));
    assert.equal((await request(mount+'/api/bootstrap')).templates.length,2);
  });
  let project;
  await t.test('library import uses a trusted ID and retains source bytes without approval',async()=>{
    const bytes=await sharp({create:{width:64,height:64,channels:3,background:'#327d5d'}}).png().toBuffer();
    const received=await request('/api/content-library/receive?source=editing&filename=fixture.png&title=fixture&artifactType=image',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:bytes});
    const id=received.item.id;assert.equal(received.item.admissionStatus,'pending');
    assert.ok((await request(mount+'/api/library-assets')).items.some(x=>x.id===id));
    const imported=await request(mount+'/api/library-assets/import',{method:'POST',body:{id},expect:201});assert.equal(imported.asset.type,'image');assert.ok(imported.asset.url.startsWith(mount+'/api/assets/'));
    assert.equal((await request(mount+'/api/library-assets/import',{method:'POST',body:{id},expect:201})).asset.id,imported.asset.id);
    await request(mount+'/api/library-assets/import',{method:'POST',body:{id,path:'/etc/passwd'},expect:400});
    project=(await request(mount+'/api/projects',{method:'POST',expect:201,body:{name:'保存与恢复',templateId:'perspective-flow',format:'landscape'}})).project;
    assert.equal(project.settings.colorCards,false);
    project=(await request(mount+'/api/projects/'+project.id,{method:'PUT',body:{expectedRevision:project.revision,fields:{...project.fields,title:'真实素材制作'},slots:project.slots.map(s=>({...s,assetId:imported.asset.id}))}})).project;
    const preview=await(await fetch(base+mount+`/api/projects/${project.id}/preview`,{headers:{Cookie:cookie}})).text();assert.match(preview,/真实素材制作/);assert.ok(!preview.includes('class="visual color-card"'));assert.ok(preview.includes(mount+'/vendor/gsap.min.js'));assert.ok(preview.includes(mount+'/template-audio/perspective-flow-music.wav'));
    await request(mount+'/api/projects/'+project.id,{method:'PUT',body:{expectedRevision:1,name:'stale'},expect:409});
    await request('/api/content-library/'+id+'/admission',{method:'POST',body:{decision:'rejected'}});
    await request(mount+'/api/library-assets/import',{method:'POST',body:{id},expect:409});
  });
  await t.test('a restart restores the exact revision and invalidates the old write token',async()=>{
    const oldToken=token;await stop();await start();await login();assert.notEqual(token,oldToken);
    assert.deepEqual((await request(mount+'/api/projects/'+project.id)).project,project);
    await request(mount+'/api/projects/'+project.id,{method:'PUT',headers:{'x-workbench-token':oldToken},body:{expectedRevision:project.revision,name:'expired'},expect:403});
    await request(mount+'/api/projects/'+project.id,{method:'PUT',headers:{Origin:'https://foreign.invalid'},body:{expectedRevision:project.revision,name:'foreign'},expect:403});
  });
});
