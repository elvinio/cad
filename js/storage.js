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
  openrouterApiKey: '',
  chatModel: 'qwen/qwen3-coder:free',
  chatMaxTokens: 4096,
  chatMaxTurns: 10,     // safety cap on the agentic tool loop
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

// ---------- Assemblies ----------
// Parallel to projects: each is a `scadpad.assembly/1` document (parts +
// placement only — geometry referenced, never embedded). Tracked by a SEPARATE
// index key so they never mix with the projects index.
const ASSEMBLIES_INDEX_KEY = `${PREFIX}.assemblies.index`;

export function listAssemblies() {
  const ids = read(ASSEMBLIES_INDEX_KEY, []);
  return ids.map(id => getAssembly(id)).filter(Boolean);
}

export function getAssembly(id) {
  return read(`${PREFIX}.assembly.${id}`, null);
}

export function saveAssembly(assembly) {
  assembly.modified = Date.now();
  const ok = write(`${PREFIX}.assembly.${assembly.id}`, assembly);
  const ids = read(ASSEMBLIES_INDEX_KEY, []);
  if (!ids.includes(assembly.id)) {
    ids.push(assembly.id);
    write(ASSEMBLIES_INDEX_KEY, ids);
  }
  return ok;
}

// Save without restamping `modified` (used when applying remote timestamps).
export function saveAssemblyRaw(assembly) {
  const ok = write(`${PREFIX}.assembly.${assembly.id}`, assembly);
  const ids = read(ASSEMBLIES_INDEX_KEY, []);
  if (!ids.includes(assembly.id)) {
    ids.push(assembly.id);
    write(ASSEMBLIES_INDEX_KEY, ids);
  }
  return ok;
}

export function deleteAssembly(id) {
  localStorage.removeItem(`${PREFIX}.assembly.${id}`);
  write(ASSEMBLIES_INDEX_KEY, read(ASSEMBLIES_INDEX_KEY, []).filter(x => x !== id));
}

export function createAssembly(name) {
  const assembly = {
    schema: 'scadpad.assembly/1',
    id: crypto.randomUUID(),
    name,
    modified: Date.now(),
    driveFileId: null,
    clearance: 0.2,
    parts: [],
  };
  saveAssembly(assembly);
  return assembly;
}

// ---------- Param sets (per project) ----------
// One `scadpad.paramsets/1` document per project holding ALL its named sets.
// Keyed by projectId; discovered per-project so there's no separate index.
const paramSetsKey = projectId => `${PREFIX}.paramsets.${projectId}`;

export function getParamSets(projectId) {
  return read(paramSetsKey(projectId), null);
}

export function saveParamSets(projectId, doc) {
  doc.modified = Date.now();
  return write(paramSetsKey(projectId), doc);
}

// Save without restamping `modified` (used when applying remote timestamps).
export function saveParamSetsRaw(projectId, doc) {
  return write(paramSetsKey(projectId), doc);
}

export function deleteParamSets(projectId) {
  localStorage.removeItem(paramSetsKey(projectId));
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
const STL_STORE = 'stlparts';

function openDb() {
  return new Promise((resolve, reject) => {
    // v2 adds the `stlparts` store. Existing users already have `libzips` at
    // v1, so the upgrade fires with that store present — guard each create.
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains(STL_STORE)) {
        db.createObjectStore(STL_STORE, { keyPath: 'name' });
      }
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

// ---------- Imported STL bytes (IndexedDB) ----------
// Mirrors the libzip store: binary part meshes referenced by assembly JSON.

export async function putStlPart(name, bytes) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STL_STORE, 'readwrite');
    tx.objectStore(STL_STORE).put({ name, bytes, importedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getStlPart(name) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STL_STORE).objectStore(STL_STORE).get(name);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteStlPart(name) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STL_STORE, 'readwrite');
    tx.objectStore(STL_STORE).delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearStlParts() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STL_STORE, 'readwrite');
    tx.objectStore(STL_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
