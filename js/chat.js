// AI chat: talk to Claude about the current model via the Anthropic SDK.
// The SDK (vendor/anthropic/) is dynamically imported on first send so the
// app still boots offline; chat itself naturally needs the network.

import { getSettings, saveSettings,
  getChatSessions, saveChatSession, deleteChatSession } from './storage.js';
import { emit, subscribe } from './state.js';
import { getCode, setCode } from './editor.js';
import { updateActiveCode } from './projects.js';
import { captureView, captureMultiView, getMeshStats } from './viewer.js';
import { toast } from './ui.js';

export const DEFAULT_SYSTEM_PROMPT =
`You are an expert CAD designer working inside ScadPad, a mobile OpenSCAD editor. The user's current OpenSCAD code is provided in <current_code> tags. Work from that code to achieve what the user needs.

To change the model you MUST call the apply_and_render tool with the COMPLETE updated file — do not paste OpenSCAD code into your text reply. apply_and_render replaces the editor contents and renders the model, returning the bounding-box dimensions and triangle count on success, or the compiler error on failure — it returns NO image. If it fails to compile, call apply_and_render again with a fix.

To SEE the model, call the look tool. By default look returns a 2×2 grid of four labelled views in OpenSCAD's Z-up frame: ISO (corner), FRONT (looking along -Y), RIGHT (looking along +X), and TOP (looking down -Z). Pass a single named view (e.g. view:"bottom"), or view:"custom" with azimuth/elevation degrees, to inspect a specific angle such as an underside or a detail. A typical step is apply_and_render then look to verify the geometry — but don't call look if you don't need to, since images cost tokens. The views are perspective, so judge sizes from the reported bounding box, not from pixels.

When the model looks right, stop calling tools and give a one- or two-sentence summary.

Rules:
- Always pass the COMPLETE file to apply_and_render — never fragments or diffs.
- Keep the code valid OpenSCAD. Preserve the user's Customizer parameters (top-level variables with their // [min:max] annotations and // descriptions) unless asked to change them.
- Keep explanations brief — the user is on a phone.
- If a request is ambiguous, make a sensible choice and note it briefly rather than asking questions.`;

// Tool the model calls to apply code to the editor and render it. The handler
// (runApplyAndRender) returns the bounding-box dimensions on success, or the
// compiler error on failure — no image. Seeing the model is the look tool's job.
const APPLY_AND_RENDER_TOOL = {
  name: 'apply_and_render',
  description:
    'Replace the entire OpenSCAD editor contents with `code` and render the model. '
    + 'On success you get the bounding-box dimensions and triangle count (NO image — call look to see it). '
    + 'On failure you get the compiler error. Always send the COMPLETE file.',
  input_schema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'The complete OpenSCAD source for the whole file.' },
    },
    required: ['code'],
  },
};

// Tool the model calls to SEE the current model. Renders an off-screen image
// (runLook): a 2×2 grid of four views by default, or a single named/custom
// angle. Decoupled from apply_and_render so confirming "did it compile?" costs
// no image tokens and the model can choose what angle to inspect.
const LOOK_TOOL = {
  name: 'look',
  description:
    'Render the CURRENT model to an image so you can inspect it. Default is a 2×2 grid of four labelled '
    + 'views (ISO, FRONT, RIGHT, TOP) in OpenSCAD Z-up coordinates. Pass a single named view, or '
    + 'view:"custom" with azimuth/elevation degrees, to look from a specific angle (e.g. an underside or a '
    + 'detail). Call apply_and_render first if you have changed the code.',
  input_schema: {
    type: 'object',
    properties: {
      view: {
        type: 'string',
        enum: ['grid', 'iso', 'front', 'back', 'left', 'right', 'top', 'bottom', 'custom'],
        description: 'Which view. "grid" (default) = 2×2 of iso/front/right/top.',
      },
      azimuth: {
        type: 'number',
        description: 'Custom only: degrees around +Z from +X (CCW). 0=+X (right), 90=+Y (back), -90=-Y (front).',
      },
      elevation: {
        type: 'number',
        description: 'Custom only: degrees above the XY plane. 90=straight down (top), -90=straight up.',
      },
    },
  },
};

// Conversation state. History stores text-only content; the rendered-model
// snapshot is attached only to the outgoing (latest) user message so old
// images don't accumulate input-token cost.
//
// A "session" is one conversation. It lives in memory here and is persisted
// (per project, text-only) to localStorage after every turn so it survives
// reloads and project switches — letting you resume an iteration later.
let history = [];
let lastCodeSeenByModel = null;
let busy = false;
let sdkClientPromise = null;

// Tool-loop control: stopRequested is set by the Stop button; activeStream is
// the in-flight SDK stream so Stop can abort the current model reply.
let stopRequested = false;
let activeStream = null;

// Persistence bookkeeping for the active session.
let currentProjectId = null;
let currentSessionId = null;       // null until the session has been saved once
let currentSessionCreated = null;
let previewDataUrl = null;         // last image shown in the preview dialog

const $ = id => document.getElementById(id);

function getSystemPrompt() {
  return getSettings().chatSystemPrompt || DEFAULT_SYSTEM_PROMPT;
}

async function getClient() {
  const { anthropicApiKey } = getSettings();
  if (!anthropicApiKey) {
    throw new Error('No Anthropic API key set — add one in Chat settings.');
  }
  if (!sdkClientPromise) {
    sdkClientPromise = import('../vendor/anthropic/index.mjs')
      .catch(e => { sdkClientPromise = null; throw e; });
  }
  const { default: Anthropic } = await sdkClientPromise;
  return new Anthropic({ apiKey: anthropicApiKey, dangerouslyAllowBrowser: true });
}

// ---------- message rendering ----------

// Input/output price per million tokens, used for the per-message cost estimate.
const MODEL_PRICING = {
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5':  { in: 1, out: 5 },
};

function formatTimestamp(ts) {
  // e.g. "Jun 13, 2026, 4:13 AM" — date and time, locale-formatted.
  return new Date(ts).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function estimateCostUsd(model, usage) {
  const p = MODEL_PRICING[model];
  if (!p || !usage) return null;
  return (usage.input_tokens * p.in + usage.output_tokens * p.out) / 1e6;
}

// Bottom-of-message stats line: time taken · tokens · estimated USD cost.
function formatStats({ model, durationMs, usage } = {}) {
  const parts = [];
  if (durationMs != null) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
  if (usage) parts.push(`${usage.input_tokens} in / ${usage.output_tokens} out tok`);
  const cost = estimateCostUsd(model, usage);
  if (cost != null) parts.push(`~$${cost.toFixed(4)}`);
  return parts.join(' · ');
}

// Open the code-artifact modal with the given code.
function showCodeArtifact(code) {
  $('chat-code-content').textContent = code;
  $('chat-code-dialog').showModal();
}

// Minimal markdown-ish renderer: fenced code blocks are hidden behind a "code
// artifact" button (opens a modal); the rest is plain text (textContent — no
// HTML injection).
function renderMessageBody(el, text) {
  el.textContent = '';
  const parts = text.split(/```[a-zA-Z]*\n?/);
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) {
      const code = part.replace(/\n$/, '');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-code-btn';
      btn.textContent = '📄 View code artifact';
      btn.addEventListener('click', () => showCodeArtifact(code));
      el.appendChild(btn);
    } else {
      const p = document.createElement('div');
      p.textContent = part;
      el.appendChild(p);
    }
  });
}

// Render one full-width message: timestamp on top, body, then (for assistant
// turns) a stats footer. Returns the message element; the body is queryable via
// `.chat-msg-body` for streaming updates.
function addBubble(role, text, { withSnapshot = false, ts = Date.now(), meta = null } = {}) {
  $('chat-empty-hint')?.remove();
  const container = $('chat-messages');
  const msg = document.createElement('div');
  msg.className = `chat-msg ${role}`;

  const time = document.createElement('div');
  time.className = 'chat-msg-time';
  time.textContent = formatTimestamp(ts);
  msg.appendChild(time);

  const body = document.createElement('div');
  body.className = 'chat-msg-body';
  renderMessageBody(body, text);
  msg.appendChild(body);

  if (withSnapshot) {
    const tag = document.createElement('span');
    tag.className = 'chat-snapshot-tag';
    tag.textContent = '📷 render attached';
    body.appendChild(tag);
  }

  if (meta) setBubbleStats(msg, meta);

  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
  return msg;
}

// Add or replace the stats footer on a message element.
function setBubbleStats(msg, meta) {
  msg.querySelector('.chat-msg-stats')?.remove();
  const stats = document.createElement('div');
  stats.className = 'chat-msg-stats';
  stats.textContent = formatStats(meta);
  msg.appendChild(stats);
}

function addNote(text, isError = false) {
  const container = $('chat-messages');
  const note = document.createElement('p');
  note.className = `chat-note${isError ? ' error' : ''}`;
  note.textContent = text;
  container.appendChild(note);
  container.scrollTop = container.scrollHeight;
}

// ---------- code apply ----------

function applyCode(code) {
  setCode(code);
  updateActiveCode(code);
  lastCodeSeenByModel = code;
  emit('code:changed', { code, immediate: true });
}

// ---------- busy / status UI ----------

// Toggle the composer between Send (idle) and Stop (a reply is in flight). The
// button stays enabled while busy so it can interrupt; send() guards re-entry.
function setBusy(on) {
  busy = on;
  const btn = $('chat-send-btn');
  btn.classList.toggle('stop', on);
  btn.title = on ? 'Stop' : 'Send';
  btn.textContent = on ? '■' : '➤'; // ■ / ➤
}

// A single status line at the bottom of the transcript: animated dots plus a
// label ("Thinking…" / "Rendering…"). Pass null to remove it.
function setStatus(text) {
  const container = $('chat-messages');
  let el = $('chat-status');
  if (!text) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'chat-status';
    el.className = 'chat-status';
    container.appendChild(el);
  }
  el.textContent = '';
  const dots = document.createElement('span');
  dots.className = 'chat-typing';
  dots.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
  const label = document.createElement('span');
  label.textContent = text;
  el.append(dots, label);
  container.scrollTop = container.scrollHeight;
}

// ---------- tool-result image button ----------

// Show a rendered-image button in the transcript; clicking opens it in the
// preview modal. This is exactly the image handed to the model as the tool
// result, so the user can see what Claude saw.
function addImageButton(label, dataUrl, caption) {
  const container = $('chat-messages');
  const row = document.createElement('div');
  row.className = 'chat-tool-row';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chat-code-btn';
  btn.textContent = `\u{1F5BC} ${label}`;
  btn.addEventListener('click', () => openImageModal(dataUrl, caption));
  row.appendChild(btn);
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

function openImageModal(dataUrl, caption) {
  previewDataUrl = dataUrl;
  const img = $('chat-preview-img');
  img.onload = () => { $('chat-preview-dims').textContent = caption || `${img.naturalWidth} × ${img.naturalHeight}px`; };
  img.src = dataUrl;
  $('chat-preview-dialog').showModal();
}

// ---------- apply_and_render tool handler ----------

// Apply code to the editor and resolve once the render settles (render:done or
// render:error). The render is driven by the normal pipeline via applyCode().
function applyAndAwaitRender(code) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      offDone(); offErr(); clearTimeout(timer);
      resolve(res);
    };
    const offDone = subscribe('render:done', (p) => finish({ ok: true, elapsedMs: p.elapsedMs }));
    const offErr = subscribe('render:error', (p) => finish({ ok: false, error: p.message }));
    const timer = setTimeout(() => finish({ ok: false, error: 'Render timed out after 90s.' }), 90000);
    applyCode(code);
  });
}

// Current bounding-box / triangle-count line, or a fallback if no mesh.
function currentDims() {
  const stats = getMeshStats();
  return stats
    ? `${stats.size[0]} × ${stats.size[1]} × ${stats.size[2]} mm · ${stats.triangles} tris`
    : 'unknown size';
}

// Run one apply_and_render call: apply + render, surface progress/error in the
// UI, and return the text-only tool_result. No image — the model calls look to
// inspect the result.
async function runApplyAndRender(code) {
  setStatus('Rendering…');
  const res = await applyAndAwaitRender(code);
  if (!res.ok) {
    addNote(`Render failed: ${res.error}`, true);
    return [{ type: 'text',
      text: `Render failed: ${res.error}\nFix the code and call apply_and_render again with the complete file.` }];
  }
  const dims = currentDims();
  addNote(`Rendered — ${dims}`);
  return [{ type: 'text',
    text: `Render OK. Bounding box ${dims}. Call look to inspect the model.` }];
}

// Run one look call: capture the requested view off-screen, surface it as an
// image button in the UI, and return the image (plus a description) as the
// tool_result so the model can see the model.
async function runLook(input = {}) {
  setStatus('Rendering…');
  if (!getMeshStats()) {
    return [{ type: 'text', text: 'Nothing is rendered yet — call apply_and_render first.' }];
  }
  const view = input.view || 'grid';
  let img, label;
  if (view === 'grid') {
    img = captureMultiView();
    label = 'iso · front · right · top';
  } else {
    img = captureView({ view, azimuth: input.azimuth, elevation: input.elevation });
    label = img?.label || view;
  }
  if (!img) {
    return [{ type: 'text', text: 'Nothing is rendered yet — call apply_and_render first.' }];
  }
  const dims = currentDims();
  addImageButton(`View render — ${label}`,
    `data:${img.mediaType};base64,${img.data}`, `Bounding box: ${dims}`);
  return [
    { type: 'text', text: `View: ${label}. Bounding box ${dims}. OpenSCAD Z-up coordinates.` },
    { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } },
  ];
}

function isAbortError(e) {
  return e?.name === 'AbortError' || e?.name === 'APIUserAbortError' || /abort/i.test(e?.message || '');
}

// ---------- send ----------

// Stop the current reply: abort the in-flight stream and break the loop after
// the current step finishes.
function stop() {
  if (!busy) return;
  stopRequested = true;
  setStatus('Stopping…');
  activeStream?.abort();
}

async function send() {
  const input = $('chat-input');
  const prompt = input.value.trim();
  if (!prompt || busy) return;

  const settings = getSettings();
  let client;
  try {
    client = await getClient();
  } catch (e) {
    toast(e.message, 'error');
    return;
  }

  stopRequested = false;
  setBusy(true);
  input.value = '';
  input.style.height = '';

  // Include current code when the model hasn't seen this version yet
  // (always on the first message, and again after manual edits).
  const code = getCode();
  const codeIsNew = code !== lastCodeSeenByModel;
  let userText = prompt;
  if (codeIsNew) {
    userText = `<current_code>\n${code}\n</current_code>\n\n${prompt}`;
    lastCodeSeenByModel = code;
  }
  const userTs = Date.now();
  history.push({ role: 'user', content: userText, ts: userTs });

  // Attach a starting 2×2 render only when the model hasn't seen this code yet
  // (first message of a session, and after manual edits) — same gate as the
  // <current_code> prepend — and only if the user has the toggle on.
  const snapshot = (settings.chatSendSnapshot && codeIsNew) ? captureMultiView() : null;
  addBubble('user', prompt, { withSnapshot: !!snapshot, ts: userTs });

  // Working message list for the API. History is text-only; the starting-state
  // snapshot is attached to the outgoing user turn only, and tool round-trips
  // for THIS send are appended here (not persisted — see below).
  const messages = history.map(m => ({ role: m.role, content: m.content }));
  if (snapshot) {
    messages[messages.length - 1] = {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: snapshot.mediaType, data: snapshot.data } },
        { type: 'text', text: userText },
      ],
    };
  }

  const maxTurns = Math.max(1, Number(settings.chatMaxTurns) || 10);
  const startedAt = Date.now();
  const assistantTextParts = [];
  let totalIn = 0, totalOut = 0;
  let lastMeta = null;
  let lastStop = null;
  let failed = false;

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (stopRequested) break;

      setStatus('Thinking…');
      const assistantBubble = addBubble('assistant', '…');
      const assistantBody = assistantBubble.querySelector('.chat-msg-body');

      const stream = client.messages.stream({
        model: settings.chatModel,
        max_tokens: Math.max(256, Number(settings.chatMaxTokens) || 4096),
        system: getSystemPrompt(),
        messages,
        tools: [APPLY_AND_RENDER_TOOL, LOOK_TOOL],
      });
      activeStream = stream;

      let accumulated = '';
      stream.on('text', (delta) => {
        accumulated += delta;
        renderMessageBody(assistantBody, accumulated);
        $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
      });

      let final;
      try {
        final = await stream.finalMessage();
      } catch (e) {
        if (isAbortError(e)) { if (!accumulated) assistantBubble.remove(); break; }
        throw e;
      } finally {
        activeStream = null;
      }

      const text = final.content.filter(b => b.type === 'text').map(b => b.text).join('');
      totalIn += final.usage.input_tokens;
      totalOut += final.usage.output_tokens;
      lastMeta = {
        model: settings.chatModel,
        durationMs: Date.now() - startedAt,
        usage: { input_tokens: totalIn, output_tokens: totalOut },
      };
      lastStop = final.stop_reason;

      if (text) {
        renderMessageBody(assistantBody, text);
        setBubbleStats(assistantBubble, lastMeta);
        assistantTextParts.push(text);
      } else {
        assistantBubble.remove();
      }

      // Replay the assistant turn verbatim (text + any tool_use blocks) so the
      // next request continues the same tool exchange.
      messages.push({ role: 'assistant', content: final.content });

      if (final.stop_reason === 'tool_use') {
        const toolResults = [];
        for (const block of final.content) {
          if (block.type !== 'tool_use') continue;
          let content;
          if (block.name === 'apply_and_render') content = await runApplyAndRender(block.input?.code ?? '');
          else if (block.name === 'look') content = await runLook(block.input ?? {});
          else content = [{ type: 'text', text: `Unknown tool: ${block.name}` }];
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
        }
        messages.push({ role: 'user', content: toolResults });
        continue; // let the model inspect the render and decide what's next
      }

      if (final.stop_reason === 'max_tokens') {
        addNote('Reply was cut off by the max-token budget. '
          + 'Raise the limit in Chat settings or ask Claude to be brief.', true);
      }
      break; // end_turn: the model is done
    }

    if (lastStop === 'tool_use' && !stopRequested) {
      addNote(`Stopped at the ${maxTurns}-turn limit. Send another message to let Claude continue, `
        + 'or raise the limit on the toolbar.');
    }
  } catch (e) {
    failed = true;
    addNote(`Request failed: ${e.message}`, true);
    // Nothing applied and no reply text: drop the user turn so a retry resends
    // it (with <current_code>) cleanly.
    if (!assistantTextParts.length) {
      history.pop();
      lastCodeSeenByModel = null;
    }
  } finally {
    setStatus(null);
    setBusy(false);
    activeStream = null;
  }

  if (!failed && assistantTextParts.length) {
    history.push({ role: 'assistant', content: assistantTextParts.join('\n\n'), ts: Date.now(), meta: lastMeta });
  }
  persistCurrentSession();
}

// ---------- session persistence ----------

// Strip the <current_code> wrapper we prepend to outgoing turns so the
// stored/restored bubble shows only what the user actually typed.
function displayText(content) {
  const text = typeof content === 'string'
    ? content
    : (content.find?.(b => b.type === 'text')?.text || '');
  return text.replace(/^<current_code>[\s\S]*?<\/current_code>\n\n/, '');
}

function resetSessionState() {
  history = [];
  lastCodeSeenByModel = null;
  currentSessionId = null;
  currentSessionCreated = null;
}

function showEmptyHint() {
  const container = $('chat-messages');
  container.textContent = '';
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.id = 'chat-empty-hint';
  hint.textContent = 'Ask Claude to modify the current model.';
  container.appendChild(hint);
}

function renderHistoryToUI() {
  const container = $('chat-messages');
  container.textContent = '';
  if (!history.length) { showEmptyHint(); return; }
  for (const m of history) {
    addBubble(m.role, displayText(m.content), { ts: m.ts ?? Date.now(), meta: m.meta ?? null });
  }
}

// Write the in-memory conversation back to localStorage (no-op when empty).
function persistCurrentSession() {
  if (!history.length) return;
  if (!currentSessionId) currentSessionId = crypto.randomUUID();
  if (!currentSessionCreated) currentSessionCreated = Date.now();
  const firstUser = history.find(m => m.role === 'user');
  const title = (firstUser ? displayText(firstUser.content) : 'Chat')
    .replace(/\s+/g, ' ').trim().slice(0, 60) || 'Chat';
  saveChatSession(currentProjectId, {
    id: currentSessionId,
    title,
    messages: history,
    lastCodeSeenByModel,
    created: currentSessionCreated,
  });
}

// "New chat": archive what we have, then start an empty session.
function newChat() {
  persistCurrentSession();
  resetSessionState();
  showEmptyHint();
}

// Continue a saved conversation (archives the current one first).
function loadSession(sess) {
  persistCurrentSession();
  history = sess.messages.map(m => ({ role: m.role, content: m.content, ts: m.ts, meta: m.meta }));
  lastCodeSeenByModel = sess.lastCodeSeenByModel ?? null;
  currentSessionId = sess.id;
  currentSessionCreated = sess.created;
  renderHistoryToUI();
}

// Switching projects: save the old conversation, resume the new project's
// most recent one (or start empty if it has none).
function onProjectChanged({ project }) {
  persistCurrentSession();
  currentProjectId = project ? project.id : null;
  resetSessionState();
  const sessions = getChatSessions(currentProjectId);
  if (sessions.length) {
    const s = sessions[0];
    history = s.messages.map(m => ({ role: m.role, content: m.content, ts: m.ts, meta: m.meta }));
    lastCodeSeenByModel = s.lastCodeSeenByModel ?? null;
    currentSessionId = s.id;
    currentSessionCreated = s.created;
  }
  renderHistoryToUI();
}

// ---------- history dialog ----------

function renderHistoryList() {
  const list = $('chat-history-list');
  list.textContent = '';
  const sessions = getChatSessions(currentProjectId);
  if (!sessions.length) {
    const li = document.createElement('li');
    li.className = 'chat-history-empty';
    li.textContent = 'No saved chats for this project yet.';
    list.appendChild(li);
    return;
  }
  for (const s of sessions) {
    const li = document.createElement('li');

    const open = document.createElement('button');
    open.className = 'p-open' + (s.id === currentSessionId ? ' current' : '');
    const title = document.createElement('span');
    title.textContent = s.title;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${new Date(s.updated).toLocaleString()} · ${s.messages.length} msgs`;
    open.append(title, meta);
    open.addEventListener('click', () => {
      loadSession(s);
      $('chat-history-dialog').close();
    });
    li.appendChild(open);

    const del = document.createElement('button');
    del.className = 'li-btn';
    del.title = 'Delete';
    del.textContent = '🗑';
    del.addEventListener('click', () => {
      if (!confirm('Delete this saved chat?')) return;
      deleteChatSession(currentProjectId, s.id);
      if (s.id === currentSessionId) { resetSessionState(); renderHistoryToUI(); }
      renderHistoryList();
    });
    li.appendChild(del);

    list.appendChild(li);
  }
}

// ---------- image preview ----------

function showPreview() {
  const snap = captureMultiView();
  if (!snap) { toast('Nothing rendered yet to preview.', 'error'); return; }
  previewDataUrl = `data:${snap.mediaType};base64,${snap.data}`;
  const img = $('chat-preview-img');
  img.onload = () => {
    const off = getSettings().chatSendSnapshot
      ? '' : ' · render is OFF — toggle 📷 on to attach it to your first message';
    $('chat-preview-dims').textContent =
      `${img.naturalWidth} × ${img.naturalHeight}px · ${snap.mediaType}${off}`;
  };
  img.src = previewDataUrl;
  $('chat-preview-dialog').showModal();
}

// Clipboard image write needs a PNG blob; re-encode the JPEG data URL.
function dataUrlToPngBlob(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      c.toBlob(b => b ? resolve(b) : reject(new Error('encode failed')), 'image/png');
    };
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

async function copyPreview() {
  if (!previewDataUrl) return;
  try {
    const blob = await dataUrlToPngBlob(previewDataUrl);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Image copied to clipboard');
  } catch (e) {
    toast(`Copy failed: ${e.message}`, 'error');
  }
}

// ---------- init ----------

export function initChat() {
  const input = $('chat-input');
  // The send button doubles as a Stop button while a reply is in flight.
  $('chat-send-btn').addEventListener('click', () => (busy ? stop() : send()));
  $('chat-clear-btn').addEventListener('click', newChat);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!busy) send();
    }
  });
  // Auto-grow the input up to ~5 lines.
  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  // A different project resumes that project's most recent conversation.
  subscribe('project:changed', onProjectChanged);

  // ----- Chat panel toolbar (model + snapshot toggle + preview + history) -----
  const settings = getSettings();
  $('chat-model').value = settings.chatModel;
  $('chat-model').addEventListener('change', e =>
    saveSettings({ chatModel: e.target.value }));
  $('chat-snapshot').checked = settings.chatSendSnapshot;
  $('chat-snapshot').addEventListener('change', e =>
    saveSettings({ chatSendSnapshot: e.target.checked }));
  $('chat-max-turns').value = String(settings.chatMaxTurns);
  $('chat-max-turns').addEventListener('change', e =>
    saveSettings({ chatMaxTurns: Number(e.target.value) || 10 }));
  $('chat-preview-btn').addEventListener('click', showPreview);
  $('chat-preview-copy').addEventListener('click', copyPreview);
  $('chat-code-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('chat-code-content').textContent);
      toast('Code copied to clipboard');
    } catch (e) {
      toast(`Copy failed: ${e.message}`, 'error');
    }
  });
  $('chat-history-btn').addEventListener('click', () => {
    renderHistoryList();
    $('chat-history-dialog').showModal();
  });

  // ----- Chat settings dialog -----
  $('set-anthropic-key').value = settings.anthropicApiKey;
  $('set-anthropic-key').addEventListener('change', e =>
    saveSettings({ anthropicApiKey: e.target.value.trim() }));
  $('chat-set-max-tokens').value = settings.chatMaxTokens;
  $('chat-set-system').value = getSystemPrompt();

  $('chat-set-max-tokens').addEventListener('change', e =>
    saveSettings({ chatMaxTokens: Math.min(16000, Math.max(256, Number(e.target.value) || 4096)) }));
  $('chat-set-system').addEventListener('change', e => {
    const text = e.target.value.trim();
    // Storing null keeps the prompt tracking future default updates.
    saveSettings({ chatSystemPrompt: text && text !== DEFAULT_SYSTEM_PROMPT ? text : null });
  });
  $('chat-set-system-reset').addEventListener('click', () => {
    saveSettings({ chatSystemPrompt: null });
    $('chat-set-system').value = DEFAULT_SYSTEM_PROMPT;
    toast('System prompt reset to default');
  });

  $('menu-chat-settings').addEventListener('click', () => {
    $('menu-dialog').close();
    $('chat-settings-dialog').showModal();
  });
}
