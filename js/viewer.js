// Three.js viewer: scene, touch orbit controls, and OFF geometry parsing.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { subscribe, emit } from './state.js';
import { getSettings } from './storage.js';

let renderer, scene, camera, controls, mesh, grid, highlightMesh;
let firstFit = true;
let meshStats = null; // { triangles, size:[dx,dy,dz] } for the current mesh

// Display mode for the model material. Persists across re-renders (each render
// builds a fresh material in setGeometry, so the mode is re-applied there).
const DISPLAY_MODES = ['solid', 'wireframe', 'ghost'];
let displayMode = 'solid';

// Mutate a model material to reflect the current display mode. Solid = opaque
// flat-shaded; wireframe = edges only; ghost = translucent see-through skin.
function applyDisplayMode(material) {
  material.wireframe = displayMode === 'wireframe';
  material.transparent = displayMode === 'ghost';
  material.opacity = displayMode === 'ghost' ? 0.35 : 1;
  material.depthWrite = displayMode !== 'ghost';
  material.needsUpdate = true;
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
    if (offText) setGeometry(parseOFF(offText));
    // A fresh render clears any previous `#` overlay; if this model still has
    // highlights a render:highlight event follows and rebuilds it.
    setHighlight(null);
  });
  subscribe('render:highlight', ({ offText }) => {
    if (offText) setHighlight(parseOFF(offText));
  });
  subscribe('settings:changed', ({ settings }) => {
    if (mesh && !mesh.material.vertexColors) {
      mesh.material.color.set(settings.modelColor || '#f9d72c');
    }
  });
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
  grid.scale.setScalar(Math.max(r / 100, 0.2));
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
  return displayMode;
}

// JPEG snapshot of the current view for the AI chat (base64, no data: prefix).
// Renders synchronously first because the WebGL buffer is cleared after each
// frame (no preserveDrawingBuffer), then downscales onto a 2D canvas.
export function captureSnapshot(maxDim = 768) {
  if (!mesh || !renderer) return null;
  renderer.render(scene, camera);
  const src = renderer.domElement;
  const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(src.width * scale));
  out.height = Math.max(1, Math.round(src.height * scale));
  out.getContext('2d').drawImage(src, 0, 0, out.width, out.height);
  const dataUrl = out.toDataURL('image/jpeg', 0.8);
  return { mediaType: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

export function getMeshStats() {
  return mesh ? meshStats : null;
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
