'use strict';
// Errors from the Claude Agent SDK and Claude Code (page control, tasks) in plain words, in one
// place. The raw text (with its ids) goes to the server log only; the user sees these words.

const NEW_CHAT = "Started a new chat: the earlier one wasn't found.";
const SEE_LOG = `The details are in the EditLens log: ${require('./config').logFile}`;

const NOT_FOUND_RE = /No conversation found with session ID|conversation .{0,40}not found/i;
const TOO_LONG_RE = /prompt is too long|context (length|window).{0,40}exceed/i;

// Known result errors: [pattern, plain words].
const KNOWN = [
  [NOT_FOUND_RE, "The earlier chat wasn't found."],
  [/credit balance is too low/i, 'Your Anthropic account has no credit left.'],
  [/\bmodel\b.{0,80}\b(not found|does not exist|not available|invalid)\b|invalid model/i, "The model chosen in Claude Code isn't available. Pick another one with /model in Claude Code."],
  [/\b(aborted|AbortError)\b/i, 'Claude was stopped.'],
  [/max(imum)? turns/i, 'Claude stopped: it used all the steps allowed for one message.'],
];

// True when Claude couldn't find the conversation it was asked to continue.
function notFound(text) {
  return NOT_FOUND_RE.test(String(text || ''));
}

// unknown: the words for an error not listed here; task: the error is from a task, not page control.
// -> { text, kind: 'exit' | 'not-found' | 'error' }
function plainSdk(raw, unknown = `Claude stopped with an error. ${SEE_LOG}`, { task = false } = {}) {
  if (raw === undefined || raw === null || raw === '') return { text: 'Claude stopped unexpectedly.', kind: 'exit' };
  const s = String(raw);
  const code = /Claude Code process exited with code (-?\d+)/.exec(s);
  if (code) return { text: `Claude stopped unexpectedly (exit code ${code[1]}).`, kind: 'exit' };
  const sig = /Claude Code process terminated by signal (\w+)/.exec(s);
  if (sig) return { text: `Claude was stopped from outside (${sig[1]}).`, kind: 'exit' };
  if (TOO_LONG_RE.test(s)) return { text: `The chat is too long for Claude. ${task ? 'Start a new task.' : 'Start a new one: /editlens control new.'}`, kind: 'error' };
  for (const [re, text] of KNOWN) if (re.test(s)) return { text, kind: re === NOT_FOUND_RE ? 'not-found' : 'error' };
  return { text: unknown, kind: 'error' };
}

// Page control asked for from a session EditLens started (a task or page control's own Claude).
const OWN_SESSION = 'EditLens started this session (a task or the page). Page control runs in your project folder itself, not in a task\'s copy, so it is not turned on from here.';

module.exports = { NEW_CHAT, SEE_LOG, OWN_SESSION, notFound, plainSdk };
