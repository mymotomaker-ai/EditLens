#!/usr/bin/env node
'use strict';
// A stand-in for the claude program's sign-in commands, for test/signin.test.js and
// test/signin-preview.js. Signed in once FAKE_CLAUDE_STATE/signed-in exists.
//   claude auth status --json   -> {"loggedIn": ...}
//   claude auth login           -> prints a sign-in link, then signs in after FAKE_CLAUDE_LOGIN_MS,
//                                  or when a code is typed (FAKE_CLAUDE_LOGIN_MS=never)
const fs = require('fs');
const path = require('path');
// Run as the task account, it gets none of the test's variables (lib/taskuser.js): then the state
// folder is named in a file beside it.
function stateDir() {
  if (process.env.FAKE_CLAUDE_STATE) return process.env.FAKE_CLAUDE_STATE;
  try {
    return fs.readFileSync(path.join(path.dirname(process.argv[1]), '.fake-state'), 'utf8').trim();
  } catch (err) {
    if (err.code === 'ENOENT') return path.join(require('os').tmpdir(), 'fake-claude-none');
    throw err;
  }
}
const state = stateDir();
const marker = path.join(state, 'signed-in');
const [a, b] = process.argv.slice(2);
if (a === 'auth' && b === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: fs.existsSync(marker), authMethod: 'none' }) + '\n');
} else if (a === 'auth' && b === 'login') {
  fs.writeFileSync(path.join(state, 'login-args'), process.argv.slice(4).join(' '));
  process.stdout.write('Opening browser to sign in…\nIf the browser didn\'t open, visit: https://example.test/oauth/authorize?code=true&state=abc\nPaste code here if prompted > ');
  const done = (code) => {
    if (code === 'bad') {
      process.stdout.write('\nInvalid code\n');
      process.exit(1);
    }
    fs.writeFileSync(marker, 'yes');
    process.stdout.write('\nLogin successful.\n');
    process.exit(0);
  };
  const wait = process.env.FAKE_CLAUDE_LOGIN_MS || '300';
  const ms = Number(wait);
  if (wait !== 'never' && !(Number.isInteger(ms) && ms >= 0 && ms <= 600000)) {
    process.stderr.write(`fake claude: FAKE_CLAUDE_LOGIN_MS is not a number of ms from 0 to 600000: ${wait}\n`);
    process.exit(2);
  }
  if (wait !== 'never') setTimeout(() => done('ok'), ms);
  process.stdin.on('data', (d) => done(String(d).trim()));
} else if (a === 'task-write') {
  // As Claude Code run by the SDK (test/task-account.test.js): writes a file in its folder, runs
  // the plugin's edit hook as Claude Code would, and says who it ran as.
  const rel = b;
  const text = process.argv[4] || '';
  const file = path.join(process.cwd(), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text + '\n');
  const plugin = process.argv[5] || '';
  let hook = null;
  if (plugin) {
    const input = JSON.stringify({ session_id: 'acct-session', cwd: process.cwd(), tool_name: 'Write', tool_use_id: 'tu9', tool_input: { file_path: file, content: text + '\n' }, tool_response: { type: 'create' } });
    const r = require('child_process').spawnSync(process.execPath, [path.join(plugin, 'hooks', 'live-hook.js'), 'step'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin } });
    hook = r.status;
  }
  process.stdout.write(JSON.stringify({ user: require('os').userInfo().username, home: process.env.HOME, stateDir: process.env.EDITLENS_STATE_DIR || null, noStart: process.env.EDITLENS_NO_START || null, hook,
    secret: process.env.TEST_SECRET_X || process.env.ANTHROPIC_API_KEY || null }) + '\n');
} else {
  process.stdout.write('fake claude\n');
}
