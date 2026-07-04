// AI chat: talk to an LLM about the current model. Speaks the OpenAI
// chat-completions protocol (POST /v1/chat/completions, SSE streaming) against a
// Modal-hosted Gemma endpoint, reached through a small CORS+auth proxy (see
// modal/gemma_proxy.py). The browser sends a single `Authorization: Bearer` key;
// the proxy holds the upstream Modal proxy-auth secrets. No SDK is vendored — the
// transport is a plain fetch + SSE parser, so the app still boots offline (chat
// itself needs the network).

import { getSettings, saveSettings, getProject,
  getChatSessions, saveChatSession, deleteChatSession, getAllChatSessions,
  putChatImage, deleteChatImages } from './storage.js';
import { subscribe } from './state.js';
import { getCode } from './editor.js';
import { switchToProject } from './projects.js';
import { toast } from './ui.js';
import { getHistory, setHistory, pushHistory, getLastCode, setLastCode } from './chat/session-state.js';
import {
  DEFAULT_SYSTEM_PROMPT, getSystemPrompt, buildSystemPrompt, availableLibsBlock, currentParamsBlock,
  getChatConfig, streamChatCompletion, isAbortError, toolResultToOpenAI,
} from './chat/protocol.js';
import { runTool } from './chat/tools.js';
import {
  $, addNote, setStatus, addBubble, setBubbleStats, renderMessageBody,
  addToolUseRow, addToolResultRow, describeToolUse, showEmptyHint, renderHistoryToUI,
  showPreview, copyPreview, getBusy, setBusy,
} from './chat/ui.js';

// Conversation state (history, lastCodeSeenByModel) lives in
// chat/session-state.js — shared with tool handlers and session persistence.
// A "session" is one conversation. It lives in memory there and is persisted
// (per project, text-only) to IndexedDB after every turn so it survives
// reloads and project switches — letting you resume an iteration later.
// busy lives in chat/ui.js (getBusy/setBusy); this orchestrator reads/writes
// it through those instead of a local module variable.

// Tool-loop control: stopRequested is set by the Stop button; activeController is
// the in-flight request's AbortController so Stop can abort the current reply.
let stopRequested = false;
let activeController = null;

// Persistence bookkeeping for the active session.
let currentProjectId = null;
let currentSessionId = null;       // null until the session has been saved once
let currentSessionCreated = null;

// ---------- send ----------

// Stop the current reply: abort the in-flight request and break the loop after
// the current step finishes.
function stop() {
  if (!getBusy()) return;
  stopRequested = true;
  setStatus('Stopping…');
  activeController?.abort();
}

async function send() {
  const input = $('chat-input');
  const prompt = input.value.trim();
  if (!prompt || getBusy()) return;

  const settings = getSettings();
  let config;
  try {
    config = getChatConfig();
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
  if (getHistory().length === 0) {
    const code = getCode();
    userText = `<current_code>\n${code}\n</current_code>${currentParamsBlock()}${availableLibsBlock()}\n\n${prompt}`;
    setLastCode(code);
  } else if (getCode() !== getLastCode()) {
    userText = `${prompt}\n\n[The editor code has changed since you last read it — call read_code before editing.]`;
  }
  const userTs = Date.now();
  pushHistory({ role: 'user', content: userText, ts: userTs });

  addBubble('user', prompt, { ts: userTs });

  // Working message list for the API: the system prompt first, then history
  // (text-only). Tool round-trips (including look images) for THIS send are
  // appended here, not persisted.
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...getHistory().map(m => ({ role: m.role, content: m.content })),
  ];

  const maxTurns = Math.max(1, Number(settings.chatMaxTurns) || 100);
  const startedAt = Date.now();
  const assistantTextParts = [];
  const steps = []; // full trace (text + tool_use + tool_result) for history replay
  let totalIn = 0, totalOut = 0;
  let turnsUsed = 0;
  let lastMeta = null;
  let lastStop = null;
  let failed = false;

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (stopRequested) break;

      setStatus('Thinking…');
      const assistantBubble = addBubble('assistant', '…');
      const assistantBody = assistantBubble.querySelector('.chat-msg-body');

      // The self-hosted endpoint can cold-start for up to ~5 minutes if it has
      // scaled to zero; fetch() has no default timeout, but without this the
      // "Thinking…" status looks identical whether it's about to fail or just
      // warming up, which makes people bail (close the tab / hit Stop) early.
      const coldStartTimer = setTimeout(
        () => setStatus('Still waking up the model… cold start can take a few minutes'),
        12000);

      activeController = new AbortController();
      let accumulated = '';
      let final;
      try {
        final = await streamChatCompletion({
          config,
          messages,
          signal: activeController.signal,
          onText: (delta) => {
            if (!accumulated) { clearTimeout(coldStartTimer); setStatus('Thinking…'); }
            accumulated += delta;
            renderMessageBody(assistantBody, accumulated);
            $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
          },
        });
      } catch (e) {
        if (isAbortError(e)) { if (!accumulated) assistantBubble.remove(); break; }
        throw e;
      } finally {
        clearTimeout(coldStartTimer);
        activeController = null;
      }

      const text = final.text;
      turnsUsed += 1;
      totalIn += final.usage?.prompt_tokens || 0;
      totalOut += final.usage?.completion_tokens || 0;
      lastMeta = {
        model: settings.chatModel,
        durationMs: Date.now() - startedAt,
        turns: turnsUsed,
        usage: { input_tokens: totalIn, output_tokens: totalOut },
      };
      lastStop = final.finishReason;

      if (text) {
        renderMessageBody(assistantBody, text);
        setBubbleStats(assistantBubble, lastMeta);
        assistantTextParts.push(text);
        steps.push({ type: 'text', text, ts: Date.now(), meta: lastMeta });
      } else {
        assistantBubble.remove();
      }

      // Replay the assistant turn (text + any tool calls) so the next request
      // continues the same tool exchange.
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(final.toolCalls.length ? {
          tool_calls: final.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        } : {}),
      });

      if (final.finishReason === 'tool_calls' && final.toolCalls.length) {
        for (const tc of final.toolCalls) {
          let input;
          try { input = JSON.parse(tc.arguments || '{}'); } catch { input = {}; }
          const block = { name: tc.name, input, id: tc.id };
          const { summary, code } = describeToolUse(block.name, block.input);
          addToolUseRow(block.name, summary, { code });
          steps.push({ type: 'tool_use', name: block.name, input: block.input, summary, code });

          const content = await runTool(block);

          const resultText = content.filter(b => b.type === 'text').map(b => b.text).join('\n') || '(no output)';
          const imgBlock = content.find(b => b.type === 'image');
          let imageId = null;
          if (imgBlock) {
            imageId = crypto.randomUUID();
            await putChatImage(imageId, imgBlock.source.media_type, imgBlock.source.data);
          } else {
            addToolResultRow(resultText);
          }
          steps.push({
            type: 'tool_result', name: block.name, text: resultText, imageId,
            imageLabel: imageId ? (content.imageLabel || 'View render') : null,
          });

          messages.push(...toolResultToOpenAI(tc.id, content));
        }
        continue; // let the model inspect the results and decide what's next
      }

      break; // stop: the model is done
    }

    if (lastStop === 'tool_calls' && !stopRequested) {
      addNote(`Stopped at the ${maxTurns}-turn limit. Send another message to let the AI continue, `
        + 'or raise the limit on the toolbar.');
    }
  } catch (e) {
    failed = true;
    addNote(`Request failed: ${e.message}`, true);
    // Nothing applied and no reply text: drop the user turn so a retry resends
    // it (with <current_code>) cleanly.
    if (!assistantTextParts.length) {
      getHistory().pop();
      setLastCode(null);
    }
  } finally {
    setStatus(null);
    setBusy(false);
    activeController = null;
  }

  if (!failed && (assistantTextParts.length || steps.length)) {
    pushHistory({
      role: 'assistant',
      content: assistantTextParts.join('\n\n') || '(no reply text — see tool calls)',
      ts: Date.now(),
      meta: lastMeta,
      steps,
    });
  }
  persistCurrentSession();
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

// ---------- session persistence ----------

// Strip the context preamble we prepend to the first outgoing turn so the
// stored/restored bubble shows only what the user actually typed.
export function displayText(content) {
  const text = typeof content === 'string'
    ? content
    : (content.find?.(b => b.type === 'text')?.text || '');
  return text
    .replace(/^<current_code>[\s\S]*?<\/current_code>\n*/, '')
    .replace(/^<current_params>[\s\S]*?<\/current_params>\n*/, '')
    .replace(/^<available_libraries>[\s\S]*?<\/available_libraries>\n*/, '')
    .replace(/\n\n\[The editor code has changed[^\]]*\]$/, '');
}

function resetSessionState() {
  setHistory([]);
  setLastCode(null);
  currentSessionId = null;
  currentSessionCreated = null;
}

// Write the in-memory conversation back to IndexedDB (no-op when empty).
async function persistCurrentSession() {
  const history = getHistory();
  if (!history.length) return;
  if (!currentSessionId) currentSessionId = crypto.randomUUID();
  if (!currentSessionCreated) currentSessionCreated = Date.now();
  const firstUser = history.find(m => m.role === 'user');
  const title = (firstUser ? displayText(firstUser.content) : 'Chat')
    .replace(/\s+/g, ' ').trim().slice(0, 60) || 'Chat';
  await saveChatSession(currentProjectId, {
    id: currentSessionId,
    title,
    messages: history,
    lastCodeSeenByModel: getLastCode(),
    created: currentSessionCreated,
  });
}

// persistCurrentSession/loadSession/onProjectChanged/clearCurrentChat all
// read-modify-write the same module state (history, currentSessionId,
// currentProjectId, ...) and now await IndexedDB instead of writing
// localStorage synchronously. Two of them can be triggered in the same tick
// — e.g. the "all chats" dialog calls switchToProject() (which emits
// 'project:changed' -> onProjectChanged) immediately followed by
// loadSession() — so chain them on one queue to keep each one atomic
// relative to the others instead of letting their awaits interleave.
let chatOpChain = Promise.resolve();
function chainOp(fn) {
  const run = chatOpChain.then(fn);
  chatOpChain = run.then(() => {}, () => {});
  return run;
}

// "New chat": archive what we have, then start an empty session.
const newChat = () => chainOp(async () => {
  await persistCurrentSession();
  resetSessionState();
  showEmptyHint();
});

// "Clear this chat": permanently delete the currently open conversation (and
// any images it referenced) instead of archiving it. Distinct from New chat,
// which keeps the old conversation around in the history list.
const clearCurrentChat = () => chainOp(async () => {
  const history = getHistory();
  if (!history.length) return;
  if (!confirm('Delete this conversation? This cannot be undone.')) return;
  if (currentSessionId) {
    await deleteSessionWithImages(currentProjectId, { id: currentSessionId, messages: history });
  } else {
    await deleteChatImages(collectImageIds(history));
  }
  resetSessionState();
  showEmptyHint();
});

// Continue a saved conversation (archives the current one first).
const loadSession = (sess) => chainOp(async () => {
  await persistCurrentSession();
  setHistory(sess.messages.map(m => ({ role: m.role, content: m.content, ts: m.ts, meta: m.meta, steps: m.steps })));
  setLastCode(sess.lastCodeSeenByModel ?? null);
  currentSessionId = sess.id;
  currentSessionCreated = sess.created;
  renderHistoryToUI(getHistory());
});

// Switching projects: save the old conversation, resume the new project's
// most recent one (or start empty if it has none).
const onProjectChanged = ({ project }) => chainOp(async () => {
  await persistCurrentSession();
  currentProjectId = project ? project.id : null;
  resetSessionState();
  const sessions = await getChatSessions(currentProjectId);
  if (sessions.length) {
    const s = sessions[0];
    setHistory(s.messages.map(m => ({ role: m.role, content: m.content, ts: m.ts, meta: m.meta, steps: m.steps })));
    setLastCode(s.lastCodeSeenByModel ?? null);
    currentSessionId = s.id;
    currentSessionCreated = s.created;
  }
  renderHistoryToUI(getHistory());
});

// ---------- history dialog ----------

// Every look-tool image id referenced anywhere in a saved session, so
// deleting the session can also reclaim its IndexedDB bytes.
function collectImageIds(messages) {
  const ids = [];
  for (const m of messages || []) {
    for (const step of m.steps || []) {
      if (step.type === 'tool_result' && step.imageId) ids.push(step.imageId);
    }
  }
  return ids;
}

async function deleteSessionWithImages(projectId, session) {
  await deleteChatImages(collectImageIds(session.messages));
  await deleteChatSession(projectId, session.id);
}

async function renderHistoryList() {
  const list = $('chat-history-list');
  list.textContent = '';
  const sessions = await getChatSessions(currentProjectId);
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
    open.addEventListener('click', async () => {
      await loadSession(s);
      $('chat-history-dialog').close();
    });
    li.appendChild(open);

    const del = document.createElement('button');
    del.className = 'li-btn';
    del.title = 'Delete';
    del.textContent = '🗑';
    del.addEventListener('click', async () => {
      if (!confirm('Delete this saved chat?')) return;
      await deleteSessionWithImages(currentProjectId, s);
      if (s.id === currentSessionId) { resetSessionState(); renderHistoryToUI(getHistory()); }
      await renderHistoryList();
    });
    li.appendChild(del);

    list.appendChild(li);
  }
}

// ---------- all-chats dialog (every project) ----------

function projectLabel(projectId) {
  if (!projectId) return '(no project)';
  const p = getProject(projectId);
  return p ? p.name : '(deleted project)';
}

async function renderAllChatsList() {
  const list = $('all-chats-list');
  list.textContent = '';
  const groups = (await getAllChatSessions()).sort((a, b) =>
    (b.sessions[0]?.updated ?? 0) - (a.sessions[0]?.updated ?? 0));
  if (!groups.length) {
    const li = document.createElement('li');
    li.className = 'chat-history-empty';
    li.textContent = 'No saved chats yet.';
    list.appendChild(li);
    return;
  }
  for (const { projectId, sessions } of groups) {
    const heading = document.createElement('li');
    heading.className = 'all-chats-group';
    heading.textContent = projectLabel(projectId);
    list.appendChild(heading);

    for (const s of sessions) {
      const li = document.createElement('li');

      const open = document.createElement('button');
      open.className = 'p-open' + (projectId === currentProjectId && s.id === currentSessionId ? ' current' : '');
      const title = document.createElement('span');
      title.textContent = s.title;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${new Date(s.updated).toLocaleString()} · ${s.messages.length} msgs`;
      open.append(title, meta);
      open.addEventListener('click', async () => {
        if (projectId !== currentProjectId) switchToProject(projectId);
        await loadSession(s);
        $('all-chats-dialog').close();
      });
      li.appendChild(open);

      const del = document.createElement('button');
      del.className = 'li-btn';
      del.title = 'Delete';
      del.textContent = '🗑';
      del.addEventListener('click', async () => {
        if (!confirm(`Delete "${s.title}"?`)) return;
        await deleteSessionWithImages(projectId, s);
        if (projectId === currentProjectId && s.id === currentSessionId) {
          resetSessionState();
          renderHistoryToUI(getHistory());
        }
        await renderAllChatsList();
      });
      li.appendChild(del);

      list.appendChild(li);
    }
  }
}

async function deleteAllChatHistory() {
  const groups = await getAllChatSessions();
  const total = groups.reduce((n, g) => n + g.sessions.length, 0);
  if (!total) return;
  if (!confirm(`Delete all ${total} saved chat(s) across every project? This cannot be undone.`)) return;
  for (const { projectId, sessions } of groups) {
    for (const s of sessions) await deleteSessionWithImages(projectId, s);
  }
  resetSessionState();
  renderHistoryToUI(getHistory());
  await renderAllChatsList();
}

// ---------- init ----------

export function initChat() {
  const input = $('chat-input');
  // The send button doubles as a Stop button while a reply is in flight.
  $('chat-send-btn').addEventListener('click', () => (getBusy() ? stop() : send()));
  $('chat-clear-btn').addEventListener('click', newChat);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      // Shift+Enter / Ctrl+Enter / Cmd+Enter: insert a newline at the caret
      // instead of the browser's default (which would append at the end).
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value } = input;
      input.value = value.slice(0, s) + '\n' + value.slice(en);
      input.selectionStart = input.selectionEnd = s + 1;
      input.dispatchEvent(new Event('input'));
      return;
    }
    e.preventDefault();
    if (!getBusy()) send();
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
  $('chat-history-btn').addEventListener('click', async () => {
    await renderHistoryList();
    $('chat-history-dialog').showModal();
  });
  $('chat-delete-btn')?.addEventListener('click', clearCurrentChat);

  // ----- Chat settings dialog -----
  $('set-modal-url').value = settings.modalBaseUrl;
  $('set-modal-url').addEventListener('change', e =>
    saveSettings({ modalBaseUrl: e.target.value.trim() }));
  $('set-modal-key').value = settings.modalApiKey;
  $('set-modal-key').addEventListener('change', e =>
    saveSettings({ modalApiKey: e.target.value.trim() }));
  $('chat-set-system').value = getSystemPrompt();

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

  // ----- All chat histories (every project) -----
  $('menu-all-chats').addEventListener('click', async () => {
    $('menu-dialog').close();
    await renderAllChatsList();
    $('all-chats-dialog').showModal();
  });
  $('all-chats-delete-all').addEventListener('click', deleteAllChatHistory);
}
