import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.MONTAGE_LOCAL_PORT||3101);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid local port');
const data=path.join(root,'.local','montage-integration');
const base=`http://127.0.0.1:${port}`;
const signalPort=Number(process.env.MONTAGE_LOCAL_SIGNAL_PORT||18892);
if(!Number.isInteger(signalPort)||signalPort<1024||signalPort>65535||signalPort===port)throw Error('Invalid Signal port');
const signalBase=`http://127.0.0.1:${signalPort}`;
fs.mkdirSync(data,{recursive:true,mode:0o700});
// Resolve optional local dependencies before stopping the currently usable app.
let localRelay;
if(process.env.MONTAGE_LOCAL_REUSE_CODEX_MODEL==='true'){
  const {readRelayConfiguration}=await import('../engines/video-studio/runtime/codex-bridge.mjs');
  localRelay=readRelayConfiguration();
}
if(process.argv.includes('--restart')){
  if(process.platform==='win32')throw Error('此本地重启命令用于 macOS / Linux 开发环境');
  for(const [name,entry] of [['server','src/server.js'],['signal','engines/ai-signal-studio/app.py']]){
    const pidFile=path.join(data,name+'.pid');
    if(!fs.existsSync(pidFile))continue;
    const pid=Number(fs.readFileSync(pidFile,'utf8').trim());
    if(!Number.isSafeInteger(pid)||pid<2)throw Error('Invalid local PID');
    let command;
    try{command=execFileSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{continue;}
    if(!command.includes(path.join(root,entry)))throw Error(`PID ${pid} 不属于本工作区，未停止`);
    process.kill(pid,'SIGTERM');
    let stopped=false;
    for(let i=0;i<100;i++){
      try{process.kill(pid,0);}catch{stopped=true;break;}
      await new Promise(r=>setTimeout(r,100));
    }
    if(!stopped)throw Error(`进程 ${pid} 尚未退出，未强制终止`);
  }
}
async function health(){try{return await(await fetch(base+'/api/health',{signal:AbortSignal.timeout(800)})).json();}catch{return null;}}
let ready=await health();
if(ready)throw Error(`端口 ${port} 已有服务。请使用已有入口，或设置 MONTAGE_LOCAL_PORT。`);
const signalRoot=path.join(root,'engines','ai-signal-studio');
const signalConfig=path.join(data,'signal-private');
fs.mkdirSync(signalConfig,{recursive:true,mode:0o700});
let signalEnvironment={...process.env,SIGNAL_HOST:'127.0.0.1',SIGNAL_PORT:String(signalPort),SIGNAL_BASE_PATH:'/integrations/ai-signal/',SIGNAL_CONFIG_DIR:signalConfig};
// Optional local reuse keeps credentials in the child process, never in JSON.
if(process.env.MONTAGE_LOCAL_REUSE_CODEX_MODEL==='true'){
  const model=localRelay;
  if(model.key&&model.baseUrl){
    const file=path.join(signalConfig,'config.json');
    const settings=JSON.parse(fs.readFileSync(fs.existsSync(file)?file:path.join(signalRoot,'config.example.json'),'utf8'));
    settings.llm={provider:'responses',base_url:model.baseUrl,model:model.model};
    fs.writeFileSync(file,JSON.stringify(settings,null,2)+'\n',{mode:0o600});
    signalEnvironment.VIDEO_LLM_API_KEY=model.key;
  }
}
let signal;
try{
  const response=await fetch(signalBase+'/api/health',{signal:AbortSignal.timeout(800)});
  if(response.ok&&(await response.json()).service==='AI Signal Studio')throw Error('Signal port already has a service; choose MONTAGE_LOCAL_SIGNAL_PORT');
}catch(error){if(error.message.startsWith('Signal port'))throw error;}
const signalLog=fs.openSync(path.join(data,'signal.log'),'a',0o600);
signal=spawn(process.env.MONTAGE_LOCAL_PYTHON||'python3',[path.join(signalRoot,'app.py')],{cwd:signalRoot,detached:true,stdio:['ignore',signalLog,signalLog],env:signalEnvironment});
signal.unref();fs.closeSync(signalLog);
fs.writeFileSync(path.join(data,'signal.pid'),String(signal.pid)+'\n',{mode:0o600});
let signalReady=false;
for(let i=0;i<80;i++){
  try{const response=await fetch(signalBase+'/api/health',{signal:AbortSignal.timeout(500)});signalReady=response.ok&&(await response.json()).service==='AI Signal Studio';}catch{}
  if(signalReady)break;
  await new Promise(r=>setTimeout(r,150));
}
if(!signalReady){try{process.kill(signal.pid,'SIGTERM');}catch{}throw Error('Signal 启动失败，请查看本地 signal.log');}
const log=fs.openSync(path.join(data,'server.log'),'a',0o600);
const child=spawn(process.execPath,[path.join(root,'src/server.js')],{cwd:root,detached:true,stdio:['ignore',log,log],env:{...process.env,
  TIANHE_SKIP_DOTENV:'true',PORT:String(port),SERVER_HOST:'127.0.0.1',AGENT_PORT:String(port+14000),
  ALLOWED_ORIGINS:`${base},http://localhost:${port}`,
  DATABASE_PATH:path.join(data,'operations.db'),CONTENT_LIBRARY_DIR:path.join(data,'content-library'),
  VIDEO_STUDIO_DATA_DIR:path.join(data,'video-studio'),
  MONTAGE15_DATA_DIR:path.join(data,'montage'),CONTENT_LIBRARY_SEED_ENABLED:'false',
  AI_SIGNAL_STUDIO_URL:base+'/integrations/ai-signal/',AI_SIGNAL_STUDIO_HEALTH_URL:signalBase+'/api/health',AI_SIGNAL_STUDIO_INTERNAL_URL:signalBase,
  VIDEO_STUDIO_UPSTREAM_URL:'',CONTENT_LIBRARY_SIGNAL_ROOT:signalRoot,CONTENT_LIBRARY_EDITING_ROOT:'',CONTENT_LIBRARY_CREATION_ROOT:'',
  AUTH_ENABLED:'false',INSTANCE_LOCK_ENABLED:'true',LOCAL_AGENT_AUTO_START:'false',AUTO_COLLECT_ENABLED:'false',
  QWEN_MODE:'mock',QWEN_API_KEY:'',DASHSCOPE_API_KEY:'',RAG_BASE_URL:'',RAG_TOKEN:'',RAG_ADMIN_ENABLED:'false',RAG_FORMAL_ROUTING_ENABLED:'false',
  WECOM_WEBHOOK_URL:'',WECHAT_ROBOT_ADMIN_URL:'',MINI_PROGRAM_API_ENABLED:'false',BROWSER_CONTROL_ENABLED:'false',BROWSER_CONTROL_PROXY_AUTO_START:'false',
  AI_AUDIO_CONTENT_AUTO_TRIGGER:'false',AI_TRAFFIC_PREDICTION_ENABLED:'false',
  LOGIN_STATUS_POLL_ENABLED:'false',ISSUE_DIAGNOSIS_ENABLED:'false',OPERATIONS_ANALYTICS_ENABLED:'false',
}});
child.unref();fs.closeSync(log);fs.writeFileSync(path.join(data,'server.pid'),String(child.pid)+'\n',{mode:0o600});
for(let i=0;i<100;i++){ready=await health();if(ready?.ok)break;await new Promise(r=>setTimeout(r,150));}
if(!ready?.ok){try{process.kill(signal.pid,'SIGTERM');}catch{}throw Error('启动失败，请查看本地 server.log');}
console.log(`内部系统接入验收：http://127.0.0.1:${port}/#studio`);
console.log(`智能混剪：${base}/video-workbench/montage/`);
