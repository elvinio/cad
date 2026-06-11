// Builds a form from the ParameterSet JSON produced by --export-format=param
// and tracks user overrides (values differing from the parameter's initial).

import { subscribe, emit } from './state.js';

let container;
let schema = [];          // last extracted parameter list
let values = {};          // current overrides {name: value}
let onValuesChanged = () => {};

export function initCustomizer(el, opts = {}) {
  container = el;
  onValuesChanged = opts.onValuesChanged || onValuesChanged;
  subscribe('params:extracted', (parameterSet) => {
    schema = normalize(parameterSet);
    reconcile();
    renderForm();
  });
}

export function getParamValues() {
  return { ...values };
}

export function setParamValues(v) {
  values = { ...(v || {}) };
  renderForm();
}

function normalize(parameterSet) {
  const params = parameterSet && parameterSet.parameters;
  return Array.isArray(params) ? params.filter(p => p.group !== 'Hidden') : [];
}

// Drop overrides whose parameter no longer exists (or changed type).
function reconcile() {
  const byName = new Map(schema.map(p => [p.name, p]));
  for (const name of Object.keys(values)) {
    if (!byName.has(name)) delete values[name];
  }
}

function setValue(name, value, initial) {
  const same = JSON.stringify(value) === JSON.stringify(initial);
  if (same) delete values[name];
  else values[name] = value;
  onValuesChanged(getParamValues());
  emit('params:changed', {});
}

function renderForm() {
  if (!container) return;
  container.textContent = '';
  if (!schema.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No customizable parameters found. Declare variables at the top of your code (with optional // [min:max] annotations) to see them here.';
    container.appendChild(p);
    return;
  }

  const groups = new Map();
  for (const param of schema) {
    const g = param.group || 'Parameters';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(param);
  }

  for (const [groupName, params] of groups) {
    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = groupName;
    details.appendChild(summary);
    for (const param of params) details.appendChild(buildControl(param));
    container.appendChild(details);
  }

  const reset = document.createElement('button');
  reset.textContent = 'Reset to defaults';
  reset.className = 'close-btn';
  reset.addEventListener('click', () => {
    values = {};
    onValuesChanged({});
    emit('params:changed', {});
    renderForm();
  });
  container.appendChild(reset);
}

function currentValue(param) {
  return param.name in values ? values[param.name] : param.initial;
}

function buildControl(param) {
  const wrap = document.createElement('div');
  wrap.className = 'param';

  const label = document.createElement('label');
  label.textContent = param.caption || param.name;
  wrap.appendChild(label);

  const type = param.type;
  const val = currentValue(param);

  if (Array.isArray(param.options) && param.options.length) {
    const select = document.createElement('select');
    for (const opt of param.options) {
      const o = document.createElement('option');
      o.value = String(opt.value);
      o.textContent = opt.name !== undefined ? String(opt.name) : String(opt.value);
      select.appendChild(o);
    }
    select.value = String(val);
    select.addEventListener('change', () => {
      const v = type === 'number' ? Number(select.value) : select.value;
      setValue(param.name, v, param.initial);
    });
    wrap.appendChild(select);
  } else if (type === 'boolean') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!val;
    input.addEventListener('change', () => setValue(param.name, input.checked, param.initial));
    label.prepend(input);
  } else if (type === 'number' && param.min !== undefined && param.max !== undefined) {
    const row = document.createElement('div');
    row.className = 'param-row';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = param.min;
    range.max = param.max;
    range.step = param.step !== undefined ? param.step : 'any';
    range.value = val;
    const num = document.createElement('input');
    num.type = 'number';
    num.min = param.min;
    num.max = param.max;
    if (param.step !== undefined) num.step = param.step;
    num.value = val;
    range.addEventListener('input', () => { num.value = range.value; });
    range.addEventListener('change', () => setValue(param.name, Number(range.value), param.initial));
    num.addEventListener('change', () => {
      range.value = num.value;
      setValue(param.name, Number(num.value), param.initial);
    });
    row.appendChild(range);
    row.appendChild(num);
    wrap.appendChild(row);
  } else if (type === 'number') {
    const input = document.createElement('input');
    input.type = 'number';
    if (param.step !== undefined) input.step = param.step;
    input.value = val;
    input.addEventListener('change', () => setValue(param.name, Number(input.value), param.initial));
    wrap.appendChild(input);
  } else {
    const input = document.createElement('input');
    input.type = 'text';
    if (param.maxLength) input.maxLength = param.maxLength;
    input.value = Array.isArray(val) ? `[${val.join(',')}]` : String(val);
    input.addEventListener('change', () => {
      let v = input.value;
      if (Array.isArray(param.initial)) {
        try { v = JSON.parse(v); } catch { return; }
      }
      setValue(param.name, v, param.initial);
    });
    wrap.appendChild(input);
  }

  return wrap;
}
