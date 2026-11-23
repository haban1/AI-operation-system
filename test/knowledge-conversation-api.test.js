import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cleanupDir, jsonRequest, startServer, stopChild } from './helpers/runtime.js';

test('local conversation API authenticates, skips RAG for social/clarification, and keeps raw grounding contract', async t => {
  const calls = [];
  const rag = http.createServer(async (req,res) => {
    let raw=''; for await (const chunk of req) raw += chunk;
    const input=JSON.parse(raw); calls.push(input);
    const missing=input.query.text.includes('电话');
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ contractVersion:'1.0', requestId:input.requestId, traceId:input.traceId, snapshot:input.snapshot, result:missing?'NO_ANSWER':'ANSWERED', answer:missing?null:{text:'来自原文的地点'}, grounding:{sourceReferences:missing?[]:[{verificationStatus:'VERIFIED',documentId:'isolated-doc',chunkId:'isolated-chunk'}]},meta:{knowledgeBaseId:'main-business-kb'} }));
  });
  await new Promise(resolve=>rag.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>rag.close(resolve)));
  const runtime=await startServer({env:{AUTH_ENABLED:'true',ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'isolated-conversation-test-password',SESSION_SECRET:'isolated-conversation-secret-32-characters',RAG_BASE_URL:`http://127.0.0.1:${rag.address().port}`,RAG_ADMIN_ENABLED:'true',RAG_AUTO_START:'false',CONTENT_LIBRARY_SEED_ENABLED:'false',OPERATIONS_ANALYTICS_ENABLED:'false',LOGIN_STATUS_POLL_ENABLED:'false'}});
  t.after(async()=>{await stopChild(runtime.child);cleanupDir(runtime.dir);});
  const query=(text,headers={},context=[])=>jsonRequest(runtime.base,'/api/rag/test-query',{method:'POST',headers,body:{text,context}});
  assert.equal((await query('好厉害')).response.status,401); assert.equal(calls.length,0);
  const login=await jsonRequest(runtime.base,'/api/auth/login',{method:'POST',body:{username:'admin',password:'isolated-conversation-test-password'}});
  const headers={Cookie:login.response.headers.get('set-cookie').split(';')[0]};
  for (const [text,kind] of [['好厉害','SOCIAL'],['你是谁','SOCIAL'],['在那里参加','CLARIFICATION']]) {
    const result=await query(text,headers); assert.equal(result.response.status,200,JSON.stringify(result.data));
    assert.equal(result.data.response,null);assert.equal(result.data.presentation.kind,kind);
  }
  assert.equal(calls.length,0);
  const grounded=await query('示例公开课在哪举办',headers);
  assert.equal(grounded.response.status,200,JSON.stringify(grounded.data));assert.equal(grounded.data.response.result,'ANSWERED');
  assert.equal(grounded.data.presentation.text,'来自原文的地点');assert.equal(calls.length,1);
  const missing=await query('公司电话是多少',headers);assert.equal(missing.data.response.result,'NO_ANSWER');assert.match(missing.data.presentation.text,/联系方式/);
  const contextual=await query('在那里参加',headers,[{role:'USER',text:'示例公开课在哪里举办'},{role:'ASSISTANT',text:'已知地点'}]);
  assert.equal(contextual.data.presentation.kind,'GROUNDED');assert.equal(calls.at(-1).context.length,2);
  assert.equal(calls.length,3);assert.ok(calls.every(x=>x.knowledgeScope.knowledgeBaseId==='main-business-kb' && x.constraints.requireGrounding));
  const invalid=await jsonRequest(runtime.base,'/api/rag/test-query',{method:'POST',headers,body:{text:'好厉害',platform:'UNKNOWN'}});
  assert.equal(invalid.response.status,400);assert.equal(calls.length,3);
});
