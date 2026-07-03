// Module worker that owns the OpenSCAD wasm instance.
// One fresh instance per render job (cancellation = terminate this worker).
//
// In:  {type:"render", jobId, source, format:"off"|"binstl"|"param"|"asciistl"|"csg",
//       defines:{name:value}, backend:"manifold"|"cgal", libNames:[string]}
// Out: {type:"log", jobId, stream:"out"|"err", line}
//      {type:"done", jobId, output:ArrayBuffer, elapsedMs}
//      {type:"error", jobId, message, exitCode}

import { unzipSync } from '../../vendor/fflate/fflate.module.js';
import { getLibZip } from '../storage.js';

const FORMAT_EXT = { off: 'off', binstl: 'stl', asciistl: 'stl', param: 'json', csg: 'csg' };

// Unzipped {path -> Uint8Array} maps, kept for the worker's lifetime.
const unzippedLibs = new Map();

// Compiled wasm module, kept for the worker's lifetime so respawned jobs
// (but not respawned workers) skip recompilation — only re-instantiation.
let wasmModulePromise = null;
function getWasmModule() {
  if (!wasmModulePromise) {
    const url = new URL('../../vendor/openscad/openscad.wasm', import.meta.url);
    wasmModulePromise = WebAssembly.compileStreaming(fetch(url)).catch(async () => {
      // Fallback for servers that don't send application/wasm.
      const buf = await (await fetch(url)).arrayBuffer();
      return WebAssembly.compile(buf);
    });
  }
  return wasmModulePromise;
}

async function getUnzippedLib(name) {
  if (unzippedLibs.has(name)) return unzippedLibs.get(name);
  const rec = await getLibZip(name);
  if (!rec) return null;
  const files = unzipSync(new Uint8Array(rec.zipBytes));
  unzippedLibs.set(name, files);
  return files;
}

function stripTopFolder(paths) {
  // GitHub archive zips wrap everything in "Repo-ref/". Curated zips don't.
  const tops = new Set();
  for (const p of paths) {
    if (p.endsWith('/') && paths.length === 1) continue;
    tops.add(p.split('/')[0]);
    if (tops.size > 1) return 0;
  }
  // Single top entry that is a folder for every file -> strip it.
  const top = [...tops][0];
  return paths.every(p => p === top + '/' || p.startsWith(top + '/')) ? top.length + 1 : 0;
}

function mountLib(inst, name, files) {
  const base = name === 'fonts' ? '/fonts' : `/libraries/${name}`;
  const paths = Object.keys(files);
  const strip = stripTopFolder(paths);
  inst.FS.mkdirTree(base);
  const createdDirs = new Set([base]);
  for (const [path, data] of Object.entries(files)) {
    const rel = path.slice(strip);
    if (!rel) continue;
    const full = `${base}/${rel}`;
    if (path.endsWith('/')) {
      const dir = full.replace(/\/$/, '');
      if (!createdDirs.has(dir)) { inst.FS.mkdirTree(dir); createdDirs.add(dir); }
    } else {
      const dir = full.slice(0, full.lastIndexOf('/'));
      if (dir && !createdDirs.has(dir)) { inst.FS.mkdirTree(dir); createdDirs.add(dir); }
      inst.FS.writeFile(full, data);
    }
  }
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type !== 'render') return;
  const { jobId, source, format, defines, backend, libNames } = msg;
  const log = (stream, line) => postMessage({ type: 'log', jobId, stream, line });

  try {
    const t0 = performance.now();

    const libs = [];
    for (const name of libNames || []) {
      const files = await getUnzippedLib(name);
      if (files) libs.push([name, files]);
      else log('err', `WARNING: library "${name}" not found in cache, skipping`);
    }

    const { default: OpenSCAD } = await import('../../vendor/openscad/openscad.js');
    const wasmModule = await getWasmModule();
    const inst = await OpenSCAD({
      noInitialRun: true,
      instantiateWasm: (imports, successCallback) => {
        WebAssembly.instantiate(wasmModule, imports).then(instance => successCallback(instance, wasmModule));
      },
      print: line => log('out', line),
      printErr: line => log('err', line),
    });

    for (const [name, files] of libs) mountLib(inst, name, files);
    inst.ENV.OPENSCADPATH = '/libraries';
    inst.FS.chdir('/');
    inst.FS.writeFile('/input.scad', source);

    const outPath = `/out.${FORMAT_EXT[format]}`;
    const argv = ['/input.scad', '-o', outPath, `--export-format=${format}`];
    if (format !== 'param') argv.push(`--backend=${backend || 'manifold'}`);
    for (const [name, value] of Object.entries(defines || {})) {
      argv.push('-D', `${name}=${value}`);
    }

    let exitCode = 0;
    try {
      exitCode = inst.callMain(argv) || 0;
    } catch (e) {
      if (typeof e === 'number' && inst.formatException) {
        throw new Error(inst.formatException(e));
      }
      // Emscripten ExitStatus carries the process exit code.
      if (e && typeof e.status === 'number') exitCode = e.status;
      else throw e;
    }

    let output = null;
    try {
      output = inst.FS.readFile(outPath);
    } catch {
      // no output file -> render failed even if exit code was 0
    }
    if (exitCode !== 0 || !output) {
      postMessage({ type: 'error', jobId, message: `OpenSCAD exited with code ${exitCode}`, exitCode });
      return;
    }

    const buf = output.buffer.byteLength === output.byteLength
      ? output.buffer
      : output.slice().buffer;
    postMessage({ type: 'done', jobId, output: buf, elapsedMs: performance.now() - t0 }, [buf]);
  } catch (e) {
    postMessage({ type: 'error', jobId, message: String(e && e.message || e), exitCode: -1 });
  }
};
