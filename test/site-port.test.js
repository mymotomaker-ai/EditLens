'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5312';
// test/site-port.js with a stand-in browser. Sol M13 (findings-0.24.43-sol.md): when the page
// fetch fails, the request must not continue unchanged, or a later answer would load live.js from
// the port written in the page (the user's own EditLens).
const test = require('node:test');
const assert = require('node:assert');
const { launchOwnPort } = require('./site-port');

// A stand-in chromium; -> the route handler of the first context and the calls it made.
async function handlerOf() {
  let handler = null;
  const context = { route: async (match, fn) => { handler = fn; } };
  const chromium = { launch: async () => ({ newContext: async () => context }) };
  const browser = await launchOwnPort(chromium);
  await browser.newContext();
  return handler;
}
function route(fetch) {
  const calls = [];
  return {
    calls,
    request: () => ({ resourceType: () => 'document' }),
    fetch,
    fallback: async () => { calls.push('fallback'); },
    abort: async (code) => { calls.push('abort ' + code); },
    fulfill: async (o) => { calls.push('fulfill ' + o.body); },
  };
}

test('M13: a page whose fetch fails is not asked for again unchanged', async () => {
  const handler = await handlerOf();
  const r = route(async () => { throw new Error('route.fetch: connect ECONNREFUSED 127.0.0.1:5311'); });
  await handler(r);
  assert.deepStrictEqual(r.calls, ['abort connectionrefused']);
  const r2 = route(async () => { throw new Error('route.fetch: socket hang up'); });
  await handler(r2);
  assert.deepStrictEqual(r2.calls, ['abort failed']);
});

test('a page that loads gets live.js from this port', async () => {
  const handler = await handlerOf();
  const html = '<script src="http://127.0.0.1:4317/live.js"></script>';
  const r = route(async () => ({ headers: () => ({ 'content-type': 'text/html' }), text: async () => html }));
  await handler(r);
  assert.deepStrictEqual(r.calls, ['fulfill <script src="http://127.0.0.1:5312/live.js"></script>']);
});

test('an error that is not from the fetch is thrown', async () => {
  const handler = await handlerOf();
  const r = route(async () => { throw new TypeError('not a fetch error'); });
  await assert.rejects(handler(r), TypeError);
  assert.deepStrictEqual(r.calls, []);
});
