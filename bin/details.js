#!/usr/bin/env node
'use strict';
// Prints the Details pane as text where the mod can't draw it (e.g. the desktop Code tab).
// Session from CLAUDE_CODE_SESSION_ID, project from cwd. Starts the server if needed.
// "agents": the agents list. "sessions": the Sessions list. "stop <name>": stops the session or
// task with that name (only when the user typed it).
const { pathToFileURL } = require('url');
const path = require('path');
const config = require('../lib/config');
const { getJson, request, readToken, DOWN_CODES } = require('../lib/client');
const { plainError } = require('../lib/plainerr');
const { say } = require('../lib/say');

const LABELS = { terminal: 'the terminal', desktop: 'the desktop app', mobile: 'the mobile app', vscode: 'VS Code' };
const named = (list) => list.map((s) => LABELS[s] || s).join(', ');

function displayText(d, serverVersion) {
  // A server from before an update is still running: it can't report this yet.
  if (serverVersion && serverVersion !== config.version) return `EditLens was updated to ${config.version}, but the part that is running is still ${serverVersion}. Restart Claude Code to finish the update.`;
  if (!d) return "Line above the prompt: Claude Code hasn't reported on it yet. Run this again a few seconds after Claude Code starts.";
  if (d.drawn.length) return `Line above the prompt: shown in ${named(d.drawn)}.`;
  const where = d.surfaces.length ? ` This session draws on ${named(d.surfaces)}.` : '';
  return `Line above the prompt: Claude Code hasn't asked to show it in this session.${where} Run /editlens details any time for this summary.`;
}

// POST /sessions/stop to a server that is running (none running: nothing to stop).
// -> { status, json } or { down: true }
async function stopByName(cwd, name) {
  let res;
  try {
    res = await request('POST', '/sessions/stop', { cwd, name }, 15000, { 'x-editlens-token': readToken() });
  } catch (err) {
    if (!DOWN_CODES.has(err.code)) throw err;
    return { down: true };
  }
  try {
    return { status: res.status, json: JSON.parse(res.body) };
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { status: res.status, json: null };
  }
}

(async () => {
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (process.argv[2] === 'stop') {
    const mod = await import(pathToFileURL(path.join(__dirname, '..', 'hooks', 'mod.mjs')).href);
    const name = process.argv.slice(3).join(' ');
    const list = mod.stopNameRecords(await stopByName(cwd, name), name);
    if (list.some((r) => r.k === 'fail')) process.exitCode = 1;
    return say.records(list);
  }
  if (process.argv[2] === 'sessions') {
    const mod = await import(pathToFileURL(path.join(__dirname, '..', 'hooks', 'mod.mjs')).href);
    const data = await getJson(`/sessions?cwd=${encodeURIComponent(cwd)}`);
    return say.records(mod.recordsFromText(mod.sessionsText(data, { cwd })));
  }
  const session = process.env.CLAUDE_CODE_SESSION_ID || '';
  const s = await getJson(`/summary?cwd=${encodeURIComponent(cwd)}&session=${encodeURIComponent(session)}`);
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'hooks', 'mod.mjs')).href);
  if (process.argv[2] === 'agents') return say.records(mod.recordsFromText(mod.agentsText(s)));
  // The same rows as the mod's Details pane, as records (the mod draws them in colour).
  say.records(mod.recordsFromText(mod.detailsText(s)));
  say.blank();
  say.text(displayText(s && s.display, s && typeof s.version === 'string' ? s.version : null), true);
})().catch((err) => {
  if (!(err instanceof Error)) throw err;
  say.fail('Couldn\'t read the EditLens status', plainError(err));
  say.fix('/editlens', 'starts EditLens, then try again');
  process.exitCode = 1;
});
