import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { startServer, stopChild, cleanupDir, freePort, jsonRequest } from './helpers/runtime.js';

test('浏览器素材上传通过真实 Web/Agent 链路保存、预检和预览', async t => {
  const agentPort = await freePort();
  const runtime = await startServer({env:{
    AUTH_ENABLED:'true', ADMIN_USERNAME:'admin', ADMIN_PASSWORD:'upload-test-password',
    SESSION_SECRET:'upload-test-session-secret-at-least-32-characters', AGENT_SHARED_TOKEN:'upload-test-agent-secret',
    AGENT_PORT:String(agentPort), LOCAL_AGENT_AUTO_START:'true', INSTANCE_LOCK_ENABLED:'false',
    REQUEST_BODY_MAX_BYTES:'65536', MATERIAL_UPLOAD_MAX_BYTES:String(1024*1024), CONTENT_LIBRARY_SEED_ENABLED:'false',
    AI_AUDIO_CONTENT_AUTO_TRIGGER:'false'
  }});
  t.after(async()=>{await stopChild(runtime.child);cleanupDir(runtime.dir);});
  const uploadedRoot=path.join(runtime.dir,'publish-materials');
  const image=await sharp(randomBytes(256*256*3),{raw:{width:256,height:256,channels:3}}).png().toBuffer();
  assert.ok(image.length>65536,'fixture must exceed the JSON body limit');
  const endpoint=name=>'/api/local-agent/upload-material?filename='+encodeURIComponent(name);
  const login=await jsonRequest(runtime.base,'/api/auth/login',{method:'POST',body:{username:'admin',password:'upload-test-password'}});
  const cookie=login.response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  const headers={'Content-Type':'application/octet-stream',Cookie:cookie};
  const upload=async(name,bytes=image,extra={})=>{
    const response=await fetch(runtime.base+endpoint(name),{method:'POST',body:bytes,headers:{...headers,...extra}});
    return {status:response.status,data:await response.json()};
  };
  await t.test('拒绝未登录访问、外部来源和暂停状态',async()=>{
    assert.equal((await upload('image.png',image,{Cookie:''})).status,401);
    assert.equal((await upload('image.png',image,{Origin:'https://untrusted.example'})).status,403);
    const paused=await jsonRequest(runtime.base,'/api/settings/operations',{method:'POST',headers:{Cookie:cookie},body:{enabled:false}});
    assert.equal(paused.response.status,200);
    assert.equal((await upload('image.png')).status,409);
  });
  const enabled=await jsonRequest(runtime.base,'/api/settings/operations',{method:'POST',headers:{Cookie:cookie},body:{enabled:true}});
  assert.equal(enabled.response.status,200);
  await t.test('中文名称、大于 JSON 上限的文件和同名并发上传',async()=>{
    const uploads=await Promise.all([upload('测试 素材.png'),upload('测试 素材.png')]);
    assert.notEqual(uploads[0].data.materialPath,uploads[1].data.materialPath);
    for(const {status,data} of uploads){
      assert.equal(status,200,JSON.stringify(data));
      assert.equal(data.precheck.meta.type,'image');
      assert.equal(data.precheck.meta.parserReady,true);
      assert.equal(data.precheck.meta.width,256);
      assert.equal(data.precheck.meta.name,'测试 素材.png');
      assert.ok(data.materialPath.startsWith(uploadedRoot+path.sep));
      assert.deepEqual(fs.readFileSync(data.materialPath),image);
      const checked=await jsonRequest(runtime.base,'/api/local-agent/precheck',{method:'POST',headers:{Cookie:cookie},body:{materialPath:data.materialPath,platforms:['weibo']}});
      assert.equal(checked.response.status,200);
      assert.equal(checked.data.precheck.meta.sha256,createHash('sha256').update(image).digest('hex'));
      const preview=await fetch(runtime.base+'/api/local-agent'+checked.data.previewUrl,{headers:{Cookie:cookie,Range:'bytes=0-31'}});
      assert.equal(preview.status,206);
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()),image.subarray(0,32));
    }
  });
  await t.test('视频上传后仍能执行平台预检和播放',async()=>{
    const fixture=path.join(runtime.dir,'test.mp4');
    execFileSync(ffmpeg.path,['-v','error','-f','lavfi','-i','color=c=blue:s=320x240:r=25','-t','1','-c:v','libx264','-pix_fmt','yuv420p',fixture]);
    const result=await upload('视频.MP4',fs.readFileSync(fixture));
    assert.equal(result.status,200,JSON.stringify(result.data));
    assert.equal(result.data.precheck.meta.type,'video');
    assert.equal(result.data.precheck.meta.width,320);
    const checked=await jsonRequest(runtime.base,'/api/local-agent/precheck',{method:'POST',headers:{Cookie:cookie},body:{materialPath:result.data.materialPath,platforms:['bilibili']}});
    assert.equal(checked.data.precheck.meta.parserReady,true);
    assert.equal(checked.data.precheck.results[0].platformCode,'bilibili');
  });
  await t.test('非法路径、空文件、超限和伪造媒体不留下文件',async()=>{
    const before=fs.readdirSync(uploadedRoot).sort();
    for(const [name,bytes,expected] of [
      ['../escape.png',image,400],['C:\\escape.png',image,400],['bad.exe',image,415],
      ['empty.png',Buffer.alloc(0),400],['large.png',Buffer.alloc(1024*1024+1),413],
      ['broken.mp4',Buffer.from('not a video'),422],['wrong.jpg',image,422]
    ])assert.equal((await upload(name,bytes)).status,expected,name);
    assert.equal((await upload('image.png',image,{'Content-Type':'application/json'})).status,415);
    assert.deepEqual(fs.readdirSync(uploadedRoot).sort(),before);
  });
  await t.test('上传中断清理未完成文件',async()=>{
    const before=fs.readdirSync(uploadedRoot).sort();
    const request=http.request(runtime.base+endpoint('cancel.png'),{method:'POST',headers:{...headers,'Content-Length':image.length}});
    request.on('error',()=>{});
    request.write(image.subarray(0,1024));
    const until=async condition=>{
      for(let i=0;i<60;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,50));}
      assert.fail('Upload cleanup timed out');
    };
    await until(()=>fs.readdirSync(uploadedRoot).length===before.length+1);
    request.destroy();
    await until(()=>fs.readdirSync(uploadedRoot).length===before.length);
    assert.deepEqual(fs.readdirSync(uploadedRoot).sort(),before);
  });
});
