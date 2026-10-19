"""AMF handler.

AMF is XML with ``<metadata type="...">`` children on the root ``<amf>``
element, and the file may optionally be zip-compressed.  Uncompressed files
are patched with the same bounded-window streaming approach as 3MF; compressed
ones are small in practice and are rebuilt in one pass.
"""

from __future__ import annotations

import os
import zipfile

from . import xmlmeta
from .base import (AtomicWrite, Handler, Meta, MetaError, backup_once,
                   copy_stream, human, report)

# normalised key -> AMF metadata type
TYPES = [
    ("title", "name"),
    ("designer", "author"),
    ("description", "description"),
    ("copyright", "copyright"),
    ("license", "license"),
    ("application", "cad"),
    ("origin", "url"),
]
KEY_TO_TYPE = dict(TYPES)
TYPE_TO_KEY = {t: k for k, t in TYPES}
EDITABLE = [k for k, _ in TYPES]
ZIP_LIMIT = 256 << 20


class Amf(Handler):
    name = "amf"
    extensions = (".amf",)

    def read(self, path):
        window, zipped, entry = _load_window(path)
        region = xmlmeta.parse(window, "amf", "type")
        fields = {}
        custom = []
        for e in region.entries:
            key = TYPE_TO_KEY.get(e.name)
            if key and not fields.get(key):
                fields[key] = e.value
            elif not key:
                custom.append({"name": e.name, "value": e.value})
        notes = ["AMF names its fields by type: Title is stored as "
                 "type=\"name\" and Designer as type=\"author\"."]
        if zipped:
            notes.append("This AMF is zip-compressed; it will be rebuilt on "
                         "save.")
        return Meta(
            fmt="AMF (compressed)" if zipped else "AMF",
            fields=fields,
            custom=custom,
            editable=EDITABLE,
            custom_supported=True,
            notes=notes,
            info={"File size": human(os.path.getsize(path))},
            recompress=zipped,
        )

    def write(self, path, patch, progress=None, backup=True, fast=False):
        window, zipped, entry = _load_window(path)
        region = xmlmeta.parse(window, "amf", "type")
        entries = list(region.entries)

        for key, raw in patch.fields.items():
            amf_type = KEY_TO_TYPE.get(key)
            if not amf_type:
                continue
            value = "" if raw is None else str(raw).strip()
            existing = [e for e in entries if e.name == amf_type]
            if existing:
                for e in existing:
                    e.value = value
            elif value:
                entries.append(xmlmeta.Entry(amf_type, value))

        if patch.custom is not None:
            entries = [e for e in entries if e.name in TYPE_TO_KEY]
            for item in patch.custom:
                cname = (item.get("name") or "").strip()
                if cname:
                    entries.append(xmlmeta.Entry(cname, item.get("value") or ""))

        new_window = xmlmeta.apply(region, entries, "type")
        if backup:
            report(progress, 0.0, "Backing up original")
            backup_once(path)

        report(progress, 0.1, "Writing")
        if zipped:
            with zipfile.ZipFile(path) as zin:
                others = [(i, zin.read(i)) for i in zin.infolist()
                          if i.filename != entry]
            with AtomicWrite(path) as out:
                with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
                    zout.writestr(entry, new_window)
                    for info, data in others:
                        zout.writestr(info.filename, data)
        else:
            size = os.path.getsize(path)
            body = size - len(window)
            with AtomicWrite(path) as dst, open(path, "rb") as src:
                dst.write(new_window)
                src.seek(len(window))
                copy_stream(src, dst, remaining=body, progress=progress,
                            base=0.1, span=0.89, total=max(body, 1))
        report(progress, 1.0, "Saved")


def _load_window(path):
    """Return (header window bytes, is_zipped, entry name inside the zip)."""
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            candidates = [i for i in z.infolist()
                          if i.filename.lower().endswith(".amf")] or z.infolist()
            if not candidates:
                raise MetaError("This compressed AMF has no entries.")
            entry = candidates[0]
            if entry.file_size > ZIP_LIMIT:
                raise MetaError(
                    "The AMF document inside this archive is %s, which is too "
                    "large to rebuild safely." % human(entry.file_size))
            return z.read(entry.filename), True, entry.filename
    with open(path, "rb") as f:
        return f.read(xmlmeta.HEADER_WINDOW), False, None

