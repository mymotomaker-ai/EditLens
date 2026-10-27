'use strict';
// Decides whether an edited file is frontend or backend code, and finds the HTTP routes a
// backend change affects so the page can tell whether it uses them.

const path = require('path');

const BACKEND_EXT = new Set(['.py', '.go', '.rb', '.java', '.kt', '.cs', '.php', '.rs', '.ex', '.exs', '.sql', '.prisma', '.graphql']);
const FRONTEND_EXT = new Set(['.html', '.htm', '.css', '.scss', '.sass', '.less', '.styl', '.jsx', '.tsx', '.vue', '.svelte', '.astro', '.mdx']);
const BACKEND_DIR = /(^|\/)(server|backend|api|routes?|controllers?|handlers?|models?|db|database|migrations|services|middlewares?|resolvers|prisma)(\/|$)/i;
const FRONTEND_DIR = /(^|\/)(components|pages|public|static|styles|views|layouts|assets|client|frontend|ui)(\/|$)/i;
const BACKEND_FILE = /(^|\/)(server|app|main|index)\.(m?js|ts|cjs)$/i;

// Next.js style file routes: app/api/x/route.ts -> /api/x, pages/api/x.ts -> /api/x
function fileRoute(rel) {
  const p = rel.replace(/\\/g, '/');
  let m = p.match(/(?:^|\/)app\/(api\/.*?)\/route\.(?:m?js|ts)x?$/);
  if (m) return '/' + m[1].replace(/\[([^\]]+)\]/g, ':$1');
  m = p.match(/(?:^|\/)pages\/(api\/.*?)\.(?:m?js|ts)x?$/);
  if (m) return '/' + m[1].replace(/\/index$/, '').replace(/\[([^\]]+)\]/g, ':$1');
  return null;
}

function classify(relFile, fileText) {
  const rel = String(relFile || '').replace(/\\/g, '/');
  const ext = path.extname(rel).toLowerCase();
  if (fileRoute(rel)) return 'backend';
  if (BACKEND_EXT.has(ext)) return 'backend';
  if (FRONTEND_EXT.has(ext)) return 'frontend';
  if (/\.(m?js|cjs|ts)$/.test(ext)) {
    if (BACKEND_DIR.test(rel)) return 'backend';
    if (FRONTEND_DIR.test(rel)) return 'frontend';
    // A JS file that creates an HTTP server or defines routes is backend code.
    if (typeof fileText === 'string' && /require\(['"](express|fastify|koa|http)['"]\)|from ['"](express|fastify|koa|hono|node:http|http)['"]|createServer\(|\b(app|router)\.(get|post|put|patch|delete)\(/.test(fileText)) return 'backend';
    if (BACKEND_FILE.test(rel) && !/(^|\/)src\//.test(rel)) return 'backend';
    return 'frontend';
  }
  return 'other';
}

const ROUTE_PATTERNS = [
  // Express, Fastify, Hono, Gin
  /\b(?:app|router|server|api|fastify|r|e|g)\.(?:get|post|put|patch|delete|all|route|use)\s*\(\s*['"`](\/[^'"`]*)['"`]/g,
  // Flask, FastAPI
  /@(?:app|router|bp|blueprint|api|\w+_router)\.(?:route|get|post|put|patch|delete|api_route)\(\s*['"](\/[^'"]*)['"]/g,
  /@(?:Get|Post|Put|Delete|Patch|Request)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?["'](\/[^"']*)/g, // Spring
  /\b(?:re_)?path\(\s*r?['"]\^?([\w\-/<>:]+)/g, // Django
  /HandleFunc\(\s*"(\/[^"]*)"/g, // Go net/http
  /\bpathname\s*===?\s*['"`](\/[^'"`]*)['"`]/g, // plain node http
  /['"`](\/api\/[\w\-/:{}<>.]*)['"`]/g, // any /api/... string
];

function routesIn(lines) {
  const out = [];
  for (const line of lines) {
    for (const re of ROUTE_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) out.push(m[1].startsWith('/') ? m[1] : '/' + m[1]);
    }
  }
  return out;
}

// Routes the change affects: routes on changed lines, plus the nearest route declared
// above each change (the handler that contains it).
function changedRoutes(relFile, fileText, hunks) {
  const routes = [];
  const fr = fileRoute(String(relFile || ''));
  if (fr) routes.push(fr);
  const lines = typeof fileText === 'string' ? fileText.split('\n') : [];
  for (const h of hunks) {
    routes.push(...routesIn(h.lines.filter((l) => l[0] === '+' || l[0] === '-').map((l) => l.slice(1))));
    let newNo = Number(h.newStart);
    if (!Number.isFinite(newNo)) continue;
    for (const l of h.lines) {
      if (l[0] === '+' || l[0] === '-') break;
      newNo++;
    }
    let handlerFound = false;
    for (let i = Math.min(newNo - 1, lines.length - 1); i >= 0 && i >= newNo - 60; i--) {
      const found = routesIn([lines[i]]);
      if (found.length) {
        routes.push(found[found.length - 1]);
        handlerFound = true;
        break;
      }
    }
    // Data edited outside a handler (e.g. `const menu = [...]`): routes on lines that use it.
    if (!handlerFound) {
      const name = enclosingDeclaration(lines, newNo - 1);
      if (name) {
        const re = new RegExp('\\b' + name + '\\b');
        routes.push(...routesIn(lines.filter((l) => re.test(l))));
      }
    }
  }
  return [...new Set(routes)].slice(0, 8);
}

// Name of the variable declared at or above `index` whose value spans the changed line.
function enclosingDeclaration(lines, index) {
  for (let i = Math.min(index, lines.length - 1); i >= 0 && i >= index - 200; i--) {
    const m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(lines[i] || '');
    if (m) return m[1];
    // Past the start of the declaration.
    if (i < index && /^\S/.test(lines[i] || '') && !/^[\]})]/.test(lines[i])) return null;
  }
  return null;
}

module.exports = { classify, changedRoutes, fileRoute };
