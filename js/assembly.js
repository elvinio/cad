// Assembly document controller + Parts-tab UI.
//
// Manages the assembly data model (parts + placement) and the Parts panel.
// Does NO 3D / Three.js / geometry work — that lives in the viewer and talks to
// this module ONLY through the event bus.
//
// Bus topics EMITTED here:
//   assembly:active            {assembly}            an assembly became the active document
//   assembly:parts-changed     {assembly}            parts added/removed/visibility/color/source edited
//   assembly:clearance-changed {clearance}           clearance slider moved
//   part:select                {id|null}             user clicked a part row (request gizmo attach)
//
// Bus topics SUBSCRIBED here (emitted by the viewer — defensive, may never fire):
//   part:moved      {id, transform}                  viewer drag-end -> write transform + autosave
//   part:selected   {id|null}                         highlight matching row
//   fit:updated     {pairs:[{a,b,clash,gap}]}         render the fit readout

import { listAssemblies, getAssembly, saveAssembly, deleteAssembly,
         createAssembly, listProjects, getProject } from './storage.js';
import { emit, subscribe } from './state.js';
import { extractParams } from './render-manager.js';
import { setParamValues, getParamValues } from './customizer.js';
import { toast } from './ui.js';
import { getActiveProject, switchToProject } from './projects.js';

const DEFAULT_PART_COLOR = '#cccccc';

let active = null;
let els = null;
let selectedPartId = null;
// Cache of extracted ParameterSets per scad project (keyed by projectId) so
// re-selecting a part doesn't re-run the worker param pass every time.
const paramSchemaCache = new Map();

export function initAssembly(elements) {
  els = elements;

  els.newBtn.addEventListener('click', () => newAssembly());
  els.addPartBtn.addEventListener('click', () => addPart());

  els.clearanceSlider.addEventListener('input', () => {
    const clearance = parseFloat(els.clearanceSlider.value);
    if (active) {
      active.clearance = clearance;
      autosave();
    }
    updateClearanceLabel(clearance);
    emit('assembly:clearance-changed', { clearance });
  });

  // Viewer -> here (defensive: the viewer may not exist yet this round).
  subscribe('part:moved', ({ id, transform }) => {
    if (!active) return;
    const part = active.parts.find(p => p.id === id);
    if (!part) return;
    part.transform = transform;
    autosave();
    if (id === selectedPartId) updateTransformPanel(part);
  });

  // Selection from the 3D viewport (viewer raycast). Mirror it into the list +
  // retarget the Param tab to the clicked part.
  subscribe('part:selected', ({ id }) => onSelectionChanged(id));

  // The Param tab is shared: in assembly mode its edits belong to the selected
  // part (written inline into the assembly), not to a scad project.
  subscribe('params:changed', () => {
    if (!isAssemblyMode() || !active || !selectedPartId) return;
    const part = active.parts.find(p => p.id === selectedPartId);
    if (!part || part.source.type !== 'scad') return;
    part.source.overrides = getParamValues();
    autosave();
    // Re-render just this part (the viewer re-renders parts whose overrides changed).
    emit('assembly:parts-changed', { assembly: active });
  });

  subscribe('fit:updated', ({ pairs }) => renderFit(pairs));

  initTransformPanel();
}

function isAssemblyMode() {
  return document.body.classList.contains('mode-assembly');
}

// Central selection handler: highlight the row and point the Param tab at the
// selected part's parameters (pre-filled with its saved overrides).
function onSelectionChanged(id) {
  selectedPartId = id || null;
  if (els && els.partsList) {
    els.partsList.querySelectorAll('li').forEach(li =>
      li.classList.toggle('selected', li.dataset.id === id));
  }
  const part = id && active && active.parts.find(p => p.id === id);
  updateTransformPanel(part || null);
  retargetParamTab();
}

async function retargetParamTab() {
  if (!active) return;
  const part = selectedPartId && active.parts.find(p => p.id === selectedPartId);
  // No (scad) part selected → clear the form.
  if (!part || part.source.type !== 'scad') {
    emit('params:extracted', { parameters: [] });
    setParamValues({});
    return;
  }
  const project = getProject(part.source.projectId);
  if (!project) {
    emit('params:extracted', { parameters: [] });
    setParamValues({});
    return;
  }
  let schema = paramSchemaCache.get(part.source.projectId);
  if (!schema) {
    schema = await extractParams(project.code);
    if (schema) paramSchemaCache.set(part.source.projectId, schema);
  }
  // The selection may have changed while we awaited; bail if so.
  if (selectedPartId !== part.id) return;
  emit('params:extracted', schema || { parameters: [] });
  setParamValues(part.source.overrides || {});
}

export function getActiveAssembly() {
  return active;
}

function setActive(assembly) {
  active = assembly;
  selectedPartId = null;
  document.getElementById('project-name').textContent = assembly.name;
  emit('assembly:active', { assembly });
  renderParts();
  syncClearanceUI();
  updateTransformPanel(null);
  retargetParamTab();   // nothing selected yet -> clear the Param tab
}

function autosave() {
  if (!active) return;
  if (!saveAssembly(active)) toast('Storage full — assembly not saved!', 'error');
}

function syncClearanceUI() {
  if (!els || !active) return;
  els.clearanceSlider.value = active.clearance;
  updateClearanceLabel(active.clearance);
}

function updateClearanceLabel(clearance) {
  if (els && els.clearanceValue) {
    els.clearanceValue.textContent = `${Number(clearance).toFixed(2)} mm`;
  }
}

function newAssembly() {
  const name = prompt('Assembly name:', `assembly-${listAssemblies().length + 1}`);
  if (!name) return;
  const assembly = createAssembly(name);
  setActive(assembly);
  renderList();
  els.list.closest('dialog')?.close();
}

// ----- Assemblies dialog list -----

export function renderList() {
  if (!els || !els.list) return;
  els.list.textContent = '';
  const assemblies = listAssemblies().sort((a, b) => b.modified - a.modified);
  for (const assembly of assemblies) {
    const li = document.createElement('li');

    const open = document.createElement('button');
    open.className = 'p-open' + (active && assembly.id === active.id ? ' current' : '');
    const meta = new Date(assembly.modified).toLocaleString()
      + (assembly.driveFileId ? ' · synced' : '');
    open.innerHTML = `${escapeHtml(assembly.name)}<span class="meta">${escapeHtml(meta)}</span>`;
    open.addEventListener('click', () => {
      setActive(getAssembly(assembly.id));
      els.list.closest('dialog')?.close();
    });
    li.appendChild(open);

    li.appendChild(iconBtn('✎', 'Rename', () => {
      const name = prompt('Rename assembly:', assembly.name);
      if (!name) return;
      const a = getAssembly(assembly.id);
      a.name = name;
      saveAssembly(a);
      if (active && active.id === a.id) setActive(a);
      renderList();
    }));

    li.appendChild(iconBtn('⧉', 'Duplicate', () => {
      const a = getAssembly(assembly.id);
      const copy = createAssembly(`${a.name} copy`);
      copy.clearance = a.clearance;
      copy.parts = a.parts.map(p => ({
        ...p,
        id: crypto.randomUUID(),
        source: { ...p.source },
        transform: { ...p.transform },
      }));
      saveAssembly(copy);
      renderList();
    }));

    li.appendChild(iconBtn('🗑', 'Delete', () => {
      if (!confirm(`Delete assembly "${assembly.name}"?`)) return;
      const wasActive = active && active.id === assembly.id;
      deleteAssembly(assembly.id);
      if (wasActive) {
        active = null;
        // Deleting the open assembly leaves assembly mode: fall back to the
        // last scad project, which re-emits project:changed and lets main.js
        // + viewer.js run their existing exit-assembly-mode teardown.
        const project = getActiveProject();
        if (project) switchToProject(project.id);
      }
      renderList();
    }));

    els.list.appendChild(li);
  }
}

// ----- Parts panel -----

function renderParts() {
  if (!els || !els.partsList) return;
  els.partsList.textContent = '';

  if (!active || active.parts.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No parts yet. Add a part from one of your scad projects.';
    els.partsList.appendChild(p);
    return;
  }

  for (const part of active.parts) {
    const li = document.createElement('li');
    li.dataset.id = part.id;

    const swatch = document.createElement('span');
    swatch.className = 'part-swatch';
    swatch.style.background = part.color || DEFAULT_PART_COLOR;
    // Click the swatch to recolor the part.
    swatch.title = 'Change color';
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      const color = prompt('Part color (#rrggbb):', part.color || DEFAULT_PART_COLOR);
      if (!color) return;
      part.color = color;
      swatch.style.background = color;
      autosave();
      emit('assembly:parts-changed', { assembly: active });
    });
    li.appendChild(swatch);

    const name = document.createElement('button');
    name.className = 'part-name';
    name.textContent = part.name;
    name.addEventListener('click', () => {
      emit('part:select', { id: part.id });   // viewer: attach gizmo
      onSelectionChanged(part.id);             // list highlight + Param tab retarget
    });
    li.appendChild(name);

    li.appendChild(iconBtn(part.visible ? '👁' : '🚫', 'Toggle visibility', () => {
      part.visible = !part.visible;
      autosave();
      emit('assembly:parts-changed', { assembly: active });
      renderParts();
    }));

    li.appendChild(iconBtn('🗑', 'Delete part', () => {
      if (!confirm(`Remove part "${part.name}"?`)) return;
      active.parts = active.parts.filter(p => p.id !== part.id);
      autosave();
      emit('assembly:parts-changed', { assembly: active });
      emit('part:select', { id: null });
      onSelectionChanged(null);
      renderParts();
    }));

    els.partsList.appendChild(li);
  }
}

function addPart() {
  if (!active) {
    toast('Open or create an assembly first.', 'error');
    return;
  }
  const projects = listProjects();
  if (projects.length === 0) {
    toast('No scad projects to add. (STL import coming soon.)', 'error');
    return;
  }

  const menu = projects.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
  const choice = prompt(`Add part from project:\n${menu}`, '1');
  if (!choice) return;
  const idx = parseInt(choice, 10) - 1;
  const project = projects[idx];
  if (!project) {
    toast('No such project.', 'error');
    return;
  }

  const part = {
    id: crypto.randomUUID(),
    name: project.name,
    source: { type: 'scad', projectId: project.id, overrides: {} },
    transform: { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1 },
    color: DEFAULT_PART_COLOR,
    visible: true,
  };
  active.parts.push(part);
  autosave();
  emit('assembly:parts-changed', { assembly: active });
  renderParts();
}

// ----- Fit readout -----

function renderFit(pairs) {
  if (!els || !els.fitReadout) return;
  els.fitReadout.textContent = '';
  if (!active || !pairs || pairs.length === 0) return;

  const nameOf = id => {
    const part = active.parts.find(p => p.id === id);
    return part ? part.name : id;
  };

  for (const pair of pairs) {
    const row = document.createElement('div');
    row.className = 'fit-row';
    const label = `${nameOf(pair.a)} ↔ ${nameOf(pair.b)}`;

    const status = document.createElement('span');
    if (pair.clash) {
      status.className = 'fit-clash';
      status.textContent = 'clash';
    } else {
      const tight = pair.gap < active.clearance;
      status.className = tight ? 'fit-tight' : '';
      status.textContent = `${Number(pair.gap).toFixed(2)} mm`;
    }

    row.textContent = `${label}: `;
    row.appendChild(status);
    els.fitReadout.appendChild(row);
  }
}

// ----- Transform panel -----

function initTransformPanel() {
  const panel = document.getElementById('part-transform-panel');
  if (!panel) return;

  let _holdTimer = null;
  let _holdCount = 0;

  function _clearHold() {
    clearTimeout(_holdTimer);
    _holdTimer = null;
    _holdCount = 0;
  }

  function _doStep(part, prop, dir) {
    const step = prop[0] === 'p'
      ? parseFloat(document.getElementById('txp-pos-step').value)
      : parseFloat(document.getElementById('txp-rot-step').value);
    setTransformProp(part, prop, getTransformProp(part, prop) + dir * step);
    updateTransformPanel(part);
    autosave();
    emit('assembly:parts-changed', { assembly: active });
  }

  function _scheduleHold(part, prop, dir) {
    _holdCount++;
    // Accelerate: 120ms for first 8 repeats, 60ms for next 8, then 30ms
    const delay = _holdCount <= 8 ? 120 : _holdCount <= 16 ? 60 : 30;
    _holdTimer = setTimeout(() => {
      _doStep(part, prop, dir);
      _scheduleHold(part, prop, dir);
    }, delay);
  }

  panel.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.txp-btn');
    if (!btn || !active || !selectedPartId) return;
    const part = active.parts.find(p => p.id === selectedPartId);
    if (!part) return;
    const prop = btn.dataset.prop;
    const dir = parseFloat(btn.dataset.d);
    _clearHold();
    _doStep(part, prop, dir);
    // 400ms initial delay before repeat begins
    _holdTimer = setTimeout(() => _scheduleHold(part, prop, dir), 400);
  });

  // Listen on document so release is caught even if finger/pointer drifts off the button
  document.addEventListener('pointerup', _clearHold);
  document.addEventListener('pointercancel', _clearHold);

  panel.addEventListener('change', (e) => {
    const inp = e.target.closest('.txp-inp');
    if (!inp || !active || !selectedPartId) return;
    const part = active.parts.find(p => p.id === selectedPartId);
    if (!part) return;
    setTransformProp(part, inp.dataset.prop, parseFloat(inp.value) || 0);
    autosave();
    emit('assembly:parts-changed', { assembly: active });
  });
}

const _propIndex = { px: [0, 'pos'], py: [1, 'pos'], pz: [2, 'pos'],
                     rx: [0, 'rot'], ry: [1, 'rot'], rz: [2, 'rot'] };

function getTransformProp(part, prop) {
  const [i, arr] = _propIndex[prop];
  return ((part.transform || {})[arr] || [0, 0, 0])[i] || 0;
}

function setTransformProp(part, prop, val) {
  if (!part.transform) part.transform = { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1 };
  const [i, arr] = _propIndex[prop];
  if (!part.transform[arr]) part.transform[arr] = [0, 0, 0];
  part.transform[arr][i] = Math.round(val * 1000) / 1000;
}

function updateTransformPanel(part) {
  const panel = document.getElementById('part-transform-panel');
  if (!panel) return;
  if (!part) { panel.hidden = true; return; }
  panel.hidden = false;
  const t = part.transform || {};
  const pos = t.pos || [0, 0, 0];
  const rot = t.rot || [0, 0, 0];
  document.getElementById('txp-px').value = pos[0];
  document.getElementById('txp-py').value = pos[1];
  document.getElementById('txp-pz').value = pos[2];
  document.getElementById('txp-rx').value = rot[0];
  document.getElementById('txp-ry').value = rot[1];
  document.getElementById('txp-rz').value = rot[2];
}

// ----- helpers (mirrored from projects.js) -----

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
