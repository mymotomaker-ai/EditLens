#!/usr/bin/env node
'use strict';
// Pairing two computers (for example a laptop and a VPS).
// On the VPS: pair [open] prints a one-time code and the line to run on the laptop ("open" also
// accepts direct joins on the pairing port); pair off ends every pairing.
// On the laptop: join <[user@]address> <code> [--key "<file>"] [--ssh-port <n>] pairs; join lists
// paired computers; join off [name] unpairs. control <name> [new] [take] and manual <name> switch
// page control on that computer.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { ensureServer, postJson, getJson } = require('../lib/client');
const config = require('../lib/config');
const { appsByRecent } = require('../lib/connect');
const { isPrivate } = require('../server/pair-host');
const taskuser = require('../lib/taskuser');
const { controlArgs } = require('../lib/pairwire');
const { say, emit, fieldWidth } = require('../lib/say');
const connectBin = require('./connect');

// Claude Code runs as root on Linux and tasks would run as root: 'root' when Root (unsafe) is on
// (allowed in the EditLens window, setting still Root), 'account' when no task account is in use.
function rootNote() {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  const stateDir = require('../lib/config').stateDir;
  if (settings.given().values.task_account === 'Root (unsafe)' && rootAllowed(stateDir)) return 'root';
  if (taskuser.lookup() && !taskuser.isOff(stateDir)) return null;
  return 'account';
}

// The EditLens window's "allow" for Root (unsafe) (server/server.js ROOT_FILE).
function rootAllowed(stateDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, 'task-root.json'), 'utf8')).on === true;
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return false;
    throw err;
  }
}
const { openBrowser, canOpenBrowser, shownUrl, shownKey, KEY_PLACEHOLDER } = require('../lib/browser');
const { plainError, plainMessage } = require('../lib/plainerr');
const settings = require('../lib/settings');

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (!Number.isFinite(s)) return 'never';
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

// A link's state as a short value for the join list's value column (13 cells at most).
// -> [value, tone]
const STATE_VALUES = { connected: ['● Connected', 'ok'], connecting: ['○ Connecting', 'off'], reconnecting: ['! Connecting', 'warn'], refused: ['! Re-pair', 'warn'], off: ['○ Off', 'off'] };
function stateValue(state) {
  return STATE_VALUES[state] || ['○ Not connected', 'off'];
}

// /editlens join: the computers this one joined, then those that joined it, then a waiting code.
// Each name has a dotted line to its state; the line under it has the page or the fix.
function sayPaired(remotes, host) {
  const hosts = remotes.hosts || [];
  const pairs = host.pairs || [];
  if (!hosts.length && !pairs.length) {
    say.head(null, '', 'none yet', 'Paired computers');
    say.blank();
    say.steps('Pair', [{ n: 1, cmd: '/editlens pair', note: 'on the other computer' }, { n: 2, text: 'Type the line it prints here' }]);
  } else {
    say.head(null, '', '', 'Paired computers');
    const width = Math.max(...[...hosts, ...pairs].map((x) => [...`◆ ${x.name}`].length));
    if (hosts.length) {
      say.blank();
      say.text('This computer joined', true);
      for (const h of hosts) {
        const [value, tone] = stateValue(h.state);
        say.row(`◆ ${h.name}`, value, tone, { width });
        const seen = h.state !== 'connected' && h.lastSeen ? `last connected ${ago(h.lastSeen)}` : '';
        if (h.state === 'refused' || h.error) say.field('', `Remove: /editlens join off ${h.name}`, [h.error, seen].filter(Boolean).join(' · '), { width: 2 });
        else if (h.url) say.field('', shownUrl(h.keyUrl || h.url), [h.address, h.site ? '' : 'no site there yet: run /editlens on it', h.answers ? 'you can answer its questions' : ''].filter(Boolean).join(' · '), { link: true, width: 2 });
        else say.field('', [h.address, seen].filter(Boolean).join(' · '), '', { width: 2, dim: true });
      }
    }
    if (pairs.length) {
      say.blank();
      say.text('Joined this computer', true);
      for (const p of pairs) {
        say.row(`◆ ${p.name}`, p.connected ? '● Connected' : '○ Offline', p.connected ? 'ok' : 'off', { width });
        const about = [p.connected || !p.lastSeen ? '' : `last seen ${ago(p.lastSeen)}`, p.cwd].filter(Boolean).join(' · ');
        if (about) say.field('', about, '', { width: 2, dim: true });
      }
    }
  }
  if (host.waiting) {
    say.blank();
    say.text(`Pairing code open · ${host.waiting.minutesLeft} min left · /editlens pair off ends all pairings`, true);
  }
}

// /editlens join worked: the success block (layout B), as the other computer shows it.
function sayJoined(h, { ssh, opened }) {
  say.head('ok', `Paired with ◆ ${h.name}`, ssh ? 'through SSH · reconnects by itself' : 'reconnects by itself', '');
  say.blank();
  say.fields([
    ...(h.url ? [['Page', shownUrl(h.keyUrl || h.url), opened ? 'opened' : h.site ? '' : 'no site connected there yet: run /editlens on it, then reload', { link: true }]] : []),
    ['You can', 'open its page, give Claude there tasks'],
    ['Next', `/editlens control ${h.name}`, 'run Claude there', { cmd: true }],
    ['Remove', `/editlens join off ${h.name}`, '', { cmd: true }],
  ]);
}

// What a paired computer printed for control/manual, as one line plus its page.
// -> { mode: 'Auto · continues its last chat', page, fail: ['✕ …', '! Fix …'], take }
// take: null | 'idle' | 'working', set when page control runs in another project there.
function remoteSummary(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  // "! Fix  › /editlens control take to …" (0.24.33 and later) or "/editlens control take  …" (before).
  const hint = lines.find((l) => /^(?:! Fix\s+›\s+)?\/editlens control take\s/.test(l));
  const take = hint ? (/stop Claude there/.test(hint) ? 'working' : 'idle') : null;
  // "Control ··· ● Page control" (0.24.33 and later) or "Control  ● Page control" (before).
  const control = lines.find((l) => /^Control[\s·]+●\s*Page control/.test(l));
  const mode = control ? control.replace(/^Control[\s·]+●\s*Page control\s*·?\s*/, '').replace(/this chat/, 'its last chat') : '';
  const page = lines.map((l) => /^Page[\s·]+(https?:\/\/\S+)/.exec(l)).find(Boolean);
  return { mode, page: page ? page[1] : null, fail: lines.filter((l) => /^(✕|! Fix)/.test(l)), take };
}

// The other computer has no page of the paired folder open (bin/drive.js "wasn't opened in time").
function noPageThere(r) {
  return r.fail.some((l) => /wasn't opened in time/.test(l));
}

// The paired folder's page address on this computer, with this user's key (D11), or null.
async function pagedUrl(name) {
  const s = await getJson('/pair', 5000).catch((err) => {
    process.stderr.write(`(could not read the paired page's address: ${plainError(err)})\n`);
    return null;
  });
  const hosts = s && s.remotes && Array.isArray(s.remotes.hosts) ? s.remotes.hosts : [];
  const h = hosts.find((x) => x && typeof x.name === 'string' && x.name.toLowerCase() === String(name).toLowerCase());
  const url = h && (typeof h.keyUrl === 'string' ? h.keyUrl : h.url);
  return typeof url === 'string' && /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}\//.test(url) ? url : null;
}

// Pairing shares the project's page: connect it first when nothing is connected yet.
// -> { url } when it connected, { missing: true } when it couldn't, or null (already connected).
async function connectPage(cwd) {
  const s = await getJson(`/summary?cwd=${encodeURIComponent(cwd)}`, 5000).catch((err) => {
    process.stderr.write(`(could not ask EditLens whether the page is connected: ${plainError(err)})\n`);
    return null;
  });
  if (s && (s.connection || (Array.isArray(s.pages) && s.pages.length))) return null;
  const apps = appsByRecent(cwd, config.stateDir);
  if (apps.length !== 1) return null;
  const res = await connectBin.connectPage(apps[0], null);
  return res.problem ? { missing: true } : { url: res.url };
}

// The words of a pairing command: the first in lower case, so Pair and PAIR work. -> { first, word, rest }
// The failure line names what was being done.
function failText(argv) {
  const { word, rest } = pairWords(argv);
  const off = (rest[0] || '').toLowerCase() === 'off';
  if (word === 'pair') return off ? "Couldn't turn pairing off" : "Couldn't start pairing";
  if (word === 'join') return !rest.length ? "Couldn't list the paired computers" : off ? "Couldn't leave the paired computer" : "Couldn't join";
  if (word === 'control') return "Couldn't start page control";
  if (word === 'manual') return "Couldn't switch to Manual";
  return 'Pairing failed';
}

function pairWords(argv) {
  const [first, ...rest] = argv.map((a) => String(a).trim()).filter(Boolean);
  return { first: first || '', word: (first || '').toLowerCase(), rest };
}

// A key file's path from the words at rest[i]. A quoted path with spaces may arrive split at its
// spaces (the mod splits /editlens words at spaces). -> { value, next } (next: index of its last word)
function quotedValue(rest, i) {
  const q = /^["']/.exec(rest[i]);
  if (!q) return { value: rest[i], next: i };
  for (let j = i; j < rest.length; j++) {
    if ((j > i || rest[i].length > 1) && rest[j].endsWith(q[0])) return { value: rest.slice(i, j + 1).join(' ').slice(1, -1), next: j };
  }
  throw new Error(`the key file's path has no closing ${q[0]}.`);
}

// join's words after "join": --key/-i <file> and --ssh-port/-p <n>, the rest the address and code.
// -> { opts: { key, sshPort }, words }; throws when a flag has no value or the port isn't one.
function joinArgs(rest) {
  const opts = { key: null, sshPort: null };
  const words = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    // A flag with nothing after it would be read as part of the code.
    if (['--key', '-i', '--ssh-port', '-p'].includes(w) && !rest[i + 1]) throw new Error(w === '--key' || w === '-i' ? `${w} needs a key file after it.` : `${w} needs a port number after it.`);
    if ((w === '--key' || w === '-i') && rest[i + 1]) {
      const { value, next } = quotedValue(rest, i + 1);
      i = next;
      // The line as /editlens pair printed it, not filled in yet.
      if (value.trim() === KEY_PLACEHOLDER) throw new Error(`${KEY_PLACEHOLDER} is a placeholder: type where your key file is, for example --key "~/.ssh/id_ed25519".`);
      if (!value.trim()) throw new Error(`${w} needs a key file after it.`);
      opts.key = path.resolve(value.replace(/^~(?=$|[\\/])/, os.homedir()));
    }
    else if ((w === '--ssh-port' || w === '-p') && rest[i + 1]) {
      const n = /^\d{1,5}$/.test(rest[++i]) ? Number(rest[i]) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--ssh-port takes a port number from 1 to 65535, not "${rest[i]}".`);
      opts.sshPort = n;
    }
    else words.push(w);
  }
  return { opts, words };
}

async function main() {
  const { first: given, word, rest } = pairWords(process.argv.slice(2));
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  await ensureServer();
  // The server may have started before any hook sent it the settings (for example "Remote tasks"),
  // so send them now: pairing and page control read them. A Claude EditLens runs (EDITLENS_DRIVEN)
  // has its own defaults, not the user's: it sends nothing.
  // Only options Claude Code gave this command are a report, not the saved ones read without them.
  const env = settings.given();
  if (env.from === 'env' && process.env.EDITLENS_DRIVEN !== '1') {
    await postJson('/settings/report', { values: env.values, pid: process.pid }).catch((err) => {
      process.stderr.write(`(could not report the settings: ${plainError(err)})\n`);
    });
  }

  if (word === 'pair' && (rest[0] || '').toLowerCase() === 'off') {
    const res = await postJson('/pair/off', {});
    say.head('ok', res.removed ? `unpaired ${res.removed === 1 ? 'the computer' : `all ${res.removed} computers`}` : 'nothing was paired', 'the pairing port is closed');
    if (res.controlEnded) {
      say.blank();
      say.field('Control', '○ Page control ended', 'the paired computer turned it on; its chat is in claude --resume');
    }
    return;
  }
  if (word === 'pair' && (rest.length > 1 || (rest[0] && rest[0].toLowerCase() !== 'open'))) {
    process.exitCode = 1;
    say.fail(`"${rest.join(' ').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40)}" isn't a word /editlens pair knows`);
    say.fix('/editlens pair', 'alone, /editlens pair open, or /editlens pair off');
    return;
  }
  if (word === 'pair') {
    const direct = (rest[0] || '').toLowerCase() === 'open';
    const connected = await connectPage(cwd);
    const res = await postJson('/pair', { cwd, direct });
    if (res.error) throw new Error(res.error);
    const first = res.addresses[0] || null;
    const host = first || 'THIS-COMPUTERS-ADDRESS';
    const port = res.port === 4318 ? '' : `:${res.port}`;
    const sshOpts = res.sshPort ? ` --ssh-port ${res.sshPort}` : '';
    const sshLine = `/editlens join ${res.user || 'USER'}@${host}${port} ${res.code}${sshOpts}`;
    // The same with a key file: the one the computers that joined here used, else the placeholder.
    const keyLine = `${sshLine} --key "${shownKey(res.keyPath)}"`;
    const directLine = `/editlens join ${host}${port} ${res.code}`;
    // Layout B, as the Settings pane: one value column for the rows above and below the line to type.
    const width = fieldWidth(['Open for', 'Code works', 'This computer', 'Page', 'Cancel']);
    // pairing: this code's id, so the mod can mark this reply as done once the code is used.
    emit({ k: 'head', title: 'Pair another computer', pairing: res.id || null });
    say.blank();
    say.fields([
      ['Open for', `${res.minutes} min`],
      ['Code works', 'once'],
      ['This computer', `${res.user || 'USER'}@${res.name}`],
      ...(connected && connected.url ? [['Page', shownUrl(connected.url), 'connected for the other computer', { link: true }]] : []),
    ], width);
    if (connected && connected.missing) say.steps('Your page isn\'t connected yet: run /editlens, so the other computer has a page to open', []);
    say.blank();
    say.steps('On your other computer, type this in Claude Code:', []);
    // These lines are copied, so they are never wrapped or indented.
    if (res.direct) {
      say.code(directLine, true);
      say.text(`Needs port ${res.port} open in this computer's firewall. Without that, type one of these instead (through SSH, with a key login):`, true);
    }
    // Through SSH: the plain line (your usual key), then the same with a key file.
    say.copyLines(sshLine, keyLine);
    say.text('Type it yourself; Claude can\'t run it.', true);
    if (!first) say.text('Replace THIS-COMPUTERS-ADDRESS with the address you SSH to.');
    if (first && isPrivate(first)) say.text(`${first} is a private address. If you connect to this computer with another address (its public IP or name), use that instead.`);
    if (!res.user) say.text('Replace USER with the account you log in with.');
    say.blank();
    say.fields([['Cancel', '/editlens pair off', 'also ends every pairing', { cmd: true }]], width);
    const root = rootNote();
    if (root === 'root') {
      say.blank();
      say.fail('Root (unsafe) is on', 'tasks from paired computers run as root here');
      say.fix('/config', 'and set "Run their tasks as" back to Auto (search "editlens")', 'open');
    } else if (root) {
      say.blank();
      say.steps('Tasks would run as root here', [], { text: 'Fix it:', cmd: '/editlens task-user' });
    }
    return;
  }
  if (word === 'join' && !rest.length) {
    const s = await getJson('/pair', 5000);
    sayPaired(s.remotes || { hosts: [] }, s.host || { pairs: [] });
    return;
  }
  if (word === 'join' && rest[0].toLowerCase() === 'off') {
    const res = await postJson('/join/off', { name: rest[1] || '' }, { timeoutMs: 30000 });
    if (res.error) throw new Error(res.error);
    if (!res.removed.length) return say.head(null, '', 'this computer has not joined another one');
    for (const r of res.removed) {
      if (r.joinedHere) say.done(`Unpaired ◆ ${r.name}`, 'it had joined this computer; it shows Re-pair until /editlens join off there');
      else say.done(`Unpaired ◆ ${r.name}`, r.told ? '' : 'here only: it could not connect to it. If it still lists this computer, /editlens pair off there removes it');
    }
    return;
  }
  if (word === 'join') {
    const { opts, words } = joinArgs(rest);
    if (words.length < 2) throw new Error('give the address and the code: /editlens join <address> <code>. /editlens pair on the other computer prints the whole line.');
    const ssh = words[0].includes('@');
    const res = await postJson('/join', { address: words[0], code: words.slice(1).join(''), ...opts }, { timeoutMs: 45000 }).catch((err) => ({ error: String((err && err.message) || err).replace(/^server answered \d+: /, '') }));
    if (res.error) {
      let why = res.error;
      try {
        why = JSON.parse(why).error || why;
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      }
      process.exitCode = 1;
      // ssh's own words, or the server's for them (server/ssh-tunnel.js sshError).
      const keyRefused = ssh && /permission denied|publickey|could not log in with a key/i.test(why);
      say.fail('Couldn\'t pair', keyRefused ? 'the other computer refused your SSH key' : plainMessage(why));
      if (keyRefused) {
        say.blank();
        const port = opts.sshPort ? ` --ssh-port ${opts.sshPort}` : '';
        say.steps('Fix', [{ text: 'Type the line again with the key file you use for this server:' }]);
        say.code(`/editlens join ${words.join(' ')}${port} --key "${KEY_PLACEHOLDER}"`, true);
      } else say.fix('/editlens pair', 'there for a new code, then type the line it prints here', 'on the other computer, run');
      return;
    }
    const h = res.host;
    // With this user's key (D11): the first visit sets the browser's cookie.
    const opened = h.url && openBrowser(h.keyUrl || h.url);
    sayJoined(h, { ssh, opened });
    return;
  }
  if (word === 'control' || word === 'manual') {
    const name = rest[0];
    if (!name) throw new Error(`give the name of a paired computer: /editlens ${word} <name>. /editlens join lists them.`);
    // No browser here: page control starts there once its page is opened here (0.24.41 and later there).
    const later = word === 'control' && !canOpenBrowser().ok;
    const args = word === 'manual' ? ['manual'] : [...controlArgs(rest.slice(1)).filter((a) => a !== 'manual'), ...(later ? ['--later'] : [])];
    const ask = async () => {
      const out = await postJson('/join/control', { name, args }, { timeoutMs: 9 * 60000 });
      if (out.error) throw new Error(out.error);
      return out;
    };
    let res = await ask();
    let r = remoteSummary(res.text);
    // Its page is opened on this computer, through the pairing link: the address here, not there.
    const here = word === 'control' && !res.ok && noPageThere(r) ? await pagedUrl(name) : null;
    if (here && canOpenBrowser().ok && openBrowser(here)) {
      const end = Date.now() + 120000;
      while (!res.ok && noPageThere(r) && Date.now() < end) {
        await new Promise((ok) => setTimeout(ok, 2000));
        res = await ask();
        r = remoteSummary(res.text);
      }
    }
    if (!res.ok) {
      process.exitCode = 1;
      // Its reason, then one fix for this computer to type (layout 7.3): never its lines as they are.
      const why = r.fail.map((l) => /^✕ [^:]*(?:: (.*))?$/.exec(l)).find(Boolean);
      say.fail(word === 'manual' ? `◆ ${name} didn't switch to Manual` : `Page control didn't start on ◆ ${name}`, why && why[1] ? plainMessage(why[1]) : '');
      if (!r.fail.length && res.text) for (const l of res.text.split('\n')) if (l.trim()) say.text(l.trim(), true);
      // Claude runs from another project's page there: the same one step, for that computer.
      if (r.take) say.fix(`/editlens control ${name} take`, r.take === 'working' ? 'to stop Claude there and move it to the paired project (that page switches to Manual)' : 'to move it to the paired project (that page switches to Manual)');
      else if (here) say.fix(`/editlens ${word} ${name}`, '', `open ${shownUrl(here)} here, then`);
      // The setting is off there (server/pair-host.js control()): the same command fails until it is on.
      // That computer removed the pairing while page control started (server.js grantDriveNow): pair again.
      else if (/The pairing was removed during the start/.test(String(res.text || ''))) {
        say.fix('/editlens pair', 'there for a new code, then type the line it prints here', 'on the other computer, run');
      } else if (/"Paired computers can run Claude here"/.test(String(res.text || ''))) {
        say.fix(`/editlens ${word} ${name}`, '', `on ◆ ${name}, turn on "Paired computers can run Claude here" in /config, then`);
      } else {
        const fix = r.fail.find((l) => /^! Fix/.test(l));
        const before = fix ? fix.replace(/^! Fix\s+/, '').split(/\s*›\s*/)[0].trim() : '';
        // An address there is not one this computer opens.
        say.fix(`/editlens ${word} ${name}`, '', before && !/^\/editlens/.test(before) && !/https?:\/\//.test(before) ? before : 'try again:');
      }
      return;
    }
    if (word === 'manual') {
      say.done(`◆ ${name} back to Manual`);
      return;
    }
    if (later && /page control starts when its page is open/.test(res.text)) {
      const at = await pagedUrl(name);
      say.done(`◆ ${name}: page control starts when its page is open here`);
      say.blank();
      if (at) say.field('Page', shownUrl(at), 'open it in your browser', { link: true });
      say.field('Back', `/editlens manual ${name}`, '', { cmd: true });
      return;
    }
    say.done(`Page control on ◆ ${name}`, r.mode ? '· ' + r.mode : '');
    if (r.page) {
      say.blank();
      say.field('Page', shownUrl(r.page), '', { link: true });
      say.field('Back', `/editlens manual ${name}`, '', { cmd: true });
    }
    return;
  }
  throw new Error(`"${given}" isn't a pairing word`);
}

if (require.main === module) {
  main().catch((err) => {
    say.fail(failText(process.argv.slice(2)), connectBin.errorText(err));
    say.fix('/editlens help pair', 'for the pairing steps');
    process.exitCode = 1;
  });
}

module.exports = { pairWords, joinArgs, sayPaired, sayJoined, failText, remoteSummary, rootNote };
