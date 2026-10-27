'use strict';
// Connect without changing the project: detect the dev server, write a wrapper Vite config in
// the state folder, and find/remove EditLens lines added to project files.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { INTEGRATION_MARK } = require('./guard');
const { tooBroad, normalize } = require('./paths');
const { writeAtomic, withLock } = require('./atomic');
const { portOwner, ownsProject } = require('./portowner');

// One key per folder however it is spelled (C:\\proj, c:\\proj, C:/proj).
function dirKey(dir) {
  return normalize(path.resolve(dir));
}

const VITE_CONFIGS = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs'];
// Lines added manually or by Claude between these markers can be removed by /editlens stop.
const START = 'editlens:start';
const END = 'editlens:end';
// Also accept the legacy marker names.
const hasStart = (l) => l.includes(START) || l.includes('live-edits:start');
const hasEnd = (l) => l.includes(END) || l.includes('live-edits:end');
// Where EditLens is usually added to a project.
const CANDIDATES = [
  ...VITE_CONFIGS,
  'next.config.js', 'next.config.mjs', 'next.config.ts', 'webpack.config.js', 'nuxt.config.ts', 'nuxt.config.js', 'astro.config.mjs', 'svelte.config.js',
  'index.html', 'public/index.html', 'src/index.html',
  'app/layout.tsx', 'app/layout.jsx', 'app/layout.js', 'src/app/layout.tsx', 'src/app/layout.jsx', 'src/app/layout.js',
  'pages/_document.tsx', 'pages/_document.jsx', 'pages/_document.js', 'pages/_app.tsx', 'pages/_app.jsx', 'pages/_app.js',
  'server.js', 'server.mjs', 'server.ts', 'app.js', 'app.mjs', 'app.ts', 'index.js', 'src/server.js', 'src/server.ts', 'src/app.js', 'src/app.ts', 'src/index.js', 'src/index.ts',
  'src/main.jsx', 'src/main.tsx', 'src/main.js', 'src/main.ts',
  // Python projects' base templates (Django, Flask, FastAPI with Jinja).
  'templates/base.html', 'templates/layout.html', 'templates/index.html', 'app/templates/base.html', 'app/templates/layout.html', 'app/templates/index.html',
];
const MAX_BYTES = 1024 * 1024;

// A file that can't be read (missing, a folder, a path through a file, too long) counts as absent.
const UNREADABLE = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR', 'ENAMETOOLONG', 'ELOOP'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && (UNREADABLE.includes(err.code) || err instanceof SyntaxError)) return null;
    throw err;
  }
}

function readText(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && UNREADABLE.includes(err.code)) return null;
    throw err;
  }
}

function viteConfigOf(cwd) {
  for (const name of VITE_CONFIGS) {
    const f = path.join(cwd, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// The project's own Vite (its node_modules), as the file to run with node: no shell, no npx.
function viteBinOf(cwd) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 6; i++) {
    const pkg = readJson(path.join(dir, 'node_modules', 'vite', 'package.json'));
    if (pkg) {
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.vite;
      const f = path.join(dir, 'node_modules', 'vite', bin || 'bin/vite.js');
      if (fs.existsSync(f)) return f;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// The script that starts the project's own server: dev, then start, then serve.
function serverScript(pkg) {
  const scripts = (pkg && pkg.scripts) || {};
  for (const name of ['dev', 'start', 'serve']) if (typeof scripts[name] === 'string' && scripts[name].trim()) return { name, text: scripts[name] };
  return null;
}

// A Python web project's framework, from manage.py or the dependency files.
// -> 'django' | 'fastapi' | 'flask' | null
const PY_DEPS = ['requirements.txt', 'requirements-dev.txt', 'requirements/base.txt', 'pyproject.toml', 'Pipfile', 'setup.cfg'];
function pythonFramework(cwd) {
  if (fs.existsSync(path.join(cwd, 'manage.py'))) return 'django';
  const text = PY_DEPS.map((name) => readText(path.join(cwd, name)) || '').join('\n').toLowerCase();
  if (!text.trim()) return null;
  for (const name of ['django', 'fastapi', 'flask']) {
    if (new RegExp(`(^|[\\s"'\\[,])${name}([\\s"'<>=~!\\[\\],;]|$)`, 'm').test(text)) return name;
  }
  return null;
}
const PY_NAMES = { django: 'Django', fastapi: 'FastAPI', flask: 'Flask' };
const PY_PORTS = { django: 8000, fastapi: 8000, flask: 5000 };

function pythonCommand(cwd, framework) {
  if (framework === 'django') return 'python manage.py runserver';
  if (framework === 'flask') return 'flask run --debug';
  if (framework === 'fastapi') {
    for (const [file, mod] of [['main.py', 'main'], ['app.py', 'app'], ['app/main.py', 'app.main'], ['src/main.py', 'src.main']]) {
      if (fs.existsSync(path.join(cwd, file))) return `uvicorn ${mod}:app --reload`;
    }
    return 'uvicorn main:app --reload';
  }
  return null;
}

// -> { kind, config, bin, devScript, script, framework }
// kind: 'vite' | 'next' | 'python' | 'other' | 'static' | 'none'. static: an index.html and no
// script that starts a server (EditLens serves the folder itself).
function detect(cwd) {
  const pkg = readJson(path.join(cwd, 'package.json')) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const script = serverScript(pkg);
  const devScript = script ? script.text : null;
  const config = viteConfigOf(cwd);
  const base = { config: null, bin: null, devScript, script };
  if (deps.vite || config || (devScript && /\bvite\b/.test(devScript))) return { ...base, kind: 'vite', config, bin: viteBinOf(cwd) };
  if (deps.next) return { ...base, kind: 'next' };
  const framework = pythonFramework(cwd);
  if (framework) return { ...base, kind: 'python', framework };
  const hasIndex = fs.existsSync(path.join(cwd, 'index.html'));
  if (hasIndex && !script) return { ...base, kind: 'static' };
  if (Object.keys(pkg).length || fs.existsSync(path.join(cwd, 'package.json')) || hasIndex) return { ...base, kind: 'other' };
  return { ...base, kind: 'none' };
}

// The exact command that starts the project's server ("npm run dev", "pnpm start"), or null.
function runCommand(cwd, found = detect(cwd)) {
  if (found.kind === 'python') return pythonCommand(cwd, found.framework);
  if (!found.script) return null;
  const pm = fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(cwd, 'yarn.lock')) ? 'yarn' :
    fs.existsSync(path.join(cwd, 'bun.lockb')) || fs.existsSync(path.join(cwd, 'bun.lock')) ? 'bun' : 'npm';
  if (found.script.name === 'start' && pm !== 'bun') return `${pm} start`;
  return pm === 'yarn' ? `yarn ${found.script.name}` : `${pm} run ${found.script.name}`;
}

// A path written into the wrapper config: esbuild (which bundles Vite configs) takes absolute
// paths with forward slashes on every platform.
function importPath(file) {
  return JSON.stringify(path.resolve(file).split(path.sep).join('/'));
}

// Ports a project's dev server probably uses, and why: the port it used last time ('last'), its
// dev script's --port, -p or PORT= ('script'), then its framework's default ('default').
// -> [{ port, from }]
function devCandidates(cwd, found = detect(cwd), stateDir = null) {
  const out = [];
  const last = stateDir ? lastTarget(stateDir, cwd) : null;
  if (last) out.push({ port: Number(new URL(last).port) || 80, from: 'last' });
  const script = found.devScript || '';
  for (const re of [/--port[= ](\d{2,5})/g, /(?:^|\s)-p[= ]?(\d{2,5})/g, /\bPORT=(\d{2,5})/g]) {
    for (const m of script.matchAll(re)) out.push({ port: Number(m[1]), from: 'script' });
  }
  // PORT=<n> in the project's .env files, as most frameworks read them.
  for (const name of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    const text = readText(path.join(cwd, name));
    const m = text && /^\s*PORT\s*=\s*["']?(\d{2,5})["']?\s*$/m.exec(text);
    if (m) out.push({ port: Number(m[1]), from: 'script' });
  }
  const pkg = readJson(path.join(cwd, 'package.json')) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (deps.next || deps.nuxt || deps.express || deps['@remix-run/dev']) out.push({ port: 3000, from: 'default' });
  if (deps.astro) out.push({ port: 4321, from: 'default' });
  if (deps['@angular/core']) out.push({ port: 4200, from: 'default' });
  if (found.kind === 'python' && PY_PORTS[found.framework]) out.push({ port: PY_PORTS[found.framework], from: 'default' });
  // Nothing known: the usual ports, then Python's (Flask 5000, Django and FastAPI 8000). Those two
  // count only when they serve a web page: on a Mac, AirPlay listens on 5000.
  if (!out.length) out.push({ port: 3000, from: 'default' }, { port: 8080, from: 'default' }, { port: 5000, from: 'default', html: true }, { port: 8000, from: 'default', html: true });
  // One entry per port, in first-seen order; the project's own script comes before the rest.
  const byPort = new Map();
  for (const c of out.filter((x) => Number.isInteger(x.port) && x.port > 0 && x.port < 65536)) {
    const had = byPort.get(c.port);
    if (!had) byPort.set(c.port, c);
    else if (c.from === 'script') had.from = 'script';
  }
  return [...byPort.values()];
}
function devPorts(cwd, found = detect(cwd), stateDir = null) {
  return devCandidates(cwd, found, stateDir).map((c) => c.port);
}

// What answers HTTP on <port> at 127.0.0.1, else at ::1 (a dev server started on localhost listens
// there on many computers): { ok, title, html, host } | { ok: false, title, error } (title: the
// page's <title> or ''; error: why the request failed other than nothing listening, e.g. EACCES).
// v6: false for EditLens's own port, which is on 127.0.0.1 only.
async function probe(port, timeoutMs = 700, { v6 = true } = {}) {
  const v4 = await probeAt('127.0.0.1', port, timeoutMs);
  if (v4.ok || v4.error || !v6) return v4;
  const at6 = await probeAt('::1', port, timeoutMs);
  return at6.ok ? at6 : v4;
}
function probeAt(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: timeoutMs, headers: { accept: 'text/html' } }, (res) => {
      let body = '';
      const done = () => {
        const m = /<title[^>]*>([^<]{0,200})<\/title>/i.exec(body);
        const html = /text\/html/i.test(String(res.headers['content-type'] || '')) && res.statusCode < 400;
        resolve({ ok: true, title: m ? m[1].trim() : '', html, host });
      };
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 65536) {
          res.destroy();
          done();
        }
      });
      res.on('end', done);
      res.on('error', done); // the status line arrived, so something answers, whatever the body does
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    // No IPv6 on this computer counts as nothing there.
    req.on('error', (err) => resolve({ ok: false, title: '', error: NOTHING_THERE.includes(err.code) || (host === '::1' && NO_V6.includes(err.code)) ? null : err.code || err.message }));
  });
}
const NO_V6 = ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'ENETUNREACH', 'EHOSTUNREACH'];
async function answers(port, timeoutMs = 700) {
  return (await probe(port, timeoutMs)).ok;
}

// Nothing listens there (or it closed the connection): the usual "not running".
const NOTHING_THERE = ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'];

// A remembered address counts as this project's for this long, while its page title stays the same.
const LAST_FRESH_MS = 12 * 3600000;

// This project's dev server when it is already running: { url, sure, title, from } or null.
// sure: it answered where this project's server was recently (same page title), or on its dev
// script's port. A framework's default port could belong to another project: not sure.
async function devServerOf(cwd, { skip = [], stateDir = null } = {}) {
  const last = stateDir ? lastTargetInfo(stateDir, cwd) : null;
  let unsure = null;
  for (const c of devCandidates(cwd, detect(cwd), stateDir)) {
    if (skip.includes(c.port)) continue;
    const p = await probe(c.port);
    if (!p.ok || (c.html && !p.html)) continue;
    let sure = c.from === 'script';
    if (c.from === 'last') sure = Date.now() - last.at < LAST_FRESH_MS && (!last.title || last.title === p.title);
    // A usual port: sure when the program listening there runs from this project.
    let from = c.from;
    if (!sure && ownsProject(await portOwner(c.port), cwd)) {
      sure = true;
      from = 'process';
    }
    const found = { url: `http://localhost:${c.port}`, sure, title: p.title, from };
    if (sure) return found;
    if (!unsure) unsure = found;
  }
  return unsure;
}

// The address of this project's dev server when it is certainly running, or null.
async function findDevServer(cwd, opts = {}) {
  const found = await devServerOf(cwd, opts);
  return found && found.sure ? found.url : null;
}

// Writes the wrapper config for this project into the state folder and returns its path. The
// project's config is imported as it is (object, function or promise) and EditLens is added to
// its plugins unless it is already there.
function writeViteWrapper(cwd, stateDir, { port } = {}) {
  const userConfig = viteConfigOf(cwd);
  const plugin = path.join(__dirname, '..', 'integrations', 'vite.mjs');
  const dir = path.join(stateDir, 'connect');
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 12);
  const file = path.join(dir, `vite.config.${id}.mjs`);
  const lines = [
    '// Written by EditLens (/editlens). Runs your own Vite config with EditLens added,',
    '// so nothing in your project changes. Safe to delete.',
    userConfig ? `import userConfig from ${importPath(userConfig)};` : 'const userConfig = {};',
    `import editlens from ${importPath(plugin)};`,
    '',
    'async function flat(list) {',
    '  const out = [];',
    '  for (const p of await list) {',
    '    const v = await p;',
    '    if (Array.isArray(v)) out.push(...(await flat(v)));',
    '    else if (v) out.push(v);',
    '  }',
    '  return out;',
    '}',
    '',
    'export default async (env) => {',
    "  const config = (typeof userConfig === 'function' ? await userConfig(env) : await userConfig) || {};",
    '  const plugins = await flat(config.plugins || []);',
    "  const has = plugins.some((p) => p && p.name === 'editlens');",
    `  return { ...config, root: config.root || ${importPath(cwd)}, plugins: has ? plugins : [...plugins, editlens({ root: ${importPath(cwd)}${port ? `, port: ${Number(port)}` : ''} })] };`,
    '};',
    '',
  ];
  // Written to a temporary file and renamed, so a running Vite never reads half a file.
  writeAtomic(file, lines.join('\n'));
  return file;
}

// Folders that never contain the app itself.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'tmp', 'temp']);

// The apps in a folder: the folder itself when it is one, otherwise the app folders directly
// inside it (e.g. Claude Code opened on a parent folder). -> [absolute folder]
function appsIn(cwd) {
  const dir = path.resolve(cwd);
  if (detect(dir).kind !== 'none') return [dir];
  // The home folder or a drive root contains everything: don't guess an app there.
  if (tooBroad(dir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(err.code)) return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .slice(0, 300)
    .map((e) => path.join(dir, e.name))
    .filter((d) => detect(d).kind !== 'none')
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 20);
}

// The folders connected most recently, newest first (so a list of apps starts with them).
function recentApps(stateDir) {
  const data = readJson(path.join(stateDir, 'recent-apps.json'));
  return data && Array.isArray(data.dirs) ? data.dirs.filter((d) => typeof d === 'string') : [];
}
// Read and written under a lock, so two sessions starting at the same time each keep their entry.
function rememberApp(stateDir, dir) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'recent-apps.json');
  withLock(file, () => {
    const dirs = [path.resolve(dir), ...recentApps(stateDir).filter((d) => dirKey(d) !== dirKey(dir))].slice(0, 20);
    writeAtomic(file, JSON.stringify({ dirs }));
  });
}
// The dev server address a project was connected to last (tried first next time).
// -> { url, at, title } or null. An entry from before 0.22.2 is a plain address (at 0: not recent).
function lastTargetInfo(stateDir, dir) {
  const data = readJson(path.join(stateDir, 'targets.json'));
  const all = data && data.targets && typeof data.targets === 'object' ? data.targets : null;
  // Saved under the folder's key; before 0.22.4, under its path as spelled.
  const own = (k) => (all && Object.prototype.hasOwnProperty.call(all, k) ? all[k] : null);
  const t = own(dirKey(dir)) || own(path.resolve(dir));
  const info = typeof t === 'string' ? { url: t, at: 0, title: '' } : t && typeof t === 'object' ? t : null;
  if (!info || typeof info.url !== 'string' || !/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(info.url)) return null;
  const at = Number(info.at);
  return { url: info.url, at: Number.isFinite(at) && at > 0 ? at : 0, title: typeof info.title === 'string' ? info.title.slice(0, 200) : '' };
}
function lastTarget(stateDir, dir) {
  const info = lastTargetInfo(stateDir, dir);
  return info ? info.url : null;
}
function rememberTarget(stateDir, dir, origin, { title = '' } = {}) {
  const file = path.join(stateDir, 'targets.json');
  fs.mkdirSync(stateDir, { recursive: true });
  withLock(file, () => {
    const data = readJson(file);
    const targets = { ...(data && data.targets && typeof data.targets === 'object' ? data.targets : {}) };
    delete targets[path.resolve(dir)];
    delete targets[dirKey(dir)];
    targets[dirKey(dir)] = { url: origin, at: Date.now(), title: String(title || '').slice(0, 200) };
    const keys = Object.keys(targets);
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete targets[k];
    writeAtomic(file, JSON.stringify({ targets }));
  });
}

// appsIn, the most recently connected first.
function appsByRecent(cwd, stateDir) {
  const recent = recentApps(stateDir).map(dirKey);
  const rank = (d) => {
    const i = recent.indexOf(dirKey(d));
    return i < 0 ? recent.length : i;
  };
  return appsIn(cwd).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// EditLens lines in the app's files; for a folder that contains apps, in each of them.
// -> [{ file, rel, line, text, marked }]
function findIntegrations(cwd) {
  const dir = path.resolve(cwd);
  if (detect(dir).kind !== 'none') return integrationsOf(dir, '');
  return appsIn(dir).flatMap((app) => integrationsOf(app, path.relative(dir, app)));
}

function integrationsOf(cwd, prefix) {
  const out = [];
  for (const name of CANDIDATES) {
    const rel = prefix ? path.join(prefix, name) : name;
    const file = path.join(cwd, name);
    const text = readText(file);
    if (!text || !INTEGRATION_MARK.test(text)) continue;
    const lines = text.split(/\r?\n/);
    let inBlock = false;
    lines.forEach((l, i) => {
      if (hasStart(l)) inBlock = true;
      const hit = INTEGRATION_MARK.test(l) && !hasStart(l) && !hasEnd(l);
      if (hit) out.push({ file, rel, line: i + 1, text: l.trim().slice(0, 300), marked: inBlock });
      if (hasEnd(l)) inBlock = false;
    });
  }
  return out;
}

// The text without its marked blocks (the marker lines included). -> { text, removed }
function removeMarked(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const kept = [];
  let inBlock = false;
  let removed = 0;
  let open = false;
  for (const l of lines) {
    if (!inBlock && hasStart(l)) {
      inBlock = true;
      open = true;
      removed++;
      continue;
    }
    if (inBlock) {
      removed++;
      if (hasEnd(l)) {
        inBlock = false;
        open = false;
      }
      continue;
    }
    kept.push(l);
  }
  // A start marker with no end: leave the file unchanged rather than cut it short.
  if (open) return { text, removed: 0, unclosed: true };
  return { text: kept.join(eol), removed };
}

module.exports = { SKIP_DIRS, pythonFramework, PY_NAMES, answers, probe, runCommand, lastTarget, lastTargetInfo, rememberTarget, devPorts, devCandidates, findDevServer, devServerOf, detect, viteConfigOf, viteBinOf, writeViteWrapper, findIntegrations, appsIn, appsByRecent, recentApps, rememberApp, removeMarked, START, END, CANDIDATES };
