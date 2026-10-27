'use strict';
// npm test: every test/*.test.js with node's runner. The proxy takes any free port, never its
// steady one (4400-4899): the user's own EditLens or another test may use it at the same time.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ISOLATE_PATHS } = require('./isolate');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('test', f));
// Files run in parallel, and some change their passwd file or Claude Code settings: without these
// paths, each file's test/isolate.js makes its own (EDITLENS_ISOLATE_RUN stays: they are one run).
const env = { ...process.env, EDITLENS_STEADY_PORTS: 'off' };
for (const name of ISOLATE_PATHS) delete env[name];
const child = spawn(process.execPath, ['--test', ...files], { cwd: path.join(__dirname, '..'), stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code));
