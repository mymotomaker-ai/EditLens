'use strict';
// GET /summary?since=<seq>&wait=<s> for the mod (hooks/mod.mjs): the request is answered immediately
// when the session's summary changed after seq, else kept open until it changes or for wait seconds.
// An idle session then makes one request per wait instead of one every 2 s.

const WAIT_MAX_S = 25; // a waiting request is answered after this long at most
const SETTLE_MS = 150; // changes that come together are sent in one answer
const RECHECK_MS = 5000; // for what changes with no signal: files, notices that expire
const PER_SESSION = 2; // a third request of one session answers its oldest (a reloaded mod)
const MAX_HELD = 64; // past this, requests are answered immediately
const KEPT = 200; // summaries remembered, one per session and folder

// A seq from the query: digits only, a safe integer. -> number or null
function sinceParam(raw) {
  if (typeof raw !== 'string' || !/^\d{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

// Seconds to wait, from the query: digits only, at most WAIT_MAX_S. -> number (0: answer immediately)
function waitParam(raw) {
  if (typeof raw !== 'string' || !/^\d{1,4}$/.test(raw)) return 0;
  return Math.min(WAIT_MAX_S, Number(raw));
}

class SummaryWatch {
  // build(sessionId, cwd) -> the summary body
  constructor(build, { now = Date.now, waitMaxS = WAIT_MAX_S } = {}) {
    this.build = build;
    // From the clock, so a restarted server numbers above the last one (the mod also takes a
    // lower number as a change).
    const t = Number(now());
    this.seq = Number.isSafeInteger(Math.floor(t)) && t > 0 ? Math.floor(t) : 0;
    this.waitMaxS = waitMaxS;
    this.last = new Map(); // key -> { fp, seq }
    this.held = new Set(); // { key, group, sessionId, cwd, since, mod, done, timer }
    this.timer = null;
    this.recheck = null;
  }

  // The summary and its seq; the seq moves when this key's summary differs from the last one.
  current(sessionId, cwd) {
    const key = `${sessionId || ''}\0${cwd || ''}`;
    const body = this.build(sessionId, cwd);
    // display repeats what the mod itself reported: not a change.
    const { display: _display, ...rest } = body;
    const fp = JSON.stringify(rest);
    let e = this.last.get(key);
    if (!e || e.fp !== fp) {
      e = { fp, seq: ++this.seq };
      this.last.delete(key);
      this.last.set(key, e);
      if (this.last.size > KEPT) this.last.delete(this.last.keys().next().value);
    }
    return { body, seq: e.seq };
  }

  // -> Promise of { body, seq, changed }, or null when the caller went away first.
  // since: the seq the caller has (null: none); wait: seconds it may wait (0: not at all).
  answer({ sessionId, cwd, since, wait, mod = false, res = null }) {
    const now = this.current(sessionId, cwd);
    const changed = since === null || now.seq !== since;
    const ms = Math.min(this.waitMaxS, Number.isFinite(wait) && wait > 0 ? wait : 0) * 1000;
    if (changed || !ms || this.held.size >= MAX_HELD) return Promise.resolve({ ...now, changed });
    const group = sessionId || cwd || '';
    const same = [...this.held].filter((h) => h.group === group);
    if (same.length >= PER_SESSION) this.finish(same[0]);
    return new Promise((resolve) => {
      const h = { key: `${sessionId || ''}\0${cwd || ''}`, group, sessionId, cwd, since, mod, done: resolve, timer: null };
      h.timer = setTimeout(() => this.finish(h), ms);
      this.held.add(h);
      if (res) {
        res.on('close', () => {
          if (this.held.delete(h)) {
            clearTimeout(h.timer);
            this.idle();
            resolve(null);
          }
        });
      }
      if (!this.recheck) {
        this.recheck = setInterval(() => this.check(), RECHECK_MS);
        this.recheck.unref();
      }
    });
  }

  // Answers a waiting request now, with the summary as it is.
  finish(h, now = null) {
    if (!this.held.delete(h)) return;
    clearTimeout(h.timer);
    this.idle();
    const out = now || this.current(h.sessionId, h.cwd);
    h.done({ ...out, changed: out.seq !== h.since });
  }

  idle() {
    if (this.held.size) return;
    clearInterval(this.recheck);
    this.recheck = null;
  }

  // Something the summary depends on may have changed: waiting requests are checked shortly.
  nudge() {
    if (!this.held.size || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.check();
    }, SETTLE_MS);
    this.timer.unref();
  }

  // Answers each waiting request whose summary changed.
  check() {
    const seen = new Map();
    for (const h of [...this.held]) {
      let now = seen.get(h.key);
      if (!now) {
        now = this.current(h.sessionId, h.cwd);
        seen.set(h.key, now);
      }
      if (now.seq !== h.since) this.finish(h, now);
    }
  }

  // Shutting down: every waiting request is answered now.
  releaseAll() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const h of [...this.held]) this.finish(h);
  }

  // A mod's request is waiting: the mod is running.
  modHeld() {
    for (const h of this.held) if (h.mod) return true;
    return false;
  }
}

module.exports = { SummaryWatch, sinceParam, waitParam, WAIT_MAX_S, PER_SESSION, MAX_HELD };
