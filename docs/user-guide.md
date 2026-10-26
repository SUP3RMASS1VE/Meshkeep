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
- Choose **Select All**, or press **⌘A** on Mac / **Ctrl+A** on Windows while
  browsing, to select all matching models across every page. This replaces the
  previous selection and respects the current folder, collection, search and
  filters. Up to 500 models can be selected at once; narrow the results for larger
  libraries. Typing fields keep their normal text-selection shortcut. Open a
  project and choose **Add selected models** to add all those parts together.
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
The studio accepts files up to 250 MiB, 3MF packages up to 500 MiB unpacked, and up
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


## Multipart projects

Select model files, then choose **+** beside **Projects** in the sidebar. Name the
project to start a build checklist. You can also create an empty project. Projects
are scoped to the folder you are browsing and its subfolders.

To add more parts, close the project panel, select models in the browser, reopen
the project from the sidebar and choose **Add selected models**. Adding the same
file again preserves its existing progress; increase **Copies needed** for repeats.

Each part has a name, copies needed, copies printed, notes and a status: To print,
Printing, Needs another attempt, Printed or Assembled. Choose **Save part** after
editing. Selecting Printed or Assembled fills the printed count with the required
quantity. The progress bar counts printed copies; the separate assembly count
shows how many part entries have been assembled.

Project progress is independent of a model's library print status and print journal,
so the same file can be used in multiple builds. Renaming a model within Meshkeep
preserves its link. Missing files remain in the checklist with a warning and retain
their progress. Removing parts or deleting a project never deletes model files.
This version tracks model files, not individual meshes embedded inside a 3MF.

## Assembly Studio

Open a multipart project and choose **Open Assembly Studio**. Each required copy
appears as a separate piece, including repeated copies of the same file. Copies
already counted as printed appear solid; the remaining copies are ghosted.
Update the project's **Copies printed** count and reopen the studio to see the
build's progress.

New pieces start in a compact layout using each piece's own footprint, so a
large multi-plate 3MF does not push all the other pieces far apart. Select a piece in the scene or the parts
list, then use **Move** or **Rotate** and drag its handles to arrange it. You can
also enter an exact position in millimetres or rotation in degrees and apply the
placement. Coordinates use the printing convention: X and Y across the bed,
Z upwards. The drag handles follow the selected piece's local axes; the numeric
fields use fixed project coordinates. Positions refer to the centre of each model. Meshkeep does not infer
how separate files fit together; arrange the assembled model and choose
**Save layout** to keep those placements with the project.

Use the **Exploded view** slider to spread the pieces out and bring them back
together. Return the slider to zero to edit placements. Exploding the view does
not change the assembled positions that are saved. **Fit assembly** frames the
current view and shows all pieces. **Focus piece** isolates the selected piece
and frames it close up; selecting another piece while focused switches that view.
Turn off **Ghost unfinished pieces** for a solid view while arranging. These view
controls do not change print counts or saved placements. Selecting a piece shows
its filename, copy number and print progress; multi-mesh files are labelled as
moving together.

**Compact layout** rearranges all loaded copies by their individual footprints,
preserving their rotations. It asks before replacing positions and requires
**Save layout** to make the change permanent. Use it to recover an overly
spread-out layout. New pieces added to an existing saved layout are placed beside
the saved pieces, leaving those saved positions intact.

Layouts live in the local catalogue alongside project progress and do not alter
model files. In-app renames retain placements. Removing a part removes its
placements; reducing its required quantity removes placements for the copies no
longer needed. Missing or unpreviewable files are listed in the studio, while
available pieces remain usable. Saving the visible pieces preserves placements
for pieces that could not be loaded.

The scene supports up to **200 copies** and **5 million rendered triangles** in
total, in addition to the existing per-file preview limits. Copies count towards
the triangle limit individually. Each file moves as one piece; component meshes
inside a 3MF retain their internal arrangement. Large or unsupported pieces are
reported rather than silently omitted.
