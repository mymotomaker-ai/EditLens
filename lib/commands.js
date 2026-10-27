'use strict';
// Commands for the panel's palette. A page can't type into Claude Code, so:
//   runnable  custom commands/skills: sent as a page message (Claude runs them via Skill)
//   copy      built-ins (/compact, /model, ...): the panel copies them for pasting

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_COMMANDS = 300;
const HEAD_BYTES = 4096;
const NAME_RE = /^[A-Za-z0-9][\w.:-]{0,79}$/;

// Built-in commands, run only in Claude Code itself.
const BUILT_IN = [
  ['compact', 'Summarize the conversation to reduce the context used', '[instructions]'],
  ['clear', 'Start a new conversation with empty context', ''],
  ['context', 'Show what is using the context window', ''],
  ['model', 'Switch the model', '[model]'],
  ['cost', 'Show token usage and cost for this session', ''],
  ['usage', 'Show your plan usage limits', ''],
  ['resume', 'Resume an earlier conversation', ''],
  ['rewind', 'Restore an earlier point in the conversation', ''],
  ['memory', 'Edit CLAUDE.md memory files', ''],
  ['init', 'Create a CLAUDE.md for this project', ''],
  ['permissions', 'View or change tool permissions', ''],
  ['agents', 'Manage subagents', ''],
  ['mcp', 'Manage MCP servers', ''],
  ['hooks', 'View hook settings', ''],
  ['plugin', 'Manage plugins', ''],
  ['config', 'Open settings', ''],
  ['status', 'Show version, model and account', ''],
  ['export', 'Export the conversation', ''],
  ['add-dir', 'Add a working directory', '<path>'],
  ['doctor', 'Check the Claude Code installation', ''],
  ['help', 'List commands', ''],
].map(([name, description, argumentHint]) => ({ name, description, argumentHint, source: 'Claude Code', kind: 'built-in', runnable: false }));

function readHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EISDIR') return null;
    throw err;
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// YAML frontmatter, flat keys only (enough for description, argument-hint, name, flags).
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function firstLine(text) {
  const body = String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const line = body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'));
  return line ? line.trim().slice(0, 140) : '';
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EACCES') return [];
    throw err;
  }
}

function entry(name, head, source, kind) {
  const fm = frontmatter(head);
  return {
    name,
    description: (fm.description || firstLine(head)).slice(0, 200),
    argumentHint: (fm['argument-hint'] || '').slice(0, 80),
    source,
    kind,
    // Commands that opt out of model invocation can only be typed by the user.
    runnable: fm['disable-model-invocation'] !== 'true',
  };
}

// commands/*.md (subfolders become name:sub) and skills/<name>/SKILL.md under one root.
function scanRoot(root, source, prefix, out) {
  const walk = (dir, parts) => {
    for (const d of listDir(dir)) {
      if (d.isDirectory() && parts.length < 3) walk(path.join(dir, d.name), [...parts, d.name]);
      else if (d.isFile() && d.name.endsWith('.md')) {
        const name = prefix + [...parts, d.name.slice(0, -3)].join(':');
        const head = readHead(path.join(dir, d.name));
        if (head !== null && NAME_RE.test(name)) out.push(entry(name, head, source, 'command'));
      }
    }
  };
  walk(path.join(root, 'commands'), []);
  for (const d of listDir(path.join(root, 'skills'))) {
    if (!d.isDirectory()) continue;
    const head = readHead(path.join(root, 'skills', d.name, 'SKILL.md'));
    if (head === null) continue;
    const name = prefix + (frontmatter(head).name || d.name);
    if (NAME_RE.test(name)) out.push(entry(name, head, source, 'skill'));
  }
}

// Plugins Claude Code has installed: ~/.claude/plugins/installed_plugins.json.
function pluginRoots(claudeDir) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES' || err instanceof SyntaxError) return [];
    throw err;
  }
  const plugins = data && typeof data.plugins === 'object' && data.plugins ? data.plugins : {};
  const roots = [];
  for (const [id, installs] of Object.entries(plugins)) {
    const name = id.split('@')[0];
    for (const inst of Array.isArray(installs) ? installs : [installs]) {
      if (inst && typeof inst.installPath === 'string') roots.push({ name, root: inst.installPath });
    }
  }
  return roots;
}

function listCommands({ projectDir, pluginRoot, pluginName, claudeDir = path.join(os.homedir(), '.claude') } = {}) {
  const found = [];
  if (projectDir) scanRoot(path.join(projectDir, '.claude'), 'project', '', found);
  scanRoot(claudeDir, 'user', '', found);
  const roots = pluginRoots(claudeDir);
  if (pluginRoot && pluginName && !roots.some((r) => r.name === pluginName)) roots.push({ name: pluginName, root: pluginRoot });
  const seenRoots = new Set();
  for (const r of roots) {
    if (seenRoots.has(r.name)) continue; // several scopes of one plugin: list it once
    seenRoots.add(r.name);
    scanRoot(r.root, `plugin ${r.name}`, `${r.name}:`, found);
  }
  // The first one is used: built-ins can't be overridden, and a project command hides a user one.
  const byName = new Map();
  for (const c of [...BUILT_IN, ...found]) if (!byName.has(c.name)) byName.set(c.name, c);
  return [...byName.values()].slice(0, MAX_COMMANDS);
}

module.exports = { listCommands, frontmatter, BUILT_IN, NAME_RE };
