# Plan — Feed render results back into AI Chat

**Status:** proposed
**Scope:** make the AI chat aware of the latest render outcome (success stats or
failure errors) so it can self-correct, without taxing every unrelated question.

## Goal / decided behaviour

Today `js/chat.js` subscribes only to `project:changed`. It never sees
`render:error`, `render:log`, or `render:done`, so when Claude writes broken code
*you* have to paste the error back manually.

This change gives Claude the last render outcome. The agreed model (from the
design discussion) is **automatic-on-failure + a manual "send to chat" button +
a settings toggle** for power users:

- **Default (`auto-fail`)**: when the last render *errored*, the error context is
  attached automatically to your next chat message. On success, nothing is
  attached except an optional one-line summary (see below). This handles the
  expensive case (won't-compile) hands-free without spending tokens narrating
  success on every unrelated question.
- **Manual button**: an "Ask AI to fix" affordance on the error badge / console
  for the *renders-but-looks-wrong* case (compiles fine, geometry is wrong).
  One tap switches to Chat, attaches the render context, and focuses the input.
- **Settings toggle (`chatRenderFeedback`)**: `auto-fail` (default) · `always` ·
  `off`, mirroring the existing `chatSendSnapshot` pattern so users can force
  fully-automatic or fully-manual.

## What data is available (verified)

- `render:done` → `{ offText, elapsedMs }` (see `render-manager.js:142`). Triangle
  count is derivable via `viewer.getMeshStats()` (`viewer.js:120`). **Bounding-box
  dimensions are NOT currently computed** — small addition needed (below).
- `render:error` → `{ message }` (`render-manager.js:149`). This is often a generic
  exception/"worker error" string.
- `render:log` → `{ stream, line }`. The *real* OpenSCAD compiler errors
  (`ERROR: Parser error in line 12…`) arrive here, not in `render:error`. `ui.js:112`
  already filters `^ERROR|^WARNING`. **The useful error text must be collected from
  the log lines, not just `render:error.message`.**
- `render:start` clears the console (`ui.js:108-111`) — so error-line collection in
  chat must reset on `render:start` too.

## Design

### 1. New setting

In `js/storage.js` `DEFAULT_SETTINGS`, add:

```
chatRenderFeedback: 'auto-fail',   // 'auto-fail' | 'always' | 'off'
```

Backwards-compatible: absent value falls back to `'auto-fail'`.

### 2. Track the last render outcome in `js/chat.js`

Add module state and subscriptions (alongside the existing `project:changed`
subscription in `initChat`):

```
let lastRender = null;     // see shape below
let renderErrorLines = []; // collected between render:start and done/error
let feedbackSent = false;  // true once the current outcome has been sent to the model
```

Subscriptions:

- `subscribe('render:start', …)` → `renderErrorLines = []`.
- `subscribe('render:log', ({stream,line}) => …)` → push lines matching
  `^ERROR|^WARNING` (cap to last ~20 lines to bound tokens).
- `subscribe('render:done', ({elapsedMs}) => …)` → set
  `lastRender = { status:'ok', elapsedMs, stats: getMeshStats(), at: Date.now() }`;
  `feedbackSent = false`.
- `subscribe('render:error', ({message}) => …)` → set
  `lastRender = { status:'error', message, errors:[...renderErrorLines], at:Date.now() }`;
  `feedbackSent = false`.

`feedbackSent = false` on every new outcome is what lets the next message pick it
up exactly once.

Outcome shape:

```
{ status:'ok',    elapsedMs, stats:{triangles, size:[x,y,z]}, at }
{ status:'error', message, errors:[ "ERROR: …", … ],          at }
```

### 3. Bounding-box dimensions (small viewer addition)

Extend `viewer.js getMeshStats()` to also return model size. The bounding box is
cheap from the existing geometry:

```
geometry.computeBoundingBox();  // or reuse boundingSphere already used by fitView()
return { triangles, size:[dx, dy, dz] };  // rounded to ~0.01
```

This makes the success summary genuinely useful ("renders OK · 4.2k tris ·
50 × 30 × 20").

### 4. Build the feedback block

A helper `buildRenderFeedback()` returns a string wrapped in a new tag the system
prompt will document, e.g.:

- Failure:
  ```
  <render_result status="error">
  The current code failed to render. OpenSCAD reported:
  ERROR: Parser error in line 12: syntax error
  …
  </render_result>
  ```
- Success (only attached in `always` mode, or as a one-liner):
  ```
  <render_result status="ok">
  Rendered successfully in 0.8s · 4214 triangles · bounding box 50 × 30 × 20 mm.
  </render_result>
  ```

### 5. Decide whether to attach (in `send()`)

Mirror the existing `<current_code>` prepend logic (`chat.js:213-218`). Just before
building `userText`, decide `attachFeedback`:

```
const mode = settings.chatRenderFeedback ?? 'auto-fail';
const attachFeedback =
  !feedbackSent && lastRender && (
    mode === 'always' ||
    (mode === 'auto-fail' && lastRender.status === 'error') ||
    manualFeedbackRequested            // set by the "Ask AI to fix" button
  );
```

If attaching, prepend the `<render_result>` block to `userText` (after the
optional `<current_code>` block), set `feedbackSent = true`, and clear
`manualFeedbackRequested`.

Token hygiene — identical to how snapshots/`<current_code>` are handled:
- The block is added only to the **outgoing** turn (`messages[len-1]`), never
  replayed into history. `displayText()` (`chat.js:292`) must also strip the
  `<render_result>…</render_result>` prefix so saved/restored bubbles show only
  what the user typed (extend its existing regex).
- `feedbackSent` guards against re-sending the same unchanged outcome on every
  subsequent message.

### 6. Manual "Ask AI to fix" affordance

The error badge is `#error-badge` (`ui.js:84`); errors already show in the Console
tab. Add a small button (e.g. next to the badge, or in the console header) shown
only when `#error-badge` is visible: **"Ask AI to fix"**.

Click handler (in `ui.js`, calling an exported `chat.js` hook):
1. Switch to the Chat tab (`document.querySelector('[data-tab="chat-view"]').click()`).
2. Set `manualFeedbackRequested = true` in chat (export a setter, e.g.
   `requestRenderFeedback()`), so the *next* send attaches the context even in
   `off`/`auto-fail`-success modes.
3. Pre-fill `#chat-input` with a nudge ("Fix this render error") and focus it —
   leave the actual send to the user so they can edit.

### 7. System prompt update

Add to `DEFAULT_SYSTEM_PROMPT` (`chat.js:13`) a line describing the new tag:

> The app may include a `<render_result>` block reporting whether the previous
> code rendered. `status="error"` means it failed to compile — fix the reported
> error. `status="ok"` includes triangle count and bounding-box size you can use
> to sanity-check the geometry.

Because `chatSystemPrompt` stores `null` to track the default (`chat.js:522`),
users on the default automatically get the new wording; only users who customised
their prompt keep the old one (acceptable).

### 8. Settings UI

Add a `<select id="chat-set-render-feedback">` to the chat settings dialog
(`index.html` near the max-tokens / snapshot controls, ~line 217), with options
On-failure (default) / Always / Off. Wire in `initChat()` next to the existing
`chat-set-max-tokens` handler (`chat.js:514-518`): read on init, `saveSettings`
on change.

## Edge cases

- **No render yet** (`lastRender === null`): attach nothing.
- **Snapshot on failure**: a failed render usually leaves the previous mesh (or
  none) in the viewer, so `captureSnapshot()` may be stale or null. Leave snapshot
  behaviour unchanged; the text error block is the signal that matters. Optionally
  note in the feedback that the image (if any) reflects the *previous* good render.
- **Manual edits between renders**: outcome still applies to the code the model is
  about to receive via `<current_code>`; no special handling.
- **Cancelled renders**: `render-manager.js:147` returns silently on `'cancelled'`
  with no `render:done`/`render:error`, so `lastRender` is untouched — correct.
- **Error-line volume**: cap collected lines (~20) and total chars to bound tokens.
- **`max_tokens` cutoff** already blocks code application (`chat.js:266`); feedback
  logic is independent and unaffected.

## Files touched

- `js/storage.js` — new `chatRenderFeedback` default.
- `js/viewer.js` — extend `getMeshStats()` with bounding-box `size`.
- `js/chat.js` — render-event subscriptions, `lastRender`/`feedbackSent` state,
  `buildRenderFeedback()`, attach logic in `send()`, `displayText()` strip,
  exported `requestRenderFeedback()`, system-prompt line, settings wiring.
- `js/ui.js` (+ `index.html`) — "Ask AI to fix" button on the error badge/console;
  settings `<select>`; import the chat hook.
- `sw.js` — **bump `CACHE` version** (mandatory per CLAUDE.md gotcha #10).

## Test plan

Per CLAUDE.md (`python3 -m http.server 8765`, headless Chromium):

1. **Auto-fail**: paste code with a syntax error → render fails, badge shows →
   send a chat message → verify the outgoing request includes
   `<render_result status="error">` with the OpenSCAD error line, and that the
   saved chat bubble does NOT show the block (stripped by `displayText`).
2. **Success, auto-fail mode**: valid code, send a question → verify NO
   `<render_result>` block is attached (token hygiene).
3. **Always mode**: switch setting → send → verify success summary with triangle
   count and bounding-box size is attached.
4. **Off mode**: verify nothing is attached even on error.
5. **Manual button**: with an error showing, click "Ask AI to fix" → lands on Chat
   tab, input pre-filled and focused → send → error block attached regardless of
   mode.
6. **Resend guard**: after sending feedback once, send a second message without
   re-rendering → verify the block is NOT attached again (`feedbackSent`).
7. Regression: existing `<current_code>` prepend and snapshot attach still work;
   offline boot still works (no new eager imports).

## Out of scope (future)

- Tool-use / surgical patching (separate, larger plan).
- Sending structured geometry (manifoldness, open edges) beyond tri count + bbox.
- Auto-resend loop (model fixes → auto re-render → auto re-feed) without user turn.
