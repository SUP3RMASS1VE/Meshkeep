"""Persistent local catalogue. File contents are never stored in the database."""
from __future__ import annotations

import hashlib
import os
import sqlite3
import threading
from contextlib import contextmanager

import formats
from file_state import file_stat, is_link
from formats.base import MetaError, human
from organizer import install, Organizer

SKIP = {'.git', '.svn', 'node_modules', '__pycache__', '.Trash', 'Library'}
SORTS = {'name': 'name COLLATE NOCASE', 'size': 'size', 'modified': 'mtime',
         'format': 'ext', 'designer': 'designer COLLATE NOCASE',
         'title': 'title COLLATE NOCASE'}


def signature(st):
    return st.st_size, st.st_mtime_ns, st.st_ctime_ns


def under(path, root):
    try:
        return os.path.commonpath([os.path.normcase(path), os.path.normcase(root)]) == os.path.normcase(root)
    except ValueError:
        return False


def like(value):
    return value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def filter_clause(where, args, search='', tag='', status='', ext='', designer=''):
    args = list(args)
    if tag:
        where += ' AND EXISTS (SELECT 1 FROM tags WHERE tags.path=models.path AND tag=? COLLATE NOCASE)'
        args.append(tag.casefold())
    if status:
        where += " AND COALESCE((SELECT status FROM annotations WHERE annotations.path=models.path),'unprinted')=?"
        args.append(status)
    if ext:
        where += ' AND ext=?'
        args.append(ext)
    if designer:
        where += ' AND designer LIKE ? ESCAPE "\\"'
        args.append('%'+like(designer)+'%')
    if search:
        where += ' AND (name LIKE ? ESCAPE "\\" OR path LIKE ? ESCAPE "\\" OR title LIKE ? ESCAPE "\\" OR designer LIKE ? ESCAPE "\\" OR description LIKE ? ESCAPE "\\")'
        args += ['%'+like(search)+'%']*5
    return where, args


class Library:
    def __init__(self, path):
        self.path = path
        self._init_lock = threading.Lock()
        self.scan_lock = threading.Lock()
        self._ready = False

    @contextmanager
    def connect(self):
        with self._init_lock:
            os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
            db = sqlite3.connect(self.path, timeout=30)
            db.row_factory = sqlite3.Row
            if not self._ready:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute("""CREATE TABLE IF NOT EXISTS models (
                    path TEXT PRIMARY KEY, folder TEXT NOT NULL, name TEXT NOT NULL,
                    ext TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL,
                    mtime_ns INTEGER NOT NULL, ctime_ns INTEGER NOT NULL,
                    title TEXT NOT NULL DEFAULT '', designer TEXT NOT NULL DEFAULT '',
                    description TEXT NOT NULL DEFAULT '', license TEXT NOT NULL DEFAULT '',
                    hasThumbnail INTEGER NOT NULL DEFAULT 0, error TEXT,
                    hash TEXT, hash_size INTEGER, hash_mtime INTEGER, hash_ctime INTEGER)""")
                db.execute('CREATE INDEX IF NOT EXISTS models_folder ON models(folder)')
                db.execute('CREATE INDEX IF NOT EXISTS models_size ON models(size)')
                db.execute('CREATE INDEX IF NOT EXISTS models_hash ON models(hash)')
                db.execute("""CREATE TABLE IF NOT EXISTS previews (
                    path TEXT PRIMARY KEY, size TEXT, mtime TEXT, ctime TEXT, png BLOB NOT NULL)""")
                install(db)
                db.commit()
                self._ready = True
        try:
            with db:
                yield db
        finally:
            db.close()

    def enrich(self, folder, files):
        with self.connect() as db:
            rows = {r['path']: dict(r) for r in db.execute(
                'SELECT path,title,designer,description,hasThumbnail,error FROM models WHERE folder=?', (folder,))}
        for item in files:
            item.update(rows.get(item['path'], {}))
            item['folder'] = folder
        return self.decorate(files)

    def decorate(self, files):
        if not files:
            return files
        placeholders = ','.join('?' for _ in files)
        paths = [f['path'] for f in files]
        with self.connect() as db:
            annotations = {r['path']: dict(r) for r in db.execute('SELECT * FROM annotations WHERE path IN ('+placeholders+')', paths)}
            tags = {}
            for row in db.execute('SELECT path,tag FROM tags WHERE path IN ('+placeholders+') ORDER BY tag', paths):
                tags.setdefault(row['path'], []).append(row['tag'])
        for item in files:
            item['status'] = annotations.get(item['path'], {}).get('status', 'unprinted')
            item['tags'] = tags.get(item['path'], [])
        return files

    def preview(self, path):
        stamp = tuple(str(n) for n in signature(file_stat(path)))
        with self.connect() as db:
            row = db.execute('SELECT * FROM previews WHERE path=?', (path,)).fetchone()
        if row and stamp == (row['size'], row['mtime'], row['ctime']):
            return bytes(row['png'])
        return None

    def cache_preview(self, path, png, stamp):
        if tuple(stamp) != tuple(str(n) for n in signature(file_stat(path))):
            raise MetaError('The file changed while its preview was being generated.')
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO previews VALUES (?,?,?,?,?)', (path, *stamp, png))

    def update(self, path, force=False):
        st = file_stat(path)
        with self.connect() as db:
            old = db.execute('SELECT * FROM models WHERE path=?', (path,)).fetchone()
            if not force and old and signature(st) == (old['size'], old['mtime_ns'], old['ctime_ns']):
                return old['error']
        fields, thumb, error = {}, False, None
        try:
            meta = formats.read(path)
            fields, thumb = meta.fields, meta.has_thumbnail
        except Exception as exc:
            error = str(exc)
        after = file_stat(path)
        if signature(st) != signature(after):
            return  # next scan retries files changing underneath us
        with self.connect() as db:
            db.execute('''INSERT INTO models
                (path,folder,name,ext,size,mtime,mtime_ns,ctime_ns,title,designer,description,license,hasThumbnail,error)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET
                folder=excluded.folder,name=excluded.name,ext=excluded.ext,size=excluded.size,
                mtime=excluded.mtime,mtime_ns=excluded.mtime_ns,ctime_ns=excluded.ctime_ns,
                title=excluded.title,designer=excluded.designer,description=excluded.description,
                license=excluded.license,hasThumbnail=excluded.hasThumbnail,error=excluded.error,
                hash=NULL,hash_size=NULL,hash_mtime=NULL,hash_ctime=NULL''',
                (path, os.path.dirname(path), os.path.basename(path), os.path.splitext(path)[1].lower(),
                 st.st_size, st.st_mtime, st.st_mtime_ns, st.st_ctime_ns,
                 fields.get('title', ''), fields.get('designer', ''), fields.get('description', ''),
                 fields.get('license', ''), int(thumb), error))
        return error

    def forget(self, path):
        with self.connect() as db:
            db.execute('DELETE FROM models WHERE path=?', (path,))
            db.execute('DELETE FROM previews WHERE path=?', (path,))

    def refresh(self, path):
        # Only update files already in the catalogue; editing doesn't silently add a library.
        with self.connect() as db:
            exists = db.execute('SELECT 1 FROM models WHERE path=?', (path,)).fetchone()
        if exists:
            self.update(path, force=True)

    def scan(self, root, progress):
        if not self.scan_lock.acquire(blocking=False):
            raise MetaError('Another library scan or duplicate check is still running.')
        try:
            count, errors = 0, []
            def onerror(exc):
                errors.append(str(exc))
            for folder, dirs, files in os.walk(root, followlinks=False, onerror=onerror):
                dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in SKIP
                                 and not is_link(os.path.join(folder, d)))
                for name in files:
                    if name.startswith('.') or os.path.splitext(name)[1].lower() not in formats.EXTENSIONS:
                        continue
                    path = os.path.join(folder, name)
                    if is_link(path):
                        continue
                    try:
                        metadata_error = self.update(path)
                        if metadata_error:
                            errors.append('%s: %s' % (name, metadata_error))
                        count += 1
                        if count % 25 == 0:
                            progress(0, 'Indexed %s models · %s' % (count, name))
                    except OSError as exc:
                        errors.append('%s: %s' % (name, exc))
            # Remove truly missing files, retaining entries inside inaccessible folders.
            with self.connect() as db:
                rows = db.execute('SELECT path FROM models WHERE path LIKE ? ESCAPE "\\"',
                                  (like(root.rstrip(os.sep) + os.sep) + '%',)).fetchall()
                for row in rows:
                    try:
                        os.stat(row['path'])
                    except FileNotFoundError:
                        db.execute('DELETE FROM models WHERE path=?', (row['path'],))
                        db.execute('DELETE FROM previews WHERE path=?', (row['path'],))
                    except OSError:
                        pass
            return {'indexed': count, 'errors': errors[:50], 'errorCount': len(errors)}
        finally:
            self.scan_lock.release()

    def hashes(self, root, progress):
        if not self.scan_lock.acquire(blocking=False):
            raise MetaError('Another library scan or duplicate check is still running.')
        try:
            where, args = self.scope(root, True)
            with self.connect() as db:
                rows = db.execute('SELECT *, (SELECT fingerprint FROM current_geometry g WHERE g.path=models.path) AS shapeHash FROM models WHERE ' + where, args).fetchall()
            by_size = {}
            for row in rows:
                by_size.setdefault(row['size'], []).append(row)
            candidates = [r for group in by_size.values() if len(group) > 1 for r in group]
            errors, hashed = [], 0
            for i, row in enumerate(candidates):
                path = row['path']
                try:
                    st = file_stat(path)
                    if signature(st) != (row['size'], row['mtime_ns'], row['ctime_ns']):
                        self.update(path, force=True)
                        continue
                    cached = row['hash'] and signature(st) == (row['hash_size'], row['hash_mtime'], row['hash_ctime'])
                    if not cached:
                        digest = hashlib.sha256()
                        with open(path, 'rb') as source:
                            while True:
                                chunk = source.read(1 << 20)
                                if not chunk:
                                    break
                                digest.update(chunk)
                                progress(i / max(1, len(candidates)), 'Hashing %s (%d/%d)' % (row['name'], i + 1, len(candidates)))
                            after = file_stat(source.fileno())
                        if signature(st) != signature(after) or signature(st) != signature(file_stat(path)):
                            raise OSError('File changed during hashing; rescan and try again.')
                        with self.connect() as db:
                            db.execute('UPDATE models SET hash=?,hash_size=?,hash_mtime=?,hash_ctime=? WHERE path=? AND size=? AND mtime_ns=? AND ctime_ns=?',
                                       (digest.hexdigest(), *signature(st), path, *signature(st)))
                        hashed += 1
                except OSError as exc:
                    errors.append('%s: %s' % (row['name'], exc))
                    self.forget(path)
                progress((i + 1) / max(1, len(candidates)), 'Checked %d/%d candidates' % (i + 1, len(candidates)))
            result = self.query(root, recursive=True, duplicates=True, limit=1)
            return {'hashed': hashed, 'duplicateFiles': result['total'], 'errors': errors[:50], 'errorCount': len(errors)}
        finally:
            self.scan_lock.release()

    @staticmethod
    def scope(root, recursive):
        if recursive:
            return 'path LIKE ? ESCAPE "\\"', [like(root.rstrip(os.sep) + os.sep) + '%']
        return 'folder=?', [root]

    def query(self, root, recursive=True, search='', ext='', sort='name', descending=False,
              duplicates=False, offset=0, limit=80, tag='', status='', designer='', collection='', geometry=False):
        where, args = self.scope(root, recursive)
        scope, scope_args = where, list(args)
        if collection:
            selected = Organizer(self).collection(collection)
            if selected['kind'] == 'manual':
                where += ' AND path IN (SELECT path FROM collection_members WHERE collection_id=?)'
                args.append(selected['id'])
            else:
                where, args = filter_clause(where, args, **selected['rules'])
        where, args = filter_clause(where, args, search=search, tag=tag, status=status, ext=ext, designer=designer)
        dup = 'SELECT hash FROM models WHERE ' + scope + ' AND hash IS NOT NULL GROUP BY hash HAVING COUNT(*)>1'
        if duplicates:
            where += ' AND hash IN (' + dup + ')'
            args += scope_args
        shape_dup = 'SELECT fingerprint FROM current_geometry WHERE '+scope+' AND fingerprint IS NOT NULL GROUP BY fingerprint HAVING COUNT(*)>1'
        if geometry:
            where += ' AND path IN (SELECT path FROM current_geometry WHERE fingerprint IN ('+shape_dup+'))'
            args += scope_args
        order = SORTS.get(sort, SORTS['name']) + (' DESC' if descending else ' ASC') + ', path ASC'
        with self.connect() as db:
            total = db.execute('SELECT COUNT(*) FROM models WHERE ' + where, args).fetchone()[0]
            library_count = db.execute('SELECT COUNT(*) FROM models WHERE ' + scope, scope_args).fetchone()[0]
            rows = db.execute('SELECT *, (SELECT fingerprint FROM current_geometry g WHERE g.path=models.path) AS shapeHash FROM models WHERE ' + where + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?',
                              [*args, limit, offset]).fetchall()
            groups = dict(db.execute('SELECT hash,COUNT(*) FROM models WHERE ' + scope +
                                     ' AND hash IS NOT NULL GROUP BY hash HAVING COUNT(*)>1', scope_args).fetchall())
            shape_groups = dict(db.execute('SELECT fingerprint,COUNT(*) FROM current_geometry WHERE '+scope+
                                         ' AND fingerprint IS NOT NULL GROUP BY fingerprint HAVING COUNT(*)>1', scope_args).fetchall())
        files = []
        for row in rows:
            item = dict(row)
            item['sizeText'] = human(item['size'])
            item['hasBackup'] = os.path.exists(item['path'] + '.bak')
            item['duplicateCount'] = groups.get(item['hash'], 0)
            item['geometryCount'] = shape_groups.get(item['shapeHash'], 0)
            # Don't send hash bookkeeping or full descriptions for each card.
            for key in ('hash_size', 'hash_mtime', 'hash_ctime', 'mtime_ns', 'ctime_ns', 'description'):
                item.pop(key, None)
            files.append(item)
        return {'files': self.decorate(files), 'total': total, 'indexed': library_count, 'offset': offset,
                'limit': limit, 'duplicateGroups': len(groups), 'geometryGroups': len(shape_groups)}
