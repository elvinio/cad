// Extracts geometry marked with the `#` highlight modifier from OpenSCAD CSG
// output, so the viewer can draw it as a translucent red overlay.
//
// Why CSG: the `.off` mesh export bakes away all booleans AND drops the `#`
// marker entirely (a highlighted subtracted shape is simply absent). The `.csg`
// export is the only format that keeps the modifier — this build emits it as a
// literal `#` prefix character on the node, e.g. `#\tsphere($fn = 16, r = 12);`
// (NOT a `color([1,0,0,0.5])` wrapper, despite what some references claim).
//
// CSG is a fully-evaluated subset of SCAD (only multmatrix/group/booleans/
// primitives — no variables or modules), so the extracted subtree can be fed
// straight back into OpenSCAD to produce a drawable OFF mesh for the overlay.

// Boolean operators whose result we must NOT preserve when they merely sit
// ABOVE a highlight: collapse them to union() so siblings can't subtract or
// clip the overlay. Everything else (multmatrix/group/color/extrudes/render…)
// keeps its name+args so transforms and positions survive.
const BOOLEAN_OPS = new Set([
  'union', 'difference', 'intersection', 'hull', 'minkowski',
]);

// Cheap gate: does the source plausibly use `#` as a modifier? Strips comments
// and strings first so a `#` inside them doesn't trigger the extra CSG pass.
// False positives only cost one wasted CSG export, so this stays lenient.
export function sourceHasHighlight(src) {
  if (!src) return false;
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/\/\/[^\n]*/g, ' ')          // line comments
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ');  // double-quoted strings
  return stripped.includes('#');
}

// --- CSG parser (recursive descent over the flattened subset) --------------

function parse(text) {
  let i = 0;
  const n = text.length;

  const skipWs = () => { while (i < n && /\s/.test(text[i])) i++; };

  // Read a balanced (...) run as opaque text, including the parens.
  function readArgs() {
    if (text[i] !== '(') return '';
    let depth = 0, start = i;
    for (; i < n; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') { depth--; if (depth === 0) { i++; break; } }
    }
    return text.slice(start, i);
  }

  function readNodes(stopAtBrace) {
    const nodes = [];
    for (;;) {
      skipWs();
      if (i >= n) break;
      if (stopAtBrace && text[i] === '}') { i++; break; }

      // Leading modifier characters (may stack, e.g. `#%`).
      const mods = new Set();
      while (i < n && '#%!*'.includes(text[i])) { mods.add(text[i]); i++; skipWs(); }

      // Identifier.
      const idStart = i;
      while (i < n && /[A-Za-z0-9_$]/.test(text[i])) i++;
      const name = text.slice(idStart, i);
      if (!name) { i++; continue; } // stray char; skip defensively

      skipWs();
      const args = readArgs();
      skipWs();

      let children = null;
      if (text[i] === '{') { i++; children = readNodes(true); }
      else if (text[i] === ';') i++;

      nodes.push({ mods, name, args, children });
    }
    return nodes;
  }

  return readNodes(false);
}

// --- Tree -> highlight-only CSG text ---------------------------------------

// Emit a node and its whole subtree verbatim (it IS highlighted geometry),
// stripping modifier chars so nested marks don't interfere.
function serializeReal(node) {
  if (node.mods.has('*')) return '';        // disabled: no geometry
  if (node.children) {
    const inner = node.children.map(serializeReal).filter(Boolean).join('\n');
    return `${node.name}${node.args} {\n${inner}\n}`;
  }
  return `${node.name}${node.args};`;
}

// Walk an un-highlighted region, keeping only branches that contain a `#`.
function extractNode(node) {
  if (node.mods.has('*')) return '';
  if (node.mods.has('#')) return serializeReal(node);   // highlighted: take it all
  if (!node.children) return '';                        // plain leaf: nothing

  const parts = node.children.map(extractNode).filter(Boolean);
  if (!parts.length) return '';
  const inner = parts.join('\n');

  // Booleans sitting above a highlight collapse to union so they can't clip it;
  // transforms/groups keep their identity to preserve placement.
  const wrap = BOOLEAN_OPS.has(node.name) ? 'union()' : `${node.name}${node.args}`;
  return `${wrap} {\n${inner}\n}`;
}

// Given raw CSG text, return a synthetic CSG/SCAD string containing only the
// `#`-highlighted geometry (in world position), or '' if there is none.
export function extractHighlights(csgText) {
  let tree;
  try { tree = parse(csgText); } catch { return ''; }
  const parts = tree.map(extractNode).filter(Boolean);
  return parts.length ? parts.join('\n') : '';
}
