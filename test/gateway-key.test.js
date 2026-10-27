'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5340';
// D11 (the user's choice, option A; Sol H6): the two local addresses a paired computer opens (its
// site and its live server) answer only the user whose key file this is. The site needs the key
// once (a link EditLens gives), then a cookie; the live server's addresses start with /gk-<key>.
// Another user on the same computer has neither. The other computer is a stand-in here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { PairRemotes } = require('../server/pair-remote');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-gwkey-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

// The other computer: its site and its live server, each an http server that says what it got.
async function standIn(name) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': name === 'site' ? 'text/html' : 'text/plain' });
    res.end(name === 'site' ? '<html><head><script src="http://127.0.0.1:4999/live.js"></script></head><body>vps</body></html>' : `${name} ${req.url}`);
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

// A first visit with the key, as a browser makes it: each redirect sets a cookie for its own name
// (127.0.0.1 or localhost). -> { cookies: { host: 'name=value' }, final } (final: the last address)
async function visit(keyUrl) {
  const cookies = {};
  let at = new URL(keyUrl);
  for (let i = 0; i < 4; i++) {
    const r = await get(Number(at.port), at.pathname + at.search, { host: at.host });
    if (r.status !== 302) return { cookies, final: at, status: r.status };
    if (r.headers['set-cookie']) {
      assert.match(String(r.headers['set-cookie']), /HttpOnly/i);
      cookies[at.hostname] = String(r.headers['set-cookie']).split(';')[0];
    }
    at = new URL(r.headers.location, at);
  }
  return { cookies, final: at, status: 302 };
}

async function paired(version) {
  const site = await standIn('site');
  const live = await standIn('live');
  const dir = fs.mkdtempSync(path.join(base, 'state-'));
  const remotes = new PairRemotes({ stateDir: dir, port: 5341, log: () => {}, otherUser: () => false });
  remotes.dial = async (h, head) => net.connect(head.t === 'site' ? site.port : live.port, '127.0.0.1');
  remotes.ask = async () => ({ ok: true, version, site: true });
  const h = { id: 'c'.repeat(32), key: 'd'.repeat(64), host: '203.0.113.5', port: 5342, name: 'vps', cwd: '/srv/app', livePort: 4999, version, liveGateway: 0, siteGateway: 0 };
  remotes.hosts.push(h);
  await remotes.open(h);
  const done = async () => {
    await remotes.close();
    site.server.close();
    live.server.close();
  };
  return { remotes, h, site, live, dir, done };
}

test('D11: the site address needs the key once, then its cookie; nobody else gets the page', async () => {
  const p = await paired('0.24.45');
  try {
    const open = p.remotes.status().hosts[0];
    assert.ok(!/key|gk-/.test(JSON.stringify(open)), 'no key in the status pages and the line above the prompt see');
    const withKey = p.remotes.status({ withKey: true }).hosts[0];
    const keyed = new URL(withKey.keyUrl);
    assert.strictEqual(keyed.port, String(p.h.siteGateway));
    const token = keyed.searchParams.get('editlens-key');
    assert.match(token, /^[0-9a-f]{32}$/);

    const none = await get(p.h.siteGateway, '/');
    assert.strictEqual(none.status, 403);
    assert.match(none.body, /\/editlens join/);
    assert.strictEqual(p.site.seen.length, 0, 'nothing was sent to the other computer');
    const wrong = await get(p.h.siteGateway, `/?editlens-key=${'0'.repeat(32)}`);
    assert.strictEqual(wrong.status, 403);

    const v = await visit(withKey.keyUrl);
    assert.strictEqual(v.final.searchParams.get('editlens-key'), null, 'the key leaves the address bar');
    assert.strictEqual(v.final.pathname, '/');
    assert.ok(v.cookies['127.0.0.1'] && v.cookies.localhost, JSON.stringify(v.cookies));
    const cookie = v.cookies['127.0.0.1'];
    const page = await get(p.h.siteGateway, '/', { cookie });
    assert.strictEqual(page.status, 200);
    assert.strictEqual((await get(p.h.siteGateway, '/', { cookie: v.cookies.localhost, host: `localhost:${p.h.siteGateway}` })).status, 200);
    // The page's script comes through this computer's live address, with the key in its path.
    const src = /<script src="http:\/\/127\.0\.0\.1:(\d+)(\/gk-[0-9a-f]{32})\/live\.js"/.exec(page.body);
    assert.ok(src, page.body);
    assert.strictEqual(Number(src[1]), p.h.liveGateway);
    assert.ok(!page.body.includes(token), 'the site key is not the live key');
  } finally {
    await p.done();
  }
});

test('D11: the live address passes only requests that start with the key; the other computer gets them', async () => {
  const p = await paired('0.24.45');
  try {
    const cookie = (await visit(p.remotes.status({ withKey: true }).hosts[0].keyUrl)).cookies['127.0.0.1'];
    const gk = /(\/gk-[0-9a-f]{32})\/live\.js/.exec((await get(p.h.siteGateway, '/', { cookie })).body)[1];
    const without = await get(p.h.liveGateway, '/live.js');
    assert.strictEqual(without.status, 403);
    const wrong = await get(p.h.liveGateway, `/gk-${'0'.repeat(32)}/live.js`);
    assert.strictEqual(wrong.status, 403);
    assert.strictEqual(p.live.seen.length, 0, 'nothing was sent to the other computer');
    const ok = await get(p.h.liveGateway, `${gk}/live.js`);
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(p.live.seen, [`${gk}/live.js`]);
    // The answer window, opened as a page from this computer's panel: its cookie lets it in, at the
    // address with the key.
    const answer = await get(p.h.liveGateway, '/answer', { cookie });
    assert.strictEqual(answer.status, 302);
    assert.strictEqual(answer.headers.location, `${gk}/answer`);
    assert.deepStrictEqual(p.live.seen, [`${gk}/live.js`]);
  } finally {
    await p.done();
  }
});

test('D11: the key file is this user\'s only, and stays the same', async () => {
  const p = await paired('0.24.45');
  try {
    const first = p.remotes.status({ withKey: true }).hosts[0].keyUrl;
    const file = path.join(p.dir, 'gateway-key');
    assert.ok(fs.existsSync(file));
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o077, 0, 'no access for others');
    const again = new PairRemotes({ stateDir: p.dir, port: 5341, log: () => {}, otherUser: () => false });
    assert.strictEqual(again.token('site', p.h.siteGateway), new URL(first).searchParams.get('editlens-key'));
  } finally {
    await p.done();
  }
});
