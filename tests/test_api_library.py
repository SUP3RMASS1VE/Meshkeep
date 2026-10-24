"""HTTP checks for library endpoints and their existing authentication boundary."""
import base64
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

import helpers
from helpers import make_stl, make_png
import app
from file_state import file_stat
from library import signature


class ApiLibraryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = os.path.realpath(cls.temp.name)
        cls.path = make_stl(os.path.join(cls.root, 'first.stl'))
        make_stl(os.path.join(cls.root, 'second.stl'))
        cls.api = app.Api(cls.root, os.path.join(cls.root, 'catalogue.sqlite3'))
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), app.make_handler(cls.api, 'qa'))
        cls.server.daemon_threads = True
        cls.base = 'http://127.0.0.1:%s' % cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.temp.cleanup()

    def request(self, name, params=None, body=None, auth=True):
        url = self.base + '/api/' + name + '?' + urllib.parse.urlencode(params or {})
        headers = {'Content-Type': 'application/json'}
        if auth:
            headers['X-Auth'] = 'qa'
        request = urllib.request.Request(url, headers=headers,
            data=None if body is None else json.dumps(body).encode())
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.read(), response.headers
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(), exc.headers

    def job(self, name):
        status, data, _ = self.request(name, body={'path': self.root})
        self.assertEqual(status, 200)
        job = json.loads(data)['job']
        for _ in range(200):
            _, data, _ = self.request('job', {'id': job['id']})
            job = json.loads(data)
            if job['state'] != 'running':
                self.assertEqual(job['state'], 'done', job)
                return job['result']
            time.sleep(.01)
        self.fail('Job did not complete')

    def test_authentication_and_path_scope(self):
        for endpoint in ('browse', 'model', 'preview', 'workspace', 'project', 'organization', 'geometryCandidates', 'printPhoto'):
            status, _, _ = self.request(endpoint, {'path': self.path}, auth=False)
            self.assertEqual(status, 403)
        for endpoint in ('scan', 'duplicates', 'cachePreview', 'annotate', 'project', 'collection', 'print', 'watch', 'geometry'):
            status, _, _ = self.request(endpoint, body={'path': self.root}, auth=False)
            self.assertEqual(status, 403)
        status, _, _ = self.request('model', {'path': '/etc/hosts'})
        self.assertEqual(status, 400)

    def test_static_backslash_traversal_is_rejected(self):
        route = '/..%5capp.py?t=qa'
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(self.base + route)
        self.assertEqual(error.exception.code, 404)

    def test_scan_hashes_and_paged_query(self):
        self.assertEqual(self.job('scan')['indexed'], 2)
        self.assertEqual(self.job('duplicates')['duplicateFiles'], 2)
        status, raw, _ = self.request('browse', {'path': self.root, 'scope': 'library', 'duplicates': '1', 'limit': '1'})
        self.assertEqual(status, 200)
        result = json.loads(raw)
        self.assertEqual(result['total'], 2)
        self.assertEqual(len(result['files']), 1)
        self.assertEqual(result['files'][0]['duplicateCount'], 2)

    def test_model_bytes_and_versioned_cache(self):
        status, raw, headers = self.request('model', {'path': self.path})
        self.assertEqual(status, 200)
        with open(self.path, 'rb') as source:
            self.assertEqual(raw, source.read())
        stamp = headers['X-Model-Stamp'].split(',')
        self.assertEqual(stamp, [str(n) for n in signature(file_stat(self.path))])
        png = make_png(12, 12)
        status, _, _ = self.request('cachePreview', body={'path': self.path, 'stamp': stamp,
            'png': base64.b64encode(png).decode()})
        self.assertEqual(status, 200)
        status, raw, _ = self.request('preview', {'path': self.path})
        self.assertEqual((status, raw), (200, png))
        status, _, _ = self.request('cachePreview', body={'path': self.path, 'stamp': ['0', '0', '0'],
            'png': base64.b64encode(png).decode()})
        self.assertEqual(status, 400)
