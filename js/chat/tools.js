// Tool schemas (Anthropic input_schema shape) and handlers the chat model can
// call: read/edit/write the editor code, get/set Customizer params, render
// snapshots (look/look_at), and search the BOSL2 index (lookup_lib).
// runTool() is the dispatcher the send() orchestrator calls per tool_use.

import { subscribe, emit } from '../state.js';
import { getSettings } from '../storage.js';
import { getCode, setCode } from '../editor.js';
import { updateActiveCode } from '../projects.js';
import { getParamValues, getParamSchema, applyParamOverrides } from '../customizer.js';
import { getMeshStats } from '../viewer.js';
import { captureMultiView, captureLookAt } from '../viewer/capture.js';
import { getLastCode, setLastCode } from './session-state.js';
// addImageButton/setStatus/addNote still live in chat.js (chat/ui.js doesn't
// exist yet). Tool handlers call straight into UI rendering as a side effect
// of computing their result — an intentional exception to strict layering
// (see docs/review-three-angles.md §1.5): simplicity over a bus round-trip
// for a synchronous same-call-stack UI update. Only referenced inside
// function bodies below, never at this module's own top level, so this
// circular import is safe regardless of module evaluation order.
import { addImageButton, setStatus, addNote } from '../chat.js';

// Always-on BOSL2 starter kit: the handful of modules that cover most requests,
// appended to the system prompt only when BOSL2 is installed so even a zero-
// tool-call reply composes them correctly. The long tail goes through lookup_lib.
export const CORE_BOSL2 =
`BOSL2 quick reference (include <BOSL2/std.scad>; anchors: TOP/BOTTOM/LEFT/RIGHT/FWD/BACK/CENTER, combine with +):
- cuboid(size, [rounding=], [chamfer=], [edges=], [anchor=], [spin=], [orient=]) — box with rounded/chamfered edges.
- cyl(h=, r=|d=, [rounding=], [chamfer=], [anchor=]) — cylinder with rounded ends; rounded_prism/prismoid for tapers.
- tube(h=, or=|od=, ir=|id=|wall=, [anchor=]) — hollow cylinder.
- sphere(r=|d=), spheroid(r=|d=, [circum=]) — spheres.
- prismoid(size1=, size2=, h=, [rounding=], [chamfer=]) — tapered box / pyramid frustum.
- attach(parent_anchor, child_anchor) CHILD; / position(anchor) CHILD; — place a child on a parent's face without manual translate/rotate.
- xcopies/ycopies/zcopies(spacing=|n=) CHILD; , grid_copies(spacing=, n=) CHILD; — repeat children in a line or grid.
- linear_sweep(region, h=), rotate_sweep(region, angle=) — extrude/revolve a 2D shape.
- screw(spec, length=, [head=]), nut(spec), threaded_rod(d=, l=, pitch=) — standard fasteners and threads.
- spur_gear(circ_pitch=|mod=, teeth=, thickness=), rack(...), bevel_gear(...) — gears.
Call lookup_lib for exact signatures of anything else.`;

// Tools the model can call. read_code/edit_code/write_code/get_params/set_params
// all operate on the live editor + customizer; look/look_at render and return an
// image. Handlers live in runTool(); most return text only (the model uses
// look/look_at to see images), keeping per-turn token cost down.
export const TOOLS = [
  {
    name: 'read_code',
    description:
      'Read the current OpenSCAD editor code. Returns the lines numbered (1-based). '
      + 'Omit the range to read the whole file, or pass start_line/end_line to read a slice. '
      + 'Always read before editing if the code may have changed since you last saw it.',
    input_schema: {
      type: 'object',
      properties: {
        start_line: { type: 'integer', description: 'First line to read (1-based, inclusive). Optional.' },
        end_line: { type: 'integer', description: 'Last line to read (1-based, inclusive). Optional.' },
      },
    },
  },
  {
    name: 'edit_code',
    description:
      'Replace the inclusive line range start_line..end_line with new_text, then render. '
      + 'Line numbers must match the most recent read_code; if the code changed since then the '
      + 'edit is rejected — call read_code again first. To insert without removing lines, set '
      + 'end_line = start_line - 1. Returns compile status and bounding box as text (call look to see it).',
    input_schema: {
      type: 'object',
      properties: {
        start_line: { type: 'integer', description: 'First line to replace (1-based, inclusive).' },
        end_line: { type: 'integer', description: 'Last line to replace (1-based, inclusive). Use start_line-1 to insert.' },
        new_text: { type: 'string', description: 'Replacement text for the range (may be multiple lines, no trailing newline needed).' },
      },
      required: ['start_line', 'end_line', 'new_text'],
    },
  },
  {
    name: 'write_code',
    description:
      'Replace the ENTIRE editor contents with `code`, then render. Use for new models or large '
      + 'rewrites; prefer edit_code for small changes. Returns compile status and bounding box as text.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The complete OpenSCAD source for the whole file.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'get_params',
    description:
      'List the Customizer parameters (top-level variables that drive the geometry) with their '
      + 'current value, default, and any min/max/options. Returns JSON.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_params',
    description:
      'Set one or more Customizer parameter values and re-render. Pass `params` as a map of '
      + '{parameter_name: value}. Changing parameters affects how the model looks. Returns compile '
      + 'status and bounding box as text (call look to see it). Use get_params first to learn valid names.',
    input_schema: {
      type: 'object',
      properties: {
        params: {
          type: 'object',
          description: 'Map of parameter name to new value, e.g. {"width": 40, "rounded": true}.',
          additionalProperties: true,
        },
      },
      required: ['params'],
    },
  },
  {
    name: 'look',
    description:
      'Render the current model and return a 2×2 image (ISO, FRONT, RIGHT, TOP views in OpenSCAD '
      + 'Z-up) plus the bounding-box dimensions. Call this whenever you want to see the result.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'look_at',
    description:
      'Render one free-angle, full-resolution image of the model for close-up inspection — use it '
      + 'to zoom into a specific feature or view an angle the fixed 2×2 look grid does not cover. '
      + 'yaw_deg/pitch_deg pick the camera direction (Z-up: yaw 0 = FRONT looking along -Y, increasing '
      + 'toward +X/RIGHT at 90; pitch 0 = horizontal, +90 = TOP, -90 = BOTTOM). zoom scales the default '
      + 'framing distance (0.15-5; below 1 moves the camera closer, above 1 farther). style switches the '
      + 'material for this shot only: "solid" (default), "wireframe" (see through to hidden edges), or '
      + '"ghost" (translucent, to see overlapping/internal solids). Returns the bounding-box dimensions as text.',
    input_schema: {
      type: 'object',
      properties: {
        yaw_deg: { type: 'number', description: 'Camera azimuth in degrees. 0=FRONT, 90=RIGHT, 180=BACK, 270/-90=LEFT. Default 45 (a corner view).' },
        pitch_deg: { type: 'number', description: 'Camera elevation in degrees, -89..89. 0=horizontal, 90=TOP, -90=BOTTOM. Default 30.' },
        zoom: { type: 'number', description: 'Framing distance multiplier, 0.15-5. Below 1 zooms in closer; above 1 pulls back. Default 1.' },
        style: { type: 'string', enum: ['solid', 'wireframe', 'ghost'], description: 'Material style for this shot only. Default "solid".' },
      },
    },
  },
  {
    name: 'lookup_lib',
    description:
      'Search the BOSL2 library for modules/functions matching a query and return their exact '
      + 'signatures — name, one-line synopsis, usage forms and argument names. Use this before '
      + 'calling a library module whose arguments you are not sure of, instead of guessing. '
      + 'Example queries: "rounded box", "attach to face", "spur gear", "screw thread", "hex nut".',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for, e.g. "rounded cuboid" or "metric screw".' },
      },
      required: ['query'],
    },
  },
];

// Lazily-fetched BOSL2 signature index (vendor/libraries/bosl2-index.json), used
// by the lookup_lib tool. Cached after first fetch; the SW back-fills it into the
// cache on first use so it works offline thereafter.
let bosl2IndexPromise = null;

// Lazily fetch + cache the BOSL2 signature index for lookup_lib.
function getBosl2Index() {
  if (!bosl2IndexPromise) {
    bosl2IndexPromise = fetch('vendor/libraries/bosl2-index.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .catch(e => { bosl2IndexPromise = null; throw e; });
  }
  return bosl2IndexPromise;
}

// Score entries against the query words (name hits weigh most, then synopsis,
// then arg names) and return the top matches formatted compactly for the model.
function searchBosl2Index(index, query) {
  const words = String(query).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1);
  if (!words.length) return [];
  const scored = [];
  for (const e of index.entries) {
    const name = e.name.toLowerCase();
    const syn = (e.synopsis || '').toLowerCase();
    const argNames = e.args.map(a => a.name.toLowerCase()).join(' ');
    let score = 0;
    for (const w of words) {
      if (name === w) score += 12;
      else if (name.includes(w)) score += 6;
      if (syn.includes(w)) score += 3;
      if (argNames.includes(w)) score += 1;
    }
    if (score) scored.push({ score, e });
  }
  scored.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
  return scored.slice(0, 8).map(s => s.e);
}

function formatBosl2Match(e) {
  const usage = e.usage.length ? e.usage.map(u => `    ${u}`).join('\n') : '    (see Arguments)';
  const args = e.args.length ? `\n  args: ${e.args.map(a => a.name).join(', ')}` : '';
  return `• ${e.name} — ${e.synopsis} [${e.file}]\n${usage}${args}`;
}

// ---------- code apply ----------

function applyCode(code) {
  setCode(code);
  updateActiveCode(code);
  setLastCode(code);
  emit('code:changed', { code, immediate: true });
}

// ---------- tool handlers ----------

// Resolve once the render settles (render:done / render:error) after running
// `trigger` (which mutates code or params). Subscribing before triggering avoids
// missing a fast render.
function awaitRender(trigger) {
  return new Promise((resolve) => {
    let settled = false;
    const logs = [];
    const offLog = subscribe('render:log', (m) => { const l = (m?.line ?? '').trim(); if (l) logs.push(l); });
    const finish = (res) => {
      if (settled) return;
      settled = true;
      offDone(); offErr(); offLog(); clearTimeout(timer);
      resolve({ ...res, logs });
    };
    const offDone = subscribe('render:done', (p) => finish({ ok: true, elapsedMs: p.elapsedMs }));
    const offErr = subscribe('render:error', (p) => finish({ ok: false, error: p.message }));
    const timer = setTimeout(() => finish({ ok: false, error: 'Render timed out after 90s.' }), 90000);
    trigger();
  });
}

// OpenSCAD prints "Could not initialize localization" on every run (harmless).
const LOG_NOISE = /Could not initialize localization/i;

// Pull the warnings/errors worth showing the model out of a render's log lines:
// deduped, capped, noise filtered. Surfaced on success too (e.g. deprecated
// calls or undefined-variable warnings that compiled anyway) so it can fix them.
function notableLogs(logs) {
  const seen = new Set();
  const out = [];
  for (const l of logs || []) {
    if (!/\b(WARNING|ERROR|DEPRECATED)\b/i.test(l) || LOG_NOISE.test(l) || seen.has(l)) continue;
    seen.add(l);
    out.push(l);
    if (out.length >= 8) break;
  }
  return out;
}

const applyAndAwaitRender = (code) => awaitRender(() => applyCode(code));

function dimsLine() {
  const stats = getMeshStats();
  return stats
    ? `${stats.size[0]} × ${stats.size[1]} × ${stats.size[2]} mm · ${stats.triangles} tris`
    : 'unknown size';
}

// Text tool_result after an apply/param change (no image — the model uses look).
function renderResultText(res) {
  const notes = notableLogs(res.logs);
  const msgBlock = notes.length ? `\nOpenSCAD messages:\n${notes.map(l => `  ${l}`).join('\n')}` : '';
  if (!res.ok) {
    addNote(`Render failed: ${res.error}`, true);
    return `Render failed: ${res.error}${msgBlock}\nFix the problem and try again.`;
  }
  return `Render OK. Bounding box ${dimsLine()}.${msgBlock}\nCall look to see the model.`;
}

function runReadCode(input) {
  const code = getCode();
  setLastCode(code); // the model now has an up-to-date view
  const lines = code.split('\n');
  let start = Number.isFinite(input?.start_line) ? Math.max(1, Math.floor(input.start_line)) : 1;
  let end = Number.isFinite(input?.end_line) ? Math.min(lines.length, Math.floor(input.end_line)) : lines.length;
  if (start > end) {
    return [{ type: 'text', text: `Invalid range: start_line ${start} > end_line ${end}. The file has ${lines.length} lines.` }];
  }
  const width = String(end).length;
  const numbered = lines.slice(start - 1, end)
    .map((l, i) => `${String(start + i).padStart(width)}\t${l}`).join('\n');
  return [{ type: 'text', text: `${lines.length} lines total.\n${numbered || '(empty)'}` }];
}

async function runEditCode(input) {
  const current = getCode();
  if (current !== getLastCode()) {
    return [{ type: 'text',
      text: 'The editor code changed since your last read_code, so these line numbers may be stale. '
        + 'Call read_code again, then redo the edit.' }];
  }
  const lines = current.split('\n');
  const start = Math.floor(input?.start_line);
  const end = Math.floor(input?.end_line);
  if (!Number.isInteger(start) || !Number.isInteger(end)
      || start < 1 || start > lines.length + 1 || end < start - 1 || end > lines.length) {
    return [{ type: 'text',
      text: `Invalid range start_line=${input?.start_line} end_line=${input?.end_line}. `
        + `The file has ${lines.length} lines (use end_line = start_line - 1 to insert).` }];
  }
  const newLines = String(input?.new_text ?? '').split('\n');
  const newCode = [...lines.slice(0, start - 1), ...newLines, ...lines.slice(end)].join('\n');
  setStatus('Rendering…');
  return [{ type: 'text', text: renderResultText(await applyAndAwaitRender(newCode)) }];
}

async function runWriteCode(input) {
  setStatus('Rendering…');
  return [{ type: 'text', text: renderResultText(await applyAndAwaitRender(String(input?.code ?? ''))) }];
}

function runGetParams() {
  const schema = getParamSchema();
  if (!schema.length) {
    return [{ type: 'text', text: 'This model has no Customizer parameters (no annotated top-level variables).' }];
  }
  const overrides = getParamValues();
  const list = schema.map(p => ({
    name: p.name,
    type: p.type,
    current: (p.name in overrides) ? overrides[p.name] : p.initial,
    default: p.initial,
    ...(p.min !== undefined ? { min: p.min } : {}),
    ...(p.max !== undefined ? { max: p.max } : {}),
    ...(Array.isArray(p.options) && p.options.length ? { options: p.options.map(o => o.value) } : {}),
    ...(p.group ? { group: p.group } : {}),
  }));
  return [{ type: 'text', text: JSON.stringify({ parameters: list }, null, 2) }];
}

async function runSetParams(input) {
  const params = input?.params;
  if (!params || typeof params !== 'object' || Array.isArray(params) || !Object.keys(params).length) {
    return [{ type: 'text', text: 'set_params needs a non-empty `params` object, e.g. {"width": 40}.' }];
  }
  if (!getParamSchema().length) {
    return [{ type: 'text', text: 'This model has no Customizer parameters to set. Edit the code instead.' }];
  }
  const known = new Set(getParamSchema().map(p => p.name));
  const unknown = Object.keys(params).filter(n => !known.has(n));
  if (unknown.length === Object.keys(params).length) {
    return [{ type: 'text', text: `Unknown parameter(s): ${unknown.join(', ')}. Call get_params for valid names.` }];
  }
  setStatus('Rendering…');
  const res = await awaitRender(() => applyParamOverrides(params));
  let text = renderResultText(res);
  if (res.ok) text += `\nCurrent overrides: ${JSON.stringify(getParamValues())}`;
  if (unknown.length) text += `\n(Ignored unknown parameter(s): ${unknown.join(', ')}.)`;
  return [{ type: 'text', text }];
}

function runLook() {
  const img = captureMultiView();
  if (!img) {
    return [{ type: 'text', text: 'Nothing is rendered yet — apply or fix the code first, then look again.' }];
  }
  const dims = dimsLine();
  const label = 'View render — iso · front · right · top';
  addImageButton(label, `data:${img.mediaType};base64,${img.data}`, `Bounding box: ${dims}`);
  const content = [
    { type: 'text', text: `Bounding box ${dims}. The image is a 2×2 grid: ISO, FRONT, RIGHT, TOP in OpenSCAD Z-up.` },
    { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } },
  ];
  content.imageLabel = label; // read by send() when recording the history step
  return content;
}

function runLookAt(input) {
  const yawDeg = Number.isFinite(input?.yaw_deg) ? input.yaw_deg : 45;
  const pitchDeg = Number.isFinite(input?.pitch_deg) ? input.pitch_deg : 30;
  const zoom = Number.isFinite(input?.zoom) ? input.zoom : 1;
  const style = typeof input?.style === 'string' ? input.style : 'solid';
  const img = captureLookAt({ yawDeg, pitchDeg, zoom, style });
  if (!img) {
    return [{ type: 'text', text: 'Nothing is rendered yet — apply or fix the code first, then look_at again.' }];
  }
  const dims = dimsLine();
  const label = `View render — yaw ${img.yawDeg}°, pitch ${img.pitchDeg}°, zoom ${img.zoom}×${img.style !== 'solid' ? `, ${img.style}` : ''}`;
  addImageButton(label, `data:${img.mediaType};base64,${img.data}`, `Bounding box: ${dims}`);
  const content = [
    { type: 'text', text: `Bounding box ${dims}. Single view at yaw ${img.yawDeg}°, pitch ${img.pitchDeg}°, zoom ${img.zoom}×, style ${img.style} (OpenSCAD Z-up).` },
    { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } },
  ];
  content.imageLabel = label; // read by send() when recording the history step
  return content;
}

async function runLookupLib(input) {
  const query = (input?.query || '').trim();
  if (!query) return [{ type: 'text', text: 'lookup_lib needs a `query`, e.g. "rounded box" or "spur gear".' }];
  if (!getSettings().installedLibs?.includes('BOSL2')) {
    return [{ type: 'text', text: 'BOSL2 is not installed, so its signatures are unavailable. Tell the user to install BOSL2 from the Libraries menu, or build the model from plain OpenSCAD primitives.' }];
  }
  let index;
  try {
    index = await getBosl2Index();
  } catch (e) {
    return [{ type: 'text', text: `Could not load the BOSL2 index (${e.message}). Fall back to plain OpenSCAD primitives.` }];
  }
  const matches = searchBosl2Index(index, query);
  if (!matches.length) {
    return [{ type: 'text', text: `No BOSL2 module matched "${query}". Try different keywords, or build it from primitives.` }];
  }
  const text = `BOSL2 matches for "${query}" (include <BOSL2/std.scad>):\n\n`
    + matches.map(formatBosl2Match).join('\n\n');
  return [{ type: 'text', text }];
}

// Dispatch one tool_use block to its handler, returning tool_result content.
export async function runTool(block) {
  switch (block.name) {
    case 'read_code':  return runReadCode(block.input || {});
    case 'edit_code':  return await runEditCode(block.input || {});
    case 'write_code': return await runWriteCode(block.input || {});
    case 'get_params': return runGetParams();
    case 'set_params': return await runSetParams(block.input || {});
    case 'look':       return runLook();
    case 'look_at':    return runLookAt(block.input || {});
    case 'lookup_lib': return await runLookupLib(block.input || {});
    default:           return [{ type: 'text', text: `Unknown tool: ${block.name}` }];
  }
}
