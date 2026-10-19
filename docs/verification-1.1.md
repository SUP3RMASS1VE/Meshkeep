# Model Meta Editor 1.1 verification

Verified on Apple Silicon, 19 October 2026.

## Automated checks

- Python unit and authenticated HTTP API suite: 28 tests, 27 passed, one skipped
  because the optional sample 3MF files are absent. Includes the packaged-server
  smoke test when `MME_PACKAGED_SERVER` points at the built server executable.
- Browser integration: 90 synthetic models, no personal files. All four views;
  recursive indexing; metadata search; format filtering; descending size sort;
  folder navigation; pagination; content-hash duplicates; STL/OBJ/PLY/AMF/3MF
  loaders; transformed multi-document 3MF assembly; dropdown and canvas part
  picking; isolation; lighting/material changes; thumbnail capture and caching.
- Rendered thumbnail centre pixels checked for visible, lit geometry in the
  STL, OBJ, PLY and AMF cube fixtures. Caught and fixed missing AMF normals and
  zero STL facet normals. No browser JavaScript errors in the final run.
- Hidden Electron window with the desktop sandbox settings: WebGL 2 active,
  both transformed assembly parts rendered, no renderer console errors.
- JavaScript syntax checks passed for browser, editor, studio and 3MF parser.

## Catalogue benchmark

50,000 synthetic catalogue rows, 80 results per page, on this machine:

| Query | Time |
| --- | ---: |
| First page | 18.2 ms |
| Filename search | 34.8 ms |
| Designer search | 35.4 ms |
| Descending size sort | 12.3 ms |
| Last page | 35.2 ms |

These measure catalogue queries, including result shaping, rather than initial
filesystem scanning or thumbnail generation. UI search uses a 180 ms debounce.

## Build

Built with Python 3.9.6, PyInstaller 6.11.1, Electron 33.2.1 and
Electron Builder 25.1.8. Three.js 0.180.0 and its dependencies are vendored with
license notices. SQLite and browser assets are bundled with the sidecar.

Version 1.1.0 arm64 app, DMG and ZIP are in `desktop/dist/`. The app remains
unsigned, matching the previous distribution. The packaged-server smoke test
verifies assets, authenticated startup and a real SQLite indexing/query cycle.

## Scope and limits

The metadata editor remains available beside the library. Indexing and hashing
run in background threads. External filesystem changes require another index
scan; in-app saves, renames and restores update indexed entries. Exact duplicates
use SHA-256, size, nanosecond modification time and change time for cache validity.
No duplicate files are automatically removed.

3MF supports core triangle meshes/colours, build/component transforms, units,
production component references and Bambu/Orca names. Textures and advanced
material extensions use a neutral material with a notice. External OBJ material
files are not fetched. Preview limits and instructions are in the main README.

## Version 1.1.1 follow-up

Raised the unique 3MF, instanced 3MF and overall studio triangle limits to
5,000,000. Updated limit messages and README. JavaScript syntax checks and the
rebuilt packaged-server smoke test pass. Version 1.1.1 is packaged separately
in `desktop/dist-1.1.1/` to preserve the running 1.1.0 build. Packaged renderer
sources match the updated source files. No 5-million-triangle performance
benchmark was performed; file-size and unpacked-package limits remain unchanged.
