import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import creative_exploration as creative
from collect import fetch
from factory import SYSTEM


def example_brief():
    return {'name':'先看一次失败再解释', 'opening':'为何看到界面却不知道背后发生什么？',
            'story_arc':'误解现象，再根据证据定位，再解释局限', 'visual_plan':'用输入、分析、结果三张流程卡',
            'narration_direction':'像与朋友讲解，问题后留白', 'ending':'先确认对象再选分析工具',
            'creative_prompt':'用一次假设的程序分析任务串起来源中证实的能力，具体解释输入与输出，回到开头问题。',
            'tradeoff':'用示意流程，不能代表真实运行测评'}


class CreativeTests(unittest.TestCase):
    def test_seed_replays_assignment_but_new_round_changes_slots_and_dimensions(self):
        first=creative.new_experiment(seed='example-1')
        self.assertEqual(first,creative.new_experiment(seed='example-1'))
        self.assertEqual(len({a['render_style_id'] for a in first['agents']}),3)
        for dimension in creative.DIMENSIONS:
            self.assertEqual(len({a['assignment'][dimension] for a in first['agents']}),3)
        self.assertEqual(set(first['review_order']),set(creative.AGENT_IDS))
        next_round=creative.new_experiment([first],seed='example-1')
        old={tuple(a['assignment'].values()) for a in first['agents']}
        self.assertTrue(all(tuple(a['assignment'].values()) not in old for a in next_round['agents']))
        render_choices={creative.new_experiment(seed=str(i))['agents'][0]['render_style_id'] for i in range(20)}
        self.assertEqual(render_choices,set(creative.RENDERERS))

    def test_each_plan_receives_only_its_assignment_and_evidence(self):
        experiment=creative.new_experiment(seed='isolated')
        with patch.object(creative,'generate',return_value=json.dumps(example_brief())) as call:
            for a in experiment['agents']:
                result=creative.plan_creative_brief(a,{'repo':'morluto/rea','readme':'Evidence'}, {'llm':{'model':'fixture'}})
                prompt=json.loads(call.call_args.args[2])
                self.assertEqual(prompt['creative_constraints'],a['assignment'])
                self.assertNotIn('agents',prompt);self.assertNotIn('experiment',prompt)
                self.assertEqual(result['name'],example_brief()['name'])
        self.assertEqual(call.call_count,3)

    def test_dynamic_prompt_preserves_common_quality_rules_and_has_bounded_repair(self):
        a=creative.new_experiment(seed='one')['agents'][0]
        with patch.object(creative,'generate',side_effect=['{}',json.dumps(example_brief())]) as call:
            result=creative.plan_creative_brief(a,{}, {'llm':{}})
        self.assertEqual(call.call_count,2)
        instructions=SYSTEM+creative.brief_instructions(result,a['assignment'])
        self.assertIn(example_brief()['creative_prompt'],instructions)
        self.assertIn('不能照抄',instructions);self.assertIn('结尾回答开头',instructions)
        with patch.object(creative,'generate',return_value='{}') as call:
            with self.assertRaisesRegex(ValueError,'仍不合格'):creative.plan_creative_brief(a,{}, {'llm':{}})
        self.assertEqual(call.call_count,2)

    def test_github_fetch_uses_proxy_aware_reader_and_keeps_raw_readme_accept(self):
        with patch('collect.read_public',return_value=('README','https://api.github.com','text/plain')) as read:
            self.assertEqual(fetch('https://api.github.com/repos/example/repo/readme','application/vnd.github.raw+json'),'README')
        self.assertEqual(read.call_args.kwargs['accept'],'application/vnd.github.raw+json')
        with patch('collect.read_public',side_effect=[ValueError('网页连接失败或超时'),('ok','url','text/plain')]) as read,patch('collect.time.sleep'):
            self.assertEqual(fetch('https://example.com'),'ok')
        self.assertEqual(read.call_count,2)
        with patch('collect.read_public',side_effect=ValueError('网页返回 HTTP 404')) as read:
            with self.assertRaisesRegex(ValueError,'404'):fetch('https://example.com')
        read.assert_called_once()


if __name__=='__main__':unittest.main()
