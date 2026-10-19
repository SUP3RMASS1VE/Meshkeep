"""Shared plumbing for model-file metadata handlers.

A handler knows how to read and write the "authorship" metadata of one family
of 3D-print file formats.  Every handler exposes the same normalised field
names so the UI can stay generic.

Design constraint: model files are routinely hundreds of megabytes.  Nothing in
here may load a whole file into memory.  Handlers read a bounded header window
and, when writing, stream the untouched remainder through in chunks.
"""

from __future__ import annotations

import os
import shutil
import struct
import tempfile

# --- normalised field schema -------------------------------------------------
# (key, label, hint)  -- order here is the order shown in the UI.
FIELD_SCHEMA = [
    ("title", "Title / model name", "The name of the model itself"),
    ("designer", "Designer / creator", "Who made it"),
    ("description", "Description", ""),
    ("copyright", "Copyright", ""),
    ("license", "License", "e.g. CC-BY-4.0"),
    ("application", "Application", "Software that produced the file"),
    ("origin", "Origin / source", "Where it came from, e.g. a URL"),
    ("rating", "Rating", ""),
    ("creation_date", "Created", ""),
    ("modification_date", "Modified", ""),
]

FIELD_KEYS = [key for key, _label, _hint in FIELD_SCHEMA]
FIELD_LABELS = {key: label for key, label, _hint in FIELD_SCHEMA}

CHUNK = 1 << 20  # 1 MiB streaming chunk


class MetaError(Exception):
    """A problem the user can act on; surfaced verbatim in the UI."""


class Meta:
    """The result of reading one file."""

    def __init__(self, fmt, fields=None, custom=None, objects=None,
                 editable=None, notes=None, info=None, has_thumbnail=False,
                 custom_supported=False, byte_budget=None, recompress=False,
                 thumbnail_editable=False, thumbnail_custom=False,
                 thumbnail_kind=None):
        self.fmt = fmt
        self.fields = dict(fields or {})
        # custom: list of {"name": str, "value": str}
        self.custom = list(custom or [])
        # objects: list of {"id": str, "name": str}
        self.objects = list(objects or [])
        # which normalised keys this file can actually store
        self.editable = list(editable if editable is not None else FIELD_KEYS)
        self.notes = list(notes or [])
        self.info = dict(info or {})
        self.has_thumbnail = has_thumbnail
        self.custom_supported = custom_supported
        # for fixed-size headers (binary STL): total bytes available
        self.byte_budget = byte_budget
        # True when saving re-compresses the payload, so trading size for
        # speed is a meaningful choice
        self.recompress = recompress
        # True when the file can carry a user-chosen cover image (3MF only)
        self.thumbnail_editable = thumbnail_editable
        # True when the current cover is one this app (or MakerWorld) put in,
        # as opposed to the slicer's own plate render
        self.thumbnail_custom = thumbnail_custom
        # "bambu" (Bambu Studio / OrcaSlicer cover conventions), "generic"
        # (Metadata/thumbnail.png) or None when not editable
        self.thumbnail_kind = thumbnail_kind

    def as_dict(self):
        return {
            "format": self.fmt,
            "fields": {k: self.fields.get(k, "") for k in FIELD_KEYS},
            "custom": self.custom,
            "objects": self.objects,
            "editable": self.editable,
            "customSupported": self.custom_supported,
            "objectsEditable": bool(self.objects),
            "notes": self.notes,
            "info": self.info,
            "hasThumbnail": self.has_thumbnail,
            "byteBudget": self.byte_budget,
            "recompress": self.recompress,
            "thumbnailEditable": self.thumbnail_editable,
            "thumbnailCustom": self.thumbnail_custom,
            "thumbnailKind": self.thumbnail_kind,
        }


class Patch:
    """A requested edit.  Only keys present are touched."""

    def __init__(self, fields=None, custom=None, objects=None, thumbnail=None):
        self.fields = dict(fields or {})
        self.custom = custom  # None = leave alone; list = replace wholesale
        self.objects = dict(objects or {})  # id -> new name
        # None = leave alone;
        # {"action": "set", "large": png bytes, "small": png bytes};
        # {"action": "remove"}
        self.thumbnail = thumbnail

    def is_empty(self):
        return (not self.fields and self.custom is None and not self.objects
                and self.thumbnail is None)


class Handler:
    """Interface implemented by every format handler."""

    name = "?"
    extensions = ()

    def sniff(self, path, head):
        """Return True if this handler owns *path*.  *head* is the first 4 KiB."""
        return os.path.splitext(path)[1].lower() in self.extensions

    def read(self, path):
        raise NotImplementedError

    def write(self, path, patch, progress=None):
        raise NotImplementedError

    def thumbnail(self, path):
        """Return (mime, bytes) or None."""
        return None


# --- helpers ----------------------------------------------------------------

def report(progress, frac, message=None):
    if progress is not None:
        progress(max(0.0, min(1.0, frac)), message)


def copy_stream(src, dst, remaining=None, progress=None, base=0.0, span=1.0,
                total=None):
    """Copy src -> dst in bounded chunks, reporting progress as it goes."""
    done = 0
    while True:
        want = CHUNK if remaining is None else min(CHUNK, remaining - done)
        if want <= 0:
            break
        buf = src.read(want)
        if not buf:
            break
        dst.write(buf)
        done += len(buf)
        if total:
            report(progress, base + span * (done / total))
    return done


def backup_once(path):
    """Create path.bak if it does not already exist.  Returns the backup path
    or None.  Never overwrites an existing backup, so the very first original
    is what you get back."""
    bak = path + ".bak"
    if os.path.exists(bak):
        return None
    tmp = bak + ".partial"
    shutil.copy2(path, tmp)
    os.replace(tmp, bak)
    return bak


class AtomicWrite:
    """Write to a sibling temp file, then swap it in.  On any exception the
    original file is left completely untouched."""

    def __init__(self, path):
        self.path = path
        self.tmp = None
        self._fh = None

    def __enter__(self):
        d = os.path.dirname(os.path.abspath(self.path)) or "."
        fd, self.tmp = tempfile.mkstemp(
            prefix=os.path.basename(self.path) + ".", suffix=".tmp", dir=d)
        os.close(fd)
        self._fh = open(self.tmp, "wb")
        return self._fh

    def __exit__(self, exc_type, exc, tb):
        try:
            if self._fh:
                self._fh.flush()
                os.fsync(self._fh.fileno())
                self._fh.close()
        finally:
            if exc_type is None:
                try:
                    st = os.stat(self.path)
                except OSError:
                    st = None
                os.replace(self.tmp, self.path)
                if st is not None:
                    try:
                        os.chmod(self.path, st.st_mode & 0o7777)
                    except OSError:
                        pass
            elif self.tmp and os.path.exists(self.tmp):
                os.unlink(self.tmp)
        return False


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def png_size(data: bytes):
    """Return (width, height) of a PNG, or raise MetaError if *data* is not
    one.  Only the signature and IHDR chunk are checked."""
    if (len(data) < 24 or data[:8] != PNG_SIGNATURE
            or data[12:16] != b"IHDR"):
        raise MetaError("The image is not a valid PNG.")
    width, height = struct.unpack(">II", data[16:24])
    if not width or not height:
        raise MetaError("The image is not a valid PNG.")
    return width, height


def human(n):
    """Human-readable byte count."""
    n = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return "%d B" % n if unit == "B" else "%.1f %s" % (n, unit)
        n /= 1024.0
