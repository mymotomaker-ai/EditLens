'use strict';
// The EditLens window: the only place to allow a permission question or turn on a less strict mode.
// Served from this server's origin, never the app's: Claude edits the app, so it could use the app's
// page to approve its own requests. The app's page can Deny (safe) and open this window but can't read
// or script it: the key is only in this window's HTML, it can't be framed, and shares no window with the app.
// Through a pairing link only when the setting paired_answers is on (page control and its tasks only).
// Not covered: a program running as the same user here; Claude Code's own permission checks cover that.
const crypto = require('crypto');

const LOOSE_MODES = new Set(['acceptEdits', 'bypassPermissions']);
const CONFIRM_MS = 5 * 60000;
// Running paired computers' tasks as root (setting "Root (unsafe)") needs the user to allow it here.
const ROOT_TITLE = 'RUN PAIRED COMPUTERS\' TASKS AS ROOT';
const ROOT_WARNING = 'DANGER: AS ROOT, A TASK CAN READ, CHANGE OR DELETE ANYTHING ON THIS COMPUTER: EVERY PROJECT, SSH KEYS, PASSWORDS AND SYSTEM FILES. ONE MISTAKE, OR TEXT IN A FILE OR WEB PAGE, CAN MAKE CLAUDE DAMAGE THE SERVER OR SHOW ITS DATA, OR GIVE SOMEONE ELSE CONTROL OF IT. USE THE EDITLENS ACCOUNT INSTEAD (/editlens task-user) UNLESS YOU ARE SURE.';
const MODE_TITLES = { acceptEdits: 'Switch to Accept edits', bypassPermissions: 'Turn on Bypass permissions' };
const MODE_TEXT = {
  acceptEdits: 'Claude edits files without asking you first. It still asks before commands.',
  bypassPermissions: 'Claude won\'t ask before anything: it edits and deletes files and runs commands without asking you. Use it only on a project you can restore, like one with every change committed to git.',
};

// Less strict settings that came without Claude Code's saved settings (server.js reportSettings).
const SETTING_NOTE = 'This change is not in Claude Code\'s saved settings (/config), so nothing changes until you allow it here. If you didn\'t make it, keep the current setting.';
function settingText(key, value, from) {
  if (key === 'safety_check') return { title: 'Turn off the safety check', warning: 'Claude can then replace most of a file without asking.' };
  if (key === 'remote_tasks') return { title: 'Let paired computers run Claude here', warning: 'Paired computers can then run Claude on this computer.' };
  if (key === 'paired_answers') return { title: 'Let paired computers answer questions here', warning: 'A computer that joined this one can then allow Claude\'s actions here, from its own EditLens window.' };
  if (key === 'permission_mode') return { title: `Page control: use ${value}`, warning: `Claude then asks you less often than in ${from}.` };
  return { title: `Change ${key}`, warning: null };
}

class AnswerDesk {
  // pairAnswers(): the setting "Paired computers can answer questions here"; inPair(pair, cwd): the
  // folder is in that pairing's project.
  constructor({ pairAnswers = () => false, inPair = () => false } = {}) {
    this.pairAnswers = pairAnswers;
    this.inPair = inPair;
    this.key = crypto.randomBytes(32).toString('hex');
    this.confirms = new Map(); // id -> { id, kind: 'mode', agent, mode, ts }
  }

  keyOk(given) {
    const a = Buffer.from(String(given || ''));
    const b = Buffer.from(this.key);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // A less strict mode asked for by the app's page waits for this window.
  // agent: null for Claude, else the subagent's card key; mode null = same as Claude.
  // runId: the page-control run it was asked in; it never applies to a later run.
  requestMode(agent, mode, label, runId = null) {
    this.sweep();
    // The newest request replaces older ones.
    for (const c of this.confirms.values()) if (c.kind === 'mode' && c.agent === agent) this.confirms.delete(c.id);
    const c = { id: crypto.randomBytes(6).toString('hex'), kind: 'mode', agent, mode, label: label || null, runId: runId || null, ts: Date.now() };
    this.confirms.set(c.id, c);
    return c;
  }

  // When the setting is Root, one request waits here until the user answers it.
  requestRoot() {
    this.sweep();
    for (const c of this.confirms.values()) if (c.kind === 'root') return c;
    const c = { id: crypto.randomBytes(6).toString('hex'), kind: 'root', ts: Date.now() };
    this.confirms.set(c.id, c);
    return c;
  }

  // A less strict setting that came with the hook key but is not in Claude Code's saved settings
  // (server.js reportSettings): one request per setting, kept until it is answered or the report
  // changes. from: the value in effect now.
  requestSetting(key, value, from) {
    this.dropSetting(key);
    const c = { id: crypto.randomBytes(6).toString('hex'), kind: 'setting', key, value, from, ts: Date.now() };
    this.confirms.set(c.id, c);
    return c;
  }

  dropSetting(key) {
    for (const c of [...this.confirms.values()]) if (c.kind === 'setting' && c.key === key) this.confirms.delete(c.id);
  }

  dropRoot() {
    for (const c of [...this.confirms.values()]) if (c.kind === 'root') this.confirms.delete(c.id);
  }

  rootWaiting() {
    this.sweep();
    return [...this.confirms.values()].some((c) => c.kind === 'root');
  }

  take(id) {
    this.sweep();
    const c = this.confirms.get(String(id || ''));
    if (c) this.confirms.delete(c.id);
    return c || null;
  }

  // Mode requests from a page-control run that has ended. runId: the run going now, or null.
  dropModes(runId = null) {
    for (const c of [...this.confirms.values()]) if (c.kind === 'mode' && c.runId !== runId) this.confirms.delete(c.id);
  }

  sweep() {
    const now = Date.now();
    // The root request stays while the setting is Root.
    for (const c of [...this.confirms.values()]) if (c.kind !== 'root' && c.kind !== 'setting' && now - c.ts > CONFIRM_MS) this.confirms.delete(c.id);
  }

  pairAllowed() {
    return this.pairAnswers() === true;
  }

  // What a paired computer may answer: page control in its project, and the tasks it gave. Never a
  // setting, root or a mode change (those are answered on this computer only).
  pairCan(pair, body, { drive, task }) {
    if (!this.pairAllowed() || !body) return false;
    if (body.kind === 'drive') return Boolean(drive && drive.active && this.inPair(pair, drive.cwd) && (drive.permissions || []).some((p) => p.id === String(body.id || '')));
    if (body.kind === 'task') return Boolean(task && task.pairId === pair.id);
    return false;
  }

  // All waiting questions, oldest first. drive: driver.status(); tasks: Task objects; asks: Asks.
  // pair: the pairing the window is open through (only what pairCan allows, plus its project's
  // questions in Claude Code, which are answered there).
  list({ drive, tasks, asks, host, pair = null }) {
    this.sweep();
    if (drive) this.dropModes(drive.active ? drive.runId || null : null);
    if (pair) return this.pairList({ drive, tasks, asks, host, pair });
    const out = [];
    const sub = (id) => `A subagent${id ? ' (' + String(id).slice(-4) + ')' : ''}`;
    if (drive && drive.active) {
      for (const p of drive.permissions || []) {
        out.push({ key: `p:${p.id}`, kind: 'drive', id: p.id, who: `${p.agentId ? sub(p.agentId) : 'Claude'} in page control`, title: p.title, detail: p.detail || null,
          note: p.note || null, warning: p.warning || null, canAlways: Boolean(p.canAlways), ts: p.ts });
      }
    }
    for (const c of this.confirms.values()) {
      if (c.kind === 'root') {
        out.push({ key: 'root', kind: 'root', id: c.id, who: 'EditLens setting on this computer', title: ROOT_TITLE, detail: null,
          note: 'You chose "Root (unsafe)" for "Run paired computers\' tasks as". Nothing changes until you allow it here. Keep the safe account: set it back to Auto in /config.',
          warning: ROOT_WARNING, danger: true, canAlways: false, ts: c.ts });
        continue;
      }
      if (c.kind === 'setting') {
        const s = settingText(c.key, c.value, c.from);
        out.push({ key: `s:${c.key}`, kind: 'setting', id: c.id, who: 'EditLens setting on this computer', title: s.title, detail: null,
          note: SETTING_NOTE, warning: s.warning, canAlways: false, ts: c.ts });
        continue;
      }
      out.push({ key: `m:${c.id}`, kind: 'mode', id: c.id, who: c.agent ? `${c.label || 'A subagent'} in page control` : 'Claude in page control',
        title: MODE_TITLES[c.mode] || 'Change the permission mode', detail: null, note: c.mode === null ? 'Same mode as Claude.' : MODE_TEXT[c.mode] || null,
        warning: c.mode === 'bypassPermissions' ? 'Claude won\'t ask before anything.' : null, canAlways: false, ts: c.ts });
    }
    for (const t of tasks) {
      for (const p of t.permissions.values()) {
        out.push({ key: `t:${t.id}:${p.id}`, kind: 'task', task: t.id, id: p.id, who: `Task from ◆ ${t.by}`, title: p.title, detail: p.detail || null,
          note: p.note || null, warning: p.warning || null, canAlways: Boolean(p.canAlways), ts: p.ts || t.updatedAt });
      }
    }
    for (const q of asks.list(() => true)) {
      out.push({ key: `a:${q.id}`, kind: 'ask', id: q.id, who: `${q.agentId ? sub(q.agentId) : 'Claude'} in Claude Code`, title: q.title, detail: q.detail || null,
        note: q.note || null, warning: null, canAlways: false, readOnly: true, ts: q.ts });
    }
    // A time that is not a finite number counts as 0 (first): Infinity - Infinity would be NaN.
    const at = (q) => (Number.isFinite(Number(q.ts)) ? Number(q.ts) : 0);
    return { host, questions: out.sort((a, b) => at(a) - at(b)) };
  }

  pairList({ drive, tasks, asks, host, pair }) {
    const all = this.list({ drive, tasks, asks, host }).questions;
    const keep = all.filter((q) => (q.kind === 'drive' && drive && this.inPair(pair, drive.cwd))
      || (q.kind === 'task' && tasks.some((t) => t.id === q.task && t.pairId === pair.id))
      || (q.kind === 'ask' && asks.list((cwd) => this.inPair(pair, cwd)).some((a) => `a:${a.id}` === q.key)));
    // Each question says which computer it is on.
    return { host, via: true, questions: keep.map((q) => ({ ...q, who: `◆ ${host} · ${q.who}` })) };
  }

  // Headers for the window and its requests: not framed, not shared with the app's window.
  headers(nonce) {
    return {
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    };
  }

  // Allows only same-origin requests that include the key; through a pairing link only while the
  // setting is on (checked on every request, so turning it off stops the window immediately).
  allowed(req) {
    if (req.socket && req.socket.editlensPair && !this.pairAllowed()) return false;
    if (req.headers['sec-fetch-site'] !== 'same-origin') return false;
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return false;
    return this.keyOk(req.headers['x-editlens-answer']);
  }

  page(product) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${product}: allow or deny</title>
<style>
:root{--bg:#fbfaf7;--raise:#fff;--sunk:#f1efe9;--fg:#1c1b18;--muted:#64615a;--line:rgba(28,27,24,.12);--accent:#c96442;--accent-ink:#a4492b;--del:#b3392e;--warn:#b45309;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1a;--raise:#262624;--sunk:#131312;--fg:#f5f3ee;--muted:#aeaba2;--line:rgba(245,243,238,.14);--accent:#d97757;--accent-ink:#f2a98b;--del:#ff9d91;--warn:#f5b571}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 "Segoe UI Variable Text","Segoe UI",-apple-system,system-ui,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px}header b{font-size:15px}header p{margin:2px 0 0;color:var(--muted);font-size:12.5px}
main{padding:10px 12px 16px;display:flex;flex-direction:column;gap:8px}
.q{border:1px solid var(--line);border-radius:10px;background:var(--raise);padding:10px 12px}.q.focus{outline:2px solid var(--accent);outline-offset:1px}
.who{font-size:12.5px;color:var(--muted);font-weight:600}.t{font-weight:600;margin:3px 0}
pre{margin:6px 0;padding:6px 8px;background:var(--sunk);border-radius:6px;font:12px/1.45 "Cascadia Mono",Consolas,ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;max-height:10em;overflow:auto}
.n{color:var(--muted);font-size:12.5px;margin:4px 0}.w{color:var(--warn);font-weight:600;font-size:12.5px;margin:4px 0}
.q.danger{border:2px solid var(--del)}.q.danger .t,.w.danger{color:var(--del);text-transform:uppercase}.w.danger{font-weight:800;font-size:13px;line-height:1.5}
.a{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
button{font-family:inherit;font-weight:600;font-size:13px;line-height:1;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--raise);color:var(--fg);cursor:pointer}
button.allow{background:var(--accent);border-color:var(--accent);color:#fff}button.deny{background:var(--del);border-color:var(--del);color:#fff}
@media (prefers-color-scheme:dark){button.allow,button.deny{color:#1c1b18}}
button:disabled{opacity:.5;cursor:default}button:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.e{color:var(--muted);text-align:center;padding:28px 12px}
</style></head><body>
<header><b>Allow or deny</b><p id="sub">Questions from Claude. Only you can answer them here.</p></header>
<main id="list"><div class="e">Loading…</div></main>
<script nonce="${nonce}">
(function () {
  'use strict';
  var KEY = ${JSON.stringify(this.key)};
  // Opened through a paired computer's link: its addresses start with the link's key (D11).
  var BASE = (/^\\/gk-[0-9a-f]{32}(?=\\/)/.exec(location.pathname) || [''])[0];
  try {
    window.opener = null;
  } catch (err) {
    // A browser where opener cannot be set throws a TypeError, which is ignored.
    if (!(err instanceof TypeError)) throw err;
  }
  var list = document.getElementById('list');
  var sub = document.getElementById('sub');
  var want = '';
  try {
    want = (decodeURIComponent(location.hash).match(/q=([\\w:-]+)/) || [])[1] || '';
  } catch (err) {
    if (!(err instanceof URIError)) throw err;
  }
  var scrolled = false;
  var shownAt = Date.now();
  var busy = {};
  var answered = 0;
  // Buttons wait a moment after the window shows, so a click meant for the page behind can't
  // press Allow when the window appears.
  var ARM_MS = 600;
  document.addEventListener('visibilitychange', function () { if (!document.hidden) shownAt = Date.now(); });
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function call(method, path, body) {
    return fetch(BASE + path, { method: method, headers: { 'content-type': 'application/json', 'x-editlens-answer': KEY }, body: body ? JSON.stringify(body) : undefined, credentials: 'omit' })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status)); return j; }); });
  }
  function answer(q, decision, buttons) {
    if (Date.now() - shownAt < ARM_MS) return;
    busy[q.key] = true;
    buttons.forEach(function (b) { b.disabled = true; });
    call('POST', '/answer', { kind: q.kind, id: q.id, task: q.task || null, decision: decision }).then(function () {
      answered++;
      refresh();
    }, function (err) {
      delete busy[q.key];
      buttons.forEach(function (b) { b.disabled = false; });
      sub.textContent = 'Could not answer: ' + err.message;
    });
  }
  function render(data) {
    var qs = data.questions || [];
    sub.textContent = data.via ? 'Questions from Claude on \u25c6 ' + data.host + ', the computer you paired with. Only you can answer them here.'
      : (data.host ? 'On ' + data.host + '. ' : '') + 'Questions from Claude. Only you can answer them here.';
    if (!qs.length) {
      list.replaceChildren(el('div', 'e', answered ? 'Done. No more questions.' : 'No questions now.'));
      if (answered) setTimeout(function () { window.close(); }, 900);
      return;
    }
    list.replaceChildren.apply(list, qs.map(function (q) {
      var box = el('div', 'q' + (q.danger ? ' danger' : '') + (q.key === want ? ' focus' : ''));
      box.appendChild(el('div', 'who', q.who));
      box.appendChild(el('div', 't', q.title || 'Use a tool'));
      if (q.warning) box.appendChild(el('div', q.danger ? 'w danger' : 'w', q.warning));
      if (q.detail) box.appendChild(el('pre', '', q.detail));
      if (q.note) box.appendChild(el('div', 'n', q.note));
      if (q.readOnly) {
        box.appendChild(el('div', 'n', 'Answer this in Claude Code.'));
        return box;
      }
      var acts = el('div', 'a');
      var choices = q.kind === 'root' ? [['deny', 'allow', 'Keep the safe account'], ['allow', 'deny', 'Run tasks as root']]
        : q.kind === 'mode' ? [['allow', 'allow', q.title || 'Switch'], ['deny', '', 'Keep the current mode']]
        : q.kind === 'setting' ? [['deny', 'allow', 'Keep the current setting'], ['allow', '', q.title || 'Change it']]
        : [['allow', 'allow', 'Allow']].concat(q.canAlways ? [['always', '', 'Always allow (this session)']] : [], [['deny', 'deny', 'Deny']]);
      var buttons = choices.map(function (c) {
        var b = el('button', c[1], c[2]);
        b.type = 'button';
        b.disabled = Boolean(busy[q.key]);
        b.addEventListener('click', function () { answer(q, c[0], buttons); });
        acts.appendChild(b);
        return b;
      });
      box.appendChild(acts);
      return box;
    }));
    var f = list.querySelector('.q.focus');
    if (f && !scrolled) {
      f.scrollIntoView({ block: 'center' });
      scrolled = true;
    }
  }
  function refresh() {
    return call('GET', '/answer/list').then(render, function (err) {
      sub.textContent = 'EditLens is not responding (' + err.message + '). This window tries again every second.';
    });
  }
  refresh();
  setInterval(refresh, 1000);
})();
</script></body></html>`;
    return { html, nonce };
  }
}

module.exports = { AnswerDesk, LOOSE_MODES };
