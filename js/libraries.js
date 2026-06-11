// Library management: curated zips vendored with the app + custom zip URLs.
// Zip bytes live in IndexedDB; the render worker reads them from there.

import { getSettings, saveSettings, putLibZip, getLibZip, deleteLibZip } from './storage.js';
import { emit } from './state.js';
import { toast } from './ui.js';

// Vendored same-origin zips (no CORS issues, work offline once cached).
export const CURATED = [
  { name: 'BOSL2',      url: 'vendor/libraries/BOSL2.zip',      desc: 'The Belfry OpenSCAD Library v2' },
  { name: 'BOSL',       url: 'vendor/libraries/BOSL.zip',       desc: 'The Belfry OpenSCAD Library v1' },
  { name: 'MCAD',       url: 'vendor/libraries/MCAD.zip',       desc: 'Parts: gears, motors, nuts…' },
  { name: 'NopSCADlib', url: 'vendor/libraries/NopSCADlib.zip', desc: 'Printers, enclosures, hardware' },
  { name: 'funcutils',  url: 'vendor/libraries/funcutils.zip',  desc: 'Functional programming helpers' },
  { name: 'fonts',      url: 'vendor/libraries/fonts.zip',      desc: 'Noto/Liberation fonts for text()' },
];

let dialog, list;

export function initLibraries(els) {
  dialog = els.dialog;
  list = els.list;
  els.customAdd.addEventListener('click', async () => {
    const name = els.customName.value.trim();
    const url = els.customUrl.value.trim();
    if (!name || !url) { toast('Enter both a name and a zip URL', 'error'); return; }
    if (!/^[\w.-]+$/.test(name)) { toast('Name must be a simple folder name', 'error'); return; }
    try {
      await installLib(name, url);
      els.customName.value = '';
      els.customUrl.value = '';
      renderList();
    } catch (e) {
      toast(`Download failed: ${e.message}`, 'error');
    }
  });
}

async function installLib(name, url) {
  toast(`Downloading ${name}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  await putLibZip(name, url, bytes);
  const settings = getSettings();
  if (!settings.installedLibs.includes(name)) {
    saveSettings({ installedLibs: [...settings.installedLibs, name] });
  }
  emit('libs:changed', {});
  toast(`${name} installed`);
}

async function removeLib(name) {
  await deleteLibZip(name);
  const settings = getSettings();
  saveSettings({ installedLibs: settings.installedLibs.filter(n => n !== name) });
  emit('libs:changed', {});
}

export async function renderList() {
  list.textContent = '';
  const settings = getSettings();
  const curatedNames = new Set(CURATED.map(c => c.name));
  const entries = [
    ...CURATED,
    ...settings.installedLibs.filter(n => !curatedNames.has(n)).map(n => ({ name: n, custom: true })),
  ];

  for (const entry of entries) {
    const li = document.createElement('li');
    const installed = settings.installedLibs.includes(entry.name);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = installed;
    checkbox.addEventListener('change', async () => {
      checkbox.disabled = true;
      try {
        if (checkbox.checked) {
          // custom libs that are unchecked get fully removed, so this path
          // only re-installs curated entries
          await installLib(entry.name, entry.url);
        } else {
          await removeLib(entry.name);
        }
      } catch (e) {
        checkbox.checked = !checkbox.checked;
        toast(`Failed: ${e.message}`, 'error');
      }
      checkbox.disabled = false;
      renderList();
    });
    li.appendChild(checkbox);

    const label = document.createElement('span');
    label.className = 'lib-name';
    label.textContent = entry.name;
    li.appendChild(label);

    const desc = document.createElement('span');
    desc.className = 'lib-size';
    desc.textContent = entry.desc || (entry.custom ? 'custom' : '');
    li.appendChild(desc);

    list.appendChild(li);
  }
}

// Re-download any installed lib whose zip is missing from IndexedDB
// (e.g. after "Clear caches").
export async function ensureInstalledLibsCached() {
  const settings = getSettings();
  for (const name of settings.installedLibs) {
    if (await getLibZip(name)) continue;
    const curated = CURATED.find(c => c.name === name);
    if (curated) {
      try { await installLib(name, curated.url); } catch { /* offline; retried next run */ }
    }
  }
}
