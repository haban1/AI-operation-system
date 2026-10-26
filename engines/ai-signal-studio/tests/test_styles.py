import json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import factory
from collect import parse_trending
from styles import get_style

class StyleTests(unittest.TestCase):
 def test_style_guidance_and_renderer_survive_generation(self):
  fixture=json.loads((ROOT/'tests/fixtures/v2-script.json').read_text())
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);run=root/'runs/new';run.mkdir(parents=True);(root/'data').mkdir()
   (run/'evidence.json').write_text(json.dumps({'url':'https://github.com/example/project','readme':'trusted evidence'}))
   (root/'data/feed.json').write_text(json.dumps({'candidates':[{'id':'example/project','weekly_stars':123}]}))
   cfg={'llm':{'provider':'compatible','base_url':'https://example.test/v1','model':'fixture','api_key':'fixture-not-real'}}
   with patch.object(factory,'ROOT',root),patch.object(factory,'generate',return_value=json.dumps(fixture)) as generate:
    result=factory.make_draft('example/project',run,cfg,style_id='discovery')
   self.assertIn(get_style('discovery')['guidance'],generate.call_args.args[1])
   self.assertEqual(result['renderer'],'style-lab');self.assertEqual(result['style_id'],'discovery')
   self.assertEqual(result['repo'],'example/project')
   self.assertNotIn('fixture-not-real',(run/'script.json').read_text())
 def test_unknown_style_fails_before_model_or_run_creation(self):
  with tempfile.TemporaryDirectory() as tmp,patch.object(factory,'generate') as generate:
   run=Path(tmp)/'invalid'
   with self.assertRaises(ValueError):factory.make_draft('example/project',run,style_id='../../bad')
   generate.assert_not_called();self.assertFalse(run.exists())
 def test_claude_codex_tool_is_not_filtered_out(self):
  html='<article><h2><a href="/example/diagram">diagram</a></h2><p>Editorial diagrams for Claude Code and Codex</p><span>37 stars this week</span></article>'
  result=parse_trending(html,'2026-10-15T00:00:00Z')
  self.assertEqual(result[0]['weekly_stars'],37)
