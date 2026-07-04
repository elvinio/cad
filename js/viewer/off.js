// OFF/COFF parser: line-oriented, handles optional per-face RGB(A) trailing
// each face line (0-1 floats or 0-255 ints). Pure — no viewer state.

import * as THREE from 'three';

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
