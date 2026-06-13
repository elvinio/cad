// OpenSCAD built-in reference: data + search UI for the Doc tab.

const DOCS = [
  // ── Primitives ────────────────────────────────────────────────
  {
    name: 'sphere', cat: 'Primitives',
    sig: 'sphere(r=1)\nsphere(r, d, $fn, $fa, $fs)',
    desc: 'Creates a sphere centered at the origin.',
    params: [
      ['r', 'Radius (default 1)'],
      ['d', 'Diameter — alternative to r'],
      ['$fn', 'Fixed fragment count (overrides $fa / $fs)'],
      ['$fa', 'Minimum angle per fragment, degrees (default 12)'],
      ['$fs', 'Minimum fragment size in mm (default 2)'],
    ],
  },
  {
    name: 'cube', cat: 'Primitives',
    sig: 'cube(size, center=false)',
    desc: 'Creates a cube or rectangular prism.',
    params: [
      ['size', 'Scalar or [x, y, z] vector. Default 1.'],
      ['center', 'If true, centers the object at origin. Default false.'],
    ],
  },
  {
    name: 'cylinder', cat: 'Primitives',
    sig: 'cylinder(h=1, r=1, center=false)\ncylinder(h, r1, r2, d, d1, d2, center)',
    desc: 'Creates a cylinder or cone along the Z axis.',
    params: [
      ['h', 'Height (default 1)'],
      ['r', 'Radius for both ends'],
      ['r1', 'Bottom radius (overrides r)'],
      ['r2', 'Top radius (overrides r)'],
      ['d', 'Diameter for both ends'],
      ['d1', 'Bottom diameter'],
      ['d2', 'Top diameter'],
      ['center', 'If true, centers vertically at origin. Default false.'],
    ],
  },
  {
    name: 'polyhedron', cat: 'Primitives',
    sig: 'polyhedron(points, faces, convexity=1)',
    desc: 'Creates a closed 3D solid from a list of vertices and faces. Faces must have outward-pointing normals (right-hand rule).',
    params: [
      ['points', 'List of [x, y, z] vertices'],
      ['faces', 'List of face index lists (counter-clockwise winding when viewed from outside)'],
      ['convexity', 'Preview complexity hint (default 1)'],
    ],
  },

  // ── 2D Shapes ─────────────────────────────────────────────────
  {
    name: 'circle', cat: '2D Shapes',
    sig: 'circle(r=1)\ncircle(r, d)',
    desc: 'Creates a 2D circle centered at the origin.',
    params: [
      ['r', 'Radius (default 1)'],
      ['d', 'Diameter — alternative to r'],
    ],
  },
  {
    name: 'square', cat: '2D Shapes',
    sig: 'square(size, center=false)',
    desc: 'Creates a 2D square or rectangle.',
    params: [
      ['size', 'Scalar or [x, y] vector'],
      ['center', 'If true, centers at origin. Default false.'],
    ],
  },
  {
    name: 'polygon', cat: '2D Shapes',
    sig: 'polygon(points, paths, convexity=1)',
    desc: 'Creates a 2D polygon from a list of points. Multiple paths can define holes.',
    params: [
      ['points', 'List of [x, y] vertices'],
      ['paths', 'Optional list of index lists; first path = outline, others = holes'],
      ['convexity', 'Preview complexity hint'],
    ],
  },
  {
    name: 'text', cat: '2D Shapes',
    sig: 'text(text, size=10, font, halign, valign, spacing=1, direction, language, script)',
    desc: 'Creates 2D text geometry from a string using a system font.',
    params: [
      ['text', 'The string to render'],
      ['size', 'Approximate cap height in mm (default 10)'],
      ['font', 'Font name, e.g. "Liberation Sans:style=Bold"'],
      ['halign', '"left" | "center" | "right" (default "left")'],
      ['valign', '"top" | "center" | "baseline" | "bottom" (default "baseline")'],
      ['spacing', 'Character spacing multiplier (default 1)'],
      ['direction', '"ltr" | "rtl" | "ttb" | "btt" (default "ltr")'],
      ['language', 'BCP 47 language tag (default "en")'],
      ['script', 'OpenType script code, e.g. "latin" (default "latin")'],
    ],
  },
  {
    name: 'import', cat: '2D Shapes',
    sig: 'import(file, convexity=1)',
    desc: 'Imports 2D (DXF, SVG) or 3D (STL, OBJ, AMF, 3MF) geometry from a file.',
    params: [
      ['file', 'Path to the file to import'],
      ['convexity', 'Preview complexity hint (default 1)'],
    ],
  },

  // ── 3D from 2D ────────────────────────────────────────────────
  {
    name: 'linear_extrude', cat: '3D from 2D',
    sig: 'linear_extrude(height=1, center=false, convexity=10, twist=0, slices, scale=1) { 2d... }',
    desc: 'Extrudes a 2D shape linearly along the Z axis, with optional twist and taper.',
    params: [
      ['height', 'Extrusion height (default 1)'],
      ['center', 'If true, centers vertically (default false)'],
      ['convexity', 'Preview hint (default 10)'],
      ['twist', 'Degrees of rotation over height (default 0)'],
      ['slices', 'Intermediate layer count for twist/scale (auto if omitted)'],
      ['scale', 'Scalar or [x, y] scale factor at the top end (default 1)'],
    ],
  },
  {
    name: 'rotate_extrude', cat: '3D from 2D',
    sig: 'rotate_extrude(angle=360, convexity=2) { 2d... }',
    desc: 'Rotates a 2D profile around the Z axis to create a solid of revolution. Profile must be in positive X.',
    params: [
      ['angle', 'Sweep angle in degrees (default 360)'],
      ['convexity', 'Preview complexity hint (default 2)'],
    ],
  },
  {
    name: 'projection', cat: '3D from 2D',
    sig: 'projection(cut=false) { 3d... }',
    desc: 'Projects 3D geometry onto the XY plane. cut=true slices at Z=0; cut=false gives a shadow.',
    params: [
      ['cut', 'If true, slices at Z=0 cross-section; if false, orthographic shadow (default false)'],
    ],
  },

  // ── Boolean ───────────────────────────────────────────────────
  {
    name: 'union', cat: 'Boolean',
    sig: 'union() { ... }',
    desc: 'Merges all children into one solid. This is the default when objects are listed without a combinator.',
    params: [],
  },
  {
    name: 'difference', cat: 'Boolean',
    sig: 'difference() { base; subtract1; subtract2; ... }',
    desc: 'Subtracts all children after the first from the first child.',
    params: [],
  },
  {
    name: 'intersection', cat: 'Boolean',
    sig: 'intersection() { ... }',
    desc: 'Returns only the volume common to all children.',
    params: [],
  },

  // ── Transforms ────────────────────────────────────────────────
  {
    name: 'translate', cat: 'Transforms',
    sig: 'translate([x, y, z]) { ... }',
    desc: 'Moves children by the given vector.',
    params: [
      ['v', '[x, y, z] displacement vector'],
    ],
  },
  {
    name: 'rotate', cat: 'Transforms',
    sig: 'rotate([x, y, z]) { ... }\nrotate(a=deg, v=[x,y,z]) { ... }',
    desc: 'Rotates children. [x,y,z] applies Euler angles in sequence Z, Y, X. (a, v) rotates a° around axis v.',
    params: [
      ['a', 'Angle in degrees, or [x, y, z] Euler angles vector'],
      ['v', 'Axis vector for single-angle form, e.g. [0, 0, 1] for Z'],
    ],
  },
  {
    name: 'scale', cat: 'Transforms',
    sig: 'scale([x, y, z]) { ... }',
    desc: 'Scales children by the given factors.',
    params: [
      ['v', 'Scalar or [x, y, z] scale factors'],
    ],
  },
  {
    name: 'resize', cat: 'Transforms',
    sig: 'resize([x, y, z], auto=false) { ... }',
    desc: 'Resizes children to given absolute dimensions. Zero on an axis means no change.',
    params: [
      ['newsize', '[x, y, z] target dimensions; 0 = unchanged on that axis'],
      ['auto', 'If true (or [x,y,z] booleans), scale unconstrained axes proportionally'],
    ],
  },
  {
    name: 'mirror', cat: 'Transforms',
    sig: 'mirror([x, y, z]) { ... }',
    desc: 'Mirrors children across the plane whose normal is the given vector.',
    params: [
      ['v', 'Normal vector of the mirror plane, e.g. [1, 0, 0] mirrors across YZ plane'],
    ],
  },
  {
    name: 'multmatrix', cat: 'Transforms',
    sig: 'multmatrix(m) { ... }',
    desc: 'Applies a 4×4 affine transformation matrix to children.',
    params: [
      ['m', '4×4 transformation matrix as a list of 4 row vectors (last row is [0,0,0,1])'],
    ],
  },
  {
    name: 'color', cat: 'Transforms',
    sig: 'color(c, alpha=1) { ... }',
    desc: 'Sets display color for preview. No effect on STL export.',
    params: [
      ['c', 'CSS color name string (e.g. "red", "Lime") or [r, g, b] or [r, g, b, a] (0–1)'],
      ['alpha', 'Opacity 0–1 (default 1). Ignored if alpha included in c.'],
    ],
  },
  {
    name: 'offset', cat: 'Transforms',
    sig: 'offset(r, delta, chamfer=false) { 2d... }',
    desc: 'Expands or shrinks a 2D shape. Use r for rounded corners, delta for sharp corners.',
    params: [
      ['r', 'Rounded offset radius (positive = expand, negative = shrink)'],
      ['delta', 'Sharp-cornered offset distance (alternative to r)'],
      ['chamfer', 'If true with delta, chamfers convex corners (default false)'],
    ],
  },
  {
    name: 'hull', cat: 'Transforms',
    sig: 'hull() { ... }',
    desc: 'Computes the convex hull enclosing all children.',
    params: [],
  },
  {
    name: 'minkowski', cat: 'Transforms',
    sig: 'minkowski() { ... }',
    desc: 'Computes the Minkowski sum of all children. Useful for rounding all edges of a shape.',
    params: [],
  },

  // ── Math ──────────────────────────────────────────────────────
  {
    name: 'abs', cat: 'Math',
    sig: 'abs(x)',
    desc: 'Returns the absolute value of x.',
    params: [['x', 'Number']],
  },
  {
    name: 'sign', cat: 'Math',
    sig: 'sign(x)',
    desc: 'Returns -1, 0, or 1 depending on the sign of x.',
    params: [['x', 'Number']],
  },
  {
    name: 'sin', cat: 'Math',
    sig: 'sin(deg)',
    desc: 'Sine of an angle given in degrees.',
    params: [['deg', 'Angle in degrees']],
  },
  {
    name: 'cos', cat: 'Math',
    sig: 'cos(deg)',
    desc: 'Cosine of an angle given in degrees.',
    params: [['deg', 'Angle in degrees']],
  },
  {
    name: 'tan', cat: 'Math',
    sig: 'tan(deg)',
    desc: 'Tangent of an angle given in degrees.',
    params: [['deg', 'Angle in degrees']],
  },
  {
    name: 'asin', cat: 'Math',
    sig: 'asin(x)',
    desc: 'Arc sine. Returns degrees in [-90, 90].',
    params: [['x', 'Value in [-1, 1]']],
  },
  {
    name: 'acos', cat: 'Math',
    sig: 'acos(x)',
    desc: 'Arc cosine. Returns degrees in [0, 180].',
    params: [['x', 'Value in [-1, 1]']],
  },
  {
    name: 'atan', cat: 'Math',
    sig: 'atan(x)',
    desc: 'Arc tangent. Returns degrees in (-90, 90).',
    params: [['x', 'Number']],
  },
  {
    name: 'atan2', cat: 'Math',
    sig: 'atan2(y, x)',
    desc: 'Two-argument arc tangent. Returns degrees in (-180, 180], correctly handling all quadrants.',
    params: [['y', 'Y component'], ['x', 'X component']],
  },
  {
    name: 'floor', cat: 'Math',
    sig: 'floor(x)',
    desc: 'Rounds x down to the nearest integer.',
    params: [['x', 'Number']],
  },
  {
    name: 'ceil', cat: 'Math',
    sig: 'ceil(x)',
    desc: 'Rounds x up to the nearest integer.',
    params: [['x', 'Number']],
  },
  {
    name: 'round', cat: 'Math',
    sig: 'round(x)',
    desc: 'Rounds x to the nearest integer (0.5 rounds up).',
    params: [['x', 'Number']],
  },
  {
    name: 'sqrt', cat: 'Math',
    sig: 'sqrt(x)',
    desc: 'Square root of x.',
    params: [['x', 'Non-negative number']],
  },
  {
    name: 'pow', cat: 'Math',
    sig: 'pow(x, y)',
    desc: 'Returns x raised to the power y.',
    params: [['x', 'Base'], ['y', 'Exponent']],
  },
  {
    name: 'exp', cat: 'Math',
    sig: 'exp(x)',
    desc: 'Returns e raised to the power x (natural exponential).',
    params: [['x', 'Exponent']],
  },
  {
    name: 'log', cat: 'Math',
    sig: 'log(x)',
    desc: 'Base-10 logarithm of x.',
    params: [['x', 'Positive number']],
  },
  {
    name: 'ln', cat: 'Math',
    sig: 'ln(x)',
    desc: 'Natural logarithm (base e) of x.',
    params: [['x', 'Positive number']],
  },
  {
    name: 'max', cat: 'Math',
    sig: 'max(a, b, ...)  or  max(vector)',
    desc: 'Returns the largest of all given values.',
    params: [['args', 'Two or more numbers, or a single vector']],
  },
  {
    name: 'min', cat: 'Math',
    sig: 'min(a, b, ...)  or  min(vector)',
    desc: 'Returns the smallest of all given values.',
    params: [['args', 'Two or more numbers, or a single vector']],
  },
  {
    name: 'norm', cat: 'Math',
    sig: 'norm(v)',
    desc: 'Returns the Euclidean length (L2 norm) of a vector.',
    params: [['v', 'Vector of any length']],
  },
  {
    name: 'cross', cat: 'Math',
    sig: 'cross(v1, v2)',
    desc: 'Returns the cross product of two 3D vectors (or the scalar cross product of two 2D vectors).',
    params: [['v1', '3D (or 2D) vector'], ['v2', '3D (or 2D) vector']],
  },

  // ── Lists & Strings ───────────────────────────────────────────
  {
    name: 'len', cat: 'Lists & Strings',
    sig: 'len(x)',
    desc: 'Returns the number of elements in a vector, or the number of characters in a string.',
    params: [['x', 'Vector or string']],
  },
  {
    name: 'concat', cat: 'Lists & Strings',
    sig: 'concat(v1, v2, ...)',
    desc: 'Concatenates vectors and/or scalar values into a new vector.',
    params: [['args', 'Vectors or scalars to join in order']],
  },
  {
    name: 'str', cat: 'Lists & Strings',
    sig: 'str(v1, v2, ...)',
    desc: 'Converts and concatenates values into a string.',
    params: [['args', 'Values to stringify and join (numbers, booleans, strings)']],
  },
  {
    name: 'chr', cat: 'Lists & Strings',
    sig: 'chr(x)',
    desc: 'Returns the Unicode character(s) for a code point or vector of code points.',
    params: [['x', 'Integer code point, or vector of code points']],
  },
  {
    name: 'ord', cat: 'Lists & Strings',
    sig: 'ord(c)',
    desc: 'Returns the Unicode code point of the first character in string c.',
    params: [['c', 'String (uses first character)']],
  },
  {
    name: 'search', cat: 'Lists & Strings',
    sig: 'search(match, vector, num_returns=1, index_col=0)',
    desc: 'Finds the index/indices of match values in a vector. Returns a vector of index vectors.',
    params: [
      ['match', 'Value or vector of values to look for'],
      ['vector', 'Vector (or vector of vectors) to search through'],
      ['num_returns', 'Max hits per match value (0 = all, default 1)'],
      ['index_col', 'Column to compare when vector contains sub-vectors (default 0)'],
    ],
  },
  {
    name: 'lookup', cat: 'Lists & Strings',
    sig: 'lookup(key, table)',
    desc: 'Linearly interpolates a value from a sorted [key, value] lookup table.',
    params: [
      ['key', 'The x value to look up'],
      ['table', 'Sorted list of [x, y] pairs'],
    ],
  },

  // ── Control ───────────────────────────────────────────────────
  {
    name: 'for', cat: 'Control',
    sig: 'for (i = [start : end]) { ... }\nfor (i = [start : step : end]) { ... }\nfor (i = vector) { ... }',
    desc: 'Iterates over a range or vector, generating geometry for each iteration. Also works in list comprehensions: [for (...) expr].',
    params: [
      ['var', 'Loop variable name'],
      ['range', '[start:end] or [start:step:end] (inclusive both ends)'],
      ['vector', 'Any vector literal or variable to iterate over'],
    ],
  },
  {
    name: 'intersection_for', cat: 'Control',
    sig: 'intersection_for (i = range) { ... }',
    desc: 'Iterates over a range or vector and intersects all resulting geometries.',
    params: [
      ['var', 'Loop variable'],
      ['range/vector', 'Range or vector to iterate'],
    ],
  },
  {
    name: 'if', cat: 'Control',
    sig: 'if (condition) { ... }\nif (condition) { ... } else { ... }',
    desc: 'Conditionally generates geometry. Condition is a boolean expression.',
    params: [
      ['condition', 'Boolean expression (e.g. x > 0, a == b, flag)'],
    ],
  },
  {
    name: 'let', cat: 'Control',
    sig: 'let (a = expr, b = expr) { ... }',
    desc: 'Binds named local variables within the enclosed scope. Variables are immutable inside.',
    params: [
      ['bindings', 'One or more name=expression pairs'],
    ],
  },
  {
    name: 'each', cat: 'Control',
    sig: 'each vector',
    desc: 'In a list comprehension, flattens one level of a sub-vector into the outer list.',
    params: [
      ['vector', 'Vector whose elements are spread into the enclosing comprehension'],
    ],
  },
  {
    name: 'assert', cat: 'Control',
    sig: 'assert(condition)\nassert(condition, message)',
    desc: 'Halts rendering with an error if condition is false. Can appear inside a function or module.',
    params: [
      ['condition', 'Boolean expression to test'],
      ['message', 'Optional string shown in the error'],
    ],
  },
  {
    name: 'echo', cat: 'Control',
    sig: 'echo(value)\necho(label=value, ...)',
    desc: 'Prints values to the console during rendering. Useful for debugging parameter values.',
    params: [
      ['values', 'Comma-separated values or name=value pairs'],
    ],
  },

  // ── Definitions ───────────────────────────────────────────────
  {
    name: 'module', cat: 'Definitions',
    sig: 'module name(param1, param2=default) { ... }',
    desc: 'Defines a named reusable geometry module. Call it like: name(args);',
    params: [
      ['name', 'Identifier (must start with a letter or underscore)'],
      ['params', 'Optional parameters; defaults are expressions evaluated at call time'],
    ],
  },
  {
    name: 'function', cat: 'Definitions',
    sig: 'function name(param1, param2=default) = expression;',
    desc: 'Defines a named function that returns a value. Supports recursion and ternary (condition ? a : b).',
    params: [
      ['name', 'Identifier'],
      ['params', 'Optional parameters with optional default values'],
      ['expression', 'Return value expression (one expression only — use let() for multi-step)'],
    ],
  },
  {
    name: 'include', cat: 'Definitions',
    sig: 'include <file.scad>',
    desc: 'Includes and executes another .scad file as if its code appeared here. Imports variables, modules, functions, and geometry.',
    params: [['file', 'Path relative to the including file, or a library path on OPENSCADPATH']],
  },
  {
    name: 'use', cat: 'Definitions',
    sig: 'use <file.scad>',
    desc: 'Imports module and function definitions from a .scad file without instantiating its geometry.',
    params: [['file', 'Path relative to the current file or a library path']],
  },
  {
    name: 'children', cat: 'Definitions',
    sig: 'children()\nchildren(index)\nchildren([i, j, ...])',
    desc: 'Instantiates the child objects passed into the current module.',
    params: [
      ['index', 'Optional: specific child index (0-based), range, or vector of indices. Omit for all children.'],
    ],
  },

  // ── Special Variables ──────────────────────────────────────────
  {
    name: '$fn', cat: 'Special Variables',
    sig: '$fn = n',
    desc: 'Forces a fixed number of sides/facets on circular geometry. 0 = use $fa and $fs instead.',
    params: [['n', 'Integer ≥ 3, or 0 to disable (default 0)']],
  },
  {
    name: '$fa', cat: 'Special Variables',
    sig: '$fa = degrees',
    desc: 'Minimum angle (in degrees) per fragment. Smaller = more fragments on curves. Default 12.',
    params: [['degrees', 'Minimum angle per fragment (default 12, minimum 0.01)']],
  },
  {
    name: '$fs', cat: 'Special Variables',
    sig: '$fs = mm',
    desc: 'Minimum fragment size in mm. Smaller = more fragments at large radii. Default 2.',
    params: [['mm', 'Minimum fragment size (default 2, minimum 0.01)']],
  },
  {
    name: '$t', cat: 'Special Variables',
    sig: '$t',
    desc: 'Animation time parameter, 0.0–1.0. Cycles during animation playback. Read-only.',
    params: [],
  },
  {
    name: '$children', cat: 'Special Variables',
    sig: '$children',
    desc: 'Number of child objects passed to the current module. Read-only.',
    params: [],
  },
  {
    name: '$preview', cat: 'Special Variables',
    sig: '$preview',
    desc: 'True during F5 preview render, false during F6 full render. Lets you simplify geometry for speed.',
    params: [],
  },
  {
    name: '$vpr', cat: 'Special Variables',
    sig: '$vpr',
    desc: 'Viewport rotation [x, y, z] in degrees. Can be set to control the 3D view.',
    params: [],
  },
  {
    name: '$vpt', cat: 'Special Variables',
    sig: '$vpt',
    desc: 'Viewport translation vector [x, y, z]. Can be set to move the camera target.',
    params: [],
  },
  {
    name: '$vpd', cat: 'Special Variables',
    sig: '$vpd',
    desc: 'Viewport camera distance (zoom level). Can be set explicitly.',
    params: [],
  },

  // ── Misc ──────────────────────────────────────────────────────
  {
    name: 'render', cat: 'Misc',
    sig: 'render(convexity=1) { ... }',
    desc: 'Forces a full CGAL render of the enclosed geometry and caches it. Useful inside modules using difference/intersection to avoid preview artifacts.',
    params: [['convexity', 'Complexity hint (default 1)']],
  },
  {
    name: 'surface', cat: 'Misc',
    sig: 'surface(file, center=false, invert=false, convexity=1)',
    desc: 'Creates a 3D height-map surface from a PNG image (brightness → height) or a whitespace-delimited .dat text file.',
    params: [
      ['file', 'Path to a PNG or .dat file'],
      ['center', 'If true, centers the surface at origin in X/Y'],
      ['invert', 'If true, inverts the height values (PNG only)'],
      ['convexity', 'Preview hint'],
    ],
  },
  {
    name: 'version', cat: 'Misc',
    sig: 'version()',
    desc: 'Returns the OpenSCAD version as a [year, month, day] vector, e.g. [2021, 1, 31].',
    params: [],
  },
  {
    name: 'version_num', cat: 'Misc',
    sig: 'version_num()',
    desc: 'Returns the OpenSCAD version as a single integer (yyyymmdd), e.g. 20210131.',
    params: [],
  },
  {
    name: 'parent_module', cat: 'Misc',
    sig: 'parent_module(n)',
    desc: 'Returns the name of the n-th ancestor module (0 = immediate caller). Useful for introspection.',
    params: [['n', 'Ancestor depth, 0 = immediate parent']],
  },
];

// ── UI ────────────────────────────────────────────────────────────

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function initDocs() {
  const search = document.getElementById('doc-search');
  const list = document.getElementById('doc-list');

  function render(query) {
    const q = query.trim().toLowerCase();
    const results = q
      ? DOCS.filter(d =>
          d.name.toLowerCase().includes(q) ||
          d.cat.toLowerCase().includes(q) ||
          d.desc.toLowerCase().includes(q) ||
          d.sig.toLowerCase().includes(q)
        )
      : DOCS;

    list.innerHTML = '';

    if (results.length === 0) {
      list.innerHTML = '<p class="doc-empty">No matches.</p>';
      return;
    }

    for (const d of results) {
      const card = document.createElement('div');
      card.className = 'doc-card';

      const hdr = document.createElement('div');
      hdr.className = 'doc-card-hdr';
      hdr.innerHTML =
        `<code class="doc-name">${esc(d.name)}</code>` +
        `<span class="doc-cat">${esc(d.cat)}</span>` +
        `<span class="doc-chevron">›</span>`;

      const body = document.createElement('div');
      body.className = 'doc-card-body';

      let html = `<pre class="doc-sig">${esc(d.sig)}</pre>` +
                 `<p class="doc-desc">${esc(d.desc)}</p>`;
      if (d.params.length) {
        html += '<table class="doc-params">' +
          d.params.map(([n, pd]) =>
            `<tr><td class="doc-pname">${esc(n)}</td><td class="doc-pdesc">${esc(pd)}</td></tr>`
          ).join('') +
          '</table>';
      }
      body.innerHTML = html;

      hdr.addEventListener('click', () => {
        const wasOpen = card.classList.contains('open');
        list.querySelectorAll('.doc-card.open').forEach(c => c.classList.remove('open'));
        if (!wasOpen) card.classList.add('open');
      });

      card.append(hdr, body);
      list.appendChild(card);
    }
  }

  search.addEventListener('input', () => render(search.value));
  render('');
}
