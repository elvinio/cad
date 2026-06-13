// Tabs, dialogs, toasts, console log panel, render status indicator.

import { subscribe } from './state.js';
import { jumpToLine, setErrorLines, clearErrorLines } from './editor.js';

export function toast(message, kind = 'info', ms = 3500) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function initUI() {
  // ----- Tabs -----
  const tabs = document.querySelectorAll('#panel-tabs .tab');
  tabs.forEach(tab => tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-view').forEach(view =>
      view.classList.toggle('active', view.id === tab.dataset.tab));
    if (tab.dataset.tab === 'console-view') {
      document.getElementById('error-badge').hidden = true;
    }
  }));

  // ----- Dialog openers -----
  const open = (btnId, dialogId, onOpen) => {
    document.getElementById(btnId).addEventListener('click', () => {
      document.getElementById('menu-dialog').close();
      if (onOpen) onOpen();
      document.getElementById(dialogId).showModal();
    });
  };
  document.getElementById('menu-btn').addEventListener('click', () =>
    document.getElementById('menu-dialog').showModal());
  open('menu-settings', 'settings-dialog');

  // SW version display
  const swVersionEl = document.getElementById('sw-version');
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'version') swVersionEl.textContent = e.data.version;
    });
    navigator.serviceWorker.controller.postMessage({ type: 'getVersion' });
  }

  // Refresh cache
  document.getElementById('menu-refresh-cache').addEventListener('click', async () => {
    document.getElementById('menu-dialog').close();
    toast('Clearing cache…', 'info', 2000);
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    } catch (_) { /* ignore */ }
    location.reload();
  });

  // Close dialogs when tapping the backdrop
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  });

  // ----- Viewer maximize -----
  const viewerPanel = document.getElementById('viewer-panel');
  const maximizeBtn = document.getElementById('maximize-btn');
  const setMaximized = (on) => {
    viewerPanel.classList.toggle('maximized', on);
    maximizeBtn.innerHTML = on ? '&#x2715;' : '&#x26F6;';
    maximizeBtn.title = on ? 'Restore viewer' : 'Maximize viewer';
  };
  maximizeBtn.addEventListener('click', () => setMaximized(!viewerPanel.classList.contains('maximized')));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && viewerPanel.classList.contains('maximized')) setMaximized(false);
  });

  // ----- Console log + status -----
  const log = document.getElementById('log');
  const status = document.getElementById('render-status');
  const badge = document.getElementById('error-badge');
  const overlay = document.getElementById('viewer-overlay');
  const MAX_LOG_LINES = 500;

  const appendLog = (line, isErr) => {
    const span = document.createElement('span');
    if (isErr) {
      const m = line.match(/line (\d+)/);
      if (m) {
        span.className = 'err-link';
        span.addEventListener('click', () => {
          document.querySelector('[data-tab="code-view"]').click();
          jumpToLine(parseInt(m[1], 10));
        });
      } else {
        span.className = 'err';
      }
    }
    span.textContent = line + '\n';
    log.appendChild(span);
    while (log.childNodes.length > MAX_LOG_LINES) log.removeChild(log.firstChild);
    log.parentElement.scrollTop = log.parentElement.scrollHeight;
  };

  // Error line numbers collected from the current render's log, surfaced as
  // gutter markers in the editor.
  let errorLineNos = [];

  subscribe('render:start', () => {
    status.className = 'status-busy';
    log.textContent = '';
    errorLineNos = [];
    clearErrorLines();
  });
  subscribe('render:log', ({ stream, line }) => {
    const isErr = stream === 'err' && /^ERROR|^WARNING/i.test(line);
    appendLog(line, isErr);
    if (stream === 'err' && /^ERROR/i.test(line)) {
      badge.hidden = false;
      const m = line.match(/line (\d+)/);
      if (m) {
        errorLineNos.push(parseInt(m[1], 10));
        setErrorLines(errorLineNos);
      }
    }
  });
  // Overlay text is composed from two sources: the render time (render:done)
  // and the model dimensions (viewer:stats, emitted after the mesh is set).
  let overlayTime = '';
  let overlayDims = '';
  const renderOverlay = () => {
    overlay.textContent = [overlayTime, overlayDims].filter(Boolean).join(' · ');
  };
  subscribe('render:done', ({ elapsedMs }) => {
    status.className = 'status-ok';
    badge.hidden = true;
    if (elapsedMs !== undefined) {
      overlayTime = `rendered in ${(elapsedMs / 1000).toFixed(1)}s`;
      renderOverlay();
    }
  });
  subscribe('viewer:stats', ({ size }) => {
    overlayDims = size
      ? `${size.map(n => +n.toFixed(2)).join(' × ')} mm`
      : '';
    renderOverlay();
  });
  subscribe('render:error', ({ message }) => {
    status.className = 'status-error';
    badge.hidden = false;
    appendLog(message, true);
  });
}
