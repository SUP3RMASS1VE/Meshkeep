# Shared Mac and Windows source review

This report records the 2.0.1 merge. The subsequent desktop-only cleanup is recorded in [desktop-only changes](desktop-only.md).

Reviewed on 19 October 2026 after importing the completed Windows project into the working Mac project.

## Review result

The returned Windows changes preserve the Mac branches for sidecar startup, slicer launch, application menus and catalogue migration. The shared PyInstaller specification selects arm64 on Mac and the native Python architecture on Windows. Electron packaging includes the appropriate platform's sidecar. The Mac build script was unchanged; the Windows PowerShell script stages dependencies and output separately.

The import contained 34 changed/new source, documentation, test and branding files. Generated Windows dependencies, sidecars and output were not merged into the active Mac source tree. The original Mac copies of replaced files were saved locally in `build/review-backups/mac-before-windows-merge.zip` before merging.

Important Windows fixes retained in the shared code include separator-aware SQL scopes and labels, path containment, directory-junction exclusion, NTFS change-time file stamps, and closing source file handles before atomic replacement. Standard-library Mac file stamps retain their original behaviour. The existing painting decoder and 3MF viewer changes were preserved.

No application-source correction was needed after review. The follow-up added repository ignore/line-ending rules, GitHub publishing instructions, clearer catalogue-backup wording and a packaged Mac regression check. The README now directs Windows users to Release downloads instead of a developer-only build directory.

## Checks run on Mac

- Source Python regression suite: 40 tests, 36 passed, four skipped (Windows junction semantics, Windows drive/case semantics, optional external samples, and the separately run packaged-server check).
- Packaged-server check run separately against the rebuilt Mac bundle: passed, including assets, SQLite organisation and watched-folder indexing.
- Native slicer bridge tests: both Mac and Windows argument-selection branches passed with fake launchers.
- Chrome smoke suite: passed library search, paging, filters, sorting, views, exact duplicates, five format loaders, parts, appearance controls and thumbnails.
- Workspace browser suite: passed tags, smart/manual collections, print journal/photos, watched-folder additions/removals, geometry comparisons, volume and measurements.
- Colour suite: passed all painting splits/orientations, nested trees, extended filament IDs, malformed data, palette assignments and standard 3MF materials. The actual alien sample again rendered grey, green and white: 1,989,463 painted triangles.
- Real Electron preload/native-bridge check: passed with a simulated slicer and the expected 8.000 cm³ synthetic cube.
- Real rebuilt Mac bundle: passed startup with the bundled server, isolated catalogue and preferences, painted colours, saved tags/notes/status across restart, single-instance exit and server shutdown. The generated test model's SHA-256 stayed unchanged. The final test isolates macOS preferences using HOME, CFFIXED_USER_HOME and a dedicated profile.
- Bundle version is 2.0.1. All bundled Mac web assets match the shared source. Mac and Windows archived `main.js` and `preload.js` match the shared native source; both archive metadata versions are 2.0.1.

## Windows evidence and limits

The returned Windows installer exactly matches the PC report's SHA-256:

```text
6a39293b5f9a9ab847e9f726b6859eb3af05486ebceed79cb855365b363c1872  Meshkeep-2.0.1-Windows-x64-Setup.exe
```

Windows installation and runtime checks were performed on the PC and recorded in [Windows verification](verification-windows.md). They could not be repeated natively on this Mac. The imported Windows sidecar's web assets were compared against the shared source. A real slicer launch remains unverified; launcher tests use fakes. The Windows-specific filesystem tests are skipped on Mac and are covered by the supplied PC report.

Both installers remain unsigned. The Mac README includes the app-specific Gatekeeper exception instructions.

## Repository and release contents

The prepared GitHub source excludes generated build folders, dependencies, installers, local catalogues, personal models, agent state and the historical machine-specific handoff. It retains all runtime web/vendor files, format modules, tests, build scripts and Mac/Windows icon assets.

Use the source for the repository and attach the Mac DMG and Windows Setup EXE separately to the same v2.0.1 Release. See [publishing instructions](github-publishing.md).
