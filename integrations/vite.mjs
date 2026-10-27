// Vite plugin: injects the EditLens client into every page during `vite dev`.
//
//   import editlens from 'editlens/integrations/vite.mjs'
//   export default defineConfig({ plugins: [editlens()] })
//
// Options: { port = 4317, root = Vite's project root, panel, settle, source = true, nonce }
//
// nonce: added to the script tag for a strict Content-Security-Policy (Vite's html.cspNonce does
// the same for every tag).
//
// source: tags JSX host elements with data-editlens-src="file:line:col" using the project's own
// @babel/core (dev only; skipped if Babel is missing).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const SOURCE_ATTR = 'data-editlens-src';
const JSX_FILE = /\.[jt]sx(\?.*)?$/;
// The codes Babel gives an error in the file's own code (its parser), not a failure of Babel.
const PARSE_ERRORS = new Set(['BABEL_PARSE_ERROR', 'BABEL_PARSER_SYNTAX_ERROR', 'BABEL_PARSER_SOURCETYPE_MODULE_REQUIRED']);

// Digits only, as lib/config.js reads it ("1e3" and "0x10" don't count); otherwise 4317.
function portFrom(value) {
  const raw = value ?? process.env.EDITLENS_PORT ?? 4317;
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  const n = /^\d{1,5}$/.test(s) ? Number(s) : NaN;
  return n > 0 && n < 65536 ? n : 4317;
}

// The project's @babel/core, or null. Source tagging is optional, so a Babel that won't load
// (half installed, or an export it refuses) never stops Vite: it warns once and continues without.
function loadBabel(root) {
  const from = [path.join(root, 'package.json'), path.join(process.cwd(), 'package.json')];
  for (const f of from) {
    try {
      return createRequire(f)('@babel/core');
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      if (err.code !== 'MODULE_NOT_FOUND') {
        console.warn(`[EditLens] could not load @babel/core (${err.code || err.message}); selections on the page will be less exact.`);
        return null;
      }
    }
  }
  return null;
}

// Babel plugin: adds the attribute to host elements (<div>, <button>), never to components
// (<Card>, <motion.div>), whose props it could change.
function tagSource(babel, rel) {
  const t = babel.types;
  return {
    name: 'editlens-source',
    visitor: {
      JSXOpeningElement(p) {
        const name = p.node.name;
        if (!t.isJSXIdentifier(name) || !/^[a-z]/.test(name.name) || !p.node.loc) return;
        if (p.node.attributes.some((a) => t.isJSXAttribute(a) && a.name && a.name.name === SOURCE_ATTR)) return;
        const { line, column } = p.node.loc.start;
        p.node.attributes.push(t.jsxAttribute(t.jsxIdentifier(SOURCE_ATTR), t.stringLiteral(`${rel}:${line}:${column + 1}`)));
      },
    },
  };
}

export default function editlens(options = {}) {
  const port = portFrom(options.port);
  let root = options.root;
  let babel = null;
  let warned = false;
  return {
    name: 'editlens',
    apply: 'serve',
    enforce: 'pre',
    configResolved(config) {
      root ??= config.root;
      if (options.source !== false) babel = loadBabel(config.root);
    },
    transformIndexHtml() {
      const attrs = { src: `http://127.0.0.1:${port}/live.js`, 'data-root': root };
      if (options.panel) attrs['data-panel'] = options.panel;
      if (options.settle !== undefined) attrs['data-settle'] = String(options.settle);
      if (typeof options.nonce === 'string' && options.nonce) attrs.nonce = options.nonce;
      // In <head>, before app code, so the client sees which API calls fill the page.
      return [{ tag: 'script', attrs, injectTo: 'head' }];
    },
    // First of all transforms, before @vitejs/plugin-react adds its hot-reload preamble, which
    // would shift every line number.
    transform: { order: 'pre', handler: tagFile },
  };

  function tagFile(code, id) {
    if (!babel || !JSX_FILE.test(id) || id.includes('/node_modules/') || id.startsWith('\0')) return null;
    const file = id.replace(/\?.*$/, '');
    if (!fs.existsSync(file)) return null;
    const rel = path.relative(root, file).replace(/\\/g, '/');
    try {
      const out = babel.transformSync(code, {
        filename: file,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        retainLines: true,
        parserOpts: { plugins: ['jsx', ...(/\.tsx$/.test(file) ? ['typescript'] : [])] },
        plugins: [tagSource(babel, rel)],
      });
      return out && out.code ? { code: out.code, map: out.map } : null;
    } catch (err) {
      // A syntax error from Babel's parser: leave the file alone so Vite reports it the usual way.
      // Any other error (a plugin or the code generator failing) is shown.
      if (!PARSE_ERRORS.has(err?.code)) {
        // The first failure in full; later ones as one line each, so all are shown.
        this.warn(warned ? `EditLens: could not add them to ${rel} either (${err.message})` : `EditLens: could not add source line numbers to ${rel}: ${err.message}`);
        warned = true;
      }
      return null;
    }
  }
}
