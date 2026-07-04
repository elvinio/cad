// AI chat orchestrator: the streaming turn loop (send()/stop()) and the
// DOM wiring (initChat()) that ties together chat/protocol.js (transport,
// SSE parsing, OpenAI-shape mapping), chat/tools.js (tool schemas + runTool),
// chat/ui.js (transcript rendering), and chat/sessions.js (persistence + the
// two history dialogs). Speaks the OpenAI chat-completions protocol (POST
// /v1/chat/completions, SSE streaming) against a Modal-hosted Gemma endpoint,
// reached through a small CORS+auth proxy (see modal/gemma_proxy.py). No SDK
// is vendored — the transport is a plain fetch + SSE parser, so the app still
// boots offline (chat itself needs the network).

import { getSettings, saveSettings, putChatImage } from './storage.js';
import { subscribe } from './state.js';
import { getCode } from './editor.js';
import { toast } from './ui.js';
import { getHistory, pushHistory, getLastCode, setLastCode } from './chat/session-state.js';
import {
  DEFAULT_SYSTEM_PROMPT, getSystemPrompt, buildSystemPrompt, availableLibsBlock, currentParamsBlock,
  getChatConfig, streamChatCompletion, isAbortError, toolResultToOpenAI,
} from './chat/protocol.js';
import { runTool } from './chat/tools.js';
import {
  $, addNote, setStatus, addBubble, setBubbleStats, renderMessageBody,
  addToolUseRow, addToolResultRow, describeToolUse,
  showPreview, copyPreview, getBusy, setBusy,
} from './chat/ui.js';
import {
  persistCurrentSession, newChat, clearCurrentChat, loadSession, onProjectChanged,
  renderHistoryList, renderAllChatsList, deleteAllChatHistory,
} from './chat/sessions.js';

// Conversation state (history, lastCodeSeenByModel) lives in
// chat/session-state.js — shared with tool handlers and session persistence.
// A "session" is one conversation. It lives in memory there and is persisted
// (per project, text-only) to IndexedDB after every turn so it survives
// reloads and project switches — letting you resume an iteration later.
// busy lives in chat/ui.js (getBusy/setBusy); this orchestrator reads/writes
// it through those instead of a local module variable.

// Tool-loop control: stopRequested is set by the Stop button; activeController is
// the in-flight request's AbortController so Stop can abort the current reply.
let stopRequested = false;
let activeController = null;

// ---------- send ----------

// Stop the current reply: abort the in-flight request and break the loop after
// the current step finishes.
function stop() {
  if (!getBusy()) return;
  stopRequested = true;
  setStatus('Stopping…');
  activeController?.abort();
}

async function send() {
  const input = $('chat-input');
  const prompt = input.value.trim();
  if (!prompt || getBusy()) return;

  const settings = getSettings();
  let config;
  try {
    config = getChatConfig();
  } catch (e) {
    toast(e.message, 'error');
    return;
  }

  stopRequested = false;
  setBusy(true);
  input.value = '';
  input.style.height = '';

  // Full code + params go out ONCE, on the first turn of the conversation. After
  // that the model reads/edits through tools. On later turns we don't resend the
  // code; if the user edited the editor since the model last read it, we just
  // tell it so it knows to read_code again (the "dirty" signal).
  let userText = prompt;
  if (getHistory().length === 0) {
    const code = getCode();
    userText = `<current_code>\n${code}\n</current_code>${currentParamsBlock()}${availableLibsBlock()}\n\n${prompt}`;
    setLastCode(code);
  } else if (getCode() !== getLastCode()) {
    userText = `${prompt}\n\n[The editor code has changed since you last read it — call read_code before editing.]`;
  }
  const userTs = Date.now();
  pushHistory({ role: 'user', content: userText, ts: userTs });

  addBubble('user', prompt, { ts: userTs });

  // Working message list for the API: the system prompt first, then history
  // (text-only). Tool round-trips (including look images) for THIS send are
  // appended here, not persisted.
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...getHistory().map(m => ({ role: m.role, content: m.content })),
  ];

  const maxTurns = Math.max(1, Number(settings.chatMaxTurns) || 100);
  const startedAt = Date.now();
  const assistantTextParts = [];
  const steps = []; // full trace (text + tool_use + tool_result) for history replay
  let totalIn = 0, totalOut = 0;
  let turnsUsed = 0;
  let lastMeta = null;
  let lastStop = null;
  let failed = false;

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (stopRequested) break;

      setStatus('Thinking…');
      const assistantBubble = addBubble('assistant', '…');
      const assistantBody = assistantBubble.querySelector('.chat-msg-body');

      // The self-hosted endpoint can cold-start for up to ~5 minutes if it has
      // scaled to zero; fetch() has no default timeout, but without this the
      // "Thinking…" status looks identical whether it's about to fail or just
      // warming up, which makes people bail (close the tab / hit Stop) early.
      const coldStartTimer = setTimeout(
        () => setStatus('Still waking up the model… cold start can take a few minutes'),
        12000);

      activeController = new AbortController();
      let accumulated = '';
      let final;
      try {
        final = await streamChatCompletion({
          config,
          messages,
          signal: activeController.signal,
          onText: (delta) => {
            if (!accumulated) { clearTimeout(coldStartTimer); setStatus('Thinking…'); }
            accumulated += delta;
            renderMessageBody(assistantBody, accumulated);
            $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
          },
        });
      } catch (e) {
        if (isAbortError(e)) { if (!accumulated) assistantBubble.remove(); break; }
        throw e;
      } finally {
        clearTimeout(coldStartTimer);
        activeController = null;
      }

      const text = final.text;
      turnsUsed += 1;
      totalIn += final.usage?.prompt_tokens || 0;
      totalOut += final.usage?.completion_tokens || 0;
      lastMeta = {
        model: settings.chatModel,
        durationMs: Date.now() - startedAt,
        turns: turnsUsed,
        usage: { input_tokens: totalIn, output_tokens: totalOut },
      };
      lastStop = final.finishReason;

      if (text) {
        renderMessageBody(assistantBody, text);
        setBubbleStats(assistantBubble, lastMeta);
        assistantTextParts.push(text);
        steps.push({ type: 'text', text, ts: Date.now(), meta: lastMeta });
      } else {
        assistantBubble.remove();
      }

      // Replay the assistant turn (text + any tool calls) so the next request
      // continues the same tool exchange.
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(final.toolCalls.length ? {
          tool_calls: final.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        } : {}),
      });

      if (final.finishReason === 'tool_calls' && final.toolCalls.length) {
        for (const tc of final.toolCalls) {
          let input;
          try { input = JSON.parse(tc.arguments || '{}'); } catch { input = {}; }
          const block = { name: tc.name, input, id: tc.id };
          const { summary, code } = describeToolUse(block.name, block.input);
          addToolUseRow(block.name, summary, { code });
          steps.push({ type: 'tool_use', name: block.name, input: block.input, summary, code });

          const content = await runTool(block);

          const resultText = content.filter(b => b.type === 'text').map(b => b.text).join('\n') || '(no output)';
          const imgBlock = content.find(b => b.type === 'image');
          let imageId = null;
          if (imgBlock) {
            imageId = crypto.randomUUID();
            await putChatImage(imageId, imgBlock.source.media_type, imgBlock.source.data);
          } else {
            addToolResultRow(resultText);
          }
          steps.push({
            type: 'tool_result', name: block.name, text: resultText, imageId,
            imageLabel: imageId ? (content.imageLabel || 'View render') : null,
          });

          messages.push(...toolResultToOpenAI(tc.id, content));
        }
        continue; // let the model inspect the results and decide what's next
      }

      break; // stop: the model is done
    }

    if (lastStop === 'tool_calls' && !stopRequested) {
      addNote(`Stopped at the ${maxTurns}-turn limit. Send another message to let the AI continue, `
        + 'or raise the limit on the toolbar.');
    }
  } catch (e) {
    failed = true;
    addNote(`Request failed: ${e.message}`, true);
    // Nothing applied and no reply text: drop the user turn so a retry resends
    // it (with <current_code>) cleanly.
    if (!assistantTextParts.length) {
      getHistory().pop();
      setLastCode(null);
    }
  } finally {
    setStatus(null);
    setBusy(false);
    activeController = null;
  }

  if (!failed && (assistantTextParts.length || steps.length)) {
    pushHistory({
      role: 'assistant',
      content: assistantTextParts.join('\n\n') || '(no reply text — see tool calls)',
      ts: Date.now(),
      meta: lastMeta,
      steps,
    });
  }
  persistCurrentSession();
}

// ---------- init ----------

export function initChat() {
  const input = $('chat-input');
  // The send button doubles as a Stop button while a reply is in flight.
  $('chat-send-btn').addEventListener('click', () => (getBusy() ? stop() : send()));
  $('chat-clear-btn').addEventListener('click', newChat);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      // Shift+Enter / Ctrl+Enter / Cmd+Enter: insert a newline at the caret
      // instead of the browser's default (which would append at the end).
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value } = input;
      input.value = value.slice(0, s) + '\n' + value.slice(en);
      input.selectionStart = input.selectionEnd = s + 1;
      input.dispatchEvent(new Event('input'));
      return;
    }
    e.preventDefault();
    if (!getBusy()) send();
  });
  // Auto-grow the input up to ~5 lines.
  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  // A different project resumes that project's most recent conversation.
  subscribe('project:changed', onProjectChanged);

  // ----- Chat panel toolbar (model + preview + history) -----
  const settings = getSettings();
  $('chat-model').value = settings.chatModel;
  $('chat-model').addEventListener('change', e =>
    saveSettings({ chatModel: e.target.value }));
  $('chat-max-turns').value = String(settings.chatMaxTurns);
  $('chat-max-turns').addEventListener('change', e =>
    saveSettings({ chatMaxTurns: Number(e.target.value) || 10 }));
  $('chat-preview-btn').addEventListener('click', showPreview);
  $('chat-preview-copy').addEventListener('click', copyPreview);
  $('chat-code-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('chat-code-content').textContent);
      toast('Code copied to clipboard');
    } catch (e) {
      toast(`Copy failed: ${e.message}`, 'error');
    }
  });
  $('chat-history-btn').addEventListener('click', async () => {
    await renderHistoryList();
    $('chat-history-dialog').showModal();
  });
  $('chat-delete-btn')?.addEventListener('click', clearCurrentChat);

  // ----- Chat settings dialog -----
  $('set-modal-url').value = settings.modalBaseUrl;
  $('set-modal-url').addEventListener('change', e =>
    saveSettings({ modalBaseUrl: e.target.value.trim() }));
  $('set-modal-key').value = settings.modalApiKey;
  $('set-modal-key').addEventListener('change', e =>
    saveSettings({ modalApiKey: e.target.value.trim() }));
  $('chat-set-system').value = getSystemPrompt();

  $('chat-set-system').addEventListener('change', e => {
    const text = e.target.value.trim();
    // Storing null keeps the prompt tracking future default updates.
    saveSettings({ chatSystemPrompt: text && text !== DEFAULT_SYSTEM_PROMPT ? text : null });
  });
  $('chat-set-system-reset').addEventListener('click', () => {
    saveSettings({ chatSystemPrompt: null });
    $('chat-set-system').value = DEFAULT_SYSTEM_PROMPT;
    toast('System prompt reset to default');
  });

  $('menu-chat-settings').addEventListener('click', () => {
    $('menu-dialog').close();
    $('chat-settings-dialog').showModal();
  });

  // ----- All chat histories (every project) -----
  $('menu-all-chats').addEventListener('click', async () => {
    $('menu-dialog').close();
    await renderAllChatsList();
    $('all-chats-dialog').showModal();
  });
  $('all-chats-delete-all').addEventListener('click', deleteAllChatHistory);
}
