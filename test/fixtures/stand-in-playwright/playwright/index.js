'use strict';
// A stand-in for playwright, loaded through ../preload.js (test/preview-cleanup.test.js).
// PW_STAND_IN=no-start: Chromium does not start. PW_STAND_IN=page: Chromium starts, and the first
// page or context fails, as a timeout in a step would. It writes its own path to PW_STAND_IN_LOADED,
// so the test can see this file was loaded.
if (process.env.PW_STAND_IN_LOADED) require('fs').appendFileSync(process.env.PW_STAND_IN_LOADED, __filename + '\n');
function fail(what) {
  throw new Error('stand-in playwright: ' + what);
}
const browser = {
  newContext: async () => fail('no page'),
  newPage: async () => fail('no page'),
  contexts: () => [],
  close: async () => {},
};
const chromium = {
  launch: async () => (process.env.PW_STAND_IN === 'no-start' ? fail('Chromium did not start') : browser),
};

module.exports = { chromium };
