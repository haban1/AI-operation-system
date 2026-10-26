import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import factory
from test_responses import reply,completed
from llm_api import generate


class DraftRepairTests(unittest.TestCase):
    def setUp(self):
        self.raw=(ROOT/'tests/fixtures/missing-narration.json').read_text(encoding='utf-8')
        self.fixed=json.loads(self.raw)
        self.fixed['scenes'][-1].update(narration=['先阅读官方说明，再选择适合的配置方式。'],sourceIds=['readme'])
        self.settings={'llm':{'provider':'responses','base_url':'https://example.test/v1','model':'gpt-6-astra','api_key':'fixture-not-real'}}

    def test_captured_failure_identifies_scene_and_missing_field(self):
        with self.assertRaisesRegex(ValueError,'第8场.*缺少旁白.*narration'):
            factory.parse_draft(self.raw,{'weekly_stars':8527})
        broken=copy.deepcopy(self.fixed);broken['scenes'][-1]['narration']=['字'*66]
        with self.assertRaisesRegex(ValueError,'第8场.*第1句.*66字'):
            factory.parse_draft(json.dumps(broken),{'weekly_stars':8527})

    def prepare(self,folder):
        root=Path(folder);run=root/'runs/repaired';run.mkdir(parents=True);(root/'data').mkdir()
        (run/'evidence.json').write_text(json.dumps({'url':'https://github.com/affaan-m/ECC','readme':'fixture evidence'}), encoding='utf-8')
        (root/'data/feed.json').write_text(json.dumps({'candidates':[{'id':'affaan-m/ECC','weekly_stars':8527}]}), encoding='utf-8')
        return root,run

    def test_missing_fields_are_retried_with_evidence_and_original_is_kept(self):
        with tempfile.TemporaryDirectory() as folder:
            root,run=self.prepare(folder);progress=[]
            with patch.object(factory,'ROOT',root),patch.object(factory,'generate',side_effect=[self.raw,json.dumps(self.fixed)]) as call:
                result=factory.make_draft('affaan-m/ECC',run,self.settings,on_progress=progress.append)
            self.assertEqual(call.call_count,2)
            repair=json.loads(call.call_args.args[2])
            self.assertIn('narration',repair['required_scene_fields'])
            self.assertIn('sourceIds',repair['required_scene_fields'])
            self.assertEqual(repair['evidence']['readme'],'fixture evidence')
            self.assertIn('第8场',repair['validation_error'])
            self.assertEqual((run/'llm-response.txt').read_text(encoding='utf-8'),self.raw)
            self.assertTrue((run/'llm-response-repair.txt').exists())
            self.assertEqual(result['editorial_status'],'自动生成 · 未经人工核实')
            record=json.loads((run/'generation.json').read_text(encoding='utf-8'))
            self.assertEqual([a['status'] for a in record['attempts']],['invalid','valid'])
            self.assertEqual(record['model'],'gpt-6-astra')
            self.assertNotIn('fixture-not-real',json.dumps(record))
            self.assertIn('修复',progress[-1])

    def test_repair_is_bounded_and_invalid_script_is_not_saved(self):
        with tempfile.TemporaryDirectory() as folder:
            root,run=self.prepare(folder)
            with patch.object(factory,'ROOT',root),patch.object(factory,'generate',return_value=self.raw) as call:
                with self.assertRaisesRegex(ValueError,'自动修复后仍不合格'):
                    factory.make_draft('affaan-m/ECC',run,self.settings)
            self.assertEqual(call.call_count,2)
            self.assertFalse((run/'script.json').exists())
            self.assertEqual(json.loads((run/'generation.json').read_text(encoding='utf-8'))['status'],'failed')

    def test_request_failure_does_not_trigger_content_repair(self):
        with tempfile.TemporaryDirectory() as folder:
            root,run=self.prepare(folder)
            with patch.object(factory,'ROOT',root),patch.object(factory,'generate',side_effect=ValueError('Token无效')) as call:
                with self.assertRaisesRegex(ValueError,'Token无效'):factory.make_draft('affaan-m/ECC',run,self.settings)
            self.assertEqual(call.call_count,1)
            self.assertEqual(json.loads((run/'generation.json').read_text(encoding='utf-8'))['attempts'][0]['status'],'request_failed')

    def test_responses_requires_narration_and_sources_in_schema(self):
        with patch('llm_api.urllib.request.urlopen',return_value=reply(completed('{}'))) as send:
            generate(self.settings['llm'],'Return JSON','test',schema=factory.DRAFT_SCHEMA)
        format=json.loads(send.call_args.args[0].data)['text']['format']
        self.assertEqual(format['type'],'json_schema');self.assertTrue(format['strict'])
        scene=format['schema']['properties']['scenes']['items']
        self.assertIn('narration',scene['required']);self.assertIn('sourceIds',scene['required'])
        self.assertEqual(scene['properties']['narration']['minItems'],1)
        self.assertFalse(scene['additionalProperties'])


if __name__=='__main__':unittest.main()
