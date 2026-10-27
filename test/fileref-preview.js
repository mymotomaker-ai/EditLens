#!/usr/bin/env node
'use strict';
require('./isolate');
// Clicks file references in a Claude reply shown in the panel, without running Claude: a markdown
// link to a folder, a file:line in plain text, a duplicate name, and a missing file. Hidden files
// such as .env are not made clickable.
//
//   NODE_PATH=$(npm root -g) node test/fileref-preview.js <out-dir> [prefix]
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { launch } = require('./launch');

const [outDir, prefix = 'fileref'] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: fileref-preview.js <out-dir> [prefix]');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });

const LIVE_PORT = 4978;
const PAGE_PORT = 4380;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-fileref-'));
const project = path.join(stateDir, 'My Site');
const files = {
  'demo-app/src/App.jsx': "import { Home, About } from './pages';\nimport { Nav } from './components';\n\nexport default function App() {\n  const [page, setPage] = useState('home');\n  return (\n    <>\n      <Nav page={page} onChange={setPage} />\n      {page === 'home' ? <Home /> : <About />}\n    </>\n  );\n}\n",
  'demo-app/src/components.jsx': "export function Nav({ page, onChange }) {\n  return <nav>{['home', 'about'].map((p) => <button key={p} onClick={() => onChange(p)}>{p}</button>)}</nav>;\n}\n",
  'demo-app/src/pages/Home.jsx': 'export default function Home() { return <h1>Home</h1>; }\n',
  'demo-app/src/pages/About.jsx': 'export default function About() { return <h1>About</h1>; }\n',
  'demo-app/src/pages/index.js': "export { default as Home } from './Home';\nexport { default as About } from './About';\n",
  'old/components.jsx': '// an older copy\n',
  'demo-app/.env': 'API_KEY=secret\n',
};
for (const [rel, text] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
  fs.writeFileSync(path.join(project, rel), text);
}

const REPLY = 'Each page has its own file in [src/pages](demo-app/src/pages), and the shared pieces are in ' +
  '[components.jsx](demo-app/src/components.jsx). [App.jsx](demo-app/src/App.jsx) now handles switching between pages, ' +
  "and I didn't add any new packages.\n\nThe page state is in demo-app/src/App.jsx:4-9. See `components.jsx`, `.env` and `old/gone.js`, " +
  'or the docs at https://react.dev/learn.\n\n```\ndemo-app/src/App.jsx stays plain text in a code block\n```';

// The page is light, so the panel would follow it; data-theme on the script tag sets the panel's theme.
const PAGE = (theme) => `<!doctype html><html><head><meta charset="utf-8"><title>Demo</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#222}main{padding:48px 40px}h1{font-size:40px;margin:0}</style>
</head><body><main><h1>Demo app</h1></main>
<script src="http://127.0.0.1:${LIVE_PORT}/live.js" data-panel="open" data-root="${project}" data-theme="${theme}"></script></body></html>`;

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: LIVE_PORT, path: urlPath, method, headers: {
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(token ? { 'x-editlens-token': token } : {}),
    } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await request('GET', '/health')).status === 200) return;
    } catch (err) {
      if (err.code !== 'ECONNREFUSED') throw err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('live server did not start');
}

(async () => {
  const live = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, EDITLENS_PORT: String(LIVE_PORT), EDITLENS_STATE_DIR: stateDir },
    stdio: 'ignore',
  });
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const theme = new URL(req.url, 'http://x').searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    res.end(PAGE(theme));
  }).listen(PAGE_PORT, '127.0.0.1');
  let browser = null;
  try {
    await waitUp();
    const token = fs.readFileSync(path.join(stateDir, `token-${LIVE_PORT}`), 'utf8').trim();
    await request('POST', '/event', { type: 'session', sessionId: 's1', cwd: project, ts: Date.now() }, token);
    await request('POST', '/event', { type: 'chat', role: 'assistant', sessionId: 's1', cwd: project, text: REPLY, ts: Date.now() }, token);
    browser = await launch(chromium);
    for (const scheme of ['dark', 'light']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: scheme === 'dark' ? 2 : 1, colorScheme: scheme });
      const page = await context.newPage();
      page.on('pageerror', (e) => console.log('[pageerror]', e.message));
      // Skip the first-visit tour; localStorage can throw in private mode.
      await page.addInitScript(() => {
        try {
          localStorage.setItem('editlens.tourDone', '1');
        } catch (err) {
          if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err;
        }
      });
      await page.goto(`http://127.0.0.1:${PAGE_PORT}/?theme=${scheme}`);
      const root = 'document.querySelector("edit-lens").shadowRoot';
      await page.waitForFunction(`${root} && ${root}.querySelectorAll('.k-claude a.fref').length > 0`);
      const links = await page.evaluate(`[...${root}.querySelectorAll('.k-claude a')].map((a) => (a.classList.contains('fref') ? 'file:' : 'web:') + a.textContent)`);
      console.log(scheme, 'links:', JSON.stringify(links));
      console.log(scheme, 'in code block:', await page.evaluate(`${root}.querySelectorAll('.k-claude pre a').length`));
      const click = (text) => page.evaluate(`[...${root}.querySelectorAll('.k-claude a.fref')].find((a) => a.textContent === ${JSON.stringify(text)}).click()`);
      const toast = () => page.evaluate(`${root}.querySelector('.toast').textContent`);

      await click('demo-app/src/App.jsx:4-9');
      await page.waitForFunction(`${root}.querySelectorAll('.pane .cl.lmark').length === 6`, null, { timeout: 8000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(outDir, `${prefix}-${scheme}-1-lines.png`) });
      console.log(scheme, 'App.jsx:4-9 marked lines:', await page.evaluate(`${root}.querySelectorAll('.pane .cl.lmark').length`));

      await click('src/pages');
      await page.waitForFunction(`${root}.querySelector('.picker.on .pitem')`);
      console.log(scheme, 'folder:', await page.evaluate(`[...${root}.querySelectorAll('.picker.on .pitem .pn')].map((n) => n.textContent).join(', ')`));
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(outDir, `${prefix}-${scheme}-2-folder.png`) });
      await page.evaluate(`${root}.querySelector('.picker.on .pitem').click()`);
      await page.waitForFunction(`[...${root}.querySelectorAll('.tab .nm')].some((n) => n.textContent === 'About.jsx')`, null, { timeout: 8000 });

      // The inline-code one: two files share the name.
      await page.evaluate(`[...${root}.querySelectorAll('.k-claude a.fref code')].find((c) => c.textContent === 'components.jsx').parentNode.click()`);
      await page.waitForFunction(`${root}.querySelector('.picker.on .pitem')`);
      console.log(scheme, 'duplicates:', await page.evaluate(`[...${root}.querySelectorAll('.picker.on .pitem .pn')].map((n) => n.textContent).join(', ')`));
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(outDir, `${prefix}-${scheme}-3-duplicates.png`) });
      await page.keyboard.press('Escape');

      await page.evaluate(`[...${root}.querySelectorAll('.k-claude a.fref code')].find((c) => c.textContent === 'old/gone.js').parentNode.click()`);
      await page.waitForTimeout(400);
      console.log(scheme, 'missing file:', await toast());
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    site.close();
    live.kill();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
