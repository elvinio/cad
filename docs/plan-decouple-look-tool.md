# Plan — Decouple rendering from vision: add a `look` tool

**Status:** proposed
**Scope:** evolve the chat tool loop (shipped in `claude/ai-cad-tool-use-cnox74`,
`js/chat.js` + `js/viewer.js`) so that *applying/rendering* and *seeing the model*
are separate tools, and give Claude control over what it looks at.

Three changes, one shippable unit:

- **A.** `apply_and_render` returns **text only** (dimensions or the compiler error) —
  no image.
- **B.** New `look` tool: Claude requests either the 2×2 grid (default) or a single
  view — a named preset *or* a custom azimuth/elevation angle.
- **C.** The first prompt of a conversation no longer attaches the user's live
  single-view snapshot; it attaches the **2×2 grid** instead, so the model starts
  from the same four-view frame it gets from `look`.

---

## Current behaviour (verified)

- `apply_and_render` (`chat.js runApplyAndRender`) applies the code, awaits the
  render, and on success **always** appends a `captureMultiView()` image to the
  tool result plus a bounding-box line; on failure it returns the error text.
  The model cannot opt out of the image or choose the angle.
- The only vision the model has is whatever `apply_and_render` hands back. There is
  no standalone "look" affordance and no way to request a specific angle.
- First-turn image: `send()` calls `captureSnapshot()` (the user's **current
  camera**, single view) gated by the `chatSendSnapshot` (📷) toggle, and attaches
  it to the outgoing user turn (`chat.js`, the `if (snapshot) …` block).
- Viewer capture surface (`js/viewer.js`):
  - `captureSnapshot(maxDim=768)` — current camera, single view.
  - `captureMultiView(maxDim=1024)` — 2×2 ISO/FRONT/RIGHT/TOP, labelled, restores
    the user's camera afterward. Internally loops `MULTIVIEW_VIEWS` calling
    `frameFrom(dirVec, up)` then `renderer.render` per cell.
  - `VIEW_DIRECTIONS` map + `frameFrom(dirVec, up)` already drive arbitrary-angle
    framing; `setView(name)` is the named-preset entry point.
  - `getMeshStats()` → `{ triangles, size:[dx,dy,dz] }`.

Cost/limitation of the coupled design: a ~40 KB image rides on **every** successful
render even when the model only wanted to confirm "did it compile?", and the model
is stuck with the canned four views (no detail/underside angle).

---

## A. `apply_and_render` returns text only

`chat.js runApplyAndRender(code)`:

1. Keep: `setStatus('Rendering…')`, `applyAndAwaitRender(code)`.
2. **Success** → no `captureMultiView`, no `addImageButton`. Return a single text
   block: `Render OK. Bounding box ${dims}. Call look to inspect the model.`
   (`dims` from `getMeshStats()` as today). Optionally `addNote('Rendered — ${dims}')`
   so the transcript shows progress without an image.
3. **Failure** → unchanged: `addNote(... error ...)` + text block telling the model
   to fix and call `apply_and_render` again.

Net: the function no longer touches the viewer's capture path at all.

---

## B. The `look` tool

### Tool definition (`chat.js`)

```js
const LOOK_TOOL = {
  name: 'look',
  description:
    'Render the CURRENT model to an image so you can inspect it. Default is a 2×2 grid '
    + 'of four labelled views (ISO, FRONT, RIGHT, TOP) in OpenSCAD Z-up coordinates. '
    + 'Pass a single named view, or view:"custom" with azimuth/elevation degrees, to '
    + 'look from a specific angle (e.g. an underside or a detail). Call apply_and_render '
    + 'first if you have changed the code.',
  input_schema: {
    type: 'object',
    properties: {
      view: {
        type: 'string',
        enum: ['grid','iso','front','back','left','right','top','bottom','custom'],
        description: 'Which view. "grid" = 2×2 of iso/front/right/top (default).',
      },
      azimuth:   { type: 'number', description: 'Custom only: degrees around +Z from +X (CCW). 0=+X(right), 90=+Y(back), -90=-Y(front).' },
      elevation: { type: 'number', description: 'Custom only: degrees above the XY plane. 90=straight down (top), -90=straight up.' },
    },
  },
};
```

Default when `view` omitted → `'grid'`.

### Handler (`chat.js runLook(input)`)

1. `setStatus('Rendering…')` (it re-frames + re-renders).
2. If `getMeshStats()` is null / no mesh → return text block
   `Nothing is rendered yet — call apply_and_render first.` (no image).
3. Otherwise:
   - `view === 'grid'` (or omitted) → `captureMultiView()`, label
     `"render — iso · front · right · top"`.
   - else → `captureView({ view, azimuth, elevation })` (new export, below),
     label e.g. `"render — front"` or `"render — custom az45 el20"`.
4. `addImageButton(label, dataUrl, dims)` (reuse existing — this is the
   "image shows as a clickable button" affordance the user already has).
5. Return blocks: `[{type:'text', text: 'View: <desc>. Bounding box <dims>. Z-up.'},
   {type:'image', source:{...}}]`.

### Viewer: single-view capture (`js/viewer.js`)

Add a single-view sibling to `captureMultiView`, factoring the shared
save/frame/render/restore dance so both share one helper.

```js
// Camera save/restore used by every off-screen capture.
function withFramedCapture(frameFn, draw) { /* save cam+grid, frameFn(), render,
  draw(src), restore, return */ }

export function captureView({ view = 'iso', azimuth = 0, elevation = 20 } = {}, maxDim = 768) {
  if (!mesh || !renderer) return null;
  let dirVec, up, label;
  if (view === 'custom') {
    const az = azimuth * Math.PI/180, el = elevation * Math.PI/180;
    dirVec = new THREE.Vector3(Math.cos(el)*Math.cos(az), Math.cos(el)*Math.sin(az), Math.sin(el));
    up = Math.abs(elevation) > 80 ? new THREE.Vector3(0,1,0) : new THREE.Vector3(0,0,1);
    label = `custom az${Math.round(azimuth)} el${Math.round(elevation)}`;
  } else {
    const v = VIEW_DIRECTIONS[view] || VIEW_DIRECTIONS.iso;
    dirVec = new THREE.Vector3(v[0], v[1], v[2]);
    up = (view === 'top' || view === 'bottom') ? new THREE.Vector3(0,1,0) : new THREE.Vector3(0,0,1);
    label = view;
  }
  // frame, render, drawImage to a (maxDim-fit) canvas, bake `label` like
  // captureMultiView does per cell, restore camera, return {mediaType,data,label}.
}
```

Notes:
- **Azimuth/elevation convention** must match `VIEW_DIRECTIONS` so named and custom
  agree: `az=0,el=0 → [1,0,0]` = right; `az=-90,el=0 → [0,-1,0]` = front;
  `el=90 → top`. Document it in the tool description (done above) and a code comment.
- **Gimbal lock**: near-vertical elevation switches `up` to +Y, same rule
  `setView` uses for top/bottom.
- Refactor `captureMultiView` to call `withFramedCapture` too, so camera
  save/restore lives in one place (no behaviour change to the grid).

### Tools array + system prompt (`chat.js`)

- `tools: [APPLY_AND_RENDER_TOOL, LOOK_TOOL]`.
- System prompt edits:
  - `apply_and_render` now "applies the complete file and renders it, returning the
    bounding-box dimensions or the compiler error — **no image**."
  - Add `look`: "call `look` when you want to *see* the model. Default returns four
    views (ISO/FRONT/RIGHT/TOP). Use a single named view or `view:"custom"` with
    azimuth/elevation degrees to inspect a specific angle (e.g. the underside)."
  - Guidance: "A typical step is `apply_and_render` then `look` to verify. Don't
    `look` if you don't need to — images cost tokens."
  - Keep the Z-up frame description and the perspective caveat (judge sizes from the
    reported bounding box, not pixels).

---

## C. First prompt sends the 2×2 grid, not the live snapshot

In `send()`:

- Replace `captureSnapshot()` with `captureMultiView()` for the starting-state image
  attached to the outgoing user turn (still only when `code !== lastCodeSeenByModel`,
  i.e. first message of the session and after manual edits — same condition as the
  `<current_code>` prepend).
- Keep the `chatSendSnapshot` (📷) toggle as the on/off gate, **repurposed** to mean
  "attach a starting 2×2 render to my first message." No storage migration — same
  key, new meaning; update the comment in `storage.js` and the tooltip in
  `index.html`. (Renaming the key is optional and not worth the migration.)
- The image is attached as the first content block of the user turn exactly as today;
  the UI still shows the `📷 snapshot attached` tag — relabel to `📷 render attached`.

### Preview button (`chat.js showPreview`)

- `showPreview()` currently previews `captureSnapshot()`. Switch it to
  `captureMultiView()` so the 🔍 preview shows what will actually be sent. Update the
  dims line accordingly (the composite has its own dimensions).

---

## Edge cases

- **`look` before any successful render** (mesh null or last render failed): return
  text "nothing rendered yet", no image. Don't throw.
- **`look` with `view:"custom"` but missing az/el**: default `azimuth=0,
  elevation=20` (a gentle ISO-ish angle) so the call still succeeds.
- **Unknown `view` enum value** (model hallucination): fall back to `iso` (the
  `VIEW_DIRECTIONS[view] || iso` guard).
- **Turn-limit interaction**: `look` is a tool call → counts as a loop turn like
  `apply_and_render`. The existing `chatMaxTurns` cap and Stop button already cover
  runaway look/apply loops. No new control needed.
- **First-prompt grid with nothing rendered yet** (brand-new empty project): 
  `captureMultiView()` returns null when there's no mesh → attach no image (same
  null-guard as today's snapshot path).
- **Camera disturbance**: every capture restores the user's live camera (existing
  behaviour in `captureMultiView`; the refactored `withFramedCapture` preserves it).

---

## Files

- `js/viewer.js` — `captureView()` (new export), `withFramedCapture()` helper,
  refactor `captureMultiView` onto it.
- `js/chat.js` — `LOOK_TOOL`, `runLook()`, trim `runApplyAndRender()` to text-only,
  add `look` to the `tools` array, system-prompt edits, first-turn `captureMultiView`,
  `showPreview` → multiview.
- `index.html` — relabel 📷 toggle tooltip; chat-settings hint wording.
- `js/storage.js` — comment-only change on `chatSendSnapshot` (semantics).
- `sw.js` — bump `CACHE` (`scadpad-v14` → `v15`).
- `css/app.css` — none expected (reuses `.chat-tool-row` / `.chat-code-btn`).

---

## Test

Headless (Playwright, per CLAUDE.md), after demo render:

1. `import('/js/viewer.js')` → `captureView({view:'front'})` returns an image with
   `label === 'front'`; `captureView({view:'custom', azimuth:45, elevation:30})`
   returns a non-null image; both leave the live camera unchanged (snapshot the
   `camera.position` before/after and compare).
2. `captureMultiView()` still returns the 4-view grid (regression).
3. Boot with no console errors; chat tab shows the turn-limit dropdown; Send/Stop
   toggle intact.

Manual / live (needs API key):

4. Ask for a change → model calls `apply_and_render` (no image in result), then
   `look` (grid) → image button appears; a follow-up `look` with `view:"bottom"` or
   a custom angle returns the requested single view.
5. First message of a fresh chat attaches the 2×2 grid (visible via 🔍 preview and
   the `📷 render attached` tag), not the user's current single-view camera.

Regression checklist from CLAUDE.md (first-load demo renders, edit→re-render,
customizer slider, BOSL2 include, STL export validity, offline reload, quality
switch) must still pass.

---

## Open question

The `look` tool always renders **perspective** (the live viewer camera). If judging
exact proportions becomes a problem, a future `projection:"ortho"` option on `look`
(temporary `THREE.OrthographicCamera`) would remove convergence distortion — out of
scope here, noted for later.
