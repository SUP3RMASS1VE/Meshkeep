"""Multipart projects: references to models and build-specific progress."""
import os
from formats.base import MetaError
from organizer import text
from library import under


def install(db):
    db.executescript('''
      CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY, root TEXT NOT NULL, name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS project_parts(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 1, completed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', notes TEXT NOT NULL DEFAULT '', UNIQUE(project_id,path));
      CREATE INDEX IF NOT EXISTS project_parts_project ON project_parts(project_id);
    ''')


class ProjectApi:
    def project(self, q):
        with self.library.connect() as db:
            row = db.execute('SELECT * FROM projects WHERE id=?', (q.get('id', [''])[0],)).fetchone()
            if not row:
                raise MetaError('Project no longer exists.')
            item = dict(row)
            self.resolve(item['root'], must_exist=False)
            item['parts'] = [dict(r) for r in db.execute('SELECT * FROM project_parts WHERE project_id=? ORDER BY id', (item['id'],))]
        for part in item['parts']:
            try:
                self.resolve(part['path'])
                part['missing'] = not os.path.isfile(part['path'])
            except MetaError:
                part['missing'] = True
        item['required'] = sum(p['required'] for p in item['parts'])
        item['completed'] = sum(p['completed'] for p in item['parts'])
        return item

    def project_action(self, body):
        action = body.get('action', 'create')
        if action == 'create':
            root = self.resolve(body.get('root'))
            if not os.path.isdir(root):
                raise MetaError('Choose a folder for this project.')
            name = text(body.get('name'), 100)
            if not name:
                raise MetaError('Give the project a name.')
            paths = self.selected_paths(body) if body.get('paths') else []
            if any(not under(p, root) for p in paths):
                raise MetaError('Select models inside the project folder.')
            with self.library.connect() as db:
                project_id = db.execute('INSERT INTO projects(root,name) VALUES (?,?)', (root, name)).lastrowid
                db.executemany('INSERT INTO project_parts(project_id,path,name) VALUES (?,?,?)', ((project_id,p,os.path.basename(p)) for p in paths))
            return self.project({'id': [project_id]})
        item = self.project({'id': [body.get('id')]})
        with self.library.connect() as db:
            if action == 'delete':
                db.execute('DELETE FROM project_parts WHERE project_id=?', (item['id'],))
                db.execute('DELETE FROM projects WHERE id=?', (item['id'],))
                return {'ok': True}
            elif action == 'update':
                name = text(body.get('name'), 100)
                if not name:
                    raise MetaError('Give the project a name.')
                db.execute('UPDATE projects SET name=?,notes=? WHERE id=?', (name,text(body.get('notes','')),item['id']))
            elif action == 'add':
                paths = self.selected_paths(body)
                if any(not under(p, item['root']) for p in paths):
                    raise MetaError('Select models inside the project folder.')
                db.executemany('INSERT OR IGNORE INTO project_parts(project_id,path,name) VALUES (?,?,?)', ((item['id'],p,os.path.basename(p)) for p in paths))
            elif action in ('part', 'remove'):
                part_id = body.get('part_id')
                if not any(p['id'] == part_id for p in item['parts']):
                    raise MetaError('Part no longer exists in this project.')
                if action == 'remove':
                    db.execute('DELETE FROM project_parts WHERE id=? AND project_id=?', (part_id,item['id']))
                else:
                    required, completed = body.get('required'), body.get('completed')
                    if type(required) is not int or type(completed) is not int or not 1 <= required <= 10000 or not 0 <= completed <= required:
                        raise MetaError('Use quantities from 1 to 10,000; printed cannot exceed required.')
                    status = body.get('status')
                    if status not in ('pending','printing','retry','printed','assembled'):
                        raise MetaError('Unknown part status.')
                    if status in ('printed','assembled') and completed != required:
                        raise MetaError('All required copies must be printed for this status.')
                    name = text(body.get('name'), 200)
                    if not name:
                        raise MetaError('Give the part a name.')
                    db.execute('UPDATE project_parts SET name=?,required=?,completed=?,status=?,notes=? WHERE id=? AND project_id=?', (name,required,completed,status,text(body.get('notes','')),part_id,item['id']))
            else:
                raise MetaError('Unknown project action.')
        return self.project({'id': [item['id']]})
