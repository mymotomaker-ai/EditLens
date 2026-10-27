'use strict';
// For the e2e scripts: ends a child process they started (real Claude) and waits until it has
// exited, also after an error or a timeout, so no Claude keeps running after the script.

// Resolves when the child has exited: SIGTERM first, SIGKILL after `ms`.
async function stopChild(child, ms = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('late'), ms); });
  const first = await Promise.race([ended.then(() => 'ended'), late]);
  clearTimeout(timer);
  if (first === 'late') {
    child.kill('SIGKILL');
    await ended;
  }
}

// Resolves when the child has started, and rejects when it could not (a missing program). Its
// "error" listener stays, so a later error is logged and does not crash Node (Sol M13).
function spawned(child) {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
    child.on('error', (err) => console.error(`${child.spawnfile}: ${err.message}`));
  });
}

module.exports = { stopChild, spawned };
