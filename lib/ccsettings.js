'use strict';
// Claude Code's settings that EditLens shows or follows, read only: the auto-compact window (/autocompact)
// and the effort level (/effort). Order: an env variable, then the settings files (user, the project's
// settings.json, then settings.local.json; a later file takes precedence). modelSettings.<model> replaces
// the top level.
const path = require('path');
const { configDir } = require('./pluginstate');
const { readSmall } = require('./readsmall');

const MIN = 100000;
const MAX = 1000000;
const FILE_MAX = 1024 * 1024;

// A window in tokens (an integer from 100000 to 1000000), or null ("auto", missing or bad).
function windowOf(v) {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  return Number.isSafeInteger(n) && n >= MIN && n <= MAX ? n : null;
}

function readJson(file) {
  const text = readSmall(file, FILE_MAX);
  if (typeof text !== 'string') return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

// "claude-opus-4-8[1m]", "claude-opus-4-8-20260101", "us.anthropic.claude-opus-4-8-v1:0" and
// "claude-opus-4-8@20260101" -> "claude-opus-4-8".
function canonicalModel(model) {
  if (typeof model !== 'string' || !model) return '';
  return model.trim().toLowerCase()
    .replace(/\[1m\]$/, '')
    .replace(/^(?:[a-z]{2,4}\.)?anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/@\d{8}$/, '')
    .replace(/-\d{8}$/, '');
}

// The value one settings file gives for the model, or undefined when the file doesn't name it.
function fromFile(s, model) {
  const per = s && s.modelSettings && typeof s.modelSettings === 'object' ? s.modelSettings : null;
  const want = canonicalModel(model);
  if (per && want) {
    for (const [k, v] of Object.entries(per)) {
      if (canonicalModel(k) === want && v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'autoCompactWindow')) return v.autoCompactWindow;
    }
  }
  return s && Object.prototype.hasOwnProperty.call(s, 'autoCompactWindow') ? s.autoCompactWindow : undefined;
}

// The auto-compact window for a session in cwd running model, or null when none is set ("auto").
// envValue: CLAUDE_CODE_AUTO_COMPACT_WINDOW as that session has it (the hook reports it).
const cache = new Map(); // "dir\0cwd\0model" -> { at, value }; settings are read at most every 2 s
function compactWindow(cwd, model, envValue, env = process.env) {
  if (envValue !== undefined && envValue !== null && envValue !== '') return windowOf(envValue);
  const key = `${configDir(env)}\0${cwd || ''}\0${model || ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 2000) return hit.value;
  const value = readWindow(cwd, model, env);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return value;
}
function settingsFiles(cwd, env) {
  const files = [path.join(configDir(env), 'settings.json')];
  if (typeof cwd === 'string' && cwd) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  return files;
}
function readWindow(cwd, model, env) {
  let value;
  for (const f of settingsFiles(cwd, env)) {
    const v = fromFile(readJson(f), model);
    if (v !== undefined) value = v;
  }
  return windowOf(value);
}

// Claude Code's effortLevel for a session in cwd (the value /effort saves), as a string, or null when
// none is set. The caller checks it is a level.
const effortCache = new Map(); // "dir\0cwd" -> { at, value }
function effortLevel(cwd, env = process.env) {
  const key = `${configDir(env)}\0${cwd || ''}`;
  const hit = effortCache.get(key);
  if (hit && Date.now() - hit.at < 2000) return hit.value;
  let value = null;
  for (const f of settingsFiles(cwd, env)) {
    const s = readJson(f);
    if (s && Object.prototype.hasOwnProperty.call(s, 'effortLevel')) value = typeof s.effortLevel === 'string' ? s.effortLevel.trim().toLowerCase() : null;
  }
  effortCache.set(key, { at: Date.now(), value });
  if (effortCache.size > 50) effortCache.delete(effortCache.keys().next().value);
  return value;
}

module.exports = { compactWindow, effortLevel, canonicalModel, windowOf, MIN, MAX };
