#!/bin/zsh
# Build "Meshkeep.app" + .dmg for Apple Silicon.
# Safe to re-run: reuses the build venv and overwrites previous outputs.
set -euo pipefail
cd "${0:A:h}"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "This script builds for Apple Silicon (arm64) and must run on one." >&2
  exit 1
fi

echo "==> 1/3 Building Python sidecar (PyInstaller)"
if [[ ! -x build/pyenv/bin/python ]]; then
  mkdir -p build
  /usr/bin/python3 -m venv build/pyenv
fi
build/pyenv/bin/pip install --quiet --disable-pip-version-check pyinstaller==6.11.1
build/pyenv/bin/pyinstaller desktop/sidecar.spec --noconfirm --clean \
  --distpath desktop/sidecar-dist --workpath build/pyinstaller

SIDECAR="desktop/sidecar-dist/mme-server/mme-server"

echo "==> 2/3 Smoke-testing sidecar"
LOG="$(mktemp -t mme-smoke)"
"$SIDECAR" --electron --port 18756 >"$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -f "$LOG"' EXIT
URL=""
for _ in {1..100}; do
  URL="$(sed -n 's/^READY_URL //p' "$LOG" | head -1)"
  [[ -n "$URL" ]] && break
  sleep 0.1
done
if [[ -z "$URL" ]]; then
  echo "Sidecar never printed READY_URL:" >&2; cat "$LOG" >&2; exit 1
fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$URL")"
if [[ "$CODE" != "200" ]]; then
  echo "Sidecar answered HTTP $CODE (expected 200)" >&2; exit 1
fi
kill $PID; wait $PID 2>/dev/null || true
trap - EXIT; rm -f "$LOG"
echo "    sidecar OK (HTTP 200)"

echo "==> 3/3 Packaging Electron app"
(cd desktop && npm ci && npx electron-builder --mac --arm64)

echo
echo "Done:"
ls -d "$PWD"/desktop/dist/*.dmg "$PWD/desktop/dist/mac-arm64/Meshkeep.app"
