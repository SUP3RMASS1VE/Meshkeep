"""3MF handler.

A 3MF is an OPC (zip) package.  Authorship metadata lives in the
``<metadata>`` elements at the top of the 3D model part, and Bambu Studio /
OrcaSlicer additionally keep the user-visible object and part names in
``Metadata/model_settings.config``.

The model part is frequently enormous (the sample used to develop this was
404 MB of XML), so reads touch only a 4 MiB header window and writes stream
the untouched remainder straight through a fresh deflate stream.
"""

from __future__ import annotations

import os
import re
import time
import zipfile

from . import xmlmeta
from .base import (CHUNK, AtomicWrite, Handler, Meta, MetaError, backup_once,
                   human, report)

MODEL_REL = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"
THUMB_REL = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"
DEFAULT_MODEL_PART = "3D/3dmodel.model"

# Bambu Studio / OrcaSlicer cover image conventions (bbs_3mf.cpp).  The
# "middle" cover is what their Home > Recent projects tile shows.
BAMBU_MIDDLE_REL = "http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"
BAMBU_SMALL_REL = "http://schemas.bambulab.com/package/2021/cover-thumbnail-small"
AUX_COVER = "Auxiliaries/.thumbnails/thumbnail_3mf.png"
AUX_MIDDLE = "Auxiliaries/.thumbnails/thumbnail_middle.png"
AUX_SMALL = "Auxiliaries/.thumbnails/thumbnail_small.png"
AUX_PARTS = (AUX_COVER, AUX_MIDDLE, AUX_SMALL)
BAMBU_PLATE = "Metadata/plate_1.png"
BAMBU_PLATE_SMALL = "Metadata/plate_1_small.png"
BAMBU_CONFIG = "Metadata/model_settings.config"
# Generic / PrusaSlicer convention
PLAIN_THUMB = "Metadata/thumbnail.png"
RELS = "_rels/.rels"
CTYPES = "[Content_Types].xml"

# Relationship Ids Bambu itself uses for each type; used when free.
_PREFERRED_IDS = {THUMB_REL: "rel-2", BAMBU_MIDDLE_REL: "rel-4",
                  BAMBU_SMALL_REL: "rel-5"}

# normalised key -> candidate 3MF metadata names, most preferred first
ALIASES = {
    "title": ["Title"],
    "designer": ["Designer"],
    "description": ["Description"],
    "copyright": ["Copyright"],
    "license": ["LicenseTerms", "License"],
    "application": ["Application"],
    "origin": ["Origin"],
    "rating": ["Rating"],
    "creation_date": ["CreationDate"],
    "modification_date": ["ModificationDate"],
}
KNOWN_NAMES = {name for names in ALIASES.values() for name in names}

# Deflating hundreds of MB at the default level is slow and buys little on
# already-dense vertex text, so large parts drop to the fast level unless the
# caller explicitly asks for maximum compression.
BIG_PART = 64 << 20

_TAG_RE = re.compile(rb"<(/?)(object|part|metadata|plate)\b([^>]*)>")
_VALUE_ATTR_RE = re.compile(rb'value\s*=\s*"([^"]*)"')
_KEY_ATTR_RE = re.compile(rb'key\s*=\s*"([^"]*)"')
_ID_ATTR_RE = re.compile(rb'id\s*=\s*"([^"]*)"')


def _rels(z):
    try:
        data = z.read("_rels/.rels")
    except KeyError:
        return []
    out = []
    for m in re.finditer(rb"<Relationship\b([^>]*)>", data):
        attrs = dict((am.group(1).decode(), (am.group(3) or am.group(4)).decode())
                     for am in xmlmeta._ATTR_RE.finditer(m.group(1)))
        out.append(attrs)
    return out


def _find_part(z, rel_type, default=None):
    names = set(z.namelist())
    for rel in _rels(z):
        if rel.get("Type") == rel_type:
            target = rel.get("Target", "").lstrip("/")
            if target in names:
                return target
    if default and default in names:
        return default
    return None


def _model_part(z):
    part = _find_part(z, MODEL_REL, DEFAULT_MODEL_PART)
    if part:
        return part
    for name in z.namelist():
        if name.lower().endswith(".model"):
            return name
    raise MetaError("No 3D model part found inside this 3MF package.")


# --- cover image: package plumbing -------------------------------------------
# These work on raw bytes and edit surgically, so everything we do not manage
# (the model relationship, texture overrides, ...) stays byte-for-byte as is.

_REL_ELEM_RE = re.compile(
    rb"[ \t]*<Relationship\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*?"
    rb"(?:/>|>\s*</Relationship\s*>)[ \t]*(?:\r?\n)?")
_TYPES_ELEM_RE = re.compile(
    rb"[ \t]*<(Default|Override)\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*?"
    rb"(?:/>|>\s*</(?:Default|Override)\s*>)[ \t]*(?:\r?\n)?")


def _attrs(raw: bytes):
    """Attribute dict plus the value spans (relative to *raw*) of each."""
    values, spans = {}, {}
    for am in xmlmeta._ATTR_RE.finditer(raw):
        key = am.group(1).decode()
        group = 3 if am.group(3) is not None else 4
        values[key] = xmlmeta.unescape(am.group(group))
        spans[key] = am.span(group)
    return values, spans


def _is_bambu(names, entries, rels):
    """Bambu Studio / OrcaSlicer package?  Decides where the cover goes."""
    if BAMBU_CONFIG in names:
        return True
    for e in entries:
        if e.name == "Application" and e.value.startswith(
                ("BambuStudio", "OrcaSlicer")):
            return True
    return any(r.get("Type", "").startswith("http://schemas.bambulab.com/")
               for r in rels)


def _rel_target(rels, rel_type, names):
    for rel in rels:
        if rel.get("Type") == rel_type:
            target = rel.get("Target", "").lstrip("/")
            if target in names:
                return target
    return None


def set_relationships(data, wanted, model_part=DEFAULT_MODEL_PART):
    """Return new ``_rels/.rels`` bytes.

    *wanted* maps a relationship Type to a part name (re-point or add it) or
    to None (remove every relationship of that Type).  An existing element
    keeps its Id and only its Target changes; further duplicates of a managed
    Type are dropped.  Everything else is left untouched."""
    if data is None:
        data = (b'<?xml version="1.0" encoding="UTF-8"?>\n'
                b'<Relationships xmlns="http://schemas.openxmlformats.org/'
                b'package/2006/relationships">\n <Relationship Target="/' +
                xmlmeta.escape_attr(model_part) + b'" Id="rel-1" Type="' +
                MODEL_REL.encode() + b'"/>\n</Relationships>\n')
    for rel_type, part in wanted.items():
        matches = []
        ids = set()
        for m in _REL_ELEM_RE.finditer(data):
            values, spans = _attrs(m.group(0))
            ids.add(values.get("Id"))
            if values.get("Type") == rel_type:
                matches.append((m, values, spans))
        if part is None:
            for m, _v, _s in reversed(matches):
                data = data[:m.start()] + data[m.end():]
            continue
        target = xmlmeta.escape_attr("/" + part)
        if matches:
            # drop extra duplicates first (back to front keeps offsets valid)
            for m, _v, _s in reversed(matches[1:]):
                data = data[:m.start()] + data[m.end():]
            m, _values, spans = matches[0]
            if "Target" in spans:
                s, e = spans["Target"]
                data = (data[:m.start() + s] + target +
                        data[m.start() + e:])
                continue
            data = data[:m.start()] + data[m.end():]
        rel_id = _PREFERRED_IDS.get(rel_type)
        n = 1
        while not rel_id or rel_id in ids:
            rel_id = "rel-mme-%d" % n
            n += 1
        elem = (b' <Relationship Target="' + target + b'" Id="' +
                rel_id.encode() + b'" Type="' +
                xmlmeta.escape_attr(rel_type) + b'"/>\n')
        close = data.rfind(b"</Relationships")
        if close < 0:
            raise MetaError("The package relationships file is malformed.")
        if close and data[close - 1:close] != b"\n":
            elem = b"\n" + elem
        data = data[:close] + elem + data[close:]
    return data


def _types_elems(data):
    out = []
    for m in _TYPES_ELEM_RE.finditer(data):
        values, _spans = _attrs(m.group(0))
        out.append((m, m.group(1), values))
    return out


def ensure_png_type(data, parts):
    """Make sure every part in *parts* resolves to ``image/png`` in
    ``[Content_Types].xml`` without ever adding a duplicate element."""
    if data is None:
        data = (b'<?xml version="1.0" encoding="UTF-8"?>\n'
                b'<Types xmlns="http://schemas.openxmlformats.org/package/'
                b'2006/content-types">\n'
                b' <Default Extension="rels" ContentType="application/'
                b'vnd.openxmlformats-package.relationships+xml"/>\n'
                b' <Default Extension="model" ContentType="application/'
                b'vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'
                b'</Types>\n')
    elems = _types_elems(data)
    png_defaults = [v for _m, kind, v in elems if kind == b"Default"
                    and v.get("Extension", "").lower() == "png"]
    if any(v.get("ContentType", "").lower() == "image/png"
           for v in png_defaults):
        return data
    if png_defaults:
        # png is mapped to something else (e.g. a texture type): override
        # just our parts.
        have = {v.get("PartName", "").lower() for _m, kind, v in elems
                if kind == b"Override"}
        new = b"".join(
            b' <Override PartName="' + xmlmeta.escape_attr("/" + p) +
            b'" ContentType="image/png"/>\n'
            for p in parts if ("/" + p).lower() not in have)
    else:
        new = b' <Default Extension="png" ContentType="image/png"/>\n'
    if not new:
        return data
    close = data.rfind(b"</Types")
    if close < 0:
        raise MetaError("The package content types file is malformed.")
    if close and data[close - 1:close] != b"\n":
        new = b"\n" + new
    return data[:close] + new + data[close:]


def remove_overrides(data, parts):
    """Drop ``<Override>`` elements for parts that are being deleted."""
    if data is None:
        return None
    gone = {("/" + p).lower() for p in parts}
    for m, kind, values in reversed(_types_elems(data)):
        if kind == b"Override" and values.get("PartName", "").lower() in gone:
            data = data[:m.start()] + data[m.end():]
    return data


def _set_meta(entries, name, value):
    """Update every entry called *name* (or drop them when value is None);
    append one if absent.  Returns the new list."""
    if value is None:
        return [e for e in entries if e.name != name]
    found = False
    for e in entries:
        if e.name == name:
            e.value = value
            found = True
    if not found:
        entries.append(xmlmeta.Entry(name, value))
    return entries


# --- Bambu/Orca model_settings.config object names ---------------------------

def parse_config_names(data: bytes):
    """Return [{key, label, name, span}] for every editable name in the
    Bambu/Orca settings config, where *span* is the byte range of the quoted
    attribute value so we can patch precisely."""
    items = []
    obj_id = None
    part_id = None
    stack = []
    for m in _TAG_RE.finditer(data):
        closing, tag, attrs = m.group(1), m.group(2), m.group(3)
        if tag == b"metadata":
            km = _KEY_ATTR_RE.search(attrs)
            if not km or km.group(1) != b"name":
                continue
            vm = _VALUE_ATTR_RE.search(attrs)
            if not vm:
                continue
            scope = stack[-1] if stack else None
            start = m.start(3) + vm.start(1)
            end = m.start(3) + vm.end(1)
            if scope == b"object" and obj_id is not None:
                items.append({"key": "object:%s" % obj_id.decode(),
                              "label": "Object %s" % obj_id.decode(),
                              "name": xmlmeta.unescape(vm.group(1)),
                              "span": (start, end)})
            elif scope == b"part" and obj_id is not None:
                pid = (part_id or b"?").decode()
                items.append({"key": "part:%s:%s" % (obj_id.decode(), pid),
                              "label": "  Part %s" % pid,
                              "name": xmlmeta.unescape(vm.group(1)),
                              "span": (start, end)})
            continue

        if closing:
            if stack and stack[-1] == tag:
                stack.pop()
            if tag == b"object":
                obj_id = None
            elif tag == b"part":
                part_id = None
            continue

        if attrs.rstrip().endswith(b"/"):
            continue  # self-closing, no scope change
        stack.append(tag)
        idm = _ID_ATTR_RE.search(attrs)
        if tag == b"object":
            obj_id = idm.group(1) if idm else None
        elif tag == b"part":
            part_id = idm.group(1) if idm else None
    return items


def patch_config_names(data: bytes, renames: dict) -> bytes:
    items = parse_config_names(data)
    edits = []
    for item in items:
        if item["key"] in renames:
            new = str(renames[item["key"]])
            edits.append((item["span"], xmlmeta.escape_attr(new)))
    for (start, end), repl in sorted(edits, key=lambda e: -e[0][0]):
        data = data[:start] + repl + data[end:]
    return data


class ThreeMF(Handler):
    name = "3mf"
    extensions = (".3mf",)

    def sniff(self, path, head):
        return (os.path.splitext(path)[1].lower() == ".3mf"
                and head[:2] == b"PK")

    # --- read ---------------------------------------------------------------
    def read(self, path):
        with zipfile.ZipFile(path) as z:
            part = _model_part(z)
            info = z.getinfo(part)
            with z.open(part) as f:
                window = f.read(xmlmeta.HEADER_WINDOW)
            region = xmlmeta.parse(window, "model", "name")

            names = set(z.namelist())
            bambu = "Metadata/model_settings.config" in names
            rels = _rels(z)
            bambu_pkg = _is_bambu(names, region.entries, rels)
            opc_part = _rel_target(rels, THUMB_REL, names)
            if bambu_pkg:
                cover_custom = any(p in names for p in AUX_PARTS)
                cover = _rel_target(rels, BAMBU_MIDDLE_REL, names) or opc_part
            else:
                cover_custom = opc_part is not None
                cover = opc_part

            fields = {}
            for key, candidates in ALIASES.items():
                for cand in candidates:
                    for entry in region.entries:
                        if entry.name == cand and entry.value:
                            fields[key] = entry.value
                            break
                    if key in fields:
                        break
                fields.setdefault(key, "")

            custom = [{"name": e.name, "value": e.value}
                      for e in region.entries if e.name not in KNOWN_NAMES]

            objects = []
            if bambu:
                cfg = z.read("Metadata/model_settings.config")
                objects = [{"id": it["key"], "label": it["label"],
                            "name": it["name"]}
                           for it in parse_config_names(cfg)]

            notes = []
            if bambu:
                notes.append(
                    "Bambu Studio / OrcaSlicer project detected: object and "
                    "part names below are the ones shown in the slicer.")
            if info.file_size >= BIG_PART:
                notes.append(
                    "The model part is %s of XML. Saving has to rewrite the "
                    "whole archive, so expect it to take a little while."
                    % human(info.file_size))

            detail = {
                "Package entries": str(len(names)),
                "Model part": part,
                "Model part size": human(info.file_size),
                "File size": human(os.path.getsize(path)),
                "Cover image": cover or "none",
            }
            return Meta(
                fmt="3MF",
                fields=fields,
                custom=custom,
                objects=objects,
                notes=notes,
                info=detail,
                has_thumbnail=self._thumb_part(z) is not None,
                custom_supported=True,
                recompress=True,
                thumbnail_editable=True,
                thumbnail_custom=cover_custom,
                thumbnail_kind="bambu" if bambu_pkg else "generic",
            )

    def _thumb_part(self, z):
        part = _find_part(z, THUMB_REL)
        if part:
            return part
        names = z.namelist()
        for cand in ("Metadata/plate_1.png", "Metadata/thumbnail.png",
                     "Metadata/top_1.png", "thumbnail.png"):
            if cand in names:
                return cand
        for name in names:
            if name.lower().endswith((".png", ".jpg", ".jpeg")):
                return name
        return None

    def thumbnail(self, path):
        with zipfile.ZipFile(path) as z:
            part = self._thumb_part(z)
            if not part:
                return None
            data = z.read(part)
        mime = "image/png" if part.lower().endswith(".png") else "image/jpeg"
        return mime, data

    # --- write --------------------------------------------------------------
    def write(self, path, patch, progress=None, backup=True, fast=False):
        with zipfile.ZipFile(path) as z:
            part = _model_part(z)
            part_info = z.getinfo(part)
            with z.open(part) as f:
                window = f.read(xmlmeta.HEADER_WINDOW)
            region = xmlmeta.parse(window, "model", "name")
            names = set(z.namelist())
            bambu = "Metadata/model_settings.config" in names

            # decided from the file as it is, before any field edits
            bambu_pkg = _is_bambu(names, region.entries, _rels(z))
            entries = list(region.entries)
            self._apply_fields(entries, patch.fields, bambu)
            if patch.custom is not None:
                entries = [e for e in entries if e.name in KNOWN_NAMES]
                for item in patch.custom:
                    cname = (item.get("name") or "").strip()
                    if cname:
                        entries.append(
                            xmlmeta.Entry(cname, item.get("value") or ""))

            replacements = {}
            adds = {}       # part name -> bytes (replaces or appends)
            deletes = set()
            if patch.thumbnail is not None:
                # After the custom-list replacement on purpose: the UI's list
                # still carries the old Thumbnail_Middle value.
                entries = self._plan_thumbnail(z, names, part, bambu_pkg,
                                               entries, patch.thumbnail,
                                               replacements, adds, deletes)
            new_window = xmlmeta.apply(region, entries, "name")

            if patch.objects and bambu:
                cfg = z.read("Metadata/model_settings.config")
                replacements["Metadata/model_settings.config"] = \
                    patch_config_names(cfg, patch.objects)

            infos = z.infolist()
            total = (sum(i.file_size for i in infos)
                     + sum(len(v) for v in adds.values())) or 1
            level = 1 if (fast and part_info.file_size >= BIG_PART) else 6

            if backup:
                report(progress, 0.0, "Backing up original")
                backup_once(path)

            report(progress, 0.02, "Rewriting package")
            with AtomicWrite(path) as out:
                with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED,
                                     allowZip64=True, compresslevel=level) as zout:
                    written = 0
                    for info in infos:
                        if info.filename in deletes:
                            written += info.file_size
                            continue
                        zi = _clone_info(info, level)
                        if info.filename in adds:
                            data = adds.pop(info.filename)
                            zi.date_time = time.localtime()[:6]
                            zi.compress_type = zipfile.ZIP_STORED
                            zout.writestr(zi, data)
                            written += len(data)
                            continue
                        if info.is_dir():
                            zout.writestr(zi, b"")
                            continue
                        if info.filename == part:
                            with z.open(info) as src, \
                                    zout.open(zi, "w", force_zip64=True) as dst:
                                src.read(len(window))  # skip the old header
                                dst.write(new_window)
                                _pump(src, dst, progress, written, total,
                                      info.file_size - len(window),
                                      "Rewriting %s" % info.filename)
                        elif info.filename in replacements:
                            zout.writestr(zi, replacements[info.filename])
                        else:
                            with z.open(info) as src, \
                                    zout.open(zi, "w", force_zip64=True) as dst:
                                _pump(src, dst, progress, written, total,
                                      info.file_size, None)
                        written += info.file_size
                        report(progress, 0.02 + 0.96 * (written / total))
                    for name, data in adds.items():
                        zi = zipfile.ZipInfo(name,
                                             date_time=time.localtime()[:6])
                        zi.external_attr = 0o644 << 16
                        # images go in stored, like Bambu's plate PNGs
                        zi.compress_type = (zipfile.ZIP_STORED
                                            if name.lower().endswith(".png")
                                            else zipfile.ZIP_DEFLATED)
                        zout.writestr(zi, data)
                        written += len(data)
                        report(progress, 0.02 + 0.96 * (written / total))
                # Windows cannot replace an archive while its source handle is open.
                z.close()
        report(progress, 1.0, "Saved")

    def _plan_thumbnail(self, z, names, model_part, bambu_pkg, entries, thumb,
                        replacements, adds, deletes):
        """Work out every package change for a cover-image set/remove.
        Fills *replacements*, *adds* and *deletes*; returns the new metadata
        entry list."""
        rels = _rels(z)
        rels_raw = z.read(RELS) if RELS in names else None
        types_raw = z.read(CTYPES) if CTYPES in names else None
        action = thumb.get("action")

        if action == "set":
            large, small = thumb["large"], thumb.get("small") or thumb["large"]
            if bambu_pkg:
                adds.update({AUX_COVER: large, AUX_MIDDLE: large,
                             AUX_SMALL: small})
                wanted = {THUMB_REL: AUX_COVER, BAMBU_MIDDLE_REL: AUX_MIDDLE,
                          BAMBU_SMALL_REL: AUX_SMALL}
                # Bambu's exporter prefers these over the rels when it
                # re-saves, so they must point at our cover too.
                entries = _set_meta(entries, "Thumbnail_Middle",
                                    "/" + AUX_MIDDLE)
                entries = _set_meta(entries, "Thumbnail_Small",
                                    "/" + AUX_SMALL)
            else:
                adds[PLAIN_THUMB] = large
                wanted = {THUMB_REL: PLAIN_THUMB}
            new_types = ensure_png_type(types_raw, list(adds))
        elif action == "remove":
            if bambu_pkg:
                present = [p for p in AUX_PARTS if p in names]
                if not present:
                    raise MetaError("There is no embedded image to remove.")
                deletes.update(present)
                plate = BAMBU_PLATE if BAMBU_PLATE in names else None
                plate_small = (BAMBU_PLATE_SMALL
                               if BAMBU_PLATE_SMALL in names else None)
                # exactly what Bambu writes when a project has no cover
                wanted = {THUMB_REL: plate, BAMBU_MIDDLE_REL: plate,
                          BAMBU_SMALL_REL: plate_small}
                for key, target in (("Thumbnail_Middle", plate),
                                    ("Thumbnail_Small", plate_small)):
                    if any(e.name == key for e in entries):
                        entries = _set_meta(entries, key,
                                            "/" + target if target else None)
            else:
                target = _rel_target(rels, THUMB_REL, names)
                if not target:
                    raise MetaError("There is no embedded image to remove.")
                if target != model_part:
                    deletes.add(target)
                wanted = {THUMB_REL: None}
            new_types = remove_overrides(types_raw, deletes)
        else:
            raise MetaError("Unknown thumbnail action.")

        new_rels = set_relationships(rels_raw, wanted, model_part)
        for name, raw, new in ((RELS, rels_raw, new_rels),
                               (CTYPES, types_raw, new_types)):
            if raw is None:
                if new is not None:
                    adds[name] = new
            elif new != raw:
                replacements[name] = new
        return entries

    def _apply_fields(self, entries, patch_fields, bambu):
        for key, raw in patch_fields.items():
            if key not in ALIASES:
                continue
            value = "" if raw is None else str(raw).strip()
            existing = [e for e in entries if e.name in ALIASES[key]]
            if existing:
                for e in existing:
                    e.value = value
            elif value:
                primary = ALIASES[key][0]
                if key == "license" and bambu:
                    primary = "License"
                entries.append(xmlmeta.Entry(primary, value))


def _clone_info(info, level=None):
    """Copy an entry's identity so the rewritten package keeps the same names,
    timestamps, permissions and per-entry compression method."""
    zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
    zi.compress_type = info.compress_type
    # zipfile substitutes 0o600 when external_attr is 0, which would make
    # extracted files owner-only; 0o644 matches what slicers produce.
    zi.external_attr = info.external_attr or (0o644 << 16)
    zi.internal_attr = info.internal_attr
    zi.create_system = info.create_system
    zi.comment = info.comment
    # zipfile only honours the level recorded on the ZipInfo when writing
    # through an explicit ZipInfo, not the ZipFile-wide setting.
    zi._compresslevel = level
    return zi


def _pump(src, dst, progress, base_bytes, total, expect, message):
    moved = 0
    while True:
        buf = src.read(CHUNK)
        if not buf:
            break
        dst.write(buf)
        moved += len(buf)
        if total:
            report(progress, 0.02 + 0.96 * ((base_bytes + moved) / total),
                   message)
    return moved

