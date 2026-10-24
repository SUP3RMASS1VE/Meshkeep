"""Local organisation, print journal and geometry analysis storage."""
import json
import math
import re
import time
import uuid

from formats.base import MetaError

STATUSES = {'unprinted', 'want', 'printed', 'retry'}


def text(value, limit=10000):
    if not isinstance(value, str) or len(value) > limit:
        raise MetaError('Invalid text or text is too long.')
    return value.strip()


def install(db):
    db.executescript('''
      CREATE TABLE IF NOT EXISTS annotations(path TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'unprinted', notes TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS tags(path TEXT NOT NULL, tag TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY(path,tag));
      CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
      CREATE TABLE IF NOT EXISTS collections(id INTEGER PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL, kind TEXT NOT NULL, rules TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS collection_members(collection_id INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY(collection_id,path));
      CREATE TABLE IF NOT EXISTS prints(id TEXT PRIMARY KEY, path TEXT NOT NULL, created REAL NOT NULL, outcome TEXT NOT NULL, printer TEXT NOT NULL, material TEXT NOT NULL, settings TEXT NOT NULL, notes TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS prints_path ON prints(path);
      CREATE TABLE IF NOT EXISTS print_photos(id TEXT PRIMARY KEY, print_id TEXT NOT NULL, png BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS watched_folders(path TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, checked REAL, error TEXT, indexed INTEGER NOT NULL DEFAULT 0, changed REAL);
      CREATE TABLE IF NOT EXISTS geometry(path TEXT PRIMARY KEY, size TEXT, mtime TEXT, ctime TEXT, fingerprint TEXT, triangles INTEGER NOT NULL, dimensions TEXT NOT NULL, volume REAL, closed INTEGER NOT NULL, updated REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS geometry_fingerprint ON geometry(fingerprint);
      DROP VIEW IF EXISTS current_geometry;
      CREATE VIEW current_geometry AS SELECT g.*,m.folder FROM geometry g JOIN models m ON m.path=g.path
        AND g.size=CAST(m.size AS TEXT) AND g.mtime=CAST(m.mtime_ns AS TEXT) AND g.ctime=CAST(m.ctime_ns AS TEXT);
    ''')
    from projects import install as install_projects
    install_projects(db)
    if 'changed' not in {row[1] for row in db.execute('PRAGMA table_info(watched_folders)')}:
        db.execute('ALTER TABLE watched_folders ADD COLUMN changed REAL')


class Organizer:
    def __init__(self, library):
        self.library = library

    def detail(self, path):
        with self.library.connect() as db:
            row = db.execute('SELECT status,notes FROM annotations WHERE path=?', (path,)).fetchone()
            tags = [r[0] for r in db.execute('SELECT tag FROM tags WHERE path=? ORDER BY tag', (path,))]
            prints = [dict(r) for r in db.execute('SELECT * FROM prints WHERE path=? ORDER BY created DESC', (path,))]
            for entry in prints:
                entry['photos'] = [r[0] for r in db.execute('SELECT id FROM print_photos WHERE print_id=?', (entry['id'],))]
            geometry = db.execute('SELECT * FROM geometry WHERE path=?', (path,)).fetchone()
        analysis = dict(geometry) if geometry else None
        if analysis:
            analysis['dimensions'] = json.loads(analysis['dimensions'])
        return {'status': row['status'] if row else 'unprinted', 'notes': row['notes'] if row else '',
                'tags': tags, 'prints': prints, 'analysis': analysis}

    def annotate(self, paths, body):
        status = body.get('status')
        if status is not None and status not in STATUSES:
            raise MetaError('Unknown print status.')
        tags = body.get('tags')
        if tags is not None:
            if not isinstance(tags, list) or len(tags) > 100:
                raise MetaError('Use at most 100 tags.')
            tags = sorted({text(tag, 80).casefold() for tag in tags if text(tag, 80)})
        notes = text(body['notes']) if 'notes' in body else None
        with self.library.connect() as db:
            for path in paths:
                db.execute('INSERT OR IGNORE INTO annotations(path) VALUES (?)', (path,))
                if status is not None:
                    db.execute('UPDATE annotations SET status=? WHERE path=?', (status, path))
                if notes is not None:
                    db.execute('UPDATE annotations SET notes=? WHERE path=?', (notes, path))
                if tags is not None:
                    if not body.get('addTags'):
                        db.execute('DELETE FROM tags WHERE path=?', (path,))
                    db.executemany('INSERT OR IGNORE INTO tags VALUES (?,?)', ((path, tag) for tag in tags))
        return {'updated': len(paths)}

    def save_collection(self, root, body):
        name = text(body.get('name'), 100)
        if not name:
            raise MetaError('Give the collection a name.')
        kind = body.get('kind', 'manual')
        if kind not in ('manual', 'smart'):
            raise MetaError('Choose a manual or smart collection.')
        rules = body.get('rules', {})
        if not isinstance(rules, dict) or set(rules) - {'search', 'tag', 'status', 'designer', 'ext'}:
            raise MetaError('Unknown smart collection rule.')
        rules = {key: text(value, 300) for key, value in rules.items() if value}
        if rules.get('status') and rules['status'] not in STATUSES:
            raise MetaError('Unknown print status rule.')
        with self.library.connect() as db:
            result = db.execute('INSERT INTO collections(name,root,kind,rules) VALUES (?,?,?,?)', (name, root, kind, json.dumps(rules)))
            return {'id': result.lastrowid, 'name': name, 'root': root, 'kind': kind, 'rules': rules}

    def collection(self, collection_id):
        with self.library.connect() as db:
            row = db.execute('SELECT * FROM collections WHERE id=?', (collection_id,)).fetchone()
        if not row:
            raise MetaError('Collection no longer exists.')
        item = dict(row)
        item['rules'] = json.loads(item['rules'])
        return item

    def memberships(self, collection_id, paths, remove=False):
        if self.collection(collection_id)['kind'] != 'manual':
            raise MetaError('Smart collections manage their membership automatically.')
        with self.library.connect() as db:
            if remove:
                db.executemany('DELETE FROM collection_members WHERE collection_id=? AND path=?', ((collection_id, path) for path in paths))
            else:
                db.executemany('INSERT OR IGNORE INTO collection_members VALUES (?,?)', ((collection_id, path) for path in paths))
        return {'updated': len(paths)}

    def delete_collection(self, collection_id):
        with self.library.connect() as db:
            db.execute('DELETE FROM collection_members WHERE collection_id=?', (collection_id,))
            db.execute('DELETE FROM collections WHERE id=?', (collection_id,))
        return {'ok': True}

    def add_print(self, path, body, photos):
        outcome = body.get('outcome', 'printed')
        if outcome not in {'printed', 'retry'}:
            raise MetaError('Choose Printed or Needs another attempt.')
        fields = [text(body.get(key, ''), 10000 if key in ('notes', 'settings') else 200) for key in ('printer', 'material', 'settings', 'notes')]
        entry_id = uuid.uuid4().hex
        with self.library.connect() as db:
            db.execute('INSERT INTO prints VALUES (?,?,?,?,?,?,?,?)', (entry_id, path, time.time(), outcome, *fields))
            for png in photos:
                db.execute('INSERT INTO print_photos VALUES (?,?,?)', (uuid.uuid4().hex, entry_id, png))
            db.execute('INSERT INTO annotations(path,status) VALUES (?,?) ON CONFLICT(path) DO UPDATE SET status=excluded.status', (path, outcome))
        return {'id': entry_id}

    def delete_print(self, entry_id):
        with self.library.connect() as db:
            db.execute('DELETE FROM print_photos WHERE print_id=?', (entry_id,))
            db.execute('DELETE FROM prints WHERE id=?', (entry_id,))
        return {'ok': True}

    def save_geometry(self, path, body, stamp):
        fingerprint = body.get('fingerprint')
        if fingerprint is not None and (not isinstance(fingerprint, str) or not re.fullmatch(r'[0-9a-f]{64}', fingerprint)):
            raise MetaError('Invalid geometry fingerprint.')
        triangles, dimensions, volume = body.get('triangles'), body.get('dimensions'), body.get('volume')
        if not isinstance(triangles, int) or isinstance(triangles, bool) or not 0 < triangles <= 5000000:
            raise MetaError('Invalid triangle count.')
        if not isinstance(dimensions, list) or len(dimensions) != 3 or not all(isinstance(n, (float, int)) and math.isfinite(n) and 0 <= n < 1e12 for n in dimensions):
            raise MetaError('Invalid model dimensions.')
        if volume is not None and (not isinstance(volume, (float, int)) or not math.isfinite(volume) or volume < 0):
            raise MetaError('Invalid model volume.')
        with self.library.connect() as db:
            if fingerprint is None:
                old = db.execute('SELECT fingerprint,size,mtime,ctime FROM geometry WHERE path=?', (path,)).fetchone()
                if old and [old[key] for key in ('size','mtime','ctime')] == stamp:
                    fingerprint = old['fingerprint']
            db.execute('INSERT OR REPLACE INTO geometry VALUES (?,?,?,?,?,?,?,?,?,?)', (path, *stamp, fingerprint, triangles, json.dumps(dimensions), volume, int(bool(body.get('closed'))), time.time()))
        return {'ok': True}

    def move(self, old, new):
        with self.library.connect() as db:
            for table in ('annotations', 'tags', 'collection_members', 'prints', 'project_parts'):
                db.execute('UPDATE OR REPLACE '+table+' SET path=? WHERE path=?', (new, old))
            db.execute('DELETE FROM geometry WHERE path=?', (old,))
