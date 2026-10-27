'use strict';
require('./isolate');
// Which page shows each file, read from the project: React Router elements, object routes with
// lazy imports, Next.js app/ and pages/ files, and everything a page component imports.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan, plainPath, importsOf } = require('../lib/routes');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-routes-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
function project(name, files) {
  const dir = path.join(base, name);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('plainPath keeps openable paths only', () => {
  assert.strictEqual(plainPath('reports'), '/reports');
  assert.strictEqual(plainPath('/a//b/'), '/a/b');
  assert.strictEqual(plainPath('/users/:id'), null);
  assert.strictEqual(plainPath('*'), null);
  assert.strictEqual(plainPath(''), null);
  assert.strictEqual(plainPath(undefined), null);
});

test('importsOf reads default, named, lazy and side-effect imports', () => {
  const { names, specs } = importsOf("import A, { B as C } from './a';\nimport './x.css';\nconst L = lazy(() => import('./l'));");
  assert.strictEqual(names.get('A'), './a');
  assert.strictEqual(names.get('C'), './a');
  assert.strictEqual(names.get('L'), './l');
  assert.ok(specs.includes('./x.css'));
});

test('React Router: JSX routes, index route, object routes, and imported components', () => {
  const dir = project('rr', {
    'package.json': '{"dependencies":{"react-router-dom":"6"}}',
    'src/App.jsx': [
      "import Home from './pages/Home';",
      "import { Reports } from './pages/Reports.jsx';",
      "const Settings = lazy(() => import('./pages/Settings'));",
      'export default () => <Routes>',
      '  <Route index element={<Home />} />',
      '  <Route path="reports" element={<Reports />} />',
      "  <Route path='/users/:id' element={<Home />} />",
      '</Routes>;',
      "export const more = [{ path: '/settings', element: <Settings /> }];",
    ].join('\n'),
    'src/pages/Home.jsx': 'export default () => null;',
    'src/pages/Reports.jsx': "import Chart from '../components/Chart';\nimport './reports.css';\nexport const Reports = () => <Chart />;",
    'src/pages/reports.css': '.r{}',
    'src/pages/Settings.jsx': 'export default () => null;',
    'src/components/Chart.jsx': "import { fmt } from '@/lib/fmt';\nexport default () => null;",
    'src/lib/fmt.js': 'export const fmt = 1;',
    'node_modules/x/App.jsx': "<Route path='/nope' element={<Nope />} />",
  });
  const out = scan(dir);
  const paths = out.routes.map((r) => r.path + ' ' + r.file).sort();
  assert.deepStrictEqual(paths, ['/ src/pages/Home.jsx', '/reports src/pages/Reports.jsx', '/settings src/pages/Settings.jsx']);
  assert.deepStrictEqual(out.files['src/components/Chart.jsx'], ['/reports']);
  assert.deepStrictEqual(out.files['src/pages/reports.css'], ['/reports']);
  assert.deepStrictEqual(out.files['src/lib/fmt.js'], ['/reports']);
  assert.strictEqual(out.files['src/App.jsx'], undefined);
});

test('Next.js app/ and pages/ routes, only in a Next project', () => {
  const dir = project('next', {
    'package.json': '{"dependencies":{"next":"15"}}',
    'app/page.tsx': "import Hero from '../components/Hero';\nexport default () => <Hero />;",
    'app/(shop)/cart/page.tsx': 'export default () => null;',
    'app/blog/[slug]/page.tsx': 'export default () => null;',
    'pages/about.jsx': 'export default () => null;',
    'pages/api/x.js': 'export default () => null;',
    'components/Hero.tsx': 'export default () => null;',
  });
  const out = scan(dir);
  assert.deepStrictEqual(out.routes.map((r) => r.path).sort(), ['/', '/about', '/cart']);
  assert.deepStrictEqual(out.files['components/Hero.tsx'], ['/']);
  const vite = project('vite', { 'package.json': '{}', 'src/pages/About.jsx': 'export default () => null;' });
  assert.deepStrictEqual(scan(vite).routes, []);
});

test('a broken package.json or unreadable project does not throw', () => {
  const dir = project('broken', { 'package.json': '{nope', 'src/a.js': "import b from './b';" });
  assert.deepStrictEqual(scan(dir).routes, []);
  assert.deepStrictEqual(scan(path.join(base, 'missing')).routes, []);
});
