# Publishing Meshkeep on GitHub

Use one repository for the shared Mac and Windows source. GitHub Actions now builds both installers on hosted machines, so you do not need to compile on your own computers.

## Upload the source

Unzip `Meshkeep-GitHub-Source.zip`, open its `meshkeep` folder, and upload the folder's contents to the repository root. Include hidden files and folders: `.github/workflows/build-desktop.yml`, `.gitignore` and `.gitattributes`. In Finder, press **Command + Shift + .** to show hidden items if needed.

The repository root should contain `README.md`, `app.py`, `file_state.py`, both build scripts, and the `.github`, `tools`, `desktop`, `web`, `formats`, `tests` and `docs` folders. Do not upload the source ZIP itself as the repository's source or nest the project inside a `Windows build` folder.

Keep `desktop/build/`, which contains the app artwork and icons. Keep `web/vendor/three/build/`, which contains the renderer needed for offline previews. Generated top-level `build/`, dependencies, installers, sidecars, local catalogues, personal files and agent state are excluded by `.gitignore` and omitted from the prepared ZIP.

## Download builds or prepare a release

1. Open **Actions → Build desktop apps → Run workflow** and select `main`.
2. For downloads only, leave the release checkbox unchecked. Both installer artifacts appear on the successful run's summary.
3. Pushes to `main`/`master` prepare a draft automatically after both builds pass. For a manual run, tick **Create a draft release with both installers**. Review the draft under **Releases**, then publish it for permanent public download links.

The draft includes the Mac DMG and update ZIP, Windows Setup EXE, `latest-mac.yml`, `latest.yml`, generated blockmaps and combined SHA-256 checksums. Keep all update assets when publishing. Installers belong in Releases, not in the source repository. Existing published releases are never overwritten by the workflow. Bump the version in `desktop/package.json` and both lockfile version fields before publishing a new version.

See the [GitHub Actions guide](github-actions.md) for version tags, automatic builds, retention and first-run setup. Builds remain unsigned unless Mac signing secrets are configured; keep the README's Mac Gatekeeper instructions and Windows publisher note. See [auto-update setup](auto-updates.md) for Mac signing and update requirements.

## Future changes

Pull or download the latest shared source before editing, preserve both platform branches, then commit/upload changes to GitHub. The hosted build jobs run independently for Apple Silicon Mac and Windows x64. You can also use the local build scripts if desired. Meshkeep 2.0.4 and later check published stable releases at startup. Windows supports in-app installation; Mac in-app installation requires a Developer ID signed build. Users on 2.0.3 or earlier must install 2.0.4 manually once. Draft releases are not offered to installed apps.

The historical [shared-source verification](verification-shared.md) and [Windows verification](verification-windows.md) describe previous builds. The [first hosted Mac and Windows build](https://github.com/SUP3RMASS1VE/Meshkeep/actions/runs/39340656513) completed successfully on 20 October 2026; both installer artifacts are available from that run.
