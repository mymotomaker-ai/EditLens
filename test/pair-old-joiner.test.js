'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5424';
// D14 from the other side: a computer that joined this one with EditLens older than 0.24.45 has
// no key at its own local addresses, so another account there could use the link. This server
// refuses that computer's page requests and says to update it. The joining computer is a stand-in
// (this file's own PairRemotes) that names an older version when it connects. 0.24.45 and 0.24.46
// name a version on their live link only: their site link is accepted by the version saved from it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { PairRemotes } = require('../server/pair-remote');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-oldjoin-'));
const project = path.join(base, 'project');
fs.mkdirSync(project);
const HOST = { port: 5424, pairPort: 5425, dir: path.join(base, 'host') };
let child = null;
let remotes = null;
// The versions the stand-in names: on its live link, and on its site link (undefined: none).
let named = '0.24.44';
let siteNamed;
// What the host server and the stand-in log.
let hostOut = '';
const remoteLog = [];
test.after(async () => {
  if (remotes) await remotes.close();
  if (child && child.exitCode === null) {
    await new Promise((r) => {
      child.once('exit', r);
      child.kill();
    });
  }
  fs.rmSync(base, { recursive: true, force: true });
});

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, agent: false, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => {
        text += c;
        // An event stream stays open: its first lines are enough.
        if (/text\/event-stream/.test(String(res.headers['content-type']))) res.destroy();
      });
      res.on('close', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', (err) => resolve({ status: 0, text: err.code || err.message }));
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function waitFor(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test('D14: page requests from a computer that joined with EditLens 0.24.44 are refused; 0.24.47 works', async () => {
  fs.mkdirSync(HOST.dir, { recursive: true });
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, EDITLENS_PORT: String(HOST.port), EDITLENS_PAIR_PORT: String(HOST.pairPort), EDITLENS_STATE_DIR: HOST.dir },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  child.stdout.on('data', (c) => { hostOut += c; });
  assert.ok(await waitFor(async () => (await request(HOST.port, 'GET', '/health')).status === 200), 'the server started');
  const token = fs.readFileSync(path.join(HOST.dir, `token-${HOST.port}`), 'utf8');
  const pair = JSON.parse((await request(HOST.port, 'POST', '/pair', { cwd: project }, { 'x-editlens-token': token })).text);
  assert.match(pair.code, /^([A-Z2-9]{4}-){6}[A-Z2-9]{4}$/);

  remotes = new PairRemotes({ stateDir: path.join(base, 'remote'), port: 5426, log: (...a) => remoteLog.push(a.join(' ')), otherUser: () => false });
  named = '0.24.44';
  const dial = remotes.dial.bind(remotes);
  remotes.dial = (h, header, opts) => {
    if (header.t === 'live') return dial(h, { ...header, version: named }, opts);
    if (header.t !== 'site') return dial(h, header, opts);
    const { version, ...rest } = header;
    return dial(h, siteNamed === undefined ? rest : { ...rest, version: siteNamed }, opts);
  };
  const joined = await remotes.join(`127.0.0.1:${HOST.pairPort}`, pair.code);
  assert.ok(joined.ok, JSON.stringify(joined));
  const h = remotes.hosts[0];
  const gk = `/gk-${remotes.token('live', h.liveGateway)}`;

  // No version on the site link and no live link before it (no version known): refused, and logged.
  const cookie = await siteCookie(remotes.status({ withKey: true }).hosts[0].keyUrl);
  assert.ok(cookie, 'the site address set its cookie');
  const unknown = await request(h.siteGateway, 'GET', '/', undefined, { cookie, host: `127.0.0.1:${h.siteGateway}` });
  assert.strictEqual(unknown.status, 403);
  assert.ok(await waitFor(() => /refused the site link from ◆ \S+: its EditLens version is not known yet/.test(hostOut), 3000), hostOut);

  const old = await request(h.liveGateway, 'GET', `${gk}/events`);
  assert.strictEqual(old.status, 403);
  assert.match(old.text, /^Update EditLens on ◆ [\w-]+ \(0\.24\.45 or later\), then reload this page\.$/);
  assert.strictEqual((await request(h.liveGateway, 'GET', `${gk}/live.js`)).status, 403);
  // No version at all (older versions sent none): refused too.
  named = undefined;
  assert.strictEqual((await request(h.liveGateway, 'GET', `${gk}/events`)).status, 403);

  named = '0.24.47';
  const now = await request(h.liveGateway, 'GET', `${gk}/events`);
  assert.strictEqual(now.status, 200);
  assert.match(now.text, /event: claude/);
});

// The cookie for the site address, from the first visit with the key (as a browser makes it).
async function siteCookie(keyUrl) {
  let at = new URL(keyUrl);
  for (let i = 0; i < 4; i++) {
    const r = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: Number(at.port), path: at.pathname + at.search, headers: { host: at.host }, agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(res));
      }).on('error', reject);
    });
    if (r.statusCode !== 302) return null;
    if (r.headers['set-cookie'] && at.hostname === '127.0.0.1') return String(r.headers['set-cookie']).split(';')[0];
    at = new URL(r.headers.location, at);
  }
  return null;
}

test('D14: the site link from a computer that joined with EditLens 0.24.44 or no version is refused', async () => {
  const h = remotes.hosts[0];
  const gk = `/gk-${remotes.token('live', h.liveGateway)}`;
  const cookie = await siteCookie(remotes.status({ withKey: true }).hosts[0].keyUrl);
  assert.ok(cookie, 'the site address set its cookie');
  // live: the version its live link names first (the other computer saves it), or null for none.
  const site = async (version, live = null) => {
    if (live) {
      named = live;
      await request(h.liveGateway, 'GET', `${gk}/events`);
    }
    siteNamed = version;
    return request(h.siteGateway, 'GET', '/', undefined, { cookie, host: `127.0.0.1:${h.siteGateway}` });
  };
  for (const [version, live] of [['0.24.44', null], [undefined, '0.24.44']]) {
    const old = await site(version, live);
    assert.strictEqual(old.status, 403, `${version} ${live}`);
    assert.match(old.text, /^Update EditLens on ◆ [\w-]+ \(0\.24\.45 or later\), then reload this page\.$/);
  }
  // 0.24.45 or later goes through: no dev site is connected for this project there, which it says.
  const now = await site('0.24.47');
  assert.strictEqual(now.status, 503);
  assert.match(now.text, /No dev site is connected/);
});

test('SN3: 0.24.45 and 0.24.46 name no version on the site link: the one saved from their live link is used', async () => {
  const h = remotes.hosts[0];
  const gk = `/gk-${remotes.token('live', h.liveGateway)}`;
  const cookie = await siteCookie(remotes.status({ withKey: true }).hosts[0].keyUrl);
  for (const version of ['0.24.45', '0.24.46']) {
    named = version;
    assert.strictEqual((await request(h.liveGateway, 'GET', `${gk}/events`)).status, 200, version);
    siteNamed = undefined;
    const r = await request(h.siteGateway, 'GET', '/', undefined, { cookie, host: `127.0.0.1:${h.siteGateway}` });
    assert.strictEqual(r.status, 503, `${version}: ${r.text}`);
    assert.match(r.text, /No dev site is connected/);
  }
  // Saved with the pairing, for the next start of that server.
  const saved = JSON.parse(fs.readFileSync(path.join(HOST.dir, 'pair-host.json'), 'utf8')).pairs[0];
  assert.strictEqual(saved.peerVersion, '0.24.46');
});

test('SN3: the joining computer logs a page request it refuses because the other one is older', async () => {
  const h = remotes.hosts[0];
  const cookie = await siteCookie(remotes.status({ withKey: true }).hosts[0].keyUrl);
  const was = h.version;
  h.version = '0.24.44';
  try {
    const r = await request(h.siteGateway, 'GET', '/', undefined, { cookie, host: `127.0.0.1:${h.siteGateway}` });
    assert.strictEqual(r.status, 403);
    assert.ok(remoteLog.some((l) => /^refused a page request for ◆ \S+: it runs EditLens 0\.24\.44; it needs 0\.24\.45 or later$/.test(l)), remoteLog.join('\n'));
  } finally {
    h.version = was;
  }
});
