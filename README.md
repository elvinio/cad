# ScadPad

Parametric CAD modeling with [OpenSCAD](https://openscad.org) in your pocket — a vanilla-JS
PWA that runs OpenSCAD compiled to WebAssembly entirely in the browser. Designed for Android
phones (viewer on top, editor below) and desktops (side by side). No build step, no framework,
no server.

![demo](assets/icon-192.png)

## Features

- **OpenSCAD wasm** rendering with the experimental **Manifold** backend by default
  (falls back to CGAL automatically if Manifold trips on a model)
- **3D viewer** (Three.js): one-finger rotate, pinch zoom, two-finger pan
- **Projects** stored in localStorage; create/rename/duplicate/delete/switch
- **Customizer**: parametric variables become sliders/dropdowns/checkboxes
  (extracted via OpenSCAD's parameter-set export, same as the desktop Customizer)
- **Libraries**: one-tap install of BOSL2, BOSL, MCAD, NopSCADlib, funcutils, fonts —
  plus any custom zip URL
- **STL export** to the device (File System Access API or download) or **Google Drive**
- **Drive sync** of projects as `.scad` files (last-write-wins, bring-your-own OAuth Client ID)
- **Offline-capable PWA**: installable, renders without a network connection
- Quality presets (Draft/Preview/Final/Custom `$fn/$fa/$fs`) in the menu

## Running

Serve the repo root over HTTP (a secure context is required for workers/SW):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Or deploy to any static host (GitHub Pages works as-is — no special headers needed;
the wasm build is single-threaded).

## Google Drive setup

1. Create an OAuth **Web application** client in Google Cloud Console.
2. Add the app's origin (e.g. `https://yourname.github.io`) to **Authorized JavaScript origins**.
3. Paste the Client ID into ScadPad's **Settings → Google Drive**, then Sign in.

Uses only the `drive.file` scope; files live in an `OpenSCAD-PWA` folder it creates.

## Licenses

- OpenSCAD wasm build: GPL-2.0 (from the [openscad-playground](https://github.com/openscad/openscad-playground) distribution)
- Three.js: MIT · fflate: MIT
- Bundled libraries keep their own licenses (BOSL2: BSD-2; MCAD: LGPL; NopSCADlib: GPL-3.0; …)
