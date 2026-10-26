import copy
import io
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'));sys.path.insert(0,str(ROOT))
import app
import factory
import llm_api
import research as r
import public_web as web
from collect import save

QUOTE='The planner identifies independent tasks for parallel execution.'
PAGE=QUOTE+' The dispatcher waits for the dependencies of each task. '*8

def brief(sid='s1',ready=True,followups=None):
    return {'ready':ready,'summary':'任务按依赖关系执行','claims':[
        {'text':'识别独立任务','evidence':[{'source_id':sid,'quote':QUOTE}]},
        {'text':'等待前置任务','evidence':[{'source_id':sid,'quote':'The dispatcher waits for the dependencies of each task.'}]}],
        'limitations':[],'followup_queries':followups or []}


class ResearchTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.run=self.root/'runs/test'
        self.topic={'title':'Agent 的任务编排','angle':'面向初学者','urls':['https://example.com/docs'],'search_mode':'public'}
        self.cfg={'llm':{'provider':'responses','base_url':'https://example.com/v1','model':'fixture','api_key':'fixture-secret'},'tts':{'provider':'edge'}}
        env=patch.dict(os.environ,{'VIDEO_LLM_API_KEY':'','VIDEO_TTS_API_KEY':''});env.start();self.addCleanup(env.stop)

    def test_private_urls_and_credentials_are_rejected_before_reading(self):
        for url in ['file:///etc/passwd','http://localhost','http://127.0.0.1','http://[::1]',
                    'https://10.0.0.2','http://198.18.0.1','https://example.com:8443',
                    'https://user:pass@example.com','https://example.com?api_key=secret']:
            with self.subTest(url=url),self.assertRaises(ValueError):r.public_url(url)
        with patch.object(web.socket,'getaddrinfo',return_value=[(2,1,6,'',('10.0.0.8',443))]):
            with self.assertRaises(ValueError):r.public_url('https://example.com',resolve=True,allow_proxy_dns=True)
        handler=web.PublicRedirect({'https':'http://127.0.0.1:7890'})
        with self.assertRaises(ValueError):handler.redirect_request(None,None,302,'',{},'http://127.0.0.1/secret')

    def test_fake_dns_only_uses_configured_loopback_proxy_for_public_names(self):
        with patch.object(web.socket,'getaddrinfo',return_value=[(2,1,6,'',('198.18.0.3',443))]):
            with self.assertRaises(ValueError):r.public_url('https://example.com',resolve=True)
            self.assertEqual(r.public_url('https://example.com',True,True),'https://example.com/')
            with self.assertRaises(ValueError):r.public_url('https://198.18.0.3',True,True)
            proxy=web.PublicProxy({'https':'http://127.0.0.1:7890'})
            req=urllib.request.Request('https://example.com/docs')
            proxy.proxy_open(req,'http://127.0.0.1:7890','https')
            self.assertEqual(req.host,'127.0.0.1:7890');self.assertEqual(req._tunnel_host,'example.com')
            self.assertIsNone(req.get_header('Authorization'))
        self.assertFalse(web.proxy_dns_allowed('https://example.com',{'https':'http://proxy.example.com:80'}))

    def test_extracts_body_and_lite_search_links_not_navigation_or_scripts(self):
        title,text=r.extract_page('<title>Official docs</title><nav>Login junk</nav><main>'+PAGE+'<script>private junk</script></main>')
        self.assertEqual(title,'Official docs');self.assertIn(QUOTE,text)
        self.assertNotIn('junk',text)
        html='<a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Original document</a>'
        with patch.object(r,'read_public',return_value=(html,'https://lite.duckduckgo.com/lite/','text/html')):
            found=r.public_search('test topic')
        self.assertEqual(found,[{'title':'Original document','url':'https://example.com/docs','via':'DuckDuckGo Lite'}])

    def test_invented_citations_fail_and_repair_is_bounded(self):
        sources=[{'id':'s1','text':PAGE}]
        with self.assertRaises(ValueError):r.validate_brief(brief('invented'),sources)
        bad=brief();bad['claims'][0]['evidence'][0]['quote']='A fabricated claim without a source.'
        with self.assertRaises(ValueError):r.validate_brief(bad,sources)
        with patch.object(r,'generate',side_effect=[json.dumps(bad),json.dumps(brief())]) as generate:
            result=r.summarize_sources(self.topic,sources,self.cfg['llm'])
        self.assertEqual(result['claims'][0]['sourceIds'],['s1']);self.assertEqual(generate.call_count,2)
        with patch.object(r,'generate',return_value=json.dumps(bad)) as generate:
            with self.assertRaisesRegex(ValueError,'仍未通过'):r.summarize_sources(self.topic,sources,self.cfg['llm'])
        self.assertEqual(generate.call_count,2)

    def test_two_research_rounds_preserve_quotes_and_never_save_tokens(self):
        plan={'focus':'编排','queries':['agent planning','agent execution']}
        replies=[json.dumps(plan),json.dumps(brief(followups=['limitations'])),json.dumps(brief('s2'))]
        def search(query):return [{'url':'https://example.com/more' if query=='limitations' else 'https://example.com/docs','title':query,'via':'fixture'}]
        with patch.object(r,'generate',side_effect=replies),patch.object(r,'public_search',side_effect=search),patch.object(r,'read_public',side_effect=lambda u:(PAGE+u,u,'text/plain')):
            evidence=r.research_topic(self.topic,self.run,self.cfg)
        report=json.loads((self.run/'research.json').read_text())
        self.assertEqual(report['status'],'done');self.assertEqual(len(report['queries']),3)
        self.assertEqual(len(evidence['sources']),2);self.assertIsNone(evidence['trending'])
        self.assertEqual(evidence['brief']['claims'][0]['sourceIds'],['s2'])
        self.assertTrue((self.run/'sources/s2.txt').exists())
        for f in self.run.rglob('*'):
            if f.is_file():self.assertNotIn('fixture-secret',f.read_text())

    def test_insufficient_evidence_stops_and_model_only_never_silently_falls_back(self):
        plan=json.dumps({'focus':'test','queries':['one topic','second query']})
        with patch.object(r,'generate',side_effect=[plan,json.dumps(brief(ready=False))]),patch.object(r,'public_search',return_value=[]),patch.object(r,'read_public',return_value=(PAGE,'https://example.com/docs','text/plain')):
            with self.assertRaisesRegex(ValueError,'不足'):r.research_topic(self.topic,self.run,self.cfg)
        self.assertFalse((self.run/'evidence.json').exists())
        self.assertEqual(json.loads((self.run/'research.json').read_text())['status'],'failed')
        with patch.object(r,'generate',return_value=plan),patch.object(r,'web_search',side_effect=ValueError('unsupported')),patch.object(r,'public_search') as fallback:
            with self.assertRaisesRegex(ValueError,'unsupported'):r.research_topic({**self.topic,'search_mode':'model'},self.run,self.cfg)
            fallback.assert_not_called()

    def test_auto_fallback_is_explicit_and_does_not_retry_unsupported_service(self):
        replies=[json.dumps({'focus':'test','queries':['one topic','second query']}),json.dumps(brief())]
        with patch.object(r,'generate',side_effect=replies),patch.object(r,'web_search',side_effect=ValueError('unsupported')) as online,patch.object(r,'public_search',return_value=[]),patch.object(r,'read_public',return_value=(PAGE,'https://example.com/docs','text/plain')):
            r.research_topic({**self.topic,'search_mode':'auto'},self.run,self.cfg)
        online.assert_called_once()
        report=json.loads((self.run/'research.json').read_text())
        self.assertEqual(report['failures'][0]['stage'],'model_search');self.assertEqual(report['searches'][0]['method'],'public')

    def test_responses_search_reads_citations_json_and_sse(self):
        result={'status':'completed','output':[
            {'type':'web_search_call','status':'completed','action':{'sources':[{'url':'https://example.com/docs'}]}},
            {'type':'message','content':[{'type':'output_text','text':'https://invented.example/ is not a citation','annotations':[{'type':'url_citation','url':'https://example.com/paper','title':'Paper'}]}]}]}
        for streaming in (False,True):
            raw='data: '+json.dumps({'type':'response.completed','response':result})+'\n\n' if streaming else json.dumps(result)
            response=io.BytesIO(raw.encode());response.headers={'Content-Type':'text/event-stream' if streaming else 'application/json'}
            with patch('llm_api.urllib.request.urlopen',return_value=response) as send:
                found=llm_api.web_search(self.cfg['llm'],'topic')
            self.assertEqual(len(found),2);self.assertNotIn('invented',str(found))
            req=send.call_args.args[0];self.assertNotIn('fixture-secret',req.data.decode())
            self.assertEqual(req.get_header('Authorization'),'Bearer fixture-secret')

    def test_custom_topic_draft_keeps_authoritative_sources_and_end_to_end_job(self):
        evidence={'kind':'topic','repo':self.topic['title'],'topic':self.topic,'url':'https://example.com/docs',
                  'trending':None,'brief':brief(),'documents':[{'id':'s1','text':PAGE}],
                  'sources':[{'id':'s1','url':'https://example.com/docs','title':'Source'}]}
        spec=json.loads((ROOT/'tests/fixtures/v2-script.json').read_text())
        for scene in spec['scenes']:
            scene['sourceIds']=['s1']
            if scene['type']=='stats':scene['type']='concept'
        def research(topic,run,settings,**kwargs):save(run/'evidence.json',evidence)
        with patch.object(app,'ROOT',self.root),patch.object(factory,'ROOT',self.root),patch.object(app,'SETTINGS',self.cfg),patch.object(app,'JOB',{'status':'running'}),patch.object(app,'research_topic',side_effect=research),patch.object(factory,'generate',return_value=json.dumps(spec)),patch.object(app,'synthesize') as voice,patch.object(app,'render') as render:
            app.LOCK.acquire();app.task('build',{'topic':self.topic,'style_id':'rapid'})
            self.assertEqual(app.JOB['status'],'done');self.assertFalse(app.LOCK.locked())
            run=self.root/'runs'/app.JOB['run'];actual=json.loads((run/'script.json').read_text())
            self.assertEqual(actual['source_kind'],'topic');self.assertEqual(actual['sources'],evidence['sources'])
            self.assertEqual(actual['repo'],self.topic['title']);self.assertTrue(actual['research_available'])
            factory.validate(actual);voice.assert_called_once();render.assert_called_once()

    def test_invalid_topic_http_does_not_start_or_mutate_job(self):
        with patch.object(app,'ROOT',self.root),patch.object(app,'SETTINGS',self.cfg),patch.object(app,'JOB',{'status':'idle'}):
            server=ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/api/build',data=b'{"topic":{"title":"x"}}',headers={'Content-Type':'application/json'})
                with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(req)
                self.assertEqual(error.exception.code,400);self.assertEqual(app.JOB['status'],'idle');self.assertFalse(app.LOCK.locked())
                self.assertFalse((self.root/'runs').exists())
            finally:server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()
