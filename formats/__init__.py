"""Format handler registry."""

from __future__ import annotations

import os

from .base import (FIELD_KEYS, FIELD_LABELS, FIELD_SCHEMA, Meta, MetaError,
                   Patch, human)
from .amf import Amf
from .stl import Stl
from .textmeta import Obj, Ply
from .threemf import ThreeMF

HANDLERS = [ThreeMF(), Stl(), Obj(), Ply(), Amf()]

EXTENSIONS = sorted({ext for h in HANDLERS for ext in h.extensions})


def detect(path):
    """Return the handler for *path*, or None if the format is unsupported."""
    ext = os.path.splitext(path)[1].lower()
    candidates = [h for h in HANDLERS if ext in h.extensions]
    if not candidates:
        return None
    try:
        with open(path, "rb") as f:
            head = f.read(4096)
    except OSError as exc:
        raise MetaError("Could not read %s: %s" % (os.path.basename(path), exc))
    for handler in candidates:
        if handler.sniff(path, head):
            return handler
    return candidates[0]


def read(path):
    handler = detect(path)
    if handler is None:
        raise MetaError("%s is not a supported model format. Supported: %s"
                        % (os.path.basename(path), ", ".join(EXTENSIONS)))
    return handler.read(path)


def write(path, patch, progress=None, backup=True, fast=False):
    handler = detect(path)
    if handler is None:
        raise MetaError("%s is not a supported model format."
                        % os.path.basename(path))
    handler.write(path, patch, progress=progress, backup=backup, fast=fast)


def thumbnail(path):
    handler = detect(path)
    if handler is None:
        return None
    return handler.thumbnail(path)
