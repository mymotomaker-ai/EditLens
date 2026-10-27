'use strict';
// This user's keys made from one file in the state folder (gateway-key: 32 random bytes, readable
// only by this user). D11: the keys of a pairing's two local addresses (server/pair-remote.js).
// D21: the page key, for pages and the EditLens window where the live server can't tell which
// account connects (macOS, Windows). A page gets it after # in an address /editlens opens or
// prints; it stays the same across restarts, one per port.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./atomic');

const FILE = 'gateway-key';
// The name after # for the page key in a page's address (the part after # is never sent to a server).
const HASH_PARAM = 'editlens-key';

// The key file's text: made once, owner-only.
function gatewayKey(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(text)) {
      if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077)) fs.chmodSync(file, 0o600);
      return text;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const key = crypto.randomBytes(32).toString('hex');
  writeAtomic(file, key + '\n', { mode: 0o600 });
  return key;
}

// The page key for the live server on `port` (32 hex characters, as a pairing's /gk- keys).
function pageKey(stateDir, port) {
  return crypto.createHmac('sha256', gatewayKey(path.join(stateDir, FILE))).update(`page:${port}`).digest('hex').slice(0, 32);
}

// A page address with the page key after #, or the address as it is (no key, or not this computer's).
function keyedUrl(url, key) {
  if (typeof url !== 'string' || !/^[0-9a-f]{32}$/.test(String(key || ''))) return url;
  if (!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}(\/|$)/i.test(url)) return url;
  const bare = url.split('#')[0];
  return `${bare}${/^http:\/\/[^/]+$/i.test(bare) ? '/' : ''}#${HASH_PARAM}=${key}`;
}

module.exports = { gatewayKey, pageKey, keyedUrl, HASH_PARAM, FILE };
