"""File version stamps, including NTFS change time rather than creation time."""
import os
import stat


def is_link(path):
    """Treat Windows directory junctions as links, including on Python 3.11."""
    if os.path.islink(path):
        return True
    if os.name == 'nt':
        try:
            return os.lstat(path).st_reparse_tag == stat.IO_REPARSE_TAG_MOUNT_POINT
        except OSError:
            pass
    return False

if os.name == 'nt':
    import ctypes
    import msvcrt
    from ctypes import wintypes

    class BasicInfo(ctypes.Structure):
        _fields_ = [(name, ctypes.c_longlong) for name in
                    ('creation', 'access', 'write', 'change')] + [('attributes', wintypes.DWORD)]

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL

    class FileStat:
        def __init__(self, st, changed):
            self._stat = st
            self.st_ctime_ns = changed

        def __getattr__(self, name):
            return getattr(self._stat, name)


def file_stat(path):
    if os.name != 'nt':
        return os.fstat(path) if isinstance(path, int) else os.stat(path)
    own = not isinstance(path, int)
    fd = os.open(path, os.O_RDONLY | os.O_BINARY) if own else path
    try:
        info = BasicInfo()
        if not kernel.GetFileInformationByHandleEx(msvcrt.get_osfhandle(fd), 0, ctypes.byref(info), ctypes.sizeof(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        return FileStat(os.fstat(fd), (info.change - 116444736000000000) * 100)
    finally:
        if own:
            os.close(fd)
