// Shared in-memory state for the active chat turn: the message history sent
// to the model, and the exact code string the model last read or wrote.
// Read/written by chat.js's send() orchestrator, chat/tools.js's edit/read
// handlers, and chat/sessions.js's persistence + session-switch logic — none
// of them owns this state exclusively, so it lives here rather than in any
// one of them. Mirrors the plain getter/setter pattern editor.js already uses
// for getCode()/setCode().

let history = [];
// The exact code string the model last read or wrote. The model's view is
// "dirty" whenever getCode() !== this (the user edited the editor since): the
// caller then sends nothing but a note telling it to read_code, and rejects
// line-based edit_code calls until it does.
let lastCodeSeenByModel = null;

// Returns the live array (not a copy) — callers may call array mutators
// (`.push()`, `.pop()`) directly on the result, same as before the split.
export function getHistory() {
  return history;
}
export function setHistory(h) {
  history = h;
}
export function pushHistory(entry) {
  history.push(entry);
}

export function getLastCode() {
  return lastCodeSeenByModel;
}
export function setLastCode(code) {
  lastCodeSeenByModel = code;
}
