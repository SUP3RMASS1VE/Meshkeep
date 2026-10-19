# Meshkeep 2.0 verification

Built for Apple Silicon on 19 October 2026. All six requested features are
implemented, together with an ink/lilac/coral workspace theme.

## Validation

- Full Python/unit/authenticated-HTTP suite, including the built application:
  **35 tests: 34 passed, one optional sample-file test skipped**.
- Packaged-server test verifies the actual SQLite catalogue, new browser/worker
  assets, tag/status persistence, smart collection queries, print settings,
  photo storage/retrieval, and live watcher indexing of a newly created file.
- Workspace browser checks on a temporary 90-model synthetic library: tags,
  manual collections, live smart membership after logging a print, stored
  photos and full-size photo viewing, watched additions and deletions,
  all-format geometry comparison, dimensions, volume and surface measurements.
- First geometry comparison: 90 models analysed, zero skipped. Subsequent runs
  use cached valid fingerprints. Equivalent cube meshes matched across STL,
  OBJ, PLY and AMF. Explicit tests confirm translation/face-order/winding
  invariance and distinguish a scaled model.
- The 20 mm cube measured 20 × 20 × 20 mm and 8.000 cm³. The test verifies
  consistently wound closed edges and clicks two real canvas surface points
  to produce a measurement line and distance/deltas.
- Existing browser smoke suite passes: paging, search, sorting, all four views,
  exact-file duplicates, 3MF part picking, all five file loaders, lighting,
  materials, thumbnails and thumbnail capture.
- Native bridge tests use a fake OS launcher. They verify saved slicer choice,
  `/usr/bin/open` argument handling, home-folder/model-extension validation,
  and rejection of an untrusted frame/origin. No real slicer is launched.
- Real Electron test verifies the isolated preload/IPC bridge and the geometry
  worker in a hidden, sandboxed BrowserWindow with a temporary profile.
- All packaged web assets match the verified sources. Packaged main/preload
  files match source. Bundle display name is Meshkeep, version 2.0.0.

## Data and compatibility

Schema additions preserve existing models, metadata, exact hashes and cached
thumbnails. Tags, notes, print state, collection membership and print records
are kept separately from source files. In-app renames move those associations.
Deletion of model files from a watched folder removes catalogue rows and cached
previews while retaining organisation/history for recovery at the same path.
Existing Model Meta Editor/Meshkeep catalogues and desktop profiles are reused.

Watchers run while the app is open and poll every 15 seconds. Only changed
snapshots cause catalogue updates. Automatic UI refresh waits while forms or
batch selections are being edited. Folder errors are retried; checks stop on
shutdown. Watcher tests use a two-second interval.

## Geometry scope

Fingerprinting compares mesh triangles at 0.001 mm precision and ignores
translation, winding, ordering, metadata and materials. Different rotations,
scale and triangulations may not match. It is not a semantic similarity search.
Existing file-size and 5-million-triangle preview limits apply. Failed models
are listed, comparison is cancellable, and no duplicates are automatically
removed. Volume is an estimate; overlaps and invalid meshes can be inaccurate.
Edge closure checks are bounded to 250,000 triangles.

## Artifacts

- `desktop/dist-meshkeep-2/Meshkeep-2.0.0-arm64.dmg`
- `desktop/dist-meshkeep-2/Meshkeep-2.0.0-arm64-mac.zip`
- `desktop/dist-meshkeep-2/mac-arm64/Meshkeep.app`

The application remains unsigned as in prior builds. Python 3.9.6, PyInstaller
6.11.1, Electron 33.2.1 and Electron Builder 25.1.8. No additional Python or
browser runtime dependency is required on the recipient's machine.
