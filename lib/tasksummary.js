'use strict';
// The plain lines Claude Code's chat shows under a task tool's call, before the data for Claude:
// no colors, at most 64 columns and 3 lines. 1) what happened and where ("✦ Task done on ◆ vps-1"),
// 2) title ··· status, 3) only when needed: where the edits are, a waiting question, or an error.
// Claude Code shows the first lines of a tool's result and collapses the rest, so the user reads
// these and Claude still gets every field after them.

const WIDTH = 64;
const STATES = {
  waiting: 'Waiting', starting: 'Starting', working: 'Working', idle: 'Done', ended: 'Ended', stopped: 'Stopped', failed: 'Failed', refused: 'Didn\'t start',
};
const HEADS = {
  waiting: 'waiting on', starting: 'started on', working: 'working on', idle: 'done on', ended: 'ended on', stopped: 'stopped on', failed: 'failed on', refused: 'didn\'t start on',
};
const LIVE = new Set(['waiting', 'starting', 'working']);

// Text without control characters (no ANSI colors, no line breaks), spaces collapsed.
function plain(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// Cut to n characters (code points, so ◆ and emoji count once), "…" at the end.
function cut(s, n) {
  const chars = [...plain(s)];
  return chars.length > n ? chars.slice(0, Math.max(0, n - 1)).join('') + '…' : chars.join('');
}
const len = (s) => [...s].length;

// The task's title: the first line of its prompt (an EditLens note in [ ] at the start is skipped).
function titleOf(prompt) {
  const lines = String(prompt || '').split('\n').map((l) => plain(l)).filter((l) => l && !/^\[(EditLens|From the Claude)\b[^\]]*\]$/.test(l));
  return lines[0] || 'Task';
}

// Rows of [label, value] with a dotted leader, values in one column, all within WIDTH.
function rows(list) {
  const vals = list.map((r) => cut(r[1], WIDTH - 12));
  const longest = Math.max(...vals.map(len));
  const labelMax = Math.max(...list.map((r) => len(plain(r[0]))));
  const col = Math.max(6, Math.min(labelMax + 5, WIDTH - longest));
  return list.map((r, i) => {
    const label = cut(r[0], col - 5);
    return `${label} ${'·'.repeat(col - len(label) - 2)} ${vals[i]}`;
  });
}

// A real count, or null.
function count(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// "Done · 4 files · +54 −3": counts only when known.
// files: { count, added, removed } (any may be null); slots: { running, limit }.
function statusText(state, { asks = 0, files = null, slots = null } = {}) {
  const bits = [asks ? 'Needs your answer' : STATES[state] || plain(state) || 'Unknown'];
  const running = slots && count(slots.running);
  const limit = slots && count(slots.limit);
  if (LIVE.has(state) && !asks && running !== null && limit) bits.push(`${running} of ${limit} running`);
  const n = files ? count(files.count) : null;
  if (n) {
    bits.push(plural(n, 'file', 'files'));
    const a = count(files.added);
    const r = count(files.removed);
    if (a !== null && r !== null) bits.push(`+${a} −${r}`);
  }
  return bits.join(' · ');
}

// Where the task's edits are: the "workspace" of a report, or the card's kind.
function whereOf(ws) {
  if (!ws || typeof ws !== 'object') return null;
  if (ws.sentFrom) return 'mine';
  if (ws.name) return 'copy';
  if (ws.shared) return 'shared';
  return null;
}
const WHERE_WORDS = { mine: 'a copy of this project', copy: 'a copy of its project', shared: 'its project' };

// The third line, only when the user needs it. t: { state, asks, error, note, where, files, start }
function thirdLine(t, computer) {
  if (t.asks) return [`Answer its question in the EditLens window on ◆ ${computer}.`];
  if ((t.state === 'failed' || t.state === 'refused') && t.error) return [`Why: ${plain(t.error)}`];
  if (t.state === 'waiting' && t.note) return [plain(t.note).replace(/^Waiting · /, '')];
  if (t.start && WHERE_WORDS[t.where]) return { row: ['Edits go to', WHERE_WORDS[t.where]] };
  const n = t.files ? count(t.files.count) : null;
  if (t.state === 'idle' && n && t.where === 'mine') return ['Not in your files yet. Claude adds them next.'];
  if (t.state === 'idle' && n && t.where === 'copy') return ['Not in its project yet. Claude merges them next.'];
  return [];
}

// head: line 1; main: [title, status]; extra: thirdLine() output (a sentence, or an aligned row).
function lines(head, main, extra) {
  const third = extra && !Array.isArray(extra) ? extra.row : null;
  const r = rows(third ? [main, third] : [main]);
  const out = [cut(head, WIDTH), r[0]];
  if (third) out.push(r[1]);
  else if (extra && extra.length) out.push(cut(extra[0], WIDTH));
  return out.join('\n');
}

// One task, as a report (check_computer_task, start, stop, follow-up) says it.
// opts: { head, computer, files, slots, start }
function taskBlock(report, opts = {}) {
  const r = report || {};
  const computer = plain(r.computer || opts.computer || 'the paired computer');
  const asks = Array.isArray(r.waitingForPermission) ? r.waitingForPermission.length : count(r.waiting) || 0;
  const state = String(r.state || '');
  const edited = Array.isArray(r.filesEdited) ? r.filesEdited.length : null;
  const files = opts.files && count(opts.files.count) !== null ? opts.files : edited ? { count: edited, added: null, removed: null } : null;
  const head = opts.head || (asks ? `✦ Task needs your answer on ◆ ${computer}` : `✦ Task ${HEADS[state] || plain(state) + ' on'} ◆ ${computer}`);
  const t = { state, asks, error: r.error, note: r.note, where: opts.where || whereOf(r.workspace), files, start: Boolean(opts.start) };
  const title = titleOf(r.prompt || opts.prompt);
  let status = statusText(state, { asks, files, slots: opts.slots });
  // "2 of 4 running" is shown first when the title would be cut for it.
  if (len(title) + len(status) + 5 > WIDTH) status = statusText(state, { asks, files });
  return lines(head, [title, status], thirdLine(t, computer));
}

// start_task_on_computer: started (or waiting).
function started(report, opts = {}) {
  const computer = plain((report && report.computer) || opts.computer || 'the paired computer');
  const head = report && report.state === 'waiting' ? `✦ Task waiting on ◆ ${computer}` : `✦ Task started on ◆ ${computer}`;
  return taskBlock(report, { ...opts, head, start: true });
}
// A start that failed: why, in one line.
function notStarted(error, opts = {}) {
  const computer = plain(opts.computer || 'the paired computer');
  return lines(`✦ Task didn't start on ◆ ${computer}`, [titleOf(opts.prompt), STATES.refused], [`Why: ${plain(error)}`]);
}
function followUp(report, opts = {}) {
  const computer = plain((report && report.computer) || opts.computer || 'the paired computer');
  return taskBlock(report, { ...opts, head: `✦ Follow-up sent to ◆ ${computer}` });
}

// wait_for_computer_tasks. tasks: the summaries waited on; fired: the ones that met the condition.
// opts: { computer, met, until }
function waited(tasks, fired, opts = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const hit = Array.isArray(fired) && fired.length ? fired : list;
  if (hit.length === 1) {
    const t = hit[0];
    const r = { ...t, waitingForPermission: undefined, waiting: count(t.waiting) || 0 };
    const where = t.kind === 'sent' ? 'mine' : t.kind === 'copy' ? 'copy' : t.kind === 'shared' ? 'shared' : null;
    const block = taskBlock(r, { computer: t.computer || opts.computer, files: t.files, slots: opts.slots, where });
    return opts.met ? block : block.replace(/^.*/, cut(`✦ Still waiting on ◆ ${plain(t.computer || opts.computer || 'the paired computer')}`, WIDTH));
  }
  const computer = plain((hit[0] && hit[0].computer) || opts.computer || 'the paired computer');
  const head = opts.met ? `✦ ${plural(hit.length, 'task', 'tasks')} ready on ◆ ${computer}` : `✦ Still waiting on ◆ ${computer}`;
  const shown = hit.slice(0, 2).map((t) => [titleOf(t.prompt), statusText(String(t.state || ''), { asks: count(t.waiting) || 0, files: t.files })]);
  const r = rows(shown);
  const out = [cut(head, WIDTH), ...r];
  if (hit.length > 2) out[2] = cut(`${r[1]} (+${hit.length - 2} more)`, WIDTH);
  return out.join('\n');
}

// list_computer_tasks: { computer, tasks: [{ task, state, prompt, workspace }] }, oldest first.
function listed(res, opts = {}) {
  const list = res && Array.isArray(res.tasks) ? res.tasks : [];
  const computer = plain((res && res.computer) || opts.computer || 'the paired computer');
  const working = list.filter((t) => LIVE.has(t.state)).length;
  const head = `✦ ${list.length ? plural(list.length, 'task', 'tasks') : 'No tasks'} on ◆ ${computer}${working ? ` · ${working} working` : ''}`;
  if (!list.length) return cut(head, WIDTH);
  const newest = list.slice(-2).reverse();
  return [cut(head, WIDTH), ...rows(newest.map((t) => [titleOf(t.prompt), statusText(String(t.state || ''))]))].join('\n');
}

// "a.js, b.js" for line 3, cut to fit.
const names = (list) => list.map((x) => plain(typeof x === 'string' ? x : x && x.path)).filter(Boolean).join(', ');

// apply_computer_task: { applied, same, conflicts, failed, computer, apply } or a dry run.
function applied(out, opts = {}) {
  const o = out || {};
  const computer = plain(o.computer || opts.computer || 'the paired computer');
  const title = titleOf(opts.prompt);
  const conflicts = Array.isArray(o.conflicts) ? o.conflicts : [];
  const failed = Array.isArray(o.failed) ? o.failed : [];
  let head;
  let status;
  if (o.dryRun) {
    const n = Array.isArray(o.wouldApply) ? o.wouldApply.length : 0;
    head = `✦ Changes ready to add from ◆ ${computer} (nothing written)`;
    status = `${plural(n, 'file', 'files')} to add`;
  } else {
    const n = Array.isArray(o.applied) ? o.applied.length : 0;
    head = n ? `✦ Changes added to your files from ◆ ${computer}` : `✦ Nothing new to add from ◆ ${computer}`;
    status = `${plural(n, 'file', 'files')} added`;
  }
  if (conflicts.length) status += ` · ${plural(conflicts.length, 'conflict', 'conflicts')}`;
  const extra = conflicts.length ? [`Changed here since it was sent: ${names(conflicts)}`] : failed.length ? [`Not added: ${names(failed)}`] : [];
  return lines(head, [title, status], extra);
}

// merge_computer_task: { applied, conflicts } or a dry run.
function merged(out, opts = {}) {
  const o = out || {};
  const computer = plain(opts.computer || 'the paired computer');
  const conflicts = Array.isArray(o.conflicts) ? o.conflicts : Array.isArray(o.leftForUser) ? o.leftForUser : [];
  let head;
  let status;
  if (o.dryRun) {
    const n = (Array.isArray(o.wouldMerge) ? o.wouldMerge.length : 0) + (Array.isArray(o.wouldCombine) ? o.wouldCombine.length : 0);
    head = `✦ Changes ready to merge on ◆ ${computer} (nothing written)`;
    status = `${plural(n, 'file', 'files')} to merge`;
  } else {
    const n = Array.isArray(o.applied) ? o.applied.length : 0;
    head = n ? `✦ Changes merged on ◆ ${computer}` : `✦ Nothing new to merge on ◆ ${computer}`;
    status = `${plural(n, 'file', 'files')} merged`;
  }
  const extra = conflicts.length ? [`Left for the user on ◆ ${computer}: ${names(conflicts)}`] : [];
  return lines(head, [titleOf(opts.prompt), status], extra);
}

module.exports = { WIDTH, plain, cut, titleOf, rows, statusText, taskBlock, started, notStarted, followUp, waited, listed, applied, merged };
