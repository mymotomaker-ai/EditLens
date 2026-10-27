#!/usr/bin/env node
'use strict';
require('./isolate');
// Sol scan of 0.24.45, M8 (client part): a code view file saved before a backend reload by 0.24.43
// names its snapshot without the server start ("s1"). After a restart that number can be another
// file's snapshot, so the page never asks for it; a reference with the server start is opened.
// A stand-in EditLens server (one port picked by the system) serves the page, live.js and /snapshot.
//
//   NODE_PATH=$(npm root -g) node test/snapshot-ref-preview.js
const http = require('http');
const assert = require('assert');
const { chromium } = require('playwright');
const { launch } = require('./launch');
const { clientScript } = require('../lib/client-script');
const pkg = require('../package.json');

const INSTANCE = 'a1b2c3d4e5f60718';
const asked = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (url.pathname === '/') {
    const port = server.address().port;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Saved files</title></head><body><h1>Page</h1>
<script src="http://127.0.0.1:${port}/live.js" data-panel="min" data-root="/site"></script></body></html>`);
  }
  if (url.pathname === '/live.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', ...cors });
    return res.end(clientScript());
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', ...cors });
    res.write(`event: claude\ndata: ${JSON.stringify({ type: 'hello', version: pkg.version, instance: INSTANCE, via: null, projects: [] })}\n\n`);
    return undefined; // kept open
  }
  if (url.pathname === '/snapshot') {
    asked.push(url.search);
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    const id = url.searchParams.get('id');
    return res.end(JSON.stringify({ file: `/site/${id}.js`, relFile: `${id}.js`, before: null, after: `// file ${id}\n`, kind: 'view' }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
  return res.end('{}');
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await launch(chromium);
  try {
    const context = await browser.newContext();
    // The tab before its reload: the code view was open with two files.
    await context.addInitScript((inst) => {
      sessionStorage.setItem('editlens.dockOpen', '1');
      sessionStorage.setItem('editlens.dockFiles', JSON.stringify([{ s: 's1', kind: 'view' }, { s: `${inst}.s2`, kind: 'view' }]));
    }, INSTANCE);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const end = Date.now() + 10000;
    while (!asked.some((q) => q.includes('id=s2')) && Date.now() < end) await page.waitForTimeout(100);
    await page.waitForTimeout(1000);
    assert.ok(asked.some((q) => /[?&]id=s2(&|$)/.test(q) && q.includes(`instance=${INSTANCE}`)), `the file with its server start opens again: ${JSON.stringify(asked)}`);
    assert.ok(!asked.some((q) => /[?&]id=s1(&|$)/.test(q)), `a reference with no server start is not asked for: ${JSON.stringify(asked)}`);
    console.log('snapshot-ref-preview: ok');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
