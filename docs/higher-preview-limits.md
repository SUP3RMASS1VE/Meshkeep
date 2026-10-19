# Higher preview limits — 2.0.3

Tested on Mac on 20 October 2026.

The authenticated model API now accepts files up to **250 MiB** (262,144,000 bytes) and 3MF archives with up to **500 MiB** (524,288,000 bytes) total declared unpacked content. Limits include the exact boundary and reject the next byte. The existing five-million-triangle and 5,000-archive-entry limits remain in place. Automatic thumbnails still use the 16 MiB limit.

## Verification

- Python suite: 45 tests; 41 passed, four skipped for platform-specific/optional packaged or external-sample checks. New tests cover exact file-size acceptance/rejection, summed unpacked ZIP sizes, and the retained entry-count cap.
- Real Chromium studio, WebGL rendering and inspection worker, on this Mac:
  - A synthetic STL of exactly 250 MiB loaded, rendered and completed inspection. This is a byte-boundary fixture with one triangle and padding; it is not a complex geometry benchmark.
  - A synthetic 3MF of exactly 500 MiB unpacked loaded, rendered and completed inspection. The extra bytes are an unused package entry, skipped by the mesh loader; this tests the total package boundary, not 500 MiB of mesh XML.
  - A real 226.1 MiB binary STL with 4,740,782 triangles loaded, rendered and completed inspection in approximately 10 seconds.
  - A real 75.2 MiB 3MF expanding to 402.1 MiB, with 4,940,514 rendered triangles, loaded, rendered and completed inspection in approximately 25 seconds.
- Original model sizes and modification times were unchanged. All inspection results were written to a temporary test catalogue.

Timing includes software rendering, a screenshot and volume inspection. It is not a promise of loading speed on other computers. The byte limits do not guarantee that every file below them will fit available memory; XML structure, geometry and painting subdivisions also affect resource usage. A file can fit the byte limits and still exceed the retained triangle limit. For example, the local Snoopy 3MF expands to about 520 MiB and remains above the new unpacked ceiling.

## Repeat the opt-in large-model check

`tests/ui/large-models.cjs` accepts `MME_LARGE_CASES`, the path to a JSON file containing an array of objects with `path` and optional expected `triangles`. Use an authenticated local test server rooted to include those files, with a temporary catalogue, and set `MME_TEST_URL` to its token-bearing URL. Set `MME_PLAYWRIGHT_PATH` and `MME_CHROME_PATH` as described in the browser test README. Screenshots go to the OS temporary folder unless `MME_SCREENSHOT_DIR` is set. Personal paths and generated large fixtures are not included in the source repository.

## Installation and platforms

Rebuild from the shared 2.0.3 source. The Mac installer is built on Mac; Windows must be rebuilt on Windows to include these changes. Existing installed 2.0.2 apps retain their previous limits until replaced.

The Mac 2.0.3 build and its bundled-server regression check passed. The packaged server also streamed the exact 250 MiB STL and 500 MiB-unpacked 3MF successfully. The actual packaged app passed isolated startup, painted-colour rendering, saved organisation across restart, single-instance handling and server shutdown.
