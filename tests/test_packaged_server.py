"""Optional smoke test: MME_PACKAGED_SERVER=/absolute/path/to/mme-server."""
import json
import base64
import os
import queue
import threading
import subprocess
import tempfile
import time
import unittest
import urllib.parse
import urllib.request

import helpers
from helpers import make_stl, make_png


@unittest.skipUnless(os.environ.get('MME_PACKAGED_SERVER'), 'set MME_PACKAGED_SERVER to test a built sidecar')
class PackagedServerTests(unittest.TestCase):
    def test_bundled_assets_and_sqlite_index(self):
        with tempfile.TemporaryDirectory() as folder:
            models = os.path.join(folder, 'models')
            os.mkdir(models)
            make_stl(os.path.join(models, 'fixture.stl'))
            process = subprocess.Popen([os.environ['MME_PACKAGED_SERVER'], '--electron', '--port', '18917',
                '--root', models, '--catalogue', os.path.join(folder, 'catalogue.sqlite3')],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                url = None
                deadline = time.monotonic() + 20
                lines = queue.Queue()
                def read_output():
                    for line in iter(process.stdout.readline, b''):
                        lines.put(line)
                reader = threading.Thread(target=read_output, daemon=True)
                reader.start()
                output = b''
                while time.monotonic() < deadline:
                    try:
                        line = lines.get(timeout=.2)
                    except queue.Empty:
                        if process.poll() is not None:
                            break
                        continue
                    output += line
                    if line.startswith(b'READY_URL '):
                        url = line.decode().strip().split(' ', 1)[1]
                        break
                self.assertTrue(url, output.decode())
                parsed = urllib.parse.urlparse(url)
                base = '%s://%s' % (parsed.scheme, parsed.netloc)
                token = urllib.parse.parse_qs(parsed.query)['t'][0]
                def request(route, body=None):
                    req = urllib.request.Request(base + route, headers={'X-Auth': token, 'Content-Type': 'application/json'},
                        data=None if body is None else json.dumps(body).encode())
                    with urllib.request.urlopen(req, timeout=10) as response:
                        return response.read()
                for asset in ('/', '/meshkeep-icon.png', '/workspace.js', '/geometry.js', '/analysis-worker.js', '/browser.js', '/studio.js', '/threemf.js', '/vendor/three/build/three.module.min.js',
                              '/vendor/three/build/three.core.min.js', '/vendor/three/examples/jsm/controls/OrbitControls.js'):
                    self.assertTrue(request(asset), asset)
                self.assertIn(b'<title>Meshkeep</title>', request('/'))
                self.assertIn(b'<h1>Meshkeep</h1>', request('/'))
                job = json.loads(request('/api/scan', {'path': models}))['job']
                for _ in range(100):
                    job = json.loads(request('/api/job?id=' + job['id']))
                    if job['state'] != 'running':
                        break
                    time.sleep(.05)
                self.assertEqual(job['state'], 'done', job)
                result = json.loads(request('/api/browse?' + urllib.parse.urlencode({'path': models, 'scope': 'library'})))
                self.assertEqual(result['total'], 1)
                self.assertEqual(json.loads(request('/api/workspace'))['collections'], [])
                fixture = os.path.join(models, 'fixture.stl')
                request('/api/annotate', {'path': fixture, 'tags': ['packagecheck'], 'status': 'want'})
                collection = json.loads(request('/api/collection', {'root': models, 'name': 'Queued', 'kind': 'smart', 'rules': {'tag': 'packagecheck', 'status': 'want'}}))
                selected = json.loads(request('/api/browse?' + urllib.parse.urlencode({'path': models, 'scope': 'library', 'collection': collection['id']})))
                self.assertEqual(selected['total'], 1)
                photo = make_png(8, 8)
                request('/api/print', {'path': fixture, 'outcome': 'printed', 'printer': 'Packaged printer', 'settings': '0.2 mm', 'photos': [base64.b64encode(photo).decode()]})
                detail = json.loads(request('/api/organization?' + urllib.parse.urlencode({'path': fixture})))
                self.assertEqual(detail['status'], 'printed')
                self.assertEqual(detail['prints'][0]['printer'], 'Packaged printer')
                self.assertEqual(request('/api/printPhoto?id=' + detail['prints'][0]['photos'][0]), photo)

                request('/api/watch', {'path': models, 'enabled': True})
                make_stl(os.path.join(models, 'watched.stl'))
                deadline = time.monotonic() + 22
                while time.monotonic() < deadline:
                    result = json.loads(request('/api/browse?' + urllib.parse.urlencode({'path': models, 'scope': 'library'})))
                    if result['total'] == 2:
                        break
                    time.sleep(.2)
                self.assertEqual(result['total'], 2, 'Packaged watcher did not index the added model')

            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                reader.join(timeout=2)
                process.stdout.close()
                process.stderr.close()
