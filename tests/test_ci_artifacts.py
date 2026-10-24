"""CI release checks must catch mismatched tags, missing builds and bad hashes."""
import json
from pathlib import Path
import tempfile
import unittest
from tools.ci_artifacts import verify, collect, combine, installer_name, required_names, OUTPUT


class CiArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'desktop').mkdir()
        (self.root / 'desktop/package.json').write_text(json.dumps({'version': '2.0.3'}))
        (self.root / 'desktop/package-lock.json').write_text(json.dumps({'version': '2.0.3', 'packages': {'': {'version': '2.0.3'}}}))

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self, platform):
        folder = self.root / 'desktop' / ('dist' if platform == 'macos-arm64' else 'dist-win')
        folder.mkdir(exist_ok=True)
        path = folder / installer_name(platform, '2.0.3')
        for name in required_names(platform, '2.0.3'):
            (folder / name).write_bytes(b'fixture-asset-' + name.encode())
        return path

    def test_tag_and_lockfile_must_match(self):
        self.assertEqual(verify(self.root, 'tag', 'v2.0.3'), '2.0.3')
        self.assertEqual(verify(self.root, 'branch', 'main'), '2.0.3')
        with self.assertRaises(ValueError):
            verify(self.root, 'tag', 'v2.0.2')
        (self.root / 'desktop/package-lock.json').write_text(json.dumps({'version': '2.0.2', 'packages': {'': {'version': '2.0.2'}}}))
        with self.assertRaises(ValueError):
            verify(self.root)

    def test_collect_and_combine_require_both_matching_installers(self):
        for platform in ['macos-arm64', 'windows-x64']:
            original = self.fixture(platform)
            name = collect(self.root, platform)
            self.assertEqual((self.root / OUTPUT / name).read_bytes(), original.read_bytes())
        combine(self.root)
        sums = (self.root / OUTPUT / 'SHA256SUMS.txt').read_text()
        self.assertEqual(len(sums.splitlines()), 5)
        (self.root / OUTPUT / installer_name('windows-x64', '2.0.3')).write_bytes(b'changed')
        with self.assertRaises(ValueError):
            combine(self.root)

    def test_missing_platform_is_not_released(self):
        self.fixture('macos-arm64')
        collect(self.root, 'macos-arm64')
        with self.assertRaises(FileNotFoundError):
            combine(self.root)
        with self.assertRaises(ValueError):
            collect(self.root, 'windows-x64')

    def test_update_manifest_and_mac_zip_are_required(self):
        original = self.fixture('macos-arm64')
        (original.parent / 'latest-mac.yml').unlink()
        with self.assertRaises(ValueError):
            collect(self.root, 'macos-arm64')
        self.fixture('macos-arm64')
        (original.parent / 'Meshkeep-2.0.3-arm64.zip').unlink()
        with self.assertRaises(ValueError):
            collect(self.root, 'macos-arm64')

    def test_blockmaps_are_included_and_checked(self):
        for platform in ['macos-arm64', 'windows-x64']:
            original = self.fixture(platform)
            original.with_name(original.name + '.blockmap').write_bytes(b'blockmap')
            collect(self.root, platform)
        combine(self.root)
        self.assertEqual(len((self.root / OUTPUT / 'SHA256SUMS.txt').read_text().splitlines()), 7)
        (self.root / OUTPUT / 'latest.yml').write_bytes(b'tampered')
        with self.assertRaises(ValueError):
            combine(self.root)

    def test_checksums_cannot_omit_required_update_assets(self):
        for platform in ['macos-arm64', 'windows-x64']:
            self.fixture(platform)
            collect(self.root, platform)
        sums = self.root / OUTPUT / 'SHA256SUMS-macos-arm64.txt'
        sums.write_text(''.join(line for line in sums.read_text().splitlines(True) if 'latest-mac.yml' not in line))
        with self.assertRaises(ValueError):
            combine(self.root)
