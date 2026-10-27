#!/usr/bin/env node
'use strict';
const { PRODUCT_NAME } = require('../lib/name');
// MCP server (stdio): Claude highlights parts of the user's page, opens code in the code view,
// uses the team board and runs tasks on paired computers. No dependencies.

const crypto = require('crypto');
const path = require('path');
const { related } = require('../lib/paths');
const { listArg } = require('../lib/listarg');
const readline = require('readline');
const { postEvent, postJson, getJson, DOWN_CODES } = require('../lib/client');
const { callKey, BOARD_TOOLS } = require('../server/board');
const remotework = require('../lib/remotework');
const { isText } = remotework;
const config = require('../lib/config');
const summary = require('../lib/tasksummary');

const PROTOCOL_VERSION = '2025-06-18';

// Relative paths in show_code are resolved against the project Claude is working in.
const { resolveRef } = require('../lib/fileref');
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// In a task run as the editlens account (lib/taskuser.js) the server accepts only edit reports,
// so this server offers no tools and calls nothing.
const TASK_ACCOUNT = process.env.EDITLENS_TASK_ACCOUNT === '1';
const TASK_ACCOUNT_TEXT = `${PRODUCT_NAME} tools are not available here: this Claude runs a task for a paired computer. Its edits are still reported.`;

// Do not use the plugin folder as the working folder: Windows would lock it during updates.
try {
  process.chdir(require('os').homedir());
} catch (err) {
  process.stderr.write(`live-page: could not leave the plugin folder: ${err.message}\n`);
}
const COLORS = ['purple', 'blue', 'green', 'yellow', 'pink'];
const REPORT_WAIT_MS = 2500;

const TOOLS = [
  {
    name: 'highlight_on_page',
    description:
      `Highlight elements on the web page the user has open (pages running the ${PRODUCT_NAME} script). ` +
      'Draws a colored outline with your note next to each target, distinct from the orange edit highlights. ' +
      'Use it while explaining a layout, asking which element they mean, or showing where a bug is. ' +
      'Each target is a CSS selector, a piece of visible text, or the number of something the user selected. ' +
      'Returns how many elements each target matched on each page.',
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector, e.g. ".menu-list li:nth-child(2)"' },
              text: { type: 'string', description: 'Visible text to find, used when no selector is given' },
              marker: { type: 'number', description: 'A number the user selected on the page (from their message); highlights that same element or area' },
              note: { type: 'string', description: 'Short label shown next to the element' },
            },
          },
        },
        color: { type: 'string', enum: COLORS, description: 'Outline color (default purple)' },
        duration_seconds: { type: 'number', description: 'How long to keep it (default 20, 0 = until cleared)' },
        scroll: { type: 'boolean', description: 'Scroll the first match into view (default true)' },
      },
      required: ['targets'],
    },
  },
  {
    name: 'show_code',
    description:
      "Open a file in the code view next to the user's page (split screen), optionally scrolled to and marking a line range " +
      'with your note. Use it to show the backend or frontend code you are talking about, or to open related files side by side ' +
      'before you edit them, so the user can see the files being edited. Your edits to open files then show in the view line by line.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the file, absolute or relative to the project' },
        line: { type: 'number', description: 'First line to mark (1-based)' },
        end_line: { type: 'number', description: 'Last line to mark (default: same as line)' },
        note: { type: 'string', description: 'Short label shown next to the marked lines' },
      },
      required: ['file'],
    },
  },
  // Team board: shared by the main agent and all subagents in this project.
  {
    name: 'read_board',
    description:
      'Read the team board that you, the main agent and the other subagents in this project share: open task claims, notes, ' +
      'questions, decisions and findings, each tagged with the agent that wrote it. Read it before you start delegated work ' +
      '(to see what others claimed or already found) and before you merge subagent results. Pass since (the latest id you saw) to get only new entries.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'number', description: 'Only entries after this id' },
        topic: { type: 'string', description: 'Only entries with this topic' },
        limit: { type: 'number', description: 'Most recent entries to return (default 30, max 100)' },
      },
    },
  },
  {
    name: 'post_note',
    description:
      'Post a short note to the team board so the main agent and the other subagents see it: a question, an answer, a decision, ' +
      'a blocker, or anything another agent should know (an API format you chose, a file you will not touch). Your name is added automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note, one to three sentences' },
        kind: { type: 'string', enum: ['note', 'question', 'answer', 'decision', 'blocker'], description: 'Default note' },
        topic: { type: 'string', description: 'Optional short topic to group related notes, e.g. "auth"' },
        reply_to: { type: 'number', description: 'Id of the entry this answers' },
      },
      required: ['text'],
    },
  },
  {
    name: 'claim_task',
    description:
      'Claim a part of the work on the team board before you start it, listing the files you will change, so no other agent ' +
      'works on the same thing. Refused (with who has it) if another agent has an open claim on the same task or files. ' +
      'Call complete_task with the returned id when you finish.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What you will do, one line' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files you expect to change, relative to the project' },
        force: { type: 'boolean', description: 'Claim even though another agent has an overlapping claim' },
      },
      required: ['task'],
    },
  },
  {
    name: 'complete_task',
    description: 'Close a claim from claim_task on the team board with a one-line result (or status "dropped" if you stopped the task).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The claim id' },
        result: { type: 'string', description: 'What you did, one line' },
        status: { type: 'string', enum: ['done', 'dropped'], description: 'Default done' },
      },
      required: ['id'],
    },
  },
  {
    name: 'share_finding',
    description:
      'Share something you found in the code with the team board: a file, optional line range, and a note (a bug, ' +
      'where a feature is, a function others should reuse). The user can click it to open those lines in the code view.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path, relative to the project or absolute' },
        line: { type: 'number', description: 'First line (1-based)' },
        end_line: { type: 'number', description: 'Last line (default: same as line)' },
        note: { type: 'string', description: 'What you found, one to three sentences' },
        topic: { type: 'string', description: 'Optional short topic' },
      },
      required: ['file', 'note'],
    },
  },
  // Claude on a paired computer (/editlens pair there, /editlens join here).
  {
    name: 'list_paired_computers',
    description: 'List the computers paired with this one (for example a VPS), with their state and the project there. ' +
      'You can give Claude on each one tasks with start_task_on_computer.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'start_task_on_computer',
    description: 'Ask Claude Code on a paired computer to do a task. workspace "mine": this project is sent with the task (as it is now, ' +
      'uncommitted changes included; not node_modules, .git, .env files, .claude) and the task works on a copy of it there; copy ' +
      'its changes into this project with apply_computer_task. workspace "theirs": the task works on that computer\'s own project, in its own ' +
      'copy (a git worktree from the last commit) when that project is a git project with a commit; merge_computer_task copies its changes ' +
      'into that project. Without git it works in that project folder itself (nothing to merge). When the two projects ' +
      'differ you must choose; when they are the same code, "theirs" is the default. It runs in that computer\'s permission mode ' +
      'and its permission questions go to the user, not to you. Write the prompt as for a subagent: complete, with everything it needs. ' +
      'Returns the task id; follow it with check_computer_task.',
    inputSchema: {
      type: 'object',
      properties: {
        computer: { type: 'string', description: 'The paired computer\'s name (optional when there is only one)' },
        prompt: { type: 'string', description: 'The task for Claude there' },
        workspace: { type: 'string', enum: ['mine', 'theirs'], description: '"mine": send this project; "theirs": that computer\'s project' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Claude\'s effort level there. Leave it out to use the user\'s Effort setting; the user can change it on the task card.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'check_computer_task',
    description: 'A task\'s state (starting, working, idle = finished its turn, waiting for a permission answer, ended, stopped, failed), ' +
      'Claude\'s replies there and its result. Pass since (replyCount from your last check) to get only new replies, and ' +
      'wait_seconds to wait until it finishes its turn or needs the user. result is the last finished turn\'s (null while a new ' +
      'turn works); its text is left out when it is the same as the last reply (sameAsLastReply).',
    inputSchema: {
      type: 'object',
      properties: {
        computer: { type: 'string' },
        task: { type: 'string', description: 'The task id' },
        since: { type: 'number', description: 'Replies already seen' },
        activity_since: { type: 'number', description: 'Tool steps already seen (activityCount from your last check)' },
        wait_seconds: { type: 'number', description: 'Wait up to this long (max 300) while it works' },
      },
      required: ['task'],
    },
  },
  {
    name: 'wait_for_computer_tasks',
    description: 'Wait for tasks on paired computers without checking each one: returns as soon as one of them meets the condition ' +
      '(turn_done: a task finished its turn or stopped; needs_user: a permission question waits for the user; any_change; all_done), ' +
      'with one line per task. Defaults: the tasks still working, until turn_done, 60 seconds (max 300). Then read a task with check_computer_task.',
    inputSchema: {
      type: 'object',
      properties: {
        computer: { type: 'string' },
        tasks: { type: 'array', items: { type: 'string' }, description: 'Task ids (default: the ones still working)' },
        until: { type: 'string', enum: ['turn_done', 'needs_user', 'any_change', 'all_done'] },
        wait_seconds: { type: 'number' },
      },
    },
  },
  {
    name: 'message_computer_task',
    description: 'Send a follow-up to a task on a paired computer: more instructions, or an answer to its question. A task that ended resumes where it was.',
    inputSchema: {
      type: 'object',
      properties: { computer: { type: 'string' }, task: { type: 'string' }, text: { type: 'string' } },
      required: ['task', 'text'],
    },
  },
  {
    name: 'stop_computer_task',
    description: 'Stop a task on a paired computer. Its copy and its changes stay there.',
    inputSchema: { type: 'object', properties: { computer: { type: 'string' }, task: { type: 'string' } }, required: ['task'] },
  },
  {
    name: 'merge_computer_task',
    description: 'Copy a finished task\'s changes from its copy into the project on that computer. Only files the project there has not ' +
      'changed itself are merged; files changed on both sides wait for the user in the EditLens panel there. Each merged file can be restored there. ' +
      'dry_run: what it would merge, writing nothing. Undo it with undo_computer_task_merge.',
    inputSchema: { type: 'object', properties: { computer: { type: 'string' }, task: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['task'] },
  },
  {
    name: 'undo_computer_task_merge',
    description: 'Undo the last merge_computer_task of a task on that computer: each file is restored only while it is still as the merge left it.',
    inputSchema: { type: 'object', properties: { computer: { type: 'string' }, task: { type: 'string' } }, required: ['task'] },
  },
  {
    name: 'get_computer_task_diff',
    description: 'A task\'s whole change as one unified diff (added files included), in pages of 60 KB: pass offset = next for the next page. paths: only these files.',
    inputSchema: {
      type: 'object',
      properties: { computer: { type: 'string' }, task: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, offset: { type: 'number' } },
      required: ['task'],
    },
  },
  {
    name: 'list_computer_task_files',
    description: 'The files in a task\'s workspace (500 per page; offset = next for more). glob: e.g. "src/**/*.jsx".',
    inputSchema: { type: 'object', properties: { computer: { type: 'string' }, task: { type: 'string' }, glob: { type: 'string' }, offset: { type: 'number' } }, required: ['task'] },
  },
  {
    name: 'search_computer_task',
    description: 'Lines that contain the text (plain text, not a pattern) in a task\'s workspace: "path:line: text". glob narrows it; max up to 200.',
    inputSchema: {
      type: 'object',
      properties: { computer: { type: 'string' }, task: { type: 'string' }, text: { type: 'string' }, glob: { type: 'string' }, max: { type: 'number' } },
      required: ['task', 'text'],
    },
  },
  {
    name: 'get_computer_task_changes',
    description: 'The files a task on a paired computer changed in its workspace (added, changed, deleted). Read one with get_computer_task_file.',
    inputSchema: { type: 'object', properties: { computer: { type: 'string' }, task: { type: 'string' } }, required: ['task'] },
  },
  {
    name: 'get_computer_task_file',
    description: 'A file from a task\'s workspace on a paired computer, whole, and how it differs from the same file in this project. ' +
      'start_line/end_line: only those lines (numbered).',
    inputSchema: {
      type: 'object',
      properties: { computer: { type: 'string' }, task: { type: 'string' }, path: { type: 'string', description: 'The file, relative to the workspace' }, start_line: { type: 'number' }, end_line: { type: 'number' } },
      required: ['task', 'path'],
    },
  },
  {
    name: 'apply_computer_task',
    description: 'For a task started with workspace "mine": copy its changes into this project. A file is written only when it is ' +
      'still as it was sent; files changed here since are listed as conflicts (read them with get_computer_task_file and edit ' +
      'them yourself). Pass files to take only some. dry_run: what it would do, writing nothing. The task must be idle. ' +
      'Each apply gets an id: undo_computer_task_apply puts the files back.',
    inputSchema: {
      type: 'object',
      properties: { computer: { type: 'string' }, task: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, dry_run: { type: 'boolean' } },
      required: ['task'],
    },
  },
  {
    name: 'undo_computer_task_apply',
    description: 'Undo an apply_computer_task (its apply id): each file is restored only while it is still as the apply left it. files: only these.',
    inputSchema: { type: 'object', properties: { apply: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }, required: ['apply'] },
  },
  {
    name: 'copy_from_computer',
    description: 'Copy a file or folder from a paired computer\'s own project into this project, as plain files. No Claude runs there ' +
      'and nothing there changes, so it costs no tokens and needs no sign-in there. Use this (not a task) whenever you only need ' +
      'files from that computer, for example an app a task built there. Left out: node_modules, build output, .git, .env files, keys ' +
      'and links; at most 200 MB. A folder is saved at the same path here, or inside "to". Files that already match are skipped; a ' +
      'different file here is a conflict unless overwrite. dry_run: what it would copy. Undo it with undo_computer_task_apply (its copy id). ' +
      'Afterwards install dependencies here yourself (for example npm install).',
    inputSchema: {
      type: 'object',
      properties: {
        computer: { type: 'string' },
        path: { type: 'string', description: 'File or folder in that computer\'s project, relative to it ("." for the whole project)' },
        to: { type: 'string', description: 'Folder in this project to copy into (default: the same path as there)' },
        overwrite: { type: 'boolean', description: 'Replace files here that differ (default false)' },
        dry_run: { type: 'boolean' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_computer_tasks',
    description: 'The tasks this computer started on a paired computer, newest last.',
    inputSchema: { type: 'object', properties: { computer: { type: 'string' } } },
  },
  {
    name: 'clear_page_highlights',
    description: 'Remove the highlights you drew with highlight_on_page.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_live_pages',
    description: `List the pages that currently have the ${PRODUCT_NAME} panel open (URL, title, whether they wait for messages).`,
    inputSchema: { type: 'object', properties: {} },
  },
];

// MCP tool annotations: a title, and whether each tool only reads, can overwrite files, gives the same
// result when called twice, or starts a Claude that can use the web.
// Order: [title, readOnly, destructive, idempotent, openWorld].
const HINTS = {
  highlight_on_page: ['Highlight on the page', false, false, false, false],
  show_code: ['Show code', false, false, true, false],
  read_board: ['Read the team board', true, false, true, false],
  post_note: ['Post a note', false, false, false, false],
  claim_task: ['Claim a task', false, false, false, false],
  complete_task: ['Complete a task', false, false, true, false],
  share_finding: ['Share a finding', false, false, false, false],
  list_paired_computers: ['List paired computers', true, false, true, false],
  start_task_on_computer: ['Start a task on a computer', false, false, false, true],
  check_computer_task: ['Check a computer task', true, false, true, false],
  wait_for_computer_tasks: ['Wait for computer tasks', true, false, true, false],
  message_computer_task: ['Message a computer task', false, false, false, true],
  stop_computer_task: ['Stop a computer task', false, true, true, false],
  merge_computer_task: ['Merge a computer task', false, true, false, false],
  undo_computer_task_merge: ['Undo a task merge', false, true, false, false],
  get_computer_task_diff: ['Get a task diff', true, false, true, false],
  list_computer_task_files: ['List task files', true, false, true, false],
  search_computer_task: ['Search a task', true, false, true, false],
  get_computer_task_changes: ['Get task changes', true, false, true, false],
  get_computer_task_file: ['Get a task file', true, false, true, false],
  apply_computer_task: ['Apply a computer task', false, true, false, false],
  undo_computer_task_apply: ['Undo a task apply', false, true, false, false],
  copy_from_computer: ['Copy from a computer', false, true, false, false],
  list_computer_tasks: ['List computer tasks', true, false, true, false],
  clear_page_highlights: ['Clear page highlights', false, false, true, false],
  list_live_pages: ['List live pages', true, false, true, false],
};
for (const t of TOOLS) {
  const [title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint] = HINTS[t.name];
  t.annotations = { title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanTargets(raw) {
  return (listArg(raw) || [])
    .filter((t) => t && typeof t === 'object')
    .map((t) => ({
      marker: Number.isInteger(Number(t.marker)) && Number(t.marker) > 0 ? Number(t.marker) : undefined,
      selector: typeof t.selector === 'string' ? t.selector.slice(0, 300) : undefined,
      text: typeof t.text === 'string' ? t.text.slice(0, 200) : undefined,
      note: typeof t.note === 'string' ? t.note.slice(0, 200) : undefined,
    }))
    .filter((t) => t.marker || t.selector || t.text)
    .slice(0, 10);
}

async function highlight(args) {
  const targets = cleanTargets(args.targets === undefined ? args.target : args.targets);
  if (!targets.length) return { text: 'No usable targets: give each one a marker, a selector or text, as a list: { "targets": [{ "marker": 2 }] }.', isError: true };
  const color = COLORS.includes(args.color) ? args.color : 'purple';
  const d = Number(args.duration_seconds);
  const duration = Number.isFinite(d) && d >= 0 ? Math.min(d, 600) : 20;
  const pointId = crypto.randomBytes(6).toString('hex');
  const posted = await postEvent({ type: 'point', pointId, targets, color, duration, scroll: args.scroll !== false, ts: Date.now() });
  const pageCount = Number.isFinite(Number(posted.pages)) ? Number(posted.pages) : 0;
  if (pageCount === 0) return { text: `No page has the ${PRODUCT_NAME} panel open, so nothing was highlighted. Ask the user to open their dev page.` };

  // Pages report what they matched; wait briefly for every connected page.
  let reports = [];
  const until = Date.now() + REPORT_WAIT_MS;
  while (Date.now() < until) {
    reports = await getJson(`/report?id=${pointId}`);
    if (reports.length >= pageCount) break;
    await sleep(150);
  }
  if (!reports.length) return { text: `Sent to ${pageCount} page(s), but none confirmed yet (they may be reloading).` };
  // A page's count: a whole number of 0 or more, anything else is 0.
  const count = (x) => {
    const n = Number(x && x.count);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  };
  const results = (r) => (Array.isArray(r.results) ? r.results : []);
  const lines = reports.map((r) => {
    const parts = results(r).map((x) => `${x && x.target}: ${count(x)} match${count(x) === 1 ? '' : 'es'}`);
    return `${r.url || 'page'} → ${parts.join('; ')}`;
  });
  const anyMiss = reports.some((r) => results(r).some((x) => !count(x)));
  return { text: lines.join('\n') + (anyMiss ? '\nTargets with 0 matches were not shown; try another selector or visible text.' : '') };
}

function lineArg(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

async function showCode(args) {
  if (typeof args.file !== 'string' || !args.file.trim()) return { text: 'Give the file to open.', isError: true };
  // The same rules as files clicked on the page: inside this project only, never hidden or
  // secret-looking files, binaries or files over 512 KB.
  const found = resolveRef(args.file, [PROJECT_DIR]);
  if (found.error) return { text: found.error, isError: true };
  if (found.kind === 'choices') return { text: `Several files match ${args.file}: ${found.matches.slice(0, 10).join(', ')}. Give the path.`, isError: true };
  if (found.kind !== 'file') return { text: `Not a file: ${args.file}`, isError: true };
  const file = found.file;
  const content = found.text;
  const line = lineArg(args.line);
  const endLine = line === null ? null : Math.max(line, lineArg(args.end_line) || line);
  const rel = path.relative(PROJECT_DIR, file);
  const relFile = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
  const posted = await postEvent({
    type: 'code', file, relFile, content, line, endLine, cwd: PROJECT_DIR,
    note: typeof args.note === 'string' ? args.note.slice(0, 200) : null, ts: Date.now(),
  });
  const pageCount = Number.isFinite(Number(posted.pages)) ? Number(posted.pages) : 0;
  if (pageCount === 0) return { text: `No page has the ${PRODUCT_NAME} panel open, so the file was not shown.` };
  const lines = content.split('\n').length;
  return { text: `Opened ${relFile} (${lines} lines)${line ? ` at line ${line}` : ''} in the code view on ${pageCount} page(s).` };
}

// ---------- Claude on a paired computer ----------
// Tool results as short JSON: no indentation, no empty fields (the agent reads keys reliably).
function prune(v) {
  if (Array.isArray(v)) return v.map(prune);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === null || x === undefined || x === '' || (Array.isArray(x) && !x.length)) continue;
    out[k] = prune(x);
  }
  return out;
}
const compact = (v) => JSON.stringify(prune(v));
const TASK_BUSY = new Set(['waiting', 'starting', 'working']);

// This computer's data on a task on a paired computer, for the summary lines in Claude Code's chat:
// prompt, files ({ count, added, removed }) and "2 of 4 running". {} when the live server can't say.
async function taskInfo(id, computer) {
  const now = await getJson('/remote/tasks').catch((err) => {
    if (!(err instanceof Error)) throw err;
    // The live server not running: the summary leaves these out. Other errors also go to the log.
    if (!DOWN_CODES.has(err.code)) process.stderr.write(`live-page: no task data for the summary: ${err.code || err.message}\n`);
    return null;
  });
  if (!now || !Array.isArray(now.tasks)) return {};
  const t = now.tasks.find((x) => x && x.task === id) || null;
  const name = (t && t.computer) || computer || '';
  const slots = now.slots && typeof now.slots === 'object' ? now.slots[name] || (Object.keys(now.slots).length === 1 ? Object.values(now.slots)[0] : null) : null;
  return { prompt: t ? t.prompt : undefined, files: t ? t.files : null, slots, computer: name || undefined };
}

// A task tool's result: the summary for the user first, then the data for Claude, unchanged.
function withSummary(out, make) {
  if (!out || out.isError) return out;
  let text = null;
  try {
    text = make();
  } catch (err) {
    // A summary that can't be made (an older EditLens there sent another shape) never hides the data.
    if (!(err instanceof TypeError)) throw err;
    process.stderr.write(`live-page: no summary: ${err.message}\n`);
  }
  return text ? { ...out, summary: text } : out;
}

async function remoteTask(op, args, extra) {
  const computer = typeof args.computer === 'string' ? args.computer.slice(0, 100) : '';
  const res = await postJson('/remote/task', { computer, op, ...extra, localDir: PROJECT_DIR }, { timeoutMs: 150000 });
  if (res && res.error) return { text: res.error, isError: true };
  return { text: compact(res), res };
}

// The card on this project's page says that Claude added a task's changes (with Undo), or that
// they were removed. Never fails the tool.
function noteApplied(body) {
  return postJson('/remote/task-applied', { dir: PROJECT_DIR, ...body }, { timeoutMs: 15000 }).catch((err) => {
    if (!(err instanceof Error)) throw err;
    process.stderr.write(`could not tell the page about the ${body.how || 'undo'}: ${err.message}\n`);
  });
}

// Returns a function that sends one op to the paired computer and resolves to the response
// ({ error } on failure).
// start: { id, prompt } of the task being started, so the page shows it while it waits or if it
// does not start (server.js noteStart).
function linkFor(args, start = null) {
  const computer = typeof args.computer === 'string' ? args.computer.slice(0, 100) : '';
  const tag = start ? { startId: start.id, startPrompt: String(start.prompt || '').slice(0, 300) } : {};
  // localDir: this project, where the panel shows the task live (server.js mirrorTask).
  return (op, extra) => postJson('/remote/task', { computer, op, ...extra, ...tag, localDir: PROJECT_DIR }, { timeoutMs: 150000 }).catch((err) => ({ error: err.message }));
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const fitBuf = (b, max) => (isText(b) && b.length <= max ? b.toString('utf8') : undefined);

async function startTask(args) {
  const prompt = typeof args.prompt === 'string' ? args.prompt : '';
  const start = { id: crypto.randomBytes(8).toString('hex'), prompt };
  const link = linkFor(args, start);
  const out = await startTaskWith(args, prompt, link);
  const computer = typeof args.computer === 'string' ? args.computer.slice(0, 100) : '';
  // Any start that ends in an error: the page and the line in Claude Code say so too.
  if (out.isError && !out.choice) {
    await link('start-failed', { error: out.text });
    return { isError: true, text: out.text, summary: summary.notStarted(out.text, { computer: computer || 'the paired computer', prompt }) };
  }
  if (out.choice) return { isError: true, text: out.text };
  const info = await taskInfo(out.res && out.res.task, computer);
  return withSummary({ text: out.text }, () => summary.started(out.res, { computer: info.computer || computer, slots: info.slots, prompt }));
}

async function startTaskWith(args, prompt, link) {
  // Only one of the five levels, as its own field; anything else is refused before anything is sent.
  if (args.effort !== undefined && !EFFORT_LEVELS.includes(args.effort)) return { isError: true, text: 'effort must be one of: low, medium, high, xhigh, max.' };
  const effort = args.effort;
  let workspace = args.workspace === 'mine' || args.workspace === 'theirs' ? args.workspace : null;
  let note;
  if (!workspace) {
    const cmp = await remotework.compareProjects(link, PROJECT_DIR);
    if (cmp.same === false) {
      // A question for the agent (which workspace), not a failed start: no notice on the page.
      return { isError: true, choice: true, text: `The project on ${cmp.theirs.computer} (${cmp.theirs.cwd}) is not this project (${PROJECT_DIR}). ` +
        'Choose: workspace "mine" sends this project and the task works on a copy of it there (copy its changes into this project with apply_computer_task); ' +
        `workspace "theirs" works on ${cmp.theirs.cwd} there.` };
    }
    workspace = 'theirs';
    if (cmp.same === null) note = 'That computer runs an older EditLens: the task works on its own project. Update EditLens there to send this project instead.';
  }
  if (workspace === 'mine') {
    const out = await remotework.sendAndStart(link, { dir: PROJECT_DIR, prompt, stateDir: config.stateDir, computer: args.computer, effort });
    return out.error ? { text: out.error, isError: true } : { text: compact(out), res: out };
  }
  const res = await link('start', { prompt, ...(effort ? { effort } : {}) });
  if (res && res.error) return { text: res.error, isError: true };
  const all = note ? { ...res, note } : res;
  return { text: compact(all), res: all };
}

function taskId(args) {
  return typeof args.task === 'string' ? args.task.trim().slice(0, 40) : '';
}

async function pairedComputers() {
  const s = await getJson('/pair');
  const hosts = (s && s.remotes && s.remotes.hosts) || [];
  if (!hosts.length) return { text: 'This computer is not paired with another one. The user pairs one with /editlens pair there and /editlens join here.' };
  return { text: hosts.map((h) => `${h.name}: ${h.state}${h.error && h.state !== 'connected' ? ` (${h.error})` : ''}, project ${h.cwd}`).join('\n') };
}

async function checkTask(args) {
  const wait = Math.min(300, Math.max(0, Number(args.wait_seconds) || 0)) * 1000;
  const since = Number.isFinite(Number(args.since)) ? Math.max(0, Math.floor(Number(args.since))) : 0;
  const end = Date.now() + wait;
  for (;;) {
    // The other computer keeps the request open until the task changes (up to a minute): one request per
    // change. An older EditLens there responds immediately, so a quick response waits 2 s.
    const left = Math.max(0, Math.floor((end - Date.now()) / 1000));
    const asked = Date.now();
    const res = await postJson('/remote/task', { computer: typeof args.computer === 'string' ? args.computer : '', op: 'check', task: taskId(args), since, activitySince: Number.isSafeInteger(Number(args.activity_since)) && Number(args.activity_since) >= 0 ? Number(args.activity_since) : undefined, wait: Math.min(60, left) }, { timeoutMs: 90000 });
    if (res && res.error) return { text: res.error, isError: true };
    const waiting = res.waitingForPermission && res.waitingForPermission.length;
    if (!TASK_BUSY.has(res.state) || waiting || Date.now() > end) {
      if (waiting) res.note = `Waiting for the user to answer ${waiting === 1 ? 'a permission question' : waiting + ' permission questions'} in the EditLens window on that computer (only the user can allow; a panel can only deny).`;
      const info = await taskInfo(res.task, args.computer);
      return withSummary({ text: compact(res) }, () => summary.taskBlock(res, { computer: info.computer, files: info.files, slots: info.slots }));
    }
    if (Date.now() - asked < 1000) await sleep(2000);
  }
}

const RESTING = new Set(['idle', 'ended', 'stopped', 'failed']);
const UNTIL = new Set(['turn_done', 'needs_user', 'any_change', 'all_done']);
function taskLine(t) {
  return `${t.task} on ${t.computer || 'the paired computer'}: ${t.state}${t.waiting ? `, waiting for the user (${t.waiting})` : ''}` +
    `, ${t.replyCount} replies, ${t.activityCount} steps, ${t.editCount} edits${t.error ? `, error: ${t.error}` : ''} (${t.prompt})`;
}
// Waits on this computer's copy of the tasks' state (the live server updates it once per change),
// so a check sends no request to the other computer.
async function waitTasks(args) {
  const computer = typeof args.computer === 'string' ? args.computer.slice(0, 100) : '';
  const until = UNTIL.has(args.until) ? args.until : 'turn_done';
  const n = Number(args.wait_seconds);
  const end = Date.now() + (Number.isFinite(n) ? Math.min(300, Math.max(0, n)) : 60) * 1000;
  let now = await getJson(`/remote/tasks?follow=${encodeURIComponent(computer)}`);
  // Just started following (after a restart): wait up to 5 s for the first state.
  if (!now.tasks.length) now = await getJson(`/remote/tasks?since=${now.seq}&wait=5`, 10000);
  const mineOf = (list) => list.filter((t) => !computer || String(t.computer || '').toLowerCase() === computer.toLowerCase());
  const askedList = listArg(args.tasks);
  const asked = askedList && askedList.length ? askedList.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : null;
  if (asked && !asked.length) return { text: 'Give "tasks" as task ids (text), from start_task_on_computer or list_computer_tasks.', isError: true };
  const start = new Map(mineOf(now.tasks).map((t) => [t.task, t]));
  // None of the given ids is known: say so now instead of waiting the whole time for them.
  if (asked && !asked.some((id) => start.has(id))) return { text: `Not known here: ${asked.join(', ')}. List the tasks with list_computer_tasks.`, isError: true };
  const ids = asked || [...start.values()].filter((t) => !RESTING.has(t.state) || t.waiting).map((t) => t.task);
  if (!ids.length) return { text: start.size ? `No task is working. Latest:\n${[...start.values()].slice(-5).map(taskLine).join('\n')}` : 'No tasks on paired computers are known here. Start one with start_task_on_computer.' };
  for (;;) {
    const tasks = mineOf(now.tasks).filter((t) => ids.includes(t.task));
    const fired = tasks.filter((t) => {
      const before = start.get(t.task);
      if (until === 'needs_user') return t.waiting > 0;
      if (until === 'any_change') return !before || t.seq > before.seq;
      if (until === 'turn_done') return RESTING.has(t.state) && (!before || t.seq > before.seq || RESTING.has(before.state));
      return false;
    });
    const allDone = tasks.length === ids.length && tasks.every((t) => RESTING.has(t.state) && !t.waiting);
    const met = until === 'all_done' ? allDone : fired.length > 0;
    if (met || Date.now() >= end) {
      const head = met ? (until === 'all_done' ? 'All done.' : `Ready: ${fired.map((t) => t.task).join(', ')} (${until}).`) : `Still waiting after the time given (${until}).`;
      const missing = ids.filter((id) => !tasks.some((t) => t.task === id));
      const text = [head, ...tasks.map(taskLine), ...(missing.length ? [`Not known here: ${missing.join(', ')}`] : [])].join('\n');
      const slots = now.slots && typeof now.slots === 'object' ? now.slots : {};
      return withSummary({ text }, () => summary.waited(tasks, met ? fired : [], { met, computer, slots: tasks.length === 1 ? slots[tasks[0].computer] || null : null }));
    }
    const left = Math.max(1, Math.min(50, Math.floor((end - Date.now()) / 1000)));
    now = await getJson(`/remote/tasks?since=${now.seq}&wait=${left}`, (left + 10) * 1000);
  }
}

// The plugin's PreToolUse hook has already told the server which agent makes this exact call.
async function boardTool(name, args) {
  return postJson('/board', { tool: name, args, key: callKey(name, args), projectDir: PROJECT_DIR });
}

async function callTool(name, args) {
  if (BOARD_TOOLS.includes(name)) return boardTool(name, args || {});
  switch (name) {
    case 'highlight_on_page':
      return highlight(args || {});
    case 'show_code':
      return showCode(args || {});
    case 'list_paired_computers':
      return pairedComputers();
    case 'start_task_on_computer':
      return startTask(args || {});
    case 'get_computer_task_changes':
      return remoteTask('changes', args, { task: taskId(args) });
    case 'get_computer_task_diff': {
      const r = await linkFor(args)('diff', { task: taskId(args), paths: listArg(args.paths) ? listArg(args.paths).filter((x) => typeof x === 'string').slice(0, 200) : undefined, offset: Number.isSafeInteger(Number(args.offset)) ? Number(args.offset) : 0 });
      if (r.error) return { text: r.error, isError: true };
      return { text: `${r.diff}${r.next !== null && r.next !== undefined ? `\n--- more: offset ${r.next} of ${r.size} ---` : ''}` };
    }
    case 'list_computer_task_files':
      return remoteTask('files', args, { task: taskId(args), glob: typeof args.glob === 'string' ? args.glob : undefined, offset: Number.isSafeInteger(Number(args.offset)) ? Number(args.offset) : 0 });
    case 'search_computer_task':
      return remoteTask('search', args, { task: taskId(args), text: typeof args.text === 'string' ? args.text : '', glob: typeof args.glob === 'string' ? args.glob : undefined, max: Number.isSafeInteger(Number(args.max)) ? Number(args.max) : undefined });
    case 'undo_computer_task_apply': {
      const dir = PROJECT_DIR;
      const out = await remotework.undoApply({ stateDir: config.stateDir, apply: typeof args.apply === 'string' ? args.apply.trim() : '', files: listArg(args.files) ? listArg(args.files).filter((f) => typeof f === 'string') : null,
        onUndone: (f) => postJson('/remote/applied', { undo: true, dir, path: f.path, status: f.after === null ? 'deleted' : 'changed', intent: 'Undone: back as it was before the apply',
          binary: Boolean((f.before && !isText(f.before)) || (f.after && !isText(f.after))) || undefined,
          before: f.before ? fitBuf(f.before, 2 * 1024 * 1024) : '', after: f.after ? fitBuf(f.after, 512 * 1024) : '' }, { timeoutMs: 15000 }).catch((err) => process.stderr.write(`could not show ${f.path} on the page: ${err.message}\n`)) });
      // The card keeps its Undo while a file of the apply is not put back (Sol M6).
      if (!out.error && out.undone && out.undone.length && out.left === 0) await noteApplied({ apply: typeof args.apply === 'string' ? args.apply.trim() : '', undone: true });
      return out.error ? { text: out.error, isError: true } : { text: compact(out) };
    }
    case 'get_computer_task_file': {
      if (args.start_line !== undefined || args.end_line !== undefined) {
        const lines = await remotework.showLines(linkFor(args), { task: taskId(args), rel: typeof args.path === 'string' ? args.path : '', start: Math.floor(Number(args.start_line)), end: Math.floor(Number(args.end_line)) });
        return lines.error ? { text: lines.error, isError: true } : lines;
      }
      const out = await remotework.showFile(linkFor(args), { task: taskId(args), rel: typeof args.path === 'string' ? args.path : '', dir: PROJECT_DIR });
      return out.error ? { text: out.error, isError: true } : out;
    }
    case 'apply_computer_task': {
      const task = taskId(args);
      // Each file written appears on the page like any other edit (highlight, Changes, code view, Restore).
      const onApplied = (f) => postJson('/remote/applied', {
        task, computer: typeof args.computer === 'string' ? args.computer.slice(0, 100) : '', dir: PROJECT_DIR, path: f.path, status: f.status, intent: f.intent,
        binary: Boolean((f.before && !isText(f.before)) || (f.after && !isText(f.after))) || undefined,
        // Same limits as the hooks: lib/snapshots keeps up to 512 KB, lib/backups up to 2 MB.
        before: f.before ? fitBuf(f.before, 2 * 1024 * 1024) : '', after: f.after ? fitBuf(f.after, 512 * 1024) : '',
      }, { timeoutMs: 15000 }).catch((err) => process.stderr.write(`could not show ${f.path} on the page: ${err.message}\n`));
      const out = await remotework.applyTask(linkFor(args), { task, stateDir: config.stateDir, files: listArg(args.files) ? listArg(args.files).filter((f) => typeof f === 'string').slice(0, 2000) : null, onApplied, dryRun: args.dry_run === true });
      // A dry run only lists what would be applied (Sol M2).
      if (!out.error && out.dryRun) return { text: compact(out) };
      if (!out.error && out.applied.length) out.seeIt = 'The applied files show on the page as edits (highlight, Changes list, code view). Tell the user where to look (the page or route the task named).';
      if (out.error) return { text: out.error, isError: true };
      if (out.apply) await noteApplied({ task, computer: out.computer || (typeof args.computer === 'string' ? args.computer.slice(0, 100) : ''), how: 'apply', apply: out.apply, count: out.applied.length });
      const info = await taskInfo(task, args.computer);
      return withSummary({ text: compact(out) }, () => summary.applied(out, { computer: info.computer, prompt: info.prompt }));
    }
    case 'copy_from_computer': {
      const computer = typeof args.computer === 'string' ? args.computer.slice(0, 100) : '';
      const dir = PROJECT_DIR;
      const onApplied = (f) => postJson('/remote/applied', {
        computer, dir, path: f.path, status: f.status, intent: f.intent,
        binary: Boolean((f.before && !isText(f.before)) || (f.after && !isText(f.after))) || undefined,
        before: f.before ? fitBuf(f.before, 2 * 1024 * 1024) : '', after: f.after ? fitBuf(f.after, 512 * 1024) : '',
      }, { timeoutMs: 15000 }).catch((err) => process.stderr.write(`could not show ${f.path} on the page: ${err.message}\n`));
      const out = await remotework.copyFrom(linkFor(args), { from: typeof args.path === 'string' ? args.path : undefined, to: typeof args.to === 'string' ? args.to : undefined, dir, stateDir: config.stateDir,
        computer, overwrite: args.overwrite === true, dryRun: args.dry_run === true, onApplied });
      return out.error ? { text: out.error, isError: true } : { text: compact(out) };
    }
    case 'check_computer_task':
      return checkTask(args || {});
    case 'wait_for_computer_tasks':
      return waitTasks(args || {});
    case 'message_computer_task': {
      const out = await remoteTask('send', args, { task: taskId(args), text: typeof args.text === 'string' ? args.text : '' });
      return withSummary(out, () => summary.followUp(out.res, { computer: args.computer }));
    }
    case 'stop_computer_task': {
      const out = await remoteTask('stop', args, { task: taskId(args) });
      return withSummary(out, () => summary.taskBlock(out.res, { computer: args.computer }));
    }
    case 'merge_computer_task': {
      const task = taskId(args);
      const out = await remoteTask('merge', args, { task, dryRun: args.dry_run === true || undefined });
      const info = await taskInfo(task, args.computer);
      if (!out.isError && !out.res.dryRun && Array.isArray(out.res.applied) && out.res.applied.length) {
        await noteApplied({ task, computer: info.computer || (typeof args.computer === 'string' ? args.computer.slice(0, 100) : ''), how: 'merge', count: out.res.applied.length });
      }
      return withSummary(out, () => summary.merged(out.res, { computer: info.computer || args.computer, prompt: info.prompt }));
    }
    case 'undo_computer_task_merge': {
      const out = await remoteTask('undo-merge', args, { task: taskId(args) });
      const kept = Array.isArray(out.res && out.res.kept) && out.res.kept.length;
      if (!out.isError && Array.isArray(out.res.undone) && out.res.undone.length && !out.res.partial && !kept) await noteApplied({ task: taskId(args), undone: true });
      return out;
    }
    case 'list_computer_tasks': {
      const out = await remoteTask('list', args, {});
      return withSummary(out, () => summary.listed(out.res, { computer: args.computer }));
    }
    case 'clear_page_highlights':
      await postEvent({ type: 'point-clear', ts: Date.now() });
      return { text: 'Cleared.' };
    case 'list_live_pages': {
      const all = await getJson('/pages/live');
      const pages = Array.isArray(all) ? all : [];
      if (!pages.length) return { text: 'No pages are connected. Run /editlens to connect this project\'s page, then open the address it prints.' };
      const mine = (p) => p.root && related(p.root, PROJECT_DIR);
      return {
        text: pages.map((p) => `${p.title || '(untitled)'} — ${p.url}${p.root ? (mine(p) ? ' (this project)' : ` (project ${p.root})`) : ' (no project: messages from it are not sent to Claude)'}${p.listen ? ' (waiting for messages)' : ''}`).join('\n'),
      };
    }
    default:
      return { text: `Unknown tool ${name}`, isError: true };
  }
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function onMessage(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params && typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'live-page', version: require('../lib/config').version },
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TASK_ACCOUNT ? [] : TOOLS });
    case 'tools/call': {
      if (TASK_ACCOUNT) return reply(id, { content: [{ type: 'text', text: TASK_ACCOUNT_TEXT }], isError: true });
      let out;
      try {
        out = await callTool(params && params.name, (params && params.arguments) || {});
      } catch (err) {
        // Report tool failures to Claude instead of crashing the server.
        out = { text: `${PRODUCT_NAME} server error: ${err.message}`, isError: true };
      }
      // A task tool: the plain summary for the user first (Claude Code shows it and collapses the rest),
      // then the data for Claude.
      const content = out.summary ? [{ type: 'text', text: out.summary }, { type: 'text', text: out.text }] : [{ type: 'text', text: out.text }];
      return reply(id, { content, isError: Boolean(out.isError) });
    }
    default:
      if (isRequest) replyError(id, -32601, `Method not found: ${method}`);
      return undefined; // notifications such as notifications/initialized need no response
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    if (err instanceof SyntaxError) return replyError(null, -32700, 'Parse error');
    throw err;
  }
  // Valid JSON that is not a request object (null, 1, [], "x").
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return replyError(null, -32600, 'Invalid Request');
  onMessage(msg).catch((err) => {
    process.stderr.write(`live-page: ${err.stack || err.message}\n`);
    if (msg.id !== undefined && msg.id !== null) replyError(msg.id, -32603, err.message);
  });
  return undefined;
});
rl.on('close', () => process.exit(0));
