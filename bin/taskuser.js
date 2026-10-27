#!/usr/bin/env node
'use strict';
// /editlens task-user: tasks from a paired computer run as a normal account, not root.
//   node bin/taskuser.js         set up the account, its own Claude Code and its sign-in line
//   node bin/taskuser.js status  what is set up
//   node bin/taskuser.js off     remove the account EditLens made, with its home folder; an account
//                                made manually is kept and only turned off for EditLens
// Typed by the user on the host, never run by Claude. Linux, as root only.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const taskuser = require('../lib/taskuser');
const settings = require('../lib/settings');
const { getJson, pageKey } = require('../lib/client');
const { say } = require('../lib/say');
const { plainError, plainMessage } = require('../lib/plainerr');

const NAME = taskuser.NAME;
const PRODUCT = require('../lib/name').PRODUCT_NAME;
// Written in the account's home only when this command made it: "off" removes only an account it made.
const MARKER = taskuser.MARKER;
const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

// Where "off" is kept for an account made manually (lib/taskuser.js account() reads it).
function offFile() {
  return path.join(require('../lib/config').stateDir, taskuser.OFF_FILE);
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeoutMs || 60000, env: opts.env || process.env, input: opts.input });
  return { ok: !r.error && r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || (r.error && plainError(r.error)) || '').trim() };
}

// Its own Claude login, typed by the user (nothing is copied from root).
function saySignIn() {
  say.steps('Sign it in once', [
    { n: 1, cmd: `su - ${NAME}` },
    { n: 2, cmd: 'claude' },
    { n: 3, cmd: '/login', text: 'follow the link' },
    { n: 4, cmd: '/exit', text: 'then exit' },
  ], { text: 'Check: /editlens task-user status   Undo: /editlens task-user off' }, 'in a terminal on this server');
}

// -> true | false | null (can't tell)
function signedIn(a) {
  const r = sh('runuser', ['-u', NAME, '--', path.join(a.home, '.local', 'bin', 'claude'), 'auth', 'status', '--json'], { env: taskuser.envFor(a, process.env, 0), timeoutMs: 30000 });
  try {
    const j = JSON.parse(r.out);
    return typeof j.loggedIn === 'boolean' ? j.loggedIn : null;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
}

function claudeOf(a) {
  return path.join(a.home, '.local', 'bin', 'claude');
}

// Node for the plugin's hooks, as the account.
function nodeOk() {
  return sh('runuser', ['-u', NAME, '--', process.execPath, '--version']).ok;
}

async function sayStatus() {
  const a = taskuser.lookup();
  if (!a) {
    say.head(null, '', `no ${NAME} account: tasks from paired computers run as root here`);
    say.hint(['/editlens task-user', 'set one up']);
    return;
  }
  if (taskuser.isOff(path.dirname(offFile()))) {
    say.head(null, '', `${NAME} is turned off for ${PRODUCT}: tasks from paired computers run as root here`);
    say.hint(['/editlens task-user', 'turn it on again']);
    return;
  }
  const hasClaude = fs.existsSync(claudeOf(a));
  const login = hasClaude ? signedIn(a) : null;
  // Layout B rows: the value starts with its mark (✓ done, ✕ missing, ! can't tell).
  say.head(null, '', '', 'Task account');
  say.blank();
  say.fields([
    ['Account', `✓ ${NAME}`],
    ['Claude Code', hasClaude ? '✓ installed' : '✕ not installed'],
    ['Signed in', login === true ? '✓ yes' : login === false ? '✕ not yet' : "! can't tell"],
  ]);
  if (!hasClaude) say.text('Claude Code is not installed for it: /editlens task-user installs it.', true);
  if (!nodeOk()) say.steps(`${NAME} can't run ${process.execPath}, so its edits won't show in the panel`, [], { text: 'Install Node outside /root (for example from your package manager).' });
  const setting = settings.given().values.task_account;
  const rootOn = fs.existsSync(path.join(require('../lib/config').stateDir, 'task-root.json'));
  if (rootOn) {
    say.fail('Root (unsafe) is on', 'tasks from paired computers run as root');
    say.fix('/config', 'and set "Run their tasks as" back to Auto (search "editlens")', 'open');
  }
  else if (setting === 'Root (unsafe)') {
    const a = await answerOpen();
    const end = { text: 'Set the setting back to Auto to cancel the request.' };
    const heading = 'Tasks run as editlens until you allow Root (unsafe) in the EditLens window (it waits there)';
    if (!a.ssh) say.steps(`${heading}, ${a.url}`, [], end);
    else {
      // No browser here: the window opens on the user's computer, through one of the SSH lines.
      say.steps(heading, [
        { n: 1, text: 'In a terminal on your computer, run one of the lines below and leave it open' },
        { n: 2, text: `Open ${a.url} there` },
      ], end);
      say.copyLines(a.ssh, a.sshKey);
    }
  }
  else say.text(hasClaude && login === true ? `Tasks from paired computers run as ${NAME}.` : 'Not in use until it is ready.', true);
}

// The EditLens window's address, plus the SSH lines when no browser opens here (with the key file
// the paired computers used, when they all used the same one). Where pages need the page key (D21)
// the window's address starts with it, as in the mod's links (/gk-<key>/answer).
async function answerOpen() {
  const { loginName, addresses, savedKey } = require('../server/pair-host');
  const config = require('../lib/config');
  const a = require('../lib/browser').answerOpen({ port: config.port, user: loginName(), addresses: addresses(), key: savedKey(config.stateDir) });
  const key = await pageKey();
  return key ? { ...a, url: a.url.replace(/\/answer$/, `/gk-${key}/answer`) } : a;
}

async function liveTasks() {
  try {
    const s = await getJson('/tasks/live', 3000);
    return s && Number.isInteger(s.live) ? s.live : null;
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return null;
  }
}

// An unknown word, refused with the command's own words.
function sayUnknown(word) {
  say.fail(`"${word.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40)}" isn't something /editlens task-user knows`);
  say.fix('', '', 'use one of these:');
  say.cmdList([['/editlens task-user', 'set up'], ['/editlens task-user status', 'check'], ['/editlens task-user off', 'undo']]);
  process.exitCode = 1;
}

async function main() {
  const word = (process.argv[2] || '').toLowerCase();
  if (word && word !== 'status' && word !== 'off') return sayUnknown(word);
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') {
    say.head(null, '', 'not needed here: tasks already run as your own user');
    return;
  }
  if (process.getuid() !== 0) {
    say.head(null, '', 'not needed: Claude Code runs as a normal user, so tasks do too');
    return;
  }
  if (word === 'status') {
    await sayStatus();
    return;
  }
  if (word === 'off') {
    const a = taskuser.lookup();
    if (!a) {
      say.head(null, '', `there is no ${NAME} account; tasks run as root`);
      return;
    }
    // Made manually: kept, only turned off for EditLens (tasks run as root again).
    if (!taskuser.madeByEditLens(a)) {
      fs.mkdirSync(path.dirname(offFile()), { recursive: true, mode: 0o700 });
      fs.writeFileSync(offFile(), `/editlens task-user off: the ${NAME} account was made manually, so it is kept and not used.\n`, { mode: 0o600 });
      say.done(`Turned off: tasks from paired computers no longer run as ${NAME}`, 'they run as root again');
      say.text(`The ${NAME} account was made manually, so ${PRODUCT} keeps it. To remove it yourself: sudo userdel -r ${NAME}`);
      say.hint(['/editlens task-user', 'turn it on again']);
      return;
    }
    const live = await liveTasks();
    // The live server didn't respond: don't assume no task is running.
    if (live === null && !process.argv.includes('--force')) {
      say.fail(`Can't tell whether tasks still run as ${NAME}`, `${PRODUCT} didn't answer`);
      say.fix('/editlens task-user off', 'again (or add --force to remove it anyway)', 'start Claude Code or wait a moment, then');
      process.exitCode = 1;
      return;
    }
    if (live) {
      say.fail('Not removed', `${live} task${live === 1 ? '' : 's'} still run${live === 1 ? 's' : ''} here`);
      say.fix('/editlens task-user off', 'again', `stop ${live === 1 ? 'it' : 'them'} first, then`);
      process.exitCode = 1;
      return;
    }
    const r = sh('userdel', ['-r', NAME]);
    // userdel also warns (and exits non-zero) when there is no mail spool: what counts is the account.
    if (taskuser.lookup()) {
      say.fail('Couldn\'t remove the account', plainMessage(r.err) || 'userdel stopped');
      say.fix(`userdel -r ${NAME}`, '', 'to remove it yourself:');
      process.exitCode = 1;
      return;
    }
    say.done(`Removed the ${NAME} account`, `its home ${a.home}, its Claude login and its task workspaces`);
    say.text('Tasks from paired computers run as root again. /editlens task-user sets it up again.', true);
    return;
  }
  if (word) return sayUnknown(word);

  // Set up, step by step; each step is skipped when already done, so running it again finishes it.
  let a = taskuser.lookup();
  const out = [];
  if (!a) {
    const exists = sh('id', ['-u', NAME]);
    if (exists.ok) {
      say.fail(`A system account named ${NAME} already exists`, 'EditLens only uses a normal account (uid 1000 or more)');
      say.fix('/editlens task-user', 'again', `remove or rename ${NAME} first, then`);
      process.exitCode = 1;
      return;
    }
    const made = sh('useradd', ['--create-home', '--shell', '/bin/bash', '--user-group', NAME]);
    if (!made.ok) {
      say.fail('Couldn\'t create the account', plainMessage(made.err) || 'useradd stopped');
      say.fix('/editlens task-user', 'again as root', 'check that useradd works here, then run');
      process.exitCode = 1;
      return;
    }
    a = taskuser.lookup();
    if (!a) {
      say.fail(`The ${NAME} account isn't a normal account`, 'its uid is under 1000');
      say.fix(`userdel -r ${NAME}`, '', 'remove it:');
      process.exitCode = 1;
      return;
    }
    sh('passwd', ['-l', NAME]);
    fs.chmodSync(a.home, 0o750);
    taskuser.writeNew(path.join(a.home, MARKER), `${taskuser.MADE_TEXT} /editlens task-user off removes this account and its home.\n`);
    out.push([`Made account ${NAME}`, 'no password, no sudo']);
  } else {
    // Made before, maybe manually: never marked here, so "off" keeps an account made manually.
    out.push([`Account ${NAME}`, taskuser.madeByEditLens(a) ? a.home : `${a.home} (made manually: /editlens task-user off keeps it)`]);
  }
  // Set up again after "off" on an account made manually: it is used again.
  fs.rmSync(offFile(), { force: true });
  if (!fs.existsSync(claudeOf(a))) {
    for (const [t, n] of out.splice(0)) say.done(t, n);
    const inst = sh('runuser', ['-l', NAME, '-c', INSTALL], { timeoutMs: 300000 });
    if (!fs.existsSync(claudeOf(a))) {
      // The installer's last non-empty line (never its whole output).
      const said = String(inst.err || inst.out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
      say.fail('Couldn\'t install Claude Code for it', plainMessage(said) || 'the installer stopped');
      say.fix('/editlens task-user', 'again to retry');
      process.exitCode = 1;
      return;
    }
    out.push(['Installed its Claude Code', claudeOf(a)]);
  } else {
    out.push(['Its Claude Code is installed', claudeOf(a)]);
  }
  for (const [t, n] of out) say.done(t, n);
  if (!nodeOk()) say.steps(`${NAME} can't run ${process.execPath}, so its edits won't show in the panel`, [], { text: 'Install Node outside /root (for example from your package manager), then restart Claude Code.' });
  say.blank();
  if (signedIn(a) === true) {
    say.done('Signed in', `tasks from paired computers now run as ${NAME}`);
    say.hint(['/editlens task-user off', 'undo']);
  } else {
    saySignIn();
  }
}

main().catch((err) => {
  say.fail('/editlens task-user failed', plainError(err));
  say.fix('/editlens task-user status', 'shows what is set up now');
  process.exitCode = 1;
});
