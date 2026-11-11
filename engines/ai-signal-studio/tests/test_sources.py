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
from contextlib import ExitStack
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'));sys.path.insert(0,str(ROOT))
import app
import collect
import research
import source_collectors as s


class SourcesTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.settings=s.normalize_sources()
        for key in s.SOURCE_NAMES:self.settings[key]=False
        self.settings['rss']=[]

    def test_rss_and_atom_preserve_dates_and_reject_nonpublic_links(self):
        feed={'name':'新闻','url':'https://example.com/feed'}
        raw='<rss><channel><item><title>新闻标题</title><link>/article/1</link><description>&lt;b&gt;摘要&lt;/b&gt;</description><pubDate>today</pubDate></item><item><title>重复文章</title><link>/article/1</link></item><item><title>内网地址</title><link>http://127.0.0.1/secret</link></item></channel></rss>'
        rows=s.parse_rss(raw,feed,'stamp')
        self.assertEqual(len(rows),1);self.assertEqual(rows[0]['url'],'https://example.com/article/1')
        self.assertEqual(rows[0]['description'],'摘要');self.assertEqual(rows[0]['published_at'],'today')
        self.assertEqual(rows[0]['metrics'],[])
        atom='<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom文章</title><link rel="alternate" href="https://example.com/a"/><updated>2026-11-04</updated><summary>文章摘要</summary></entry></feed>'
        self.assertEqual(s.parse_rss(atom,feed,'stamp')[0]['published_at'],'2026-11-04')
        for bad in ['<html>登录页面</html>','<!DOCTYPE rss [<!ENTITY x "boom">]><rss/>','<rss/>']:
            with self.subTest(bad=bad),self.assertRaises(ValueError):s.parse_rss(bad,feed,'stamp')

    def test_configuration_rejects_private_urls_and_unbounded_inputs(self):
        for url in ['file:///tmp/x','http://localhost:9200/mcp','https://10.0.0.1/rss','https://example.com/?api_key=secret']:
            with self.subTest(url=url),self.assertRaises(ValueError):s.normalize_sources({'rss':[{'name':'bad','url':url}]})
        for value in [{'github':'true'},{'xhs_keywords':['a']*4},{'rss':[{}]},{'xhs_note_type':'all'}]:
            with self.subTest(value=value),self.assertRaises(ValueError):s.normalize_sources(value)

    def test_weibo_metrics_are_not_stars_and_ads_are_excluded(self):
        rows=s.parse_weibo(json.dumps({'data':{'realtime':[{'word':'今天的新进展','num':12345},{'word':'广告条目','is_ad':1}]}}),'stamp')
        self.assertEqual(len(rows),1);self.assertEqual(rows[0]['metrics'][0]['value'],12345)
        self.assertEqual(rows[0]['source_key'],'weibo');self.assertNotIn('weekly_stars',rows[0])
        with self.assertRaises(ValueError):s.parse_weibo('{"ok":0}', 'stamp')

    def test_weibo_uses_scoped_local_bridge_without_proxy_or_redirects(self):
        env={'SIGNAL_WEIBO_AGENT_URL':'http://host.docker.internal:17831','SIGNAL_WEIBO_AGENT_TOKEN':'scoped-secret'}
        with patch.dict(os.environ,env),patch.object(urllib.request,'build_opener') as build:
            build.return_value.open.return_value.__enter__.return_value.read.return_value=b'{"ok":true,"transport":"logged-in-browser","data":{"realtime":[{"word":"test"}]}}'
            result=json.loads(s.fetch_weibo())
            request=build.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url,'http://host.docker.internal:17831/platforms/weibo/hot-topics')
            self.assertEqual(request.get_header('X-signal-token'),'scoped-secret')
            self.assertEqual(build.call_args.args[0].proxies,{})
            self.assertIsInstance(build.call_args.args[1],s.WeiboNoRedirect)
            self.assertTrue(result['ok'])
        with patch.dict(os.environ,{**env,'SIGNAL_WEIBO_AGENT_URL':'https://example.com'}),self.assertRaises(ValueError):s.fetch_weibo()
        with patch.dict(os.environ,{**env,'SIGNAL_WEIBO_AGENT_TOKEN':''}),self.assertRaisesRegex(ValueError,'尚未连接'):s.fetch_weibo()

    def test_weibo_bridge_errors_are_not_misreported_as_logged_out(self):
        env={'SIGNAL_WEIBO_AGENT_URL':'http://127.0.0.1:17831','SIGNAL_WEIBO_AGENT_TOKEN':'scoped-secret'}
        for code,message,expected in [(401,'','鉴权失败'),(404,'','版本过旧'),(409,'微博正在执行其他任务','其他任务'),(502,'微博要求安全验证','安全验证')]:
            body=json.dumps({'message':message}).encode()
            with self.subTest(code=code),patch.dict(os.environ,env),patch.object(urllib.request,'build_opener') as build:
                build.return_value.open.side_effect=urllib.error.HTTPError(env['SIGNAL_WEIBO_AGENT_URL'],code,'error',{},io.BytesIO(body))
                with self.assertRaisesRegex(ValueError,expected):s.fetch_weibo()

    def test_xhs_skips_non_notes_and_preserves_displayed_counts(self):
        data={'feeds':[{'modelType':'hot_query'},{'id':'abc123','xsecToken':'public-token','noteCard':{
            'displayTitle':'真实笔记标题','type':'video','user':{'nickname':'作者'},'interactInfo':{'likedCount':'1.2万','collectedCount':'23'}}}]}
        row=s.parse_xhs(data,'stamp','人工智能')[0]
        self.assertEqual(row['content_type'],'video');self.assertEqual(row['metrics'][0]['value'],12000)
        self.assertEqual(row['metrics'][0]['display'],'1.2万');self.assertIn('关键词搜索',row['discovery'])
        self.assertIn('xsec_token=',row['url'])
        self.assertEqual(s.parse_xhs({'feeds':[]},'stamp','x'),[])
        with self.assertRaises(ValueError):s.parse_xhs({'message':'请登录'},'stamp','x')

    def test_source_failure_preserves_old_capture_and_disabled_sources_drop_out(self):
        old={'id':'weibo:old','source':'微博','source_key':'weibo','title':'原始热点',
             'url':'https://example.com/news','collected_at':'original-time'}
        collect.save(self.root/'data/feed.json',{'archive':'data/capture-20261101-120000','candidates':[old],'sources':[]})
        self.settings['weibo']=True
        def failure():raise ValueError('HTTP 403')
        with patch.object(collect,'ROOT',self.root),patch.object(s,'source_jobs',return_value=[('weibo','微博',failure)]):
            result=collect.collect(self.settings)
        self.assertTrue(result['candidates'][0]['stale'])
        self.assertEqual(result['candidates'][0]['collected_at'],'original-time')
        self.assertEqual(result['candidates'][0]['archive'],'data/capture-20261101-120000')
        self.assertEqual(result['sources'][0]['retained_count'],1)
        self.settings['weibo']=False
        with patch.object(collect,'ROOT',self.root):result=collect.collect(self.settings)
        self.assertEqual(result['candidates'],[])

    def test_success_deduplicates_and_clears_staleness(self):
        row=s.item('weibo','微博','1','热点题目','https://example.com/news','new')
        with patch.object(collect,'ROOT',self.root),patch.object(s,'source_jobs',return_value=[('weibo','微博',lambda:[row,row])]):
            result=collect.collect(self.settings)
        self.assertEqual(len(result['candidates']),1);self.assertFalse(result['candidates'][0]['stale'])
        self.assertEqual(result['candidates'][0]['archive'],result['archive'])
        self.assertEqual(json.loads((self.root/result['archive']/'feed.json').read_text())['schema_version'],2)

    def test_non_github_selection_uses_archived_topic_and_git_keeps_repo(self):
        rows=[s.item('weibo','微博','1','热点题目','https://example.com/news','now'),
              {'id':'org/repo','source':'GitHub'}]
        collect.save(self.root/'data/feed.json',{'candidates':rows,'archive':'data/capture-20261104-123456-123456'})
        topic=s.resolve_candidate(self.root,'weibo:1')['topic']
        self.assertEqual(research.normalize_topic(topic)['collected_ref']['id'],'weibo:1')
        self.assertEqual(s.resolve_candidate(self.root,'org/repo'),{'repo':'org/repo'})
        with self.assertRaises(ValueError):s.resolve_candidate(self.root,'missing')
        topic['collected_ref']['archive']='data/../../runtime-config'
        with self.assertRaises(ValueError):research.normalize_topic(topic)

    def test_xhs_detail_must_match_selected_note_and_contain_text(self):
        row=s.item('xiaohongshu','小红书','abc123','笔记题目','https://www.xiaohongshu.com/explore/abc123','now',xsec_token='token')
        ref={'archive':'data/capture-20261104-123456','id':row['id']}
        collect.save(self.root/ref['archive']/'feed.json',{'candidates':[row]})
        with patch.object(s,'XhsClient') as cls:
            call=cls.return_value.__enter__.return_value.call
            call.return_value={'data':{'note':{'noteId':'abc123','title':'笔记题目','desc':'这是可核实的笔记正文。'*20}}}
            document=s.collected_document(self.root,ref)
            self.assertIn('可核实',document['text']);self.assertEqual(document['url'],row['url'])
            self.assertFalse(call.call_args.args[1]['load_all_comments'])
            call.return_value={'data':{'note':{'noteId':'other','desc':'其他正文'*20}}}
            with self.assertRaises(ValueError):s.collected_document(self.root,ref)
            call.return_value={'data':{'note':{'noteId':'abc123','desc':'视频'}}}
            with self.assertRaises(ValueError):s.collected_document(self.root,ref)

    def test_mcp_disallows_publish_and_does_not_use_proxy(self):
        with patch.object(urllib.request,'build_opener') as build:
            client=s.XhsClient()
        self.assertEqual(build.call_args.args[0].proxies,{})
        with self.assertRaises(ValueError):client.call('publish_content',{})

    def test_selected_note_text_enters_citation_validation(self):
        quote='The planner identifies independent tasks for parallel execution.'
        quote2='The dispatcher waits for the dependencies of each task.'
        seed={'title':'笔记题目','url':'https://example.com/note','text':quote+' '+quote2,
              'via':'小红书笔记正文','retrieved_at':'now','sha256':'fixture'}
        topic={'title':'笔记题目','urls':[seed['url']],'search_mode':'public',
               'collected_ref':{'archive':'data/capture-20261104-123456','id':'xiaohongshu:note'}}
        brief={'ready':True,'summary':'已核实的资料','claims':[
            {'text':'识别任务','evidence':[{'source_id':'s1','quote':quote}]},
            {'text':'等待依赖','evidence':[{'source_id':'s1','quote':quote2}]}],
            'limitations':[],'followup_queries':[]}
        with patch.object(research,'collected_document',return_value=seed),patch.object(research,'public_search',return_value=[]),\
             patch.object(research,'read_public') as public_read,patch.object(research,'generate',side_effect=[
                 json.dumps({'focus':'核实','queries':['任务编排','任务依赖']}),json.dumps(brief)]):
            result=research.research_topic(topic,self.root/'research',{'llm':{'provider':'compatible'}})
        public_read.assert_not_called()
        self.assertEqual(result['kind'],'topic');self.assertEqual(result['sources'][0]['id'],'s1')
        self.assertIn(quote,result['documents'][0]['text'])
        self.assertTrue((self.root/'research/sources/s1.txt').exists())

    def test_login_qr_only_returns_supported_bounded_images(self):
        with patch.object(s,'XhsClient') as client:
            client.return_value.__enter__.return_value.tool.return_value={'content':[
                {'type':'text','text':'请扫码登录'}, {'type':'image','mimeType':'image/svg+xml','data':'unsafe'},
                {'type':'image','mimeType':'image/png','data':'YWJj'}]}
            result=s.xhs_login(True)
        self.assertEqual(result['image'],'data:image/png;base64,YWJj')
        self.assertIn('扫码登录',result['message'])

    def test_logged_out_source_is_not_successful_empty_feed(self):
        with patch.object(s,'XhsClient') as cls:
            client=cls.return_value.__enter__.return_value
            client.tool.return_value={'content':[{'type':'text','text':'❌ 未登录'}]}
            with self.assertRaisesRegex(ValueError,'扫码登录'):s.collect_xhs(self.settings,'now',self.root)
            client.call.assert_not_called()


class SourceApiTests(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.root=Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        (self.root/'runs').mkdir()
        self.settings=copy.deepcopy(app.SETTINGS)
        self.settings['llm']['api_key']='private-fixture-key'
        self.settings['tts']['openai_api_key']='private-voice-key'
        self.stack.enter_context(patch.object(app,'ROOT',self.root))
        self.stack.enter_context(patch.object(app,'SETTINGS',self.settings))
        self.stack.enter_context(patch.object(app,'JOB',{'status':'idle'}))
        self.stack.enter_context(patch.dict(os.environ,{'SIGNAL_CONFIG_DIR':str(self.root/'config')}))
        server=ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.stack.callback(thread.join);self.stack.callback(server.server_close);self.stack.callback(server.shutdown)
        self.url=f'http://127.0.0.1:{server.server_port}'

    def post(self,path,body):
        return urllib.request.urlopen(urllib.request.Request(self.url+'/api/'+path,data=json.dumps(body).encode(),headers={'Content-Type':'application/json'}),timeout=5)

    def test_save_sources_preserves_model_and_never_persists_keys(self):
        settings=s.normalize_sources();settings['weibo']=False
        with self.post('sources-config',{'sources':settings}) as response:self.assertTrue(json.load(response)['ok'])
        saved=(self.root/'config/config.json').read_text()
        self.assertNotIn('private-fixture-key',saved);self.assertNotIn('private-voice-key',saved)
        self.assertEqual(app.SETTINGS['llm']['api_key'],'private-fixture-key')
        self.assertFalse(json.loads(saved)['sources']['weibo'])

    def test_settings_changes_are_locked_during_jobs(self):
        app.LOCK.acquire()
        try:
            with self.assertRaises(urllib.error.HTTPError) as error:self.post('sources-config',{'sources':s.normalize_sources()})
            self.assertEqual(error.exception.code,409)
        finally:app.LOCK.release()

    def test_selection_resolves_server_record_before_dispatch(self):
        row=s.item('weibo','微博','1','热点题目','https://example.com/news','now')
        collect.save(self.root/'data/feed.json',{'candidates':[row],'archive':'data/capture-20261104-123456'})
        received=[];done=threading.Event()
        def task(action,payload):
            received.append(payload);app.LOCK.release();done.set()
        with patch.object(app,'require_ready'),patch.object(app,'task',side_effect=task):
            with self.post('draft',{'candidate_id':row['id']}) as response:self.assertEqual(response.status,202)
            self.assertTrue(done.wait(2));payload=received[0]
            self.assertNotIn('repo',payload);self.assertEqual(payload['topic']['urls'],[row['url']])
            self.assertIn('collected_ref',payload['topic'])
        with self.assertRaises(urllib.error.HTTPError) as error:self.post('draft',{'candidate_id':'missing'})
        self.assertEqual(error.exception.code,400)


if __name__=='__main__':unittest.main()
