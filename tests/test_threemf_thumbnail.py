"""3MF cover image: set / re-set / remove, package integrity."""

from __future__ import annotations

import os
import re
import shutil
import tempfile
import unittest
import zipfile

import helpers  # noqa: F401  (puts the repo root on sys.path)
from helpers import (MIDDLE_REL, MODEL_REL, SMALL_REL, THUMB_REL,
                     CTYPES_PNG_TEXTURE, make_3mf, make_png, make_stl)

import formats
from formats import threemf
from formats.base import MetaError, Patch, png_size

AUX_COVER = "Auxiliaries/.thumbnails/thumbnail_3mf.png"
AUX_MIDDLE = "Auxiliaries/.thumbnails/thumbnail_middle.png"
AUX_SMALL = "Auxiliaries/.thumbnails/thumbnail_small.png"
DOWNLOADS = os.path.expanduser("~/Downloads")


def rels_of(path):
    with zipfile.ZipFile(path) as z:
        data = z.read("_rels/.rels")
    out = []
    for m in re.finditer(rb"<Relationship\b([^>]*)>", data):
        attrs = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1).decode()))
        out.append(attrs)
    return data, out


def by_type(rels, rtype):
    return [r for r in rels if r.get("Type") == rtype]


def read_all(path):
    with zipfile.ZipFile(path) as z:
        return {n: z.read(n) for n in z.namelist()}


def set_patch(large, small, **kw):
    return Patch(thumbnail={"action": "set", "large": large, "small": small},
                 **kw)


REMOVE = Patch(thumbnail={"action": "remove"})


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.large = make_png(512, 512, (255, 0, 0, 255))
        self.small = make_png(128, 128, (255, 0, 0, 255))

    def tearDown(self):
        self._tmp.cleanup()

    def path(self, name="t.3mf"):
        return os.path.join(self.dir, name)

    def assert_no_dupes(self, path):
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            self.assertEqual(len(names), len(set(names)), names)
            self.assertIsNone(z.testzip())
            ctypes = z.read("[Content_Types].xml")
        _data, rels = rels_of(path)
        types = [r["Type"] for r in rels]
        self.assertEqual(len(types), len(set(types)), types)
        ids = [r["Id"] for r in rels]
        self.assertEqual(len(ids), len(set(ids)), ids)
        self.assertLessEqual(
            len(re.findall(rb'<Default Extension="png"', ctypes, re.I)), 1)


class BambuTests(Base):
    def test_set_writes_aux_parts_and_rels(self):
        p = make_3mf(self.path())
        before_rels, _ = rels_of(p)
        formats.write(p, set_patch(self.large, self.small), backup=False)
        files = read_all(p)
        self.assertEqual(files[AUX_COVER], self.large)
        self.assertEqual(files[AUX_MIDDLE], self.large)
        self.assertEqual(files[AUX_SMALL], self.small)
        data, rels = rels_of(p)
        self.assertEqual([r["Target"] for r in by_type(rels, THUMB_REL)],
                         ["/" + AUX_COVER])
        self.assertEqual([r["Target"] for r in by_type(rels, MIDDLE_REL)],
                         ["/" + AUX_MIDDLE])
        self.assertEqual([r["Target"] for r in by_type(rels, SMALL_REL)],
                         ["/" + AUX_SMALL])
        # Ids preserved and the model rel line is byte-identical
        self.assertEqual({r["Type"]: r["Id"] for r in rels},
                         {MODEL_REL: "rel-1", THUMB_REL: "rel-2",
                          MIDDLE_REL: "rel-4", SMALL_REL: "rel-5"})
        model_line = re.search(rb'.*rel-1.*', before_rels).group(0)
        self.assertIn(model_line, data)
        with zipfile.ZipFile(p) as z:
            self.assertEqual(z.getinfo(AUX_COVER).compress_type,
                             zipfile.ZIP_STORED)
        self.assert_no_dupes(p)

    def test_metadata_updated_or_appended(self):
        for has_meta in (True, False):
            p = make_3mf(self.path("m%d.3mf" % has_meta),
                         thumbnail_middle=has_meta)
            formats.write(p, set_patch(self.large, self.small), backup=False)
            meta = formats.read(p)
            custom = {c["name"]: c["value"] for c in meta.custom}
            self.assertEqual(custom["Thumbnail_Middle"], "/" + AUX_MIDDLE)
            self.assertEqual(custom["Thumbnail_Small"], "/" + AUX_SMALL)
            self.assertEqual(meta.fields["title"], "Test cube")
            self.assertEqual(meta.fields["designer"], "Someone")
            self.assertEqual(custom["Application"] if "Application" in custom
                             else meta.fields["application"],
                             "BambuStudio-02.00.00.00")
            with zipfile.ZipFile(p) as z:
                model = z.read("3D/3dmodel.model")
            self.assertEqual(model.count(b'name="Thumbnail_Middle"'), 1)
            self.assertIn(b"<triangle v1=\"0\" v2=\"1\" v3=\"2\"/>", model)

    def test_set_twice_no_duplicates_second_wins(self):
        p = make_3mf(self.path())
        formats.write(p, set_patch(self.large, self.small), backup=False)
        names_once = sorted(read_all(p))
        rels_once, _ = rels_of(p)
        large2 = make_png(512, 512, (0, 255, 0, 255))
        small2 = make_png(128, 128, (0, 255, 0, 255))
        formats.write(p, set_patch(large2, small2), backup=False)
        self.assertEqual(sorted(read_all(p)), names_once)
        self.assertEqual(rels_of(p)[0], rels_once)
        files = read_all(p)
        self.assertEqual(files[AUX_COVER], large2)
        self.assertEqual(files[AUX_SMALL], small2)
        self.assert_no_dupes(p)

    def test_other_entries_untouched(self):
        p = make_3mf(self.path())
        before = read_all(p)
        formats.write(p, set_patch(self.large, self.small), backup=False)
        after = read_all(p)
        for name, data in before.items():
            if name in ("_rels/.rels", "3D/3dmodel.model"):
                continue
            self.assertEqual(after[name], data, name)

    def test_remove_reverts_to_plate_render(self):
        p = make_3mf(self.path())
        formats.write(p, set_patch(self.large, self.small), backup=False)
        formats.write(p, REMOVE, backup=False)
        files = read_all(p)
        for part in (AUX_COVER, AUX_MIDDLE, AUX_SMALL):
            self.assertNotIn(part, files)
        _data, rels = rels_of(p)
        self.assertEqual(by_type(rels, THUMB_REL)[0]["Target"],
                         "/Metadata/plate_1.png")
        self.assertEqual(by_type(rels, MIDDLE_REL)[0]["Target"],
                         "/Metadata/plate_1.png")
        self.assertEqual(by_type(rels, SMALL_REL)[0]["Target"],
                         "/Metadata/plate_1_small.png")
        custom = {c["name"]: c["value"] for c in formats.read(p).custom}
        self.assertEqual(custom["Thumbnail_Middle"], "/Metadata/plate_1.png")
        self.assertEqual(custom["Thumbnail_Small"],
                         "/Metadata/plate_1_small.png")
        self.assert_no_dupes(p)
        with self.assertRaises(MetaError):
            formats.write(p, REMOVE, backup=False)

    def test_combined_save_custom_list_does_not_win(self):
        p = make_3mf(self.path())
        meta = formats.read(p)
        custom = list(meta.custom) + [{"name": "Mine:Batch", "value": "7"}]
        self.assertTrue(any(c["name"] == "Thumbnail_Middle" and
                            c["value"] == "/Metadata/plate_1.png"
                            for c in custom))
        formats.write(p, set_patch(self.large, self.small,
                                   fields={"title": "X"}, custom=custom),
                      backup=False)
        meta = formats.read(p)
        got = {c["name"]: c["value"] for c in meta.custom}
        self.assertEqual(meta.fields["title"], "X")
        self.assertEqual(got["Mine:Batch"], "7")
        self.assertEqual(got["Thumbnail_Middle"], "/" + AUX_MIDDLE)

    def test_backup_equals_original(self):
        p = make_3mf(self.path())
        with open(p, "rb") as f:
            original = f.read()
        formats.write(p, set_patch(self.large, self.small), backup=True)
        with open(p + ".bak", "rb") as f:
            self.assertEqual(f.read(), original)

    def test_read_flags_and_thumbnail(self):
        p = make_3mf(self.path())
        d = formats.read(p).as_dict()
        self.assertTrue(d["thumbnailEditable"])
        self.assertFalse(d["thumbnailCustom"])
        self.assertEqual(d["info"]["Cover image"], "Metadata/plate_1.png")
        formats.write(p, set_patch(self.large, self.small), backup=False)
        d = formats.read(p).as_dict()
        self.assertTrue(d["thumbnailCustom"])
        self.assertEqual(d["info"]["Cover image"], AUX_MIDDLE)
        self.assertEqual(formats.thumbnail(p), ("image/png", self.large))
        formats.write(p, REMOVE, backup=False)
        self.assertFalse(formats.read(p).as_dict()["thumbnailCustom"])


class GenericTests(Base):
    def test_set_creates_plain_thumbnail(self):
        p = make_3mf(self.path(), bambu=False)
        formats.write(p, set_patch(self.large, self.small), backup=False)
        files = read_all(p)
        self.assertEqual(files["Metadata/thumbnail.png"], self.large)
        self.assertFalse(any(n.startswith("Auxiliaries") for n in files))
        _data, rels = rels_of(p)
        self.assertEqual([r["Target"] for r in by_type(rels, THUMB_REL)],
                         ["/Metadata/thumbnail.png"])
        self.assertIn(b'<Default Extension="png" ContentType="image/png"/>',
                      files["[Content_Types].xml"])
        self.assertNotIn(b"Thumbnail_", files["3D/3dmodel.model"])
        self.assert_no_dupes(p)
        # set again: still one of everything
        formats.write(p, set_patch(self.small, self.small), backup=False)
        self.assertEqual(read_all(p)["Metadata/thumbnail.png"], self.small)
        self.assert_no_dupes(p)
        self.assertEqual(sorted(read_all(p)), sorted(files))

    def test_remove_deletes_rel_and_part(self):
        p = make_3mf(self.path(), bambu=False, generic_thumb=True)
        self.assertTrue(formats.read(p).thumbnail_custom)
        formats.write(p, REMOVE, backup=False)
        files = read_all(p)
        self.assertNotIn("Metadata/thumbnail.png", files)
        _data, rels = rels_of(p)
        self.assertEqual(by_type(rels, THUMB_REL), [])
        self.assertEqual(len(by_type(rels, MODEL_REL)), 1)
        d = formats.read(p).as_dict()
        self.assertFalse(d["hasThumbnail"])
        self.assertFalse(d["thumbnailCustom"])

    def test_png_texture_type_gets_override(self):
        p = make_3mf(self.path(), bambu=False, ctypes=CTYPES_PNG_TEXTURE)
        formats.write(p, set_patch(self.large, self.small), backup=False)
        ct = read_all(p)["[Content_Types].xml"]
        self.assertEqual(ct.count(b'<Default Extension="png"'), 1)
        self.assertEqual(ct.count(
            b'<Override PartName="/Metadata/thumbnail.png" '
            b'ContentType="image/png"/>'), 1)
        formats.write(p, set_patch(self.large, self.small), backup=False)
        ct = read_all(p)["[Content_Types].xml"]
        self.assertEqual(ct.count(b"<Override"), 1)
        formats.write(p, REMOVE, backup=False)
        self.assertNotIn(b"<Override", read_all(p)["[Content_Types].xml"])

    def test_missing_rels_and_ctypes_are_created(self):
        p = self.path()
        model = read_all(make_3mf(self.path("src.3mf"), bambu=False))[
            "3D/3dmodel.model"]
        with zipfile.ZipFile(p, "w") as z:
            z.writestr("3D/3dmodel.model", model)
        formats.write(p, set_patch(self.large, self.small), backup=False)
        _data, rels = rels_of(p)
        self.assertEqual(len(by_type(rels, MODEL_REL)), 1)
        self.assertEqual(len(by_type(rels, THUMB_REL)), 1)
        self.assertIn(b'Extension="png"', read_all(p)["[Content_Types].xml"])
        self.assert_no_dupes(p)


class HelperTests(unittest.TestCase):
    def test_png_size(self):
        self.assertEqual(png_size(make_png(7, 3)), (7, 3))
        with self.assertRaises(MetaError):
            png_size(b"GIF89a" + b"\0" * 40)

    def test_set_relationships_drops_duplicates(self):
        data = (b'<Relationships>\n'
                b' <Relationship Target="/a.png" Id="rel-2" Type="%s"/>\n'
                b' <Relationship Target="/b.png" Id="rel-9" Type="%s"/>\n'
                b'</Relationships>' % (THUMB_REL.encode(), THUMB_REL.encode()))
        out = threemf.set_relationships(data, {THUMB_REL: "c.png"})
        self.assertEqual(out.count(b"<Relationship "), 1)
        self.assertIn(b'Target="/c.png" Id="rel-2"', out)

    def test_non_3mf_not_editable(self):
        with tempfile.TemporaryDirectory() as d:
            p = make_stl(os.path.join(d, "t.stl"))
            self.assertFalse(formats.read(p).as_dict()["thumbnailEditable"])


SAMPLES = ["ikea++Skadis An.3mf", "peg_board_v1ac.3mf"]


@unittest.skipUnless(all(os.path.exists(os.path.join(DOWNLOADS, s))
                         for s in SAMPLES), "sample 3MFs not in ~/Downloads")
class SampleCopyTests(Base):
    def test_set_read_remove_on_copies(self):
        for sample in SAMPLES:
            src = os.path.join(DOWNLOADS, sample)
            st = os.stat(src)
            p = os.path.join(self.dir, sample)
            shutil.copyfile(src, p)
            before = read_all(p)
            meta_before = formats.read(p).as_dict()

            formats.write(p, set_patch(self.large, self.small), backup=False)
            d = formats.read(p).as_dict()
            self.assertTrue(d["thumbnailCustom"])
            self.assertEqual(d["fields"], meta_before["fields"])
            self.assertEqual(d["objects"], meta_before["objects"])
            self.assertEqual(formats.thumbnail(p)[1], self.large)
            self.assert_no_dupes(p)
            after = read_all(p)
            for name, data in before.items():
                if name in ("_rels/.rels", "3D/3dmodel.model") \
                        or name.startswith("Auxiliaries/.thumbnails/"):
                    continue
                self.assertEqual(after[name], data, name)

            formats.write(p, set_patch(self.small, self.small), backup=False)
            self.assertEqual(sorted(read_all(p)), sorted(after))
            self.assert_no_dupes(p)

            formats.write(p, REMOVE, backup=False)
            d = formats.read(p).as_dict()
            self.assertFalse(d["thumbnailCustom"])
            self.assertEqual(d["fields"], meta_before["fields"])
            self.assert_no_dupes(p)
            st2 = os.stat(src)
            self.assertEqual((st.st_size, st.st_mtime),
                             (st2.st_size, st2.st_mtime))


if __name__ == "__main__":
    unittest.main()
