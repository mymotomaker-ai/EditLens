'use strict';
require('./isolate');
// A task on a sent project runs as the normal "editlens" account (lib/taskuser.js): its workspace
// is in that account's home and belongs to it, its Claude Code runs as it, its hooks report the
// task's edits with a key that can do nothing else, and git there runs as the account too.
// Creates the account, so it runs only as root on Linux with EDITLENS_TEST_ACCOUNT=1 (a test
// machine); the unit checks below run everywhere.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const taskuser = require('../lib/taskuser');
const remotework = require('../lib/remotework');
const { stopChildren } = require('./launch');

test('the account is found only as root on Linux, never a system account, and never quietly skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-acct-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const passwd = path.join(dir, 'passwd');
  const home = path.join(dir, 'home');
  fs.writeFileSync(passwd, `root:x:0:0:root:/root:/bin/bash\neditlens:x:1001:1001::${home}:/bin/bash\n`);
  assert.deepStrictEqual(taskuser.lookup('editlens', passwd), { name: 'editlens', uid: 1001, gid: 1001, home, shell: '/bin/bash' });
  assert.strictEqual(taskuser.account({ uid: 1000, platform: 'linux', passwd }), null, 'not root: as before');
  assert.strictEqual(taskuser.account({ uid: 0, platform: 'win32', passwd }), null);
  assert.strictEqual(taskuser.account({ uid: 0, platform: 'linux', passwd, setting: 'root' }), null);
  // It exists but has no Claude Code: an error, not root.
  assert.match(taskuser.account({ uid: 0, platform: 'linux', passwd }).error, /no Claude Code yet/);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '');
  const a = taskuser.account({ uid: 0, platform: 'linux', passwd });
  assert.strictEqual(a.workspaces, path.join(home, 'editlens-workspaces'));
  assert.strictEqual(a.stateDir, path.join(home, '.editlens-task'));
  // A system account (or root) by that name is never used.
  fs.writeFileSync(passwd, 'editlens:x:0:0::/root:/bin/bash\n');
  assert.strictEqual(taskuser.lookup('editlens', passwd), null);
  fs.writeFileSync(passwd, 'editlens:x:999:999::/var/lib/x:/bin/false\n');
  assert.strictEqual(taskuser.lookup('editlens', passwd), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Claude Code is started through runuser with the account\'s home and the hooks\' own folder', () => {
  const calls = [];
  const a = { name: 'editlens', uid: 1001, gid: 1001, home: '/home/editlens', shell: '/bin/bash', stateDir: '/home/editlens/.editlens-task' };
  const spawnAs = taskuser.spawner(a, 4317, (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return {};
  });
  spawnAs({ command: '/home/editlens/.local/bin/claude', args: ['--print'], cwd: '/home/editlens/editlens-workspaces/x', env: { HOME: '/root', PATH: '/usr/bin' } });
  assert.strictEqual(calls[0].cmd, 'runuser');
  assert.deepStrictEqual(calls[0].args, ['-u', 'editlens', '--', '/home/editlens/.local/bin/claude', '--print']);
  const env = calls[0].opts.env;
  assert.strictEqual(env.HOME, '/home/editlens');
  assert.strictEqual(env.USER, 'editlens');
  assert.strictEqual(env.EDITLENS_STATE_DIR, '/home/editlens/.editlens-task');
  assert.strictEqual(env.EDITLENS_NO_START, '1');
  assert.strictEqual(env.EDITLENS_PORT, '4317');
});

test('the account gets none of root\'s keys, tokens or other variables', () => {
  const calls = [];
  const a = { name: 'editlens', uid: 1001, gid: 1001, home: '/home/editlens', shell: '/bin/bash', stateDir: '/home/editlens/.editlens-task' };
  const spawnAs = taskuser.spawner(a, 4317, (cmd, args, opts) => {
    calls.push(opts.env);
    return {};
  });
  spawnAs({ command: 'claude', args: [], cwd: '/', env: { PATH: '/usr/bin', LANG: 'C.UTF-8', SECRET_X: '1', ANTHROPIC_API_KEY: 'sk-1', CLAUDE_CODE_OAUTH_TOKEN: 't', GITHUB_TOKEN: 'g', AWS_SECRET_ACCESS_KEY: 'a', DATABASE_URL: 'd', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', HOME: '/root' } });
  const env = calls[0];
  for (const k of ['SECRET_X', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL']) assert.strictEqual(env[k], undefined, k);
  assert.strictEqual(env.PATH, '/usr/bin');
  assert.strictEqual(env.LANG, 'C.UTF-8');
  assert.strictEqual(env.CLAUDE_CODE_ENTRYPOINT, 'sdk-ts');
  assert.strictEqual(env.HOME, '/home/editlens');
  // git as the account too.
  const g = taskuser.baseEnv({ name: 'editlens', home: '/home/editlens' }, { PATH: '/bin', GITHUB_TOKEN: 'g' }, { GIT_INDEX_FILE: '/x' });
  assert.deepStrictEqual(g, { PATH: '/bin', HOME: '/home/editlens', USER: 'editlens', LOGNAME: 'editlens', SHELL: '/bin/bash', GIT_INDEX_FILE: '/x' });
});

// This test uses the real /etc/passwd (test/isolate.js hides it from the others). It never runs where
// an "editlens" account already exists: it would replace that account's Claude Code with the stand-in.
const REAL = '/etc/passwd';
const LIVE = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0 && process.env.EDITLENS_TEST_ACCOUNT === '1'
  && spawnSync('runuser', ['--help']).status === 0;
const SKIP = !LIVE ? 'needs root on Linux and EDITLENS_TEST_ACCOUNT=1 (it creates the account)'
  : taskuser.lookup('editlens', REAL) ? 'an "editlens" account already exists here; this test runs only where it can make its own' : false;

test('a sent task runs as the editlens account, end to end', { skip: SKIP }, async (t) => {
  // Cleanup first, so a failed step never leaves the account or the folders behind.
  const children = new Set();
  let base = null;
  let madeUid = null;
  const uidNow = () => {
    const r = spawnSync('id', ['-u', 'editlens'], { encoding: 'utf8' });
    return r.status === 0 && /^\d+\n?$/.test(r.stdout) ? Number(r.stdout) : null;
  };
  // The account this run made, still with its uid: one made again by something else is not changed.
  const ours = () => madeUid !== null && uidNow() === madeUid;
  t.after(async () => {
    // The servers save their state as they exit: remove the folder only after they have ended.
    await stopChildren([...children]);
    if (base) fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (ours()) spawnSync('userdel', ['-r', 'editlens']);
  });
  // An account that appeared after the skip check was made by something else: it is never changed.
  if (taskuser.lookup('editlens', REAL)) return t.skip('an "editlens" account appeared after the first check');
  // useradd fails when the account appeared just now; then nothing here is changed or removed.
  assert.strictEqual(spawnSync('useradd', ['--create-home', '--shell', '/bin/bash', '--user-group', 'editlens']).status, 0);
  madeUid = uidNow();
  const acct = taskuser.lookup('editlens', REAL);
  assert.ok(acct && acct.uid === madeUid, 'the account is the one this run made');
  const claude = path.join(acct.home, '.local', 'bin', 'claude');
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), claude);
  fs.chmodSync(claude, 0o755);
  spawnSync('chown', ['-R', 'editlens:editlens', path.join(acct.home, '.local')]);

  base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-acct-e2e-'));
  fs.chmodSync(base, 0o755); // the account reads the fake's sign-in marker
  const SERVER = path.join(__dirname, '..', 'server', 'server.js');
  const HOST = { port: 4933, pairPort: 4934, dir: path.join(base, 'host') };
  const REMOTE = { port: 4935, pairPort: 4936, dir: path.join(base, 'remote') };
  const fake = path.join(base, 'fake');
  const vpsProject = path.join(base, 'vps-site');
  const laptopProject = path.join(base, 'laptop-app');
  const git = (cwd, ...args) => assert.strictEqual(spawnSync('git', ['-C', cwd, ...args]).status, 0);
  for (const [dir, files] of [[vpsProject, { 'index.html': '<h1>VPS</h1>\n' }], [laptopProject, { 'src/App.jsx': 'old\n' }]]) {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    git(dir, 'init', '-q');
    git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'add', '-A');
    git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'start');
  }
  const sdk = path.join(fake, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
  fs.mkdirSync(path.join(fake, 'state'), { recursive: true });
  fs.chmodSync(fake, 0o755);
  fs.chmodSync(path.join(fake, 'state'), 0o755);
  fs.writeFileSync(path.join(fake, 'state', 'signed-in'), 'yes');
  fs.writeFileSync(path.join(path.dirname(claude), '.fake-state'), path.join(fake, 'state'));

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
  async function waitFor(fn, ms = 15000) {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v || Date.now() > end) return v;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  function startServer(s, extra = {}) {
    fs.mkdirSync(s.dir, { recursive: true });
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, EDITLENS_TEST_PASSWD: REAL, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir, ...extra }, stdio: 'ignore' });
    children.add(child);
    child.on('exit', () => children.delete(child));
    return waitFor(async () => (await request(s.port, 'GET', '/health')).status === 200);
  }
  const token = (s) => fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8');
  const api = (s, method, urlPath, body) => request(s.port, method, urlPath, body, { 'x-editlens-token': token(s) }).then((r) => r.json);
  const call = (op, extra) => api(REMOTE, 'POST', '/remote/task', { op, ...extra });

  // Root's keys and tokens stay root's: the account's Claude never sees them.
  await startServer(HOST, { EDITLENS_SDK_DIR: path.join(fake, 'sdk'), FAKE_CLAUDE_STATE: path.join(fake, 'state'), TEST_SECRET_X: 'root-only', ANTHROPIC_API_KEY: 'sk-root-only' });
  await startServer(REMOTE);
  await api(HOST, 'POST', '/event', { type: 'session', sessionId: 'h1', cwd: vpsProject, ts: Date.now() });
  const { code } = await api(HOST, 'POST', '/pair', { cwd: vpsProject });
  assert.ok((await api(REMOTE, 'POST', '/join', { address: `127.0.0.1:${HOST.pairPort}`, code })).ok);

  const started = await remotework.sendAndStart(call, { dir: laptopProject, prompt: 'write src/App.jsx new', stateDir: REMOTE.dir });
  assert.ok(started.task, JSON.stringify(started));
  const ws = started.workspace.folder;
  assert.ok(ws.startsWith(path.join(acct.home, 'editlens-workspaces') + '/'), ws);
  assert.strictEqual(fs.statSync(ws).uid, acct.uid, 'the workspace belongs to the account');
  const done = await waitFor(async () => {
    const r = await call('check', { task: started.task });
    return r.state === 'idle' && r.replyCount >= 1 && r;
  });
  assert.ok(done, 'the task finished');
  const ran = JSON.parse(JSON.parse(fs.readFileSync(path.join(fake, 'state', 'spawned'), 'utf8').trim().split('\n')[0]).out);
  assert.deepStrictEqual(ran, { user: 'editlens', home: acct.home, stateDir: path.join(acct.home, '.editlens-task'), noStart: '1', hook: 0, secret: null });
  assert.strictEqual(fs.readFileSync(path.join(ws, 'src', 'App.jsx'), 'utf8'), 'new\n');
  assert.strictEqual(fs.statSync(path.join(ws, 'src', 'App.jsx')).uid, acct.uid);

  // Its hook reported the edit with the account's own key: on the task's card.
  const card = await waitFor(async () => {
    const w = await call('watch', { task: started.task, since: 0 });
    return w.card && w.card.edits && w.card.edits.length && w.card;
  });
  assert.ok(card, 'the edit is on the card');
  assert.strictEqual(card.edits[0].relFile, 'src/App.jsx');

  // That key does nothing else.
  const key = fs.readFileSync(path.join(acct.home, '.editlens-task', `token-${HOST.port}`), 'utf8');
  assert.notStrictEqual(key, token(HOST));
  const as = (method, p, body) => request(HOST.port, method, p, body, { 'x-editlens-token': key });
  assert.strictEqual((await as('POST', '/remote/task', { op: 'list' })).status, 401);
  assert.strictEqual((await as('POST', '/settings/report', { values: {} })).status, 401);
  assert.strictEqual((await as('POST', '/event', { type: 'change', cwd: vpsProject, file: path.join(vpsProject, 'index.html') })).status, 403, 'outside its workspaces');
  assert.strictEqual((await as('POST', '/event', { type: 'ask', cwd: ws })).status, 403, 'not a question');
  fs.symlinkSync('/etc/passwd', path.join(ws, 'link'));
  assert.strictEqual((await as('POST', '/event', { type: 'change', cwd: ws, file: path.join(ws, 'link') })).status, 403, 'not through a link out');
  fs.rmSync(path.join(ws, 'link'));

  // Whatever it sends, the account's own sockets get only the health check and its edit reports:
  // not the EditLens window (and its key), the page stream, snapshots or messages.
  const asAccount = (method, p, headers = {}) => {
    // http, not fetch: Node's fetch replaces sec-fetch-mode, and the test forges what a browser sends.
    const js = `require('http').request({ host: '127.0.0.1', port: ${HOST.port}, path: '${p}', method: '${method}', headers: ${JSON.stringify(headers)} }, (r) => console.log(r.statusCode)).on('error', () => console.log(0)).end()`;
    return Number(spawnSync('runuser', ['-u', 'editlens', '--', process.execPath, '-e', js], { encoding: 'utf8', cwd: '/' }).stdout.trim());
  };
  assert.strictEqual(asAccount('GET', '/health'), 200);
  assert.strictEqual(asAccount('GET', '/answer', { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' }), 403, 'no window, so no key for it');
  assert.strictEqual(asAccount('GET', '/answer/list', { 'sec-fetch-site': 'same-origin' }), 403);
  assert.strictEqual(asAccount('GET', `/snapshot?id=s1`), 403);
  assert.strictEqual(asAccount('POST', '/message', { 'content-type': 'application/json' }), 403);
  assert.strictEqual(asAccount('POST', '/event', { 'x-editlens-token': token(HOST) }), 403, 'not even with root\'s key');
  const rootOpen = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: HOST.port, path: '/answer', agent: false, headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' } }, (r) => {
    r.resume();
    resolve(r.statusCode);
  }).on('error', () => resolve(0)));
  assert.strictEqual(rootOpen, 200, 'root still opens it');

  // Review runs git as the account: it works, and leaves nothing in the workspace owned by root.
  const changes = await call('changes', { task: started.task });
  assert.deepStrictEqual(changes.files.map((f) => [f.path, f.status]), [['src/App.jsx', 'changed']]);
  assert.match((await call('diff', { task: started.task })).diff, /\+new/);
  assert.ok((await call('search', { task: started.task, text: 'new' })).matches.length);
  const notOwned = spawnSync('find', [ws, '-not', '-user', 'editlens'], { encoding: 'utf8' }).stdout.trim();
  assert.strictEqual(notOwned, '', 'nothing owned by root');
  await call('stop', { task: started.task });
});

test('tests never use this computer\'s real task account or Claude Code settings (test/isolate.js)', () => {
  // Every test, preview and e2e script loads it first (an e2e script uses the real Claude only with
  // EDITLENS_E2E_REAL_CLAUDE=1, Sol M15).
  const dir = __dirname;
  const missing = fs.readdirSync(dir).filter((f) => /(\.test|-preview)\.js$|^(preview|docs-pairing|e2e-[\w-]+)\.js$/.test(f))
    .filter((f) => !/^'use strict';\nrequire\('\.\/isolate'\);$/m.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepStrictEqual(missing, []);
  assert.match(fs.readFileSync(path.join(dir, 'run.js'), 'utf8'), /require\('\.\/isolate'\)/);
  // The account is looked up in the test's own passwd file, which has no "editlens" line.
  assert.ok(process.env.EDITLENS_TEST_PASSWD && process.env.CLAUDE_CONFIG_DIR.startsWith(os.tmpdir()));
  assert.strictEqual(taskuser.lookup(), null);
  assert.strictEqual(taskuser.account({ uid: 0, platform: 'linux' }), null, 'as root on Linux too: no account, so the stand-in Claude');
});
