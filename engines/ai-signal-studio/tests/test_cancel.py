import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from contextlib import ExitStack
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT/'scripts'))
import app
from collect import save
from task_control import ProgressDict, TaskControl
REAL_WORKER = app.task_worker


def fixture_worker(root, settings, job, action, payload, connection):
    job = ProgressDict(job, connection)
    if payload.get('complete'):
        job.update(status='done', step='隔离完成')
        return
    heartbeat = str(Path(root)/'heartbeat')
    code = "import signal,time,sys; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); p=Path(sys.argv[1]);\nwhile True:\n p.write_text(str(time.time())); time.sleep(.03)"
    subprocess.Popen([sys.executable, '-c', code, heartbeat])
    job.update(step='隔离任务运行中')
    while True:
        time.sleep(.05)


def wait_for(callback, seconds=6):
    limit = time.monotonic() + seconds
    while time.monotonic() < limit:
        if callback():
            return
        time.sleep(.03)
    raise AssertionError('等待条件超时')


class CancelTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        (self.root/'runs').mkdir()
        self.stack.enter_context(patch.object(app, 'ROOT', self.root))
        self.stack.enter_context(patch.object(app, 'JOB', {'status':'idle'}))
        self.stack.enter_context(patch.object(app, 'LOCK', threading.Lock()))
        self.stack.enter_context(patch.object(app, 'TASK_CONTROL', TaskControl()))
        self.stack.enter_context(patch.object(app, 'task_worker', fixture_worker))
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.stack.callback(thread.join)
        self.stack.callback(self.server.server_close)
        self.stack.callback(self.server.shutdown)
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def post(self, action, body, origin=None):
        headers = {'Content-Type':'application/json'}
        if origin:
            headers['Origin'] = origin
        request = urllib.request.Request(self.base+'/api/'+action, data=json.dumps(body).encode(), headers=headers)
        with urllib.request.urlopen(request) as response:
            return response.status, json.load(response)

    def tearDown(self):
        if app.TASK_CONTROL.active:
            app.TASK_CONTROL.cancel(app.JOB.get('started_at'), lambda: None)
            wait_for(lambda: not app.LOCK.locked())

    def test_cancel_kills_media_descendants_releases_lock_and_allows_next_job(self):
        status, result = self.post('collect', {})
        self.assertEqual(status, 202)
        token = result['job']['started_at']
        wait_for(lambda: (self.root/'heartbeat').exists())
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.post('cancel', {'started_at':'old-job'})
        self.assertEqual(error.exception.code, 409)
        self.assertTrue(app.LOCK.locked())
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.post('cancel', {'started_at':token}, 'http://other.invalid')
        self.assertEqual(error.exception.code, 403)
        self.assertEqual(self.post('cancel', {'started_at':token})[0], 202)
        wait_for(lambda: not app.LOCK.locked())
        self.assertEqual(app.JOB['status'], 'cancelled')
        self.assertEqual(json.loads((self.root/'data/last-job.json').read_text())['status'], 'cancelled')
        heartbeat = (self.root/'heartbeat').read_text()
        time.sleep(.15)
        self.assertEqual((self.root/'heartbeat').read_text(), heartbeat)
        self.assertEqual(self.post('cancel', {'started_at':token})[0], 200)
        self.assertEqual(self.post('collect', {'complete':True})[0], 202)
        wait_for(lambda: not app.LOCK.locked())
        self.assertEqual(app.JOB['status'], 'done')

    def test_cancel_comparison_retains_completed_agent_and_video(self):
        batch_id = 'compare-fixture'
        video = self.root/'runs/completed/video.mp4'
        video.parent.mkdir()
        video.write_bytes(b'completed-video-fixture')
        save(self.root/f'data/comparisons/{batch_id}.json', {
            'id':batch_id, 'status':'running', 'review':{'status':'pending'},
            'agents':[{'status':'done','run':'completed','video':'/runs/completed/video.mp4'},
                      {'status':'running'}, {'status':'queued'}]})
        app.JOB = {'status':'running', 'started_at':'comparison-token', 'comparison_id':batch_id}
        app.LOCK.acquire()
        app.TASK_CONTROL.prepare(app.JOB['started_at'])
        thread = threading.Thread(target=app.run_task, args=('compare', {}), daemon=True)
        thread.start()
        wait_for(lambda: (self.root/'heartbeat').exists())
        self.post('cancel', {'started_at':'comparison-token'})
        thread.join(5)
        self.assertFalse(thread.is_alive())
        batch = json.loads((self.root/f'data/comparisons/{batch_id}.json').read_text())
        self.assertEqual(batch['status'], 'cancelled')
        self.assertEqual([a['status'] for a in batch['agents']], ['done','cancelled','cancelled'])
        self.assertEqual(video.read_bytes(), b'completed-video-fixture')

    def test_cancel_before_worker_start_and_missing_task_identity(self):
        app.TASK_CONTROL.prepare('early')
        app.JOB = {'status':'running', 'started_at':'early'}
        app.LOCK.acquire()
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.post('cancel', {})
        self.assertEqual(error.exception.code, 400)
        self.post('cancel', {'started_at':'early'})
        app.run_task('collect', {})
        self.assertFalse(app.LOCK.locked())
        self.assertEqual(app.JOB['status'], 'cancelled')
        self.assertFalse((self.root/'heartbeat').exists())

    def test_real_worker_reports_completion_without_model_or_network(self):
        settings = {**app.SETTINGS, 'sources':{'github':False, 'hackernews':False, 'reddit':False,
                    'weibo':False, 'xiaohongshu':False, 'rss':[]}}
        with patch.object(app, 'task_worker', REAL_WORKER), patch.object(app, 'SETTINGS', settings):
            self.assertEqual(self.post('collect', {})[0], 202)
            wait_for(lambda: not app.LOCK.locked())
        self.assertEqual(app.JOB['status'], 'done')
        self.assertEqual(json.loads((self.root/'data/last-job.json').read_text())['status'], 'done')


if __name__ == '__main__':
    unittest.main()
