'use strict';
// The browser scripts (test/*-preview.js, test/preview.js) the browser job in .github/workflows/test.yml
// runs, and the ones it does not, with the reason. test/ci.test.js checks every script is in one list.

const run = [
  'controls-preview', 'markers-preview', 'missed-preview', 'tasks-preview', 'restore-live-preview', 'theme-preview',
  'split-preview', 'composer-preview', 'tab-file-menu-preview', 'undo-edit-preview', 'undo-remote-preview',
  'feed-preview', 'stream-preview', 'gaps-preview', 'codeview-preview', 'codeview-design-preview', 'effort-preview',
  'chips-preview', 'sessions-preview', 'taskcard-preview', 'pair-preview', 'copies-preview', 'update-preview',
  'follow-nav-preview', 'card-memory-preview', 'pickbox-preview', 'dictation-preview', 'restore-check-preview',
  'settings-card-preview', 'snapshot-ref-preview', 'sol-0.24.45-client-preview', 'selbar-switcher-preview',
  'composer-glass-preview', 'sol-0.24.46-client-preview', 'attach-preview', 'no-undo-preview',
  'page-key-preview', 'settings-invalid-preview',
];

const SITE = 'opens a running site (<site-url> <site-dir>, such as examples/vite-react), which CI does not start';
const PICTURES = 'makes pictures only: it checks nothing';
const notRun = {
  'access-preview': SITE,
  'agents-preview': SITE,
  'bounds-preview': SITE,
  'changes-preview': SITE,
  'code-open-preview': SITE,
  'follow-preview': SITE,
  'hover-preview': SITE,
  'layout-preview': SITE,
  'memory-preview': SITE,
  'modes-preview': SITE,
  'narrow-preview': SITE,
  'overlap-preview': SITE,
  'page-follow-preview': SITE,
  'point-preview': SITE,
  'restore-preview': SITE,
  'select-css-preview': SITE,
  'select-preview': SITE,
  'show-preview': SITE,
  'signin-preview': SITE,
  'space-preview': SITE,
  'dock-preview': PICTURES,
  'fileref-preview': PICTURES,
  'palette-preview': PICTURES,
  'usage-preview': PICTURES,
  preview: PICTURES,
};

module.exports = { run, notRun };
