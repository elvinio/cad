// Tiny pub/sub event bus. Topics in use:
//   project:changed   {project}            active project switched or renamed
//   code:changed      {code}               editor content changed
//   params:extracted  {parameterSet}       customizer schema from --export-format=param
//   params:changed    {}                   a customizer value changed
//   render:start      {}
//   render:done       {offText, elapsedMs}
//   render:error      {message}
//   settings:changed  {settings}
//   libs:changed      {}

const listeners = new Map();

export function subscribe(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic).delete(fn);
}

export function emit(topic, payload) {
  const set = listeners.get(topic);
  if (!set) return;
  for (const fn of set) {
    try { fn(payload); } catch (e) { console.error(`listener for ${topic} failed`, e); }
  }
}
