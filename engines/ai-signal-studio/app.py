"""Local video workbench with one active job and bounded parallel creators."""
import argparse
import copy
import datetime as dt
import json
import mimetypes
import os
import re
import shutil
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT/'scripts'))
from collect import collect, save, now
from factory import config, make_draft, synthesize, render, validate
from llm_api import normalize_settings, public_settings, require_ready, test_connection
from styles import get_style, public_styles
from speech_api import normalize_speech, public_speech, stored_speech, require_speech, speech_bytes
from comparison import create_batch, run_batch, read_batch, list_batches, recover_batches, choose, supervise_batch, safe_error
from research import normalize_topic, research_topic
from runtime import base_path, config_path, public_url

LOCK = threading.Lock()
JOB = {'status':'idle','step':'等待开始'}
if (ROOT/'data/last-job.json').exists():
    JOB = json.loads((ROOT/'data/last-job.json').read_text(encoding='utf-8'))
    if JOB.get('status')=='running':
        JOB.update(status='failed',step='上次任务被中断，请重新生成')
        save(ROOT/'data/last-job.json',JOB)
SETTINGS = config()
SETTINGS['tts'] = normalize_speech({}, SETTINGS['tts'])
recover_batches(ROOT)

def style_preference():
    path=ROOT/'data/style-preference.json'
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'style_id':'baseline-v2'}

def run_path(name):
    if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',name):
        raise ValueError('任务名称不正确')
    return ROOT/'runs'/name

def public_batch(batch):
    """Serialize known local media fields without changing persisted artifacts."""
    result=copy.deepcopy(batch)
    for agent in result.get('agents',[]):
        for item in [agent,*agent.get('history',[])]:
            if item.get('video','') and item['video'].startswith('/runs/'):
                item['video']=public_url(item['video'])
    for frames in result.get('review',{}).get('samples',{}).values():
        for frame in frames:
            if frame.get('url','').startswith('/runs/'):
                frame['url']=public_url(frame['url'])
    return result

def public_job():
    result=dict(JOB)
    if result.get('comparison_id'):
        try:
            batch=read_batch(ROOT,result['comparison_id'])
            if batch.get('error'):
                result['error']=batch['error']
                if '资料' in batch.get('stage',''):
                    result['diagnosis']={'summary':batch['repo']+' 的公开资料未能读取，创作尚未开始。',
                                         'detail':batch['error'],'retry':'请检查网络后重试资料准备。'}
            result['comparison_url']=public_url('/?view=studio&comparison='+batch['id'])
        except ValueError:pass
    if result.get('run'):
        folder=run_path(result['run'])
        result['logs']={name:public_url(f'/runs/{folder.name}/{name}') for name in ['error.log','llm-response.txt','llm-response-repair.txt','generation.json','research.json'] if (folder/name).is_file()}
        if (folder/'diagnosis.json').exists():
            result['diagnosis']=json.loads((folder/'diagnosis.json').read_text(encoding='utf-8'))
    return result

def task(action, payload):
    global JOB
    run = None
    try:
        if action=='collect':
            JOB['step']='正在采集公开热点'; collect()
        elif action in ['compare','compare-retry']:
            result=run_batch(ROOT,payload['comparison_id'],SETTINGS,on_progress=lambda message:JOB.update(step=message))
            JOB.update(status='done' if result['status']=='done' else 'failed',
                       step=result['stage'],error=result.get('error'),finished_at=now())
            return
        elif action=='comparison-feedback':
            JOB.update(step='Supervisor 正在整理反馈')
            supervise_batch(ROOT,payload['comparison_id'],SETTINGS,
                            global_feedback=payload.get('global_feedback',''),
                            agent_feedback=payload.get('agent_feedback') or {},
                            all_rejected=bool(payload.get('all_rejected')))
            result=run_batch(ROOT,payload['comparison_id'],SETTINGS,on_progress=lambda message:JOB.update(step=message))
            JOB.update(status='done' if result['status']=='done' else 'failed',
                       step=result['stage'],error=result.get('error'),finished_at=now())
            return
        elif action in ['draft','build']:
            repo=payload.get('repo','')
            topic=payload.get('topic')
            if topic is None and not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',repo): raise ValueError('请选择一个 GitHub 选题')
            run=ROOT/'runs'/dt.datetime.now().strftime('run-%Y%m%d-%H%M%S-%f')
            JOB.update(run=run.name,step='读取官方资料并生成文稿',model=SETTINGS['llm']['model'],provider=SETTINGS['llm']['provider'])
            if topic is not None:
                research_topic(topic,run,SETTINGS,on_progress=lambda message:JOB.update(step=message))
                repo=topic['title']
            make_draft(repo,run,SETTINGS,on_progress=lambda message:JOB.update(step=message),style_id=payload.get('style_id',style_preference()['style_id']))
            if action=='build':
                JOB['step']='生成中文配音';synthesize(run, SETTINGS)
                JOB['step']='渲染竖屏视频并验证';render(run)
        elif action=='render':
            original=run_path(payload['run']);spec=payload['script']
            original_spec=json.loads((original/'script.json').read_text(encoding='utf-8'))
            # Keep source identity tied to the existing evidence; editable fields are scene copy.
            for key in ['repo','sources','created_at']:
                spec[key]=original_spec[key]
            for key in ['source_kind','topic_title','research_available']:
                if key in original_spec:spec[key]=original_spec[key]
                else:spec.pop(key,None)
            validate(spec)
            evidence=json.loads((original/'evidence.json').read_text(encoding='utf-8'))
            for scene in spec['scenes']:
                if scene['type']=='stats':
                    metric=(evidence.get('trending') or {}).get('weekly_stars')
                    if metric is None: raise ValueError('缺少本周增长证据')
                    scene['metric']=metric;scene['highlight']=format(metric,',')
            run=ROOT/'runs'/dt.datetime.now().strftime('edit-%Y%m%d-%H%M%S-%f');run.mkdir()
            for name in ['evidence.json','README-source.md','repository.json','research.json']:
                if (original/name).exists(): shutil.copy(original/name,run/name)
            if (original/'assets').exists():
                shutil.copytree(original/'assets',run/'assets')
            spec['editorial_status']='用户编辑后预览，待内容复核'
            spec['pacing']='conversational'
            save(run/'script.json',spec)
            JOB.update(run=run.name,step='生成中文配音');synthesize(run, SETTINGS)
            JOB['step']='渲染竖屏视频并验证';render(run)
        else: raise ValueError('未知动作')
        JOB.update(status='done',step='已完成',finished_at=now())
    except Exception as e:
        JOB.update(status='failed',step='处理失败',error=safe_error(e,SETTINGS),finished_at=now())
        if run:
            run.mkdir(exist_ok=True);(run/'error.log').write_text(safe_error(e,SETTINGS), encoding='utf-8')
    finally:
        save(ROOT/'data/last-job.json',JOB)
        LOCK.release()

class Handler(BaseHTTPRequestHandler):
    def send_json(self,value,status=200):
        body=json.dumps(value,ensure_ascii=False).encode();self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store');self.end_headers()
        if self.command!='HEAD':self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path=urlsplit(self.path).path
        if path=='/api/state':
            feed=json.loads((ROOT/'data/feed.json').read_text(encoding='utf-8')) if (ROOT/'data/feed.json').exists() else {'candidates':[],'sources':[]}
            review_file=ROOT/'data/library-review.json'
            reviews=json.loads(review_file.read_text(encoding='utf-8')).get('runs',{}) if review_file.exists() else {}
            comparison_selections={}
            for batch in list_batches(ROOT):
                selected=batch.get('selected_styles') or ([batch['selected_style']] if batch.get('selected_style') else [])
                for agent in batch.get('agents',[]):
                    agent_id=agent.get('agent_id') or agent.get('style_id')
                    if agent_id in selected and agent.get('run'):
                        comparison_selections[agent['run']]={'comparison_id':batch['id'],'round':batch.get('round',1)}
            runs=[]
            for folder in sorted((ROOT/'runs').iterdir(),reverse=True):
                review=reviews.get(folder.name,{})
                if review.get('decision')=='rejected':continue
                if not (folder/'script.json').exists():continue
                try:
                    spec=json.loads((folder/'script.json').read_text(encoding='utf-8'));v=json.loads((folder/'validation.json').read_text(encoding='utf-8')) if (folder/'validation.json').exists() else {}
                    selected_info=comparison_selections.get(folder.name,{})
                    runs.append({'id':folder.name,'title':spec['title'],'repo':spec['repo'],'video':public_url(f'/runs/{folder.name}/video.mp4') if (folder/'video.mp4').exists() and v.get('full_decode')=='passed' else None,'duration':v.get('duration'),'status':review.get('label') or spec.get('editorial_status','待复核'),'review_flags':spec.get('review_flags',[]),'quality_baseline':review.get('quality_baseline',False),'style_id':spec.get('style_id','baseline-v2'),'experiment':spec.get('experiment'),'created_at':spec.get('created_at'),'revision':spec.get('revision'),'comparison_of':spec.get('comparison_of'),'voice_note':spec.get('voice_note'),'comparison_id':spec.get('comparison_id'),'comparison_selected':bool(selected_info),'selected_comparison_id':selected_info.get('comparison_id'),'selected_round':selected_info.get('round')})
                except (ValueError,KeyError):continue
            self.send_json({'feed':feed,'runs':runs,'comparisons':[public_batch(batch) for batch in list_batches(ROOT)],'job':public_job(),'styles':public_styles(),'style_preference':style_preference(),'config':{**SETTINGS,'llm':public_settings(SETTINGS['llm']),'tts':public_speech(SETTINGS['tts'])}});return
        if path=='/api/health':self.send_json({'ok':True,'service':'AI Signal Studio'});return
        if path.startswith('/runs/'):
            file=(ROOT/unquote(path).lstrip('/')).resolve()
            if not file.is_relative_to((ROOT/'runs').resolve()) or file.suffix not in ['.mp4','.mp3','.wav','.json','.md','.srt','.png','.jpg','.log','.txt']:
                self.send_error(403);return
        else:
            file=(ROOT/'web'/('index.html' if path=='/' else unquote(path).lstrip('/'))).resolve()
            if not file.is_relative_to((ROOT/'web').resolve()):self.send_error(403);return
        if not file.is_file():self.send_error(404);return
        if file.suffix=='.html' and file.is_relative_to((ROOT/'web').resolve()):
            # Only this explicit template slot is dynamic; static assets and
            # all media continue to stream byte-for-byte, including Range.
            body=file.read_text(encoding='utf-8').replace('__SIGNAL_BASE_PATH__',base_path()).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type','text/html; charset=utf-8')
            self.send_header('Content-Length',str(len(body)))
            self.send_header('Cache-Control','no-store')
            self.end_headers()
            if self.command!='HEAD':self.wfile.write(body)
            return
        size=file.stat().st_size;start=0;end=size-1;partial=False
        rng=self.headers.get('Range')
        if rng:
            match=re.fullmatch(r'bytes=(\d*)-(\d*)',rng)
            if not match or not any(match.groups()):self.send_error(416);return
            a,b=match.groups()
            if a:start=int(a);end=min(int(b),size-1) if b else size-1
            else:start=max(0,size-int(b))
            if start>end or start>=size:self.send_response(416);self.send_header('Content-Range',f'bytes */{size}');self.end_headers();return
            partial=True
        self.send_response(206 if partial else 200)
        self.send_header('Content-Type','text/plain; charset=utf-8' if file.suffix in ['.log','.txt'] else mimetypes.guess_type(str(file))[0] or 'application/octet-stream')
        self.send_header('Accept-Ranges','bytes');self.send_header('Content-Length',str(end-start+1))
        if partial:self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
        self.end_headers()
        if self.command=='HEAD':return
        try:
            with file.open('rb') as stream:
                stream.seek(start);remaining=end-start+1
                while remaining:
                    chunk=stream.read(min(262144,remaining))
                    if not chunk:break
                    self.wfile.write(chunk);remaining-=len(chunk)
        except (BrokenPipeError,ConnectionResetError):pass

    def do_POST(self):
        global JOB,SETTINGS
        # Prevent other websites from silently starting local generation jobs.
        host=self.headers.get('Host','');origin=self.headers.get('Origin')
        if host not in {f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'} or (origin and origin not in {'http://'+host}):
            self.send_json({'error':'仅接受本地工作台操作'},403);return
        try:
            size=int(self.headers.get('Content-Length',0))
            if size<0 or size>1000000:raise ValueError('请求过大')
            payload=json.loads(self.rfile.read(size) or b'{}')
            if not isinstance(payload,dict):raise ValueError('请求内容必须是对象')
            action=urlsplit(self.path).path.removeprefix('/api/')
            if action in ('draft','build','compare') and 'topic' in payload:
                payload['topic']=normalize_topic(payload['topic'])
                if payload['topic']['search_mode']=='model' and SETTINGS['llm']['provider']!='responses':
                    raise ValueError('请使用支持联网搜索的 Responses 服务，或选择自动搜索')
            if action=='comparison-choice':
                if LOCK.locked():
                    self.send_json({'error':'请等待当前任务结束后保存选择'},409);return
                ids=payload['agent_ids'] if 'agent_ids' in payload else (payload.get('agent_id') or payload.get('style_id'))
                result=choose(ROOT,payload.get('comparison_id'),ids)
                self.send_json({'ok':True,'selected_style':result['selected_style'],
                                'selected_styles':result.get('selected_styles',[])});return
            if action=='style-preference':
                style=get_style(payload['style_id'])
                save(ROOT/'data/style-preference.json',{'style_id':style['id'],'updated_at':now()})
                self.send_json({'ok':True,'style_id':style['id']});return
            if action=='config':
                if LOCK.locked():raise ValueError('任务运行中，请完成后再改设置')
                llm=normalize_settings(payload['llm'],SETTINGS['llm'])
                voice=normalize_speech(payload.get('tts',{}),SETTINGS['tts'])
                if 'tts' in payload:
                    tts=payload['tts']
                    if tts.get('provider') not in ['edge','openai','qwen']:raise ValueError('配音服务不正确')
                    if tts.get('edge_voice') not in ['zh-CN-YunjianNeural','zh-CN-XiaoxiaoNeural','zh-CN-YunyangNeural','zh-CN-YunxiNeural']:raise ValueError('请选择可用音色')
                    if tts.get('rate') not in ['-5%','-3%','-2%','+0%','+5%','+10%','+15%','+20%']:raise ValueError('请选择可用语速')
                    if tts.get('pitch','+0Hz') not in ['-2Hz','-1Hz','+0Hz','+1Hz','+2Hz']:raise ValueError('请选择可用音高')
                    voice.update({k:tts[k] for k in ['provider','edge_voice','rate']})
                    voice['pitch']=tts.get('pitch','+0Hz')
                    if 'use_style_presets' in tts:
                        if not isinstance(tts['use_style_presets'],bool):raise ValueError('风格配音选项必须是布尔值')
                        voice['use_style_presets']=tts['use_style_presets']
                SETTINGS={**SETTINGS,'llm':llm,'tts':voice}
                stored={**SETTINGS,'tts':stored_speech(voice),'llm':{k:v for k,v in SETTINGS['llm'].items() if k!='api_key'}}
                save(config_path(ROOT),stored);self.send_json({'ok':True});return
            if action=='test-voice':
                if SETTINGS['tts'].get('provider') != 'openai': raise ValueError('试听API音色时请选择OpenAI语音')
                require_speech(SETTINGS['tts'])
                if not LOCK.acquire(blocking=False): self.send_json({'error':'已有任务正在运行'},409);return
                try:
                    folder=ROOT/'runs'/'voice-preview';folder.mkdir(exist_ok=True)
                    speech=speech_bytes(SETTINGS['tts'],'你有没有遇到过这种情况？刚跟 AI 讲清楚项目，换个对话，又得从头再来。')
                    name=dt.datetime.now().strftime('preview-%Y%m%d-%H%M%S-%f.wav')
                    (folder/name).write_bytes(speech)
                    self.send_json({'ok':True,'audio':public_url(f'/runs/voice-preview/{name}')})
                finally:LOCK.release()
                return
            if action=='test-model':
                if not LOCK.acquire(blocking=False):self.send_json({'error':'已有任务正在运行'},409);return
                try:self.send_json(test_connection(SETTINGS['llm']))
                finally:LOCK.release()
                return
            if action in ['build','render','compare','compare-retry','comparison-feedback']: require_speech(SETTINGS['tts'])
            if action not in ['collect','draft','build','render','compare','compare-retry','comparison-feedback']:self.send_json({'error':'未知操作'},404);return
            if action in ['compare','compare-retry','comparison-feedback']:
                require_ready(SETTINGS['llm'])
                if action=='compare' and 'topic' not in payload and (not isinstance(payload.get('repo'),str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',payload['repo'])):
                    raise ValueError('请选择一个 GitHub 选题')
                if action=='compare-retry':
                    previous=read_batch(ROOT,payload.get('comparison_id'))
                    if previous['status']=='running':raise ValueError('对比任务正在运行')
                    if previous['status']=='done':raise ValueError('此对比已完成，无需重试')
                if action=='comparison-feedback':
                    previous=read_batch(ROOT,payload.get('comparison_id'))
                    if previous['status']=='running':raise ValueError('对比任务正在运行')
                    if not isinstance(payload.get('agent_feedback',{}),dict):raise ValueError('分路反馈格式不正确')
                    if not isinstance(payload.get('all_rejected',False),bool):raise ValueError('全部否决必须是布尔值')
                    if not payload.get('all_rejected') and not str(payload.get('global_feedback','')).strip() and not any(str(v).strip() for v in (payload.get('agent_feedback') or {}).values()):
                        raise ValueError('请填写反馈，或选择三版全部否决')
            if action in ['draft','build']:
                get_style(payload.get('style_id',style_preference()['style_id']))
                require_ready(SETTINGS['llm'])
            if not LOCK.acquire(blocking=False):self.send_json({'error':'已有任务正在运行'},409);return
            try:
                if action=='compare':
                    batch=create_batch(ROOT,payload.get('repo'),SETTINGS,topic=payload.get('topic'))
                    payload['comparison_id']=batch['id']
            except Exception:
                LOCK.release();raise
            JOB={'status':'running','step':'准备开始','action':action,'started_at':now()}
            if action in ['compare','compare-retry','comparison-feedback']:JOB['comparison_id']=payload['comparison_id']
            save(ROOT/'data/last-job.json',JOB)
            threading.Thread(target=task,args=(action,payload),daemon=True).start()
            self.send_json({'ok':True,'job':JOB},202)
        except (ValueError,KeyError,TypeError) as e:self.send_json({'error':str(e)},400)

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--host',default=os.environ.get('SIGNAL_HOST','127.0.0.1'))
    parser.add_argument('--port',type=int,default=int(os.environ.get('SIGNAL_PORT','8892')))
    a=parser.parse_args()
    base_path()
    server=ThreadingHTTPServer((a.host,a.port),Handler)
    print(f'AI Signal Studio → http://{a.host}:{a.port}',flush=True)
    server.serve_forever()
