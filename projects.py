"""Multipart projects: references to models and build-specific progress."""
import math
import os
from formats.base import MetaError
from organizer import text
from library import under


def install(db):
    db.executescript('''
      CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY, root TEXT NOT NULL, name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS project_parts(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 1, completed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', notes TEXT NOT NULL DEFAULT '', UNIQUE(project_id,path));
      CREATE INDEX IF NOT EXISTS project_parts_project ON project_parts(project_id);
      CREATE TABLE IF NOT EXISTS project_layout(
        part_id INTEGER NOT NULL, copy_index INTEGER NOT NULL,
        x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
        rx REAL NOT NULL, ry REAL NOT NULL, rz REAL NOT NULL,
        PRIMARY KEY(part_id,copy_index)
      );
    ''')


def layout_values(layout, parts):
    """Validate a complete save before writing any placements.

    Positions are millimetres in the model's Z-up coordinates; rotations are
    XYZ Euler angles in degrees. A save only replaces the submitted copies.
    """
    if not isinstance(layout, list) or len(layout) > 200:
        raise MetaError('Save up to 200 assembly placements at a time.')
    quantities = {part['id']: part['required'] for part in parts}
    seen, values = set(), []
    for placement in layout:
        if not isinstance(placement, dict):
            raise MetaError('Each assembly placement must identify a part and copy.')
        part_id, copy_index = placement.get('part_id'), placement.get('copy_index')
        if type(part_id) is not int or part_id not in quantities:
            raise MetaError('Part no longer exists in this project.')
        if type(copy_index) is not int or not 0 <= copy_index < quantities[part_id]:
            raise MetaError('Assembly copy is outside the required quantity.')
        key = part_id, copy_index
        if key in seen:
            raise MetaError('An assembly copy can only appear once per save.')
        seen.add(key)
        vectors = []
        for field, limit in (('position', 1000000), ('rotation', 360)):
            vector = placement.get(field)
            if (not isinstance(vector, list) or len(vector) != 3 or
                    not all(type(n) in (int, float) and -limit <= n <= limit and math.isfinite(n) for n in vector)):
                raise MetaError('Assembly %s must contain three finite numbers between -%s and %s.' % (field, limit, limit))
            vectors.extend(vector)
        values.append((*key, *vectors))
    return values


class ProjectApi:
    def project(self, q):
        with self.library.connect() as db:
            row = db.execute('SELECT * FROM projects WHERE id=?', (q.get('id', [''])[0],)).fetchone()
            if not row:
                raise MetaError('Project no longer exists.')
            item = dict(row)
            self.resolve(item['root'], must_exist=False)
            item['parts'] = [dict(r) for r in db.execute('SELECT * FROM project_parts WHERE project_id=? ORDER BY id', (item['id'],))]
            item['layout'] = [
                {'part_id': r['part_id'], 'copy_index': r['copy_index'],
                 'position': [r['x'], r['y'], r['z']], 'rotation': [r['rx'], r['ry'], r['rz']]}
                for r in db.execute('''SELECT l.* FROM project_layout l
                    JOIN project_parts p ON p.id=l.part_id WHERE p.project_id=?
                    ORDER BY l.part_id,l.copy_index''', (item['id'],))
            ]
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
                db.execute('DELETE FROM project_layout WHERE part_id IN (SELECT id FROM project_parts WHERE project_id=?)', (item['id'],))
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
            elif action == 'layout':
                # Keep ownership/quantity validation and the write in one
                # transaction, including concurrent part removals or edits.
                db.execute('BEGIN IMMEDIATE')
                if not db.execute('SELECT id FROM projects WHERE id=?', (item['id'],)).fetchone():
                    raise MetaError('Project no longer exists.')
                parts = db.execute('SELECT id,required FROM project_parts WHERE project_id=?', (item['id'],)).fetchall()
                values = layout_values(body.get('layout'), parts)
                db.executemany('''INSERT INTO project_layout(part_id,copy_index,x,y,z,rx,ry,rz)
                    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(part_id,copy_index) DO UPDATE SET
                    x=excluded.x,y=excluded.y,z=excluded.z,
                    rx=excluded.rx,ry=excluded.ry,rz=excluded.rz''', values)
            elif action in ('part', 'remove'):
                part_id = body.get('part_id')
                if not any(p['id'] == part_id for p in item['parts']):
                    raise MetaError('Part no longer exists in this project.')
                if action == 'remove':
                    db.execute('DELETE FROM project_layout WHERE part_id=?', (part_id,))
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
                    db.execute('DELETE FROM project_layout WHERE part_id=? AND copy_index>=?', (part_id,required))
            else:
                raise MetaError('Unknown project action.')
        return self.project({'id': [item['id']]})
