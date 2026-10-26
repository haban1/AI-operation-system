import copy
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
import factory
from llm_api import generate, normalize_settings, public_settings, read_responses, response_text, test_connection


def completed(text):
    return {'status':'completed','output':[
        {'type':'reasoning','summary':[{'type':'summary_text','text':'not the answer'}]},
        {'type':'message','status':'completed','content':[{'type':'output_text','text':text}]}]}


def reply(value, streaming=False):
    if streaming:
        payload = ': heartbeat\n\nevent: response.output_text.delta\ndata: '+json.dumps({'type':'response.output_text.delta','delta':'do not duplicate'})+'\n\n'
        payload += 'data: '+json.dumps({'type':'response.completed','response':value})+'\n\ndata: [DONE]\n\n'
    else:
        payload = json.dumps(value)
    response = io.BytesIO(payload.encode())
    response.headers = {'Content-Type':'text/event-stream; charset=utf-8' if streaming else 'application/json'}
    return response


class ResponsesTests(unittest.TestCase):
    def setUp(self):
        self.settings = {'provider':'responses','base_url':'https://api.example.test/v1','model':'gpt-6-astra','api_key':'fixture-token-not-real'}
        self.env = patch.dict(os.environ, {'VIDEO_LLM_API_KEY':''})
        self.env.start(); self.addCleanup(self.env.stop)

    def test_native_request_and_streamed_answer(self):
        with patch('llm_api.urllib.request.urlopen', return_value=reply(completed('{"ok":true}'), True)) as send:
            self.assertEqual(generate(self.settings,'Return JSON','test'),'{"ok":true}')
        request = send.call_args.args[0]
        body = json.loads(request.data)
        self.assertEqual(request.full_url,'https://api.example.test/v1/responses')
        self.assertEqual(request.get_header('Authorization'),'Bearer fixture-token-not-real')
        self.assertEqual(body['input'][0]['content'][0],{'type':'input_text','text':'test'})
        self.assertEqual(body['text']['format'],{'type':'json_object'})
        self.assertTrue(body['stream']); self.assertFalse(body['store'])
        self.assertNotIn('messages',body); self.assertNotIn('temperature',body)
        self.assertNotIn('fixture-token-not-real',request.data.decode())

    def test_json_gateway_response_and_multiple_text_parts(self):
        value = completed('one')
        value['output'][1]['content'].append({'type':'output_text','text':'two'})
        self.assertEqual(read_responses(reply(value)),'onetwo')

    def test_rejects_incomplete_refusal_and_abrupt_stream(self):
        value = completed('partial');value['status']='incomplete'
        with self.assertRaises(ValueError):response_text(value)
        value = completed('');value['output'][1]['content']=[{'type':'refusal','refusal':'refused'}]
        with self.assertRaises(ValueError):response_text(value)
        response=io.BytesIO(b'data: {"type":"response.output_text.delta","delta":"{}"}\n\ndata: [DONE]\n\n')
        response.headers={'Content-Type':'text/event-stream'}
        with self.assertRaisesRegex(ValueError,'提前结束'):read_responses(response)

    def test_stream_failure_is_not_saved_as_a_success(self):
        response=io.BytesIO(b'data: {"type":"response.failed","response":{"error":{"message":"upstream error"}}}\n\n')
        response.headers={'Content-Type':'text/event-stream'}
        with self.assertRaisesRegex(ValueError,'未完成'):read_responses(response)

    def test_token_readiness_and_http_errors(self):
        settings={k:v for k,v in self.settings.items() if k!='api_key'}
        with patch('llm_api.urllib.request.urlopen') as send:
            with self.assertRaisesRegex(ValueError,'填写Token'):generate(settings,'JSON','test')
            send.assert_not_called()
        error=urllib.error.HTTPError(self.settings['base_url'],401,'Unauthorized',{},io.BytesIO(b'secret upstream body'))
        with patch('llm_api.urllib.request.urlopen',side_effect=error):
            with self.assertRaisesRegex(ValueError,'Token无效') as caught:generate(self.settings,'JSON','test')
        self.assertNotIn('secret upstream body',str(caught.exception))

    def test_settings_keep_token_on_same_service_and_never_return_it(self):
        values={**self.settings,'base_url':'https://api.example.test/v1/responses/','api_key':''}
        normalized=normalize_settings(values,self.settings)
        self.assertEqual(normalized['base_url'],self.settings['base_url'])
        self.assertEqual(normalized['api_key'],self.settings['api_key'])
        self.assertTrue(public_settings(normalized)['api_key_configured'])
        self.assertNotIn('api_key',public_settings(normalized))
        values['base_url']='https://other.example.test/v1'
        self.assertNotIn('api_key',normalize_settings(values,self.settings))
        values['base_url']='https://api.example.test/v1?token=fixture'
        with self.assertRaises(ValueError):normalize_settings(values)

    def test_chat_completions_and_ollama_still_work(self):
        values={**self.settings,'provider':'compatible'}
        response={'choices':[{'finish_reason':'stop','message':{'content':'{"ok":true}'}}]}
        with patch('llm_api.urllib.request.urlopen',return_value=reply(response)) as send:
            self.assertEqual(test_connection(values)['provider'],'compatible')
            self.assertTrue(send.call_args.args[0].full_url.endswith('/chat/completions'))
        values={'provider':'ollama','base_url':'http://127.0.0.1:11434','model':'qwen3.5:4b'}
        with patch('llm_api.urllib.request.urlopen',return_value=reply({'message':{'content':'{"ok":true}'}})) as send:
            self.assertTrue(test_connection(values)['ok'])
            self.assertIsNone(send.call_args.args[0].get_header('Authorization'))

    def test_responses_draft_keeps_verified_source_and_creates_v2(self):
        spec=json.loads((ROOT/'tests/fixtures/v2-script.json').read_text(encoding='utf-8'))
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);run=root/'runs/new';run.mkdir(parents=True);(root/'data').mkdir()
            (run/'evidence.json').write_text(json.dumps({'url':'https://github.com/tt-a1i/archify','readme':'fixture evidence'}), encoding='utf-8')
            (root/'data/feed.json').write_text(json.dumps({'candidates':[{'id':'tt-a1i/archify','weekly_stars':14946}]}), encoding='utf-8')
            with patch.object(factory,'ROOT',root),patch('llm_api.urllib.request.urlopen',return_value=reply(completed(json.dumps(spec)),True)):
                result=factory.make_draft('tt-a1i/archify',run,{'llm':self.settings})
            self.assertEqual(result['model'],'gpt-6-astra')
            self.assertEqual(result['renderer'],'punchy-v2')
            self.assertEqual(next(s for s in result['scenes'] if s['type']=='stats')['metric'],14946)
            self.assertNotIn('fixture-token-not-real',(run/'script.json').read_text(encoding='utf-8'))


if __name__=='__main__':unittest.main()
