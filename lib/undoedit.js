'use strict';
// "Undo only this edit": reverses one edit in a file that may have changed since, keeping later
// changes. Works on lines: each block the edit changed must still be exactly as the edit left it;
// otherwise only Claude can undo it (a conflict).

const { diffOps, splitLines } = require('./diff');

// The edit's changed blocks: { from, to } is the range in `after` (0-based, end exclusive), `old`
// the lines it replaced. Pure deletions have from === to.
function blocks(before, after) {
  const out = [];
  let cur = null;
  let newIdx = 0;
  for (const o of diffOps(splitLines(before), splitLines(after))) {
    if (o.op === ' ') {
      cur = null;
      newIdx++;
      continue;
    }
    if (!cur) {
      cur = { from: newIdx, to: newIdx, old: [] };
      out.push(cur);
    }
    if (o.op === '-') cur.old.push(o.text);
    else {
      newIdx++;
      cur.to = newIdx;
    }
  }
  return out;
}

// For each line of `after`, its index in `now` when no later change touched it, else -1.
function lineMap(after, now) {
  const map = [];
  let a = 0;
  let n = 0;
  for (const o of diffOps(after, now)) {
    if (o.op === ' ') map[a++] = n++;
    else if (o.op === '-') map[a++] = -1;
    else n++;
  }
  return map;
}

// -> { clean: true, text, lines: [first, last] } | { clean: false, lines } | { error }
// lines: 1-based lines of `after` the edit changed, for messages.
function reverseEdit({ before, after, now }) {
  if (typeof before !== 'string' || typeof after !== 'string' || typeof now !== 'string') return { error: 'not-kept' };
  const parts = blocks(before, after);
  if (!parts.length) return { error: 'no-change' };
  const first = parts[0].from + 1;
  const last = Math.max(first, parts[parts.length - 1].to);
  const lines = [first, last];
  if (now === after) return { clean: true, text: before, lines };
  const afterLines = splitLines(after);
  const nowLines = splitLines(now);
  const map = lineMap(afterLines, nowLines);
  const edits = [];
  for (const p of parts) {
    let at;
    if (p.to > p.from) {
      // Every line the edit wrote is still there, unchanged and together.
      for (let i = p.from; i < p.to; i++) {
        if (map[i] < 0 || (i > p.from && map[i] !== map[i - 1] + 1)) return { clean: false, lines };
      }
      at = { start: map[p.from], end: map[p.to - 1] + 1 };
    } else {
      // A deletion: the lines on both sides must still be next to each other.
      const prev = p.from > 0 ? map[p.from - 1] : -2;
      const next = p.from < afterLines.length ? map[p.from] : -2;
      if (prev === -1 || next === -1) return { clean: false, lines };
      const start = prev === -2 ? (next === -2 ? nowLines.length : next) : prev + 1;
      if (next !== -2 && next !== start) return { clean: false, lines };
      at = { start, end: start };
    }
    edits.push({ ...at, old: p.old });
  }
  const out = nowLines.slice();
  for (const e of edits.reverse()) out.splice(e.start, e.end - e.start, ...e.old);
  let text = out.join('\n');
  if (text && (now.endsWith('\n') || (now === '' && before.endsWith('\n')))) text += '\n';
  return { clean: true, text, lines };
}

module.exports = { reverseEdit };
