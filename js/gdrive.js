// Google Drive integration via Google Identity Services (token client)
// + Drive REST API v3 over plain fetch. The user supplies their own
// OAuth Client ID (Settings menu).

import {
  getSettings, saveSettings, listProjects, saveProjectRaw,
  listAssemblies, getAssembly, saveAssemblyRaw, createAssembly,
  getParamSets, saveParamSetsRaw,
  getStlPart, putStlPart,
} from './storage.js';
import { importProject, getActiveProject } from './projects.js';
import { toast } from './ui.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'cad';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

let tokenClient = null;
let tokenClientId = '';   // client ID that tokenClient was built with
let accessToken = null;
let tokenExpiry = 0;

function loadGis() {
  if (window.google && window.google.accounts) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Google sign-in (offline?)'));
    document.head.appendChild(s);
  });
}

export function isSignedIn() {
  return !!accessToken && Date.now() < tokenExpiry;
}

export async function signIn() {
  const { googleClientId } = getSettings();
  if (!googleClientId) throw new Error('Set your Google OAuth Client ID in Settings first');
  await loadGis();
  if (!tokenClient || tokenClientId !== googleClientId) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: googleClientId,
      scope: SCOPE,
      callback: () => {},
    });
    tokenClientId = googleClientId;
  }
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) { reject(new Error(resp.error)); return; }
      accessToken = resp.access_token;
      tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
      resolve();
    };
    tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
  });
}

export function signOut() {
  if (accessToken && window.google) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiry = 0;
  tokenClient = null;
  tokenClientId = '';
}

async function ensureToken() {
  if (!isSignedIn()) await signIn();
  return accessToken;
}

async function driveFetch(url, options = {}) {
  const token = await ensureToken();
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Drive API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

async function findOrCreateFolder() {
  const settings = getSettings();
  if (settings.driveFolderId) {
    // verify it still exists AND is the right folder (guard against stale IDs
    // from a previous folder name like 'OpenSCAD-PWA')
    try {
      const meta = await (await driveFetch(
        `${API}/files/${settings.driveFolderId}?fields=id,name`)).json();
      if (meta.name === FOLDER_NAME) return settings.driveFolderId;
      // name mismatch — cached ID points to wrong folder; fall through
    } catch { /* deleted remotely; fall through to search/create */ }
  }
  // Search for existing 'cad' folder directly under root
  const q = encodeURIComponent(
    `name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`);
  const found = await (await driveFetch(`${API}/files?q=${q}&fields=files(id)`)).json();
  let id = found.files && found.files[0] && found.files[0].id;
  if (!id) {
    const created = await (await driveFetch(`${API}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME, parents: ['root'] }),
    })).json();
    id = created.id;
  }
  saveSettings({ driveFolderId: id });
  return id;
}

async function uploadFile(name, blob, folderId, fileId = null) {
  const metadata = fileId ? { name } : { name, parents: [folderId] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);
  const url = fileId
    ? `${UPLOAD_API}/files/${fileId}?uploadType=multipart&fields=id,modifiedTime`
    : `${UPLOAD_API}/files?uploadType=multipart&fields=id,modifiedTime`;
  return (await driveFetch(url, { method: fileId ? 'PATCH' : 'POST', body: form })).json();
}

export async function uploadSTL(name, blob) {
  const folderId = await findOrCreateFolder();
  await uploadFile(name, blob, folderId);
}

// ---------- Project sync: last-write-wins by timestamp ----------

export async function syncProjects() {
  const folderId = await findOrCreateFolder();
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const remote = await (await driveFetch(
    `${API}/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=1000`)).json();
  const allRemote = remote.files || [];
  const remoteFiles = allRemote.filter(f => f.name.endsWith('.scad'));

  const local = listProjects();
  const byDriveId = new Map(local.filter(p => p.driveFileId).map(p => [p.driveFileId, p]));
  const byName = new Map(local.map(p => [`${p.name}.scad`, p]));
  const matchedRemoteIds = new Set();
  const matchedLocalIds = new Set();
  let pushed = 0, pulled = 0;

  for (const rf of remoteFiles) {
    const project = byDriveId.get(rf.id) || byName.get(rf.name);
    if (!project) continue;
    matchedRemoteIds.add(rf.id);
    matchedLocalIds.add(project.id);
    const remoteMs = Date.parse(rf.modifiedTime);
    if (project.modified > remoteMs + 2000) {
      const res = await uploadFile(`${project.name}.scad`,
        new Blob([project.code], { type: 'text/plain' }), folderId, rf.id);
      project.driveFileId = res.id;
      // Align local timestamp to what Drive stored so next sync sees no drift
      project.modified = Date.parse(res.modifiedTime);
      saveProjectRaw(project);
      pushed++;
    } else if (remoteMs > project.modified + 2000) {
      const code = await (await driveFetch(`${API}/files/${rf.id}?alt=media`)).text();
      project.code = code;
      project.driveFileId = rf.id;
      project.modified = remoteMs;
      saveProjectRaw(project);
      pulled++;
      const activeProject = getActiveProject();
      if (activeProject && activeProject.id === project.id) {
        activeProject.code = code;
      }
    } else if (!project.driveFileId) {
      project.driveFileId = rf.id;
      saveProjectRaw(project);
    }
  }

  // Local projects with no remote counterpart -> push as new files
  for (const project of local) {
    if (matchedLocalIds.has(project.id)) continue;
    const res = await uploadFile(`${project.name}.scad`,
      new Blob([project.code], { type: 'text/plain' }), folderId);
    project.driveFileId = res.id;
    project.modified = Date.parse(res.modifiedTime);
    saveProjectRaw(project);
    pushed++;
  }

  // Remote files with no local counterpart -> import
  for (const rf of remoteFiles) {
    if (matchedRemoteIds.has(rf.id)) continue;
    const code = await (await driveFetch(`${API}/files/${rf.id}?alt=media`)).text();
    importProject(rf.name.replace(/\.scad$/, ''), code, rf.id, Date.parse(rf.modifiedTime));
    pulled++;
  }

  // ---- New document types: assemblies + param-set sidecars (both .json) ----
  // Drive only gives us name + modifiedTime in the listing; assemblies and
  // param-sets are told apart only by the `schema` field INSIDE the JSON, so we
  // fetch+parse the .json bodies once and route by schema.
  const remoteJson = allRemote.filter(f => f.name.endsWith('.json'));
  const parsed = [];        // { rf, doc }  for every successfully parsed .json
  for (const rf of remoteJson) {
    try {
      const text = await (await driveFetch(`${API}/files/${rf.id}?alt=media`)).text();
      parsed.push({ rf, doc: JSON.parse(text) });
    } catch { /* unreadable / non-JSON — skip, never abort the sync */ }
  }
  const remoteAssemblies = parsed.filter(p => p.doc && p.doc.schema === 'scadpad.assembly/1');
  const remoteParamSets = parsed.filter(p => p.doc && p.doc.schema === 'scadpad.paramsets/1');

  const a = await syncAssemblies(folderId, remoteAssemblies);
  const p = await syncParamSets(folderId, remoteParamSets, local);
  pushed += a.pushed + p.pushed;
  pulled += a.pulled + p.pulled;

  toast(`Sync complete: ${pushed} pushed, ${pulled} pulled`);
  return { pushed, pulled };
}

// Serialize a localStorage JSON doc to a Drive-bound Blob (stable, pretty).
function jsonBlob(doc) {
  return new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
}

// ---------- Assemblies <-> <name>.json (schema scadpad.assembly/1) ----------
// Mirrors the project round-trip: byDriveId then byName, ±2s dead-zone
// last-write-wins, saveAssemblyRaw to apply remote timestamps without restamp.
async function syncAssemblies(folderId, remoteAssemblies) {
  const local = listAssemblies();
  const byDriveId = new Map(local.filter(x => x.driveFileId).map(x => [x.driveFileId, x]));
  const byName = new Map(local.map(x => [`${x.name}.json`, x]));
  const matchedRemoteIds = new Set();
  const matchedLocalIds = new Set();
  let pushed = 0, pulled = 0;

  for (const { rf, doc } of remoteAssemblies) {
    const asm = byDriveId.get(rf.id) || byName.get(rf.name);
    if (!asm) continue;
    matchedRemoteIds.add(rf.id);
    matchedLocalIds.add(asm.id);
    const remoteMs = Date.parse(rf.modifiedTime);
    if (asm.modified > remoteMs + 2000) {
      const res = await uploadFile(`${asm.name}.json`, jsonBlob(asm), folderId, rf.id);
      asm.driveFileId = res.id;
      asm.modified = Date.parse(res.modifiedTime);
      saveAssemblyRaw(asm);
      pushed++;
    } else if (remoteMs > asm.modified + 2000) {
      doc.id = asm.id;            // keep our local id stable on download
      doc.driveFileId = rf.id;
      doc.modified = remoteMs;
      saveAssemblyRaw(doc);
      pulled++;
    } else if (!asm.driveFileId) {
      asm.driveFileId = rf.id;
      saveAssemblyRaw(asm);
    }
    // Whichever way it resolved, reconcile its STL parts in both directions
    // against the now-current local copy.
    const current = getAssembly(asm.id);
    await ensureStlPartsLocal(current);
    await ensureStlPartsRemote(current, folderId);
  }

  // Local assemblies with no remote counterpart -> push as new files
  for (const asm of local) {
    if (matchedLocalIds.has(asm.id)) continue;
    const res = await uploadFile(`${asm.name}.json`, jsonBlob(asm), folderId);
    asm.driveFileId = res.id;
    asm.modified = Date.parse(res.modifiedTime);
    saveAssemblyRaw(asm);
    await ensureStlPartsRemote(asm, folderId);
    pushed++;
  }

  // Remote assemblies with no local counterpart -> create locally
  for (const { rf, doc } of remoteAssemblies) {
    if (matchedRemoteIds.has(rf.id)) continue;
    const created = createAssembly(doc.name || rf.name.replace(/\.json$/, ''));
    const merged = { ...doc, id: created.id, driveFileId: rf.id,
                     modified: Date.parse(rf.modifiedTime) };
    saveAssemblyRaw(merged);
    await ensureStlPartsLocal(merged);
    pulled++;
  }

  return { pushed, pulled };
}

// ---------- Param sets <-> <projectName>.params.json (scadpad.paramsets/1) ----
// Sidecar keyed in storage by projectId; the doc's `project` field also holds
// the projectId. The Drive filename is <projectName>.params.json, so we resolve
// project name <-> id via the local projects list. Last-write-wins like above.
async function syncParamSets(folderId, remoteParamSets, localProjects) {
  const byId = new Map(localProjects.map(pr => [pr.id, pr]));
  const byName = new Map(localProjects.map(pr => [pr.name, pr]));
  // Build the set of local param-set docs that actually exist.
  const localDocs = localProjects
    .map(pr => ({ project: pr, doc: getParamSets(pr.id) }))
    .filter(x => x.doc);
  const byDriveId = new Map(
    localDocs.filter(x => x.doc.driveFileId).map(x => [x.doc.driveFileId, x]));
  const matchedRemoteIds = new Set();
  const matchedProjectIds = new Set();
  let pushed = 0, pulled = 0;

  const fileName = pr => `${pr.name}.params.json`;

  for (const { rf, doc } of remoteParamSets) {
    // Resolve which local project this sidecar belongs to.
    let entry = byDriveId.get(rf.id);
    if (!entry) {
      // Match by the project the doc names, or by filename <name>.params.json.
      const pr = byId.get(doc.project)
        || byName.get(rf.name.replace(/\.params\.json$/, ''));
      if (pr) entry = { project: pr, doc: getParamSets(pr.id) };
    }
    if (!entry || !entry.project) continue;   // orphan sidecar; nothing to attach to
    const pr = entry.project;
    matchedRemoteIds.add(rf.id);
    matchedProjectIds.add(pr.id);
    const localDoc = entry.doc;               // may be null if not present locally
    const remoteMs = Date.parse(rf.modifiedTime);

    if (localDoc && localDoc.modified > remoteMs + 2000) {
      const res = await uploadFile(fileName(pr), jsonBlob(localDoc), folderId, rf.id);
      localDoc.driveFileId = res.id;
      localDoc.modified = Date.parse(res.modifiedTime);
      saveParamSetsRaw(pr.id, localDoc);
      pushed++;
    } else if (!localDoc || remoteMs > (localDoc.modified || 0) + 2000) {
      const merged = { ...doc, project: pr.id, driveFileId: rf.id, modified: remoteMs };
      saveParamSetsRaw(pr.id, merged);
      pulled++;
    } else if (localDoc && !localDoc.driveFileId) {
      localDoc.driveFileId = rf.id;
      saveParamSetsRaw(pr.id, localDoc);
    }
  }

  // Local sidecars with no remote counterpart -> push as new files
  for (const { project: pr, doc } of localDocs) {
    if (matchedProjectIds.has(pr.id)) continue;
    if (doc.driveFileId && matchedRemoteIds.has(doc.driveFileId)) continue;
    const res = await uploadFile(fileName(pr), jsonBlob(doc), folderId);
    doc.driveFileId = res.id;
    doc.modified = Date.parse(res.modifiedTime);
    saveParamSetsRaw(pr.id, doc);
    pushed++;
  }

  // Remote sidecars whose project doesn't exist locally are skipped: there's no
  // project to attach them to (a .params.json with no matching .scad). They'll
  // attach on a later sync once the project is pulled.
  return { pushed, pulled };
}

// ---------- Imported STL parts (IndexedDB <-> Drive .stl) ----------
// Best-effort and resilient: a missing/failed STL must never abort the sync.

function stlRefs(assembly) {
  return (assembly && Array.isArray(assembly.parts) ? assembly.parts : [])
    .filter(p => p && p.source && p.source.type === 'stl' && p.source.ref)
    .map(p => p.source.ref);
}

// Look up a Drive file by exact name in the cad folder (returns {id} or null).
async function findRemoteByName(name, folderId) {
  try {
    const q = encodeURIComponent(
      `name='${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`);
    const res = await (await driveFetch(`${API}/files?q=${q}&fields=files(id,name)`)).json();
    return (res.files && res.files[0]) || null;
  } catch { return null; }
}

// For every STL the assembly references that isn't in IndexedDB, pull it down.
async function ensureStlPartsLocal(assembly) {
  for (const ref of stlRefs(assembly)) {
    try {
      const have = await getStlPart(ref);
      if (have) continue;
      const remote = await findRemoteByName(ref, getSettings().driveFolderId);
      if (!remote) continue;
      const buf = await (await driveFetch(`${API}/files/${remote.id}?alt=media`)).arrayBuffer();
      await putStlPart(ref, new Uint8Array(buf));
    } catch { /* one bad STL must not break the whole sync */ }
  }
}

// For every STL the assembly references that lives locally but not on Drive,
// upload it. Uses findRemoteByName to avoid duplicating an already-pushed file.
async function ensureStlPartsRemote(assembly, folderId) {
  for (const ref of stlRefs(assembly)) {
    try {
      const local = await getStlPart(ref);
      if (!local) continue;
      const remote = await findRemoteByName(ref, folderId);
      if (remote) continue;            // already on Drive
      await uploadFile(ref,
        new Blob([local.bytes], { type: 'application/octet-stream' }), folderId);
    } catch { /* best-effort */ }
  }
}
