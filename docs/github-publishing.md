# Publishing Meshkeep on GitHub

Use one repository for the shared Mac and Windows source. GitHub Actions now builds both installers on hosted machines, so you do not need to compile on your own computers.

## Upload the source

Unzip `Meshkeep-GitHub-Source.zip`, open its `meshkeep` folder, and upload the folder's contents to the repository root. Include hidden files and folders: `.github/workflows/build-desktop.yml`, `.gitignore` and `.gitattributes`. In Finder, press **Command + Shift + .** to show hidden items if needed.

The repository root should contain `README.md`, `app.py`, `file_state.py`, both build scripts, and the `.github`, `tools`, `desktop`, `web`, `formats`, `tests` and `docs` folders. Do not upload the source ZIP itself as the repository's source or nest the project inside a `Windows build` folder.

Keep `desktop/build/`, which contains the app artwork and icons. Keep `web/vendor/three/build/`, which contains the renderer needed for offline previews. Generated top-level `build/`, dependencies, installers, sidecars, local catalogues, personal files and agent state are excluded by `.gitignore` and omitted from the prepared ZIP.

## Download builds or prepare a release

1. Open **Actions → Build desktop apps → Run workflow** and select `main`.
2. For downloads only, leave the release checkbox unchecked. Both installer artifacts appear on the successful run's summary.
3. To prepare a release, tick **Create a draft release with both installers**. After both builds pass, review the draft under **Releases**, then publish it.

The draft includes the Mac DMG, Windows Setup EXE and combined SHA-256 checksums. Installers belong in Releases, not in the source repository. Existing published releases are never overwritten by the workflow. Bump the version in `desktop/package.json` and both lockfile version fields before publishing a new version.

See the [GitHub Actions guide](github-actions.md) for version tags, automatic builds, retention and first-run setup. Both apps remain unsigned; keep the README's Mac Gatekeeper instructions and Windows publisher note.

## Future changes

Pull or download the latest shared source before editing, preserve both platform branches, then commit/upload changes to GitHub. The hosted build jobs run independently for Apple Silicon Mac and Windows x64. You can also use the local build scripts if desired. There is no automatic update service inside installed Meshkeep apps; users install a new release to update.

The historical [shared-source verification](verification-shared.md) and [Windows verification](verification-windows.md) describe previous builds. The [first hosted Mac and Windows build](https://github.com/SUP3RMASS1VE/Meshkeep/actions/runs/39340656513) completed successfully on 20 October 2026; both installer artifacts are available from that run.
