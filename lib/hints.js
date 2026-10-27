'use strict';
// Turns a code change into DOM lookup hints (ids, classes, CSS selectors, visible text)
// that the page script uses to find the elements the change affects.

const MAX_PER_KIND = 12;
const STYLE_EXT = new Set(['.css', '.scss', '.sass', '.less', '.styl', '.pcss']);

function uniq(list) {
  return [...new Set(list)].slice(0, MAX_PER_KIND);
}

// Lines that exist after the change: added lines first, then context lines.
function afterLines(hunks) {
  const added = [];
  const context = [];
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l[0] === '+') added.push(l.slice(1));
      else if (l[0] === ' ') context.push(l.slice(1));
    }
  }
  return { added, context };
}

const ID_RE = /\bid\s*=\s*["'{`]\s*["'`]?([A-Za-z][\w:-]*)/g;
const CLASS_ATTR_RE = /\b(?:class|className)\s*=\s*(?:\{\s*)?["'`]([^"'`]+)["'`]/g;
const CLASS_TOKEN_RE = /^-?[A-Za-z_][\w-]*$/;
const TAG_TEXT_RE = />\s*([^<>{}\n]{3,80}?)\s*</g;
const STRING_RE = /(["'`])((?:(?!\1)[^\\\n]){0,80})\1/g; // short ones too, so quotes pair up
const TEXTY_RE = /[A-Za-z]{3,}\s+[A-Za-z]/; // looks like words, not an identifier or a path

function collect(re, line, group, out) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(line)) !== null) out.push(m[group]);
}

function markupHints(lines) {
  const ids = [];
  const classes = [];
  const texts = [];
  for (const line of lines) {
    collect(ID_RE, line, 1, ids);
    const classAttrs = [];
    collect(CLASS_ATTR_RE, line, 1, classAttrs);
    for (const attr of classAttrs) {
      for (const token of attr.split(/\s+/)) if (CLASS_TOKEN_RE.test(token)) classes.push(token);
    }
    collect(TAG_TEXT_RE, line, 1, texts);
    const strings = [];
    collect(STRING_RE, line, 2, strings);
    for (const s of strings) if (s.length >= 4 && TEXTY_RE.test(s) && !/[{}<>]|https?:/.test(s)) texts.push(s);
    // Bare text lines inside markup, e.g. a paragraph body on its own line.
    const bare = line.trim();
    if (bare.length >= 4 && bare.length <= 120 && !/[<>{}=;()]/.test(bare) && TEXTY_RE.test(bare)) texts.push(bare);
  }
  return {
    ids: uniq(ids),
    classes: uniq(classes),
    texts: uniq(texts.map((t) => t.trim()).filter((t) => t.length >= 3)),
  };
}

// For stylesheets: finds the selector of the rule that contains each changed line.
function styleSelectors(fileText, hunks) {
  if (typeof fileText !== 'string') return [];
  const lines = fileText.split('\n');
  const selectors = [];
  for (const h of hunks) {
    let newNo = h.newStart;
    for (const l of h.lines) {
      if (l[0] === '-') continue;
      if (l[0] === '+') selectors.push(...enclosingSelector(lines, newNo - 1));
      newNo++;
    }
  }
  return uniq(selectors);
}

function enclosingSelector(lines, index) {
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) return [];
  let depth = 0;
  for (let i = index; i >= 0; i--) {
    const line = lines[i];
    // Count braces right to left so a rule that closes above this line is skipped.
    for (let c = line.length - 1; c >= 0; c--) {
      if (line[c] === '}' && i !== index) depth++;
      else if (line[c] === '{') {
        if (depth === 0) {
          // Selector text may span lines: collect back to the previous ; } or {.
          let sel = line.slice(0, c);
          for (let k = i - 1; k >= 0 && !/[;{}]\s*$/.test(lines[k]) && sel.split(',').length < 20; k--) {
            sel = lines[k] + '\n' + sel;
          }
          sel = sel.replace(/\/\*[\s\S]*?\*\//g, '').trim();
          if (!sel || sel.startsWith('@')) continue; // @media and similar: keep looking outward
          return sel.split(',').map((s) => s.trim()).filter(Boolean);
        }
        depth--;
      }
    }
  }
  return [];
}

function buildHints({ ext, hunks, fileText }) {
  const { added, context } = afterLines(hunks);
  if (STYLE_EXT.has(ext)) {
    return { selectors: styleSelectors(fileText, hunks), ids: [], classes: [], texts: [] };
  }
  const primary = markupHints(added);
  // Context lines help when only an attribute value changed on a multi-line element.
  if (primary.ids.length + primary.classes.length + primary.texts.length === 0) {
    const fallback = markupHints(context);
    return { selectors: [], ids: fallback.ids, classes: fallback.classes, texts: [] };
  }
  return { selectors: [], ...primary };
}

module.exports = { buildHints, enclosingSelector, STYLE_EXT };
