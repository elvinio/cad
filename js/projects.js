// Project CRUD dialog and active-project lifecycle.

import { listProjects, getProject, saveProject, saveProjectRaw, deleteProject,
         createProject, getSettings, saveSettings } from './storage.js';
import { emit } from './state.js';
import { toast } from './ui.js';

let active = null;
let dialog, list;

export function initProjects(els) {
  dialog = els.dialog;
  list = els.list;
  els.newBtn.addEventListener('click', () => newProject());
}

export async function loadInitialProject() {
  const settings = getSettings();
  let project = settings.activeProjectId && getProject(settings.activeProjectId);
  if (!project) project = listProjects()[0];
  if (!project) {
    project = createProject('demo', '');
  }
  setActive(project);
  return project;
}

export function getActiveProject() {
  return active;
}

// Switch the active project by id (used by the "all chat histories" screen to
// jump to a project before loading one of its saved conversations).
export function switchToProject(id) {
  const project = getProject(id);
  if (project) setActive(project);
  return project;
}

function setActive(project) {
  active = project;
  saveSettings({ activeProjectId: project.id });
  document.getElementById('project-name').textContent = project.name;
  emit('project:changed', { project });
}

export function updateActiveCode(code) {
  if (!active) return;
  active.code = code;
  if (!saveProject(active)) toast('Storage full — project not saved!', 'error');
}

export function updateActiveParams(paramValues) {
  if (!active) return;
  active.paramValues = paramValues;
  saveProject(active);
}

async function newProject() {
  const name = prompt('Project name:', `model-${listProjects().length + 1}`);
  if (!name) return;
  const project = createProject(name, '');
  setActive(project);
  renderList();
  dialog.close();
}

export function renderList() {
  list.textContent = '';
  const projects = listProjects().sort((a, b) => b.modified - a.modified);
  for (const project of projects) {
    const li = document.createElement('li');

    const open = document.createElement('button');
    open.className = 'p-open' + (active && project.id === active.id ? ' current' : '');
    const meta = new Date(project.modified).toLocaleString()
      + (project.driveFileId ? ' · synced' : '');
    open.innerHTML = `${escapeHtml(project.name)}<span class="meta">${escapeHtml(meta)}</span>`;
    open.addEventListener('click', () => {
      setActive(getProject(project.id));
      dialog.close();
    });
    li.appendChild(open);

    li.appendChild(iconBtn('✎', 'Rename', () => {
      const name = prompt('Rename project:', project.name);
      if (!name) return;
      const p = getProject(project.id);
      p.name = name;
      saveProject(p);
      if (active && active.id === p.id) setActive(p);
      renderList();
    }));

    li.appendChild(iconBtn('⧉', 'Duplicate', () => {
      const p = getProject(project.id);
      const copy = createProject(`${p.name} copy`, p.code);
      copy.paramValues = { ...p.paramValues };
      saveProject(copy);
      renderList();
    }));

    li.appendChild(iconBtn('⬇', 'Download .scad', () => {
      const p = getProject(project.id);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([p.code], { type: 'text/plain' }));
      a.download = `${p.name}.scad`;
      a.click();
      URL.revokeObjectURL(a.href);
    }));

    li.appendChild(iconBtn('🗑', 'Delete', () => {
      if (!confirm(`Delete project "${project.name}"?`)) return;
      deleteProject(project.id);
      if (active && active.id === project.id) {
        const next = listProjects()[0];
        if (next) setActive(next);
        else loadInitialProject();
      }
      renderList();
    }));

    list.appendChild(li);
  }
}

function iconBtn(char, title, onClick) {
  const b = document.createElement('button');
  b.className = 'li-btn';
  b.textContent = char;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

// Used by Drive sync to import remote files.
export function importProject(name, code, driveFileId, modifiedMs) {
  const project = createProject(name, code);
  project.driveFileId = driveFileId;
  if (modifiedMs) project.modified = modifiedMs;
  saveProjectRaw(project);
  return project;
}
