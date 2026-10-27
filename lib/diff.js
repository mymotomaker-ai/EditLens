'use strict';
// Small line diff used when Claude Code's own structuredPatch is not available.

const CONTEXT = 2;
// Above this many DP cells (old lines x new lines) we skip LCS and report a full replace.
const MAX_CELLS = 4_000_000;
const MAX_LINES_PER_EVENT = 400;
const MAX_LINE_LENGTH = 400;

function splitLines(text) {
  if (typeof text !== 'string' || text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Returns a list of ops: {op: ' '|'-'|'+', text, oldNo, newNo}.
function diffOps(a, b) {
  // Trim the common prefix and suffix first: most edits change a small region.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ op: ' ', text: a[i], oldNo: i + 1, newNo: i + 1 });

  if (midA.length * midB.length > MAX_CELLS) {
    midA.forEach((text, i) => ops.push({ op: '-', text, oldNo: start + i + 1, newNo: null }));
    midB.forEach((text, i) => ops.push({ op: '+', text, oldNo: null, newNo: start + i + 1 }));
  } else {
    const n = midA.length;
    const m = midB.length;
    // lcs[i][j] = LCS length of midA[i..] and midB[j..], stored flat.
    const lcs = new Uint32Array((n + 1) * (m + 1));
    const w = m + 1;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = midA[i] === midB[j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push({ op: ' ', text: midA[i], oldNo: start + i + 1, newNo: start + j + 1 });
        i++;
        j++;
      } else if (i < n && (j >= m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        // Removals before additions, like git.
        ops.push({ op: '-', text: midA[i], oldNo: start + i + 1, newNo: null });
        i++;
      } else {
        ops.push({ op: '+', text: midB[j], oldNo: null, newNo: start + j + 1 });
        j++;
      }
    }
  }
  const tailOffsetA = endA;
  const tailOffsetB = endB;
  for (let k = 0; k < a.length - endA; k++) {
    ops.push({ op: ' ', text: a[tailOffsetA + k], oldNo: tailOffsetA + k + 1, newNo: tailOffsetB + k + 1 });
  }
  return ops;
}

// Group ops into unified-diff style hunks with CONTEXT lines around changes.
function opsToHunks(ops) {
  const hunks = [];
  let current = null;
  let lastChange = -Infinity;
  ops.forEach((o, idx) => {
    if (o.op === ' ') return;
    const from = Math.max(0, idx - CONTEXT);
    if (current && from <= lastChange + CONTEXT + 1) {
      for (let k = lastChange + 1; k <= idx; k++) current.ops.push(ops[k]);
    } else {
      current = { ops: ops.slice(from, idx + 1) };
      hunks.push(current);
    }
    lastChange = idx;
    current.end = idx;
  });
  return hunks.map((h) => {
    const tail = ops.slice(h.end + 1, h.end + 1 + CONTEXT);
    const all = h.ops.concat(tail);
    const firstOld = all.find((o) => o.oldNo !== null);
    const firstNew = all.find((o) => o.newNo !== null);
    return {
      oldStart: firstOld ? firstOld.oldNo : 0,
      newStart: firstNew ? firstNew.newNo : 0,
      lines: all.map((o) => o.op + o.text),
    };
  });
}

function diffText(oldText, newText) {
  return opsToHunks(diffOps(splitLines(oldText), splitLines(newText)));
}

// Accept Claude Code's structuredPatch when it is well formed; return null otherwise.
function normalizeStructuredPatch(patch) {
  if (!Array.isArray(patch) || patch.length === 0) return null;
  const hunks = [];
  for (const h of patch) {
    if (!h || !Array.isArray(h.lines)) return null;
    const oldStart = Number(h.oldStart);
    const newStart = Number(h.newStart);
    // Guard against NaN / missing line numbers from unexpected payload shapes.
    if (!Number.isFinite(oldStart) || !Number.isFinite(newStart)) return null;
    hunks.push({
      oldStart,
      newStart,
      lines: h.lines.filter((l) => typeof l === 'string' && /^[ +\-\\]/.test(l)),
    });
  }
  return hunks;
}

// Limits the payload so one huge Write cannot overload the page.
function clampHunks(hunks) {
  let budget = MAX_LINES_PER_EVENT;
  let truncated = false;
  const out = [];
  for (const h of hunks) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const lines = h.lines.slice(0, budget).map((l) => (l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) + '…' : l));
    if (lines.length < h.lines.length) truncated = true;
    budget -= lines.length;
    out.push({ ...h, lines });
  }
  return { hunks: out, truncated };
}

function countStats(hunks) {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l[0] === '+') added++;
      else if (l[0] === '-') removed++;
    }
  }
  return { added, removed };
}

module.exports = { diffText, diffOps, normalizeStructuredPatch, clampHunks, countStats, splitLines };
