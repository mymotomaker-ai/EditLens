'use strict';
// For previews and e2e scripts: starts Chromium (`chromium` from playwright). When it can't start,
// the script's own EditLens server is stopped first, so a failed preview leaves no server running.
// Only a script that loaded lib/client.js can have started one; this file loads nothing itself.
// A script that starts servers with spawn() passes them as `children`; they are stopped too.
async function launch(chromium, options = {}, children = []) {
  try {
    return await chromium.launch(options);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    const client = require.cache[require.resolve('../lib/client')];
    if (client) await client.exports.stopServer();
    await stopChildren(children);
    throw err;
  }
}

// Stops child processes (from spawn) and waits until each has ended: SIGTERM, then SIGKILL after 5 s.
function stopChildren(children) {
  return Promise.all(children.filter((c) => c && c.exitCode === null && c.signalCode === null).map((c) => new Promise((resolve) => {
    const late = setTimeout(() => c.kill('SIGKILL'), 5000);
    c.once('exit', () => {
      clearTimeout(late);
      resolve();
    });
    c.kill();
  })));
}

module.exports = { launch, stopChildren };
