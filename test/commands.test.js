'use strict';
require('./isolate');
// The command palette's list (project, user and plugin commands and skills, plus built-ins that
// can only be copied), and a palette command sent from the page to Claude.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-cmd-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '4385';
const { listCommands, frontmatter } = require('../lib/commands');
const { ensureServer, stopServer, getJson } = require('../lib/client');
const config = require('../lib/config');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('frontmatter reads flat keys and strips quotes', () => {
  assert.deepStrictEqual(frontmatter('---\ndescription: "Deploy it"\nargument-hint: [env]\n---\nbody'), { description: 'Deploy it', 'argument-hint': '[env]' });
  assert.deepStrictEqual(frontmatter('no frontmatter'), {});
});

test('lists project, user and plugin commands and skills; built-ins are copy-only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-cmds-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'site');
  const claudeDir = path.join(root, 'home', '.claude');
  const plugin = path.join(root, 'plugins', 'deployer');
  write(path.join(project, '.claude', 'commands', 'ship.md'), '---\ndescription: Ship the site\nargument-hint: [env]\n---\nShip it.');
  write(path.join(project, '.claude', 'commands', 'db', 'reset.md'), 'Reset the dev database.');
  write(path.join(project, '.claude', 'commands', 'secret.md'), '---\ndisable-model-invocation: true\n---\nOnly manually.');
  write(path.join(project, '.claude', 'commands', 'compact.md'), 'Trying to shadow a built-in.');
  write(path.join(claudeDir, 'commands', 'ship.md'), 'User version, shadowed by the project.');
  write(path.join(claudeDir, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review a diff\n---\n');
  write(path.join(plugin, 'commands', 'deploy.md'), '---\ndescription: Deploy\n---\n');
  write(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'deployer@market': [{ scope: 'user', installPath: plugin }] } }));

  const list = listCommands({ projectDir: project, claudeDir });
  const by = Object.fromEntries(list.map((c) => [c.name, c]));
  assert.strictEqual(by.ship.source, 'project');
  assert.strictEqual(by.ship.argumentHint, '[env]');
  assert.strictEqual(by.ship.runnable, true);
  assert.strictEqual(by['db:reset'].description, 'Reset the dev database.');
  assert.strictEqual(by.secret.runnable, false);
  assert.strictEqual(by.review.kind, 'skill');
  assert.strictEqual(by.review.source, 'user');
  assert.strictEqual(by['deployer:deploy'].source, 'plugin deployer');
  assert.strictEqual(by.compact.kind, 'built-in', 'built-ins cannot be shadowed');
  assert.strictEqual(by.compact.runnable, false);
  assert.strictEqual(list.filter((c) => c.name === 'ship').length, 1);

  // A broken plugin registry is ignored.
  write(path.join(claudeDir, 'plugins', 'installed_plugins.json'), '{oops');
  assert.ok(listCommands({ projectDir: project, claudeDir }).some((c) => c.name === 'ship'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a palette command is sent to Claude as a request to run it', async (t) => {
  await ensureServer();
  t.after(async () => {
    await stopServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  const stream = new AbortController();
  await fetch(`${config.baseUrl}/events?page=pg1&root=${encodeURIComponent(stateDir)}`, { signal: stream.signal });
  t.after(() => stream.abort());
  const post = async (body) => {
    const res = await fetch(`${config.baseUrl}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId: 'pg1', ...body }) });
    return { status: res.status, body: await res.json() };
  };
  assert.strictEqual((await post({ command: { name: '../../etc', args: '' } })).status, 400);
  const ok = await post({ command: { name: 'deployer:deploy', args: 'now please' } });
  assert.strictEqual(ok.status, 200);
  assert.ok((await getJson('/history')).some((e) => e.type === 'page-message' && e.text === '/deployer:deploy now please' && e.command.name === 'deployer:deploy'));

  // The UserPromptSubmit hook passes it to Claude.
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'live-hook.js'), 'prompt'], {
    input: JSON.stringify({ session_id: 's1', cwd: stateDir, prompt: 'hi' }),
    env: { ...process.env, EDITLENS_WAIT_ANYWHERE: '1' },
    encoding: 'utf8',
  });
  const context = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(context, /Run the `\/deployer:deploy` command with arguments: now please/);
  assert.match(context, /Skill tool/);
});
