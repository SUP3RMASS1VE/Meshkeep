#!/usr/bin/env python3
"""Meshkeep desktop application's local server sidecar.

Started by the Electron app; serves the bundled interface on an authenticated
loopback connection. End users launch Meshkeep.app or Meshkeep.exe.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import mimetypes
import os
import posixpath
import secrets
import shutil
import signal
import socket
import sys
import threading
import time
import traceback
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import formats
from file_state import file_stat, is_link
from library import Library, under
from organizer import Organizer
from workspace_api import WorkspaceApi
from watcher import FolderWatcher
from formats.base import FIELD_SCHEMA, MetaError, Patch, human, png_size

if getattr(sys, "frozen", False):
    # PyInstaller bundle: data files live under _MEIPASS
    HERE = getattr(sys, "_MEIPASS",
                   os.path.dirname(os.path.abspath(sys.executable)))
else:
    HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
# JSON bodies; the cover image travels as base64 PNG inside /api/save.
MAX_BODY = 20 << 20
MAX_IMAGE_BYTES = 4 << 20


def decode_png(raw, label, max_side):
    """Base64 (optionally a data: URL) -> validated PNG bytes."""
    if not isinstance(raw, str) or not raw:
        raise MetaError("The %s image is missing." % label)
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[-1]
    try:
        data = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        raise MetaError("The %s image is not valid base64." % label)
    if len(data) > MAX_IMAGE_BYTES:
        raise MetaError("The %s image is larger than %s." %
                        (label, human(MAX_IMAGE_BYTES)))
    width, height = png_size(data)
    if width > max_side or height > max_side:
        raise MetaError("The %s image is %d×%d; at most %d px per side is "
                        "allowed." % (label, width, height, max_side))
    return data


def parse_thumbnail(raw):
    """Turn the save body's ``thumbnail`` key into a Patch.thumbnail."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise MetaError("Unknown thumbnail action.")
    action = raw.get("action")
    if action == "remove":
        return {"action": "remove"}
    if action == "set":
        return {"action": "set",
                "large": decode_png(raw.get("png"), "cover", 2048),
                "small": decode_png(raw.get("pngSmall"), "small cover", 512)}
    raise MetaError("Unknown thumbnail action.")

# Directories that only ever add noise to a model browser.
SKIP_DIRS = {".git", ".svn", "node_modules", "__pycache__", ".Trash",
             "Library", ".DS_Store"}


class Job:
    _seq = 0
    _lock = threading.Lock()

    def __init__(self, label):
        with Job._lock:
            Job._seq += 1
            self.id = "job%d" % Job._seq
        self.label = label
        self.state = "running"
        self.progress = 0.0
        self.message = "Starting"
        self.error = None
        self.result = None
        self.started = time.time()

    def as_dict(self):
        return {"id": self.id, "label": self.label, "state": self.state,
                "progress": self.progress, "message": self.message,
                "error": self.error, "result": self.result,
                "elapsed": round(time.time() - self.started, 1)}


JOBS = {}
JOBS_LOCK = threading.Lock()


def start_job(label, fn):
    job = Job(label)
    with JOBS_LOCK:
        JOBS[job.id] = job
        # keep the table from growing without bound
        if len(JOBS) > 50:
            for old in sorted(JOBS.values(), key=lambda j: j.started)[:20]:
                if old.state != "running":
                    JOBS.pop(old.id, None)

    def run():
        def progress(frac, message=None):
            job.progress = frac
            if message:
                job.message = message
        try:
            job.result = fn(progress)
            job.state = "done"
            job.progress = 1.0
            job.message = "Done"
        except MetaError as exc:
            job.state = "error"
            job.error = str(exc)
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI
            job.state = "error"
            job.error = "%s: %s" % (type(exc).__name__, exc)
            traceback.print_exc()

    threading.Thread(target=run, daemon=True).start()
    return job


def default_catalogue():
    if sys.platform == 'win32':
        support = os.environ.get('LOCALAPPDATA') or os.path.join(os.path.expanduser('~'), 'AppData', 'Local')
    else:
        support = os.path.join(os.path.expanduser('~'), 'Library', 'Application Support')
    legacy = os.path.join(support, 'Model Meta Editor', 'catalogue.sqlite3')
    # Continue using an existing catalogue, including its thumbnail cache.
    if os.path.isfile(legacy):
        return legacy
    return os.path.join(support, 'Meshkeep', 'catalogue.sqlite3')


class Api(WorkspaceApi):
    decode_photo = staticmethod(decode_png)

    def __init__(self, root, db_path=None):
        self.root = os.path.realpath(os.path.expanduser(root))
        self.library = Library(db_path or default_catalogue())
        self.organizer = Organizer(self.library)

    def browse(self, q):
        def value(key, default=''):
            return q.get(key, [default])[0]
        path = self.resolve(value('path'))
        if not os.path.isdir(path):
            path = os.path.dirname(path)
        try:
            offset = max(0, int(value('offset', '0')))
            limit = max(1, min(200, int(value('limit', '80'))))
        except ValueError:
            raise MetaError('Invalid result page.')
        options = dict(search=value('search').strip(), ext=value('ext'),
                       sort=value('sort', 'name'), descending=value('desc') == '1',
                       duplicates=value('duplicates') == '1', offset=offset, limit=limit,
                       tag=value('tag'), status=value('status'), designer=value('designer'),
                       collection=value('collection'), geometry=value('geometry') == '1')
        if options['collection']:
            collection = self.organizer.collection(options['collection'])
            path = self.resolve(collection['root'])
        listing = self.list({'path': [path], 'dirsOnly': ['1' if value('scope') == 'library' else '0']})
        if value('scope') == 'library' or options['collection'] or options['geometry']:
            result = self.library.query(path, recursive=True, **options)
        else:
            # Direct folder browsing works before a catalogue has been built.
            files = self.library.enrich(path, listing['files'])
            term = options['search'].casefold()
            files = [f for f in files if (not term or any(term in str(f.get(k, '')).casefold() for k in ('name','path','title','designer','description')))
                     and (not options['ext'] or f['ext'] == options['ext'])
                     and (not options['tag'] or options['tag'].casefold() in f.get('tags', []))
                     and (not options['status'] or options['status'] == f.get('status', 'unprinted'))]
            key = {'modified': 'mtime', 'format': 'ext'}.get(options['sort'], options['sort'])
            files.sort(key=lambda f: (str(f.get(key, '')).casefold() if key not in ('size', 'mtime')
                                     else f[key], f['path']), reverse=options['descending'])
            result = dict(files=files[offset:offset + limit], total=len(files), offset=offset,
                          limit=limit, indexed=0, duplicateGroups=0)
        listing.update(result)
        return listing

    def scan(self, body):
        path = self.resolve(body.get('path'))
        if not os.path.isdir(path):
            raise MetaError('Choose a folder to index.')
        return {'job': start_job('Indexing library', lambda p: self.library.scan(path, p)).as_dict()}

    def duplicates(self, body):
        path = self.resolve(body.get('path'))
        if not os.path.isdir(path):
            raise MetaError('Choose a folder to check.')
        def work(progress):
            scan = self.library.scan(path, progress)
            result = self.library.hashes(path, progress)
            result['errors'] = (scan['errors'] + result['errors'])[:50]
            result['errorCount'] += scan['errorCount']
            return result
        return {'job': start_job('Finding exact duplicates', work).as_dict()}

    def model(self, q):
        path = self.resolve(q.get('path', [''])[0])
        if os.path.splitext(path)[1].lower() not in formats.EXTENSIONS or not os.path.isfile(path):
            raise MetaError('Choose a supported model file.')
        if os.path.getsize(path) > (64 << 20):
            raise MetaError('Interactive preview is limited to 64 MB per file. Metadata editing still works.')
        if path.lower().endswith('.3mf'):
            with zipfile.ZipFile(path) as archive:
                infos = archive.infolist()
                if len(infos) > 5000 or sum(i.file_size for i in infos) > (256 << 20):
                    raise MetaError('This 3MF is too large to preview safely (256 MB unpacked limit).')
        return path

    def preview(self, q):
        path = self.resolve(q.get('path', [''])[0])
        cached = self.library.preview(path)
        if cached:
            return 'image/png', cached
        return self.thumb(q)

    def cache_preview(self, body):
        path = self.resolve(body.get('path'))
        png = decode_png(body.get('png'), 'preview', 512)
        stamp = body.get('stamp')
        if not isinstance(stamp, list) or len(stamp) != 3:
            raise MetaError('Missing preview file version.')
        self.library.cache_preview(path, png, stamp)
        return {'ok': True}

    # --- path handling ------------------------------------------------------
    def resolve(self, raw, must_exist=True):
        if not raw:
            return self.root
        path = os.path.realpath(os.path.expanduser(raw))
        if not under(path, self.root):
            raise MetaError("%s is outside the folder this app was started "
                            "with (%s)." % (path, self.root))
        if must_exist and not os.path.exists(path):
            raise MetaError("%s does not exist." % path)
        return path

    # --- endpoints ----------------------------------------------------------
    def config(self, q):
        return {
            "schema": [{"key": k, "label": lb, "hint": h}
                       for k, lb, h in FIELD_SCHEMA],
            "extensions": formats.EXTENSIONS,
            "root": self.root,
            "start": self.root,
        }

    def list(self, q):
        path = self.resolve(q.get("path", [""])[0] or self.root)
        if os.path.isfile(path):
            path = os.path.dirname(path)
        dirs, files = [], []
        try:
            entries = sorted(os.scandir(path), key=lambda e: e.name.lower())
        except PermissionError:
            raise MetaError("No permission to read %s." % path)
        for entry in entries:
            if entry.name.startswith(".") or entry.name in SKIP_DIRS or is_link(entry.path):
                continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    dirs.append({"name": entry.name, "path": entry.path})
                    continue
                if q.get('dirsOnly', ['0'])[0] == '1' or entry.is_symlink():
                    continue
                ext = os.path.splitext(entry.name)[1].lower()
                if ext not in formats.EXTENSIONS:
                    continue
                st = entry.stat()
                files.append({"name": entry.name, "path": entry.path,
                              "ext": ext, "size": st.st_size,
                              "sizeText": human(st.st_size),
                              "mtime": st.st_mtime,
                              "hasBackup": os.path.exists(entry.path + ".bak")})
            except OSError:
                continue

        crumbs = []
        walk = path
        while True:
            crumbs.append({"name": os.path.basename(walk) or walk,
                           "path": walk})
            if walk == self.root or len(crumbs) > 40:
                break
            parent = os.path.dirname(walk)
            if parent == walk:
                break
            walk = parent
        crumbs.reverse()
        parent = os.path.dirname(path)
        return {"path": path,
                "parent": parent if path != self.root else None,
                "crumbs": crumbs, "dirs": dirs, "files": files}

    def meta(self, q):
        path = self.resolve(q.get("path", [""])[0])
        if not os.path.isfile(path):
            raise MetaError("%s is not a file." % path)
        meta = formats.read(path).as_dict()
        st = file_stat(path)
        meta["path"] = path
        meta["name"] = os.path.basename(path)
        meta["size"] = st.st_size
        meta["hasBackup"] = os.path.exists(path + ".bak")
        meta['organization'] = self.organizer.detail(path)
        meta['stamp'] = [str(st.st_size), str(st.st_mtime_ns), str(st.st_ctime_ns)]
        return meta

    def thumb(self, q):
        path = self.resolve(q.get("path", [""])[0])
        got = formats.thumbnail(path)
        if not got:
            raise MetaError("No embedded thumbnail.")
        return got  # (mime, bytes) - handled specially by the request handler

    def save(self, body):
        path = self.resolve(body.get("path"))
        thumbnail = parse_thumbnail(body.get("thumbnail"))
        if thumbnail is not None:
            handler = formats.detect(path)
            if handler is None or handler.name != "3mf":
                raise MetaError("Only 3MF files can hold a cover image.")
        patch = Patch(fields=body.get("fields") or {},
                      custom=body.get("custom"),
                      objects=body.get("objects") or {},
                      thumbnail=thumbnail)
        if patch.is_empty():
            raise MetaError("Nothing to save.")
        backup = bool(body.get("backup", True))
        fast = bool(body.get("fast", False))
        name = os.path.basename(path)

        def work(progress):
            formats.write(path, patch, progress=progress, backup=backup,
                          fast=fast)
            self.library.refresh(path)
            return {"paths": [path],
                    "hasBackup": os.path.exists(path + ".bak")}

        return {"job": start_job("Saving %s" % name, work).as_dict()}

    def batch(self, body):
        paths = [self.resolve(p) for p in (body.get("paths") or [])]
        if not paths:
            raise MetaError("No files selected.")
        fields = {k: v for k, v in (body.get("fields") or {}).items()
                  if v is not None}
        if not fields:
            raise MetaError("Fill in at least one field to apply.")
        backup = bool(body.get("backup", True))
        fast = bool(body.get("fast", False))

        def work(progress):
            done, failed = [], []
            for index, path in enumerate(paths):
                base = index / len(paths)
                span = 1.0 / len(paths)
                name = os.path.basename(path)

                def sub(frac, message=None, base=base, span=span, name=name):
                    progress(base + span * frac,
                             "%s (%d/%d)" % (name, index + 1, len(paths)))
                try:
                    handler = formats.detect(path)
                    if handler is None:
                        raise MetaError("unsupported format")
                    meta = handler.read(path)
                    usable = {k: v for k, v in fields.items()
                              if k in meta.editable}
                    if not usable:
                        failed.append({"name": name,
                                       "error": "none of those fields fit a "
                                                "%s file" % meta.fmt})
                        continue
                    handler.write(path, Patch(fields=usable), progress=sub,
                                  backup=backup, fast=fast)
                    self.library.refresh(path)
                    done.append(name)
                except MetaError as exc:
                    failed.append({"name": name, "error": str(exc)})
                except Exception as exc:  # noqa: BLE001
                    failed.append({"name": name,
                                   "error": "%s: %s" % (type(exc).__name__, exc)})
            return {"applied": done, "failed": failed, "paths": paths}

        label = "Applying to %d file%s" % (len(paths), "" if len(paths) == 1 else "s")
        return {"job": start_job(label, work).as_dict()}

    def rename(self, body):
        path = self.resolve(body.get("path"))
        new_name = (body.get("name") or "").strip()
        if not new_name:
            raise MetaError("The new file name is empty.")
        if os.sep in new_name or new_name in (".", ".."):
            raise MetaError("The file name cannot contain %s." % os.sep)
        target = os.path.join(os.path.dirname(path), new_name)
        self.resolve(target, must_exist=False)
        if os.path.exists(target) and os.path.realpath(target) != path:
            raise MetaError("%s already exists in that folder." % new_name)
        os.rename(path, target)
        bak = path + ".bak"
        if os.path.exists(bak):
            os.rename(bak, target + ".bak")
        with self.library.connect() as db:
            indexed = db.execute('SELECT 1 FROM models WHERE path=?', (path,)).fetchone()
        self.organizer.move(path, target)
        self.library.forget(path)
        if indexed:
            self.library.update(target)
        return {"path": target, "name": new_name}

    def revert(self, body):
        path = self.resolve(body.get("path"))
        bak = path + ".bak"
        if not os.path.exists(bak):
            raise MetaError("There is no backup for this file.")
        name = os.path.basename(path)

        def work(progress):
            progress(0.1, "Restoring %s" % name)
            tmp = path + ".restoring"
            shutil.copy2(bak, tmp)
            os.replace(tmp, path)
            self.library.refresh(path)
            progress(1.0, "Restored")
            return {"paths": [path], "hasBackup": True}

        return {"job": start_job("Restoring %s" % name, work).as_dict()}

    def discard_backup(self, body):
        path = self.resolve(body.get("path"))
        bak = path + ".bak"
        if os.path.exists(bak):
            os.unlink(bak)
        return {"path": path, "hasBackup": False}

    def job(self, q):
        job_id = q.get("id", [""])[0]
        with JOBS_LOCK:
            job = JOBS.get(job_id)
        if not job:
            raise MetaError("Unknown job %s." % job_id)
        return job.as_dict()


def make_handler(api, token):
    class Handler(BaseHTTPRequestHandler):
        server_version = "Meshkeep"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            if "--verbose" in sys.argv:
                sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

        # --- helpers --------------------------------------------------------
        def send_json(self, obj, status=200):
            body = json.dumps(obj).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def send_bytes(self, data, mime, status=200, cache=False):
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control",
                             "max-age=60" if cache else "no-store")
            self.end_headers()
            self.wfile.write(data)

        def fail(self, message, status=400):
            self.send_json({"error": message}, status)

        def authorised(self, query):
            host = (self.headers.get("Host") or "").split(":")[0]
            if host not in ("127.0.0.1", "localhost", "[::1]", "::1"):
                return False
            supplied = self.headers.get("X-Auth") or query.get("t", [""])[0]
            return secrets.compare_digest(str(supplied), token)

        def read_body(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                raise MetaError("Request body too large.")
            if not length:
                return {}
            return json.loads(self.rfile.read(length).decode("utf-8"))

        # --- routing --------------------------------------------------------
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            route = parsed.path

            if route.startswith("/api/"):
                if not self.authorised(query):
                    return self.fail("Not authorised. Reopen the link printed "
                                     "in the terminal.", 403)
                name = route[len("/api/"):]
                getters = {"config": api.config, "list": api.list,
                           "meta": api.meta, "job": api.job, 'browse': api.browse, 'workspace': api.workspace,
                           'organization': api.organization, 'geometryCandidates': api.geometry_candidates}
                try:
                    if name == "thumb":
                        mime, data = api.thumb(query)
                        return self.send_bytes(data, mime, cache=True)
                    if name == 'printPhoto':
                        mime, data = api.print_photo(query)
                        return self.send_bytes(data, mime)
                    if name == 'preview':
                        try:
                            mime, data = api.preview(query)
                        except MetaError as exc:
                            return self.fail(str(exc), 404)
                        return self.send_bytes(data, mime)
                    if name == 'model':
                        path = api.model(query)
                        with open(path, 'rb') as model:
                            st = file_stat(model.fileno())
                            self.send_response(200)
                            self.send_header('Content-Type', 'application/octet-stream')
                            self.send_header('Content-Length', str(st.st_size))
                            self.send_header('X-Model-Stamp', ','.join(str(n) for n in (st.st_size, st.st_mtime_ns, st.st_ctime_ns)))
                            self.send_header('Cache-Control', 'no-store')
                            self.end_headers()
                            shutil.copyfileobj(model, self.wfile, 1 << 20)
                        return
                    if name in getters:
                        return self.send_json(getters[name](query))
                except MetaError as exc:
                    return self.fail(str(exc))
                except Exception as exc:  # noqa: BLE001
                    traceback.print_exc()
                    return self.fail("%s: %s" % (type(exc).__name__, exc), 500)
                return self.fail("Unknown endpoint %s" % name, 404)

            return self.serve_static(route)

        def do_POST(self):
            parsed = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            if not parsed.path.startswith("/api/"):
                return self.fail("Not found", 404)
            if not self.authorised(query):
                return self.fail("Not authorised.", 403)
            name = parsed.path[len("/api/"):]
            posters = {"save": api.save, "batch": api.batch,
                       "rename": api.rename, "revert": api.revert,
                       "discardBackup": api.discard_backup,
                       'scan': api.scan, 'duplicates': api.duplicates,
                       'cachePreview': api.cache_preview, 'annotate': api.annotate,
                       'collection': api.collection_action, 'print': api.print_action,
                       'watch': api.watch_action, 'geometry': api.geometry_save}
            if name not in posters:
                return self.fail("Unknown endpoint %s" % name, 404)
            try:
                return self.send_json(posters[name](self.read_body()))
            except MetaError as exc:
                return self.fail(str(exc))
            except json.JSONDecodeError:
                return self.fail("Malformed request body.")
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                return self.fail("%s: %s" % (type(exc).__name__, exc), 500)

        def serve_static(self, route):
            rel = posixpath.normpath(urllib.parse.unquote(route)).lstrip("/")
            if rel in ("", "."):
                rel = "index.html"
            if rel.startswith(".."):
                return self.fail("Not found", 404)
            target = os.path.realpath(os.path.join(WEB, rel))
            if not under(target, os.path.realpath(WEB)):
                return self.fail("Not found", 404)
            if not os.path.isfile(target):
                return self.fail("Not found", 404)
            mime = mimetypes.guess_type(target)[0] or "application/octet-stream"
            if mime.startswith("text/") or mime.endswith("javascript"):
                mime += "; charset=utf-8"
            with open(target, "rb") as f:
                return self.send_bytes(f.read(), mime)

    return Handler


def free_port(host, preferred):
    for port in [preferred] + list(range(preferred + 1, preferred + 20)):
        with socket.socket() as s:
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    raise SystemExit("No free port near %d." % preferred)


def main():
    ap = argparse.ArgumentParser(
        description="Edit names and authorship metadata in 3D print files.")
    ap.add_argument("--root", default=os.path.expanduser("~"),
                    help="Folder the app is allowed to browse and edit "
                         "(default: your home folder).")
    ap.add_argument("--port", type=int, default=8756)
    ap.add_argument("--catalogue", help="Optional path to the local SQLite catalogue.")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--electron", action="store_true",
                    help="Internal startup flag used by the Meshkeep desktop app.")
    args = ap.parse_args()
    if not args.electron:
        ap.error("Launch the Meshkeep desktop application. This server is an internal app component.")

    root = os.path.realpath(os.path.expanduser(args.root))
    if not os.path.isdir(root):
        raise SystemExit("--root %s is not a folder." % root)

    host = "127.0.0.1"
    port = free_port(host, args.port)
    token = secrets.token_urlsafe(24)
    api = Api(root, args.catalogue)
    httpd = ThreadingHTTPServer((host, port), make_handler(api, token))
    httpd.daemon_threads = True
    watcher = FolderWatcher(api.library, root)
    watcher.start()

    url = "http://%s:%d/?t=%s" % (host, port, token)
    print("Meshkeep")
    print("  formats : %s" % ", ".join(formats.EXTENSIONS))
    print("  folder  : %s" % root)
    sys.stdout.flush()
    if args.electron:
        # single machine-parseable line for the desktop shell
        print("READY_URL " + url, flush=True)

    def on_term(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, on_term)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        watcher.stop()
        httpd.server_close()


if __name__ == "__main__":
    main()
