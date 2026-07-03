// Tiny pub/sub event bus. ALL cross-module communication goes through this.
//
// The topic list and payload shapes are the contract in js/topics.js — read
// that file before adding a new emit()/subscribe() call. This module only
// implements the mechanics (listener registry + optional unknown-topic
// warning); it deliberately does not hardcode the topic list itself.

import { KNOWN_TOPICS } from './topics.js';

const listeners = new Map();

const DEBUG_KEY = 'scadpad.debugEventBus';
let debug = false;
try { debug = localStorage.getItem(DEBUG_KEY) === '1'; } catch { /* storage disabled */ }

// Toggle the unknown-topic warning at runtime (e.g. from devtools, or test
// harnesses that want every emit() checked against topics.js for the run).
export function setDebugEventBus(on) {
  debug = !!on;
  try { localStorage.setItem(DEBUG_KEY, debug ? '1' : '0'); } catch { /* storage disabled */ }
}

export function subscribe(topic, fn) {
  if (debug && !KNOWN_TOPICS.has(topic)) {
    console.warn(`[event-bus] subscribe() to unknown topic "${topic}" — add it to TOPICS in js/topics.js`);
  }
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic).delete(fn);
}

export function emit(topic, payload) {
  if (debug && !KNOWN_TOPICS.has(topic)) {
    console.warn(`[event-bus] emit() on unknown topic "${topic}" — add it to TOPICS in js/topics.js`);
  }
  const set = listeners.get(topic);
  if (!set) return;
  for (const fn of set) {
    try { fn(payload); } catch (e) { console.error(`listener for ${topic} failed`, e); }
  }
}
