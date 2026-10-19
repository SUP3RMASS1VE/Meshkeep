"""Byte-accurate patching of the ``<metadata>`` block at the top of an XML
model document (3MF's 3dmodel.model and AMF both follow this shape).

Everything works on ``bytes`` rather than ``str`` on purpose: a 3dmodel.model
can be 400 MB, so we only ever look at a bounded window from the start of the
document, and byte offsets into that window have to stay exact.  Decoding to
text with error replacement would shift them.
"""

from __future__ import annotations

import re

from .base import MetaError

# How much of the document we pull in to find the metadata block.  Per both the
# 3MF and AMF specs metadata are the first children of the root element, so
# this is generous by orders of magnitude.
HEADER_WINDOW = 4 << 20

_ATTR_RE = re.compile(rb"""([A-Za-z_:][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)')""")


def _tag_end(buf, start):
    """Index just past the '>' of the tag beginning at *start*, honouring
    quoted attribute values (XML permits a bare '>' inside them)."""
    i = start + 1
    quote = None
    n = len(buf)
    while i < n:
        c = buf[i:i + 1]
        if quote:
            if c == quote:
                quote = None
        elif c in (b'"', b"'"):
            quote = c
        elif c == b">":
            return i + 1
        i += 1
    return -1


def _skip_ignorable(buf, i):
    """Advance past whitespace, comments, PIs and doctype declarations."""
    n = len(buf)
    while i < n:
        while i < n and buf[i:i + 1] in b" \t\r\n":
            i += 1
        if buf.startswith(b"<!--", i):
            end = buf.find(b"-->", i)
            if end < 0:
                return -1
            i = end + 3
        elif buf.startswith(b"<?", i):
            end = buf.find(b"?>", i)
            if end < 0:
                return -1
            i = end + 2
        elif buf.startswith(b"<!", i):
            end = _tag_end(buf, i)
            if end < 0:
                return -1
            i = end
        else:
            return i
    return -1


def unescape(raw: bytes) -> str:
    text = raw.decode("utf-8", "replace")
    # Numeric references first so a literal "&#38;" round-trips sanely.
    text = re.sub(r"&#x([0-9a-fA-F]+);", lambda m: chr(int(m.group(1), 16)), text)
    text = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), text)
    for ent, ch in (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'),
                    ("&apos;", "'"), ("&amp;", "&")):
        text = text.replace(ent, ch)
    return text


def escape_text(value: str) -> bytes:
    out = (value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    return out.encode("utf-8")


def escape_attr(value: str) -> bytes:
    out = (value.replace("&", "&amp;").replace("<", "&lt;")
           .replace(">", "&gt;").replace('"', "&quot;"))
    return out.encode("utf-8")


class Entry:
    """One ``<metadata>`` element."""

    __slots__ = ("name", "value", "extra")

    def __init__(self, name, value, extra=b""):
        self.name = name
        self.value = value
        self.extra = extra  # verbatim extra attributes, e.g. ' preserve="1"'


class Region:
    """Where the metadata block lives inside the header window."""

    __slots__ = ("start", "end", "indent", "entries", "window")

    def __init__(self, start, end, indent, entries, window):
        self.start = start
        self.end = end
        self.indent = indent
        self.entries = entries
        self.window = window


def parse(window: bytes, root: str, key_attr: str) -> Region:
    """Locate and parse the metadata block.  *key_attr* is ``name`` for 3MF and
    ``type`` for AMF."""
    root_re = re.compile(rb"<" + re.escape(root.encode()) + rb"(?=[\s/>])")
    m = root_re.search(window)
    if not m:
        raise MetaError(
            "Could not find the <%s> root element near the start of the "
            "document; this file may not be a valid %s." % (root, root.upper()))
    root_end = _tag_end(window, m.start())
    if root_end < 0:
        raise MetaError("The <%s> element is truncated or malformed." % root)
    if window[root_end - 2:root_end] == b"/>":
        # Empty root: nothing to replace, insert before the self-closing slash.
        raise MetaError("The <%s> element is empty; nothing to edit." % root)

    key_attr_b = key_attr.encode()
    entries = []
    cursor = root_end
    block_start = root_end
    block_end = root_end
    indent = None

    while True:
        nxt = _skip_ignorable(window, cursor)
        if nxt < 0:
            raise MetaError(
                "Reached the end of the %d KiB header window without finding "
                "the end of the metadata block." % (len(window) // 1024))
        if not window.startswith(b"<metadata", nxt) or \
                window[nxt + 9:nxt + 10] not in b" \t\r\n/>":
            block_end = cursor if entries else root_end
            break

        tag_end = _tag_end(window, nxt)
        if tag_end < 0:
            raise MetaError("A <metadata> element is truncated.")
        tag = window[nxt:tag_end]
        self_closing = tag.rstrip()[-2:] == b"/>"
        attr_src = tag[len(b"<metadata"):-2 if self_closing else -1]

        name = None
        extra = []
        for am in _ATTR_RE.finditer(attr_src):
            attr_name = am.group(1)
            raw = am.group(3) if am.group(3) is not None else am.group(4)
            if attr_name == key_attr_b:
                name = unescape(raw)
            else:
                extra.append(b" " + am.group(0))

        if self_closing:
            value = ""
            elem_end = tag_end
        else:
            close = window.find(b"</metadata", tag_end)
            if close < 0:
                raise MetaError("Unclosed <metadata> element in header.")
            close_end = _tag_end(window, close)
            if close_end < 0:
                raise MetaError("Unclosed <metadata> element in header.")
            value = unescape(window[tag_end:close])
            elem_end = close_end

        if indent is None:
            # Remember the whitespace that preceded the first entry so the
            # rewritten block keeps the document's existing indentation.
            lead = window[root_end:nxt]
            tail_nl = lead.rfind(b"\n")
            indent = lead[tail_nl + 1:] if tail_nl >= 0 else b" "

        if name is not None:
            entries.append(Entry(name, value, b"".join(extra)))
        cursor = elem_end
        block_end = elem_end

    if indent is None:
        indent = b"  "
    return Region(block_start, block_end, indent, entries, window)


def render(entries, key_attr: str, indent: bytes) -> bytes:
    key_attr_b = key_attr.encode()
    parts = []
    for e in entries:
        if not e.name:
            continue
        parts.append(b"\n" + indent + b"<metadata " + key_attr_b + b'="' +
                     escape_attr(e.name) + b'"' + e.extra + b">" +
                     escape_text(e.value) + b"</metadata>")
    return b"".join(parts)


def apply(region: Region, entries, key_attr: str) -> bytes:
    """Return a new header window with the metadata block replaced.

    The whitespace that followed the old block is preserved, so the element
    after the metadata keeps its original indentation.
    """
    block = render(entries, key_attr, region.indent)
    return region.window[:region.start] + block + region.window[region.end:]
