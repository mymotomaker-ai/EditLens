'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4334';
// Drive mode on Windows, simulated: the desktop app's claude.exe is not on PATH, so the live server
// only knows it when bin/drive.js passes it; the SDK installed without its optional runtime must
// then be given that path, and with neither, the user gets plain words instead of an SDK error.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Driver, findClaude, isClaudeProgram, runtimePackage, hasRuntime, NO_CLAUDE } = require('../server/driver');

const FAKE_SDK = `
export function query({ options }) {
  globalThis.__liveSdkCalls.push(options);
  if (globalThis.__liveSdkMode === 'no-binary') throw new Error('Native CLI binary for win32-x64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.');
  return {
    async *[Symbol.asyncIterator]() {},
    async supportedCommands() { return []; },
    async interrupt() {},
  };
}
`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-win-'));
  const sdk = path.join(dir, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'sdk.mjs'), FAKE_SDK);
  const app = path.join(dir, 'AnthropicClaude', 'app-1.2.3');
  fs.mkdirSync(app, { recursive: true });
  const exe = path.join(app, 'claude.exe');
  fs.writeFileSync(exe, 'MZ');
  fs.writeFileSync(path.join(app, 'claude.cmd'), '@echo off');
  fs.writeFileSync(path.join(app, 'other.exe'), 'MZ');
  return { dir, exe, app };
}

test('finds the desktop app claude.exe only from a reported path, never a shim or another program', () => {
  const { dir, exe, app } = setup();
  try {
    const opts = { platform: 'win32', env: { PATH: app }, home: dir };
    assert.strictEqual(findClaude([], opts), null, 'claude.cmd on PATH is a shim, not usable');
    assert.strictEqual(findClaude([exe], opts), exe);
    assert.strictEqual(findClaude([path.join(app, 'other.exe'), 'claude.exe', null, ''], opts), null);
    assert.strictEqual(findClaude([path.join(dir, 'gone', 'claude.exe')], opts), null, 'an app update moved it');
    assert.strictEqual(isClaudeProgram(exe, 'win32'), true);
    assert.strictEqual(isClaudeProgram(path.join(app, 'claude.cmd'), 'win32'), false);
    assert.strictEqual(isClaudeProgram(42, 'win32'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the runtime package name for each computer', () => {
  assert.strictEqual(runtimePackage('win32', 'x64'), '@anthropic-ai/claude-agent-sdk-win32-x64');
  assert.strictEqual(runtimePackage('linux', 'x64', true), '@anthropic-ai/claude-agent-sdk-linux-x64-musl');
  assert.strictEqual(runtimePackage('darwin', 'arm64', true), '@anthropic-ai/claude-agent-sdk-darwin-arm64');
});

test('Windows drive start: uses the passed claude.exe, else the runtime, else plain words', async () => {
  const { dir, exe } = setup();
  const saved = { sdk: process.env.EDITLENS_SDK_DIR, path: process.env.EDITLENS_CLAUDE_PATH };
  process.env.EDITLENS_SDK_DIR = path.join(dir, 'sdk');
  delete process.env.EDITLENS_CLAUDE_PATH;
  globalThis.__liveSdkCalls = [];
  globalThis.__liveSdkMode = 'ok';
  try {
    const d = new Driver({ root: false, emit: () => {}, log: () => {}, stateDir: dir, platform: 'win32' });

    // 1. SDK without its runtime, server never told where claude.exe is: no SDK call, plain words.
    assert.strictEqual(hasRuntime(dir, runtimePackage('win32', 'x64')), false);
    let r = await d.start({ cwd: dir, claudePaths: [] });
    assert.strictEqual(r.error, NO_CLAUDE);
    assert.strictEqual(globalThis.__liveSdkCalls.length, 0);

    // 2. bin/drive.js passed the desktop app's claude.exe: the SDK is told to use it.
    r = await d.start({ cwd: dir, claudePaths: [exe] });
    assert.deepStrictEqual(r, { ok: true });
    assert.strictEqual(globalThis.__liveSdkCalls[0].pathToClaudeCodeExecutable, exe);
    d.stop('test');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 3. No claude.exe, but the runtime package was installed: the SDK uses its own copy.
    const rt = path.join(dir, 'sdk', 'node_modules', '@anthropic-ai', `claude-agent-sdk-win32-${process.arch}`);
    fs.mkdirSync(rt, { recursive: true });
    fs.writeFileSync(path.join(rt, 'package.json'), '{}');
    r = await d.start({ cwd: dir, claudePaths: [] });
    assert.deepStrictEqual(r, { ok: true });
    assert.strictEqual(globalThis.__liveSdkCalls[1].pathToClaudeCodeExecutable, undefined);
    d.stop('test');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 4. The SDK still can't find its binary: the same plain words, not the SDK's message.
    globalThis.__liveSdkMode = 'no-binary';
    r = await d.start({ cwd: dir, claudePaths: [] });
    assert.strictEqual(r.error, NO_CLAUDE);
    // Not running, and the reason is kept for the panel and the line in Claude Code.
    assert.strictEqual(d.status().active, false);
    assert.strictEqual(d.status().lastError.error, NO_CLAUDE);
  } finally {
    for (const [k, v] of [['EDITLENS_SDK_DIR', saved.sdk], ['EDITLENS_CLAUDE_PATH', saved.path]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
