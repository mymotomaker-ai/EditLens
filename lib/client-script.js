'use strict';
// The page script (/live.js), split into several files in client/src so none exceeds the plugin
// directory's file size limit. They are joined in name order into one script with one scope.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'client', 'src');

function partFiles() {
  return fs.readdirSync(DIR).filter((f) => /^\d+-[\w-]+\.js$/.test(f)).sort().map((f) => path.join(DIR, f));
}

// Read again only when a part changed, so an update is served without a server restart.
let cache = { key: '', text: '' };
function clientScript() {
  const files = partFiles();
  const key = files.map((f) => f + ':' + fs.statSync(f).mtimeMs).join('|');
  if (key !== cache.key) cache = { key, text: files.map((f) => fs.readFileSync(f, 'utf8')).join('') };
  return cache.text;
}

module.exports = { clientScript, partFiles };
