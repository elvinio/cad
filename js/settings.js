// Settings dialog: rendering quality/backend, Google Client ID, storage info.

export const COLOR_PRESETS = [
  { label: 'Yellow',  hex: '#f9d72c' },
  { label: 'Silver',  hex: '#c8c8d0' },
  { label: 'Blue',    hex: '#4090e8' },
  { label: 'Orange',  hex: '#e87040' },
  { label: 'Green',   hex: '#3ab060' },
  { label: 'Red',     hex: '#e04050' },
  { label: 'White',   hex: '#f0f0ef' },
];

import { getSettings, saveSettings, clearLibZips } from './storage.js';
import { emit } from './state.js';
import { signIn, signOut, isSignedIn } from './gdrive.js';
import { toast } from './ui.js';

export function initSettings() {
  const $ = id => document.getElementById(id);
  const settings = getSettings();

  $('set-backend').value = settings.backend;
  $('set-quality').value = settings.quality;
  $('set-fn').value = settings.custom.fn;
  $('set-fa').value = settings.custom.fa;
  $('set-fs').value = settings.custom.fs;
  $('set-final-export').checked = settings.finalQualityExport;
  $('set-client-id').value = settings.googleClientId;
  $('set-anthropic-key').value = settings.anthropicApiKey;
  $('set-folder-id').value = settings.driveFolderId || '';
  $('custom-quality').hidden = settings.quality !== 'custom';

  const save = (patch) => {
    saveSettings(patch);
    emit('settings:changed', { settings: getSettings() });
  };

  $('set-backend').addEventListener('change', e => save({ backend: e.target.value }));
  $('set-quality').addEventListener('change', e => {
    $('custom-quality').hidden = e.target.value !== 'custom';
    save({ quality: e.target.value });
  });
  for (const key of ['fn', 'fa', 'fs']) {
    $(`set-${key}`).addEventListener('change', () => {
      save({ custom: {
        fn: Number($('set-fn').value),
        fa: Number($('set-fa').value),
        fs: Number($('set-fs').value),
      } });
    });
  }
  $('set-final-export').addEventListener('change', e =>
    save({ finalQualityExport: e.target.checked }));
  $('set-client-id').addEventListener('change', e =>
    save({ googleClientId: e.target.value.trim() }));
  $('set-anthropic-key').addEventListener('change', e =>
    saveSettings({ anthropicApiKey: e.target.value.trim() }));
  $('set-folder-id').addEventListener('change', e =>
    save({ driveFolderId: e.target.value.trim() || null }));

  // ----- Google sign-in -----
  const updateAuthUi = () => {
    const signedIn = isSignedIn();
    $('gdrive-signin').hidden = signedIn;
    $('gdrive-signout').hidden = !signedIn;
    $('gdrive-status').textContent = signedIn ? 'Signed in' : '';
  };
  $('gdrive-signin').addEventListener('click', async () => {
    try {
      await signIn();
      toast('Signed in to Google Drive');
    } catch (e) {
      toast(e.message, 'error');
    }
    updateAuthUi();
  });
  $('gdrive-signout').addEventListener('click', () => {
    signOut();
    updateAuthUi();
  });
  updateAuthUi();

  // ----- Storage -----
  const refreshUsage = async () => {
    if (!navigator.storage || !navigator.storage.estimate) return;
    const { usage, quota } = await navigator.storage.estimate();
    $('storage-usage').textContent =
      `Using ${(usage / 1048576).toFixed(1)} MB of ${(quota / 1048576).toFixed(0)} MB`;
  };
  refreshUsage();
  document.getElementById('settings-dialog').addEventListener('close', refreshUsage);

  $('clear-caches').addEventListener('click', async () => {
    if (!confirm('Clear cached wasm/app files and downloaded libraries? Projects are kept.')) return;
    await clearLibZips();
    if (window.caches) {
      for (const key of await caches.keys()) await caches.delete(key);
    }
    toast('Caches cleared — reload to re-download');
    refreshUsage();
  });

  // ----- Color swatches (in menu dialog) -----
  const swatchContainer = document.getElementById('color-swatches');
  COLOR_PRESETS.forEach(({ label, hex }) => {
    const btn = document.createElement('button');
    btn.className = 'color-swatch';
    btn.style.background = hex;
    btn.title = label;
    if (hex === settings.modelColor) btn.classList.add('active');
    btn.addEventListener('click', () => {
      save({ modelColor: hex });
      swatchContainer.querySelectorAll('.color-swatch')
        .forEach(s => s.classList.toggle('active', s === btn));
    });
    swatchContainer.appendChild(btn);
  });
}
