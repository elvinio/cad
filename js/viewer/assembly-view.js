// ====================================================================
// Assembly mode
// --------------------------------------------------------------------
// Renders multiple placed parts (scad sub-projects or imported STLs), a
// transform gizmo to move/rotate the selected part, and a fit/clash engine
// that flags overlapping or too-close pairs. Everything here is dormant
// unless an assembly is active — the single scad mesh/highlightMesh are
// hidden on enter and restored on exit (the render:done handler in core
// rebuilds them). Communication with the rest of the app is bus-only, wired
// up once via initAssemblyView(canvas), called from core's initViewer.
//
// GIZMO mode-switch scheme (documented): the gizmo defaults to 'translate'.
// Re-selecting the ALREADY-selected part (a second `part:select` for the same
// id) toggles translate<->rotate. Additionally, while a part is selected the
// keys g/t force translate and r forces rotate (handy on desktop). Both paths
// converge on setGizmoMode().
// ====================================================================

import * as THREE from 'three';
import { TransformControls } from 'three/addons/TransformControls.js';
import { STLLoader } from 'three/addons/STLLoader.js';
import { MeshBVH, computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { subscribe, emit } from '../state.js';
import { getProject, getStlPart } from '../storage.js';
import { renderSource } from '../render-manager.js';
import { parseOFF } from './off.js';
import * as viewer from '../viewer.js';

// three-mesh-bvh wiring: patch BufferGeometry/Mesh prototypes once so we can
// build per-part BVHs and use accelerated raycasts for the containment guard.
// This is global but harmless to the single-mesh scad path (it never builds a
// boundsTree, and acceleratedRaycast falls back to the default when none exists).
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// All of this is inert while `assemblyMode === false`; the single-mesh scad
// pipeline (core's setGeometry / render:done) is never touched. When an
// assembly is active the single `mesh`/`highlightMesh` are hidden and a
// `partsGroup` of per-part meshes drives the scene, gizmo, and fit engine.
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

// Whether an assembly is currently active — read by measure.js/capture.js.
export function isAssemblyActive() {
  return assemblyMode;
}

// The meshes a viewport raycast can hit right now, or null when no assembly
// is active (callers fall back to their own single-mesh target).
export function getPickableTargets() {
  return (assemblyMode && partsGroup) ? partsGroup.children.filter(c => c.visible) : null;
}

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
  viewer.applyDisplayMode(material); // respect the current solid/wireframe/ghost mode
  return material;
}

// Apply `fn` to every assembly part's material. Used directly by capture.js's
// look_at style override, and registered with core via
// registerPartMaterialsHook so core's cycleDisplayMode can restyle parts
// without statically importing this module.
export function forEachPartMaterial(fn) {
  if (!assemblyMode || !partsGroup) return;
  for (const child of partsGroup.children) {
    if (child.material) fn(child.material);
  }
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
        emit('render:log', { stream: 'err', line: `WARNING: assembly: part "${part.name || part.id}" — project not found, skipping` });
        return null;
      }
      const off = await renderSource({ source: p.code, overrides: source.overrides || {} });
      return parseOFF(off);
    }
    if (source.type === 'stl') {
      const rec = await getStlPart(source.ref);
      if (!rec || !rec.bytes) {
        emit('render:log', { stream: 'err', line: `WARNING: assembly: part "${part.name || part.id}" — STL "${source.ref}" not found, skipping` });
        return null;
      }
      const buf = rec.bytes.buffer ?? rec.bytes;
      return new STLLoader().parse(buf);
    }
    emit('render:log', { stream: 'err', line: `WARNING: assembly: part "${part.name || part.id}" — unknown source type, skipping` });
    return null;
  } catch (e) {
    emit('render:log', { stream: 'err', line: `WARNING: assembly: part "${part.name || part.id}" failed to render: ${e.message}` });
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
  const tc = new TransformControls(viewer.camera, viewer.renderer.domElement);
  tc.setMode(gizmoMode);
  viewer.scene.add(tc.getHelper()); // helper, not the control (0.184.0 API)
  tc.addEventListener('dragging-changed', (event) => {
    viewer.controls.enabled = !event.value; // freeze orbit while dragging the gizmo
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
  const rect = viewer.renderer.domElement.getBoundingClientRect();
  _ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  _ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  _ray.setFromCamera(_ndc, viewer.camera);
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
// back to the default iso framing direction used by core's fitView().
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
  viewer.frameSphere(sphere.center, sphere.radius, new THREE.Vector3(1, -1, 0.8).normalize(), new THREE.Vector3(0, 0, 1));
}

// ENTER assembly mode: hide the single scad mesh, build a fresh parts group,
// render every part SEQUENTIALLY (the worker is single-flight), frame, and run
// the fit engine.
async function enterAssembly(assembly) {
  assemblyMode = true;
  clearance = Number(assembly && assembly.clearance) || 0;
  // Hide the single-file scad view (kept around so exit can restore it).
  viewer.setMeshVisible(false);
  viewer.setHighlightVisible(false);
  // Fresh container + bookkeeping.
  if (partsGroup) tearDownPartsGroup();
  partsGroup = new THREE.Group();
  viewer.scene.add(partsGroup);
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
    viewer.scene.remove(partsGroup);
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
  viewer.setMeshVisible(true);
  viewer.setHighlightVisible(true);
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
        emit('render:log', { stream: 'err', line: `WARNING: fit: pair ${aId}/${bId} failed: ${e.message}` });
      }
      const entry = { a: aId, b: bId, clash };
      if (!clash && gap != null) entry.gap = gap;
      pairs.push(entry);
    }
  }
  emit('fit:updated', { pairs });
}

// Wire the assembly bus subscriptions and viewport pointer/keyboard listeners.
// Called once from core's initViewer with the viewport canvas.
export function initAssemblyView(canvas) {
  // Registered here (not at module top-level): this runs after core viewer.js
  // has finished its own module evaluation, avoiding a TDZ error on core's
  // `forEachPartMaterialHook` let-binding from the viewer.js <-> assembly-view.js
  // circular import (assembly-view.js's top-level code executes mid-evaluation
  // of core viewer.js, before core reaches that declaration).
  viewer.registerPartMaterialsHook(forEachPartMaterial);

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
}
