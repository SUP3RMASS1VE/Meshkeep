# PyInstaller spec for the Meshkeep server sidecar (onedir, native Windows / Mac arm64).
#   pyinstaller desktop/sidecar.spec --noconfirm --clean \
#       --distpath desktop/sidecar-dist --workpath build/pyinstaller
import os
import sys

from PyInstaller.utils.hooks import collect_submodules

repo_root = os.path.abspath(os.path.join(SPECPATH, ".."))
sys.path.insert(0, repo_root)

a = Analysis(
    [os.path.join(repo_root, "app.py")],
    pathex=[repo_root],
    datas=[(os.path.join(repo_root, "web"), "web")],
    hiddenimports=collect_submodules("formats"),
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="mme-server",
    console=True,
    target_arch="arm64" if sys.platform == "darwin" else None,
)
coll = COLLECT(exe, a.binaries, a.datas, name="mme-server")
