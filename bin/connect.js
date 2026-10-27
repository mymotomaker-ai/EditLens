#!/usr/bin/env node
'use strict';
// Connects this project's page to EditLens without changing project files, and disconnects.
//   node bin/connect.js [url]           Vite: run its own Vite with EditLens; else proxy <url>
//   node bin/connect.js stop [remove]   stop; "remove" also strips marked EditLens blocks
//   node bin/connect.js status
const fs = require('fs');
const path = require('path');
const { normalize } = require('../lib/paths');
const safepath = require('../lib/safepath');
const { ensureServer, postJson, getJson, isUp, pageKey } = require('../lib/client');
const { keyedUrl } = require('../lib/pagekey');
const { findIntegrations, removeMarked, detect, devServerOf, PY_NAMES, probe } = require('../lib/connect');
const config = require('../lib/config');
const { say } = require('../lib/say');
const { refusal } = require('../lib/starter');
const { plainError, plainMessage } = require('../lib/plainerr');
const { shownUrl } = require('../lib/browser');

// The other way for Python servers: the script tag in the base template, marked so
// `/editlens stop remove` removes it again.
function pythonTag(cwd) {
  const root = path.resolve(cwd).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  say.steps('Or use your server\'s own address', [
    { text: 'Add these 3 lines before </body> in your base template (for example templates/base.html):' },
    { text: '<!-- editlens:start -->' },
    { text: `<script src="http://127.0.0.1:${config.port}/live.js" data-root="${root}"></script>` },
    { text: '<!-- editlens:end -->' },
  ], { text: 'Remove them later:', cmd: '/editlens stop remove' });
}
const { BackupStore } = require('../server/backups');

function errorText(err) {
  if (err && typeof err.code === 'string') return plainError(err);
  const msg = String((err && err.message) || err).replace(/^server answered \d+: /, '');
  try {
    return plainMessage(JSON.parse(msg).error || msg);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return plainMessage(msg);
  }
}

function listLines(found) {
  for (const f of found) say.text(`  ${f.rel}:${f.line}${f.marked ? ' (marked)' : ''}  ${f.text}`, true);
}

// The project files that load EditLens, as one field.
function filesField(found) {
  if (!found.length) return say.field('Project', 'no files changed');
  const open = unclosed(found);
  const note = found.some((f) => f.marked && !open.has(f.file)) ? '/editlens stop remove removes them'
    : open.size ? 'a block has no editlens:end line: add it, or remove the lines yourself' : 'ask Claude to remove them when you are done';
  say.field('Project', '! EditLens lines in ' + [...new Set(found.map((f) => f.rel))].join(', '), note);
}

// Backs each file up first; the panel's Restore can't see these copies, so the path is printed.
// Each file is resolved first (links included): a file that is not inside the project is skipped.
function removeBlocks(cwd) {
  const named = [...new Set(findIntegrations(cwd).filter((f) => f.marked).map((f) => f.file))];
  const store = new BackupStore(path.join(config.stateDir, 'backups'));
  const done = [];
  for (const name of named) {
    const rel = path.relative(cwd, name);
    const at = safepath.inside(cwd, rel);
    if (!at.error && !at.exists) {
      say.text(`Skipped ${rel}: it is no longer there`, true);
      continue;
    }
    if (at.error === 'outside') {
      say.fail(`Skipped ${rel}`, 'it is a link to a file outside this project');
      say.fix('', '', 'remove the EditLens lines manually in the file it links to');
      continue;
    }
    if (at.error) {
      say.fail(`Skipped ${rel}`, `it could not be read (${at.error})`);
      say.fix('/editlens stop remove', 'again', `make ${rel} readable, then run`);
      continue;
    }
    const file = at.file;
    const text = fs.readFileSync(file, 'utf8');
    const out = removeMarked(text);
    if (out.unclosed) {
      say.fail(`Skipped ${rel}`, 'it has "editlens:start" without "editlens:end"');
      say.fix('/editlens stop remove', 'again', 'add the missing "editlens:end" line, then run');
      continue;
    }
    if (!out.removed) continue;
    const backup = store.save({ file, relFile: rel, cwd, text, reason: 'disconnect' });
    fs.writeFileSync(file, out.text);
    done.push({ rel, lines: out.removed, backup });
  }
  return done;
}

// The connection's folder is this folder or one inside it.
function inside(dir, cwd) {
  const x = normalize(path.resolve(dir));
  const y = normalize(path.resolve(cwd));
  return x === y || x.startsWith(y + '/');
}
function where(dir, cwd) {
  const rel = path.relative(cwd, dir);
  return rel ? ` in ${rel}` : '';
}

// Connects cwd's page: Vite runs with EditLens, other dev servers get the EditLens proxy for the dev server.
// -> the server's response ({ url, kind, target, already, and whether the folder is served because the
// dev server is not running }) plus found and python,
// or { problem: 'unsure' | 'not-running' | 'nothing-answers' | 'failed', ... }. Prints nothing.
async function connectPage(cwd, target) {
  await ensureServer();
  const kind = detect(cwd);
  const connect = (to) => postJson('/connect', { cwd, target: to }, { timeoutMs: 90000 }).catch((err) => ({ error: errorText(err) }));
  let res = await connect(target || null);
  let found = null;
  if (res.error === 'needs-url') {
    // Not Vite: look for the project's dev server where it ran last, and where it usually runs.
    found = await devServerOf(cwd, { skip: [config.port], stateDir: config.stateDir });
    if (found && found.sure) res = await connect(found.url);
    else if (found) {
      // A usual framework port (or an old address) not seen running from this project may be
      // another project's server, so the user confirms it with one click.
      await postJson('/connect/hint', { cwd, url: found.url }).catch((err) => {
        process.stderr.write(`(could not offer the Connect button: ${errorText(err)})\n`);
      });
      return { problem: 'unsure', url: found.url };
    }
  }
  if (res.error === 'needs-url') {
    const name = res.kind === 'next' ? 'Next.js' : res.kind === 'python' && PY_NAMES[res.framework] ? PY_NAMES[res.framework] : '';
    return { problem: 'not-running', name, command: res.command || null, python: res.kind === 'python' };
  }
  if (res.error === 'nothing-answers') return { problem: 'nothing-answers', target: res.target, command: res.command || null };
  if (res.code === 'no-app') return { problem: 'no-app', apps: Array.isArray(res.apps) ? res.apps.filter((a) => typeof a === 'string') : [] };
  if (res.error) return { problem: 'failed', error: res.error, log: Array.isArray(res.log) ? res.log : [] };
  return { ...res, found: found && found.url, python: kind.kind === 'python' ? PY_NAMES[kind.framework] || 'Python' : null };
}

// The page's address and where it comes from, for the Page field.
function pageNote(res) {
  if (res.kind === 'vite') return 'your Vite dev server, with EditLens';
  if (res.kind === 'static') return 'EditLens serves this folder (no dev server needed)';
  if (res.fallback) return `EditLens serves this folder until ${res.target} answers`;
  return `your dev server at ${res.target}`;
}

// What stopped connectPage, with its fix. Sets the exit code.
// note: said first (the app found in a folder inside this one).
function sayProblem(res, cwd, note) {
  process.exitCode = 1;
  const about = (own) => [note, own].filter(Boolean).join(' · ');
  if (res.problem === 'unsure') {
    const host = res.url.replace('http://', '');
    say.head(null, '', about(`found ${host}, not sure it's this project`));
    say.blank();
    say.steps('Is this your app?', [{ cmd: `/editlens ${res.url}`, text: `or press Connect ${host} on the line above the prompt` }]);
  } else if (res.problem === 'not-running') {
    say.head(null, '', about(`no ${res.name ? res.name + ' ' : ''}dev server found`));
    say.blank();
    say.steps('Start your dev server', [
      { n: 1, cmd: res.command || 'npm run dev', text: 'in another terminal' },
      { n: 2, cmd: '/editlens', text: 'here, again' },
    ], { text: 'Different address?', cmd: '/editlens http://localhost:<port>' });
    if (res.python) {
      say.blank();
      pythonTag(cwd);
    }
  } else if (res.problem === 'no-app') {
    sayNoApp(res.apps, cwd, note);
  } else if (res.problem === 'nothing-answers') {
    if (note) say.head(null, '', note);
    say.fail('Couldn\'t connect', `no server is running at ${res.target}`);
    say.fix('/editlens', '', `start your dev server${res.command ? ` (${res.command})` : ''}, then`);
  } else {
    if (note) say.head(null, '', note);
    say.fail('Couldn\'t connect', plainMessage(res.error));
    for (const line of res.log.slice(-8)) say.text('  ' + line, true);
    say.fix('/editlens', '', 'fix what it says, then');
  }
}

// A folder with no app: connect one nearby, or make a starter page here (/editlens new, which only
// the user types). Where no starter page may go, the second choice is a new folder.
function sayNoApp(apps, cwd, note) {
  say.head(null, '', [note, 'no app in this folder (no package.json or index.html)'].filter(Boolean).join(' · '));
  say.blank();
  const no = refusal(cwd, { stateDir: config.stateDir });
  const fresh = no ? { text: `Or make a folder for a new site: ${no.fix}, then open Claude Code in it and type`, cmd: '/editlens new' } : { text: 'Or make a starter page here:', cmd: '/editlens new' };
  if (apps.length) {
    say.steps('Connect an app in a folder nearby', apps.map((a) => ({ cmd: `/editlens ${quoteArg(path.relative(cwd, a))}` })), fresh);
    return;
  }
  if (no) {
    say.steps('Make a folder for a new site', [{ n: 1, cmd: no.fix }, { n: 2, text: `open Claude Code in ${no.where}` }, { n: 3, cmd: '/editlens new', text: 'makes index.html there and opens it' }],
      { text: 'Or open Claude Code in your app\'s folder, or name it:', cmd: '/editlens <folder>' });
    return;
  }
  say.steps('Make a starter page here', [{ cmd: '/editlens new', text: 'makes index.html and connects it' }], { text: 'Or open Claude Code in your app\'s folder, or name it:', cmd: '/editlens <folder>' });
}

function quoteArg(rel) {
  return /\s/.test(rel) ? `"${rel}"` : rel;
}

// Files with "editlens:start" but no "editlens:end": stop remove skips them, so it is not offered.
function unclosed(found) {
  const out = new Set();
  for (const file of new Set(found.filter((f) => f.marked).map((f) => f.file))) {
    try {
      if (removeMarked(fs.readFileSync(file, 'utf8')).unclosed) out.add(file);
    } catch (err) {
      if (!['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes(err.code)) throw err;
    }
  }
  return out;
}

// What the failure line says when main() throws: the step it was on.
let failWhat = 'Couldn\'t connect';

async function main() {
  // Words in any case; an address keeps its own (paths can be case-sensitive).
  let arg = (process.argv[2] || '').trim();
  if (['stop', 'status'].includes(arg.toLowerCase())) arg = arg.toLowerCase();
  const extra = process.argv.slice(3).map((a) => String(a).trim().toLowerCase()).filter(Boolean);
  if (arg === 'stop' && extra.length) {
    if (extra.length > 1 || extra[0] !== 'remove') {
      say.fail(`"${extra.join(' ').slice(0, 40)}" isn't a word /editlens stop knows`);
      say.fix('/editlens stop', 'disconnects; /editlens stop remove also removes the marked lines');
      process.exitCode = 1;
      return;
    }
    arg = 'remove';
  }
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // stop and status don't start a server just to say nothing is connected. If another program
  // uses the port, ensureServer says which.
  const quiet = arg === 'status' || arg === 'stop' || arg === 'remove';
  if (arg === 'status') failWhat = 'Couldn\'t read the status';
  else if (quiet) failWhat = 'Couldn\'t disconnect';
  let up = quiet ? await isUp() : false;
  if (!up && (!quiet || (await probe(config.port, 700, { v6: false })).ok)) {
    await ensureServer();
    up = true;
  }
  if (arg === 'status') {
    const list = up ? await getJson('/connections') : [];
    const mine = list.filter((c) => inside(c.cwd, cwd));
    say.head(mine.length ? 'ok' : null, mine.length ? 'connected' : '', mine.length ? '' : up ? 'not connected (/editlens connects)' : "EditLens isn't running (/editlens starts it and connects)");
    const key = mine.length ? await pageKey() : null;
    for (const c of mine) say.field('Page', shownUrl(keyedUrl(c.url, key)), (c.kind === 'vite' ? 'Vite run by EditLens' : c.kind === 'static' || !c.target ? 'EditLens serves this folder' : 'a proxy for ' + c.target) + where(c.cwd, cwd), { link: true });
    const found = findIntegrations(cwd);
    filesField(found);
    if (found.length) listLines(found);
    return;
  }
  if (arg === 'stop' || arg === 'remove') {
    let stopped = 0;
    let proxied = false;
    let pageControl = false;
    if (up) {
      // This folder, and apps in folders inside it that /editlens connected.
      const list = await getJson('/connections');
      const mine = list.filter((c) => inside(c.cwd, cwd));
      proxied = mine.some((c) => c.kind === 'proxy');
      const dirs = [...new Set([cwd, ...mine.map((c) => c.cwd)])];
      // A count only when it is a whole number (Sol L1): "0" as text would read as connected.
      for (const d of dirs) {
        const n = (await postJson('/disconnect', { cwd: d })).stopped;
        if (Number.isSafeInteger(n) && n > 0) stopped += n;
      }
      // Page control in this folder ends too (the user's choice, D5); the chat is kept.
      const ended = await postJson('/drive/end', { cwd }).catch((err) => {
        process.stderr.write(`(could not end page control: ${errorText(err)})\n`);
        return null;
      });
      pageControl = Boolean(ended && ended.ended);
    }
    say.head(stopped ? 'ok' : null, stopped ? 'disconnected' : '', stopped ? (proxied ? 'your own dev server keeps running' : '') : up ? 'nothing was connected with /editlens here' : "EditLens isn't running, so nothing was connected");
    if (pageControl) {
      say.blank();
      say.field('Control', '○ Page control ended', 'the page chat is in claude --resume');
    }
    if (arg === 'remove') {
      failWhat = 'Couldn\'t remove the EditLens lines';
      const done = removeBlocks(cwd);
      for (const d of done) say.done(`Removed ${d.lines} marked lines from ${d.rel}`, `copy of the file before: ${path.join(config.stateDir, 'backups', d.backup + '.json')}`);
    }
    const left = findIntegrations(cwd);
    if (left.length) {
      say.field('Project', '! EditLens is still in ' + [...new Set(left.map((f) => f.rel))].join(', '));
      listLines(left);
      const open = unclosed(left);
      if (left.some((f) => f.marked && !open.has(f.file))) say.hint(['/editlens stop remove', 'removes the marked lines']);
      if (open.size) say.text(`Add the editlens:end line to ${[...open].map((f) => path.relative(cwd, f)).join(', ')}, or remove the EditLens lines there yourself.`, true);
      if (left.some((f) => !f.marked)) say.text('Lines without editlens:start/end markers are never changed by EditLens.', true);
    } else {
      say.field('Project', 'no EditLens lines in your files');
    }
    return;
  }
  // /editlens <address>, run alone: the page part of /editlens's output.
  const res = await connectPage(cwd, arg || null);
  if (res.problem) return sayProblem(res, cwd);
  say.head('ok', res.already ? 'already connected' : 'connected');
  say.blank();
  say.field('Page', shownUrl(keyedUrl(res.url, await pageKey())), pageNote(res), { link: true });
  filesField(findIntegrations(cwd));
}

if (require.main === module) {
  main().catch((err) => {
    say.fail(failWhat, errorText(err));
    say.fix('/editlens details', 'to see whether EditLens is running, then try again');
    process.exitCode = 1;
  });
}

module.exports = { connectPage, sayProblem, sayNoApp, quoteArg, pageNote, filesField, listLines, pythonTag, errorText, removeBlocks };
