# Plan — Review-items 2–4 (apply-confirm, editor gutter, viewer dims/presets)

**Status:** proposed
**Scope:** the next three items from the experience-review priority table, after
item 1 (render-feedback-to-chat, planned separately in
`plan-render-feedback-to-chat.md`):

- **#2** Diff / confirm before the AI overwrites your code
- **#3** Editor line numbers + clickable error markers
- **#4** Viewer model-dimensions readout + camera presets

These are independent and can ship in any order; each has its own section. One
shared test/SW note at the end.

---

## Item 2 — Confirm before AI applies code

### Current behaviour (verified)

`send()` auto-applies the model's code with no review: `extractCodeBlock()` grabs
the **last** fenced block (`chat.js:175`) and `applyCode()` immediately replaces the
editor and re-renders (`chat.js:183-188`, called at `chat.js:270-274`). A truncated
stream, an explanation-only reply, or a partial snippet can silently clobber working
code. There is no confirmation step.

Mitigations that already exist: `applyCode()` → `setCode()` → `pushHistory()`
(`editor.js:113-118`), so an applied change *is* undoable via the existing Undo
button. The `max_tokens` cutoff already blocks apply (`chat.js:266`).

### Design

Default to **review-before-apply** with a one-tap accept, and a setting to restore
the current auto-apply for users who prefer it.

1. **Setting** (`storage.js DEFAULT_SETTINGS`): `chatAutoApply: false`
   (default = review). Absent → review.

2. **Diff dialog** — reuse the pattern of the existing `#chat-code-dialog`
   (`index.html:247`). Add a `#chat-apply-dialog` with:
   - a unified diff view (old vs. proposed), and
   - **Apply** / **Discard** buttons.
   No diff library (no-build promise) — add a tiny line-level diff helper in a new
   `js/util/linediff.js` (LCS over lines → `+`/`-`/context rows), styled with
   existing console `.err`/ok colours. Keep it small; this is display-only.

3. **Flow change in `send()`** (`chat.js:269-275`): after extracting `newCode`:
   - if `settings.chatAutoApply` → call `applyCode()` as today;
   - else → open the diff dialog with `code` (current) vs `newCode`. **Apply**
     calls the existing `applyCode(newCode)` + the existing
     `addNote('Code updated — rendering…')`; **Discard** adds a note
     (`'Change discarded.'`) and leaves the editor untouched.
   - The model turn is already saved to history regardless (`chat.js:262`), so
     discarding loses nothing in the conversation — the user can ask for a revised
     version. `lastCodeSeenByModel` must only advance when actually applied
     (it already does, inside `applyCode` at `chat.js:186`), so a discarded
     proposal means the *next* turn re-sends `<current_code>` correctly — confirm
     this holds and add a test.

4. **"Renders but looks wrong" path is unaffected**: the user just keeps chatting;
   nothing about this item changes the (separately planned) render-feedback flow.

5. **Settings UI**: a checkbox in the chat-settings dialog
   (`index.html` near `chat-set-max-tokens`, ~line 217) — "Auto-apply code from
   Claude (skip the review dialog)" — wired in `initChat()` next to the existing
   max-tokens handler (`chat.js:514-518`).

### Edge cases
- **No code block** in the reply: nothing to apply, no dialog (already handled by
  the `if (newCode …)` guard).
- **Identical code** (`newCode === code`, `chat.js:271`): no dialog.
- **Streaming / busy**: dialog opens only after `finalMessage()`; `busy` already
  gates re-entry (`chat.js:195`).
- **Mobile**: dialog must be scrollable and fit `100dvh` like the other dialogs.

### Files
`js/storage.js`, `js/chat.js`, `js/util/linediff.js` (new), `index.html`
(`#chat-apply-dialog` + settings checkbox), `css/app.css` (diff rows).

---

## Item 3 — Editor line numbers + clickable error markers

### Current behaviour (verified)

The editor is a bare `<textarea id="editor">` (`index.html:67`) inside `#code-view`;
no gutter, no line numbers (`editor.js`). Error feedback today lives only in the
Console tab: `ui.js:88-106` turns log lines containing `line (\d+)` into clickable
`.err-link` spans that switch to the Code tab and call `jumpToLine()`
(`editor.js:120-128`). So the *jump* plumbing exists; what's missing is in-editor
visibility.

### Design

Add a **line-number gutter** beside the textarea plus an **error marker** on the
failing line, reusing the existing `jumpToLine` + log-parsing plumbing.

1. **Gutter element**: wrap the textarea in a `.editor-wrap` (flex/grid:
   `[gutter][textarea]`). Gutter is a `<div>` whose content is `1\n2\n3…` kept in
   sync. The textarea keeps `overflow:auto`; the gutter scrolls in lockstep via a
   `scroll` listener (`gutter.scrollTop = textarea.scrollTop`). Line height and
   font **must match exactly** (share a CSS class) or numbers drift — call this out
   in the test.

2. **Line count sync**: on the existing `input` handler (`editor.js:62`), recompute
   line count from `value.split('\n').length` and rebuild gutter rows (cheap;
   debounce only if profiling shows jank on large files). Also rebuild on
   `setCode()`.

3. **Error markers**: introduce an exported `editor.setErrorLines(lineNos)` /
   `clearErrorLines()`. Marked gutter rows get an `.err` class (red dot / highlight)
   and are clickable → `jumpToLine(n)` (focuses + selects that line, already
   implemented). Optionally highlight the textarea line via a backdrop overlay
   (defer if costly — the gutter marker is the MVP).

4. **Wire the error source** in `ui.js` (it already parses error lines):
   - on `render:start` → `clearErrorLines()` (mirrors the existing `log.textContent=''`
     at `ui.js:110`);
   - in the `render:log` handler (`ui.js:112`), when a line matches `line (\d+)`,
     collect the number and call `setErrorLines([...])`.
   This reuses the exact regex already in `appendLog` (`ui.js:91`).

5. **Keep it no-build**: pure DOM + CSS, no editor library, consistent with the
   project's deliberate "plain textarea" choice (CLAUDE.md known-limitations).

### Edge cases
- **Wrapping**: the textarea must NOT soft-wrap (`white-space:pre; overflow-x:auto`)
  or gutter numbers won't align with visual rows. Verify `#editor` styling.
- **Soft keyboard / mobile resize**: gutter height tracks the textarea via the same
  flexport layout; re-check on the existing `ResizeObserver`-free path (editor has
  none today — rely on CSS flex).
- **Very large files**: rebuilding the gutter string each keystroke is O(n); fine
  for typical SCAD files, debounce if needed.
- Error lines must clear on a successful re-render (covered by `render:start`).

### Files
`index.html` (`.editor-wrap` + gutter div), `css/app.css` (gutter + `.err` row,
matched line metrics), `js/editor.js` (gutter sync, `setErrorLines`/`clearErrorLines`),
`js/ui.js` (collect line numbers, call setter), `js/main.js` (no change expected).

---

## Item 4 — Viewer dimensions readout + camera presets

### Current behaviour (verified)

- **Reset view is ALREADY done** — `#reset-view-btn` (`index.html:36`) is wired to
  `fitView` in `main.js:90`; a `#maximize-btn` also exists. So this item is **only
  dimensions + presets**, not reset.
- `fitView()` (`viewer.js:89-102`) computes a bounding **sphere** and frames the
  model from a fixed iso direction `(1,-1,0.8)`. No bounding-box size is surfaced.
- `getMeshStats()` returns triangle count only (`viewer.js:120-123`).
- The overlay `#viewer-overlay` shows `rendered in Xs` (`ui.js:121`).

### Design

#### 4a. Dimensions readout
1. Extend `getMeshStats()` (`viewer.js:120`) to also compute the bounding box:
   `geometry.computeBoundingBox()` → `size = box.getSize()` → return
   `{ triangles, size:[dx,dy,dz] }` (round to ~0.01). (This is the *same* extension
   the render-feedback plan needs — implement once, both consume it.)
2. Display it. Two options — pick one:
   - **(preferred)** append to the existing overlay line in `ui.js:121`:
     `rendered in 0.8s · 50 × 30 × 20 mm`. Minimal surface, no new markup.
   - or a dedicated small readout element in `#viewer-panel`.
   The overlay update happens on `render:done`; read `getMeshStats()` there (the
   geometry is already set by the viewer's own `render:done` subscription —
   ordering: viewer subscribes at `viewer.js:49`, ui at `ui.js:117`; both fire on
   the same emit, but listener order is registration order. `initViewer` runs
   before `initUI`? **No** — `initUI()` is called first in `main.js:25-26`. So at
   `render:done` time in ui.js the mesh may not yet be set.) → **Safest:** compute
   size inside the viewer's own `render:done` handler and either stash it for
   `getMeshStats()` or emit it. Call this out; don't assume cross-listener ordering.

#### 4b. Camera presets
1. Add `setView(name)` to `viewer.js` for `front | back | left | right | top |
   bottom | iso`. Reuse `fitView()`'s framing math but swap the direction vector:
   - iso `(1,-1,0.8)` (current default), front `(0,-1,0)`, back `(0,1,0)`,
     right `(1,0,0)`, left `(-1,0,0)`, top `(0,0,1)`, bottom `(0,0,-1)`.
   - Keep Z-up (`camera.up=(0,0,1)`), keep the `r*2.4` distance, near/far, and grid
     scaling already in `fitView` — factor the shared framing into a helper
     `frameFrom(dirVec)` that both `fitView` and `setView` call.
2. UI: a small preset control among the overlay buttons in `#viewer-panel`
   (`index.html:36-37`) — e.g. a compact popover or a row of buttons (Top/Front/
   Right/Iso covers 90% on mobile; full six optional). Wire clicks in `main.js`
   beside the existing `reset-view-btn` handler (`main.js:90`).
3. An **axis gizmo** (small XYZ corner widget) is a natural companion but is
   deferred — note as future work to keep this item small.

### Edge cases
- **No mesh yet**: `getMeshStats()` already returns null (`viewer.js:121`); presets
  must early-return like `fitView` (`viewer.js:90`).
- **Units**: OpenSCAD is unitless; label as "mm" by convention but keep it a plain
  number suffix that's easy to change.
- **Degenerate/flat models** (zero-thickness): bounding box may have a 0 dim — show
  `0` rather than NaN.

### Files
`js/viewer.js` (`getMeshStats` bbox, `frameFrom`, `setView`), `js/ui.js` (overlay
dims, or wherever size is surfaced), `index.html` (preset buttons), `css/app.css`
(preset control), `js/main.js` (wire presets).

---

## Shared notes

- **SW cache bump (mandatory)**: bump `CACHE` in `sw.js` on any commit touching app
  files (CLAUDE.md gotcha #10) — applies to all three items.
- **No-build constraint**: none of these introduces a bundler or framework; all are
  vanilla DOM/CSS + Three.js, per CLAUDE.md.

## Test plan (headless Chromium, `python3 -m http.server 8765`)

**Item 2**
1. Force a reply with a code block → review dialog opens, editor unchanged until
   **Apply**; **Apply** re-renders; **Discard** leaves editor + viewer as-is.
2. After Discard, send another message → outgoing request still includes
   `<current_code>` (proves `lastCodeSeenByModel` didn't advance).
3. Toggle `chatAutoApply` on → code applies with no dialog (legacy behaviour).
4. Reply with no/identical/`max_tokens`-cut code → no dialog, no clobber.

**Item 3**
5. Gutter numbers align with lines after typing, Enter/auto-indent, paste, and
   `setCode()` (project switch); gutter scrolls in lockstep with the textarea.
6. Paste code with a syntax error → render fails → gutter marks the reported line;
   clicking the marker selects that line in the editor; markers clear on the next
   successful render.
7. Confirm console `.err-link` jump still works (no regression).

**Item 4**
8. Render the demo → overlay shows dimensions alongside `rendered in Xs`; numbers
   match a known cube (`cube([50,30,20])` → `50 × 30 × 20`).
9. Each preset frames the model from the right direction, Z stays up, model stays
   centred/fit; presets early-return cleanly before first render.
10. Existing Reset-view and Maximize buttons still work (no regression).

**All**: offline reload after SW install still renders; first-load demo renders at
every quality preset (CLAUDE.md checklist).

## Out of scope (future)
- Syntax highlighting / autocomplete (separate, larger; relaxes no-build).
- Axis gizmo, wireframe/section/measure tools (viewer item set, separate plan).
- Tool-use surgical patching for chat (separate plan).
