'use strict';
// Page selections (elements, areas, code lines) sent with a message: keeps only known fields
// with valid sizes, and describes them for Claude.

const MAX_ITEMS = 12;

function str(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// A finite, rounded number in range, or null (never NaN).
function int(v, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function box(b) {
  if (!b || typeof b !== 'object') return null;
  const x = int(b.x, -1e6, 1e7);
  const y = int(b.y, -1e6, 1e7);
  const w = int(b.w, 0, 1e6);
  const h = int(b.h, 0, 1e6);
  return x === null || y === null || w === null || h === null ? null : { x, y, w, h };
}

function source(s) {
  if (!s || typeof s !== 'object') return null;
  const comps = Array.isArray(s.components) ? s.components.map((c) => str(c, 60)).filter(Boolean).slice(0, 4) : [];
  const out = {
    file: str(s.file, 300),
    line: int(s.line, 1, 1e7),
    col: int(s.col, 1, 1e5),
    how: ['exact', 'parent', 'file', 'approx'].includes(s.how) ? s.how : null,
    components: comps,
  };
  return out.file || comps.length ? out : null;
}

function styles(s) {
  if (!s || typeof s !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(s).slice(0, 12)) {
    if (/^[a-zA-Z]{1,30}$/.test(k) && str(v, 80)) out[k] = str(v, 80);
  }
  return out;
}

function clean(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list.slice(0, MAX_ITEMS)) {
    if (!a || typeof a !== 'object') continue;
    const n = int(a.n, 1, 1e6);
    if (n === null) continue;
    if (a.kind === 'element') {
      out.push({
        kind: 'element', n,
        tag: str(a.tag, 30) || 'element',
        id: str(a.id, 80),
        classes: Array.isArray(a.classes) ? a.classes.map((c) => str(c, 40)).filter(Boolean).slice(0, 5) : [],
        selector: str(a.selector, 300),
        text: str(a.text, 160),
        role: str(a.role, 40),
        label: str(a.label, 80),
        box: box(a.box),
        styles: styles(a.styles),
        source: source(a.source),
      });
    } else if (a.kind === 'region') {
      out.push({
        kind: 'region', n,
        box: box(a.box),
        elements: Array.isArray(a.elements) ? a.elements.slice(0, 6).filter((e) => e && typeof e === 'object').map((e) => ({
          tag: str(e.tag, 30) || 'element', selector: str(e.selector, 300), text: str(e.text, 80), source: source(e.source),
        })) : [],
      });
    } else if (a.kind === 'code') {
      const line = int(a.line, 1, 1e7);
      const file = str(a.file, 300);
      if (!file || line === null) continue;
      const endLine = Math.max(line, int(a.endLine, 1, 1e7) || line);
      out.push({ kind: 'code', n, file, line, endLine, text: typeof a.text === 'string' ? a.text.slice(0, 3000) : '' });
    }
  }
  return out;
}

function where(src) {
  if (!src) return '';
  const comp = src.components.length ? ` (in ${src.components.join(' › ')})` : '';
  if (!src.file) return comp ? ` —${comp.slice(1)}` : '';
  const loc = `${src.file}${src.line ? `:${src.line}` : ''}`;
  if (src.how === 'parent') return ` — inside the element written at ${loc}${comp}`;
  if (src.how === 'file') return ` — rendered by ${loc} (line unknown)${comp}`;
  if (src.how === 'approx') return ` — in ${src.file}${src.line ? ` (React reports line ${src.line}, but Vite shifts it; find the element in the file)` : ''}${comp}`;
  return ` — written at ${loc}${comp}`;
}

function tagOf(a) {
  const cls = a.classes && a.classes.length ? `.${a.classes.slice(0, 3).join('.')}` : '';
  return `<${a.tag}${a.id ? `#${a.id}` : ''}${cls}>`;
}

function describe(a) {
  if (a.kind === 'code') {
    const fence = a.text.includes('```') ? '~~~' : '```';
    return `[${a.n}] ${a.endLine > a.line ? `Lines ${a.line}-${a.endLine}` : `Line ${a.line}`} of ${a.file}:\n${fence}\n${a.text}\n${fence}`;
  }
  if (a.kind === 'region') {
    const b = a.box;
    const lines = [`[${a.n}] An area of the page${b ? ` (${b.w}×${b.h} px at ${b.x},${b.y})` : ''}${a.elements.length ? ', containing:' : ''}`];
    for (const e of a.elements) lines.push(`    <${e.tag}>${e.text ? ` "${e.text}"` : ''}${where(e.source)}${e.selector ? ` · selector ${e.selector}` : ''}`);
    return lines.join('\n');
  }
  const parts = [`[${a.n}] ${tagOf(a)}${a.text ? ` "${a.text}"` : ''}${a.label ? ` (label "${a.label}")` : ''}${where(a.source)}`];
  const extra = [];
  if (a.selector) extra.push(`selector ${a.selector}`);
  if (a.role) extra.push(`role ${a.role}`);
  if (a.box) extra.push(`${a.box.w}×${a.box.h} px at ${a.box.x},${a.box.y}`);
  const st = Object.entries(a.styles || {}).map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${v}`);
  if (st.length) extra.push(st.join('; '));
  if (extra.length) parts.push(`    ${extra.join(' · ')}`);
  return parts.join('\n');
}

// text: the message. A line in it that starts with selection numbers ("2 Make it green", from the
// box next to a pick) is a note about those selections.
function formatAttachments(list, text) {
  if (!list || !list.length) return '';
  return (
    'The user selected these on the page (the numbers are drawn on their screen; to highlight one, ' +
    'call highlight_on_page with { "targets": [{ "marker": 2 }] }):\n' + list.map(describe).join('\n') +
    (notedNumbers(list, text) ? '\nA line of the message that starts with one of these numbers is about that selection.' : '')
  );
}

function notedNumbers(list, text) {
  const nums = new Set(list.map((a) => String(a.n)));
  return String(text || '').split('\n').some((line) => {
    const m = /^(\d{1,4}) /.exec(line);
    return Boolean(m) && nums.has(m[1]);
  });
}

// "2 things: <button> "Add to cart", Lines 11-16 of server.js"
function summary(list) {
  return list.map((a) => (a.kind === 'code' ? `${a.file}:${a.line}` : a.kind === 'region' ? 'an area' : tagOf(a))).join(', ');
}

module.exports = { clean, formatAttachments, summary, MAX_ITEMS };
