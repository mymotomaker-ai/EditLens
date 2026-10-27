#!/usr/bin/env node
'use strict';
// Starts the live server if nothing responds on its port. A running server is kept running, even an
// older one (SessionStart replaces that), so page control is never interrupted.
const { ensureServer, isUp } = require('../lib/client');
const { plainError } = require('../lib/plainerr');

(async () => {
  if (await isUp()) return console.log('running');
  const out = await ensureServer();
  console.log(out.started ? 'started' : 'running');
})().catch((err) => {
  if (!(err instanceof Error)) throw err;
  console.log(`not started: ${plainError(err)}`);
  process.exitCode = 1;
});
