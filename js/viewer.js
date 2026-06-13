// Three.js viewer: scene, touch orbit controls, and OFF geometry parsing.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { subscribe } from './state.js';
import { getSettings } from './storage.js';

let renderer, scene, camera, controls, mesh, grid;
let firstFit = true;

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
  mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  if (firstFit) {
    fitView();
    firstFit = false;
  }
}

export function fitView() {
  if (!mesh) return;
  mesh.geometry.computeBoundingSphere();
  const { center, radius } = mesh.geometry.boundingSphere;
  const r = Math.max(radius, 1);
  controls.target.copy(center);
  const dirVec = new THREE.Vector3(1, -1, 0.8).normalize();
  camera.position.copy(center).addScaledVector(dirVec, r * 2.4);
  camera.near = r / 100;
  camera.far = r * 100;
  camera.updateProjectionMatrix();
  grid.scale.setScalar(Math.max(r / 100, 0.2));
  controls.update();
}

export function getMeshStats() {
  if (!mesh) return null;
  return { triangles: mesh.geometry.getAttribute('position').count / 3 };
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
    const uniform = colors.every((v, i) =>
      Math.abs(v - (i % 3 === 0 ? r0 : i % 3 === 1 ? g0 : b0)) < 0.005);
    if (uniform) hasColor = false;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (hasColor) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}
