'use strict';
require('./isolate');
// Plain words in what people read: no figures of speech, and the most common word for each idea
// (the word list in /mnt/project-files/editlens-wording/plain-english.md). Scans the string
// literals of every script in the folders below (subfolders too), the Markdown pages people and
// Claude read, and the plugin's settings text.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Every file under dir (relative to ROOT, forward slashes), node_modules left out.
function walk(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(rel);
    return e.isFile() ? [rel] : [];
  });
}
const DIRS = ['bin', 'client/src', 'hooks', 'lib', 'mcp', 'server', 'integrations', 'examples'];
// The previews' check and section names are read in their output too (other strings are pages and code).
const PREVIEWS = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('-preview.js')).map((f) => 'test/' + f);
const FILES = [...DIRS.flatMap(walk).filter((f) => /\.(m?js|jsx)$/.test(f)), ...PREVIEWS];
// CODE_OF_CONDUCT.md is the Contributor Covenant's own text, so it is left out.
const PAGES = ['README.md', 'PRIVACY.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', '.github/pull_request_template.md', ...walk('docs'), ...walk('skills'), ...walk('examples')].filter((f) => f.endsWith('.md'));
// The text of the example pages (tags, styles and scripts left out).
const HTML = walk('examples').filter((f) => f.endsWith('.html'));
const JSON_TEXT = ['.claude-plugin/plugin.json'];

// The shared list of phrases and the literal uses left out (test/plain-words.js).
const { hits, read, plain } = require('./plain-words');

// CSS class lists set from code ("k-task fresh", " fresh").
const CLASSES = /^ ?(k-task fresh|fresh|ucard ctx)$/;
// Style sheets in strings (".k-edit.fresh{…}", "--ctx:#0f8b8d;…"). The "{" of a template's "${}" is
// not a style rule: "Could not start ${}" is text.
const CSS = /^\s*(--[\w-]+:|[.#\[\w][^{}\n]*(?<!\$)\{)/;

// The string literals of a JS file, comments left out. Strings inside a template's ${...} parts are
// read too; // comments inside a page written as a template are left out.
// A string is named when it is a check or section name, or inside one written as a template.
function literals(src) {
  const all = read(src).strings;
  const names = all.filter((s) => /\b(check|section)\($/.test(src.slice(Math.max(0, s.start - 9), s.start)));
  return all.map((s) => ({ text: s.text.replace(/(^|\s)\/\/ [^\n]*/g, '$1'), line: s.line,
    named: names.some((x) => x.start <= s.start && s.end <= x.end) }));
}

test('user-facing text uses the plain word list', () => {
  const found = [];
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // Keys and ids (one lowercase word) and absolute paths ("/snap") are code, not text.
    const preview = PREVIEWS.includes(rel);
    for (const lit of literals(src).filter((l) => (!preview || l.named) && !/^[a-z][\w-]*$/.test(l.text) && !/^\/[\w./-]*$/.test(l.text) && !CLASSES.test(l.text) && !CSS.test(l.text))) {
      for (const h of hits(lit.text)) found.push(`${rel}:${lit.line} "${lit.text.slice(0, 80)}": use "${h.use}"`);
    }
  }
  assert.deepStrictEqual(found, []);
});

// A Markdown page's paragraphs, lines joined (a phrase can be split over two lines): -> [{ line, text }].
// A blank line, a list item, a table row, a heading or a quote starts a new one. Code spans are left out.
function paragraphs(src) {
  const out = [];
  src.split('\n').forEach((line, i) => {
    const last = out[out.length - 1];
    if (!line.trim()) out.push(null);
    else if (!last || /^\s*([-*|#>]|\d+\.\s)/.test(line)) out.push({ line: i + 1, lines: [line] });
    else last.lines.push(line);
  });
  return out.filter(Boolean).map((p) => ({ line: p.line, text: plain(p.lines.join('\n').replace(/`[^`]*`/g, '``').split(/\s+/).join(' ')) }));
}
function pageHits(rel, src) {
  return paragraphs(src).flatMap((p) => hits(p.text).map((h) => `${rel}:${p.line} "${p.text.slice(0, 80)}": use "${h.use}"`));
}

test('the Markdown pages use the plain word list too', () => {
  const found = PAGES.flatMap((rel) => pageHits(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')));
  assert.deepStrictEqual(found, []);
});

test('the checks find a phrase split over two lines, and a message with ${} is not a style sheet', () => {
  assert.deepStrictEqual(pageHits('x.md', '# Title\n\nYou copy them by\n  hand if you want them.\n- one\n- two by\n  hand\n'), [
    'x.md:3 "You copy them by hand if you want them.": use "manually"',
    'x.md:6 "- two by hand": use "manually"',
  ]);
  assert.deepStrictEqual(pageHits('x.md', 'Ends by\n\nhand.\n- by\n- hand\n'), []);
  for (const css of ['.k-edit.fresh{color:red}', '--ctx:#0f8b8d;', '.x{color:${}}', 'button:hover{opacity:.8}']) assert.ok(CSS.test(css), css);
  for (const text of ['Could not start ${} now', 'Copy ${} files by hand']) assert.ok(!CSS.test(text), text);
});

test('the example pages use the plain word list too', () => {
  const found = [];
  for (const rel of HTML) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, ''));
    // Lines joined up to a blank line, as text can wrap in the middle of a phrase.
    let start = 0;
    src.split(/\n[ \t]*\n/).forEach((block) => {
      const text = block.replace(/<[^>]*>/g, ' ').split(/\s+/).join(' ');
      for (const h of hits(text)) found.push(`${rel}:${start + 1} "${text.trim().slice(0, 80)}": use "${h.use}"`);
      start += block.split('\n').length + 1;
    });
  }
  assert.deepStrictEqual(found, []);
});

test('the plugin\'s settings text uses the plain word list too', () => {
  const found = [];
  // Every string value, with where it is ("userConfig.start.description").
  const strings = (v, at) => (typeof v === 'string' ? [{ at, text: v }]
    : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => strings(x, at ? at + '.' + k : k)) : []);
  for (const rel of JSON_TEXT) {
    const all = strings(JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')), '');
    for (const s of all.filter((x) => !/^[a-z][\w-]*$/.test(x.text))) {
      for (const h of hits(s.text)) found.push(`${rel} ${s.at} "${s.text.slice(0, 80)}": use "${h.use}"`);
    }
  }
  assert.deepStrictEqual(found, []);
});

test('the scan covers subfolders and the pages people read', () => {
  assert.ok(PAGES.includes('README.md') && PAGES.includes('PRIVACY.md') && PAGES.includes('skills/editlens-guide/SKILL.md'), PAGES.join(' '));
  for (const f of ['CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', '.github/pull_request_template.md']) assert.ok(PAGES.includes(f), f);
  assert.ok(FILES.includes(`server/server.js`) && FILES.includes(`hooks/mod.mjs`), 'scripts in the folders');
  assert.ok(FILES.includes('integrations/vite.mjs') && FILES.includes('examples/fullstack/server.js') && FILES.includes('test/pair-preview.js'), 'integrations, examples, previews');
  assert.ok(HTML.includes('examples/static-site/index.html'), HTML.join(' '));
  for (const rel of JSON_TEXT) assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
});

// A noun said again in one short sentence: "page control stops, and page control starts again" is
// "page control stops, and starts again". Found: two words (not both small), then "and", "or" or a
// comma, then the same two words within 12 words. KEPT: repeats that name two different things, a
// button or setting by its name, or parallel parts of a list.
const SMALL = new Set(('a an the this that these those it its is are was be to of in on at for with and or but not no by '
  + 'as from your you here there then than when what which who one each every any all some can will may do does has have '
  + 'so if into out up only also just more most less very own same other new').split(' '));
const KEPT = [
  '/editlens pair open, or /editlens pair off', 'so it can\'t undo only this edit', 'then where the project\'s dev script',
  'old lines in red, new lines in green', 'Show code on hover', 'page control and the Claude Code window, or two Claude Code',
  'Hide line above prompt', 'resizes from its inner corner, and a docked code view from its inner edge',
  'the same as the full screen button', 'a tab you reload keeps it, and a tab you open later', 'on the VPS itself, or on the laptop when the VPS',
  'says how many run at once', 'runs as root on a Linux server, a task can run everything as root',
  'a subagent switched to Ask is asked, a subagent in Plan', 'the files you open in the code view',
  'a red ring, the mic becomes a red', 'The edit card and the code view after the edit',
];
function repeats(text) {
  const out = [];
  for (const sentence of text.split(/[.;:!?()"`[\]{}]/)) {
    const w = sentence.toLowerCase().replace(/\\'/g, "'").match(/[a-z]+(?:'[a-z]+)?|,/g) || [];
    for (let i = 0; i + 1 < w.length; i++) {
      const two = `${w[i]} ${w[i + 1]}`;
      if (w[i] === ',' || w[i + 1] === ',' || (SMALL.has(w[i]) && SMALL.has(w[i + 1]))) continue;
      for (let j = i + 2; j + 1 < w.length && j < i + 14; j++) {
        if (`${w[j]} ${w[j + 1]}` === two && w.slice(i + 2, j).some((x) => x === 'and' || x === 'or' || x === ',')) {
          if (!KEPT.some((k) => sentence.replace(/\\'/g, "'").includes(k) && k.toLowerCase().includes(two))) out.push(two);
          break;
        }
      }
    }
  }
  return out;
}

test('a noun is not said twice in one short sentence', () => {
  const found = [];
  for (const rel of FILES.filter((f) => !PREVIEWS.includes(f))) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const lit of literals(src)) for (const two of repeats(lit.text)) found.push(`${rel}:${lit.line} "${two}": ${lit.text.slice(0, 90)}`);
  }
  for (const rel of PAGES) {
    // Paragraphs joined across line breaks; code spans left out.
    for (const para of fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\n\s*\n|\n(?=\s*[-*|#])/)) {
      const text = plain(para.replace(/`[^`]*`/g, ' ').split(/\s+/).join(' '));
      for (const two of repeats(text)) found.push(`${rel} "${two}": ${text.slice(0, 90)}`);
    }
  }
  assert.deepStrictEqual(found, []);
});
