'use strict';
// Moves state from the legacy folder (~/.claude/claude-live-mode) to the EditLens state folder.
// Runs after the old server stops (Windows locks its folder); what can't move is left in place.
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');

const LEGACY_NAME = 'claude-live-mode';

// The old folder, or null when a test or the user set the state folder themselves.
function legacyDir() {
  if (process.env.EDITLENS_STATE_DIR) return null;
  return path.join(os.homedir(), '.claude', LEGACY_NAME);
}

// Files a move can't take now (in use, another drive, no permission).
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES', 'EXDEV', 'ENOTEMPTY', 'EEXIST']);

function migrateState(from = legacyDir(), to = config.stateDir) {
  if (!from || !fs.existsSync(from)) return { moved: [] };
  fs.mkdirSync(to, { recursive: true });
  const moved = [];
  for (const name of fs.readdirSync(from)) {
    const target = path.join(to, name);
    if (fs.existsSync(target)) continue;
    try {
      fs.renameSync(path.join(from, name), target);
      moved.push(name);
    } catch (err) {
      if (!BUSY.has(err.code)) throw err;
    }
  }
  keepOldStatusLine(from, to);
  try {
    fs.rmdirSync(from);
  } catch (err) {
    if (!BUSY.has(err.code) && err.code !== 'ENOENT') throw err;
  }
  return { moved };
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// The user's settings are never edited: if they name the legacy script, a stub there calls the new one.
function keepOldStatusLine(from, to) {
  let settings = '';
  try {
    settings = fs.readFileSync(path.join(path.dirname(from), 'settings.json'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES') return;
    throw err;
  }
  if (!settings.includes(LEGACY_NAME + '/statusline.js') && !settings.includes(LEGACY_NAME + '\\\\statusline.js')) return;
  // The old copy of the script (if it couldn't move) is replaced by the stub.
  const stub = path.join(from, 'statusline.js');
  const text = `// EditLens moved to ${JSON.stringify(to)}; /editlens usage shows the new status line.\nrequire(${JSON.stringify(path.join(to, 'statusline.js'))});\n`;
  fs.mkdirSync(from, { recursive: true });
  if (readOrNull(stub) !== text) fs.writeFileSync(stub, text);
}

module.exports = { migrateState, legacyDir, LEGACY_NAME };
