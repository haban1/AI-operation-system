import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from runtime import load_config,voice_python


class RuntimeTests(unittest.TestCase):
    def test_fresh_checkout_initializes_without_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'config.example.json').write_bytes((ROOT/'config.example.json').read_bytes())
            config=load_config(root)
            self.assertTrue((root/'data').is_dir())
            self.assertTrue((root/'runs').is_dir())
            self.assertEqual(config['tts']['edge_python'],'')
            self.assertNotIn('api_key',config['llm'])
            config['llm']['model']='existing-local-choice'
            (root/'config.json').write_text(json.dumps(config),encoding='utf-8')
            self.assertEqual(load_config(root)['llm']['model'],'existing-local-choice')

    def test_venv_is_resolved_inside_new_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            python=root/'.venv-voice'/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
            python.parent.mkdir(parents=True);python.touch()
            self.assertEqual(voice_python({},'edge',root),str(python.absolute()))
            with self.assertRaisesRegex(ValueError,'环境不存在'):
                voice_python({'python':'missing-python'},'qwen',root)


if __name__=='__main__':unittest.main()
