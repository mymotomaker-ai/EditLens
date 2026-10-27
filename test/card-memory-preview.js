'use strict';
require('./isolate');
// Cards removed from the panel (it keeps its newest 250 items) are let go with all their data: after
// hundreds of edits, the removed edit cards the page still keeps (counted with Chrome's object query
// after garbage collection) stay few, and do not grow with more edits.
// usage: NODE_PATH=$(npm root -g) node test/card-memory-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: card-memory-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-card-memory-'));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '5243' });
const { ensureServer, stopServer, postEvent, postJson } = require('../lib/client');
const { launch } = require('./launch');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The strings on a heap snapshot that match, leaving out those kept only by the engine: V8's string
// tables, and a function's inline cache (a FeedbackVector, which keeps the last few property names
// the function looked up, at random). Those are not the page's data.
function pageStrings(snap, match) {
  const m = snap.snapshot.meta;
  const N = m.node_fields.length;
  const E = m.edge_fields.length;
  const [T, NAME, EC] = ['type', 'name', 'edge_count'].map((f) => m.node_fields.indexOf(f));
  const [ET, TO] = ['type', 'to_node'].map((f) => m.edge_fields.indexOf(f));
  const types = m.node_types[0];
  const weak = m.edge_types[0].indexOf('weak');
  const { nodes, edges, strings } = snap;
  const name = (i) => strings[nodes[i * N + NAME]];
  const isString = (i) => /string/.test(types[nodes[i * N + T]]);
  // The nodes that keep each node in want (node index -> list of node indexes).
  const holders = (want) => {
    const out = new Map([...want].map((i) => [i, []]));
    for (let i = 0, e = 0; i < nodes.length / N; i++) {
      for (const end = e + nodes[i * N + EC]; e < end; e++) {
        const to = edges[e * E + TO] / N;
        if (out.has(to) && edges[e * E + ET] !== weak) out.get(to).push(i);
      }
    }
    return out;
  };
  const found = new Set();
  for (let i = 0; i < nodes.length / N; i++) if (isString(i) && match(name(i))) found.add(i);
  const first = holders(found);
  const ENGINE = new Set(['system / FeedbackVector', '(Internalized strings)', '(External strings)']);
  const arrays = new Set([...first.values()].flat().filter((h) => !ENGINE.has(name(h))));
  const second = holders(arrays);
  const engineOnly = (h) => ENGINE.has(name(h)) || (second.get(h).length > 0 && second.get(h).every((g) => name(g) === 'system / FeedbackVector'));
  return [...new Set([...found].filter((i) => !first.get(i).every(engineOnly)).map(name))];
}
let n = 0;
// Claude creates a new file: its card has Remove file.
async function edits(count) {
  for (let i = 0; i < count; i++) {
    const rel = `src/f${++n}.js`;
    await postEvent({ type: 'change', sessionId: 's1', cwd: proj, file: path.join(proj, rel), relFile: rel, tool: 'Write', kind: 'frontend',
      created: true, before: '', after: `export const f${n} = ${n};\n`, hunks: [{ oldStart: 0, newStart: 1, lines: [`+export const f${n} = ${n};`] }],
      stats: { added: 1, removed: 0 }, intent: 'Add f' + n, ts: Date.now() });
  }
}

const page = `<!doctype html><title>App</title><body style="font:16px system-ui;margin:40px"><h1>App</h1>
<script src="http://127.0.0.1:5243/live.js" data-root="${proj}" data-panel="open"></script></body>`;

(async () => {
  await stopServer();
  await ensureServer();
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    const pg = await ctx.newPage();
    const errors = [];
    pg.on('pageerror', (e) => errors.push(e.message));
    await pg.goto(`http://127.0.0.1:${site.address().port}/`);
    await pg.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
    await sleep(800);
    // Sol L7: a pinned subagent stays listed after it finishes, past the 50 finished ones kept.
    const chat = (role, extra) => postEvent({ type: 'chat', role, cwd: proj, ts: Date.now(), ...extra });
    const rows = () => pg.evaluate(`[...${ROOT}.querySelectorAll('.arow')].map((x) => x.querySelector('b').textContent)`);
    await chat('agent-start', { toolUseId: 'toolu_pin', agentId: 'pin1', agentType: 'Explore', description: 'Pin me' });
    await pg.waitForFunction(`[...${ROOT}.querySelectorAll('.asw .arow b')].some((b) => b.textContent === 'Pin me')`, null, { timeout: 10000 });
    await pg.evaluate(`[...${ROOT}.querySelectorAll('.asw .arow')].find((x) => x.querySelector('b').textContent === 'Pin me').click()`);
    await sleep(300);
    const pinned = await pg.evaluate(`(() => { const b = [...${ROOT}.querySelectorAll('.arow.act .ra button')].find((x) => x.textContent === 'Pin'); if (!b) return false; b.click(); return true; })()`);
    // Back to Main, so the pinned one is not kept for being followed.
    await pg.evaluate(`[...${ROOT}.querySelectorAll('.arow')].find((x) => x.querySelector('b').textContent === 'Main').click()`);
    await sleep(300);
    await chat('agent-done', { toolUseId: 'toolu_pin', agentId: 'pin1', status: 'completed', text: 'ok', toolCount: 1, durationMs: 10 });
    for (let i = 0; i < 52; i++) {
      await chat('agent-start', { toolUseId: 'toolu_x' + i, agentId: 'x' + i, agentType: 'Explore', description: 'Look ' + i });
      await chat('agent-done', { toolUseId: 'toolu_x' + i, agentId: 'x' + i, status: 'completed', text: 'ok', toolCount: 1, durationMs: 10 });
    }
    await sleep(900);
    const listed = await rows();
    check('Sol L7: past 50 finished subagents, the pinned one stays listed', pinned && listed.includes('Pin me'), { pinned, first: listed.slice(0, 3) });
    // Sol M10: subagents with an edit sent before their start (counted under "a:<id>"), a read
    // (a Follow position), a permission mode from the hooks and a color. All are removed with them.
    for (let i = 0; i < 6; i++) {
      const id = 'agGoneZq' + i;
      const tu = 'toolu_goneZq' + i;
      const rel = `src/gone${i}.js`;
      await postEvent({ type: 'change', sessionId: 's1', cwd: proj, agentId: id, file: path.join(proj, rel), relFile: rel, tool: 'Write', kind: 'frontend', created: true,
        before: '', after: 'export {};\n', hunks: [{ oldStart: 0, newStart: 1, lines: ['+export {};'] }], stats: { added: 1, removed: 0 }, ts: Date.now() });
      await chat('agent-start', { sessionId: 's1', toolUseId: tu, agentId: id, agentType: 'Explore', description: 'Gone ' + i });
      await chat('agent-step', { sessionId: 's1', toolUseId: tu, agentId: id, agentType: 'Explore', kind: 'tool', tool: 'Read', summary: rel,
        file: path.join(proj, rel), line: 1, end: 1, op: 'read' });
      await chat('agent-step', { sessionId: 's1', toolUseId: tu, agentId: id, agentType: 'Explore', kind: 'tool', tool: 'Grep', summary: 'x', permissionMode: 'plan' });
      await chat('agent-done', { sessionId: 's1', toolUseId: tu, agentId: id, status: 'completed', text: 'ok', toolCount: 2, durationMs: 10 });
    }
    // Sol advice: "added to your files" events for 150 tasks whose cards never arrive.
    for (let i = 0; i < 150; i++) await postJson('/remote/task-applied', { task: 'fedcba' + i.toString(16).padStart(6, '0'), dir: proj, count: 1 });
    await sleep(600);
    const cdp = await ctx.newCDPSession(pg);
    let lastApplied = 0; // task ids of those events still on the page's heap
    // Strings on the page's heap that name the removed subagents.
    const goneLeft = async () => {
      for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
      const chunks = [];
      const onChunk = (p) => chunks.push(p.chunk);
      cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
      const snap = JSON.parse(chunks.join(''));
      lastApplied = new Set(snap.strings.filter((s) => /^fedcba[0-9a-f]{6}$/.test(s))).size;
      return pageStrings(snap, (s) => /goneZq/i.test(s) && s.length < 40);
    };
    const goneBefore = await goneLeft();
    // Edit cards (li.k-edit) that are no longer on the page but are still kept.
    const kept = async () => {
      await sleep(1500);
      for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
      const proto = await cdp.send('Runtime.evaluate', { expression: 'HTMLLIElement.prototype' });
      const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId });
      const out = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objectId, returnByValue: true,
        functionDeclaration: 'function () { return this.filter((x) => x.classList.contains("k-edit") && !x.isConnected).length; }' });
      await cdp.send('Runtime.releaseObject', { objectId: objects.objectId });
      return out.result.value;
    };
    await edits(250);
    const d1 = await kept();
    await edits(250);
    const d2 = await kept();
    await edits(250);
    const d3 = await kept();
    const cards = await pg.evaluate(`${ROOT}.querySelectorAll('.k-edit').length`);
    check('the panel keeps its newest cards', cards > 100 && cards <= 250, cards);
    // The code view lists the newest 200 edits, so up to that many removed cards can still be kept.
    check('removed cards are let go: at most 200 kept, and no more after more edits', d2 <= 200 && d3 <= 200 && d3 - d2 < 20, { d1, d2, d3 });
    const goneAfter = await goneLeft();
    const agentRows = await rows();
    check('Sol M10: removed subagents leave no Follow position, color, mode or edit count by key or id',
      goneBefore.length > 0 && !agentRows.some((x) => /^Gone /.test(x)) && goneAfter.length === 0, { goneBefore, goneAfter });
    check('Sol advice: at most 100 of the 150 task events without a card are kept', lastApplied > 0 && lastApplied <= 100, lastApplied);
    check('no page errors', errors.length === 0, errors);
  } finally {
    await browser.close();
    site.close();
    await stopServer();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} FAILED` : 'all ok');
  process.exit(failed ? 1 : 0);
})();
