// AI chat: talk to Claude about the current model via the Anthropic SDK.
// The SDK (vendor/anthropic/) is dynamically imported on first send so the
// app still boots offline; chat itself naturally needs the network.

import { getSettings, saveSettings } from './storage.js';
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
let history = [];
let lastCodeSeenByModel = null;
let busy = false;
let sdkClientPromise = null;

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

// Minimal markdown-ish renderer: fenced code blocks become <pre>, the rest is
// plain text (textContent — no HTML injection).
function renderMessageBody(el, text) {
  el.textContent = '';
  const parts = text.split(/```[a-zA-Z]*\n?/);
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) {
      const pre = document.createElement('pre');
      pre.textContent = part.replace(/\n$/, '');
      el.appendChild(pre);
    } else {
      const p = document.createElement('div');
      p.textContent = part;
      el.appendChild(p);
    }
  });
}

function addBubble(role, text, { withSnapshot = false } = {}) {
  $('chat-empty-hint')?.remove();
  const container = $('chat-messages');
  const bubble = document.createElement('div');
  bubble.className = `chat-msg ${role}`;
  renderMessageBody(bubble, text);
  if (withSnapshot) {
    const tag = document.createElement('span');
    tag.className = 'chat-snapshot-tag';
    tag.textContent = '📷 snapshot attached';
    bubble.appendChild(tag);
  }
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  return bubble;
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
  history.push({ role: 'user', content: userText });

  const snapshot = settings.chatSendSnapshot ? captureSnapshot() : null;
  addBubble('user', prompt, { withSnapshot: !!snapshot });
  const assistantBubble = addBubble('assistant', '…');

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
      renderMessageBody(assistantBubble, accumulated);
      $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
    });

    const final = await stream.finalMessage();
    const text = final.content.filter(b => b.type === 'text').map(b => b.text).join('');
    history.push({ role: 'assistant', content: text });
    renderMessageBody(assistantBubble, text);

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
    const u = final.usage;
    addNote(`${settings.chatModel} · ${u.input_tokens} in / ${u.output_tokens} out tokens`);
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

function clearChat() {
  history = [];
  lastCodeSeenByModel = null;
  const container = $('chat-messages');
  container.textContent = '';
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.id = 'chat-empty-hint';
  hint.textContent = 'Ask Claude to modify the current model.';
  container.appendChild(hint);
}

// ---------- init ----------

export function initChat() {
  const input = $('chat-input');
  $('chat-send-btn').addEventListener('click', send);
  $('chat-clear-btn').addEventListener('click', clearChat);
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

  // A different project is a different conversation.
  subscribe('project:changed', clearChat);

  // ----- Chat settings dialog -----
  const settings = getSettings();
  $('set-anthropic-key').value = settings.anthropicApiKey;
  $('set-anthropic-key').addEventListener('change', e =>
    saveSettings({ anthropicApiKey: e.target.value.trim() }));
  $('chat-set-model').value = settings.chatModel;
  $('chat-set-max-tokens').value = settings.chatMaxTokens;
  $('chat-set-snapshot').checked = settings.chatSendSnapshot;
  $('chat-set-system').value = getSystemPrompt();

  $('chat-set-model').addEventListener('change', e =>
    saveSettings({ chatModel: e.target.value }));
  $('chat-set-max-tokens').addEventListener('change', e =>
    saveSettings({ chatMaxTokens: Math.min(16000, Math.max(256, Number(e.target.value) || 4096)) }));
  $('chat-set-snapshot').addEventListener('change', e =>
    saveSettings({ chatSendSnapshot: e.target.checked }));
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
