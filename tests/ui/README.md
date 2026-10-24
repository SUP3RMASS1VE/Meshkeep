# Browser integration checks

Uses a temporary library of 90 synthetic files, including a multi-document,
two-part 3MF assembly. No personal model files are used or modified.

Start the fixture server from the repository root:

```sh
python3 tests/ui/fixture_server.py
```

In another terminal, run with Playwright available:

```sh
MME_PLAYWRIGHT_PATH=/absolute/path/to/node_modules/playwright \
MME_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node tests/ui/smoke.cjs
```

Omit `MME_CHROME_PATH` to use Playwright's installed Chromium. Optionally set
`MME_SCREENSHOT_DIR` to an existing directory (default: the OS temporary directory).

On Windows, use Python and Node from PATH and set environment variables in PowerShell:

```powershell
python tests/ui/fixture_server.py
# In another terminal, with Playwright installed:
$env:MME_PLAYWRIGHT_PATH = 'C:/path/to/node_modules/playwright'
$env:MME_CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
node tests/ui/smoke.cjs
node tests/ui/workspace.cjs
node tests/ui/colours.cjs
```

After a Windows build, the native test uses
`build/windows-desktop/node_modules/electron/dist/electron.exe tests/ui/electron-workspace.cjs`.

Checks: recursive indexing, paged results, metadata search, exact duplicates,
view switching, all five file loaders, 3MF component transforms, part selection
through the dropdown and actual canvas raycasting, material/lighting controls,
isolation, thumbnail capture and thumbnail generation. Browser JavaScript errors
fail the run. Stop the fixture server with Ctrl+C to remove its temporary files.


For the Meshkeep 2.0 workspace workflows, run `node tests/ui/workspace.cjs`
with the same environment variables. It verifies tags, manual/smart collections,
print records, photo enlargement, real watcher imports/removals, cross-format
geometry fingerprints, winding/order/translation invariance, volume and surface
measurements. The fixture server polls every 2 seconds to keep tests short;
the normal app polls every 15 seconds.

`desktop/node_modules/.bin/electron tests/ui/electron-workspace.cjs` checks
the actual isolated preload bridge and studio worker in Electron with a simulated
slicer launcher. It uses a separate temporary profile and does not open a real
slicer or modify the user's settings.

## Packaged Mac app

Run `python3 tests/ui/make_packaged_fixture.py`, set `MME_INSTALLED_APP` to the
rebuilt `Meshkeep.app/Contents/MacOS/Meshkeep` executable, then run
`node tests/ui/packaged-mac.cjs` with Playwright available. The check uses a
generated painted cube and separate test home/profile, then verifies bundled
startup, colours, saved organisation, restart, single-instance handling and server
shutdown. It does not read or rewrite personal models.

Run `node tests/ui/projects.cjs` with the same fixture and environment to check
project creation, quantities, duplicate additions, persistence after reload, assembly,
mobile panel sizing, removal and deletion.
