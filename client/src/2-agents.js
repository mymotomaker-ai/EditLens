  // Part of the page script: client/src files are joined in order (lib/client-script.js) and share
  // the scope opened in 1-panel.js.
  // ---------- agent chips, their details card, and the Changes row (handoff 12 and 14) ----------
  // A chip wherever the page names an agent: status mark, short name, at most one dim word, never an id.
  // Hover (300 ms) or focus opens the details card (a tap on touch screens opens it as a bottom sheet).
  // The card says where the agent runs and with what model and settings.
  styleEl.textContent += [
    '.achip{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0;padding:4px 10px;border:0;border-radius:99px;background:var(--fill);color:var(--fg);',
    'font:500 12px/1.3 var(--sans);white-space:nowrap;cursor:pointer;text-align:left;vertical-align:middle}',
    'button.achip:hover{background:var(--fill2)}.achip.on{box-shadow:0 0 0 1.5px var(--accent)}',
    '.achip .an{overflow:hidden;text-overflow:ellipsis;min-width:0}.achip .aw{flex:none;color:var(--muted)}',
    '.achip.sm{padding:1px 7px;gap:5px;font-size:11px}.achip.bare{padding:0;background:transparent}',
    '.am{flex:none;display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--add)}',
    '.am.sub{background:var(--ac,var(--agent))}.am.ask{background:var(--warn)}',
    '.am.spin{width:8px;height:8px;background:none;border:1.5px solid var(--fill2);border-top-color:var(--accent);animation:spin .9s linear infinite}',
    '.achip.sm .am{width:6px;height:6px}.achip.sm .am.spin{width:7px;height:7px}',
    // In the Follow row and the code view header the label keeps the row's own button size.
    '.fchip.achip{border:0;background:var(--fill);color:var(--fg);padding:4px 10px;gap:6px;font:500 12px/1.3 var(--sans)}.fchip.achip:hover{background:var(--fill2)}',
    '.fchip.achip.on{background:var(--fill);font-weight:500;box-shadow:0 0 0 1.5px var(--accent)}.fchip.achip .an{white-space:nowrap}',
    '.pinfo .who .achip{font-weight:500;max-width:100%}',
    // The details card: a popover beside the chip, or a bottom sheet on a touch screen.
    '.acard{position:fixed;z-index:9;width:300px;max-width:calc(100vw - 16px);padding:6px;pointer-events:auto;background:var(--glass);-webkit-backdrop-filter:blur(24px) saturate(1.4);',
    'backdrop-filter:blur(24px) saturate(1.4);color:var(--fg);border-radius:14px;box-shadow:var(--shadow);font:400 13px/1.45 var(--sans);-webkit-font-smoothing:antialiased;animation:pop .15s ease-out}',
    '.acard .ah{display:flex;gap:10px;align-items:flex-start;padding:8px 8px 10px}.acard .ah>div{flex:1;min-width:0}',
    '.acard .ah b{display:block;font-weight:600;font-size:13.5px;letter-spacing:-.01em;overflow-wrap:anywhere}',
    '.acard .ast{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted)}',
    '.abdg{flex:none;width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:var(--fill);color:var(--fg);font:600 12px/1 var(--sans)}',
    '.abdg.sub{background:color-mix(in srgb,var(--ac,var(--agent)) 15%,transparent);color:var(--ac,var(--agent))}.abdg.main{background:var(--accent-soft);color:var(--accent)}',
    '.akv{display:grid;grid-template-columns:84px minmax(0,1fr);gap:5px 10px;padding:8px 10px;margin:0 2px 4px;border-radius:10px;background:var(--fill);font-size:12px}',
    '.akv>span{min-width:0;overflow-wrap:anywhere}.akv>.al{color:var(--muted)}.akv .k{color:var(--muted)}',
    '.lv{display:inline-flex;align-items:flex-end;gap:1.5px;height:10px;margin-right:5px;vertical-align:-1px}',
    '.lv i{width:2.5px;border-radius:1px;background:var(--fill2)}.lv i:nth-child(1){height:4px}.lv i:nth-child(2){height:5.5px}.lv i:nth-child(3){height:7px}.lv i:nth-child(4){height:8.5px}.lv i:nth-child(5){height:10px}',
    '.lv i.on{background:currentColor}',
    '.aacts{display:flex;justify-content:flex-end;gap:6px;padding:4px 8px 6px}',
    '.aacts button{padding:4px 10px;border:0;border-radius:7px;background:var(--fill2);color:var(--fg);font:500 12px/1.3 var(--sans);cursor:pointer}',
    '.aacts button:hover{background:color-mix(in srgb,var(--fg) 12%,transparent)}.aacts button.q{background:transparent;color:var(--muted)}.aacts button.q:hover{color:var(--fg)}',
    '.aacts button.warn{color:var(--del)}.aacts button[aria-pressed=true]{background:var(--accent-soft);color:var(--accent-ink)}',
    '.acard.sheet{left:0!important;right:0;top:auto!important;bottom:0;width:auto;max-width:none;max-height:80vh;overflow:auto;border-radius:18px 18px 0 0;padding:4px 10px 14px;',
    'box-shadow:0 -8px 24px rgba(0,0,0,.18),0 0 0 .5px var(--line);animation:rise .2s ease-out}',
    '.acard .grab{width:36px;height:5px;border-radius:3px;background:var(--fill2);margin:5px auto 4px}.acard:not(.sheet) .grab{display:none}',
    '.ascrim{position:fixed;inset:0;z-index:9;pointer-events:auto;background:rgba(0,0,0,.18)}',
    // The Agents tab: one row per agent, the chip and what it is doing now.
    '.agents{flex-direction:column;flex-wrap:nowrap;align-items:stretch}.agents .swopen{align-self:flex-start}.agents .abtns{display:flex;flex-wrap:wrap;gap:6px}',
    '.alist{display:flex;flex-direction:column;padding:4px;border-radius:12px;background:var(--raise);box-shadow:0 0 0 .5px var(--line)}',
    '.agrow{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:6px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}',
    '.agrow:hover,.agrow.on{background:var(--fill)}.agrow .achip{background:transparent;padding:0;flex:0 1 auto}',
    '.agrow .ars{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:12px}',
    // The Changes row: line 1 the marker, file, folder (cut from the left) and counts; line 2 the
    // agent and the time.
    '.cno{flex:none;width:16px;height:16px;border-radius:50%;display:grid;place-items:center;background:var(--accent);color:#fff;font:600 9px/1 var(--sans)}',
    '.cno.seen{background:transparent;color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}',
    '.c1{display:flex;align-items:center;gap:7px;min-width:0;white-space:nowrap;font-size:12.5px}',
    '.c1 .f{flex:none;font:600 12.5px/1.3 var(--sans);overflow-wrap:normal}',
    '.c1 .cf{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;color:var(--faint)}',
    '.c1 .cnt{flex:none;margin-left:auto;font:11.5px/1.3 var(--mono);color:var(--muted)}.c1 .cnt .a{color:var(--add)}.c1 .cnt .d{color:var(--del)}',
    '.c2{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin:3px 0 0 23px;font-size:11px;color:var(--muted)}',
    '.chlist .chr{display:block;padding:7px 8px;border-radius:8px;cursor:pointer}.chlist .chr+.chr{border-top:.5px solid var(--line);border-radius:0}',
    '.chlist .chr:hover{background:var(--fill)}.chlist .chr.on{background:var(--sel-soft);box-shadow:inset 3px 0 0 var(--sel)}',
    '.chlist .chr>.chi{display:block;width:100%;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}',
    '.chlist .chr>.chi:hover{background:none}.chlist .chr .w{display:block;margin:2px 0 0 23px;font-size:.84em;color:var(--muted);overflow-wrap:anywhere}',
    '.chlist .chr .c2 .chrst{margin:0 0 0 auto;font-size:11px}.chlist .chi .c1 .f{font:600 12.5px/1.3 var(--sans);overflow-wrap:normal}',
    '.chlist .chr .c2>.k:empty{display:none}.chlist .chr .c1+.w{margin-top:3px}',
    '.tedits.rows{margin:.4em 0 0;padding:4px;list-style:none;border-radius:10px;background:var(--sunk);font-size:1em}',
    '.tedits.rows li{padding:6px;overflow-wrap:normal}.tedits.rows li+li{border-top:.5px solid var(--line)}',
    '.tedits.rows .c2{margin-left:0}.tedits.rows .c2 .why{margin:0;font-size:inherit;color:var(--muted)}',
    // The full path on hover over a file name.
    '.fpop{width:300px;padding:10px 12px;font-size:12px}.fpop .fp{font:500 11.5px/1.45 var(--mono);word-break:break-all}',
    '.fpop .fw{margin-top:6px;color:var(--muted)}.fpop .ff{margin-top:6px;font:11px/1.45 var(--mono);color:var(--muted);opacity:.8;word-break:break-all}',
    '.ewho{display:flex;align-items:center;gap:8px;margin-top:4px;font-size:11px;color:var(--muted)}',
  ].join('');

  var EFFORT_NAMES = dict({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' });
  var EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
  var CARD_OPEN_MS = 300;
  var CARD_CLOSE_MS = 200;
  var agentCard = { node: null, scrim: null, key: null, anchor: null, timer: 0, closer: 0, sheet: false, stopAsk: false, build: null, onKey: null, refocus: false };
  var lastPointer = 'mouse';

  // A paired computer's row: 'r:<computer>:<task id>' (one task) or 'r:<computer>:sessions'.
  function remoteKeyOf(k) {
    var m = /^r:(.+):([0-9a-f]{12}|sessions)$/.exec(String(k || ''));
    return m ? { computer: m[1], task: m[2] === 'sessions' ? null : m[2] } : null;
  }
  // A task a paired computer gave Claude here: 'task:<id>'.
  function hereTaskOf(k) {
    var m = /^task:(.+)$/.exec(String(k || ''));
    var c = m ? taskCards[m[1]] : null;
    return c && c.ev ? c.ev : null;
  }
  function agentKind(k) {
    if (k === 'main') return 'main';
    if (/^task:/.test(String(k))) return 'here';
    var r = remoteKeyOf(k);
    if (r) return r.task ? 'task' : 'sessions';
    return 'sub';
  }
  function firstLine(text, max) {
    var line = String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean)[0] || '';
    return line.length > (max || 80) ? line.slice(0, (max || 80) - 1) + '…' : line;
  }
  // { name, word }: what the chip says. Never an id, never "copy of this project".
  function agentName(k) {
    var kind = agentKind(k);
    // A name given in the Sessions list (handoff 13.2) is used everywhere; a task on a paired
    // computer keeps the computer as its dim word.
    var given = sessionName(k);
    if (given) return { name: given, word: kind === 'task' ? '◆ ' + remoteKeyOf(k).computer : '' };
    if (kind === 'main') return { name: 'Main', word: '' };
    if (kind === 'here') {
      var t = hereTaskOf(k);
      return { name: 'Task from ◆ ' + (t && t.by ? t.by : 'a paired computer'), word: '' };
    }
    var r = remoteKeyOf(k);
    if (r) return { name: '◆ ' + r.computer, word: r.task ? 'Task' : '' };
    var a = agents[k];
    if (a && a.desc && a.desc !== 'Subagent') return { name: a.desc, word: '' };
    return { name: (a && a.type) || 'Subagent', word: '' };
  }
  function remoteTaskEv(k) {
    var r = remoteKeyOf(k);
    var c = r && r.task ? remoteCards[r.task] : null;
    return c && c.ev ? c.ev : null;
  }
  // Edits made until now, from the cards the page has (a task's own count when it has one).
  function agentEditCount(k) {
    var t = agentKind(k) === 'here' ? hereTaskOf(k) : remoteTaskEv(k);
    if (t && Number.isFinite(Number(t.editCount)) && Number(t.editCount) >= 0) return Number(t.editCount);
    var e = agentEdits(k);
    var total = Object.keys(e).reduce(function (s, f) { return s + posInt(e[f]); }, 0);
    return Number.isSafeInteger(total) ? total : 0;
  }
  var TASK_WORKING = dict({ starting: 1, working: 1 });
  // { mark: spin | ask | ok | sub, text }: the status mark and words.
  function agentStatus(k) {
    var kind = agentKind(k);
    var a = agents[k];
    if (kind === 'here' || kind === 'task') {
      var t = kind === 'here' ? hereTaskOf(k) : remoteTaskEv(k);
      if (t) {
        var st = String(t.state || '');
        var asks = kind === 'here' ? (Array.isArray(t.permissions) ? t.permissions.length : 0) : posInt(t.waiting);
        if (asks) return { mark: 'ask', text: kind === 'here' ? 'Needs your answer' : 'Needs your answer there' };
        if (TASK_WORKING[st]) return { mark: 'spin', text: st === 'starting' ? 'Starting' : 'Working' };
        if (st === 'waiting') return { mark: 'ok', text: 'Waiting' };
        return { mark: 'ok', text: TASK_STATES[st] || 'Done' };
      }
    }
    var s = swStatus(k === 'main' || a ? k : 'main');
    if (k !== 'main' && !a) return { mark: kind === 'sub' ? 'sub' : 'ok', text: 'Done' };
    if (s.cls === 'wait') return { mark: 'ask', text: 'Needs your answer' };
    if (s.text === 'Working') return { mark: 'spin', text: kind === 'sessions' ? 'Editing' : 'Working' };
    return { mark: kind === 'sub' ? 'sub' : 'ok', text: kind === 'sessions' && s.text === 'Done' ? 'Idle' : s.text };
  }
  // "14 s", "6 min", "1 h 5 min".
  function spanWords(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + ' s';
    var m = Math.round(s / 60);
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  }
  function agoWords(ts) {
    var t = Number(ts);
    if (!Number.isFinite(t) || t <= 0) return '';
    var ms = Date.now() - t;
    return ms < 10000 ? 'just now' : spanWords(ms) + ' ago';
  }
  function agentStarted(k) {
    var kind = agentKind(k);
    var t = kind === 'here' ? hereTaskOf(k) : kind === 'task' ? remoteTaskEv(k) : null;
    var at = t ? Number(t.startedAt) : kind === 'main' ? mainInfo.start : agents[k] ? swStarted(agents[k]) : 0;
    return Number.isFinite(at) && at > 0 ? at : 0;
  }
  // "Working · 3 edits made", "Done · 14 s".
  function agentStatusLine(k) {
    var st = agentStatus(k);
    var n = agentEditCount(k);
    var edits = n ? n + (n === 1 ? ' edit' : ' edits') : '';
    if (st.mark === 'spin') return st.text + (edits ? ' · ' + edits + ' made' : '');
    var a = agents[k];
    var took = a && a.done && a.ended && swStarted(a) ? spanWords(a.ended - swStarted(a)) : '';
    return [st.text, took, edits].filter(Boolean).join(' · ');
  }
  function cardEffortMeter(level) {
    var at = EFFORT_ORDER.indexOf(level) + 1;
    var m = el('span', { class: 'lv', 'aria-hidden': 'true' });
    for (var i = 1; i <= 5; i++) m.appendChild(el('i', { class: i <= at ? 'on' : null }));
    return m;
  }
  // The effort fields EditLens reads: { level, used, supported, cap, source }, or { inherited: true }.
  function mainEffort() {
    // Under page control: its own level (25-effort.js keeps it); else what Claude Code reports
    // (the usage figures name the level only, as a string).
    if (drive.active && effortState.page) return effortState.page;
    return effortState.terminal || (usage && typeof usage.effort === 'string' ? effortOf({ level: usage.effort }) : null);
  }
  // [nodes] for the Effort row, or null when nothing is known.
  function effortValue(e, inherited) {
    if (inherited) {
      var m = mainEffort();
      var lv0 = m && (EFFORT_NAMES[m.used] ? m.used : EFFORT_NAMES[m.level] ? m.level : null);
      return lv0 && m.supported !== false ? [cardEffortMeter(lv0), document.createTextNode(EFFORT_NAMES[lv0]), el('span', { class: 'k', text: ' · same as Main' })]
        : [document.createTextNode('Same as Main')];
    }
    if (!e || typeof e !== 'object') return null;
    if (e.supported === false) return [document.createTextNode('Effort not used')];
    var lv = EFFORT_NAMES[e.used] ? e.used : EFFORT_NAMES[e.level] ? e.level : null;
    return lv ? [cardEffortMeter(lv), document.createTextNode(EFFORT_NAMES[lv])] : null;
  }
  // "Opus 5.5 · 1M context".
  function cardModel(m) {
    if (typeof m !== 'string' || !m) return null;
    return modelLabel({ model: m }).replace(/ \(1M\)$/, ' · 1M context');
  }
  // Everything the card shows, built again each time it opens or refreshes.
  function agentInfo(k) {
    var kind = agentKind(k);
    var a = agents[k];
    var nm = agentName(k);
    var st = agentStatus(k);
    var rows = [];
    var row = function (label, value, note) { if (value) rows.push([label, value, note || '']); };
    var t = kind === 'here' ? hereTaskOf(k) : kind === 'task' ? remoteTaskEv(k) : null;
    var r = remoteKeyOf(k);
    var title = nm.name;
    var given = sessionName(k);
    var badge = '✦';
    if (kind === 'main') {
      row('Computer', 'This computer');
      row('Agent', 'Your session');
      row('Edits go to', 'This project');
      row('Model', agentModel('main'));
      row('Effort', effortValue(mainEffort(), false));
      row('Mode', modeLabel(mainMode()));
    } else if (kind === 'sub') {
      badge = 'A';
      title = a && a.desc && a.desc !== 'Subagent' ? a.desc : (a && a.prompt ? firstLine(a.prompt) : nm.name);
      row('Computer', 'This computer');
      row('Agent', 'Subagent', a && a.type ? '· ' + a.type : '');
      row('Edits go to', a && Object.keys(a.files || {}).length && copyCardOf(a) ? 'Its own copy of this project' : 'This project');
      row('Model', a ? agentModel(k) : null);
      row('Effort', effortValue(a && a.effort, !(a && a.effort && !a.effort.inherited)));
      row('Mode', a ? modeLabel(agentModeOf(k).mode) : null);
    } else if (kind === 'here') {
      badge = '◆';
      title = t ? firstLine(t.prompt) || nm.name : nm.name;
      row('Computer', 'This computer');
      row('Agent', 'Task from ◆ ' + (t && t.by ? t.by : 'a paired computer'));
      row('Edits go to', t && t.kind === 'sent' ? 'A copy of ◆ ' + t.by + '\'s project' : t && t.workspace ? 'A copy of this project' : 'This project');
      row('Model', cardModel(t && t.model));
      row('Effort', effortValue(t && t.effort, false));
      row('Mode', t ? modeLabel(t.mode) : null);
    } else {
      badge = '◆';
      var prompt = t ? t.prompt : a ? a.prompt : '';
      title = r.task ? firstLine(prompt) || 'Task on ◆ ' + r.computer : 'Claude Code on ◆ ' + r.computer;
      row('Computer', r.computer, t && t.login ? '· ' + t.login : '');
      row('Agent', r.task ? 'Task you started from this page' : 'Claude Code sessions there');
      var mine = t ? t.kind === 'sent' : a && a.taskKind === 'mine';
      row('Edits go to', r.task ? (mine ? 'A copy of this project' : 'Its own project') : 'Its own project');
      row('Model', cardModel(t && t.model));
      row('Effort', effortValue(t && t.effort, false));
      row('Mode', t ? modeLabel(t.mode) : null);
    }
    // Its given name is the card's title (what it does is in Doing for tasks).
    if (given) {
      if (kind === 'here' || kind === 'task') rows.unshift(['Doing', t ? firstLine(t.prompt) || '—' : '—', '']);
      title = given;
    }
    var started = agentStarted(k);
    if (started) row('Started', clock(started), '· ' + agoWords(started));
    var running = st.mark === 'spin' || st.mark === 'ask' || st.text === 'Waiting';
    var stop = null;
    if (running && kind === 'sub' && a && !a.done && !a.remote && driving()) {
      stop = function () { return driveRequest('/drive/stop-agent', { agent: a.agentId || a.key }); };
    } else if (running && kind === 'here' && t) {
      stop = function () { return postJson('/task/stop', { page: PAGE_ID, task: t.taskId }); };
    } else if (running && kind === 'task' && r && r.task) {
      stop = function () { return postJson('/remote/task/stop', { page: PAGE_ID, task: r.task }); };
    }
    return { key: k, kind: kind, name: nm.name, word: nm.word, mark: st.mark, status: agentStatusLine(k), badge: badge, title: title, rows: rows,
      stop: stop, follow: kind !== 'here', color: kind === 'sub' ? ownerColor(k) : null };
  }
  // The copy card this subagent finished in, if any (its edits went to its own copy).
  function copyCardOf(a) {
    var id = a && a.agentId;
    if (!id) return null;
    for (var key in copyCards) if (copyCards[key].ev && copyCards[key].ev.agentId === id) return copyCards[key];
    return null;
  }

  // The chip's own parts: mark, name, dim word.
  function chipParts(k, small) {
    var nm = agentName(k);
    var st = agentStatus(k);
    var mark = el('span', { class: 'am ' + st.mark, 'aria-hidden': 'true' });
    if (agentKind(k) === 'sub') mark.style.setProperty('--ac', ownerColor(k));
    var out = [mark, el('span', { class: 'an', text: nm.name })];
    if (nm.word) out.push(el('span', { class: 'aw', text: ' · ' + nm.word })); // keeps textContent readable
    if (small) mark.setAttribute('data-sm', '1');
    return out;
  }
  function chipLabel(k) {
    var nm = agentName(k);
    return nm.name + (nm.word ? ' · ' + nm.word : '') + ', ' + agentStatus(k).text;
  }
  // A chip as a button: hover or focus opens the details card; click does onClick (or opens the card).
  function agentChip(k, opts) {
    var o = opts || {};
    var b = el(o.tag || 'button', { class: 'achip' + (o.small ? ' sm' : '') + (follow.mode === k ? ' on' : ''), 'data-key': k, 'aria-label': chipLabel(k) });
    if ((o.tag || 'button') === 'button') b.setAttribute('type', 'button');
    chipParts(k, o.small).forEach(function (p) { b.appendChild(p); });
    if (o.tag !== 'span') bindAgentCard(b, k, o.onClick);
    return b;
  }
  // Hover (after CARD_OPEN_MS), keyboard focus, and a tap on a touch screen open the card for k.
  // onClick: what a click does with a mouse (null: it opens the card).
  function bindAgentCard(node, k, onClick) {
    bindHoverPop(node, function () { return agentCardBody(k); }, k);
    node.addEventListener('click', function (e) {
      if (lastPointer === 'touch') {
        e.preventDefault();
        e.stopImmediatePropagation();
        showPop(node, function () { return agentCardBody(k); }, k, true);
        return;
      }
      if (onClick) return onClick(e);
      e.stopPropagation();
      showPop(node, function () { return agentCardBody(k); }, k, false);
    }, true);
  }
  function bindHoverPop(node, build, key) {
    node.addEventListener('pointerdown', function (e) { lastPointer = e.pointerType || 'mouse'; }, true);
    node.addEventListener('pointerenter', function (e) {
      if (e.pointerType === 'touch') return;
      lastPointer = e.pointerType || 'mouse';
      clearTimeout(agentCard.closer);
      if (agentCard.node && agentCard.key === key && !agentCard.sheet) {
        agentCard.anchor = node;
        return;
      }
      clearTimeout(agentCard.timer);
      agentCard.timer = setTimeout(function () { if (node.isConnected) showPop(node, build, key, false); }, CARD_OPEN_MS);
    });
    node.addEventListener('pointerleave', function () {
      clearTimeout(agentCard.timer);
      closePopSoon();
    });
    node.addEventListener('focus', function () {
      // Keyboard focus only: a click focuses too, and a click has its own action.
      var ok = true;
      try {
        ok = node.matches(':focus-visible');
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err; // a browser without :focus-visible
      }
      if (ok && lastPointer !== 'touch' && !agentCard.refocus) showPop(node, build, key, false);
    });
    node.addEventListener('blur', function (e) {
      if (agentCard.node && e.relatedTarget && agentCard.node.contains(e.relatedTarget)) return;
      if (agentCard.anchor === node && !agentCard.sheet) closePopSoon();
    });
  }
  function closePopSoon() {
    clearTimeout(agentCard.closer);
    if (!agentCard.node || agentCard.sheet) return;
    agentCard.closer = setTimeout(closePop, CARD_CLOSE_MS);
  }
  function closePop(back) {
    clearTimeout(agentCard.timer);
    clearTimeout(agentCard.closer);
    var anchor = agentCard.anchor;
    if (agentCard.node) agentCard.node.remove();
    if (agentCard.scrim) agentCard.scrim.remove();
    if (agentCard.onKey) agentCard.onKey.doc.removeEventListener('keydown', agentCard.onKey.fn, true);
    agentCard.node = agentCard.scrim = agentCard.key = agentCard.anchor = agentCard.build = agentCard.onKey = null;
    agentCard.sheet = false;
    agentCard.stopAsk = false;
    if (back && anchor && anchor.isConnected) {
      // Focus returns to its label after Esc, without opening the card again.
      agentCard.refocus = true;
      anchor.focus({ preventScroll: true });
      agentCard.refocus = false;
    }
  }
  // Opens (or moves) the one popover: next to anchor, or as a bottom sheet.
  function showPop(anchor, build, key, sheet) {
    clearTimeout(agentCard.timer);
    clearTimeout(agentCard.closer);
    if (agentCard.node && agentCard.key === key && agentCard.sheet === sheet && agentCard.anchor === anchor) return;
    closePop(false);
    var host = menuHost(anchor);
    var doc = anchor.ownerDocument;
    var card = el('div', { class: 'acard' + (sheet ? ' sheet' : ''), role: 'dialog', 'aria-label': 'Details', tabindex: '-1' });
    agentCard.node = card;
    agentCard.key = key;
    agentCard.anchor = anchor;
    agentCard.sheet = sheet;
    agentCard.build = build;
    fillPop();
    card.addEventListener('pointerenter', function () { clearTimeout(agentCard.closer); });
    card.addEventListener('pointerleave', function () { closePopSoon(); });
    card.addEventListener('focusout', function (e) {
      if (sheet || (e.relatedTarget && (card.contains(e.relatedTarget) || e.relatedTarget === anchor))) return;
      closePopSoon();
    });
    if (sheet) {
      agentCard.scrim = el('div', { class: 'ascrim', on: { click: function () { closePop(false); } } });
      host.appendChild(agentCard.scrim);
    }
    host.appendChild(card);
    var fn = function (e) {
      if (e.key !== 'Escape' || !agentCard.node) return;
      e.preventDefault();
      e.stopPropagation();
      closePop(true);
    };
    doc.addEventListener('keydown', fn, true);
    agentCard.onKey = { doc: doc, fn: fn };
    placePop();
    if (sheet) card.focus({ preventScroll: true });
  }
  function fillPop() {
    var card = agentCard.node;
    if (!card || !agentCard.build) return;
    var focused = card.getRootNode().activeElement;
    var refocus = focused && card.contains(focused) ? focused.getAttribute('data-act') : null;
    card.replaceChildren.apply(card, [el('div', { class: 'grab', 'aria-hidden': 'true' })].concat(agentCard.build()));
    if (refocus) {
      var again = card.querySelector('[data-act="' + refocus + '"]');
      if (again) again.focus({ preventScroll: true });
    }
  }
  function placePop() {
    var card = agentCard.node;
    var anchor = agentCard.anchor;
    if (!card || !anchor || agentCard.sheet) return;
    var view = anchor.ownerDocument.defaultView;
    var b = anchor.getBoundingClientRect();
    var w = card.offsetWidth;
    var h = card.offsetHeight;
    var below = view.innerHeight - b.bottom - 8;
    card.style.left = Math.round(clamp(b.left, 8, Math.max(8, view.innerWidth - w - 8))) + 'px';
    card.style.top = Math.round(below >= h + 6 || b.top < h + 14 ? Math.min(b.bottom + 6, Math.max(8, view.innerHeight - h - 8)) : b.top - h - 6) + 'px';
  }
  // While open, the card updates with the agent (status, edits, buttons).
  function refreshAgentCard() {
    if (!agentCard.node || !agentCard.key || agentCard.key.indexOf('file:') === 0) return;
    if (!agentCard.anchor || !agentCard.anchor.isConnected) {
      // The chip was drawn again: the card moves to the new one, or closes when there is none.
      var host = agentCard.node.getRootNode();
      var again = host.querySelector ? host.querySelector('[data-key="' + cssEscape(agentCard.key) + '"]') : null;
      if (!again && !agentCard.sheet) return closePop(false);
      if (again) agentCard.anchor = again;
    }
    fillPop();
    placePop();
  }

  // The card for agent k: header, rows, Follow and Stop.
  function agentCardBody(k) {
    var info = agentInfo(k);
    var badge = el('span', { class: 'abdg' + (info.kind === 'sub' ? ' sub' : info.kind === 'main' ? ' main' : ''), 'aria-hidden': 'true', text: info.badge });
    if (info.color) badge.style.setProperty('--ac', info.color);
    var mark = el('span', { class: 'am ' + info.mark, 'aria-hidden': 'true' });
    if (info.color) mark.style.setProperty('--ac', info.color);
    var head = el('div', { class: 'ah' }, badge, el('div', null, el('b', { text: info.title }), el('div', { class: 'ast' }, mark, el('span', { text: info.status }))));
    var kv = el('div', { class: 'akv' });
    info.rows.forEach(function (r) {
      kv.appendChild(el('span', { class: 'al', text: r[0] }));
      var v = el('span', { class: 'av', 'data-row': r[0] });
      if (Array.isArray(r[1])) r[1].forEach(function (n) { v.appendChild(n); });
      else v.appendChild(document.createTextNode(String(r[1])));
      if (r[2]) v.appendChild(el('span', { class: 'k', text: ' ' + r[2] }));
      kv.appendChild(v);
    });
    var acts = el('div', { class: 'aacts' });
    if (info.stop) {
      var asking = agentCard.stopAsk && agentCard.key === k;
      acts.appendChild(el('button', { type: 'button', class: 'q' + (asking ? ' warn' : ''), 'data-act': 'stop', text: asking ? 'Stop it?' : 'Stop',
        title: asking ? 'Click again to stop it' : info.kind === 'sub' ? 'Stop this subagent only; Claude continues with the rest' : 'Stop this task',
        on: { click: function (e) {
          e.stopPropagation();
          if (!agentCard.stopAsk) {
            agentCard.stopAsk = true;
            fillPop();
            setTimeout(function () { if (agentCard.key === k && agentCard.stopAsk) { agentCard.stopAsk = false; fillPop(); } }, 4000);
            return;
          }
          agentCard.stopAsk = false;
          e.currentTarget.disabled = true;
          info.stop().then(function (r) {
            if (r && r.error) showToast(r.error, 6000);
            else showToast('Stopped ' + info.name + (info.word ? ' · ' + info.word : '') + '.');
          }).catch(function (err) { showToast('Could not stop it: ' + err.message, 6000); });
        } } }));
    }
    if (info.follow) {
      var on = follow.mode === k;
      acts.appendChild(el('button', { type: 'button', 'data-act': 'follow', 'aria-pressed': String(on), text: on ? 'Following' : 'Follow',
        title: on ? 'Stop following it: the code view shows every agent again' : 'Show its code in the code view as it works',
        on: { click: function (e) {
          e.stopPropagation();
          if (follow.mode === k) setFollow('all', false);
          else {
            sw.active = k;
            setFollow(k, true);
          }
          fillPop();
        } } }));
    }
    var kids = [head];
    if (info.rows.length) kids.push(kv);
    if (acts.children.length) kids.push(acts);
    return kids;
  }

  // ---------- the Changes row (handoff 14) ----------
  // The path people see: no "◆ <computer>: " at the start and no ".claude/worktrees/<name>/" of a
  // subagent's copy, only the part inside the project.
  function shownPath(p) {
    var s = String(p || '').replace(/^◆ [^:]*: /, '');
    var m = /(^|[\\/])\.claude[\\/]worktrees[\\/][A-Za-z0-9._+-]{1,128}(?:[\\/]|$)/.exec(s);
    return m ? s.slice(m.index + m[0].length) : s;
  }
  // Where an agent is now (follow.at), as the project names the file.
  function atPath(at) {
    return shownPath(at.rel || relPath(at.file));
  }
  function splitPath(p) {
    var s = shownPath(p);
    var cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1;
    return { name: s.slice(cut), dir: s.slice(0, cut) };
  }
  // A count from the event, or null when it is not a real number.
  function statOf(ev, k) {
    var v = ev && ev.stats ? ev.stats[k] : null;
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  // Counts of 0 and 0 are valid only when the edit includes what it changed (its lines or its text).
  function zeroIsReal(ev) {
    if (ev.truncated || ev.backupSkipped || (ev.remote && ev.remote.secret)) return false;
    return Boolean(ev.snapshot) || (Array.isArray(ev.hunks) && ev.hunks.length > 0);
  }
  // { kind: diff | new | deleted | same | unknown, added, removed }: never "0 lines" for counts
  // that aren't known.
  function countsOf(ev) {
    var add = statOf(ev, 'added');
    var del = statOf(ev, 'removed');
    if (ev.deleted && ev.kind !== 'restore') return { kind: 'deleted', added: add, removed: del };
    if (ev.created && ev.kind !== 'restore') return { kind: 'new', added: add, removed: del };
    if (add === null || del === null) return { kind: 'unknown', added: null, removed: null };
    if (!add && !del) return zeroIsReal(ev) ? { kind: 'same', added: 0, removed: 0 } : { kind: 'unknown', added: null, removed: null };
    return { kind: 'diff', added: add, removed: del };
  }
  // The counts for line 1: "+12 −3", "New · 42 lines", "Deleted", "No line changes", or nothing.
  function countsNode(c) {
    var box = el('span', { class: 'cnt' });
    if (c.kind === 'diff') {
      box.appendChild(el('span', { class: 'a', text: '+' + c.added }));
      box.appendChild(document.createTextNode(' '));
      box.appendChild(el('span', { class: 'd', text: '−' + c.removed }));
    } else if (c.kind === 'new') {
      box.appendChild(el('span', { class: 'a', text: 'New' }));
      if (c.added) box.appendChild(document.createTextNode(' · ' + c.added + (c.added === 1 ? ' line' : ' lines')));
    } else if (c.kind === 'deleted') {
      box.appendChild(el('span', { class: 'd', text: 'Deleted' }));
    } else if (c.kind === 'same') {
      box.textContent = 'No line changes';
    }
    return box;
  }
  // The counts as plain text: "+12 −3", "New", "Deleted", "No line changes", or '' (not known).
  function countsText(c) {
    if (c.kind === 'diff') return '+' + c.added + ' −' + c.removed;
    return c.kind === 'new' ? 'New' : c.kind === 'deleted' ? 'Deleted' : c.kind === 'same' ? 'No line changes' : '';
  }
  // An edit card's "+12 −3" (new file: "+42"; deleted: "−7"), or null when there is nothing to show.
  function statNode(c) {
    var add = c.kind === 'diff' || (c.kind === 'new' && c.added) ? el('span', { class: 'plus', text: '+' + c.added }) : null;
    var del = c.kind === 'diff' || (c.kind === 'deleted' && c.removed) ? el('span', { class: 'minus', text: '−' + c.removed }) : null;
    return add || del ? el('span', { class: 'stat' }, add, del) : null;
  }
  // Where the edit happened, in one plain line, for the hover on the file name ('' for this project).
  function editWhere(ev) {
    var r = ev.remote;
    if (r) {
      if (r.kind === 'task' && r.taskKind === 'mine') return 'In a copy of this project on ◆ ' + r.computer + '. It shows in your project when the task\'s changes are applied.';
      return 'On ◆ ' + r.computer + ', in its own project.';
    }
    if (ev.copy) return 'In a subagent\'s copy of this project.';
    if (ev.task && ev.task.by) return 'In a copy of ◆ ' + ev.task.by + '\'s project, for its task.';
    return '';
  }
  function filePopBody(ev) {
    var rel = shownPath(ev.relFile || ev.file);
    var kids = [el('div', { class: 'fp', text: rel })];
    var where = editWhere(ev);
    if (where) kids.push(el('div', { class: 'fw', text: where }));
    var full = String(ev.file || '');
    if ((ev.remote || ev.copy || ev.task) && full && full !== rel) kids.push(el('div', { class: 'ff', text: full }));
    return kids;
  }
  // Line 1 of a Changes row: marker number, file name (bold, never cut), its folder (dim, cut from
  // the left) and the counts. o: { no, seen, line } (line: shown after the name, ":5").
  function changeLine(ev, o) {
    var parts = splitPath(ev.relFile || ev.file);
    var opt = o || {};
    var name = el('b', { class: 'f', text: parts.name + (opt.line ? ':' + opt.line : '') });
    var line = el('span', { class: 'c1' },
      opt.no ? el('span', { class: 'cno' + (opt.seen ? ' seen' : ''), text: String(opt.no), 'aria-hidden': 'true' }) : null,
      name,
      parts.dir ? el('span', { class: 'cf' }, el('bdi', { text: parts.dir })) : null,
      countsNode(countsOf(ev)));
    bindHoverPop(name, function () { return filePopBody(ev); }, 'file:' + editKey(ev));
    return line;
  }
  // Line 2: the agent's chip (small) and the time, and "lines not known yet" when they aren't.
  function changeWho(ev, extra) {
    var k = ev.kind === 'restore' ? null : ownerOf(ev);
    var line = el('div', { class: 'c2' });
    if (k) line.appendChild(agentChip(k, { small: true }));
    var bits = [timeAgo(ev.ts) || ''];
    if (countsOf(ev).kind === 'unknown') bits.push('lines not known yet');
    line.appendChild(el('span', { class: 'k', text: bits.filter(Boolean).join(' · ') }));
    (extra || []).forEach(function (n) { if (n) line.appendChild(n); });
    return line;
  }

  // The code view's "N lines" for a file's text; nothing when there is no text (not known, or an
  // empty file): never "0 lines".
  function linesText(lines) {
    var n = Array.isArray(lines) ? lines.length : 0;
    return n > 0 ? n + (n === 1 ? ' line' : ' lines') : '';
  }

  // ---------- the Agents tab: one row per agent ----------
  var agentsTabOpen = agentsEl.querySelector('.swopen');
  // The Agents tab's "All sessions": the Sessions sheet (handoff 13.2).
  var agentsTabSessions = el('button', { class: 'mini swopen', type: 'button', 'data-act': 'all-sessions', text: 'All sessions', title: 'Page control\'s sessions and the tasks of this project, here and on paired computers',
    on: { click: function () { openSessions(null); } } });
  var agentsTabButtons = el('div', { class: 'abtns' }, agentsTabOpen, agentsTabSessions);
  var agentsTabList = el('div', { class: 'alist', role: 'list' });
  function renderAgentsTab() {
    var keys = ['main'].concat(Object.keys(agents));
    var focused = agentsTabList.getRootNode().activeElement;
    var focusKey = focused && focused.closest && focused.closest('.agrow') ? focused.closest('.agrow').getAttribute('data-key') : null;
    agentsTabList.replaceChildren.apply(agentsTabList, keys.map(function (k) {
      var b = el('button', { class: 'agrow' + (follow.mode === k ? ' on' : ''), type: 'button', role: 'listitem', 'data-key': k, 'aria-label': chipLabel(k) });
      var chip = el('span', { class: 'achip' + (follow.mode === k ? ' on' : '') });
      chipParts(k).forEach(function (p) { chip.appendChild(p); });
      var step = agentKind(k) === 'main' ? swStep('main') || agentStatus('main').text : swStep(k);
      b.appendChild(chip);
      b.appendChild(el('span', { class: 'ars', text: firstLine(step, 60) }));
      bindAgentCard(b, k, null);
      return b;
    }));
    if (agentsEl.firstChild !== agentsTabList) agentsEl.replaceChildren(agentsTabList, agentsTabButtons);
    if (focusKey) {
      var again = agentsTabList.querySelector('.agrow[data-key="' + cssEscape(focusKey) + '"]');
      if (again) again.focus({ preventScroll: true });
    }
  }

  // Follow from the terminal's agents list (the mod): the code view follows that agent.
  function onFollowAgent(ev) {
    var key = typeof ev.key === 'string' ? ev.key : '';
    var k = key === 'main' ? 'main' : agents[key] ? key : null;
    if (!k) {
      var a = agentFor({ toolUseId: key, agentId: typeof ev.agentId === 'string' ? ev.agentId : null });
      k = a ? a.key : /^r:/.test(key) ? key : null;
    }
    if (!k) return showToast('That agent is not on this page yet.');
    sw.active = k;
    setFollow(k, true);
    showToast('Following ' + ownerLabel(k) + ' (from Claude Code)');
  }
