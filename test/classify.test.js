'use strict';
require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, changedRoutes, fileRoute } = require('../lib/classify');
const { diffText } = require('../lib/diff');

test('classify by extension and folder', () => {
  assert.equal(classify('src/App.jsx'), 'frontend');
  assert.equal(classify('public/styles.css'), 'frontend');
  assert.equal(classify('api/main.py'), 'backend');
  assert.equal(classify('server/routes/menu.js'), 'backend');
  assert.equal(classify('src/utils/format.ts'), 'frontend');
  assert.equal(classify('server.js', "const http = require('http');"), 'backend');
  assert.equal(classify('app/api/menu/route.ts'), 'backend');
  assert.equal(classify('README.md'), 'other');
});

test('Next.js file routes', () => {
  assert.equal(fileRoute('app/api/menu/[id]/route.ts'), '/api/menu/:id');
  assert.equal(fileRoute('pages/api/users/index.ts'), '/api/users');
  assert.equal(fileRoute('src/App.jsx'), null);
});

test('changedRoutes finds the enclosing Express handler', () => {
  const before = "app.get('/api/menu', (req, res) => {\n  res.json(menu);\n});\n";
  const after = "app.get('/api/menu', (req, res) => {\n  res.json(menu.filter(Boolean));\n});\n";
  assert.deepEqual(changedRoutes('server.js', after, diffText(before, after)), ['/api/menu']);
});

test('changedRoutes: Flask decorator and plain node pathname', () => {
  const py = '@app.route("/api/items/<int:id>")\ndef item(id):\n    return items[id]\n';
  const hunks = [{ oldStart: 3, newStart: 3, lines: ['-    return items[id]', '+    return items.get(id)'] }];
  assert.deepEqual(changedRoutes('api.py', py, hunks), ['/api/items/<int:id>']);
  const node = "if (url.pathname === '/api/menu') return sendJson(res, menu);\nconst menu = [\n  { name: 'Mocha', price: 4.5 },\n];\n";
  const h2 = [{ oldStart: 3, newStart: 3, lines: ["+  { name: 'Mocha', price: 4.5 },"] }];
  assert.deepEqual(changedRoutes('server.js', node, h2), ['/api/menu']);
});

test('changedRoutes: data declared above the handler links to routes that use it', () => {
  const file = "const menu = [\n  { name: 'Espresso', price: 3 },\n  { name: 'Mocha', price: 4.5 },\n];\n\nfunction route(url, res) {\n  if (url.pathname === '/api/menu') return sendJson(res, menu);\n}\n";
  const hunks = [{ oldStart: 3, newStart: 3, lines: ["+  { name: 'Mocha', price: 4.5 },"] }];
  assert.deepEqual(changedRoutes('server.js', file, hunks), ['/api/menu']);
});
