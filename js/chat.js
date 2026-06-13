// AI chat: talk to Claude about the current model via the Anthropic SDK.
// The SDK (vendor/anthropic/) is dynamically imported on first send so the
// app still boots offline; chat itself naturally needs the network.

import { getSettings, saveSettings,
  getChatSessions, saveChatSession, deleteChatSession } from './storage.js';
import { emit, subscribe } from './state.js';
import { getCode, setCode } from './editor.js';
import { updateActiveCode } from './projects.js';
import { getParamValues, getParamSchema, applyParamOverrides } from './customizer.js';
import { captureSnapshot, captureMultiView, getMeshStats } from './viewer.js';
import { toast } from './ui.js';

export const DEFAULT_SYSTEM_PROMPT =
`You are an expert CAD designer working inside ScadPad, a mobile OpenSCAD editor. You edit the user's OpenSCAD code through tools, the way a coding assistant edits a file. The current code and Customizer parameters are given once, in <current_code> and <current_params> tags, at the start of the conversation.

Tools:
- read_code: read the current editor code, optionally a line range. Lines come back numbered. The code may have changed since you last saw it (the user can edit too) — if a message tells you the code changed, or before any edit you're unsure about, call read_code first to get fresh line numbers.
- edit_code: replace an inclusive line range (start_line..end_line) with new_text. Line numbers MUST match the latest read_code; if the code changed since your last read the edit is rejected and you must read_code again.
- write_code: replace the WHOLE file. Use for new models from scratch or large rewrites.
- get_params / set_params: read the Customizer parameters and change their values. Parameters are top-level variables that drive the geometry; changing them re-renders the model and is usually better than hard-coding numbers into the code.
- look: render and return a 2×2 image of the model — ISO (corner), FRONT (-Y), RIGHT (+X), TOP (down -Z) — in OpenSCAD's Z-up frame. edit_code/write_code/set_params only report compile status and the bounding box as text; call look when you want to actually SEE the result. The image is perspective — judge sizes from the reported bounding box, not pixels.

Workflow: make a change with edit_code/write_code/set_params, read the text result; if it failed to compile, fix it; when you want to verify the shape, call look. When the model is right, stop and give a one- or two-sentence summary.

Rules:
- Prefer small edit_code edits over rewriting the whole file.
- Keep the code valid OpenSCAD. Preserve the user's Customizer parameters (top-level variables with their // [min:max] annotations and // descriptions) unless asked to change them; tweak values with set_params rather than editing the annotations.
- Keep explanations brief — the user is on a phone.
- If a request is ambiguous, make a sensible choice and note it briefly rather than asking questions.`;

// Tools the model can call. read_code/edit_code/write_code/get_params/set_params
// all operate on the live editor + customizer; look renders and returns the
// 2×2 image. Handlers live in runTool(); most return text only (the model uses
// look to see images), keeping per-turn token cost down.
const TOOLS = [
  {
    name: 'read_code',
    description:
      'Read the current OpenSCAD editor code. Returns the lines numbered (1-based). '
      + 'Omit the range to read the whole file, or pass start_line/end_line to read a slice. '
      + 'Always read before editing if the code may have changed since you last saw it.',
    input_schema: {
      type: 'object',
      properties: {
        start_line: { type: 'integer', description: 'First line to read (1-based, inclusive). Optional.' },
        end_line: { type: 'integer', description: 'Last line to read (1-based, inclusive). Optional.' },
      },
    },
  },
  {
    name: 'edit_code',
    description:
      'Replace the inclusive line range start_line..end_line with new_text, then render. '
      + 'Line numbers must match the most recent read_code; if the code changed since then the '
      + 'edit is rejected — call read_code again first. To insert without removing lines, set '
      + 'end_line = start_line - 1. Returns compile status and bounding box as text (call look to see it).',
    input_schema: {
      type: 'object',
      properties: {
        start_line: { type: 'integer', description: 'First line to replace (1-based, inclusive).' },
        end_line: { type: 'integer', description: 'Last line to replace (1-based, inclusive). Use start_line-1 to insert.' },
        new_text: { type: 'string', description: 'Replacement text for the range (may be multiple lines, no trailing newline needed).' },
      },
      required: ['start_line', 'end_line', 'new_text'],
    },
  },
  {
    name: 'write_code',
    description:
      'Replace the ENTIRE editor contents with `code`, then render. Use for new models or large '
      + 'rewrites; prefer edit_code for small changes. Returns compile status and bounding box as text.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The complete OpenSCAD source for the whole file.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'get_params',
    description:
      'List the Customizer parameters (top-level variables that drive the geometry) with their '
      + 'current value, default, and any min/max/options. Returns JSON.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_params',
    description:
      'Set one or more Customizer parameter values and re-render. Pass `params` as a map of '
      + '{parameter_name: value}. Changing parameters affects how the model looks. Returns compile '
      + 'status and bounding box as text (call look to see it). Use get_params first to learn valid names.',
    input_schema: {
      type: 'object',
      properties: {
        params: {
          type: 'object',
          description: 'Map of parameter name to new value, e.g. {"width": 40, "rounded": true}.',
          additionalProperties: true,
        },
      },
      required: ['params'],
    },
  },
  {
    name: 'look',
    description:
      'Render the current model and return a 2×2 image (ISO, FRONT, RIGHT, TOP views in OpenSCAD '
      + 'Z-up) plus the bounding-box dimensions. Call this whenever you want to see the result.',
    input_schema: { type: 'object', properties: {} },
  },
];

// Conversation state. History stores text-only content; rendered images are
// fetched on demand by the look tool and never persisted, so old images don't
// accumulate input-token cost.
//
// A "session" is one conversation. It lives in memory here and is persisted
// (per project, text-only) to localStorage after every turn so it survives
// reloads and project switches — letting you resume an iteration later.
let history = [];
// The exact code string the model last read or wrote. The model's view is
// "dirty" whenever getCode() !== this (the user edited the editor since): we
// then re-send nothing but a note telling it to read_code, and reject line-
// based edit_code calls until it does. applyCode() and read_code update it.
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
function addBubble(role, text, { ts = Date.now(), meta = null } = {}) {
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

// A <current_params> block listing each Customizer parameter's current value,
// sent once alongside <current_code> on the first turn (empty string if the
// model has no parameters). After that the model uses get_params/set_params.
function currentParamsBlock() {
  const schema = getParamSchema();
  if (!schema.length) return '';
  const overrides = getParamValues();
  const lines = schema.map((p) => {
    const v = (p.name in overrides) ? overrides[p.name] : p.initial;
    return `${p.name} = ${JSON.stringify(v)}`;
  });
  return `\n\n<current_params>\n${lines.join('\n')}\n</current_params>`;
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

// ---------- tool-use display ----------

// Show a row in the transcript for a tool the model just called, with its key
// parameters, so the user can follow what Claude is doing. Code-bearing tools
// (edit_code/write_code) get a "View code" button into the artifact modal.
function addToolUseRow(name, summary, { code = null } = {}) {
  const container = $('chat-messages');
  const row = document.createElement('div');
  row.className = 'chat-tool-row';
  const label = document.createElement('span');
  label.className = 'chat-tool-call';
  label.textContent = summary ? `🔧 ${name}(${summary})` : `🔧 ${name}`;
  row.appendChild(label);
  if (code != null) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-code-btn';
    btn.textContent = '📄 View code';
    btn.addEventListener('click', () => showCodeArtifact(code));
    row.appendChild(btn);
  }
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

function formatParamMap(params) {
  if (!params || typeof params !== 'object') return '';
  return Object.entries(params).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
}

// Render the chat row describing one tool_use block (called before running it).
function displayToolUse({ name, input }) {
  switch (name) {
    case 'read_code': {
      const hasRange = input?.start_line != null || input?.end_line != null;
      addToolUseRow('read_code', hasRange ? `lines ${input.start_line ?? 1}–${input.end_line ?? 'end'}` : 'whole file');
      break;
    }
    case 'edit_code':
      addToolUseRow('edit_code', `lines ${input?.start_line}–${input?.end_line}`, { code: input?.new_text ?? '' });
      break;
    case 'write_code':
      addToolUseRow('write_code', 'whole file', { code: input?.code ?? '' });
      break;
    case 'set_params':
      addToolUseRow('set_params', formatParamMap(input?.params));
      break;
    case 'get_params':
      addToolUseRow('get_params', '');
      break;
    case 'look':
      addToolUseRow('look', '');
      break;
    default:
      addToolUseRow(name, '');
  }
}

// ---------- tool handlers ----------

// Resolve once the render settles (render:done / render:error) after running
// `trigger` (which mutates code or params). Subscribing before triggering avoids
// missing a fast render.
function awaitRender(trigger) {
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
    trigger();
  });
}

const applyAndAwaitRender = (code) => awaitRender(() => applyCode(code));

function dimsLine() {
  const stats = getMeshStats();
  return stats
    ? `${stats.size[0]} × ${stats.size[1]} × ${stats.size[2]} mm · ${stats.triangles} tris`
    : 'unknown size';
}

// Text tool_result after an apply/param change (no image — the model uses look).
function renderResultText(res) {
  if (!res.ok) {
    addNote(`Render failed: ${res.error}`, true);
    return `Render failed: ${res.error}\nFix the problem and try again.`;
  }
  return `Render OK. Bounding box ${dimsLine()}. Call look to see the model.`;
}

function runReadCode(input) {
  const code = getCode();
  lastCodeSeenByModel = code; // the model now has an up-to-date view
  const lines = code.split('\n');
  let start = Number.isFinite(input?.start_line) ? Math.max(1, Math.floor(input.start_line)) : 1;
  let end = Number.isFinite(input?.end_line) ? Math.min(lines.length, Math.floor(input.end_line)) : lines.length;
  if (start > end) {
    return [{ type: 'text', text: `Invalid range: start_line ${start} > end_line ${end}. The file has ${lines.length} lines.` }];
  }
  const width = String(end).length;
  const numbered = lines.slice(start - 1, end)
    .map((l, i) => `${String(start + i).padStart(width)}\t${l}`).join('\n');
  return [{ type: 'text', text: `${lines.length} lines total.\n${numbered || '(empty)'}` }];
}

async function runEditCode(input) {
  const current = getCode();
  if (current !== lastCodeSeenByModel) {
    return [{ type: 'text',
      text: 'The editor code changed since your last read_code, so these line numbers may be stale. '
        + 'Call read_code again, then redo the edit.' }];
  }
  const lines = current.split('\n');
  const start = Math.floor(input?.start_line);
  const end = Math.floor(input?.end_line);
  if (!Number.isInteger(start) || !Number.isInteger(end)
      || start < 1 || start > lines.length + 1 || end < start - 1 || end > lines.length) {
    return [{ type: 'text',
      text: `Invalid range start_line=${input?.start_line} end_line=${input?.end_line}. `
        + `The file has ${lines.length} lines (use end_line = start_line - 1 to insert).` }];
  }
  const newLines = String(input?.new_text ?? '').split('\n');
  const newCode = [...lines.slice(0, start - 1), ...newLines, ...lines.slice(end)].join('\n');
  setStatus('Rendering…');
  return [{ type: 'text', text: renderResultText(await applyAndAwaitRender(newCode)) }];
}

async function runWriteCode(input) {
  setStatus('Rendering…');
  return [{ type: 'text', text: renderResultText(await applyAndAwaitRender(String(input?.code ?? ''))) }];
}

function runGetParams() {
  const schema = getParamSchema();
  if (!schema.length) {
    return [{ type: 'text', text: 'This model has no Customizer parameters (no annotated top-level variables).' }];
  }
  const overrides = getParamValues();
  const list = schema.map(p => ({
    name: p.name,
    type: p.type,
    current: (p.name in overrides) ? overrides[p.name] : p.initial,
    default: p.initial,
    ...(p.min !== undefined ? { min: p.min } : {}),
    ...(p.max !== undefined ? { max: p.max } : {}),
    ...(Array.isArray(p.options) && p.options.length ? { options: p.options.map(o => o.value) } : {}),
    ...(p.group ? { group: p.group } : {}),
  }));
  return [{ type: 'text', text: JSON.stringify({ parameters: list }, null, 2) }];
}

async function runSetParams(input) {
  const params = input?.params;
  if (!params || typeof params !== 'object' || Array.isArray(params) || !Object.keys(params).length) {
    return [{ type: 'text', text: 'set_params needs a non-empty `params` object, e.g. {"width": 40}.' }];
  }
  if (!getParamSchema().length) {
    return [{ type: 'text', text: 'This model has no Customizer parameters to set. Edit the code instead.' }];
  }
  const known = new Set(getParamSchema().map(p => p.name));
  const unknown = Object.keys(params).filter(n => !known.has(n));
  if (unknown.length === Object.keys(params).length) {
    return [{ type: 'text', text: `Unknown parameter(s): ${unknown.join(', ')}. Call get_params for valid names.` }];
  }
  setStatus('Rendering…');
  const res = await awaitRender(() => applyParamOverrides(params));
  let text = renderResultText(res);
  if (res.ok) text += `\nCurrent overrides: ${JSON.stringify(getParamValues())}`;
  if (unknown.length) text += `\n(Ignored unknown parameter(s): ${unknown.join(', ')}.)`;
  return [{ type: 'text', text }];
}

function runLook() {
  const img = captureMultiView();
  if (!img) {
    return [{ type: 'text', text: 'Nothing is rendered yet — apply or fix the code first, then look again.' }];
  }
  const dims = dimsLine();
  addImageButton('View render — iso · front · right · top',
    `data:${img.mediaType};base64,${img.data}`, `Bounding box: ${dims}`);
  return [
    { type: 'text', text: `Bounding box ${dims}. The image is a 2×2 grid: ISO, FRONT, RIGHT, TOP in OpenSCAD Z-up.` },
    { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } },
  ];
}

// Dispatch one tool_use block to its handler, returning tool_result content.
async function runTool(block) {
  switch (block.name) {
    case 'read_code':  return runReadCode(block.input || {});
    case 'edit_code':  return await runEditCode(block.input || {});
    case 'write_code': return await runWriteCode(block.input || {});
    case 'get_params': return runGetParams();
    case 'set_params': return await runSetParams(block.input || {});
    case 'look':       return runLook();
    default:           return [{ type: 'text', text: `Unknown tool: ${block.name}` }];
  }
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

  // Full code + params go out ONCE, on the first turn of the conversation. After
  // that the model reads/edits through tools. On later turns we don't resend the
  // code; if the user edited the editor since the model last read it, we just
  // tell it so it knows to read_code again (the "dirty" signal).
  let userText = prompt;
  if (history.length === 0) {
    const code = getCode();
    userText = `<current_code>\n${code}\n</current_code>${currentParamsBlock()}\n\n${prompt}`;
    lastCodeSeenByModel = code;
  } else if (getCode() !== lastCodeSeenByModel) {
    userText = `${prompt}\n\n[The editor code has changed since you last read it — call read_code before editing.]`;
  }
  const userTs = Date.now();
  history.push({ role: 'user', content: userText, ts: userTs });

  addBubble('user', prompt, { ts: userTs });

  // Working message list for the API. History is text-only; tool round-trips
  // (including look images) for THIS send are appended here, not persisted.
  const messages = history.map(m => ({ role: m.role, content: m.content }));

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
        tools: TOOLS,
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
          displayToolUse(block);
          const content = await runTool(block);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
        }
        messages.push({ role: 'user', content: toolResults });
        continue; // let the model inspect the results and decide what's next
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
  const snap = captureSnapshot();
  if (!snap) { toast('Nothing rendered yet to preview.', 'error'); return; }
  previewDataUrl = `data:${snap.mediaType};base64,${snap.data}`;
  const img = $('chat-preview-img');
  img.onload = () => {
    $('chat-preview-dims').textContent =
      `${img.naturalWidth} × ${img.naturalHeight}px · ${snap.mediaType}`;
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

  // ----- Chat panel toolbar (model + preview + history) -----
  const settings = getSettings();
  $('chat-model').value = settings.chatModel;
  $('chat-model').addEventListener('change', e =>
    saveSettings({ chatModel: e.target.value }));
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
