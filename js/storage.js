// localStorage: projects + settings. IndexedDB: library zip bytes.

const PREFIX = 'scadpad';
const INDEX_KEY = `${PREFIX}.projects.index`;
const SETTINGS_KEY = `${PREFIX}.settings`;

export const DEFAULT_SETTINGS = {
  googleClientId: '',
  backend: 'manifold',
  quality: 'preview',
  custom: { fn: 0, fa: 12, fs: 2 },
  finalQualityExport: true,
  modelColor: '#f9d72c',
  installedLibs: [],
  activeProjectId: null,
  driveFolderId: null,
  anthropicApiKey: '',
  chatModel: 'claude-sonnet-4-6',
  chatMaxTokens: 4096,
  chatSendSnapshot: true,
  chatSystemPrompt: null, // null -> DEFAULT_SYSTEM_PROMPT in chat.js
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    if (e && e.name === 'QuotaExceededError') return false;
    throw e;
  }
}

// ---------- Projects ----------

export function listProjects() {
  const ids = read(INDEX_KEY, []);
  return ids.map(id => getProject(id)).filter(Boolean);
}

export function getProject(id) {
  return read(`${PREFIX}.project.${id}`, null);
}

export function saveProject(project) {
  project.modified = Date.now();
  const ok = write(`${PREFIX}.project.${project.id}`, project);
  const ids = read(INDEX_KEY, []);
  if (!ids.includes(project.id)) {
    ids.push(project.id);
    write(INDEX_KEY, ids);
  }
  return ok;
}

// Save without restamping `modified` (used when applying remote timestamps).
export function saveProjectRaw(project) {
  const ok = write(`${PREFIX}.project.${project.id}`, project);
  const ids = read(INDEX_KEY, []);
  if (!ids.includes(project.id)) {
    ids.push(project.id);
    write(INDEX_KEY, ids);
  }
  return ok;
}

export function deleteProject(id) {
  localStorage.removeItem(`${PREFIX}.project.${id}`);
  write(INDEX_KEY, read(INDEX_KEY, []).filter(x => x !== id));
}

export function createProject(name, code) {
  const project = {
    id: crypto.randomUUID(),
    name,
    code,
    paramValues: {},
    modified: Date.now(),
    driveFileId: null,
  };
  saveProject(project);
  return project;
}

// ---------- Settings ----------

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read(SETTINGS_KEY, {}) };
}

export function saveSettings(patch) {
  const settings = { ...getSettings(), ...patch };
  write(SETTINGS_KEY, settings);
  return settings;
}

// ---------- Chat sessions (per project) ----------
// Each project keeps a list of saved conversations (text-only, no snapshots).
// Capped to the most recent MAX_CHAT_SESSIONS so chat never starves the
// localStorage quota that projects also share.
const MAX_CHAT_SESSIONS = 20;
const chatKey = projectId => `${PREFIX}.chat.${projectId || 'none'}`;

// Newest first.
export function getChatSessions(projectId) {
  return read(chatKey(projectId), []);
}

// Upsert a session by id, restamp `updated`, move it to the front, and prune.
export function saveChatSession(projectId, session) {
  const sessions = getChatSessions(projectId).filter(s => s.id !== session.id);
  sessions.unshift({ ...session, updated: Date.now() });
  return write(chatKey(projectId), sessions.slice(0, MAX_CHAT_SESSIONS));
}

export function deleteChatSession(projectId, sessionId) {
  const sessions = getChatSessions(projectId).filter(s => s.id !== sessionId);
  write(chatKey(projectId), sessions);
}

// ---------- Library zips (IndexedDB) ----------

const DB_NAME = 'scadpad';
const STORE = 'libzips';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'name' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putLibZip(name, url, zipBytes) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ name, url, zipBytes, fetchedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getLibZip(name) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(name);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteLibZip(name) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearLibZips() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
