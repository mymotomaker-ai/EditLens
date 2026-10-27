#!/usr/bin/env node
'use strict';
// /editlens restart: replaces the running server with the newest installed one now, instead of
// waiting until page control stops; then bin/start.js does what /editlens does. Pages /editlens
// connected are connected again at the same address. Page control that ran starts again in the
// same conversation when its page reconnects (lib/pagekeep.js); a paired computer's running task stops.
const path = require('path');
const config = require('../lib/config');
const { ensureServer, stopServer, health, noteOldControl, getJson, postJson, pageKey } = require('../lib/client');
const { keyedUrl } = require('../lib/pagekey');
const pagekeep = require('../lib/pagekeep');
const { say } = require('../lib/say');
const { plainMessage, plainError } = require('../lib/plainerr');

// The connections /editlens made (GET /connections), to make again after the restart.
async function connectionsNow() {
  const list = await getJson('/connections', 5000).catch((err) => {
    process.stderr.write(`(could not read which pages are connected: ${plainError(err)})\n`);
    return [];
  });
  return (Array.isArray(list) ? list : []).filter((c) => c && typeof c.cwd === 'string' && c.cwd && ['static', 'proxy', 'vite'].includes(c.kind)).slice(0, 20);
}

function urlOf(text) {
  try {
    return typeof text === 'string' ? new URL(text) : null;
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return null;
  }
}

// Each one again, at the port its page had. -> [{ cwd, ok, error, moved: the new address or null }]
async function reconnect(list) {
  const out = [];
  for (const c of list) {
    const url = urlOf(c.url);
    const port = url ? Number(url.port) : NaN;
    const target = c.kind === 'proxy' && typeof c.target === 'string' ? c.target + (url ? url.pathname : '') : null;
    const res = await postJson('/connect', { cwd: c.cwd, target, sessionId: c.sessionId || null, ...(Number.isInteger(port) && port > 0 ? { port } : {}) }, { timeoutMs: 90000 })
      .catch((err) => ({ error: plainError(err) }));
    const now = res && res.ok ? urlOf(res.url) : null;
    // A new address is printed with the page key where pages need it (D21), as the Page line.
    const moved = now && url && now.href !== url.href ? keyedUrl(now.href, await pageKey()) : null;
    out.push({ cwd: c.cwd, ok: Boolean(res && res.ok), error: res && res.error ? String(res.error) : null, moved });
  }
  return out;
}

const WHY = { refused: "it didn't accept the request to stop", 'no answer': "it didn't respond to the request to stop", 'still running': "it didn't stop in time" };

async function restart() {
  // Claude running from the page would stop itself; only the user may do that.
  if (process.env.EDITLENS_DRIVEN === '1') return { error: 'Claude running from the page can\'t restart EditLens', fix: ['/editlens restart', '', 'type it yourself in Claude Code:'] };
  const running = await health();
  if (running && running.busy) return { error: 'the running EditLens didn\'t respond in time', fix: ['/editlens restart', 'again in a moment', 'try'] };
  const connected = running ? await connectionsNow() : [];
  if (running) {
    // An older server doesn't save page control for the next one, so it is saved here.
    await noteOldControl(running);
    const issue = {};
    const stopped = await stopServer({ force: true, issue });
    if (stopped !== true) return { error: `the running EditLens${running.version ? ' ' + running.version : ''}: ${WHY[issue.why] || WHY['still running']}`, fix: ['/editlens restart', 'again', 'close Claude Code windows that still use it, then type'] };
  }
  const r = await ensureServer();
  const again = await reconnect(connected);
  const kept = pagekeep.onStart(pagekeep.read(path.join(config.stateDir, 'page-control-on.json')), { version: r.version || config.version });
  const pages = running && Number.isInteger(running.pages) && running.pages > 0 ? running.pages : 0;
  return { ok: true, started: !running, from: running ? running.version || null : null, version: r.version || config.version, control: kept && kept.restore ? kept.cwd : null, pages, again };
}

// Pages open before the restart reconnect within a few seconds (1 s, then 2 s, then 5 s). Waiting
// for them first means /editlens then finds them, and opens no second tab. -> true when back
async function waitForPages(count, ms = 10000) {
  const end = Date.now() + ms;
  while (count > 0 && Date.now() < end) {
    const h = await health();
    if (h && Number.isInteger(h.pages) && h.pages >= count) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return count <= 0;
}

// -> true when it restarted
function sayRestart(r) {
  if (r.error) {
    process.exitCode = 1;
    say.fail('Couldn\'t restart EditLens', r.error);
    say.fix(...r.fix);
    return false;
  }
  say.head('ok', r.started ? 'started' : 'restarted', r.from && r.from !== r.version ? `${r.from} → ${r.version}` : `EditLens ${r.version}`);
  say.blank();
  const again = Array.isArray(r.again) ? r.again : [];
  const ok = again.filter((a) => a.ok && !a.moved).length;
  if (ok) say.done(`Connected ${ok === 1 && again.length === 1 ? 'the page' : `${ok} page${ok === 1 ? '' : 's'}`} again`, 'at the same address');
  for (const a of again.filter((x) => x.ok && x.moved)) say.done(`Connected ${a.cwd} again`, `at a new address: ${a.moved}`);
  for (const a of again.filter((x) => !x.ok)) say.steps(`${a.cwd} is not connected: ${plainMessage(a.error) || 'no reason was given'}`, []);
  if (r.control) say.done('Page control starts again', `in ${r.control} when its page reconnects (a few seconds)`);
  if (!r.started) say.act('Open pages reconnect by themselves. Reload a page when it shows Update ready.');
  return true;
}

function sayFailed(err) {
  say.fail('Couldn\'t restart EditLens', plainMessage(err && err.message));
  say.fix('/editlens restart', 'again', 'try');
  process.exitCode = 1;
}

if (require.main === module) restart().then(sayRestart, sayFailed);

module.exports = { restart, sayRestart, sayFailed, waitForPages };
