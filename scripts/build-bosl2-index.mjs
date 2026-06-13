// Dev/maintenance tool — NOT part of the no-build app runtime.
// Extracts a compact signature index from BOSL2's structured docstrings so the
// AI chat can look up exact module/function signatures on demand instead of
// guessing argument names from memory.
//
// Input:  vendor/libraries/BOSL2.zip  (the vendored curated zip)
// Output: vendor/libraries/bosl2-index.json  (committed asset, loaded by js/chat.js)
//
// Run:    node scripts/build-bosl2-index.mjs
//
// BOSL2 docstrings are uniform line-comment blocks, e.g.:
//   // Module: cuboid()
//   // Synopsis: Creates a cube with chamfering and roundovers.
//   // Usage: Rounded Cubes
//   //   cuboid(size, [rounding=], ...);
//   // Arguments:
//   //   size = The size of the cube, a number or length 3 vector.
//   //   ---
//   //   rounding = Radius of the edge rounding.  Default: No rounding.
// We capture name, file, synopsis, usage[] and args[] (positional kept; the
// `---` divider and overly long arg prose are trimmed) and skip Example/
// Description/Figure sections to keep the JSON small.

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { unzipSync, strFromU8 } from '../vendor/fflate/fflate.module.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = join(root, 'vendor/libraries/BOSL2.zip');
const OUT = join(root, 'vendor/libraries/bosl2-index.json');

const MAX_USAGE = 4;   // keep at most this many usage lines per entry
const MAX_ARGS = 16;   // keep at most this many args per entry
const MAX_ARG_DESC = 120;

const DECL_RE = /^\/\/\s*(Function&Module|Function|Module|Constant):\s*(.+?)\s*$/;
const SECTION_RE = /^\/\/\s*([A-Z][A-Za-z&/ ]*):\s*(.*)$/;
const CONT_RE = /^\/\/\s{2,}(.*)$/;

function shorten(s) {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > MAX_ARG_DESC ? s.slice(0, MAX_ARG_DESC - 1).trimEnd() + '…' : s;
}

// Parse one .scad file's docstrings into entries.
function parseFile(file, text) {
  const out = [];
  let cur = null;
  let section = null; // 'usage' | 'args' | 'other' | null
  const flush = () => { if (cur && (cur.usage.length || cur.synopsis)) out.push(cur); cur = null; section = null; };

  for (const line of text.split('\n')) {
    const decl = line.match(DECL_RE);
    if (decl) {
      flush();
      const name = decl[2].replace(/\(\)\s*$/, '').trim();
      cur = { name, file, kind: decl[1], synopsis: '', usage: [], args: [] };
      continue;
    }
    if (!cur) continue;

    const cont = line.match(CONT_RE);
    if (cont) {
      const body = cont[1].trim();
      if (section === 'usage' && body && cur.usage.length < MAX_USAGE) {
        cur.usage.push(body);
      } else if (section === 'args' && body && body !== '---' && cur.args.length < MAX_ARGS) {
        const eq = body.indexOf('=');
        const name = eq > 0 ? body.slice(0, eq).trim() : '';
        // Only accept real "name = description" rows; skip wrapped description
        // lines and inline example code that also contain '='.
        if (/^[$A-Za-z_][\w$]*$/.test(name)) cur.args.push({ name, desc: shorten(body.slice(eq + 1)) });
      }
      continue;
    }

    const sec = line.match(SECTION_RE);
    if (sec) {
      const head = sec[1].toLowerCase();
      if (head === 'synopsis') { cur.synopsis = shorten(sec[2]); section = 'other'; }
      else if (head === 'usage') section = 'usage';
      else if (head === 'arguments') section = 'args';
      else section = 'other';
      continue;
    }

    // A non-comment line (the actual module/function definition) ends the block.
    if (!line.startsWith('//')) flush();
  }
  flush();
  return out;
}

const zip = unzipSync(new Uint8Array(readFileSync(ZIP)));
const entries = [];
for (const [path, bytes] of Object.entries(zip)) {
  if (!path.endsWith('.scad')) continue;
  const file = path.replace(/^[^/]+\//, '').replace(/^BOSL2\//, ''); // strip any top folder
  for (const e of parseFile(file, strFromU8(bytes))) entries.push(e);
}

entries.sort((a, b) => a.name.localeCompare(b.name));
const index = { library: 'BOSL2', generated: new Date().toISOString().slice(0, 10), count: entries.length, entries };
writeFileSync(OUT, JSON.stringify(index) + '\n');

console.log(`Wrote ${OUT}: ${entries.length} entries`);
const sample = ['cuboid', 'attach', 'spur_gear', 'screw', 'rounding'];
for (const n of sample) {
  const e = entries.find(x => x.name === n);
  console.log(e ? `  ${n}: usage=${e.usage.length} args=${e.args.length} — ${e.synopsis}` : `  ${n}: MISSING`);
}
