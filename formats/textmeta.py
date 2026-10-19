"""OBJ and PLY handlers.

Neither format has a metadata schema, but both have a comment convention that
every tool in the wild respects:

* OBJ: ``#`` comment lines at the top of the file.
* PLY: ``comment`` lines inside the header, before ``end_header``.

So metadata is stored as ``Key: Value`` comments.  Bodies can be huge (and PLY
bodies may be binary), so only the header is decoded; the rest is streamed
through untouched.
"""

from __future__ import annotations

import os

from .base import (AtomicWrite, Handler, Meta, MetaError, backup_once,
                   copy_stream, human, report)

# normalised key -> comment label
LABELS = [
    ("title", "Title"),
    ("designer", "Designer"),
    ("description", "Description"),
    ("copyright", "Copyright"),
    ("license", "License"),
    ("application", "Application"),
    ("origin", "Origin"),
]
LABEL_TO_KEY = {label.lower(): key for key, label in LABELS}
KEY_TO_LABEL = dict(LABELS)
EDITABLE = [key for key, _ in LABELS]
HEADER_LIMIT = 1 << 20


def _split_kv(text):
    if ":" not in text:
        return None, None
    label, _, value = text.partition(":")
    return label.strip(), value.strip()


def _parse_comments(comments):
    """comments: list of comment payload strings (the text after the marker)."""
    fields, custom, raw = {}, [], []
    for text in comments:
        label, value = _split_kv(text)
        if label is None or not label:
            raw.append(text)
            continue
        key = LABEL_TO_KEY.get(label.lower())
        if key:
            fields[key] = value
        else:
            custom.append({"name": label, "value": value})
    return fields, custom, raw


def _render_comments(fields, custom, raw):
    out = []
    for key, label in LABELS:
        value = (fields.get(key) or "").strip()
        if value:
            out.append("%s: %s" % (label, value))
    for item in custom or []:
        name = (item.get("name") or "").strip()
        if name:
            out.append("%s: %s" % (name, (item.get("value") or "").strip()))
    out.extend(raw)
    return out


def _merge(current, patch_fields):
    merged = dict(current)
    for key in EDITABLE:
        if key in patch_fields:
            merged[key] = (patch_fields[key] or "").strip()
    return merged


class Obj(Handler):
    name = "obj"
    extensions = (".obj",)

    def read(self, path):
        comments, offset, newline = _read_obj_header(path)
        fields, custom, raw = _parse_comments(comments)
        return Meta(
            fmt="OBJ",
            fields=fields,
            custom=custom,
            editable=EDITABLE,
            custom_supported=True,
            notes=["OBJ has no metadata standard, so values are stored as "
                   "'# Key: Value' comment lines at the top of the file. Most "
                   "tools preserve and display them."],
            info={"File size": human(os.path.getsize(path)),
                  "Header comment lines": str(len(comments))},
        )

    def write(self, path, patch, progress=None, backup=True, fast=False):
        comments, offset, newline = _read_obj_header(path)
        fields, custom, raw = _parse_comments(comments)
        merged = _merge(fields, patch.fields)
        new_custom = patch.custom if patch.custom is not None else custom
        lines = _render_comments(merged, new_custom, raw)
        block = b"".join(("# " + line).encode("utf-8") + newline
                         for line in lines)
        _rewrite_head(path, offset, block, progress, backup)


class Ply(Handler):
    name = "ply"
    extensions = (".ply",)

    def read(self, path):
        header, offset, newline = _read_ply_header(path)
        comments = [payload for kind, payload in header if kind == "comment"]
        fields, custom, raw = _parse_comments(comments)
        fmt_line = next((p for k, p in header if k == "format"), "")
        return Meta(
            fmt="PLY",
            fields=fields,
            custom=custom,
            editable=EDITABLE,
            custom_supported=True,
            notes=["PLY stores values as 'comment Key: Value' lines in the "
                   "header. The mesh data itself is untouched."],
            info={"File size": human(os.path.getsize(path)),
                  "Encoding": fmt_line or "unknown"},
        )

    def write(self, path, patch, progress=None, backup=True, fast=False):
        header, offset, newline = _read_ply_header(path)
        comments = [payload for kind, payload in header if kind == "comment"]
        fields, custom, raw = _parse_comments(comments)
        merged = _merge(fields, patch.fields)
        new_custom = patch.custom if patch.custom is not None else custom
        rendered = _render_comments(merged, new_custom, raw)

        lines = []
        inserted = False
        for kind, payload in header:
            if kind == "comment":
                continue
            lines.append(payload)
            # Comments have to come after 'format' to stay spec-legal.
            if kind == "format" and not inserted:
                lines.extend("comment " + c for c in rendered)
                inserted = True
        if not inserted:
            lines.extend("comment " + c for c in rendered)
        lines.append("end_header")
        block = b"".join(line.encode("utf-8") + newline for line in lines)
        _rewrite_head(path, offset, block, progress, backup)


# --- header parsing ----------------------------------------------------------

def _detect_newline(buf):
    nl = buf.find(b"\n")
    if nl > 0 and buf[nl - 1:nl] == b"\r":
        return b"\r\n"
    return b"\n"


def _read_obj_header(path):
    """Return (comment payloads, byte offset of the first non-comment line,
    newline style)."""
    with open(path, "rb") as f:
        buf = f.read(HEADER_LIMIT)
    newline = _detect_newline(buf)
    comments = []
    offset = 0
    while offset < len(buf):
        nl = buf.find(b"\n", offset)
        end = len(buf) if nl < 0 else nl + 1
        line = buf[offset:end]
        stripped = line.strip()
        if stripped.startswith(b"#"):
            comments.append(stripped[1:].strip().decode("utf-8", "replace"))
        elif stripped == b"":
            # A blank line inside the leading block is dropped on rewrite.
            pass
        else:
            break
        offset = end
        if nl < 0:
            break
    return comments, offset, newline


def _read_ply_header(path):
    with open(path, "rb") as f:
        buf = f.read(HEADER_LIMIT)
    if not buf.startswith(b"ply"):
        raise MetaError("This does not look like a PLY file (no 'ply' magic).")
    end = buf.find(b"end_header")
    if end < 0:
        raise MetaError("PLY header is missing 'end_header'.")
    nl = buf.find(b"\n", end)
    if nl < 0:
        raise MetaError("PLY header is truncated.")
    newline = _detect_newline(buf)
    header_bytes = buf[:end]
    entries = []
    for raw_line in header_bytes.split(b"\n"):
        line = raw_line.rstrip(b"\r").decode("utf-8", "replace")
        if not line.strip():
            continue
        first = line.split(None, 1)[0].lower()
        if first == "comment":
            entries.append(("comment", line.split(None, 1)[1].strip()
                            if len(line.split(None, 1)) > 1 else ""))
        elif first == "format":
            entries.append(("format", line))
        else:
            entries.append((first, line))
    return entries, nl + 1, newline


def _rewrite_head(path, old_offset, new_block, progress, backup):
    """Replace the first *old_offset* bytes of the file with *new_block*."""
    size = os.path.getsize(path)
    if backup:
        report(progress, 0.0, "Backing up original")
        backup_once(path)
    body = size - old_offset
    report(progress, 0.05, "Rewriting file")
    with AtomicWrite(path) as dst, open(path, "rb") as src:
        dst.write(new_block)
        src.seek(old_offset)
        copy_stream(src, dst, remaining=body, progress=progress, base=0.05,
                    span=0.94, total=max(body, 1))
    report(progress, 1.0, "Saved")

