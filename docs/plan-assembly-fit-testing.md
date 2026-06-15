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

### Assembly mode = a shell mode, not a new region

A project is *either* a normal scad project *or* an assembly. Opening an assembly
emits `project:changed` with `kind:"assembly"`; `main.js` toggles a single
`body.mode-assembly` class and everything else keys off it in CSS (no framework,
no router — keeps the no-build promise). The viewer (top panel) is reused as-is,
gaining multi-part + `TransformControls` + selection.

The bottom-panel tabs change by mode:

| Tab | scad project | assembly |
|---|---|---|
| **Code** | shown | **hidden** |
| **Parts** | hidden | **shown** (new) |
| **Param** | shown — edits the project's params | shown — edits the **selected part's** overrides |
| **Chat** | shown | shown |
| **Console** | shown | shown |
| **Doc** | shown | **hidden** |

- **Parts** (new tab, occupies the Code slot's neighbourhood) holds: the part
  list (select / show-hide / delete / add), the **clearance slider** bound to
  `assembly.clearance`, and the **pairwise fit readout** (clash = red, else the
  minimum gap, flagged when `gap < clearance`).
- Selecting a part in the list ↔ attaching the gizmo are two-way via the bus
  (`part:selected`); gizmo drag-end emits `part:moved` → autosave.
- In assembly mode the **Param** tab retargets to the *selected part*: it edits
  that part's customizer overrides, re-renders just that part, and writes the
  values **inline into the assembly JSON** (see below).

### Param sets — named customizer presets per scad

A single scad can carry **multiple named parameter sets** (e.g. `default`,
`tight`, `loose`). The **Param** tab gains a dropdown to pick the active set,
plus save / save-as / rename / delete. Selecting a set feeds its values through
the existing `setParamValues()` → re-render path (`js/customizer.js` already
exposes `setParamValues` / `getParamValues` / `applyParamOverrides`, so this is
additive). Param sets are stored as JSON and synced to Drive (see storage table).

An assembly part may be **seeded** from one of its scad's named sets, but the
authoritative override values are snapshotted **inline** in the assembly JSON
(`source.overrides`) so the assembly stays self-contained and doesn't drift if
the project's param sets change later. Optionally the part records which set it
came from (`source.paramSet`) for display only.

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
      "source": {
        "type": "scad",
        "projectId": "uuid-of-scad-project",
        "overrides": { "wall": 3 },
        "paramSet": "tight"
      },
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
- **`source.overrides` is an inline snapshot** of the customizer values for that
  part, carried in (and synced with) the assembly JSON — *not* a reference to a
  named param set. `source.paramSet` is an optional display-only label of the set
  it was seeded from.

### Param-set file — versioned JSON sidecar per project

Each scad project gets at most one params sidecar holding *all* its named sets:

```json
{
  "schema": "scadpad.paramsets/1",
  "project": "rounded-box",
  "modified": 1718412345678,
  "driveFileId": null,
  "active": "tight",
  "sets": {
    "default": {},
    "tight": { "wall": 3, "clearance": 0.1 },
    "loose": { "wall": 2, "clearance": 0.4 }
  }
}
```

`sets[name]` is an overrides map in the exact shape `getParamValues()` returns
(only values differing from each parameter's `initial`). One file per project
(not one per set) keeps the Drive folder tidy and matches name-based project
sync. Stored in localStorage like a project; synced as `<name>.params.json`.

## Where bytes live (mirror the library pattern)

| Data | Store | Drive sync |
|---|---|---|
| Assembly JSON (parts + transforms + inline `overrides`) | localStorage (like a project) | yes — small `.json` text file |
| Param sets (named customizer presets per scad) | localStorage (like a project) | yes — `<name>.params.json` text file |
| scad-sourced parts | already a project (`.scad`) | already syncs |
| imported STL bytes | **IndexedDB** (binary, like `libzips`) | as separate `.stl` files |

`type:"scad"` parts store **no** binary — re-rendered at load via the existing
render pipeline. A part's overrides ride **inside** the assembly JSON, so they
sync with it; the project's own param sets sync separately as the sidecar above.

## Sync

`syncProjects` (`js/gdrive.js`) currently filters to `.scad` and round-trips
`project.code` only (so `paramValues` already don't sync). To carry assemblies,
**extend sync**:

- Accept `.json` files in the Drive `cad` folder and round-trip the assembly
  document with the same last-write-wins / ±2 s dead-zone logic.
- Round-trip `<name>.params.json` sidecars the same way (distinguish from
  assembly `.json` by the `schema` field: `scadpad.paramsets/1` vs
  `scadpad.assembly/1`).
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
- Add param-set storage: `getParamSets(projectId)`, `saveParamSets`,
  `saveParamSetsRaw` (`scadpad.paramsets/1` shape, one doc per project).
- IndexedDB store for imported STL bytes (mirror `libzips`).

**Phase 1b — param sets UI (independent of assemblies)**
- Param tab: add a set dropdown + save / save-as / rename / delete. On select,
  apply via `setParamValues()` and persist `active`. Ships value to standalone
  scad projects first; the assembly Param-tab reuse falls out of Phase 5.

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
- An "Assembly" entry + "New assembly" button in the projects dialog
  (`js/projects.js`); opening one emits `project:changed` with `kind:"assembly"`.
- `main.js` toggles `body.mode-assembly`; CSS hides the **Code** and **Doc** tabs
  and shows the new **Parts** tab. `ui.js` tab handler stays generic (tabs hidden
  via class, not removed). Param tab retargets to the selected part in this mode.
- Build the **Parts** view: part list (add / select / show-hide / delete),
  clearance slider, pairwise fit readout.
- Update `sw.js` precache + bump `CACHE`.

**Follow-ups (out of v1 scope)**
- Numeric transform fields for fine nudging.
- OpenSCAD `intersection()` authoritative offline fit check (handles containment,
  reports volume).
- Feature mating (hole-to-peg / face-to-face snapping).

## Test checklist (extends CLAUDE.md "How to test")

- Add two parts; drag one with the gizmo → transform persists across reload.
- Overlapping parts report a clash (red); separated parts report a positive gap.
- A part nested fully inside another is still flagged (containment guard).
- Assembly `.json` round-trips through Drive sync; imported `.stl` re-downloads.
- Offline reload (SW) restores the assembly and re-renders all parts.
- Save a named param set on a scad, switch sets via the dropdown → re-renders;
  set persists across reload and round-trips through Drive (`<name>.params.json`).
- Open an assembly → Code/Doc tabs hidden, Parts tab shown; select a part → Param
  tab edits that part's overrides and they save inline in the assembly JSON.
