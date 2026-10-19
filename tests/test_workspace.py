import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import helpers
from helpers import make_stl, make_png
import app
from file_state import file_stat
from library import signature
from watcher import FolderWatcher
from formats.base import MetaError


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=os.path.realpath(self.temp.name)
        self.models=os.path.join(self.root,'models');os.mkdir(self.models)
        self.path=make_stl(os.path.join(self.models,'a.stl'))
        self.other=make_stl(os.path.join(self.models,'b.stl'))
        self.api=app.Api(self.models,os.path.join(self.root,'library.sqlite3'))
        self.lib=self.api.library
        self.lib.scan(self.models,lambda *a:None)

    def tearDown(self):
        self.temp.cleanup()

    def test_annotations_manual_and_smart_collections(self):
        original=Path(self.path).read_bytes()
        self.api.annotate({'path':self.path,'tags':['Miniatures','terrain'],'status':'want','notes':'Use supports'})
        item=self.api.collection_action({'root':self.models,'name':'Project','kind':'manual'})
        self.api.collection_action({'id':item['id'],'action':'add','paths':[self.path]})
        self.assertEqual(self.lib.query(self.models,collection=item['id'])['total'],1)
        smart=self.api.collection_action({'root':self.models,'name':'Unprinted minis','kind':'smart','rules':{'tag':'miniatures','status':'want'}})
        self.assertEqual(self.lib.query(self.models,collection=smart['id'])['total'],1)
        self.assertEqual(self.lib.query(self.models,collection=smart['id'],search='no match')['total'],0)
        self.api.annotate({'path':self.path,'status':'printed'})
        self.assertEqual(self.lib.query(self.models,collection=smart['id'])['total'],0)
        self.assertEqual(self.lib.query(self.models,tag='MINIATURES')['total'],1)
        self.api.annotate({'paths':[self.path,self.other],'tags':['weekend'],'addTags':True})
        self.assertEqual(self.lib.query(self.models,tag='weekend')['total'],2)
        self.assertEqual(Path(self.path).read_bytes(),original)
        self.api.collection_action({'id':item['id'],'action':'remove','paths':[self.path]})
        self.assertEqual(self.lib.query(self.models,collection=item['id'])['total'],0)
        self.assertTrue(os.path.isfile(self.path))

    def test_prints_photos_and_rename_preserve_organisation(self):
        self.api.annotate({'path':self.path,'tags':['mini'],'notes':'Keep me'})
        record=self.api.organizer.add_print(self.path,{'outcome':'retry','printer':'Printer','material':'PLA','settings':'0.2 mm','notes':'More supports'},[make_png(10,10)])
        data=self.api.organizer.detail(self.path)
        self.assertEqual(data['status'],'retry')
        photo=data['prints'][0]['photos'][0]
        self.assertEqual(self.api.print_photo({'id':[photo]})[1],make_png(10,10))
        target=self.api.rename({'path':self.path,'name':'renamed.stl'})['path']
        moved=self.api.organizer.detail(target)
        self.assertEqual(moved['tags'],['mini']);self.assertEqual(moved['notes'],'Keep me')
        self.assertEqual(moved['prints'][0]['id'],record['id'])
        self.api.print_action({'action':'delete','id':record['id']})
        self.assertEqual(self.api.organizer.detail(target)['prints'],[])
        with self.assertRaises(MetaError):self.api.print_photo({'id':[photo]})

    def test_watch_indexes_new_changed_deleted_files(self):
        self.api.watch_action({'path':self.models})
        watcher=FolderWatcher(self.lib,self.models)
        watcher.tick()
        changed=self.api.workspace({})['watches'][0]['changed']
        watcher.tick()
        self.assertEqual(self.api.workspace({})['watches'][0]['changed'],changed)
        added=make_stl(os.path.join(self.models,'new.stl'));watcher.tick()
        self.assertEqual(self.lib.query(self.models)['total'],3)
        with open(added,'a') as f:f.write('\n')
        watcher.tick()
        self.assertEqual(self.lib.query(self.models,search='new')['files'][0]['size'],os.stat(added).st_size)
        os.unlink(added);watcher.tick()
        self.assertEqual(self.lib.query(self.models)['total'],2)
        self.api.watch_action({'path':self.models,'enabled':False})
        make_stl(os.path.join(self.models,'paused.stl'));watcher.tick()
        self.assertEqual(self.lib.query(self.models)['total'],2)
        self.api.watch_action({'path':self.models,'remove':True})
        self.assertEqual(self.api.workspace({})['watches'],[])

    def test_watch_missing_folder_retries_without_losing_notes(self):
        self.api.watch_action({'path':self.models})
        watcher=FolderWatcher(self.lib,self.models);watcher.tick()
        moved=self.models+'-away';os.rename(self.models,moved)
        watcher.tick();self.assertIn('unavailable',self.api.workspace({})['watches'][0]['error'])
        os.rename(moved,self.models);watcher.tick()
        self.assertIsNone(self.api.workspace({})['watches'][0]['error'])

    def test_geometry_cache_validity_and_groups(self):
        body={'fingerprint':'a'*64,'triangles':1,'dimensions':[1,1,0],'volume':0,'closed':False}
        for path in [self.path,self.other]:
            self.api.geometry_save({'path':path,'stamp':[str(n) for n in signature(file_stat(path))],**body})
        result=self.lib.query(self.models,geometry=True)
        self.assertEqual(result['total'],2);self.assertEqual(result['geometryGroups'],1)
        # An inspection without a fingerprint must retain an existing valid one.
        self.api.geometry_save({'path':self.path,'stamp':[str(n) for n in signature(file_stat(self.path))],**body,'fingerprint':None})
        self.assertEqual(self.lib.query(self.models,geometry=True)['total'],2)
        with open(self.other,'a') as f:f.write('\n')
        self.lib.update(self.other)
        self.assertEqual(self.lib.query(self.models,geometry=True)['total'],0)
        with self.assertRaises(MetaError):self.api.geometry_save({'path':self.path,'stamp':['0','0','0'],**body})

    def test_workspace_scope_and_invalid_rules(self):
        with self.assertRaises(MetaError):self.api.watch_action({'path':self.root})
        with self.assertRaises(MetaError):self.api.annotate({'path':self.path,'status':'bad'})
        with self.assertRaises(MetaError):self.api.collection_action({'root':self.models,'name':'Bad','kind':'smart','rules':{'sql':'delete'}})
        with self.assertRaises(MetaError):self.api.geometry_save({'path':self.path,'stamp':[str(n) for n in signature(file_stat(self.path))],'triangles':1,'dimensions':[float('nan'),0,0],'volume':0})
