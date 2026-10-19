# Meshkeep branding

The application is now named Meshkeep. Its macOS bundle name, menu/window title,
desktop header and installer name use that name.

New installations use `~/Library/Application Support/Meshkeep/`. Existing
installations keep their previous catalogue and Electron preferences under
`~/Library/Application Support/Model Meta Editor/`. The existing bundle
identifier is retained for upgrade compatibility.

The 5-million-triangle preview limit introduced in 1.1.1 is retained.

## New app icon

Created with the built-in image-generation tool. The design is a sculpted,
faceted M in mint, teal, blue and violet on a dark rounded tile, with transparent
padding outside the tile. The exact generation prompt is in `icon-prompt.txt`.

- Original raster master: `desktop/build/meshkeep-master.png`
- 1024px app icon: `desktop/build/icon.png`
- Native macOS icon: `desktop/build/icon.icns`
- Native size variants: `desktop/build/Meshkeep.iconset/`
- Header and favicon: `web/meshkeep-icon.png`
- 256px preview: `docs/branding/meshkeep-preview.png`

The original SVG is archived as `previous-icon.svg`; it is not packaged or used.
PNG size conversion uses macOS sips; native packaging uses iconutil.

## Release verification

Meshkeep 1.2.0 arm64 is packaged in `desktop/dist-meshkeep/`. The app bundle,
executable, display name, window title and installer use Meshkeep. The generated
ICNS in the app exactly matches the source ICNS; bundled header/favicon artwork
and renderer sources also match. The desktop archive retains the compatibility
path for existing Electron preferences. The full Python/API and packaged-server
suite passed (28 passed, one optional sample test skipped). The catalogue reuse
test confirms the existing file is retained unchanged. Node syntax checks pass.
