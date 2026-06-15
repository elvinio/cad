// Named parameter sets per scad project: a dropdown + save/save-as/rename/delete
// bar in the Param tab. A project's sets live in one `scadpad.paramsets/1` doc
// (see js/storage.js); each set is an overrides map in the exact shape
// getParamValues() returns. Until the user saves, a project with no doc shows a
// single implicit `default` set ({}) and no doc is written.

import { subscribe } from './state.js';
import { getParamSets, saveParamSets, deleteParamSets } from './storage.js';
import { getParamValues, applyParamSet } from './customizer.js';

let select, saveBtn, saveAsBtn, renameBtn, deleteBtn;
let projectId = null;   // active scad project id
let doc = null;         // loaded paramsets doc, or null when none saved yet
let active = 'default'; // active set name (implicit `default` until a doc exists)

export function initParamSets(els) {
  select = els.select;
  saveBtn = els.saveBtn;
  saveAsBtn = els.saveAsBtn;
  renameBtn = els.renameBtn;
  deleteBtn = els.deleteBtn;

  select.addEventListener('change', onSelect);
  saveBtn.addEventListener('click', onSave);
  saveAsBtn.addEventListener('click', onSaveAs);
  renameBtn.addEventListener('click', onRename);
  deleteBtn.addEventListener('click', onDelete);

  // Re-target to whichever scad project is open.
  subscribe('project:changed', ({ project }) => {
    projectId = project && project.id;
    doc = projectId ? getParamSets(projectId) : null;
    active = (doc && doc.active && doc.sets && doc.active in doc.sets)
      ? doc.active
      : 'default';
    refresh();
  });

  refresh();
}

// Build a fresh doc seeded with the current set under `name`.
function makeDoc(name, overrides) {
  return {
    schema: 'scadpad.paramsets/1',
    project: projectId,
    modified: Date.now(),
    driveFileId: null,
    active: name,
    sets: { [name]: { ...overrides } },
  };
}

// Rebuild the dropdown options from the doc's sets (or a lone `default`),
// mark the active one, and enable/disable buttons for the current state.
function refresh() {
  if (!select) return;
  const names = doc ? Object.keys(doc.sets) : [];
  if (!names.length) names.push('default'); // implicit default when no doc yet

  select.textContent = '';
  for (const name of names) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    select.appendChild(o);
  }
  if (!names.includes(active)) active = names[0];
  select.value = active;

  // Rename/delete only make sense once a doc with sets exists.
  const hasDoc = !!doc;
  renameBtn.disabled = !hasDoc;
  deleteBtn.disabled = !hasDoc;
}

// Pick a set: apply its overrides to the live model and persist the choice.
function onSelect() {
  active = select.value;
  const overrides = (doc && doc.sets[active]) || {};
  applyParamSet(overrides);            // re-render + autosave via customizer
  if (doc && doc.active !== active) {
    doc.active = active;
    saveParamSets(projectId, doc);     // persist active selection
  }
}

// Overwrite the active set with the current overrides (create the doc if none).
function onSave() {
  if (!projectId) return;
  const overrides = getParamValues();
  if (!doc) doc = makeDoc(active, overrides);
  else { doc.sets[active] = { ...overrides }; doc.active = active; }
  saveParamSets(projectId, doc);
  refresh();
}

// Create a new named set from the current overrides and make it active.
function onSaveAs() {
  if (!projectId) return;
  const name = (prompt('Save parameter set as:') || '').trim();
  if (!name) return;
  if (doc && name in doc.sets && !confirm(`Set "${name}" exists — overwrite?`)) return;
  const overrides = getParamValues();
  if (!doc) doc = makeDoc(name, overrides);
  else { doc.sets[name] = { ...overrides }; doc.active = name; }
  active = name;
  saveParamSets(projectId, doc);
  refresh();
}

// Rename the active set (key rename within sets), guarding blank/duplicate.
function onRename() {
  if (!doc) return;
  const name = (prompt('Rename parameter set:', active) || '').trim();
  if (!name || name === active) return;
  if (name in doc.sets) { alert(`Set "${name}" already exists.`); return; }
  doc.sets[name] = doc.sets[active];
  delete doc.sets[active];
  doc.active = name;
  active = name;
  saveParamSets(projectId, doc);
  refresh();
}

// Delete the active set. If it was the last one, drop the whole doc and fall
// back to the implicit `default`; otherwise activate another remaining set.
function onDelete() {
  if (!doc) return;
  if (!confirm(`Delete parameter set "${active}"?`)) return;
  delete doc.sets[active];
  const remaining = Object.keys(doc.sets);
  if (!remaining.length) {
    deleteParamSets(projectId);
    doc = null;
    active = 'default';
  } else {
    active = remaining[0];
    doc.active = active;
    saveParamSets(projectId, doc);
    applyParamSet(doc.sets[active]); // reflect the now-active set in the model
  }
  refresh();
}
