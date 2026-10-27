'use strict';
require('./isolate');
// A dev server on a usual port connects by itself when the program listening there runs from the
// project; otherwise EditLens asks (a one-click Connect in the mod, or /editlens <address>).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { portOwner, ownsProject, netstatPid, listeningInodes } = require('../lib/portowner');
const { devServerOf } = require('../lib/connect');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-owner-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test('netstat lines: the listening process on that port only', () => {
  const text = [
    'Active Connections',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1052',
    '  TCP    127.0.0.1:30000        0.0.0.0:0              LISTENING       77',
    '  TCP    127.0.0.1:3000         127.0.0.1:52000        ESTABLISHED     88',
    '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       4242',
    '  TCP    [::1]:8080             [::]:0                 LISTENING       NaN',
  ].join('\r\n');
  assert.strictEqual(netstatPid(text, 3000), 4242);
  assert.strictEqual(netstatPid(text, 8080), null);
  assert.strictEqual(netstatPid(text, 5173), null);
  assert.strictEqual(netstatPid('', 3000), null);
});

test('/proc/net/tcp: listening sockets on the port', () => {
  const proc = fs.mkdtempSync(path.join(base, 'proc-'));
  fs.mkdirSync(path.join(proc, 'net'));
  const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  fs.writeFileSync(path.join(proc, 'net', 'tcp'), head
    + '   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5555 1 0\n'
    + '   1: 0100007F:0BB8 0100007F:CB20 01 00000000:00000000 00:00000000 00000000  1000        0 6666 1 0\n'
    + '   2: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7777 1 0\n');
  assert.deepStrictEqual([...listeningInodes(3000, proc)], ['5555']);
  assert.deepStrictEqual([...listeningInodes(8080, proc)], ['7777']);
  assert.deepStrictEqual([...listeningInodes(4000, proc)], []);
});

test('who owns the project: working folder, monorepo root, or a path on the command line', () => {
  const app = fs.mkdtempSync(path.join(base, 'app-'));
  const other = fs.mkdtempSync(path.join(base, 'other-'));
  assert.strictEqual(ownsProject({ dir: app }, app), true);
  assert.strictEqual(ownsProject({ dir: path.join(app, 'web') }, app), true);
  assert.strictEqual(ownsProject({ dir: other }, app), false);
  // The project inside the server's folder counts only when that folder is a project root.
  const mono = fs.mkdtempSync(path.join(base, 'mono-'));
  fs.mkdirSync(path.join(mono, 'apps', 'web'), { recursive: true });
  assert.strictEqual(ownsProject({ dir: mono }, path.join(mono, 'apps', 'web')), false);
  fs.writeFileSync(path.join(mono, 'package.json'), '{}');
  assert.strictEqual(ownsProject({ dir: mono }, path.join(mono, 'apps', 'web')), true);
  // Never the home folder or a root.
  assert.strictEqual(ownsProject({ dir: os.homedir() }, path.join(os.homedir(), 'x')), false);
  assert.strictEqual(ownsProject({ dir: '/' }, app), false);
  assert.strictEqual(ownsProject({ dir: app }, os.homedir()), false);
  // Windows: the command line names the project (case and slashes don't matter); a longer
  // folder name that starts the same doesn't count.
  const cmd = 'node "C:\\Users\\Me\\Proj\\node_modules\\next\\dist\\bin\\next" dev';
  assert.strictEqual(ownsProject({ dir: null, command: cmd }, 'C:\\Users\\Me\\Proj'), true);
  assert.strictEqual(ownsProject({ dir: null, command: cmd }, 'c:/users/me/proj'), true);
  assert.strictEqual(ownsProject({ dir: null, command: cmd }, 'C:\\Users\\Me\\Pro'), false);
  assert.strictEqual(ownsProject({ dir: null, command: `node ${app}/server.js` }, app), true);
  assert.strictEqual(ownsProject({ dir: null, command: `node ${app}2/server.js` }, app), false);
  assert.strictEqual(ownsProject({ dir: null, command: '' }, app), false);
  assert.strictEqual(ownsProject(null, app), false);
});

function startServer(cwd) {
  const code = "const s=require('http').createServer((q,r)=>{r.setHeader('content-type','text/html');r.end('<title>Dev</title>')});s.listen(0,'127.0.0.1',()=>console.log(s.address().port));";
  const child = spawn(process.execPath, ['-e', code], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => child.stdout.once('data', (d) => {
    const port = Number(String(d).trim());
    // The port the child printed: a whole number 1-65535, or the test stops here.
    if (Number.isInteger(port) && port >= 1 && port <= 65535) resolve({ child, port });
    else {
      child.kill();
      reject(new Error(`the dev server printed no port: ${String(d).trim()}`));
    }
  }));
}

test('a dev server running from the project is found and connected by itself', { skip: process.platform === 'win32' }, async (t) => {
  const app = fs.mkdtempSync(path.join(base, 'live-'));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '15' } }));
  const elsewhere = fs.mkdtempSync(path.join(base, 'elsewhere-'));
  const mine = await startServer(app);
  const theirs = await startServer(elsewhere);
  t.after(() => { mine.child.kill(); theirs.child.kill(); });

  const owner = await portOwner(mine.port);
  assert.ok(owner && owner.pid === mine.child.pid, JSON.stringify(owner));
  assert.strictEqual(ownsProject(owner, app), true);
  assert.strictEqual(ownsProject(await portOwner(theirs.port), app), false);

  // Remembered long ago (not recent): proven by the process, so sure.
  const stateDir = fs.mkdtempSync(path.join(base, 'state-'));
  const write = (port) => fs.writeFileSync(path.join(stateDir, 'targets.json'), JSON.stringify({ targets: { [path.resolve(app)]: `http://localhost:${port}` } }));
  write(mine.port);
  const found = await devServerOf(app, { stateDir, skip: [3000, 4321, 4200, 8080] });
  assert.deepStrictEqual({ url: found.url, sure: found.sure, from: found.from }, { url: `http://localhost:${mine.port}`, sure: true, from: 'process' });
  // Another folder's server on that address: still asks.
  write(theirs.port);
  const unsure = await devServerOf(app, { stateDir, skip: [3000, 4321, 4200, 8080] });
  assert.deepStrictEqual({ url: unsure.url, sure: unsure.sure }, { url: `http://localhost:${theirs.port}`, sure: false });
});

test('PORT in the project\'s .env counts as the project\'s own port', async () => {
  const { devCandidates } = require('../lib/connect');
  const app = fs.mkdtempSync(path.join(base, 'env-'));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));
  fs.writeFileSync(path.join(app, '.env'), 'API_KEY=x\nPORT="4100"\n');
  const list = devCandidates(app);
  assert.deepStrictEqual(list[0], { port: 4100, from: 'script' });
  fs.writeFileSync(path.join(app, '.env'), 'PORT=abc\n');
  assert.ok(!devCandidates(app).some((c) => c.from === 'script'));
});
