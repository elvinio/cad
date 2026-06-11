// STL export: render at export quality, then save to device or Google Drive.

import { renderExport } from './render-manager.js';
import { uploadSTL } from './gdrive.js';
import { getActiveProject } from './projects.js';
import { toast } from './ui.js';

export function initExport(els) {
  els.exportBtn.addEventListener('click', () => els.dialog.showModal());

  els.deviceBtn.addEventListener('click', async () => {
    els.dialog.close();
    try {
      const blob = await renderSTL();
      await saveToDevice(blob, `${getActiveProject().name}.stl`);
    } catch (e) {
      if (e.name !== 'AbortError') toast(`Export failed: ${e.message}`, 'error');
    }
  });

  els.driveBtn.addEventListener('click', async () => {
    els.dialog.close();
    try {
      const blob = await renderSTL();
      toast('Uploading to Drive…');
      await uploadSTL(`${getActiveProject().name}.stl`, blob);
      toast('Uploaded to Google Drive');
    } catch (e) {
      toast(`Upload failed: ${e.message}`, 'error');
    }
  });
}

async function renderSTL() {
  toast('Rendering STL…');
  const buffer = await renderExport();
  return new Blob([buffer], { type: 'model/stl' });
}

async function saveToDevice(blob, filename) {
  if (window.showSaveFilePicker) {
    const handle = await showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: 'STL model', accept: { 'model/stl': ['.stl'] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    toast(`Saved ${filename}`);
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`Downloading ${filename}`);
  }
}
