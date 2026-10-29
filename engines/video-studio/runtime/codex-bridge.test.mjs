import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexBridge } from './codex-bridge.mjs';

const KEY = 'sk-test-video-bridge-secret-123456789';
function fixture(t, transport = 'exec') {
  const root = mkdtempSync(join(tmpdir(), 'video-bridge-test-'));
  const fake = join(root, 'fake-codex.mjs');
  writeFileSync(fake, `
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex-test 1');process.exit(0)}
if(args.includes('app-server')) {
 const {createInterface}=await import('node:readline');
 const send=x=>console.log(JSON.stringify(x));
 for await(const line of createInterface({input:process.stdin})) {
  const m=JSON.parse(line);const p=m.params||{};
  if(m.method==='initialize')send({id:m.id,result:{}});
  else if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:p.threadId||'019app-thread'}}});
  else if(m.method==='mcpServerStatus/list')send({id:m.id,result:{data:[{name:'chatcut',runtimeStatus:'connected',tools:{list_projects:{}},toolsError:null}]}});
  else if(m.method==='turn/start'){
   send({id:m.id,result:{turn:{id:'turn-native'}}});
   const input=p.input[0].text;
   if(!input.includes('wait forever')){
    send({method:'item/completed',params:{item:{id:'answer-'+Date.now(),type:'agentMessage',text:'app-server answer'}}});
    send({method:'turn/completed',params:{turn:{id:'turn-native',status:'completed'}}});
   }
  }else if(m.method==='turn/interrupt'){
   send({id:m.id,result:{}});send({method:'turn/completed',params:{turn:{id:'turn-native',status:'interrupted'}}});
  }
 }
} else {
let input='';for await(const x of process.stdin)input+=x;
console.log(JSON.stringify({type:'thread.started',thread_id:'019test-thread'}));
if(input.includes('wait forever'))setTimeout(()=>{},100000);
else {
 console.log(JSON.stringify({type:'item.started',item:{id:'tool-1',type:'command_execution',command:'echo '+process.env.VIDEO_RELAY_API_KEY}}));
 if(input.includes('fail this turn')){console.log(JSON.stringify({type:'turn.failed',error:{message:'upstream failed '+process.env.VIDEO_RELAY_API_KEY}}));process.exitCode=1}
 else {console.log(JSON.stringify({type:'item.completed',item:{id:'assistant-'+Date.now(),type:'agent_message',text:args.includes('resume')?'resumed':'hello'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}))}
}
}
`);
  const bridge = new CodexBridge({ root, transport, cli: process.execPath, cliPrefix: [fake], credentials: () => ({ key: KEY, baseUrl:'https://relay.test/v1', model:'example-model', source:'test' }), timeoutMs:5000 });
  t.after(() => { bridge.close(); rmSync(root,{recursive:true,force:true}); });
  return { bridge, root };
}
function complete(bridge,id) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{unsubscribe();reject(new Error('no done event'))},7000);
    const unsubscribe=bridge.subscribe(id,event=>{if(event.type==='done'){clearTimeout(timer);queueMicrotask(()=>unsubscribe());resolve(event)}} ,{after:bridge.getSession(id).events.at(-1)?.id || 0});
  });
}

test('persists conversation, resumes the exact thread and redacts secrets', async t => {
  const {bridge,root}=fixture(t); const session=bridge.createSession({skillIds:['chatcut-source-pack-01']});
  const done=complete(bridge,session.id); await bridge.send(session.id,{message:'hello'}); await done;
  assert.equal(bridge.getSession(session.id).threadId,'019test-thread');
  assert.equal(bridge.getSession(session.id).messages.at(-1).text,'hello');
  const again=complete(bridge,session.id);await bridge.send(session.id,{message:'continue'});await again;
  assert.equal(bridge.getSession(session.id).messages.at(-1).text,'resumed');
  assert.ok(!readFileSync(join(root,'runtime/private/sessions.json'),'utf8').includes(KEY));
  assert.ok(!readFileSync(join(root,'runtime/private/codex-home/config.toml'),'utf8').includes(KEY));
  const status=await bridge.status();assert.ok(status.available);assert.ok(!JSON.stringify(status).includes(KEY));
});

test('cancel stops the running child and permits another turn', async t => {
  const {bridge}=fixture(t);const session=bridge.createSession();
  const done=complete(bridge,session.id);await bridge.send(session.id,{message:'wait forever'});
  assert.equal(bridge.cancel(session.id).cancelled,true);assert.equal((await done).status,'cancelled');
  const next=complete(bridge,session.id);await bridge.send(session.id,{message:'hello'});await next;
  assert.equal(bridge.getSession(session.id).status,'idle');
});

test('parallel duplicate sends are rejected and failed turns retain safe error', async t => {
  const {bridge}=fixture(t);const session=bridge.createSession();
  const done=complete(bridge,session.id);const first=bridge.send(session.id,{message:'fail this turn'});
  await assert.rejects(bridge.send(session.id,{message:'duplicate'}),e=>e.statusCode===409);
  await first;assert.equal((await done).status,'failed');
  assert.ok(!bridge.getSession(session.id).lastError.includes(KEY));
});

test('a service restart marks unfinished saved turns as interrupted', t => {
  const {bridge,root}=fixture(t);const session=bridge.createSession();
  const file=join(root,'runtime/private/sessions.json');const data=JSON.parse(readFileSync(file));
  data.sessions[0].status='running';writeFileSync(file,JSON.stringify(data));
  const restarted=new CodexBridge({root,cli:process.execPath});
  assert.equal(restarted.getSession(session.id).status,'interrupted');
});

test('app-server initializes thread MCP before generation and resumes its thread', async t => {
  const {bridge}=fixture(t,'app-server');const session=bridge.createSession();
  const done=complete(bridge,session.id);await bridge.send(session.id,{message:'hello'});await done;
  assert.equal(bridge.getSession(session.id).threadId,'019app-thread');
  assert.equal(bridge.getSession(session.id).messages.at(-1).text,'app-server answer');
  assert.equal((await bridge.status()).chatcut.state,'connected');
  const next=complete(bridge,session.id);await bridge.send(session.id,{message:'continue'});await next;
  assert.equal(bridge.getSession(session.id).messages.length,4);
});

test('app-server interrupts a native turn', async t => {
  const {bridge}=fixture(t,'app-server');const session=bridge.createSession();
  const done=complete(bridge,session.id);await bridge.send(session.id,{message:'wait forever'});
  await new Promise(resolve=>setTimeout(resolve,100));bridge.cancel(session.id);
  assert.equal((await done).status,'cancelled');
});
