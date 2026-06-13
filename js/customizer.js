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

// The full parameter list (name/type/initial/min/max/options/…) last extracted
// from the code. Used by AI chat's get_params tool to report what's adjustable.
export function getParamSchema() {
  return schema.map(p => ({ ...p }));
}

export function setParamValues(v) {
  values = { ...(v || {}) };
  renderForm();
}

// Merge a partial {name: value} map of overrides from an external caller (AI
// chat's set_params tool). Validates names against the schema, drops values
// equal to their initial, then persists + re-renders exactly like a manual
// edit (onValuesChanged + params:changed). Returns the names it didn't know.
export function applyParamOverrides(partial) {
  const byName = new Map(schema.map(p => [p.name, p]));
  const unknown = [];
  for (const [name, value] of Object.entries(partial || {})) {
    const p = byName.get(name);
    if (!p) { unknown.push(name); continue; }
    if (JSON.stringify(value) === JSON.stringify(p.initial)) delete values[name];
    else values[name] = value;
  }
  onValuesChanged(getParamValues());
  emit('params:changed', {});
  renderForm();
  return { unknown };
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

// Step a number input by ±step, clamp to min/max, commit the new value.
function adjustNumber(num, param, dir) {
  const step = param.step !== undefined && param.step !== '' ? Number(param.step) : 1;
  let v = Number(num.value);
  if (!Number.isFinite(v)) v = Number(param.initial) || 0;
  v += dir * step;
  if (param.min !== undefined) v = Math.max(Number(param.min), v);
  if (param.max !== undefined) v = Math.min(Number(param.max), v);
  // Avoid binary-float dust by rounding to the step's decimal precision.
  const dp = (String(step).split('.')[1] || '').length;
  v = Number(v.toFixed(dp));
  num.value = v;
  setValue(param.name, v, param.initial);
}

function buildStepper(num, param) {
  const div = document.createElement('div');
  div.className = 'param-stepper';
  for (const [sign, dir] of [['−', -1], ['+', 1]]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'step-btn';
    btn.textContent = sign;
    btn.title = (dir < 0 ? 'Decrease ' : 'Increase ') + (param.caption || param.name);
    btn.addEventListener('click', () => adjustNumber(num, param, dir));
    div.appendChild(btn);
  }
  return div;
}

// 3-column row: [variable name] [text field] [ − + stepper ].
function buildControl(param) {
  const wrap = document.createElement('div');
  wrap.className = 'param';

  const label = document.createElement('label');
  label.className = 'param-name';
  label.textContent = param.caption || param.name;
  label.title = param.name;
  wrap.appendChild(label);

  const type = param.type;
  const val = currentValue(param);

  if (Array.isArray(param.options) && param.options.length) {
    const select = document.createElement('select');
    select.className = 'param-field param-field--wide';
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
    input.className = 'param-field param-field--wide';
    input.checked = !!val;
    input.addEventListener('change', () => setValue(param.name, input.checked, param.initial));
    wrap.appendChild(input);
  } else if (type === 'number') {
    const num = document.createElement('input');
    num.type = 'number';
    num.className = 'param-field';
    if (param.min !== undefined) num.min = param.min;
    if (param.max !== undefined) num.max = param.max;
    if (param.step !== undefined) num.step = param.step;
    num.value = val;
    num.addEventListener('change', () => adjustNumber(num, param, 0));
    wrap.appendChild(num);
    wrap.appendChild(buildStepper(num, param));
  } else {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'param-field param-field--wide';
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
