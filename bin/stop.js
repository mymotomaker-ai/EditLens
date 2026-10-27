#!/usr/bin/env node
'use strict';
// Stops the EditLens server, for example before updating the plugin on Windows.
const config = require('../lib/config');
const { stopServer, isUp } = require('../lib/client');
const { plainError } = require('../lib/plainerr');

(async () => {
  if (!(await isUp())) return console.log(`not running at ${config.baseUrl}`);
  const stopped = await stopServer();
  console.log(stopped === true ? 'stopped' : `still running; see ${config.logFile}`);
  return undefined;
})().catch((err) => {
  console.log(`could not stop: ${plainError(err)}`);
  process.exitCode = 1;
});
