'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5421';
// D14 (the user's choice, option A; Sol M1): a paired computer older than 0.24.45 has no gateway
// key, so its two local addresses here refuse it and say "Update EditLens on ◆ <name>". A version
// that can't be read counts as older. The key is never skipped. The other computer is a stand-in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { PairRemotes } = require('../server/pair-remote');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-oldpeer-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

// The other computer: its site and its live server, each an http server that notes what it got.
async function standIn(name) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': name === 'site' ? 'text/html' : 'text/plain' });
    res.end(name === 'site' ? '<html><head><script src="http://127.0.0.1:5427/live.js"></script></head><body>vps</body></html>' : `${name} ${req.url}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, seen, port: server.address().port };
}

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

// The first visit with the key, as a browser makes it (redirects, a cookie for 127.0.0.1).
async function cookieFor(keyUrl) {
  let at = new URL(keyUrl);
  let cookie = null;
  for (let i = 0; i < 4; i++) {
    const r = await get(Number(at.port), at.pathname + at.search, { host: at.host });
    if (r.status !== 302) break;
    if (r.headers['set-cookie'] && at.hostname === '127.0.0.1') cookie = String(r.headers['set-cookie']).split(';')[0];
    at = new URL(r.headers.location, at);
  }
  return cookie;
}

async function paired(version) {
  const site = await standIn('site');
  const live = await standIn('live');
  const dir = fs.mkdtempSync(path.join(base, 'state-'));
  const remotes = new PairRemotes({ stateDir: dir, port: 5422, log: () => {}, otherUser: () => false });
  remotes.dial = async (h, head) => net.connect(head.t === 'site' ? site.port : live.port, '127.0.0.1');
  remotes.ask = async () => ({ ok: true, version, site: true });
  const h = { id: 'e'.repeat(32), key: 'f'.repeat(64), host: '203.0.113.5', port: 5423, name: 'vps', cwd: '/srv/app', livePort: 5427, version, liveGateway: 0, siteGateway: 0 };
  remotes.hosts.push(h);
  remotes.save = () => {};
  await remotes.open(h);
  const done = async () => {
    await remotes.close();
    site.server.close();
    live.server.close();
  };
  return { remotes, h, site, live, done };
}

for (const version of ['0.24.44', '']) {
  test(`D14: a paired computer with ${version ? 'EditLens ' + version : 'no readable version'} is refused, with the update message`, async () => {
    const p = await paired(version);
    try {
      const cookie = await cookieFor(p.remotes.status({ withKey: true }).hosts[0].keyUrl);
      assert.ok(cookie, 'the first visit with the key still sets the cookie');
      const page = await get(p.h.siteGateway, '/', { cookie });
      assert.strictEqual(page.status, 403);
      assert.match(page.body, /^Update EditLens on ◆ vps/);
      const token = p.remotes.token('live', p.h.liveGateway);
      const script = await get(p.h.liveGateway, `/gk-${token}/live.js`);
      assert.strictEqual(script.status, 403);
      assert.match(script.body, /^Update EditLens on ◆ vps/);
      // Without the key: the address's usual refusal, and no name of the other computer.
      const bare = await get(p.h.liveGateway, '/events');
      assert.strictEqual(bare.status, 403);
      assert.doesNotMatch(bare.body, /vps/);
      assert.deepStrictEqual([p.site.seen, p.live.seen], [[], []], 'nothing went to the other computer');
    } finally {
      await p.done();
    }
  });
}

test('D14: a paired computer with 0.24.45 or later works through both addresses', async () => {
  const p = await paired('0.24.47');
  try {
    const cookie = await cookieFor(p.remotes.status({ withKey: true }).hosts[0].keyUrl);
    const page = await get(p.h.siteGateway, '/', { cookie });
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /<script src="http:\/\/127\.0\.0\.1:\d+\/gk-[0-9a-f]{32}\/live\.js"/);
    const token = p.remotes.token('live', p.h.liveGateway);
    const script = await get(p.h.liveGateway, `/gk-${token}/live.js`);
    assert.strictEqual(script.status, 200);
    assert.strictEqual((await get(p.h.liveGateway, '/live.js')).status, 403, 'the key is still needed');
  } finally {
    await p.done();
  }
});

test('D14: a computer that updates is let through after its next check, and the version is saved', async () => {
  const p = await paired('0.24.44');
  let saved = 0;
  p.remotes.save = () => { saved++; };
  try {
    p.remotes.ask = async () => ({ ok: true, version: '0.24.47', site: true });
    p.remotes.check(p.h, p.remotes.links.get(p.h.id));
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(p.h.version, '0.24.47');
    assert.ok(saved >= 1, 'the new version is kept for the next start');
    const token = p.remotes.token('live', p.h.liveGateway);
    assert.strictEqual((await get(p.h.liveGateway, `/gk-${token}/live.js`)).status, 200);
  } finally {
    await p.done();
  }
});
