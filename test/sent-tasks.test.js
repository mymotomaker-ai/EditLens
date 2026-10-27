'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4925';
// A task on the paired VPS that works on the LAPTOP's project: the project is sent with the task
// (never .env, .claude, node_modules), the task works on a copy there, and its changes are copied back
// as files, written here only where the file is still as it was sent. Also: replies are no longer
// cut short, and the laptop is told when the two projects differ.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const remotework = require('../lib/remotework');
const sendproject = require('../lib/sendproject');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-sent-'));
const vpsProject = path.join(base, 'vps-site');
const laptopProject = path.join(base, 'laptop-app');
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const HOST = { port: 4352, pairPort: 4353, dir: path.join(base, 'host') };
const REMOTE = { port: 4354, pairPort: 4355, dir: path.join(base, 'remote') };
const fake = path.join(base, 'fake');
const children = new Set();

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}
function gitProject(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'start');
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
const call = (op, extra) => api(REMOTE, 'POST', '/remote/task', { op, ...extra });
// A page's event stream: every event as it arrives (frames split on blank lines).
function stream(s, query) {
  const events = [];
  const ac = new AbortController();
  fetch(`http://127.0.0.1:${s.port}/events?${query}`, { signal: ac.signal }).then(async (res) => {
    let buf = '';
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        buf = buf.slice(i + 2);
        try {
          if (data) events.push(JSON.parse(data));
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
    }
  }).catch((err) => {
    if (err.name !== 'AbortError') throw err;
  });
  return { events, close: () => ac.abort() };
}
const settled = (id, pred) => waitFor(async () => {
  const r = await call('check', { task: id });
  return pred(r) && r;
}, 20000);

test('a task on the VPS works on the laptop\'s project and its changes are copied back', async (t) => {
  const sdk = path.join(fake, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
  fs.mkdirSync(path.join(fake, 'bin'));
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(fake, 'bin', 'claude'));
  fs.mkdirSync(path.join(fake, 'state'));
  fs.writeFileSync(path.join(fake, 'state', 'signed-in'), 'yes');

  gitProject(vpsProject, { 'index.html': '<h1>VPS site</h1>\n' });
  gitProject(laptopProject, {
    'src/App.jsx': 'export default () => <h1>App</h1>;\n', 'src/keep.js': 'keep\n', 'src/gone.js': 'gone\n', 'src/mine.js': 'v1\n',
    '.gitignore': 'node_modules/\ndist/\n', '.env': 'SECRET=1\n', '.claude/settings.json': '{"hooks":{}}\n', '.mcp.json': '{}\n',
  });
  fs.mkdirSync(path.join(laptopProject, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(laptopProject, 'node_modules', 'x', 'i.js'), 'x');
  fs.writeFileSync(path.join(laptopProject, 'src', 'draft.js'), 'uncommitted\n'); // sent too

  const hostEnv = { EDITLENS_SDK_DIR: path.join(fake, 'sdk'), FAKE_CLAUDE_STATE: path.join(fake, 'state') };
  await startServer(HOST, hostEnv);
  await startServer(REMOTE);
  t.after(async () => {
    // Servers save state as they exit: wait for them (up to 5 s) before removing their folders.
    await Promise.all([...children].map((c) => (c.exitCode !== null || c.signalCode !== null ? null : new Promise((done) => {
      const timer = setTimeout(done, 5000);
      c.once('exit', () => { clearTimeout(timer); done(); });
      c.kill();
    }))));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await api(HOST, 'POST', '/event', { type: 'session', sessionId: 'h1', cwd: vpsProject, execPath: path.join(fake, 'bin', 'claude'), ts: Date.now() });
  const { code } = await api(HOST, 'POST', '/pair', { cwd: vpsProject });
  assert.ok((await api(REMOTE, 'POST', '/join', { address: `127.0.0.1:${HOST.pairPort}`, code })).ok);

  // Different projects: the laptop is told, and must choose.
  const cmp = await remotework.compareProjects(call, laptopProject);
  assert.strictEqual(cmp.same, false);
  assert.strictEqual(cmp.theirs.cwd, vpsProject);
  assert.strictEqual((await remotework.compareProjects(call, vpsProject)).same, true);

  // Sent: the task works on a copy of the laptop's project.
  const started = await remotework.sendAndStart(call, { dir: laptopProject, prompt: 'write src/App.jsx export default () => <h1>Pricing</h1>;', stateDir: REMOTE.dir });
  assert.ok(started.task, JSON.stringify(started));
  assert.strictEqual(started.workspace.sentFrom.length > 0, true);
  const ws = started.workspace.folder;
  assert.ok(ws.startsWith(HOST.dir), 'in the VPS\'s EditLens folder, not its project');
  assert.strictEqual(fs.readFileSync(path.join(ws, 'src', 'draft.js'), 'utf8'), 'uncommitted\n');
  for (const never of ['.env', '.claude/settings.json', '.mcp.json', 'node_modules/x/i.js']) assert.ok(!fs.existsSync(path.join(ws, never)), never);
  assert.ok(await settled(started.task, (r) => r.state === 'idle'));
  assert.ok(!fs.existsSync(path.join(vpsProject, 'src')), 'the VPS\'s own project is untouched');
  // The VPS looks for files changed by commands after the turn ends, so on a busy computer that comes
  // after "idle". Wait for it: an edit reported later with the same text would hide the change (L11).
  const scanned = (w) => Boolean(w && w.card && w.card.edits.some((e) => e.intent === 'Changed by a command'));
  assert.ok(await waitFor(async () => scanned(await call('watch', { task: started.task, since: 0 })), 20000), 'the command scan ended');

  // The laptop's panel follows the task live: a follow-up (with this project) starts it.
  const page = stream(REMOTE, `page=lp&root=${encodeURIComponent(laptopProject)}`);
  t.after(() => page.close());
  await api(REMOTE, 'POST', '/remote/task', { op: 'send', task: started.task, text: 'say hi', localDir: laptopProject });
  // An edit by the task's Claude there (its hook reports it): on its card, here and there.
  await api(HOST, 'POST', '/event', { type: 'change', sessionId: 'task-session', cwd: ws, file: path.join(ws, 'src', 'App.jsx'), relFile: 'src/App.jsx', tool: 'Edit', intent: 'Pricing heading', stats: { added: 1, removed: 1 }, before: 'export default () => <h1>App</h1>;\n', after: 'export default () => <h1>Pricing</h1>;\n', ts: Date.now() });
  const watched = await call('watch', { task: started.task, since: 0 });
  // The stand-in Claude wrote the file itself (as a command would): that shows too, first.
  assert.deepStrictEqual(watched.card.edits.map((e) => [e.relFile, e.intent, e.added]).sort(), [['src/App.jsx', 'Changed by a command', 1], ['src/App.jsx', 'Pricing heading', 1]]);
  // Both edits are in the task's workspace: the VPS keeps no copy of them for Restore (none left unused).
  const copies = fs.existsSync(path.join(HOST.dir, 'backups')) ? fs.readdirSync(path.join(HOST.dir, 'backups')).filter((n) => /^b[0-9a-f]{16}\.json$/.test(n)) : [];
  assert.deepStrictEqual(copies, [], 'no unused copies of task edits');
  const mirrored = await waitFor(() => page.events.find((e) => e.type === 'task-remote' && e.editCount === 2));
  assert.ok(mirrored, JSON.stringify(page.events.map((e) => e.type)));
  assert.strictEqual(mirrored.cwd, laptopProject);
  assert.strictEqual(mirrored.edits[0].relFile, 'src/App.jsx');
  assert.ok(!('permissions' in mirrored), 'questions are answered on that computer only');
  assert.ok(await settled(started.task, (r) => r.state === 'idle' && r.replyCount >= 2));
  assert.deepStrictEqual((await call('check', { task: started.task })).filesEdited, ['src/App.jsx']);

  // More work there: a new file, a deletion, and a file the user also changes here meanwhile.
  await call('send', { task: started.task, text: 'write src/Pricing.jsx export const Pricing = 1;' });
  await settled(started.task, (r) => r.state === 'idle' && r.replyCount >= 3);
  await call('send', { task: started.task, text: 'write src/mine.js v2-from-vps' });
  await settled(started.task, (r) => r.state === 'idle' && r.replyCount >= 4);
  fs.rmSync(path.join(ws, 'src', 'gone.js'));
  // Build output there never counts as the task's work (even when the project ignores none of it).
  fs.mkdirSync(path.join(ws, 'build'));
  fs.writeFileSync(path.join(ws, 'build', 'out.js'), 'built');
  fs.writeFileSync(path.join(ws, 'npm-debug.log'), 'log');
  fs.writeFileSync(path.join(laptopProject, 'src', 'mine.js'), 'v2-from-me\n');

  const changes = await call('changes', { task: started.task });
  const byPath = Object.fromEntries(changes.files.map((f) => [f.path, f.status]));
  assert.deepStrictEqual(byPath, { 'src/App.jsx': 'changed', 'src/gone.js': 'deleted', 'src/mine.js': 'changed', 'src/Pricing.jsx': 'added' });
  assert.strictEqual(changes.files.find((f) => f.path === 'src/App.jsx').intent, 'Pricing heading');

  const shown = await remotework.showFile(call, { task: started.task, rel: 'src/App.jsx', dir: laptopProject });
  assert.ok(shown.text, JSON.stringify(shown));
  assert.match(shown.text, /Pricing/);
  assert.match(shown.text, /-export default \(\) => <h1>App<\/h1>;/);

  // Review first: one diff (added files too), a listing, a search, and a dry run that writes nothing.
  fs.writeFileSync(path.join(ws, 'id_rsa'), 'PRIVATE');
  const d = await call('diff', { task: started.task });
  assert.match(d.diff, /^diff --git a\/src\/App\.jsx/m);
  assert.match(d.diff, /^\+export const Pricing = 1;$/m, 'an added file is in the diff');
  assert.doesNotMatch(d.diff, /PRIVATE|build\/out|npm-debug/, 'never a key, build output or log');
  assert.strictEqual((await call('diff', { task: started.task, offset: Number.NaN })).offset, 0);
  const listed = await call('files', { task: started.task, glob: 'src/**' });
  assert.ok(listed.files.includes('src/Pricing.jsx') && !listed.files.includes('id_rsa'), JSON.stringify(listed));
  const found = await call('search', { task: started.task, text: 'Pricing' });
  assert.ok(found.matches.some((m) => /^src\/App\.jsx:1: /.test(m)), JSON.stringify(found));
  const app = changes.files.find((f) => f.path === 'src/App.jsx');
  const appBuf = fs.readFileSync(path.join(ws, 'src', 'App.jsx'));
  assert.deepStrictEqual([app.hash, app.size], [require('crypto').createHash('sha256').update(appBuf).digest('hex'), appBuf.length], 'changes include each file\'s hash and size');
  const dry = await remotework.applyTask(call, { task: started.task, stateDir: REMOTE.dir, dryRun: true });
  assert.deepStrictEqual(dry.wouldApply.sort(), ['src/App.jsx (changed)', 'src/Pricing.jsx (added)', 'src/gone.js (deleted there)']);
  assert.deepStrictEqual(dry.conflicts.map((c) => c.path), ['src/mine.js']);
  assert.match(fs.readFileSync(path.join(laptopProject, 'src', 'App.jsx'), 'utf8'), /<h1>App/, 'a dry run writes nothing');

  // Each file written shows on the laptop's page as an edit (what the MCP tool sends).
  const shownHere = [];
  const onApplied = async (f) => {
    shownHere.push(f.path);
    await api(REMOTE, 'POST', '/remote/applied', { task: started.task, computer: 'vps', dir: laptopProject, path: f.path, status: f.status, intent: f.intent,
      before: f.before ? f.before.toString('utf8') : '', after: f.after ? f.after.toString('utf8') : '' });
  };
  const applied = await remotework.applyTask(call, { task: started.task, stateDir: REMOTE.dir, onApplied });
  assert.deepStrictEqual(shownHere.sort(), ['src/App.jsx', 'src/Pricing.jsx', 'src/gone.js']);
  const edit = await waitFor(() => page.events.find((e) => e.type === 'change' && e.tool === 'Apply' && e.relFile === 'src/App.jsx'));
  assert.ok(edit, 'the applied file is an edit on the page');
  assert.strictEqual(edit.intent, 'Pricing heading (from vps)');
  assert.strictEqual(edit.stats.added, 1);
  assert.ok(edit.snapshot && edit.backup, 'code view and Restore have it');
  assert.ok(page.events.some((e) => e.type === 'change' && e.relFile === 'src/gone.js' && e.deleted));
  assert.match((await api(REMOTE, 'POST', '/remote/applied', { dir: laptopProject, path: '../x.js', after: 'x' })).error, /bad file/);
  assert.deepStrictEqual(applied.applied.sort(), ['src/App.jsx', 'src/Pricing.jsx', 'src/gone.js']);
  assert.deepStrictEqual(applied.conflicts, [{ path: 'src/mine.js', why: 'you changed it here since it was sent' }]);
  assert.match(fs.readFileSync(path.join(laptopProject, 'src', 'App.jsx'), 'utf8'), /Pricing/);
  assert.strictEqual(fs.readFileSync(path.join(laptopProject, 'src', 'Pricing.jsx'), 'utf8'), 'export const Pricing = 1;\n');
  assert.ok(!fs.existsSync(path.join(laptopProject, 'src', 'gone.js')));
  assert.strictEqual(fs.readFileSync(path.join(laptopProject, 'src', 'mine.js'), 'utf8'), 'v2-from-me\n', 'your change is kept');
  // Applying again changes nothing.
  const again = await remotework.applyTask(call, { task: started.task, stateDir: REMOTE.dir });
  assert.deepStrictEqual(again.applied, []);

  // Undo the apply: a file changed since stays; the rest are restored (the deleted file returns).
  assert.match(applied.apply, /^[0-9a-f]{12}$/);
  fs.writeFileSync(path.join(laptopProject, 'src', 'Pricing.jsx'), 'my own edit\n');
  const undone = await remotework.undoApply({ stateDir: REMOTE.dir, apply: applied.apply });
  assert.deepStrictEqual(undone.undone.sort(), ['src/App.jsx', 'src/gone.js']);
  assert.deepStrictEqual(undone.kept, [{ path: 'src/Pricing.jsx', why: 'changed since the apply' }]);
  assert.match(fs.readFileSync(path.join(laptopProject, 'src', 'App.jsx'), 'utf8'), /<h1>App/);
  assert.strictEqual(fs.readFileSync(path.join(laptopProject, 'src', 'gone.js'), 'utf8'), 'gone\n');
  assert.strictEqual(fs.readFileSync(path.join(laptopProject, 'src', 'Pricing.jsx'), 'utf8'), 'my own edit\n');
  assert.match((await remotework.undoApply({ stateDir: REMOTE.dir, apply: '../../x' })).error, /apply id/);

  // The VPS's own merge refuses a sent task; files outside the workspace can't be read.
  assert.match((await call('merge', { task: started.task })).error, /sent from/);
  assert.match((await call('file', { task: started.task, path: '../../tasks.json' })).error, /Not a file/);
  assert.match((await call('file', { task: started.task, path: '.env' })).error, /Not a file/);

  // Long replies arrive whole (never cut at 4,000 characters).
  await call('send', { task: started.task, text: 'long 15000' });
  const long = await settled(started.task, (r) => r.state === 'idle' && r.replyCount >= 5);
  assert.strictEqual(long.replies[long.replies.length - 1].length, 15000);
});

test('sendproject: never writes outside the project, never .env or .claude', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-apply-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = fs.mkdtempSync(path.join(base, 'apply-'));
  assert.ok(sendproject.applyChange(dir, { path: '../x', status: 'added' }, Buffer.from('x'), {}).error);
  assert.ok(sendproject.applyChange(dir, { path: '/etc/x', status: 'added' }, Buffer.from('x'), {}).error);
  assert.ok(sendproject.applyChange(dir, { path: '.env.local', status: 'added' }, Buffer.from('x'), {}).error);
  assert.ok(sendproject.applyChange(dir, { path: '.claude/settings.json', status: 'added' }, Buffer.from('x'), {}).error);
  assert.ok(sendproject.applyChange(dir, { path: 'a/.git/config', status: 'added' }, Buffer.from('x'), {}).error);
  assert.deepStrictEqual(sendproject.applyChange(dir, { path: 'ok.txt', status: 'added' }, Buffer.from('x'), {}), { ok: true, before: null });
  // Added here meanwhile: kept.
  assert.ok(sendproject.applyChange(dir, { path: 'ok.txt', status: 'added' }, Buffer.from('y'), {}).conflict);
  assert.strictEqual(sendproject.cleanRel('a\\b/./c'), 'a/b/c');
  assert.strictEqual(sendproject.cleanRel('C:\\x'), null);
  assert.strictEqual(sendproject.excluded('.env.example'), false);
  const bundle = require('zlib').gzipSync(Buffer.from(JSON.stringify({ v: 1, files: [{ p: '../evil', d: 'eA==' }, { p: '.claude/x', d: 'eA==' }, { p: 'fine', d: 'eA==' }] })));
  const into = path.join(base, 'unpacked');
  assert.deepStrictEqual(await sendproject.unpack(bundle, into), { count: 1 });
  assert.ok(!fs.existsSync(path.join(base, 'evil')));
  assert.ok((await sendproject.unpack(Buffer.from('not gzip'), path.join(base, 'u2'))).error);
  // A write that fails before it finishes (a file where a folder must go) keeps nothing.
  const clash = require('zlib').gzipSync(Buffer.from(JSON.stringify({ v: 1, files: [{ p: 'a', d: 'eA==' }, { p: 'b', d: 'eA==' }, { p: 'a/c', d: 'eA==' }] })));
  const failed = await sendproject.unpack(clash, path.join(base, 'u3'));
  assert.match(failed.error, /could not be written/);
  assert.ok(!fs.existsSync(path.join(base, 'u3')) && !fs.existsSync(path.join(base, 'u3.part')));
});

test('remote addresses compare however they are written', () => {
  assert.strictEqual(remotework.remoteKey('git@github.com:Me/App.git'), 'github.com/me/app');
  assert.strictEqual(remotework.remoteKey('https://github.com/me/app/'), 'github.com/me/app');
  assert.strictEqual(remotework.remoteKey(''), null);
});

test('apply: a file held open is reported, not thrown; a working task is not applied', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-held-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'old');
  const manifest = { 'a.txt': sendproject.sha(Buffer.from('old')) };
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('held'), { code: 'EPERM' }); };
  let r;
  try {
    r = sendproject.applyChange(dir, { path: 'a.txt', status: 'changed' }, Buffer.from('new'), manifest);
  } finally {
    fs.renameSync = rename;
  }
  assert.match(r.error, /^EPERM: the file is in use/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'old');
  assert.deepStrictEqual(fs.readdirSync(dir), ['a.txt'], 'no temp file left');

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-busy-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateDir, 'sent'));
  fs.writeFileSync(path.join(stateDir, 'sent', 'abcdef012345.json'), JSON.stringify({ dir, manifest }));
  const busy = await remotework.applyTask(async () => ({ kind: 'sent', state: 'working', busy: true, files: [{ path: 'a.txt', status: 'changed' }] }), { task: 'abcdef012345', stateDir });
  assert.match(busy.error, /still working/);
});

test('a git remote goes to the other computer without its user name, token or password', () => {
  const { publicRemote } = require('../server/tasks');
  assert.strictEqual(publicRemote('https://me:ghp_secret@github.com/me/app.git'), 'https://github.com/me/app.git');
  assert.strictEqual(publicRemote('https://ghp_secret@github.com/me/app.git'), 'https://github.com/me/app.git');
  assert.strictEqual(publicRemote('git@github.com:me/app.git'), 'github.com:me/app.git');
  assert.strictEqual(publicRemote('ssh://git:pw@host/x.git'), 'ssh://host/x.git');
  assert.strictEqual(publicRemote(''), null);
});

test('more key and login files never cross between computers', () => {
  for (const rel of ['credentials', '.aws/credentials', 'deploy/prod.tfvars', 'backup.gpg', 'key.asc', '.htpasswd', 'secrets.yaml', 'api.token', '.ssh/config', '.kube/config', '.docker/config.json', 'app/.gnupg/pubring.kbx']) {
    assert.ok(sendproject.excluded(rel), rel);
  }
  for (const rel of ['src/credentials.js', 'docs/secret-sauce.md', 'src/App.jsx', 'config/app.json']) assert.ok(!sendproject.excluded(rel), rel);
});
