"""Preview byte/ZIP boundaries, with sparse files and synthetic directory records."""
import os
import tempfile
import unittest
import zipfile
from unittest import mock
from types import SimpleNamespace

import app
from formats.base import MetaError


class ModelLimitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = os.path.realpath(self.temp.name)
        self.api = app.Api(self.root, os.path.join(self.root, 'catalogue.sqlite3'))

    def tearDown(self):
        self.temp.cleanup()

    def test_file_accepts_exactly_250_mib_and_rejects_next_byte(self):
        path = os.path.join(self.root, 'large.stl')
        with open(path, 'wb') as model:
            model.truncate(250 << 20)
        self.assertEqual(self.api.model({'path': [path]}), path)
        with open(path, 'ab') as model:
            model.write(b'0')
        with self.assertRaisesRegex(MetaError, '250 MiB'):
            self.api.model({'path': [path]})

    def check_archive(self, sizes):
        path = os.path.join(self.root, 'large.3mf')
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('3D/model.model', '<model/>')
        with mock.patch('app.zipfile.ZipFile') as reader:
            reader.return_value.__enter__.return_value.infolist.return_value = [SimpleNamespace(file_size=n) for n in sizes]
            return self.api.model({'path': [path]})

    def test_unpacked_sum_accepts_500_mib_and_rejects_next_byte(self):
        self.assertTrue(self.check_archive([300 << 20, 200 << 20]).endswith('.3mf'))
        with self.assertRaisesRegex(MetaError, '500 MiB'):
            self.check_archive([300 << 20, (200 << 20) + 1])

    def test_archive_entry_cap_stays_5000(self):
        self.assertTrue(self.check_archive([1] * 5000).endswith('.3mf'))
        with self.assertRaises(MetaError):
            self.check_archive([1] * 5001)
