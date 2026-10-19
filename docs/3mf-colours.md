# 3MF painted colours — 2.0.1

The alien sample stored a filament palette in `Metadata/project_settings.config` and per-triangle `paint_color` attributes. The previous loader only read standard 3MF material resources, so it used the blue fallback.

The loader now supports:

- JSON `filament_colour` (falling back to `extruder_colour`) and Prusa text-config `extruder_colour` palettes.
- Bambu/Orca object and part `extruder` metadata, inherited through component references. Each mesh cache entry includes its inherited filament assignment.
- `paint_color` and Prusa `slic3rpe:mmu_segmentation` facet attributes. Nibbles are consumed right-to-left. The low two bits encode zero to three split edges; upper bits select the split orientation or leaf state. State 0 inherits the part's filament; other states index the palette from 1. Extended states use an escape nibble.
- Recursive midpoint subdivisions with winding and child order preserved. The existing five-million-triangle limit includes rendered painted subtriangles and instances. Malformed painting and missing colours produce warnings.
- Existing standard 3MF per-face/per-vertex colours retain precedence over default slicer filament assignments for unpainted faces.

Only preview data changes. Original files and their embedded thumbnails are never modified. Existing cached captures are retained; use Capture thumbnail to replace a previous blue studio capture. Texture-based material extensions remain unsupported and show a warning.

## Format references

The implementation interprets the serialized format documented by the upstream reader/writer and split geometry, without copying C++ code:

- [BambuStudio facet serialization and deserialization](https://github.com/bambulab/BambuStudio/blob/master/src/libslic3r/TriangleSelector.cpp)
- [BambuStudio hexadecimal storage](https://github.com/bambulab/BambuStudio/blob/master/src/libslic3r/Model.cpp)

## Verification

`tests/ui/colours.cjs` exercises real browser modules: all split types and orientations, conserved signed area, child colour order, nested trees, extended filament IDs, malformed/truncated data, JSON palettes, object assignments, standard core colour precedence and neutral fallback. Optional `MME_COLOUR_MODEL` verifies the supplied alien file read-only and renders the studio to `/private/tmp/meshkeep-colour-fix.png`.

The supplied alien has 1,943,516 source triangles. Painted subdivisions yield 1,989,463 rendered triangles: 1,916,858 grey (`#676868`), 68,236 green (`#00ff00`) and 4,369 white (`#fafbff`).

Release checks passed: browser colour suite against the actual alien, existing browser smoke suite, 34 Python regression tests (one optional sample test skipped), and packaged server/version/asset integrity checks. Installer: `desktop/dist-meshkeep-2.0.1/Meshkeep-2.0.1-arm64.dmg`.
