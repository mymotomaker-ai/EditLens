'use strict';
require('./isolate');
// Comments stay short and in plain words: a block (consecutive // lines, or one /* */) is at most
// 4 lines (a file's first block: 6), a line at most 110 characters, and no figures of speech.
// Reads the comments only; test/wording.test.js checks the strings people read.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['bin', 'client', 'hooks', 'lib', 'mcp', 'server', 'test'];
const MAX_BLOCK = 4;
const MAX_FIRST_BLOCK = 6;
const MAX_LINE = 110;

// Instead of -> use. Same idea as the list in test/wording.test.js, for comments.
const BANNED = [
  [/\b(lands?|landed|landing)\b/i, 'appear / arrive'],
  [/\bshow(s|ed|ing)? up\b/i, 'appear'],
  [/\b(takes?|took|taking) (it |them )?out\b/i, 'remove'],
  [/\b(takes?|took|taken|taking) (it |them )?back\b/i, 'cancel'],
  [/\b(takes?|took|taken|taking) (it |them )?off\b/i, 'remove'],
  [/\bslim\b/i, 'narrow'],
  [/\bthin bar\b/i, 'narrow bar'],
  [/\bfresh\b/i, 'new'],
  [/\blaunch(es|ed|ing)?\b/i, 'start'],
  [/\bqueued\b/i, 'waiting'],
  [/\bover SSH\b/i, 'through SSH'],
  [/\bdrives? Claude\b|\bdriving Claude\b/i, 'runs Claude'],
  [/\bin all\b/i, 'total'],
  [/\bbrings? it back\b/i, 'shows it again'],
  [/\bholds\b/i, 'has / keeps'],
  [/\bkicks? off\b|\bkicked off\b/i, 'starts'],
  [/\bunder the hood\b/i, '(say what happens)'],
  [/\bon the fly\b/i, 'while running'],
  [/\bout of the box\b/i, 'by default'],
  [/\bbubbles? up\b|\bbubbled up\b/i, 'is passed up'],
  [/\bplumbing\b/i, '(name the code)'],
  [/\bwir(e|es|ed|ing) (it |them )?up\b/i, 'connect / set up'],
  [/\bpiggyback/i, 'reuse'],
  [/\bheavy lifting\b/i, 'main work'],
  [/\bspin(s|ning)? up\b|\bspun up\b/i, 'start'],
  [/\bhand(s|ed|ing)? (it |them )?off\b/i, 'pass / give'],
  [/\bbake[sd]? in\b|\bbaked\b/i, 'built in / fixed'],
  [/\bfire[ -]and[ -]forget\b/i, 'without waiting'],
  [/\bfor free\b/i, 'without extra work'],
  [/\blives (in|on)\b/i, 'is in / is on'],
  // From test/comment-wording.test.js, which checks fewer folders.
  [/\bpops? up\b|\bpopped up\b/i, 'appears'],
  [/\bgrab(s|bed|bing)?\b/i, 'drag / take'],
  [/\bon top of\b/i, 'in addition to / above'],
];

// The source files in DIRS (node_modules, dot folders and preview output left out).
function sources() {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.') || e.name.endsWith('-out')) continue;
      const r = rel + '/' + e.name;
      if (e.isDirectory()) walk(r);
      else if (/\.(m?js|ts)$/.test(e.name)) out.push(r);
    }
  };
  for (const d of DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(d);
  return out.sort();
}

// Words after which a / starts a regex literal, not a division.
const BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await']);

// The comments of a JS or TS file: [{ start, end, block }] (block: true for /* */). Strings, template
// text and regex literals are skipped, so a // or /* inside them is not read as a comment.
function comments(src) {
  const out = [];
  const n = src.length;
  // Open template literals: each entry is the { depth at which its ${...} part ends.
  const templates = [];
  let depth = 0;
  // The last token: 'word', 'num', 'close' (a ) or ]), or the punctuator itself. A / after a value divides.
  let last = '';
  let i = 0;
  if (src.startsWith('#!')) i = src.indexOf('\n') < 0 ? n : src.indexOf('\n');
  const template = () => {
    // i is just after a ` or a }; read template text up to ` or ${.
    while (i < n) {
      const c = src[i];
      if (c === '\\') i += 2;
      else if (c === '`') { i++; last = 'close'; return; }
      else if (c === '$' && src[i + 1] === '{') { i += 2; templates.push(++depth); last = '{'; return; }
      else i++;
    }
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? n : e;
      out.push({ start: i, end, block: false });
      i = end;
    } else if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      out.push({ start: i, end, block: true });
      i = end;
    } else if (c === '\'' || c === '"') {
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i++;
      last = 'close';
    } else if (c === '`') {
      i++;
      template();
    } else if (c === '/') {
      const value = last === 'word' || last === 'num' || last === 'close';
      if (value) { i++; last = '/'; continue; }
      // A regex literal: up to the closing / outside a [...] class, then its flags.
      let cls = false;
      i++;
      while (i < n && src[i] !== '\n') {
        const r = src[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '[') cls = true;
        else if (r === ']') cls = false;
        else if (r === '/' && !cls) break;
        i++;
      }
      i++;
      while (i < n && /[a-z]/i.test(src[i])) i++;
      last = 'close';
    } else if (/[A-Za-z_$\u0080-\uffff]/.test(c)) {
      const m = /^[\w$\u0080-\uffff]+/.exec(src.slice(i, i + 64));
      const word = m[0];
      i += word.length;
      last = BEFORE_REGEX.has(word) ? word : 'word';
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d))) {
      i += /^[\w.]+/.exec(src.slice(i, i + 64))[0].length;
      last = 'num';
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === '{') {
      depth++; i++; last = '{';
    } else if (c === '}') {
      i++;
      if (templates.length && templates[templates.length - 1] === depth) {
        templates.pop();
        depth--;
        template();
        continue;
      }
      depth--;
      last = '}';
    } else if (c === ')' || c === ']') {
      i++; last = 'close';
    } else if ((c === '+' || c === '-') && d === c) {
      // After x++ a / divides; after a prefix ++, a / can't follow.
      i += 2; last = last === 'word' || last === 'close' ? 'close' : c + c;
    } else {
      i++; last = c;
    }
  }
  return out;
}

// Comment blocks: [{ block, alone, last, lines: [{ line, text, width }] }], lines numbered from 1.
// A // comment alone on its line joins the // block on the line above, if that one is alone on its
// line too. A /* */ comment is its own block.
function blocks(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  const lineOf = (pos) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const out = [];
  let prev = null;
  for (const c of comments(src)) {
    const first = lineOf(c.start);
    const last = lineOf(Math.max(c.start, c.end - 1));
    const alone = /^\s*$/.test(src.slice(starts[first], c.start));
    const lines = [];
    for (let l = first; l <= last; l++) {
      const from = Math.max(starts[l], c.start);
      const to = Math.min(l + 1 < starts.length ? starts[l + 1] - 1 : src.length, c.end);
      lines.push({ line: l + 1, text: src.slice(from, to), width: to - starts[l] });
    }
    if (!c.block && alone && prev && !prev.block && prev.alone && prev.last === first - 1) {
      prev.lines.push(...lines);
      prev.last = last;
    } else {
      prev = { block: c.block, alone, last, lines };
      out.push(prev);
    }
  }
  return out;
}

// What a comment says in its own words. Left out: `code`, "quoted text", .class and .file names,
// calls such as launch() and options such as fresh: true.
function words(text) {
  return text.replace(/`[^`]*`|"[^"\n]*"/g, ' ').replace(/\.[A-Za-z_][\w-]*/g, ' ')
    .replace(/[\w$]+\(/g, ' ').replace(/\b\w+: (true|false|null|undefined|-?\d[\w.]*)\b/g, ' ');
}

function problems(rel, src) {
  const found = [];
  blocks(src).forEach((b, k) => {
    const max = k === 0 ? MAX_FIRST_BLOCK : MAX_BLOCK;
    const at = (line, what) => found.push(`${rel}:${line} ${what}`);
    if (b.lines.length > max) at(b.lines[0].line, `comment block of ${b.lines.length} lines (max ${max})`);
    for (const l of b.lines) {
      if (l.width > MAX_LINE) at(l.line, `comment line of ${l.width} characters (max ${MAX_LINE})`);
      for (const [re, use] of BANNED) {
        const m = re.exec(words(l.text));
        if (m) at(l.line, `"${m[0]}" in a comment: use "${use}"`);
      }
    }
  });
  return found;
}

test('comments are short and use plain words', () => {
  const found = [];
  for (const rel of sources()) found.push(...problems(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')));
  assert.deepStrictEqual(found, []);
});
