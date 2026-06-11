// Plain-textarea code editor with tab handling, auto-indent and autosave.

import { emit } from './state.js';

let textarea;
let onChange = () => {};

export function initEditor(el, opts = {}) {
  textarea = el;
  onChange = opts.onChange || onChange;

  textarea.addEventListener('input', () => {
    onChange(textarea.value);
    emit('code:changed', { code: textarea.value });
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
    }
  });
}

export function getCode() {
  return textarea ? textarea.value : '';
}

export function setCode(code) {
  if (textarea) textarea.value = code;
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
