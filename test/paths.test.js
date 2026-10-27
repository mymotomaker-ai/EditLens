'use strict';
require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, related, tooBroad } = require('../lib/paths');

test('Windows spellings of the same folder match', () => {
  assert.equal(normalize('C:\\Users\\pro\\site\\'), 'c:/users/pro/site');
  assert.ok(related('C:/Users/Pro/site', 'c:\\Users\\Pro\\site'));
  assert.ok(related('C:/Users/Pro/site', 'C:\\Users\\Pro\\site\\src\\App.jsx'));
  assert.ok(related('C:\\Users\\Pro\\site\\src', 'C:/Users/Pro/site'));
});

test('different folders do not match', () => {
  assert.ok(!related('C:/Users/Pro/site', 'C:\\Users\\Pro\\site2\\a.js'));
  assert.ok(!related('/home/pro/site', '/home/pro/other'));
  assert.ok(!related('/home/pro/site', '/home/pro/Site'), 'POSIX paths stay case-sensitive');
});

test('missing side matches nothing', () => {
  assert.ok(!related(null, '/x'));
  assert.ok(!related('/x', ''));
});

test('roots too broad to be a project', () => {
  for (const r of ['/', 'C:/', 'c:', 'C:\\', '\\\\server\\share', 'src', '', '/home', '/home/pro']) assert.ok(tooBroad(r, '/home/pro'), r);
  for (const r of ['/home/pro/site', '/app', 'C:/Users/Pro/site']) assert.ok(!tooBroad(r, '/home/pro'), r);
  assert.ok(tooBroad('C:\\Users', 'C:\\Users\\Pro'));
  assert.ok(!related('C:/', 'C:/Users/Pro/site') || tooBroad('C:/'), 'a drive root is refused before it can match');
});

test('UNC paths compare case-insensitively', () => {
  assert.ok(related('\\\\Server\\Share\\Proj', '//server/share/proj/src'));
});
