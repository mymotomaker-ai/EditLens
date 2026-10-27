'use strict';
require('./isolate');
// Claude on a paired computer: the laptop ("remote") asks Claude on the VPS ("host") to do tasks.
// Two EditLens servers on one machine, a stand-in SDK and claude (test/fixtures): each task gets its
// own copy of the git project, permission questions go to the host's pages (never to the asking
// agent), follow-ups, Stop, Merge, and a task kept after the host restarts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-tasks-'));
const project = path.join(base, 'project');
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const HOST = { port: 4372, pairPort: 4373, dir: path.join(base, 'host') };
const REMOTE = { port: 4940, pairPort: 4375, dir: path.join(base, 'remote') };
const fake = path.join(base, 'fake');
const children = new Set();

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
}

function setupFakes() {
  const sdk = path.join(fake, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
  fs.mkdirSync(path.join(fake, 'bin'));
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(fake, 'bin', 'claude'));
  fs.mkdirSync(path.join(fake, 'state'));
  fs.writeFileSync(path.join(fake, 'state', 'signed-in'), 'yes');
}

function startServer(s, extra = {}) {
  fs.mkdirSync(s.dir, { recursive: true });
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir, ...extra },
    stdio: 'ignore',
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  s.child = child;
  return waitFor(async () => (await request(s.port, 'GET', '/health')).status === 200);
}
function stopServer(s) {
  return new Promise((resolve) => {
    if (!s.child || s.child.exitCode !== null) return resolve();
    s.child.once('exit', () => resolve());
    s.child.kill();
  });
}
function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', (err) => resolve({ status: 0, json: null, error: err.code }));
    req.setTimeout(150000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}
const token = (s) => fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8');
const api = (s, method, urlPath, body) => request(s.port, method, urlPath, body, { 'x-editlens-token': token(s) }).then((r) => r.json);
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}
const task = (body) => api(REMOTE, 'POST', '/remote/task', body);
// The EditLens window, as a browser opens it: its HTML (with its key) and headers.
function answerWindow(port) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/answer', headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8');
        resolve({ headers: res.headers, key: (/var KEY = "([0-9a-f]{64})"/.exec(html) || [])[1] });
      });
    });
  });
}
const settled = (id, pred) => waitFor(async () => {
  const r = await task({ op: 'check', task: id });
  return pred(r) && r;
}, 20000);

// A page of the host's project: collects the task cards it is sent.
function openPage(s, id, root) {
  const cards = [];
  const ctrl = new AbortController();
  fetch(`http://127.0.0.1:${s.port}/events?page=${id}&root=${encodeURIComponent(root)}`, { signal: ctrl.signal }).then(async (res) => {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (data) {
          const ev = JSON.parse(data.slice(6));
          if (ev.type === 'task') cards.push(ev);
        }
      }
    }
  }).catch((err) => {
    if (err.name !== 'AbortError') throw err;
  });
  return { cards, close: () => ctrl.abort() };
}

test('Claude on the laptop runs tasks on the paired VPS', async (t) => {
  setupFakes();
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.email', 't@example.com');
  git(project, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(project, 'src', 'a.js'), 'one\n');
  fs.writeFileSync(path.join(project, '.gitignore'), '.claude/\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'start');
  const hostEnv = { EDITLENS_SDK_DIR: path.join(fake, 'sdk'), FAKE_CLAUDE_STATE: path.join(fake, 'state') };
  await startServer(HOST, hostEnv);
  await startServer(REMOTE);
  const pages = [];
  t.after(async () => {
    for (const p of pages) p.close();
    for (const c of children) c.kill();
    await stopServer(HOST);
    await stopServer(REMOTE);
    fs.rmSync(base, { recursive: true, force: true });
  });
  // The host knows its claude program from its hooks.
  await api(HOST, 'POST', '/event', { type: 'session', sessionId: 'h1', cwd: project, execPath: path.join(fake, 'bin', 'claude'), ts: Date.now() });

  // Before pairing: a plain answer.
  assert.match((await task({ op: 'list' })).error, /not paired/);
  const { code } = await api(HOST, 'POST', '/pair', { cwd: project });
  const joined = await api(REMOTE, 'POST', '/join', { address: `127.0.0.1:${HOST.pairPort}`, code });
  assert.ok(joined.ok, JSON.stringify(joined));
  const hostPage = openPage(HOST, 'hp', project);
  const otherPage = openPage(HOST, 'op', path.join(base, 'elsewhere'));
  pages.push(hostPage, otherPage);
  await new Promise((r) => setTimeout(r, 300));

  // Start: its own copy of the project, Claude answers there.
  const started = await task({ op: 'start', prompt: 'hello' });
  assert.ok(started && started.task, JSON.stringify(started));
  assert.match(started.workspace.name, /^editlens-task-[0-9a-f]{12}$/);
  assert.ok(fs.existsSync(path.join(project, '.claude', 'worktrees', started.workspace.name, 'src', 'a.js')), 'the copy exists');
  const done = await settled(started.task, (r) => r.state === 'idle');
  assert.ok(done, 'finishes its turn');
  assert.deepStrictEqual(done.replies, ['Done: hello']);
  // Written by the laptop's Claude: never a typed (human) prompt, never a slash command.
  const sentHere = fs.readFileSync(path.join(fake, 'state', 'messages'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const first = sentHere.find((m) => /hello/.test(m.text));
  assert.ok(first && first.composed && !first.human, JSON.stringify(first));
  assert.strictEqual(first.origin.kind, 'peer');
  assert.strictEqual(first.origin.fromMode, 'prompting');
  assert.match(first.text, /^\[From the Claude on .+, not typed by a person here\.\]\nhello\n\n\[EditLens: when you finish/);
  assert.deepStrictEqual(done.result, { isError: false, turns: null, sameAsLastReply: true }, 'the answer is sent once, as the last reply');
  const queries = fs.readFileSync(path.join(fake, 'state', 'queries'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(queries[0].cwd, path.join(project, '.claude', 'worktrees', started.workspace.name), 'Claude works in the copy');
  assert.match(queries[0].append, /You were given this task by the Claude on .+ \(another computer\), not by a person/, 'its system prompt says who gives it work');

  // Tool steps: titles only, secrets masked, subagents marked; costs from the result.
  await task({ op: 'send', task: started.task, text: 'steps' });
  const stepped = await settled(started.task, (r) => r.state === 'idle' && r.activityCount === 3);
  assert.ok(stepped, 'three steps');
  assert.deepStrictEqual(stepped.activity, ['Bash API_TOKEN=*** npm test --password ***', 'Edit src/a.js', '[subagent] Read src/b.js']);
  assert.deepStrictEqual(stepped.stats, { turns: 3, seconds: 4, costUsd: 0.0123 });
  assert.deepStrictEqual((await task({ op: 'check', task: started.task, activitySince: 2 })).activity, ['[subagent] Read src/b.js']);

  // Sol M6: the task's Claude asking for page control in the project folder itself (as a task in a
  // folder that is not a git project does) is refused, like page control's own session.
  const fromTask = await request(HOST.port, 'POST', '/drive/grant', { cwd: project, caller: '11111111-2222-3333-4444-555555555555' }, { 'x-editlens-token': token(HOST) });
  assert.strictEqual(fromTask.status, 403, JSON.stringify(fromTask.json));

  // The laptop follows every task with one request per change ("watch-all"), and keeps a copy.
  const all = await task({ op: 'watch-all', since: 0 });
  const mineThere = all.tasks.find((x) => x.task === started.task);
  assert.ok(mineThere && mineThere.card && mineThere.activityCount === 3, JSON.stringify(all).slice(0, 300));
  const t0 = Date.now();
  const quiet = await task({ op: 'watch-all', since: all.seq, wait: 1 });
  assert.deepStrictEqual(quiet.tasks, []);
  assert.ok(Date.now() - t0 >= 900, 'waits when nothing changed');
  assert.strictEqual((await task({ op: 'watch-all', since: Number.NaN })).tasks.length >= 1, true, 'NaN since: everything');
  assert.match((await task({ op: 'bogus', task: started.task })).error, /Unknown op "bogus"/);
  assert.match((await task({ op: 'bogus' })).error, /Unknown op/, 'named before the task is looked up');
  const cached = await waitFor(async () => {
    const r = await api(REMOTE, 'GET', '/remote/tasks?follow=');
    return r.tasks.find((x) => x.task === started.task && x.activityCount === 3) && r;
  });
  assert.ok(cached, 'the laptop\'s copy of the task state');
  const waited = await api(REMOTE, 'GET', `/remote/tasks?since=${cached.seq}&wait=1`);
  assert.strictEqual(waited.seq, cached.seq, 'nothing new: answered after the wait');

  // wait_for_computer_tasks (the MCP tool): returns when the working task finishes its turn.
  const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'live-page.js')], { stdio: ['pipe', 'pipe', 'ignore'], cwd: project,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, EDITLENS_PORT: String(REMOTE.port), EDITLENS_STATE_DIR: REMOTE.dir } });
  children.add(mcp);
  let mcpOut = '';
  mcp.stdout.on('data', (d) => { mcpOut += d; });
  await task({ op: 'send', task: started.task, text: 'hello again', localDir: project });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for_computer_tasks', arguments: { tasks: [started.task], until: 'turn_done', wait_seconds: 20 } } }) + '\n');
  const answered = await waitFor(() => mcpOut.includes('\n') && JSON.parse(mcpOut.split('\n')[0]), 25000);
  // Ids that aren't known (or aren't text) answer immediately, not after the whole wait.
  const asked = Date.now();
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wait_for_computer_tasks', arguments: { tasks: ['000000000000', {}, 5], wait_seconds: 60 } } }) + '\n');
  const unknown = await waitFor(() => mcpOut.split('\n').length > 2 && JSON.parse(mcpOut.split('\n')[1]), 15000);
  assert.ok(unknown && unknown.result.isError && /^Not known here: 000000000000\./.test(unknown.result.content[0].text), JSON.stringify(unknown));
  assert.ok(Date.now() - asked < 15000);
  mcp.kill();
  assert.ok(answered, 'the wait answers');
  // The plain summary for the user first (handoff 16.2), then the same lines for Claude as before.
  assert.strictEqual(answered.result.content.length, 2);
  assert.match(answered.result.content[0].text, /^✦ Task done on ◆ .+\n.+ ··· Done/);
  assert.match(answered.result.content[1].text, new RegExp(`^Ready: ${started.task} \\(turn_done\\)\\.\\n${started.task} on .+: idle, 3 replies`));

  // A permission question: shown to the host's project pages only; the asking agent only learns it waits.
  await task({ op: 'send', task: started.task, text: 'ask npm test' });
  const waiting = await settled(started.task, (r) => r.waitingForPermission.length === 1);
  assert.deepStrictEqual(waiting.waitingForPermission, [{ tool: 'Bash', title: 'Run a command', detail: 'npm test' }]);
  const card = await waitFor(() => hostPage.cards.find((c) => c.permissions && c.permissions.length));
  assert.ok(card, 'the host page shows the question');
  assert.strictEqual(otherPage.cards.length, 0, 'another project\'s page gets nothing');
  const perm = card.permissions[0];
  assert.strictEqual((await request(HOST.port, 'POST', '/task/answer', { page: 'op', task: started.task, id: perm.id, decision: 'deny' })).status, 404);
  // A page (or anything that registered as one) can't allow: only the EditLens window can.
  const fromPage = await request(HOST.port, 'POST', '/task/answer', { page: 'hp', task: started.task, id: perm.id, decision: 'allow' });
  assert.strictEqual(fromPage.status, 403);
  assert.ok(fromPage.json.answerWindow);
  const win = await answerWindow(HOST.port);
  assert.strictEqual(win.headers['x-frame-options'], 'DENY');
  assert.strictEqual(win.headers['access-control-allow-origin'], undefined, 'other origins can\'t read the window');
  assert.match(win.headers['content-security-policy'], /frame-ancestors 'none'/);
  const answerApi = (method, urlPath, body, headers) => request(HOST.port, method, urlPath, body, { 'x-editlens-answer': win.key, 'sec-fetch-site': 'same-origin', ...headers });
  assert.strictEqual((await request(HOST.port, 'GET', '/answer/list')).status, 403, 'no key');
  assert.strictEqual((await answerApi('GET', '/answer/list', undefined, { origin: 'http://127.0.0.1:5173' })).status, 403, 'another origin');
  assert.strictEqual((await answerApi('GET', '/answer/list', undefined, { 'sec-fetch-site': 'same-site' })).status, 403, 'another port is same-site, not same-origin');
  const pre = await new Promise((resolve) => {
    http.request({ host: '127.0.0.1', port: HOST.port, method: 'OPTIONS', path: '/answer', headers: { origin: 'http://127.0.0.1:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-editlens-answer' } }, (res) => {
      res.resume();
      resolve(res.headers);
    }).end();
  });
  assert.ok(!/x-editlens-answer/i.test(pre['access-control-allow-headers'] || ''), 'a page can\'t send the window\'s key header');
  const listed = await answerApi('GET', '/answer/list');
  assert.strictEqual(listed.status, 200);
  const q = listed.json.questions.find((x) => x.kind === 'task');
  assert.ok(q && q.id === perm.id && q.task === started.task, JSON.stringify(listed.json));
  assert.strictEqual((await answerApi('POST', '/answer', { kind: 'task', task: started.task, id: perm.id, decision: 'allow' })).status, 200);
  const allowed = await settled(started.task, (r) => r.state === 'idle' && r.replies.includes('Ran: npm test'));
  assert.ok(allowed, 'runs once the user allows it');
  const newer = await task({ op: 'check', task: started.task, since: 3 });
  assert.deepStrictEqual(newer.replies, ['Ran: npm test'], 'since: only new replies');

  // Merge: the copy's change is applied to the project.
  fs.writeFileSync(path.join(started.workspace.folder, 'src', 'a.js'), 'two\n');
  const preview = await task({ op: 'merge', task: started.task, dryRun: true });
  assert.deepStrictEqual(preview.wouldMerge, ['src/a.js'], JSON.stringify(preview));
  assert.strictEqual(fs.readFileSync(path.join(project, 'src', 'a.js'), 'utf8'), 'one\n', 'a dry run merges nothing');
  const tdiff = await task({ op: 'diff', task: started.task });
  assert.match(tdiff.diff, /^-one$\n^\+two$/m);
  const merged = await task({ op: 'merge', task: started.task });
  assert.deepStrictEqual(merged.applied, ['src/a.js'], JSON.stringify(merged));
  assert.ok(!('undoList' in merged), 'undo details stay on that computer');
  assert.strictEqual(fs.readFileSync(path.join(project, 'src', 'a.js'), 'utf8'), 'two\n');
  // Undo the merge, then merge again.
  assert.deepStrictEqual((await task({ op: 'undo-merge', task: started.task })).undone, ['src/a.js']);
  assert.strictEqual(fs.readFileSync(path.join(project, 'src', 'a.js'), 'utf8'), 'one\n');
  // Pages see the undo as an edit ("Merge undone"), played in the code view, not as another tab's restore.
  const undoEv = (await api(HOST, 'GET', '/history')).filter((e) => e.type === 'change').pop();
  assert.deepStrictEqual([undoEv.kind, undoEv.via, undoEv.relFile, undoEv.intent], ['restore', 'merge-undo', 'src/a.js', 'Merge undone: put back as before the merge'], JSON.stringify(undoEv));
  assert.match((await task({ op: 'undo-merge', task: started.task })).error, /Nothing to undo/);
  assert.deepStrictEqual((await task({ op: 'merge', task: started.task })).applied, ['src/a.js']);
  assert.strictEqual(fs.readFileSync(path.join(project, 'src', 'a.js'), 'utf8'), 'two\n');
  // H2 (Sol scan of 0.24.43): a folder of a merged new file becomes a link to another folder with a
  // file of the same text; undoing the merge must not remove the file there.
  fs.mkdirSync(path.join(started.workspace.folder, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(started.workspace.folder, 'sub', 'new.txt'), 'same\n');
  assert.deepStrictEqual((await task({ op: 'merge', task: started.task })).applied, ['sub/new.txt']);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-h2-'));
  try {
    fs.writeFileSync(path.join(elsewhere, 'new.txt'), 'same\n');
    fs.rmSync(path.join(project, 'sub'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(project, 'sub'));
    const undone = await task({ op: 'undo-merge', task: started.task });
    assert.deepStrictEqual(undone.undone, [], JSON.stringify(undone));
    assert.strictEqual(fs.readFileSync(path.join(elsewhere, 'new.txt'), 'utf8'), 'same\n', 'the file outside the project stays');
  } finally {
    fs.rmSync(path.join(project, 'sub'), { force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }

  // List, Stop from the page, unknown tasks.
  assert.strictEqual((await task({ op: 'list' })).tasks.length, 1);
  assert.match((await task({ op: 'check', task: 'nope' })).error, /No such task/);
  assert.strictEqual((await request(HOST.port, 'POST', '/task/stop', { page: 'hp', task: started.task })).status, 200);
  assert.strictEqual((await task({ op: 'check', task: started.task })).state, 'stopped');

  // A second task runs at the same time in its own copy.
  const second = await task({ op: 'start', prompt: 'second' });
  assert.notStrictEqual(second.workspace.name, started.workspace.name);
  assert.ok(await settled(second.task, (r) => r.state === 'idle'));

  // The host restarts: the task says so, and a follow-up resumes its conversation.
  await stopServer(HOST);
  await startServer(HOST, hostEnv);
  await api(HOST, 'POST', '/event', { type: 'session', sessionId: 'h2', cwd: project, execPath: path.join(fake, 'bin', 'claude'), ts: Date.now() });
  const after = await waitFor(async () => {
    const r = await task({ op: 'check', task: second.task });
    return r && !r.error && r;
  }, 30000);
  assert.ok(after, 'reachable again');
  assert.strictEqual(after.state, 'ended');
  assert.match(after.note, /stopped/);
  const resumed = await task({ op: 'send', task: second.task, text: 'again' });
  assert.ok(!resumed.error, JSON.stringify(resumed));
  assert.ok(await settled(second.task, (r) => r.state === 'idle' && r.replies.includes('Done: again')));
  const last = fs.readFileSync(path.join(fake, 'state', 'queries'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  assert.strictEqual(last.resume, '11111111-2222-3333-4444-555555555555', 'resumes the conversation');
});
