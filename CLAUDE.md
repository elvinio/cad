# CLAUDE.md — ScadPad developer guide

Context for AI assistants (and humans) maintaining this codebase. Read this before
fixing bugs or adding features.

## What this is

A **PWA for OpenSCAD CAD modeling on Android phones** (and desktop). Vanilla JS ES
modules, **no framework, no build step, no bundler** — files are served as-is from the
repo root (GitHub Pages compatible). Three.js is the only UI library (vendored, wired
through an import map in `index.html`). OpenSCAD runs as WebAssembly in a Web Worker.

Layout: mobile portrait = viewer on top / editor below (CSS grid, `100dvh`);
desktop landscape ≥768px = side by side. Bottom panel tabs: **Code / Customizer / Console**.

## Architecture

```
index.html         app shell, all panels/dialogs in static markup, import map for "three"
css/app.css        all styling; media query for desktop layout
js/main.js         bootstrap: init modules, wire event-bus subscriptions
js/state.js        tiny pub/sub bus — ALL cross-module communication goes through it
js/storage.js      localStorage (projects, settings) + IndexedDB (library zip bytes)
js/render-manager.js  debounce, one-in-flight queue, cancel-by-terminate, CGAL fallback
js/worker/openscad-worker.js  module worker: owns wasm instance, mounts libs, runs CLI
js/viewer.js       Three.js scene + OrbitControls + hand-written OFF parser
js/editor.js       plain <textarea>: Tab/Enter handling, Ctrl+S, autosave via onChange
js/customizer.js   ParameterSet JSON -> form controls -> override values
js/projects.js     project CRUD dialog + active-project lifecycle
js/libraries.js    curated lib picker (vendored zips) + custom URL -> IndexedDB
js/export.js       STL render -> showSaveFilePicker / <a download> / Drive upload
js/gdrive.js       Google Identity Services token client + Drive REST v3 + sync
js/settings.js     settings dialog (backend, quality, Client ID, Anthropic key, storage)
js/ui.js           tabs, dialogs, toasts, console log panel, status dot
js/chat.js         AI Chat tab: Anthropic SDK (lazy-imported), streams replies, applies code
sw.js              service worker: cache-first app shell, tolerant wasm precache
vendor/openscad/   openscad.js + openscad.wasm (see "Provenance" below)
vendor/three/      three.module.js, three.core.js, OrbitControls.js, STLLoader.js
vendor/fflate/     fflate.module.js (unzip, used in the worker)
vendor/anthropic/  Anthropic TS SDK .mjs dist (see "Provenance" below)
vendor/libraries/  curated zips: BOSL2, BOSL, MCAD, NopSCADlib, funcutils, fonts
examples/default.scad  first-run demo project (parametric rounded box)
```

### Event bus topics (js/state.js)

`project:changed`, `code:changed`, `params:extracted`, `params:changed`,
`render:start`, `render:log`, `render:done`, `render:error`, `settings:changed`,
`libs:changed`. main.js wires which events trigger `requestRender(reason)`.

### Render pipeline (the core)

1. Edit fires `code:changed` → `requestRender('code')` (debounce 800ms; customizer
   changes use `'params'`/300ms and skip the param pass).
2. **Param pass**: worker runs `openscad /input.scad -o /out.json --export-format=param`.
   Output is the Customizer ParameterSet JSON (`{parameters:[{name,type,initial,min,max,
   step,options,caption,group}]}`). Doubles as a syntax check. `Hidden` group is skipped.
3. **Geometry pass**: `-o /out.off --export-format=off --backend=manifold` plus
   `-D` defines: quality preset (`$fn=16` draft / `$fn=32` preview / none final /
   custom `$fn/$fa/$fs`) and customizer overrides (only values ≠ initial; strings are
   JSON-quoted). OFF text → `parseOFF()` → BufferGeometry → viewer.
4. STL export (`renderExport()`): same but `--export-format=binstl`, final quality by
   default (settings checkbox).

**Worker lifecycle**: ONE worker, but a **fresh OpenSCAD wasm instance per job**
(`OpenSCAD({noInitialRun:true,...})` then `callMain(argv)`). Cancellation is ONLY
possible by `worker.terminate()` + respawn — render-manager does this whenever a new
job arrives while one is in flight. The worker reads library zips from IndexedDB itself
(no postMessage transfer) and caches the unzipped file maps in worker memory.

**Library mounting**: zips are unzipped (fflate) and written into the Emscripten FS at
`/libraries/<Name>/...` (`fonts` is special-cased to `/fonts`). `ENV.OPENSCADPATH =
"/libraries"` is set before `callMain`; `FS.chdir('/')` so fonts resolve at `$(cwd)/fonts`.
GitHub archive zips have a `Repo-ref/` top folder — `stripTopFolder()` removes it; the
curated zips (from openscad-playground's npm dist) have files at the zip root.

## Provenance of vendored assets

- `vendor/openscad/`: extracted from the **`openscad-playground` npm package v2.4.0**
  (`package/dist/wasm/`). This is the current OpenSCAD dev-snapshot wasm used by the
  official playground (single-threaded — **no COOP/COEP/SharedArrayBuffer needed**,
  works on plain GitHub Pages). Supports `--backend=manifold`, `--export-format=param|off|binstl`.
  The upstream source for newer builds is
  `https://files.openscad.org/playground/OpenSCAD-*.wasm*-WebAssembly-web.zip`
  (blocked in some sandboxes; the npm package mirrors it).
- `vendor/libraries/*.zip`: same npm package, `package/dist/libraries/`. Serving them
  same-origin sidesteps CORS entirely (codeload.github.com zips do NOT send CORS headers;
  `api.github.com/repos/<o>/<r>/zipball/<ref>` does but is rate-limited 60/hr/IP —
  relevant for the custom-URL feature).
- `vendor/three/`: npm `three@0.184.0` — `build/three.module.js` **and**
  `build/three.core.js` (the module file imports it), `examples/jsm/controls/OrbitControls.js`,
  `examples/jsm/loaders/STLLoader.js`. The addons import bare `'three'`, resolved by the
  import map in index.html.
- `vendor/fflate/fflate.module.js`: npm `fflate@0.8.3` `esm/browser.js`.
- `vendor/anthropic/`: all `*.mjs` files from npm `@anthropic-ai/sdk` (version recorded in
  `vendor/anthropic/VERSION`) — the ESM dist uses only relative imports, so it runs
  unbundled in the browser. **One patch**: `resources/beta/webhooks.mjs` imports the npm
  package `standardwebhooks` (Node-only signature verification); that import is rewritten
  to the local `standardwebhooks-stub.mjs`. Re-apply the patch when upgrading the SDK.
  The remaining `node:` imports in the tree are all *dynamic* (credential-chain paths
  that never run when an `apiKey` is passed) so they're harmless in the browser.
  `js/chat.js` imports the SDK lazily (dynamic import on first send) so the app shell
  still boots offline — the SDK files are NOT in the SW precache; the cache-first fetch
  handler back-fills them on first use. The SW never intercepts `api.anthropic.com`
  (cross-origin requests pass through).

To upgrade OpenSCAD: pull a newer playground npm release or files.openscad.org snapshot,
replace `vendor/openscad/*`, re-run the test recipes below.

## How to test

No test framework; verification is via headless Chromium (Playwright is preinstalled in
the CC sandbox at `/opt/node22/lib/node_modules/playwright`, browser at
`/opt/pw-browsers/chromium-*/chrome-linux/chrome`).

```sh
python3 -m http.server 8765   # serve repo root
```

**Browser e2e pattern** (see git history `/tmp/test-e2e.js` shape): load
`http://localhost:8765/`, wait for
`#viewer-overlay` text to contain `rendered in` (that's the render-done signal), inject
code by setting `#editor.value` + dispatching `new Event('input')`, clear
`#viewer-overlay.textContent` between renders. Console errors of the form
`listener for render:done failed` indicate viewer/parser bugs.

**Direct wasm CLI harness in Node** (much faster for render bugs — bypasses the app):

```js
import OpenSCAD from './vendor/openscad/openscad.js';
import { readFileSync } from 'fs';
const inst = await OpenSCAD({ noInitialRun: true,
  wasmBinary: readFileSync('./vendor/openscad/openscad.wasm'),  // REQUIRED in Node
  print: console.log, printErr: console.error });
inst.FS.writeFile('/input.scad', 'cube(5);');
inst.callMain(['/input.scad','-o','/out.off','--export-format=off','--backend=manifold']);
inst.FS.readFile('/out.off');
```

Checklist that must keep passing: first-load demo renders; edit → re-render;
customizer slider re-renders; BOSL2 checkbox install then
`include <BOSL2/std.scad> cuboid(20, rounding=3);` renders; STL download is valid binary
STL (length === 84 + 50·triangleCount, header uint32 at offset 80); offline reload after
SW install still renders; quality switch re-renders.

## Gotchas (hard-won — do not rediscover these)

1. **OFF header format**: OpenSCAD emits `OFF 16 24 0` — counts on the SAME line as the
   keyword (classic OFF puts them on the next line). `parseOFF()` handles both. Face
   color is optional trailing `r g b [a]` per face line, ints 0-255 or floats 0-1.

2. **Manifold backend crashes on specific models**: e.g. hull() of spheres with certain
   `-D $fn=…` values dies with `CGAL error in applyHull(): assertion violation
   (Triangulation_ds_face_base_2.h)`. It is deterministic per (model, $fn, instance
   history) but NOT predictable — $fn 16/17/30 fine, 24/31/32/48/64 crash on the same
   model, and the same job can succeed in a worker that already completed a render.
   **Mitigation in code**: `runGeometryJob()` in render-manager.js retries once with
   `--backend=cgal` and logs a WARNING. Don't remove it. The demo project's defaults
   (radius=5, wall=2) were chosen to render at every quality preset.

3. **`-D` values**: passed as two argv entries (`'-D', 'name=value'`). String values must
   be JSON-quoted (`-D style="rounded"`), booleans as `true/false`, vectors as `[a,b,c]`.
   `--export-format=param` is undocumented in `--help` but works.

4. **Cancellation**: there is no way to interrupt `callMain` — only `worker.terminate()`.
   Anything that must survive cancellation cannot live in worker memory only (that's why
   zips are in IndexedDB and re-read after respawn).

5. **Node vs browser wasm**: the web build fetches `openscad.wasm` relative to the module
   URL; in Node that fetch fails — pass `wasmBinary` explicitly (see harness above).

6. **Three.js r150+**: `three.module.js` imports `./three.core.js`; both files must be
   vendored. Addons (`OrbitControls`) import bare `'three'` → import map required since
   there's no bundler.

7. **Headless Chrome quirks**: it HAS `window.showSaveFilePicker`, so the export test
   must `delete window.showSaveFilePicker` to exercise the `<a download>` fallback;
   the picker path can't be driven headlessly. WebGL needs `--no-sandbox` and runs on
   SwiftShader (warnings are normal).

8. **Network sandbox (Claude Code remote env)**: `files.openscad.org`, `cdn.jsdelivr.net`,
   `unpkg.com`, `*.github.io` are blocked; `registry.npmjs.org`, `github.com`,
   `codeload.github.com`, `raw.githubusercontent.com` work. `api.github.com` is often
   rate-limited (shared IP). Anonymous `git clone` of arbitrary repos fails (credential
   prompt); npm tarballs via curl are the reliable source for vendored deps.

9. **localStorage ~5MB quota**: projects only (code + param overrides). Zip bytes go to
   IndexedDB (`scadpad` db, `libzips` store, keyPath `name`). `saveProject()` returns
   false on QuotaExceededError — callers toast.

10. **Service worker**: `sw.js` precaches the shell with `cache.addAll` but the ~9.6MB
    `openscad.wasm` is cached with a tolerant separate `Promise.allSettled` so install
    never fails on slow networks; the cache-first fetch handler back-fills it on first
    use. **Bump `CACHE` in `sw.js` on every commit that changes any app file** — if you
    don't, users on the cached version will never see your changes. The version string
    (`scadpad-v1`, `scadpad-v2`, …) is displayed in the Menu dialog so users can confirm
    they're on the latest build. Only same-origin GETs are intercepted (Google auth/API
    traffic must never be cached).

11. **OpenSCAD wasm prints noise**: `Could not initialize localization` on every run —
    harmless, ignore it in logs/tests.

12. **Timestamps in Drive sync**: last-write-wins with a ±2s dead zone
    (`js/gdrive.js syncProjects`). `saveProjectRaw()` exists specifically to write a
    project WITHOUT restamping `modified` (needed when applying remote modifiedTime).
    Deletions do not propagate (v1 design decision).

## Known limitations / nice-to-haves

- Customizer `paramValues` are not synced to Drive (only `.scad` code).
- No syntax highlighting (plain textarea — deliberate, keeps no-build promise).
- `if/else`-heavy hull models may silently render via the CGAL fallback (slower).
- SW update UX: no "new version available" toast yet; users must reload twice.
- Library picker re-downloads curated zips after "Clear caches" on next use
  (`ensureInstalledLibsCached()` runs at boot).
