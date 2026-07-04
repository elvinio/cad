// Plain-textarea code editor with tab handling, auto-indent and autosave.

import { emit } from './state.js';

let textarea;
let gutter;
let errorLines = new Set();
let gutterLineCount = -1;
let onChange = () => {};
let onUndoRedoStateChange = () => {};

// --- Undo/redo history ---
let undoStack = [];
let undoIndex = -1;
let pushDebounceTimer = null;

function pushHistory(code) {
  undoStack = undoStack.slice(0, undoIndex + 1);
  if (undoStack.length && undoStack[undoStack.length - 1] === code) return;
  undoStack.push(code);
  if (undoStack.length > 200) undoStack.shift();
  undoIndex = undoStack.length - 1;
  onUndoRedoStateChange();
}

function applyHistory(code) {
  if (!textarea) return;
  textarea.value = code;
  buildGutter();
  onChange(code);
  emit('code:changed', { code, immediate: true });
  onUndoRedoStateChange();
}

// --- Line-number gutter ---

// Rebuild the gutter rows to match the textarea's line count. Each row is a
// div whose line metrics match #editor exactly (shared CSS) so numbers align.
// Every row is clickable → toggles a leading "#" on its line. Error rows also
// get an .err class for the red highlight.
function buildGutter(force = false) {
  if (!gutter || !textarea) return;
  const count = textarea.value.split('\n').length;
  if (!force && count === gutterLineCount) return;
  gutterLineCount = count;
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= count; n++) {
    const row = document.createElement('div');
    row.className = 'gutter-row';
    row.textContent = n;
    row.title = errorLines.has(n)
      ? `Error on line ${n} — click to toggle "#"`
      : `Click to toggle "#" on line ${n}`;
    if (errorLines.has(n)) row.classList.add('err');
    row.addEventListener('click', () => toggleCommentLine(n));
    frag.appendChild(row);
  }
  gutter.textContent = '';
  gutter.appendChild(frag);
}

// Prepend "#" to the given line, or remove it if already present, then
// re-render like any other edit (debounced history push + code:changed).
function toggleCommentLine(lineNo) {
  if (!textarea) return;
  const lines = textarea.value.split('\n');
  const idx = lineNo - 1;
  if (idx < 0 || idx >= lines.length) return;
  lines[idx] = lines[idx].startsWith('#') ? lines[idx].slice(1) : '#' + lines[idx];
  textarea.value = lines.join('\n');
  buildGutter(true);
  onChange(textarea.value);
  emit('code:changed', { code: textarea.value });
  clearTimeout(pushDebounceTimer);
  pushDebounceTimer = setTimeout(() => pushHistory(textarea.value), 1000);
}

export function setErrorLines(lineNos) {
  errorLines = new Set(lineNos.filter(n => Number.isFinite(n)));
  buildGutter(true);
}

export function clearErrorLines() {
  if (!errorLines.size) return;
  errorLines = new Set();
  buildGutter(true);
}

export function canUndo() { return undoIndex > 0; }
export function canRedo() { return undoIndex < undoStack.length - 1; }

export function undo() {
  clearTimeout(pushDebounceTimer);
  if (!canUndo()) return;
  undoIndex--;
  applyHistory(undoStack[undoIndex]);
}

export function redo() {
  clearTimeout(pushDebounceTimer);
  if (!canRedo()) return;
  undoIndex++;
  applyHistory(undoStack[undoIndex]);
}

export function clearHistory() {
  clearTimeout(pushDebounceTimer);
  undoStack = [];
  undoIndex = -1;
  onUndoRedoStateChange();
}

// --- Init ---

export function initEditor(el, opts = {}) {
  textarea = el;
  gutter = document.getElementById('editor-gutter');
  onChange = opts.onChange || onChange;
  onUndoRedoStateChange = opts.onUndoRedoStateChange || onUndoRedoStateChange;

  textarea.addEventListener('input', () => {
    buildGutter();
    onChange(textarea.value);
    emit('code:changed', { code: textarea.value });
    clearTimeout(pushDebounceTimer);
    pushDebounceTimer = setTimeout(() => pushHistory(textarea.value), 1000);
  });

  // Keep the gutter scrolled in lockstep with the textarea.
  textarea.addEventListener('scroll', () => {
    if (gutter) gutter.scrollTop = textarea.scrollTop;
  });
  buildGutter(true);

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      textarea.setRangeText('  ', textarea.selectionStart, textarea.selectionEnd, 'end');
      textarea.dispatchEvent(new Event('input'));
    } else if (e.key === 'Enter') {
      const upToCursor = textarea.value.slice(0, textarea.selectionStart);
      const lastLine = upToCursor.slice(upToCursor.lastIndexOf('\n') + 1);
      const indent = (lastLine.match(/^\s*/) || [''])[0]
        + (/[{([]\s*$/.test(lastLine) ? '  ' : '');
      if (indent) {
        e.preventDefault();
        textarea.setRangeText('\n' + indent, textarea.selectionStart, textarea.selectionEnd, 'end');
        textarea.dispatchEvent(new Event('input'));
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      onChange(textarea.value);
      emit('code:changed', { code: textarea.value, immediate: true });
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      redo();
    }
  });

  pushHistory(textarea.value || '');
}

// Insert a snippet at the caret (or over the selection) without losing focus —
// used by the on-screen key bar to supplement the soft keyboard on mobile.
export function insertText(text) {
  if (!textarea) return;
  textarea.focus();
  textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
  textarea.dispatchEvent(new Event('input'));
}

export function getCode() {
  return textarea ? textarea.value : '';
}

export function setCode(code) {
  if (textarea) {
    textarea.value = code;
    buildGutter();
    pushHistory(code);
  }
}

export function jumpToLine(lineNo) {
  if (!textarea) return;
  const lines = textarea.value.split('\n');
  let pos = 0;
  for (let i = 0; i < Math.min(lineNo - 1, lines.length); i++) pos += lines[i].length + 1;
  const end = pos + (lines[lineNo - 1] || '').length;
  textarea.focus();
  textarea.setSelectionRange(pos, end);
}
