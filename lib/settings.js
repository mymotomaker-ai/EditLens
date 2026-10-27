'use strict';
// Settings are plugin.json userConfig (stored by Claude Code). Hooks read CLAUDE_PLUGIN_OPTION_*,
// the mod gets them in register(). Invalid or missing values use the defaults.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MANIFEST = path.join(__dirname, '..', '.claude-plugin', 'plugin.json');

function readManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    return m && typeof m === 'object' ? m : {};
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err instanceof SyntaxError)) return {};
    throw err;
  }
}

const MANIFEST_DATA = readManifest();
const PLUGIN_NAME = typeof MANIFEST_DATA.name === 'string' && MANIFEST_DATA.name ? MANIFEST_DATA.name : 'editlens';
const SCHEMA = MANIFEST_DATA.userConfig && typeof MANIFEST_DATA.userConfig === 'object' ? MANIFEST_DATA.userConfig : {};
const KEYS = Object.keys(SCHEMA);
// What the page may change (through Claude Code, which doesn't ask for these). The safety check,
// auto connect, paired computers running Claude here, subagent copies, page control's permission
// mode and the port can be changed only in Claude Code.
const PAGE_EDITABLE = ['start', 'effort', 'permission_glow', 'highlight', 'hover_code', 'pick_box', 'dictation', 'follow_page', 'expand_code_view', 'wait', 'line_above_prompt', 'theme', 'text_size', 'editor', 'tasks_at_once'];

function defaults() {
  const out = {};
  for (const k of KEYS) out[k] = SCHEMA[k].default;
  return out;
}

// One value, checked against its field: -> the value, or undefined when it is invalid.
function check(key, raw) {
  const f = SCHEMA[key];
  if (!f || raw === undefined || raw === null) return undefined;
  // An array or object is never a value: ["off"] and ["1"] would read as text (Sol L5).
  if (typeof raw === 'object' || typeof raw === 'function') return undefined;
  if (f.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false;
    return undefined;
  }
  if (f.type === 'number') {
    if (typeof raw === 'string' && !raw.trim()) return undefined;
    // Text: digits only, so "1e3", "0x1100", "4705.0" or "+4705" are not taken as numbers.
    if (typeof raw === 'string' && !/^\d{1,9}$/.test(raw.trim())) return undefined;
    if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
    const n = typeof raw === 'number' ? raw : Number(raw.trim());
    if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
    if ((typeof f.min === 'number' && n < f.min) || (typeof f.max === 'number' && n > f.max)) return undefined;
    return n;
  }
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  if (Array.isArray(f.options)) return f.options.includes(s) ? s : undefined;
  return s;
}

// Any object of raw values -> every key set, each value valid.
function normalize(raw) {
  const out = defaults();
  if (!raw || typeof raw !== 'object') return out;
  for (const k of KEYS) {
    const v = check(k, raw[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// The values Claude Code gave this hook process.
function fromEnv(env = process.env) {
  const raw = {};
  for (const k of KEYS) {
    const v = env['CLAUDE_PLUGIN_OPTION_' + k.toUpperCase()];
    if (v !== undefined) raw[k] = v;
  }
  return { values: normalize(raw), set: Object.keys(raw).length > 0 };
}

const MODE_IDS = { Ask: 'default', 'Accept edits': 'acceptEdits', Plan: 'plan', Auto: 'auto', "Don't ask": 'dontAsk' };
const SIZE_IDS = { Small: 's', Medium: 'm', Large: 'l' };
const THEME_IDS = { Auto: null, Light: 'light', Dark: 'dark' };
// The editor the file menu's Open link starts (a vscode:// or cursor:// link); None hides Open.
const EDITOR_IDS = { 'VS Code': 'vscode', Cursor: 'cursor', None: null };

// Tasks at once (tasks from paired computers running here at the same time): a whole number 1 to 8.
// Out of range is clamped; anything else (NaN, "", "1e3", null, an object) is the default.
const TASKS_MIN = 1;
const TASKS_MAX = 8;
const TASKS_DEFAULT = 4;
function taskLimit(raw) {
  // Text: digits only, as check() takes a number ("1e3", "0x4" and "4.5" don't count).
  if (typeof raw === 'string' && !/^\s*\d{1,9}\s*$/.test(raw)) return TASKS_DEFAULT;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) return TASKS_DEFAULT;
  return Math.min(TASKS_MAX, Math.max(TASKS_MIN, n));
}

function modeId(values) {
  return MODE_IDS[values && values.permission_mode] || 'auto';
}

function startsControl(values) {
  return Boolean(values && values.start === 'Connect and turn on page control');
}

// Whether /editlens (and /editlens restart, which then does the same) turns on page control: when
// asked (/editlens control), else when the start setting says so. Not in a session EditLens started
// (page control's own Claude, a task): page control runs in the project folder, not a task's copy.
function startsControlNow({ asked = false, values, env = process.env } = {}) {
  if (asked) return true;
  if (env.EDITLENS_DRIVEN === '1' || env.EDITLENS_NO_START === '1') return false;
  return startsControl(values);
}

// For the panel: the values, what each one is, and which ones the page may change.
function describe(values) {
  return KEYS.map((k) => ({
    key: k, title: SCHEMA[k].title, description: SCHEMA[k].description, type: SCHEMA[k].type,
    options: Array.isArray(SCHEMA[k].options) ? SCHEMA[k].options : null,
    value: values[k], default: SCHEMA[k].default, pageEditable: PAGE_EDITABLE.includes(k),
    // A number's range (Tasks at once: the page's stepper).
    ...(SCHEMA[k].type === 'number' ? { min: SCHEMA[k].min, max: SCHEMA[k].max } : {}),
  }));
}

// Page control's modes, from most strict to least strict ("Don't ask" never asks; the Settings
// pane also treats it as the least strict).
const MODE_ORDER = ['Plan', 'Ask', 'Accept edits', 'Auto', "Don't ask"];

// True when `to` lets Claude or other computers do more than `from` without the user. Only the
// settings the server checks for safety; the rest are never less strict.
function lessStrict(key, from, to) {
  if (from === to) return false;
  if (key === 'safety_check') return to === false;
  if (key === 'remote_tasks' || key === 'paired_answers') return to === true;
  if (key === 'task_account') return to === 'Root (unsafe)';
  if (key === 'permission_mode') {
    const a = MODE_ORDER.indexOf(from);
    const b = MODE_ORDER.indexOf(to);
    return b > a;
  }
  return false;
}

// What Claude Code saved for this plugin in the user's settings file (pluginConfigs, written by
// /config and the mod's Settings pane; hooks get them as CLAUDE_PLUGIN_OPTION_*).
// -> { key: [valid values, one per install of the plugin] } or null when the file can't be read.
function savedOptions(env = process.env) {
  const all = savedConfigs(env);
  if (!all) return null;
  const out = {};
  for (const options of all) {
    for (const k of KEYS) {
      const v = check(k, options[k]);
      if (v !== undefined) (out[k] = out[k] || []).push(v);
    }
  }
  return out;
}

// The options objects saved for this plugin (one per install), or null when the file can't be read.
function savedConfigs(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  } catch (err) {
    if (err && (['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(err.code) || err instanceof SyntaxError)) return null;
    throw err;
  }
  const configs = data && typeof data.pluginConfigs === 'object' && data.pluginConfigs ? data.pluginConfigs : {};
  return Object.entries(configs).filter(([id, c]) => id.split('@')[0] === PLUGIN_NAME && c && c.options && typeof c.options === 'object')
    .map(([, c]) => c.options);
}

// Saved values that are not valid, so their defaults are used (the mod's effectNotes says the same in
// the terminal): { key: the value as saved, as text of at most 40 characters }. {} when none.
function savedInvalid(env = process.env) {
  const out = {};
  for (const options of savedConfigs(env) || []) {
    for (const k of KEYS) {
      const raw = options[k];
      if (raw === undefined || raw === null || check(k, raw) !== undefined || k in out) continue;
      const text = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
      out[k] = text.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40);
    }
  }
  return out;
}

// The settings for a command: the options Claude Code gave it, else (a command Claude ran with its
// Bash tool gets none) the ones saved in its settings file, read only. raw: each value as given or
// saved, an invalid one too (for the "not a valid value" note). -> { raw, values, from }
function given(env = process.env) {
  const own = fromEnv(env);
  if (own.set) {
    const raw = {};
    for (const k of KEYS) if (env['CLAUDE_PLUGIN_OPTION_' + k.toUpperCase()] !== undefined) raw[k] = env['CLAUDE_PLUGIN_OPTION_' + k.toUpperCase()];
    return { raw, values: own.values, from: 'env' };
  }
  // A valid value first (one per install of the plugin), else the invalid one as saved.
  const saved = savedOptions(env) || {};
  const raw = { ...savedInvalid(env) };
  for (const k of Object.keys(saved)) raw[k] = saved[k][0];
  return { raw, values: normalize(raw), from: Object.keys(raw).length ? 'saved' : 'defaults' };
}

// True when Claude Code's saved settings (savedOptions()) give `key` this value. Only a saved value
// counts: a key not saved may be set by a policy or a --settings file this can't read, so its
// default proves nothing (the Settings pane's Reset writes each default).
function savedAs(key, value, saved) {
  return Boolean(saved && SCHEMA[key] && saved[key] && saved[key].includes(value));
}

module.exports = { taskLimit, TASKS_MIN, TASKS_MAX, TASKS_DEFAULT, SCHEMA, KEYS, PLUGIN_NAME, lessStrict, savedOptions, savedInvalid, savedAs, given, PAGE_EDITABLE, defaults, check, normalize, fromEnv, modeId, startsControl, startsControlNow, describe, MODE_IDS, SIZE_IDS, THEME_IDS, EDITOR_IDS };
