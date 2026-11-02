// Deployment verification against the local Tianhe server. No publishing calls.
// Credentials are read from the existing container environment and never logged.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const base='http://127.0.0.1:3100', prefix='/integrations/ai-signal/';
const action=process.argv[2] || 'state';
const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({username:process.env.ADMIN_USERNAME || 'admin',password:process.env.ADMIN_PASSWORD}),signal:AbortSignal.timeout(10000)});
assert.equal(login.status,200,'Login failed');
const cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);await login.body.cancel();
async function request(route,options={}) {return fetch(base+route,{...options,redirect:'manual',headers:{Cookie:cookie,Origin:base,...options.headers},signal:AbortSignal.timeout(90000)});}
async function json(route,options={}) {const response=await request(route,options);assert.ok(response.ok,`${route}: HTTP ${response.status}`);return response.json();}
const post=(route,body)=>json(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const state=await json(prefix+'api/state');
const llm=state.config.llm;
assert.equal(llm.provider,'compatible');assert.equal(llm.base_url,'http://web:3100/api/model/v1');assert.equal(llm.model,'tianhe-workbench-chat');assert.equal(llm.api_key_configured,true);
if(action==='state') {
  console.log(JSON.stringify({job:state.job,runs:state.runs.map(({id,title,video,duration})=>({id,title,video,duration})),model:llm.model,voice:state.config.tts.provider},null,2));
} else if(action==='start') {
  assert.notEqual(state.job.status,'running','A generation is already running');
  console.log(JSON.stringify({modelTest:await post(prefix+'api/test-model',{}),started:await post(prefix+'api/build',{repo:'remotion-dev/remotion',style_id:'baseline-v2'})},null,2));
} else if(action==='verify') {
  const runId=process.argv[3];assert.match(runId || '',/^[A-Za-z0-9_-]{1,100}$/);
  const run=state.runs.find(item=>item.id===runId);assert.ok(run?.video,'Completed video required');
  const report={checkedAt:new Date().toISOString(),commit:'752c29e68f892fa6b2fe0ed54ebce2bbee13b7c7',runId,title:run.title,checks:[]};
  for(const route of [prefix,prefix+'app.js',prefix+'api/state',run.video]) {
    const response=await fetch(base+route,{signal:AbortSignal.timeout(10000)});assert.equal(response.status,401,'Anonymous access denied');await response.body.cancel();
  }
  report.checks.push('Page, assets, API and video require authentication');
  const wb=await json('/api/creative-workbench/status');assert.ok(wb.services.length===3 && wb.services.every(s=>s.online));assert.equal(wb.services.find(s=>s.id==='automatic').url,prefix);
  report.checks.push('Three routes online; automatic route uses bundled Signal');
  const page=await request(prefix);assert.equal(page.status,200);assert.match(await page.text(),/<base href="\/integrations\/ai-signal\/">/);
  const old=await request('/ai-studio/index.html');assert.equal(old.status,302);assert.equal(old.headers.get('location'),prefix);await old.body?.cancel();
  const validation=await json(prefix+`runs/${runId}/validation.json`);assert.equal(validation.full_decode,'passed');assert.equal(validation.width,1080);assert.equal(validation.height,1920);
  report.media=validation;
  const video=Buffer.from(await (await request(run.video)).arrayBuffer());const sha256=createHash('sha256').update(video).digest('hex');
  const head=await request(run.video,{method:'HEAD'});assert.equal(Number(head.headers.get('content-length')),video.length);
  for(const range of ['bytes=0-1023','bytes=-1024']) {const response=await request(run.video,{headers:{Range:range}});assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,1024);}
  report.checks.push('Full-decode video, downloads and byte ranges valid');
  const library=await post('/api/content-library/sync',{});const item=library.items.find(i=>i.source==='automatic' && i.sourceId===runId);assert.ok(item,'Video imported');assert.equal(item.sha256,sha256);
  assert.equal(library.items.filter(i=>i.source==='automatic' && i.sourceId===runId).length,1,'No duplicate imports');
  const copied=Buffer.from(await (await request(item.mediaUrl)).arrayBuffer());assert.equal(createHash('sha256').update(copied).digest('hex'),sha256);
  const draft=await json(`/api/content-library/${item.id}/publish-draft`);
  assert.equal(draft.requiresPrecheck,true,'Draft still requires publishing precheck');
  report.libraryId=item.id;report.sha256=sha256;report.draftKeys=Object.keys(draft);report.checks.push('Shared library copy matches; publish draft readable');
  let previous;
  try { previous=JSON.parse(await readFile('/app/data/signal-live-verification.json','utf8')); } catch(error) { if(error.code!=='ENOENT')throw error; }
  if(previous?.runId===runId) {assert.equal(previous.libraryId,item.id);assert.equal(previous.sha256,sha256);report.checks.push('Repeated verification preserves media and library identity');}
  await writeFile('/app/data/signal-live-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} else throw new Error('Use state, start or verify <runId>');
