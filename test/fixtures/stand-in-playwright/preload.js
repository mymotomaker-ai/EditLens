'use strict';
// Loaded with node --require by test/preview-cleanup.test.js: require('playwright') then gives the
// stand-in next to this file, also when a real playwright is in a node_modules folder that Node
// looks in before NODE_PATH.
const Module = require('module');

const STAND_IN = require.resolve('./playwright');
const resolve = Module._resolveFilename;
Module._resolveFilename = function standInFirst(request, ...rest) {
  return request === 'playwright' ? STAND_IN : resolve.call(this, request, ...rest);
};
