// Event bus contract: every topic that crosses module boundaries through
// js/state.js, with a JSDoc payload shape for each. This is the ONE place to
// add a topic before emitting/subscribing to it — state.js's emit() warns
// (behind a debug flag) if a topic isn't listed in TOPICS below, so a typo'd
// name or a shape drift (e.g. `{stream,line}` vs a bare string) surfaces at
// the first keystroke instead of as a silent `undefined` deep in a listener.
//
// Enable the warning: `localStorage.setItem('scadpad.debugEventBus', '1')`
// then reload, or call setDebugEventBus(true) from the console. test/e2e.js
// runs with it on for the whole suite.
//
// Adding a topic: add the constant below, add its payload typedef, emit/
// subscribe using the constant (not a raw string) so a rename can't drift.

/** @typedef {{project: object}} ProjectChangedPayload project = the Project record from storage.js (id, name, code, paramValues, modified, driveFileId) */
/** @typedef {{code: string, immediate?: boolean}} CodeChangedPayload immediate=true skips the 800ms debounce (paste-a-whole-project, AI chat edits) */
/** @typedef {{parameters: ParamDef[]}} ParamsExtractedPayload the raw --export-format=param ParameterSet JSON, NOT wrapped in another object */
/** @typedef {{name: string, type: string, initial: *, min?: number, max?: number, step?: number, options?: *[], caption?: string, group?: string}} ParamDef */
/** @typedef {{}} ParamsChangedPayload */
/** @typedef {{}} RenderStartPayload */
/** @typedef {{stream: 'out'|'err', line: string}} RenderLogPayload NEVER a bare string — see test/e2e.js checkAssemblyRenderLogPayload (bug #1) */
/** @typedef {{offText?: string, elapsedMs: number}} RenderDonePayload offText is absent on the STL-export render (renderExport() has no OFF to hand the viewer) */
/** @typedef {{offText: string}} RenderHighlightPayload `#`-highlighted geometry overlay; follows render:done when the source has a highlight modifier */
/** @typedef {{message: string}} RenderErrorPayload */
/** @typedef {{settings: object}} SettingsChangedPayload full settings object from storage.js getSettings() */
/** @typedef {{}} LibsChangedPayload */
/** @typedef {{triangles: number, size: [number, number, number]}} ViewerStatsPayload */
/** @typedef {{assembly: object}} AssemblyActivePayload assembly = the Assembly record (id, name, clearance, parts[]) */
/** @typedef {{assembly: object}} AssemblyPartsChangedPayload */
/** @typedef {{clearance: number}} AssemblyClearanceChangedPayload */
/** @typedef {{id: string|null}} PartSelectPayload command: viewer, attach the gizmo to this part (null detaches) */
/** @typedef {{id: string|null}} PartSelectedPayload event: viewport raycast picked this part (null = picked empty space) */
/** @typedef {{id: string, transform: PartTransform}} PartMovedPayload */
/** @typedef {{pos: [number,number,number], rot: [number,number,number], scale: number}} PartTransform */
/** @typedef {{pairs: FitPair[]}} FitUpdatedPayload */
/** @typedef {{a: string, b: string, clash: boolean, gap?: number}} FitPair gap is only set when !clash */
/** @typedef {{text: string|null}} MeasureUpdatedPayload null clears the readout */

export const TOPICS = Object.freeze({
  PROJECT_CHANGED: 'project:changed',
  CODE_CHANGED: 'code:changed',
  PARAMS_EXTRACTED: 'params:extracted',
  PARAMS_CHANGED: 'params:changed',
  RENDER_START: 'render:start',
  RENDER_LOG: 'render:log',
  RENDER_DONE: 'render:done',
  RENDER_HIGHLIGHT: 'render:highlight',
  RENDER_ERROR: 'render:error',
  SETTINGS_CHANGED: 'settings:changed',
  LIBS_CHANGED: 'libs:changed',
  VIEWER_STATS: 'viewer:stats',
  ASSEMBLY_ACTIVE: 'assembly:active',
  ASSEMBLY_PARTS_CHANGED: 'assembly:parts-changed',
  ASSEMBLY_CLEARANCE_CHANGED: 'assembly:clearance-changed',
  PART_SELECT: 'part:select',
  PART_SELECTED: 'part:selected',
  PART_MOVED: 'part:moved',
  FIT_UPDATED: 'fit:updated',
  MEASURE_UPDATED: 'measure:updated',
});

export const KNOWN_TOPICS = new Set(Object.values(TOPICS));
