#!/usr/bin/env node
'use strict';
// Page control: the live server runs Claude (Agent SDK) on a copy of the conversation, from the page.
// Args: [new | manual | stop | <session id>] [take] [--wait <seconds>] [--open] [--auto]
// take: end page control in another project first. --wait: wait for a page to open. --open: open it.
// --auto: started with the session (no SDK download). First run installs the SDK (~30 MB, +250 MB
// when there is no claude binary) into ~/.claude/editlens/sdk.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../lib/config');
const { ensureServer, postJson, getJson, pageKey } = require('../lib/client');
const { keyedUrl } = require('../lib/pagekey');
const { sdkEntry, sdkDir, findClaude, hasRuntime, runtimePackage, SDK_PACKAGE } = require('../server/driver');
const { related } = require('../lib/paths');
const { openOnce, canOpenBrowser, openAdvice, shownUrl, noBrowserText } = require('../lib/browser');
const { plainError, plainMessage } = require('../lib/plainerr');
const { say } = require('../lib/say');
const { NEW_CHAT, OWN_SESSION } = require('../lib/sdkerr');

const NO_PAGE = /No page with the .* panel is open/;
const SUPERSEDED = /A newer session is waiting for the page/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The flags after the word. -> { word, take, wait (ms), open, auto, later }
// --later: with no page open, page control starts when one opens (a paired computer with no browser asks).
function parseArgs(argv) {
  const out = { word: '', take: false, wait: 0, open: false, auto: false, later: false };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i] || '').toLowerCase();
    if (a === '--wait') {
      const n = Number(argv[++i]);
      out.wait = Number.isFinite(n) && n > 0 ? Math.min(n, 3600) * 1000 : 0;
    } else if (a === '--open') out.open = true;
    else if (a === '--auto') out.auto = true;
    else if (a === '--later') out.later = true;
    else if (a === 'take') out.take = true;
    else if (!out.word) out.word = a;
  }
  return out;
}

// Manual cancels "turn on when the page opens" from the session start: the waiter stops the next
// time it asks. The pid file from older versions is removed.
async function cancelAutoControl() {
  try {
    fs.unlinkSync(path.join(config.stateDir, 'auto-control.pid'));
  } catch (err) {
    if (!err || !err.code) throw err;
    // Usually it is gone already. Other errors are printed but don't stop the switch.
    if (err.code !== 'ENOENT') process.stderr.write(`(could not remove the old ${path.join(config.stateDir, 'auto-control.pid')}: ${err.code})\n`);
  }
  await postJson('/drive/stop-waiting', {}).catch((err) => {
    process.stderr.write(`(could not stop the waiting page control: ${plainError(err)})\n`);
  });
}

// This project's connected page address, or null.
async function pageUrl(cwd) {
  const list = await getJson('/connections').catch((err) => {
    process.stderr.write(`(could not ask EditLens for the page address: ${plainError(err)})\n`);
    return [];
  });
  const c = Array.isArray(list) ? list.find((x) => x && related(x.cwd, cwd) && typeof x.url === 'string') : null;
  return c ? c.url : null;
}

// How to open the page from the user's own computer when no browser opens here (browser.js openAdvice).
async function adviceFor(cwd, url, browser) {
  const s = await getJson('/pair', 5000).catch((err) => {
    process.stderr.write(`(could not ask EditLens about paired computers: ${plainError(err)})\n`);
    return null;
  });
  const pairs = s && s.host && Array.isArray(s.host.pairs) ? s.host.pairs : [];
  const { loginName, addresses } = require('../server/pair-host');
  const advice = openAdvice({ browser, cwd, pairs, pageUrl: url, livePort: config.port, user: loginName(), addresses: addresses() });
  // The address to open there, with the page key where pages need it (D21), as the Page line.
  if (advice && advice.url) advice.url = keyedUrl(advice.url, await pageKey());
  return advice;
}

// The steps for opening the page from the user's own computer (advice from adviceFor), then cmd.
function sayOpenFrom(advice, cmd) {
  const end = cmd ? { text: 'Then', cmd } : undefined;
  if (advice.paired) {
    const p = advice.paired;
    say.steps(`Open your page on ◆ ${p.name}`, [p.url ? { text: p.url, note: 'it is paired with this folder' } : { cmd: '/editlens join', text: `on ◆ ${p.name} shows the address` }], end, noBrowserText(advice.why));
    return;
  }
  const fill = /PORT/.test(advice.ssh);
  say.steps('Open your page from your computer', [
    { n: 1, text: fill ? 'In a terminal on your computer, run one of the lines below with your dev server\'s port for PORT, and leave it open' : 'In a terminal on your computer, run one of the lines below and leave it open' },
    { n: 2, text: `Open ${advice.url} there` },
  ], end, noBrowserText(advice.why));
  // Lines to copy, each on its own line (a mark at the start would be copied too).
  say.copyLines(advice.ssh, advice.sshKey);
  if (advice.other) say.text(`◆ ${advice.other.name} is paired for ${advice.other.folder}, not this folder. To open this folder there: /editlens pair here, then the /editlens join line it prints, on ◆ ${advice.other.name}. That moves the pairing to this folder.`, true);
}

const { SDK_VERSION, registryHost, sdkSource } = require('../lib/sdkinfo');

// npm's own script, run with this node and no shell, so folder names with spaces are safe.
function npmCli() {
  const bin = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows installer
    path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // macOS / Linux
  ];
  return candidates.find((f) => typeof f === 'string' && /npm-cli\.js$/.test(f) && fs.existsSync(f)) || null;
}

// npm's output is kept out of the /editlens reply; only its error lines are used, to say why an
// install failed.
function runNpm(args, cwd) {
  const cli = npmCli();
  const opts = { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 };
  if (cli) return spawnSync(process.execPath, [cli, ...args], opts);
  if (process.platform !== 'win32') return spawnSync('npm', args, opts);
  // npm.cmd only runs through cmd.exe. The arguments are fixed strings without spaces or quotes,
  // and the folder is passed as cwd, never on the command line.
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`], opts);
}

// npm's reason for a failed install, from its "npm error" lines, in plain words ('' for none).
function npmReason(out) {
  const lines = String((out && out.stderr) || '').split(/\r?\n/).map((l) => l.replace(/^npm (?:ERR!|error)\s*/, '').trim())
  const said = lines.find((l) => l && !/^(code|errno|syscall|A complete log|path|dest|signal)\b/i.test(l) && !/^\S+\.log$/.test(l));
  return said ? plainMessage(said) : '';
}

// Where npm will download from: the user's own npm setting, else npm's default.
function npmRegistry(cwd) {
  const cli = npmCli();
  const opts = { cwd, encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
  const r = cli ? spawnSync(process.execPath, [cli, 'config', 'get', 'registry'], opts)
    : process.platform !== 'win32' ? spawnSync('npm', ['config', 'get', 'registry'], opts)
      : spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd config get registry'], opts);
  return registryHost(!r.error && r.status === 0 ? r.stdout : process.env.npm_config_registry);
}

// The page panel shows the download while it runs (npm prints nothing until it ends).
function setupNotice(text) {
  // Only a notice: without it the install still runs, and the reason goes to stderr.
  return postJson('/event', { type: 'setup', text, cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd() }, { start: false }).catch((err) => {
    process.stderr.write(`(the page could not be told about the download: ${plainError(err)})\n`);
    return null;
  });
}

async function installSdk(withRuntime) {
  const dir = sdkDir(config.stateDir);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), '{ "private": true }\n');
  const size = withRuntime ? 'about 250 MB, with its own copy of Claude' : 'about 30 MB';
  await setupNotice(`Setting up page control: downloading ${sdkSource(npmRegistry(dir))} (one time, ${size})…`);
  const started = Date.now();
  // --ignore-scripts: the SDK needs no install scripts, so no package script runs with this
  // user's rights (root's on a VPS logged in as root).
  const args = ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', ...(withRuntime ? [] : ['--omit=optional']), `${SDK_PACKAGE}@${SDK_VERSION}`];
  const out = runNpm(args, dir);
  await setupNotice('');
  if (out.error) throw new Error(`npm could not run (${plainError(out.error)}). Is Node.js with npm installed?`);
  if (out.status !== 0) {
    const why = npmReason(out);
    throw new Error(`the download didn't finish${why ? ` (${why})` : ''}. Check your internet connection and run it again.`);
  }
  return { seconds: Math.max(1, Math.round((Date.now() - started) / 1000)), size };
}

// A refused request, from the server's answer when it gave one. -> { error, busy, working }
function refusalOf(err) {
  const msg = err && err.code ? plainError(err) : String((err && err.message) || err).replace(/^server answered \d+: /, '');
  let answer = null;
  try {
    answer = JSON.parse(msg);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  if (!answer || typeof answer !== 'object') return { error: msg };
  return { error: answer.error || msg, busy: answer.busy === true, working: answer.working === true };
}

// The word after control, in any case. -> 'manual' | 'new' | a session id | ''
function controlWord(given) {
  const word = String(given || '').trim().toLowerCase();
  if (word === 'manual' || word === 'stop') return 'manual';
  if (word === 'new' || SESSION_ID.test(word)) return word;
  return '';
}
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Page control on (or off with word 'manual'). Prints nothing. -> { manual } | { ok, pages, from,
// signIn, opened, installed } | { auto: 'needs-setup' } | { superseded } | { error, url, noPage }
// take: end page control in another project first (only from a command the user typed).
async function control({ cwd, word: given = '', take = false, wait = 0, open = false, auto = false, later = false } = {}) {
  const word = controlWord(given);
  // Claude running from a page (or a task) never moves page control: only the user, in Claude Code.
  if (take && process.env.EDITLENS_DRIVEN === '1') return { error: TAKE_HERE };
  await ensureServer();
  // A waiter left from the start of the session isn't needed once the user chose.
  if (!auto) await cancelAutoControl();
  if (word === 'manual') {
    await postJson('/drive/end', {});
    return { manual: true };
  }
  // The claude program: this session's, else the ones the hooks reported to the live server
  // (/editlens runs this without CLAUDE_CODE_EXECPATH), else PATH. Only when none is found does
  // the SDK need its own copy of Claude (about 250 MB).
  const reported = await getJson('/claude-paths').then((r) => (r && Array.isArray(r.paths) ? r.paths : []), (err) => {
    process.stderr.write(`(could not ask EditLens which claude Claude Code runs: ${plainError(err)}; looking on PATH)\n`);
    return [];
  });
  const exe = findClaude([process.env.CLAUDE_CODE_EXECPATH, ...reported]);
  // Turned on automatically at session start: never download something nobody asked for.
  if (auto && !sdkEntry(config.stateDir)) return { auto: 'needs-setup' };
  let installed = null;
  if (!sdkEntry(config.stateDir)) installed = await installSdk(!exe);
  else if (!exe && !hasRuntime(config.stateDir)) installed = await installSdk(true);
  const sessionId = SESSION_ID.test(word) ? word : null;
  // Starting Claude the first time (loading the SDK, checking the login) can take a while.
  const waiter = auto ? require('crypto').randomBytes(8).toString('hex') : undefined;
  // caller: the session running this, so a task's Claude is refused (server.js grantDriveNow).
  const caller = SESSION_ID.test(process.env.CLAUDE_CODE_SESSION_ID || '') ? process.env.CLAUDE_CODE_SESSION_ID : undefined;
  // pairedBy: run for a paired computer (server/pair-host.js), whose pair off ends page control.
  const pairedBy = /^[0-9a-f]{32}$/.test(process.env.EDITLENS_PAIRED_BY || '') ? process.env.EDITLENS_PAIRED_BY : undefined;
  // origin: typed by the user (asked), or a session start's request (auto, also the setup run the server
  // began for it): the server checks the settings that request needs (Sol S5).
  const origin = auto || process.env.EDITLENS_ORIGIN === 'auto' ? 'auto' : 'asked';
  const grant = () => postJson('/drive/grant', { cwd, fresh: word === 'new', sessionId, caller, claudePath: exe, auto, waiter, take: take === true && !auto, pairedBy, origin }, { timeoutMs: 180000 }).catch(refusalOf);
  // No page open yet: wait for it (and open it), so /editlens control alone is enough.
  const deadline = Date.now() + wait;
  // The server turns page control on when the page opens (as the session start asks it to).
  const whenOpen = () => postJson('/drive/auto', { cwd, claudePath: exe, sessionId: process.env.CLAUDE_CODE_SESSION_ID || null, fresh: word === 'new', resume: sessionId, paired: later, pairedBy, origin })
    .catch(refusalOf);
  let res = await grant();
  if (later && res.error && NO_PAGE.test(res.error)) {
    const armed = await whenOpen();
    if (armed && armed.error) return { error: armed.error, own: armed.error === OWN_SESSION, installed };
    return { later: true, installed };
  }
  let url = null;
  let opened = false;
  let asked = false;
  while (res.error && NO_PAGE.test(res.error) && Date.now() < deadline) {
    if (!asked) {
      asked = true;
      // With the page key where pages need it (D21), so the page it opens can connect.
      url = keyedUrl(await pageUrl(cwd), await pageKey());
      // No browser here (a VPS through SSH): /editlens shows output only when it ends, so waiting
      // would hide how to open the page. Say it now.
      const browser = open ? canOpenBrowser() : { ok: true };
      if (!browser.ok) {
        const armed = await whenOpen();
        if (armed && armed.error) return { error: armed.error, own: armed.error === OWN_SESSION, installed };
        return { error: res.error, noPage: true, url, advice: await adviceFor(cwd, url, browser), installed };
      }
      opened = Boolean(open && url && openOnce(url, config.stateDir));
    }
    await sleep(1500);
    res = await grant();
  }
  if (res.error && SUPERSEDED.test(res.error)) return { superseded: true, installed };
  if (res.error && res.busy) return { error: res.error, busy: true, working: res.working === true, installed };
  if (res.error) return { error: res.error, noPage: NO_PAGE.test(res.error), own: res.error === OWN_SESSION, url: url || keyedUrl(await pageUrl(cwd), await pageKey()), installed };
  return { ok: true, pages: Array.isArray(res.pages) ? res.pages : [], from: res.from || null, already: res.already === true, newChat: res.newChat === true, signIn: Boolean(res.signIn), opened, installed,
    moved: typeof res.moved === 'string' ? res.moved : null, unused: res.unused === true };
}

const TAKE_HERE = 'Claude running from a page can\'t move page control. Type /editlens control take in Claude Code.';

// The Control field and the next step, for /editlens and /editlens control. Sets the exit code
// when page control didn't start. more(): printed after the Control field (the Project field).
function sayControl(r, more) {
  const rest = () => {
    if (more) more();
    if (r.moved) say.done(`Moved from ${r.moved}`, r.unused ? 'no page was open there' : 'that page is in Manual again');
    if (r.installed) say.done('Set up page control', `one time, ${r.installed.size}, ${r.installed.seconds} s`);
    say.blank();
  };
  if (r.manual) {
    say.field('Control', '○ Manual', 'you use Claude here, the page shows each edit');
    rest();
    if (r.advice) {
      sayOpenFrom(r.advice);
      // The SSH lines end with their own blank line.
      if (r.advice.paired || r.advice.other) say.blank();
    }
    say.hint(['/editlens control', 'use Claude from the page'], ['/editlens stop', 'disconnect']);
    return;
  }
  // Kept across /editlens restart: it starts again when its page reconnects.
  if (r.back) {
    say.field('Control', '● Page control', 'starts again when the page reconnects');
    rest();
    say.hint(['/editlens manual', 'back to this window'], ['/editlens stop', 'disconnect']);
    return;
  }
  if (r.later) {
    say.field('Control', '○ Manual', 'page control starts when its page is open');
    rest();
    return;
  }
  if (r.auto === 'needs-setup') {
    say.field('Control', '○ Manual', 'page control needs a one-time setup');
    rest();
    say.hint(['/editlens control', 'set it up and turn it on']);
    return;
  }
  if (r.superseded) {
    say.field('Control', '○ Manual', 'a newer session waits for the page');
    rest();
    return;
  }
  if (r.error && r.advice) {
    // Not a failure: the page has to be opened from the user's own computer first.
    say.field('Control', '○ Manual', 'page control starts when your page is open');
    rest();
    sayOpenFrom(r.advice);
    return;
  }
  if (r.error) {
    process.exitCode = 1;
    say.field('Control', '○ Manual');
    rest();
    if (r.busy) {
      // Claude runs from another project's page: the user can move it here in one step.
      say.fail('Page control didn\'t start', plainMessage(r.error));
      say.fix('/editlens control take', r.working ? 'to stop Claude there and move it here (that page switches to Manual)' : 'to move it here (that page switches to Manual)');
    } else if (r.noPage) {
      say.fail('Page control didn\'t start', 'your page wasn\'t opened in time');
      say.fix('/editlens control', '', r.url ? `open ${shownUrl(r.url)}, then` : 'open your page, then');
    } else if (r.own) {
      say.fail('Page control didn\'t start', plainMessage(r.error));
      say.fix('/editlens', 'in Claude Code in your own project folder', 'type');
    } else if (/no conversation found/i.test(String(r.error))) {
      // The chat it continues has nothing saved yet (no message sent in it).
      say.fail('Page control didn\'t start', plainMessage(r.error));
      say.fix('/editlens control new', 'for a new chat on the page, or send a message here first');
    } else {
      say.fail('Page control didn\'t start', plainMessage(r.error) || 'no reason was given');
      say.fix('/editlens control', '', 'try again:');
    }
    return;
  }
  say.field('Control', '● Page control', r.already ? 'already on' : r.from ? 'continues this chat' : 'a new chat');
  if (r.newChat) say.text(NEW_CHAT);
  rest();
  if (r.signIn) {
    say.steps('Sign in once', [
      { n: 1, text: 'Click Sign in in the panel on your page.' },
      canOpenBrowser().ok ? { text: 'Your browser opens. Claude starts by itself after.' } : { text: 'Open the sign-in page it shows, then paste its code in the panel.' },
      { n: 'or', text: 'Use an API key instead:' },
      { cmd: 'set ANTHROPIC_API_KEY, then /editlens control' },
    ], { text: 'Not now?', cmd: '/editlens manual' });
    return;
  }
  say.act('Type in the panel on your page to talk to Claude.');
  say.hint(['/editlens manual', 'back to this window'], ['/editlens stop', 'disconnect']);
}

if (require.main === module) (async () => {
  const opts = parseArgs(process.argv.slice(2));
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const r = await control({ cwd, word: opts.word, take: opts.take, wait: opts.wait, open: opts.open, auto: opts.auto, later: opts.later });
  if (r.manual) say.head('ok', 'back to Manual', 'the page chat is in claude --resume');
  else if (r.ok) say.head('ok', 'page control on', r.pages.map((p) => `${p.title || 'page'} · ${shownUrl(p.url)}`).join(', '));
  else say.head(null, '');
  sayControl(r);
})().catch((err) => {
  // The failure line names what was asked: /editlens manual is not a start.
  say.fail(failText(parseArgs(process.argv.slice(2)).word), plainError(err));
  say.fix('/editlens details', 'to see whether EditLens is running, then try again');
  process.exitCode = 1;
});

function failText(word) {
  return controlWord(word) === 'manual' ? 'Couldn\'t switch to Manual' : 'Couldn\'t start page control';
}

module.exports = { parseArgs, control, controlWord, sayControl, cancelAutoControl, failText, adviceFor, sayOpenFrom };
