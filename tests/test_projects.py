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

    def placement(self, project, part=0, **values):
        return {'part_id':project['parts'][part]['id'],'copy_index':0,
                'position':[12.5,-3,20],'rotation':[0,90,-45],**values}

    def save_layout(self, project, layout):
        return self.api.project_action({'action':'layout','id':project['id'],'layout':layout})

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
        with self.assertRaises(MetaError):restricted.project_action({'id':outer['id'],'action':'layout','layout':[self.placement(outer)]})

    def test_layout_persists_per_copy_and_preserves_unsubmitted_placements(self):
        original = Path(self.path).read_bytes()
        project = self.update_part(self.create())
        layout = [self.placement(project), self.placement(project, copy_index=1, position=[0,0,0]),
                  self.placement(project, part=1)]
        saved = self.save_layout(project, layout)
        self.assertEqual(saved['layout'], layout)
        # Partial saves retain both other copies and unavailable models.
        os.unlink(self.other)
        moved = self.placement(project, position=[-1000000,0,1000000], rotation=[-360,0,360])
        saved = self.save_layout(project, [moved])
        self.assertEqual(saved['layout'], [moved,*layout[1:]])
        self.assertTrue(saved['parts'][1]['missing'])
        self.assertEqual(self.save_layout(project, [])['layout'], saved['layout'])
        fresh = app.Api(self.models,os.path.join(self.root,'library.sqlite3'))
        reloaded = fresh.project({'id':[project['id']]})
        self.assertEqual(reloaded['layout'], saved['layout'])
        self.assertEqual(reloaded['completed'], 2)
        self.assertEqual(Path(self.path).read_bytes(), original)
        self.assertEqual(self.api.organizer.detail(self.path)['status'],'unprinted')
        self.assertEqual(self.create(name='Other assembly',paths=[self.path])['layout'], [])

    def test_layout_validation_is_atomic_and_checks_copy_ownership(self):
        project = self.update_part(self.create())
        other_project = self.create(name='Other assembly')
        original = self.placement(project)
        self.save_layout(project,[original])
        valid_change = self.placement(project, position=[99,0,0])
        invalid = [
            {'part_id':other_project['parts'][0]['id']}, {'part_id':True}, {'part_id':1.0},
            {'part_id':[]}, {'part_id':999999}, {'copy_index':-1}, {'copy_index':4},
            {'copy_index':True}, {'copy_index':0.0}, {'position':None}, {'position':[]},
            {'position':[0,0]}, {'position':[0,0,0,0]}, {'position':['0',0,0]},
            {'position':[True,0,0]}, {'position':[float('nan'),0,0]},
            {'position':[float('inf'),0,0]}, {'position':[1000001,0,0]},
            {'position':[-1000001,0,0]}, {'position':[10**1000,0,0]},
            {'rotation':[0,float('-inf'),0]}, {'rotation':[0,float('nan'),0]},
            {'rotation':[0,361,0]}, {'rotation':[0,-361,0]}, {'rotation':[False,0,0]},
            {'rotation':None}, {'rotation':[0,0]},
        ]
        for values in invalid:
            # Use another copy so it is the malformed field, not a duplicate
            # placement, that rejects the entire request.
            bad = self.placement(project,copy_index=1,**{k:v for k,v in values.items() if k != 'copy_index'})
            if 'copy_index' in values: bad['copy_index'] = values['copy_index']
            with self.subTest(values=values), self.assertRaises(MetaError):
                self.save_layout(project,[valid_change,bad])
            self.assertEqual(self.api.project({'id':[project['id']]})['layout'], [original])
        for layout in (None, {}, 'invalid', [None], [42], [original,original], [original]*201):
            with self.subTest(layout=layout), self.assertRaises(MetaError):
                self.save_layout(project,layout)
        self.assertEqual(self.api.project({'id':[project['id']]})['layout'], [original])

    def test_layout_batch_limit_and_cleanup_on_quantity_remove_and_delete(self):
        project = self.update_part(self.create(),required=201,completed=0,status='pending')
        layout = [self.placement(project,copy_index=i) for i in range(200)]
        self.assertEqual(len(self.save_layout(project,layout)['layout']),200)
        saved = self.save_layout(project,[self.placement(project,copy_index=200),self.placement(project,part=1)])
        self.assertEqual(len(saved['layout']),202)
        reduced = self.update_part(project,required=2,completed=0,status='pending')
        self.assertEqual([(p['part_id'],p['copy_index']) for p in reduced['layout']],
                         [(project['parts'][0]['id'],0),(project['parts'][0]['id'],1),(project['parts'][1]['id'],0)])
        # Raising the quantity again must not resurrect removed placements.
        raised = self.update_part(project,required=3,completed=0,status='pending')
        self.assertEqual(raised['layout'],reduced['layout'])
        removed = self.api.project_action({'action':'remove','id':project['id'],'part_id':project['parts'][0]['id']})
        self.assertEqual(removed['layout'],[self.placement(project,part=1)])
        with self.lib.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM project_layout').fetchone()[0],1)
        self.api.project_action({'action':'delete','id':project['id']})
        with self.lib.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM project_layout').fetchone()[0],0)
        self.assertTrue(os.path.isfile(self.path))
        self.assertTrue(os.path.isfile(self.other))

    def test_layout_follows_part_id_through_rename(self):
        project = self.create()
        layout = [self.placement(project)]
        self.save_layout(project,layout)
        target = self.api.rename({'path':self.path,'name':'renamed assembly part.stl'})['path']
        renamed = self.api.project({'id':[project['id']]})
        self.assertEqual(renamed['parts'][0]['path'],target)
        self.assertEqual(renamed['layout'],layout)

    def test_existing_project_database_gains_layout_storage_idempotently(self):
        from projects import install
        project = self.update_part(self.create())
        # Simulate the schema shipped before Assembly Studio.
        with self.lib.connect() as db:
            db.execute('DROP TABLE project_layout')
        fresh = app.Api(self.models,os.path.join(self.root,'library.sqlite3'))
        restored = fresh.project({'id':[project['id']]})
        self.assertEqual(restored['parts'],project['parts'])
        self.assertEqual(restored['layout'],[])
        layout = [self.placement(project)]
        fresh.project_action({'action':'layout','id':project['id'],'layout':layout})
        with fresh.library.connect() as db:
            install(db)
            install(db)
        self.assertEqual(fresh.project({'id':[project['id']]})['layout'],layout)
