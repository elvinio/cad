// AI chat: talk to Claude about the current model via the Anthropic SDK.
// The SDK (vendor/anthropic/) is dynamically imported on first send so the
// app still boots offline; chat itself naturally needs the network.

import { getSettings, saveSettings,
  getChatSessions, saveChatSession, deleteChatSession } from './storage.js';
import { emit, subscribe } from './state.js';
import { getCode, setCode } from './editor.js';
import { updateActiveCode } from './projects.js';
import { captureSnapshot } from './viewer.js';
import { toast } from './ui.js';

export const DEFAULT_SYSTEM_PROMPT =
`You are an expert CAD designer working inside ScadPad, a mobile OpenSCAD editor. The user's current OpenSCAD code is provided in <current_code> tags. Work from that code to achieve what the user needs.

Rules:
- When you change the model, reply with the COMPLETE updated OpenSCAD file in a single \`\`\`openscad fenced code block. The app replaces the editor contents with that block and re-renders automatically, so never reply with fragments, diffs, or multiple alternative code blocks.
- Keep the code valid OpenSCAD. Preserve the user's Customizer parameters (top-level variables with their // [min:max] annotations and // descriptions) unless asked to change them.
- The user may attach a screenshot of the rendered model so you can check the result of your previous code. Use it to verify the geometry looks right and iterate if it doesn't.
- Keep explanations brief — one or two sentences before the code block. The user is on a phone.
- If a request is ambiguous, make a sensible choice and note it briefly rather than asking questions.`;

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
    tag.textContent = '📷 snapshot attached';
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

// ---------- code extraction / apply ----------

function extractCodeBlock(text) {
  const matches = [...text.matchAll(/```(?:openscad|scad)?\n([\s\S]*?)```/g)];
  if (!matches.length) return null;
  const code = matches[matches.length - 1][1].trim();
  // Heuristic guard: ignore trivial snippets the model quoted in passing.
  return code.length > 10 ? code : null;
}

function applyCode(code) {
  setCode(code);
  updateActiveCode(code);
  lastCodeSeenByModel = code;
  emit('code:changed', { code, immediate: true });
}

// ---------- send ----------

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

  busy = true;
  $('chat-send-btn').disabled = true;
  input.value = '';
  input.style.height = '';

  // Include current code when the model hasn't seen this version yet
  // (always on the first message, and again after manual edits).
  const code = getCode();
  let userText = prompt;
  if (code !== lastCodeSeenByModel) {
    userText = `<current_code>\n${code}\n</current_code>\n\n${prompt}`;
    lastCodeSeenByModel = code;
  }
  const userTs = Date.now();
  history.push({ role: 'user', content: userText, ts: userTs });

  const snapshot = settings.chatSendSnapshot ? captureSnapshot() : null;
  addBubble('user', prompt, { withSnapshot: !!snapshot, ts: userTs });
  const assistantBubble = addBubble('assistant', '…');
  const assistantBody = assistantBubble.querySelector('.chat-msg-body');
  const startedAt = Date.now();

  // History is text-only; attach the snapshot to the outgoing message only.
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

  try {
    const stream = client.messages.stream({
      model: settings.chatModel,
      max_tokens: Math.max(256, Number(settings.chatMaxTokens) || 4096),
      system: getSystemPrompt(),
      messages,
    });

    let accumulated = '';
    stream.on('text', (delta) => {
      accumulated += delta;
      renderMessageBody(assistantBody, accumulated);
      $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
    });

    const final = await stream.finalMessage();
    const text = final.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const meta = {
      model: settings.chatModel,
      durationMs: Date.now() - startedAt,
      usage: { input_tokens: final.usage.input_tokens, output_tokens: final.usage.output_tokens },
    };
    history.push({ role: 'assistant', content: text, ts: Date.now(), meta });
    renderMessageBody(assistantBody, text);
    setBubbleStats(assistantBubble, meta);

    if (final.stop_reason === 'max_tokens') {
      addNote('Reply was cut off by the max-token budget — no code was applied. '
        + 'Raise the limit in Chat settings or ask Claude to be brief.', true);
    } else {
      const newCode = extractCodeBlock(text);
      if (newCode && newCode !== code) {
        applyCode(newCode);
        addNote('Code updated — rendering…');
      }
    }
    persistCurrentSession();
  } catch (e) {
    history.pop(); // drop the failed user turn so a retry resends it cleanly
    lastCodeSeenByModel = null;
    assistantBubble.remove();
    addNote(`Request failed: ${e.message}`, true);
  } finally {
    busy = false;
    $('chat-send-btn').disabled = false;
  }
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
    const off = getSettings().chatSendSnapshot
      ? '' : ' · snapshot is OFF — toggle 📷 on to send it';
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
  $('chat-send-btn').addEventListener('click', send);
  $('chat-clear-btn').addEventListener('click', newChat);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
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
