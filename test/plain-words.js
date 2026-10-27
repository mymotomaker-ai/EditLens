'use strict';
// The plain-word list shared by test/wording.test.js (text people read) and test/comment-wording.test.js
// (code comments), and the reader both use to find the strings and comments of a script. The list:
// no figures of speech, and the most common literal word for each idea (from the wording tables of
// the 0.24.40 and 0.24.43 scans).

// Instead of -> use (the reason shows in the failure).
const PHRASES = [
  [/\b(lands?|landed|landing)\b/i, 'appear / arrive'],
  [/\bshow(s|ed|ing)? up\b/i, 'appear'],
  [/\b(takes?|took|taking) (it |them )?out\b/i, 'remove'],
  [/\b(takes?|took|taken|taking) (it |them )?back\b/i, 'cancel'],
  [/\bslim\b/i, 'narrow'],
  [/\bthin bar\b/i, 'narrow bar'],
  [/\bctx\b/i, 'context'],
  [/\bfresh\b/i, 'new / again'],
  [/\blaunch(es|ed|ing)?\b/i, 'start'],
  [/\bqueued\b/i, 'waiting'],
  [/\bover SSH\b|\bgoes over\b/i, 'through SSH / uses SSH'],
  [/\breach(es|ed|ing)?\b/i, 'connect to / are connected / is sent to'],
  [/\bdrives? Claude\b|\bdriv(e|ing) Claude\b/i, 'run / use Claude'],
  [/\b(nothing |something )?answers at\b/i, 'is running at'],
  [/\bin all\b/i, 'total'],
  [/\bholds\b/i, 'has'],
  [/\bfall(s|ing)? back\b|\bfell back\b|\bfallback\b/i, 'use (instead) / using the default'],
  [/\bcomes? back\b|\bcame back\b/i, 'starts again / reconnects / is copied back'],
  [/\bin a row\b/i, 'one after another'],
  [/\bsnap(s|ped|ping)?\b/i, 'move to the edge'],
  [/\bghost\b/i, 'dashed outline'],
  [/\bhairline\b/i, 'thin border'],
  [/\bwins\b/i, 'takes precedence'],
  [/\blives (in|on)\b/i, 'is in / is on'],
  [/\bin front of\b/i, 'a proxy for'],
  [/\bpops? up\b|\bpopped up\b/i, 'appears'],
  [/\bgrab(s|bed|bing|ber)?\b/i, 'drag / take / drag handle'],
  [/\bon top of\b/i, 'in addition to / above'],
  // From the wording table of the 0.24.40 scan.
  [/\bfree up context\b/i, 'reduce the context used'],
  [/\bgo back to an earlier\b/i, 'restore an earlier point'],
  [/\bleft alone\b/i, 'kept running / not changed'],
  [/\bin front\b(?! of)/i, 'at the start'],
  [/\b(goe?s?|comes?) first\b/i, 'is shown first / remove the oldest first'],
  [/\bbr(ing|ings|inging|ought)\b/i, 'copy / receive / restore / show again / select'],
  [/\bgo(es)? back\b/i, 'is restored / switches to / are copied'],
  [/\bmake room\b|\broom for one more\b|\bthere is room\b/i, 'stay within the limit / the limit allows it'],
  [/\bup to date\b/i, 'current'],
  [/\bleft behind\b/i, 'unused / not kept'],
  [/\bhalf ?way\b/i, 'before it finishes'],
  [/\b(is|turns?|turned|turning) (it |itself |page control )?back on\b/i, 'starts again'],
  [/\btricks? Claude\b/i, 'makes Claude'],
  [/\blink is up\b/i, 'the computers are connected'],
  [/\bdrop(s|ped|ping)?\b/i, 'remove / cancel'],
  [/\bdeepest\b/i, 'most reasoning'],
  [/\btyping ahead\b/i, 'as when you send another message'],
  [/\bout of date\b/i, 'older than the current state'],
  [/\bstuck\b/i, 'not responding'],
  [/\b(take|takes|took|taking) over\b(?! \d)/i, 'start another session that controls'],
  [/\bwork(s|ed)? around\b|\bworkaround\b/i, 'bypass'],
  [/\bsent along\b/i, 'sent with'],
  [/\btaking anything\b/i, 'applying any changes'],
  // From the wording tables of the 0.24.43 scan.
  [/\bstays? flat\b/i, 'stays within a limit'],
  [/\bstale\b/i, 'older'],
  [/\bcut off\b/i, 'incomplete / ended early'],
  [/\bby hand\b/i, 'manually'],
  [/\bwork(s|ed|ing)? out\b/i, 'compute'],
  [/\bwait(s|ing)? (its|their|your) turn\b/i, 'wait for a session'],
  [/\bin sync\b/i, 'the same'],
  [/\bright away\b/i, 'immediately'],
  // The setting's name "Tasks at once" stays.
  [/(?<!tasks )\bat once\b/i, 'immediately / at the same time'],
  [/\bso far\b/i, 'used / made'],
  [/\bfor good\b/i, 'permanently'],
  [/\bgo(es|ing)? away\b/i, 'reloads or closes / is hidden'],
  [/\bback online\b/i, 'connected again'],
  [/\b(hit|hits|hitting) (a|an|the|its|their)( [\w-]+){0,4} limit\b/i, 'reached the limit'],
  [/\blast resort\b/i, '(say what it handles)'],
  [/\bbest[ -]effort\b/i, '(say what still happens)'],
  [/\bcarr(y|ies|ied|ying)\b/i, 'include / send / allow'],
  [/\bgo(es)? on\b/i, 'continue'],
  [/\bthat'?s it\b/i, 'setup is complete'],
  [/\bfoot of\b/i, 'bottom of'],
  [/\bwarmer\b/i, '(name the colour)'],
  [/\bstands? out\b/i, 'easy to see'],
  [/\bhero\b/i, 'main heading'],
  [/\blong way round\b/i, 'longer walk'],
  [/\bfast mornings\b/i, 'coffee brewed slowly'],
  // From the wording table of the 0.24.45 scan.
  [/\beither way\b/i, 'in both cases'],
  [/\bnow and then\b/i, 'sometimes'],
  [/\bleaves? nothing behind\b/i, 'leaves no partial file / removes everything'],
];

// Left out before the check: `code`, words used in their literal meaning (a window in front of
// another, dragging and dropping, reaching a limit), names ("dropped" is a board status,
// edits-dropped.json a file) and the CSS `cursor:grab`.
const LITERAL = new RegExp([
  /`[^`\n]*`/, /\b(another (window|tab|app)|is|opens it|(code|view),) in front\b/,
  /\bdrop(s|ped|ping)? (it |a window )?(at|near|on|in|here)\b/, /\b(if )?dropped (now|near|at|on)\b/,
  /\breach(es|ed)? (its|the|a|their)( [\w-]+){0,4} limit\b/, /\bdrop-shadow\b/, /"dropped"/, /[\w-]+\.json\b/,
  /\bcursor: ?grab(bing)?\b/,
].map((r) => r.source).join('|'), 'gi');
const plain = (text) => text.replace(LITERAL, (m) => m.replace(/[^\n]/g, ' '));

// The phrases found in text: [{ phrase, use, index }].
function hits(text) {
  const t = plain(text);
  const out = [];
  for (const [re, use] of PHRASES) {
    const m = re.exec(t);
    if (m) out.push({ phrase: m[0], use, index: m.index });
  }
  return out;
}

// Words after which a / starts a regex literal, not a division.
const BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await']);

// The strings and comments of a JS file. strings: [{ text, start, end, line }], where a template's text has
// "${}" for each expression and the strings inside an expression are their own entries. comments:
// [{ text, start, end, line, lastLine, block, alone }]. Regex literals are skipped.
function read(src) {
  const starts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') starts.push(k + 1);
  const lineOf = (pos) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const strings = [];
  const comments = [];
  const n = src.length;
  // Open templates, innermost last: { start, text, depth } (depth: where its open ${...} part ends).
  const templates = [];
  let depth = 0;
  // The last token: 'word', 'num', 'close' (a value), or the punctuator itself. A / after a value divides.
  let last = '';
  let i = 0;
  if (src.startsWith('#!')) i = src.indexOf('\n') < 0 ? n : src.indexOf('\n');
  // i is just after a ` or the } of an expression; read the template's text up to ` or ${.
  const template = () => {
    const t = templates[templates.length - 1];
    while (i < n) {
      const c = src[i];
      if (c === '\\') { t.text += src.slice(i, i + 2); i += 2; }
      else if (c === '`') {
        i++;
        templates.pop();
        strings.push({ text: t.text, start: t.start, end: i, line: lineOf(t.start) });
        last = 'close';
        return;
      } else if (c === '$' && src[i + 1] === '{') { i += 2; t.text += '${}'; t.depth = ++depth; last = '{'; return; }
      else { t.text += c; i++; }
    }
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && (d === '/' || d === '*')) {
      const e = d === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2);
      const end = e < 0 ? n : d === '/' ? e : e + 2;
      const line = lineOf(i);
      comments.push({ text: src.slice(i, end), start: i, end, line, lastLine: lineOf(Math.max(i, end - 1)),
        block: d === '*', alone: /^\s*$/.test(src.slice(starts[line - 1], i)) });
      i = end;
    } else if (c === '\'' || c === '"') {
      const from = i;
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      strings.push({ text: src.slice(from + 1, i), start: from, end: i + 1, line: lineOf(from) });
      i++;
      last = 'close';
    } else if (c === '`') {
      templates.push({ start: i, text: '', depth: -1 });
      i++;
      template();
    } else if (c === '/') {
      if (last === 'word' || last === 'num' || last === 'close') { i++; last = '/'; continue; }
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
    } else if (/[A-Za-z_$\u0080-￿]/.test(c)) {
      const word = /^[\w$\u0080-￿]+/.exec(src.slice(i, i + 64))[0];
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
      const t = templates[templates.length - 1];
      if (t && t.depth === depth) { depth--; t.depth = -1; template(); continue; }
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
  return { strings, comments };
}

// Comments joined where they continue each other: a // comment alone on its line joins the // comment
// that ends on the line above. Returns [{ text, line, pieces: [{ at, line }] }]; at is an offset in text.
function commentBlocks(src) {
  const out = [];
  let prev = null;
  for (const c of read(src).comments) {
    // Each line of the comment without its // or /* */ marks.
    const lines = c.text.split('\n').map((l, k) => ({ line: c.line + k,
      text: l.replace(/^\s*(\/\/+|\/\*+|\*+(?!\/))?/, '').replace(/\*+\/\s*$/, '').trim() }));
    if (!c.block && c.alone && prev && !prev.block && prev.lastLine === c.line - 1) {
      prev.lines.push(...lines);
      prev.lastLine = c.lastLine;
    } else {
      prev = { block: c.block, lastLine: c.lastLine, lines };
      out.push(prev);
    }
  }
  return out.map((b) => {
    let text = '';
    const pieces = [];
    for (const l of b.lines) {
      if (text) text += ' ';
      pieces.push({ at: text.length, line: l.line });
      text += l.text;
    }
    return { text, line: b.lines[0].line, pieces };
  });
}

// The source line of an offset in a joined comment.
function lineAt(block, index) {
  let line = block.line;
  for (const p of block.pieces) if (p.at <= index) line = p.line;
  return line;
}

module.exports = { PHRASES, LITERAL, plain, hits, read, commentBlocks, lineAt };
