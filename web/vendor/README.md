# Vendored browser dependencies

Three.js **0.180.0**, MIT license, from the official npm `three` package.

Only the renderer, OrbitControls, TransformControls, STL/OBJ/PLY/AMF loaders and their fflate
ZIP dependency are included. The files retain upstream license notices;
`three/LICENSE` contains the Three.js license. The fflate license is in
`three/examples/jsm/libs/fflate.module.js`.

3MF core geometry, production component references and part identities are
handled by this application's `web/threemf.js`.

The app loads these assets locally; it makes no CDN requests.

`TransformControls.js` is the unmodified control module from the official
Three.js `r180` release and provides Assembly Studio's move and rotate handles.
