'use strict';
// Maps source files to the app page that shows them (React/Vue Router, Next.js files, plus each
// page's import graph), including pages nobody has opened yet. Heuristic, no dependencies.

const fs = require('fs');
const path = require('path');
const { normalize, tooBroad } = require('./paths');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'coverage', '.turbo', '.cache', '.vite', 'vendor']);
const CODE = /\.(jsx?|tsx?|mjs|cjs|vue|svelte)$/i;
const RESOLVE_EXT = ['', '.jsx', '.tsx', '.js', '.ts', '.mjs', '.vue', '.svelte', '.css', '.scss', '.sass', '.less'];
const MAX_FILES = 4000;
const MAX_BYTES = 400 * 1024;
const MAX_DEPTH = 6;
const CACHE_MS = 15000;

const CACHE_MAX = 50;
const cache = new Map(); // normalized root -> { at, value }

function walk(root) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < MAX_FILES) {
    const rel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'ENOTDIR' || err.code === 'ELOOP' || err.code === 'ENAMETOOLONG')) continue;
      throw err;
    }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(r);
      } else if (e.isFile()) {
        out.push(r);
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

function read(root, rel) {
  try {
    const full = path.join(root, rel);
    if (fs.statSync(full).size > MAX_BYTES) return '';
    return fs.readFileSync(full, 'utf8');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EISDIR' || err.code === 'ELOOP' || err.code === 'ENAMETOOLONG')) return '';
    throw err;
  }
}

function hasNext(root) {
  const text = read(root, 'package.json');
  if (!text) return false;
  try {
    const pkg = JSON.parse(text);
    return Boolean((pkg.dependencies && pkg.dependencies.next) || (pkg.devDependencies && pkg.devDependencies.next));
  } catch (err) {
    if (err instanceof SyntaxError) return false;
    throw err;
  }
}

// A route path someone can open as is: no :params, *, [segments] or regex.
function plainPath(p) {
  if (typeof p !== 'string') return null;
  let s = p.trim();
  if (!s || /[:*[\]()?]/.test(s)) return null;
  if (s[0] !== '/') s = '/' + s;
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/$/, '');
  return s;
}

// Next.js: app/**/page.* and pages/**/*.
function nextRoutes(files) {
  const out = [];
  for (const rel of files) {
    let m = /^(?:src\/)?app\/(?:(.*)\/)?page\.(?:jsx?|tsx?|mdx)$/.exec(rel);
    if (m) {
      const segs = (m[1] || '').split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'));
      const p = plainPath('/' + segs.join('/'));
      if (p) out.push({ path: p, file: rel });
      continue;
    }
    m = /^(?:src\/)?pages\/(.*)\.(?:jsx?|tsx?|mdx)$/.exec(rel);
    if (m && !/^(api\/|_app$|_document$|_error$|404$|500$)/.test(m[1])) {
      const p = plainPath('/' + m[1].replace(/(^|\/)index$/, ''));
      if (p) out.push({ path: p, file: rel });
    }
  }
  return out;
}

// import X from './x', import { X } from './x', import './x.css', const X = lazy(() => import('./x'))
function importsOf(text) {
  const names = new Map(); // local name -> spec
  const specs = [];
  const re = /import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}\s*)?(?:\*\s+as\s+([\w$]+)\s*)?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|(?:const|let|var)\s+([\w$]+)\s*=\s*(?:React\.)?(?:lazy|defineAsyncComponent)\(\s*(?:async\s*)?\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    const spec = m[4] || m[5] || m[7] || m[8] || m[9];
    if (!spec) continue;
    specs.push(spec);
    if (m[1]) names.set(m[1], spec);
    if (m[3]) names.set(m[3], spec);
    if (m[2]) {
      m[2].split(',').forEach((part) => {
        const local = part.trim().split(/\s+as\s+/).pop();
        if (/^[\w$]+$/.test(local)) names.set(local, spec);
      });
    }
    if (m[6]) names.set(m[6], spec);
  }
  return { names, specs };
}

function resolver(root, fileSet) {
  return function resolve(fromRel, spec) {
    let base;
    if (spec.startsWith('.')) base = path.posix.join(path.posix.dirname(fromRel), spec);
    else if (spec.startsWith('@/') || spec.startsWith('~/')) base = 'src/' + spec.slice(2);
    else if (spec.startsWith('/')) base = spec.slice(1);
    else return null; // a package
    base = path.posix.normalize(base).replace(/^\.\//, '');
    for (const ext of RESOLVE_EXT) if (fileSet.has(base + ext)) return base + ext;
    for (const ext of RESOLVE_EXT.slice(1)) if (fileSet.has(base + '/index' + ext)) return base + '/index' + ext;
    return null;
  };
}

// <Route path="/x" element={<X />} />, { path: '/x', element: <X />, Component: X, component: X }
function declaredRoutes(rel, text, names, resolve) {
  const out = [];
  const add = (p, name) => {
    const route = plainPath(p);
    const spec = name && names.get(name);
    const file = spec ? resolve(rel, spec) : null;
    if (route && file) out.push({ path: route, file });
  };
  let m;
  const tag = /<Route\b([^>]*?)\/?>/g;
  while ((m = tag.exec(text))) {
    const attrs = m[1];
    const p = /\bpath\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*['"`]([^'"`]*)['"`]\s*\})/.exec(attrs);
    const index = /\bindex\b/.test(attrs);
    const comp = /\b(?:element\s*=\s*\{\s*<\s*([A-Z][\w$.]*)|[Cc]omponent\s*=\s*\{\s*([A-Z][\w$]*))/.exec(attrs);
    if ((p || index) && comp) add(p ? p[1] || p[2] || p[3] || '' : '/', comp[1] || comp[2]);
  }
  const obj = /\bpath\s*:\s*['"`]([^'"`]*)['"`][^{}]{0,300}?\b(?:element\s*:\s*<\s*([A-Z][\w$]*)|[Cc]omponent\s*:\s*([A-Z][\w$]*))/g;
  while ((m = obj.exec(text))) add(m[1], m[2] || m[3]);
  const objRev = /\b(?:element\s*:\s*<\s*([A-Z][\w$]*)[^{}]{0,120}?|[Cc]omponent\s*:\s*([A-Z][\w$]*)\s*,[^{}]{0,120}?)\bpath\s*:\s*['"`]([^'"`]*)['"`]/g;
  while ((m = objRev.exec(text))) add(m[3], m[1] || m[2]);
  return out;
}

function scan(root) {
  const files = walk(root);
  const fileSet = new Set(files);
  const resolve = resolver(root, fileSet);
  const graph = new Map(); // rel -> [rel]
  const routes = [];
  const seen = new Set();
  const push = (r) => {
    const k = r.path + ' ' + r.file;
    if (!seen.has(k)) {
      seen.add(k);
      routes.push(r);
    }
  };
  if (hasNext(root)) nextRoutes(files).forEach(push);
  for (const rel of files) {
    if (!CODE.test(rel)) continue;
    const text = read(root, rel);
    if (!text) continue;
    const { names, specs } = importsOf(text);
    graph.set(rel, [...new Set(specs.map((s) => resolve(rel, s)).filter(Boolean))]);
    if (/\bpath\s*[=:]/.test(text)) declaredRoutes(rel, text, names, resolve).forEach(push);
  }
  // Each page component and everything it imports is shown on that page.
  const byFile = {};
  for (const r of routes) {
    const depth = new Map([[r.file, 0]]);
    const queue = [r.file];
    while (queue.length) {
      const f = queue.shift();
      (byFile[f] = byFile[f] || []).includes(r.path) || byFile[f].push(r.path);
      const d = depth.get(f);
      if (d >= MAX_DEPTH) continue;
      for (const next of graph.get(f) || []) {
        if (!depth.has(next)) {
          depth.set(next, d + 1);
          queue.push(next);
        }
      }
    }
  }
  return { routes, files: byFile };
}

function routesFor(root) {
  if (!root || tooBroad(root)) return { routes: [], files: {} };
  const key = normalize(root);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = scan(root);
  cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return value;
}

module.exports = { routesFor, scan, plainPath, importsOf, nextRoutes };
