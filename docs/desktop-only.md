# Desktop-only launch — 2.0.2

Meshkeep is distributed and launched as a desktop application on Mac and Windows.

- Removed the legacy `Meshkeep.command` browser launcher.
- Removed user-facing browser/source-mode launch instructions from the README and user guide.
- Removed automatic browser opening and the `--no-browser` option from the Python sidecar.
- Direct execution of the internal Python server without the desktop startup flag now exits with a message directing users to the Meshkeep app.
- Kept the internal server, bundled `web/` assets, build scripts and developer integration tests: these power and verify the desktop application.

The Electron launcher already uses the internal `--electron` startup flag on both platforms, so normal desktop launches retain their existing behaviour. The source/package version is now 2.0.2. Packaged-app tests read the source version instead of hardcoding a previous release.

## Releases

The Mac 2.0.2 installer is rebuilt here. The Windows installer available from the PC is still 2.0.1. Rebuild with `build-windows.ps1` on Windows from the updated shared source before publishing a Windows 2.0.2 installer. Do not rename an older installer as a new version.

The historical [shared-source review](verification-shared.md) and [Windows report](verification-windows.md) describe their original 2.0.1 builds. The new source archive replaces the earlier GitHub export and excludes the retired launcher.

Verification: 42 Python source tests (38 passed, four platform/optional checks skipped), the separate packaged-server test, rejection of direct startup by the packaged sidecar, and the real Mac 2.0.2 bundle's startup, colour, persistence, restart, single-instance and shutdown checks all passed.
