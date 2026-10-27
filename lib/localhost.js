'use strict';
// Host headers that name this computer. A request with any other name connected to a local server
// through DNS rebinding (a website's own name pointed at 127.0.0.1), so it is refused.
// One check for the live server, the built-in static server and the dev-server proxy.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function localHost(host) {
  return LOCAL_HOST.test(String(host || ''));
}

module.exports = { localHost };
