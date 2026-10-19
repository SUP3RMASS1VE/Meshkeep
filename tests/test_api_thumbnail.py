"""End-to-end: the cover image through the token-authenticated HTTP API."""

from __future__ import annotations

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

import helpers  # noqa: F401  (puts the repo root on sys.path)
from helpers import make_3mf, make_png, make_stl

import app

TOKEN = "tok"


class ApiThumbnailTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.dir = os.path.realpath(cls._tmp.name)
        cls.httpd = ThreadingHTTPServer(
            ("127.0.0.1", 0), app.make_handler(app.Api(cls.dir, os.path.join(cls.dir, "catalogue.sqlite3")), TOKEN))
        cls.httpd.daemon_threads = True
        cls.base = "http://127.0.0.1:%d" % cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls._tmp.cleanup()

    def request(self, route, body=None, auth=True):
        headers = {"Content-Type": "application/json"}
        if auth:
            headers["X-Auth"] = TOKEN
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + route, data=data,
                                     headers=headers,
                                     method="POST" if data else "GET")
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def save(self, body):
        status, raw = self.request("/api/save", body)
        if status != 200:
            return status, json.loads(raw)
        job = json.loads(raw)["job"]
        for _ in range(200):
            _s, raw = self.request("/api/job?id=" + job["id"])
            job = json.loads(raw)
            if job["state"] != "running":
                break
            time.sleep(0.05)
        return status, job

    def thumb(self, path):
        return self.request("/api/thumb?t=%s&path=%s"
                            % (TOKEN, urllib.parse.quote(path)), auth=False)

    def test_set_get_remove(self):
        p = make_3mf(os.path.join(self.dir, "a.3mf"))
        large = make_png(512, 512, (10, 20, 30, 255))
        small = make_png(128, 128)
        body = {"path": p, "backup": True, "thumbnail": {
            "action": "set", "png": base64.b64encode(large).decode(),
            "pngSmall": "data:image/png;base64," +
                        base64.b64encode(small).decode()}}

        status, _raw = self.request("/api/save", body, auth=False)
        self.assertEqual(status, 403)

        status, job = self.save(body)
        self.assertEqual(status, 200)
        self.assertEqual(job["state"], "done", job)
        self.assertTrue(os.path.exists(p + ".bak"))
        status, data = self.thumb(p)
        self.assertEqual((status, data), (200, large))

        _s, raw = self.request("/api/meta?path=" + urllib.parse.quote(p))
        meta = json.loads(raw)
        self.assertTrue(meta["thumbnailEditable"])
        self.assertTrue(meta["thumbnailCustom"])

        status, job = self.save({"path": p, "backup": True,
                                 "thumbnail": {"action": "remove"}})
        self.assertEqual(job["state"], "done", job)
        _s, raw = self.request("/api/meta?path=" + urllib.parse.quote(p))
        self.assertFalse(json.loads(raw)["thumbnailCustom"])

    def test_bad_input_is_400(self):
        p = make_3mf(os.path.join(self.dir, "b.3mf"))
        good = base64.b64encode(make_png(8, 8)).decode()
        cases = [
            {"action": "set", "png": "!!not base64!!", "pngSmall": good},
            {"action": "set", "png": base64.b64encode(b"GIF89a....").decode(),
             "pngSmall": good},
            {"action": "set", "png": good,
             "pngSmall": base64.b64encode(make_png(600, 1)).decode()},
            {"action": "explode"},
        ]
        for thumb in cases:
            status, payload = self.save({"path": p, "thumbnail": thumb})
            self.assertEqual(status, 400, thumb)
            self.assertIn("error", payload)

        stl = make_stl(os.path.join(self.dir, "c.stl"))
        status, payload = self.save({"path": stl, "thumbnail": {
            "action": "set", "png": good, "pngSmall": good}})
        self.assertEqual(status, 400)
        self.assertIn("3MF", payload["error"])


if __name__ == "__main__":
    unittest.main()
