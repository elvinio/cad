# Plan — Assemblies & fit-testing (collision / clearance)

**Status:** proposed
**Scope:** let a project hold *multiple parts*, place them in 3D with a **drag
gizmo**, and test whether they **fit** (clash detection + clearance), with the
placement saved, synced to Google Drive, and restored on reload.

## Why (background from the design discussion)

The user models gears and mechanical parts in OpenSCAD and wants to verify
assemblies — "will these pieces fit; if they collide, they don't fit."

Key conclusions reached before this plan:

- **"Does it fit" is interference detection, not dynamics.** No physics engine
  (matter.js / Rapier / etc.) is needed or even well-suited — gear-tooth and
  tight-fit contacts make rigid-body sims jitter and tunnel, and they presuppose
  a gear/joint constraint anyway.
- **Meshing/fit is geometry.** Two parts fit at a given placement iff their
  surfaces don't cross *and* the minimum gap respects a clearance margin (real
  printed parts need ~0.1–0.3 mm, so "zero overlap" is too strict).
- **Tooling:** `three-mesh-bvh` for fast mesh-vs-mesh queries in the Three.js
  viewer (`intersectsGeometry` → clash, `closestPointToGeometry` → clearance
  gap). OpenSCAD `intersection()` is the authoritative offline check and handles
  full containment, but it's slow and non-interactive — out of scope for v1,
  noted as a follow-up.
- **Placement = a transform per part.** Collision depends only on the *relative*
  pose, computed as `inverse(A.matrixWorld) · B.matrixWorld`.

## Decided behaviour

- **Interaction is the gizmo first.** Selecting a part shows a Three.js
  `TransformControls` gizmo (translate arrows + rotate rings) and you drag it
  into place. **No numeric-entry panel in v1** (it can be added later for fine
  nudging, but it is explicitly not the primary path).
- A project can be an **assembly**: an ordered list of parts, each with a source
  (scad project re-rendered, or imported STL) and a transform.
- The assembly **saves automatically** (like code autosave), **syncs to Drive**,
  and **restores exactly** on reload — selected parts, transforms, clearance.
- Live **fit readout**: per part-pair, show clash (red) or the minimum gap, and
  flag pairs whose gap is below the clearance threshold.

## Format — versioned JSON

JSON is what the whole app already uses (projects, settings, ParameterSet). It is
text, so it diffs/merges and rides the last-write-wins Drive sync. The assembly
document describes *parts + placement only* — geometry is referenced, never
embedded (localStorage ~5 MB quota, gotcha #9).

```json
{
  "schema": "scadpad.assembly/1",
  "id": "uuid",
  "name": "gearbox",
  "modified": 1718412345678,
  "driveFileId": null,
  "clearance": 0.2,
  "parts": [
    {
      "id": "a1",
      "name": "housing",
      "source": { "type": "scad", "projectId": "uuid-of-scad-project", "overrides": {} },
      "transform": { "pos": [0, 0, 0], "rot": [0, 0, 0], "scale": 1 },
      "color": "#cccccc",
      "visible": true
    },
    {
      "id": "b2",
      "name": "gear-20t",
      "source": { "type": "stl", "ref": "gear-20t.stl" },
      "transform": { "pos": [22, 0, 4], "rot": [0, 0, 9], "scale": 1 }
    }
  ]
}
```

Schema choices:

- **`transform` = position (mm) + Euler degrees `[rx,ry,rz]` + uniform scale.**
  Euler degrees map 1:1 to OpenSCAD `translate(pos) rotate(rot)`, so the same
  data can later drive a generated `.scad`. (Switch `rot` to a quaternion only if
  free-rotation gizmo use causes gimbal pain.)
- **`source` is a tagged union.** `type:"scad"` references an existing project +
  customizer overrides and is **re-rendered on load** — nothing binary stored,
  sync-trivial. This is the common case (parts are in scad). `type:"stl"` covers
  genuinely imported meshes.

## Where bytes live (mirror the library pattern)

| Data | Store | Drive sync |
|---|---|---|
| Assembly JSON (parts + transforms) | localStorage (like a project) | yes — small `.json` text file |
| scad-sourced parts | already a project (`.scad`) | already syncs |
| imported STL bytes | **IndexedDB** (binary, like `libzips`) | as separate `.stl` files |

`type:"scad"` parts store **no** binary — re-rendered at load via the existing
render pipeline.

## Sync

`syncProjects` (`js/gdrive.js`) currently filters to `.scad` and round-trips
`project.code` only (so `paramValues` already don't sync). To carry assemblies,
**extend sync**:

- Accept `.json` files in the Drive `cad` folder and round-trip the assembly
  document with the same last-write-wins / ±2 s dead-zone logic.
- Imported `.stl` parts: `uploadFile` already takes arbitrary blobs (`uploadSTL`
  exists). Push them to the same folder; reference by name / `driveFileId`.
- Re-use `saveProjectRaw`-style "save without restamping `modified`" semantics for
  applying remote timestamps.

(Alternative considered and rejected for v1: embedding the assembly JSON in a
`.scad` header comment to avoid touching sync. It works with zero sync changes
and renders as a real positioned assembly, but cross-project `include` doesn't
resolve in the worker, forcing every part into one file. The JSON-project route
is cleaner and gizmo-friendly.)

## Vendored dependencies to add

Both are single ESM modules that drop into the existing import map / no-build
setup exactly like `OrbitControls` and `STLLoader`:

- **`three-mesh-bvh`** — BVH-accelerated mesh queries (`intersectsGeometry`,
  `closestPointToGeometry`). Record version in a `vendor/.../VERSION` per repo
  convention.
- **`TransformControls`** — `three/examples/jsm/controls/TransformControls.js`,
  the drag gizmo. Imports bare `'three'` → resolved by the existing import map.

Update `sw.js` precache list and **bump `CACHE`** (gotcha #10) when these ship.

## Collision / fit engine

For each visible part build (and cache) a BVH on its geometry. For each pair:

1. `relMatrix = inverse(A.matrixWorld) · B.matrixWorld`.
2. `bvhA.intersectsGeometry(B.geometry, relMatrix)` → clash (boolean).
3. If no clash, `bvhA.closestPointToGeometry(...)` → minimum gap; flag if
   `gap < clearance`.
4. Rebuild the relevant matrices/queries on gizmo drag (throttled to animation
   frames).

Caveat to handle: triangle-vs-triangle misses **full containment** (a part wholly
inside another with no surfaces crossing). Add a single point-in-mesh raycast
parity test per pair to catch it. STL has no canonical origin — compute each
part's `Box3` on load and optionally recenter so the gizmo starts somewhere sane.

## Implementation phases

**Phase 1 — format + storage**
- Add assembly schema constants + `createAssembly`, `getAssembly`,
  `saveAssembly`/`saveAssemblyRaw`, `listAssemblies` to `js/storage.js`
  (parallel to projects; reuse the JSON read/write + index pattern).
- IndexedDB store for imported STL bytes (mirror `libzips`).

**Phase 2 — viewer: multi-part + gizmo**
- Vendor `TransformControls`; wire into `js/viewer.js` alongside `OrbitControls`
  (disable orbit while dragging the gizmo).
- Load N parts into the scene: re-render `scad` sources via the pipeline, parse
  imported STLs via `STLLoader`. Apply each part's transform.
- Select a part → attach gizmo; on drag-end, write the transform back to the
  assembly and autosave.

**Phase 3 — fit testing**
- Vendor `three-mesh-bvh`; build/cache per-part BVHs.
- Pairwise clash + clearance with the containment guard; live readout UI
  (per-pair status, clearance slider bound to `clearance`).

**Phase 4 — sync**
- Extend `js/gdrive.js syncProjects` to round-trip `.json` assemblies and mirror
  imported `.stl` parts; last-write-wins like projects.

**Phase 5 — UI / project mode**
- An "Assembly" entry in the projects dialog (`js/projects.js`); switch the
  viewer/editor shell into assembly mode (part list instead of single-file code).
- Update `sw.js` precache + bump `CACHE`.

**Follow-ups (out of v1 scope)**
- Numeric transform fields for fine nudging.
- OpenSCAD `intersection()` authoritative offline fit check (handles containment,
  reports volume).
- Feature mating (hole-to-peg / face-to-face snapping).
- Sync customizer `overrides` for scad parts (same gap projects have today).

## Test checklist (extends CLAUDE.md "How to test")

- Add two parts; drag one with the gizmo → transform persists across reload.
- Overlapping parts report a clash (red); separated parts report a positive gap.
- A part nested fully inside another is still flagged (containment guard).
- Assembly `.json` round-trips through Drive sync; imported `.stl` re-downloads.
- Offline reload (SW) restores the assembly and re-renders all parts.
