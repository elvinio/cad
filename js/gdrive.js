// Google Drive integration via Google Identity Services (token client)
// + Drive REST API v3 over plain fetch. The user supplies their own
// OAuth Client ID (Settings menu).

import { getSettings, saveSettings, listProjects, saveProjectRaw } from './storage.js';
import { importProject, getActiveProject } from './projects.js';
import { toast } from './ui.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'cad';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

let tokenClient = null;
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
  if (!tokenClient) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: googleClientId,
      scope: SCOPE,
      callback: () => {},
    });
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
  const remoteFiles = (remote.files || []).filter(f => f.name.endsWith('.scad'));

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

  toast(`Sync complete: ${pushed} pushed, ${pulled} pulled`);
  return { pushed, pulled };
}
