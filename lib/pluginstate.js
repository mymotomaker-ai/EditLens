'use strict';
// Is the EditLens plugin active for one project folder? Installed for it (installed_plugins.json:
// user scope everywhere, project or local scope only in that project) and enabled (enabledPlugins;
// the last file that names it takes precedence: user settings, then .claude/settings.json, then
// .claude/settings.local.json). Read only. CLAUDE_CONFIG_DIR changes Claude Code's folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { within } = require('./paths');

const NAME = 'editlens';
const READ_CODES = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR'];

function configDir(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

// A JSON file, or null when it is missing, unreadable or not JSON.
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err instanceof SyntaxError || READ_CODES.includes(err && err.code)) return null;
    throw err;
  }
}

// EditLens's installs that apply in cwd: [{ key, scope, projectPath }].
function installsFor(cwd, dir) {
  const data = readJson(path.join(dir, 'plugins', 'installed_plugins.json'));
  const plugins = data && typeof data.plugins === 'object' && data.plugins ? data.plugins : {};
  const out = [];
  for (const [key, val] of Object.entries(plugins)) {
    if (key.split('@')[0] !== NAME) continue;
    // Version 1 of the file had one entry per plugin (user scope), version 2 a list.
    for (const e of Array.isArray(val) ? val : [val]) {
      if (!e || typeof e !== 'object') continue;
      const scope = typeof e.scope === 'string' ? e.scope : 'user';
      const projectPath = typeof e.projectPath === 'string' ? e.projectPath : null;
      if ((scope === 'project' || scope === 'local') && !(projectPath && cwd && within(cwd, projectPath))) continue;
      out.push({ key, scope, projectPath });
    }
  }
  return out;
}

// What the settings files say about the key: true, false, or null when none names it.
function enabledIn(key, files) {
  let on = null;
  let from = null;
  for (const f of files) {
    const s = readJson(f);
    const list = s && typeof s.enabledPlugins === 'object' && s.enabledPlugins ? s.enabledPlugins : null;
    if (list && Object.prototype.hasOwnProperty.call(list, key)) {
      on = list[key] !== false;
      from = f;
    }
  }
  return { on, from };
}

// -> { active, installed: [{ key, scope, projectPath, enabled, from }], why }
// why: plain words for the log when it is not active.
function pluginState(cwd, { env = process.env, home = os.homedir() } = {}) {
  const dir = configDir(env, home);
  const installs = installsFor(cwd, dir);
  // A project's settings are read from the folder the install names, or from cwd.
  const installed = installs.map((i) => {
    const root = i.projectPath || cwd || null;
    const files = [path.join(dir, 'settings.json'), ...(root ? [path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')] : [])];
    const e = enabledIn(i.key, files);
    return { ...i, enabled: e.on, from: e.from };
  });
  const active = installed.some((i) => i.enabled === true);
  let why = null;
  if (!installs.length) why = `EditLens is not installed in Claude Code for ${cwd || 'this folder'} (${path.join(dir, 'plugins', 'installed_plugins.json')})`;
  else if (!active) why = installed.some((i) => i.enabled === false) ? 'EditLens is turned off in Claude Code\'s settings for this project' : 'EditLens is installed but not turned on in Claude Code\'s settings';
  return { active, installed, why };
}

module.exports = { pluginState, configDir };
