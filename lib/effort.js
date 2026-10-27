'use strict';
// Effort: Claude's effort level (Claude Code's /effort). Page control and tasks set it through the
// Agent SDK (Options.effort at start, applyFlagSettings({ effortLevel }) while it runs). A level is
// always one of LEVELS, given as its own field: never read from a prompt's text.
const fs = require('fs');
const { writeAtomic } = require('./atomic');
const ccsettings = require('./ccsettings');

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
// The EditLens setting (plugin.json "effort") uses the labels. Auto (the default): Claude Code's own level.
const BY_LABEL = { Low: 'low', Medium: 'medium', High: 'high', 'Extra high': 'xhigh', Max: 'max' };
const AUTO = 'Auto';
const DEFAULT = 'high';
const BAD_LEVEL = 'Effort must be one of: low, medium, high, xhigh, max.';

function isLevel(v) {
  return typeof v === 'string' && LEVELS.includes(v);
}

// -> 0..4, or -1 for anything that isn't a level.
function rank(v) {
  return isLevel(v) ? LEVELS.indexOf(v) : -1;
}

function label(v) {
  return isLevel(v) ? LABELS[v] : '';
}

// The level the EditLens setting picks (values: lib/settings.js normalize()). Auto, missing or bad:
// the effortLevel in Claude Code's settings for cwd, or null (send none: Claude Code uses its default).
function fromSettings(values, cwd, env) {
  const v = values && values.effort;
  if (BY_LABEL[v]) return BY_LABEL[v];
  const own = ccsettings.effortLevel(cwd, env);
  return isLevel(own) ? own : null;
}

// The setting is Auto (also when it is missing or bad).
function isAuto(values) {
  return !BY_LABEL[values && values.effort];
}

// A level typed or sent by a person or a program: the id ("xhigh") or its label ("Extra high"),
// any case. -> the level, or null. "auto" is not a level: see isAuto().
function parse(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (isLevel(s)) return s;
  if (s === 'extra high') return 'xhigh';
  return null;
}

// The lower of two levels (a cap); a missing one doesn't count.
function lower(a, b) {
  if (!isLevel(a)) return isLevel(b) ? b : null;
  if (!isLevel(b)) return a;
  return rank(a) <= rank(b) ? a : b;
}

// The shape the pages, the summary and the agents always get (the chips depend on it).
// level: requested; used: what Claude uses after limits (null: none sent or unknown); supported:
// the model uses effort (null: unknown); cap: highest level settings or the organization allow
// (null: none known); source: 'page' (EditLens set it) or 'terminal' (Claude Code's, read only).
function shape({ level = null, used = null, supported = null, cap = null, source = 'page', fromClaude = false } = {}) {
  const out = {
    level: isLevel(level) ? level : null,
    used: isLevel(used) ? used : null,
    supported: typeof supported === 'boolean' ? supported : null,
    cap: isLevel(cap) ? cap : null,
    source: source === 'terminal' ? 'terminal' : 'page',
  };
  // No one set the level (Auto): Claude Code picked it by itself.
  if (fromClaude === true) out.fromClaude = true;
  return out;
}

// What Claude reports after a level was requested. applied: get_settings applied.effort (null: no
// effort sent, the model has none); models: ModelInfo.supportedEffortLevels or null; supports:
// ModelInfo.supportsEffort or null; settingsCap: maxEffortLevel in the settings.
// -> { used, supported, cap }
function resolve({ requested, applied, appliedKnown = true, models = null, supports = null, settingsCap = null }) {
  if (supports === false || (appliedKnown && applied === null)) return { used: null, supported: false, cap: isLevel(settingsCap) ? settingsCap : null };
  const used = isLevel(applied) ? applied : null;
  let cap = isLevel(settingsCap) ? settingsCap : null;
  if (used && rank(used) < rank(requested)) {
    // Lower than requested: the model doesn't have that level (Max runs as High), or a limit.
    const modelHas = Array.isArray(models) ? models.includes(requested) : requested !== 'max';
    if (modelHas) cap = lower(cap, used);
  }
  return { used, supported: used ? true : supports === true ? true : null, cap };
}

// The level kept for each page conversation (its session id), so a conversation that continues
// keeps the level it had. Newest KEEP. Throws fs errors (with a code) on write.
const KEEP = 50;
// The mark of a level set for page control: v 3 from 0.24.56. No mark (0.24.51 or earlier) may be
// Claude Code's own level; v 2 (0.24.52 to 0.24.55) may be the Effort setting's.
const MARK = 3;
function readKept(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (err) {
    if (err instanceof SyntaxError || ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(err && err.code)) return {};
    throw err;
  }
}
// level null: back to Claude Code's own level (Auto), so the kept one is forgotten.
function remember(file, sessionId, level, now = Date.now()) {
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId) || (level !== null && !isLevel(level))) return;
  const all = readKept(file);
  if (level === null && !all[sessionId]) return;
  if (level !== null && all[sessionId] && all[sessionId].level === level && all[sessionId].v === MARK) return;
  if (level === null) delete all[sessionId];
  else all[sessionId] = { level, at: now, v: MARK };
  const keep = Object.entries(all).filter(([, r]) => r && isLevel(r.level) && Number.isFinite(r.at)).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP);
  writeAtomic(file, JSON.stringify(Object.fromEntries(keep)), { mkdir: true });
}
// -> the level kept for that conversation, or null. Max lasts for one session (D24): it is kept
// only when restored (EditLens starts the same conversation again after a restart). A level kept
// before v 3 may be Claude Code's own or the Effort setting's, so it is never used (W1, X1, K2).
function kept(file, sessionId, { restored = false } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const r = readKept(file)[sessionId];
  if (!r || !isLevel(r.level) || r.v !== MARK) return null;
  return r.level === 'max' && restored !== true ? null : r.level;
}

module.exports = { LEVELS, LABELS, BY_LABEL, AUTO, DEFAULT, BAD_LEVEL, isLevel, rank, label, fromSettings, isAuto, parse, lower, shape, resolve, remember, kept };
