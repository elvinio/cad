// Orchestrates the OpenSCAD worker: debouncing, one-in-flight queue,
// cancellation by worker termination, and the param/geometry two-phase pipeline.

import { emit } from './state.js';
import { getSettings } from './storage.js';

const WORKER_URL = new URL('./worker/openscad-worker.js', import.meta.url);

const DEBOUNCE_MS = { code: 800, params: 300, settings: 100, project: 0 };
const QUALITY_DEFINES = {
  draft: { $fn: 16 },
  preview: { $fn: 32 },
  final: {},
};

let worker = null;
let jobSeq = 0;
let currentJob = null;   // {jobId, resolve, reject}
let debounceTimer = null;
let pendingNeedsParams = false;
let getCode = () => '';
let getParamValues = () => ({});

export function initRenderManager(opts) {
  getCode = opts.getCode;
  getParamValues = opts.getParamValues;
  spawn();
}

function spawn() {
  worker = new Worker(WORKER_URL, { type: 'module' });
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'log') {
      emit('render:log', msg);
      return;
    }
    if (!currentJob || msg.jobId !== currentJob.jobId) return;
    const job = currentJob;
    currentJob = null;
    if (msg.type === 'done') job.resolve(msg);
    else job.reject(new Error(msg.message));
  };
  worker.onerror = (e) => {
    if (currentJob) {
      const job = currentJob;
      currentJob = null;
      job.reject(new Error(e.message || 'worker error'));
    }
  };
}

function cancelInFlight() {
  if (!currentJob) return;
  const job = currentJob;
  currentJob = null;
  worker.terminate();
  spawn();
  job.reject(new Error('cancelled'));
}

function runJob(payload) {
  cancelInFlight();
  return new Promise((resolve, reject) => {
    const jobId = ++jobSeq;
    currentJob = { jobId, resolve, reject };
    worker.postMessage({ type: 'render', jobId, ...payload });
  });
}

// The experimental Manifold backend occasionally hits geometry-specific
// assertions (e.g. CGAL errors in applyHull); retry once with CGAL.
async function runGeometryJob(payload) {
  try {
    return await runJob(payload);
  } catch (e) {
    if (e.message === 'cancelled' || payload.backend !== 'manifold') throw e;
    emit('render:log', {
      stream: 'err',
      line: 'WARNING: Manifold backend failed, retrying with CGAL (slower)…',
    });
    return runJob({ ...payload, backend: 'cgal' });
  }
}

function qualityDefines(settings) {
  if (settings.quality === 'custom') {
    const d = {};
    const { fn, fa, fs } = settings.custom;
    if (fn > 0) d.$fn = fn;
    if (fa > 0) d.$fa = fa;
    if (fs > 0) d.$fs = fs;
    return d;
  }
  return QUALITY_DEFINES[settings.quality] || QUALITY_DEFINES.preview;
}

function paramDefines() {
  const d = {};
  for (const [name, v] of Object.entries(getParamValues() || {})) {
    if (typeof v === 'string') d[name] = JSON.stringify(v);
    else if (Array.isArray(v)) d[name] = `[${v.join(',')}]`;
    else d[name] = String(v);
  }
  return d;
}

// reason: 'code' | 'params' | 'settings' | 'project'
export function requestRender(reason = 'code') {
  if (reason !== 'params') pendingNeedsParams = true;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => doRender(), DEBOUNCE_MS[reason] ?? 300);
}

async function doRender() {
  const source = getCode();
  if (!source.trim()) return;
  const settings = getSettings();
  const needsParams = pendingNeedsParams;
  pendingNeedsParams = false;
  emit('render:start', {});

  try {
    if (needsParams) {
      const res = await runJob({
        source, format: 'param', defines: {},
        backend: settings.backend, libNames: settings.installedLibs,
      });
      try {
        const parameterSet = JSON.parse(new TextDecoder().decode(res.output));
        emit('params:extracted', parameterSet);
      } catch {
        // unparseable param dump: ignore, geometry pass will surface errors
      }
    }

    const res = await runGeometryJob({
      source, format: 'off',
      defines: { ...qualityDefines(settings), ...paramDefines() },
      backend: settings.backend, libNames: settings.installedLibs,
    });
    emit('render:done', {
      offText: new TextDecoder().decode(res.output),
      elapsedMs: res.elapsedMs,
    });
  } catch (e) {
    if (e.message === 'cancelled') return;
    if (needsParams) pendingNeedsParams = true; // retry param pass next time
    emit('render:error', { message: e.message });
  }
}

// Full-quality render for STL export. Returns ArrayBuffer of binary STL.
export async function renderExport() {
  const settings = getSettings();
  const defines = settings.finalQualityExport
    ? paramDefines()
    : { ...qualityDefines(settings), ...paramDefines() };
  emit('render:start', {});
  try {
    const res = await runGeometryJob({
      source: getCode(), format: 'binstl', defines,
      backend: settings.backend, libNames: settings.installedLibs,
    });
    emit('render:done', { elapsedMs: res.elapsedMs });
    return res.output;
  } catch (e) {
    emit('render:error', { message: e.message });
    throw e;
  }
}
