import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.gif':'image/gif', '.mp4':'video/mp4', '.mov':'video/quicktime', '.webm':'video/webm', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.m4a':'audio/mp4', '.json':'application/json; charset=utf-8' };
const IMAGE = new Set(['.jpg','.jpeg','.png','.webp','.gif','.svg']);
const VIDEO = new Set(['.mp4','.mov','.mkv','.webm']);
const AUDIO = new Set(['.mp3','.wav','.m4a','.aac','.flac']);
const MEDIA = new Set([...IMAGE,...VIDEO,...AUDIO]);
const SAMPLE_CATEGORIES = {
  'FV4A8209.JPG':'场地环境','FV4A8240.JPG':'听众反应','FV4A8307.JPG':'讲师讲解','FV4A8352.JPG':'讲师讲解',
  'FV4A8411.JPG':'实操教学','FV4A8445.JPG':'讲师讲解','FV4A8492.JPG':'场地环境','FV4A8549.JPG':'团队合影',
};
const CATEGORY_NAMES = ['讲师讲解','听众反应','实操教学','交流互动','场地环境','团队合影','颁证仪式','课程信息','品牌资产','虚拟形象','音乐音效','待分类'];
const deniedParts = new Set(['.ssh','.aws','.codex','.env','.git','.npmrc','.netrc','.kube','Library']);

function error(status, message) { return Object.assign(new Error(message), { statusCode: status }); }
function inside(root, target) { const rel=path.relative(root,target); return rel==='' || (!rel.startsWith('..'+path.sep) && rel!=='..' && !path.isAbsolute(rel)); }
function safePart(value) { return String(value||'').replace(/[^a-zA-Z0-9_-]/g,''); }
function json(res, value, status=200) { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' }); res.end(JSON.stringify(value)); }
async function readJson(file, fallback) { try { return JSON.parse(await fsp.readFile(file,'utf8')); } catch(e) { if(e.code==='ENOENT')return fallback; throw e; } }
async function writeJson(file, value) { await fsp.mkdir(path.dirname(file),{recursive:true}); const temp=file+'.'+randomUUID()+'.tmp'; await fsp.writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600}); await fsp.rename(temp,file); }
async function body(req) { let size=0; const chunks=[]; for await(const chunk of req) { size+=chunk.length; if(size>512*1024)throw error(413,'请求内容过大'); chunks.push(chunk); } try { return JSON.parse(Buffer.concat(chunks).toString()||'{}'); } catch { throw error(400,'无效的 JSON'); } }

async function sendFile(req,res,file,{download=false}={}) {
  const stat=await fsp.stat(file);
  if(!stat.isFile())throw error(404,'文件不存在');
  const headers={ 'Content-Type':MIME[path.extname(file).toLowerCase()]||'application/octet-stream', 'Accept-Ranges':'bytes', 'X-Content-Type-Options':'nosniff', 'Cache-Control':'private, max-age=60' };
  if(path.extname(file).toLowerCase()==='.svg')headers['Content-Security-Policy']="default-src 'none'; style-src 'unsafe-inline'; sandbox";
  if(download)headers['Content-Disposition']=`attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
  let start=0,end=stat.size-1,status=200;
  if(req.headers.range) {
    const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(!m || (!m[1]&&!m[2])) { res.writeHead(416,{'Content-Range':`bytes */${stat.size}`}); return res.end(); }
    if(!m[1])start=Math.max(0,stat.size-Number(m[2]));
    else { start=Number(m[1]); if(m[2])end=Math.min(end,Number(m[2])); }
    if(start>end || start>=stat.size || !Number.isSafeInteger(start)||!Number.isSafeInteger(end)) { res.writeHead(416,{'Content-Range':`bytes */${stat.size}`}); return res.end(); }
    status=206; headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length']=String(Math.max(0,end-start+1)); res.writeHead(status,headers);
  if(req.method==='HEAD'||stat.size===0)return res.end();
  const stream=fs.createReadStream(file,{start,end}); stream.on('error',()=>res.destroy()); res.on('close',()=>stream.destroy()); stream.pipe(res);
}

export function createVideoStudio({root=ROOT,stateDir=process.env.VIDEO_STUDIO_DATA_DIR||path.join(root,'runtime','data'),automaticUrl=process.env.AI_SIGNAL_STUDIO_URL||'http://127.0.0.1:8892/'}={}) {
  let bridgePromise,storePromise;
  const thumbJobs=new Map();
  async function bridge() {
    if(!bridgePromise)bridgePromise=import(path.join(root,'runtime','codex-bridge.mjs')).then(async m=>{
      const b=new m.CodexBridge({root,workspaceRoot:root,stateDir:path.join(stateDir,'chat')});
      if(b.init)await b.init();
      return b;
    });
    return bridgePromise;
  }
  async function store() {
    if(!storePromise)storePromise=(async()=>{
      await fsp.mkdir(stateDir,{recursive:true});
      const existing=await readJson(path.join(stateDir,'collections.json'),null);
      if(existing)return existing;
      let source=process.env.VIDEO_MATERIALS_DIR||'';
      for(const candidate of ['/Volumes/Untitled/2026-07','/Volumes/LaCie/2026-07'])if(!source&&fs.existsSync(candidate))source=candidate;
      const value={ collections:[], labels:{}, slogans:[], outputs:[] };
      if(source)value.collections.push({id:'classroom-202607',name:'课堂与团队 · 2026-07',path:source,kind:'content',createdAt:new Date().toISOString()});
      const company=path.join(stateDir,'company-assets'); await fsp.mkdir(company,{recursive:true});
      for(const name of ['Logo','虚拟形象','品牌规范'])await fsp.mkdir(path.join(company,name),{recursive:true});
      value.collections.push({id:'company-assets',name:'公司固定资产',path:company,kind:'company',createdAt:new Date().toISOString()});
      const exportsRoot=path.join(stateDir,'chat','workspaces');await fsp.mkdir(exportsRoot,{recursive:true});
      value.collections.push({id:'studio-outputs',name:'制作任务与导出',path:exportsRoot,kind:'content',createdAt:new Date().toISOString()});
      await writeJson(path.join(stateDir,'collections.json'),value); return value;
    })();
    return storePromise;
  }
  async function save() { await writeJson(path.join(stateDir,'collections.json'),await store()); }
  async function selectedAsset(collectionId,relativePath) {
    const actual=await collectionFile(collectionId,relativePath),data=await store();
    const category=data.labels[`${actual.collection.id}:${actual.relative}`]||SAMPLE_CATEGORIES[path.basename(actual.file)]||'待分类';
    return {name:path.basename(actual.file),path:actual.file,category};
  }
  async function collections() {
    const data=await store();
    return Promise.all(data.collections.map(async c=>({ ...c,available:await fsp.stat(c.path).then(s=>s.isDirectory()).catch(()=>false) })));
  }
  async function collectionFile(id,relative='') {
    const data=await store(),c=data.collections.find(c=>c.id===id);
    if(!c)throw error(404,'素材目录不存在');
    const base=await fsp.realpath(c.path).catch(()=>{throw error(409,'素材目录暂不可用，请连接硬盘或重新映射');});
    if(relative.split(/[\\/]/).some(p=>deniedParts.has(p)||p.startsWith('.')))throw error(403,'此路径不可浏览');
    const target=path.resolve(base,relative);
    if(!inside(base,target))throw error(403,'路径超出已映射目录');
    const real=await fsp.realpath(target).catch(()=>{throw error(404,'素材不存在');});
    if(!inside(base,real))throw error(403,'链接指向映射目录之外');
    return {collection:c,file:real,relative:path.relative(base,real)};
  }
  const mediaUrl=(base,id,rel)=>`${base}/api/media/file?collectionId=${encodeURIComponent(id)}&path=${encodeURIComponent(rel)}`;
  function entry(base,c,rel,dirent,data) {
    const type=dirent.isDirectory()?'directory':IMAGE.has(path.extname(rel).toLowerCase())?'image':VIDEO.has(path.extname(rel).toLowerCase())?'video':AUDIO.has(path.extname(rel).toLowerCase())?'audio':'file';
    const key=`${c.id}:${rel}`,category=data.labels[key]||SAMPLE_CATEGORIES[path.basename(rel)]||'待分类';
    return { id:key,name:dirent.name,type,isDirectory:dirent.isDirectory(),relativePath:rel,path:path.join(c.path,rel),sourcePath:path.join(c.path,rel),collectionId:c.id,category,reviewed:!!data.labels[key]||!!SAMPLE_CATEGORIES[path.basename(rel)],url:type==='directory'?null:mediaUrl(base,c.id,rel),thumbnailUrl:['image','video'].includes(type)?`${base}/api/media/thumbnail?collectionId=${encodeURIComponent(c.id)}&path=${encodeURIComponent(rel)}`:null };
  }
  async function listMedia(url,base) {
    const id=url.searchParams.get('collectionId'),folder=url.searchParams.get('folder')||'',category=url.searchParams.get('category');
    const data=await store();
    if(!id)return {entries:[],breadcrumbs:[],categories:CATEGORY_NAMES};
    const {collection:c,file}=await collectionFile(id,folder);
    if(!(await fsp.stat(file)).isDirectory())throw error(400,'请选择目录');
    let entries=(await fsp.readdir(file,{withFileTypes:true})).filter(d=>!d.name.startsWith('.')&&(d.isDirectory()||MEDIA.has(path.extname(d.name).toLowerCase())||c.kind==='company'&&/\.(txt|md|pdf|svg)$/i.test(d.name))).map(d=>entry(base,c,path.join(folder,d.name),d,data));
    const counts=Object.fromEntries(CATEGORY_NAMES.map(cat=>[cat,entries.filter(e=>e.type!=='directory'&&e.category===cat).length]));
    if(category&&category!=='all')entries=entries.filter(e=>e.type==='directory'||e.category===category);
    const q=(url.searchParams.get('q')||'').toLowerCase(); if(q)entries=entries.filter(e=>[e.name,e.category].join(' ').toLowerCase().includes(q));
    entries.sort((a,b)=>(b.type==='directory')-(a.type==='directory')||a.name.localeCompare(b.name,'zh-CN'));
    const parts=folder.split('/').filter(Boolean);
    return {collection:c,folder,entries,categories:CATEGORY_NAMES,categoryCounts:counts,breadcrumbs:[{name:c.name,path:''},...parts.map((name,i)=>({name,path:parts.slice(0,i+1).join('/')}))],slogans:c.kind==='company'?data.slogans:[],total:entries.length};
  }
  async function thumbnail(req,res,url) {
    const {file}=await collectionFile(url.searchParams.get('collectionId'),url.searchParams.get('path')||'');
    if(path.extname(file).toLowerCase()==='.svg')return sendFile(req,res,file);
    if(!IMAGE.has(path.extname(file).toLowerCase())&&!VIDEO.has(path.extname(file).toLowerCase()))throw error(400,'此文件没有缩略图');
    const stat=await fsp.stat(file),hash=createHash('sha256').update(file+stat.mtimeMs).digest('hex');
    const target=path.join(stateDir,'thumbnails',hash+'.jpg');
    if(!fs.existsSync(target)) {
      if(!thumbJobs.has(hash))thumbJobs.set(hash,(async()=>{
        await fsp.mkdir(path.dirname(target),{recursive:true});
        const temp=target+'.pending.jpg',args=['-nostdin','-hide_banner','-loglevel','error','-y'];
        if(VIDEO.has(path.extname(file).toLowerCase()))args.push('-ss','0');
        args.push('-i',file,'-frames:v','1','-vf','scale=640:400:force_original_aspect_ratio=decrease','-q:v','5',temp);
        try { await exec(process.env.FFMPEG_BIN||'ffmpeg',args,{timeout:25000}); await fsp.rename(temp,target); }
        finally { await fsp.unlink(temp).catch(()=>{}); }
      })().finally(()=>thumbJobs.delete(hash)));
      await thumbJobs.get(hash);
    }
    return sendFile(req,res,target);
  }
  async function videos(base) {
    const manifest=await readJson(path.join(root,'bundled','manifest.json'),{videos:[]});
    const data=await store();
    const auto=[];
    const outputCollection=data.collections.find(c=>c.id==='studio-outputs');
    if(outputCollection) {
      const tasks=await fsp.readdir(outputCollection.path,{withFileTypes:true}).catch(()=>[]);
      for(const task of tasks.filter(d=>d.isDirectory()).slice(0,100)) {
        const dir=path.join(outputCollection.path,task.name,'exports');
        const files=await fsp.readdir(dir,{withFileTypes:true}).catch(()=>[]);
        for(const file of files.filter(d=>d.isFile()&&VIDEO.has(path.extname(d.name).toLowerCase()))) {
          const rel=path.join(task.name,'exports',file.name);
          auto.push({id:`export-${task.name}-${file.name}`,title:path.parse(file.name).name,videoPath:mediaUrl(base,outputCollection.id,rel),posterPath:`${base}/api/media/thumbnail?collectionId=${outputCollection.id}&path=${encodeURIComponent(rel)}`,bundled:false,style:'我的作品'});
        }
      }
    }
    return [...manifest.videos.map(v=>({...v,videoPath:base+v.videoPath,posterPath:base+v.posterPath})),...auto,...data.outputs.map(v=>({...v,videoPath:mediaUrl(base,v.collectionId,v.relativePath),posterPath:v.posterPath||null,bundled:false}))];
  }
  async function toolStatus() {
    try { return await (await bridge()).status(); }
    catch(e) { return {configured:false,tools:[{id:'codex',name:'Codex CLI',status:'error',detail:e.message}]}; }
  }
  async function handle(req,res,{mountPath=''}={}) {
    const full=new URL(req.url,`http://${req.headers.host||'localhost'}`),base=mountPath.replace(/\/$/,''),pathname=full.pathname.slice(base.length)||'/';
    try {
      if(!['GET','HEAD','POST','PATCH','DELETE'].includes(req.method))throw error(405,'不支持的请求方式');
      if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`&&req.headers.origin!==`https://${req.headers.host}`)throw error(403,'请求来源不匹配');
      if(pathname==='/api/studio/bootstrap'&&req.method==='GET') {
        const runtime=await toolStatus();
        const manifest=await readJson(path.join(root,'bundled','manifest.json'),{});
        const styles=manifest.videos||[];
        let sessions=[]; try{sessions=await(await bridge()).listSessions();}catch{}
        return json(res,{videos:await videos(base),skills:styles.map(v=>({id:v.sourceSkill||`chatcut-source-pack-${String(v.styleId).padStart(2,'0')}`,name:v.title,title:v.title,description:v.description||v.subtitle||'',styleId:v.styleId})),tools:runtime.tools||runtime,cli:runtime,collections:await collections(),slogans:(await store()).slogans,sessions,automaticUrl});
      }
      if(pathname==='/api/status'&&req.method==='GET')return json(res,{online:true,...await toolStatus()});
      if(pathname==='/api/media'&&req.method==='GET')return json(res,await listMedia(full,base));
      if(pathname==='/api/media/thumbnail'&&['GET','HEAD'].includes(req.method))return await thumbnail(req,res,full);
      if(pathname==='/api/media/file'&&['GET','HEAD'].includes(req.method)) {
        const {file}=await collectionFile(full.searchParams.get('collectionId'),full.searchParams.get('path')||'');
        if(!MEDIA.has(path.extname(file).toLowerCase())&&!/\.(txt|md|pdf|svg)$/i.test(file))throw error(403,'此文件类型不可预览');
        return await sendFile(req,res,file,{download:full.searchParams.get('download')==='1'});
      }
      if(pathname==='/api/collections'&&req.method==='GET')return json(res,{collections:await collections()});
      if(pathname==='/api/collections'&&req.method==='POST') {
        const b=await body(req); if(!path.isAbsolute(b.path||''))throw error(400,'请输入绝对目录路径');
        const real=await fsp.realpath(b.path).catch(()=>{throw error(400,'目录不存在或没有读取权限');});
        if(real===path.parse(real).root||real===os.homedir()||real.split(path.sep).some(p=>deniedParts.has(p)))throw error(400,'请选择具体的素材目录');
        if(!(await fsp.stat(real)).isDirectory())throw error(400,'需要一个目录路径');
        const data=await store(); if(data.collections.some(c=>c.path===real))throw error(409,'该目录已映射');
        const c={id:randomUUID(),name:String(b.name||path.basename(real)).slice(0,100),path:real,kind:b.kind==='company'?'company':'content',createdAt:new Date().toISOString()};
        data.collections.push(c);await save();return json(res,c,201);
      }
      const collectionMatch=/^\/api\/collections\/([\w-]+)$/.exec(pathname);
      if(collectionMatch&&req.method==='DELETE') { const data=await store();data.collections=data.collections.filter(c=>c.id!==collectionMatch[1]);await save();return json(res,{removed:true}); }
      if(pathname==='/api/assets/category'&&req.method==='POST') {
        const b=await body(req);await collectionFile(b.collectionId,b.relativePath);if(!CATEGORY_NAMES.includes(b.category))throw error(400,'分类无效');
        const data=await store();data.labels[`${b.collectionId}:${b.relativePath}`]=b.category;await save();return json(res,{saved:true});
      }
      if(pathname==='/api/assets/slogan'&&req.method==='POST') {
        const b=await body(req),text=String(b.text||'').trim();if(!text||text.length>1000)throw error(400,'请输入 1–1000 字的 Slogan');
        const data=await store(),item={id:randomUUID(),name:String(b.name||'公司 Slogan').slice(0,100),text,createdAt:new Date().toISOString()};data.slogans.push(item);await save();return json(res,item,201);
      }
      if(pathname==='/api/chat/sessions'&&req.method==='GET')return json(res,{sessions:await(await bridge()).listSessions()});
      if(pathname==='/api/chat/sessions'&&req.method==='POST')return json(res,await(await bridge()).createSession(await body(req)),201);
      const chatMatch=/^\/api\/chat\/sessions\/([\w-]+)(?:\/(messages|cancel|events))?$/.exec(pathname);
      if(chatMatch) {
        const [,id,action]=chatMatch,b=await bridge();
        if(!action&&req.method==='GET')return json(res,await b.getSession(id));
        if(action==='messages'&&req.method==='POST') {
          const input=await body(req);if(!String(input.message||'').trim())throw error(400,'请输入制作要求');
          const assetContext=[];
          for(const asset of (input.assetContext||[]).slice(0,30)) {
            const savedSlogan=(await store()).slogans.find(s=>s.id===asset.id||`slogan:${s.id}`===asset.id);
            if(savedSlogan)assetContext.push({name:savedSlogan.name,text:savedSlogan.text,type:'text'});
            else if(asset.collectionId&&asset.relativePath)assetContext.push(await selectedAsset(asset.collectionId,asset.relativePath));
            else if(asset.id) {const i=asset.id.indexOf(':');if(i>0)assetContext.push(await selectedAsset(asset.id.slice(0,i),asset.id.slice(i+1)));}
          }
          const result=await b.send(id,{message:input.message,skillIds:input.skillIds||[],assetContext,modules:input.modules||{}});
          return json(res,result||{accepted:true},202);
        }
        if(action==='cancel'&&req.method==='POST')return json(res,await b.cancel(id));
        if(action==='events'&&req.method==='GET') {
          await b.getSession(id);res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(': connected\n\n');
          const unsub=b.subscribe(id,e=>res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`),{after:Number(full.searchParams.get('after')||req.headers['last-event-id'])||0});
          const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);req.on('close',()=>{clearInterval(heartbeat);unsub?.();});return;
        }
      }
      if(pathname==='/api/outputs'&&req.method==='POST') {
        const b=await body(req),{file}=await collectionFile(b.collectionId,b.relativePath);
        if(!VIDEO.has(path.extname(file).toLowerCase()))throw error(400,'请选择成片视频文件');
        const data=await store(),v={id:randomUUID(),title:String(b.title||path.basename(file)),collectionId:b.collectionId,relativePath:b.relativePath,createdAt:new Date().toISOString()};data.outputs.push(v);await save();return json(res,v,201);
      }
      if(pathname.startsWith('/api/'))throw error(404,'接口不存在');
      let file;
      if(pathname.startsWith('/bundled/'))file=path.join(root,'bundled',decodeURIComponent(pathname.slice('/bundled/'.length)));
      else file=path.join(root,'dist',pathname==='/'||pathname==='/index.html'?'index.html':decodeURIComponent(pathname.slice(1)));
      const allowed=pathname.startsWith('/bundled/')?path.join(root,'bundled'):path.join(root,'dist');
      if(!inside(allowed,path.resolve(file)))throw error(403,'路径无效');
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self' http://127.0.0.1:8892; object-src 'none'; base-uri 'self'");
      return await sendFile(req,res,file,{download:full.searchParams.get('download')==='1'});
    } catch(e) {
      if(res.headersSent){res.end();return;}
      const status=e.statusCode||(e.code==='ENOENT'?404:500);
      if(status===500)console.error('[video-studio]',e.message);
      return json(res,{error:e.message||'操作失败'},status);
    }
  }
  return {handle,bridge,collections};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=createVideoStudio(),port=Number(process.env.VIDEO_STUDIO_PORT||8890);
  const server=http.createServer((req,res)=>{
    const host=String(req.headers.host||'').split(':')[0];
    if(!['127.0.0.1','localhost','[::1]'].includes(host)){res.writeHead(403);return res.end('Invalid host');}
    return app.handle(req,res);
  });
  server.listen(port,'127.0.0.1',()=>console.log(`内容生成工作台 http://127.0.0.1:${port}/`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close();process.exit(0);});
}
