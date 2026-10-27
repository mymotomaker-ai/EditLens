'use strict';
require('./isolate');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const wt = require('../lib/worktree');

function sh(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim();
}

// Every test's folders are in one, removed at the end.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-wt-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

// A project with one commit and a copy at .claude/worktrees/agent-a1, made the way Claude Code makes them.
function project() {
  const root = fs.mkdtempSync(path.join(base, 'p-'));
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 't@example.com');
  sh(root, 'config', 'user.name', 'T');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'App.jsx'), 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\n');
  fs.writeFileSync(path.join(root, 'src', 'Nav.jsx'), 'nav\n');
  fs.writeFileSync(path.join(root, 'src', 'Old.jsx'), 'old\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.claude/\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'start');
  const dir = path.join(root, '.claude', 'worktrees', 'agent-a1');
  sh(root, 'worktree', 'add', '-q', '-b', 'worktree-agent-a1', dir, 'HEAD');
  return { root, dir };
}

test('copyOf finds the project and copy of a path inside a copy', async () => {
  const c = wt.copyOf('/home/me/shop/.claude/worktrees/agent-a1/src/App.jsx');
  assert.deepStrictEqual(c, { root: '/home/me/shop', name: 'agent-a1', dir: path.join('/home/me/shop', '.claude', 'worktrees', 'agent-a1'), rel: 'src/App.jsx' });
  assert.strictEqual(wt.copyOf('C:\\Users\\me\\shop\\.claude\\worktrees\\agent-a1').name, 'agent-a1');
  assert.strictEqual(wt.copyOf('/home/me/shop/src/App.jsx'), null);
  assert.strictEqual(wt.copyOf(undefined), null);
});

test('wantsCopy: editing subagents only, and never over the caller\'s own choice', () => {
  assert.strictEqual(wt.wantsCopy({ subagent_type: 'general-purpose' }), true);
  assert.strictEqual(wt.wantsCopy({}), true);
  assert.strictEqual(wt.wantsCopy({ subagent_type: 'Explore' }), false);
  assert.strictEqual(wt.wantsCopy({ subagent_type: 'general-purpose', isolation: 'remote' }), false);
  assert.strictEqual(wt.wantsCopy({ subagent_type: 'general-purpose', cwd: '/x' }), false);
});

test('canCopy needs a git project with a commit', async () => {
  const plain = fs.mkdtempSync(path.join(base, 'plain-'));
  assert.strictEqual(wt.canCopy(plain), false);
  sh(plain, 'init', '-q');
  assert.strictEqual(wt.canCopy(plain), false);
  const { root, dir } = project();
  assert.strictEqual(wt.canCopy(root), true);
  assert.strictEqual(wt.canCopy(dir), false); // already inside a copy
});

test('status and merge: clean, merged, same, added, deleted and a conflict', async () => {
  const { root, dir } = project();
  // The copy: edits App line 2, rewrites Nav, adds New, deletes Old.
  const app = path.join(dir, 'src', 'App.jsx');
  fs.writeFileSync(app, fs.readFileSync(app, 'utf8').replace('line 2', 'line 2 (copy)'));
  fs.writeFileSync(path.join(dir, 'src', 'Nav.jsx'), 'nav (copy)\n');
  fs.writeFileSync(path.join(dir, 'src', 'New.jsx'), 'new\n');
  fs.rmSync(path.join(dir, 'src', 'Old.jsx'));
  // The project meanwhile: App line 7 (different lines: merges), Nav itself (same line: conflict).
  const mainApp = path.join(root, 'src', 'App.jsx');
  fs.writeFileSync(mainApp, fs.readFileSync(mainApp, 'utf8').replace('line 7', 'line 7 (main)'));
  fs.writeFileSync(path.join(root, 'src', 'Nav.jsx'), 'nav (main)\n');

  const st = await wt.status(root, 'agent-a1');
  const by = Object.fromEntries(st.files.map((f) => [f.relFile, f]));
  assert.strictEqual(st.branch, 'worktree-agent-a1');
  assert.strictEqual(by['src/App.jsx'].state, 'merged');
  assert.strictEqual(by['src/Nav.jsx'].state, 'conflict');
  assert.strictEqual(by['src/New.jsx'].state, 'clean');
  assert.strictEqual(by['src/New.jsx'].added, true);
  assert.strictEqual(by['src/Old.jsx'].state, 'clean');
  assert.strictEqual(by['src/Old.jsx'].deleted, true);

  const res = await wt.merge(root, 'agent-a1');
  assert.deepStrictEqual(res.conflicts, ['src/Nav.jsx']);
  assert.deepStrictEqual(res.applied.map((a) => a.relFile).sort(), ['src/App.jsx', 'src/New.jsx', 'src/Old.jsx']);
  const merged = fs.readFileSync(mainApp, 'utf8');
  assert.ok(merged.includes('line 2 (copy)') && merged.includes('line 7 (main)'), merged);
  assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'New.jsx'), 'utf8'), 'new\n');
  assert.strictEqual(fs.existsSync(path.join(root, 'src', 'Old.jsx')), false);
  // Never merged silently.
  assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'Nav.jsx'), 'utf8'), 'nav (main)\n');
  const old = res.applied.find((a) => a.relFile === 'src/Old.jsx');
  assert.strictEqual(old.before, 'old\n');
  assert.strictEqual(old.after, null);

  // Merging again changes nothing; taking the copy's Nav resolves the last one.
  const again = await wt.merge(root, 'agent-a1');
  assert.strictEqual(again.applied.length, 0);
  const took = await wt.merge(root, 'agent-a1', { take: ['src/Nav.jsx'] });
  assert.deepStrictEqual(took.applied.map((a) => a.relFile), ['src/Nav.jsx']);
  assert.strictEqual(took.applied[0].before, 'nav (main)\n');
  assert.ok((await wt.status(root, 'agent-a1')).files.every((f) => f.state === 'same'));
});

test('commits made in the copy count too', async () => {
  const { root, dir } = project();
  fs.writeFileSync(path.join(dir, 'src', 'Nav.jsx'), 'nav (committed)\n');
  sh(dir, 'commit', '-q', '-am', 'copy work');
  const res = await wt.merge(root, 'agent-a1');
  assert.deepStrictEqual(res.applied.map((a) => a.relFile), ['src/Nav.jsx']);
  assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'Nav.jsx'), 'utf8'), 'nav (committed)\n');
});

test('listCopies and remove', async () => {
  const { root, dir } = project();
  assert.deepStrictEqual(wt.listCopies(root), ['agent-a1']);
  assert.ok(wt.remove(root, 'agent-a1').ok);
  assert.strictEqual(fs.existsSync(dir), false);
  assert.deepStrictEqual(wt.listCopies(root), []);
  assert.strictEqual(spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'worktree-agent-a1']).status, 1);
  assert.ok((await wt.status(root, '../x')).error);
  assert.ok(wt.remove(root, '../x').error);
});

test('a copy with many changed files: the server keeps answering, a second check is quick, edits show', async () => {
  const { root, dir } = project();
  const many = path.join(root, 'many');
  fs.mkdirSync(many);
  for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), 'a\nb\nc\nd\ne\nf\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'many');
  sh(dir, 'merge', '-q', 'main');
  // Both sides change every file, in different lines: each one needs a three-way merge.
  for (let i = 0; i < 150; i++) {
    fs.writeFileSync(path.join(dir, 'many', `f${i}.txt`), 'a (copy)\nb\nc\nd\ne\nf\n');
    fs.writeFileSync(path.join(many, `f${i}.txt`), 'a\nb\nc\nd\ne\nf (main)\n');
  }
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const t0 = Date.now();
  const st = await wt.status(root, 'agent-a1');
  const first = Date.now() - t0;
  clearInterval(timer);
  assert.strictEqual(st.files.filter((f) => f.state === 'merged').length, 150);
  assert.ok(ticks >= 3, `the event loop ran meanwhile (${ticks} ticks in ${first} ms)`);

  const t1 = Date.now();
  const again = await wt.status(root, 'agent-a1');
  assert.ok(Date.now() - t1 < first, 'the second check reuses the first');
  assert.deepStrictEqual(again.files.map((f) => f.state), st.files.map((f) => f.state));

  // The project changes the same line as the copy: that file is a conflict now.
  fs.writeFileSync(path.join(many, 'f7.txt'), 'a (main)\nb\nc\nd\ne\nf (main)\n');
  const after = await wt.status(root, 'agent-a1');
  assert.strictEqual(after.files.find((f) => f.relFile === 'many/f7.txt').state, 'conflict');

  // Two merges at the same time: one after the other, and each file goes in once.
  const [m1, m2] = await Promise.all([wt.merge(root, 'agent-a1'), wt.merge(root, 'agent-a1')]);
  assert.strictEqual(m1.applied.length, 149);
  assert.strictEqual(m2.applied.length, 0);
  assert.deepStrictEqual(m2.conflicts, ['many/f7.txt']);
  assert.strictEqual(fs.readFileSync(path.join(many, 'f3.txt'), 'utf8'), 'a (copy)\nb\nc\nd\ne\nf (main)\n');
});

test('configuration and keys an agent wrote in its copy are never merged', async () => {
  const { root, dir } = project();
  fs.writeFileSync(path.join(dir, '.mcp.json'), '{"mcpServers":{"x":{"command":"evil"}}}\n');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=1\n');
  fs.writeFileSync(path.join(dir, 'deploy.pem'), 'key\n');
  fs.writeFileSync(path.join(dir, 'src', 'Nav.jsx'), 'nav 2\n');
  const st = await wt.status(root, 'agent-a1');
  const by = Object.fromEntries(st.files.map((f) => [f.relFile, f.state]));
  assert.deepStrictEqual(by, { '.mcp.json': 'held', '.env': 'held', 'deploy.pem': 'held', 'src/Nav.jsx': 'clean' });
  const res = await wt.merge(root, 'agent-a1', { take: ['.mcp.json'] });
  assert.deepStrictEqual(res.applied.map((a) => a.relFile), ['src/Nav.jsx']);
  for (const f of ['.mcp.json', '.env', 'deploy.pem']) assert.ok(!fs.existsSync(path.join(root, f)), f);
});

// H1 (Sol scan of 0.24.40): merging never goes through a link, in the project or in the copy, to a
// file outside the project or to one the merge keeps back.
test('a merge never reads or writes through a link outside the project or into held-back files', async () => {
  const { root, dir } = project();
  const outside = fs.mkdtempSync(path.join(base, 'outside-'));
  fs.writeFileSync(path.join(outside, 'data.txt'), 'outside data\n');
  // The project has links: one out of the project, one to its own .claude folder.
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'out'));
  fs.symlinkSync(path.join(root, '.claude'), path.join(root, 'cfg'));
  // The copy writes real folders with those names, and a link to a file outside.
  fs.mkdirSync(path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'out', 'new.txt'), 'written outside\n');
  fs.mkdirSync(path.join(dir, 'cfg'));
  fs.writeFileSync(path.join(dir, 'cfg', 'settings.json'), '{"hooks":{}}\n');
  fs.symlinkSync(path.join(outside, 'data.txt'), path.join(dir, 'data.txt'));
  fs.writeFileSync(path.join(dir, 'src', 'Nav.jsx'), 'nav 2\n');
  const st = await wt.status(root, 'agent-a1');
  const by = Object.fromEntries(st.files.map((f) => [f.relFile, f.state]));
  assert.deepStrictEqual(by, { 'cfg/settings.json': 'held', 'data.txt': 'held', 'out/new.txt': 'held', 'src/Nav.jsx': 'clean' });
  const res = await wt.merge(root, 'agent-a1', { take: ['out/new.txt', 'cfg/settings.json', 'data.txt'] });
  assert.deepStrictEqual(res.applied.map((a) => a.relFile), ['src/Nav.jsx']);
  assert.ok(!fs.existsSync(path.join(outside, 'new.txt')), 'nothing written outside the project');
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'settings.json')), 'nothing written in .claude');
  assert.ok(fs.lstatSync(path.join(root, 'out')).isSymbolicLink() && !fs.existsSync(path.join(root, 'data.txt')), 'the outside file was not copied in');
});

// H3 (Sol scan of 0.24.43): a folder of the project becomes a link (to a file with the same text)
// while the text merge runs; the write must not go there.
test('a folder that becomes a link while the merge runs is not written through', async () => {
  const { root, dir } = project();
  const app = path.join(dir, 'src', 'App.jsx');
  fs.writeFileSync(app, fs.readFileSync(app, 'utf8').replace('line 2', 'line 2 (copy)'));
  const mainApp = path.join(root, 'src', 'App.jsx');
  fs.writeFileSync(mainApp, fs.readFileSync(mainApp, 'utf8').replace('line 7', 'line 7 (main)'));
  const outside = fs.mkdtempSync(path.join(base, 'outside-'));
  // A git that swaps the folder for the link at the second text merge (the first is the status
// check), then runs the real git.
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = fs.mkdtempSync(path.join(base, 'bin-'));
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const count = ${JSON.stringify(path.join(bin, 'count'))};
const n = args.includes('merge-file') ? (fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0) + 1 : 0;
if (n) fs.writeFileSync(count, String(n));
if (n === 2) {
  fs.copyFileSync(${JSON.stringify(mainApp)}, ${JSON.stringify(path.join(outside, 'App.jsx'))});
  fs.renameSync(${JSON.stringify(path.join(root, 'src'))}, ${JSON.stringify(path.join(root, 'src-was'))});
  fs.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(path.join(root, 'src'))});
}
const r = require('child_process').spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + savedPath;
  let res;
  try {
    res = await wt.merge(root, 'agent-a1');
  } finally {
    process.env.PATH = savedPath;
  }
  assert.ok(!fs.readFileSync(path.join(outside, 'App.jsx'), 'utf8').includes('line 2 (copy)'), 'nothing written outside the project');
  assert.ok(res.conflicts.includes('src/App.jsx'), JSON.stringify(res));
});
