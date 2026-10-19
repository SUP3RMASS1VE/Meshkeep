# Publishing Meshkeep on GitHub

Use **one repository** for the shared Mac and Windows source code. The code chooses the appropriate executable, file paths, slicer launcher and menus for each platform. Build each installer on its own operating system.

## Upload the source

A prepared source folder is supplied as `github-upload/` and as `Meshkeep-GitHub-Source.zip` outside the repository export. Unzip the source archive, open its `meshkeep` folder, and upload that folder's **contents** to the repository root. Do not upload the ZIP itself as the repository's source, or put the source inside another `Windows build` folder.

The root should contain `README.md`, `app.py`, `file_state.py`, `build-mac.sh`, `build-windows.ps1`, `.gitignore`, `.gitattributes`, and the `desktop`, `web`, `formats`, `tests` and `docs` folders. Include the dotfiles when copying or uploading. With Git, `git add .` includes them automatically.

Keep `desktop/build/`: it contains the app artwork and both platform icons. Keep `web/vendor/three/build/`: it contains the JavaScript runtime needed for offline previews. These are source assets, unlike the generated top-level `build/` directory.

Do not upload dependencies, virtual environments, generated app folders, local catalogues, personal models, local agent state or the imported Windows comparison folder. The root `.gitignore` excludes these. The prepared export already leaves them out.

The source archive intentionally omits the historical Mac-to-Windows handoff, which contains machine-specific context. Current build instructions and verification reports are in the README and docs.

## Upload the installers as a Release

For a **v2.0.2** release, build both platform installers from the same source and attach them as downloadable assets:

- `Meshkeep-2.0.2-arm64.dmg` — Apple Silicon Mac installer, rebuilt from the merged source on Mac.
- `Meshkeep-2.0.2-Windows-x64-Setup.exe` — Windows x64 installer; rebuild it on the PC from the current source before publishing v2.0.2.

Attach `SHA256SUMS.txt` alongside them so downloads can be checked. The supplied `release-files/` folder groups the available downloads and records which platform versions are ready; that folder is ignored by Git. Do not commit these large installers into the source repository.

The Mac ZIP is optional. Builder debug files, blockmaps, unpacked apps and sidecar directories are not needed for this manual release. This version has no configured automatic update service.

Both current installers are unsigned. Keep the README's Gatekeeper instructions for Mac and the unsigned-publisher note for Windows. Do not claim Apple notarisation or Windows code signing.

## Future changes

Work from the same repository on both computers: pull the latest changes before editing, preserve platform-specific branches, and push source changes back when finished. Rebuild Mac releases on a Mac and Windows releases on Windows. Test both platforms when shared code changes.

See [shared-source verification](verification-shared.md) and [Windows verification](verification-windows.md) for coverage and limitations.

The available Windows 2.0.1 installer predates removal of the legacy browser entry point in 2.0.2. It still launches as a normal desktop app, but do not rename it or label it as a 2.0.2 build. Historical verification reports describe their original versions.
