// Three.js viewer core: scene/camera/renderer/controls, the single-file scad
// mesh pipeline, camera framing, and display-mode/fullscreen toggles. Snapshot
// capture, measurement, assembly rendering, and the OFF parser live in
// sibling viewer/*.js modules, wired up from initViewer().

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { subscribe, emit } from './state.js';
import { getSettings } from './storage.js';
import { parseOFF } from './viewer/off.js';
import { initMeasure } from './viewer/measure.js';
import { initAssemblyView, isAssemblyActive } from './viewer/assembly-view.js';

// Live bindings read directly by sibling viewer/*.js modules (measure.js,
// capture.js, assembly-view.js); only this module ever reassigns them.
export let renderer, scene, camera, controls, mesh, grid, axisGroup, highlightMesh;
let firstFit = true;
let preFsDist = null;
let meshStats = null; // { triangles, size:[dx,dy,dz] } for the current mesh

// Registration point for assembly-view's forEachPartMaterial, so core can
// touch part materials (cycleDisplayMode) without statically importing
// assembly-view (which would create an import cycle, since assembly-view
// imports core's applyDisplayMode).
let forEachPartMaterialHook = null;
export function registerPartMaterialsHook(fn) {
  forEachPartMaterialHook = fn;
}

// Controlled mutation points for the single scad mesh's visibility, used by
// assembly mode's enter/exit instead of reaching into `mesh`/`highlightMesh`
// directly.
export function setMeshVisible(v) {
  if (mesh) mesh.visible = v;
}
export function setHighlightVisible(v) {
  if (highlightMesh) highlightMesh.visible = v;
}

// Display mode for the model material. Persists across re-renders (each render
// builds a fresh material in setGeometry, so the mode is re-applied there).
const DISPLAY_MODES = ['solid', 'wireframe', 'ghost'];
let displayMode = 'solid';

// Mutate a model material to reflect the current display mode. Solid = opaque
// flat-shaded; wireframe = edges only; ghost = translucent see-through skin.
// Exported so assembly-view.js's makePartMaterial can apply the same styling
// to part meshes.
export function applyDisplayMode(material) {
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
    if (isAssemblyActive()) return;
    if (offText) setGeometry(parseOFF(offText));
    // A fresh render clears any previous `#` overlay; if this model still has
    // highlights a render:highlight event follows and rebuilds it.
    setHighlight(null);
  });
  subscribe('render:highlight', ({ offText }) => {
    if (isAssemblyActive()) return;
    if (offText) setHighlight(parseOFF(offText));
  });
  subscribe('settings:changed', ({ settings }) => {
    if (mesh && !mesh.material.vertexColors) {
      mesh.material.color.set(settings.modelColor || '#f9d72c');
    }
  });

  // Assembly mode: part rendering, gizmo, fit engine — all wired by its own
  // module (bus subscriptions + viewport pointer/keyboard listeners).
  initAssemblyView(canvas);

  // Measurement tool: tap detection, snapping, and its own render:done reset.
  initMeasure(canvas);
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

  // measure.js resets its own state on render:done (it owns that concern now).

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
// Exported so capture.js can reuse the same named views for its capture grid.
export const VIEW_DIRECTIONS = {
  iso:    [1, -1, 0.8],
  front:  [0, -1, 0],
  back:   [0, 1, 0],
  right:  [1, 0, 0],
  left:   [-1, 0, 0],
  top:    [0, 0, 1],
  bottom: [0, 0, -1],
};

// Point the camera at a given world-space sphere from dirVec, keeping it
// centred and fit. `up` is configurable because looking straight down/up the
// Z axis (top/bottom) would be gimbal-locked with Z-up. `distMult` scales the
// standoff distance (2.4x the bounding radius by default); smaller values
// zoom in, larger values zoom out. Shared by frameFrom (single scad mesh) and
// assembly-view.js's frameAll (union of visible parts) so both frame the same
// way from whatever bounding sphere they compute.
export function frameSphere(center, radius, dirVec, up, distMult = 2.4) {
  const r = Math.max(radius, 1);
  controls.target.copy(center);
  camera.up.copy(up);
  camera.position.copy(center).addScaledVector(dirVec.clone().normalize(), r * distMult);
  camera.near = r / 100;
  camera.far = r * 100;
  camera.updateProjectionMatrix();
  const s = Math.max(r / 100, 0.2);
  grid.scale.setScalar(s);
  axisGroup.scale.setScalar(s);
  controls.update();
}

export function frameFrom(dirVec, up, distMult = 2.4) {
  if (!mesh) return;
  mesh.geometry.computeBoundingSphere();
  const { center, radius } = mesh.geometry.boundingSphere;
  frameSphere(center, radius, dirVec, up, distMult);
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
  if (forEachPartMaterialHook) forEachPartMaterialHook(applyDisplayMode);
  return displayMode;
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

