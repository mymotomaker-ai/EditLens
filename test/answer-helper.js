'use strict';
// For the end-to-end scripts: answer in the EditLens window the way the person does there (the
// window's own page has its key; see server/answer.js).
const http = require('http');
const config = require('../lib/config');

// What a browser sends when it opens the window, and for the window's own requests.
const OPEN_HEADERS = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
const WINDOW_HEADERS = { 'sec-fetch-site': 'same-origin' };

// The window's page, as a browser opens it (Node's fetch always sends its own sec-fetch-mode).
function pageText(base = config.baseUrl) {
  const u = new URL('/answer', base);
  return new Promise((resolve, reject) => {
    http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: OPEN_HEADERS }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

async function windowKey(base = config.baseUrl) {
  const m = /var KEY = "([0-9a-f]{64})"/.exec(await pageText(base));
  if (!m) throw new Error('no EditLens window key');
  return m[1];
}

// Every waiting question of these kinds gets this decision. -> what was answered
async function answerAll({ kinds = ['drive', 'task', 'mode'], decision = 'allow', base = config.baseUrl } = {}) {
  const key = await windowKey(base);
  const headers = { 'content-type': 'application/json', 'x-editlens-answer': key, ...WINDOW_HEADERS };
  const list = await (await fetch(`${base}/answer/list`, { headers })).json();
  const done = [];
  for (const q of list.questions.filter((x) => kinds.includes(x.kind))) {
    const res = await fetch(`${base}/answer`, { method: 'POST', headers, body: JSON.stringify({ kind: q.kind, id: q.id, task: q.task || null, decision }) });
    done.push({ kind: q.kind, title: q.title, status: res.status });
  }
  return done;
}

module.exports = { windowKey, answerAll, pageText, OPEN_HEADERS, WINDOW_HEADERS };
