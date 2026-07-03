// Headless smoke test for the CLAUDE.md "checklist that must keep passing" plus
// known regression scenarios. No framework, no deps beyond Playwright (this repo
// keeps the no-build promise; Playwright is dev-only tooling, never shipped).
//
// Run:    node test/e2e.js
// Needs:  Playwright + a Chromium build. In the Claude Code sandbox both are
//         preinstalled (see CLAUDE.md "How to test"); elsewhere run
//         `npm i -D playwright && npx playwright install chromium` first, or
//         point E2E_CHROMIUM at a chrome/chromium binary.
//
// Each check is independent-ish but shares one browser context (like a human
// clicking through the app), except the very first ("fresh load") which needs
// its own private context to observe the true first-run state.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = process.env.E2E_PORT || 8799;
const BASE_URL = `http://localhost:${PORT}/`;
const CHROMIUM_PATH = process.env.E2E_CHROMIUM || '/opt/pw-browsers/chromium';

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const mod = await import('/opt/node22/lib/node_modules/playwright/index.js');
    return mod.default ?? mod;
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', ROOT, '--bind', '127.0.0.1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (chunk) => {
      if (/Serving HTTP/.test(chunk.toString())) {
        proc.stdout.off('data', onData);
        resolve(proc);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData); // http.server logs its startup line to stderr
    proc.on('error', reject);
    setTimeout(() => resolve(proc), 2000); // fallback if the log line format changes
  });
}

// Wait for the viewer overlay to show a fresh "rendered in ..." after clearing it.
async function waitForRender(page, { timeoutMs = 30000 } = {}) {
  await page.evaluate(() => { document.getElementById('viewer-overlay').textContent = ''; });
  return page.waitForFunction(
    () => document.getElementById('viewer-overlay')?.textContent.includes('rendered in'),
    { timeout: timeoutMs },
  );
}

async function setCode(page, code) {
  await page.evaluate((c) => {
    const editor = document.getElementById('editor');
    editor.value = c;
    editor.dispatchEvent(new Event('input'));
  }, code);
}

async function openMenuDialog(page, dialogId, menuBtnId) {
  await page.click('#menu-btn');
  await page.click(`#${menuBtnId}`);
  await page.waitForSelector(`#${dialogId}[open]`);
}

// ---- individual checks ----

async function checkFreshLoadIsEmpty(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(BASE_URL);
  await page.waitForSelector('#editor');
  const code = await page.inputValue('#editor');
  const overlay = await page.textContent('#viewer-overlay');
  await context.close();
  if (code !== '') throw new Error(`expected empty editor on first load, got: ${JSON.stringify(code)}`);
  if (overlay.includes('rendered in')) throw new Error('unexpected render before any edit');
}

async function checkEditTriggersRender(page) {
  await setCode(page, 'cube(10);');
  await waitForRender(page);
}

async function checkCustomizerReRenders(page) {
  await setCode(page, 'w = 10; // [1:50]\ncube([w, 10, 10]);');
  await waitForRender(page);
  await page.click('.tab[data-tab="customizer-view"]');
  await page.waitForSelector('#customizer-form input.param-field[type="number"]');
  const input = page.locator('#customizer-form input.param-field[type="number"]').first();
  await input.fill('25');
  await input.dispatchEvent('change');
  await waitForRender(page);
  await page.click('.tab[data-tab="code-view"]');
}

async function checkBosl2InstallAndRender(page) {
  await openMenuDialog(page, 'libraries-dialog', 'menu-libraries');
  const bosl2Row = page.locator('#libraries-list li', { hasText: 'BOSL2' });
  const checkbox = bosl2Row.locator('input[type="checkbox"]');
  if (!(await checkbox.isChecked())) {
    await checkbox.check();
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('#libraries-list li')];
      const row = rows.find(r => r.textContent.includes('BOSL2'));
      return row && !row.querySelector('input[type="checkbox"]').disabled;
    }, { timeout: 20000 });
  }
  await page.click('#libraries-dialog .close-btn');
  await setCode(page, 'include <BOSL2/std.scad>\ncuboid(20, rounding=3);');
  await waitForRender(page, { timeoutMs: 45000 });
  await page.click('.tab[data-tab="console-view"]');
  const log = await page.textContent('#log');
  await page.click('.tab[data-tab="code-view"]');
  if (/^ERROR/im.test(log)) throw new Error(`BOSL2 render logged an error:\n${log}`);
}

async function checkQualitySwitchReRenders(page) {
  await setCode(page, 'sphere(10, $fn=32);');
  await waitForRender(page);
  await page.click('#quality-toggle-btn');
  await waitForRender(page);
}

async function checkStlExportIsValid(page) {
  await setCode(page, 'cube(8);');
  await waitForRender(page);
  // Headless Chrome has showSaveFilePicker; drop it to exercise the <a download> path
  // (the picker itself can't be driven headlessly — see CLAUDE.md gotcha #7).
  await page.evaluate(() => { delete window.showSaveFilePicker; });
  await page.click('#export-btn');
  await page.waitForSelector('#export-dialog[open]');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-device'),
  ]);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  if (buf.length < 84) throw new Error(`STL too short: ${buf.length} bytes`);
  const triCount = buf.readUInt32LE(80);
  const expected = 84 + 50 * triCount;
  if (buf.length !== expected) {
    throw new Error(`STL length mismatch: got ${buf.length}, expected ${expected} (triCount=${triCount})`);
  }
}

async function checkOfflineReloadStillRenders(page) {
  await setCode(page, 'cylinder(h=10, r=5, $fn=24);');
  await waitForRender(page);
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 20000 })
    .catch(() => { throw new Error('service worker never took control — is it registered?'); });
  await page.context().setOffline(true);
  try {
    await page.reload();
    await page.waitForSelector('#editor');
    await waitForRender(page, { timeoutMs: 20000 });
  } finally {
    await page.context().setOffline(false);
  }
}

// Regression: viewer.js used to emit render:log with a bare string; ui.js
// destructures {stream, line}, so failures printed as literal "undefined".
async function checkAssemblyRenderLogPayload(page) {
  await openMenuDialog(page, 'projects-dialog', 'menu-projects');
  page.once('dialog', d => d.accept('e2e-assembly'));
  await page.click('#new-assembly-btn');
  await page.waitForFunction(() => document.body.classList.contains('mode-assembly'), { timeout: 10000 });

  await page.evaluate(async () => {
    const { listAssemblies, saveAssembly } = await import('/js/storage.js');
    const a = listAssemblies().sort((x, y) => y.modified - x.modified)[0];
    a.parts.push({
      id: crypto.randomUUID(), name: 'ghost-part', visible: true, color: '#cccccc',
      source: { type: 'scad', projectId: 'nonexistent-id', overrides: {} },
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    });
    saveAssembly(a);
  });

  await openMenuDialog(page, 'projects-dialog', 'menu-projects');
  await page.click('#assemblies-list li:has-text("e2e-assembly") button.p-open');
  await page.waitForTimeout(600);

  await page.click('.tab[data-tab="console-view"]');
  const log = await page.textContent('#log');
  if (log.includes('undefined')) throw new Error(`render:log printed literal "undefined":\n${log}`);
  if (!log.includes('project not found')) throw new Error(`expected readable assembly warning, got:\n${log}`);
}

// Regression: deleting the active assembly used to leave body.mode-assembly
// set and stale part meshes on screen with no way back except opening a project.
async function checkDeleteActiveAssemblyExitsAssemblyMode(page) {
  const inAssembly = await page.evaluate(() => document.body.classList.contains('mode-assembly'));
  if (!inAssembly) throw new Error('setup assumption failed: expected to already be in assembly mode');

  await openMenuDialog(page, 'projects-dialog', 'menu-projects');
  page.once('dialog', d => d.accept());
  await page.click('#assemblies-list li:has-text("e2e-assembly") button[title="Delete"]');
  await page.waitForTimeout(600);

  const stillAssembly = await page.evaluate(() => document.body.classList.contains('mode-assembly'));
  if (stillAssembly) throw new Error('mode-assembly still set after deleting the active assembly');
}

// Chat sessions live in IndexedDB (`chatsessions` store), not localStorage —
// exercise storage.js's API directly (no live Modal endpoint needed) since
// the AI Chat flow itself is skipped in this sandbox.
async function checkChatSessionsInIndexedDb(page) {
  const result = await page.evaluate(async () => {
    const storage = await import('./js/storage.js');
    const projectId = 'e2e-chat-project';
    const otherProjectId = 'e2e-chat-other';
    // Cap: saving 25 sessions for one project should prune to the most
    // recent 20 (storage.js MAX_CHAT_SESSIONS).
    for (let i = 0; i < 25; i++) {
      await storage.saveChatSession(projectId, {
        id: `s${i}`, title: `session ${i}`, messages: [{ role: 'user', content: `hi ${i}` }],
      });
      await new Promise(r => setTimeout(r, 1)); // distinct `updated` timestamps
    }
    await storage.saveChatSession(otherProjectId, { id: 'other-1', title: 'other', messages: [] });

    const sessions = await storage.getChatSessions(projectId);
    const newestFirst = sessions.every((s, i) => i === 0 || s.updated <= sessions[i - 1].updated);
    const newestId = sessions[0]?.id;

    await storage.deleteChatSession(projectId, newestId);
    const afterDelete = await storage.getChatSessions(projectId);

    const groups = await storage.getAllChatSessions();
    const group = groups.find(g => g.projectId === projectId);
    const otherGroup = groups.find(g => g.projectId === otherProjectId);

    // Cleanup so this check doesn't leak state into later checks/runs.
    for (const s of await storage.getChatSessions(projectId)) await storage.deleteChatSession(projectId, s.id);
    for (const s of await storage.getChatSessions(otherProjectId)) await storage.deleteChatSession(otherProjectId, s.id);

    const legacyKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('scadpad.chat.')) legacyKeys.push(k);
    }

    return {
      cappedAt20: sessions.length === 20,
      newestFirst,
      deletedOneRemains19: afterDelete.length === 19 && !afterDelete.some(s => s.id === newestId),
      groupFound: !!group && group.sessions.length === 19,
      otherGroupIsolated: !!otherGroup && otherGroup.sessions.length === 1 && otherGroup.sessions[0].id === 'other-1',
      noLegacyLocalStorageKeys: legacyKeys.length === 0,
    };
  });
  for (const [key, ok] of Object.entries(result)) {
    if (!ok) throw new Error(`chat session storage check failed: ${key} — ${JSON.stringify(result)}`);
  }
}

// Regression: a v3 -> v4 IndexedDB upgrade must migrate any legacy
// `scadpad.chat.<projectId>` localStorage arrays into the `chatsessions`
// store and then remove the localStorage keys, instead of silently
// dropping saved conversations on first load after the update.
async function checkChatSessionsMigrateFromLocalStorage(browser) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem('scadpad.chat.migrate-me', JSON.stringify([
      { id: 'legacy-1', title: 'legacy chat', messages: [{ role: 'user', content: 'hello' }], created: 1, updated: 1 },
    ]));
  });
  const page = await context.newPage();
  await page.goto(BASE_URL);
  await page.waitForSelector('#editor');
  const result = await page.evaluate(async () => {
    const storage = await import('./js/storage.js');
    // Give the IDB upgrade transaction a moment to commit (it runs on the
    // first openDb() call, which happens as soon as the module is used).
    let sessions = await storage.getChatSessions('migrate-me');
    for (let i = 0; i < 20 && sessions.length === 0; i++) {
      await new Promise(r => setTimeout(r, 50));
      sessions = await storage.getChatSessions('migrate-me');
    }
    return {
      migrated: sessions.length === 1 && sessions[0].id === 'legacy-1',
      legacyKeyRemoved: localStorage.getItem('scadpad.chat.migrate-me') === null,
    };
  });
  await context.close();
  if (!result.migrated) throw new Error(`legacy chat session was not migrated into IndexedDB: ${JSON.stringify(result)}`);
  if (!result.legacyKeyRemoved) throw new Error('legacy localStorage chat key was not removed after migration');
}

const CHECKS = [
  ['fresh load starts with empty code, no render', checkFreshLoadIsEmpty, { freshContext: true }],
  ['edit triggers a render', checkEditTriggersRender],
  ['customizer field change re-renders', checkCustomizerReRenders],
  ['BOSL2 install + include renders', checkBosl2InstallAndRender],
  ['quality toggle re-renders', checkQualitySwitchReRenders],
  ['STL export is a valid binary STL', checkStlExportIsValid],
  ['offline reload after SW install still renders', checkOfflineReloadStillRenders],
  ['assembly render:log uses {stream,line} payload (regression)', checkAssemblyRenderLogPayload],
  ['deleting the active assembly exits assembly mode (regression)', checkDeleteActiveAssemblyExitsAssemblyMode],
  ['chat sessions live in IndexedDB, capped and grouped per project', checkChatSessionsInIndexedDb],
  ['legacy localStorage chat sessions migrate into IndexedDB (regression)', checkChatSessionsMigrateFromLocalStorage, { freshContext: true }],
];

async function main() {
  const server = await startServer();
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  // Run with the event-bus debug flag on so any emit()/subscribe() using a
  // topic missing from js/topics.js (typo, or a new topic nobody registered)
  // surfaces as a console warning below instead of silently passing.
  await context.addInitScript(() => localStorage.setItem('scadpad.debugEventBus', '1'));
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error('  [pageerror]', err.message));
  const busWarnings = [];
  page.on('console', (msg) => {
    if (msg.type() === 'warning' && msg.text().startsWith('[event-bus]')) busWarnings.push(msg.text());
  });
  await page.goto(BASE_URL);
  await page.waitForSelector('#editor');

  const results = [];
  for (const [name, fn, opts] of CHECKS) {
    try {
      if (opts?.freshContext) await fn(browser);
      else await fn(page);
      results.push([name, true, null]);
      console.log(`PASS  ${name}`);
    } catch (e) {
      results.push([name, false, e]);
      console.log(`FAIL  ${name}`);
      console.log(`      ${e.message}`);
    }
  }

  const busCheckName = 'event bus: no emit()/subscribe() on a topic missing from js/topics.js';
  if (busWarnings.length) {
    results.push([busCheckName, false, new Error(busWarnings.join('\n'))]);
    console.log(`FAIL  ${busCheckName}`);
    for (const w of busWarnings) console.log(`      ${w}`);
  } else {
    results.push([busCheckName, true, null]);
    console.log(`PASS  ${busCheckName}`);
  }

  console.log('\nAI Chat (write/read code, tool loop) is SKIPPED — needs a live Modal endpoint,');
  console.log('which is unreachable from this sandbox. Test manually in a real browser per CLAUDE.md.');

  await browser.close();
  server.kill();

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('e2e harness crashed:', e);
  process.exit(1);
});
