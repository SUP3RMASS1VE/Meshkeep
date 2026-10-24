"""Project persistence, progress, validation and scope boundaries."""
import os
from pathlib import Path
import unittest
import test_workspace
from formats.base import MetaError
import app


class ProjectTests(unittest.TestCase):
    setUp = test_workspace.WorkspaceTests.setUp
    tearDown = test_workspace.WorkspaceTests.tearDown
    def create(self, **values):
        return self.api.project_action({'root':self.models,'name':'Robot','paths':[self.path,self.other],**values})

    def update_part(self, project, **values):
        return self.api.project_action({'action':'part','id':project['id'],'part_id':project['parts'][0]['id'],'name':'Left leg','required':4,'completed':2,'status':'printing','notes':'PLA',**values})

    def test_quantities_persist_without_changing_model_or_global_status(self):
        original=Path(self.path).read_bytes()
        project=self.create()
        result=self.update_part(project)
        self.assertEqual((result['required'],result['completed']),(5,2))
        self.assertEqual(self.api.organizer.detail(self.path)['status'],'unprinted')
        fresh=app.Api(self.models,os.path.join(self.root,'library.sqlite3'))
        self.assertEqual(fresh.project({'id':[project['id']]})['parts'][0]['notes'],'PLA')
        summary=fresh.workspace({})['projects'][0]
        self.assertEqual((summary['required'],summary['completed']),(5,2))
        self.assertEqual(Path(self.path).read_bytes(),original)
        second=self.create(name='Another build')
        self.assertEqual(second['completed'],0)

    def test_validation_and_part_ownership(self):
        project=self.create()
        for values in ({'required':0},{'completed':5},{'required':True},{'completed':-1},{'status':'assembled'},{'status':'unknown'},{'name':''},{'part_id':99999}):
            with self.subTest(values=values),self.assertRaises(MetaError):
                self.update_part(project,**values)
        self.assertEqual(self.api.project({'id':[project['id']]})['completed'],0)
        self.assertEqual(self.update_part(project,completed=4,status='assembled')['completed'],4)

    def test_missing_renamed_and_duplicate_parts(self):
        project=self.create()
        target=self.api.rename({'path':self.path,'name':'new.stl'})['path']
        self.assertEqual(self.api.project({'id':[project['id']]})['parts'][0]['path'],target)
        result=self.api.project_action({'action':'add','id':project['id'],'paths':[target]})
        self.assertEqual(len(result['parts']),2)
        os.unlink(target)
        result=self.api.project({'id':[project['id']]})
        self.assertTrue(result['parts'][0]['missing'])
        self.update_part(result)
        self.api.project_action({'action':'remove','id':project['id'],'part_id':result['parts'][0]['id']})
        self.assertEqual(self.api.project({'id':[project['id']]})['required'],1)
        self.api.project_action({'action':'delete','id':project['id']})
        self.assertTrue(os.path.isfile(self.other))
        with self.lib.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM project_parts').fetchone()[0],0)

    def test_scope_enforced_and_creation_atomic(self):
        nested=os.path.join(self.models,'nested');os.mkdir(nested)
        with self.assertRaises(MetaError):self.create(root=nested)
        self.assertEqual(self.api.workspace({})['projects'],[])
        project=self.create(root=nested,paths=[])
        with self.assertRaises(MetaError):self.api.project_action({'id':project['id'],'action':'add','paths':[self.path]})
        restricted=app.Api(nested,os.path.join(self.root,'library.sqlite3'))
        outer=self.create()
        self.assertEqual(len(restricted.workspace({})['projects']),1)
        with self.assertRaises(MetaError):restricted.project({'id':[outer['id']]})
        with self.assertRaises(MetaError):restricted.project_action({'id':outer['id'],'action':'delete'})
