import copy
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import ExitStack
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'));sys.path.insert(0,str(ROOT))
import app
import comparison as comp
import factory
import llm_api
from collect import save
from styles import get_style
from creative_exploration import AGENT_IDS


def verdict(ids):
    return {'summary':'对比完整叙事与具体用途','recommended_style':ids[0],'reason':'开头结尾呼应',
            'verdicts':[{'style_id':s,'strengths':['具体问题开场'],'weaknesses':['缺少实测'],
                         'best_for':'需要了解工具的人','observations':[{'scene':1,'note':'从实际问题切入'}]} for s in ids]}


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.cfg={'llm':{'provider':'responses','base_url':'https://example.test/v1','model':'fixture','api_key':'private-fixture'},'tts':{'provider':'edge'}}
        self.fixture=json.loads((ROOT/'tests/fixtures/v2-script.json').read_text())
        self.env=patch.dict(os.environ,{'VIDEO_LLM_API_KEY':'','VIDEO_TTS_API_KEY':''});self.env.start();self.addCleanup(self.env.stop)
        save(self.root/'data/feed.json',{'candidates':[{'id':'example/project','weekly_stars':123}]})

    def enrich(self,repo,folder):
        evidence={'url':'https://github.com/example/project/tree/abc','commit':'abc','readme':'Fixed official evidence','repo':repo}
        save(folder/'evidence.json',evidence)
        return evidence

    def render(self,run):
        (run/'video.mp4').write_bytes(b'fixture')
        save(run/'validation.json',{'duration':70,'full_decode':'passed'})

    def voice(self,run,settings):
        spec=json.loads((run/'script.json').read_text())
        for i,s in enumerate(spec['scenes']):s.update({'from':i*90,'durationFrames':90})
        save(run/'render-props.json',spec)

    def sample(self,run):
        spec=json.loads((run/'script.json').read_text())
        return ['data:image/jpeg;base64,ZmFrZQ=='],[{'scene':1,'seconds':1.5,'url':f'/runs/{run.name}/review-frames/00.jpg'}]

    def setup_pipeline(self,stack,fail_style=None,barrier=None,topic=False):
        calls=[]
        def generate(settings,instructions,prompt,**kwargs):
            style=next(s for s in AGENT_IDS if '"name": "'+s+'"' in instructions)
            calls.append(style)
            if barrier:barrier.wait(timeout=4)
            if style==fail_style:raise ValueError('mock failure private-fixture')
            spec=copy.deepcopy(self.fixture)
            if topic:
                for scene in spec['scenes']:
                    scene['sourceIds']=['s1']
                    if scene['type']=='stats':scene['type']='concept'
            spec['creator_pitch']={'approach':style,'strengths':['第1场提出问题'],'tradeoff':'没有亲测'}
            return json.dumps(spec)
        stack.enter_context(patch.object(factory,'ROOT',self.root))
        stack.enter_context(patch.object(comp,'plan_creative_brief',side_effect=lambda a,e,s:{k:(a['agent_id'] if k=='name' else '题材专用表达') for k in ['name','opening','story_arc','visual_plan','narration_direction','ending','creative_prompt','tradeoff']}))
        enrich=stack.enter_context(patch.object(comp,'enrich',side_effect=self.enrich))
        stack.enter_context(patch.object(factory,'generate',side_effect=generate))
        stack.enter_context(patch.object(comp,'synthesize',side_effect=self.voice))
        render=stack.enter_context(patch.object(comp,'render',side_effect=self.render))
        stack.enter_context(patch.object(comp,'sample_video',side_effect=self.sample))
        review=stack.enter_context(patch.object(comp,'generate',side_effect=lambda settings,instructions,prompt,**kw:json.dumps(verdict([v['style_id'] for v in json.loads(prompt)['videos']]))))
        return calls,enrich,render,review

    def test_custom_topic_is_researched_once_and_shared_across_all_styles(self):
        topic={'title':'Agent 怎么拆分任务','angle':'面向初学者','urls':[],'search_mode':'public'}
        batch=comp.create_batch(self.root,None,self.cfg,topic=topic)
        evidence={'kind':'topic','topic':topic,'repo':topic['title'],'url':'https://example.com/docs','trending':None,
                  'brief':{'summary':'按依赖编排'},'sources':[{'id':'s1','url':'https://example.com/docs','title':'Source'}],
                  'documents':[{'id':'s1','text':'Source evidence'}]}
        def research(topic,folder,settings,**kwargs):
            save(folder/'evidence.json',evidence)
            save(folder/'research.json',{'brief':{'summary':'按依赖编排'},'sources':evidence['sources'],'queries':['planning'],'limitations':[]})
            return evidence
        with ExitStack() as stack:
            calls,enrich,render,review=self.setup_pipeline(stack,topic=True)
            research_call=stack.enter_context(patch.object(comp,'research_topic',side_effect=research))
            result=comp.run_batch(self.root,batch['id'],self.cfg)
        self.assertEqual(result['status'],'done');research_call.assert_called_once();enrich.assert_not_called()
        self.assertCountEqual(calls,AGENT_IDS);self.assertEqual(render.call_count,3)
        for agent in result['agents']:
            run=self.root/'runs'/agent['run'];spec=json.loads((run/'script.json').read_text())
            self.assertEqual(spec['source_kind'],'topic');self.assertEqual(spec['sources'],evidence['sources'])
            self.assertTrue((run/'research.json').exists())
        payload=json.loads(review.call_args.args[2]);self.assertIsNone(payload['official_evidence']['trending'])
        self.assertEqual(result['research']['summary'],'按依赖编排')

    def test_three_isolated_parallel_calls_share_evidence_and_review_actual_outputs(self):
        batch=comp.create_batch(self.root,'example/project',self.cfg)
        with ExitStack() as stack:
            calls,enrich,render,review=self.setup_pipeline(stack,barrier=threading.Barrier(3))
            result=comp.run_batch(self.root,batch['id'],self.cfg)
        self.assertEqual(result['status'],'done');self.assertCountEqual(calls,AGENT_IDS)
        enrich.assert_called_once();self.assertEqual(render.call_count,3);review.assert_called_once()
        self.assertEqual(len(review.call_args.kwargs['images']),3)
        payload=json.loads(review.call_args.args[2]);self.assertNotIn('creator_pitch',json.dumps(payload))
        self.assertNotIn('creative_prompt',json.dumps(payload));self.assertNotIn('assignment',json.dumps(payload))
        self.assertNotIn('-agent-',json.dumps(payload));self.assertNotIn('/runs/',json.dumps(payload))
        self.assertEqual([v['style_id'] for v in payload['videos']],['version-1','version-2','version-3'])
        self.assertTrue(result['review']['blind'])
        self.assertEqual(result['review']['result']['recommended_style'],result['experiment']['review_order'][0])
        self.assertEqual(payload['official_evidence']['trending']['weekly_stars'],123)
        self.assertEqual(result['review']['mode'],'keyframes');self.assertIsNone(result['selected_style'])
        self.assertEqual(comp.choose(self.root,batch['id'],'agent-b')['selected_style'],'agent-b')
        for file in self.root.rglob('*.json'):self.assertNotIn('private-fixture',file.read_text())

    def test_multiple_selection_is_persisted_for_library(self):
        batch=comp.create_batch(self.root,'example/project',self.cfg)
        batch['status']='done'
        for agent in batch['agents']:
            agent.update(status='done',title=agent['agent_id'],video='/runs/'+agent['run']+'/video.mp4')
        save(comp.batch_path(self.root,batch['id']),batch)
        result=comp.choose(self.root,batch['id'],['agent-a','agent-c'])
        self.assertEqual(result['selected_styles'],['agent-a','agent-c'])
        self.assertIsNone(result['selected_style'])
        persisted=comp.read_batch(self.root,batch['id'])
        self.assertEqual(persisted['selected_styles'],['agent-a','agent-c'])
        self.assertEqual(comp.choose(self.root,batch['id'],[])['selected_styles'],[])

    def test_supervisor_feedback_restarts_only_targeted_route_and_preserves_other_selection(self):
        batch=comp.create_batch(self.root,'example/project',self.cfg)
        batch['status']='done'
        for agent in batch['agents']:
            agent.update(status='done',title=agent['agent_id'],video='/runs/'+agent['run']+'/video.mp4',
                         brief={'name':agent['agent_id']})
        batch['selected_styles']=['agent-b','agent-c'];batch['selected_style']=None
        save(comp.batch_path(self.root,batch['id']),batch)
        evidence_dir=self.root/'data/comparisons'/batch['id'];evidence_dir.mkdir(parents=True,exist_ok=True)
        save(evidence_dir/'evidence.json',{'repo':'example/project','url':'https://example.test/readme'})
        supervisor={'summary':'缩短 A 并补结尾','plans':[{'agent_id':'agent-a','instructions':'压缩中段并补一个回答开头的问题的结尾','expected_change':'节奏更紧，结尾闭环'}]}
        with patch.object(comp,'generate',return_value=json.dumps(supervisor,ensure_ascii=False)):
            result=comp.supervise_batch(self.root,batch['id'],self.cfg,agent_feedback={'agent-a':'这一版太长，结尾戛然而止'})
        updated=comp.read_batch(self.root,batch['id'])
        agent_a=next(a for a in updated['agents'] if a['agent_id']=='agent-a')
        agent_b=next(a for a in updated['agents'] if a['agent_id']=='agent-b')
        self.assertEqual(result['round'],2)
        self.assertEqual(agent_a['status'],'queued')
        self.assertEqual(agent_a['run'],batch['id']+'-r2-agent-a')
        self.assertEqual(agent_b['status'],'done')
        self.assertEqual(updated['selected_styles'],['agent-b','agent-c'])
        self.assertIn('太长',agent_a['supervisor_feedback'])

    def test_reject_all_creates_three_new_videos_and_reviews_again(self):
        batch=comp.create_batch(self.root,'example/project',self.cfg)
        with ExitStack() as stack:
            self.setup_pipeline(stack)
            previous=comp.run_batch(self.root,batch['id'],self.cfg)
        comp.choose(self.root,batch['id'],list(AGENT_IDS))
        original_runs={a['run'] for a in previous['agents']}
        for global_feedback,all_rejected in [('三条都太长，压到50秒',False),('',True)]:
            with self.subTest(all_rejected=all_rejected):
                plan={'summary':'缩短三路并保留闭环','plans':[{'agent_id':aid,'instructions':'目标50秒，约200字，删减中段重复解释，保留开头和结尾','expected_change':'更紧凑'} for aid in AGENT_IDS]}
                with patch.object(comp,'generate',return_value=json.dumps(plan)) as supervisor:
                    revised=comp.supervise_batch(self.root,batch['id'],self.cfg,global_feedback=global_feedback,all_rejected=all_rejected)
                self.assertEqual(revised['selected_styles'],[])
                self.assertEqual(revised['review']['status'],'pending')
                prompt=json.loads(supervisor.call_args.args[2])
                self.assertTrue(all(a['duration_seconds']==70 and a['scenes'] for a in prompt['target_agents']))
                with ExitStack() as stack:
                    calls,enrich,render,review=self.setup_pipeline(stack)
                    with patch.object(factory,'generate',wraps=factory.generate) as draft:
                        result=comp.run_batch(self.root,batch['id'],self.cfg)
                    self.assertTrue(all('目标50秒' in c.args[1] and '产出8个场景，中文旁白总计约300到380字' not in c.args[1] for c in draft.call_args_list))
                self.assertEqual(result['status'],'done');self.assertCountEqual(calls,AGENT_IDS)
                self.assertEqual(render.call_count,3);review.assert_called_once();enrich.assert_not_called()
                self.assertFalse(original_runs & {a['run'] for a in result['agents']})
                self.assertTrue(all((self.root/'runs'/run/'video.mp4').exists() for run in original_runs))

    def test_invalid_supervisor_plan_does_not_change_round_or_selections(self):
        batch=comp.create_batch(self.root,'example/project',self.cfg)
        batch['status']='done';save(comp.batch_path(self.root,batch['id']),batch)
        self.enrich(batch['repo'],self.root/'data/comparisons'/batch['id'])
        for plan in ({'summary':'bad','plans':None}, {'summary':'bad','plans':[{'agent_id':'agent-a'}]}, []):
            with patch.object(comp,'generate',return_value=json.dumps(plan)):
                with self.assertRaisesRegex(ValueError,'完整调整方案'):
                    comp.supervise_batch(self.root,batch['id'],self.cfg,agent_feedback={'agent-a':'缩短'})
            self.assertEqual(comp.read_batch(self.root,batch['id']),batch)

    def test_failed_branch_is_redacted_and_retry_preserves_finished_videos(self):
        batch=comp.create_batch(self.root,'example/project',self.cfg)
        with ExitStack() as stack:
            self.setup_pipeline(stack,fail_style='agent-b')
            result=comp.run_batch(self.root,batch['id'],self.cfg)
        self.assertEqual(result['status'],'partial')
        self.assertNotIn('private-fixture',json.dumps(result))
        self.assertEqual(len(result['review']['result']['verdicts']),2)
        with self.assertRaises(ValueError):comp.choose(self.root,batch['id'],'agent-b')
        finished={a['run']:(self.root/'runs'/a['run']/'video.mp4').stat().st_mtime_ns for a in result['agents'] if a['status']=='done'}
        original_assignments=[(a['assignment'],a['brief']) for a in result['agents']]
        with ExitStack() as stack:
            calls,enrich,render,review=self.setup_pipeline(stack)
            result=comp.run_batch(self.root,batch['id'],self.cfg)
        self.assertEqual(result['status'],'done');self.assertEqual(calls,['agent-b']);enrich.assert_not_called()
        render.assert_called_once();self.assertEqual(len(result['review']['result']['verdicts']),3)
        self.assertEqual(original_assignments,[(a['assignment'],a['brief']) for a in result['agents']])
        for run,mtime in finished.items():self.assertEqual((self.root/'runs'/run/'video.mp4').stat().st_mtime_ns,mtime)

    def test_review_failure_does_not_lose_videos_and_retries_only_review(self):
        batch=comp.create_batch(self.root,'example/project',self.cfg)
        with ExitStack() as stack:
            *_,review=self.setup_pipeline(stack)
            review.side_effect=ValueError('模型服务 HTTP 429')
            result=comp.run_batch(self.root,batch['id'],self.cfg)
        self.assertEqual(result['status'],'partial');self.assertEqual(result['review']['status'],'failed')
        self.assertTrue(all(a['status']=='done' for a in result['agents']))
        with ExitStack() as stack:
            calls,_,render,_=self.setup_pipeline(stack)
            result=comp.run_batch(self.root,batch['id'],self.cfg)
        self.assertEqual(result['status'],'done');self.assertEqual(calls,[]);render.assert_not_called()

    def test_image_rejection_falls_back_explicitly_without_image_claims(self):
        batch=comp.create_batch(self.root,'example/project',self.cfg)
        with ExitStack() as stack:
            *_,review=self.setup_pipeline(stack)
            review.side_effect=[ValueError('模型服务 HTTP 400'),json.dumps(verdict(['version-1','version-2','version-3']))]
            result=comp.run_batch(self.root,batch['id'],self.cfg)
        self.assertEqual(result['review']['mode'],'text_only');self.assertIn('未看画面',result['review']['scope'])
        self.assertNotIn('images',review.call_args.kwargs)
        self.assertNotIn('frames',review.call_args.args[2]);self.assertNotIn('image_numbers',review.call_args.args[2])

    def test_restart_recovers_only_unfinished_branches_and_ids_are_checked(self):
        batch=comp.create_batch(self.root,'example/project',self.cfg)
        batch['agents'][0]['status']='done';save(comp.batch_path(self.root,batch['id']),batch)
        with self.assertRaises(ValueError):comp.choose(self.root,batch['id'],'agent-a')
        comp.recover_batches(self.root);recovered=comp.read_batch(self.root,batch['id'])
        self.assertEqual(recovered['status'],'interrupted');self.assertEqual(recovered['agents'][0]['status'],'done')
        self.assertEqual(recovered['agents'][1]['status'],'failed')
        with self.assertRaises(ValueError):comp.read_batch(self.root,'../../config')
        with self.assertRaises(ValueError):comp.validate_review(verdict(['invented']),[{'style_id':'agent-a','scenes':[{}]}])

    def test_video_samples_are_extracted_from_encoded_file(self):
        run=self.root/'runs/sample';run.mkdir(parents=True)
        save(run/'render-props.json',{'scenes':[{'from':0,'durationFrames':30}]})
        subprocess.run(['ffmpeg','-y','-v','error','-f','lavfi','-i','color=c=red:s=120x200:d=1','-c:v','libx264','-pix_fmt','yuv420p',str(run/'video.mp4')],check=True)
        images,points=comp.sample_video(run)
        self.assertTrue(images[0].startswith('data:image/jpeg;base64,/9j/'))
        self.assertEqual(points[0]['seconds'],.5)
        self.assertTrue((run/'review-frames/00.jpg').is_file())

    def test_readiness_blocks_no_token_and_http_prevents_duplicate_job(self):
        cfg=copy.deepcopy(self.cfg);cfg['llm'].pop('api_key')
        with self.assertRaisesRegex(ValueError,'Token'):comp.create_batch(self.root,'example/project',cfg)
        self.assertFalse((self.root/'data/comparisons').exists())
        (self.root/'runs').mkdir()
        with patch.object(app,'ROOT',self.root),patch.object(app,'SETTINGS',cfg),patch.object(app,'JOB',{'status':'idle'}):
            server=ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            def post():
                req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/api/compare',data=b'{"repo":"example/project"}',headers={'Content-Type':'application/json'})
                return urllib.request.urlopen(req)
            try:
                with self.assertRaises(urllib.error.HTTPError) as error:post()
                self.assertEqual(error.exception.code,400);self.assertFalse(app.LOCK.locked())
                app.SETTINGS=copy.deepcopy(self.cfg);app.LOCK.acquire()
                try:
                    with self.assertRaises(urllib.error.HTTPError) as error:post()
                    self.assertEqual(error.exception.code,409)
                finally:app.LOCK.release()
            finally:server.shutdown();server.server_close();thread.join()

    def test_images_are_encoded_for_each_protocol_and_tokens_stay_in_headers(self):
        image='data:image/jpeg;base64,ZmFrZQ=='
        for provider in ('responses','compatible','ollama'):
            cfg={**self.cfg['llm'],'provider':provider}
            data={'output_text':'{}'} if provider=='responses' else {'choices':[{'message':{'content':'{}'}}]} if provider=='compatible' else {'message':{'content':'{}'}}
            response=io.BytesIO(json.dumps(data).encode());response.headers={'Content-Type':'application/json'}
            with patch('llm_api.urllib.request.urlopen',return_value=response) as send:
                llm_api.generate(cfg,'JSON','Review',images=[image])
            request=send.call_args.args[0];body=json.loads(request.data)
            self.assertNotIn('private-fixture',request.data.decode())
            if provider=='responses':self.assertEqual(body['input'][0]['content'][1]['image_url'],image)
            elif provider=='compatible':self.assertEqual(body['messages'][-1]['content'][1]['image_url']['url'],image)
            else:self.assertEqual(body['messages'][-1]['images'],['ZmFrZQ=='])

    def test_http_start_to_choice_and_review_frame_delivery(self):
        (self.root/'runs').mkdir()
        finished=threading.Event()
        with ExitStack() as stack:
            self.setup_pipeline(stack)
            stack.enter_context(patch.object(app,'ROOT',self.root))
            stack.enter_context(patch.object(app,'SETTINGS',copy.deepcopy(self.cfg)))
            stack.enter_context(patch.object(app,'JOB',{'status':'idle'}))
            original=app.task
            def task(*args):
                try:original(*args)
                finally:finished.set()
            stack.enter_context(patch.object(app,'task',side_effect=task))
            server=ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            base=f'http://127.0.0.1:{server.server_port}'
            def post(path,body):
                req=urllib.request.Request(base+'/api/'+path,data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
                with urllib.request.urlopen(req) as r:return r.status,json.load(r)
            try:
                status,result=post('compare',{'repo':'example/project'})
                self.assertEqual(status,202);self.assertTrue(finished.wait(8))
                with urllib.request.urlopen(base+'/api/state') as r:state=json.load(r)
                self.assertEqual(state['job']['status'],'done');self.assertFalse(app.LOCK.locked())
                self.assertEqual(len(state['runs']),3);self.assertEqual(state['comparisons'][0]['status'],'done')
                self.assertNotIn('private-fixture',json.dumps(state))
                batch_id=result['job']['comparison_id']
                _,result=post('comparison-choice',{'comparison_id':batch_id,'style_id':'agent-c'})
                self.assertEqual(result['selected_style'],'agent-c')
                self.assertEqual(comp.read_batch(self.root,batch_id)['selected_style'],'agent-c')
                _,selection=post('comparison-choice',{'comparison_id':batch_id,'agent_ids':['agent-a','agent-c']})
                self.assertEqual(selection['selected_styles'],['agent-a','agent-c'])
                with urllib.request.urlopen(base+'/api/state') as r:chosen=json.load(r)
                self.assertEqual(sum(r['comparison_selected'] for r in chosen['runs']),2)
                post('comparison-choice',{'comparison_id':batch_id,'agent_ids':[]})
                with urllib.request.urlopen(base+'/api/state') as r:cleared=json.load(r)
                self.assertFalse(any(r['comparison_selected'] for r in cleared['runs']))
                self.assertEqual(len(cleared['runs']),3)
                frame=self.root/'runs'/state['runs'][0]['id']/'review-frames/00.jpg';frame.parent.mkdir();frame.write_bytes(b'jpeg-fixture')
                with urllib.request.urlopen(base+'/runs/'+state['runs'][0]['id']+'/review-frames/00.jpg') as r:
                    self.assertEqual(r.headers['Content-Type'],'image/jpeg');self.assertEqual(r.read(),b'jpeg-fixture')
            finally:server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()
