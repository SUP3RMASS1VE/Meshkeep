"""Catalogue regression tests: search, paging, scoped hashes and cache invalidation."""
import os
import shutil
import tempfile
import unittest
from unittest import mock

import helpers
from helpers import make_3mf, make_stl, make_png
import app
from file_state import file_stat
from library import Library, signature
from formats.base import MetaError, Patch
import formats


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = os.path.realpath(self.temp.name)
        self.models = os.path.join(self.root, 'models_100%')
        os.mkdir(self.models)
        self.library = Library(os.path.join(self.root, 'catalogue.sqlite3'))
        self.api = app.Api(self.models, self.library.path)

    def tearDown(self):
        self.temp.cleanup()

    def scan(self):
        return self.library.scan(self.models, lambda *a: None)

    def query(self, **kwargs):
        return self.library.query(self.models, **kwargs)

    def test_recursive_index_search_filters_and_paging(self):
        make_3mf(os.path.join(self.models, 'named.3mf'))
        os.mkdir(os.path.join(self.models, 'nested'))
        for i in range(85):
            make_stl(os.path.join(self.models, 'nested', 'model_%03d.stl' % i))
        self.assertEqual(self.scan()['indexed'], 86)
        self.assertEqual(self.query()['total'], 86)
        self.assertEqual(len(self.query()['files']), 80)
        self.assertEqual(len(self.query(offset=80)['files']), 6)
        self.assertEqual(self.query(search='Someone')['total'], 1)
        self.assertEqual(self.query(search='Test cube')['total'], 1)
        self.assertEqual(self.query(ext='.stl')['total'], 85)
        self.assertEqual(self.query(recursive=False)['total'], 1)
        self.assertEqual(self.query(search='%')['total'], 86)  # literal percent in folder name
        self.assertEqual(self.query(search='_no_match')['total'], 0)
        page = self.api.browse({'path': [self.models], 'scope': ['library'], 'limit': ['7']})
        self.assertEqual(len(page['files']), 7)
        self.assertEqual(page['total'], 86)
        with self.assertRaises(MetaError):
            self.api.browse({'offset': ['bad']})

    def test_hash_content_not_name_and_invalidation(self):
        a = make_stl(os.path.join(self.models, 'a.stl'))
        b = os.path.join(self.models, 'renamed.stl')
        shutil.copyfile(a, b)
        c = make_stl(os.path.join(self.models, 'different.stl'))
        with open(c, 'r+') as f:
            content = f.read(); f.seek(0); f.write(content.replace('solid t', 'solid z'))
        self.scan()
        result = self.library.hashes(self.models, lambda *a: None)
        self.assertEqual(result['duplicateFiles'], 2)
        self.assertEqual(self.query(duplicates=True)['duplicateGroups'], 1)
        self.assertEqual(self.library.hashes(self.models, lambda *a: None)['hashed'], 0)
        old = os.stat(b)
        with open(b, 'r+') as f:
            content = f.read(); f.seek(0); f.write(content.replace('solid t', 'solid q'))
        os.utime(b, ns=(old.st_atime_ns, old.st_mtime_ns))  # unchanged mtime/size, changed ctime
        self.scan()
        self.assertEqual(self.query(duplicates=True)['total'], 0)
        self.library.hashes(self.models, lambda *a: None)
        self.assertEqual(self.query(duplicates=True)['total'], 0)

    def test_edits_invalidate_catalogue_metadata_and_hash(self):
        path = make_3mf(os.path.join(self.models, 'named.3mf'))
        self.scan()
        formats.write(path, Patch(fields={'designer': 'New designer'}), backup=False)
        self.library.refresh(path)
        self.assertEqual(self.query(search='Someone')['total'], 0)
        self.assertEqual(self.query(search='New designer')['total'], 1)
        renamed = self.api.rename({'path': path, 'name': 'renamed.3mf'})
        self.assertEqual(self.query()['files'][0]['path'], renamed['path'])

    def test_stale_files_symlinks_and_root_boundaries(self):
        path = make_stl(os.path.join(self.models, 'a.stl'))
        outside = make_stl(os.path.join(self.root, 'outside.stl'))
        self.scan()
        self.assertEqual(self.query()['total'], 1)
        self.assertEqual(len(self.api.list({})['files']), 1)
        with self.assertRaises(MetaError):
            self.api.model({'path': [outside]})
        os.unlink(path)
        self.scan()
        self.assertEqual(self.query()['total'], 0)

    def test_symlink_is_excluded(self):
        outside = make_stl(os.path.join(self.root, 'outside.stl'))
        try:
            os.symlink(outside, os.path.join(self.models, 'outside.stl'))
        except OSError as exc:
            if getattr(exc, 'winerror', None) == 1314:
                self.skipTest('Windows account does not have symbolic-link creation privilege')
            raise
        self.scan()
        self.assertEqual(self.query()['total'], 0)

    @unittest.skipUnless(os.name == 'nt', 'Windows directory junctions')
    def test_junction_does_not_escape_scan_or_watcher(self):
        import subprocess
        from watcher import FolderWatcher
        outside = os.path.join(self.root, 'outside')
        os.mkdir(outside)
        make_stl(os.path.join(outside, 'external.stl'))
        junction = os.path.join(self.models, 'junction')
        subprocess.run(['cmd', '/c', 'mklink', '/J', junction, outside], check=True, capture_output=True)
        self.scan()
        self.assertEqual(self.query()['total'], 0)
        self.assertEqual(self.api.list({})['dirs'], [])
        with self.assertRaises(MetaError):
            self.api.resolve(os.path.join(junction, 'external.stl'))
        self.api.watch_action({'path': self.models, 'enabled': True})
        watcher = FolderWatcher(self.library, self.models)
        watcher.tick()
        self.assertEqual(watcher.snapshots[self.models], {})

    def test_preview_stamp_and_model_limit(self):
        path = make_stl(os.path.join(self.models, 'a.stl'))
        stamp = [str(n) for n in signature(file_stat(path))]
        png = make_png(20, 20)
        self.library.cache_preview(path, png, stamp)
        self.assertEqual(self.api.preview({'path': [path]}), ('image/png', png))
        with open(path, 'a') as f:
            f.write('\n')
        self.assertIsNone(self.library.preview(path))
        with self.assertRaises(MetaError):
            self.library.cache_preview(path, png, stamp)
        with open(path, 'wb') as f:
            f.truncate((64 << 20) + 1)
        with self.assertRaises(MetaError):
            self.api.model({'path': [path]})

    def test_renamed_app_preserves_catalogue(self):
        support = os.path.join(self.root, 'Library', 'Application Support')
        with mock.patch('app.os.path.expanduser', return_value=self.root), mock.patch('app.sys.platform', 'darwin'):
            self.assertEqual(app.default_catalogue(), os.path.join(support, 'Meshkeep', 'catalogue.sqlite3'))
            legacy_folder = os.path.join(support, 'Model Meta Editor')
            os.makedirs(legacy_folder)
            legacy = os.path.join(legacy_folder, 'catalogue.sqlite3')
            with open(legacy, 'wb') as existing:
                existing.write(b'existing catalogue')
            self.assertEqual(app.default_catalogue(), legacy)
            with open(legacy, 'rb') as existing:
                self.assertEqual(existing.read(), b'existing catalogue')

    def test_windows_catalogue_uses_local_appdata(self):
        with mock.patch('app.sys.platform', 'win32'), mock.patch.dict(os.environ, {'LOCALAPPDATA': self.root}):
            self.assertEqual(app.default_catalogue(), os.path.join(self.root, 'Meshkeep', 'catalogue.sqlite3'))

    def test_windows_path_case_and_drive_boundaries(self):
        if os.name != 'nt':
            self.skipTest('Windows path semantics')
        self.assertEqual(self.api.resolve(self.models.upper()), os.path.realpath(self.models))
        with self.assertRaises(MetaError):
            self.api.resolve('Z:\\outside\\model.stl', must_exist=False)

    def test_scan_does_not_escape_folder_prefix(self):
        sibling = self.models + 'other'
        os.mkdir(sibling)
        make_stl(os.path.join(sibling, 'a.stl'))
        self.library.scan(sibling, lambda *a: None)
        self.assertEqual(self.query()['total'], 0)


if __name__ == '__main__':
    unittest.main()
