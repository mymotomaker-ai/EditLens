#!/usr/bin/env node
'use strict';
// A stand-in for Vite's command line, for the port only: --port N (else FAKE_VITE_PORT), the next
// port when that one is taken (as Vite does without strictPort), and a close that takes a moment
// after SIGTERM (Vite closes its watcher and sockets first). Prints Vite's "Local:" line with
// localhost, as Vite does; it listens on FAKE_VITE_HOST (127.0.0.1 by default, ::1 for that case).
const http = require('http');
const host = process.env.FAKE_VITE_HOST || '127.0.0.1';
const i = process.argv.indexOf('--port');
let port = Number(i > 0 ? process.argv[i + 1] : process.env.FAKE_VITE_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) port = 5173;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<html><head><title>vite</title></head><body>vite on ${server.address().port}</body></html>`);
});
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  port += 1;
  server.listen(port, host);
});
server.on('listening', () => process.stdout.write(`\n  VITE v5.0.0  ready in 10 ms\n\n  ➜  Local:   http://localhost:${port}/\n`));
server.listen(port, host);
process.on('SIGTERM', () => setTimeout(() => server.close(() => process.exit(0)), 600));
