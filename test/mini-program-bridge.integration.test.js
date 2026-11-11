import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { startServer, stopChild, tempRuntimeDir, cleanupDir, jsonRequest } from './helpers/runtime.js';
const secret = 'outbound-integration-test-secret-32-characters';
const appId = 'outbound-test';
const protocol = 'tianhe-mini-program/1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function eventually(check) { for(let i=0;i<400;i++){if(await check())return;await sleep(50)}assert.fail('Timed out waiting for outbound flow'); }
const listen = server => new Promise(r => server.listen(0,'127.0.0.1',()=>r(server.address().port)));
async function close(server){server.closeAllConnections();await new Promise(r=>server.close(r));}

test('local-only server pulls, durably acknowledges and sends signed AI replies; settings survive restart', {timeout:60000}, async t=>{
  const dir=tempRuntimeDir('mini-outbound-integration-'); let runtime;
  const received=[], errors=[], acks=[], replies=[];let delivered=false;let failAck=true;
  const remote=http.createServer((req,res)=>{void(async()=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks);
    const body=JSON.parse(raw);const nonce=req.headers['x-nonce'];
    const canonical=['POST',req.url,req.headers['x-timestamp'],nonce,crypto.createHash('sha256').update(raw).digest('hex')].join('\n');
    assert.equal(req.headers['x-mini-app-id'],appId);
    assert.equal(req.headers['x-signature'],crypto.createHmac('sha256',secret).update(canonical).digest('hex'));
    received.push(req.url);
    let data={ok:true,protocol,appId,requestNonce:nonce};
    if(req.url==='/bridge/health')data.capabilities=['pull','ack','replies'];
    else if(req.url==='/bridge/pull'){
      data.delivery=delivered?null:{id:'lease-1',message:{appId,conversationId:'session-1',messageId:'message-1',userId:'user-1',text:'办理港澳居民居住证需要哪些材料？',sentAt:new Date().toISOString()}};
      delivered=true;
    }else if(req.url==='/bridge/ack'){
      acks.push(body);
      if(failAck){res.writeHead(503);res.end('{}');return}
      Object.assign(data,{deliveryId:body.deliveryId,acknowledged:true});
    }else if(req.url==='/bridge/replies'){replies.push(body)}
    else throw new Error('Unexpected path '+req.url);
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));
  })().catch(e=>{errors.push(e.message);res.writeHead(500);res.end('{}')})});
  const rag=http.createServer((req,res)=>{void(async()=>{
    const chunks=[];for await(const c of req)chunks.push(c);const p=JSON.parse(Buffer.concat(chunks));
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({requestId:p.requestId,result:'ANSWERED',snapshot:p.snapshot,answer:{text:'正式知识回答：'+p.query.text},grounding:{confidence:.97,confidenceBand:'HIGH',sourceReferences:[{documentId:'flow-document',documentVersion:1,chunkId:'flow-chunk'}]},meta:{knowledgeVersion:'flow-release-1'}}));
  })().catch(e=>{errors.push(e.message);res.writeHead(500);res.end('{}')})});
  t.after(async()=>{await stopChild(runtime?.child);await close(remote);await close(rag);cleanupDir(dir)});
  const port=await listen(remote),ragPort=await listen(rag);
  const env={SETTINGS_ENCRYPTION_KEY:'isolated-bridge-integration-encryption-key',MINI_PROGRAM_CONNECTION_MODE:'pull',MINI_PROGRAM_API_ENABLED:'false',MINI_PROGRAM_APP_ID:'',MINI_PROGRAM_SHARED_SECRET:'',MINI_PROGRAM_GATEWAY_URL:'',MINI_PROGRAM_CALLBACK_URL:'',RAG_BASE_URL:`http://127.0.0.1:${ragPort}`,RAG_FORMAL_ROUTING_ENABLED:'true',RAG_TIMEOUT_MS:'2000',WECOM_WEBHOOK_URL:''};
  runtime=await startServer({dir,env});
  const settings={mode:'pull',enabled:false,appId,sharedSecret:secret,gatewayUrl:`http://127.0.0.1:${port}/bridge`,callbackUrl:'',pollSeconds:2};
  let r=await jsonRequest(runtime.base,'/api/mini-program/connection',{method:'POST',body:settings});assert.equal(r.response.status,200);assert.ok(!r.text.includes(secret));
  const clientId=r.data.connection.clientId;
  r=await jsonRequest(runtime.base,'/api/mini-program/connection/test',{method:'POST',body:{}});assert.equal(r.data.result.reachable,true);assert.deepEqual(received,['/bridge/health']);
  r=await jsonRequest(runtime.base,'/api/mini-program/connection',{method:'POST',body:{...settings,enabled:true,sharedSecret:''}});assert.equal(r.response.status,200);
  await eventually(()=>acks.length>0);
  assert.equal(acks[0].status,'ACCEPTED');
  await stopChild(runtime.child);
  failAck=false;const count=received.length;
  runtime=await startServer({dir,env});
  await eventually(()=>received.slice(count).includes('/bridge/ack'));
  const resumedOperations=received.slice(count).filter(p=>p!=='/bridge/replies');assert.equal(resumedOperations[0],'/bridge/ack');
  await eventually(()=>replies.length>0);
  assert.equal(replies[0].type,'assistant.message');assert.equal(replies[0].appId,appId);assert.ok(JSON.stringify(replies[0]).includes('正式知识回答'));
  r=await jsonRequest(runtime.base,'/api/mini-program/connection');assert.equal(r.data.connection.clientId,clientId);
  r=await jsonRequest(runtime.base,'/api/mini-program/connection',{method:'POST',body:{...settings,sharedSecret:'',enabled:false}});assert.equal(r.response.status,200);
  const paused=received.filter(p=>p==='/bridge/pull').length;await sleep(2300);assert.equal(received.filter(p=>p==='/bridge/pull').length,paused);
  r=await jsonRequest(runtime.base,'/open-api/v1/mini-program/messages',{method:'POST',body:{}});assert.notEqual(r.response.status,200);
  assert.deepEqual(errors,[]);
});

test('connection configuration and test endpoints require admin authentication',async t=>{
  const runtime=await startServer({env:{AUTH_ENABLED:'true',ADMIN_PASSWORD:'test-password-only',SESSION_SECRET:'test-session-secret-with-at-least-32-characters',SETTINGS_ENCRYPTION_KEY:'isolated-auth-test-key',MINI_PROGRAM_API_ENABLED:'false',MINI_PROGRAM_CONNECTION_MODE:'pull'}});
  t.after(async()=>{await stopChild(runtime.child);cleanupDir(runtime.dir)});
  for(const [url,method] of [['/api/mini-program/connection','GET'],['/api/mini-program/connection','POST'],['/api/mini-program/connection/test','POST']]){
    const r=await jsonRequest(runtime.base,url,{method,...(method==='POST'?{body:{}}:{})});assert.equal(r.response.status,401);
  }
});
