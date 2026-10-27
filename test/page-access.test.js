'use strict';
require('./isolate');
// What a page on localhost may do depends on the project it names: a page that names a drive or
// filesystem root, or no project at all, gets the least access (no files, no restore, no messages,
// no settings, no page control key), and a page of a project reads only files inside it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-access-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '4394';
const { ensureServer, stopServer, postEvent, postJson } = require('../lib/client');
const config = require('../lib/config');

const project = path.join(stateDir, 'site');
const outside = path.join(stateDir, 'private.txt');

async function req(method, urlPath, body) {
  const res = await fetch(`${config.baseUrl}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

test('a page gets only what its own project allows', async (t) => {
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'App.jsx'), 'export default 1;\n');
  fs.writeFileSync(outside, 'not for pages\n');
  await ensureServer();
  const streams = [];
  t.after(async () => {
    for (const s of streams) s.abort();
    await stopServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  const open = async (id, root) => {
    const s = new AbortController();
    streams.push(s);
    await fetch(`${config.baseUrl}/events?page=${id}${root === undefined ? '' : '&root=' + encodeURIComponent(root)}`, { signal: s.signal });
  };
  await postEvent({ type: 'session', sessionId: 's1', cwd: project, ts: Date.now(), canListen: false });
  await open('good', project);
  await open('none');
  await open('slash', '/');
  await open('drive', 'C:/');
  await open('home', os.homedir());

  // Files: the project's page reads its own files, never one outside the project.
  const ok = await req('GET', `/file?page=good&ref=src/App.jsx`);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.kind, 'file');
  assert.strictEqual((await req('GET', `/file?page=good&ref=${encodeURIComponent(outside)}`)).status, 404);
  for (const id of ['none', 'slash', 'drive', 'home', 'unknown']) {
    const r = await req('GET', `/file?page=${id}&ref=${encodeURIComponent(outside)}`);
    assert.strictEqual(r.status, 404, id);
    const inProject = await req('GET', `/file?page=${id}&ref=src/App.jsx`);
    assert.strictEqual(inProject.status, 404, `${id} reads no project file either`);
    const routes = await req('GET', `/pages?page=${id}`);
    assert.deepStrictEqual([routes.body.root, routes.body.routes], [null, []], id);
  }

  // Messages, settings, restore and the Team board need a page that names its project.
  assert.strictEqual((await req('POST', '/message', { text: 'hi', pageId: 'good' })).status, 200);
  for (const id of ['none', 'slash', 'drive', 'home']) {
    assert.strictEqual((await req('POST', '/message', { text: 'hi', pageId: id })).status, 403, id);
    assert.strictEqual((await req('POST', '/settings', { page: id, key: 'theme', value: 'Light' })).status, 403, id);
    assert.strictEqual((await req('POST', '/restore', { page: id, id: 'b1' })).status, 403, id);
  }
  assert.strictEqual((await req('POST', '/message', { text: 'hi' })).status, 403, 'no page at all');

  // Page control goes only to the project's page: with only root-less pages open, nobody gets it.
  streams[0].abort();
  await new Promise((r) => setTimeout(r, 200));
  const grant = await postJson('/drive/grant', { cwd: project }).catch((err) => ({ error: err.message }));
  assert.match(String(grant.error), /No page with the/);

  // Turned on by itself at the start of a session: a paired computer's page never counts.
  await open('pair-vps-1', project);
  const auto = await postJson('/drive/grant', { cwd: project, auto: true }).catch((err) => ({ error: err.message }));
  assert.match(String(auto.error), /No page with the/);
});

test('page control flags: wait (capped, NaN-safe), open, auto, take, later', () => {
  const { parseArgs } = require('../bin/drive');
  assert.deepStrictEqual(parseArgs(['new', '--wait', '120', '--open']), { word: 'new', take: false, wait: 120000, open: true, auto: false, later: false });
  assert.deepStrictEqual(parseArgs(['--auto', '--wait', 'NaN']), { word: '', take: false, wait: 0, open: false, auto: true, later: false });
  // --later: sent by a paired computer with no browser (bin/pair.js); not the word.
  assert.deepStrictEqual([parseArgs(['new', '--later']).word, parseArgs(['new', '--later']).later], ['new', true]);
  assert.strictEqual(parseArgs(['--wait', '99999']).wait, 3600000);
  assert.strictEqual(parseArgs(['--wait', '-5']).wait, 0);
  assert.strictEqual(parseArgs(['MANUAL']).word, 'manual');
  // take is not the word: control take, control new take.
  assert.deepStrictEqual([parseArgs(['take']).word, parseArgs(['take']).take], ['', true]);
  assert.deepStrictEqual([parseArgs(['new', 'TAKE']).word, parseArgs(['new', 'TAKE']).take], ['new', true]);
});
