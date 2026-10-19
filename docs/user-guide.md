# Meshkeep user guide

For installation and an overview, see the [main README](../README.md).

Edit the names and authorship metadata of 3D print files (.3mf, .amf, .obj, .ply, .stl).

3MF files can also carry a custom cover image (Thumbnail / cover image section); slicers show it in their recent-projects view.

## Install

See [Mac installation and Gatekeeper instructions](../README.md#install-on-mac) in the main README.

## Library browser (v1.1)

- Expand folders in the sidebar; choose **Folders**, **Grid**, **List** or
  **Preview**. Preview cards open directly in the 3D studio.
- Search the current folder immediately, or choose **Index folder** to catalogue
  that folder and its subfolders. Switch the scope to **Indexed folder +
  subfolders** to search filenames, paths, titles, designers and descriptions.
- Filter by format and sort by name, file size, modified date, format, title or
  designer. Results are paged in groups of 80 so large collections do not create
  thousands of DOM elements.
- **Find duplicates** refreshes the index, then compares SHA-256 hashes of
  same-size files. **Duplicates only** shows matching files and their group
  counts. This finds byte-identical copies, including renamed copies; metadata
  edits or archive recompression produce different hashes. Files are never
  deleted by duplicate detection.
- Indexing and hashing run in background jobs. Unreadable files are reported.
  Watched folders update automatically while Meshkeep is open. For other folders,
  repeat **Index folder** after external additions, changes or deletions;
  edits made inside the app update the index automatically. **Refresh** reloads
  the view and folder tree; it does not recursively rescan the catalogue.

The catalogue and generated thumbnails are stored locally in
`~/Library/Application Support/Meshkeep/catalogue.sqlite3`.
Existing installations continue using the previous
`~/Library/Application Support/Model Meta Editor/catalogue.sqlite3` when present,
including cached thumbnails. Desktop preferences are also retained. The bundle
identifier is preserved for compatibility.

The model index can be rebuilt from the original files, but tags, collections, notes and print history require a backup of the catalogue.

## 3D Preview Studio

Open a model, then choose **Open 3D studio**. Orbit, pan, zoom, choose a lighting
preset, change material/colour/exposure, toggle wireframe, or isolate a selected
part. Parts can be selected in the list or by clicking the model. For Bambu/Orca
parts with editable names, **Edit part name** returns to the matching metadata
field.

STL, OBJ, PLY, AMF and 3MF geometry is supported. 3MF previews support build and
component transforms, units, core colours, and production-extension references
to model parts in other package entries. Advanced 3MF textures/material
extensions use a neutral material and display a notice. External OBJ material
and texture files are not loaded. STL/OBJ/PLY coordinates are assumed to be mm.

Cards use embedded images when available, otherwise generate and cache previews
as they become visible. Automatic generation is limited to files up to 16 MiB.
The studio accepts files up to 64 MiB, 3MF packages up to 256 MiB unpacked, and up
to 5 million triangles, including unique and instanced 3MF geometry. Larger files
can still be edited in the metadata editor. WebGL 2 is required for rendering.
Appearance controls affect the preview only; **Use view as library thumbnail**
saves a separate cached image without modifying the model file.

Three.js is bundled with the app under `web/vendor/`, so rendering works offline.

## Meshkeep 2.0: collections and print journal

The workspace now uses an ink, lilac and warm-coral theme.

**Tags and library notes:** open a model and use **In your library** to save tags,
notes and print status. These live in the local catalogue; saving them does not
rewrite the model file. Filter the browser by tag or print state. For multiple
models, tick their checkboxes and choose **Organise selected** to add tags, set a
status or add them to a collection.

**Collections:** choose **+** beside Collections. Hand-picked collections contain
models you add explicitly. Smart collections combine search, tag, print status,
designer and format rules, scoped to the chosen folder and its subfolders.
Every rule must match. An example is tag `miniatures` and status `Unprinted`.
Search and filters continue to narrow the results within a collection. Removing
a model from a collection or deleting a collection never deletes the model file.

**Print journal:** choose **Log a print**, then record a successful print or an
attempt needing another try. Save printer, material, settings, notes and up to
three finished-print photos. Photos are resized to a maximum of 960px per side,
stored locally and can be clicked to enlarge. Logging a print updates the model's
current status. Deleting a journal entry does not change the manually editable
current status. In-app renames retain tags, notes, collection membership and
print history.

## Watched folders

Choose **+** beside Watched folders to watch the current folder recursively.
Meshkeep checks explicitly watched folders approximately every 15 seconds while
the app is running, indexing additions and updates and removing missing models
from the catalogue. Unavailable folders are retried. Use the checkbox to pause
watching or **×** to remove a watch. Existing tags and print records remain local
when a file disappears, so they can be recovered if the same path returns.
Hidden folders and symlinks are skipped. Rename tracking is guaranteed for
renames made inside Meshkeep; external renames are treated as removal/addition.

## Send to slicer

In the desktop app, choose **Send to slicer**. On first use, pick your slicer's
`.app` bundle on Mac or `.exe` executable on Windows. The choice is remembered. Shift-click the button to choose a
different slicer. Checked models can be sent together from the selection bar.
The app opens files through macOS or launches the Windows executable with a safe argument array, without shell interpolation or uploads.
The native bridge checks its caller, model extensions and home-folder boundary.

## Inspection and geometry matches

The studio shows X/Y/Z dimensions, triangle count and estimated solid volume in
cm³. It checks closure and consistent edge winding for meshes up to 250,000
triangles; larger meshes receive an unverified estimate. Open meshes, reversed
parts, overlaps and self-intersections can make the estimate inaccurate. This
is not a slicer's material-use estimate.

Choose **Measure distance**, then click two points on model surfaces. The
studio shows their straight-line distance and X/Y/Z deltas in mm, with markers
and a measurement line. Clear the measurement or click a new pair of points.
STL, OBJ and PLY units are assumed to be mm; AMF and 3MF units are respected.

**Compare shapes** loads indexed models one at a time and computes mesh
fingerprints in a Web Worker. Results and inspection data are cached by file
version. **Matching geometry** filters the resulting groups. This comparison
ignores names, file metadata, material colours, vertex/triangle ordering, face
winding and translation. Coordinates are compared at 0.001 mm precision.
Arbitrary rotations, scaling and different triangulations may not match; this
is mesh equivalence, not a similarity or semantic search. Existing preview
file-size and triangle limits also apply to geometry comparison. Skipped models
are listed, cancellation is available, and files are never removed automatically.

Run `node tests/test_slicer.cjs` to test the native launcher with a fake OS
launcher. Browser workspace checks are in `tests/ui/workspace.cjs`; see
`tests/ui/README.md` for Playwright setup.

## 3MF painted colours (v2.0.1)

The studio reads Bambu/Orca filament palettes, object/part filament assignments and facet painting, including subdivided colour boundaries. Standard 3MF base materials and vertex colours continue to work. Original colours restores the imported palette after appearance changes. Missing palettes or malformed painting produce a visible warning rather than invented colours. Texture extensions remain unsupported. See [colour verification](3mf-colours.md).
