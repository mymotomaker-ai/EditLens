'use strict';
// The Sessions list: names people give sessions, and page control's conversations in each
// project, saved by the live server in one file (sessions.json in the state folder).
// Keys: 'pc:<session id>' (page control), 'task:<task id>' (a paired computer's task here),
// 'r:<computer>:<task id>' (a task this computer started on a paired computer).
const fs = require('fs');
const { writeAtomic } = require('./atomic');

const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^(pc:[0-9a-f-]{36}|task:[0-9a-f]{12}|r:[^\u0000-\u001f\u007f]{1,100}:[0-9a-f]{12})$/i;
const NAME_MAX = 60; // characters in a name
const NAMES_KEPT = 300;
const RUNS_KEPT = 60; // page control's conversations, all projects
const TITLE_MAX = 80;

// A name as typed: one line, no control characters, spaces collapsed, at most NAME_MAX characters.
// -> the name, '' (no name: back to the session's own), or null when it isn't text.
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length > NAME_MAX ? chars.slice(0, NAME_MAX - 1).join('').trimEnd() + '…' : s;
}

// The first line of a message, as a session's own name ("Make the header blue").
function titleOf(text) {
  const line = String(typeof text === 'string' ? text : '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const chars = [...line.replace(/[\u0000-\u001f\u007f]/g, ' ')];
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX - 1).join('') + '…' : chars.join('');
}

// The command that continues a session in Claude Code: cd "<folder>" && claude --resume <id>, run
// as account when the task had one. Null when the folder or id is unknown or can't be quoted.
// A Unix folder with ' " $ ` \ or ! is put in single quotes, so the shell reads it as it is.
function resumeCommand(folder, sessionId, account) {
  if (typeof folder !== 'string' || !folder || /[\r\n\0]/.test(folder) || typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) return null;
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(folder);
  if (windows && /["%]/.test(folder)) return null;
  const plain = windows || !/["'$`\\!]/.test(folder);
  const cmd = `cd ${plain ? `"${folder}"` : shellQuote(folder)} && claude --resume ${sessionId}`;
  if (windows || typeof account !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(account)) return cmd;
  return `su - ${account} -c ${plain ? `'${cmd}'` : shellQuote(cmd)}`;
}
function shellQuote(text) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

// A whole number of milliseconds, or null (never NaN).
function msOf(v) {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

class SessionStore {
  // log(text): a line in the server log when the file can't be read or written.
  constructor({ file, log }) {
    this.file = file;
    this.log = log || (() => {});
    this.names = new Map(); // key -> { name, at }
    this.runs = []; // { id, runId, cwd, title, startedAt, endedAt, model, effort, mode }, oldest first
    this.pending = null; // { runId, text }: the first message, sent before Claude said its session id
    this.load();
  }

  load() {
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err instanceof SyntaxError || ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(err.code)) {
        if (err.code !== 'ENOENT') this.log(`sessions: ${this.file} can't be read (${err.code || 'not JSON'}); starting an empty list`);
        return;
      }
      throw err;
    }
    const names = data && data.names && typeof data.names === 'object' ? data.names : {};
    for (const [k, v] of Object.entries(names)) {
      const name = v && cleanName(v.name);
      if (KEY_RE.test(k) && name) this.names.set(k, { name, at: msOf(v.at) || 0 });
    }
    for (const r of Array.isArray(data && data.runs) ? data.runs : []) {
      if (!r || !SESSION_RE.test(String(r.id)) || typeof r.cwd !== 'string' || !r.cwd) continue;
      this.runs.push({ id: r.id, runId: typeof r.runId === 'string' ? r.runId.slice(0, 40) : null, cwd: r.cwd, title: titleOf(r.title), startedAt: msOf(r.startedAt), endedAt: msOf(r.endedAt),
        model: typeof r.model === 'string' ? r.model.slice(0, 80) : null, effort: typeof r.effort === 'string' ? r.effort.slice(0, 20) : null, mode: typeof r.mode === 'string' ? r.mode.slice(0, 30) : null });
    }
    this.runs = this.runs.slice(-RUNS_KEPT);
  }

  save() {
    const names = Object.fromEntries([...this.names].sort((a, b) => a[1].at - b[1].at).slice(-NAMES_KEPT));
    try {
      writeAtomic(this.file, JSON.stringify({ names, runs: this.runs.slice(-RUNS_KEPT) }), { mode: 0o600, mkdir: true });
    } catch (err) {
      if (!err.code) throw err;
      this.log(`sessions: could not save the list (${err.code})`);
    }
  }

  // The name people gave key, or null.
  name(key) {
    const n = this.names.get(String(key || ''));
    return n ? n.name : null;
  }

  // -> { ok, key, name } (name null: back to its own name) | { error }
  rename(key, raw) {
    const k = String(key || '');
    if (!KEY_RE.test(k)) return { error: 'That session is not in the list.' };
    const name = cleanName(raw);
    if (name === null) return { error: 'Type a name.' };
    if (name) this.names.set(k, { name, at: Date.now() });
    else this.names.delete(k);
    this.save();
    return { ok: true, key: k, name: name || null };
  }

  // Page control started or continued a conversation (its init message). runId: page control's run
  // (server/driver.js); a run that switched to a new chat (old one not found) keeps its row and name.
  pageStarted({ id, cwd, runId = null, model, effort, mode, at = Date.now() }) {
    if (!SESSION_RE.test(String(id)) || typeof cwd !== 'string' || !cwd) return;
    let r = this.runs.find((x) => x.id === id);
    const was = runId ? this.runs.find((x) => x.runId === runId && x.id !== id && !x.endedAt) : null;
    if (!r && was) {
      const n = this.names.get(`pc:${was.id}`);
      if (n) {
        this.names.delete(`pc:${was.id}`);
        this.names.set(`pc:${id}`, n);
      }
      r = was;
      r.id = id;
    }
    if (!r) {
      r = { id, runId: null, cwd, title: '', startedAt: msOf(at), endedAt: null, model: null, effort: null, mode: null };
      this.runs.push(r);
      if (this.runs.length > RUNS_KEPT) this.runs.splice(0, this.runs.length - RUNS_KEPT);
    }
    if (typeof runId === 'string' && runId) r.runId = runId.slice(0, 40);
    if (!r.title && this.pending && this.pending.runId === r.runId) r.title = titleOf(this.pending.text);
    this.pending = null;
    r.endedAt = null;
    if (typeof model === 'string' && model) r.model = model.slice(0, 80);
    if (typeof effort === 'string' && effort) r.effort = effort.slice(0, 20);
    if (typeof mode === 'string' && mode) r.mode = mode.slice(0, 30);
    this.save();
  }

  // What it runs with now (the model, effort level and permission mode can change during a run).
  pageInfo(id, { model, effort, mode } = {}) {
    const r = this.runs.find((x) => x.id === id);
    if (!r) return;
    const next = { model: typeof model === 'string' && model ? model.slice(0, 80) : r.model, effort: typeof effort === 'string' && effort ? effort.slice(0, 20) : r.effort, mode: typeof mode === 'string' && mode ? mode.slice(0, 30) : r.mode };
    if (next.model === r.model && next.effort === r.effort && next.mode === r.mode) return;
    Object.assign(r, next);
    this.save();
  }

  // The first message names the session until someone renames it. id: null until Claude reports
  // its session id; the text is kept for pageStarted with this runId.
  pageMessage(id, text, runId = null) {
    const r = id ? this.runs.find((x) => x.id === id) : null;
    if (!r) {
      if (!id && runId) this.pending = { runId: String(runId), text: String(text || '') };
      return;
    }
    if (r.title) return;
    r.title = titleOf(text);
    if (r.title) this.save();
  }

  pageEnded(id, at = Date.now()) {
    const r = this.runs.find((x) => x.id === id);
    if (!r || r.endedAt) return;
    r.endedAt = msOf(at);
    this.save();
  }

  // This project's page control conversations, newest first. matches(a, b): the same project.
  pageRuns(cwd, matches) {
    return this.runs.filter((r) => !cwd || matches(r.cwd, cwd)).slice().reverse();
  }
}

module.exports = { SessionStore, cleanName, titleOf, resumeCommand, SESSION_RE, KEY_RE, NAME_MAX };
