import copy
import json
import os
import shutil
import socket
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
from urllib.parse import urlsplit

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
sys.path.insert(0,str(ROOT))
import app
import factory
from runtime import base_path, config_path, load_config, public_url


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack()
        self.addCleanup(self.stack.close)
        self.root=Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.private=self.root/'private-config'
        self.stack.enter_context(patch.dict(os.environ,{
            'SIGNAL_BASE_PATH':'/integrations/ai-signal/',
            'SIGNAL_CONFIG_DIR':str(self.private),
        }))
        shutil.copy(ROOT/'config.example.json',self.root/'config.example.json')
        shutil.copytree(ROOT/'web',self.root/'web')
        self.settings=load_config(self.root)
        self.stack.enter_context(patch.object(app,'ROOT',self.root))
        self.stack.enter_context(patch.object(app,'SETTINGS',self.settings))
        self.stack.enter_context(patch.object(app,'JOB',{'status':'idle'}))

    def serve(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        self.stack.callback(thread.join)
        self.stack.callback(server.server_close)
        self.stack.callback(server.shutdown)
        return f'http://127.0.0.1:{server.server_port}'

    def test_private_config_initializes_and_retains_saved_settings(self):
        self.assertEqual(config_path(self.root),self.private/'config.json')
        self.assertFalse((self.root/'config.json').exists())
        self.assertTrue((self.root/'runs').is_dir())
        self.assertTrue((self.root/'data').is_dir())
        settings=copy.deepcopy(self.settings)
        settings['llm']['model']='saved-fixture-model'
        config_path(self.root).write_text(json.dumps(settings))
        self.assertEqual(load_config(self.root)['llm']['model'],'saved-fixture-model')
        with patch.dict(os.environ,{'SIGNAL_CONFIG_DIR':''}):
            self.assertEqual(config_path(self.root),self.root/'config.json')

    def test_settings_write_private_volume_and_do_not_expose_tokens(self):
        url=self.serve()
        payload=copy.deepcopy(self.settings)
        payload['llm']['api_key']='deployment-model-fixture'
        payload['tts']['provider']='openai'
        payload['tts']['openai_api_key']='deployment-voice-fixture'
        request=urllib.request.Request(url+'/api/config',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(request) as response:
            self.assertTrue(json.load(response)['ok'])
        with urllib.request.urlopen(url+'/api/state') as response:
            state=json.load(response)
        stored=config_path(self.root).read_text()
        for token in ['deployment-model-fixture','deployment-voice-fixture']:
            self.assertNotIn(token,stored)
            self.assertNotIn(token,json.dumps(state))
        self.assertFalse((self.root/'config.json').exists())
        self.assertFalse((self.root/'data/config.json').exists())
        self.assertEqual(load_config(self.root)['tts']['provider'],'openai')

    def test_prefixed_ui_state_and_range_keep_media_under_authenticated_path(self):
        run=self.root/'runs/sample';run.mkdir()
        (run/'script.json').write_text(json.dumps({'title':'Sample','repo':'example/repo'}))
        (run/'validation.json').write_text(json.dumps({'full_decode':'passed','duration':1}))
        (run/'video.mp4').write_bytes(b'0123456789')
        (run/'error.log').write_text('fixture log')
        batch={'id':'compare-fixture','agents':[{'run':'sample','video':'/runs/sample/video.mp4',
              'history':[{'video':'/runs/older/video.mp4'}]}],
              'review':{'samples':{'agent-a':[{'url':'/runs/sample/review-frames/00.jpg'}]}},
              'source_url':'https://example.com/runs/source',
              'description':'Literal /runs/sample/video.mp4 text stays unchanged'}
        self.stack.enter_context(patch.object(app,'JOB',{'run':'sample','comparison_id':batch['id']}))
        self.stack.enter_context(patch.object(app,'list_batches',return_value=[batch]))
        self.stack.enter_context(patch.object(app,'read_batch',return_value=batch))
        url=self.serve()
        for page in ['/', '/workflow.html']:
            with urllib.request.urlopen(url+page) as response:
                html=response.read().decode()
            self.assertIn('<base href="/integrations/ai-signal/">',html)
            self.assertNotIn('__SIGNAL_BASE_PATH__',html)
            self.assertNotIn('href="/workflow',html)
        with urllib.request.urlopen(url+'/api/state') as response:
            state=json.load(response)
        self.assertEqual(state['runs'][0]['video'],'/integrations/ai-signal/runs/sample/video.mp4')
        self.assertEqual(state['job']['comparison_url'],'/integrations/ai-signal/?view=studio&comparison=compare-fixture')
        self.assertEqual(state['job']['logs']['error.log'],'/integrations/ai-signal/runs/sample/error.log')
        public=state['comparisons'][0]
        self.assertEqual(public['agents'][0]['history'][0]['video'],'/integrations/ai-signal/runs/older/video.mp4')
        self.assertTrue(public['review']['samples']['agent-a'][0]['url'].startswith(base_path()))
        self.assertEqual(public['source_url'],batch['source_url'])
        self.assertEqual(public['description'],batch['description'])
        self.assertEqual(batch['agents'][0]['video'],'/runs/sample/video.mp4')
        # The Node gateway strips only its mount prefix before forwarding.
        upstream_path=urlsplit(state['runs'][0]['video']).path.removeprefix(base_path().rstrip('/'))
        request=urllib.request.Request(url+upstream_path,headers={'Range':'bytes=2-5'})
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.status,206)
            self.assertEqual(response.headers['Content-Range'],'bytes 2-5/10')
            self.assertEqual(response.read(),b'2345')
        with urllib.request.urlopen(url+'/api/health') as response:
            self.assertEqual(json.load(response),{'ok':True,'service':'AI Signal Studio'})

    def test_direct_local_mode_and_cross_site_rejection_remain_available(self):
        with patch.dict(os.environ,{'SIGNAL_BASE_PATH':''}):
            self.assertEqual(public_url('/runs/sample/video.mp4'),'/runs/sample/video.mp4')
            url=self.serve()
            with urllib.request.urlopen(url+'/') as response:
                self.assertIn('<base href="/">',response.read().decode())
            request=urllib.request.Request(url+'/api/config',data=b'{}',headers={'Origin':'https://unrelated.example'})
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(request)
            self.assertEqual(caught.exception.code,403)
        with patch.dict(os.environ,{'SIGNAL_BASE_PATH':'//untrusted.example/'}):
            with self.assertRaises(ValueError):base_path()

    def test_edge_subprocess_uses_private_config_location(self):
        run=self.root/'runs/voice-fixture';run.mkdir()
        shutil.copy(ROOT/'tests/fixtures/valid-script.json',run/'script.json')
        with patch.object(factory,'ROOT',self.root),patch.object(factory,'voice_python',return_value='/fixture/python'),patch.object(factory.subprocess,'run') as call:
            factory.synthesize(run,self.settings)
        args=call.call_args_list[0].args[0]
        self.assertEqual(args[-1],str(self.private/'config.json'))

    def request_raw(self,url,path,method='GET',headers=None):
        address=urlsplit(url)
        request=f'{method} {path} HTTP/1.0\r\nHost: {address.netloc}\r\n'
        request+=''.join(f'{key}: {value}\r\n' for key,value in (headers or {}).items())
        with socket.create_connection((address.hostname,address.port),timeout=3) as connection:
            connection.sendall((request+'\r\n').encode('ascii'))
            chunks=[]
            while True:
                chunk=connection.recv(65536)
                if not chunk:break
                chunks.append(chunk)
        raw_headers,_,body=b''.join(chunks).partition(b'\r\n\r\n')
        lines=raw_headers.decode('iso-8859-1').split('\r\n')
        status=int(lines[0].split()[1])
        fields=dict(line.split(': ',1) for line in lines[1:])
        fields.pop('Date',None)
        return status,fields,body

    def test_media_head_matches_get_and_range_without_sending_body(self):
        run=self.root/'runs/head-fixture';run.mkdir()
        (run/'video.mp4').write_bytes(b'0123456789')
        url=self.serve()
        for headers,status,expected in [({},200,b'0123456789'),
                                        ({'Range':'bytes=2-5'},206,b'2345'),
                                        ({'Range':'bytes=-3'},206,b'789'),
                                        ({'Range':'bytes=12-'},416,b'')]:
            with self.subTest(headers=headers):
                get=self.request_raw(url,'/runs/head-fixture/video.mp4',headers=headers)
                head=self.request_raw(url,'/runs/head-fixture/video.mp4','HEAD',headers)
                self.assertEqual(get[0],status)
                self.assertEqual(get[2],expected)
                self.assertEqual(head[:2],get[:2])
                self.assertEqual(head[2],b'')

    def test_html_json_and_error_head_match_get_headers_without_body(self):
        url=self.serve()
        for path in ['/', '/workflow.html', '/api/health', '/api/state', '/runs/missing.mp4']:
            with self.subTest(path=path):
                get=self.request_raw(url,path)
                head=self.request_raw(url,path,'HEAD')
                self.assertEqual(get[0],404 if path.endswith('missing.mp4') else 200)
                self.assertEqual(int(get[1]['Content-Length']),len(get[2]))
                self.assertEqual(head[:2],get[:2])
                self.assertEqual(head[2],b'')


if __name__=='__main__':unittest.main()
