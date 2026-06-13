// App bootstrap.

import { subscribe } from './state.js';
import { initUI, toast } from './ui.js';
import { initViewer, fitView } from './viewer.js';
import { initEditor, getCode, setCode } from './editor.js';
import { initCustomizer, getParamValues, setParamValues } from './customizer.js';
import { initProjects, loadInitialProject, renderList as renderProjects,
         updateActiveCode, updateActiveParams } from './projects.js';
import { initLibraries, renderList as renderLibraries, ensureInstalledLibsCached } from './libraries.js';
import { initRenderManager, requestRender } from './render-manager.js';
import { initExport } from './export.js';
import { initSettings } from './settings.js';
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
  initEditor($('editor'), { onChange: updateActiveCode });
  initCustomizer($('customizer-form'), { onValuesChanged: updateActiveParams });
  initProjects({
    dialog: $('projects-dialog'),
    list: $('projects-list'),
    newBtn: $('new-project-btn'),
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
    $('projects-dialog').showModal();
  });
  $('menu-projects').addEventListener('click', () => {
    $('menu-dialog').close();
    renderProjects();
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
  $('reset-view-btn').addEventListener('click', fitView);

  // Wiring: edits and settings changes trigger renders
  subscribe('code:changed', ({ immediate }) => requestRender(immediate ? 'project' : 'code'));
  subscribe('params:changed', () => requestRender('params'));
  subscribe('settings:changed', () => requestRender('settings'));
  subscribe('libs:changed', () => requestRender('settings'));
  subscribe('project:changed', ({ project }) => {
    setCode(project.code);
    setParamValues(project.paramValues);
    requestRender('project');
  });

  ensureInstalledLibsCached();
  await loadInitialProject();
}

boot();
