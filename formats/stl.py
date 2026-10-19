"""STL handler.

STL has no real metadata section.  What it does have:

* Binary STL: a fixed 80-byte header before the triangle count.  It is free
  text, so we pack ``Key=Value`` pairs into it and parse them back out.  Only
  80 bytes exist, which the UI surfaces as a live budget.
* ASCII STL: the name on the ``solid`` / ``endsolid`` lines.

Binary header edits are done in place with a single 80-byte write, so retagging
a 237 MB mesh is instant rather than a full file rewrite.
"""

from __future__ import annotations

import os
import struct

from .base import (AtomicWrite, Handler, Meta, MetaError, backup_once,
                   copy_stream, human, report)

HEADER_SIZE = 80
PACK_KEYS = [("title", "Title"), ("designer", "Designer"),
             ("copyright", "Copyright"), ("license", "License")]
PACK_LABELS = {label: key for key, label in PACK_KEYS}
SEP = ";"


def is_binary(path):
    size = os.path.getsize(path)
    if size < HEADER_SIZE + 4:
        return False
    with open(path, "rb") as f:
        head = f.read(HEADER_SIZE + 4)
    count = struct.unpack("<I", head[HEADER_SIZE:HEADER_SIZE + 4])[0]
    if size == HEADER_SIZE + 4 + count * 50:
        return True
    # Some writers append junk; trust the ASCII marker only if the count maths
    # does not work out.
    return not head[:5].lower().startswith(b"solid")


def pack_header(fields) -> bytes:
    parts = []
    for key, label in PACK_KEYS:
        value = (fields.get(key) or "").strip()
        if value:
            parts.append("%s=%s" % (label, value.replace(SEP, ",")))
    text = SEP.join(parts)
    raw = text.encode("utf-8")[:HEADER_SIZE]
    # Never leave a partial multi-byte character at the cut.
    while raw:
        try:
            raw.decode("utf-8")
            break
        except UnicodeDecodeError:
            raw = raw[:-1]
    return raw.ljust(HEADER_SIZE, b"\0")


def unpack_header(raw: bytes):
    text = raw.rstrip(b"\0").rstrip().decode("utf-8", "replace").strip()
    fields = {}
    if not text:
        return fields, False
    chunks = [c.strip() for c in text.split(SEP)]
    structured = False
    leftovers = []
    for chunk in chunks:
        if "=" in chunk:
            label, _, value = chunk.partition("=")
            key = PACK_LABELS.get(label.strip())
            if key:
                fields[key] = value.strip()
                structured = True
                continue
        leftovers.append(chunk)
    if leftovers and "title" not in fields:
        fields["title"] = SEP.join(leftovers).strip()
    elif leftovers:
        fields["title"] = (fields.get("title", "") + " " +
                           SEP.join(leftovers)).strip()
    return fields, structured


class Stl(Handler):
    name = "stl"
    extensions = (".stl",)

    def read(self, path):
        size = os.path.getsize(path)
        if is_binary(path):
            with open(path, "rb") as f:
                raw = f.read(HEADER_SIZE)
                count = struct.unpack("<I", f.read(4))[0]
            fields, structured = unpack_header(raw)
            used = len(pack_header(fields).rstrip(b"\0"))
            notes = [
                "Binary STL stores metadata in an 80-byte header, so the "
                "fields below share one small budget.",
            ]
            if raw.strip(b"\0").strip() and not structured:
                notes.append(
                    "The existing header was free-form text, so it has been "
                    "loaded into Title. Check it before saving.")
            return Meta(
                fmt="STL (binary)",
                fields=fields,
                editable=[k for k, _ in PACK_KEYS],
                notes=notes,
                info={"Triangles": "{:,}".format(count),
                      "File size": human(size),
                      "Header in use": "%d of %d bytes" % (used, HEADER_SIZE)},
                byte_budget=HEADER_SIZE,
            )

        name, _, _ = _ascii_solid_name(path)
        return Meta(
            fmt="STL (ASCII)",
            fields={"title": name},
            editable=["title"],
            notes=["ASCII STL only has room for the solid name, so Title is "
                   "the single editable field. Convert to binary STL if you "
                   "need designer or licence tags."],
            info={"File size": human(size)},
        )

    def write(self, path, patch, progress=None, backup=True, fast=False):
        if is_binary(path):
            current, _ = unpack_header(_read_header(path))
            merged = dict(current)
            for key, _label in PACK_KEYS:
                if key in patch.fields:
                    merged[key] = (patch.fields[key] or "").strip()
            packed = pack_header(merged)
            wanted = SEP.join(
                "%s=%s" % (label, merged[key]) for key, label in PACK_KEYS
                if merged.get(key)).encode("utf-8")
            if len(wanted) > HEADER_SIZE:
                raise MetaError(
                    "Those values need %d bytes but a binary STL header only "
                    "holds %d. Shorten them by %d characters."
                    % (len(wanted), HEADER_SIZE, len(wanted) - HEADER_SIZE))
            if backup:
                report(progress, 0.0, "Backing up original")
                backup_once(path)
            report(progress, 0.5, "Writing header")
            with open(path, "r+b") as f:
                f.seek(0)
                f.write(packed)
                f.flush()
                os.fsync(f.fileno())
            report(progress, 1.0, "Saved")
            return

        if "title" not in patch.fields:
            report(progress, 1.0, "Nothing to change")
            return
        self._write_ascii(path, (patch.fields["title"] or "").strip(),
                          progress, backup)

    def _write_ascii(self, path, new_name, progress, backup):
        _name, first_line_end, newline = _ascii_solid_name(path)
        size = os.path.getsize(path)
        if backup:
            report(progress, 0.0, "Backing up original")
            backup_once(path)

        tail_window = min(4096, size)
        with open(path, "rb") as f:
            f.seek(size - tail_window)
            tail = f.read(tail_window)
        idx = tail.rfind(b"endsolid")
        tail_start = size - tail_window + idx if idx >= 0 else None
        if tail_start is not None and tail_start <= first_line_end:
            tail_start = None

        head_line = b"solid " + new_name.encode("utf-8") if new_name else b"solid"
        report(progress, 0.05, "Rewriting file")
        with AtomicWrite(path) as dst, open(path, "rb") as src:
            src.seek(first_line_end)
            dst.write(head_line + newline)
            body = (tail_start - first_line_end) if tail_start is not None \
                else (size - first_line_end)
            copy_stream(src, dst, remaining=body, progress=progress,
                        base=0.05, span=0.9, total=max(body, 1))
            if tail_start is not None:
                end_line = b"endsolid " + new_name.encode("utf-8") \
                    if new_name else b"endsolid"
                dst.write(end_line + newline)
        report(progress, 1.0, "Saved")


def _read_header(path):
    with open(path, "rb") as f:
        return f.read(HEADER_SIZE)


def _ascii_solid_name(path):
    """Return (name, offset just past the first line, newline bytes)."""
    with open(path, "rb") as f:
        chunk = f.read(4096)
    nl = chunk.find(b"\n")
    if nl < 0:
        raise MetaError("This ASCII STL has no line breaks; refusing to edit.")
    line = chunk[:nl]
    newline = b"\r\n" if line.endswith(b"\r") else b"\n"
    line = line.rstrip(b"\r")
    text = line.decode("utf-8", "replace").strip()
    name = text[5:].strip() if text.lower().startswith("solid") else ""
    return name, nl + 1, newline

