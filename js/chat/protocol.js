// Chat transport: request config, the SSE streaming parser, and the shaping
// of outgoing messages (system prompt, tool schemas in OpenAI shape, tool
// results back to the model). No UI, no tool execution — those live in
// chat/tools.js, chat/ui.js, and the send()/stop() orchestrator in chat.js.

import { getSettings } from '../storage.js';
import { getParamValues, getParamSchema } from '../customizer.js';
import { CURATED } from '../libraries.js';
import { TOOLS, CORE_BOSL2 } from './tools.js';

export const DEFAULT_SYSTEM_PROMPT =
`You are an expert CAD designer working inside ScadPad, a mobile OpenSCAD editor. You edit the user's OpenSCAD code through tools, the way a coding assistant edits a file. The current code and Customizer parameters are given once, in <current_code> and <current_params> tags, at the start of the conversation.

Tools:
- read_code: read the current editor code, optionally a line range. Lines come back numbered. The code may have changed since you last saw it (the user can edit too) — if a message tells you the code changed, or before any edit you're unsure about, call read_code first to get fresh line numbers.
- edit_code: replace an inclusive line range (start_line..end_line) with new_text. Line numbers MUST match the latest read_code; if the code changed since your last read the edit is rejected and you must read_code again.
- write_code: replace the WHOLE file. Use for new models from scratch or large rewrites.
- get_params / set_params: read the Customizer parameters and change their values. Parameters are top-level variables that drive the geometry; changing them re-renders the model and is usually better than hard-coding numbers into the code.
- look: render and return a 2×2 image of the model — ISO (corner), FRONT (-Y), RIGHT (+X), TOP (down -Z) — in OpenSCAD's Z-up frame. edit_code/write_code/set_params only report compile status and the bounding box as text; call look when you want to actually SEE the result. The image is perspective — judge sizes from the reported bounding box, not pixels. Use this first for a general check.
- look_at: one free-angle, full-resolution image for close-up inspection — pick any yaw/pitch and zoom in, instead of the four fixed corners of look. Also lets you switch to wireframe (see through to hidden edges/internal cavities) or ghost/translucent (see overlapping solids at once) for the shot. Use it after look when you need to check a specific feature look's quartered view is too small or the wrong angle for — e.g. a chamfer, a hole alignment, wall thickness, or whether two parts actually intersect.
- lookup_lib: search the installed BOSL2 library for the exact signature of a module or function (e.g. "rounded box", "gear", "screw thread"). Returns names, one-line synopses, usage signatures and argument names. Use it BEFORE calling a library module you're not 100% sure of — do not guess argument names.

Building blocks: you don't have to model everything from raw primitives. The libraries listed in <available_libraries> are pre-made parts you compose like Lego. Prefer them when one fits — especially BOSL2 (include <BOSL2/std.scad>) for rounded/chamfered shapes, attachments, gears, screws and threads. Only include a library that is actually listed in <available_libraries>; if the user wants something that needs a library that isn't installed, say so briefly instead of guessing. For the common cases, plain OpenSCAD primitives + CSG (cube/cylinder/sphere, union/difference/intersection/hull) are still the simplest choice.

Workflow: make a change with edit_code/write_code/set_params, read the text result; if it failed to compile, fix it; when you want to verify the shape, call look. When the model is right, stop and give a one- or two-sentence summary.

Rules:
- Prefer small edit_code edits over rewriting the whole file.
- Keep the code valid OpenSCAD (units are millimetres). Preserve the user's Customizer parameters (top-level variables with their // [min:max] annotations and // descriptions) unless asked to change them; tweak values with set_params rather than editing the annotations. For new models, expose the key dimensions as such top-level variables so the result is parametric.
- Don't guess library argument names — call lookup_lib first. Confirm a finished shape with look before declaring it done.
- Render results may include an "OpenSCAD messages" section — read it. Fix the cause of any WARNING/DEPRECATED (e.g. undefined variable, deprecated call) even if the model still compiled. Renders that fall back to the slower CGAL backend usually mean a pathological shape (e.g. hull() of many spheres at high $fn) — simplify it.
- Keep explanations brief — the user is on a phone.
- If a request is ambiguous, make a sensible choice and note it briefly rather than asking questions.`;

export function getSystemPrompt() {
  return getSettings().chatSystemPrompt || DEFAULT_SYSTEM_PROMPT;
}

// The editable base prompt plus install-dependent guidance that must apply even
// when the user has overridden the base prompt: the BOSL2 starter kit (only when
// BOSL2 is installed). Kept out of getSystemPrompt() so the settings textarea
// shows just the editable base and the kit can't be accidentally baked in.
export function buildSystemPrompt() {
  let prompt = getSystemPrompt();
  if (getSettings().installedLibs?.includes('BOSL2')) prompt += `\n\n${CORE_BOSL2}`;
  return prompt;
}

// A first-turn-only block listing the libraries the user has installed (name +
// what it's for + its include path) so the model knows what it may compose with.
export function availableLibsBlock() {
  const installed = getSettings().installedLibs || [];
  const include = name => name === 'fonts' ? 'use with text()' : `include <${name}/${name === 'BOSL2' ? 'std.scad' : '…'}>`;
  const lines = installed.map(name => {
    const desc = CURATED.find(c => c.name === name)?.desc || 'custom library';
    return `- ${name} — ${desc} (${include(name)})`;
  });
  const body = lines.length
    ? lines.join('\n')
    : '- (none installed — use only plain OpenSCAD primitives; tell the user to install a library from the Libraries menu if they need one)';
  return `\n\n<available_libraries>\n${body}\n</available_libraries>`;
}

// A <current_params> block listing each Customizer parameter's current value,
// sent once alongside <current_code> on the first turn (empty string if the
// model has no parameters). After that the model uses get_params/set_params.
export function currentParamsBlock() {
  const schema = getParamSchema();
  if (!schema.length) return '';
  const overrides = getParamValues();
  const lines = schema.map((p) => {
    const v = (p.name in overrides) ? overrides[p.name] : p.initial;
    return `${p.name} = ${JSON.stringify(v)}`;
  });
  return `\n\n<current_params>\n${lines.join('\n')}\n</current_params>`;
}

// Build the request config from settings (proxy URL + bearer key + model). The
// browser talks to the Modal proxy, which forwards to the Gemma auto endpoint.
export function getChatConfig() {
  const { modalBaseUrl, modalApiKey, chatModel } = getSettings();
  if (!modalBaseUrl) throw new Error('Set your Modal proxy URL in Chat settings.');
  if (!modalApiKey) throw new Error('Set your Modal API key in Chat settings.');
  return {
    url: modalBaseUrl.replace(/\/+$/, '') + '/v1/chat/completions',
    model: chatModel,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${modalApiKey}`,
    },
  };
}

// The tools in OpenAI function-calling shape (Anthropic input_schema maps 1:1
// onto OpenAI parameters). Computed per-call rather than cached at module
// load — cheap (8 entries), and avoids relying on TOOLS being initialized by
// the time this module's top level runs (tools.js is itself part of a
// chat.js <-> protocol.js <-> tools.js import cycle via addImageButton et al).
function getOpenAITools() {
  return TOOLS.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

// POST one chat-completion and consume the SSE stream. Calls onText(delta) as
// assistant text arrives; accumulates any tool calls (streamed in fragments,
// keyed by index) and the final usage. Returns
// { text, toolCalls:[{id,name,arguments}], finishReason, usage }.
export async function streamChatCompletion({ config, messages, signal, onText }) {
  const res = await fetch(config.url, {
    method: 'POST',
    headers: config.headers,
    signal,
    body: JSON.stringify({
      model: config.model,
      messages,
      tools: getOpenAITools(),
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finishReason = null;
  let usage = null;
  const toolCalls = []; // index -> { id, name, arguments }

  const handleEvent = (raw) => {
    // Each SSE event is one or more `data:` lines; collect their payloads.
    const data = raw.split('\n')
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim())
      .join('');
    if (!data || data === '[DONE]') return;
    let json;
    try { json = JSON.parse(data); } catch { return; }
    if (json.usage) usage = json.usage;
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (delta.content) { text += delta.content; onText?.(delta.content); }
    for (const tc of delta.tool_calls || []) {
      const i = tc.index ?? 0;
      const slot = toolCalls[i] || (toolCalls[i] = { id: '', name: '', arguments: '' });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.arguments += tc.function.arguments;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      handleEvent(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
    }
  }
  if (buffer.trim()) handleEvent(buffer);

  return { text, toolCalls: toolCalls.filter(Boolean), finishReason, usage };
}

export function isAbortError(e) {
  return e?.name === 'AbortError' || e?.name === 'APIUserAbortError' || /abort/i.test(e?.message || '');
}

// Convert a runTool() result (Anthropic content blocks) into the OpenAI messages
// that report it back to the model. Text always goes in the `tool` message; an
// image (only look/look_at return one) can't live in a `tool` message, so it's
// appended as a follow-up user message with an image_url part.
export function toolResultToOpenAI(callId, content) {
  const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n') || '(no output)';
  const msgs = [{ role: 'tool', tool_call_id: callId, content: text }];
  const img = content.find(b => b.type === 'image');
  if (img) {
    msgs.push({
      role: 'user',
      content: [
        { type: 'text', text: '(rendered image for the look tool result above)' },
        { type: 'image_url', image_url: { url: `data:${img.source.media_type};base64,${img.source.data}` } },
      ],
    });
  }
  return msgs;
}
