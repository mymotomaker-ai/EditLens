'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4924';
// Claude can't answer its own questions: commands and fetches to EditLens's own approval and
// control endpoints (or its keys) are denied, in every session; the EditLens window's AnswerDesk only
// takes looser modes from the window.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { selfCall, editlensPorts } = require('../lib/selfguard');
const { AnswerDesk, LOOSE_MODES } = require('../server/answer');
const { Asks } = require('../server/asks');

test('commands and fetches to EditLens endpoints are denied; the app and other calls are not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-selfguard-'));
  try {
    fs.writeFileSync(path.join(dir, 'pair-remote.json'), JSON.stringify({ hosts: [{ liveGateway: 61234, siteGateway: 61235 }, { liveGateway: 'x' }] }));
    const ports = editlensPorts({ stateDir: dir, port: 4317, pairPort: 4318 });
    assert.deepStrictEqual(ports.sort(), [4317, 4318, 61234, 61235]);
    const o = { stateDir: dir, ports };
    const denied = [
      ['Bash', 'curl -d \'{"decision":"allow"}\' http://127.0.0.1:4317/task/answer'],
      ['Bash', 'curl -s localhost:4317/answer | grep KEY'],
      ['Bash', 'curl http://127.0.0.1:61234/drive/permission'],
      ['Bash', 'wget -qO- http://[::1]:4317/copy/merge'],
      ['PowerShell', 'Invoke-WebRequest http://localhost:4317/settings -Method POST'],
      ['WebFetch', 'http://localhost:4317/answer/list'],
      ['Bash', 'cat ~/.claude/editlens/token-4317'],
      ['Bash', `cat ${path.join(dir, 'token-4317')}`],
      // D21: the file the page key is made from.
      ['Bash', 'cat ~/.claude/editlens/gateway-key'],
      ['Bash', `cat ${path.join(dir, 'gateway-key')}`],
      ['Bash', `curl localhost:4317/gk-${'a'.repeat(32)}/answer`],
      ['Bash', 'curl http://127.1:4317/answer'],
      ['Bash', 'curl http://127.0.1:4317/answer'],
      ['Bash', 'curl http://0177.0.0.1:4317/answer'],
      ['Bash', 'curl http://[::ffff:7f00:1]:4317/answer'],
      ['Bash', 'curl -N localhost:4317/events?page=x'],
      ['Bash', 'curl -d x localhost:4317/message'],
      ['Bash', 'curl localhost:4317/snapshot?id=s1'],
      ['Bash', 'cat ~/.claude/editlens/token-*'],
      ['Bash', 'cat ~/.claude/editlens/*'],
      // A POST to /health in the same command is still refused, and so is a closed path after it.
      ['Bash', 'curl -d x http://127.0.0.1:4317/health'],
      ['Bash', 'curl -s http://127.0.0.1:4317/health && curl http://localhost:4317/settings'],
    ];
    for (const [tool, text] of denied) assert.ok(selfCall(tool, tool === 'WebFetch' ? { url: text } : { command: text }, o), text);
    const allowed = [
      ['Bash', 'curl localhost:3000/settings'],
      ['Bash', 'curl http://127.0.0.1:4317/health'],
      ['Bash', 'npm test'],
      // Flags of other commands in the same line are not a POST to /health (0.24.32 refused these).
      ['Bash', 'tar -T list.txt -cf x.tar && curl -s http://127.0.0.1:4317/health'],
      ['Bash', 'ls -d ~/.claude/plugins/cache/editlens/* ; curl -s http://127.0.0.1:4317/health'],
      ['Bash', 'curl -s http://127.0.0.1:4317/health; curl -d x https://example.com'],
      ['WebFetch', 'https://example.com/answer'],
      ['Read', 'http://127.0.0.1:4317/answer'],
    ];
    for (const [tool, text] of allowed) assert.strictEqual(selfCall(tool, tool === 'WebFetch' ? { url: text } : { command: text }, o), null, text);
    assert.strictEqual(selfCall('Bash', null, o), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Bash hook denies a call to the approval endpoint', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'live-hook.js'), 'bash'], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: os.tmpdir(), tool_name: 'Bash', tool_input: { command: 'curl -X POST http://127.0.0.1:4924/answer' } }),
    encoding: 'utf8', env: { ...process.env, EDITLENS_PORT: '4924' },
  });
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /EditLens window/);
});

test('looser modes wait for the window; the key is never in a list', () => {
  assert.deepStrictEqual([...LOOSE_MODES].sort(), ['acceptEdits', 'bypassPermissions']);
  const desk = new AnswerDesk();
  assert.match(desk.key, /^[0-9a-f]{64}$/);
  assert.ok(desk.keyOk(desk.key));
  assert.ok(!desk.keyOk(''));
  assert.ok(!desk.keyOk(desk.key.slice(1)));
  const first = desk.requestMode(null, 'acceptEdits');
  const second = desk.requestMode(null, 'bypassPermissions'); // the newest pick takes precedence
  const list = desk.list({ drive: { active: false }, tasks: [], asks: new Asks({}), host: 'vps' });
  assert.deepStrictEqual(list.questions.map((q) => [q.kind, q.title]), [['mode', 'Turn on Bypass permissions']]);
  assert.ok(!JSON.stringify(list).includes(desk.key));
  assert.strictEqual(desk.take(first.id), null);
  assert.strictEqual(desk.take(second.id).mode, 'bypassPermissions');
  assert.strictEqual(desk.take(second.id), null, 'once');
  const req = (h) => ({ headers: { host: '127.0.0.1:4317', ...h } });
  assert.ok(desk.allowed(req({ 'x-editlens-answer': desk.key, 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:4317' })));
  assert.ok(!desk.allowed(req({ 'x-editlens-answer': desk.key, 'sec-fetch-site': 'same-site' })));
  assert.ok(!desk.allowed(req({ 'x-editlens-answer': desk.key, origin: 'http://localhost:5173' })));
  assert.ok(!desk.allowed(req({})));
  assert.ok(!desk.allowed(req({ 'x-editlens-answer': desk.key })), 'with the key but not from the window (no browser headers)');
  const { html, nonce } = desk.page('EditLens');
  assert.ok(html.includes(`nonce="${nonce}"`));
  assert.match(desk.headers(nonce)['Content-Security-Policy'], new RegExp(`script-src 'nonce-${nonce.replace(/[+/=]/g, '\\$&')}'`));
});

test('a mode request from an ended page-control run is ignored, not applied to the next run', () => {
  const desk = new AnswerDesk();
  const old = desk.requestMode(null, 'acceptEdits', null, 'run1');
  let list = desk.list({ drive: { active: true, runId: 'run1', permissions: [] }, tasks: [], asks: new Asks({}), host: 'vps' });
  assert.deepStrictEqual(list.questions.map((q) => q.id), [old.id]);
  list = desk.list({ drive: { active: true, runId: 'run2', permissions: [] }, tasks: [], asks: new Asks({}), host: 'vps' });
  assert.deepStrictEqual(list.questions, []);
  assert.strictEqual(desk.take(old.id), null);
  desk.requestMode(null, 'bypassPermissions', null, 'run2');
  desk.list({ drive: { active: false }, tasks: [], asks: new Asks({}), host: 'vps' });
  assert.strictEqual(desk.confirms.size, 0, 'page control ended');
  desk.requestRoot();
  desk.dropModes(null);
  assert.strictEqual(desk.confirms.size, 1, 'the root request stays');
});

// 0.24.31 scan M2: every route on an EditLens port but GET /health and GET /live.js, and key files
// matched by globs, whatever words are in the command.
test('the self guard covers every EditLens route and glob reads of the key files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-selfguard-'));
  try {
    const o = { stateDir: dir, ports: [4711, 4923, 4318] };
    const bash = (command) => selfCall('Bash', { command }, o);
    const denied = [
      'curl -X POST 127.0.0.1:4711/edits/undo',
      'curl -X POST 127.0.0.1:4711/shutdown',
      'curl -H "x-editlens-token: $(cat k)" -d \'{"values":{"remote_tasks":true}}\' 127.0.0.1:4711/settings/report',
      'curl 127.0.0.1:4711/edits/recent',
      'curl -X POST localhost:4711/connect -d \'{}\'',
      'curl http://127.0.0.1:4711',
      'curl -d x http://127.0.0.1:4711/health',
      'curl "http://127.0.0.1:4711""/shutdown"',
      'wget --post-data x http://localhost:4711/live.js',
      "find ~ -name 'token-*' -exec cat {} +",
      'cat ~/.claude/*/token-4317',
      'cat ~/.claude/*/*',
      'cat ~/.claude/e*/t*',
      'grep -r token ~/.claude/*',
      'cat ~/.claude/{editlens,x}/*',
      `cat ${dir}/*`,
      'type %USERPROFILE%\\.claude\\editlens\\token-4317',
    ];
    for (const c of denied) assert.ok(bash(c), c);
    assert.ok(selfCall('WebFetch', { url: 'http://localhost:4711/summary' }, o));
    assert.ok(selfCall('PowerShell', { command: 'Invoke-WebRequest http://localhost:4711/health -Method Post' }, o));
    const allowed = [
      'curl http://127.0.0.1:4711/health',
      'curl -s http://localhost:4711/live.js | head',
      'curl -X GET http://localhost:4711/health?x=1',
      // EditLens's own commands (the skill runs bin/start.js), its log and its folder.
      'node "$HOME/.claude/editlens/start.js" join 127.0.0.1:4318 ABCD-EFGH-IJKL',
      'node "$HOME/.claude/editlens/start.js" http://localhost:3000',
      `node "${path.join(__dirname, '..', 'bin', 'start.js')}" status`,
      'tail -50 ~/.claude/editlens/server-4711.log',
      'ls ~/.claude/editlens',
      'cat ~/.claude/settings.json',
      'ls ~/.claude/projects/*/abc.jsonl',
      'cat ~/.claude/*.json',
      'rm build/token-*.txt',
      'curl localhost:3000/shutdown',
      'git log --since=12:43',
    ];
    for (const c of allowed) assert.strictEqual(bash(c), null, c);
    assert.strictEqual(selfCall('WebFetch', { url: 'http://localhost:4711/health' }, o), null);

    // The hook (every session) and page control's rule (driver.js agentRule) use the same check.
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'live-hook.js'), 'bash'], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: os.tmpdir(), tool_name: 'Bash', tool_input: { command: 'curl -X POST 127.0.0.1:4923/edits/undo' } }),
      encoding: 'utf8', env: { ...process.env, EDITLENS_PORT: '4923', EDITLENS_STATE_DIR: dir },
    });
    assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const { Driver } = require('../server/driver');
    const out = await Driver.prototype.agentRule.call({ stateDir: dir }, { cwd: dir }, { tool_name: 'Bash', tool_input: { command: "find ~ -name 'token-*' -exec cat {} +" } });
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
