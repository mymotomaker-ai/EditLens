#!/usr/bin/env node
'use strict';
require('./isolate');
// The page-control safety check with real Claude: in Accept edits, a Write that replaces most of
// a file still shows a permission card with the reason (and Deny keeps the file), while a normal
// edit goes through without a question. Needs a signed-in claude and the SDK installed.
//
//   EDITLENS_E2E_REAL_CLAUDE=1 EDITLENS_SDK_DIR=<dir with the SDK installed> \
//     node test/e2e-guard.js [claude-path]
const { needRealClaude } = require('./isolate');
needRealClaude();
const fs = require('fs');
const os = require('os');
const path = require('path');
// Its own port and isolate's state folder: the EditLens server the user runs is never used or stopped.
process.env.EDITLENS_PORT = '5232';
const { Driver } = require('../server/driver');

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-e2e-guard-'));
const APP = Array.from({ length: 30 }, (_, i) => `export const item${i} = ${i};`).join('\n') + '\n';
fs.writeFileSync(path.join(cwd, 'App.jsx'), APP);
const events = [];
let d;
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};
async function turn(text, onAsk) {
  const from = events.length;
  d.send(text);
  const end = Date.now() + 240000;
  while (Date.now() < end) {
    for (const p of d.status().permissions || []) if (!p.seen) {
      p.seen = true;
      await onAsk(p);
    }
    if (events.slice(from).some((e) => e.type === 'drive' && e.phase === 'idle')) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

(async () => {
  d = new Driver({ emit: (e) => events.push(e), log: () => {}, stateDir: process.env.EDITLENS_STATE_DIR, platform: process.platform });
  const out = await d.start({ cwd, claudePaths: process.argv[2] ? [process.argv[2]] : [] });
  check('Claude starts', out.ok && !out.signIn, out);
  await until(() => d.status().phase === 'ready', 60000);
  check('Accept edits', (await d.setMode('acceptEdits')).ok);

  const cards = [];
  const ok1 = await turn('This is a test of a permission prompt and I want exactly this: call the Write tool once on App.jsx with the content `export default 1;` (nothing else). Do not read it or edit it another way. If the write is denied, reply "denied" and stop.', async (p) => {
    cards.push({ tool: p.tool, title: p.title, warning: p.warning || null });
    d.answer(p.id, 'deny');
  });
  check('turn 1 finished', ok1);
  check('a card with the reason was shown, even in Accept edits', cards.some((c) => c.tool === 'Write' && /replaces most of App\.jsx/.test(c.warning || '')), cards);
  check('Deny kept the file', fs.readFileSync(path.join(cwd, 'App.jsx'), 'utf8') === APP);

  const cards2 = [];
  const ok2 = await turn('Now add the line `export const extra = 1;` at the end of App.jsx with the Edit tool. Reply "done".', async (p) => {
    cards2.push({ tool: p.tool, warning: p.warning || null });
    d.answer(p.id, 'allow');
  });
  check('turn 2 finished', ok2);
  check('a normal edit asked nothing', !cards2.some((c) => c.tool === 'Edit' || c.tool === 'Write'), cards2);
  check('the edit was made', fs.readFileSync(path.join(cwd, 'App.jsx'), 'utf8').includes('extra = 1'));
  d.stop('test over');
  fs.rmSync(cwd, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  if (d) d.stop('error');
  fs.rmSync(cwd, { recursive: true, force: true });
  process.exit(1);
});
