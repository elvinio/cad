// App bootstrap.

import { subscribe } from './state.js';
import { initUI, toast } from './ui.js';
import { initViewer, fitView, setView, cycleDisplayMode, toggleGrid } from './viewer.js';
import { initEditor, getCode, setCode, clearHistory, canUndo, canRedo, undo, redo, insertText } from './editor.js';
import { initCustomizer, getParamValues, setParamValues } from './customizer.js';
import { initParamSets } from './paramsets.js';
import { initAssembly, renderList as renderAssemblies } from './assembly.js';
import { initProjects, loadInitialProject, renderList as renderProjects,
         updateActiveCode, updateActiveParams } from './projects.js';
import { initLibraries, renderList as renderLibraries, ensureInstalledLibsCached } from './libraries.js';
import { initRenderManager, requestRender } from './render-manager.js';
import { initExport } from './export.js';
import { initSettings, setQuality } from './settings.js';
import { getSettings } from './storage.js';
import { syncProjects } from './gdrive.js';
import { initDocs } from './docs.js';
import { initChat } from './chat.js';

const $ = id => document.getElementById(id);

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  initUI();
  initViewer($('viewer-canvas'));
  function syncUndoRedoBtns() {
    $('undo-btn').disabled = !canUndo();
    $('redo-btn').disabled = !canRedo();
  }
  initEditor($('editor'), { onChange: updateActiveCode, onUndoRedoStateChange: syncUndoRedoBtns });
  $('undo-btn').addEventListener('click', undo);
  $('redo-btn').addEventListener('click', redo);
  // Insert common coding chars at the caret. mousedown + preventDefault keeps the
  // textarea focused (and the soft keyboard open) instead of blurring on tap.
  $('key-bar').addEventListener('mousedown', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (!btn) return;
    e.preventDefault();
    insertText(btn.dataset.key);
  });
  initCustomizer($('customizer-form'), { onValuesChanged: updateActiveParams });
  initParamSets({
    select: $('paramset-select'),
    saveBtn: $('paramset-save'),
    saveAsBtn: $('paramset-saveas'),
    renameBtn: $('paramset-rename'),
    deleteBtn: $('paramset-delete'),
  });
  initProjects({
    dialog: $('projects-dialog'),
    list: $('projects-list'),
    newBtn: $('new-project-btn'),
  });
  initAssembly({
    list: $('assemblies-list'),
    newBtn: $('new-assembly-btn'),
    partsList: $('parts-list'),
    addPartBtn: $('add-part-btn'),
    clearanceSlider: $('clearance-slider'),
    clearanceValue: $('clearance-value'),
    fitReadout: $('fit-readout'),
  });
  initLibraries({
    dialog: $('libraries-dialog'),
    list: $('libraries-list'),
    customName: $('lib-custom-name'),
    customUrl: $('lib-custom-url'),
    customAdd: $('lib-custom-add'),
  });
  initSettings();
  initDocs();
  initChat();
  initRenderManager({ getCode, getParamValues });
  initExport({
    exportBtn: $('export-btn'),
    dialog: $('export-dialog'),
    deviceBtn: $('export-device'),
    driveBtn: $('export-drive'),
  });

  // Menu navigation
  $('project-btn').addEventListener('click', () => {
    renderProjects();
    renderAssemblies();
    $('projects-dialog').showModal();
  });
  $('menu-projects').addEventListener('click', () => {
    $('menu-dialog').close();
    renderProjects();
    renderAssemblies();
    $('projects-dialog').showModal();
  });
  $('menu-libraries').addEventListener('click', () => {
    $('menu-dialog').close();
    renderLibraries();
    $('libraries-dialog').showModal();
  });
  $('menu-sync').addEventListener('click', async () => {
    $('menu-dialog').close();
    try {
      await syncProjects();
      renderProjects();
    } catch (e) {
      toast(`Sync failed: ${e.message}`, 'error');
    }
  });
  const gridBtn = $('grid-toggle-btn');
  gridBtn.addEventListener('click', () => {
    const visible = toggleGrid();
    gridBtn.classList.toggle('grid-off', !visible);
  });
  $('view-presets').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (btn) setView(btn.dataset.view);
  });
  $('display-mode-btn').addEventListener('click', (e) => {
    const mode = cycleDisplayMode();
    e.currentTarget.textContent = mode[0].toUpperCase() + mode.slice(1);
  });

  const qualityBtn = $('quality-toggle-btn');
  const syncQualityBtn = () => {
    const q = getSettings().quality;
    qualityBtn.textContent = q === 'draft' ? 'Draft' : 'Prev';
  };
  syncQualityBtn();
  qualityBtn.addEventListener('click', () => {
    const next = getSettings().quality === 'draft' ? 'preview' : 'draft';
    setQuality(next);
    syncQualityBtn();
  });

  // Wiring: edits and settings changes trigger renders. In assembly mode the
  // single-file pipeline is dormant — the viewer renders each part itself (and
  // re-renders parts on settings:changed), so skip the auto single render.
  const inAssemblyMode = () => document.body.classList.contains('mode-assembly');
  subscribe('code:changed', ({ immediate }) => { if (!inAssemblyMode()) requestRender(immediate ? 'project' : 'code'); });
  subscribe('params:changed', () => { if (!inAssemblyMode()) requestRender('params'); });
  subscribe('settings:changed', () => { if (!inAssemblyMode()) requestRender('settings'); syncQualityBtn(); });
  subscribe('libs:changed', () => { if (!inAssemblyMode()) requestRender('settings'); });
  subscribe('project:changed', ({ project }) => {
    // Opening a scad project leaves assembly mode (if we were in it).
    if (document.body.classList.contains('mode-assembly')) {
      document.body.classList.remove('mode-assembly');
      const partsTab = document.querySelector('.tab[data-tab="parts-view"]');
      if (partsTab && partsTab.classList.contains('active')) {
        document.querySelector('.tab[data-tab="code-view"]').click();
      }
    }
    clearHistory();
    setCode(project.code);
    setParamValues(project.paramValues);
    requestRender('project');
  });
  // Opening an assembly switches the shell into assembly mode and reveals Parts.
  subscribe('assembly:active', () => {
    document.body.classList.add('mode-assembly');
    document.querySelector('.tab[data-tab="parts-view"]').click();
  });

  ensureInstalledLibsCached();
  await loadInitialProject();
}

boot();
