'use strict';
// Screenshots pasted into the page panel's message box. The type comes from the file's first bytes
// (never from the name or type the page sends), the file is saved under the EditLens state folder
// with a name made here, and Claude is told where it is (or, in page control, gets the image).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PER_MESSAGE = 3;
const KEEP_FILES = 60;
const KEEP_MS = 7 * 24 * 3600 * 1000;
const REFUSED = "That file can't be added: only PNG, JPEG or WebP up to 5 MB.";
const GONE = 'That screenshot is no longer kept. Paste it again.';
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const ID_RE = /^[0-9a-f]{24}$/;
const FILE_RE = /^([0-9a-f]{24})\.(png|jpg|webp)$/;

function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function dim(v) {
  return Number.isInteger(v) && v >= 1 && v <= 100000 ? v : null;
}

// Width and height from the image header, or null when the header is incomplete or invalid.
function size(buf, type) {
  let w = null;
  let h = null;
  if (type === 'image/png' && buf.length >= 24 && buf.toString('latin1', 12, 16) === 'IHDR') {
    w = buf.readUInt32BE(16);
    h = buf.readUInt32BE(20);
  } else if (type === 'image/webp' && buf.length >= 30) {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') {
      w = buf.readUInt16LE(26) & 0x3fff;
      h = buf.readUInt16LE(28) & 0x3fff;
    } else if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      w = (b & 0x3fff) + 1;
      h = ((b >>> 14) & 0x3fff) + 1;
    } else if (chunk === 'VP8X') {
      w = buf.readUIntLE(24, 3) + 1;
      h = buf.readUIntLE(27, 3) + 1;
    }
  } else if (type === 'image/jpeg') {
    // Walk the segments to the first frame header (SOF0-SOF15, except DHT, JPG and DAC).
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        h = buf.readUInt16BE(i + 5);
        w = buf.readUInt16BE(i + 7);
        break;
      }
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  const out = { w: dim(w), h: dim(h) };
  return out.w && out.h ? out : null;
}

class ShotStore {
  constructor(dir, { log } = {}) {
    this.dir = dir;
    this.log = log || (() => {});
    this.items = new Map(); // id -> { id, file, type, bytes, w, h, root, pair, ts }
  }

  // buf: the bytes the page sent; scope: { root, pair } of the page that sent it.
  save(buf, scope) {
    const type = sniff(buf);
    if (!type || buf.length > MAX_BYTES) return { error: REFUSED };
    const dims = size(buf, type);
    if (!dims) return { error: REFUSED };
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const id = crypto.randomBytes(12).toString('hex');
    const file = path.join(this.dir, `${id}.${EXT[type]}`);
    fs.writeFileSync(file, buf, { flag: 'wx', mode: 0o600 });
    const shot = { id, file, type, bytes: buf.length, w: dims.w, h: dims.h, root: scope.root || null, pair: scope.pair || null, ts: Date.now() };
    this.items.set(id, shot);
    this.prune();
    return { shot };
  }

  // Only the page's own project (and, through a pairing link, only that link) can see a shot.
  get(id, scope, matches) {
    const shot = typeof id === 'string' && ID_RE.test(id) ? this.items.get(id) : null;
    if (!shot || shot.pair !== (scope.pair || null) || !matches(scope.root, shot.root)) return null;
    return fs.existsSync(shot.file) ? shot : null;
  }

  // The ids a message names, checked: { shots } or { error }.
  pick(ids, scope, matches) {
    if (ids === undefined || ids === null) return { shots: [] };
    if (!Array.isArray(ids) || ids.length > MAX_PER_MESSAGE) return { error: `You can add up to ${MAX_PER_MESSAGE} screenshots to one message.` };
    const shots = [];
    for (const id of ids) {
      const shot = this.get(id, scope, matches);
      if (!shot) return { error: GONE };
      if (!shots.includes(shot)) shots.push(shot);
    }
    return { shots };
  }

  // Deletes old files: older than a week, or beyond the newest KEEP_FILES.
  prune() {
    let names;
    try {
      names = fs.readdirSync(this.dir).filter((n) => FILE_RE.test(n));
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`screenshots: could not list ${this.dir}: ${err.message}`);
      return;
    }
    const list = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        list.push({ name, file, at: fs.statSync(file).mtimeMs });
      } catch (err) {
        if (err.code !== 'ENOENT') this.log(`screenshots: could not read ${name}: ${err.message}`);
      }
    }
    list.sort((a, b) => b.at - a.at);
    const now = Date.now();
    list.forEach((f, i) => {
      if (i < KEEP_FILES && now - f.at < KEEP_MS) return;
      try {
        fs.unlinkSync(f.file);
      } catch (err) {
        if (err.code !== 'ENOENT') this.log(`screenshots: could not remove ${f.name}: ${err.message}`);
      }
      this.items.delete(FILE_RE.exec(f.name)[1]);
    });
  }
}

// What the page may see: no file path.
function publicShot(s) {
  return { id: s.id, type: s.type, bytes: s.bytes, w: s.w, h: s.h };
}

// For a message Claude reads through the hooks: the files, for its Read tool.
function describeShots(shots) {
  if (!shots || !shots.length) return '';
  const one = shots.length === 1;
  return `The user pasted ${one ? 'a screenshot' : `${shots.length} screenshots`} with this message. ` +
    `Open ${one ? 'it' : 'them'} with your Read tool:\n` + shots.map((s) => `    ${s.file}`).join('\n');
}

// For page control: the images go to Claude in the message itself. Read without blocking the server.
async function messageContent(text, shots) {
  if (!shots || !shots.length) return text;
  const blocks = await Promise.all(shots.map(async (s) => ({ type: 'image', source: { type: 'base64', media_type: s.type, data: (await fs.promises.readFile(s.file)).toString('base64') } })));
  blocks.push({ type: 'text', text });
  return blocks;
}

module.exports = { ShotStore, sniff, size, publicShot, describeShots, messageContent, MAX_BYTES, MAX_PER_MESSAGE, REFUSED, GONE };
