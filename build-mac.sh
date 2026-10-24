#!/bin/zsh
# Build and test the Apple Silicon desktop app, locally or on GitHub Actions.
set -euo pipefail
cd "${0:A:h}"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "This script builds for Apple Silicon (arm64) and must run on one." >&2
  exit 1
fi

echo "==> 1/3 Building Python sidecar (PyInstaller)"
if [[ ! -x build/pyenv/bin/python ]]; then
  mkdir -p build
  "${MME_BUILD_PYTHON:-/usr/bin/python3}" -m venv build/pyenv
fi
build/pyenv/bin/pip install --quiet --disable-pip-version-check pyinstaller==6.11.1
build/pyenv/bin/pyinstaller desktop/sidecar.spec --noconfirm --clean \
  --distpath desktop/sidecar-dist --workpath build/pyinstaller

echo "==> 2/3 Testing source, bundled server and native bridge"
MME_PACKAGED_SERVER="$PWD/desktop/sidecar-dist/mme-server/mme-server" \
  build/pyenv/bin/python -m unittest discover -s tests -v
node tests/test_slicer.cjs
node --test tests/test_updater.cjs tests/test_update_bridge.cjs tests/test_update_ui.cjs

echo "==> 3/3 Packaging Electron app"
(cd desktop && npm ci && npx electron-builder --config electron-builder.mac.cjs --mac --arm64 --publish never)

echo
echo "Done:"
ls -d "$PWD"/desktop/dist/*.dmg "$PWD/desktop/dist/mac-arm64/Meshkeep.app"
