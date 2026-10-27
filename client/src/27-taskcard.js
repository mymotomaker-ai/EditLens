  // Part of the page script: client/src files are joined in order (lib/client-script.js) and share
  // the scope opened in 1-panel.js.
  // ---------- task cards (handoff 16.1) ----------
  // One card per task between paired computers: "here" (a paired computer asked Claude here) or
  // "there" (Claude here asked a paired computer). A finished card folds to one line when a newer one
  // is below. The page never allows a permission question and never sends Claude a message by itself.
  styleEl.textContent += [
    '.k-task{container:tcard/inline-size;padding:10px 12px 8px;border-radius:12px;background:var(--raise);border:0;box-shadow:var(--card);font:400 12px/1.45 var(--sans);color:var(--fg)}',
    '.k-task.fresh{animation:flash 1.4s ease-out}',
    '.k-task.asks{box-shadow:0 0 0 1px color-mix(in srgb,var(--warn) 50%,transparent),0 4px 14px -6px rgba(0,0,0,.2)}',
    // Top row: the label, the root tag, then the status and time on the right.
    '.k-task .th{display:flex;align-items:center;gap:8px;min-width:0}',
    '.k-task .th .achip{flex:0 1 auto}.k-task .am.bad{background:var(--del)}',
    '.k-task .tsw{margin-left:auto;display:inline-flex;align-items:center;gap:5px;min-width:0;font-size:11.5px;color:var(--muted);white-space:nowrap}',
    '.k-task .tsw.w{color:var(--warn)}.k-task .tsw.ok{color:var(--add)}.k-task .tsw.er{color:var(--del)}',
    '.k-task .tsw svg{width:12px;height:12px;flex:none}',
    '.k-task .tst{overflow:hidden;text-overflow:ellipsis}.k-task .tslots{font-size:inherit;color:inherit}.k-task .tslots::before{content:"· "}.k-task .tslots:empty{display:none}',
    '.k-task .tago{flex:none;font-size:11px;color:var(--faint)}.k-task .th>.tago{margin-left:-3px}',
    '.k-task .rootc{flex:none;font:600 10.5px/1.4 var(--sans);padding:0 6px;border-radius:99px;color:var(--del);background:color-mix(in srgb,var(--del) 12%,transparent);cursor:help}',
    // Title, the rest of the prompt (two lines), More.
    '.k-task .tt{margin-top:7px;font-weight:600;font-size:13.5px;letter-spacing:-.005em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.k-task .tp{margin-top:2px;color:var(--muted);white-space:pre-line;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '.k-task .tp.open,.k-task .trep p.open{display:block;-webkit-line-clamp:unset}',
    '.k-task .tmore{border:0;background:none;padding:0;margin:1px 0 0;color:var(--api);font:500 11.5px/1.4 var(--sans);cursor:pointer}.k-task .tmore:hover{text-decoration:underline}',
    // Now: the current step.
    '.k-task .tnow{display:flex;align-items:center;gap:7px;margin-top:8px;color:var(--muted);white-space:nowrap;overflow:hidden;min-width:0}',
    '.k-task .tnow b{font-weight:500;color:var(--fg);overflow:hidden;text-overflow:ellipsis;min-width:0}',
    '.k-task .tnow.wait{white-space:normal}',
    '.k-task .tspin{flex:none;width:9px;height:9px;border-radius:50%;border:1.5px solid var(--fill2);border-top-color:var(--accent);animation:spin .9s linear infinite}',
    // Files: the header with counts and where they are, then Changes rows without line 2.
    '.k-task .tfh{display:flex;align-items:center;flex-wrap:wrap;gap:2px 6px;margin:10px 0 5px;font-size:11px;font-weight:600;color:var(--faint)}',
    '.k-task .tfh .cnt{font:11px/1.3 var(--mono)}.k-task .tfh .cnt .a{color:var(--add)}.k-task .tfh .cnt .d{color:var(--del)}',
    '.k-task .twhere{margin-left:auto;display:inline-flex;align-items:center;gap:4px;border:0;background:none;padding:0;color:var(--faint);font:500 11px/1.3 var(--sans);cursor:help;text-align:right}',
    '.k-task .twhere:hover{color:var(--fg)}.k-task .twhere svg{width:12px;height:12px;flex:none}',
    '.k-task .tfiles{margin:0;padding:2px;list-style:none;border-radius:10px;background:var(--fill)}',
    '.k-task .tfiles li{padding:6px 8px}.k-task .tfiles li+li{border-top:.5px solid var(--line)}.k-task .tfiles .c1{font-size:12px}.k-task .tfiles .c1 .f{font-size:12px}',
    '.k-task .tfiles li.tless{color:var(--faint);font-size:11px}',
    '.k-task .tall{display:block;border:0;background:none;padding:0;margin:5px 0 0 8px;color:var(--api);font:500 11.5px/1.4 var(--sans);cursor:pointer}.k-task .tall:hover{text-decoration:underline}',
    // Claude's reply, a question, a warning, a note.
    '.k-task .trep,.k-task .tq{margin-top:9px;padding:7px 10px;border-radius:9px;background:var(--fill)}',
    '.k-task .trep .lh2{font-size:11px;font-weight:600;color:var(--faint);margin-bottom:2px}',
    '.k-task .trep p{margin:0;white-space:pre-line;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
    '.k-task .tq b{font-weight:600}.k-task .tq code{display:block;margin-top:5px;font:11.5px/1.4 var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.k-task .tq .tqn{margin-top:5px;color:var(--muted);font-size:11.5px}',
    '.k-task .twarn{display:flex;gap:6px;align-items:flex-start;margin-top:8px;color:var(--muted);overflow-wrap:anywhere}.k-task .twarn svg{width:13px;height:13px;flex:none;margin-top:2px;color:var(--del)}',
    '.k-task .tq .twarn{margin-top:5px}',
    '.k-task .tnote{margin-top:8px;color:var(--muted);font-size:11.5px;overflow-wrap:anywhere}',
    // After Claude added its changes: a line with Undo.
    '.k-task .tapl{display:flex;align-items:center;gap:6px;margin-top:5px;color:var(--add);font-size:12px}.k-task .tapl svg{width:12px;height:12px;flex:none}',
    '.k-task .tapl.undone{color:var(--muted)}.k-task .tapl .tb{margin-left:auto}',
    // The row of buttons.
    '.k-task .tft{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:9px;padding-top:7px;border-top:.5px solid var(--line)}',
    '.k-task .tft .sp{flex:1}.k-task .tft .pmode.ef{margin:0;flex:none}',
    '.k-task .thint{font-size:11px;color:var(--faint);border:0;background:none;padding:0;cursor:pointer;text-decoration:none}.k-task .thint:hover{color:var(--fg);text-decoration:underline}',
    '.k-task span.thint{cursor:default}.k-task span.thint:hover{text-decoration:none;color:var(--faint)}',
    '.k-task .tb{display:inline-flex;align-items:center;padding:4px 10px;border:0;border-radius:7px;background:var(--fill2);color:var(--fg);font:500 12px/1.3 var(--sans);white-space:nowrap;cursor:pointer;text-decoration:none}',
    '.k-task .tb:hover{background:color-mix(in srgb,var(--fg) 12%,transparent)}.k-task .tb:disabled{opacity:.45;cursor:default}',
    '.k-task .tb.p{background:var(--accent-fill);color:#fff}.k-task .tb.p:hover{filter:brightness(1.06)}',
    '.k-task .tb.q{background:transparent;color:var(--muted)}.k-task .tb.q:hover{background:var(--fill);color:var(--fg)}',
    '.k-task .tb.no{color:var(--del)}',
    // Folded: one line (label, title, files, time, chevron); a click opens it.
    '.k-task.folded{padding:8px 12px;cursor:pointer}.k-task.folded .th .ttl{font-weight:600;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:0 1 auto}',
    '.k-task.folded .th .tsw{flex:none}.k-task.folded .achip .aw{display:none}.k-task .tchev{flex:none;width:11px;height:11px;transform:rotate(-90deg)}.k-task .tchev.up{transform:rotate(180deg)}',
    '.k-task .tfold{border:0;background:none;padding:0 2px;color:var(--faint);cursor:pointer;display:inline-flex}.k-task .tfold:hover{color:var(--fg)}',
    // The full sentence (ⓘ) and the whole text (More on a phone).
    '.acard .tsheet b{display:block;font-weight:600;margin-bottom:4px}.acard .tsheet p{margin:0;white-space:pre-line;overflow-wrap:anywhere}.acard .tsheet{padding:8px 8px 6px;font-size:12.5px}',
    // Narrow panel: status under the label, where-line under the files header, effort as bars only.
    '@container tcard (max-width:300px){.k-task:not(.folded) .th{flex-wrap:wrap}.k-task:not(.folded) .th .tsw{order:5;flex:1 0 100%;margin:1px 0 0;white-space:normal}',
    '.k-task .th>.tago{margin-left:auto}.k-task .tfh .twhere{flex:1 0 100%;margin-left:0;text-align:left}',
    '.k-task .tft .pmode.ef>span:not(.lv),.k-task .tft .pmode.ef>svg{display:none}}',
    // A phone: full width in the sheet, 32 px buttons.
    '.panel.phone .k-task .tft .tb,.panel.phone .k-task .tft .pmode.ef{min-height:32px}',
  ].join('');

  var taskCards = Object.create(null); // id -> { item, ev, open: { prompt, reply, files }, userOpen }
  var remoteCards = Object.create(null);
  var noticeCards = Object.create(null);
  var appliedByTask = Object.create(null); // task id -> the last task-applied event
  var APPLIED_WAIT_MAX = 100; // of those for tasks whose card has not arrived: the oldest are removed
  var TASK_DONE = dict({ idle: 1, ended: 1, stopped: 1, failed: 1 });
  var TASK_STATES = dict({ waiting: 'Waiting', starting: 'Starting', working: 'Working', idle: 'Done', ended: 'Ended', stopped: 'Stopped', failed: 'Failed', refused: 'Didn\'t start' });
  // Running or waiting: the card shows how many tasks run of the Tasks at once limit ("2 of 4 running").
  var TASK_LIVE = dict({ waiting: 1, starting: 1, working: 1 });
  var TASK_RUNNING = dict({ starting: 1, working: 1 });
  var SVG_NS = 'http://www.w3.org/2000/svg';

  // A small line icon: 'info' (ⓘ), 'warn', 'check', 'chev'.
  function tIcon(name) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    var d = { info: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 7.2V11M8 5v.1', warn: 'M8 2.5l6 10.5H2zM8 7v2.5M8 11.3v.1', check: 'M3 8.5l3 3 7-7', chev: 'M4 6l4 4 4-4' }[name];
    var p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
    return svg;
  }
  // "now", "30 s", "2 min", "1 h".
  function taskAgo(ts) {
    var t = Number(ts);
    if (!Number.isFinite(t) || t <= 0) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 5) return 'now';
    if (s < 60) return s + ' s';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    return Math.floor(s / 3600) + ' h';
  }
  setInterval(function () {
    feedEl.querySelectorAll('.k-task .tago').forEach(function (n) { n.textContent = taskAgo(n.getAttribute('data-ts')); });
  }, 1000);
  function isPhone() {
    return panel.classList.contains('phone') || lastPointer === 'touch';
  }
  // The prompt's first line (the title) and the rest.
  function promptParts(prompt) {
    var lines = String(prompt || '').split('\n');
    var i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    return { title: (lines[i] || '').trim(), rest: lines.slice(i + 1).join('\n').trim() };
  }
  // Claude's last reply without a "Done: <the prompt>" line (the title already says it).
  function replyText(reply, title) {
    var t = String(title || '').trim().toLowerCase();
    return String(reply || '').split('\n').filter(function (l) {
      var m = /^\s*\**done:?\**\s*(.*)$/i.exec(l);
      return !(m && t && m[1].trim().replace(/[.\s]+$/, '').toLowerCase() === t.replace(/[.\s]+$/, ''));
    }).join('\n').trim();
  }
  // A tool step ("Edit src/a.js", "Bash npm test") in words: { verb, what }.
  var STEP_VERBS = dict({ Edit: 'Editing', MultiEdit: 'Editing', Write: 'Editing', NotebookEdit: 'Editing', Read: 'Reading', Bash: 'Running', Grep: 'Searching', Glob: 'Searching',
    WebFetch: 'Opening', WebSearch: 'Searching the web', Task: 'Starting a subagent', Agent: 'Starting a subagent', TodoWrite: 'Planning' });
  var STEP_FILES = dict({ Edit: 1, MultiEdit: 1, Write: 1, NotebookEdit: 1, Read: 1 });
  function stepWords(step) {
    var m = /^(?:\[subagent\] )?(\S+)\s*([\s\S]*)$/.exec(String(step || '').trim());
    if (!m) return null;
    var what = m[2].trim();
    return { verb: STEP_VERBS[m[1]] || m[1], what: STEP_FILES[m[1]] ? baseName(what) : what };
  }
  // One line in a small sheet (phone) or beside the button: the whole text, or the full sentence.
  function taskPop(button, key, build) {
    showPop(button, build, key, isPhone());
  }
  // True when a feed card was added below this card after it finished (its own edits don't count).
  // c.doneLast: the feed's last card when it finished.
  function newerBelow(c) {
    var last = feedEl.lastElementChild;
    if (!c.item.isConnected || !c.doneLast || !last || last === c.doneLast) return false;
    // FOLLOWING (4): the current last card is after the old one (not an older card left after a removal).
    return !c.doneLast.isConnected || Boolean(c.doneLast.compareDocumentPosition(last) & 4);
  }
  // Every card this page shows, for folding: [{ c, draw }].
  function allTaskCards() {
    var out = [];
    Object.keys(taskCards).forEach(function (id) { out.push({ c: taskCards[id], draw: function () { renderTask(id); } }); });
    Object.keys(remoteCards).forEach(function (id) { out.push({ c: remoteCards[id], draw: function () { renderRemote(id); } }); });
    return out;
  }
  // A finished card folds once something newer is below it (never a running, waiting or asking one).
  var foldTimer = 0;
  new MutationObserver(function () {
    clearTimeout(foldTimer);
    foldTimer = setTimeout(function () {
      allTaskCards().forEach(function (x) {
        if (x.c.item && x.c.item.isConnected && !x.c.item.classList.contains('folded') && x.c.foldable && !x.c.userOpen && newerBelow(x.c)) x.draw();
      });
    }, 50);
  }).observe(feedEl, { childList: true });

  // "Sessions" on a task card: the Sessions sheet at that computer's group.
  function sessionsButton(group) {
    return el('button', { class: 'tb q', type: 'button', 'data-act': 'sessions', text: 'Sessions', title: 'Every session ' + (group === 'here' ? 'on this computer' : 'on ' + group.replace(/^r:/, '◆ ')),
      on: { click: function () { openSessions(group); } } });
  }
  // Stop (Cancel while it is waiting). path is the stop endpoint for the task's direction.
  function stopButton(path, id, waiting) {
    var b = el('button', { class: 'tb', type: 'button', 'data-act': 'stop', text: waiting ? 'Cancel' : 'Stop', title: waiting ? 'Remove it from the line of waiting tasks' : 'Stop this task',
      on: { click: function () {
        b.disabled = true;
        postJson(path, { page: PAGE_ID, task: id }).then(function (r) {
          if (r && r.error) {
            b.disabled = false;
            showToast(r.error, 6000);
          }
        }).catch(function (err) {
          b.disabled = false;
          showToast('Could not stop the task: ' + err.message, 6000);
        });
      } } });
    return b;
  }
  function finiteOrNull(v) {
    return Number.isFinite(v) ? v : null;
  }
  // A task's files, one row per file, newest first. Counts are summed only if every edit has them.
  function taskFiles(edits, extra) {
    var rows = [];
    var byPath = Object.create(null);
    var num = function (v) {
      if (v === null || v === undefined || v === '') return null;
      var n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    (Array.isArray(edits) ? edits : []).slice().reverse().forEach(function (e) {
      if (!e || typeof e.relFile !== 'string' || !e.relFile) return;
      var key = shownPath(e.relFile);
      var r = byPath[key];
      var a = num(e.added);
      var d = num(e.removed);
      if (!r) {
        r = byPath[key] = { relFile: e.relFile, file: typeof e.file === 'string' ? e.file : '', created: Boolean(e.created), deleted: Boolean(e.deleted), stats: { added: a, removed: d }, ts: e.ts, hunks: [] };
        Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; });
        rows.push(r);
        return;
      }
      // An older edit of the same file: use its created flag and add its counts.
      r.created = Boolean(e.created);
      r.stats.added = r.stats.added === null || a === null ? null : finiteOrNull(r.stats.added + a);
      r.stats.removed = r.stats.removed === null || d === null ? null : finiteOrNull(r.stats.removed + d);
    });
    return rows;
  }
  // "+A −R" for the header, or null unless every file's counts are known.
  function filesTotal(rows) {
    var add = 0;
    var del = 0;
    for (var i = 0; i < rows.length; i++) {
      var c = countsOf(rows[i]);
      if (c.kind === 'unknown' || c.added === null || c.removed === null) return null;
      add += c.added;
      del += c.removed;
    }
    // A sum past the largest number is unknown.
    return Number.isFinite(add) && Number.isFinite(del) ? { kind: 'diff', added: add, removed: del } : null;
  }

  // Draws one card. c: { item, open, userOpen }. m: what it shows (see renderTask and renderRemote).
  function drawTaskCard(c, m) {
    var item = c.item;
    var asks = Boolean(m.asks);
    c.foldable = Boolean(TASK_DONE[m.state]) && !asks;
    if (!c.foldable) c.doneLast = null;
    else if (!c.doneLast) c.doneLast = feedEl.lastElementChild;
    var applied = m.applied && !m.applied.undone ? m.applied : null;
    var folded = c.foldable && !c.userOpen && Boolean(applied || newerBelow(c));
    item.className = 'k-task st-' + m.state + (asks ? ' asks' : '') + (folded ? ' folded' : '') + (c.fresh ? ' fresh' : '');
    c.fresh = false;
    item.setAttribute('data-task', m.id);
    item.replaceChildren();
    // The label: the details card on hover or click; its mark says the card's state.
    var chip = m.chip;
    var mark = chip.querySelector('.am');
    if (mark) mark.className = 'am ' + (asks || m.state === 'waiting' ? 'ask' : TASK_RUNNING[m.state] ? 'spin' : m.state === 'failed' || m.state === 'refused' ? 'bad' : 'ok');
    var head = el('div', { class: 'th' }, chip);
    if (m.root) head.appendChild(el('span', { class: 'rootc', text: 'root', title: m.root, tabindex: '0' }));
    var ago = el('span', { class: 'tago', 'data-ts': String(m.at || ''), text: taskAgo(m.at), title: Number(m.at) > 0 ? clock(Number(m.at)) : '' });
    if (folded) {
      item.title = 'Show this task';
      head.appendChild(el('span', { class: 'ttl', text: m.title || 'Task' }));
      var n = m.files.length;
      head.appendChild(el('span', { class: 'tsw' }, n ? el('span', { class: 'tfc', text: n + (n === 1 ? ' file' : ' files') }) : null, ago, tIcon('chev')));
      head.lastChild.lastChild.setAttribute('class', 'tchev');
      item.appendChild(head);
      if (m.applied) item.appendChild(appliedLine(m));
      item.onclick = function (e) {
        if (e.target.closest && e.target.closest('button, a, .achip')) return;
        c.userOpen = true;
        m.redraw();
      };
      return;
    }
    item.removeAttribute('title');
    item.onclick = null;
    var tone = asks || m.state === 'waiting' ? ' w' : m.state === 'idle' ? ' ok' : m.state === 'failed' || m.state === 'refused' ? ' er' : '';
    var sw = el('span', { class: 'tsw' + tone }, m.state === 'idle' && !asks ? tIcon('check') : null, el('span', { class: 'tst', text: m.status }),
      TASK_LIVE[m.state] && !asks && m.slots ? m.slots : null);
    // The time is a separate item, so a narrow card keeps it on the top row and moves the status below.
    head.appendChild(sw);
    head.appendChild(ago);
    if (c.foldable && c.userOpen) {
      // Opened from its folded line: it can fold again.
      var back = el('button', { class: 'tfold', type: 'button', title: 'Show this task as one line', 'aria-label': 'Hide', on: { click: function () { c.userOpen = false; m.redraw(); } } }, tIcon('chev'));
      back.firstChild.setAttribute('class', 'tchev up');
      head.appendChild(back);
    }
    item.appendChild(head);
    item.appendChild(el('div', { class: 'tt', text: m.title || 'Task', title: m.title || '' }));
    if (m.rest) item.appendChild(moreText('tp', m.rest, c, 'prompt', m.title));
    // Now: the step it is on, or why it waits.
    if (TASK_RUNNING[m.state] && !asks && m.step) {
      var w = stepWords(m.step);
      if (w) item.appendChild(el('div', { class: 'tnow' }, el('span', { class: 'tspin', 'aria-hidden': 'true' }), el('span', { text: w.verb }), w.what ? el('b', { text: w.what, title: w.what }) : null));
    } else if (m.state === 'waiting' && m.wait) {
      item.appendChild(el('div', { class: 'tnow wait', text: String(m.wait).replace(/^Waiting · /, '') }));
    }
    if (m.question) item.appendChild(m.question);
    if (m.files.length) {
      item.appendChild(filesHeader(m));
      item.appendChild(filesList(c, m));
    }
    if (m.files.length > 3) {
      item.appendChild(el('button', { class: 'tall', type: 'button', 'data-act': 'files', text: c.open.files ? 'Show fewer' : 'Show all ' + m.files.length + ' files',
        on: { click: function () { c.open.files = !c.open.files; m.redraw(); } } }));
    }
    if (m.warn) item.appendChild(el('div', { class: 'twarn', role: 'note' }, tIcon('warn'), el('span', { text: m.warn })));
    if (m.note) item.appendChild(el('div', { class: 'tnote', text: m.note }));
    var reply = TASK_DONE[m.state] && !asks ? replyText(m.reply, m.title) : '';
    if (reply) item.appendChild(el('div', { class: 'trep' }, el('div', { class: 'lh2', text: 'Claude\'s reply' }), moreText('p', reply, c, 'reply', 'Claude\'s reply')));
    if (m.applied) item.appendChild(appliedLine(m));
    var foot = el('div', { class: 'tft' });
    if (m.effort) foot.appendChild(m.effort);
    foot.appendChild(el('span', { class: 'sp' }));
    (m.actions || []).forEach(function (b) { if (b) foot.appendChild(b); });
    if (foot.querySelector('button, a')) item.appendChild(foot);
  }
  // The rest of a text, clamped (two lines for the prompt, three for the reply), with More: in place,
  // or in a small sheet on a phone.
  function moreText(cls, text, c, key, title) {
    var box = el(cls === 'p' ? 'p' : 'div', { class: cls === 'p' ? (c.open[key] ? 'open' : null) : 'tp' + (c.open[key] ? ' open' : ''), text: text });
    var wrap = document.createDocumentFragment();
    wrap.appendChild(box);
    var more = el('button', { class: 'tmore', type: 'button', 'data-act': 'more-' + key, hidden: c.open[key] ? null : 'hidden', text: c.open[key] ? 'Less' : 'More' });
    more.addEventListener('click', function (e) {
      e.stopPropagation();
      if (isPhone() && !c.open[key]) return taskPop(more, 'more:' + key + ':' + c.item.getAttribute('data-task'), function () { return [el('div', { class: 'tsheet' }, el('b', { text: title }), el('p', { text: text }))]; });
      c.open[key] = !c.open[key];
      box.classList.toggle('open', c.open[key]);
      more.textContent = c.open[key] ? 'Less' : 'More';
    });
    wrap.appendChild(more);
    // More appears only when the text is cut: measured after drawing (a hidden panel estimates by length).
    requestAnimationFrame(function () {
      if (c.open[key] || !box.isConnected) return;
      var cut = box.clientHeight ? box.scrollHeight > box.clientHeight + 1 : text.length > (key === 'reply' ? 200 : 120) || text.split('\n').length > (key === 'reply' ? 3 : 2);
      more.hidden = !cut;
    });
    var holder = el('div', { class: 'tmw' });
    holder.appendChild(wrap);
    return holder;
  }
  // "Files · 5 · +71 −3", and on the right where they are (ⓘ: the full sentence).
  function filesHeader(m) {
    var total = filesTotal(m.files);
    var head = el('div', { class: 'tfh' }, el('span', { text: 'Files · ' + m.files.length }), total ? countsNode(total) : null);
    if (m.where) {
      var b = el('button', { class: 'twhere', type: 'button', 'data-act': 'where', 'aria-label': m.where.short + '. ' + m.where.full }, el('span', { text: m.where.short }), tIcon('info'));
      var build = function () { return [el('div', { class: 'tsheet' }, el('p', { text: m.where.full }))]; };
      bindHoverPop(b, build, 'where:' + m.id);
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        taskPop(b, 'where:' + m.id, build);
      });
      head.appendChild(b);
    }
    return head;
  }
  function filesList(c, m) {
    var list = el('ul', { class: 'tfiles' });
    var shown = c.open.files ? m.files : m.files.slice(0, 3);
    shown.forEach(function (f) { list.appendChild(el('li', null, changeLine(f, {}))); });
    if (c.open.files && m.earlier > 0) list.appendChild(el('li', { class: 'tless', text: m.earlier + (m.earlier === 1 ? ' earlier edit is' : ' earlier edits are') + ' not listed here.' }));
    return list;
  }
  // "✓ Added to your files" with Undo, after Claude added the task's changes.
  function appliedLine(m) {
    var a = m.applied;
    var where = a.how === 'merge' ? 'its project' : 'your files';
    if (a.undone) return el('div', { class: 'tapl undone' }, el('span', { text: a.how === 'merge' ? 'The merge was undone.' : 'Undone. Your files are as they were before.' }));
    var line = el('div', { class: 'tapl' }, tIcon('check'), el('span', { text: 'Added to ' + where }));
    if (a.canUndo) {
      var b = el('button', { class: 'tb q', type: 'button', 'data-act': 'undo-apply', text: 'Undo', title: a.how === 'merge' ? 'Remove the merged files from its project again (each only while it is as the merge left it)' : 'Put your files back as they were before (each only while it is as the apply left it)',
        on: { click: function (e) {
          e.stopPropagation();
          b.disabled = true;
          postJson('/remote/task/undo-apply', { page: PAGE_ID, task: m.id }).then(function (r) {
            var n = r && Array.isArray(r.undone) ? r.undone.length : 0;
            var kept = r && Array.isArray(r.kept) ? r.kept.length : 0;
            showToast(n ? 'Undone: ' + n + (n === 1 ? ' file is' : ' files are') + ' as before.' + (kept ? ' ' + kept + ' changed since, so kept.' : '') : 'Nothing to undo: the files changed since.', 6000);
          }).catch(function (err) {
            b.disabled = false;
            showToast('Could not undo: ' + err.message, 6000);
          });
        } } });
      line.appendChild(b);
    }
    return line;
  }
  // A plain label for a card that has no task yet (waiting to be sent, or it didn't start).
  function plainChip(who, mark) {
    return el('span', { class: 'achip sm', 'aria-label': '◆ ' + who + ' · Task' }, el('span', { class: 'am ' + mark, 'aria-hidden': 'true' }), el('span', { class: 'an', text: '◆ ' + who }), el('span', { class: 'aw', text: ' · Task' }));
  }

  // ---------- a task from a paired computer: its Claude asked Claude here ----------
  function onTask(ev) {
    var id = String(ev.taskId || '');
    if (!id) return;
    var c = taskCards[id];
    // New, or its card was removed from the feed: add a card at the bottom.
    if (!c || !c.item.isConnected) {
      c = taskCards[id] = { item: el('li', { class: 'k-task fresh' }), open: {}, userOpen: false, fresh: Date.now() - finiteNum(ev.startedAt) < 10000 };
      append(c.item, c.fresh);
    }
    c.ev = ev;
    renderTask(id);
  }
  function renderTask(id) {
    var c = taskCards[id];
    if (!c) return;
    var ev = c.ev;
    var st = String(ev.state || '');
    var perms = Array.isArray(ev.permissions) ? ev.permissions : [];
    var by = String(ev.by || 'Paired computer');
    var parts = promptParts(ev.prompt);
    // "◆ laptop · asked": who sent it (or the name given in Sessions, if any).
    var chip = agentChip('task:' + id, { small: true });
    if (!sessionName('task:' + id)) {
      chip.querySelector('.an').textContent = '◆ ' + by;
      var word = chip.querySelector('.aw') || chip.appendChild(el('span', { class: 'aw' }));
      word.textContent = ev.followUp ? ' · follow-up' : ' · asked';
    }
    var question = null;
    var actions = [];
    if (perms.length) {
      var p = perms[0];
      question = el('div', { class: 'tq', role: 'group', 'aria-label': 'Permission question' }, el('b', { text: p.title || p.tool || 'Permission' }),
        p.detail ? el('code', { text: p.detail, title: p.detail }) : null,
        p.warning ? el('div', { class: 'twarn' }, tIcon('warn'), el('span', { text: p.warning })) : null,
        perms.length > 1 ? el('div', { class: 'tqn', text: (perms.length - 1) + (perms.length === 2 ? ' more question' : ' more questions') + ' after this one.' }) : null);
      // Only the EditLens window can allow; the page can only deny.
      actions.push(el('button', { class: 'thint', type: 'button', 'data-act': 'answer', text: 'Allow in the EditLens window', title: 'Opens the EditLens window, where only you can allow it',
        on: { click: function () { openAnswerWindow('t:' + id + ':' + p.id); } } }));
      actions.push(sessionsButton('here'));
      var deny = el('button', { class: 'tb', type: 'button', 'data-act': 'deny', text: 'Deny', on: { click: function () {
        deny.disabled = true;
        postJson('/task/answer', { page: PAGE_ID, task: id, id: p.id, decision: 'deny' }).catch(function (err) {
          deny.disabled = false;
          showToast('Could not answer: ' + err.message, 6000);
        });
      } } });
      actions.push(deny);
    } else if (st !== 'refused') {
      actions.push(sessionsButton('here'));
      // A done task keeps its session for a follow-up; Stop ends it.
      if (TASK_LIVE[st] || st === 'idle') actions.push(stopButton('/task/stop', id, st === 'waiting'));
    }
    var ws = ev.kind === 'sent' ? 'sent' : ev.workspace ? 'copy' : 'shared';
    drawTaskCard(c, {
      id: id, state: st, asks: perms.length > 0, chip: chip, redraw: function () { renderTask(id); },
      status: perms.length ? 'Needs your answer' : TASK_STATES[st] || st, slots: slotsNode('here', ev.slots),
      at: TASK_RUNNING[st] || perms.length ? ev.startedAt : ev.ts,
      root: ev.asRoot === 'unsafe' ? 'Runs as root, because the Root (unsafe) setting is on here.' : ev.asRoot === 'root' ? 'Runs as root. For a normal account, type /editlens task-user in Claude Code here (once).' : null,
      title: parts.title, rest: parts.rest, step: ev.step, wait: st === 'waiting' ? ev.note : null,
      files: taskFiles(ev.edits, ws === 'sent' ? { task: { by: by } } : null), earlier: Math.max(0, posInt(ev.editCount) - (Array.isArray(ev.edits) ? ev.edits.length : 0)),
      where: ws === 'sent' ? { short: 'In its own copy', full: 'In a copy of ◆ ' + by + '\'s project, sent from there. Its changes are copied to the original project when Claude on ◆ ' + by + ' applies them.' }
        : ws === 'copy' ? { short: 'In its own copy', full: 'In its own copy of this project (' + ev.workspace + '). The changes are merged into this project when Claude on ◆ ' + by + ' merges them.' }
          : { short: 'In this project', full: 'In this project folder itself: it is not a git project, so the task has no copy.' },
      question: question, warn: ev.error || null, note: st === 'waiting' ? null : ev.note || null, reply: ev.lastReply,
      effort: st === 'refused' ? null : taskEffortChip(id, ev), actions: actions, applied: null,
    });
  }

  // ---------- a task this computer's Claude sent to a paired computer, updated live ----------
  // Its edits happen there (in a copy of this project, or that computer's own project). They are
  // in this project only after Claude here applies them, and then appear as edits.
  function onRemoteTask(ev) {
    var id = String(ev.taskId || '');
    if (!id) return;
    var c = remoteCards[id];
    if (!c || !c.item.isConnected) {
      c = remoteCards[id] = { item: el('li', { class: 'k-task fresh' }), open: {}, userOpen: false, fresh: Date.now() - finiteNum(ev.startedAt) < 10000 };
      append(c.item, c.fresh);
    }
    c.ev = ev; // for its label and details card
    var st = String(ev.state || '');
    var who = String(ev.computer || 'Paired computer');
    // Its row in the Agents switcher (added by its edits) stops its spinner when the task finishes.
    var rowKey = 'r:' + who + ':' + id;
    if (agents[rowKey] && !agents[rowKey].done && TASK_DONE[st]) {
      clearTimeout(remoteIdle[rowKey]);
      finishAgent({ toolUseId: rowKey, agentId: rowKey, status: st === 'failed' ? 'failed' : 'done', ts: Date.now() });
    }
    renderRemote(id);
    refreshAgentCard();
    swSoon();
  }
  function renderRemote(id) {
    var c = remoteCards[id];
    if (!c) return;
    var ev = c.ev;
    var st = String(ev.state || '');
    var who = String(ev.computer || 'Paired computer');
    var rowKey = 'r:' + who + ':' + id;
    var waiting = posInt(ev.waiting);
    var parts = promptParts(ev.prompt);
    var app = typeof ev.appUrl === 'string' && /^http:\/\/127\.0\.0\.1:\d{2,5}\/$/.test(ev.appUrl) ? ev.appUrl : null;
    // That computer lets this one answer its questions (its setting): its EditLens window, through the link.
    var answerAt = typeof ev.answerUrl === 'string' && /^http:\/\/127\.0\.0\.1:\d{2,5}\/answer$/.test(ev.answerUrl) ? ev.answerUrl : null;
    var files = taskFiles(ev.edits, { remote: { computer: who, kind: 'task', taskKind: ev.kind === 'sent' ? 'mine' : 'theirs', inCopy: ev.kind === 'copy' } });
    var applied = appliedByTask[id] || null;
    // The step it is on: from the task (EditLens 0.24.36 there), else its last edit here.
    var a = agents[rowKey];
    var step = ev.step || (a && !a.done && a.lastStep ? a.lastStep : null);
    var question = null;
    var actions = [];
    if (waiting) {
      var asked = Array.isArray(ev.waitingFor) ? ev.waitingFor.filter(Boolean).join(', ') : '';
      question = el('div', { class: 'tq', role: 'group', 'aria-label': 'Permission question' }, el('b', { text: asked || 'A permission question' }),
        el('div', { class: 'tqn', text: answerAt ? 'Asked on ◆ ' + who + '. ◆ ' + who + ' lets you answer it here, in its EditLens window.'
          : 'Asked on ◆ ' + who + '. Only someone there can answer it, in the EditLens window there.' }));
      if (answerAt) {
        actions.push(el('button', { class: 'mini allow', type: 'button', 'data-act': 'answer-here', text: 'Answer…', title: 'Opens ◆ ' + who + '\'s EditLens window, where only you can answer it',
          on: { click: function () { openWindowAt(answerAt, 'editlens-answer-' + who); } } }));
      } else actions.push(app ? el('a', { class: 'thint', href: app, target: '_blank', rel: 'noopener', 'data-act': 'answer-there', text: 'Answer on ◆ ' + who, title: 'Open ◆ ' + who + '\'s app in a new tab, through the pairing link' })
        : el('span', { class: 'thint', 'data-act': 'answer-there', text: 'Answer on ◆ ' + who, title: 'Only someone at ◆ ' + who + ' can answer it, in the EditLens window there' }));
    } else if (app) {
      actions.push(el('a', { class: 'tb q', href: app, target: '_blank', rel: 'noopener', 'data-act': 'app', text: 'Open app', title: 'Open ◆ ' + who + '\'s app in a new tab, through the pairing link' }));
    }
    actions.push(sessionsButton('r:' + who));
    // Stop: the same op Claude's stop tool sends to that computer.
    if (TASK_LIVE[st]) actions.push(stopButton('/remote/task/stop', id, st === 'waiting' && !waiting));
    else if (st === 'idle' && files.length && !(applied && !applied.undone)) {
      // Review changes: there is no review view, so open the task's files in the code view and follow it.
      actions.push(el('button', { class: 'tb p', type: 'button', 'data-act': 'review', text: 'Review changes', title: 'Open its files in the code view, following this task',
        on: { click: function () {
          sw.active = rowKey;
          setFollow(rowKey, true);
        } } }));
    }
    drawTaskCard(c, {
      id: id, state: st, asks: waiting > 0, chip: agentChip(rowKey, { small: true }), redraw: function () { renderRemote(id); },
      status: waiting ? 'Needs your answer' : TASK_STATES[st] || st, slots: slotsNode(who, ev.slots),
      at: TASK_RUNNING[st] || waiting ? ev.startedAt : ev.ts,
      root: ev.asRoot === 'unsafe' ? 'Runs as root on ◆ ' + who + ', because the Root (unsafe) setting is on there.'
        : ev.asRoot === 'root' ? 'Runs as root. For a normal account, type /editlens task-user in Claude Code on ◆ ' + who + ' (once).' : null,
      title: parts.title, rest: parts.rest, step: step, wait: st === 'waiting' ? ev.note : null,
      files: files, earlier: Math.max(0, posInt(ev.editCount) - (Array.isArray(ev.edits) ? ev.edits.length : 0)),
      // Same wording as each edit's card (placeNote): where the files are, and when they arrive here.
      where: ev.kind === 'sent' ? { short: 'In a copy · not in your files yet', full: 'On ◆ ' + who + ', in a copy of this project. Not in your files yet: Claude adds them when the task is done.' }
        : ev.kind === 'copy' ? { short: 'In a copy of its project', full: 'On ◆ ' + who + ', in a copy of its project. Not in its project yet: Claude merges them when the task is done (or Merge on its page).' }
          : { short: 'In its project', full: 'On ◆ ' + who + ', in its project.' },
      question: question, warn: ev.error || null, note: st === 'waiting' ? null : ev.note || null, reply: ev.lastReply,
      effort: st === 'refused' ? null : remoteEffortChip(id, ev), actions: actions, applied: applied,
    });
  }
  // Claude here added (or removed) a task's changes: the card says so, with Undo.
  function onTaskApplied(ev) {
    var id = String(ev.taskId || '');
    if (!/^[0-9a-f]{12}$/.test(id)) return;
    delete appliedByTask[id]; // set again at the end, as the newest
    appliedByTask[id] = { how: ev.how === 'merge' ? 'merge' : 'apply', count: posInt(ev.count), undone: Boolean(ev.undone), canUndo: Boolean(ev.canUndo) };
    var waiting = Object.keys(appliedByTask).filter(function (k) { return !remoteCards[k]; });
    waiting.slice(0, Math.max(0, waiting.length - APPLIED_WAIT_MAX)).forEach(function (k) { delete appliedByTask[k]; });
    if (remoteCards[id] && remoteCards[id].ev) renderRemote(id);
  }

  // A task for a paired computer that is waiting to be sent, or did not start. This card is replaced
  // by the task's own card once the task starts.
  function onTaskNotice(ev) {
    var key = String(ev.sessionId || '');
    if (!key) return;
    var c = noticeCards[key];
    if (ev.state === 'cleared') {
      if (c) c.item.remove();
      delete noticeCards[key];
      return;
    }
    if (!c || !c.item.isConnected) {
      c = noticeCards[key] = { item: el('li', { class: 'k-task fresh' }), open: {}, userOpen: false, fresh: Date.now() - finiteNum(ev.ts) < 10000 };
      append(c.item, c.fresh);
    }
    c.ev = ev;
    renderNotice(key);
  }
  function renderNotice(key) {
    var c = noticeCards[key];
    if (!c) return;
    var ev = c.ev;
    var refused = ev.state === 'refused';
    var who = String(ev.computer || 'Paired computer');
    var parts = promptParts(ev.prompt);
    var actions = [];
    // Try again: the page never messages Claude by itself, so it puts the request in the message box
    // (or copies it, when this page can't message Claude) for the user to send.
    if (refused) {
      actions.push(el('button', { class: 'tb', type: 'button', 'data-act': 'retry', text: 'Try again', title: 'Puts a request to start it again in the message box. Nothing is sent until you send it.',
        on: { click: function () { askAgain(who, parts.title || String(ev.prompt || ''), Boolean(ev.followUp)); } } }));
    }
    drawTaskCard(c, {
      id: key, state: refused ? 'refused' : 'waiting', asks: false, chip: plainChip(who, refused ? 'bad' : 'ask'), redraw: function () { renderNotice(key); },
      status: refused ? 'Didn\'t start' : 'Waiting', slots: null, at: ev.ts, root: null,
      title: parts.title || (ev.followUp ? 'Follow-up' : 'Task'), rest: parts.rest, step: null, wait: refused ? null : ev.text,
      files: [], earlier: 0, where: null, question: null, warn: refused ? String(ev.why || ev.text || '').replace(/^Didn't start · /, '') : null, note: null, reply: '',
      effort: null, actions: actions, applied: null,
    });
  }
  function askAgain(who, title, followUp) {
    var text = (followUp ? 'Send the follow-up to ◆ ' : 'Start the task on ◆ ') + who + ' again: ' + title;
    if (messageBlocked()) return copyText(text, 'Copied. Paste it into Claude Code to try again.');
    if (state.panel !== 'open') setPanel('open');
    input.value = text;
    input.dispatchEvent(new Event('input'));
    input.focus();
    showToast('Press Enter to send it to Claude.');
  }
