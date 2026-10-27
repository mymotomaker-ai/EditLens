'use strict';
// Keeps a log file small: past `max` bytes, only its newest half is kept.
const fs = require('fs');

const LOG_MAX = 1024 * 1024;

function trimLog(file, max = LOG_MAX) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  if (size <= max) return false;
  const keep = Math.floor(max / 2);
  const buf = Buffer.alloc(keep);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, keep, size - keep);
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString('utf8');
  const from = text.indexOf('\n') + 1; // start at a whole line
  fs.writeFileSync(file, `[log trimmed to its newest ${Math.round(keep / 1024)} KB]\n` + text.slice(from));
  return true;
}

module.exports = { trimLog, LOG_MAX };
