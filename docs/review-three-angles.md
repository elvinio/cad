# ScadPad review — three angles

**Status:** review (no code changes)
**Scope:** whole-app review from three perspectives — software architect, 3D
designer (the human user), and the AI that has to drive the chat tools and
produce OpenSCAD code. Each section lists concrete improvements and gaps,
roughly ordered by value. File/line references are against the commit this
document was added in.

Bugs found *while reviewing* (verified in code, not speculation) are marked
**[bug]** — they're the strongest evidence for the structural suggestions
around them.

---

## 1. As a software architect

### What's already good (keep it)

- Module boundaries are real: cross-module talk goes through `js/state.js`,
  the worker owns wasm, heavy bytes live in IndexedDB, quota failures are
  handled where they matter. The no-build promise is held consistently
  (even `linediff.js` was written dependency-free).
- Cancellation-by-terminate with libraries re-read from IndexedDB is the
  right call for an uninterruptible `callMain`.
- The CGAL fallback in `runGeometryJob()` and the tolerant SW precache are
  hard-won and correctly commented as such.

### Bugs found in passing

1. **[bug] `render:log` payload shape mismatch.** `viewer.js:815,824,830,833`
   and `viewer.js:1170` emit `render:log` with a **string** payload, but the
   only consumer (`ui.js:136`) destructures `({ stream, line })`. Every
   assembly-part failure ("project not found", "STL not found", "failed to
   render") and every fit-pair failure prints as the literal text `undefined`
   in the console panel. The user's best diagnostic for a broken assembly is
   invisible.

2. **[bug] Deleting the *active* assembly strands the app in assembly mode.**
   `assembly.js:209-214` sets `active = null` and re-renders the list, but
   never emits anything that would flip `body.mode-assembly` off or tear down
   the viewer's parts group — the deleted assembly's meshes stay on screen
   until the user happens to open a scad project.

3. **[bug] Chat sessions can silently fail to persist.**
   `saveChatSession()` (`storage.js:198-202`) propagates `write()`'s
   `false` on QuotaExceededError, but `persistCurrentSession()`
   (`chat.js:1161-1175`) ignores the return value. Projects toast on quota;
   a long chat session just vanishes on reload with no signal. (Chat traces
   with full tool steps are also the fastest-growing thing in localStorage —
   see "move sessions to IndexedDB" below.)

4. **[bug] Dead code shipped and precached.** `js/util/linediff.js` is
   imported by nothing but listed in the SW precache (`sw.js:29`). It's the
   remnant of the apply-confirm plan
   (`docs/plan-editor-viewer-and-apply-confirm.md` item 2) that never landed —
   which matters for the AI section below. Either land the feature or drop the
   file from the shell list.

### Structural improvements

5. **Split the two god modules.** `chat.js` (1,495 lines) is transport + SSE
   parser + tool schemas + tool handlers + transcript UI + session
   persistence + two history dialogs. `viewer.js` (1,250 lines) is scene +
   capture + measurement + assembly rendering + fit engine + OFF parser.
   Natural seams that need no framework: `chat/protocol.js` (streamChatCompletion,
   OpenAI mapping), `chat/tools.js` (schemas + runTool), `chat/ui.js`,
   `chat/sessions.js`; `viewer/measure.js`, `viewer/assembly-view.js`,
   `viewer/capture.js`, `viewer/off.js`. Right now a change to the SSE parser
   and a change to the history dialog touch the same file, and the file is
   too big to hold in one head (or one AI context window — relevant given how
   this repo is maintained).

6. **Make the event bus contract explicit.** Bug #1 exists because topic
   payloads are documented only in scattered comments, and `state.js`'s own
   topic list is stale (missing `assembly:*`, `part:*`, `fit:updated`,
   `measure:updated`, `render:log`, `render:highlight`'s consumers…). A single
   `topics.js` that exports topic-name constants with JSDoc payload typedefs —
   and an `emit` that (in a debug flag) warns on unknown topics — would have
   caught #1 at the first keystroke. Cheap, no build step required.

7. **Stop paying full wasm setup on every render.** Each job re-instantiates
   the ~9.6 MB wasm **and** re-writes every installed library into MEMFS
   (`openscad-worker.js:75-85`). BOSL2 alone is hundreds of files; that's
   per-keystroke latency on a phone. Two safe steps that don't disturb the
   terminate-based cancellation model:
   - Cache the compiled `WebAssembly.Module` in the worker
     (`WebAssembly.compileStreaming` once per worker lifetime, pass via
     `instantiateWasm`) so respawn pays instantiation, not compilation.
   - Keep the fresh-instance-per-job policy (the Manifold gotcha depends on
     instance history), but memoize the *unzip* (already done) **and** the
     directory-tree layout so mounting is a flat loop of `writeFile`s.
   Measure before/after with the Node harness; the win is likely dominated by
   library mounting for BOSL2 users.

8. **The single-flight worker is shared by four callers with different
   expectations.** The live pipeline (`doRender`), STL export
   (`renderExport`), assembly part renders (`renderSource`), and the chat
   tools all funnel into the same cancel-on-new-job worker. Consequences:
   an autosave-triggered render mid-STL-export terminates the export; chat's
   `awaitRender()` (`chat.js:650-666`) resolves on *any* `render:done`,
   including one caused by the user editing concurrently, so a tool result
   can describe a render of code the model didn't write. Fix: tag jobs with
   an id + purpose, let `render:done`/`render:error` carry the id, and have
   `awaitRender` match on it; give export/assembly jobs a "don't preempt me,
   queue instead" flag.

9. **Error propagation loses the message.** The worker reports
   `OpenSCAD exited with code 1` (`openscad-worker.js:113`) while the real
   diagnosis (`ERROR: Parser error in line 12`) went past as log lines. The
   console UI re-pairs them visually and chat re-collects them via
   `notableLogs()`, i.e. two consumers already reimplement "attach the ERROR
   lines to the failure". Do it once at the source: buffer the last N stderr
   lines in the worker and put them in the `error` message.

10. **Testing is all manual recipes.** CLAUDE.md's checklist is good but
    nothing runs it. Lowest-cost first steps, all no-build:
    - Unit-test the pure functions in Node (`parseOFF`, `extractHighlights`
      + its parser, `stripTopFolder`, `diffLines`, `searchBosl2Index`,
      `definesFromOverrides`) — they're already dependency-free.
    - Check in the e2e script the git history keeps recreating in `/tmp`
      (`test/e2e.js`), and a GitHub Action that serves the repo and runs it
      headless. The "checklist that must keep passing" then actually must.

11. **SW update path has a torn-version window.** `skipWaiting()` +
    `clients.claim()` + cache-first means a new SW can take over while the
    old page is running; the worker **dynamically imports**
    `vendor/openscad/openscad.js` on every job (`openscad-worker.js:75`), so
    a mid-session update can pair an old shell with a new wasm loader. Also
    the known missing "new version available" toast. Fix both together:
    on `updatefound`, show the toast; don't `skipWaiting()` until the user
    accepts (or on next navigation), which closes the torn window too.

12. **Move chat sessions (and their step traces) to IndexedDB.** They're the
    only unbounded-ish JSON still in localStorage (capped at 20/project, but a
    single agentic session with many tool steps is tens of KB). Images already
    went to IndexedDB; sessions should follow, leaving localStorage for
    projects + settings only.

13. **Docs drift.** CLAUDE.md's architecture tree predates `assembly.js`,
    `docs.js`, `paramsets.js`, `csg-highlight.js`, `util/linediff.js`, the
    `three-mesh-bvh` vendor, and the TransformControls vendor file; the README
    still says the Drive folder is `OpenSCAD-PWA` (code says `cad`,
    `gdrive.js:15`) and promises Customizer "sliders" that don't exist (see
    §2). For a repo explicitly maintained with AI assistance, stale CLAUDE.md
    is a defect class of its own.

14. **Drive sync edge cases** (acknowledged as v1, listing for the record):
    renaming a project orphans the old remote file (next sync pushes a new
    name, old one lingers and will re-import as a new project on another
    device); two projects with the same name collide on `byName`; deletions
    don't propagate; `paramValues` aren't synced. A tombstone list + rename
    detection via `driveFileId` (already matched first) would cover most of it.

---

## 2. As a 3D designer

### The modeling loop

1. **No way to stop a long render.** Cancellation exists internally
   (terminate + respawn) but isn't surfaced. A render that takes 60 s on a
   phone (`final` quality + BOSL2 threads) just spins; the only escape is
   editing code to trigger a preempt. A stop button on the status dot is
   nearly free.

2. **No progress feedback.** `render:start` → status dot; nothing else until
   done. OpenSCAD's stderr has phase chatter that could at least drive
   "compiling / rendering / exporting" labels, plus an elapsed-seconds counter
   so slow ≠ hung. (The chat UI already learned this lesson with its
   cold-start message — the viewer never did.)

3. **Customizer has no sliders.** README promises them; `buildControl()`
   (`customizer.js:199-209`) renders number inputs + steppers only. On a
   phone, a `<input type=range>` (when `min`/`max` are known) with the
   existing 300 ms debounce is the single biggest interaction upgrade
   available. Vector parameters also fall through to a raw text field —
   three narrow number inputs would fit the existing 3-column row.

4. **No section/clipping view.** Ghost + wireframe help, but the standard
   tool for "is the wall thick enough / is the cavity right" is a clipping
   plane. Three.js does this natively (`renderer.clippingPlanes`) — a single
   axis-aligned plane with a slider would cover 90% of uses, and could be
   exposed to the AI's `look_at` too (see §3).

5. **No orthographic camera.** For judging alignment and proportion CAD users
   flip to ortho; the perspective-only view is also called out as a limitation
   in the AI's own `look` tool description. One `OrthographicCamera` +
   a toggle that maps the current framing across.

6. **Measurement is two-point only.** Good v1 (snapping is genuinely nice),
   but no angle, no edge length as a unit, no "diameter of this hole" — the
   last one being *the* 3D-printing question. Even just showing the snapped
   edge's own length when both picks land on the same edge would help.

7. **Grid gives no scale.** `frameFrom` rescales the grid continuously
   (`viewer.js:343`), so a cell is never a known size — the grid is decorative.
   Snap grid scale to 1/2/5×10ⁿ mm and print the cell size in the overlay
   ("grid: 5 mm"). A print-bed outline preset (220×220 etc.) would serve the
   same "will it fit my printer" instinct.

### Files, projects, sharing

8. **No import from device.** You can export `.scad`/STL out, but the only way
   *in* is typing or Drive sync. A file-input (and drag-drop on desktop) for
   `.scad` — and STL straight into an assembly part — closes the loop.

9. **No project thumbnails.** `captureSnapshot()` already exists for the AI;
   saving a small JPEG per project on save and showing it in the projects
   dialog would make the list scannable at zero new infrastructure (IndexedDB,
   like chat images).

10. **No templates/examples.** New projects start empty (deliberate, good for
    boot), but a "start from example" list — box with lid, gear pair,
    customizer demo — teaches both OpenSCAD and the Customizer annotations.
    The demo strings can live in a static JS file; no network.

11. **No share-by-URL.** Playground-style `#code=<lz-string>` links would make
    ScadPad viral among the OpenSCAD crowd and cost ~30 lines plus a vendored
    lz-string. (Also a natural "open in ScadPad" target for forum posts.)

12. **Export is STL-only.** 3MF is the modern default for slicers (units,
    color, multiple parts) and this wasm build exports it
    (`--export-format=3mf`). Assemblies can't be exported at all — a combined
    STL/3MF of the placed parts (bake each part's transform into its mesh) is
    the obvious v2 of the assembly feature: right now you can *verify* the fit
    but not *print* the verified arrangement.

### Assemblies

13. **The part picker is a numbered `prompt()`** (`assembly.js:295-303`).
    Every other list in the app is a proper dialog; this one is the roughest
    interaction in the product and it's on the newest flagship feature.

14. **No exploded view / no duplicate part / no snap.** Exploded (scale all
    part offsets from the assembly centroid) is cheap and demos beautifully.
    Gizmo snapping (1 mm / 5°) matters on touch where fine dragging is hard —
    the numeric panel exists but snap-while-dragging is the fluent path.

15. **The authoritative fit check is still missing** — the plan itself notes
    BVH clash ≠ boolean truth (coplanar faces, containment edge cases are
    parity-hack'd). An on-demand "verify with OpenSCAD" button that renders
    `intersection()` of each suspect pair in the worker would turn the fit
    readout from advisory into trustworthy.

### Editor

16. **No find/replace.** Before syntax highlighting, before anything: search
    in a 300-line scad file on a phone is scroll-and-squint today. A tiny
    find bar over the textarea (with `setSelectionRange` to jump) preserves
    the no-build stance.

17. **Syntax highlighting is worth revisiting** — the "plain textarea keeps
    the no-build promise" tradeoff conflates *no build for us* with *no
    prebuilt vendored assets*, but the repo already vendors prebuilt Three.js.
    A vendored CodeMirror 6 ESM bundle (one file, import-mapped) would bring
    highlighting, bracket match, find/replace, and mobile-decent selection at
    the same provenance standard as `vendor/three`. Keep the textarea as a
    setting fallback if bundle size on first load is a concern.

18. **`text()` with no fonts installed fails cryptically.** The app knows
    whether the `fonts` lib is installed and can see `text(` in the source —
    one targeted hint ("install fonts in Libraries") in the console would
    save every new user the same confusion.

---

## 3. As the AI that drives the tools

This is the strongest part of the app conceptually — a real agentic loop with
file-style editing, param control, vision, and library lookup is ahead of most
"AI CAD" products. The gaps are in feedback quality and loop robustness.

### Feedback quality (what the model gets back)

1. **Echo the edited region back in the `edit_code` result.** Today a
   successful edit returns only "Render OK. Bounding box …". Line-number
   edits are the classic small-model failure (off-by-one, wrong indentation
   splice), and the model can't see what it produced without spending a turn
   on `read_code`. Append the new numbered content of `start_line-2 ..
   end_of_replacement+2` to the tool result — a few hundred tokens that saves
   whole turns and prevents compounding mis-edits.

2. **Add a string-replace edit tool.** `replace_text(old_string, new_string)`
   with a uniqueness check is far more robust for LLMs than line arithmetic
   (it's what every coding agent converged on, including the one writing this
   review). Keep `edit_code` for insertions; route the staleness guard through
   content matching, which brings…

3. **Soften the staleness guard.** `getCode() !== lastCodeSeenByModel`
   (`chat.js:723`) rejects an edit if the user touched *anything anywhere*,
   costing a full read-the-whole-file round trip. If the *target range's*
   content still matches what the model last read, the edit is safe; and when
   rejecting, include the current content of the target range in the rejection
   so recovery is one turn, not two.

4. **`look` after a failed render silently shows stale geometry.** If
   `edit_code` fails to compile and the model calls `look` anyway, it gets the
   *previous* successful mesh with no warning (`runLook` only guards the
   never-rendered case, `chat.js:788-802`). Track render-failed state and
   prefix the caption: "WARNING: this is the last successful render; the
   current code does not compile."

5. **A `find_code(regex)` tool.** For long files the model currently reads
   everything. Grep-with-line-numbers is ~20 lines of implementation and cuts
   token burn on every non-trivial session.

6. **Vision improvements, in value order:**
   - **Orthographic capture option** for `look`/`look_at` — the tool
     descriptions currently have to warn the model *not* to trust the pixels.
   - **Scale annotation baked into the image** (a labelled mm bar, like the
     view labels already baked in) so "is that hole ~5 mm?" is answerable.
   - **Section view** in `look_at` (`clip_z: 12` style) once the viewer grows
     a clipping plane (§2.4) — wall thickness is the #1 thing ghost mode
     approximates poorly.
   - Expose the existing mesh stats richer: `get_stats` with per-axis bbox,
     triangle count, and (cheap to add from the BVH work) watertightness —
     lets the model verify printability without an image at all.

7. **Generalize `lookup_lib` beyond BOSL2.** The prompt tells the model not
   to guess signatures, but MCAD/NopSCADlib/BOSL have no index, so guessing is
   the only option for them. `scripts/build-bosl2-index.mjs` already exists —
   parameterize it per library and ship one index per curated zip. Also expose
   the human Doc tab's builtin reference (`docs.js`, 685 lines of curated
   signatures) as a `lookup_docs` tool — it's sitting there already structured.

### Loop robustness (protocol level)

8. **Dangling tool calls when `finish_reason !== 'tool_calls'`.**
   `chat.js:1023` only executes tools when the finish reason is exactly
   `tool_calls`, but some OpenAI-compatible servers (and some vLLM tool
   parsers) emit tool calls with `finish_reason: 'stop'`. The assistant
   message *with* `tool_calls` is still pushed into `messages`
   (`chat.js:1011-1021`), so the next request contains a tool call with no
   tool result — strict servers 400 on that, lenient ones confuse the model.
   Gate on `final.toolCalls.length` instead, and treat the finish reason as
   advisory.

9. **Malformed tool arguments are silently emptied.** `JSON.parse` failure →
   `input = {}` (`chat.js:1026`) → e.g. `write_code` with `{}` replaces the
   file with an empty string via `String(input?.code ?? '')`. Return an error
   tool result ("arguments were not valid JSON — resend") instead of running
   the tool with defaults.

10. **`finish_reason: 'length'` is invisible.** CLAUDE.md claims it drives a
    max-tokens warning, but `send()` only special-cases the turn-limit note;
    a truncated reply just ends. Add a note so the user knows to say
    "continue" (and so a truncated `write_code` never looks like a decision).

11. **Stop can't interrupt a render.** `stop()` aborts the HTTP stream, but a
    tool mid-`awaitRender` waits up to 90 s (`chat.js:663`). Render-manager
    already knows how to cancel (terminate); export a `cancelRender()` and
    call it from `stop()`.

12. **Session resume degrades the model's memory.** Persisted history stores
    assistant turns as flattened text; a resumed conversation re-sends
    `'(no reply text — see tool calls)'` for tool-only turns
    (`chat.js:1078`), so the model no longer knows *what it edited* earlier —
    while `lastCodeSeenByModel` still tells it the code is familiar. Persist a
    compact textual trace instead ("[edited lines 12–20]", "[set width=40]",
    "[looked: render OK 40×20×10]") — the `steps` array already contains
    everything needed to synthesize it.

13. **No context-window management.** History grows without bound within a
    session and the whole thing is re-sent every request. Against a
    self-hosted model with a finite context, long sessions will be truncated
    server-side with no client awareness. Track approximate tokens (usage is
    already collected per turn) and window or summarize old turns client-side
    past a threshold.

### Product level

14. **Land the apply-confirm plan.** The AI applies `write_code` to the
    user's project instantly; a truncated or misparsed generation clobbers
    working code with only editor-undo as the net. The plan
    (`docs/plan-editor-viewer-and-apply-confirm.md`) is written, the diff
    util is shipped and precached, and review-before-apply (with an
    auto-apply setting) is table stakes for trusting an agent with your only
    copy of a model. This is the highest-value unfinished work in the repo.

15. **The provider layer is one rename away from generic.** The transport is
    already plain OpenAI chat-completions against a configurable base URL —
    only the *labels* (`modalBaseUrl`, "Modal proxy URL") say otherwise.
    Rename to `chatBaseUrl`/`chatApiKey` in settings/UI (keeping the old keys
    as fallback) and ScadPad works out of the box with OpenRouter, Ollama,
    llama.cpp, vLLM anywhere — which also de-risks the (third) provider
    migration this repo has already been through.

16. **No eval harness for the agent.** Prompt and tool changes currently ship
    on vibes. A scripted eval (Node + the wasm harness + a live endpoint):
    five tasks — "make a 20 mm cube", "add a 5 mm hole through it", "fix this
    broken code", "make it parametric", "use BOSL2 rounding" — scored on
    compile success + bbox match, run before merging prompt/tool changes.
    Even three tasks would have caught most historical regressions in the
    tool descriptions.

---

## Suggested priority (cross-cutting)

| # | Item | Angle | Effort |
|---|------|-------|--------|
| 1 | Apply-confirm before AI code lands (§3.14) | AI/designer | plan exists |
| 2 | Fix `render:log` payload bug (§1.1) + delete-active-assembly bug (§1.2) | arch | trivial |
| 3 | Echo edited region in `edit_code` results (§3.1) | AI | small |
| 4 | Customizer sliders (§2.3) | designer | small |
| 5 | Stop button for renders (§2.1) + chat Stop cancels render (§3.11) | both | small |
| 6 | Tool-call gate on `toolCalls.length`, arg-parse errors (§3.8-9) | AI | small |
| 7 | Worker: cache compiled wasm module + faster lib mount (§1.7) | arch | medium |
| 8 | Generalized library indexes + `lookup_docs` (§3.7) | AI | medium |
| 9 | Job-tagged render bus (fixes awaitRender races) (§1.8) | arch | medium |
| 10 | 3MF + assembly export (§2.12) | designer | medium |
