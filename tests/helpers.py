"""Fixtures for the tests: tiny PNGs and synthetic 3MF packages, built with
the standard library only."""

from __future__ import annotations

import os
import struct
import sys
import zipfile
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

MODEL_REL = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"
THUMB_REL = ("http://schemas.openxmlformats.org/package/2006/relationships/"
             "metadata/thumbnail")
MIDDLE_REL = "http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"
SMALL_REL = "http://schemas.bambulab.com/package/2021/cover-thumbnail-small"


def _chunk(kind, data):
    body = kind + data
    return (struct.pack(">I", len(data)) + body +
            struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF))


def make_png(w, h, rgba=(255, 0, 0, 255)):
    """A valid RGBA PNG of a single colour."""
    row = b"\x00" + bytes(rgba) * w
    raw = row * h
    return (b"\x89PNG\r\n\x1a\n" +
            _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) +
            _chunk(b"IDAT", zlib.compress(raw)) +
            _chunk(b"IEND", b""))


CTYPES_PNG = (
    b'<?xml version="1.0" encoding="UTF-8"?>\n'
    b'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
    b' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
    b' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'
    b' <Default Extension="png" ContentType="image/png"/>\n'
    b'</Types>')

CTYPES_NO_PNG = (
    b'<?xml version="1.0" encoding="UTF-8"?>\n'
    b'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
    b' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
    b' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'
    b'</Types>')

CTYPES_PNG_TEXTURE = CTYPES_NO_PNG.replace(
    b"</Types>",
    b' <Default Extension="png" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodeltexture"/>\n</Types>')


def _rels(items):
    out = [b'<?xml version="1.0" encoding="UTF-8"?>\n'
           b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n']
    for target, rid, rtype in items:
        out.append((' <Relationship Target="%s" Id="%s" Type="%s"/>\n'
                    % (target, rid, rtype)).encode())
    out.append(b"</Relationships>")
    return b"".join(out)


def _model(meta):
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<model unit="millimeter" xml:lang="en-US" '
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">']
    for k, v in meta:
        lines.append(' <metadata name="%s">%s</metadata>' % (k, v))
    lines += [' <resources>',
              '  <object id="1" type="model"><mesh><vertices>',
              '   <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>'
              '<vertex x="0" y="1" z="0"/>',
              '  </vertices><triangles><triangle v1="0" v2="1" v3="2"/>'
              '</triangles></mesh></object>',
              ' </resources>',
              ' <build><item objectid="1"/></build>',
              '</model>']
    return "\n".join(lines).encode()


CONFIG = (b'<?xml version="1.0" encoding="UTF-8"?>\n<config>\n'
          b'  <object id="1">\n    <metadata key="name" value="Cube"/>\n'
          b'  </object>\n  <plate>\n'
          b'    <metadata key="plater_id" value="1"/>\n'
          b'    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>\n'
          b'  </plate>\n</config>\n')


def make_3mf(path, bambu=True, thumbnail_middle=True, generic_thumb=False,
             ctypes=None):
    """Write a small synthetic 3MF.

    bambu=True: Bambu Studio project with plate renders and cover rels that
    point at them (what Bambu writes without a custom cover).
    bambu=False: PrusaSlicer-style package, optionally with
    Metadata/thumbnail.png + OPC rel."""
    entries = []
    if bambu:
        meta = [("Application", "BambuStudio-02.00.00.00"),
                ("Title", "Test cube"), ("Designer", "Someone")]
        if thumbnail_middle:
            meta += [("Thumbnail_Middle", "/Metadata/plate_1.png"),
                     ("Thumbnail_Small", "/Metadata/plate_1_small.png")]
        rels = _rels([("/3D/3dmodel.model", "rel-1", MODEL_REL),
                      ("/Metadata/plate_1.png", "rel-2", THUMB_REL),
                      ("/Metadata/plate_1.png", "rel-4", MIDDLE_REL),
                      ("/Metadata/plate_1_small.png", "rel-5", SMALL_REL)])
        entries += [
            ("[Content_Types].xml", ctypes or CTYPES_PNG, zipfile.ZIP_DEFLATED),
            ("_rels/.rels", rels, zipfile.ZIP_DEFLATED),
            ("3D/3dmodel.model", _model(meta), zipfile.ZIP_DEFLATED),
            ("Metadata/model_settings.config", CONFIG, zipfile.ZIP_DEFLATED),
            ("Metadata/plate_1.png", make_png(16, 16, (0, 0, 255, 255)),
             zipfile.ZIP_STORED),
            ("Metadata/plate_1_small.png", make_png(4, 4, (0, 0, 255, 255)),
             zipfile.ZIP_STORED),
        ]
    else:
        meta = [("Application", "PrusaSlicer-2.8.0"), ("Title", "Test cube")]
        items = [("/3D/3dmodel.model", "rel-1", MODEL_REL)]
        if generic_thumb:
            items.append(("/Metadata/thumbnail.png", "rel-2", THUMB_REL))
        entries += [
            ("[Content_Types].xml", ctypes or CTYPES_NO_PNG,
             zipfile.ZIP_DEFLATED),
            ("_rels/.rels", _rels(items), zipfile.ZIP_DEFLATED),
            ("3D/3dmodel.model", _model(meta), zipfile.ZIP_DEFLATED),
            ("Metadata/Slic3r_PE.config", b"; generated\n",
             zipfile.ZIP_DEFLATED),
        ]
        if generic_thumb:
            entries.append(("Metadata/thumbnail.png",
                            make_png(16, 16, (0, 255, 0, 255)),
                            zipfile.ZIP_STORED))
    with zipfile.ZipFile(path, "w") as z:
        for name, data, method in entries:
            z.writestr(name, data, compress_type=method)
    return path


def make_stl(path):
    with open(path, "w") as f:
        f.write("solid t\nfacet normal 0 0 1\nouter loop\n"
                "vertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\n"
                "endloop\nendfacet\nendsolid t\n")
    return path
