#!/usr/bin/env node
'use strict';
// /editlens entry point: node bin/start.js [command]. With no command, follows the
// "What /editlens does" setting (connect this project's page by default).
// Commands: <address|port>, <folder>, new, stop [remove], control, manual, pair, join, task-user,
// undo, restore, status, details, agents, sessions, settings, effort, usage, help.
// lib/help.js describes each one; most run a script in bin/.
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');
const settings = require('../lib/settings');
const config = require('../lib/config');
const { ensureServer, getJson, isUp, health, pageKey } = require('../lib/client');
const { keyedUrl } = require('../lib/pagekey');
const { olderNote } = require('../lib/versions');
const { openOnce, canOpenBrowser, shownUrl } = require('../lib/browser');
const { plainError } = require('../lib/plainerr');
const fs = require('fs');
const { findIntegrations, detect, appsByRecent, recentApps } = require('../lib/connect');
const { refusal, writeStarter } = require('../lib/starter');

const BIN = __dirname;

// env: extra environment, e.g. CLAUDE_PROJECT_DIR for an app in a folder inside the project.
function run(script, args, env) {
  const out = spawnSync(process.execPath, [path.join(BIN, script), ...args], { stdio: 'inherit', env: { ...process.env, ...env }, windowsHide: true });
  if (out.error) throw out.error;
  if (out.status !== 0) process.exitCode = 1;
  return out.status === 0;
}

const { sayHelp } = require('../lib/help');
const { say } = require('../lib/say');
const { connectPage, sayProblem, pageNote, filesField, pythonTag } = require('./connect');
const { control, sayControl, adviceFor } = require('./drive');

// The same groups and words as the mod's Settings pane (hooks/mod.mjs settingsLines).
async function saySettings() {
  // A command Claude ran with its Bash tool gets no plugin options: the saved ones (settings.given()).
  const { raw, values } = settings.given();
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'hooks', 'mod.mjs')).href);
  say.head(null, '', 'change them in /config (search "editlens")', 'EditLens settings');
  say.blank();
  // The same lines as the mod's settingsText (where no pane can be shown).
  say.fields(mod.settingRows(settings.SCHEMA, values));
  // The same notes as the mod's text form (hooks/mod.mjs effectNotes); config.port is the port this
  // session's server uses (EDITLENS_PORT, else the one kept for the session, else the Port setting).
  const notes = mod.effectNotes({ schema: settings.SCHEMA, raw, env: process.env, port: config.port });
  if (notes.length) say.blank();
  // Each a warning line (! in the warning colour), as the other screens have them.
  for (const n of notes) say.steps(n, []);
}

// The context window as the server last read it (the mod shows this session's own numbers instead).
// Then the status line the user adds to their settings for plan limits in the panel; EditLens
// never edits that file.
async function sayUsage(cwd) {
  const cmd = `node "${config.statusLineFile.split(path.sep).join('/')}"`;
  let s = null;
  if (await isUp()) {
    s = await getJson(`/summary?cwd=${encodeURIComponent(cwd)}&session=${encodeURIComponent(process.env.CLAUDE_CODE_SESSION_ID || '')}`).catch((err) => {
      process.stderr.write(`(could not read the context window from EditLens: ${plainError(err)})\n`);
      return null;
    });
  }
  const t = (s && s.tokens) || {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const pct = num(t.percent);
  const used = num(t.context);
  const win = num(t.window);
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'hooks', 'mod.mjs')).href);
  // The user's auto-compact window (/autocompact) is where Claude compacts: it is named as such.
  const compact = t.windowSource === 'autocompact';
  say.head(null, '', win ? `${mod.fmtWindow(win)} ${compact ? 'auto-compact window' : 'context'}` : '', 'Usage');
  if (pct !== null) {
    say.blank();
    say.meter('Context', pct, used !== null && win ? `${mod.fmtTokens(used)} of ${mod.fmtWindow(win)}` : '', compact ? { source: 'autocompact' } : null);
  }
  say.blank();
  say.steps('Plan limits in the panel: add to ~/.claude/settings.json', [
    { text: `"statusLine": { "type": "command", "command": ${JSON.stringify(cmd)} }`, code: true },
  ], { text: 'Have one already? Add --then <your command> to the end. Numbers appear after Claude\'s next reply in a terminal session.' });
}

// Plain /editlens in Manual opens the page when the user typed it here (the mod sets
// EDITLENS_TYPED), no page of this project is open yet, and a browser can open here. With no
// browser (a VPS through SSH), it says how to open it from the user's computer. -> { opened } | { advice }
async function openTyped(dir, url) {
  if (!url) return {};
  const browser = canOpenBrowser();
  // With the page key (macOS, Windows) it opens even when Claude ran /editlens: a page opened another
  // way can't connect until a page of its address had the key once (D21).
  const key = await pageKey();
  if (browser.ok && process.env.EDITLENS_TYPED !== '1' && !key) return {};
  const s = await getJson(`/summary?cwd=${encodeURIComponent(dir)}`).catch((err) => {
    process.stderr.write(`(could not check whether your page is open: ${plainError(err)})\n`);
    return null;
  });
  if (!s || !Array.isArray(s.pages) || s.pages.length) return {};
  if (!browser.ok) return { advice: await adviceFor(dir, url, browser) };
  return { opened: openOnce(keyedUrl(url, key), config.stateDir) };
}

// The project loads EditLens by itself and its page is open already: nothing to start.
async function openAlready(cwd) {
  if (!findIntegrations(cwd).length) return null;
  await ensureServer();
  const s = await getJson(`/summary?cwd=${encodeURIComponent(cwd)}`);
  return s && Array.isArray(s.pages) && s.pages.length ? s.pages : null;
}

// "/editlens web" or "/editlens ./apps/web": a folder containing an app. -> absolute folder or null
function folderArg(cwd, text) {
  const dir = path.resolve(cwd, text.replace(/^["']|["']$/g, ''));
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch (err) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(err.code)) throw err;
  }
  return isDir && detect(dir).kind !== 'none' ? dir : null;
}

function quoteArg(rel) {
  return /\s/.test(rel) ? `"${rel}"` : rel;
}

function recentlyUsed(dir) {
  return recentApps(config.stateDir).includes(dir);
}

// What the user typed for an app's folder; "new" is the command, so a folder named new is ./new.
function appArg(cwd, dir) {
  const rel = path.relative(cwd, dir);
  return quoteArg(rel.toLowerCase() === 'new' ? './' + rel : rel);
}

// Why index.html can't be written, in plain words.
const WRITE_ERRORS = { EACCES: 'this folder can\'t be written to', EPERM: 'this folder can\'t be written to', EROFS: 'this folder is read-only', ENOSPC: 'the disk is full' };

// /editlens new: a starter index.html in a folder with no app; /editlens then connects it.
// -> { note, made } to continue, or null when it stopped here (it said why).
function starterPage(cwd) {
  if (detect(cwd).kind !== 'none') {
    return { note: fs.existsSync(path.join(cwd, 'index.html')) ? 'index.html exists, so nothing was made' : 'an app is here, so nothing was made' };
  }
  const apps = appsByRecent(cwd, config.stateDir);
  if (apps.length) {
    say.head(null, '', 'this folder has apps in folders inside it, so nothing was made');
    say.blank();
    say.steps('Connect one', apps.map((a) => ({ cmd: `/editlens ${appArg(cwd, a)}` })));
    return null;
  }
  const no = refusal(cwd, { stateDir: config.stateDir });
  const w = no ? null : writeStarter(cwd);
  if (no || w.error) {
    const fix = no || { fix: 'mkdir ~/my-site', where: '~/my-site' };
    say.fail('Can\'t make a starter page here', no ? no.why : (WRITE_ERRORS[w.error] || 'index.html could not be written'));
    say.fix(fix.fix, `, then open Claude Code in ${fix.where} and type /editlens new`);
    process.exitCode = 1;
    return null;
  }
  if (w.kept) return { note: 'index.html exists, so nothing was made' };
  return { note: 'made index.html, a starter page', made: true };
}

(async () => {
  let args = process.argv.slice(2).map((a) => String(a).trim()).filter(Boolean);
  let first = (args[0] || '').toLowerCase();
  if (first === 'help') return sayHelp(say, args.slice(1).join(' '));
  if (first === 'settings') return saySettings();
  if (first === 'usage') return sayUsage(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  // The line above the prompt is drawn by the EditLens mod, which also handles "/editlens line".
  if (first === 'line') return say.steps('The line above the prompt shows only in the terminal and the desktop Code tab', [], { text: 'Turn it on or off there:', cmd: '/editlens line' });
  if (first === 'status') return run('connect.js', ['status']);
  if (first === 'details') return run('details.js', []);
  if (first === 'effort') return run('effort.js', args.slice(1));
  if (first === 'agents') return run('details.js', ['agents']);
  if (first === 'sessions') return run('details.js', ['sessions', ...args.slice(1)]);
  // "stop <name>": a page control session or a task by its name (stop remove: disconnect, below).
  if (first === 'stop' && args.length > 1 && args[1].toLowerCase() !== 'remove') return run('details.js', ['stop', ...args.slice(1)]);
  if (first === 'stop') return run('connect.js', ['stop', ...args.slice(1)]);
  // Restarts the server, then continues as /editlens (below).
  let restarted = null;
  if (first === 'restart') {
    const restartBin = require('./restart');
    restarted = await restartBin.restart().catch((err) => {
      restartBin.sayFailed(err);
      return null;
    });
    if (!restarted || !restartBin.sayRestart(restarted)) return undefined;
    await restartBin.waitForPages(restarted.pages);
    say.blank();
    args = [];
    first = '';
  }
  if (first === 'pair' || first === 'join') return run('pair.js', args);
  if (first === 'task-user') return run('taskuser.js', args.slice(1));
  if (first === 'undo' || first === 'restore') return run('undo.js', args);
  // "control vps-1" / "manual vps-1": on a paired computer.
  const onHost = args[1] && !/^(new|take|[0-9a-f-]{36})$/i.test(args[1]);
  if (first === 'control' && onHost) return run('pair.js', args);
  // "/editlens control [new | <session>]": connects the page first if needed, then turns page
  // control on and waits for the page to open.
  let controlArgs = null;
  if (first === 'control') {
    // "NEW" and an upper-case session id work too: drive.js compares lower case.
    controlArgs = args.slice(1).map((a) => a.toLowerCase());
    // At most one of new or a session id, and take at most once.
    const named = controlArgs.filter((a) => a !== 'take');
    const extra = [...named.filter((a, i) => i > 0 || !/^(new|[0-9a-f-]{36})$/.test(a)), ...controlArgs.filter((a) => a === 'take').slice(1)];
    if (extra.length) {
      say.fail(`"${extra.join(' ').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40)}" isn't a word /editlens control knows`);
      say.fix('/editlens control', 'alone, or with new, a session id, or take');
      process.exitCode = 1;
      return undefined;
    }
    args = [];
    first = '';
  }
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Only from the user: the skill and the mod run it for a typed /editlens new, and the Bash guard
  // blocks Claude from running it (hooks/live-hook.js onBash).
  let starter = null;
  if (first === 'new') {
    if (args.length > 1) {
      say.fail('/editlens new takes no name', 'it makes index.html in this folder');
      say.fix('/editlens new', 'here, or open Claude Code in another folder first');
      process.exitCode = 1;
      return undefined;
    }
    starter = starterPage(cwd);
    if (!starter) return undefined;
    args = [];
    first = '';
  }
  if (first === 'manual') {
    if (onHost) return run('pair.js', args);
    say.head('ok', 'back to Manual', 'the page chat is in claude --resume');
    say.blank();
    return sayControl(await control({ cwd, word: 'manual' }));
  }
  let target = null;
  let app = null;
  // A port: 2 to 5 digits, at most 65535, alone or after localhost.
  const portOf = /^\d+$/.test(first) ? first : (/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)(?:\/|$)/i.exec(first) || [])[1];
  if (portOf !== undefined && !(/^\d{2,5}$/.test(portOf) && Number(portOf) <= 65535)) {
    say.fail(`"${first.slice(0, 40)}" isn't a port`, 'a port is a number like 3000 or 5173');
    say.fix('/editlens 5173', 'with your dev server\'s port');
    process.exitCode = 1;
    return undefined;
  }
  if (/^\d{2,5}$/.test(first)) target = `http://localhost:${first}`;
  else if (/^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(\/|$)/i.test(first)) {
    // No port: port 80 is almost never a dev server, so EditLens asks instead of guessing.
    say.fail(`"${first.slice(0, 40)}" has no port`, 'give the port your dev server prints, like localhost:5173');
    say.fix('/editlens 5173', 'with your dev server\'s port');
    process.exitCode = 1;
    return undefined;
  } else if (/^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(first)) target = args[0];
  else if (first) {
    app = folderArg(cwd, args.join(' '));
    if (!app) {
      say.fail(`"${args[0]}" isn't something /editlens knows`);
      say.fix('/editlens', 'with one of the commands below');
      say.blank();
      sayHelp(say);
      process.exitCode = 1;
      return undefined;
    }
  }
  if (!target && !app) {
    // Claude Code opened on a folder that contains the app (or several) rather than on the app.
    const apps = appsByRecent(cwd, config.stateDir);
    if (apps.length === 1 && apps[0] !== path.resolve(cwd)) app = apps[0];
    else if (apps.length > 1) {
      say.head(null, '', 'this folder has more than one app');
      say.blank();
      say.steps('Connect one', apps.map((a, i) => ({ cmd: `/editlens ${appArg(cwd, a)}`, note: i === 0 && recentlyUsed(a) ? '(used last)' : '' })));
      return undefined;
    }
  }
  const dir = app || cwd;
  const env = app ? { CLAUDE_PROJECT_DIR: app } : {};
  const open = target ? null : await openAlready(dir);
  let res = null;
  if (!open) {
    res = await connectPage(dir, target);
    if (res.problem) return sayProblem(res, dir, app ? `your app is in ${path.relative(cwd, app)}` : starter ? starter.note : '');
  }
  // Page control kept across the restart starts again automatically when its page reconnects.
  const wantsControl = settings.startsControlNow({ asked: Boolean(controlArgs), values: settings.given().values }) && !(restarted && restarted.control);
  const r = wantsControl
    ? await withEnv(env, () => control({ cwd: dir, word: (controlArgs || []).find((a) => a !== 'take') || '', take: (controlArgs || []).includes('take'), wait: 120000, open: true }))
    : restarted && restarted.control ? { back: true } : { manual: true, ...(res ? await openTyped(dir, res.url) : {}) };
  const note = starter ? starter.note : res && res.found ? `found your dev server at ${res.found}` : open ? 'your app loads EditLens by itself' : '';
  say.head('ok', res && res.already ? 'already connected' : 'connected', note);
  say.blank();
  if (app) say.field('App', path.relative(cwd, app) || '.');
  const pages = open ? open.map((p) => p.url).filter(Boolean) : [res.url];
  const key = await pageKey();
  pages.forEach((url, i) => say.field(i ? '' : 'Page', shownUrl(keyedUrl(url, key)), [r.opened && i === 0 ? 'opened in your browser' : '', res ? pageNote(res) : ''].filter(Boolean).join(' · '), { link: true }));
  sayControl(r, () => {
    if (starter && starter.made) say.field('Project', 'index.html is new', 'ask Claude to change it, for example "add a photo and a contact form"');
    else filesField(findIntegrations(dir));
    if (res && res.python) say.field(res.python, 'open the address above, not your server\'s own');
    if (config.port !== 4317) say.field('EditLens', `port ${config.port}`);
  });
  if (res && res.python) {
    say.blank();
    pythonTag(dir);
  }
  const old = olderNote(await health(), config.version);
  if (old) say.text(`${old[0]} · ${old[1]}`, true);
  return undefined;
})().catch((err) => {
  say.fail('EditLens couldn\'t start', plainError(err));
  say.fix('/editlens details', 'to see whether EditLens is running, then try again');
  process.exitCode = 1;
});

// Runs fn with extra environment (an app in a folder inside the project), then puts it back.
async function withEnv(env, fn) {
  const before = {};
  for (const k of Object.keys(env)) {
    before[k] = process.env[k];
    process.env[k] = env[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
}
