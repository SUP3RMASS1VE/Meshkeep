"""Authenticated API actions for the library workspace."""
import os
from file_state import file_stat

import formats
from formats.base import MetaError
from library import like, signature, under
from organizer import Organizer, text


class WorkspaceApi:
    def selected_paths(self, body):
        paths = body.get('paths', [body.get('path')])
        if not isinstance(paths, list) or not 0 < len(paths) <= 500:
            raise MetaError('Select between 1 and 500 models.')
        result = []
        for raw in paths:
            if not isinstance(raw, str):
                raise MetaError('Choose a model file.')
            path = self.resolve(raw)
            if not os.path.isfile(path) or os.path.splitext(path)[1].lower() not in formats.EXTENSIONS:
                raise MetaError('Choose a supported model file.')
            result.append(path)
        return list(dict.fromkeys(result))

    def workspace(self, q):
        with self.library.connect() as db:
            collections = [dict(r) for r in db.execute('SELECT id,name,root,kind FROM collections ORDER BY name COLLATE NOCASE') if under(r['root'], self.root)]
            watches = [dict(r) for r in db.execute('SELECT * FROM watched_folders ORDER BY path') if under(r['path'], self.root)]
            tags = [dict(r) for r in db.execute('SELECT tag,COUNT(*) AS count FROM tags WHERE path LIKE ? ESCAPE "\\" GROUP BY tag ORDER BY tag', (like(self.root.rstrip(os.sep))+'/%',))]
        return {'collections': collections, 'watches': watches, 'tags': tags}

    def organization(self, q):
        path = self.resolve(q.get('path', [''])[0])
        result = self.organizer.detail(path)
        if result['analysis'] and [result['analysis'][k] for k in ('size','mtime','ctime')] != [str(n) for n in signature(file_stat(path))]:
            result['analysis'] = None
        return result

    def annotate(self, body):
        paths = self.selected_paths(body)
        for path in paths:
            self.library.update(path)
        return self.organizer.annotate(paths, body)

    def collection_action(self, body):
        action = body.get('action', 'create')
        if action == 'create':
            root = self.resolve(body.get('root'))
            if not os.path.isdir(root):
                raise MetaError('Choose a folder for this collection.')
            return self.organizer.save_collection(root, body)
        item = self.organizer.collection(body.get('id'))
        self.resolve(item['root'], must_exist=action != 'delete')
        if action == 'delete':
            return self.organizer.delete_collection(item['id'])
        if action in ('add', 'remove'):
            paths = self.selected_paths(body)
            for path in paths:
                if not under(path, item['root']):
                    raise MetaError('This collection is scoped to '+item['root'])
                self.library.update(path)
            return self.organizer.memberships(item['id'], paths, action == 'remove')
        raise MetaError('Unknown collection action.')

    def print_action(self, body):
        if body.get('action') == 'delete':
            with self.library.connect() as db:
                row = db.execute('SELECT path FROM prints WHERE id=?', (body.get('id'),)).fetchone()
            if not row:
                raise MetaError('Print record no longer exists.')
            self.resolve(row['path'], must_exist=False)
            return self.organizer.delete_print(body['id'])
        path = self.selected_paths(body)[0]
        photos = body.get('photos', [])
        if not isinstance(photos, list) or len(photos) > 3:
            raise MetaError('Attach up to three photos per print record.')
        # UI converts images to bounded PNGs before upload.
        images = [self.decode_photo(photo, 'print photo', 1600) for photo in photos]
        self.library.update(path)
        return self.organizer.add_print(path, body, images)

    def print_photo(self, q):
        with self.library.connect() as db:
            row = db.execute('SELECT p.path,f.png FROM print_photos f JOIN prints p ON p.id=f.print_id WHERE f.id=?', (q.get('id', [''])[0],)).fetchone()
        if not row:
            raise MetaError('Photo no longer exists.')
        self.resolve(row['path'], must_exist=False)
        return 'image/png', bytes(row['png'])

    def watch_action(self, body):
        path = self.resolve(body.get('path'), must_exist=not body.get('remove'))
        if not body.get('remove') and not os.path.isdir(path):
            raise MetaError('Choose a folder to watch.')
        with self.library.connect() as db:
            if body.get('remove'):
                db.execute('DELETE FROM watched_folders WHERE path=?', (path,))
            else:
                db.execute('INSERT INTO watched_folders(path,enabled) VALUES (?,?) ON CONFLICT(path) DO UPDATE SET enabled=excluded.enabled', (path, int(bool(body.get('enabled', True)))))
        return {'ok': True}

    def geometry_candidates(self, q):
        path = self.resolve(q.get('path', [''])[0])
        after = q.get('after', [''])[0]
        scope, args = self.library.scope(path, True)
        missing = ' AND NOT EXISTS(SELECT 1 FROM current_geometry g WHERE g.path=models.path AND g.fingerprint IS NOT NULL)'
        with self.library.connect() as db:
            rows = [dict(r) for r in db.execute('SELECT path,name,size FROM models WHERE '+scope+missing+' AND path>? ORDER BY path LIMIT 20', [*args, after])]
            total = db.execute('SELECT COUNT(*) FROM models WHERE '+scope+missing, args).fetchone()[0]
        return {'files': rows, 'remaining': total}

    def geometry_save(self, body):
        path = self.selected_paths(body)[0]
        stamp = body.get('stamp')
        if stamp != [str(n) for n in signature(file_stat(path))]:
            raise MetaError('The model changed during analysis. Try again.')
        self.library.update(path)
        return self.organizer.save_geometry(path, body, stamp)
