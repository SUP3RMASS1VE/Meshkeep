# Build Mac and Windows apps on GitHub

The **Build desktop apps** workflow builds and tests Meshkeep on GitHub's own machines. Your Mac and Windows PC do not need to build either installer.

## First-time setup

1. Upload the updated shared source to the repository root. Include the hidden `.github` folder: the workflow must be at `.github/workflows/build-desktop.yml`. Include `tools/ci_artifacts.py` and the updated build scripts as well. Do not upload the source ZIP as a single repository file.
2. Open the repository's **Actions** tab. If GitHub asks you to enable workflows, enable them.
3. Select **Build desktop apps**, then **Run workflow**, choose `main` and confirm.
4. When the run finishes successfully, open its summary and scroll to **Artifacts**.
5. Download `Meshkeep-macos-arm64` for the Mac installer or `Meshkeep-windows-x64` for the Windows installer. Extract the downloaded artifact ZIP to get the `.dmg` or `Setup.exe` and its SHA-256 checksum file.

Pushes to `main` or `master` also build automatically and prepare a draft release after both platforms pass. Pull requests build and test without publishing a release. Installers in workflow artifacts are retained for 30 days; use Releases for permanent downloads.

No custom secrets or signing certificates are required for unsigned builds or Windows updates. Mac in-app installation requires Developer ID signing; see [auto-update setup](auto-updates.md). The workflow uses GitHub's automatic token. It uses standard hosted runners, not paid larger-runner labels. Availability and account limits are controlled by GitHub.

## Create a release with both installers

1. Update the version consistently in `desktop/package.json` and both version fields in `desktop/package-lock.json`, then upload/commit those changes with the source.
2. Open **Actions → Build desktop apps → Run workflow** and choose `main`.
3. Tick **Create a draft release with both installers**, then run the workflow.
4. After both builds pass, open **Releases** and review the new draft. It contains both installers, the Mac update ZIP, `latest-mac.yml`, `latest.yml`, generated blockmaps and combined `SHA256SUMS.txt`. Keep all these assets when publishing: the installed app needs the manifests and update packages.
5. Publish the draft when ready. Installed apps discover published stable releases on their next launch; drafts and prereleases are not offered. No local build or terminal command is needed.

The draft targets the exact source commit that was built. If that version is already published, the workflow keeps its assets unchanged: bump the version before creating another release. Reruns can refresh a draft only when it targets the same commit. Automatic drafts run on pushes to `main`/`master`; the manual release option is also available on those branches. Other branch runs produce download artifacts only.

Optional Git workflow: pushing a matching tag such as `v2.0.4` also builds both apps and prepares a draft. A tag/version mismatch fails before building. A failed platform does not produce a draft with only one installer. If publishing a draft triggers another tag build, the existing published release is left unchanged.

## What runs

- Apple Silicon Mac: `macos-15`, arm64 Python 3.11, Node 22, `zsh build-mac.sh`.
- Windows x64: `windows-2022`, x64 Python 3.11, Node 22, `build-windows.ps1`.
- Both: Python source/API/packaged-server regression tests and native-launcher and auto-update tests, followed by installer packaging.
- Tag release: download both installers, verify checksums, then upload to a draft release.

The Mac build can use `MME_BUILD_PYTHON` to select the setup-python interpreter. Windows and Mac dependencies, sidecars and output remain separate. Electron publishing is disabled inside the build commands; release uploads happen only in the dedicated draft-release job after both builds pass. Actions are pinned to verified commit SHAs.

The build workflow does not run the optional large personal-model or GUI suites; those require extra fixtures or a graphical test environment. Existing local verification remains documented separately. Unsigned Mac builds still need the README's Gatekeeper steps; Windows builds remain unsigned too.

## References and verification status

[GitHub hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) describes the standard runner labels. [GitHub artifact documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts) explains downloading build artifacts.

The workflow is installed on main. The [first hosted build](https://github.com/SUP3RMASS1VE/Meshkeep/actions/runs/39340656513) completed successfully on 20 October 2026 for both Apple Silicon Mac and Windows x64, with both installer artifacts available.

Local verification completed: actionlint v1.7.12 passed the workflow; the three CI artifact/tag/checksum tests passed; the updated Mac build completed with 48 Python tests (45 passed, three platform/optional skips), both native-launcher branches passed, and installer/checksum collection succeeded against the real Mac DMG. The hosted Windows and Mac jobs have also both passed.

Actions artifacts are temporary, authenticated downloads and may return 404 when the browser is not signed into GitHub. For permanent public downloads, open Releases, review the generated draft and publish it. A skipped release job on the first build run was expected under the earlier manual-only release condition; main/master pushes now prepare drafts automatically.
