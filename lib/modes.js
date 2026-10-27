'use strict';
// Permission modes, as Claude Code names them (Shift+Tab in the terminal), and the rules for a
// subagent that the panel gave its own mode. Claude Code applies the session's mode; page control
// also applies a subagent's own mode through a PreToolUse hook.

const path = require('path');

// The modes Claude Code takes, in its Shift+Tab order. Bypass is never part of the cycle.
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const CYCLE = ['default', 'acceptEdits', 'plan', 'auto'];
// A subagent can get these; null means "same as Claude".
const AGENT_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Tools that only read, plan or talk: Claude Code doesn't ask about them, and neither does a
// subagent's own mode.
const SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'LSP', 'ToolSearch', 'WebSearch', 'Skill',
  'TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'BashOutput',
  'Agent', 'Task', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
  'ReadMcpResourceDirTool', 'SubagentHandback', 'ListAgents', 'GetTask', 'FetchInboxMessage',
]);
// A subagent's message to Claude only returns text. A message to another session can make that
// session change things, so the subagent's own mode applies to it.
function toClaude(tool, input) {
  return tool === 'SendMessage' && !!input && input.to === 'main';
}
// This plugin's own tools (mcp/live-page.js). These change nothing: lists, highlights, code view,
// reads of a task on a paired computer and the team board. Every other one changes something
// (starts, stops, messages, merges, applies or copies), and Plan and Ask refuse it.
const OWN_TOOL = /^mcp__.*live-page__([a-z_]+)$/;
const OWN_READS = new Set([
  'highlight_on_page', 'clear_page_highlights', 'show_code', 'list_live_pages',
  'read_board', 'post_note', 'claim_task', 'complete_task', 'share_finding',
  'list_paired_computers', 'list_computer_tasks', 'check_computer_task', 'wait_for_computer_tasks',
  'get_computer_task_diff', 'list_computer_task_files', 'search_computer_task', 'get_computer_task_changes',
  'get_computer_task_file',
]);

function isMode(m) {
  return MODES.includes(m);
}

function ownTool(tool) {
  const m = OWN_TOOL.exec(String(tool || ''));
  return m ? m[1] : null;
}

// True for a live-page tool that changes something (any not in OWN_READS, so a new one too).
function liveToolChanges(tool) {
  const name = ownTool(tool);
  return name !== null && !OWN_READS.has(name);
}

// True for a live-page tool that changes nothing (in OWN_READS).
function liveToolReads(tool) {
  const name = ownTool(tool);
  return name !== null && OWN_READS.has(name);
}

const READ_ALLOW = { decision: 'allow', reason: 'An EditLens tool that changes nothing.' };

function isSafe(tool) {
  return SAFE_TOOLS.has(tool) || (ownTool(tool) !== null && !liveToolChanges(tool));
}

function liveRefusal(who, tool) {
  return { decision: 'deny', reason: `${who}: it may use only the live-page tools that change nothing (lists, code view, `
    + `highlights, the team board). ${ownTool(tool)} changes something, so it is refused here.` };
}

// Claude's own mode under page control: in Plan, the live-page tools that change something are refused.
// The ones that change nothing are allowed in every mode (Claude Code's own rules would ask).
function sessionDecision(sessionMode, tool) {
  if (liveToolReads(tool)) return READ_ALLOW;
  return sessionMode === 'plan' && liveToolChanges(tool) ? liveRefusal('Claude is in Plan mode', tool) : null;
}

function inside(file, cwd) {
  if (typeof file !== 'string' || !file || typeof cwd !== 'string' || !cwd) return false;
  const rel = path.relative(path.resolve(cwd), path.resolve(cwd, file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// What page control's hook returns for one tool call of a subagent that has its own mode:
// { decision: 'allow' | 'ask' | 'deny', reason } or null (leave it to Claude Code).
//   mode: the subagent's own mode; sessionMode: Claude's mode right now.
function agentDecision(mode, sessionMode, tool, input, cwd) {
  if (!mode) return null;
  if (liveToolChanges(tool)) {
    if (mode === 'plan') return liveRefusal('This subagent is set to Plan in the panel', tool);
    if (mode === 'default') return liveRefusal('This subagent is set to Ask in the panel', tool);
    return null;
  }
  if (liveToolReads(tool)) return READ_ALLOW;
  if (isSafe(tool) || toClaude(tool, input)) return null;
  const permissive = sessionMode === 'auto' || sessionMode === 'bypassPermissions' || sessionMode === 'acceptEdits' || sessionMode === 'dontAsk';
  const edit = EDIT_TOOLS.has(tool);
  const file = input && (input.file_path || input.notebook_path);
  switch (mode) {
    case 'bypassPermissions':
      return { decision: 'allow', reason: 'This subagent is set to Bypass permissions in the panel.' };
    case 'plan':
      return { decision: 'deny', reason: 'This subagent is set to Plan in the panel: it reads and plans only. Report the plan instead of making changes.' };
    case 'acceptEdits':
      if (edit && inside(file, cwd)) return { decision: 'allow', reason: 'This subagent is set to Accept edits in the panel.' };
      // Commands and other tools still ask, even when Claude itself runs in Auto or Bypass.
      if (sessionMode === 'auto' || sessionMode === 'bypassPermissions') return { decision: 'ask', reason: 'This subagent is set to Accept edits in the panel, so it asks before anything but edits.' };
      return null;
    case 'default':
      // Claude's own mode would allow it without asking; this subagent asks.
      if (permissive) return { decision: 'ask', reason: 'This subagent is set to Ask in the panel.' };
      return null;
    default:
      return null;
  }
}

module.exports = { MODES, CYCLE, AGENT_MODES, EDIT_TOOLS, isMode, isSafe, inside, agentDecision, sessionDecision, liveToolChanges, liveToolReads };
