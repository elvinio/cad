// Chat session persistence (IndexedDB) and both history dialogs: the
// per-project history list and the all-projects history list. Owns the
// chainOp queue that serializes newChat/clearCurrentChat/loadSession/
// onProjectChanged against each other, since they can be triggered in the
// same tick (see the comment above chatOpChain below) and all read-modify-
// write the same in-memory session state.

import { getProject, getChatSessions, saveChatSession, deleteChatSession,
  getAllChatSessions, deleteChatImages } from '../storage.js';
import { switchToProject } from '../projects.js';
import { getHistory, setHistory, getLastCode, setLastCode } from './session-state.js';
import { $, showEmptyHint, renderHistoryToUI } from './ui.js';

// Persistence bookkeeping for the active session.
let currentProjectId = null;
let currentSessionId = null;       // null until the session has been saved once
let currentSessionCreated = null;

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
export async function persistCurrentSession() {
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
export const newChat = () => chainOp(async () => {
  await persistCurrentSession();
  resetSessionState();
  showEmptyHint();
});

// "Clear this chat": permanently delete the currently open conversation (and
// any images it referenced) instead of archiving it. Distinct from New chat,
// which keeps the old conversation around in the history list.
export const clearCurrentChat = () => chainOp(async () => {
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
export const loadSession = (sess) => chainOp(async () => {
  await persistCurrentSession();
  setHistory(sess.messages.map(m => ({ role: m.role, content: m.content, ts: m.ts, meta: m.meta, steps: m.steps })));
  setLastCode(sess.lastCodeSeenByModel ?? null);
  currentSessionId = sess.id;
  currentSessionCreated = sess.created;
  renderHistoryToUI(getHistory());
});

// Switching projects: save the old conversation, resume the new project's
// most recent one (or start empty if it has none).
export const onProjectChanged = ({ project }) => chainOp(async () => {
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

export async function renderHistoryList() {
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

export async function renderAllChatsList() {
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

export async function deleteAllChatHistory() {
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
