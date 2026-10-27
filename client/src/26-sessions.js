  // Part of the page script: client/src files are joined in order (lib/client-script.js) and share
  // the scope opened in 1-panel.js.
  // ---------- the Sessions sheet (handoff 13.2) ----------
  // Page control's sessions and this project's tasks, here and on paired computers, in groups.
  // The picked row has Open, Continue in terminal (copies `claude --resume`), Stop and ⋯ → Rename.
  // The page never starts a session from here and never answers a permission question.
  styleEl.textContent += [
    '.usage.sessions .shead .sct{margin-left:auto;color:var(--muted);font-size:11.5px;font-weight:400}',
    '.sslist{margin-top:.6em;padding:6px;border-radius:14px;background:var(--raise);box-shadow:0 0 0 .5px var(--line)}',
    '.ssg{padding:8px 8px 2px;font-size:11px;font-weight:600;color:var(--faint)}.ssg+.ssr{margin-top:0}.ssr+.ssg{padding-top:10px}',
    '.ssr{padding:8px;border-radius:9px;font-size:12.5px;cursor:pointer;outline:0}.ssr.on{background:var(--fill)}',
    '.ssr:focus-visible{box-shadow:inset 0 0 0 2px var(--focus)}',
    '.ss1{display:flex;align-items:center;gap:7px;min-width:0}',
    '.ss1 .ssn{font-weight:600;color:var(--fg);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ss1 .sss{margin-left:auto;flex:none;color:var(--muted);white-space:nowrap}.ss1 .sss.warn{color:var(--warn)}.ss1 .sss.bad{color:var(--del)}',
    '.ssd{flex:none;width:7px;height:7px;border-radius:50%;background:var(--faint)}.ssd.ok{background:var(--add)}.ssd.wait,.ssd.ask{background:var(--warn)}.ssd.bad{background:var(--del)}',
    '.ssd.spin{width:9px;height:9px;background:none;border:1.5px solid var(--fill2);border-top-color:var(--accent);animation:spin .9s linear infinite}',
    '.ssm{color:var(--muted);font-size:11.5px;margin:2px 0 0 16px;overflow-wrap:anywhere}',
    '.ssa{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:8px 0 0 16px}',
    '.ssa button,.ssren button{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:0;border-radius:7px;background:var(--fill2);color:var(--fg);font:500 12px/1.3 var(--sans);cursor:pointer;white-space:nowrap}',
    '.ssa button:hover{background:color-mix(in srgb,var(--fg) 12%,transparent)}.ssa button.q{background:transparent;color:var(--muted)}.ssa button.q:hover{color:var(--fg);background:var(--fill)}',
    '.ssa button:disabled{opacity:.45;cursor:default}.ssa svg{width:12px;height:12px}',
    '.ssa .ssmore{margin-left:auto;width:24px;height:24px;padding:0;justify-content:center;background:transparent;color:var(--muted)}.ssa .ssmore:hover{background:var(--fill);color:var(--fg)}',
    '.ssa .ssmenu{display:flex;flex-direction:column;position:absolute;right:0;top:calc(100% + 4px);z-index:2;min-width:120px;padding:4px;border-radius:10px;background:var(--glass);box-shadow:var(--shadow)}',
    '.ssa .ssmenu button{background:transparent;justify-content:flex-start;border-radius:6px}.ssa .ssmenu button:hover{background:var(--fill)}',
    '.ssa .sswrap{position:relative;margin-left:auto}',
    '.ssren{display:flex;align-items:center;gap:6px;min-width:0}',
    '.ssren input{flex:1;min-width:0;padding:3px 7px;border:0;border-radius:6px;background:var(--raise);color:var(--fg);font:600 12.5px/1.4 var(--sans);box-shadow:0 0 0 1.5px var(--focus);outline:0}',
    '.ssren button.p{background:var(--accent-fill);color:#fff;padding:3px 9px}',
    '.ssnote{margin:2px 0 0 16px;font-size:11.5px;color:var(--muted)}.ssnote.bad{color:var(--del)}',
    '.ssfoot{margin-top:6px;padding:6px 8px 2px;border-top:.5px solid var(--line);font-size:11px;font-weight:500;color:var(--faint)}',
    '.ssnone{padding:10px 8px;color:var(--muted);font-size:12.5px}',
    '.tslots{flex:none;color:var(--muted);font-size:11.5px;white-space:nowrap}',
    '.mini.quiet{background:transparent;color:var(--muted)}.mini.quiet:hover{background:var(--fill);color:var(--fg);filter:none}',
    '.stepper{display:inline-flex;align-items:center;border-radius:8px;background:var(--fill)}',
    '.stepper button{width:26px;height:24px;border:0;background:transparent;color:var(--fg2);font:400 14px/1 var(--sans);cursor:pointer;border-radius:8px;padding:0}',
    '.stepper button:hover:not(:disabled){background:var(--fill2);color:var(--fg)}.stepper button:disabled{opacity:.35;cursor:default}',
    '.stepper b{min-width:18px;text-align:center;font-weight:600;color:var(--fg)}',
    '.settings .sghead{padding:.75em 0 0;font-size:11px;font-weight:600;color:var(--faint)}',
  ].join('');

  var SESSIONS_POLL_MS = 2000;
  var sessionsEl = el('div', { class: 'usage settings sessions', role: 'region', 'aria-label': 'Sessions' });
  settingsEl.after(sessionsEl);
  var sessionsSheet = { open: false, data: null, error: '', pick: null, renaming: null, menu: null, note: null, busy: null, timer: 0, scrollTo: null };
  // The names people gave sessions, by the keys chips use ('main', 'task:<id>', 'r:<computer>:<id>').
  var sessionNames = Object.create(null);
  // { running, limit } task counts per computer: 'here' or a paired computer's name.
  var taskSlots = Object.create(null);
  var SESSION_WORDS = dict({ working: 'Working', starting: 'Starting', asking: 'Needs your answer', signin: 'Needs sign-in', waiting: 'Waiting',
    idle: 'Done', stopped: 'Stopped', ended: 'Ended', failed: 'Failed', refused: 'Didn\'t start' });
  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // The name given to a session (null: its own name). Used by the agent chips and cards.
  function sessionName(k) {
    return typeof sessionNames[k] === 'string' && sessionNames[k] ? sessionNames[k] : null;
  }
  // A valid { running, limit }, or null.
  function slotsOf(v) {
    if (!v || typeof v !== 'object') return null;
    var running = Number(v.running);
    var limit = Number(v.limit);
    if (!Number.isInteger(running) || running < 0 || !Number.isInteger(limit) || limit < 1 || limit > 8) return null;
    return { running: running, limit: limit };
  }
  // "2 of 4 running"
  function slotsText(s) {
    return s ? s.running + ' of ' + s.limit + ' running' : '';
  }
  // A task card's "2 of 4 running": updated in place when the count changes (task-slots).
  function slotsNode(where, fallback) {
    var s = taskSlots[where] || slotsOf(fallback);
    if (s) taskSlots[where] = s;
    return el('span', { class: 'tslots', 'data-slots': where, text: slotsText(s), title: 'Tasks running on ' + (where === 'here' ? 'this computer' : '◆ ' + where) + ' now, of its Tasks at once setting' });
  }
  function onTaskSlots(ev) {
    var s = slotsOf(ev);
    if (!s) return;
    var where = typeof ev.computer === 'string' && ev.computer ? ev.computer : 'here';
    taskSlots[where] = s;
    feedEl.querySelectorAll('.tslots').forEach(function (n) { if (n.getAttribute('data-slots') === where) n.textContent = slotsText(s); });
    if (sessionsSheet.open) sessionsSoon();
  }

  // "14:02" today, "yesterday", or "Oct 9".
  function sessionWhen(ms, withClock) {
    var n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    var d = new Date(n);
    if (!Number.isFinite(d.getTime())) return '';
    var now = new Date();
    var y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === now.toDateString()) return clock(n);
    if (!withClock && d.toDateString() === y.toDateString()) return 'yesterday';
    return MONTH_NAMES[d.getMonth()] + ' ' + d.getDate() + (withClock ? ', ' + clock(n) : '');
  }
  // The row's second line: how it started · model · effort · mode · start time.
  function sessionLine(r) {
    var how = typeof r.how === 'string' && r.how ? r.how : r.kind === 'page' ? 'Page control' : 'Task';
    var s = slotsOf(r.slots);
    if (r.state === 'waiting' && s) return how.replace(/ · .*$/, '') + ' · ' + s.running + ' of ' + s.limit + ' already running';
    return [how, r.model ? modelLabel({ model: String(r.model) }).replace(/ \(1M\)$/, '') : '', EFFORT_NAMES[r.effort] || '', modeLabel(r.mode), sessionWhen(r.startedAt, true)]
      .filter(Boolean).join(' · ');
  }
  function sessionStatus(r) {
    var st = SESSION_WORDS[r.state] ? r.state : 'ended';
    var word = st === 'idle' && r.kind === 'page' && r.running ? 'Idle' : st === 'asking' && r.kind === 'there' ? 'Needs your answer there' : SESSION_WORDS[st];
    var at = !r.running && (st === 'stopped' || st === 'ended' || st === 'idle' || st === 'failed') ? sessionWhen(r.at, false) : '';
    var mark = st === 'working' || st === 'starting' ? 'spin' : st === 'asking' || st === 'signin' ? 'ask' : st === 'waiting' ? 'wait'
      : st === 'failed' || st === 'refused' ? 'bad' : st === 'idle' ? 'ok' : '';
    return { text: word + (at ? ' · ' + at : ''), mark: mark, tone: st === 'asking' || st === 'signin' ? 'warn' : st === 'failed' || st === 'refused' ? 'bad' : '' };
  }

  function openSessions(groupKey) {
    if (settings.open) setSettingsOpen(false);
    if (usageOpen) {
      usageOpen = false;
      renderUsage();
    }
    sessionsSheet.open = true;
    sessionsSheet.scrollTo = groupKey || null;
    panel.classList.add('sheet');
    if (state.panel !== 'open') setPanel('open');
    renderSessions();
    loadSessions(true);
    clearInterval(sessionsSheet.timer);
    sessionsSheet.timer = setInterval(function () { if (sessionsSheet.open) loadSessions(false); }, SESSIONS_POLL_MS);
  }
  function closeSessions() {
    if (!sessionsSheet.open) return;
    sessionsSheet.open = false;
    sessionsSheet.renaming = null;
    sessionsSheet.menu = null;
    clearInterval(sessionsSheet.timer);
    if (!settings.open) panel.classList.remove('sheet');
    renderSessions();
  }
  var sessionsSoonTimer = 0;
  function sessionsSoon() {
    clearTimeout(sessionsSoonTimer);
    sessionsSoonTimer = setTimeout(function () { loadSessions(false); }, 300);
  }
  // GET /sessions for this page's project. Also updates the session names the chips use.
  var sessionsLoading = false;
  var sessionsShown = ''; // the list last drawn, as JSON: the same list is not drawn again
  var sessionsAfterHello = false;
  function loadSessions(focus) {
    if (sessionsLoading) return;
    // Before the first hello this page does not know if it runs through a pairing link (state.via).
    if (!state.hello) {
      sessionsAfterHello = true;
      return;
    }
    if (state.via) {
      // A page through a pairing link: the server there lists sessions only on its own page.
      sessionsSheet.data = null;
      sessionsSheet.error = 'This page runs on ◆ ' + state.via + '. Open the Sessions list on that computer\'s own page.';
      if (sessionsSheet.open) renderSessions(false);
      return;
    }
    sessionsLoading = true;
    fetch(SERVER + '/sessions?page=' + encodeURIComponent(PAGE_ID)).then(function (res) {
      // An error page that isn't JSON: report its status, not the parse error.
      return res.json().catch(function (err) {
        if (!(err instanceof SyntaxError)) throw err;
        throw new Error('HTTP ' + res.status);
      }).then(function (json) {
        if (!res.ok) throw new Error(json && json.error ? json.error : 'HTTP ' + res.status);
        return json;
      });
    }).then(function (data) {
      sessionsLoading = false;
      var names = Object.create(null);
      var given = data && data.names && typeof data.names === 'object' ? data.names : {};
      Object.keys(given).forEach(function (k) { if (typeof given[k] === 'string') names[k] = given[k]; });
      var changed = JSON.stringify(names) !== JSON.stringify(sessionNames);
      sessionNames = names;
      if (changed) {
        renderAgentsTab();
        refreshAgentCard();
        swSoon();
      }
      sessionsSheet.data = data && Array.isArray(data.groups) ? data : null;
      var shown = JSON.stringify(sessionsSheet.data);
      var same = shown === sessionsShown && !sessionsSheet.error;
      sessionsShown = shown;
      sessionsSheet.error = '';
      if (sessionsSheet.open && (focus || !same)) renderSessions(focus);
    }).catch(function (err) {
      sessionsLoading = false;
      if (!(err instanceof Error)) throw err;
      sessionsSheet.error = 'Could not list the sessions: ' + err.message;
      if (sessionsSheet.open) renderSessions(false);
    });
  }

  // The first hello arrived: load the list that was asked for before it.
  function sessionsHello() {
    if (!sessionsAfterHello) return;
    sessionsAfterHello = false;
    loadSessions(true);
  }
  function sessionRows() {
    var d = sessionsSheet.data;
    return d ? d.groups.reduce(function (all, g) { return all.concat(Array.isArray(g.rows) ? g.rows : []); }, []) : [];
  }
  function pickSession(key) {
    if (sessionsSheet.pick === key) return;
    sessionsSheet.pick = key;
    sessionsSheet.menu = null;
    if (sessionsSheet.renaming !== key) sessionsSheet.renaming = null;
    if (sessionsSheet.note && sessionsSheet.note.key !== key) sessionsSheet.note = null;
    renderSessions(true);
  }
  function sessionNote(key, text, bad) {
    sessionsSheet.note = { key: key, text: text, bad: Boolean(bad) };
    renderSessions(false);
  }
  // Open: follow it in the panel and show its card (or the chat, for page control).
  function openSession(r) {
    closeSessions();
    if (r.follow === 'main' || /^r:/.test(r.follow || '')) setFollow(r.follow, true);
    var card = null;
    if (r.kind === 'here') card = taskCards[r.key.slice(5)];
    else if (r.kind === 'there') card = remoteCards[r.key.slice(r.key.lastIndexOf(':') + 1)];
    if (card && card.item && card.item.isConnected) {
      card.item.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.item.classList.remove('fresh');
      void card.item.offsetWidth; // restarts the highlight animation
      card.item.classList.add('fresh');
    } else if (r.kind === 'page') {
      feedEl.scrollTop = feedEl.scrollHeight;
    }
  }
  // Stop: the same request as its own Stop button. It stays in the list.
  function stopSessionRow(r) {
    var req = r.kind === 'page' ? driveRequest('/drive/stop', {})
      : r.kind === 'here' ? postJson('/task/stop', { page: PAGE_ID, task: r.key.slice(5) })
        : postJson('/remote/task/stop', { page: PAGE_ID, task: r.key.slice(r.key.lastIndexOf(':') + 1) });
    sessionsSheet.busy = r.key;
    renderSessions(false);
    req.then(function (out) {
      sessionsSheet.busy = null;
      if (out && out.error) return sessionNote(r.key, String(out.error), true);
      sessionNote(r.key, 'Stopped. It stays here, and Continue in terminal still works.');
      return loadSessions(false);
    }).catch(function (err) {
      sessionsSheet.busy = null;
      if (!(err instanceof Error)) throw err;
      sessionNote(r.key, 'Could not stop it: ' + err.message, true);
    });
  }
  function renameSession(r, name) {
    sessionsSheet.busy = r.key;
    renderSessions(false);
    postJson('/sessions/rename', { page: PAGE_ID, key: r.key, name: name }).then(function () {
      sessionsSheet.busy = null;
      sessionsSheet.renaming = null;
      sessionsSheet.note = null;
      loadSessions(true);
    }).catch(function (err) {
      sessionsSheet.busy = null;
      if (!(err instanceof Error)) throw err;
      sessionNote(r.key, 'Could not rename it: ' + err.message, true);
    });
  }
  function continueSession(r) {
    if (!r.command) return;
    copyText(r.command, r.kind === 'there'
      ? 'Copied. Run it in a terminal on ◆ ' + r.computer + ' to continue this session in Claude Code.'
      : 'Copied. Run it in a terminal to continue this session in Claude Code.');
  }

  function sessionActions(r) {
    var acts = el('div', { class: 'ssa' });
    var busy = sessionsSheet.busy === r.key;
    if (r.follow) acts.appendChild(el('button', { type: 'button', 'data-act': 'open', text: 'Open', title: 'Follow it in the panel and show its ' + (r.kind === 'page' ? 'chat' : 'card'), on: { click: function (e) { e.stopPropagation(); openSession(r); } } }));
    var cont = el('button', { type: 'button', 'data-act': 'continue', title: r.command ? r.command : 'The command is ready after Claude\'s first reply', on: { click: function (e) { e.stopPropagation(); continueSession(r); } } },
      icon('copy'), document.createTextNode('Continue in terminal'));
    if (!r.command) cont.disabled = true;
    acts.appendChild(cont);
    if (r.running) {
      var mine = r.kind !== 'page' || driving();
      var stop = el('button', { class: 'q', type: 'button', 'data-act': 'stop', text: busy ? 'Stopping…' : 'Stop',
        title: mine ? 'Stop it. It stays in this list.' : 'Page control runs from another tab: stop it there, or with /editlens manual in Claude Code.',
        on: { click: function (e) { e.stopPropagation(); stopSessionRow(r); } } });
      if (busy || !mine) stop.disabled = true;
      acts.appendChild(stop);
    }
    if (r.key !== 'pc:new') {
      var wrap = el('span', { class: 'sswrap' });
      var more = el('button', { class: 'ssmore', type: 'button', 'data-act': 'more', title: 'More', 'aria-label': 'More for ' + r.name, 'aria-haspopup': 'menu', 'aria-expanded': String(sessionsSheet.menu === r.key),
        on: { click: function (e) { e.stopPropagation(); sessionsSheet.menu = sessionsSheet.menu === r.key ? null : r.key; renderSessions(false); } } }, icon('more'));
      wrap.appendChild(more);
      if (sessionsSheet.menu === r.key) {
        var menu = el('div', { class: 'ssmenu', role: 'menu' });
        menu.appendChild(el('button', { type: 'button', role: 'menuitem', 'data-act': 'rename', text: 'Rename', on: { click: function (e) {
          e.stopPropagation();
          sessionsSheet.menu = null;
          sessionsSheet.renaming = r.key;
          sessionsSheet.note = null;
          renderSessions(false);
        } } }));
        if (r.renamed) menu.appendChild(el('button', { type: 'button', role: 'menuitem', 'data-act': 'own-name', text: 'Use its own name', on: { click: function (e) { e.stopPropagation(); sessionsSheet.menu = null; renameSession(r, ''); } } }));
        wrap.appendChild(menu);
      }
      acts.appendChild(wrap);
    }
    return acts;
  }
  function renameField(r) {
    var input = el('input', { type: 'text', 'aria-label': 'Name for this session', maxlength: '60', placeholder: r.ownName || '', 'data-key': r.key });
    input.value = r.name;
    var save = el('button', { class: 'p', type: 'button', text: 'Save', on: { click: function (e) { e.stopPropagation(); renameSession(r, input.value); } } });
    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        renameSession(r, input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        sessionsSheet.renaming = null;
        renderSessions(true);
      }
    });
    return el('div', { class: 'ssren' }, input, save);
  }
  function sessionRow(r) {
    var on = r.key === sessionsSheet.pick;
    var st = sessionStatus(r);
    var row = el('div', { class: 'ssr' + (on ? ' on' : ''), role: 'listitem', tabindex: on ? '0' : '-1', 'data-key': r.key, 'aria-label': r.name + ', ' + st.text });
    var renaming = on && sessionsSheet.renaming === r.key;
    var mark = el('span', { class: 'ssd ' + st.mark, 'aria-hidden': 'true' });
    var name = renaming ? renameField(r) : el('span', { class: 'ssn', text: r.name });
    var top = el('div', { class: 'ss1' }, mark, name);
    if (renaming) name.style.flex = '1';
    else top.appendChild(el('span', { class: 'sss' + (st.tone ? ' ' + st.tone : ''), text: st.text }));
    row.appendChild(top);
    if (renaming) {
      row.appendChild(el('div', { class: 'ssm', text: 'Enter saves, Esc cancels. An empty name gives it its own name back.' }));
    } else {
      row.appendChild(el('div', { class: 'ssm', text: sessionLine(r) }));
      if (on) row.appendChild(sessionActions(r));
    }
    var note = sessionsSheet.note && sessionsSheet.note.key === r.key ? sessionsSheet.note : null;
    if (on && note) row.appendChild(el('div', { class: 'ssnote' + (note.bad ? ' bad' : ''), role: 'status', text: note.text }));
    // The name opens the agent details card, as the chips do (handoff 12.2).
    var chipKey = r.kind === 'page' && r.current ? 'main' : r.kind === 'there' ? r.key : null;
    if (chipKey && !renaming) bindHoverPop(name, function () { return agentCardBody(chipKey); }, chipKey);
    row.addEventListener('click', function () { pickSession(r.key); });
    row.addEventListener('keydown', function (e) {
      if (e.target !== row) return;
      var rows = sessionRows();
      var i = rows.findIndex(function (x) { return x.key === r.key; });
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) pickSession(next.key);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeSessions();
      }
    });
    return row;
  }
  function renderSessions(focus) {
    sessionsEl.classList.toggle('on', sessionsSheet.open);
    if (!sessionsSheet.open) return sessionsEl.replaceChildren();
    var d = sessionsSheet.data;
    var rows = sessionRows();
    if (!rows.some(function (r) { return r.key === sessionsSheet.pick; })) {
      var first = rows.filter(function (r) { return r.running; })[0] || rows[0];
      sessionsSheet.pick = first ? first.key : null;
    }
    var done = el('button', { class: 'sback', type: 'button', text: 'Done', on: { click: closeSessions } });
    var count = d && d.total ? d.total + (d.running ? ' · ' + d.running + ' running' : '') + (d.waiting > 0 ? ' · ' + d.waiting + ' waiting' : '') : '';
    var kids = [el('div', { class: 'shead' }, el('b', { text: 'Sessions' }), el('span', { class: 'sct', text: count }), done)];
    var list = el('div', { class: 'sslist', role: 'list', 'aria-label': 'Sessions' });
    if (sessionsSheet.error) list.appendChild(el('div', { class: 'ssnone', role: 'status', text: sessionsSheet.error }));
    else if (!d) list.appendChild(el('div', { class: 'ssnone', text: 'Listing the sessions…' }));
    else if (!rows.length) list.appendChild(el('div', { class: 'ssnone', text: 'No sessions in this project yet. Page control and tasks show here.' }));
    var scrollNode = null;
    (d ? d.groups : []).forEach(function (g) {
      if (!Array.isArray(g.rows) || !g.rows.length) return;
      var head = el('div', { class: 'ssg', 'data-group': String(g.key || ''), text: String(g.title || '') });
      list.appendChild(head);
      if (sessionsSheet.scrollTo && sessionsSheet.scrollTo === g.key) scrollNode = head;
      g.rows.forEach(function (r) { list.appendChild(sessionRow(r)); });
    });
    list.appendChild(el('div', { class: 'ssfoot', text: 'Continue in terminal copies a command. The desktop app may not list these.' }));
    kids.push(list);
    var keep = sessionsEl.scrollTop;
    // A name being typed stays, with its cursor, when the list is drawn again.
    var old = sessionsEl.querySelector('.ssren input');
    var draft = old && old.getAttribute('data-key') === sessionsSheet.renaming
      ? { key: sessionsSheet.renaming, value: old.value, start: old.selectionStart, end: old.selectionEnd, focused: sessionsEl.getRootNode().activeElement === old } : null;
    sessionsEl.replaceChildren.apply(sessionsEl, kids);
    sessionsEl.scrollTop = keep;
    if (scrollNode) {
      sessionsSheet.scrollTo = null;
      scrollNode.scrollIntoView({ block: 'start' });
    }
    var rn = sessionsEl.querySelector('.ssren input');
    if (rn && draft && draft.key === rn.getAttribute('data-key')) {
      rn.value = draft.value;
      if (draft.focused) rn.focus();
      rn.setSelectionRange(draft.start, draft.end);
    } else if (rn) {
      rn.focus();
      rn.select();
    } else if (focus) {
      var picked = sessionsEl.querySelector('.ssr.on');
      if (picked) picked.focus({ preventScroll: true });
    }
    return undefined;
  }
