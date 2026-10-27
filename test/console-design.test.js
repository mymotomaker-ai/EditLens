'use strict';
require('./isolate');
// Every console print in one design (handoff §8 layout B, §11, §2.5): a ✦ head, label ···· value
// rows with the values in one column, "✕ what went wrong" then "! Fix", plain words. It runs the code
// paths (every /editlens form and its error form, every hook, the button log, every user-facing literal
// in bin/, lib/, hooks/ and server/), so a new text is checked too.
// Ports 4327 (server), 4328 (pairing), 4329 (a dev server), 4330 (nothing listens).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { parse, labelText, MARK } = require('../lib/say');
const { killServer } = require('./kill');
const { stopChildren } = require('./launch');

const ROOT = path.join(__dirname, '..');
const WIDTH = 80; // cells: a layout line (head, label rows, commands) never wraps at 80 columns
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'el-design-'));
const home = path.join(base, 'home');
const project = path.join(base, 'site');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'index.html'), '<!doctype html><title>t</title><p>hi</p>\n');

function envFor(port, extra = {}) {
  const env = { ...process.env, HOME: home, EDITLENS_PORT: String(port), EDITLENS_PAIR_PORT: '4328', EDITLENS_STATE_DIR: path.join(base, 'state-' + port), EDITLENS_NO_BROWSER: '1', CLAUDE_PROJECT_DIR: project, EDITLENS_SAY: 'records', CLAUDE_PLUGIN_OPTION_START: 'Connect the page', ...extra };
  for (const k of ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'EDITLENS_SESSION_ID', 'EDITLENS_TYPED', 'CLAUDE_CODE_REMOTE']) if (!(k in extra)) delete env[k];
  fs.mkdirSync(env.EDITLENS_STATE_DIR, { recursive: true });
  return env;
}

function exec(file, args, opts) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [file, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 << 20, ...opts }, (err, stdout, stderr) => resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? err.code : 0 }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
  });
}

// A few at a time: each is a node process.
async function eachLimited(list, n, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  }));
  return out;
}

// --- The command forms, from the code ---------------------------------------------------------

// The mod's argumentHint ('[stop | control [take] | undo [N] | <dev server address or folder>]')
// expanded: each word, with and without its optional part; N is a number, <...> a port and a folder.
function hintForms() {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'mod.mjs'), 'utf8');
  const m = /argumentHint:\s*'\[(.*?)\]'/.exec(src);
  assert.ok(m, 'hooks/mod.mjs registers /editlens with an argumentHint');
  const forms = new Set(['']);
  for (const alt of m[1].split('|').map((s) => s.trim())) {
    if (/^</.test(alt)) {
      forms.add('4329');
      forms.add('no-such-folder');
      continue;
    }
    const words = alt.replace(/\[([^\]]+)\]/g, '').trim().replace(/\bN\b/g, '3');
    forms.add(words);
    for (const opt of alt.match(/\[([^\]]+)\]/g) || []) forms.add((words + ' ' + opt.slice(1, -1)).replace(/\bN\b/g, '3'));
  }
  return [...forms];
}

// Help for each topic lib/help.js knows, and one it doesn't.
function helpForms() {
  return ['help', ...Object.keys(require('../lib/help').MORE).map((k) => 'help ' + k), 'help zzz'];
}

// What each form does when something is wrong: a word too many, or a bad one.
function errorForms(forms) {
  const out = new Set(['zzz', 'stop zzz', 'undo zzz', 'restore', 'undo 3 zzz', 'new zzz', 'join zzz', 'join 1.2.3.4 zzz']);
  for (const f of forms) if (f && !/\d/.test(f)) out.add(f.split(' ')[0] + ' zzz');
  return [...out];
}

// Forms that change this computer beyond the test's folders: never run here.
//   task-user (bare) makes a system account; control with a server up downloads and starts page
//   control (so "What /editlens does" is set to Connect the page above). Their error forms run.
const DOWN_ONLY = /^control\b/;
const NEVER = /^task-user$/;

// --- The rules ----------------------------------------------------------------------------------

const cells = (t) => [...String(t)].length;
const CODES = /\b(?:E(?:CONNREFUSED|CONNRESET|NOENT|ACCES|PERM|ADDRINUSE|PIPE|TIMEDOUT|NOTFOUND|HOSTUNREACH|ROFS|NOSPC|EXIST|ISDIR|NOTDIR|AI_AGAIN)|ERR_[A-Z_]+)\b/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const LAYOUT = new Set(['head', 'field', 'row', 'item', 'cmd', 'cmds', 'meter', 'hint', 'title']);
const HELPED_BY = new Set(['fix', 'steps', 'hint', 'cmd', 'cmds']);

// Words a user should never read: our own prefix, raw errors, ids, stack lines, broken values.
function textProblems(line) {
  const out = [];
  if (/^\s*(?:✦\s*)?editlens\s*:/i.test(line)) out.push('starts with "editlens:"');
  if (/(?:^|\s)(?:\w*Error|Uncaught \w+):\s/.test(line)) out.push('raw "Error:" text');
  if (CODES.test(line)) out.push('raw error code ' + CODES.exec(line)[0]);
  if (UUID.test(line)) out.push('an id');
  if (/^\s+at .+:\d+:\d+\)?$/.test(line)) out.push('a stack line');
  if (/\b(?:undefined|NaN)\b|\[object Object\]/.test(line)) out.push('a broken value');
  return out;
}

// The records of one reply -> what breaks the design, as "where: line: why".
function recordProblems(list, where) {
  const out = [];
  const say = (r, why) => out.push(`${where}: ${JSON.stringify(r.plain ? r.plain.join('⏎') : r.text)}: ${why}`);
  list.forEach((r, i) => {
    if (r.raw) return say(r, 'printed outside lib/say.js (no record)');
    for (const line of r.plain) for (const why of textProblems(line)) say(r, why);
    // An old "Label: value" line instead of a label ···· value row.
    if (r.k === 'text' && /^[A-Z][A-Za-z ]{0,14}: \S/.test(r.plain[0] || '') && !/^(?:Note|Tip): /.test(r.plain[0])) say(r, 'a "Label: value" line, not a ···· row');
    if (LAYOUT.has(r.k)) for (const line of r.plain) if (cells(line) > WIDTH && !/https?:\/\/|\/\S+\/\S+/.test(line)) say(r, `${cells(line)} cells, over ${WIDTH}`);
    if (r.k === 'field' && r.label && !/^\S.*? ·{2,} $/.test(labelText(r))) say(r, 'no dotted leader');
    // Errors are two parts: what went wrong, then what to do (§2.5).
    if (r.k === 'fail') {
      const rest = list.slice(i + 1);
      const end = rest.findIndex((x) => x.k === 'head' || x.k === 'fail' || x.k === 'done');
      if (!(end < 0 ? rest : rest.slice(0, end)).some((x) => HELPED_BY.has(x.k))) say(r, 'a ✕ line with no ! Fix after it');
    }
  });
  // Values in one column: the rows of a block (fields, or command rows, next to each other) start
  // their values at the same cell.
  const valueAt = (r) => (r.k === 'field' ? cells(labelText(r)) : r.plain[0].indexOf(String(r.what), 2 + cells(r.cmd)));
  let block = [];
  const flush = () => {
    const at = new Set(block.map(valueAt));
    if (at.size > 1) say(block[0], `rows of one block start their values at cells ${[...at].join(' and ')}`);
    block = [];
  };
  for (const r of list) {
    if (block.length && r.k !== block[0].k) flush();
    if (r.k === 'field' || (r.k === 'cmd' && r.what)) block.push(r);
  }
  if (block.length) flush();
  return out;
}

// stdout -> records; lines outside lib/say.js are kept and marked raw.
function recordsOf(stdout) {
  return String(stdout).split(/\r?\n/).filter((l) => l.trim()).map((l) => (l.startsWith(MARK) ? parse(l)[0] : null) || { k: 'text', text: l, plain: [l], raw: true });
}

// --- The live server for the "up" pass ------------------------------------------------------------

let server = null;
let dev = null;
const up = (port) => new Promise((r) => http.get(`http://127.0.0.1:${port}/health`, (res) => {
  res.resume();
  r(res.statusCode === 200);
}).on('error', (err) => {
  if (!['ECONNREFUSED', 'ECONNRESET'].includes(err.code)) throw err;
  r(false);
}));

test.before(async () => {
  // A server left on 4327 by another run would answer in place of this test's own: stop with a reason.
  if (await up(4327)) throw new Error('port 4327 is in use by another EditLens server; stop it, then run this test again');
  dev = http.createServer((req, res) => res.end('<!doctype html><title>dev</title><p>dev</p>')).listen(4329, '127.0.0.1');
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env: envFor(4327), stdio: 'ignore' });
  for (let i = 0; i < 100 && !(await up(4327)); i++) await new Promise((r) => setTimeout(r, 100));
});

// The server on 4327's /health answer, or null when none answers.
const health = (port) => new Promise((r) => http.get(`http://127.0.0.1:${port}/health`, (res) => {
  let body = '';
  res.on('data', (c) => { body += c; });
  res.on('end', () => {
    try {
      r(JSON.parse(body));
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      r(null);
    }
  });
}).on('error', (err) => {
  if (!['ECONNREFUSED', 'ECONNRESET'].includes(err.code)) throw err;
  r(null);
}));

test.after(async () => {
  if (server) await stopChildren([server]);
  // A /editlens form that restarts the server leaves a new one, not `server`: stop it by its pid, only
  // when it is this test's server, and wait until it has ended before removing its folder.
  const h = await health(4327);
  if (h && Number.isInteger(h.pid)) killServer(h.pid, path.join(base, 'state-4327'));
  for (let i = 0; i < 50 && (await health(4327)); i++) await new Promise((r) => setTimeout(r, 100));
  if (dev) dev.close();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// --- The tests ------------------------------------------------------------------------------------

const replies = []; // [{ where, records }] for the button-log test

test('every /editlens reply, error, fix and hint is in the design, with the server down and up', async () => {
  const forms = [...hintForms(), ...helpForms()];
  const all = [...forms, ...errorForms(forms)].filter((f) => !NEVER.test(f));
  assert.ok(all.length > 40, `the scan found ${all.length} forms`);
  const runs = [
    ...all.map((f) => ({ f, port: 4330, env: { EDITLENS_NO_START: '1' } })),
    ...all.filter((f) => !DOWN_ONLY.test(f)).map((f) => ({ f, port: 4327, env: {} })),
  ];
  const problems = [];
  await eachLimited(runs, 6, async ({ f, port, env }) => {
    const out = await exec(path.join(ROOT, 'bin', 'start.js'), f ? f.split(' ') : [], { cwd: project, env: envFor(port, env) });
    const where = `/editlens ${f} (${port === 4327 ? 'server up' : 'server down'})`;
    const list = recordsOf(out.stdout);
    if (!list.length) problems.push(`${where}: printed nothing`);
    replies.push({ where, records: list });
    problems.push(...recordProblems(list, where));
  });
  // The scan saw the layouts it checks.
  const kinds = new Set(replies.flatMap((r) => r.records.map((x) => x.k)));
  for (const k of ['head', 'field', 'fail', 'fix', 'cmd', 'steps']) assert.ok(kinds.has(k), `the replies had a ${k} record`);
  assert.deepStrictEqual(problems, [], problems.join('\n'));
});

test('the one-row log of a button press, for each of those replies', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'hooks', 'mod.mjs')).href);
  assert.ok(replies.length, 'the replies were collected');
  const problems = [];
  for (const { where, records } of replies) {
    const line = mod.pressLine(records.filter((r) => !r.raw));
    if (!line) continue;
    const rows = line.split('\n');
    if (!/^✦ /.test(rows[0])) problems.push(`${where}: ${JSON.stringify(line)}: no ✦ head`);
    if (/^✦ ✕/.test(rows[0]) && !/^ {2}! Fix /.test(rows[1] || '')) problems.push(`${where}: ${JSON.stringify(line)}: no ! Fix`);
    for (const r of rows) for (const why of textProblems(r)) problems.push(`${where}: ${JSON.stringify(r)}: ${why}`);
  }
  assert.deepStrictEqual(problems, [], problems.join('\n'));
});

// A hook's input made from its event and its matcher in hooks.json.
function hookInputs(event, matcher) {
  const common = { session_id: 'scan', transcript_path: path.join(base, 'none.jsonl'), cwd: project, hook_event_name: event, permission_mode: 'default' };
  const tools = matcher ? matcher.replace(/^\.\*/, '').split('|').map((t) => t.replace(/[^\w-]/g, '')).filter(Boolean) : [];
  const toolInput = (t) => (/Bash|PowerShell/.test(t) ? [{ command: 'ls' }, { command: 'curl -s http://127.0.0.1:4327/control/take' }, { command: `node ${path.join(ROOT, 'bin', 'start.js')} new` }]
    : /WebFetch/.test(t) ? [{ url: 'http://127.0.0.1:4327/token', prompt: 'x' }]
      : /Edit|Write/.test(t) ? [{ file_path: path.join(project, 'index.html'), old_string: 'hi', new_string: 'hello', content: '' }]
        : /Agent|Task/.test(t) ? [{ description: 'look', prompt: 'look', subagent_type: 'Explore' }] : [{}]);
  switch (event) {
    case 'SessionStart': return ['startup', 'resume', 'clear', 'compact'].map((source) => ({ ...common, source }));
    case 'UserPromptSubmit': return [{ ...common, prompt: 'hello' }];
    case 'PreToolUse': case 'PostToolUse': return tools.flatMap((t) => toolInput(t).map((ti) => ({ ...common, tool_name: t, tool_input: ti, tool_response: {} })));
    case 'PermissionRequest': return [{ ...common, tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }];
    case 'Stop': case 'SubagentStop': return [{ ...common, stop_hook_active: false, agent_id: 'a1' }];
    case 'SubagentStart': return [{ ...common, agent_id: 'a1', agent_type: 'Explore' }];
    case 'SessionEnd': return [{ ...common, reason: 'other' }];
    default: return [common];
  }
}

// What the user reads from a hook's answer: systemMessage and a permission reason (the rest goes
// to Claude). Plain text there: the same words, ✕ then ! Fix, no "editlens:" in our own text.
let hookTexts = 0; // texts a hook showed the user, so the scan is known to have read some
function hookProblems(out, where) {
  const problems = [];
  let json = null;
  try {
    json = out.stdout.trim().startsWith('{') ? JSON.parse(out.stdout) : null;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    problems.push(`${where}: not JSON: ${out.stdout.slice(0, 80)}`);
  }
  if (!json) return problems;
  const shown = [json.systemMessage, json.hookSpecificOutput && json.hookSpecificOutput.permissionDecisionReason].filter((t) => typeof t === 'string');
  for (const text of shown) {
    hookTexts++;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const why of textProblems(line)) problems.push(`${where}: ${JSON.stringify(line)}: ${why}`);
      if (/^✕ /.test(line) && !/^! Fix /.test(lines[i + 1] || '')) problems.push(`${where}: ${JSON.stringify(line)}: a ✕ line with no ! Fix under it`);
    });
  }
  return problems;
}

test('every hook in hooks.json: what the user reads is in the design (terminal and desktop app)', async () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const runs = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        const m = /hooks\/([\w-]+\.js)" (\S+)/.exec(h.command);
        assert.ok(m, `${event}: a live-hook.js command`);
        for (const input of hookInputs(event, g.matcher)) {
          for (const surface of ['cli', 'claude-desktop']) {
            for (const port of [4330, 4327]) runs.push({ file: path.join(ROOT, 'hooks', m[1]), arg: m[2], input, surface, port, where: `${event} ${m[2]} ${input.source || input.tool_name || ''} (${surface}, server ${port === 4327 ? 'up' : 'down'})` });
          }
        }
      }
    }
  }
  assert.ok(runs.length > 40, `the scan found ${runs.length} hook runs`);
  const problems = [];
  await eachLimited(runs, 6, async (r) => {
    const env = envFor(r.port, { CLAUDE_CODE_ENTRYPOINT: r.surface, CLAUDE_PLUGIN_ROOT: ROOT, ...(r.port === 4330 ? { EDITLENS_NO_START: '1' } : {}) });
    delete env.EDITLENS_SAY;
    const out = await exec(r.file, [r.arg], { cwd: project, env, input: JSON.stringify(r.input), timeout: 15000 });
    problems.push(...hookProblems(out, r.where));
  });
  assert.ok(hookTexts > 0, 'some hook showed the user a text (the desktop welcome at least)');
  assert.deepStrictEqual(problems, [], problems.join('\n'));
});

// --- Every user-facing literal in the source --------------------------------------------------------

function sources() {
  const out = [];
  for (const dir of ['bin', 'lib', 'hooks', 'server']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) if (/\.(m?js)$/.test(name)) out.push(path.join(dir, name));
  }
  return out;
}

// The first string literal after a call's "(" -> its text, or null.
function firstLiteral(src, at) {
  const m = /^\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/.exec(src.slice(at));
  return m ? m[2] : null;
}

test('every user-facing literal: no "editlens:" prefix, and every ✕ has its ! Fix next to it', () => {
  const problems = [];
  for (const rel of sources()) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const lines = src.split('\n');
    const where = (i) => `${rel}:${src.slice(0, i).split('\n').length}`;
    // Rows Claude Code draws ($.ui.log not to the debug log, toasts, the status entry) and the
    // say.* texts: our own words, never our name with a colon at the start.
    const calls = /\$\.ui\.(log|toast|status)\(|\bsay\.(fail|done|head|text|field|fix|steps|hint|title|item|row|cmd|act)\(/g;
    for (let m; (m = calls.exec(src));) {
      const lit = firstLiteral(src, m.index + m[0].length);
      const rest = src.slice(m.index, src.indexOf('\n', m.index));
      if (m[1] === 'log' && /to: 'debug'/.test(rest)) continue;
      if (lit !== null && /^\s*editlens\s*:/i.test(lit)) problems.push(`${where(m.index)}: ${m[0]}'${lit.slice(0, 50)}': starts with "EditLens:"`);
    }
    // Text the user reads from a hook or a permission question.
    for (const m of src.matchAll(/(?:systemMessage|permissionDecisionReason|_REASON|\bREASON)\s*[:=]\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      if (/^\s*editlens\s*:/i.test(m[2])) problems.push(`${where(m.index)}: "${m[2].slice(0, 50)}": starts with "EditLens:"`);
    }
    // Every say.fail is followed by its fix (or the steps, hint or commands that say what to do).
    lines.forEach((line, i) => {
      if (!/\bsay\.fail\(/.test(line)) return;
      const next = lines.slice(i, i + 5).join('\n');
      if (!/\bsay\.(fix|steps|hint|cmd|cmds)\(|sayHelp\(/.test(next)) problems.push(`${rel}:${i + 1}: say.fail with no say.fix after it`);
    });
    // The mod's own records: a fail record has a fix record in the same list.
    lines.forEach((line, i) => {
      if (!/k: 'fail'/.test(line) || /=== 'fail'|case 'fail'|k === 'fail'/.test(line)) return;
      if (!/k: 'fix'/.test(lines.slice(i, i + 4).join('\n'))) problems.push(`${rel}:${i + 1}: a fail record with no fix record`);
    });
  }
  assert.deepStrictEqual(problems, [], problems.join('\n'));
});

test('the mod\'s own texts: errors, notices, Details and Settings in the design', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'hooks', 'mod.mjs')).href);
  const problems = [];
  // Every kind of error the mod turns into words.
  for (const e of [Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4317'), { code: 'ECONNREFUSED' }), new Error('timeout'), Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }), new Error('Claude Code returned an error result: No conversation found with session ID: f5aaa32e-616a-4598-b1bf-82fc6ed132e7'), new TypeError('x is not a function')]) {
    problems.push(...recordProblems(mod.errorRecords(e), 'errorRecords ' + e.message.slice(0, 30)));
  }
  for (const t of ['EditLens: Paired with ◆ laptop', 'Paired with ◆ laptop', '✕ The pairing code expired']) {
    for (const why of textProblems(mod.noticeText(t))) problems.push(`noticeText ${t}: ${why}`);
  }
  for (const why of textProblems(mod.WELCOME)) problems.push(`WELCOME: ${why}`);
  // The mod's copy of plainMessage says the same words.
  const { plainMessage } = require('../lib/plainerr');
  for (const t of ['Error: connect ECONNREFUSED 127.0.0.1:4317', 'Claude Code returned an error result: No conversation found with session ID: f5aaa32e-616a-4598-b1bf-82fc6ed132e7', 'spawn xdg-open ENOENT', 'TypeError: x is not a function\n    at y (z.js:1:2)', 'session 0b7c1e52-3f9a-4b8e-9d2c-111122223333 is busy', 'JSON.parse Invalid package.json: JSONParseError: Unexpected end of JSON input']) {
    if (mod.plainWords(t) !== plainMessage(t)) problems.push(`plainWords(${JSON.stringify(t)}) = ${JSON.stringify(mod.plainWords(t))}, lib/plainerr.js says ${JSON.stringify(plainMessage(t))}`);
  }
  problems.push(...recordProblems(mod.recordsFromText(mod.settingsText(require('../lib/settings').SCHEMA, {})), 'settingsText'));
  const summary = { live: true, version: '0.24.33', sessionId: 's', control: 'page', state: 'working', mode: 'acceptEdits', model: 'claude-opus-5-5', pages: [{ url: 'http://127.0.0.1:5173/', title: 'Demo' }], pageCount: 1, agents: [], agentCount: 0, agentsRunning: 0, tokens: { context: 48000, window: 200000, percent: 24 }, permissions: 0, connection: { kind: 'proxy', url: 'http://127.0.0.1:5173/' }, integrations: [] };
  problems.push(...recordProblems(mod.recordsFromText(mod.detailsText(summary)), 'detailsText'));
  assert.deepStrictEqual(problems, [], problems.join('\n'));
});
