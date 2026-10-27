'use strict';
require('./isolate');
// Sol scan of 0.24.43, Lows L4, L5, L9, L10: numbers from outside are checked as finite, and
// catches ignore only the errors they expect.
process.env.EDITLENS_PORT = '5300';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// L9: a stand-in @babel/core whose transformSync throws the error named in the code.
function fakeBabel(t) {
  const root = tmpDir(t, 'editlens-vite-babel-');
  const core = path.join(root, 'node_modules', '@babel', 'core');
  fs.mkdirSync(core, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"app"}');
  fs.writeFileSync(path.join(core, 'package.json'), '{"name":"@babel/core","main":"index.js"}');
  fs.writeFileSync(path.join(core, 'index.js'), [
    "'use strict';",
    'exports.types = {};',
    'exports.transformSync = (code) => {',
    '  const [name, code2] = code.split(" ");',
    '  const err = name === "SyntaxError" ? new SyntaxError("bad") : new Error("broken");',
    '  if (code2) err.code = code2;',
    '  throw err;',
    '};',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'App.jsx'), 'x');
  return root;
}

test('L9: the Vite plugin ignores only parser syntax errors and warns about other Babel errors', async (t) => {
  const root = fakeBabel(t);
  const vite = (await import('../integrations/vite.mjs')).default;
  const plugin = vite({ root });
  plugin.configResolved({ root });
  const warns = [];
  const run = (code) => plugin.transform.handler.call({ warn: (m) => warns.push(m) }, code, path.join(root, 'App.jsx'));
  assert.strictEqual(run('SyntaxError BABEL_PARSE_ERROR'), null);
  assert.strictEqual(run('SyntaxError BABEL_PARSER_SYNTAX_ERROR'), null);
  assert.deepStrictEqual(warns, [], 'a syntax error is left to Vite');
  assert.strictEqual(run('SyntaxError BABEL_TRANSFORM_ERROR'), null);
  assert.strictEqual(run('Error BABEL_GENERATE_ERROR'), null);
  assert.strictEqual(warns.length, 2, 'other Babel errors are shown');
  assert.match(warns[0], /could not add source line numbers to App\.jsx/);
});

test('L4: a subagent token sum past the largest number is unknown, not Infinity', (t) => {
  const { agentsOf } = require('../server/summary');
  const [a] = agentsOf([{ type: 'chat', role: 'agent-step', toolUseId: 't1', ctx: 1e308, msgId: 'm1', out: 1e308 }]);
  assert.strictEqual(a.tokens, null);
  const { SessionWatcher } = require('../server/transcript');
  const sent = [];
  const w = new SessionWatcher({ sessionId: 's1', transcriptPath: path.join(tmpDir(t, 'editlens-tr-'), 's1.jsonl'), cwd: '/p', emit: (ev) => sent.push(ev) });
  const usage = { input_tokens: 1e308, cache_creation_input_tokens: 1e308, cache_read_input_tokens: 0, output_tokens: 5 };
  w.onAgent('a1', { toolUseId: 't1' }, [{ type: 'assistant', message: { id: 'm1', model: 'm', usage, content: [{ type: 'text', text: 'hi' }] } }], false);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].ctx, null, 'the sum is checked');
});
