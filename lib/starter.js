'use strict';
// /editlens new: a starter page (index.html) in a folder that has no app yet. Only a /editlens new
// typed by the user makes it, never Claude or the page. It never replaces a file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalize, within, tooBroad } = require('./paths');
const { detect, recentApps, SKIP_DIRS } = require('./connect');

const PLUGIN_DIR = path.resolve(__dirname, '..');

// More files than this that are not web files: the folder is for something else (documents,
// photos, another kind of project), so no starter page goes there.
const MANY_OTHER = 20;
// Pages, styles, scripts, images, fonts, data and notes a small website has.
const WEB_FILE = /\.(html?|css|m?js|cjs|jsx|tsx?|json|map|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|md|txt)$/i;

// System and program folders: never anywhere inside them.
const SYSTEM_TREES = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/boot', '/dev', '/proc', '/sys', '/run',
  '/System', '/Library', '/Applications', '/private/etc'];
// Folders that contain the system's or other people's folders: not the folder itself.
const SYSTEM_TOPS = ['/var', '/opt', '/srv', '/tmp', '/mnt', '/media', '/home', '/Users', '/Volumes', '/private', '/private/var', '/private/tmp', '/snap'];
// The same on Windows, on any drive (normalize() makes them lower case).
const WIN_TREES = ['/windows', '/program files', '/program files (x86)', '/programdata'];
const WIN_TOPS = ['/users'];

// Why no starter page may go in dir, or null when it may. -> { why, fix } (fix: a command to type)
function refusal(dir, { home = os.homedir(), stateDir = null, pluginDir = PLUGIN_DIR } = {}) {
  // A Windows path stays as it is (path.resolve would make C:\Windows relative off Windows).
  const x = normalize(/^[a-z]:[\\/]/i.test(dir) ? dir : path.resolve(dir));
  const h = normalize(home);
  const elsewhere = { fix: 'mkdir ~/my-site', where: '~/my-site' };
  if (h && x === h) return { why: 'this is your home folder', fix: 'mkdir my-site', where: 'my-site' };
  if (x === '/' || /^[a-z]:$/.test(x) || /^\/\/[^/]+(\/[^/]+)?$/.test(x)) return { why: 'this is the top folder of a drive', ...elsewhere };
  const drive = /^[a-z]:\//.test(x) ? x.slice(2) : null;
  const trees = drive === null ? SYSTEM_TREES : WIN_TREES;
  const tops = drive === null ? SYSTEM_TOPS : WIN_TOPS;
  const rest = drive === null ? x : drive;
  if (trees.some((t) => within(rest, t)) || tops.includes(rest)) return { why: 'this is a system folder', ...elsewhere };
  if (tooBroad(x, home)) return { why: 'this folder contains your home folder', ...elsewhere };
  if ((stateDir && within(x, stateDir)) || within(x, pluginDir)) return { why: 'this is EditLens\'s own folder', ...elsewhere };
  if (h && within(x, path.join(home, '.claude'))) return { why: 'this is Claude Code\'s own folder', ...elsewhere };
  // ~/.config, ~/.ssh and other hidden folders in the home folder contain settings, not websites.
  if (h && x.startsWith(h + '/') && x.slice(h.length + 1).startsWith('.')) return { why: 'this is a hidden settings folder', ...elsewhere };
  const other = otherFiles(dir);
  if (other > MANY_OTHER) return { why: `this folder has ${other} files that are not web files (more than ${MANY_OTHER})`, ...elsewhere };
  return null;
}

// How many files (not folders, not hidden) right in dir are not web files. Counts up to 1000.
function otherFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(err.code)) return 0;
    throw err;
  }
  return entries.slice(0, 1000).filter((e) => e.isFile() && !e.name.startsWith('.') && !WEB_FILE.test(e.name)).length;
}

// "my-site" -> "My site": the page's title from the folder's name.
function titleOf(dir) {
  const name = path.basename(path.resolve(dir)).replace(/[\u0000-\u001f\u007f]/g, '').replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return name ? name[0].toUpperCase() + name.slice(1) : 'My site';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pageText(title) {
  const t = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<style>
  body { margin: 0; font: 18px/1.6 system-ui, sans-serif; color: #1f2328; background: #fafaf7; }
  main { max-width: 40rem; margin: 0 auto; padding: 4rem 1.5rem; }
  h1 { font-size: 2.5rem; line-height: 1.2; margin: 0 0 1rem; }
  p { color: #57606a; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6edf3; background: #0d1117; }
    p { color: #9198a1; }
  }
</style>
</head>
<body>
<main>
  <h1>${t}</h1>
  <p>A starter page made by EditLens. Ask Claude to change it, for example: "make this a page about my bakery, with the opening hours".</p>
</main>
</body>
</html>
`;
}

// Writes dir/index.html, only when no file of that name is there ('wx' fails on any file).
// -> { made: file } | { kept: file } | { error: code }
function writeStarter(dir) {
  const file = path.join(dir, 'index.html');
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') return { kept: file };
    if (['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOENT', 'ENOTDIR', 'EISDIR'].includes(err.code)) return { error: err.code };
    throw err;
  }
  try {
    fs.writeSync(fd, pageText(titleOf(dir)));
  } finally {
    fs.closeSync(fd);
  }
  return { made: file };
}

// Apps near a folder that has none: its parent folder, and the parent's other folders (one level).
// The most recently connected first, then by name. -> [absolute folder], at most max
function nearbyApps(cwd, { stateDir = null, max = 3, home = os.homedir() } = {}) {
  const dir = path.resolve(cwd);
  const parent = path.dirname(dir);
  // A drive or filesystem root contains everything: don't guess there.
  if (parent === dir || (tooBroad(parent, home) && normalize(parent) !== normalize(home))) return [];
  const found = [];
  if (normalize(parent) !== normalize(home) && detect(parent).kind !== 'none') found.push(parent);
  let entries = [];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch (err) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(err.code)) throw err;
  }
  const siblings = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .slice(0, 300)
    .map((e) => path.join(parent, e.name))
    .filter((d) => normalize(d) !== normalize(dir) && detect(d).kind !== 'none');
  const recent = stateDir ? recentApps(stateDir).map((d) => normalize(path.resolve(d))) : [];
  const rank = (d) => {
    const i = recent.indexOf(normalize(d));
    return i < 0 ? recent.length : i;
  };
  siblings.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [...found, ...siblings].slice(0, max);
}

// The one-line error for a folder with no app (the server's /connect answer), with both choices.
function noAppText(cwd, apps) {
  const near = apps.map((a) => '/editlens ' + quoteArg(path.relative(cwd, a))).join(', ');
  return 'No app here: this folder has no package.json or index.html, and neither do the folders inside it. ' +
    (near ? `Connect an app nearby (${near}), or make` : 'Make') + ' a starter page here: /editlens new.';
}

function quoteArg(rel) {
  return /\s/.test(rel) ? `"${rel}"` : rel;
}

// Only the user may run /editlens new.

// The user's prompt is /editlens new (as typed, or as Claude Code writes a slash command).
function typedNew(prompt) {
  const p = String(prompt || '');
  if (/^\s*\/(editlens:)?editlens\s+new\s*$/i.test(p)) return true;
  return /<command-name>\/?(editlens:)?editlens<\/command-name>/i.test(p) && /<command-args>\s*new\s*<\/command-args>/i.test(p);
}

// A ticket per session, saved by the prompt hook when the user types /editlens new and removed by
// the next prompt; the Bash guard allows Claude's `start.js new` only while it exists.
const TICKET_MS = 10 * 60000;
function ticketFile(stateDir, sessionId) {
  return /^[\w-]{1,100}$/.test(String(sessionId || '')) ? path.join(stateDir, 'asked-new', sessionId) : null;
}

function saveAsked(stateDir, sessionId, prompt) {
  const file = ticketFile(stateDir, sessionId);
  if (!file) return;
  if (typedNew(prompt)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(Date.now()));
    return;
  }
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
  }
}

function askedNew(stateDir, sessionId, now = Date.now()) {
  const file = ticketFile(stateDir, sessionId);
  if (!file) return false;
  let at;
  try {
    at = Number(fs.readFileSync(file, 'utf8').trim());
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR'].includes(err.code)) return false;
    throw err;
  }
  return Number.isFinite(at) && at > 0 && now - at >= 0 && now - at < TICKET_MS;
}

module.exports = { refusal, otherFiles, titleOf, pageText, writeStarter, nearbyApps, noAppText, typedNew, saveAsked, askedNew, MANY_OTHER, TICKET_MS };
