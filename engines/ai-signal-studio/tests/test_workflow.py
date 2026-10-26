import copy
import json
import sys
import unittest
import tempfile
from unittest.mock import patch
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from collect import parse_trending
from factory import validate
sys.path.insert(0,str(ROOT))
import app

class EvidenceTests(unittest.TestCase):
    def test_trending_fixture_preserves_weekly_growth_and_total(self):
        candidates=parse_trending((ROOT/'tests/fixtures/trending.html').read_text(encoding='utf-8'),'2026-09-08')
        project=next(x for x in candidates if x['id']=='tt-a1i/archify')
        self.assertEqual(project['weekly_stars'],14946)
        self.assertEqual(project['total_stars'],53648)
        self.assertNotIn('colinhacks/zod',[x['id'] for x in candidates])

    def test_block_page_is_not_successful_empty_feed(self):
        with self.assertRaises(ValueError):parse_trending('<html>Access denied</html>','2026-09-08')

    def test_missing_weekly_data_stays_unknown(self):
        page='<article><h2><a href="/acme/ai-tool">AI Tool</a></h2><p>AI agent</p><a href="/acme/ai-tool/stargazers">123</a></article>'
        result=parse_trending(page,'today')[0]
        self.assertIsNone(result['weekly_stars'])
        self.assertEqual(result['total_stars'],123)

    def setUp(self):
        self.spec=json.loads((ROOT/'tests/fixtures/valid-script.json').read_text(encoding='utf-8'))

    def test_reviewed_spec_is_valid(self):validate(self.spec)

    def test_unknown_source_cannot_enter_render(self):
        self.spec['scenes'][0]['sourceIds']=['invented']
        with self.assertRaises(ValueError):validate(self.spec)

    def test_stats_need_measured_integer(self):
        self.spec['scenes'][1]['metric']='近1.5万'
        with self.assertRaises(ValueError):validate(self.spec)

    def test_long_narration_is_rejected_before_tts(self):
        self.spec['scenes'][0]['narration']=['很长的内容'*30]
        with self.assertRaises(ValueError):validate(self.spec)

    def test_edit_creates_new_version_and_preserves_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);original=root/'runs/original';original.mkdir(parents=True)
            raw=json.dumps(self.spec,ensure_ascii=False)
            (original/'script.json').write_text(raw, encoding='utf-8')
            (original/'evidence.json').write_text(json.dumps({'trending':{'weekly_stars':14946}}), encoding='utf-8')
            (original/'assets').mkdir()
            (original/'assets/demo.mp4').write_bytes(b'original-media-fixture')
            changed=copy.deepcopy(self.spec);changed['scenes'][0]['title']='项目交接讲不清？';changed['repo']='invented/repo'
            with patch.object(app,'ROOT',root),patch.object(app,'JOB',{'status':'running'}),patch.object(app,'synthesize') as voice,patch.object(app,'render') as render:
                app.LOCK.acquire()
                app.task('render',{'run':'original','script':changed})
                self.assertEqual(app.JOB['status'],'done')
                voice.assert_called_once();render.assert_called_once()
                revised=json.loads((root/'runs'/app.JOB['run']/'script.json').read_text(encoding='utf-8'))
                self.assertEqual(revised['repo'],self.spec['repo'])
                self.assertEqual(revised['scenes'][0]['title'],'项目交接讲不清？')
                self.assertEqual(revised['scenes'][1]['metric'],14946)
                self.assertEqual((root/'runs'/app.JOB['run']/'assets/demo.mp4').read_bytes(),b'original-media-fixture')
            self.assertEqual((original/'script.json').read_text(encoding='utf-8'),raw)
            self.assertFalse(app.LOCK.locked())

if __name__=='__main__':unittest.main()
