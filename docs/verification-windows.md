# Meshkeep 2.0.1 Windows verification

Verified 19 October 2026 on Windows x64, with Python 3.11.0, PyInstaller 6.11.1,
Electron 33.2.1 and electron-builder 25.1.8.

## Delivered build

- Installer: `desktop/dist-win/Meshkeep-2.0.1-Windows-x64-Setup.exe` (89,545,966 bytes).
- SHA-256: `6a39293b5f9a9ab847e9f726b6859eb3af05486ebceed79cb855365b363c1872`.
- Installed successfully for the current account under `%LOCALAPPDATA%/Programs/Meshkeep`.
- Start menu and desktop shortcuts verified. Executable product name, icon and version resources are set.
- Unsigned installer and app; no security settings were changed.

## Changes

Windows sidecar executable selection and hidden console, Windows development
Python launcher, Windows slicer executable picker and safe argument launch,
platform-specific menus, per-user Windows catalogue, native architecture handling,
NSIS packaging, and a repeatable `build-windows.ps1` build. Windows dependencies,
sidecar and release output are separate from the copied Mac files.

The portability audit also fixed recursive SQL scopes using Unix separators,
Windows path labels and containment, static-file backslash traversal, junction
exclusion in scanning/watching/folder browsing, and file
replacement while source handles were still open (3MF, STL, OBJ/PLY and AMF).
Windows cache stamps use the file's change time via GetFileInformationByHandleEx,
rather than Python's Windows creation-time `ctime`; this detects same-size edits
even if modification time is restored. Mac file stamping keeps its original behaviour.
The painted 3MF parser and painting subdivision implementation were preserved.

## Checks passed

- Python regression run with `MME_PACKAGED_SERVER` set: 40 tests, 38 passed,
  two skipped. Coverage includes metadata and embedded covers, catalogue indexing,
  hashes and stale caches, authenticated HTTP, path scope, collections, print
  records, folder watching, and the built sidecar's assets and SQLite operations.
- Native bridge tests for both Mac and Windows launch arguments, Unicode and
  special-character paths, outside-home rejection and IPC caller/origin validation.
- Chrome browser smoke: 90-model paging, search/filter/sort, views, duplicate
  hashes, all five formats, studio controls and thumbnail generation/capture/cache.
- Workspace browser suite: tags, collections, print journal/photos, watcher
  additions/removals, geometry comparison, volume and measurement.
- Colour suite: split types and orientation, nested painting trees, extended IDs,
  malformed painting, filament palettes, extruder assignment, core materials.
- Real Electron preload isolation and native bridge with a simulated slicer;
  studio worker reported 8.000 cubic centimetres for the synthetic cube.
- The actual installed executable was launched with Playwright in a separate
  profile/catalogue: packaged version 2.0.1, synthetic painted model rendering in
  grey/green/white, Unicode and spaces in the path, tags/notes/status surviving a
  restart, second-instance exit, and server shutdown after closing. Model SHA-256
  was unchanged. Screenshot: `build/installed-app-painted-colours.png`.

## Limits of verification

The external Mac alien sample was not supplied, so the original real-model test
was not repeated on Windows. The optional external-sample Python test was skipped.
The symlink test was skipped because this Windows account lacks symlink creation
privilege; an actual Windows junction was created and excluded successfully, and
stale-file, path-boundary and cross-drive checks still ran. No Windows
security settings were changed to enable symlinks. The builder archive's unused
Mac symlinks are excluded during extraction of Windows tooling.

A real slicer launch has not been tested; native bridge tests use simulated
launchers. Mac builds were preserved but could not be executed on this Windows PC.
Windows Electron test profiles remain in the OS temporary directory because
Chromium keeps cache files locked until its process exits.

## Repeat installed-app test

With Playwright available and the fixture server running for the native bridge test:

```powershell
python tests/ui/make_packaged_fixture.py
$env:MME_INSTALLED_APP = "$env:LOCALAPPDATA/Programs/Meshkeep/Meshkeep.exe"
$env:MME_PLAYWRIGHT_PATH = 'C:/path/to/node_modules/playwright'
node tests/ui/packaged-windows.cjs
```

The installed-app test uses only generated files in `build/installed-app-qa` and
needs no fixture server itself. It redirects the catalogue to that folder and
uses software rendering for repeatability. Normal launch uses default rendering.
