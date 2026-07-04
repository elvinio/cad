// Snapshot capture for the AI chat: single-view, 2x2 multi-view, and free-angle
// look_at shots. All save/restore the user's live camera framing so capture
// never disturbs their view.

import * as THREE from 'three';
import * as viewer from '../viewer.js';
import { forEachPartMaterial } from './assembly-view.js';

// JPEG snapshot of the current view for the AI chat (base64, no data: prefix).
// Renders synchronously first because the WebGL buffer is cleared after each
// frame (no preserveDrawingBuffer), then downscales onto a 2D canvas.
export function captureSnapshot(maxDim = 768) {
  const { mesh, renderer, scene, camera, axisGroup, grid } = viewer;
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
  const { mesh, renderer, scene, camera, controls, grid, axisGroup, frameFrom, VIEW_DIRECTIONS } = viewer;
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

// Temporarily override wireframe/opacity on a material for a look_at capture,
// returning a restore function. Mirrors applyDisplayMode's solid/wireframe/ghost
// styling but without touching the persistent `displayMode` the UI toggle uses.
function overrideStyle(material, style) {
  const prev = {
    wireframe: material.wireframe, transparent: material.transparent,
    opacity: material.opacity, depthWrite: material.depthWrite,
  };
  material.wireframe = style === 'wireframe';
  material.transparent = style === 'ghost';
  material.opacity = style === 'ghost' ? 0.35 : 1;
  material.depthWrite = style !== 'ghost';
  material.needsUpdate = true;
  return () => { Object.assign(material, prev); material.needsUpdate = true; };
}

const LOOKAT_STYLES = new Set(['solid', 'wireframe', 'ghost']);

// Single free-angle snapshot for the AI chat's look_at tool: yaw/pitch (degrees,
// OpenSCAD Z-up frame — yaw 0 = FRONT looking along -Y, increasing toward +X;
// pitch 0 = horizontal, +90 = TOP, -90 = BOTTOM), a zoom multiplier on the
// default framing distance (<1 = closer, >1 = farther), and an optional
// display style ('solid'|'wireframe'|'ghost') applied only for this shot.
// Full resolution (not quartered like captureMultiView), for close-up detail
// inspection. Restores the user's live camera + material afterward.
export function captureLookAt({ yawDeg = 45, pitchDeg = 30, zoom = 1, style = 'solid', maxDim = 1024 } = {}) {
  const { mesh, renderer, scene, camera, controls, grid, axisGroup, frameFrom } = viewer;
  if (!mesh || !renderer) return null;

  const saved = {
    pos: camera.position.clone(),
    up: camera.up.clone(),
    target: controls.target.clone(),
    near: camera.near, far: camera.far,
    gridScale: grid.scale.x,
    axisScale: axisGroup.scale.x,
  };

  const restoreStyles = [];
  const styleName = LOOKAT_STYLES.has(style) ? style : 'solid';
  if (mesh.material) restoreStyles.push(overrideStyle(mesh.material, styleName));
  forEachPartMaterial(m => restoreStyles.push(overrideStyle(m, styleName)));

  const yaw = THREE.MathUtils.degToRad(yawDeg);
  const pitch = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pitchDeg, -89, 89));
  const dirVec = new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
    Math.sin(pitch),
  );
  const up = Math.abs(pitchDeg) > 80 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const distMult = 2.4 * THREE.MathUtils.clamp(zoom, 0.15, 5);

  axisGroup.visible = false;
  frameFrom(dirVec, up, distMult);
  renderer.render(scene, camera);

  const src = renderer.domElement;
  const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(src.width * scale));
  out.height = Math.max(1, Math.round(src.height * scale));
  out.getContext('2d').drawImage(src, 0, 0, out.width, out.height);
  const dataUrl = out.toDataURL('image/jpeg', 0.85);

  for (const restore of restoreStyles) restore();
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

  return { mediaType: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1), yawDeg, pitchDeg, zoom, style: styleName };
}
