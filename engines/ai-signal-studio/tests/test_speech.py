import copy
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
import wave
from pathlib import Path
from unittest.mock import patch,MagicMock
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'));sys.path.insert(0,str(ROOT))
from speech_api import normalize_speech,public_speech,stored_speech,speech_bytes,require_speech,NoRedirect
from narration_timing import attach_word_timing
from tts_openai import synthesize


def wav():
    out=io.BytesIO()
    with wave.open(out,'wb') as w:
        w.setnchannels(1);w.setsampwidth(2);w.setframerate(24000);w.writeframes(b'\0'*24000)
    return out.getvalue()

class SpeechTests(unittest.TestCase):
    def setUp(self):
        self.env=patch.dict(os.environ,{'VIDEO_TTS_API_KEY':'','VIDEO_LLM_API_KEY':'writing-secret-fixture'})
        self.env.start();self.addCleanup(self.env.stop)
        self.cfg=normalize_speech({'openai_api_key':'speech-secret-fixture','openai_base_url':'https://speech.example.test/v1/audio/speech'})
        self.cfg['provider']='openai'
    def test_tokens_are_isolated_and_never_public_or_stored(self):
        self.assertNotIn('speech-secret-fixture',json.dumps(public_speech(self.cfg)))
        self.assertNotIn('speech-secret-fixture',json.dumps(stored_speech(self.cfg)))
        fresh=normalize_speech({},stored_speech(self.cfg))
        with self.assertRaisesRegex(ValueError,'独立'):require_speech(fresh)
        same=normalize_speech({'openai_api_key':''},self.cfg)
        self.assertEqual(same['openai_api_key'],'speech-secret-fixture')
        other=normalize_speech({'openai_base_url':'https://other.example.test/v1'},self.cfg)
        self.assertNotIn('openai_api_key',other)
    def test_url_and_redirect_cannot_leak_token(self):
        for url in ['https://speech.test/v1?key=secret','https://user:secret@speech.test/v1','http://remote.test/v1']:
            with self.assertRaises(ValueError):normalize_speech({'openai_base_url':url})
        self.assertIsNone(NoRedirect().redirect_request(None,None,302,'',{},'https://other.test'))
    def test_request_uses_speech_key_and_supported_audio_contract(self):
        opener=MagicMock();response=io.BytesIO(wav());opener.open.return_value=response
        with patch('speech_api.urllib.request.build_opener',return_value=opener):
            result=speech_bytes(self.cfg,'你好。')
        req=opener.open.call_args.args[0];body=json.loads(req.data)
        self.assertEqual(req.full_url,'https://speech.example.test/v1/audio/speech')
        self.assertEqual(req.get_header('Authorization'),'Bearer speech-secret-fixture')
        self.assertEqual(body['response_format'],'wav');self.assertIn('instructions',body)
        self.assertNotIn('secret',req.data.decode());self.assertEqual(result[:4],b'RIFF')
    def test_provider_body_never_enters_error_log(self):
        opener=MagicMock();opener.open.side_effect=urllib.error.HTTPError('https://speech.test',401,'speech-secret-fixture',{},io.BytesIO(b'speech-secret-fixture'))
        with patch('speech_api.urllib.request.build_opener',return_value=opener):
            with self.assertRaisesRegex(ValueError,'401') as caught:speech_bytes(self.cfg,'你好。')
        self.assertNotIn('secret',str(caught.exception))
    def test_invalid_audio_rejected(self):
        opener=MagicMock();opener.open.return_value=io.BytesIO(b'{"error":"not audio"}')
        with patch('speech_api.urllib.request.build_opener',return_value=opener):
            with self.assertRaisesRegex(ValueError,'WAV'):speech_bytes(self.cfg,'你好。')
    def test_api_render_timeline_is_measured_and_secret_free(self):
        with tempfile.TemporaryDirectory() as tmp:
            run=Path(tmp);spec={'renderer':'style-lab','scenes':[{'narration':['你好。再试一下。']},{'narration':['最后一句。']}]}
            (run/'script.json').write_text(json.dumps(spec))
            with patch('tts_openai.speech_bytes',return_value=wav()):synthesize(run,self.cfg)
            props=json.loads((run/'render-props.json').read_text())
            self.assertEqual(props['scenes'][1]['from'],props['scenes'][0]['durationFrames'])
            self.assertTrue((run/'audio/narration.wav').is_file())
            last=props['scenes'][-1]
            self.assertEqual(last['from']+last['durationFrames'],props['durationFrames'])
            with wave.open(str(run/'audio/narration.wav'),'rb') as audio:
                self.assertAlmostEqual(audio.getnframes()/audio.getframerate(),props['durationFrames']/30,delta=1/30)
            self.assertNotIn('secret',(run/'render-props.json').read_text())
            self.assertTrue(all('words' not in c for s in props['scenes'] for c in s['captions']))
    def test_http_settings_roundtrip_keeps_secret_only_in_memory(self):
        import app
        import threading
        from http.server import ThreadingHTTPServer
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'data').mkdir();(root/'runs').mkdir()
            settings=json.loads((ROOT/'config.example.json').read_text())
            payload=copy.deepcopy(settings);payload['tts']['provider']='openai';payload['tts']['openai_api_key']='voice-memory-fixture'
            with patch.object(app,'ROOT',root),patch.object(app,'SETTINGS',settings),patch.object(app,'JOB',{'status':'idle'}):
                server=ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
                thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
                try:
                    url=f'http://127.0.0.1:{server.server_port}/api/'
                    req=urllib.request.Request(url+'config',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
                    with urllib.request.urlopen(req) as r:self.assertTrue(json.load(r)['ok'])
                    with urllib.request.urlopen(url+'state') as r:state=json.load(r)
                    self.assertTrue(state['config']['tts']['openai_api_key_configured'])
                    self.assertNotIn('voice-memory-fixture',json.dumps(state))
                    self.assertNotIn('voice-memory-fixture',(root/'config.json').read_text())
                    self.assertEqual(app.SETTINGS['tts']['openai_api_key'],'voice-memory-fixture')
                finally:server.shutdown();server.server_close();thread.join()
    def test_scene_lead_preserves_last_word_and_cue_matches_audio(self):
        words=[{'text':'前句','startMs':100,'endMs':500,'charFrom':0},
               {'text':'先记下','startMs':1000,'endMs':1600,'charFrom':2},
               {'text':'再检索','startMs':2000,'endMs':2600,'charFrom':5}]
        spec={'pacing':'conversational','scenes':[{'narration':['前句。']},{'narration':['先记下，再检索。'],'cue_phrases':['先记下','再检索']}]}
        attach_word_timing(spec,words,2.8)
        start=spec['scenes'][1]['from']*1000/30
        self.assertGreater(start,500);self.assertLess(start,1000)
        self.assertEqual(''.join(c['text'] for s in spec['scenes'] for c in s['captions']),'前句先记下再检索')
        cues=spec['scenes'][1]['cueFrames'];self.assertEqual(cues[1]-cues[0],30)
        for s in spec['scenes']:
            for c in s['captions']:self.assertGreaterEqual(c['startMs'],0);self.assertLessEqual(c['endMs'],s['durationFrames']*1000/30+1)

if __name__=='__main__':unittest.main()
