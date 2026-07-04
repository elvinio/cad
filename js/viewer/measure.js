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

import * as THREE from 'three';
import { subscribe, emit } from '../state.js';
import * as viewer from '../viewer.js';
import { isAssemblyActive, getPickableTargets } from './assembly-view.js';

// Inert while `measureMode === false`. When on, taps on the model surface drop
// markers (snapped to the nearest vertex/edge); the second tap draws a line and
// emits the distance to the overlay. A third tap starts a fresh measurement.
let measureMode = false;
let measureGroup = null;        // THREE.Group holding markers + connecting line
const measurePoints = [];       // world-space THREE.Vector3 of picked points
const SNAP_PX = 14;             // screen-space snap radius (pixels)

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
  const assemblyTargets = getPickableTargets();
  if (assemblyTargets) return assemblyTargets;
  return (viewer.mesh && viewer.mesh.visible) ? [viewer.mesh] : [];
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
    viewer.scene.remove(measureGroup);
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
  _mProj.copy(p).project(viewer.camera);
  const el = viewer.renderer.domElement;
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
  return Math.max(viewer.grid.scale.x, 0.05);
}

// Rebuild the marker group from the current measurePoints.
function rebuildMeasureGroup() {
  if (measureGroup) {
    viewer.scene.remove(measureGroup);
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
  viewer.scene.add(measureGroup);
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
  const rect = viewer.renderer.domElement.getBoundingClientRect();
  _mPtr.set(ev.clientX - rect.left, ev.clientY - rect.top);
  _mNdc.set((_mPtr.x / rect.width) * 2 - 1, -(_mPtr.y / rect.height) * 2 + 1);
  _mRay.setFromCamera(_mNdc, viewer.camera);
  const hits = _mRay.intersectObjects(targets, false);
  if (!hits.length) return;
  addMeasurePoint(snapHit(hits[0], _mPtr));
}
const _mNdc = new THREE.Vector2();

// Wire pointer picking and the render:done reset. Called once from core's
// initViewer with the viewport canvas.
export function initMeasure(canvas) {
  canvas.addEventListener('pointerdown', onMeasurePointerDown);
  canvas.addEventListener('pointerup', onMeasurePointerUp);
  // A fresh single-file render replaces the mesh; any markers float in stale
  // space. Assembly-mode renders of the single-file pipeline are dormant (core
  // ignores them too), so mirror that guard here.
  subscribe('render:done', () => {
    if (!isAssemblyActive()) clearMeasurement();
  });
}
