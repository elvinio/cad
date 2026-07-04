// Chat transcript rendering: message bubbles, status line, tool-use/result
// rows, image preview, and the busy/composer state. No transport, no tool
// execution — those live in chat/protocol.js and chat/tools.js. The
// orchestrator (send()/stop()/initChat() in chat.js) drives all of this.

import { getChatImage } from '../storage.js';
import { toast } from '../ui.js';
import { captureSnapshot } from '../viewer/capture.js';
// displayText still lives in chat.js until chat/sessions.js exists (Step 4
// of the split). Only referenced inside renderHistoryToUI's body below, never
// at this module's own top level, so this circular import is safe regardless
// of which of chat.js/chat/ui.js the module loader evaluates first.
import { displayText } from '../chat.js';

export const $ = id => document.getElementById(id);

let busy = false;
let previewDataUrl = null; // last image shown in the preview dialog

function formatTimestamp(ts) {
  // e.g. "Jun 13, 2026, 4:13 AM" — date and time, locale-formatted.
  return new Date(ts).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// Bottom-of-message stats line: turns · time · tokens. The endpoint is
// self-hosted, so there's no per-token price to show.
function formatStats({ durationMs, usage, turns } = {}) {
  const parts = [];
  if (turns != null) parts.push(`${turns} turn${turns === 1 ? '' : 's'}`);
  if (durationMs != null) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
  if (usage) parts.push(`${usage.input_tokens} in / ${usage.output_tokens} out tok`);
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
export function renderMessageBody(el, text) {
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
export function addBubble(role, text, { ts = Date.now(), meta = null } = {}) {
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
export function setBubbleStats(msg, meta) {
  msg.querySelector('.chat-msg-stats')?.remove();
  const stats = document.createElement('div');
  stats.className = 'chat-msg-stats';
  stats.textContent = formatStats(meta);
  msg.appendChild(stats);
}

export function addNote(text, isError = false) {
  const container = $('chat-messages');
  const note = document.createElement('p');
  note.className = `chat-note${isError ? ' error' : ''}`;
  note.textContent = text;
  container.appendChild(note);
  container.scrollTop = container.scrollHeight;
}

// ---------- busy / status UI ----------

// Toggle the composer between Send (idle) and Stop (a reply is in flight). The
// button stays enabled while busy so it can interrupt; send() guards re-entry.
export function setBusy(on) {
  busy = on;
  const btn = $('chat-send-btn');
  btn.classList.toggle('stop', on);
  btn.title = on ? 'Stop' : 'Send';
  btn.textContent = on ? '■' : '➤'; // ■ / ➤
}

export function getBusy() {
  return busy;
}

// A single status line at the bottom of the transcript: animated dots plus a
// label ("Thinking…" / "Rendering…"). Pass null to remove it.
export function setStatus(text) {
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
export function addImageButton(label, dataUrl, caption) {
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

// Same button as addImageButton, but for history replay: the image bytes
// live in IndexedDB (by id), not in memory, so fetch them lazily on click.
export function addImageButtonLazy(label, imageId, caption) {
  const container = $('chat-messages');
  const row = document.createElement('div');
  row.className = 'chat-tool-row';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chat-code-btn';
  btn.textContent = `\u{1F5BC} ${label}`;
  btn.addEventListener('click', async () => {
    const rec = await getChatImage(imageId);
    if (!rec) { toast('This image is no longer available.', 'error'); return; }
    openImageModal(`data:${rec.mediaType};base64,${rec.data}`, caption);
  });
  row.appendChild(btn);
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

// A tool_result's text, shown as a muted line under its tool-use row. Skipped
// for `look` (the image button + its caption already covers that result).
export function addToolResultRow(text) {
  if (!text) return;
  const container = $('chat-messages');
  const row = document.createElement('div');
  row.className = 'chat-tool-row chat-tool-result';
  row.textContent = text;
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

// ---------- tool-use display ----------

// Show a row in the transcript for a tool the model just called, with its key
// parameters, so the user can follow what Claude is doing. Code-bearing tools
// (edit_code/write_code) get a "View code" button into the artifact modal.
export function addToolUseRow(name, summary, { code = null } = {}) {
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

// Summarize one tool_use block the same way for the live transcript and for
// history replay, so both render identically. NOTE: this return shape
// ({summary, code}) is persisted verbatim into a session's `steps` array
// (see chat.js's send()) — changing the field names or semantics here is
// effectively a storage-schema change for saved sessions, not just a
// display tweak.
export function describeToolUse(name, input) {
  switch (name) {
    case 'read_code': {
      const hasRange = input?.start_line != null || input?.end_line != null;
      return { summary: hasRange ? `lines ${input.start_line ?? 1}–${input.end_line ?? 'end'}` : 'whole file', code: null };
    }
    case 'edit_code':
      return { summary: `lines ${input?.start_line}–${input?.end_line}`, code: input?.new_text ?? '' };
    case 'write_code':
      return { summary: 'whole file', code: input?.code ?? '' };
    case 'set_params':
      return { summary: formatParamMap(input?.params), code: null };
    case 'get_params':
      return { summary: '', code: null };
    case 'look':
      return { summary: '', code: null };
    case 'look_at': {
      const parts = [];
      if (input?.yaw_deg != null) parts.push(`yaw ${input.yaw_deg}°`);
      if (input?.pitch_deg != null) parts.push(`pitch ${input.pitch_deg}°`);
      if (input?.zoom != null) parts.push(`zoom ${input.zoom}×`);
      if (input?.style && input.style !== 'solid') parts.push(input.style);
      return { summary: parts.join(', '), code: null };
    }
    case 'lookup_lib':
      return { summary: input?.query ? `"${input.query}"` : '', code: null };
    default:
      return { summary: '', code: null };
  }
}

export function showEmptyHint() {
  const container = $('chat-messages');
  container.textContent = '';
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.id = 'chat-empty-hint';
  hint.textContent = 'Ask the AI to modify the current model.';
  container.appendChild(hint);
}

// Replay one assistant message's full trace (text/tool_use/tool_result), in
// order, so a reloaded conversation looks the same as it did while streaming.
export function renderAssistantSteps(steps) {
  for (const step of steps) {
    if (step.type === 'text') {
      addBubble('assistant', step.text, { ts: step.ts ?? Date.now(), meta: step.meta ?? null });
    } else if (step.type === 'tool_use') {
      addToolUseRow(step.name, step.summary, { code: step.code ?? null });
    } else if (step.type === 'tool_result') {
      if (step.imageId) addImageButtonLazy(step.imageLabel || 'View image', step.imageId, step.text);
      else addToolResultRow(step.text);
    }
  }
}

export function renderHistoryToUI(history) {
  const container = $('chat-messages');
  container.textContent = '';
  if (!history.length) { showEmptyHint(); return; }
  for (const m of history) {
    if (m.role === 'assistant' && Array.isArray(m.steps) && m.steps.length) {
      renderAssistantSteps(m.steps);
    } else {
      addBubble(m.role, displayText(m.content), { ts: m.ts ?? Date.now(), meta: m.meta ?? null });
    }
  }
}

// ---------- image preview ----------

export function showPreview() {
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

export async function copyPreview() {
  if (!previewDataUrl) return;
  try {
    const blob = await dataUrlToPngBlob(previewDataUrl);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Image copied to clipboard');
  } catch (e) {
    toast(`Copy failed: ${e.message}`, 'error');
  }
}

// Fill the chat composer with prefilled text and bring it into view, without
// sending. Used by the console's "Ask Claude to fix" button to hand off a render
// error as a ready-to-send prompt. Switches to the Chat tab and focuses the input.
export function seedChatInput(text) {
  const input = $('chat-input');
  if (!input) return;
  document.querySelector('[data-tab="chat-view"]')?.click();
  input.value = text;
  input.dispatchEvent(new Event('input')); // auto-grow + any listeners
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
