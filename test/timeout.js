'use strict';
// For the previews and e2e scripts: rejection handlers that ignore only the error a step expects,
// and rethrow any other (a closed page, an error in the page script, a bug in the test).

// A Playwright wait that ran out (TimeoutError) gives `value`.
function onTimeout(value) {
  return (err) => {
    if (err && err.name === 'TimeoutError') return value;
    throw err;
  };
}

// A request to a server that is not running yet, or that just stopped, gives `value`.
const NOT_RUNNING = ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'];
function notRunning(value) {
  return (err) => {
    const code = err && ((err.cause && err.cause.code) || err.code);
    if (NOT_RUNNING.includes(code)) return value;
    throw err;
  };
}

module.exports = { onTimeout, notRunning };
