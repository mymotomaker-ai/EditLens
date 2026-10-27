'use strict';
// Tests never touch this computer's real setup: the "editlens" task account (lib/taskuser.js) is
// looked up in a passwd file without it, Claude Code's settings come from an empty folder, EditLens
// keeps its state in a new temporary folder, the claude program found is the stand-in, and git
// reads no global or system settings and runs no hooks. Child processes get these through the
// environment. A path already set is kept only when it is inside this run's private folder (a test
// that starts another, see tempInRun); any other is replaced. Each file sets its own port.
const fs = require('fs');
const os = require('os');
const path = require('path');

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}
function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}
function inside(parent, p) {
  const rel = path.relative(parent, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
// Where a path ends after every link. A path not made yet ends in its folder; a link to nothing is null.
function finalPath(p) {
  const real = realOrNull(p);
  if (real) return real;
  if (lstatOrNull(p)) return null;
  const dirReal = realOrNull(path.dirname(p));
  return dirReal && path.join(dirReal, path.basename(p));
}
const TMP = fs.realpathSync(os.tmpdir());
// A home folder inside the temporary folder (an account made for tests) is that account's real setup.
const HOME = realOrNull(os.homedir());
const HOME_IN_TMP = Boolean(HOME) && HOME !== TMP && inside(TMP, HOME);
const mine = (st) => typeof process.getuid !== 'function' || st.uid === process.getuid();

// The run: the isolate folder of the first test process (npm test, or a file run directly). A child
// gets it through EDITLENS_ISOLATE_RUN; it counts only while that folder is there, is this user's and
// only this user can open it. Each later process of the run makes its own folder inside it.
function runFolder() {
  const p = process.env.EDITLENS_ISOLATE_RUN;
  if (!p || !path.isAbsolute(p) || !path.basename(p).startsWith('editlens-isolate-')) return null;
  const st = lstatOrNull(p);
  const ok = st && st.isDirectory() && mine(st) && (process.platform === 'win32' || (st.mode & 0o077) === 0);
  return ok && realOrNull(path.dirname(p)) === TMP ? realOrNull(p) : null;
}
const inherited = runFolder();
const dir = fs.mkdtempSync(path.join(inherited || os.tmpdir(), 'editlens-isolate-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
if (!inherited) process.env.EDITLENS_ISOLATE_RUN = dir;
// A new folder inside this run's private folder: a test process this one starts keeps it (Sol M14).
const tempInRun = (prefix) => fs.mkdtempSync(path.join(dir, prefix));

// Whether this test run made `real` (a path after every link): it is inside the run's private folder,
// and outside ~/.claude and a home in the temporary folder. A folder anywhere else is never kept.
function madeThisRun(real) {
  if (!inherited || !real || real === inherited || !inside(inherited, real)) return false;
  if (HOME && inside(path.join(HOME, '.claude'), real)) return false;
  return !(HOME_IN_TMP && inside(HOME, real));
}
function kept(name, p) {
  if (!p || !path.isAbsolute(p)) return false;
  // The stand-in claude: the link is the run's, and it ends at test/fixtures/fake-claude.js or in the run.
  if (name === 'EDITLENS_CLAUDE_PATH') {
    const at = realOrNull(path.dirname(p));
    const end = realOrNull(p);
    return Boolean(at) && madeThisRun(path.join(at, path.basename(p))) && Boolean(end)
      && (end === realOrNull(path.join(__dirname, 'fixtures', 'fake-claude.js')) || madeThisRun(end));
  }
  return madeThisRun(finalPath(p));
}

// What was set before: test/e2e-*.js scripts that run the real Claude may put these back (needRealClaude).
const BEFORE = Object.fromEntries(['CLAUDE_CONFIG_DIR', 'EDITLENS_CLAUDE_PATH', 'CLAUDE_CODE_EXECPATH'].map((k) => [k, process.env[k]]));
function own(name, make) {
  if (kept(name, process.env[name])) return;
  process.env[name] = make();
}
own('EDITLENS_TEST_PASSWD', () => {
  const f = path.join(dir, 'passwd');
  fs.writeFileSync(f, 'root:x:0:0:root:/root:/bin/bash\n');
  return f;
});
own('CLAUDE_CONFIG_DIR', () => {
  fs.mkdirSync(path.join(dir, 'claude-config'));
  return path.join(dir, 'claude-config');
});
own('EDITLENS_STATE_DIR', () => {
  fs.mkdirSync(path.join(dir, 'state'));
  return path.join(dir, 'state');
});
// The stand-in, named claude: server/driver.js takes only a file with that name.
own('EDITLENS_CLAUDE_PATH', () => {
  fs.mkdirSync(path.join(dir, 'bin'));
  const link = path.join(dir, 'bin', 'claude');
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), link);
  return link;
});
process.env.CLAUDE_CODE_EXECPATH = process.env.EDITLENS_CLAUDE_PATH;
own('GIT_CONFIG_GLOBAL', () => {
  fs.writeFileSync(path.join(dir, 'gitconfig'), `[core]\n\thooksPath = ${path.join(dir, 'git-hooks').replace(/\\/g, '/')}\n`);
  fs.mkdirSync(path.join(dir, 'git-hooks'));
  return path.join(dir, 'gitconfig');
});
process.env.GIT_CONFIG_NOSYSTEM = '1';

// The paths set above (test/run.js removes them, so each test file makes its own).
const ISOLATE_PATHS = ['EDITLENS_TEST_PASSWD', 'CLAUDE_CONFIG_DIR', 'EDITLENS_STATE_DIR', 'EDITLENS_CLAUDE_PATH',
  'CLAUDE_CODE_EXECPATH', 'GIT_CONFIG_GLOBAL'];

// Whether the script `main` may use the real signed-in Claude: only a test/e2e-*.js script, and only
// with EDITLENS_E2E_REAL_CLAUDE=1 set (Sol M15).
function realClaudeAllowed(env, main) {
  return env.EDITLENS_E2E_REAL_CLAUDE === '1' && typeof main === 'string' && path.dirname(main) === __dirname
    && /^e2e-[\w-]+\.js$/.test(path.basename(main));
}
// For an e2e script that runs the real Claude, called before it loads anything else: puts back this
// computer's Claude settings folder and claude program, or stops the script and says why.
function needRealClaude() {
  if (!realClaudeAllowed(process.env, require.main && require.main.filename)) {
    console.error('This script runs the real signed-in Claude with this computer\'s Claude settings and claude program. '
      + 'To allow that, set EDITLENS_E2E_REAL_CLAUDE=1 and run it again.');
    process.exit(2);
  }
  for (const [name, value] of Object.entries(BEFORE)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  // The claude these scripts start is its own session, not part of the Claude session that ran them.
  for (const name of PARENT_SESSION) delete process.env[name];
  // Subagents run in the turn, so the page shows them as they work (not as background tasks).
  process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
}
// Set by a Claude session for the programs it runs; each one ties a child claude to that session.
const PARENT_SESSION = [
  'CLAUDE_CODE_SESSION_ID', // the parent's session id: the child would reuse it
  'CLAUDE_AUTO_BACKGROUND_TASKS', // runs subagents in the background
  'CLAUDE_CODE_MESSAGING_SOCKET', // the parent's messaging socket
  'CLAUDE_CODE_MESSAGING_TOKEN', // the key for that socket
  'CLAUDE_CODE_CHILD_SESSION', // marks the child as one of the parent's sessions
  'CLAUDE_PID', // the parent's process id
  'CLAUDECODE', // says the program runs inside Claude Code
  'CLAUDE_CODE_REMOTE_SESSION_ID', // the parent's remote session id
  'CLAUDE_CODE_SESSION_ATTENDED', // whether a person watches the parent session
  'CLAUDE_CODE_PROJECTS_SESSION', // the parent's project session
  'CLAUDE_CODE_SYNC_SESSION_REFS', // syncs the parent's session links
  'CLAUDE_CODE_WORKER_EPOCH', // the parent's worker run
  'CLAUDE_CODE_TEE_SDK_STDOUT', // copies output into the parent's stream
  'CLAUDE_CODE_DIAGNOSTICS_FILE', // the parent's log file
  'CLAUDE_CODE_BG_TASKS_REPORT_RUNNING', // reports background tasks to the parent
  'CLAUDE_CODE_ENTRYPOINT', // how the parent was started (the child says its own)
  'CLAUDE_EFFORT', // the parent's effort level
  'CLAUDE_AFTER_LAST_COMPACT', // the parent's last summary of its chat
];
module.exports = { ISOLATE_PATHS, tempInRun, realClaudeAllowed, needRealClaude };
