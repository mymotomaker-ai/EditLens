
  // ---------- effort: Claude's effort level (Claude Code's /effort) ----------
  // A chip after the permission mode: five-bar meter, level, chevron. Page control and tasks from
  // paired computers change it here (from Claude's next step); in Manual it only shows Claude Code's level.
  // Shape from the server (lib/effort.js): { level, used, supported, cap, source: 'page' | 'terminal' }.
  var EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
  var EFFORT_LABELS = dict({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' });
  var EFFORT_NOTES = dict({ low: 'Fastest, for small changes', high: 'Default', max: 'Most reasoning · this session only' });
  var effortState = { page: null, terminal: null };
  styleEl.textContent += [
    '.pmode.ef{display:inline-flex;gap:5px}.pmode.ef.hide{display:none}.pmode.ef.off,.pmode.ef.ro{color:var(--faint)}',
    '.pmode.ef svg{width:11px;height:11px;flex:none}',
    '.lv{display:inline-flex;align-items:flex-end;gap:1.5px;height:10px;flex:none}',
    '.lv>span{width:2.5px;border-radius:1px;background:var(--fill2)}',
    '.lv>span:nth-child(1){height:4px}.lv>span:nth-child(2){height:5.5px}.lv>span:nth-child(3){height:7px}.lv>span:nth-child(4){height:8.5px}.lv>span:nth-child(5){height:10px}',
    '.lv[data-l="1"]>span:nth-child(-n+1),.lv[data-l="2"]>span:nth-child(-n+2),.lv[data-l="3"]>span:nth-child(-n+3),.lv[data-l="4"]>span:nth-child(-n+4),.lv[data-l="5"]>span{background:currentColor}',
    '.lmenu.efmenu{width:min(270px,calc(100vw - 16px))}',
    '.efmenu button.li{gap:10px;padding:7px 8px}.efmenu .li .lv{color:var(--muted)}.efmenu .li .lbl{flex:1;min-width:0}',
    '.efmenu .li small{display:block;color:var(--faint);font-size:11px;font-weight:400;margin-top:1px}',
    '.efmenu button.li.cap{opacity:.4;cursor:default}.efmenu button.li.cap:hover{background:transparent}',
    '.efmenu .efoot{font-size:11px;font-weight:500;color:var(--faint);padding:4px 9px 6px}',
  ].join('');

  function effortLabel(level) {
    return EFFORT_LABELS[level] || '';
  }
  // 1..5 for a level, 0 for none.
  function effortRank(level) {
    return EFFORT_LEVELS.indexOf(level) + 1;
  }
  // The five-bar meter, filled up to the level.
  function effortMeter(level) {
    var m = el('span', { class: 'lv', 'data-l': String(effortRank(level)), 'aria-hidden': 'true' });
    for (var i = 0; i < 5; i++) m.appendChild(el('span'));
    return m;
  }
  // An effort the server sent, checked: null unless it names one of the five levels.
  function effortOf(e) {
    if (!e || typeof e !== 'object' || !EFFORT_LABELS[e.level]) return null;
    return {
      level: e.level, used: EFFORT_LABELS[e.used] ? e.used : null, supported: typeof e.supported === 'boolean' ? e.supported : null,
      cap: EFFORT_LABELS[e.cap] ? e.cap : null, source: e.source === 'terminal' ? 'terminal' : 'page',
    };
  }
  function effortModelName(model) {
    return model ? modelLabel({ model: String(model) }) : '';
  }

  // Draws the effort chip (a button). opts: { model, pick(level) -> Promise, or null when it can't be
  // changed here, readOnlyNote, whose (the tooltip names that Claude) }.
  function drawEffortChip(chip, e, opts) {
    opts = opts || {};
    chip.classList.add('pmode', 'on', 'ef');
    chip.classList.toggle('hide', !e);
    chip.classList.remove('off', 'ro');
    chip.onclick = null;
    if (!e) return chip.replaceChildren();
    var model = effortModelName(opts.model);
    if (e.supported === false) {
      // A model without effort: grey, and the tooltip names the model.
      chip.classList.add('off');
      chip.replaceChildren(effortMeter(null), el('span', { text: 'Effort not used' }));
      chip.title = (model || 'This model') + ' doesn\'t use effort.';
      chip.onclick = function () { showToast(chip.title); };
      return;
    }
    var shown = e.used || e.level;
    if (e.source === 'terminal') {
      // Manual: Claude Code's own level, read only.
      chip.classList.add('ro');
      chip.replaceChildren(effortMeter(shown), el('span', { text: effortLabel(shown) + ' · set in Claude Code' }));
      chip.title = 'Set in Claude Code: type /effort';
      chip.onclick = function () { showToast('Effort is set in Claude Code: type /effort there to change it. This page can\'t change it.'); };
      return;
    }
    chip.replaceChildren(effortMeter(shown), el('span', { text: effortLabel(shown) }), icon('minimize'));
    chip.title = (opts.whose ? opts.whose + ' effort: ' : 'Effort: ') + effortLabel(shown) + (e.used && e.used !== e.level ? ' (' + effortLabel(e.level) + ' asked for)' : '') +
      (opts.pick ? '. Click to change it.' : '. ' + (opts.readOnlyNote || ''));
    chip.setAttribute('aria-haspopup', opts.pick ? 'menu' : 'false');
    chip.onclick = function () {
      if (opts.pick) openEffortMenu(chip, e, opts.pick, opts.foot);
      else if (opts.readOnlyNote) showToast(opts.readOnlyNote);
    };
  }

  function closeEffortMenu() {
    var open = [root].concat(pop.panel ? [pop.panel.root] : [], pop.dock ? [pop.dock.root] : []);
    open.forEach(function (r) { r.querySelectorAll('.lwrap.efwrap').forEach(function (n) { n.remove(); }); });
  }
  // The five levels: a check on the current one, levels above a cap greyed out and not clickable.
  function openEffortMenu(button, e, pick, foot) {
    closeEffortMenu();
    closeModeMenu();
    closeLayoutMenu();
    var current = e.used || e.level;
    var menu = el('div', { class: 'lmenu efmenu', role: 'menu' });
    var wrap = el('div', { class: 'lwrap efwrap' }, menu);
    menu.appendChild(el('div', { class: 'lh', text: 'Effort' }));
    EFFORT_LEVELS.forEach(function (level) {
      var capped = Boolean(e.cap) && effortRank(level) > effortRank(e.cap);
      var note = EFFORT_NOTES[level];
      var b = el('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(level === current), 'data-level': level,
        class: 'li' + (level === current ? ' on' : '') + (capped ? ' cap' : ''), 'aria-disabled': capped ? 'true' : null },
      effortMeter(level), el('span', { class: 'lbl' }, document.createTextNode(effortLabel(level)), note ? el('small', { text: note }) : null));
      b.addEventListener('click', function () {
        if (capped) return;
        closeEffortMenu();
        if (level === current) return;
        pick(level);
      });
      menu.appendChild(b);
    });
    menu.appendChild(el('hr'));
    menu.appendChild(el('div', { class: 'efoot', text: e.cap ? 'Your organization\'s settings allow up to ' + effortLabel(e.cap) + '.' : foot || 'Applies from Claude\'s next step.' }));
    wrap.addEventListener('pointerdown', function (ev) { if (ev.target === wrap) closeEffortMenu(); });
    wrap.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      closeEffortMenu();
    });
    menuHost(button).appendChild(wrap);
    var view = button.ownerDocument.defaultView;
    var r = button.getBoundingClientRect();
    var mw = menu.offsetWidth;
    var mh = menu.offsetHeight;
    menu.style.left = Math.round(clamp(r.left, 8, view.innerWidth - mw - 8)) + 'px';
    menu.style.top = Math.round(r.top - mh - 6 > 8 ? r.top - mh - 6 : Math.min(view.innerHeight - mh - 8, r.bottom + 6)) + 'px';
    var first = menu.querySelector('button.on') || menu.querySelector('button:not(.cap)');
    if (first) first.focus();
  }
  // After a change: applies the effort Claude now uses, or shows a toast with the reason it failed.
  function effortPicked(promise, done) {
    return promise.then(function (r) {
      var e = effortOf(r && r.effort);
      if (e) done(e);
      if (e && e.cap && e.used && effortRank(e.used) < effortRank(e.level)) showToast('Effort set to ' + effortLabel(e.used) + ', the highest your organization allows.');
    }).catch(function (err) {
      if (!(err instanceof Error)) throw err;
      showToast('Could not change the effort: ' + err.message, 6000);
    });
  }

  // ---- the message box ----
  var effortButton = el('button', { class: 'pmode ef hide', type: 'button' });
  modeButton.after(effortButton);
  function renderEffort() {
    if (drive.active) {
      // Page control's level; this page can change it only when it has page control.
      // Page control's own Claude, not the Claude Code window: the tooltip says so.
      drawEffortChip(effortButton, effortState.page, {
        model: drive.model,
        whose: 'Page control',
        pick: driving() ? function (level) {
          return effortPicked(driveRequest('/drive/effort', { level: level }), function (e) {
            effortState.page = e;
            renderEffort();
          });
        } : null,
        readOnlyNote: 'Page control runs from another tab or page: change it there.',
        foot: 'Applies to this page control session from Claude\'s next step. New tasks use the Effort setting.',
      });
    } else {
      drawEffortChip(effortButton, effortState.terminal, {});
    }
  }
  // Page control's effort, from the 'drive-status', 'drive' and 'drive-effort' events.
  function onDriveEffort(ev) {
    if (ev.type === 'drive' && ev.phase === 'ended') effortState.page = null;
    else if (ev.type === 'drive-status' && !ev.active) effortState.page = null;
    else if (ev.effort) effortState.page = effortOf(ev.effort);
    renderEffort();
  }
  // effort: the level of Claude in the user's terminal, as Claude Code reports it (read only).
  function onTerminalEffort(ev) {
    var e = effortOf(ev.effort);
    if (!e) return;
    e.source = 'terminal';
    effortState.terminal = e;
    renderEffort();
  }

  // ---- task cards ----
  // A task a paired computer sent to Claude here: the effort is changed here (POST /task/effort).
  function taskEffortChip(id, ev) {
    var e = effortOf(ev.effort);
    if (!e) return null;
    var chip = el('button', { type: 'button' });
    drawEffortChip(chip, e, { pick: ev.state === 'refused' ? null : function (level) {
      return effortPicked(postJson('/task/effort', { page: PAGE_ID, task: id, level: level }), function (next) {
        var c = taskCards[id];
        if (c) {
          c.ev.effort = next;
          renderTask(id);
        }
      });
    } });
    return chip;
  }
  // A task Claude here sent to a paired computer: the change is sent there (POST /remote/task-effort),
  // and that computer reports the effort it uses in the task's next update.
  function remoteEffortChip(id, ev) {
    var e = effortOf(ev.effort);
    if (!e) return null;
    var chip = el('button', { type: 'button' });
    var opts = { pick: ev.state === 'refused' ? null : function (level) {
      return effortPicked(postJson('/remote/task-effort', { page: PAGE_ID, task: id, level: level }), function (next) {
        drawEffortChip(chip, next, opts);
      });
    } };
    drawEffortChip(chip, e, opts);
    return chip;
  }
