'use strict';
require('./isolate');
// Screenshots pasted into the panel's message box: the type is read from the file's first bytes
// (never the name or type the page sends), PNG / JPEG / WebP up to 5 MB, at most 3 per message,
// saved under the EditLens state folder; Claude is told the file path, and in page control gets
// the image in the message itself. Uses the stand-in SDK and claude for page control.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-shots-'));
const state = path.join(dir, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
const sdk = path.join(dir, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
const bin = path.join(dir, 'bin');
fs.mkdirSync(bin);
fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(bin, 'claude'));
const exe = path.join(bin, 'claude');
Object.assign(process.env, {
  EDITLENS_STATE_DIR: path.join(dir, 'live'),
  EDITLENS_PORT: '4921',
  EDITLENS_SDK_DIR: path.join(dir, 'sdk'),
  FAKE_CLAUDE_STATE: state,
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { ensureServer, stopServer, postJson, getJson } = require('../lib/client');
const config = require('../lib/config');
const shotsLib = require('../lib/screenshots');
const { formatMessages } = require('../lib/messages');
const project = path.join(dir, 'app');
const other = path.join(dir, 'other');
fs.mkdirSync(project);
fs.mkdirSync(other);

// A real PNG of w×h (one gray row repeated).
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A JPEG header: APP0, then a frame header with the size.
function jpeg(w, h) {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(9)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
function webp(w, h) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBPVP8X', 8, 'latin1');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

test('the type comes from the first bytes, with the size from the header', () => {
  assert.strictEqual(shotsLib.sniff(png(44, 30)), 'image/png');
  assert.deepStrictEqual(shotsLib.size(png(44, 30), 'image/png'), { w: 44, h: 30 });
  assert.strictEqual(shotsLib.sniff(jpeg(640, 480)), 'image/jpeg');
  assert.deepStrictEqual(shotsLib.size(jpeg(640, 480), 'image/jpeg'), { w: 640, h: 480 });
  assert.strictEqual(shotsLib.sniff(webp(1280, 720)), 'image/webp');
  assert.deepStrictEqual(shotsLib.size(webp(1280, 720), 'image/webp'), { w: 1280, h: 720 });
  assert.strictEqual(shotsLib.sniff(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00', 'latin1')), null, 'GIF is refused');
  assert.strictEqual(shotsLib.sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null, 'SVG is refused');
  assert.strictEqual(shotsLib.sniff(Buffer.alloc(3)), null);
  assert.strictEqual(shotsLib.size(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), 'image/png'), null, 'a cut-short header has no size (never NaN)');
  const text = formatMessages([{ text: 'This looks wrong', images: [{ file: '/s/a.png' }, { file: '/s/b.png' }] }]);
  assert.match(text, /> This looks wrong\n\nThe user pasted 2 screenshots with this message\. Open them with your Read tool:\n {4}\/s\/a\.png\n {4}\/s\/b\.png/);
});

async function postShot(page, buf, type = 'image/png') {
  const res = await fetch(`${config.baseUrl}/shot?page=${page}`, { method: 'POST', headers: { 'Content-Type': type }, body: buf });
  return { status: res.status, body: await res.json() };
}
async function pagePost(route, body) {
  const res = await fetch(`${config.baseUrl}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
function openPage(id, root) {
  const ctrl = new AbortController();
  const frames = [];
  fetch(`${config.baseUrl}/events?page=${id}&root=${encodeURIComponent(root)}`, { signal: ctrl.signal }).then(async (res) => {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (data) frames.push(JSON.parse(data.slice(6)));
      }
    }
  }).catch((err) => {
    if (err.name !== 'AbortError') throw err;
  });
  return { frames, close: () => ctrl.abort() };
}
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test('the server keeps only real images, tells Claude the path, and page control sends the image', async (t) => {
  await ensureServer();
  const pages = [openPage('p1', project), openPage('p2', other)];
  t.after(async () => {
    for (const p of pages) p.close();
    await stopServer();
  });
  await until(async () => (await getJson('/pages/live')).length === 2);

  // Refused: not an image (whatever type the page says), too big, an unknown page.
  const fake = await postShot('p1', Buffer.from('GIF89a' + 'x'.repeat(100), 'latin1'), 'image/png');
  assert.strictEqual(fake.status, 415);
  assert.strictEqual(fake.body.error, "That file can't be added: only PNG, JPEG or WebP up to 5 MB.");
  const big = Buffer.concat([png(10, 10), Buffer.alloc(5 * 1024 * 1024)]);
  assert.strictEqual((await postShot('p1', big)).status, 415, 'over 5 MB');
  assert.strictEqual((await postShot('nope', png(4, 4))).status, 403);

  // Kept: under the state folder, named here, size read from the file.
  const shot = await postShot('p1', png(44, 30), 'application/octet-stream');
  assert.strictEqual(shot.status, 200, JSON.stringify(shot.body));
  assert.match(shot.body.id, /^[0-9a-f]{24}$/);
  assert.deepStrictEqual([shot.body.type, shot.body.w, shot.body.h], ['image/png', 44, 30]);
  assert.strictEqual('file' in shot.body, false, 'the page never gets the file path');
  const saved = path.join(config.stateDir, 'screenshots', `${shot.body.id}.png`);
  assert.ok(fs.existsSync(saved));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(saved).mode & 0o777, 0o600);
  const jpg = await postShot('p1', jpeg(800, 600));
  assert.deepStrictEqual([jpg.body.type, jpg.body.w], ['image/jpeg', 800]);

  // The sent bubble's picture: for a page of the same project only.
  const img = await fetch(`${config.baseUrl}/shot?id=${shot.body.id}&page=p1`);
  assert.strictEqual(img.status, 200);
  assert.strictEqual(img.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(png(44, 30)));
  assert.strictEqual((await fetch(`${config.baseUrl}/shot?id=${shot.body.id}&page=p2`)).status, 404, 'another project');
  assert.strictEqual((await fetch(`${config.baseUrl}/shot?id=../x&page=p1`)).status, 404);

  // A message with screenshots: at most 3, only this project's, and Claude is told the path.
  assert.strictEqual((await pagePost('/message', { pageId: 'p2', text: 'x', images: [shot.body.id] })).status, 410, "another project's screenshot");
  assert.strictEqual((await pagePost('/message', { pageId: 'p1', text: 'x', images: [shot.body.id, jpg.body.id, shot.body.id, jpg.body.id] })).status, 410, 'more than 3');
  const sent = await pagePost('/message', { pageId: 'p1', text: '', images: [shot.body.id] });
  assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
  assert.ok(await until(() => pages[0].frames.some((f) => f.type === 'page-message' && f.images && f.images[0].id === shot.body.id && f.images[0].w === 44 && !('file' in f.images[0]))),
    'the page gets the picture to show, without the path');
  const taken = await getJson(`/messages/take?cwd=${encodeURIComponent(project)}&via=prompt`);
  assert.strictEqual(taken.messages.length, 1);
  assert.strictEqual(taken.messages[0].text, 'Look at this.');
  const forClaude = formatMessages(taken.messages);
  assert.ok(forClaude.includes(`Open it with your Read tool:\n    ${saved}`), forClaude);

  // Page control: the image goes to Claude in the message.
  assert.ok((await postJson('/drive/grant', { cwd: project, claudePath: exe }, { timeoutMs: 20000 })).ok);
  assert.ok(await until(() => pages[0].frames.some((f) => f.type === 'drive-grant')));
  const key = pages[0].frames.find((f) => f.type === 'drive-grant').key;
  const driven = await pagePost('/drive/message', { key, pageId: 'p1', text: 'This looks wrong', images: [jpg.body.id] });
  assert.strictEqual(driven.status, 200, JSON.stringify(driven.body));
  const file = path.join(state, 'messages');
  assert.ok(await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('This looks wrong')), 'Claude got the message');
  const got = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((m) => Array.isArray(m.text));
  assert.ok(got, 'the message has content blocks');
  assert.deepStrictEqual(got.text.map((b) => b.type), ['image', 'text']);
  assert.strictEqual(got.text[0].source.media_type, 'image/jpeg');
  assert.ok(Buffer.from(got.text[0].source.data, 'base64').equals(jpeg(800, 600)));
  assert.strictEqual(got.text[1].text, 'This looks wrong');
  assert.ok(await until(() => pages[0].frames.some((f) => f.type === 'drive-message' && f.images && f.images[0].id === jpg.body.id)));
  await pagePost('/drive/stop', { key, pageId: 'p1' });
});

test('messageContent reads the images without blocking: base64 blocks, then the text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-shot-content-'));
  try {
    const file = path.join(dir, 'a.png');
    fs.writeFileSync(file, png(4, 3));
    const pending = shotsLib.messageContent('Look', [{ file, type: 'image/png' }]);
    assert.ok(pending instanceof Promise);
    assert.deepStrictEqual(await pending, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(4, 3).toString('base64') } }, { type: 'text', text: 'Look' }]);
    assert.strictEqual(await shotsLib.messageContent('Only text', []), 'Only text');
    await assert.rejects(shotsLib.messageContent('x', [{ file: path.join(dir, 'gone.png'), type: 'image/png' }]), { code: 'ENOENT' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('old screenshots are removed: older than a week, or past the newest 60', () => {
  const store = new shotsLib.ShotStore(path.join(dir, 'prune'));
  const old = store.save(png(4, 4), { root: project }).shot;
  const keep = store.save(png(4, 4), { root: project }).shot;
  const weekAgo = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(old.file, weekAgo, weekAgo);
  fs.writeFileSync(path.join(dir, 'prune', 'notes.txt'), 'not ours');
  store.prune();
  assert.ok(!fs.existsSync(old.file) && fs.existsSync(keep.file) && fs.existsSync(path.join(dir, 'prune', 'notes.txt')));
  assert.strictEqual(store.get(old.id, { root: project }, () => true), null);
  for (let i = 0; i < 65; i++) store.save(png(4, 4), { root: project });
  assert.strictEqual(fs.readdirSync(path.join(dir, 'prune')).filter((n) => n.endsWith('.png')).length, 60);
});
