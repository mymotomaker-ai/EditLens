'use strict';
// All /editlens output goes through here as records: head ("✦ EditLens  ✓ connected"), field
// ("Page ······ <value>"), act (the next step), item (mark, bold name, dim note), row, meter, and
// fail (always followed by a "! Fix" line). Lines are plain text; with EDITLENS_SAY=records (set by
// the mod) each is also written as RS + "EL" + JSON, which the mod draws in the theme's colours.
// Symbols are narrow, never emoji, and one cell wide in Windows fonts: ✓ ! ✕ › · ◆ ● ○ ✦ │ └

const MARK = '\u001eEL';
// The field label column: the label, a dotted line, a space (the Settings pane's layout). A block
// with a longer label passes its own width (say.fields does), so its values line up.
const LABEL = 12;
// Column widths every screen shares (the mod draws the same widths with real columns).
const CMD = 22; // /editlens help: the command column
const METER_LABEL = 10; // /editlens usage: the label column
const METER = 16; // cells in a usage meter

function records() {
  return process.env.EDITLENS_SAY === 'records';
}

function clean(v) {
  return v === undefined || v === null ? '' : String(v);
}

function cells(text) {
  return [...clean(text)].length;
}

// A field's label with its dotted line, as wide as its column: "Page ······ ". No label (a second
// line of a value): spaces, so the line starts under the value.
function labelText(r) {
  const label = clean(r.label);
  const width = Number.isInteger(r.width) && r.width > 0 ? r.width : LABEL;
  if (!label) return ' '.repeat(width);
  return label + ' ' + '·'.repeat(Math.max(2, width - cells(label) - 2)) + ' ';
}

// The label column a block of fields needs: LABEL, or the longest label, its dots and spaces.
function fieldWidth(labels) {
  return Math.max(LABEL, ...labels.map((l) => (clean(l) ? cells(l) + 4 : 0)));
}

// A label, a dotted line and a value: the values of rows with the same width start in one column.
function leaderText(label, value, width) {
  const w = Number.isInteger(width) && width > 0 ? width : cells(label);
  return clean(label) + ' ' + '·'.repeat(Math.max(2, w - cells(label) + 2)) + ' ' + clean(value);
}

// A percent as a meter of ━ and ─ (box-drawing lines every Windows font has). -> [filled, empty]
function meterCells(percent, size = METER) {
  const n = typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const on = Math.round((n / 100) * size);
  return ['━'.repeat(on), '─'.repeat(size - on)];
}

// "41%", or '' for a number that isn't one.
function percentText(percent) {
  return typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 ? Math.round(percent) + '%' : '';
}

// The head: ✦, the title ("EditLens" unless it names its own; '' for none, as in
// "✦ ✓ Paired with ◆ laptop-1"), the state, a dim note.
function headText(r) {
  const title = typeof r.title === 'string' ? r.title : 'EditLens';
  const state = r.status ? ({ ok: '✓', warn: '!', fail: '✕' }[r.status] || '') + ' ' + clean(r.word) : '';
  return '✦ ' + [title, state].filter(Boolean).join('  ') + (r.note ? '  · ' + r.note : '');
}

// One record -> its plain lines.
function plain(r) {
  switch (r.k) {
    case 'head': return [headText(r)];
    case 'field': return [labelText(r) + clean(r.value) + (r.note ? '  ' + r.note : '')];
    case 'act': return [clean(r.text)];
    case 'hint': return [(r.items || []).map(([cmd, what]) => clean(cmd) + (what ? '  ' + what : '')).join('  ·  ')];
    case 'done': return ['✓ ' + clean(r.text) + (r.note ? '  ' + r.note : '')];
    case 'fail': return ['✕ ' + clean(r.what) + (r.detail ? ': ' + r.detail : '')];
    case 'fix': return [('! Fix  ' + (r.before ? r.before + ' ' : '') + (r.cmd ? (r.run ? 'Run ' : '› ') + r.cmd : '') + (r.after ? (/^[,.;]/.test(r.after) ? '' : ' ') + r.after : '')).trimEnd()];
    // copy: a line to type on another computer (the join line), on its own line, never indented.
    case 'code': return ['', (r.copy ? '' : '    ') + clean(r.text), ''];
    case 'steps': {
      const out = ['! ' + clean(r.heading) + (r.note ? '  ' + r.note : '')];
      for (const s of r.items || []) {
        const lead = s.n === undefined ? '   ' : String(s.n).padEnd(3);
        out.push('│  ' + lead + (s.cmd ? '› ' + s.cmd : '') + (s.cmd && s.text ? '  ' : '') + clean(s.text) + (s.note ? '  ' + s.note : ''));
      }
      if (r.end) out.push('└  ' + clean(r.end.text) + (r.end.cmd ? (r.end.text ? ' ' : '') + r.end.cmd : ''));
      return out;
    }
    case 'title': return [clean(r.text)];
    case 'item': return [({ ok: '✓', warn: '!', on: '●', fail: '✕' }[r.mark] || ' ') + ' ' + clean(r.name).padEnd(Number.isInteger(r.width) && r.width > 0 ? r.width : 0) + (r.note ? '  ' + r.note : '')];
    case 'cmd': {
      // The command column: CMD, or the width a list of longer commands requested (cmdWidth).
      const w = Number.isInteger(r.width) && r.width > 0 ? r.width : CMD;
      return ['  ' + (cells(r.cmd) + 1 > w ? clean(r.cmd) + '  ' : clean(r.cmd).padEnd(w)) + clean(r.what)];
    }
    case 'row': return [leaderText(r.label, r.value, r.width) + (r.note ? '  ' + r.note : '')];
    case 'meter': {
      const [on, off] = meterCells(r.percent);
      return [clean(r.label).padEnd(METER_LABEL) + on + off + '  ' + percentText(r.percent).padStart(4) + (r.note ? '   ' + r.note : '')];
    }
    case 'cmds': return ['  /editlens ' + (r.items || []).join('  ') + (r.note ? '    more: ' + r.note : '')];
    case 'blank': return [''];
    default: return [clean(r.text)];
  }
}

// Prints one record: its plain lines, and the record itself for the mod.
function emit(r) {
  const lines = plain(r);
  if (records()) process.stdout.write(MARK + JSON.stringify({ ...r, plain: lines }) + '\n');
  else process.stdout.write(lines.join('\n') + '\n');
}

const say = {
  head: (status, word, note, title) => emit({ k: 'head', status, word, note, ...(typeof title === 'string' ? { title } : {}) }),
  item: (mark, name, note, width) => emit({ k: 'item', mark, name, note, width }),
  field: (label, value, note, opts) => emit({ k: 'field', label, value, note, ...(opts || {}) }),
  // A block of fields whose values start in one column: [[label, value, note, opts], ...].
  // width: the column for the whole reply when it has more than one block.
  fields: (list, width) => {
    const w = Number.isInteger(width) && width > 0 ? width : fieldWidth(list.map((f) => f[0]));
    for (const [label, value, note, opts] of list) emit({ k: 'field', label, value, note, ...(opts || {}), width: w });
  },
  act: (text) => emit({ k: 'act', text }),
  hint: (...items) => emit({ k: 'hint', items }),
  done: (text, note) => emit({ k: 'done', text, note }),
  fail: (what, detail) => emit({ k: 'fail', what, detail }),
  fix: (cmd, after, before) => emit({ k: 'fix', cmd, after, before }),
  code: (text, copy) => emit({ k: 'code', text, ...(copy ? { copy: true } : {}) }),
  steps: (heading, items, end, note) => emit({ k: 'steps', heading, items, end, note }),
  title: (text) => emit({ k: 'title', text }),
  cmd: (cmd, what, width) => emit({ k: 'cmd', cmd, what, ...(Number.isInteger(width) ? { width } : {}) }),
  // Command rows whose descriptions line up, whatever the command length.
  cmdList: (list) => {
    const width = Math.max(CMD, ...list.map(([cmd]) => cells(cmd) + 2));
    for (const [cmd, what] of list) emit({ k: 'cmd', cmd, what, width });
  },
  cmds: (items, note) => emit({ k: 'cmds', items, note }),
  // tone: 'ok' (green), 'warn' or 'off' (dim), for the value.
  row: (label, value, tone, opts) => emit({ k: 'row', label, value, tone, ...(opts || {}) }),
  meter: (label, percent, note, extra) => emit({ k: 'meter', label, percent, note, ...(extra || {}) }),
  blank: () => emit({ k: 'blank' }),
  // Two lines to copy: the plain one (the default key), then, under a dim "With a key file:",
  // the same with the key file. Each on its own line, never wrapped or indented.
  copyLines: (plainLine, keyLine) => {
    emit({ k: 'code', text: plainLine, copy: true });
    emit({ k: 'text', text: 'With a key file:', dim: true });
    emit({ k: 'code', text: keyLine, copy: true });
  },
  text: (text, dim) => emit({ k: 'text', text, dim: Boolean(dim) }),
  // Records made elsewhere (the mod's recordsFromText): printed with their own plain lines.
  records: (list) => {
    for (const r of list || []) {
      const lines = Array.isArray(r.plain) ? r.plain.map(String) : plain(r);
      if (records()) process.stdout.write(MARK + JSON.stringify({ ...r, plain: lines }) + '\n');
      else process.stdout.write(lines.join('\n') + '\n');
    }
  },
};

// Output of another EditLens script run with records on: its records, and any other line as text.
function parse(out) {
  const list = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    if (line.startsWith(MARK)) {
      try {
        list.push(JSON.parse(line.slice(MARK.length)));
        continue;
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
      }
    }
    if (line.trim()) list.push({ k: 'text', text: line, plain: [line] });
  }
  return list;
}

module.exports = { say, plain, parse, emit, labelText, fieldWidth, leaderText, meterCells, percentText, MARK, LABEL, CMD, METER_LABEL, METER };
