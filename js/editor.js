// Plain-textarea code editor with tab handling, auto-indent and autosave.

import { emit } from './state.js';

let textarea;
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
  onChange(code);
  emit('code:changed', { code, immediate: true });
  onUndoRedoStateChange();
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
  onChange = opts.onChange || onChange;
  onUndoRedoStateChange = opts.onUndoRedoStateChange || onUndoRedoStateChange;

  textarea.addEventListener('input', () => {
    onChange(textarea.value);
    emit('code:changed', { code: textarea.value });
    clearTimeout(pushDebounceTimer);
    pushDebounceTimer = setTimeout(() => pushHistory(textarea.value), 1000);
  });

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

export function getCode() {
  return textarea ? textarea.value : '';
}

export function setCode(code) {
  if (textarea) {
    textarea.value = code;
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
