#!/usr/bin/env node
'use strict';
// A stand-in for ssh in tests: `-L 127.0.0.1:<local>:127.0.0.1:<remote>` forwards a local port, as
// `ssh -N -L` does. The login "denied@..." fails like a missing key. Each run's arguments are
// appended to FAKE_SSH_LOG.
const fs = require('fs');
const net = require('net');

const args = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ pid: process.pid, args }) + '\n');
const login = args[args.length - 1];
if (/^denied@/.test(login)) {
  process.stderr.write(`${login}: Permission denied (publickey).\n`);
  process.exit(255);
}
const spec = args[args.indexOf('-L') + 1] || '';
const m = /^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/.exec(spec);
const isPort = (s) => Number.isInteger(Number(s)) && Number(s) > 0 && Number(s) < 65536;
if (!m || !isPort(m[1]) || !isPort(m[2])) {
  process.stderr.write(`bad -L ${spec}\n`);
  process.exit(2);
}
const server = net.createServer((local) => {
  const up = net.connect(Number(m[2]), '127.0.0.1');
  local.pipe(up);
  up.pipe(local);
  const done = () => {
    local.destroy();
    up.destroy();
  };
  local.on('error', done);
  up.on('error', done);
  local.on('close', done);
  up.on('close', done);
});
server.on('error', (err) => {
  process.stderr.write(`bind: ${err.code}\n`);
  process.exit(255);
});
server.listen(Number(m[1]), '127.0.0.1');
