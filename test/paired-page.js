'use strict';
// A paired computer's page as this user's browser opens it (D11): the site address needs the
// cookie the address with the key sets, and the live address needs the key at the start of each
// path. Both are made from the joining computer's key file (server/pair-remote.js token()).
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

// stateDir: the joining computer's state folder; sitePort: the site address's port.
function siteCookie(stateDir, sitePort) {
  return `editlens-gw-${sitePort}=${token(stateDir, 'site', sitePort)}`;
}

function token(stateDir, kind, port) {
  const key = fs.readFileSync(path.join(stateDir, 'gateway-key'), 'utf8').trim();
  return crypto.createHmac('sha256', key).update(`${kind}:${port}`).digest('hex').slice(0, 32);
}

function get(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers, agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    }).on('error', reject);
  });
}

// The page at siteUrl (a paired computer's site address here): its cookie, its HTML, and the page
// script's address through the link. -> { sitePort, cookie, html, port, gk, origin, live(path) }
// live(path): that path on the live address, with the key when the page's script has it.
async function openPaired(stateDir, siteUrl) {
  const sitePort = Number(new URL(siteUrl).port);
  if (!Number.isInteger(sitePort) || sitePort < 1 || sitePort > 65535) throw new Error(`no port in the site address: ${siteUrl}`);
  const cookie = siteCookie(stateDir, sitePort);
  const page = await get(sitePort, '/', { cookie });
  const m = /127\.0\.0\.1:(\d+)((?:\/gk-[0-9a-f]{32})?)\/live\.js/.exec(page.text);
  if (!m) throw new Error(`no EditLens script in the paired page (${page.status}): ${page.text.slice(0, 200)}`);
  const gk = m[2];
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port in the paired page: ${m[1]}`);
  return { sitePort, cookie, html: page.text, port, gk, origin: `http://127.0.0.1:${sitePort}`, live: (p) => gk + p };
}

module.exports = { openPaired, siteCookie, token };
