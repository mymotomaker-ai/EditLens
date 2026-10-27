'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4326';
// /editlens without changing project files: the Vite wrapper config, the proxy for
// other dev servers (pages get the script, websockets pass through), finding and removing
// marked EditLens lines, and connections stopping with the session that made them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { detect, writeViteWrapper, findIntegrations, removeMarked, runCommand, findDevServer, devServerOf, rememberTarget, lastTarget, lastTargetInfo } = require('../lib/connect');
const { startProxy, inject, allowLive } = require('../server/proxy');
const { Connector, localUrl, steadyPort } = require('../server/connector');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-connect-'));
const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  }).on('error', reject);
});

test('what kind of dev server a project has', () => {
  const dir = tmp();
  try {
    assert.strictEqual(detect(dir).kind, 'none');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '15' }, scripts: { dev: 'next dev' } }));
    assert.deepStrictEqual([detect(dir).kind, detect(dir).devScript], ['next', 'next dev']);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { vite: '6' } }));
    fs.writeFileSync(path.join(dir, 'vite.config.ts'), 'export default {}');
    const v = detect(dir);
    assert.strictEqual(v.kind, 'vite');
    assert.strictEqual(v.config, path.join(dir, 'vite.config.ts'));
    assert.strictEqual(v.bin, null, 'not installed yet');
    fs.writeFileSync(path.join(dir, 'package.json'), '{broken');
    assert.strictEqual(detect(dir).kind, 'vite', 'a broken package.json is skipped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Vite wrapper imports the project config and adds EditLens once, outside it', () => {
  const dir = tmp();
  const state = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'vite.config.js'), 'export default {}');
    const file = writeViteWrapper(dir, state, { port: 4400 });
    assert.ok(file.startsWith(path.join(state, 'connect')), file);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes(`import userConfig from ${JSON.stringify(path.join(dir, 'vite.config.js').split(path.sep).join('/'))}`));
    assert.match(text, /integrations\/vite\.mjs"/);
    assert.match(text, /p\.name === 'editlens'/, 'not added twice');
    assert.match(text, /port: 4400/);
    assert.deepStrictEqual(fs.readdirSync(dir), ['vite.config.js'], 'nothing written in the project');
    assert.strictEqual(writeViteWrapper(dir, state), file, 'one file per project');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test('EditLens lines in project files, and removing the marked ones', () => {
  const dir = tmp();
  try {
    const cfg = [
      "import react from '@vitejs/plugin-react';",
      '// editlens:start',
      "import editlens from 'editlens/integrations/vite.mjs';",
      '// editlens:end',
      'export default {',
      '  plugins: [',
      '    react(),',
      '    // editlens:start',
      '    editlens(),',
      '    // editlens:end',
      '  ],',
      '};',
    ].join('\r\n');
    fs.writeFileSync(path.join(dir, 'vite.config.js'), cfg);
    fs.writeFileSync(path.join(dir, 'index.html'), '<script src="http://127.0.0.1:4317/live.js"></script>');
    const found = findIntegrations(dir);
    assert.deepStrictEqual(found.map((f) => [f.rel, f.line, f.marked]), [['vite.config.js', 3, true], ['vite.config.js', 9, true], ['index.html', 1, false]]);
    const out = removeMarked(cfg);
    assert.strictEqual(out.removed, 6);
    assert.strictEqual(out.text, "import react from '@vitejs/plugin-react';\r\nexport default {\r\n  plugins: [\r\n    react(),\r\n  ],\r\n};", 'line endings kept');
    const open = removeMarked('a\n// editlens:start\nb\n');
    assert.deepStrictEqual([open.removed, open.unclosed, open.text], [0, true, 'a\n// editlens:start\nb\n'], 'an unclosed block is not changed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inject: first in <head>, once, and not into a page that already loads it', () => {
  const tag = '<script src="http://127.0.0.1:4317/live.js"></script>';
  const src = '127.0.0.1:4317/live.js';
  assert.strictEqual(inject('<html><head lang="en"><title>x</title></head></html>', tag, src), `<html><head lang="en">${tag}<title>x</title></head></html>`);
  assert.strictEqual(inject('<body>hi</body>', tag, src), `${tag}<body>hi</body>`);
  assert.strictEqual(inject('{"json":true}', tag, src), '{"json":true}');
  const already = `<head><script src="http://${src}"></script></head>`;
  assert.strictEqual(inject(already, tag, src), already);
});

test('the proxy adds the script to pages, passes the rest and websockets through, keeps redirects on itself', async () => {
  const dev = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': '40', 'content-security-policy': "script-src 'self'" });
      return res.end('<html><head></head><body>app</body></html>'.slice(0, 40));
    }
    if (req.url === '/old') {
      res.writeHead(302, { location: `http://127.0.0.1:${dev.address().port}/new` });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/javascript' });
    return res.end('console.log(1)');
  });
  dev.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write('echo:' + d.toString()));
  });
  await new Promise((r) => dev.listen(0, '127.0.0.1', r));
  const p = await startProxy({ target: `http://127.0.0.1:${dev.address().port}`, livePort: 4317, root: '/app' });
  try {
    const page = await get(p.url);
    assert.match(page.body, /^<html><head><script src="http:\/\/127\.0\.0\.1:4317\/live\.js" data-editlens-proxy="1" data-root="\/app"><\/script><\/head>/);
    assert.strictEqual(Number(page.headers['content-length']), Buffer.byteLength(page.body));
    assert.strictEqual(page.headers['content-security-policy'], "script-src 'self' http://127.0.0.1:4317", 'the page\'s policy is kept, with the live server added');
    // DNS rebinding: a website's name pointed at 127.0.0.1 gets nothing through the proxy.
    const rebound = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: p.port, path: '/', headers: { host: `evil.example:${p.port}` } }, (r) => {
      r.resume();
      resolve(r.statusCode);
    }));
    assert.strictEqual(rebound, 403);
    assert.strictEqual((await get(p.url + 'main.js')).body, 'console.log(1)');
    assert.strictEqual((await get(p.url + 'old')).headers.location, `http://127.0.0.1:${p.port}/new`);
    const echo = await new Promise((resolve, reject) => {
      const s = net.connect(p.port, '127.0.0.1', () => s.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
      let got = '';
      s.on('data', (d) => {
        got += d.toString();
        if (got.includes('\r\n\r\n') && !got.includes('echo:')) s.write('ping');
        if (got.includes('echo:ping')) {
          s.destroy();
          resolve(got);
        }
      });
      s.on('error', reject);
    });
    assert.match(echo, /^HTTP\/1\.1 101/);
  } finally {
    await p.close();
    dev.close();
    dev.closeAllConnections();
  }
});

test('connections: a proxy for a running dev server, stopped with the session that made it', async () => {
  const dev = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html><head></head></html>');
  });
  await new Promise((r) => dev.listen(0, '127.0.0.1', r));
  const dir = tmp();
  const events = [];
  const c = new Connector({ stateDir: dir, livePort: 4317, emit: (e) => events.push(e) });
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '15' } }));
    assert.strictEqual((await c.connect({ cwd: dir })).error, 'needs-url');
    assert.match((await c.connect({ cwd: dir, target: 'http://example.com' })).error, /localhost/);
    assert.match((await c.connect({ cwd: dir, target: 'http://[bad' })).error, /not an address/);
    const out = await c.connect({ cwd: dir, target: `localhost:${dev.address().port}`, sessionId: 's1' });
    assert.ok(out.ok && out.kind === 'proxy', JSON.stringify(out));
    assert.match((await get(out.url)).body, /live\.js/);
    assert.ok((await c.connect({ cwd: dir })).already, 'connect again: the same one');
    assert.strictEqual(await c.sessionEnded('other'), 0);
    assert.strictEqual(await c.sessionEnded('s1'), 1);
    assert.deepStrictEqual(c.list(), []);
    assert.ok(events.some((e) => e.type === 'connect' && e.state === 'stopped'));
    await assert.rejects(get(out.url), 'the proxy is closed');
  } finally {
    await c.stopAll();
    dev.close();
    dev.closeAllConnections();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a plain site and the command that starts a dev server', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Hi</h1>');
    assert.strictEqual(detect(dir).kind, 'static', 'an index.html and nothing that starts a server');
    assert.strictEqual(runCommand(dir), null);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
    assert.strictEqual(detect(dir).kind, 'static', 'a package.json without a server script');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }));
    assert.deepStrictEqual([detect(dir).kind, runCommand(dir)], ['other', 'npm start']);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'nodemon app.js', start: 'node app.js' } }));
    assert.strictEqual(runCommand(dir), 'npm run dev');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    assert.strictEqual(runCommand(dir), 'pnpm run dev');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a plain site is served from its folder: pages get the script, hidden files and the outside never', async () => {
  const dir = tmp();
  const site = path.join(dir, 'site');
  fs.mkdirSync(path.join(site, 'about'), { recursive: true });
  fs.mkdirSync(path.join(site, '.git'));
  fs.writeFileSync(path.join(site, 'index.html'), '<html><head><title>Hi</title></head><body>Home</body></html>');
  fs.writeFileSync(path.join(site, 'about', 'index.html'), '<html><head></head><body>About</body></html>');
  fs.writeFileSync(path.join(site, 'style.css'), 'body{color:red}');
  fs.writeFileSync(path.join(site, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(site, '.git', 'config'), '[core]');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'no');
  const c = new Connector({ stateDir: dir, livePort: 4317 });
  try {
    const out = await c.connect({ cwd: site });
    assert.ok(out.ok && out.kind === 'static' && out.target === null, JSON.stringify(out));
    const home = await get(out.url);
    assert.strictEqual(home.status, 200);
    assert.match(home.body, /<head><script src="http:\/\/127\.0\.0\.1:4317\/live\.js"[^>]*data-root=/);
    assert.strictEqual(home.headers['cache-control'], 'no-store');
    assert.strictEqual((await get(out.url + 'style.css')).headers['content-type'], 'text/css; charset=utf-8');
    const about = await get(out.url + 'about');
    assert.deepStrictEqual([about.status, about.headers.location], [301, '/about/']);
    assert.match((await get(out.url + 'about/')).body, /About/);
    for (const bad of ['.env', '.git/config', '..%2Foutside.txt', '%2e%2e/outside.txt', 'nope.html']) {
      assert.strictEqual((await get(out.url + bad)).status, 404, bad);
    }
    const rebound = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: new URL(out.url).port, path: '/', headers: { host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }));
    assert.strictEqual(rebound, 403, 'only localhost names');
  } finally {
    await c.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dev server that stopped: the folder is served instead, or the command to start it is given', async () => {
  const dir = tmp();
  const site = path.join(dir, 'site');
  const app = path.join(dir, 'app');
  fs.mkdirSync(site);
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(site, 'index.html'), '<html><head></head><body>From the folder</body></html>');
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  const dead = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  const c = new Connector({ stateDir: dir, livePort: 4317, log: () => {} });
  try {
    const out = await c.connect({ cwd: site, target: `http://localhost:${dead}` });
    assert.ok(out.ok && out.fallback, JSON.stringify(out));
    assert.match((await get(out.url)).body, /From the folder/);
    const none = await c.connect({ cwd: app, target: `http://localhost:${dead}` });
    assert.deepStrictEqual([none.error, none.command], ['nothing-answers', 'npm run dev']);
    assert.strictEqual((await c.connect({ cwd: app })).command, 'npm run dev');
    // Later the site's server starts again: the page gets it again.
    const live = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<html><head></head><body>From the server</body></html>');
    });
    await new Promise((r) => live.listen(dead, '127.0.0.1', r));
    try {
      assert.match((await get(out.url)).body, /From the server/);
    } finally {
      live.close();
      live.closeAllConnections();
    }
  } finally {
    await c.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the dev server address that worked is tried first next time', async () => {
  const dir = tmp();
  const app = path.join(dir, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  const dev = http.createServer((req, res) => res.end('ok'));
  await new Promise((r) => dev.listen(0, '127.0.0.1', r));
  try {
    const origin = `http://127.0.0.1:${dev.address().port}`;
    assert.strictEqual(await findDevServer(app, { stateDir: dir }), null, 'an unusual port is not guessed');
    rememberTarget(dir, app, origin);
    assert.strictEqual(lastTarget(dir, app), origin);
    assert.strictEqual(await findDevServer(app, { stateDir: dir }), `http://localhost:${dev.address().port}`);
    fs.writeFileSync(path.join(dir, 'targets.json'), '{broken');
    assert.strictEqual(lastTarget(dir, app), null);
  } finally {
    dev.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a remembered or usual port is used only when it is surely this project\'s server', async () => {
  const dir = tmp();
  const app = path.join(dir, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  let title = 'App A';
  const dev = http.createServer((req, res) => res.end(`<html><head><title>${title}</title></head></html>`));
  await new Promise((r) => dev.listen(0, '127.0.0.1', r));
  try {
    const port = dev.address().port;
    const origin = `http://127.0.0.1:${port}`;
    rememberTarget(dir, app, origin, { title: 'App A' });
    assert.deepStrictEqual(await devServerOf(app, { stateDir: dir }), { url: `http://localhost:${port}`, sure: true, title: 'App A', from: 'last' });
    // Another project's server now answers there (another title): found, but not taken.
    title = 'App B';
    assert.strictEqual((await devServerOf(app, { stateDir: dir })).sure, false);
    assert.strictEqual(await findDevServer(app, { stateDir: dir }), null);
    // An address remembered long ago is not taken either.
    title = 'App A';
    const file = path.join(dir, 'targets.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.targets[path.resolve(app)].at = Date.now() - 13 * 3600000;
    fs.writeFileSync(file, JSON.stringify(data));
    assert.strictEqual(await findDevServer(app, { stateDir: dir }), null);
    // Nor an address saved by an older version (no time), nor a bad time.
    fs.writeFileSync(file, JSON.stringify({ targets: { [path.resolve(app)]: origin } }));
    assert.strictEqual(lastTarget(dir, app), origin);
    assert.strictEqual(await findDevServer(app, { stateDir: dir }), null);
    fs.writeFileSync(file, JSON.stringify({ targets: { [path.resolve(app)]: { url: origin, at: 'soon', title: 'App A' } } }));
    assert.strictEqual(lastTargetInfo(dir, app).at, 0);
    assert.strictEqual(await findDevServer(app, { stateDir: dir }), null);
    // The project's own dev script names the port: that one is taken.
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ scripts: { dev: `node server.js --port ${port}` } }));
    assert.strictEqual(await findDevServer(app, { stateDir: dir }), `http://localhost:${port}`);
  } finally {
    dev.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Vite\'s address from its output', () => {
  assert.strictEqual(localUrl('\u001b[32m  ➜  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5174\u001b[22m/\u001b[39m\n'), 'http://localhost:5174/');
  assert.strictEqual(localUrl('ready in 300 ms'), null);
});

test('a page\'s security policy keeps everything but gains what the EditLens script needs', () => {
  const live = 'http://127.0.0.1:4317';
  assert.strictEqual(allowLive("default-src 'self'; frame-ancestors 'none'", live),
    "default-src 'self'; frame-ancestors 'none'; script-src 'self' http://127.0.0.1:4317; connect-src 'self' http://127.0.0.1:4317; style-src 'self' 'unsafe-inline'");
  assert.strictEqual(allowLive("img-src *", live), 'img-src *', 'nothing limits scripts: unchanged');
  assert.strictEqual(allowLive("script-src 'nonce-abc' 'strict-dynamic'", live), null, "strict-dynamic ignores host lists: left off");
  assert.strictEqual(allowLive("style-src 'nonce-abc'", live), null, "a nonce disables 'unsafe-inline': left off");
  assert.strictEqual(allowLive(undefined, live), null);
});

test('Python projects: framework, start command and port; 5000/8000 only when they serve a page', async (t) => {
  const c = require('../lib/connect');
  const http = require('http');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-py-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const mk = (name, files) => {
    const d = path.join(base, name);
    fs.mkdirSync(d);
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(d, f), text);
    return d;
  };
  const django = mk('dj', { 'manage.py': '' });
  const fast = mk('fa', { 'requirements.txt': 'fastapi==0.110\nuvicorn\n', 'app.py': '' });
  const flask = mk('fl', { 'pyproject.toml': 'dependencies = ["Flask>=3"]\n' });
  const notFlask = mk('nf', { 'requirements.txt': 'flask-cors\n' });
  assert.deepStrictEqual([c.detect(django).framework, c.detect(fast).framework, c.detect(flask).framework], ['django', 'fastapi', 'flask']);
  assert.strictEqual(c.detect(notFlask).kind, 'none');
  assert.strictEqual(c.runCommand(django), 'python manage.py runserver');
  assert.strictEqual(c.runCommand(fast), 'uvicorn app:app --reload');
  assert.strictEqual(c.runCommand(flask), 'flask run --debug');
  assert.deepStrictEqual(c.devCandidates(flask).map((x) => x.port), [5000]);
  assert.deepStrictEqual(c.devCandidates(django).map((x) => x.port), [8000]);
  assert.deepStrictEqual(c.appsIn(django), [django]);
  // An unknown project tries 5000 and 8000 last, and only a web page there counts.
  const other = mk('other', { 'package.json': '{"scripts":{}}' });
  const fallback = c.devCandidates(other).filter((x) => x.html).map((x) => x.port);
  assert.deepStrictEqual(fallback, [5000, 8000]);
  const serve = (type, status) => new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(status, { 'content-type': type });
      res.end(type.includes('html') ? '<title>Shop</title>' : '');
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
  const airplay = await serve('text/plain', 403);
  const page = await serve('text/html; charset=utf-8', 200);
  t.after(() => {
    airplay.close();
    page.close();
  });
  assert.strictEqual((await c.probe(airplay.address().port)).html, false);
  const p = await c.probe(page.address().port);
  assert.deepStrictEqual([p.html, p.title], [true, 'Shop']);
});

test('detect on a file or an over-long path says "none" instead of throwing', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'a.css');
    fs.writeFileSync(file, 'a{}');
    assert.strictEqual(detect(file).kind, 'none');
    assert.strictEqual(detect('/' + 'x'.repeat(100000)).kind, 'none');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a project keeps its proxy port; EDITLENS_STEADY_PORTS=off takes any free port', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Hi</h1>');
  const was = process.env.EDITLENS_STEADY_PORTS;
  const portOf = (u) => Number(new URL(u).port);
  const steady = steadyPort(dir);
  assert.ok(Number.isInteger(steady) && steady >= 4400 && steady < 4900, String(steady));
  try {
    delete process.env.EDITLENS_STEADY_PORTS;
    const c = new Connector({ stateDir: dir, livePort: 4317, emit: () => {} });
    // Its steady port, unless that one is taken right now (then any free one).
    const free = await new Promise((resolve) => {
      const s = net.createServer().once('error', () => resolve(false)).listen(steady, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    const on = await c.connect({ cwd: dir, target: '', sessionId: 's1' });
    assert.ok(on.ok, JSON.stringify(on));
    if (free) assert.strictEqual(portOf(on.url), steady);
    await c.stopAll();
    process.env.EDITLENS_STEADY_PORTS = 'off';
    const c2 = new Connector({ stateDir: dir, livePort: 4317, emit: () => {} });
    const off = await c2.connect({ cwd: dir, target: '', sessionId: 's1' });
    assert.ok(off.ok, JSON.stringify(off));
    assert.ok(portOf(off.url) < 4400 || portOf(off.url) >= 4900, off.url);
    await c2.stopAll();
  } finally {
    if (was === undefined) delete process.env.EDITLENS_STEADY_PORTS;
    else process.env.EDITLENS_STEADY_PORTS = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
