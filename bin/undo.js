#!/usr/bin/env node
'use strict';
// /editlens undo [N [back]] and /editlens restore N [back]: the page's "Undo only this edit" and
// Restore, through the live server's hook-key routes. Never starts a server (none running means
// nothing to undo). undo: list this session's edits, numbered as on the page. undo N: undo only
// edit N. restore N: the whole file from before edit N. back: reverse that.
const path = require('path');
const { pathToFileURL } = require('url');
const { request, readToken, DOWN_CODES } = require('../lib/client');
const { say, emit } = require('../lib/say');
const { plainError } = require('../lib/plainerr');

const MAX_N = 999999;

// Words a person typed, safe to print back: one line, at most 20 characters.
function shown(word) {
  return String(word || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 20);
}

// The words after /editlens. -> { cmd: 'list', word } | { cmd: 'undo'|'restore', n, back }
// | { error: 'bad-n'|'extra'|'unknown', word, cmd }. N is digits only: no "3.0", "1e3", "-1" or "0".
function parseArgs(words) {
  const list = (Array.isArray(words) ? words : []).map((w) => String(w).trim()).filter(Boolean);
  const cmd = (list[0] || '').toLowerCase();
  if (cmd !== 'undo' && cmd !== 'restore') return { error: 'unknown', cmd, word: shown(list[0]) };
  if (list.length === 1) return { cmd: 'list', word: cmd };
  const n = /^[1-9]\d{0,5}$/.test(list[1]) ? Number(list[1]) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_N) return { error: 'bad-n', cmd, word: shown(list[1]) };
  if (list.length > 3 || (list.length === 3 && list[2].toLowerCase() !== 'back')) return { error: 'extra', cmd, word: shown(list.slice(2).join(' ')) };
  return { cmd, n, back: list.length === 3 };
}

// A hook-key call. -> { status, json } (json null when the answer isn't JSON) or { down: true }
async function call(method, urlPath, body) {
  const attempt = () => request(method, urlPath, body, 10000, { 'x-editlens-token': readToken() });
  let res;
  try {
    res = await attempt();
    // The server restarted since the key was read and has written a new one.
    if (res.status === 401) res = await attempt();
  } catch (err) {
    if (DOWN_CODES.has(err.code)) return { down: true };
    throw err;
  }
  try {
    return { status: res.status, json: JSON.parse(res.body) };
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { status: res.status, json: null };
  }
}

function where(env = process.env) {
  return { session: String(env.EDITLENS_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || '').slice(0, 100), cwd: env.CLAUDE_PROJECT_DIR || process.cwd() };
}

function sayDown() {
  say.fail("EditLens isn't running");
  say.fix('/editlens', 'to start it and connect your page');
}

// The list: "✦ Recent edits · this session", then rows as on the page's Changes list:
// "N  file  folder/ ····· counts", with who made it, the time and the reason dimmed below.
function sayList(m, edits, now) {
  if (!edits.length) {
    say.head(null, '', 'this session · none yet', 'Recent edits');
    return;
  }
  // The numbers in one column ("3   " beside "12  "), then the file name and its folder.
  const nw = Math.max(...edits.map((e) => String(e.n).length)) + 2;
  const label = (e) => {
    const { name, folder } = m.fileParts(e.file);
    const head = String(e.n).padEnd(nw) + name;
    const dir = m.folderFit(folder, 50 - m.cells(head));
    return head + (dir ? '  ' + dir : '');
  };
  const width = Math.max(...edits.map((e) => m.cells(label(e))));
  say.head(null, '', 'this session', 'Recent edits');
  say.blank();
  for (const e of edits) {
    // The row's value column is 13 cells: a new file's count without "lines" past that.
    const counts = m.editCounts(e);
    if (counts) say.row(label(e), m.cells(counts) > 13 ? 'New · +' + e.added : counts, 'off', { width });
    else say.text(label(e));
    const under = [m.editWho(e, null), m.editTime(e.time, now), e.canUndo || e.canRestore ? '' : "can't be undone here", counts ? '' : 'lines not known yet', e.reason].filter(Boolean).join(' · ');
    say.text(' '.repeat(nw) + (m.cells(under) > 76 - nw ? [...under].slice(0, 75 - nw).join('') + '…' : under), true);
  }
  say.blank();
  say.hint(['/editlens undo N', 'only this edit'], ['/editlens restore N', 'the whole file']);
  say.text(m.RESTORE_NOTE, true);
}

// What the server said about one undo or restore.
function sayOutcome(m, p, out) {
  if (out.kind === 'down') {
    sayDown();
    return false;
  }
  if (out.kind === 'ok') {
    say.done(out.text);
    if (!p.back) say.hint([`/editlens ${p.cmd} ${p.n} back`, 'puts it back']);
    return true;
  }
  if (out.kind === 'conflict') {
    // The mod puts the message in the prompt and replaces the copy lines (filledRecords).
    say.steps(m.CONFLICT_LINE, []);
    emit({ k: 'text', text: m.COPY_NOTE, copyNote: true });
    emit({ k: 'code', text: out.message, prompt: out.message });
    return true;
  }
  say.fail(out.text);
  if (out.undone) say.fix(`/editlens undo ${p.n} back`, 'puts it back');
  else say.fix('/editlens undo', 'lists the edits you can undo');
  return false;
}

function sayBad(p) {
  if (p.error === 'bad-n') say.fail(`"${p.word}" isn't an edit number`, 'use a whole number from 1, as on the page');
  else if (p.error === 'extra') say.fail(`"${p.word}" isn't something /editlens ${p.cmd} knows`, 'only "back" can follow the number');
  else say.fail(`"${p.word}" isn't something /editlens knows`);
  say.fix('/editlens undo', 'lists the edits and their numbers');
}

async function main(argv, env = process.env) {
  const m = await import(pathToFileURL(path.join(__dirname, '..', 'hooks', 'mod.mjs')).href);
  const p = parseArgs(argv);
  if (p.error) {
    sayBad(p);
    return 1;
  }
  const w = where(env);
  if (p.cmd === 'list') {
    const r = await call('GET', `/edits/recent?session=${encodeURIComponent(w.session)}&cwd=${encodeURIComponent(w.cwd)}`);
    if (r.down) {
      sayDown();
      return 1;
    }
    if (!r.json || !Array.isArray(r.json.edits)) {
      // A status code is not plain English; say only that the server's answer was unusable.
      say.fail("EditLens couldn't list the edits", 'the server gave an answer EditLens can\'t read');
      say.fix('/editlens details', 'to see whether the server is running');
      return 1;
    }
    sayList(m, m.recentEdits(r.json), Date.now());
    return 0;
  }
  const r = await call('POST', `/edits/${p.cmd}`, { n: p.n, ...(p.back ? { back: true } : {}), ...w });
  return sayOutcome(m, p, m.outcomeOf(r, { action: p.cmd, n: p.n, back: p.back })) ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (err) => {
    say.fail("EditLens couldn't do this", plainError(err));
    say.fix('/editlens details', 'to see whether the server is running');
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, main, where };
