// Three.js viewer: scene, touch orbit controls, and OFF geometry parsing.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { TransformControls } from 'three/addons/TransformControls.js';
import { STLLoader } from 'three/addons/STLLoader.js';
import { MeshBVH, computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { subscribe, emit } from './state.js';
import { getSettings, getProject, getStlPart } from './storage.js';
import { renderSource } from './render-manager.js';

// three-mesh-bvh wiring: patch BufferGeometry/Mesh prototypes once so we can
// build per-part BVHs and use accelerated raycasts for the containment guard.
// This is global but harmless to the single-mesh scad path (it never builds a
// boundsTree, and acceleratedRaycast falls back to the default when none exists).
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

let renderer, scene, camera, controls, mesh, grid, axisGroup, highlightMesh;
let firstFit = true;
let preFsDist = null;
let meshStats = null; // { triangles, size:[dx,dy,dz] } for the current mesh

// ---------- Assembly mode state ----------
// All of this is inert while `assemblyMode === false`; the single-mesh scad
// pipeline (setGeometry / render:done) is never touched. When an assembly is
// active the single `mesh`/`highlightMesh` are hidden and a `partsGroup` of
// per-part meshes drives the scene, gizmo, and fit engine.
let assemblyMode = false;
let partsGroup = null;          // THREE.Group holding one child mesh per part
let transformControls = null;   // TransformControls (lazy-created on first use)
let selectedPartId = null;      // id of the part the gizmo is attached to
let gizmoMode = 'translate';    // 'translate' | 'rotate' — toggled on re-select
let clearance = 0;              // current clearance threshold (mm) for fit flags
// Per-part bookkeeping keyed by part id:
//   { mesh, lastOverrides } — lastOverrides is the JSON of the overrides we last
//   rendered a scad part with, so parts-changed only re-renders on a real change.
const partRecords = new Map();

// Display mode for the model material. Persists across re-renders (each render
// builds a fresh material in setGeometry, so the mode is re-applied there).
const DISPLAY_MODES = ['solid', 'wireframe', 'ghost'];
let displayMode = 'solid';

// ---------- Measurement tool state ----------
// Inert while `measureMode === false`. When on, taps on the model surface drop
// markers (snapped to the nearest vertex/edge); the second tap draws a line and
// emits the distance to the overlay. A third tap starts a fresh measurement.
let measureMode = false;
let measureGroup = null;        // THREE.Group holding markers + connecting line
const measurePoints = [];       // world-space THREE.Vector3 of picked points
const SNAP_PX = 14;             // screen-space snap radius (pixels)

// Mutate a model material to reflect the current display mode. Solid = opaque
// flat-shaded; wireframe = edges only; ghost = translucent see-through skin.
function applyDisplayMode(material) {
  material.wireframe = displayMode === 'wireframe';
  material.transparent = displayMode === 'ghost';
  material.opacity = displayMode === 'ghost' ? 0.35 : 1;
  material.depthWrite = displayMode !== 'ghost';
  material.needsUpdate = true;
}

// Build a coloured XYZ axis indicator: shafts, cones, tick marks, and letter
// sprites.  Everything is in "grid-local" units so it can be scaled identically
// to the GridHelper and always fits the model on screen.
function makeAxisLabel(text, color, position) {
  const size = 64;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.font = `bold ${Math.round(size * 0.68)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false }),
  );
  sprite.scale.set(8, 8, 1);
  sprite.position.copy(position);
  return sprite;
}

function buildAxisGroup() {
  const group = new THREE.Group();
  const SHAFT   = 55;   // shaft length in local units
  const CONE_L  = 6;    // arrowhead length
  const CONE_R  = 1.8;  // arrowhead base radius
  const TICK_D  = 10;   // tick spacing (matches one grid cell)
  const TICK_S  = 1.8;  // half-length of each tick arm

  // Small white sphere at the origin so the intersection point is clear.
  group.add(new THREE.Mesh(
    new THREE.SphereGeometry(1.2, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xcccccc }),
  ));

  const axes = [
    {
      dir: new THREE.Vector3(1, 0, 0), color: 0xff4444, name: 'X',
      t1: new THREE.Vector3(0, 1, 0), t2: new THREE.Vector3(0, 0, 1),
      coneRotAxis: 'z', coneRotAngle: -Math.PI / 2,
    },
    {
      dir: new THREE.Vector3(0, 1, 0), color: 0x44cc44, name: 'Y',
      t1: new THREE.Vector3(1, 0, 0), t2: new THREE.Vector3(0, 0, 1),
      coneRotAxis: null, coneRotAngle: 0,
    },
    {
      dir: new THREE.Vector3(0, 0, 1), color: 0x4499ff, name: 'Z',
      t1: new THREE.Vector3(1, 0, 0), t2: new THREE.Vector3(0, 1, 0),
      coneRotAxis: 'x', coneRotAngle: Math.PI / 2,
    },
  ];

  axes.forEach(({ dir, color, name, t1, t2, coneRotAxis, coneRotAngle }) => {
    const lineMat = new THREE.LineBasicMaterial({ color });

    // Axis shaft
    group.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(),
        dir.clone().multiplyScalar(SHAFT),
      ]),
      lineMat,
    ));

    // Arrowhead cone
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(CONE_R, CONE_L, 8),
      new THREE.MeshBasicMaterial({ color }),
    );
    cone.position.copy(dir.clone().multiplyScalar(SHAFT + CONE_L / 2));
    if (coneRotAxis) cone.rotation[coneRotAxis] = coneRotAngle;
    group.add(cone);

    // Tick marks — all segments for this axis in one LineSegments draw call.
    const tickPts = [];
    const numTicks = Math.floor(SHAFT / TICK_D);
    for (let n = 1; n <= numTicks; n++) {
      const base = dir.clone().multiplyScalar(n * TICK_D);
      for (const perp of [t1, t2]) {
        tickPts.push(base.clone().addScaledVector(perp,  TICK_S));
        tickPts.push(base.clone().addScaledVector(perp, -TICK_S));
      }
    }
    group.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(tickPts),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }),
    ));

    // Axis letter label
    group.add(makeAxisLabel(name, color, dir.clone().multiplyScalar(SHAFT + CONE_L + 5)));
  });

  return group;
}

export function initViewer(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1830);

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
  camera.position.set(60, -60, 50);
  camera.up.set(0, 0, 1); // OpenSCAD is Z-up

  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.1));
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(1, -1.5, 2);
  scene.add(dir);

  grid = new THREE.GridHelper(200, 20, 0x335, 0x223);
  grid.rotation.x = Math.PI / 2; // into XY plane for Z-up
  scene.add(grid);

  axisGroup = buildAxisGroup();
  scene.add(axisGroup);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;

  const panel = canvas.parentElement;
  new ResizeObserver(() => resize(panel)).observe(panel);
  resize(panel);

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
  document.addEventListener('visibilitychange', () => {
    renderer.setAnimationLoop(document.hidden ? null : () => {
      controls.update();
      renderer.render(scene, camera);
    });
  });

  subscribe('render:done', ({ offText }) => {
    // In assembly mode the single-file pipeline is dormant; ignore stray renders
    // so they can't resurrect the hidden scad mesh over the parts group.
    if (assemblyMode) return;
    if (offText) setGeometry(parseOFF(offText));
    // A fresh render clears any previous `#` overlay; if this model still has
    // highlights a render:highlight event follows and rebuilds it.
    setHighlight(null);
  });
  subscribe('render:highlight', ({ offText }) => {
    if (assemblyMode) return;
    if (offText) setHighlight(parseOFF(offText));
  });
  subscribe('settings:changed', ({ settings }) => {
    if (mesh && !mesh.material.vertexColors) {
      mesh.material.color.set(settings.modelColor || '#f9d72c');
    }
  });

  // ---------- Assembly-mode bus wiring ----------
  subscribe('assembly:active', ({ assembly }) => { enterAssembly(assembly); });
  subscribe('assembly:parts-changed', ({ assembly }) => { reconcileParts(assembly); });
  subscribe('assembly:clearance-changed', ({ clearance: c }) => {
    clearance = Number(c) || 0;
    // Gaps are unchanged — only the gap<clearance flag — so just re-emit fit.
    runFit();
  });
  subscribe('part:select', ({ id }) => selectPart(id));
  subscribe('project:changed', () => { if (assemblyMode) exitAssembly(); });

  // Viewport picking: pointerdown raycasts the parts group so tapping a part
  // selects it (and empty space clears). Only active in assembly mode; the
  // gizmo swallows its own pointer events so this won't fire mid-drag.
  canvas.addEventListener('pointerdown', onAssemblyPointerDown);
  // Keyboard transform-mode switch while a part is selected (see GIZMO scheme).
  window.addEventListener('keydown', onAssemblyKeyDown);

  // Measurement picking: tap detection (pointerdown/up on the same spot) so an
  // orbit-drag never drops a point. Only active while measureMode is on.
  canvas.addEventListener('pointerdown', onMeasurePointerDown);
  canvas.addEventListener('pointerup', onMeasurePointerUp);
}

function resize(panel) {
  const w = panel.clientWidth, h = panel.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function setGeometry(geometry) {
  if (mesh) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  const { modelColor } = getSettings();
  const hasVertexColors = geometry.hasAttribute('color');
  const material = new THREE.MeshStandardMaterial({
    color: hasVertexColors ? 0xffffff : (modelColor || '#f9d72c'),
    flatShading: true,
    side: THREE.DoubleSide,
    vertexColors: hasVertexColors,
  });
  applyDisplayMode(material);
  mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // Compute stats here (the viewer owns the geometry); emit so the overlay can
  // show dimensions without depending on cross-listener ordering at render:done.
  geometry.computeBoundingBox();
  const s = new THREE.Vector3();
  geometry.boundingBox.getSize(s);
  const round = v => Math.round(v * 100) / 100;
  meshStats = {
    triangles: geometry.getAttribute('position').count / 3,
    size: [round(s.x), round(s.y), round(s.z)],
  };
  emit('viewer:stats', meshStats);

  // The previous mesh is gone; any markers float in stale space — reset them.
  clearMeasurement();

  if (firstFit) {
    fitView();
    firstFit = false;
  }
}

// Translucent-red overlay for `#`-highlighted geometry. Pass null to clear.
// depthWrite is off so the overlay reads as a see-through skin — subtracted
// volumes inside a difference() stay visible through the solid model.
function setHighlight(geometry) {
  if (highlightMesh) {
    scene.remove(highlightMesh);
    highlightMesh.geometry.dispose();
    highlightMesh.material.dispose();
    highlightMesh = null;
  }
  if (!geometry) return;
  const material = new THREE.MeshStandardMaterial({
    color: 0xff2222,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
    flatShading: true,
  });
  highlightMesh = new THREE.Mesh(geometry, material);
  scene.add(highlightMesh);
}

// Direction vectors for the named camera presets (in OpenSCAD's Z-up frame).
const VIEW_DIRECTIONS = {
  iso:    [1, -1, 0.8],
  front:  [0, -1, 0],
  back:   [0, 1, 0],
  right:  [1, 0, 0],
  left:   [-1, 0, 0],
  top:    [0, 0, 1],
  bottom: [0, 0, -1],
};

// Shared framing: point the camera at the model's bounding sphere from dirVec,
// keeping the model centred and fit. `up` is configurable because looking
// straight down/up the Z axis (top/bottom) would be gimbal-locked with Z-up.
function frameFrom(dirVec, up) {
  if (!mesh) return;
  mesh.geometry.computeBoundingSphere();
  const { center, radius } = mesh.geometry.boundingSphere;
  const r = Math.max(radius, 1);
  controls.target.copy(center);
  camera.up.copy(up);
  camera.position.copy(center).addScaledVector(dirVec.clone().normalize(), r * 2.4);
  camera.near = r / 100;
  camera.far = r * 100;
  camera.updateProjectionMatrix();
  const s = Math.max(r / 100, 0.2);
  grid.scale.setScalar(s);
  axisGroup.scale.setScalar(s);
  controls.update();
}

export function fitView() {
  frameFrom(new THREE.Vector3(1, -1, 0.8), new THREE.Vector3(0, 0, 1));
}

// Frame the model from a named preset: front|back|left|right|top|bottom|iso.
export function setView(name) {
  const v = VIEW_DIRECTIONS[name];
  if (!v || !mesh) return;
  const up = (name === 'top' || name === 'bottom')
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(0, 0, 1);
  frameFrom(new THREE.Vector3(v[0], v[1], v[2]), up);
}

// Advance to the next display mode (solid -> wireframe -> ghost -> solid) and
// re-apply it to the live material. Returns the new mode so the UI can relabel
// the toggle button.
export function cycleDisplayMode() {
  const next = (DISPLAY_MODES.indexOf(displayMode) + 1) % DISPLAY_MODES.length;
  displayMode = DISPLAY_MODES[next];
  if (mesh) applyDisplayMode(mesh.material);
  // In assembly mode the live material lives on each part mesh, not `mesh`.
  if (assemblyMode && partsGroup) {
    for (const child of partsGroup.children) {
      if (child.material) applyDisplayMode(child.material);
    }
  }
  return displayMode;
}

// JPEG snapshot of the current view for the AI chat (base64, no data: prefix).
// Renders synchronously first because the WebGL buffer is cleared after each
// frame (no preserveDrawingBuffer), then downscales onto a 2D canvas.
export function captureSnapshot(maxDim = 768) {
  if (!mesh || !renderer) return null;
  axisGroup.visible = false;
  renderer.render(scene, camera);
  axisGroup.visible = grid.visible;
  const src = renderer.domElement;
  const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(src.width * scale));
  out.height = Math.max(1, Math.round(src.height * scale));
  out.getContext('2d').drawImage(src, 0, 0, out.width, out.height);
  const dataUrl = out.toDataURL('image/jpeg', 0.8);
  return { mediaType: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

// Views composited into the multi-view capture, in 2×2 grid order.
const MULTIVIEW_VIEWS = ['iso', 'front', 'right', 'top'];

// Composite snapshot for the AI chat: four labelled views (iso/front/right/top)
// in a 2×2 grid so the model can judge geometry without depth ambiguity. The
// user's live camera is saved and restored, so this never disturbs their view.
// Returns { mediaType, data } like captureSnapshot (base64, no data: prefix),
// plus `views` (the labels, in grid order) for callers that describe it.
export function captureMultiView(maxDim = 1024) {
  if (!mesh || !renderer) return null;

  const saved = {
    pos: camera.position.clone(),
    up: camera.up.clone(),
    target: controls.target.clone(),
    near: camera.near, far: camera.far,
    gridScale: grid.scale.x,
    axisScale: axisGroup.scale.x,
  };

  const src = renderer.domElement;
  // Each cell is half the output edge; fit the (square-ish) canvas into it.
  const cellScale = Math.min(1, (maxDim / 2) / Math.max(src.width, src.height));
  const cellW = Math.max(1, Math.round(src.width * cellScale));
  const cellH = Math.max(1, Math.round(src.height * cellScale));
  const out = document.createElement('canvas');
  out.width = cellW * 2;
  out.height = cellH * 2;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#0f1830';
  ctx.fillRect(0, 0, out.width, out.height);

  axisGroup.visible = false;
  MULTIVIEW_VIEWS.forEach((name, idx) => {
    const v = VIEW_DIRECTIONS[name];
    const up = (name === 'top' || name === 'bottom')
      ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    frameFrom(new THREE.Vector3(v[0], v[1], v[2]), up);
    renderer.render(scene, camera);
    const x = (idx % 2) * cellW, y = ((idx / 2) | 0) * cellH;
    ctx.drawImage(src, x, y, cellW, cellH);
    // Bake the view label into the image so orientation can't desync from text.
    ctx.font = '600 14px system-ui, sans-serif';
    const label = name.toUpperCase();
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x + 4, y + 4, tw + 10, 20);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 9, y + 18);
  });

  // Restore the user's framing; OrbitControls.update() rebuilds orientation
  // from position + target + up.
  camera.position.copy(saved.pos);
  camera.up.copy(saved.up);
  camera.near = saved.near;
  camera.far = saved.far;
  camera.updateProjectionMatrix();
  controls.target.copy(saved.target);
  grid.scale.setScalar(saved.gridScale);
  axisGroup.scale.setScalar(saved.axisScale);
  axisGroup.visible = grid.visible;
  controls.update();
  renderer.render(scene, camera);

  const dataUrl = out.toDataURL('image/jpeg', 0.8);
  return {
    mediaType: 'image/jpeg',
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    views: MULTIVIEW_VIEWS.slice(),
  };
}

export function toggleGrid() {
  grid.visible = !grid.visible;
  axisGroup.visible = grid.visible;
  return grid.visible;
}

// Save the camera distance when entering fullscreen and zoom out 2× (50% zoom).
// Restore the pre-fullscreen distance when leaving, preserving any rotation/pan
// the user did while maximized.
export function applyFullscreenZoom(enter) {
  if (!camera || !controls) return;
  const dir = camera.position.clone().sub(controls.target);
  const dist = dir.length();
  if (enter) {
    preFsDist = dist;
    camera.position.copy(controls.target).addScaledVector(dir.normalize(), dist * 2);
  } else if (preFsDist !== null) {
    camera.position.copy(controls.target).addScaledVector(dir.normalize(), preFsDist);
    preFsDist = null;
  }
  controls.update();
}

export function getMeshStats() {
  return mesh ? meshStats : null;
}

// ====================================================================
// Measurement tool
// --------------------------------------------------------------------
// Two-tap point-to-point distance. Each tap raycasts the visible model and
// snaps the hit to the nearest triangle vertex, then to the nearest point on a
// triangle edge (both within SNAP_PX on screen), so edges/corners measure
// cleanly. The readout (distance + per-axis deltas) is pushed to the overlay
// via the `measure:updated` bus event. Works on the single scad mesh and on
// assembly parts (whatever is currently visible).
// ====================================================================

// Scratch vectors reused by the picker/snapper to avoid per-tap allocation.
const _mPtr = new THREE.Vector2();
const _mDown = new THREE.Vector2();
const _mRay = new THREE.Raycaster();
const _mvA = new THREE.Vector3();
const _mvB = new THREE.Vector3();
const _mvC = new THREE.Vector3();
const _mEdge = new THREE.Vector3();
const _mProj = new THREE.Vector3();
let _mDownTime = 0;

// The meshes the measurement raycast can hit: assembly parts when an assembly
// is live, otherwise the single scad mesh (if present and visible).
function measureTargets() {
  if (assemblyMode && partsGroup) return partsGroup.children.filter(c => c.visible);
  return (mesh && mesh.visible) ? [mesh] : [];
}

// Toggle the tool. Turning it off clears any in-progress measurement. Returns
// the new boolean state so the UI can relabel/highlight the button.
export function toggleMeasureMode() {
  measureMode = !measureMode;
  if (!measureMode) clearMeasurement();
  else emit('measure:updated', { text: 'Measure: tap two points on the model' });
  return measureMode;
}

// Remove markers/line and reset state; clears the overlay readout.
function clearMeasurement() {
  measurePoints.length = 0;
  if (measureGroup) {
    scene.remove(measureGroup);
    measureGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    measureGroup = null;
  }
  if (measureMode) emit('measure:updated', { text: 'Measure: tap two points on the model' });
  else emit('measure:updated', { text: null });
}

// World-space point -> screen pixel coordinates (canvas-relative).
function worldToPixels(p, out) {
  _mProj.copy(p).project(camera);
  const el = renderer.domElement;
  out.set((_mProj.x * 0.5 + 0.5) * el.clientWidth, (-_mProj.y * 0.5 + 0.5) * el.clientHeight);
  return out;
}

// Closest point on segment AB to point P, written into `out`.
function closestOnSegment(a, b, p, out) {
  _mEdge.subVectors(b, a);
  const len2 = _mEdge.lengthSq() || 1e-9;
  let t = _mEdge.dot(out.subVectors(p, a)) / len2;
  t = Math.max(0, Math.min(1, t));
  return out.copy(a).addScaledVector(_mEdge, t);
}

// Snap a raycast hit to the nearest vertex (priority) or edge point of its
// triangle when within SNAP_PX of the pointer on screen; else the raw hit.
function snapHit(hit, ptrPx) {
  const face = hit.face;
  if (!face) return hit.point.clone();
  const posAttr = hit.object.geometry.getAttribute('position');
  const mw = hit.object.matrixWorld;
  _mvA.fromBufferAttribute(posAttr, face.a).applyMatrix4(mw);
  _mvB.fromBufferAttribute(posAttr, face.b).applyMatrix4(mw);
  _mvC.fromBufferAttribute(posAttr, face.c).applyMatrix4(mw);

  // Nearest vertex first.
  let best = null, bestD = SNAP_PX;
  for (const v of [_mvA, _mvB, _mvC]) {
    const d = worldToPixels(v, _mPtr2).distanceTo(ptrPx);
    if (d < bestD) { bestD = d; best = v.clone(); }
  }
  if (best) return best;

  // Then nearest point on an edge.
  bestD = SNAP_PX;
  for (const [a, b] of [[_mvA, _mvB], [_mvB, _mvC], [_mvC, _mvA]]) {
    const e = closestOnSegment(a, b, hit.point, new THREE.Vector3());
    const d = worldToPixels(e, _mPtr2).distanceTo(ptrPx);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best || hit.point.clone();
}
const _mPtr2 = new THREE.Vector2();

// Visual scale for markers/line, tied to the framed model size (mirrors the
// grid/axis scaling so markers read the same at any model size).
function measureScale() {
  return Math.max(grid.scale.x, 0.05);
}

// Rebuild the marker group from the current measurePoints.
function rebuildMeasureGroup() {
  if (measureGroup) {
    scene.remove(measureGroup);
    measureGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
  measureGroup = new THREE.Group();
  const s = measureScale();
  for (const p of measurePoints) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(2.4 * s, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xff5577, depthTest: false }));
    dot.position.copy(p);
    dot.renderOrder = 999;
    measureGroup.add(dot);
  }
  if (measurePoints.length === 2) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([measurePoints[0], measurePoints[1]]),
      new THREE.LineDashedMaterial({ color: 0xff5577, dashSize: 2 * s, gapSize: 1.5 * s, depthTest: false }),
    );
    line.computeLineDistances();
    line.renderOrder = 999;
    measureGroup.add(line);
  }
  scene.add(measureGroup);
}

// Record a snapped point. First point starts a measurement; second completes it
// and emits the distance; a third begins a fresh one.
function addMeasurePoint(p) {
  if (measurePoints.length >= 2) measurePoints.length = 0;
  measurePoints.push(p);
  rebuildMeasureGroup();
  if (measurePoints.length === 1) {
    emit('measure:updated', { text: 'Measure: tap the second point' });
  } else {
    const a = measurePoints[0], b = measurePoints[1];
    const dist = a.distanceTo(b);
    const r = v => v.toFixed(2);
    emit('measure:updated', {
      text: `${r(dist)} mm  (Δ ${r(Math.abs(b.x - a.x))}, ${r(Math.abs(b.y - a.y))}, ${r(Math.abs(b.z - a.z))})`,
    });
  }
}

// Pointerdown: remember where/when so pointerup can tell a tap from an orbit
// drag. Only meaningful in measure mode.
function onMeasurePointerDown(ev) {
  if (!measureMode) return;
  _mDown.set(ev.clientX, ev.clientY);
  _mDownTime = performance.now();
}

// Pointerup: if it was a tap (small movement, short hold), raycast + snap and
// record the point. Drags fall through to OrbitControls untouched.
function onMeasurePointerUp(ev) {
  if (!measureMode) return;
  const moved = Math.hypot(ev.clientX - _mDown.x, ev.clientY - _mDown.y);
  if (moved > 6 || performance.now() - _mDownTime > 500) return; // it was a drag
  const targets = measureTargets();
  if (!targets.length) return;
  const rect = renderer.domElement.getBoundingClientRect();
  _mPtr.set(ev.clientX - rect.left, ev.clientY - rect.top);
  _mNdc.set((_mPtr.x / rect.width) * 2 - 1, -(_mPtr.y / rect.height) * 2 + 1);
  _mRay.setFromCamera(_mNdc, camera);
  const hits = _mRay.intersectObjects(targets, false);
  if (!hits.length) return;
  addMeasurePoint(snapHit(hits[0], _mPtr));
}
const _mNdc = new THREE.Vector2();

// ====================================================================
// Assembly mode
// --------------------------------------------------------------------
// Everything below is dormant unless `assemblyMode === true`. The single
// scad mesh/highlightMesh are hidden on enter and restored on exit (the
// render:done handler rebuilds them). Communication is bus-only.
//
// GIZMO mode-switch scheme (documented): the gizmo defaults to 'translate'.
// Re-selecting the ALREADY-selected part (a second `part:select` for the same
// id) toggles translate<->rotate. Additionally, while a part is selected the
// keys g/t force translate and r forces rotate (handy on desktop). Both paths
// converge on setGizmoMode().
// ====================================================================

// Material for an assembly part. Mirrors the scad-mode style: flat-shaded,
// double-sided MeshStandardMaterial. Honors per-part color only when the
// geometry carries no vertex colors (matching the scad swatch behaviour).
function makePartMaterial(geometry, color) {
  const hasVertexColors = geometry.hasAttribute('color');
  const material = new THREE.MeshStandardMaterial({
    color: hasVertexColors ? 0xffffff : (color || '#cccccc'),
    flatShading: true,
    side: THREE.DoubleSide,
    vertexColors: hasVertexColors,
  });
  applyDisplayMode(material); // respect the current solid/wireframe/ghost mode
  return material;
}

// Apply a part record's transform (pos mm, rot degrees XYZ, uniform scale) to
// its mesh. Mirrors the OpenSCAD translate(pos) rotate(rot) convention.
function applyPartTransform(m, transform) {
  const t = transform || {};
  const pos = t.pos || [0, 0, 0];
  const rot = t.rot || [0, 0, 0];
  const s = (typeof t.scale === 'number' && t.scale) ? t.scale : 1;
  m.position.set(pos[0] || 0, pos[1] || 0, pos[2] || 0);
  m.rotation.set(
    THREE.MathUtils.degToRad(rot[0] || 0),
    THREE.MathUtils.degToRad(rot[1] || 0),
    THREE.MathUtils.degToRad(rot[2] || 0),
    'XYZ',
  );
  m.scale.setScalar(s);
}

// Resolve one part's geometry. scad parts re-render through the pipeline;
// stl parts come from IndexedDB. Returns a BufferGeometry or null (the caller
// logs+skips on null). Never throws past here — best-effort per the contract.
async function resolvePartGeometry(part) {
  const source = part.source || {};
  try {
    if (source.type === 'scad') {
      const p = getProject(source.projectId);
      if (!p || !p.code) {
        emit('render:log', `assembly: part "${part.name || part.id}" — project not found, skipping`);
        return null;
      }
      const off = await renderSource({ source: p.code, overrides: source.overrides || {} });
      return parseOFF(off);
    }
    if (source.type === 'stl') {
      const rec = await getStlPart(source.ref);
      if (!rec || !rec.bytes) {
        emit('render:log', `assembly: part "${part.name || part.id}" — STL "${source.ref}" not found, skipping`);
        return null;
      }
      const buf = rec.bytes.buffer ?? rec.bytes;
      return new STLLoader().parse(buf);
    }
    emit('render:log', `assembly: part "${part.name || part.id}" — unknown source type, skipping`);
    return null;
  } catch (e) {
    emit('render:log', `assembly: part "${part.name || part.id}" failed to render: ${e.message}`);
    return null;
  }
}

// Build (or rebuild) a single part's mesh from resolved geometry, install a
// BVH for fit queries, register it in partRecords, and add it to partsGroup.
function installPartMesh(part, geometry) {
  geometry.computeVertexNormals();
  geometry.boundsTree = new MeshBVH(geometry); // BVH for clash/clearance queries
  const m = new THREE.Mesh(geometry, makePartMaterial(geometry, part.color));
  m.userData.partId = part.id;
  m.visible = part.visible !== false;
  applyPartTransform(m, part.transform);
  partsGroup.add(m);
  partRecords.set(part.id, {
    mesh: m,
    lastOverrides: JSON.stringify((part.source || {}).overrides || {}),
  });
}

// Dispose a part mesh's GPU/CPU resources (geometry, BVH, material) and remove
// it from the group + bookkeeping.
function disposePartMesh(id) {
  const rec = partRecords.get(id);
  if (!rec) return;
  const m = rec.mesh;
  partsGroup.remove(m);
  if (m.geometry) {
    if (m.geometry.boundsTree && m.geometry.disposeBoundsTree) m.geometry.disposeBoundsTree();
    m.geometry.boundsTree = null;
    m.geometry.dispose();
  }
  if (m.material) m.material.dispose();
  partRecords.delete(id);
}

// Lazily create the TransformControls gizmo. NOTE (three 0.184.0):
// TransformControls is NOT an Object3D — we add its *helper* to the scene, not
// the control itself (adding `tc` directly throws). Orbit is disabled while
// dragging; on the falling edge of dragging we emit part:moved.
function ensureTransformControls() {
  if (transformControls) return transformControls;
  const tc = new TransformControls(camera, renderer.domElement);
  tc.setMode(gizmoMode);
  scene.add(tc.getHelper()); // helper, not the control (0.184.0 API)
  tc.addEventListener('dragging-changed', (event) => {
    controls.enabled = !event.value; // freeze orbit while dragging the gizmo
    if (!event.value) {
      // Falling edge of a drag: commit the new placement and re-run fit.
      emitPartMoved();
      runFit();
    }
  });
  transformControls = tc;
  return tc;
}

// Read the selected mesh's transform back (rotation in DEGREES, XYZ) and emit
// part:moved so the assembly model can persist it.
function emitPartMoved() {
  if (!selectedPartId) return;
  const rec = partRecords.get(selectedPartId);
  if (!rec) return;
  const m = rec.mesh;
  const e = m.rotation; // already 'XYZ' from applyPartTransform / gizmo
  const deg = v => Math.round(THREE.MathUtils.radToDeg(v) * 1000) / 1000;
  const round = v => Math.round(v * 1000) / 1000;
  emit('part:moved', {
    id: selectedPartId,
    transform: {
      pos: [round(m.position.x), round(m.position.y), round(m.position.z)],
      rot: [deg(e.x), deg(e.y), deg(e.z)],
      scale: round(m.scale.x),
    },
  });
}

// Force the gizmo transform mode and relabel — used by both the re-select
// toggle and the keyboard shortcuts.
function setGizmoMode(mode) {
  gizmoMode = mode;
  if (transformControls) transformControls.setMode(mode);
}

// Attach/detach the gizmo to a part by id. Re-selecting the same id toggles
// translate<->rotate. id null/unknown detaches and emits no selection change.
function selectPart(id) {
  if (!assemblyMode) return;
  if (id == null) {
    selectedPartId = null;
    if (transformControls) transformControls.detach();
    return;
  }
  const rec = partRecords.get(id);
  if (!rec) {
    selectedPartId = null;
    if (transformControls) transformControls.detach();
    return;
  }
  const tc = ensureTransformControls();
  if (selectedPartId === id) {
    // Re-select of the already-selected part: toggle mode.
    setGizmoMode(gizmoMode === 'translate' ? 'rotate' : 'translate');
  }
  selectedPartId = id;
  tc.attach(rec.mesh);
}

// Pointer picking inside the viewport (assembly mode only): raycast the parts
// group on pointerdown so tapping a part selects it; empty space clears. The
// gizmo handles its own pointer events, so this won't fire mid-drag.
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
function onAssemblyPointerDown(ev) {
  if (!assemblyMode || !partsGroup) return;
  // If a drag is in progress the gizmo has captured the pointer; bail.
  if (transformControls && transformControls.dragging) return;
  const rect = renderer.domElement.getBoundingClientRect();
  _ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  _ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  _ray.setFromCamera(_ndc, camera);
  const visibleMeshes = partsGroup.children.filter(c => c.visible);
  const hits = _ray.intersectObjects(visibleMeshes, false);
  if (hits.length) {
    const id = hits[0].object.userData.partId;
    selectPart(id);
    emit('part:selected', { id });
  } else {
    selectPart(null);
    emit('part:selected', { id: null });
  }
}

// Keyboard transform-mode switch while a part is selected: g/t = translate,
// r = rotate. Ignored when typing in an input/textarea or when not in
// assembly mode with a live selection.
function onAssemblyKeyDown(ev) {
  if (!assemblyMode || !selectedPartId) return;
  const tag = (ev.target && ev.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || ev.target.isContentEditable) return;
  const k = ev.key.toLowerCase();
  if (k === 'g' || k === 't') setGizmoMode('translate');
  else if (k === 'r') setGizmoMode('rotate');
}

// Frame the camera to fit every visible part (union bounding sphere). Falls
// back to the default iso framing direction used by fitView().
function frameAll() {
  if (!partsGroup) return;
  const box = new THREE.Box3();
  let any = false;
  for (const child of partsGroup.children) {
    if (!child.visible || !child.geometry) continue;
    box.expandByObject(child);
    any = true;
  }
  if (!any) return;
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const center = sphere.center;
  const r = Math.max(sphere.radius, 1);
  const up = new THREE.Vector3(0, 0, 1);
  const dirVec = new THREE.Vector3(1, -1, 0.8).normalize();
  controls.target.copy(center);
  camera.up.copy(up);
  camera.position.copy(center).addScaledVector(dirVec, r * 2.4);
  camera.near = r / 100;
  camera.far = r * 100;
  camera.updateProjectionMatrix();
  const s = Math.max(r / 100, 0.2);
  grid.scale.setScalar(s);
  axisGroup.scale.setScalar(s);
  controls.update();
}

// ENTER assembly mode: hide the single scad mesh, build a fresh parts group,
// render every part SEQUENTIALLY (the worker is single-flight), frame, and run
// the fit engine.
async function enterAssembly(assembly) {
  assemblyMode = true;
  clearance = Number(assembly && assembly.clearance) || 0;
  // Hide the single-file scad view (kept around so exit can restore it).
  if (mesh) mesh.visible = false;
  if (highlightMesh) highlightMesh.visible = false;
  // Fresh container + bookkeeping.
  if (partsGroup) tearDownPartsGroup();
  partsGroup = new THREE.Group();
  scene.add(partsGroup);
  partRecords.clear();
  selectedPartId = null;

  const parts = (assembly && assembly.parts) || [];
  for (const part of parts) {
    const geometry = await resolvePartGeometry(part);
    if (geometry) installPartMesh(part, geometry);
  }
  frameAll();
  runFit();
}

// Reconcile the live parts group against the assembly's parts: add new, remove
// deleted, update visibility/color/transform, and re-render scad parts ONLY
// when their overrides changed (cached per id). Then re-run fit.
async function reconcileParts(assembly) {
  if (!assemblyMode || !partsGroup) return;
  const parts = (assembly && assembly.parts) || [];
  const wanted = new Set(parts.map(p => p.id));

  // Remove parts no longer present.
  for (const id of [...partRecords.keys()]) {
    if (!wanted.has(id)) {
      if (selectedPartId === id) selectPart(null);
      disposePartMesh(id);
    }
  }

  for (const part of parts) {
    const rec = partRecords.get(part.id);
    const overridesKey = JSON.stringify((part.source || {}).overrides || {});
    if (!rec) {
      // New part — render and install.
      const geometry = await resolvePartGeometry(part);
      if (geometry) installPartMesh(part, geometry);
      continue;
    }
    // Existing part: re-render a scad part only if its overrides changed.
    const isScad = (part.source || {}).type === 'scad';
    if (isScad && overridesKey !== rec.lastOverrides) {
      const geometry = await resolvePartGeometry(part);
      if (geometry) {
        const reSelect = selectedPartId === part.id;
        disposePartMesh(part.id);
        installPartMesh(part, geometry);
        if (reSelect && transformControls) transformControls.attach(partRecords.get(part.id).mesh);
      }
      continue;
    }
    // No geometry change — just refresh visibility, color, transform.
    const m = rec.mesh;
    m.visible = part.visible !== false;
    if (!m.geometry.hasAttribute('color') && part.color) m.material.color.set(part.color);
    applyPartTransform(m, part.transform);
  }
  runFit();
}

// Remove the parts group and dispose all GPU/CPU resources for its meshes.
function tearDownPartsGroup() {
  if (transformControls) transformControls.detach();
  for (const id of [...partRecords.keys()]) disposePartMesh(id);
  if (partsGroup) {
    scene.remove(partsGroup);
    partsGroup = null;
  }
  partRecords.clear();
  selectedPartId = null;
}

// EXIT assembly mode: tear down parts + gizmo. The render:done handler then
// restores the single-mesh scad view, so just un-hide the existing one too.
function exitAssembly() {
  tearDownPartsGroup();
  assemblyMode = false;
  if (mesh) mesh.visible = true;
  if (highlightMesh) highlightMesh.visible = true;
}

// ---------- Fit engine ----------
// For each unordered pair of VISIBLE parts: clash via intersectsGeometry on the
// relative matrix; if no surface clash, min gap via closestPointToGeometry plus
// a point-in-mesh parity containment guard. Emits fit:updated. Best-effort —
// never throws (per-pair try/catch).
const _invA = new THREE.Matrix4();
const _rel = new THREE.Matrix4();
const _target = {};
const _contRay = new THREE.Raycaster();
const _vWorld = new THREE.Vector3();
const _dirOut = new THREE.Vector3(0.557, 0.643, 0.526).normalize(); // arbitrary

// Parity test: is at least one vertex of `inner` inside the closed mesh
// `outer`? Cast a ray from an inner vertex (world space) in an arbitrary
// direction; an odd number of crossings of `outer` means the point is inside.
// Best-effort; returns false on any error or on non-watertight meshes.
function meshContains(outerMesh, innerMesh) {
  try {
    const pos = innerMesh.geometry.getAttribute('position');
    if (!pos || !pos.count) return false;
    // First vertex of inner, transformed into world space.
    _vWorld.fromBufferAttribute(pos, 0).applyMatrix4(innerMesh.matrixWorld);
    _contRay.set(_vWorld, _dirOut);
    _contRay.far = Infinity;
    const hits = _contRay.intersectObject(outerMesh, false);
    return (hits.length % 2) === 1;
  } catch {
    return false;
  }
}

function runFit() {
  if (!assemblyMode || !partsGroup) return;
  const meshes = partsGroup.children.filter(c => c.visible && c.geometry && c.geometry.boundsTree);
  for (const m of meshes) m.updateWorldMatrix(true, false);

  const pairs = [];
  for (let i = 0; i < meshes.length; i++) {
    for (let j = i + 1; j < meshes.length; j++) {
      const A = meshes[i], B = meshes[j];
      const aId = A.userData.partId, bId = B.userData.partId;
      let clash = false;
      let gap = null;
      try {
        // Relative pose of B in A's local frame.
        _invA.copy(A.matrixWorld).invert();
        _rel.multiplyMatrices(_invA, B.matrixWorld);
        clash = A.geometry.boundsTree.intersectsGeometry(B.geometry, _rel);
        if (!clash) {
          // Containment guard: surfaces don't cross but one may be wholly
          // inside the other. Check both directions.
          if (meshContains(A, B) || meshContains(B, A)) {
            clash = true;
          } else {
            // Minimum surface gap. Note: closestPointToGeometry returns a
            // distance in A's LOCAL space; with ~uniform scale this equals the
            // world gap times A's scale, so rescale to world mm. Fine for v1.
            const hit = A.geometry.boundsTree.closestPointToGeometry(B.geometry, _rel, _target);
            const localDist = hit ? hit.distance : (_target.distance ?? null);
            if (localDist != null && Number.isFinite(localDist)) {
              const sx = new THREE.Vector3();
              A.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), sx);
              const sc = (sx.x + sx.y + sx.z) / 3 || 1;
              gap = Math.round(localDist * sc * 1000) / 1000;
            }
          }
        }
      } catch (e) {
        // Never let a bad pair abort the whole readout.
        emit('render:log', `fit: pair ${aId}/${bId} failed: ${e.message}`);
      }
      const entry = { a: aId, b: bId, clash };
      if (!clash && gap != null) entry.gap = gap;
      pairs.push(entry);
    }
  }
  emit('fit:updated', { pairs });
}

// ---------- OFF parser ----------
// Line-oriented: handles OFF/COFF with optional per-face RGB(A)
// (0-1 floats or 0-255 ints) trailing each face line.
export function parseOFF(text) {
  const lines = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line) lines.push(line);
  }
  // Header: "OFF" alone or "OFF nv nf ne" on one line.
  let i = 1;
  let counts = lines[0].split(/\s+/);
  if (/^[A-Z]*OFF$/i.test(counts[0])) {
    counts = counts.length > 1 ? counts.slice(1) : lines[i++].split(/\s+/);
  }
  const [nVerts, nFaces] = counts.map(Number);
  if (!Number.isFinite(nVerts) || !Number.isFinite(nFaces)) {
    throw new Error('invalid OFF data');
  }

  const verts = new Float64Array(nVerts * 3);
  for (let v = 0; v < nVerts; v++) {
    const parts = lines[i++].split(/\s+/);
    verts[v * 3] = +parts[0];
    verts[v * 3 + 1] = +parts[1];
    verts[v * 3 + 2] = +parts[2];
  }

  const positions = [];
  const colors = [];
  let hasColor = false;

  for (let f = 0; f < nFaces; f++) {
    const parts = lines[i++].split(/\s+/);
    const n = parseInt(parts[0], 10);
    const idx = parts.slice(1, 1 + n).map(Number);

    let r = 0.98, g = 0.84, b = 0.17;
    if (parts.length >= 1 + n + 3) {
      r = +parts[1 + n]; g = +parts[2 + n]; b = +parts[3 + n];
      if (r > 1 || g > 1 || b > 1) { r /= 255; g /= 255; b /= 255; }
      hasColor = true;
    }

    for (let k = 1; k < n - 1; k++) {
      for (const vi of [idx[0], idx[k], idx[k + 1]]) {
        positions.push(verts[vi * 3], verts[vi * 3 + 1], verts[vi * 3 + 2]);
        colors.push(r, g, b);
      }
    }
  }

  // If every face has the same color the model has no explicit color() calls —
  // just the renderer default. Strip vertex colors so the user's swatch applies.
  if (hasColor) {
    const r0 = colors[0], g0 = colors[1], b0 = colors[2];
    let uniform = true;
    for (let i = 0; i < colors.length; i += 3) {
      if (Math.abs(colors[i] - r0) > 0.005 ||
          Math.abs(colors[i + 1] - g0) > 0.005 ||
          Math.abs(colors[i + 2] - b0) > 0.005) { uniform = false; break; }
    }
    if (uniform) hasColor = false;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (hasColor) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}
