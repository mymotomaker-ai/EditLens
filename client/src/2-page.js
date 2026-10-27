  // Part of the page script: client/src files are joined in order (lib/client-script.js) and share
  // the scope opened in 1-panel.js.
  // ---------- network tracking: which elements came from which API route ----------
  var responses = []; // { path, at }
  var routeEls = new Map(); // path -> [elements], the newest ROUTE_PATHS_MAX paths
  var ROUTE_PATHS_MAX = 100;
  function notePath(url) {
    try {
      var u = new URL(url, location.href);
      if (u.origin === ORIGIN) return null;
      return u.pathname;
    } catch (err) {
      if (err && err.name === 'TypeError') return null; // not a URL
      throw err;
    }
  }
  function noteResponse(method, url) {
    var p = notePath(url);
    if (!p) return;
    responses.push({ path: p, method: String(method || 'GET').toUpperCase(), at: Date.now() });
    if (responses.length > 200) responses.shift();
  }
  // The page's fetch and XMLHttpRequest are wrapped to learn which request filled which element;
  // restorePatches puts the originals back if the script stops.
  var unpatch = [];
  function restorePatches() {
    unpatch.splice(0).forEach(function (undo) { undo(); });
  }
  if (window.fetch) {
    var origFetch = window.fetch;
    unpatch.push(function () { window.fetch = origFetch; });
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      var method = (init && init.method) || (input && input.method) || 'GET';
      var result = origFetch.apply(this, arguments);
      if (init && init.editlensOwn) return result; // the panel's own requests are not the app's
      // The caller's promise reports the error.
      result.then(function () { noteResponse(method, url); }, function ignoreRejection() {});
      return result;
    };
  }
  if (window.XMLHttpRequest) {
    var origOpen = XMLHttpRequest.prototype.open;
    unpatch.push(function () { XMLHttpRequest.prototype.open = origOpen; });
    XMLHttpRequest.prototype.open = function (method, url) {
      var xhr = this;
      // One listener per request object, even when it is opened again.
      xhr.__editlensReq = { method: method, url: url };
      if (!xhr.__editlensNoted) {
        xhr.__editlensNoted = true;
        xhr.addEventListener('loadend', function () { noteResponse(xhr.__editlensReq.method, xhr.__editlensReq.url); });
      }
      return origOpen.apply(this, arguments);
    };
  }
  function attributeToRequests(elements, now) {
    var recent = responses.filter(function (r) { return now - r.at < RENDER_WINDOW_MS; });
    if (!recent.length) return;
    recent.forEach(function (r) {
      var list = (routeEls.get(r.path) || []).filter(function (e) { return e.isConnected; });
      routeEls.delete(r.path);
      elements.forEach(function (e) { if (list.indexOf(e) < 0) list.push(e); });
      if (list.length > 60) list.splice(0, list.length - 60);
      routeEls.set(r.path, list);
      while (routeEls.size > ROUTE_PATHS_MAX) routeEls.delete(routeEls.keys().next().value);
    });
  }
  function routeRegex(route) {
    var body = String(route).replace(/^\^/, '').replace(/\$$/, '').replace(/\/+$/, '');
    var pattern = body.split('/').map(function (seg) {
      if (/^:\w+\??$/.test(seg) || /^\{[^}]+\}$/.test(seg) || /^<[^>]+>$/.test(seg) || /^\[[^\]]+\]$/.test(seg)) return '[^/]+';
      if (seg === '*') return '.*';
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    return new RegExp('(^|/)' + pattern.replace(/^\//, '') + '/?$');
  }
  function pagePathsFor(routes) {
    var hits = [];
    (routes || []).forEach(function (route) {
      var re;
      try {
        re = routeRegex(route);
      } catch (err) {
        if (err instanceof SyntaxError) return;
        throw err;
      }
      responses.forEach(function (r) {
        if (re.test(r.path) && !hits.some(function (h) { return h.path === r.path; })) hits.push({ route: route, path: r.path, method: r.method });
      });
    });
    return hits;
  }
  function elementsForPaths(hits) {
    var out = [];
    hits.forEach(function (h) {
      (routeEls.get(h.path) || []).forEach(function (e) { if (e.isConnected && out.indexOf(e) < 0) out.push(e); });
    });
    return out.filter(function (e) { return !out.some(function (o) { return o !== e && o.contains(e); }); });
  }

  function renderDiff(hunks, truncated) {
    var box = el('div', { class: 'diff' });
    (hunks || []).forEach(function (h) {
      var start = firstChangedLine(h);
      box.appendChild(el('div', { class: 'ln h', text: Number.isFinite(start) && start > 0 ? '@@ line ' + start + ' @@' : Number.isFinite(start) ? '@@ start of file @@' : '@@ line ? @@' }));
      (h.lines || []).forEach(function (l) {
        var kind = l[0] === '+' ? ' a' : l[0] === '-' ? ' d' : '';
        box.appendChild(el('div', { class: 'ln' + kind, text: l }));
      });
    });
    if (truncated) box.appendChild(el('div', { class: 'ln h', text: '… rest of diff not shown' }));
    return box;
  }

  // Which Claude made an edit. Labels appear once edits come from more than one source (page
  // control and the Claude Code window, or two Claude Code sessions on the same project).
  var sessions = { seen: [], tags: [], control: [] };
  function sessionLabel(id) {
    if (sessions.control.indexOf(id) >= 0) return 'Page control';
    if (sessions.control.length) return 'Claude Code';
    // Numbered in the order they first edited, never by their id.
    var at = sessions.seen.indexOf(id);
    return 'Session ' + (at >= 0 ? at + 1 : sessions.seen.length + 1);
  }
  function renderSessionTags() {
    if (drive.sessionId && sessions.control.indexOf(drive.sessionId) < 0) sessions.control.push(drive.sessionId);
    var on = sessions.seen.length > 1 || sessions.control.length > 0;
    sessions.tags.forEach(function (t) {
      var id = t.getAttribute('data-session');
      t.textContent = on ? 'From ' + sessionLabel(id) : '';
      t.title = on ? 'Made by ' + sessionLabel(id) : '';
      t.classList.toggle('on', on);
    });
  }
  function noteSession(id, tag) {
    if (sessions.seen.indexOf(id) < 0) sessions.seen.push(id);
    if (tag) sessions.tags.push(tag);
    if (sessions.tags.length > 600) sessions.tags.splice(0, sessions.tags.length - 600);
    renderSessionTags();
  }
  // An edit on a paired computer: its own row in the Agents switcher (one per task there, one for
  // the sessions there), so it can be followed or filtered, with each edit as a step.
  var remoteIdle = {};
  function remoteAgent(ev, fresh) {
    var r = ev.remote;
    var k = String(ev.agentId || '');
    if (!r || !k) return;
    if (!agents[k]) {
      // The agent type is the computer ("◆ vm") and the description leaves it out, so labels name
      // it once. The title is the task's first line, never an id. Where its edits go is in each
      // edit's note and in the details card.
      addAgent({ toolUseId: k, agentId: k, agentType: '◆ ' + r.computer, ts: ev.ts, replay: !fresh, prompt: r.prompt || '',
        description: r.kind === 'task' ? firstLine(r.prompt, 80) || 'Task' : 'Claude Code sessions' });
      if (!agents[k]) return;
      agents[k].remote = true;
      agents[k].modeEl = null;
    }
    var a = agents[k];
    var rel = String(ev.relFile || '').replace(/^◆ [^:]*: /, '');
    addAgentStep({ toolUseId: k, agentId: k, kind: 'tool', tool: ev.tool || 'Edit', summary: rel, ts: ev.ts, replay: !fresh });
    if (!fresh) {
      if (!a.done) finishAgent({ toolUseId: k, agentId: k, status: 'done', ts: ev.ts, replay: true });
      else a.ended = Math.max(a.ended || 0, finiteNum(ev.ts));
      return;
    }
    // Shown as working while edits arrive; done a minute after the last one.
    if (a.done) {
      a.done = false;
      a.chip.classList.remove('done', 'failed');
      a.card.classList.remove('done', 'failed');
      var badge = a.card.querySelector('.abadge');
      if (badge) badge.textContent = String(a.type || 'agent').charAt(0).toUpperCase();
      a.stateEl.replaceChildren(el('span', { class: 'spin' }), el('span', { text: 'Editing' }));
      updateAgentsBadge();
    }
    clearTimeout(remoteIdle[k]);
    remoteIdle[k] = setTimeout(function () {
      if (agents[k] && !agents[k].done) finishAgent({ toolUseId: k, agentId: k, status: 'done', ts: Date.now() });
    }, 60000);
  }
  // Edits are numbered in the order they came; the page's markers use the same numbers.
  var editCount = 0;
  var editNo = Object.create(null); // edit key -> { no, seen }
  var EDIT_NOS_MAX = 5000; // numbers kept; the lists show far fewer edits
  function editNumber(ev) {
    var k = editKey(ev);
    if (!editNo[k]) {
      editNo[k] = { no: ++editCount, seen: false };
      if (editCount % 500 === 0) {
        Object.keys(editNo).forEach(function (e) { if (editNo[e].no <= editCount - EDIT_NOS_MAX) delete editNo[e]; });
      }
    }
    return editNo[k].no;
  }
  // Seen (its card opened, or its marker hovered): the number changes to an outline everywhere.
  function lookedAt(ev) {
    var k = editKey(ev);
    if (editNo[k]) editNo[k].seen = true;
    var card = cardOf.get(ev);
    var eno = card && card.querySelector('.eno');
    if (eno) eno.classList.add('seen');
    markers.forEach(function (m) { if (editKey(m.ev) === k) m.node.classList.add('seen'); });
  }
  // The file name in bold with its folder dim before it (wraps at the slashes).
  function fileText(path) {
    var p = String(path || '');
    var cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1;
    var node = pathText('span', 'file', p.slice(cut));
    if (cut > 0) {
      var dir = el('span', { class: 'dir' });
      p.slice(0, cut).replace(/([\\/])/g, '$1\n').split('\n').forEach(function (part, i) {
        if (i) dir.appendChild(document.createElement('wbr'));
        dir.appendChild(document.createTextNode(part));
      });
      node.insertBefore(dir, node.firstChild.nextSibling); // after the direction mark
    }
    return node;
  }
  // Where an edit is when it is not in this project's files (one note, the computer named once),
  // or '' for an edit here. Same wording on both computers' pages.
  // named: the card's agent label already names the computer, so the note leaves it out.
  function placeNote(ev, named) {
    if (ev.copy) return 'In its own copy of the project. Not in your files yet: it shows here when it is merged.';
    var r = ev.remote;
    if (r && named && ev.kind !== 'restore') {
      var t = placeNote(ev, false).replace(/^On ◆ [^,(]*(, | )/, '');
      return t.charAt(0).toUpperCase() + t.slice(1);
    }
    if (r) {
      var on = 'On ◆ ' + r.computer;
      if (r.secret) return on + ' (a key or credential file: its lines are not sent).';
      if (ev.kind === 'restore') return on + ', in its project.';
      if (r.kind === 'session') return on + ', by Claude there, in its project.';
      if (r.taskKind === 'mine') return on + ', in a copy of this project. Not in your files yet: Claude adds it when the task is done.';
      if (r.inCopy) return on + ', in a copy of its project. Not in its project yet: Claude merges it when the task is done.';
      return on + ', in its project.';
    }
    if (ev.task && ev.task.by) return 'A task from ◆ ' + ev.task.by + ', in a copy of its project. It shows on that computer\'s page as it happens.';
    return '';
  }
  // The message shown when Follow can't open a file because it is not part of this site.
  function awayNote(ev) {
    var name = baseName(String(ev.relFile || ev.file || '').replace(/^◆ [^:]*: /, ''));
    var code = ', so this page can\'t show it. Its code is in the code view.';
    if (ev.copy) return name + ' is in its own copy of the project until it is merged' + code;
    var r = ev.remote;
    if (r) {
      if (r.kind === 'task' && r.taskKind === 'mine') return name + ' is in a copy of this project on ◆ ' + r.computer + ', not in your files yet' + code;
      if (r.kind === 'task' && r.inCopy) return name + ' is in a copy of ◆ ' + r.computer + '\'s project' + code;
      return name + ' is on ◆ ' + r.computer + ', not on this site' + code;
    }
    if (ev.task && ev.task.by) return name + ' is in a copy of ◆ ' + ev.task.by + '\'s project' + code;
    return '';
  }
  function addEditCard(ev, fresh) {
    noteShown(ev);
    if (ev.remote) remoteAgent(ev, fresh);
    lastSteps = null;
    // The counts (handoff 14): nothing when they aren't known, never "+0 −0" for an unknown edit.
    var counts = countsOf(ev);
    var backend = ev.kind === 'backend';
    var restore = ev.kind === 'restore';
    // Only a tag that says something: a restore, a new file, or a backend (API) change.
    var label = restore ? restoreLabel(ev) : ev.created ? 'New file' : backend ? 'API' : '';
    var no = editNumber(ev);
    if (fresh) undoAskedEdit(ev);
    var item = el('li', { class: 'k-edit' + (backend ? ' backend' : '') + (restore ? ' restore' : '') + (fresh ? ' fresh' : ''), title: ev.file || '', 'data-ekey': editKey(ev) },
      el('div', { class: 'row' },
        el('span', { class: 'eno' + (fresh ? '' : ' seen'), text: String(no), title: 'Edit ' + no + ' (the same number as its marker on the page)' }),
        fileText(shownPath(ev.relFile || ev.file || '')),
        label ? el('span', { class: 'tool', text: label }) : null,
        statNode(counts),
        el('span', { class: 'ago', 'data-ts': String(ev.ts), text: timeAgo(ev.ts) }),
        el('button', { class: 'mini fmore', type: 'button', title: 'Open this file in your editor, or copy its path or code', 'aria-label': 'More: open or copy this file', 'aria-haspopup': 'menu',
          on: { click: function (e) { editMenu(ev, e.currentTarget); } } }, icon('more'))),
      ev.intent ? el('div', { class: 'why', text: ev.intent }) : null);
    // Its agent label: who made it, once there is more than one agent (or it was made elsewhere).
    var owner = ownerOf(ev);
    var named = !restore && (owner !== 'main' || Object.keys(agents).length > 0);
    if (named) {
      var who = el('div', { class: 'ewho' }, agentChip(owner, { small: true }));
      if (counts.kind === 'unknown' && !restore) who.appendChild(el('span', { text: 'lines not known yet' }));
      item.appendChild(who);
    }
    var where = placeNote(ev, named && Boolean(ev.remote));
    if (where) {
      item.classList.add('incopy');
      item.appendChild(el('div', { class: 'enote', text: where }));
    }
    if (ev.overlap) {
      var other = ev.overlap.agentId ? ownerLabel(ownerOf(ev.overlap)) : 'Claude';
      item.appendChild(el('div', { class: 'enote warn', text: other + ' also edited this file a moment ago. Check that one didn\'t undo the other.' }));
    }
    if (ev.sessionId) {
      var sessTag = el('div', { class: 'sess', 'data-session': String(ev.sessionId) });
      item.insertBefore(sessTag, item.querySelector('.row').nextSibling);
      noteSession(ev.sessionId, sessTag);
    }
    if (backend && ev.routes && ev.routes.length) item.appendChild(backendUses(ev));
    if (ev.snapshot) {
      item.querySelector('.row').insertBefore(
        el('button', { class: 'mini play', type: 'button', title: 'Replay this edit line by line in the code view', text: 'Replay', on: { click: function () { replayEdit(ev); } } }),
        item.querySelector('.ago'));
    }
    if (ev.backup) {
      item.querySelector('.row').insertBefore(
        el('button', { class: 'mini rst', type: 'button', title: restore ? 'Put this file back as it was before this restore' : 'Put this file back as it was before this edit',
          text: restore ? 'Undo' : 'Restore', on: { click: function () { confirmRestore(ev, item); } } }),
        item.querySelector('.ago'));
    } else if (remoteOff(ev)) {
      item.querySelector('.row').insertBefore(
        el('button', { class: 'mini rst', type: 'button', text: 'Restore', disabled: 'disabled', title: remoteOff(ev) }),
        item.querySelector('.ago'));
    } else if (canRemove(ev)) {
      item.querySelector('.row').insertBefore(seqButton(
        el('button', { class: 'mini rst', type: 'button', title: 'Delete the file this edit created', text: 'Remove file', on: { click: function () { confirmRemove(ev, item); } } }), ev),
        item.querySelector('.ago'));
    } else if (ev.backupSkipped && !ev.copy && !ev.task && (!ev.remote || remoteRef(ev))) {
      item.appendChild(el('div', { class: 'enote', text: ev.backupSkipped === 'secret' ? 'A key or credentials file: its lines are not shown and no copy is kept, so no Restore.'
        : ev.backupSkipped === 'large' ? 'No earlier copy kept, so no Restore: the file is over 2 MB.' : 'No earlier copy kept, so no Restore: the file is binary.' }));
    } else if (ev.created && !restore && !ev.copy && !ev.task && !ev.remote) {
      item.appendChild(el('div', { class: 'enote', text: 'New file: delete it to undo this edit.' }));
    }
    if (ev.backup) backupCards[ev.backup] = { ev: ev, item: item, by: null };
    else if (canRemove(ev)) createdCards[seqKey(ev, ev.seq)] = { ev: ev, item: item, by: null };
    if (restore) noteRestore(ev);
    item.appendChild(renderDiff(ev.hunks, ev.truncated));
    item.addEventListener('click', function (e) {
      if (e.target.closest && (e.target.closest('.diff') || e.target.closest('.mini') || e.target.closest('.rconf'))) return;
      item.classList.toggle('open');
      lookedAt(ev);
      if (item.classList.contains('open')) selectEdit(ev, true);
      else if (sel.card === item) clearSelection();
    });
    item.setAttribute('data-owner', owner);
    var byFile = editsBy[owner] || (editsBy[owner] = {});
    var fk = ev.relFile || ev.file || '';
    if (fk) byFile[fk] = (byFile[fk] || 0) + 1;
    swSoon();
    cardOf.set(ev, item);
    cardEv.set(item, ev);
    peekRemember(ev);
    if (posInt(ev.seq) > 0 && seqKey(ev, ev.seq) === pendingSel) {
      pendingSel = '';
      item.classList.add('open');
      setTimeout(function () { selectEdit(ev, false); }, OPTS.settle);
    }
    append(item, fresh);
  }

  // "Restore" (edit card, hover card, Changes list, code view header) returns the file to how it was
  // before that edit (the live server keeps a copy). It asks first and keeps the current file, so the
  // restore can be undone. The restore arrives as an edit of kind 'restore', the same in every tab.
  var backupCards = Object.create(null); // backup id -> { ev, item, by: the restore that undid it, or null }
  var createdCards = Object.create(null); // seq of an edit that created a file -> { ev, item, by }
  var goneBackups = Object.create(null); // backup ids the server no longer keeps
  var GONE_MAX = 1000;
  var restoring = Object.create(null); // backup id -> its request, while it runs
  var GONE_TEXT = 'Earlier version no longer kept (EditLens keeps the last 200).';
  // A restore is highlighted, and marked, in this color (the theme's teal) instead of Claude's.
  var RESTORE_COLOR = 'var(--rst)';
  function restoreLabel(ev) {
    return ev.via === 'merge-undo' ? 'Merge undone' : ev.via === 'remove' ? 'Removed' : ev.via === 'undo' ? 'Undone' : ev.via === 'undo-edit' ? 'Undone (only this edit)' : 'Restored';
  }
  function canRemove(ev) {
    return Boolean(ev.created && !ev.deleted && ev.kind !== 'restore' && posInt(ev.seq) > 0 && !ev.earlier && !ev.copy && !ev.task && (!ev.remote || remoteRef(ev)));
  }
  // Edit numbers start again from 1 when EditLens restarts. A request that names an edit by number
  // also sends the server start it came from (ev.inst), and buttons for older edits are off.
  var OLD_EDIT = 'From before EditLens restarted: reload the page to change it';
  function fromOldStart(ev) {
    return Boolean(ev && state.instance && ev.inst !== state.instance);
  }
  function seqBody(ev, body) {
    if (ev && ev.inst) body.instance = ev.inst;
    return body;
  }
  // The key of an edit by number in createdCards: numbers repeat after a restart.
  function seqKey(ev, seq) {
    return (ev && ev.inst ? ev.inst : '') + '.' + posInt(seq); // never "NaN" or "Infinity"
  }
  // A button that sends an edit number: marked with its server start, and off when that is an old one.
  function seqButton(btn, ev) {
    btn.setAttribute('data-einst', ev && ev.inst ? ev.inst : '');
    if (fromOldStart(ev)) {
      btn.disabled = true;
      btn.title = OLD_EDIT;
    }
    return btn;
  }
  // EditLens restarted: every button that sends an edit number from the old start is turned off.
  function oldEditsOff() {
    [root, pop.panel && pop.panel.root, pop.dock && pop.dock.root].forEach(function (r) {
      if (!r) return;
      Array.prototype.forEach.call(r.querySelectorAll('[data-einst]'), function (b) {
        if (b.getAttribute('data-einst') === state.instance) return;
        b.disabled = true;
        b.title = OLD_EDIT;
      });
    });
    restoreStateChanged();
  }
  // ---------- edits made on a paired computer: Restore runs there (its server does all checks) ----------
  // True when its EditLens sent what is needed to restore this edit.
  function remoteRef(ev) {
    return Boolean(ev && ev.remote && ev.remote.ref);
  }
  // Why Restore is off for an edit made on a paired computer, or '': its EditLens is too old.
  // (Not connected is known only when asked: the check says so.)
  function remoteOff(ev) {
    var r = ev && ev.remote;
    if (!r || !r.old || r.kind !== 'session' || ev.kind === 'restore') return '';
    return 'Update EditLens on ' + (r.computer || 'the paired computer') + ' to restore its edits.';
  }
  // A restore by copy id. For a paired computer's edit, its edit number is sent too, so this page's
  // server knows which computer to ask.
  function idBody(ev, body) {
    if (ev && ev.remote) {
      body.remote = true;
      body.edit = posInt(ev.seq);
      seqBody(ev, body);
    }
    return body;
  }
  function cardState(ev) {
    if (!ev) return null;
    if (ev.backup) return backupCards[ev.backup] || null;
    return posInt(ev.seq) > 0 ? createdCards[seqKey(ev, ev.seq)] || null : null;
  }
  // The restore that undid this edit (it is no longer in the file), or null.
  function restoredBy(ev) {
    var c = cardState(ev);
    return c ? c.by : null;
  }
  // What Restore on this edit does now: { id, undo } (undo: it puts back what a restore replaced), or null.
  function restoreTarget(ev) {
    var off = remoteOff(ev);
    if (off) return { id: null, undo: false, off: off };
    var c = cardState(ev);
    var id = c && c.by ? c.by.backup : ev && ev.backup;
    if (!id || goneBackups[id]) return null;
    return { id: id, undo: Boolean(c && c.by) || ev.kind === 'restore' };
  }
  function restoreButtonText(ev) {
    var t = restoreTarget(ev);
    var by = restoredBy(ev);
    if (!t) return canRemove(ev) && !by ? 'Remove file' : '';
    if (by) return by.via === 'undo' ? 'Redo' : by.via === 'undo-edit' ? 'Put it back' : 'Undo restore';
    return t.undo ? 'Undo' : 'Restore';
  }
  function restoreSource(r) {
    if (r.via === 'remove') return createdCards[seqKey(r, r.removedSeq)] || null;
    // "Undo only this edit": the card of the edit it removed (found by undidBackup, also after a restart).
    if (r.via === 'undo-edit') return r.undidBackup ? backupCards[r.undidBackup] || null : null;
    return r.restoredFrom ? backupCards[r.restoredFrom] || null : null;
  }
  // A restore arrived (live or from history): mark the card of the edit it restored, and when it
  // undoes another restore, that restore's edit is in the file again.
  function noteRestore(r) {
    var target = restoreSource(r);
    if (!target) return;
    var prev = target.ev.kind === 'restore' ? restoreSource(target.ev) : null;
    if (prev && prev.by === target.ev) setRestored(prev, null);
    setRestored(target, r);
  }
  function setRestored(c, r) {
    c.by = r;
    var item = c.item;
    item.classList.toggle('restored', Boolean(r));
    var tag = item.querySelector('.rtag');
    if (r) {
      if (!tag) {
        tag = el('span', { class: 'tool rtag' });
        item.querySelector('.row').insertBefore(tag, item.querySelector('.stat'));
      }
      tag.textContent = r.via === 'undo' || r.via === 'undo-edit' ? 'Undone' : r.via === 'remove' ? 'Removed' : r.via === 'merge-undo' ? 'Merge undone' : 'Restored';
      tag.title = (r.intent || 'Restored') + (clock(r.ts) ? ' at ' + clock(r.ts) : '');
    } else if (tag) tag.remove();
    undidLine(c, r && r.via === 'undo-edit' ? r : null);
    if (r) clearUndoAsked(c.ev);
    refreshRestoreButton(c);
    restoreStateChanged();
  }
  function refreshRestoreButton(c) {
    var box = c.item.querySelector('.rconf');
    if (box) box.remove();
    var btn = c.item.querySelector('.rst');
    var text = restoreButtonText(c.ev);
    if (btn && !text) btn.remove();
    else if (btn) {
      btn.textContent = text;
      // The "✓ Undid only this edit" line has its own Put it back.
      btn.hidden = Boolean(c.by && c.by.via === 'undo-edit');
    }
  }
  // The server no longer keeps this copy: no Restore for it anywhere, and the card says why.
  function markGone(id) {
    if (!id || goneBackups[id]) return;
    // Only the newest ids: an older one is asked again, and the server says again it is gone.
    var gone = Object.keys(goneBackups);
    if (gone.length >= GONE_MAX) gone.slice(0, gone.length - GONE_MAX + 1).forEach(function (g) { delete goneBackups[g]; });
    goneBackups[id] = true;
    [backupCards, createdCards].forEach(function (map) {
      Object.keys(map).forEach(function (k) {
        var c = map[k];
        if (c.ev.backup !== id && !(c.by && c.by.backup === id)) return;
        refreshRestoreButton(c);
        if (c.ev.backup === id && !c.item.querySelector('.enote.gone')) c.item.appendChild(el('div', { class: 'enote gone', text: GONE_TEXT }));
      });
    });
    restoreStateChanged();
  }
  // Edit cards no longer in the feed: the edit no longer points to its card (removed: the items just
  // taken from the feed), and the Restore state goes once the Changes list no longer lists the edit.
  function forgetEditCards(removed) {
    (removed || []).forEach(function (node) {
      var ev = cardEv.get(node);
      if (ev && cardOf.get(ev) === node) cardOf.delete(ev);
    });
    [backupCards, createdCards].forEach(function (map) {
      Object.keys(map).forEach(function (k) {
        var c = map[k];
        if (c.item.isConnected || changes.indexOf(c.ev) >= 0) return;
        delete map[k];
        delete undoAsked[editKey(c.ev)];
      });
    });
  }
  // The Changes list, the hover card and the code view header are updated from the cards.
  function restoreStateChanged() {
    if (changesList.classList.contains('on')) renderChanges();
    if (peek.key && peekCard.classList.contains('on')) renderPeek();
    paneRestoreSoon();
  }

  function confirmRestore(ev, item) {
    var old = item.querySelector('.rconf');
    if (old) return old.remove();
    if (!restoreTarget(ev)) return canRemove(ev) && !restoredBy(ev) ? confirmRemove(ev, item) : null;
    var box = restoreQuestion(ev, function () { box.remove(); });
    if (box) item.appendChild(box);
  }
  // A confirm box focuses Cancel once it is on the page, so Enter never confirms by accident.
  function focusCancel(box, cancel) {
    Promise.resolve().then(function () { if (box.isConnected) cancel.focus(); });
  }
  // The question asked before a restore, with its buttons. done(ok) is called when it closes.
  function restoreQuestion(ev, done) {
    var t = restoreTarget(ev);
    if (!t || t.off) return null;
    var name = ev.relFile || ev.file || 'this file';
    var by = restoredBy(ev);
    var putBack = Boolean(t.undo && by && by.via === 'undo-edit');
    var rq = el('div', { class: 'rq', text: putBack
      ? 'Put this edit back in ' + name + '? The file is restored to how it was before the undo. The current version is kept, so you can undo this.'
      : t.undo
        ? 'Put ' + name + ' back as it was before the restore? The current version is kept, so you can undo this.'
        : 'Put ' + name + ' back as it was before this edit? Later changes to it are undone too. The current version is kept, so you can undo this.' });
    var box = el('div', { class: 'rconf', role: 'group' }, rq);
    // No copy of the current file can be kept (over 2 MB, or not text): asked again, and sent with
    // noUndo only after this question (Sol 0.24.46 M6).
    var noUndo = false;
    function askNoUndo(why) {
      noUndo = true;
      box.classList.add('nound');
      rq.textContent = noUndoText(name, why) + ' ' + (putBack ? 'Put this edit back anyway?' : t.undo ? 'Undo the restore anyway?' : 'Restore it anyway?') + ' This can\'t be undone.';
      go.textContent = putBack ? 'Put back without Undo' : t.undo ? 'Undo without Redo' : 'Restore without Undo';
      go.classList.remove('allow');
      go.classList.add('deny');
    }
    var go = el('button', { class: 'mini allow', type: 'button', text: putBack ? 'Put it back' : t.undo ? 'Undo' : 'Restore', on: { click: function (e) {
      e.stopPropagation();
      if (go.disabled) return;
      go.disabled = true;
      restoreBackup(t.id, name, ev, { noUndo: noUndo, onNoUndo: askNoUndo }).then(function (ok) {
        if (ok) done(true);
        else go.disabled = Boolean(goneBackups[t.id]);
      });
    } } });
    go.disabled = true; // on once the check below says the restore can be done
    var cancel = el('button', { class: 'mini', type: 'button', text: 'Cancel', on: { click: function (e) { e.stopPropagation(); done(false); } } });
    // Only for a plain Restore of Claude's edit: a card that undoes something has no single edit to remove.
    var only = !t.undo && canUndoOnly(ev) ? undoOnlyButton(ev, name, box, done) : null;
    box.appendChild(el('div', { class: 'pacts' }, go, only, cancel));
    focusCancel(box, cancel);
    // What it would do: the file may be gone (moved or deleted), read-only, or already like that.
    postJson('/restore', idBody(ev, { page: PAGE_ID, id: t.id, check: true })).then(function (c) {
      if (!box.isConnected) return;
      box.setAttribute('data-check', 'done');
      go.disabled = false;
      if (c.blocked) {
        // A paired computer that is not connected, or too old: off, with the reason.
        rq.textContent = c.error || 'This edit can\'t be restored now.';
        go.disabled = true;
        go.title = rq.textContent;
      } else if (c.readOnly) {
        rq.textContent = name + ' is read-only, so it can\'t be put back. Make it writable, then try again.';
        go.disabled = true;
      } else if (c.same) {
        rq.textContent = name + ' is already like that. There is nothing to put back.';
        go.disabled = true;
      } else if (c.noUndo) {
        askNoUndo(c.noUndo);
      } else if (c.exists === false) {
        rq.textContent = name + ' no longer exists (it was moved or deleted). ' + (t.undo ? 'Undo' : 'Restore') + ' creates it again.';
      }
    }, function (err) {
      box.setAttribute('data-check', 'done');
      if (err && err.status === 404 && err.body && err.body.gone) {
        markGone(t.id);
        if (box.isConnected) rq.textContent = GONE_TEXT;
        return;
      }
      // Any other failure: Restore stays off, with the reason. Opening the question again checks again.
      if (!box.isConnected) return;
      rq.textContent = restoreError(err, t.id);
      go.title = rq.textContent;
    });
    return box;
  }
  // ---------- "Undo only this edit": removes this edit from the file and keeps later changes ----------
  // When a later edit changed the same lines, only Claude can do it: the button sends it a fixed
  // message (built by the live server) through the page's normal message path, after a click.
  var UNDO_ONLY = 'Undo only this edit';
  var CONFLICT_TEXT = 'A later edit changed the same lines, so only Claude can undo just this part.';
  var undoAsked = Object.create(null); // edit key -> file key, set by "Ask Claude to undo it"
  function canUndoOnly(ev) {
    return Boolean(ev && ev.kind !== 'restore' && ev.backup && posInt(ev.seq) > 0 && !ev.copy && !ev.task && (!ev.remote || remoteRef(ev)) && !restoredBy(ev));
  }
  function undoFileKey(ev) {
    return String(ev.file || ev.relFile || '').replace(/\\/g, '/');
  }
  // Why this page can't send Claude a message, or ''.
  function messageBlocked() {
    if (!state.connected) return 'Not connected to ' + PANEL_NAME + ', so this page can\'t message Claude.';
    if (!noRootEl.hidden || input.disabled) return 'This page can\'t message Claude: it is not linked to your project. Run /editlens in Claude Code in your project folder.';
    return '';
  }
  function undoOnlyButton(ev, name, box, done) {
    var cleanTitle = 'Remove only this edit from ' + name + '. Later changes to it stay.';
    var btn = el('button', { class: 'mini uonly', type: 'button', text: UNDO_ONLY, title: 'Checking whether this edit can be undone on its own.', disabled: 'disabled', 'data-mode': 'checking',
      'data-einst': ev.inst || '' });
    var mode = 'checking'; // 'clean' | 'conflict' | 'off'
    function setMode(m) {
      mode = m;
      btn.setAttribute('data-mode', m);
    }
    var message = '';
    function conflict(msg) {
      setMode('conflict');
      message = typeof msg === 'string' ? msg : '';
      btn.textContent = 'Ask Claude to undo it';
      if (!box.querySelector('.rdim')) box.querySelector('.pacts').before(el('div', { class: 'rdim', text: CONFLICT_TEXT }));
      // This page can message only Claude on this computer; the edit was made by Claude there.
      var why = fromOldStart(ev) ? OLD_EDIT : ev.remote ? 'This edit was made on ' + (ev.remote.computer || 'the paired computer') + '. Ask Claude there.'
        : messageBlocked() || (message ? '' : 'EditLens could not build the message for Claude. Try again.');
      btn.disabled = Boolean(why);
      btn.title = why || 'Send Claude this message: ' + message;
    }
    function off(why) {
      setMode('off');
      btn.disabled = true;
      btn.title = why;
    }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (btn.disabled) return;
      if (fromOldStart(ev)) return off(OLD_EDIT);
      btn.disabled = true;
      if (mode === 'clean') {
        postJson('/restore', seqBody(ev, { page: PAGE_ID, undoEdit: posInt(ev.seq) })).then(function (r) {
          showToast(r.text || 'Undid only this edit. Later changes kept.', 4000);
          done(true);
        }, function (err) {
          if (err && err.body && err.body.conflict) return conflict(err.body.message);
          if (err && err.body && noUndoWhy(err.body.noUndo)) return off(noUndoText(name, err.body.noUndo) + ' Use Restore instead.');
          btn.disabled = false;
          showToast(restoreError(err, ev.backup), 6000);
        });
      } else if (mode === 'conflict') {
        if (ev.remote) return;
        var why = messageBlocked();
        if (why) return off(why);
        var body = { text: message, pageId: PAGE_ID };
        (driving() ? driveRequest('/drive/message', body) : postJson('/message', body)).then(function () {
          markUndoAsked(ev);
          done(true);
        }, function (err) {
          btn.disabled = false;
          showToast('Could not send: ' + (err && err.message ? err.message : 'unknown error'), 6000);
        });
      }
    });
    if (fromOldStart(ev)) {
      off(OLD_EDIT);
      return btn;
    }
    postJson('/restore', seqBody(ev, { page: PAGE_ID, undoEdit: posInt(ev.seq), check: true })).then(function (c) {
      if (!box.isConnected) return;
      if (fromOldStart(ev)) return off(OLD_EDIT);
      if (c.conflict) return conflict(c.message);
      if (!c.ok) return off(c.error || 'This edit can\'t be undone on its own.');
      if (c.same) return off('This edit is no longer in ' + name + '.');
      if (noUndoWhy(c.noUndo)) return off(noUndoText(name, c.noUndo) + ' Use Restore instead.');
      setMode('clean');
      btn.title = cleanTitle;
      btn.disabled = false;
    }, function (err) {
      off((ev.remote ? '' : messageBlocked()) || (err && err.message ? err.message : 'Could not check this edit.'));
    });
    return btn;
  }
  // The edit card says it was removed, with Put it back (the copy kept just before).
  function undidLine(c, r) {
    var line = c.item.querySelector('.enote.undid');
    if (!r) {
      if (line) line.remove();
      return;
    }
    if (line) return;
    var noUndo = false; // set once the live server said no copy of the file can be kept; the user is asked
    var said = el('span', { text: '✓ Undid only this edit. Later changes kept. ' });
    var back = seqButton(el('button', { class: 'mini', type: 'button', text: 'Put it back', title: 'Put this edit back in the file', on: { click: function (e) {
      e.stopPropagation();
      if (back.disabled || fromOldStart(c.ev)) return;
      back.disabled = true;
      postJson('/restore', seqBody(c.ev, { page: PAGE_ID, undoEdit: posInt(c.ev.seq), back: true, noUndo: noUndo || undefined })).then(function (res) {
        showToast(res.text || 'Put the edit back.', 4000);
      }, function (err) {
        back.disabled = false;
        var why = err && err.body ? noUndoWhy(err.body.noUndo) : null;
        if (!why || noUndo) return showToast(restoreError(err, r.backup), 6000);
        noUndo = true;
        said.textContent = noUndoText(c.ev.relFile || c.ev.file || 'This file', why) + ' Put this edit back anyway? This can\'t be undone. ';
        back.textContent = 'Put back without Undo';
        back.classList.add('deny');
      });
    } } }), c.ev);
    c.item.appendChild(el('div', { class: 'enote undid' }, said, back));
  }
  function markUndoAsked(ev) {
    undoAsked[editKey(ev)] = undoFileKey(ev);
    var card = cardOf.get(ev);
    if (card && !card.querySelector('.uask')) card.querySelector('.row').insertBefore(el('span', { class: 'tool uask', text: 'Claude is undoing it' }), card.querySelector('.stat'));
    restoreStateChanged();
  }
  function clearUndoAsked(ev) {
    var k = editKey(ev);
    if (!undoAsked[k]) return;
    delete undoAsked[k];
    var card = cardOf.get(ev);
    var chip = card && card.querySelector('.uask');
    if (chip) chip.remove();
  }
  // The next edit to that file (Claude's or a restore) ends "Claude is undoing it".
  function undoAskedEdit(ev) {
    var f = undoFileKey(ev);
    if (!f) return;
    Object.keys(undoAsked).forEach(function (k) {
      if (undoAsked[k] !== f) return;
      delete undoAsked[k];
      Array.prototype.forEach.call(feedEl.querySelectorAll('.uask'), function (chip) {
        var card = chip.closest('.k-edit');
        if (card && card.getAttribute('data-ekey') === k) chip.remove();
      });
    });
  }
  function isUndoAsked(ev) {
    return Boolean(undoAsked[editKey(ev)]);
  }
  // ev: the card it is for (a paired computer's edit is restored there). opts.noUndo: the user chose
  // to write with no Undo copy; opts.onNoUndo(why): called instead of a message when the live server
  // refuses because no copy of the current file can be kept.
  function restoreBackup(id, name, ev, opts) {
    if (restoring[id]) return restoring[id];
    var o = opts || {};
    var p = postJson('/restore', idBody(ev, { page: PAGE_ID, id: id, noUndo: o.noUndo === true || undefined })).then(function (r) {
      var rel = r.relFile || name;
      if (r.same) showRestored(rel + ' was already like that.', null, rel, '');
      else if (r.via === 'undo') showRestored('Undid the restore of ' + rel + '.', r.undo, rel, 'Redo', ev);
      else showRestored('Restored ' + rel + '.', r.undo, rel, 'Undo', ev);
      return true;
    }, function (err) {
      var why = err && err.body ? noUndoWhy(err.body.noUndo) : null;
      if (why && o.onNoUndo) o.onNoUndo(why);
      else showToast(restoreError(err, id), 6000);
      return false;
    }).then(function (ok) {
      delete restoring[id];
      return ok;
    });
    restoring[id] = p;
    return p;
  }
  // Why no Undo copy of the current file can be kept ('large' | 'binary'), from the live server, or null.
  function noUndoWhy(v) {
    return v === 'large' || v === 'binary' ? v : null;
  }
  function noUndoText(name, why) {
    return name + (why === 'binary' ? ' is not a text file' : ' is over 2 MB') + ', so its current version can\'t be kept for Undo.';
  }
  function restoreError(err, id) {
    if (err && err.status === 404 && err.body && err.body.gone) {
      markGone(id);
      return 'Could not restore: ' + GONE_TEXT;
    }
    if (err && err.name === 'TypeError') return 'Could not restore: the EditLens live server isn\'t running. Start Claude Code in this project, then try again.';
    if (err && err.name === 'SyntaxError') return 'Could not restore: the EditLens live server gave an answer it could not read. Try again.';
    return 'Could not restore: ' + (err && err.message ? err.message : 'unknown error');
  }
  // A file Claude created: Remove file deletes it (the live server keeps its text, so it can be undone).
  function confirmRemove(ev, item) {
    var old = item.querySelector('.rconf');
    if (old) return old.remove();
    var name = ev.relFile || ev.file || 'this file';
    var box = el('div', { class: 'rconf', role: 'group' },
      el('div', { class: 'rq', text: 'Delete ' + name + '? This edit created it. A copy is kept, so you can undo this.' }));
    // No copy can be kept (over 2 MB, or not text): asked again, and removed only after that.
    var noUndo = false;
    function askNoUndo(why) {
      noUndo = true;
      box.classList.add('nound');
      box.querySelector('.rq').textContent = 'Delete ' + name + '? It ' + (why === 'binary' ? 'is not a text file' : 'is over 2 MB') + ', so no copy can be kept for Undo. This can\'t be undone.';
      go.textContent = 'Remove without Undo';
      go.classList.remove('allow');
      go.classList.add('deny');
    }
    var go = seqButton(el('button', { class: 'mini allow', type: 'button', text: 'Remove file', on: { click: function (e) {
      e.stopPropagation();
      if (go.disabled || fromOldStart(ev)) return;
      go.disabled = true;
      postJson('/restore', seqBody(ev, { page: PAGE_ID, remove: posInt(ev.seq), noUndo: noUndo || undefined })).then(function (r) {
        box.remove();
        showRestored('Removed ' + (r.relFile || name) + '.', r.undo, r.relFile || name, 'Undo', ev);
      }, function (err) {
        go.disabled = false;
        var why = err && err.body ? noUndoWhy(err.body.noUndo) : null;
        if (why && !noUndo) return askNoUndo(why);
        showToast(err && err.name === 'TypeError' ? 'Could not remove the file: the EditLens live server isn\'t running.' : 'Could not remove the file: ' + (err && err.message ? err.message : 'unknown error'), 6000);
      });
    } } }), ev);
    var cancel = el('button', { class: 'mini', type: 'button', text: 'Cancel', on: { click: function (e) { e.stopPropagation(); box.remove(); } } });
    box.appendChild(el('div', { class: 'pacts' }, go, cancel));
    item.appendChild(box);
    focusCancel(box, cancel);
    // A paired computer's file: first check that the file can be removed there. Any file: whether a
    // copy can be kept (Remove stays on here while that is checked; the live server checks again).
    if (fromOldStart(ev) || go.disabled) return;
    if (ev.remote) go.disabled = true;
    postJson('/restore', seqBody(ev, { page: PAGE_ID, remove: posInt(ev.seq), check: true })).then(function (c) {
      if (!box.isConnected || fromOldStart(ev)) return;
      if (ev.remote && (c.blocked || !c.ok || c.exists === false)) {
        var why = c.exists === false && c.ok ? name + ' is already gone.' : c.error || 'This file can\'t be removed now.';
        box.querySelector('.rq').textContent = why;
        go.title = why;
        return;
      }
      if (noUndoWhy(c.noUndo) && !noUndo) askNoUndo(c.noUndo);
      if (ev.remote) go.disabled = false;
    }, function (err) {
      if (!ev.remote) return;
      go.title = err && err.message ? err.message : 'Could not check this file.';
      box.querySelector('.rq').textContent = go.title;
    });
  }
  function showRestored(text, undo, name, undoLabel, ev) {
    var where = toastHost();
    if (toast.parentNode !== where) where.appendChild(toast);
    toast.replaceChildren(document.createTextNode(text + ' '));
    if (undo) {
      var b = el('button', { class: 'mini', type: 'button', text: undoLabel || 'Undo', on: { click: function () {
        // Only one request, even with fast repeated clicks.
        if (b.disabled) return;
        b.disabled = true;
        toast.classList.remove('on');
        restoreBackup(undo, name, ev);
      } } });
      toast.appendChild(b);
    }
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('on'); }, undo ? 8000 : 2600);
  }
  // After a reload for a backend change: what changed, with a Show code button.
  function showReloadToast(label, ev) {
    var where = toastHost();
    if (toast.parentNode !== where) where.appendChild(toast);
    var btn = el('button', { class: 'mini', type: 'button', text: 'Show code' });
    btn.addEventListener('click', function () {
      clearTimeout(toastTimer);
      peekFromButton(ev, btn);
    });
    toast.replaceChildren(document.createTextNode(label + ' '), btn);
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (!peek.pinned) toast.classList.remove('on'); }, 8000);
  }

  function backendUses(ev) {
    var hits = pagePathsFor(ev.routes);
    var box = el('div', { class: 'uses' });
    ev.routes.slice(0, 4).forEach(function (r) {
      var hit = hits.some(function (h) { return h.route === r; });
      box.appendChild(el('span', { class: 'route' + (hit ? ' hit' : ''), title: hit ? 'This page calls this route' : 'Route this change affects', text: r }));
    });
    if (hits.length) {
      box.appendChild(el('span', { text: 'used by this page' }));
      box.appendChild(el('button', { class: 'mini', type: 'button', text: 'Reload', on: { click: function () { location.reload(); } } }));
    }
    return box;
  }

  function highlightBackend(ev, scrollIfHidden) {
    var hits = pagePathsFor(ev.routes);
    if (!hits.length) return 0;
    var els = elementsForPaths(hits);
    return highlight(els, { label: hits[0].method + ' ' + hits[0].path + ' changed', color: COLORS.blue, scroll: scrollIfHidden, ev: ev });
  }

  // ---------- recent DOM changes: what the page changed recently ----------
  var mutations = [];
  function isOurs(node) {
    return node === host || (node && node.nodeType === 1 && host.contains(node));
  }
  var IGNORED_TAGS = { HTML: 1, HEAD: 1, BODY: 1, SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, TITLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  function elementFor(node) {
    var e = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!e || isOurs(e) || IGNORED_TAGS[e.tagName]) return null;
    if (e.closest && e.closest('head')) return null;
    return e;
  }
  // Records are handled together a moment later (an app that animates a style every frame makes
  // one pass, not one per frame), and each element counts once per pass.
  var pendingRecords = [];
  var recordsTimer = null;
  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) pendingRecords.push(records[i]);
    if (pendingRecords.length > 5000) pendingRecords.splice(0, pendingRecords.length - 5000);
    if (!recordsTimer) recordsTimer = setTimeout(takeRecords, 50);
  });
  function takeRecords() {
    clearTimeout(recordsTimer);
    recordsTimer = null;
    var records = pendingRecords.splice(0).concat(observer.takeRecords());
    if (records.length) onMutations(records);
  }
  function onMutations(records) {
    var now = Date.now();
    var seenNow = new Set();
    var changed = [];
    var add = function (e) {
      if (e && !seenNow.has(e)) {
        seenNow.add(e);
        changed.push(e);
      }
    };
    records.forEach(function (r) {
      if (r.type === 'childList') {
        r.addedNodes.forEach(function (n) {
          if (n.nodeType === 3 && !n.nodeValue.trim()) return;
          add(elementFor(n));
        });
      } else {
        add(elementFor(r.target));
      }
    });
    changed.forEach(function (e) { mutations.push({ t: now, el: e }); });
    peekNoteRemoved(records, now);
    if (changed.length) attributeToRequests(changed, now);
    if (changed.length && sel.key) refreshSelectionSoon();
    if (changed.length && learn) learnSoon();
    var cutoff = now - MUTATION_MEMORY_MS;
    while (mutations.length && mutations[0].t < cutoff) mutations.shift();
    if (mutations.length > 600) mutations.splice(0, mutations.length - 600);
  }

  function changedElementsSince(t) {
    takeRecords(); // what changed just now counts too
    var seen = new Set();
    mutations.forEach(function (m) { if (m.t >= t && m.el.isConnected) seen.add(m.el); });
    var list = Array.from(seen);
    // Keep the outermost changed elements: one box per changed region.
    return list.filter(function (e) {
      return !list.some(function (o) { return o !== e && o.contains(e); });
    });
  }

  function safeQueryAll(selector) {
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch (err) {
      if (err && err.name === 'SyntaxError') return []; // SCSS nesting, :global(), etc.
      throw err;
    }
  }
  function cleanSelector(sel) {
    // Remove pseudo-elements and state pseudo-classes so ".btn:hover::after" still finds .btn.
    return String(sel).replace(/::?(before|after|placeholder|selection|marker|backdrop|first-line|first-letter)\b/g, '')
      .replace(/:(hover|focus|focus-visible|focus-within|active|visited)\b/g, '').trim();
  }
  function findByText(text, limit) {
    var out = [];
    if (!document.body || !text) return out;
    var needle = String(text).toLowerCase();
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var n;
    var steps = 0;
    while ((n = walker.nextNode()) && steps++ < 8000 && out.length < limit) {
      if (n.nodeValue.toLowerCase().indexOf(needle) >= 0) {
        var e = elementFor(n);
        if (e && out.indexOf(e) < 0) out.push(e);
      }
    }
    return out;
  }
  function usable(e) {
    return !isOurs(e) && !IGNORED_TAGS[e.tagName];
  }
  function elementsFromHints(hints) {
    hints = hints || {};
    var found = [];
    function add(list) { list.forEach(function (e) { if (found.indexOf(e) < 0 && usable(e)) found.push(e); }); }
    (hints.selectors || []).forEach(function (s) {
      var c = cleanSelector(s);
      if (c && c !== 'html' && c !== 'body' && c !== ':root' && c !== '*') add(safeQueryAll(c));
    });
    (hints.ids || []).forEach(function (id) { var e = document.getElementById(id); if (e) add([e]); });
    if (!found.length) (hints.texts || []).forEach(function (t) { add(findByText(t, 4)); });
    if (!found.length) (hints.classes || []).forEach(function (c) { if (/^-?[A-Za-z_][\w-]*$/.test(c)) add(safeQueryAll('.' + c)); });
    return found;
  }

  var boxes = []; // edit/backend highlights (short-lived)
  var points = []; // Claude's deliberate highlights
  var rafId = 0;
  function visible(e) {
    var r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function place(b) {
    var r = b.target.getBoundingClientRect();
    var pad = 4;
    b.node.style.left = (r.left - pad) + 'px';
    b.node.style.top = (r.top - pad) + 'px';
    b.node.style.width = (r.width + pad * 2) + 'px';
    b.node.style.height = (r.height + pad * 2) + 'px';
    if (b.tag) b.tag.classList.toggle('below', r.top < (b.tag.classList.contains('note') ? 70 : 30));
  }
  function track() {
    placeMarkersSoon();
    boxes.forEach(place);
    points.forEach(place);
    sel.boxes.forEach(place);
    updateEdges();
    rafId = boxes.length || points.length || sel.boxes.length ? requestAnimationFrame(track) : 0;
  }
  function startTracking() {
    if (!rafId) rafId = requestAnimationFrame(track);
  }
  function clearBoxes() {
    boxes.forEach(function (b) { b.node.remove(); });
    boxes = [];
    updateEdges();
  }
  function clearPoints() {
    points.forEach(function (b) { b.node.remove(); });
    points = [];
  }
  function onScreen(b) {
    var r = b.target.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }
  // Show: scrolls an outlined element into the visible page area (not under the code view) and
  // pulses it, so the click is visible even when nothing can scroll.
  function inPageArea(target) {
    var a = pageArea();
    var r = target.getBoundingClientRect();
    var tall = r.height > a.bottom - a.top - 16;
    return (tall ? r.top >= a.top && r.top < a.bottom - 40 : r.top >= a.top + 8 && r.bottom <= a.bottom - 8) && r.right > a.left && r.left < a.right;
  }
  function underPanel(target) {
    if (state.panel !== 'open' || pop.panel) return false;
    var p = panel.getBoundingClientRect();
    var r = target.getBoundingClientRect();
    var w = Math.max(0, Math.min(r.right, p.right) - Math.max(r.left, p.left));
    var h = Math.max(0, Math.min(r.bottom, p.bottom) - Math.max(r.top, p.top));
    var area = Math.max(1, r.width * r.height);
    return (w * h) / area > 0.3;
  }
  var thruTimer = 0;
  function seeThrough() {
    panel.classList.add('thru');
    clearTimeout(thruTimer);
    thruTimer = setTimeout(function () { panel.classList.remove('thru'); }, 2600);
  }
  panel.addEventListener('pointerenter', function () {
    clearTimeout(thruTimer);
    panel.classList.remove('thru');
  });
  function revealBox(b) {
    if (!b || !b.target || b.target.isConnected === false) return;
    var a = pageArea();
    var tall = b.target.getBoundingClientRect().height > a.bottom - a.top - 16;
    if (!inPageArea(b.target) && b.target.scrollIntoView) {
      var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      b.target.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: tall ? 'start' : 'center', inline: 'nearest' });
    }
    // An element under the panel can't be scrolled out from under it, so make the panel see-through.
    setTimeout(function () { if (b.target.isConnected !== false && underPanel(b.target)) seeThrough(); }, inPageArea(b.target) ? 0 : 450);
    if (!b.node) return;
    b.node.classList.remove('hit');
    void b.node.offsetWidth; // restart the pulse on a second click
    b.node.classList.add('hit');
    clearTimeout(b.hitTimer);
    b.hitTimer = setTimeout(function () { b.node.classList.remove('hit'); }, 1800);
  }
  function updateEdges() {
    var above = false;
    var below = false;
    boxes.forEach(function (b) {
      var r = b.target.getBoundingClientRect();
      if (r.bottom < 0) above = true;
      else if (r.top > window.innerHeight) below = true;
    });
    var anyOn = boxes.some(onScreen);
    edgeTop.classList.toggle('on', above && !anyOn);
    edgeBottom.classList.toggle('on', below && !anyOn);
  }
  function scrollToFirst() {
    revealBox(boxes[0]);
  }
  edgeTop.addEventListener('click', scrollToFirst);
  edgeBottom.addEventListener('click', scrollToFirst);

  function flyCursorTo(target, color) {
    var r = target.getBoundingClientRect();
    var p = panel.getBoundingClientRect();
    var here = state.panel === 'open' && !pop.panel;
    var startX = here ? p.left + 20 : window.innerWidth - 40;
    var startY = here ? p.top + 20 : window.innerHeight - 30;
    cursor.style.color = color || '';
    cursor.style.transition = 'none';
    cursor.style.left = startX + 'px';
    cursor.style.top = startY + 'px';
    cursor.getBoundingClientRect(); // commit start position before animating
    cursor.style.transition = '';
    cursor.classList.add('on');
    cursor.style.left = Math.min(window.innerWidth - 12, Math.max(12, r.left + Math.min(r.width, 40))) + 'px';
    cursor.style.top = Math.min(window.innerHeight - 12, Math.max(12, r.top)) + 'px';
    setTimeout(function () { cursor.classList.remove('on'); }, 1400);
  }

  // opts: { label, color, scroll, ev, approx } (ev: the edit, for the code on hover)
  function highlight(targets, opts) {
    if (!state.highlight) return 0;
    var list = targets.filter(visible).slice(0, MAX_TARGETS);
    if (!list.length) return 0;
    if (opts.ev) peekMark(list, opts.ev, opts.approx);
    clearBoxes();
    list.forEach(function (target, i) {
      var node = el('div', { class: 'box' });
      if (opts.color) node.style.setProperty('--c', opts.color);
      var tag = i === 0 && opts.label ? el('div', { class: 'tag', text: opts.label }) : null;
      if (tag) node.appendChild(tag);
      layer.appendChild(node);
      var b = { node: node, tag: tag, target: target };
      boxes.push(b);
      place(b);
      // An edit's ring is highlighted briefly, then becomes its marker; other highlights stay longer.
      var ms = opts.ev ? SETTLE_MS : HIGHLIGHT_MS;
      setTimeout(function () { node.classList.add('out'); }, ms);
      setTimeout(function () {
        node.remove();
        boxes = boxes.filter(function (x) { return x !== b; });
        updateEdges();
      }, ms + 650);
    });
    // One marker per edit, on its first part that has no marker of another edit yet.
    if (opts.ev) addMarker(list.find(function (t) { return !markers.some(function (m) { return m.target === t && editKey(m.ev) !== editKey(opts.ev); }); }) || list[0], opts.ev);
    if (onScreen(boxes[0])) flyCursorTo(list[0], opts.color);
    else if (opts.scroll) scrollToFirst();
    startTracking();
    return list.length;
  }

  // ---------- change markers: a numbered dot in the margin of each changed part ----------
  // Numbered in edit order, the same as the edit cards. Filled until looked at, then an outline.
  // Hovering one opens the code-on-hover card for that change; a click keeps it open.
  var SETTLE_MS = 1600;
  var MAX_MARKERS = 30;
  var markers = []; // { node, target, ev }
  var markerLayer = el('div', { class: 'layer mlayer' });
  root.insertBefore(markerLayer, panel);
  var markerFrame = 0;
  function addMarker(target, ev) {
    var no = editNumber(ev);
    var seen = editNo[editKey(ev)].seen;
    markers = markers.filter(function (m) {
      if (m.target !== target) return true;
      m.node.remove();
      return false;
    });
    var node = el('button', { class: 'emark' + (seen ? ' seen' : '') + (ev.kind === 'restore' ? ' rst' : ''), type: 'button', text: String(no), 'aria-label': 'Edit ' + no + ': ' + (ev.kind === 'restore' ? restoreLabel(ev) + ' ' : '') + labelFor(ev) + '. Show the change' });
    var m = { node: node, target: target, ev: ev };
    node.addEventListener('pointerenter', function () { showMarkerPeek(m, false); });
    node.addEventListener('click', function (e) {
      e.stopPropagation();
      showMarkerPeek(m, true);
    });
    markerLayer.appendChild(node);
    markers.push(m);
    while (markers.length > MAX_MARKERS) markers.shift().node.remove();
    placeMarkers();
  }
  function showMarkerPeek(m, pin) {
    lookedAt(m.ev);
    if (!peek.on && !pin) return;
    showPeek([{ ev: m.ev, approx: false, el: m.target }], 'mark:' + editKey(m.ev), null);
    if (pin) pinPeek(true);
  }
  function placeMarkers() {
    markerFrame = 0;
    markers = markers.filter(function (m) {
      if (m.target.isConnected !== false) return true;
      m.node.remove();
      return false;
    });
    var taken = [];
    markers.forEach(function (m) {
      var r = m.target.getBoundingClientRect();
      var hide = !r.width || !r.height || r.bottom < 0 || r.top > window.innerHeight;
      m.node.style.display = hide ? 'none' : '';
      if (hide) return;
      // In the margin to the left; inside the part when there is no room.
      var x = r.left - 26 >= 2 ? r.left - 26 : r.left + 4;
      var y = Math.max(2, r.top + Math.min(r.height / 2, 14) - 9);
      // Two parts in the same place: the newer marker moves down so both stay visible.
      while (taken.some(function (t) { return Math.abs(t[0] - x) < 18 && Math.abs(t[1] - y) < 18; })) y += 20;
      taken.push([x, y]);
      m.node.style.left = Math.round(x) + 'px';
      m.node.style.top = Math.round(y) + 'px';
    });
  }
  function placeMarkersSoon() {
    if (markers.length && !markerFrame) markerFrame = requestAnimationFrame(placeMarkers);
  }
  document.addEventListener('scroll', placeMarkersSoon, { passive: true, capture: true });
  window.addEventListener('resize', placeMarkersSoon);
  setInterval(placeMarkersSoon, 1000); // layout that moves without a scroll (animations, images loading)

  function firstChangedLine(hunk) {
    var line = Number(hunk && hunk.newStart);
    if (!Number.isFinite(line)) return NaN;
    var lines = hunk.lines || [];
    for (var i = 0; i < lines.length; i++) {
      if (lines[i][0] === '+' || lines[i][0] === '-') return line;
      line++;
    }
    return Number(hunk.newStart);
  }
  // The last line an edit changed, on the new side (a pure removal: the line where it was).
  function lastChangedLine(hunk) {
    var line = Number(hunk && hunk.newStart);
    if (!Number.isFinite(line)) return NaN;
    var last = NaN;
    (hunk.lines || []).forEach(function (l) {
      if (l[0] === '+') last = line;
      else if (l[0] === '-' && !Number.isFinite(last)) last = line;
      if (l[0] !== '-') line++;
    });
    return Number.isFinite(last) ? last : firstChangedLine(hunk);
  }
  // Where the part that starts on line `from` ends: a tag's closing tag (JSX/HTML), or the brace
  // closing a block that opens at the end of the line (a CSS rule, a function). From the start
  // line alone when neither fits, or when no end is found within 400 lines.
  function partEnd(lines, from) {
    var first = String(lines[from - 1] || '');
    var text = lines.slice(from - 1, from + 399).join('\n');
    var lineAt = function (pos) { var n = 0; for (var i = 0; i < pos; i++) if (text.charCodeAt(i) === 10) n++; return from + n; };
    var open = /^\s*<([A-Za-z][\w.:-]*)/.exec(first);
    if (open) {
      var name = open[1];
      // Arrows (=>) and comparisons inside {…} aren't tags; remove arrows first.
      var src = text.replace(/=>/g, '=_');
      var re = /<(\/?)([A-Za-z][\w.:-]*)(?:"[^"]*"|'[^']*'|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}|[^>"'{])*?(\/?)>/g;
      var depth = 0;
      var m;
      while ((m = re.exec(src))) {
        if (m[2] !== name) continue;
        if (m[1]) depth--;
        else if (!m[3]) depth++;
        else if (depth === 0) return lineAt(m.index + m[0].length - 1);
        if (depth === 0) return lineAt(m.index + m[0].length - 1);
      }
      return from;
    }
    if (/\{\s*$/.test(first)) {
      var d = 0;
      for (var i = 0; i < text.length; i++) {
        var c = text[i];
        if (c === '{') d++;
        else if (c === '}' && --d === 0) return lineAt(i);
      }
    }
    return from;
  }
  function labelFor(ev) {
    var line = ev.hunks && firstChangedLine(ev.hunks[0]);
    return baseName(ev.relFile || ev.file) + (Number.isFinite(line) && line > 0 ? ':' + line : '');
  }
  function highlightFromHints(ev, scrollIfHidden) {
    return highlight(elementsFromHints(ev.hints), { label: labelFor(ev), scroll: scrollIfHidden, ev: ev, approx: true, color: ev.kind === 'restore' ? RESTORE_COLOR : null });
  }

  // ---------- a selected code block: its elements stay outlined until deselected ----------
  // Outlines stay while the selection exists and move with the elements on scroll and re-render.
  var sel = { key: null, kind: null, label: '', find: null, card: null, boxes: [], shown: -1 };
  var cardOf = new WeakMap(); // edit -> its card in the feed
  var cardEv = new WeakMap(); // card -> its edit
  var selTimer = 0;
  var SEL_STORE = 'editlens.selectedEdit';
  // "<server start>.<edit number>" (seqKey): numbers start again after a restart.
  var pendingSel = String(storageGet('sessionStorage', SEL_STORE) || '');

  function normPath(f) {
    return String(f || '').replace(/\\/g, '/').replace(/^\.\//, '');
  }
  function samePath(a, b) {
    a = normPath(a);
    b = normPath(b);
    if (!a || !b) return false;
    return a === b || a.slice(-(b.length + 1)) === '/' + b || b.slice(-(a.length + 1)) === '/' + a;
  }
  // data-editlens-src="file:line:col" -> { file, line, col }, or null (line and col are whole numbers).
  function parseSrc(value) {
    var m = /^(.*):(\d+):(\d+)$/.exec(value || '');
    if (!m) return null;
    var line = Number(m[2]);
    var col = Number(m[3]);
    return Number.isSafeInteger(line) && Number.isSafeInteger(col) ? { file: m[1], line: line, col: col } : null;
  }
  // Elements the Vite plugin tagged as written on one of these lines of this file.
  function elementsBySource(file, lineSet) {
    if (!file || !lineSet.size) return [];
    var out = [];
    safeQueryAll('[data-editlens-src]').forEach(function (e) {
      var s = parseSrc(e.getAttribute('data-editlens-src'));
      if (s && lineSet.has(s.line) && samePath(s.file, file)) out.push(e);
    });
    // One outline per region: remove elements inside another match.
    return out.filter(function (e) { return !out.some(function (o) { return o !== e && o.contains(e); }); });
  }
  // The new-file line numbers an edit changed (a pure deletion counts the line where it was).
  function changedLines(hunks) {
    var set = new Set();
    (hunks || []).forEach(function (h) {
      var line = Number(h && h.newStart);
      if (!Number.isFinite(line)) return;
      (h.lines || []).forEach(function (l) {
        if (l[0] === '-') {
          set.add(line);
          return;
        }
        if (l[0] === '+') set.add(line);
        line++;
      });
    });
    return set;
  }
  var STYLE_FILE = /\.(css|scss|sass|less|styl|pcss)$/i;
  // The selectors of the CSS rules these lines belong to (the rule a line is in, or the rule
  // starting on it), so a stylesheet selection outlines the elements those rules style.
  function cssSelectorsAt(lines, lineSet) {
    var text = lines.join('\n').replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });
    var starts = [0];
    for (var i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    var out = [];
    function addHead(head) {
      // At-rules (@media, @supports) wrap rules; keep looking outward only from a rule.
      if (!head || head[0] === '@' || head.indexOf('&') >= 0) return false;
      head.split(',').forEach(function (part) {
        var sel = part.trim();
        if (sel && out.indexOf(sel) < 0 && out.length < 30) out.push(sel);
      });
      return true;
    }
    lineSet.forEach(function (line) {
      if (!(line >= 1) || line > starts.length) return;
      var end = line < starts.length ? starts[line] - 1 : text.length;
      // Rules that start on this line (a whole rule on one line, too).
      var own = false;
      var re = /([^{};]+)\{/g;
      var row = text.slice(starts[line - 1], end);
      var m;
      while ((m = re.exec(row))) if (addHead(m[1].trim())) own = true;
      if (own) return;
      var depth = 0;
      for (var j = end - 1; j >= 0; j--) {
        var ch = text[j];
        if (ch === '}') depth++;
        else if (ch === '{') {
          if (depth > 0) {
            depth--;
            continue;
          }
          var from = Math.max(text.lastIndexOf('}', j - 1), text.lastIndexOf('{', j - 1), text.lastIndexOf(';', j - 1)) + 1;
          addHead(text.slice(from, j).trim());
          break;
        }
      }
    });
    return out;
  }
  // A restarted server numbers its events from 1 again: the key includes the server's start too, so
  // an edit after a restart never reuses the number or the card of an older one.
  function editKey(ev) {
    return 'edit:' + (posInt(ev.seq) > 0 ? (ev.inst ? ev.inst + '.' : '') + ev.seq : (ev.file || '') + '@' + ev.ts);
  }
  // The edits this page shows (file and time), so the copies a restarted server lists again
  // ("earlier") are not shown twice.
  var shownEdits = new Set();
  function noteShown(ev) {
    shownEdits.add((ev.file || '') + '@' + ev.ts);
    if (shownEdits.size > 5000) shownEdits.delete(shownEdits.values().next().value);
  }
  function shownBefore(ev) {
    return shownEdits.has((ev.file || '') + '@' + ev.ts);
  }
  function selectEdit(ev, scroll) {
    var key = editKey(ev);
    var lines = changedLines(ev.hunks);
    var css = STYLE_FILE.test(ev.file || ev.relFile || '');
    var cssSelectors = null; // filled in once the stylesheet's text arrives
    var finder = ev.kind === 'backend'
      ? function () { return elementsForPaths(pagePathsFor(ev.routes)); }
      : css
        ? function () {
          var byRule = cssSelectors ? elementsFromHints({ selectors: cssSelectors }) : [];
          return byRule.length ? byRule : elementsFromHints(ev.hints);
        }
        : function () {
          var bySource = elementsBySource(ev.relFile || ev.file, lines);
          return bySource.length ? bySource : elementsFromHints(ev.hints);
        };
    var first = Math.min.apply(null, Array.from(lines).concat([Infinity]));
    var last = Math.max.apply(null, Array.from(lines).concat([-Infinity]));
    select({ key: key, kind: 'edit', label: labelFor(ev), find: finder, card: cardOf.get(ev) || null, seq: posInt(ev.seq), scroll: scroll, ev: ev,
      file: ev.file || ev.relFile, relFile: ev.relFile, line: Number.isFinite(first) ? first : null, end: Number.isFinite(last) && last >= first ? last : null, lines: Array.from(lines), snapshot: ev.snapshot || null });
    if (css && ev.snapshot && lines.size) {
      fetchSnapshot(ev.snapshot).then(function (snap) {
        if (!snap || sel.key !== key || typeof snap.after !== 'string') return;
        cssSelectors = cssSelectorsAt(splitLines(snap.after), lines);
        drawSelection(true);
        if (scroll && sel.boxes.length && !sel.boxes.some(onScreen)) revealBox(sel.boxes[0]);
      }, function (err) { console.warn('[EditLens] could not read the stylesheet:', err); });
    }
  }
  function selectLines(file, a, b, view) {
    var lines = new Set();
    for (var i = a; i <= b && lines.size < 2000; i++) lines.add(i);
    select({
      key: 'code:' + normPath(file) + ':' + a + '-' + b,
      kind: 'code',
      label: baseName(file) + ':' + a + (b > a ? '–' + b : ''),
      find: STYLE_FILE.test(file || '')
        ? function () { return view ? elementsFromHints({ selectors: cssSelectorsAt(view.lines, lines) }) : []; }
        : function () { return elementsBySource(file, lines); },
      scroll: false,
      file: file,
      line: a,
      end: b,
    });
  }
  function select(opts) {
    if (!state.highlight) return 0;
    if (sel.key === opts.key) return sel.boxes.length;
    clearSelection();
    sel.key = opts.key;
    sel.kind = opts.kind;
    sel.label = opts.label;
    sel.find = opts.find;
    sel.card = opts.card || null;
    sel.file = opts.file || null;
    sel.line = opts.line || null;
    sel.end = opts.end || null;
    sel.lines = opts.lines || null;
    sel.relFile = opts.relFile || null;
    sel.snapshot = opts.snapshot || null;
    sel.ev = opts.ev || null;
    sel.color = opts.color || null;
    sel.shown = -1; // which outline Show went to last; each click moves to the next one
    if (sel.card) sel.card.classList.add('sel');
    storageSet('sessionStorage', SEL_STORE, opts.seq > 0 ? seqKey(opts.ev, opts.seq) : null);
    var n = drawSelection(false);
    if (n && opts.scroll && !sel.boxes.some(onScreen)) revealBox(sel.boxes[0]);
    return n;
  }
  function selectionTargets() {
    return (sel.find() || []).filter(function (e) { return e.isConnected && visible(e); }).slice(0, MAX_TARGETS);
  }
  function drawSelection(again) {
    var list = selectionTargets();
    sel.boxes.forEach(function (b) { b.node.remove(); });
    sel.boxes = [];
    list.forEach(function (target, i) {
      var node = el('div', { class: 'box sel' + (again ? ' again' : '') + (sel.color ? ' fol' : '') });
      node.style.setProperty('--c', sel.color || COLORS.selected);
      var tag = i === 0 ? el('div', { class: 'tag', text: sel.label }) : null;
      if (tag) node.appendChild(tag);
      selLayer.appendChild(node);
      var b = { node: node, tag: tag, target: target };
      sel.boxes.push(b);
      place(b);
    });
    renderSelBar();
    startTracking();
    return list.length;
  }
  // After the page re-renders (HMR, data loading, a route change), outline the elements again.
  function refreshSelectionSoon() {
    if (selTimer) return;
    selTimer = setTimeout(function () {
      selTimer = 0;
      if (!sel.key) return;
      var now = selectionTargets();
      var before = sel.boxes.map(function (b) { return b.target; });
      var same = now.length === before.length && now.every(function (e, i) { return e === before[i]; });
      if (!same) drawSelection(true);
    }, 250);
  }
  function renderSelBar() {
    selBar.classList.toggle('on', Boolean(sel.key));
    changesList.classList.toggle('nobar', !sel.key); // matches the bar
    if (!sel.key) return placeFloaters();
    var n = sel.boxes.length;
    selText.textContent = '';
    selText.appendChild(el('b', { text: sel.label }));
    var at = n > 1 && sel.shown >= 0 && sel.shown < n ? sel.shown + 1 : 0;
    selText.appendChild(document.createTextNode(n
      ? ' · ' + n + (n === 1 ? ' element' : ' elements') + ' on this page' + (at ? ' (showing ' + at + ' of ' + n + ')' : '')
      : sel.kind === 'code' ? ' · nothing on this page comes from these lines' : ' · not on this page'));
    // Nothing to scroll to: Show goes to the page that shows this code when that page is known,
    // else opens the code (unless it is the code being shown).
    var place = !n && sel.file ? knownPlace(sel.file) : null;
    var openCode = !n && !place && sel.file && sel.kind !== 'code';
    selShow.textContent = n ? 'Show' : place ? 'Go to page' : 'Open code';
    renderChangesButton();
    placeFloaters();
    selCode.style.display = n && sel.file && sel.kind !== 'code' && codeCoversPage() ? '' : 'none';
    selShow.disabled = !n && !place && !openCode;
    selShow.title = n ? (n > 1 ? 'Scroll to the outlined elements one at a time (each click shows the next one)' : 'Scroll to the outlined element') + (sel.kind !== 'code' && sel.file ? ', and open its code in the code view' : '')
      : place ? 'Go to ' + place.route + (place.via && place.via.text ? ' (' + place.via.text + ')' : '') + ', where this code is shown'
        : openCode ? "These elements aren't on this page right now, and it isn't known yet which page shows them. Opens the code in the code view instead."
          : "Nothing on this page matches these lines.";
  }
  function showSelection() {
    if (sel.boxes[0]) {
      // The next outline; the same one again when you scrolled away from it.
      var last = Number.isInteger(sel.shown) && sel.shown >= 0 && sel.shown < sel.boxes.length ? sel.shown : -1;
      sel.shown = last >= 0 && !inPageArea(sel.boxes[last].target) ? last : (last + 1) % sel.boxes.length;
      sel.boxes.forEach(function (b) { if (b.node) b.node.classList.remove('hit'); });
      revealBox(sel.boxes[sel.shown]);
      renderSelBar();
      // Show also opens that part of the code in the code view, marked until you pick something
      // else. Lines picked in the code view are already open there; in a narrow window the code
      // view would cover the page, so Code in this bar opens it.
      if (sel.kind !== 'code' && sel.file && !codeCoversPage()) openSelectionCode(sel);
      return;
    }
    if (!sel.file) return;
    if (knownPlace(sel.file)) {
      revealFile({ file: sel.file, line: sel.line, end: sel.end, keep: true, quiet: false });
      return;
    }
    openSelectionCode(sel);
  }
  function codeCoversPage() {
    return window.innerWidth <= 760 && !pop.dock && layout.dock.mode !== 'float';
  }
  selCode.addEventListener('click', function () { openSelectionCode(sel); });
  function renderChangesButton() {
    var n = changesCount;
    selChanges.textContent = (changesList.classList.contains('on') ? '▾ ' : '▴ ') + 'Changes' + (n ? ' (' + n + ')' : '');
    selChanges.style.display = n ? '' : 'none';
  }
  function setChangesOpen(open) {
    changesList.classList.toggle('on', Boolean(open));
    selChanges.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) renderChanges();
    renderChangesButton();
    placeToast();
  }
  // Newest first. Picking one outlines it on the page (scrolled to) and opens its code, marked.
  function renderChanges() {
    var items = changes.slice().reverse().map(function (ev) {
      var owner = ownerOf(ev);
      var lines = changedLines(ev.hunks);
      var first = Math.min.apply(null, Array.from(lines).concat([Infinity]));
      var undoneBy = restoredBy(ev);
      var num = editNo[editKey(ev)];
      // The Changes row (handoff 14). Line 1: marker number, file name, its folder, counts.
      var item = el('button', { class: 'chi' + (sel.key === editKey(ev) ? ' on' : '') + (ev.kind === 'restore' ? ' rst' : '') + (undoneBy ? ' restored' : ''), type: 'button' },
        changeLine(ev, { no: num ? num.no : null, seen: num ? num.seen : false, line: Number.isFinite(first) && first > 0 ? first : null }),
        ev.intent ? el('span', { class: 'w', text: ev.intent }) : null,
        undoneBy ? el('span', { class: 'w rb', text: restoreLabel(undoneBy) + (clock(undoneBy.ts) ? ' at ' + clock(undoneBy.ts) : '') + ': no longer in the file.' }) : null,
        isUndoAsked(ev) ? el('span', { class: 'w uask', text: 'Claude is undoing it' }) : null,
        ev.snapshot ? null : el('span', { class: 'w', text: ev.earlier ? 'From before EditLens restarted: its code is not kept, but Restore still works.' : 'Code not kept (binary or too large): outlines the page only.' }));
      item.style.setProperty('--fc', ev.kind === 'restore' ? RESTORE_COLOR : ownerColor(owner));
      item.addEventListener('click', function () { pickChange(ev); });
      // Line 2: who made it (its label, with its own details card) and when; Restore on the right.
      var t = restoreTarget(ev);
      var btn = null;
      var row = el('div', { class: 'chr' + (sel.key === editKey(ev) ? ' on' : ''), role: 'listitem' }, item);
      if (t) {
        btn = el('button', { class: 'mini chrst', type: 'button', text: restoreButtonText(ev), title: t.off || (t.undo ? 'Put the file back as it was before the restore' : 'Put the file back as it was before this edit') });
        // A paired computer's edit its EditLens can't restore: off, with the reason.
        if (t.off) btn.disabled = true;
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var open = row.querySelector('.rconf');
          if (open) return open.remove();
          var box = restoreQuestion(ev, function () { box.remove(); });
          if (box) row.appendChild(box);
        });
      }
      row.appendChild(changeWho(ev, [ev.kind === 'restore' ? el('span', { class: 'k', text: restoreLabel(ev) }) : null, btn]));
      return row;
    });
    var count = changesCount + ' this session' + (changes.length < changesCount ? ' (latest ' + changes.length + ' listed)' : '');
    changesList.replaceChildren.apply(changesList, [el('div', { class: 'chh' }, el('b', { text: 'All changes' }), el('span', { text: count }))].concat(items));
    placeChangesList();
  }
  // Above the bar when there is space, else below it; never past the window.
  function placeChangesList() {
    var b = selBar.getBoundingClientRect();
    var vh = window.innerHeight;
    var above = b.top - 16;
    var below = vh - b.bottom - 16;
    changesList.style.left = selBar.style.left;
    changesList.style.width = Math.max(240, Math.round(b.width || 0)) + 'px';
    if (above >= 140 || above >= below) {
      changesList.style.top = 'auto';
      changesList.style.bottom = Math.round(vh - b.top + 8) + 'px';
      changesList.style.maxHeight = Math.round(Math.max(80, Math.min(380, above))) + 'px';
    } else {
      changesList.style.bottom = 'auto';
      changesList.style.top = Math.round(b.bottom + 8) + 'px';
      changesList.style.maxHeight = Math.round(Math.max(80, Math.min(380, below))) + 'px';
    }
  }
  // Where the switcher ends up, not where its opening animation has it now (8px lower, 97% size).
  function switcherBox() {
    var r = switcher.getBoundingClientRect();
    var h = switcher.offsetHeight;
    var top = switcher.style.top !== 'auto' ? parseFloat(switcher.style.top) : window.innerHeight - parseFloat(switcher.style.bottom) - h;
    if (!isFinite(top)) return r;
    return { left: r.left, right: r.left + switcher.offsetWidth, top: top, bottom: top + h, width: switcher.offsetWidth, height: h };
  }
  // The pieces at the bottom of the page never cover each other: the selection bar keeps beside
  // (or goes above) the pill and a panel in a bottom corner, stays out of a code view docked at
  // the bottom, and a message (toast) shows above the bar.
  function placeFloaters() {
    var a = pageArea();
    var vh = window.innerHeight;
    var left = a.left + 16;
    var right = a.right - 16;
    var bottom = vh - a.bottom + 16;
    var lift = bottom;
    var obstacles = [];
    if (pill.classList.contains('on')) obstacles.push(pill.getBoundingClientRect());
    if (!pop.panel && state.panel === 'open') obstacles.push(panel.getBoundingClientRect());
    // The Agents switcher where it is down in the bar's row (dragged there, or no panel on the page).
    if (switcher.classList.contains('on')) obstacles.push(switcherBox());
    obstacles.forEach(function (r) {
      if (!r.width || r.bottom < vh - bottom - 56) return; // not down in the bar's row
      if (r.left - 12 - left >= 240) right = Math.min(right, r.left - 12);
      else if (right - (r.right + 12) >= 240) left = Math.max(left, r.right + 12);
      else lift = Math.max(lift, vh - r.top + 8);
    });
    // Moved above another element: it can use the full width again.
    if (lift > bottom) {
      left = a.left + 16;
      right = a.right - 16;
    }
    selBar.style.left = Math.round(left) + 'px';
    selBar.style.bottom = Math.round(Math.max(8, Math.min(lift, vh - (selBar.offsetHeight || 48) - 8))) + 'px';
    selBar.style.maxWidth = Math.round(Math.max(200, Math.min(460, right - left))) + 'px';
    if (changesList.classList.contains('on')) placeChangesList();
    // Above the panel, the switcher goes above the bar (placeSwitcher).
    if (switcher.classList.contains('on')) placeSwitcher();
    placeToast();
    pqSoon();
  }
  // A message goes above the selection bar and its list, else below them, else at the top; never
  // over the bar, the list or the pill (it may cover the panel for a moment).
  function placeToast() {
    var vh = window.innerHeight;
    var h = toast.offsetHeight || 40;
    var boxes = [selBar, changesList, pill].filter(function (n) {
      return n.classList.contains('on') && !n.classList.contains('nobar');
    }).map(function (n) { return n.getBoundingClientRect(); }).filter(function (b) { return b.height; });
    var free = function (t) { return t >= 8 && t + h <= vh - 8 && boxes.every(function (b) { return t + h <= b.top - 4 || t >= b.bottom + 4; }); };
    var stack = [selBar, changesList].filter(function (n) {
      return n.classList.contains('on') && !n.classList.contains('nobar');
    }).map(function (n) { return n.getBoundingClientRect(); }).filter(function (b) { return b.height; });
    var tops = [pageArea().bottom - 24 - h];
    if (stack.length) {
      tops.push(Math.min.apply(null, stack.map(function (b) { return b.top; })) - 8 - h);
      tops.push(Math.max.apply(null, stack.map(function (b) { return b.bottom; })) + 8);
    }
    tops.push(8);
    var t = tops.filter(free)[0];
    if (t === undefined) t = 8;
    toast.style.bottom = 'auto';
    toast.style.top = Math.round(t) + 'px';
  }

  function pickChange(ev) {
    selectEdit(ev, true);
    if (sel.key && sel.boxes[0]) {
      sel.shown = 0;
      revealBox(sel.boxes[0]);
    }
    if (sel.key) renderSelBar();
    // In a narrow window the code view would cover the page: the page first, then Code.
    if (ev.snapshot && (!codeCoversPage() || !sel.key || !sel.boxes.length)) {
      var lines = Array.from(changedLines(ev.hunks));
      var first = Math.min.apply(null, lines.concat([Infinity]));
      var last = Math.max.apply(null, lines.concat([-Infinity]));
      openSelectionCode({ file: ev.relFile || ev.file, relFile: ev.relFile, snapshot: ev.snapshot, line: Number.isFinite(first) ? first : null, end: Number.isFinite(last) ? last : null, lines: lines, edit: ev });
    }
    if (changesList.classList.contains('on')) renderChanges();
  }
  selChanges.addEventListener('click', function () { setChangesOpen(!changesList.classList.contains('on')); });
  window.addEventListener('resize', function () {
    if (sel.key) renderSelBar();
    if (changesList.classList.contains('on')) placeChangesList();
  });
  // The file as that edit left it, so the line is right even after later edits; else as it is now.
  function openSelectionCode(s, owner) {
    var fallback = function () { openRef({ path: s.file, line: s.line, end: s.end, part: true }, owner); };
    if (!s.snapshot) return fallback();
    fetchSnapshot(s.snapshot).then(function (snap) {
      if (!snap) return fallback();
      showCodeView();
      enqueue({ ev: { type: 'code', snapshot: s.snapshot, file: s.file, relFile: s.relFile || s.file, line: s.line, endLine: s.end, lines: s.lines || null, part: true, edit: s.edit || null, approx: Boolean(s.approx) }, owner: owner || null });
    }, fallback);
  }
  function clearSelection() {
    sel.boxes.forEach(function (b) { b.node.remove(); });
    if (sel.card) sel.card.classList.remove('sel');
    if (sel.key) storageSet('sessionStorage', SEL_STORE, null);
    sel = { key: null, kind: null, label: '', find: null, card: null, boxes: [], shown: -1 };
    clearTimeout(selTimer);
    selTimer = 0;
    renderSelBar();
  }
  selShow.addEventListener('click', showSelection);
  selClear.addEventListener('click', function () {
    setChangesOpen(false);
    clearSelection();
  });
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !sel.key || e.defaultPrevented || pick.on) return;
    setChangesOpen(false);
    clearSelection();
  });

  // ---------- Claude pointing at the page ----------
  function resolveTarget(t) {
    // A number the user pointed at: the same element (or area) again.
    if (t.marker) {
      var m = sentMarks[t.marker] || pick.items.find(function (x) { return x.n === t.marker; });
      if (m && m.target && m.target.isConnected !== false) return [m.target];
      if (m && m.kind === 'element' && m.selector) return safeQueryAll(m.selector).filter(usable).slice(0, 1);
      if (!t.selector && !t.text) return [];
    }
    if (t.selector) {
      var bySel = safeQueryAll(t.selector).filter(usable);
      if (bySel.length || !t.text) return bySel;
    }
    return t.text ? findByText(t.text, 6) : [];
  }
  function showPoint(ev, report) {
    clearPoints();
    var color = COLORS[ev.color] || COLORS.purple;
    var results = [];
    var first = null;
    (ev.targets || []).forEach(function (t) {
      var found = resolveTarget(t).filter(visible).slice(0, 8);
      results.push({ target: t.marker ? '#' + t.marker : t.selector || '"' + t.text + '"', count: found.length });
      found.forEach(function (target, i) {
        var node = el('div', { class: 'box point' });
        node.style.setProperty('--c', color);
        var note = i === 0 && t.note ? el('div', { class: 'note', text: t.note }) : null;
        if (note) node.appendChild(note);
        pointLayer.appendChild(node);
        var b = { node: node, tag: note, target: target };
        points.push(b);
        place(b);
        if (!first) first = target;
      });
    });
    if (first && ev.scroll !== false) {
      var r = first.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      else flyCursorTo(first, color);
    }
    startTracking();
    var d = Number(ev.duration);
    // Seconds; a time longer than a timer can wait (about 24 days) would end the outline immediately.
    if (Number.isFinite(d) && d > 0 && d * 1000 <= 2147483647) {
      var mine = points.slice();
      setTimeout(function () {
        mine.forEach(function (b) { b.node.classList.add('out'); });
        setTimeout(function () {
          mine.forEach(function (b) { b.node.remove(); });
          points = points.filter(function (b) { return mine.indexOf(b) < 0; });
        }, 650);
      }, d * 1000);
    }
    if (report && ev.pointId) {
      postJson('/report', { pointId: ev.pointId, pageId: PAGE_ID, url: location.href, results: results }).catch(function (err) {
        console.warn('[EditLens] could not report highlight result:', err);
      });
    }
    return results;
  }
  function addPointCard(ev, results) {
    lastSteps = null;
    var notes = (ev.targets || []).map(function (t) { return t.note; }).filter(Boolean);
    var total = results ? results.reduce(function (n, r) { return n + (Number.isFinite(r.count) ? r.count : 0); }, 0) : null;
    var names = (ev.targets || []).map(function (t) { return t && t.text ? String(t.text).slice(0, 40) : ''; }).filter(Boolean);
    var what = names.length ? names.join(', ') : total === null ? '' : total + ' part' + (total === 1 ? '' : 's');
    var card = el('li', { class: 'k-point', style: COLORS[ev.color] ? '--pc:' + COLORS[ev.color] : null },
      el('span', { class: 'pring', 'aria-hidden': 'true', text: '✦' }),
      el('span', { class: 'ptext' }, document.createTextNode('Claude pointed at '), what ? el('b', { text: what }) : document.createTextNode('the page'),
        document.createTextNode((what ? ' on the page' : '') + (total === 0 ? ' (not found here)' : '') + (notes.length ? ' · ' + notes.join(' · ') : ''))));
    card.addEventListener('click', function () { showPoint(ev, false); });
    append(card, !ev.replay);
  }

  // ---------- the user pointing for Claude: elements, areas and code lines ----------
  // Inspector-style: click attaches, Shift+click adds, drag attaches an area. Each attachment gets
  // a number sent with the next message (source, component, selector, text, styles); Claude can
  // refer to it by number.
  var YOU = '#0e8a6a';
  // next: the lowest number not sent yet in this tab (kept across reloads).
  var pick = { on: false, hover: null, down: null, drag: false, items: [], next: Number(storageGet('sessionStorage', 'editlens.markNo')) || 1 };
  if (!Number.isInteger(pick.next) || pick.next < 1) pick.next = 1;
  var sentMarks = Object.create(null); // number -> attachment with its element, used by message buttons
  var catcher = el('div', { class: 'catcher' });
  var hoverBox = el('div', { class: 'ubox hover' });
  var hoverTag = el('div', { class: 'tag' });
  hoverBox.appendChild(hoverTag);
  var dragBox = el('div', { class: 'ubox drag' });
  var pickBar = el('div', { class: 'pickbar', role: 'status' },
    el('span', { text: 'Click something to select it · Shift+click for more · drag for an area · Esc to stop' }));
  var markLayer = el('div', { class: 'layer marks' });
  var attsEl = el('div', { class: 'atts' });
  var marks = []; // { node, item }
  var markRaf = 0;

  function clip(s, max) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function px(v) {
    var x = Math.round(Number(v));
    return Number.isFinite(x) ? x : 0;
  }
  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');
  }
  function unique(sel) {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (err) {
      if (err && err.name === 'SyntaxError') return false;
      throw err;
    }
  }
  // A selector that finds this element and only it: id, test id, else a short path.
  function selectorFor(e) {
    if (e.id && unique('#' + cssEscape(e.id))) return '#' + cssEscape(e.id);
    var attrs = ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label'];
    for (var i = 0; i < attrs.length; i++) {
      var v = e.getAttribute(attrs[i]);
      if (v && v.length < 60) {
        var s = e.tagName.toLowerCase() + '[' + attrs[i] + '="' + v.replace(/"/g, '\\"') + '"]';
        if (unique(s)) return s;
      }
    }
    var parts = [];
    var node = e;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 6) {
      var part = node.tagName.toLowerCase();
      if (node.id && unique('#' + cssEscape(node.id))) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      var cls = [].filter.call(node.classList, function (c) { return /^[a-zA-Z][\w-]{1,30}$/.test(c) && !/\d{3,}/.test(c); })[0];
      if (cls) part += '.' + cssEscape(cls);
      var parent = node.parentElement;
      if (parent) {
        var same = [].filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (unique(parts.join(' > '))) break;
      node = parent;
    }
    return parts.join(' > ');
  }
  // Where an element comes from in the source, best evidence first.
  function sourceOf(e) {
    var out = { file: null, line: null, col: null, how: null, components: [] };
    var tagged = e.closest('[data-editlens-src]');
    if (tagged) {
      var s = parseSrc(tagged.getAttribute('data-editlens-src'));
      if (s) {
        out.file = s.file;
        out.line = s.line;
        out.col = s.col;
        out.how = tagged === e ? 'exact' : 'parent';
      }
    }
    // React: component names, and the JSX location React 18 records in development.
    var fiberKey = Object.keys(e).find(function (k) { return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0; });
    var f = fiberKey ? e[fiberKey] : null;
    for (var depth = 0; f && depth < 60; depth++, f = f.return) {
      var t = f.type;
      if (typeof t === 'function' || (t && typeof t === 'object' && (t.render || t.type))) {
        var fn = typeof t === 'function' ? t : t.render || t.type;
        var name = (t && t.displayName) || (fn && (fn.displayName || fn.name));
        if (name && out.components.length < 4 && out.components.indexOf(name) < 0) out.components.push(name);
      }
      if (!out.file && f._debugSource && f._debugSource.fileName) {
        out.file = f._debugSource.fileName;
        out.line = Number(f._debugSource.lineNumber) || null;
        out.col = Number(f._debugSource.columnNumber) || null;
        // @vitejs/plugin-react adds its hot-reload code before React records lines, so in Vite apps
        // without the plugin's source tags the line is shifted down.
        out.how = document.querySelector('script[src*="/@vite/client"]') ? 'approx' : depth === 0 ? 'exact' : 'parent';
      }
      // React 19 removed _debugSource; its _debugStack names the module but in served (compiled) lines.
      if (!out.file && depth === 0 && f._debugStack && typeof f._debugStack.stack === 'string') {
        var frame = /https?:\/\/[^/\s]+(\/[^\s?:)]+\.[jt]sx?)/.exec(f._debugStack.stack.split('\n').slice(2).join('\n'));
        if (frame && !/node_modules|\/@/.test(frame[1])) {
          out.file = frame[1].replace(/^\//, '');
          out.how = 'file';
        }
      }
    }
    // Vue and Svelte record the component file on the element.
    var vue = e.__vueParentComponent;
    if (vue && vue.type) {
      var vn = vue.type.__name || vue.type.name;
      if (vn && out.components.indexOf(vn) < 0) out.components.unshift(vn);
      if (!out.file && vue.type.__file) {
        out.file = vue.type.__file;
        out.how = 'file';
      }
    }
    var sv = e.__svelte_meta && e.__svelte_meta.loc;
    if (!out.file && sv && sv.file) {
      out.file = sv.file;
      out.line = Number(sv.line) + 1 || null;
      out.how = 'exact';
    }
    if (!Number.isFinite(out.line)) out.line = null;
    if (!Number.isFinite(out.col)) out.col = null;
    return out;
  }
  var STYLE_KEYS = ['display', 'position', 'color', 'backgroundColor', 'fontSize', 'fontWeight', 'padding', 'margin', 'borderRadius', 'gap'];
  function describe(e) {
    var r = e.getBoundingClientRect();
    var cs = getComputedStyle(e);
    var styles = {};
    STYLE_KEYS.forEach(function (k) {
      var v = cs[k];
      if (v && v !== 'normal' && v !== 'none' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)' && v !== 'auto') styles[k] = v;
    });
    var label = e.getAttribute('aria-label') || e.getAttribute('alt') || e.getAttribute('title') || e.getAttribute('placeholder') || '';
    return {
      kind: 'element',
      tag: e.tagName.toLowerCase(),
      id: e.id || null,
      classes: [].slice.call(e.classList, 0, 5),
      selector: selectorFor(e),
      text: clip(e.innerText || e.textContent, 160),
      role: e.getAttribute('role') || null,
      label: clip(label, 80) || null,
      box: { x: px(r.left + scrollX), y: px(r.top + scrollY), w: px(r.width), h: px(r.height) },
      styles: styles,
      source: sourceOf(e),
    };
  }
  function shortName(item) {
    if (item.kind === 'code') return baseName(item.file) + ':' + item.line + (item.endLine > item.line ? '-' + item.endLine : '');
    if (item.kind === 'region') return 'Area ' + item.box.w + '×' + item.box.h;
    var s = '<' + item.tag + (item.classes && item.classes[0] ? '.' + item.classes[0] : '') + '>';
    return item.text ? s + ' ' + clip(item.text, 28) : s;
  }
  function sourceLabel(src) {
    if (!src || !src.file) return src && src.components.length ? src.components[0] : '';
    return (src.components[0] ? src.components[0] + ' · ' : '') + baseName(src.file) + (src.line ? ':' + (src.how === 'approx' ? '~' : '') + src.line : '');
  }

  // The element under the pointer, looking through our own overlay.
  function elementAt(x, y) {
    var list = document.elementsFromPoint(x, y);
    for (var i = 0; i < list.length; i++) {
      var e = elementFor(list[i]);
      if (e && e !== document.body) return e;
    }
    return null;
  }
  // opts.stay: the focus stays where it is, never in the panel's box.
  function setPick(on, opts) {
    pick.on = on;
    catcher.classList.toggle('on', on);
    pickBar.classList.toggle('on', on);
    pointButton.setAttribute('aria-pressed', String(on));
    hoverBox.classList.remove('on');
    dragBox.classList.remove('on');
    pick.down = null;
    if (on && state.panel !== 'open') setPanel('open');
    if (!on && noteBox.open) nbText.focus({ preventScroll: true });
    else if (!on && opts && opts.stay) {
      if (root.activeElement === input) input.blur();
    } else if (!on && pick.items.length) input.focus();
  }
  function placeRect(node, r) {
    node.style.left = r.left + 'px';
    node.style.top = r.top + 'px';
    node.style.width = r.width + 'px';
    node.style.height = r.height + 'px';
  }
  catcher.addEventListener('pointermove', function (e) {
    if (pick.down) {
      var dx = e.clientX - pick.down.x;
      var dy = e.clientY - pick.down.y;
      if (!pick.drag && Math.abs(dx) + Math.abs(dy) > 8) pick.drag = true;
      if (pick.drag) {
        hoverBox.classList.remove('on');
        dragBox.classList.add('on');
        placeRect(dragBox, { left: Math.min(e.clientX, pick.down.x), top: Math.min(e.clientY, pick.down.y), width: Math.abs(dx), height: Math.abs(dy) });
        return;
      }
    }
    var target = elementAt(e.clientX, e.clientY);
    pick.hover = target;
    if (!target) return hoverBox.classList.remove('on');
    var r = target.getBoundingClientRect();
    placeRect(hoverBox, { left: r.left - 3, top: r.top - 3, width: r.width + 6, height: r.height + 6 });
    var src = sourceLabel(sourceOf(target));
    hoverTag.textContent = '<' + target.tagName.toLowerCase() + (target.classList[0] ? '.' + target.classList[0] : '') + '>' + (src ? '  ' + src : '');
    hoverTag.classList.toggle('below', r.top < 30);
    hoverBox.classList.add('on');
  });
  catcher.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault();
    catcher.setPointerCapture(e.pointerId);
    pick.down = { x: e.clientX, y: e.clientY };
    pick.drag = false;
  });
  catcher.addEventListener('pointerup', function (e) {
    if (!pick.down) return;
    var start = pick.down;
    pick.down = null;
    dragBox.classList.remove('on');
    var added = null;
    if (pick.drag) {
      pick.drag = false;
      added = attachRegion({ left: Math.min(e.clientX, start.x), top: Math.min(e.clientY, start.y), right: Math.max(e.clientX, start.x), bottom: Math.max(e.clientY, start.y) });
    } else {
      // A tap (touch) has no pointer move before it, so no hover yet.
      var target = pick.hover || elementAt(e.clientX, e.clientY);
      // An item already picked: the box opens at it again; nothing new is attached.
      var had = target && noteBoxUsable(e) ? pick.items.filter(function (x) { return x.target === target; })[0] : null;
      var item = target && !had ? describe(target) : null;
      if (had) added = had;
      else if (item && attach(item, target)) added = item;
    }
    if (added && noteBoxUsable(e)) openNoteBox(added);
    // Nothing added while the box is in use (12 picks): the panel's box doesn't get the focus, so
    // a note typed next is never sent by Enter.
    if (!e.shiftKey) setPick(false, { stay: !added && noteBoxUsable(e) });
  });
  // Nothing on the page reacts to clicks while pointing.
  catcher.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
  window.addEventListener('keydown', function (e) {
    if (pick.on && e.key === 'Escape') {
      e.preventDefault();
      setPick(false);
    }
    if (e.altKey && e.shiftKey && (e.key === 'P' || e.key === 'p' || e.code === 'KeyP') && !hostTyping(e)) {
      e.preventDefault();
      setPick(!pick.on);
    }
  }, true);

  // An area: its box plus the main elements inside it.
  function attachRegion(r) {
    var inside = [];
    var all = document.body ? document.body.getElementsByTagName('*') : [];
    for (var i = 0; i < all.length && inside.length < 400; i++) {
      var e = all[i];
      if (!elementFor(e)) continue;
      var b = e.getBoundingClientRect();
      if (b.width < 4 || b.height < 4) continue;
      if (b.left >= r.left - 2 && b.top >= r.top - 2 && b.right <= r.right + 2 && b.bottom <= r.bottom + 2) inside.push(e);
    }
    // Keep the outermost ones: the region's main blocks, not every span in them.
    var top = inside.filter(function (e) { return inside.indexOf(e.parentElement) < 0; }).slice(0, 6);
    var item = {
      kind: 'region',
      box: { x: px(r.left + scrollX), y: px(r.top + scrollY), w: px(r.right - r.left), h: px(r.bottom - r.top) },
      elements: top.map(function (e) {
        var d = describe(e);
        return { tag: d.tag, selector: d.selector, text: clip(d.text, 80), source: d.source };
      }),
    };
    var fixed = { left: r.left + scrollX, top: r.top + scrollY, w: r.right - r.left, h: r.bottom - r.top };
    return attach(item, { getBoundingClientRect: function () { return { left: fixed.left - scrollX, top: fixed.top - scrollY, width: fixed.w, height: fixed.h, right: fixed.left - scrollX + fixed.w, bottom: fixed.top - scrollY + fixed.h }; }, isConnected: true }) ? item : null;
  }

  // -> true when the item was added
  function attach(item, target) {
    if (pick.items.length >= 12) {
      showToast('You can attach up to 12 things at a time. Send these first.');
      return false;
    }
    if (target && target.nodeType === 1 && pick.items.some(function (x) { return x.target === target; })) {
      showToast('Already attached.');
      return false;
    }
    // The next number after the picks still attached, and never one already sent (Claude can still
    // point at those). A removed pick's number is used again.
    item.n = pick.items.reduce(function (n, x) { return Math.max(n, x.n + 1); }, pick.next);
    item.target = target || null;
    pick.items.push(item);
    if (target) addMark(item);
    renderAtts();
    return true;
  }
  function detach(item) {
    pick.items = pick.items.filter(function (x) { return x !== item; });
    removeMark(item);
    renderAtts();
  }
  function addMark(item) {
    var node = el('div', { class: 'ubox mark' + (item.kind === 'region' ? ' area' : '') }, el('span', { class: 'num', text: String(item.n) }));
    markLayer.appendChild(node);
    marks.push({ node: node, item: item });
    placeMarks();
  }
  function removeMark(item) {
    marks = marks.filter(function (m) {
      if (m.item !== item) return true;
      m.node.remove();
      return false;
    });
  }
  function placeMarks() {
    marks.forEach(function (m) {
      var t = m.item.target;
      if (!t || t.isConnected === false) return m.node.classList.add('gone');
      var r = t.getBoundingClientRect();
      placeRect(m.node, { left: r.left - 3, top: r.top - 3, width: r.width + 6, height: r.height + 6 });
    });
    placeNoteBox();
    cancelAnimationFrame(markRaf);
    markRaf = marks.length ? requestAnimationFrame(placeMarks) : 0;
  }
  function flashMark(item) {
    var t = item.target;
    if (!t || t.isConnected === false) return showToast('That is no longer on the page.');
    if (t.nodeType === 1) t.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var exists = marks.some(function (m) { return m.item === item; });
    if (!exists) {
      addMark(item);
      setTimeout(function () { removeMark(item); }, 3500);
    }
  }
  function renderAtts() {
    attsEl.replaceChildren();
    pick.items.forEach(function (item) {
      attsEl.appendChild(el('span', { class: 'att', title: item.kind === 'element' ? item.selector : '' },
        el('b', { text: String(item.n) }),
        el('span', { class: 'an', text: shortName(item), on: { click: function () { if (item.kind === 'code') openRef({ path: item.file, line: item.line, end: item.endLine }); else flashMark(item); } } }),
        el('button', { type: 'button', class: 'ax', title: 'Remove', 'aria-label': 'Remove ' + item.n, text: '×', on: { click: function () { detach(item); } } })));
    });
    noteBoxItemsChanged();
    renderInputMarks();
    renderSend();
  }
  // What goes to the server: plain data only (no elements).
  function attachmentsForSend() {
    return pick.items.map(function (item) {
      var copy = {};
      Object.keys(item).forEach(function (k) { if (k !== 'target') copy[k] = item[k]; });
      return copy;
    });
  }
  // Clears only what was sent with the message; anything picked while it was sending stays.
  var SENT_MARKS_MAX = 200; // the newest numbers sent, which Claude can still point at
  function afterSend(sent) {
    sent.forEach(function (item) { sentMarks[item.n] = item; pick.next = Math.max(pick.next, item.n + 1); });
    storageSet('sessionStorage', 'editlens.markNo', String(pick.next));
    var nums = Object.keys(sentMarks).map(Number).sort(function (a, b) { return a - b; });
    nums.slice(0, Math.max(0, nums.length - SENT_MARKS_MAX)).forEach(function (k) { delete sentMarks[k]; });
    pick.items = pick.items.filter(function (item) { return sent.indexOf(item) < 0; });
    renderAtts();
    // The numbers stay on the page for a moment, so the user sees what was sent.
    setTimeout(function () { sent.forEach(removeMark); }, 2500);
  }
  // Buttons on a sent message: click to show the item again.
  function attChips(list) {
    var box = el('div', { class: 'atts sent' });
    (list || []).forEach(function (a) {
      var item = sentMarks[a.n] || a;
      box.appendChild(el('span', { class: 'att', on: { click: function () { if (a.kind === 'code') openRef({ path: a.file, line: a.line, end: a.endLine }); else flashMark(item); } } },
        el('b', { text: String(a.n) }), el('span', { class: 'an', text: shortName(a) })));
    });
    return box;
  }

  // ---------- the message box next to the picked item (setting: Message box next to what you pick) ---------
  // It never sends: Add (or Enter) puts the note in the panel's message box, on its own line that
  // starts with the pick's number. Esc or a click elsewhere puts typed text there too.
  var noteBox = { open: false, items: [], h: 0 };
  var nbChip = el('button', { class: 'nbchip', type: 'button' });
  var nbText = el('textarea', { rows: '1', placeholder: 'Add a note for Claude…', 'aria-label': 'Note for Claude about what you picked', title: DICTATE_TIP });
  var nbAdd = el('button', { class: 'nbadd', type: 'button', text: 'Add', title: 'Add to your message (Enter). Nothing is sent.' });
  var nbHint = el('div', { class: 'nbhint' },
    el('span', null, el('b', { text: 'Enter' }), document.createTextNode(' adds it to your message')),
    el('span', null, el('b', { text: 'Esc' }), document.createTextNode(' closes')),
    DICTATE_KEY ? el('span', { title: DICTATE_TIP }, el('b', { text: DICTATE_KEY }), document.createTextNode(' to speak')) : null);
  var nbList = el('div', { class: 'nblist' });
  var nbEl = el('div', { class: 'notebox', role: 'dialog', 'aria-label': 'Note about what you picked' },
    el('div', { class: 'nbrow' }, nbChip, nbText, nbAdd), nbHint, nbList);
  var NB_HINT_KEY = 'editlens.noteHint';
  var KIND_NAMES = dict({ h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', button: 'button', a: 'link',
    img: 'image', svg: 'image', picture: 'image', video: 'video', input: 'field', textarea: 'field', select: 'menu', p: 'text', span: 'text',
    li: 'item', ul: 'list', ol: 'list', table: 'table', tr: 'row', form: 'form', nav: 'navigation', label: 'label' });
  // "button “Order now”", "heading “New today…”", "area"
  function pickName(item) {
    if (item.kind === 'region') return 'area';
    if (item.kind === 'code') return shortName(item);
    var kind = item.role === 'button' ? 'button' : KIND_NAMES[item.tag] || item.tag;
    var text = clip(item.label || item.text, 16).replace(/\s+…$/, '…');
    return text ? kind + ' “' + text + '”' : kind;
  }
  function pickBoxOn() {
    return !(settings.values && settings.values.pick_box === false);
  }
  // Not on phones and small screens (narrower than 600 px, or touch only): the panel's box is used.
  function noteBoxUsable(e) {
    if (!pickBoxOn() || window.innerWidth < 600 || (e && e.pointerType === 'touch')) return false;
    return !(window.matchMedia && !window.matchMedia('(any-pointer: fine)').matches);
  }
  function openNoteBox(item) {
    if (noteBox.items.indexOf(item) < 0) noteBox.items.push(item);
    noteBox.open = true;
    nbEl.classList.add('on');
    renderNoteBox();
    nbText.focus({ preventScroll: true });
  }
  function renderNoteBox() {
    var items = noteBox.items;
    var nums = items.map(function (x) { return el('i', { text: String(x.n) }); });
    nbChip.replaceChildren.apply(nbChip, nums.concat(el('span', { text: items.length === 1 ? pickName(items[0]) : items.length + ' picks' })));
    nbChip.title = items.length > 1 ? 'Point here to see them; × removes one' : items.length ? shortName(items[0]) : '';
    nbList.replaceChildren.apply(nbList, items.length > 1 ? items.map(function (item) {
      return el('div', { class: 'nbli' }, el('i', { text: String(item.n) }), el('span', { text: pickName(item) }),
        el('button', { type: 'button', title: 'Remove', 'aria-label': 'Remove ' + item.n, text: '×', on: { click: function () { detach(item); } } }));
    }) : []);
    if (items.length < 2) nbEl.classList.remove('list');
    nbHint.hidden = storageGet('localStorage', NB_HINT_KEY) === 'seen';
    nbAdd.disabled = !nbText.value.trim();
    noteBox.h = 0;
    placeNoteBox();
  }
  nbChip.addEventListener('mouseenter', function () { if (noteBox.items.length > 1) nbEl.classList.add('list'); });
  nbChip.addEventListener('click', function () { if (noteBox.items.length > 1) nbEl.classList.toggle('list'); noteBox.h = 0; placeNoteBox(); });
  nbEl.addEventListener('mouseleave', function () {
    if (!nbEl.classList.contains('list')) return;
    nbEl.classList.remove('list');
    noteBox.h = 0;
    placeNoteBox();
  });
  // Picks removed (× here or in the panel) or sent: the box shows the rest, or closes.
  function noteBoxItemsChanged() {
    if (!noteBox.open) return;
    var left = noteBox.items.filter(function (x) { return pick.items.indexOf(x) >= 0; });
    if (left.length === noteBox.items.length) return;
    noteBox.items = left;
    if (left.length) renderNoteBox();
    else closeNoteBox({ focus: false });
  }
  // opts.added: Add or Enter (a short message says so). opts.focus: the panel's box gets the focus.
  function closeNoteBox(opts) {
    if (!noteBox.open) return;
    dictateStop(nbText);
    var note = nbText.value.trim();
    var nums = noteBox.items.filter(function (x) { return pick.items.indexOf(x) >= 0; }).map(function (x) { return x.n; });
    noteBox.open = false;
    noteBox.items = [];
    nbText.value = '';
    nbText.style.height = '';
    nbEl.classList.remove('on', 'list');
    storageSet('localStorage', NB_HINT_KEY, 'seen');
    if (note) {
      var before = input.value.replace(/\s+$/, '');
      input.value = (before ? before + '\n' : '') + (nums.length ? nums.join(' ') + ' ' : '') + note;
      autoGrow();
      saveDraft();
    }
    if (!opts.focus) return;
    if (state.panel !== 'open') setPanel('open');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollTop = input.scrollHeight;
    if (opts.added) showToast('Added to your message · Send when ready', 1800);
  }
  function nbGrow() {
    nbText.style.height = 'auto';
    nbText.style.height = nbText.scrollHeight + 'px';
    nbAdd.disabled = !nbText.value.trim();
    noteBox.h = 0;
    placeNoteBox();
  }
  nbText.addEventListener('input', nbGrow);
  nbText.addEventListener('keydown', function (e) {
    e.stopPropagation(); // the page's own shortcuts don't get keys typed here
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (pick.on) setPick(false);
      closeNoteBox({ added: true, focus: true });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (pick.on) setPick(false);
      closeNoteBox({ focus: true });
    }
  });
  nbAdd.addEventListener('click', function () {
    if (pick.on) setPick(false);
    closeNoteBox({ added: true, focus: true });
  });
  // A click anywhere else (not while picking: Shift+click adds to the same note).
  document.addEventListener('pointerdown', function (e) {
    if (!noteBox.open || pick.on || e.composedPath().indexOf(nbEl) >= 0) return;
    closeNoteBox({ focus: false });
  }, true);
  window.addEventListener('resize', function () {
    if (noteBox.open && !noteBoxUsable()) closeNoteBox({ focus: false });
  });
  // Below the newest pick with a point toward it, else above; beside a dragged area (right, else
  // left). Inside the window; hidden while the pick is scrolled out of view. Runs with placeMarks.
  function placeNoteBox() {
    if (!noteBox.open) return;
    var item = noteBox.items[noteBox.items.length - 1];
    var t = item && item.target;
    var r = t && t.isConnected !== false ? t.getBoundingClientRect() : null;
    var W = window.innerWidth;
    var H = window.innerHeight;
    var off = !r || r.bottom < 0 || r.top > H || r.right < 0 || r.left > W;
    nbEl.classList.toggle('gone', off);
    if (off) return;
    var M = 8;
    var GAP = 10;
    var w = Math.min(380, W - 2 * M);
    if (nbEl.style.width !== w + 'px' || !noteBox.h) {
      nbEl.style.width = w + 'px';
      noteBox.h = nbEl.offsetHeight;
    }
    var h = noteBox.h;
    var side = '';
    var left = 0;
    var top = 0;
    if (item.kind === 'region') {
      if (r.right + GAP + w <= W - M) side = 'lf', left = r.right + GAP;
      else if (r.left - GAP - w >= M) side = 'rt', left = r.left - GAP - w;
      top = clamp(r.top, M, H - h - M);
    }
    if (!side) {
      left = clamp(r.left - 6, M, W - w - M);
      if (r.bottom + GAP + h <= H - M) side = 'dn', top = r.bottom + GAP;
      else if (r.top - GAP - h >= M) side = 'up', top = r.top - GAP - h;
      else side = 'dn', top = clamp(r.bottom + GAP, M, H - h - M); // taller than the window
    }
    nbEl.style.left = px(left) + 'px';
    nbEl.style.top = px(top) + 'px';
    if (nbEl.dataset.side !== side) nbEl.dataset.side = side;
    if (side === 'dn' || side === 'up') nbEl.style.setProperty('--ax', px(clamp(r.left + Math.min(r.width / 2, 22) - left - 6, 12, w - 24)) + 'px');
    else nbEl.style.setProperty('--ay', px(clamp(r.top + Math.min(r.height / 2, 18) - top - 6, 10, h - 22)) + 'px');
  }
  // Pick numbers at the start of a line in the panel's message box get a round mark. A textarea
  // can't draw one, so a copy of its text without color lies behind it, with the marks.
  function renderInputMarks() {
    if (!pick) return;
    // Words still being heard (dictation) are drawn there instead, with the box's text.
    if (dictate && dictate.interim && dictate.box && dictate.box.area === input) return dictMirror(dictate.box);
    var marked = inputMarkKids();
    if (!marked.any) return inMirror.replaceChildren();
    inMirror.replaceChildren.apply(inMirror, marked.kids);
    var pad = parseFloat(getComputedStyle(inMirror).paddingLeft);
    inMirror.style.width = input.clientWidth + (Number.isFinite(pad) ? pad : 0) + 'px';
    inMirror.scrollTop = input.scrollTop;
  }
  // The box's text as nodes, with a mark on each pick number that starts a line. Also used for the
  // one line the box shows out of focus (renderShut). any: at least one mark.
  function inputMarkKids() {
    var have = Object.create(null);
    (pick ? pick.items : []).forEach(function (x) { have[x.n] = true; });
    var kids = [];
    var any = false;
    input.value.split('\n').forEach(function (line, i) {
      if (i) kids.push(document.createTextNode('\n'));
      var used = 0;
      var m = /^(?:\d{1,4} )+/.exec(line);
      (m ? m[0].split(' ').slice(0, -1) : []).every(function (num) {
        if (!have[num]) return false;
        kids.push(el('span', { class: 'imk', text: num }), document.createTextNode(' '));
        used += num.length + 1;
        any = true;
        return true;
      });
      kids.push(document.createTextNode(line.slice(used)));
    });
    return { kids: kids, any: any };
  }
  // The panel got wider or narrower: the marks follow the text's new line breaks.
  if (window.ResizeObserver) new ResizeObserver(function () { if (inMirror.firstChild) renderInputMarks(); }).observe(input);

  // Lines selected in the code view: a button offers to attach them.
  var codePick = el('button', { class: 'codepick', type: 'button' });
  var codeSel = null;
  codePick.addEventListener('mousedown', function (e) { e.preventDefault(); });
  codePick.addEventListener('click', function () {
    if (!codeSel) return;
    attach({ kind: 'code', file: codeSel.f.relFile || codeSel.f.file, line: codeSel.a, endLine: codeSel.b, text: codeSel.f.lines.slice(codeSel.a - 1, codeSel.b).join('\n').slice(0, 3000) }, null);
    codePick.classList.remove('on');
    codeSel = null;
    var s = selectionOf(dock);
    if (s) s.removeAllRanges();
  });
  function rowInfo(node) {
    var row = node && (node.nodeType === 1 ? node : node.parentElement);
    row = row && row.closest ? row.closest('.cl') : null;
    if (!row) return null;
    var key = Object.keys(files).find(function (k) { return files[k].codeEl.contains(row); });
    var f = key && files[key];
    var i = f ? f.rows.indexOf(row) : -1;
    return i >= 0 ? { f: f, line: i + 1 } : null;
  }
  function checkCodeSelection(e) {
    setTimeout(function () {
      var s = selectionOf(dock);
      var a = s && s.rangeCount && !s.isCollapsed ? rowInfo(s.anchorNode) : null;
      var b = a ? rowInfo(s.focusNode) : null;
      if (!a || !b || a.f !== b.f || player.current) {
        codePick.classList.remove('on');
        codeSel = null;
        if (sel.kind === 'code' && !player.current) clearSelection();
        return;
      }
      codeSel = { f: a.f, a: Math.min(a.line, b.line), b: Math.max(a.line, b.line) };
      selectLines(codeSel.f.relFile || codeSel.f.file, codeSel.a, codeSel.b, codeSel.f);
      codePick.textContent = 'Attach line' + (codeSel.b > codeSel.a ? 's ' + codeSel.a + '–' + codeSel.b : ' ' + codeSel.a) + ' for Claude';
      codePick.style.left = Math.min(window.innerWidth - 220, e.clientX + 8) + 'px';
      codePick.style.top = Math.max(8, e.clientY - 40) + 'px';
      codePick.classList.add('on');
    }, 0);
  }

  // ---------- page control: Claude runs from this page ----------
  // The page control key is kept in memory only; the server resends it after a reload.
  storageSet('sessionStorage', 'editlens.driveKey', null);
  var drive = { key: null, active: false, phase: null, sessionId: null, from: null, continued: false, working: false, model: null };
  var permCards = Object.create(null);
  var normalCommands = null;
  var setupShown = false; // page control's download notice is shown
  // The Send button becomes Stop while Claude works (renderSend). Manual is under the message box,
  // in the same place as "Turn on page control" when page control is off.
  var handBackButton = el('button', { class: 'mini pcoff', type: 'button', text: 'Manual', title: 'Switch to Manual: you run Claude in Claude Code again, and this page only shows what Claude does' });
  var driveText = el('span', { class: 't' });
  var driveBar = el('div', { class: 'drivebar', role: 'status' }, el('span', { class: 'dd' }), driveText);
  // Sign-in runs claude's own login in the browser; this page never sees credentials.
  var signin = { state: null, url: null, error: null, showCode: false, noBrowser: false };
  var signinBox = el('div', { class: 'signin', role: 'region', 'aria-label': 'Sign in to Claude' });
  function signinRequest(pathName, body) {
    return driveRequest(pathName, body).then(function (r) {
      if (r && r.error) throw new Error(r.error);
      return r;
    });
  }
  function startSignIn(useConsole) {
    signin.state = 'starting';
    signin.error = null;
    signin.url = null;
    signin.showCode = false;
    renderSignIn();
    signinRequest('/drive/signin', { console: useConsole }).catch(function (err) {
      signin.state = 'failed';
      signin.error = err.message;
      renderSignIn();
    });
  }
  function renderSignIn() {
    var on = drive.active && drive.phase === 'signin' && Boolean(drive.key);
    signinBox.classList.toggle('on', on);
    if (!on) return;
    var kids = [];
    var waiting = signin.state === 'starting' || signin.state === 'started' || signin.state === 'waiting';
    if (signin.state === 'done') {
      kids.push(el('p', { class: 'st', text: 'Signed in. Starting Claude…' }));
    } else if (waiting) {
      // Claude runs on a computer with no browser (a VPS): the sign-in page opens here, and its
      // code is pasted back, since that page cannot connect to the other computer by itself.
      var remote = signin.noBrowser;
      kids.push(el('p', { class: 'st' }, el('b', { text: remote ? 'Sign in to Claude on the sign-in page.' : 'Your browser opened to sign in to Claude.' }),
        document.createTextNode(remote ? ' Then paste the code it shows below.' : ' Finish there, and Claude starts here by itself.')));
      if (signin.url && /^https?:\/\//i.test(signin.url)) {
        var link = el('a', { href: signin.url, target: '_blank', rel: 'noopener noreferrer', text: remote ? 'Open the sign-in page' : "Browser didn't open? Open the sign-in page" });
        link.addEventListener('click', function () { signin.showCode = true; setTimeout(renderSignIn, 0); });
        kids.push(el('p', { class: 'sub' }, link));
      }
      if (signin.showCode || remote) {
        var codeInput = el('input', { type: 'text', class: 'code', placeholder: 'Paste the code the sign-in page shows', 'aria-label': 'Sign-in code', autocomplete: 'off', spellcheck: 'false' });
        var send = el('button', { class: 'mini', type: 'button', text: 'Continue' });
        var go = function () {
          var code = codeInput.value.trim();
          if (!code) return;
          send.disabled = true;
          signinRequest('/drive/signin-code', { code: code }).then(function () {
            codeInput.value = '';
          }, function (err) {
            send.disabled = false;
            showToast(err.message);
          });
        };
        send.addEventListener('click', go);
        codeInput.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') go(); });
        kids.push(el('p', { class: 'sub', text: 'If the page shows a code instead of finishing, paste it here:' }), el('div', { class: 'row' }, codeInput, send));
      }
      var cancel = el('button', { class: 'mini', type: 'button', text: 'Cancel' });
      cancel.addEventListener('click', function () {
        signinRequest('/drive/signin-cancel', {}).catch(function (err) { showToast(err.message); });
      });
      kids.push(el('div', { class: 'row' }, cancel));
    } else {
      kids.push(el('p', { class: 'st' }, el('b', { text: 'Claude needs you to sign in once' }),
        document.createTextNode(' before it can run from this page. ' + (drive.retry ? 'Your message is sent as soon as Claude starts.' : 'This only happens the first time.'))));
      if (signin.error) kids.push(el('p', { class: 'err', text: signin.error }));
      // An API key is the recommended way for tools built on the Agent SDK; the Console sign-in
      // gives one. A Claude plan sign-in still works.
      kids.push(el('p', { class: 'sub', text: 'Recommended: an API key. Set ANTHROPIC_API_KEY on this computer, then run /editlens control again. Or sign in:' }));
      var apiBilling = el('button', { class: 'mini allow', type: 'button', text: 'Sign in with Anthropic Console', title: 'Pay per use with API billing. Opens the sign-in page.' });
      apiBilling.addEventListener('click', function () { startSignIn(true); });
      var main = el('button', { class: 'mini', type: 'button', text: 'Sign in', title: 'Sign in with your Claude account (Pro, Max, Team or Enterprise). Opens the sign-in page.' });
      main.addEventListener('click', function () { startSignIn(false); });
      kids.push(el('div', { class: 'row' }, apiBilling, main));
    }
    signinBox.replaceChildren.apply(signinBox, kids);
  }
  function onSignIn(ev) {
    if (ev.state === 'cancelled') {
      signin.state = null;
    } else if (ev.state === 'failed') {
      signin.state = 'failed';
      signin.error = ev.error || "The sign-in didn't finish.";
    } else {
      signin.state = ev.state;
      if (ev.url) signin.url = ev.url;
      if (typeof ev.noBrowser === 'boolean') signin.noBrowser = ev.noBrowser;
    }
    renderSignIn();
  }
  function driving() {
    return Boolean(drive.key && drive.active);
  }
  var drivingDrawn = false; // driving() when the effort chip was last drawn
  function renderDrive() {
    renderSessionTags();
    renderAccess();
    // The effort chip can be changed only with page control's key: draw it again when that changes.
    if (driving() !== drivingDrawn) {
      drivingDrawn = driving();
      if (effortButton) {
        closeEffortMenu();
        renderEffort();
      }
    }
    driveBar.classList.toggle('on', drive.active);
    panel.classList.toggle('driving', driving());
    handBackButton.disabled = !drive.key;
    handBackButton.style.display = drive.active && drive.key ? '' : 'none';
    renderSend();
    if (!drive.active) return;
    var who = drive.sessionId ? ' · session ' + String(drive.sessionId).slice(0, 8) : '';
    var origin = drive.continued ? 'your earlier page conversation' : drive.from ? 'a copy of your conversation' : 'a new conversation';
    if (!drive.key) driveText.textContent = 'Claude is running from another tab or page' + who + '.';
    else if (drive.phase === 'signin') driveText.textContent = 'Page control is waiting for you to sign in to Claude.';
    else if (drive.phase === 'starting') driveText.textContent = 'Starting Claude on ' + origin + '…';
    else {
      driveText.replaceChildren(el('b', { text: 'Page control' }), el('span', { class: 'det', text: ' · ' + (drive.continued ? 'earlier page conversation' : drive.from ? 'copy of your conversation' : 'new conversation') + who + (drive.model ? ' · ' + drive.model : '') }));
      driveText.title = 'Claude runs from this page, on ' + origin + '. Messages start it immediately.';
    }
    driveBar.classList.toggle('busy', drive.working);
    if (!input.disabled) input.placeholder = driving() ? (drive.phase === 'signin' ? 'Message Claude (sent once you are signed in)…' : 'Message Claude (starts immediately)…') : INPUT_PLACEHOLDER;
    renderSignIn();
  }
  function driveRequest(pathName, body) {
    var payload = { key: drive.key, pageId: PAGE_ID };
    Object.keys(body || {}).forEach(function (k) { payload[k] = body[k]; });
    return postJson(pathName, payload).catch(function (err) {
      // Page control ended while this page was not connected: clear the key and show Manual.
      if ((err.body && err.body.notDriving) || /not driving/i.test(err.message)) {
        drive.key = null;
        renderDrive();
        updateHint();
      }
      throw err;
    });
  }
  handBackButton.addEventListener('click', function () {
    driveRequest('/drive/stop', {}).catch(function (err) { showToast('Could not switch to manual: ' + err.message); });
  });
  function onDriveGrant(ev) {
    if (typeof ev.key !== 'string') return;
    var newKey = drive.key !== ev.key;
    drive.key = ev.key;
    if (newKey) permActsAgain();
    drive.active = true;
    if (!ev.resume) {
      drive.from = ev.fromSessionId || null;
      drive.continued = Boolean(ev.continued);
    }
    renderDrive();
    updateHint();
    renderModes();
    if (!ev.resume) showToast(typeof ev.note === 'string' && ev.note ? ev.note : 'Claude now runs from this page', ev.note ? 12000 : undefined);
  }
  function onDriveStatus(ev) {
    // Ended while this page was not connected (a restart): it says why, never a plain Manual.
    if (!ev.active && (drive.active || drive.key)) return onDrive({ phase: 'ended', error: typeof ev.error === 'string' && ev.error ? ev.error : null });
    drive.active = Boolean(ev.active);
    drive.phase = ev.phase || null;
    drive.sessionId = typeof ev.sessionId === 'string' && ev.sessionId ? ev.sessionId : null;
    drive.from = ev.fromSessionId || null;
    drive.continued = Boolean(ev.continued);
    drive.working = Boolean(ev.working);
    drive.model = ev.model || null;
    drive.retry = Boolean(ev.retry);
    drive.mode = MODE_INFO[ev.mode] ? ev.mode : null;
    drive.agentModes = ev.agentModes && typeof ev.agentModes === 'object' ? ev.agentModes : {};
    if (ev.signin) {
      signin.state = 'waiting';
      signin.url = ev.signin.url || null;
    }
    (ev.permissions || []).forEach(addPermission);
    renderDrive();
    renderModes();
    updateHint();
  }
  function onDrive(ev) {
    if (ev.phase === 'ended') {
      drive.active = false;
      drive.continued = false;
      drive.working = false;
      drive.key = null;
      Object.keys(permCards).forEach(function (id) { settlePermission(id, 'cancelled'); });
      drive.commands = null;
      drive.mode = null;
      drive.agentModes = {};
      closeModeMenu();
      if (normalCommands) setCommands(normalCommands);
      drive.lastError = ev.error ? String(ev.error) : null;
      if (ev.error) showToast('Page control stopped: ' + ev.error, 12000);
      // Moved to another project by /editlens control take.
      else if (ev.note) showToast(String(ev.note), 12000);
      else showToast('Manual control: you control Claude in Claude Code again; this page only shows what Claude does.');
      state.working = false;
      setNow('');
    } else {
      drive.active = true;
      drive.lastError = null;
      drive.phase = ev.phase;
      if (typeof ev.sessionId === 'string' && ev.sessionId) drive.sessionId = ev.sessionId;
      if (ev.fromSessionId !== undefined) drive.from = ev.fromSessionId;
      if (ev.model) drive.model = ev.model;
      if (ev.phase === 'signin') {
        drive.retry = Boolean(ev.retry);
        if (signin.state !== 'failed') signin.state = null;
      }
      if (ev.phase === 'starting' || ev.phase === 'ready') signin = { state: null, url: null, error: null, showCode: false };
      // 'ready' can arrive after the first message (Claude starts with it), so it changes nothing.
      drive.working = ev.phase === 'working' ? true : ev.phase === 'idle' ? false : drive.working;
      state.working = drive.working;
      state.statusLabel = 'Working';
      if (ev.phase === 'working') {
        setNow('Thinking…');
        mainInfo.start = Date.now();
        mainInfo.end = 0;
        tabTitleDone(false);
      }
      if (ev.phase === 'idle' && mainInfo.start && !mainInfo.end) mainInfo.end = Date.now();
      if (ev.phase === 'idle') {
        setNow(ev.isError ? 'Claude stopped with an error.' : '');
        tabTitleDone(true);
      }
    }
    renderDrive();
    renderModes();
    refreshStatus();
  }
  // ---------- the EditLens window: where questions are allowed ----------
  // The page is code Claude edits, so nothing on it can allow a question or make the mode less strict.
  // Allow opens the EditLens window (server/answer.js, another origin the page can't script); the page
  // can only Deny. focus: the question to show first ('p:<id>', 't:<task>:<id>').
  function openAnswerWindow(focus) {
    // A paired computer's page: only its page control and task questions, while it allows it.
    var asked = /^[pt]:/.test(focus || '');
    if (state.via && !(asked && settings.values && settings.values.paired_answers === true)) {
      showToast('Answer this on ◆ ' + state.via + ' itself.' + (asked ? ' To answer from here, turn on "Paired computers can answer questions here" in /config on ◆ ' + state.via + '.' : ''), 12000);
      return;
    }
    openWindowAt(SERVER + '/answer' + (focus ? '#q=' + encodeURIComponent(focus) : ''), 'editlens-answer');
  }
  function openWindowAt(url, name) {
    leaveFullFor(); // a new window can't be drawn above a full-screen page
    var w = window.open(url, name, 'popup,width=460,height=640');
    if (!w) showToast('Your browser blocked the EditLens window. Allow pop-ups for this page, or open ' + url.replace(/#.*$/, ''), 12000);
  }
  // Allow… / Always allow… (in the EditLens window) and Deny (here). deny: function, or null when
  // this page can't deny it either.
  function answerActions(focus, canAlways, deny) {
    var acts = el('div', { class: 'pacts' });
    acts.appendChild(el('button', { class: 'mini allow', type: 'button', text: 'Allow…', title: 'Opens the EditLens window, where only you can allow it', on: { click: function () { openAnswerWindow(focus); } } }));
    if (canAlways) acts.appendChild(el('button', { class: 'mini', type: 'button', text: 'Always allow…', title: 'Opens the EditLens window: allow this kind of action for the rest of this session', on: { click: function () { openAnswerWindow(focus); } } }));
    if (deny) {
      acts.appendChild(el('button', { class: 'mini deny', type: 'button', text: 'Deny', on: { click: function (e) {
        e.currentTarget.disabled = true;
        var b = e.currentTarget;
        deny().catch(function (err) {
          b.disabled = false;
          showToast('Could not answer: ' + err.message, 6000);
        });
      } } }));
    }
    return acts;
  }

  // A tool call that the user's permission settings would need approval for.
  function addPermission(p) {
    if (!p || !p.id || permCards[p.id]) return;
    var body = el('div', { class: 'pbody' }, el('b', { text: p.title || ('Use ' + p.tool) }));
    if (p.warning) body.appendChild(el('div', { class: 'pwarn', role: 'alert', text: '⚠ ' + p.warning }));
    if (p.note) body.appendChild(el('div', { class: 'pnote', text: p.note }));
    if (p.detail) body.appendChild(el('pre', { class: 'pdetail', text: p.detail }));
    if (p.diff) body.appendChild(el('pre', { class: 'pdetail diffy' }, el('span', { class: 'rm', text: p.diff.before }), document.createTextNode('\n'), el('span', { class: 'ad', text: p.diff.after })));
    if (p.preview) body.appendChild(el('pre', { class: 'pdetail', text: p.preview }));
    var acts = permActs(p);
    var asker = p.agentKey && agents[p.agentKey] ? ownerLabel(p.agentKey) : p.agentId ? 'A subagent' : 'Claude';
    if (p.agentMode && MODE_INFO[p.agentMode]) body.appendChild(el('div', { class: 'pnote', text: 'This subagent is set to ' + modeLabel(p.agentMode) + ' in this panel.' }));
    var card = el('li', { class: 'k-perm' + (p.warning ? ' warned' : ''), 'data-owner': p.agentKey || (p.agentId ? 'a:' + p.agentId : 'main') }, el('div', { class: 'who', text: '✦ ' + asker + ' asks permission' }), body, acts);
    permCards[p.id] = { card: card, acts: acts, owner: p.agentKey || (p.agentId ? 'a:' + p.agentId : 'main'), p: p };
    swSoon();
    append(card, true);
    if (state.panel !== 'open') setPanel('open');
  }
  // Allow…, and Deny once this tab has page control's key.
  function permActs(p) {
    return answerActions('p:' + p.id, p.canAlways, drive.key ? function () { return driveRequest('/drive/permission', { id: p.id, decision: 'deny' }); } : null);
  }
  // The key arrived after the questions were drawn (a reloaded tab): their Deny is added now (Sol L7).
  function permActsAgain() {
    Object.keys(permCards).forEach(function (id) {
      var c = permCards[id];
      var acts = permActs(c.p);
      c.acts.replaceWith(acts);
      c.acts = acts;
    });
    pqSoon();
  }
  function settlePermission(id, decision) {
    var c = permCards[id];
    if (!c) return;
    delete permCards[id];
    swSoon();
    var words = dict({ allow: 'Allowed', always: 'Allowed for this session', deny: 'Denied', timeout: 'Denied (no answer in 10 minutes)', cancelled: 'Cancelled' });
    c.card.classList.add('done', decision === 'allow' || decision === 'always' ? 'ok' : 'no');
    c.acts.replaceChildren(el('span', { class: 'pres', text: words[decision] || decision }));
  }
  function addDriveMessage(ev) {
    var item = addUser(ev.text, 'page', ev.replay, ev.images, ev.ts, ev.computer, ev.host);
    if (Array.isArray(ev.attachments) && ev.attachments.length) item.querySelector('.bubble').after(attChips(ev.attachments));
  }

  // ---------- permission mode (Shift+Tab in Claude Code) ----------
  // Page control switches it here, for Claude and for each subagent. In Manual the page only
  // shows it, from the hooks: a page can't change the mode of a Claude Code window.
  var MODE_INFO = dict({
    default: ['Ask', 'Asks before edits and commands.'],
    acceptEdits: ['Accept edits', 'Edits files in this project without asking; asks before commands.'],
    plan: ['Plan', 'Reads and plans only; makes no changes.'],
    auto: ['Auto', 'A safety check approves or denies each step, and asks when unsure.'],
    dontAsk: ["Don't ask", 'Runs only what your settings already allow, and denies the rest.'],
    bypassPermissions: ['Bypass permissions', 'Runs every tool without asking.'],
  });
  // Alt+M: the modes that need no confirmation (Accept edits and Bypass are confirmed in the
  // EditLens window, from the menu).
  var MODE_CYCLE = ['default', 'plan', 'auto'];
  var AGENT_MODE_LIST = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
  // From the hooks: the newest main-agent mode, and each subagent's.
  var modeState = { hookMain: null, hookAgents: {} };
  drive.mode = null;
  drive.agentModes = {};
  function modeLabel(m) {
    return MODE_INFO[m] ? MODE_INFO[m][0] : '';
  }
  function mainMode() {
    return drive.active ? drive.mode : modeState.hookMain;
  }
  // { mode, own } for a subagent card key: own = it has a mode of its own.
  function agentModeOf(k) {
    var a = agents[k];
    var id = a && a.agentId;
    if (drive.active) {
      var own = drive.agentModes[k] || (id && drive.agentModes[id]) || null;
      return { mode: own || drive.mode, own: Boolean(own) };
    }
    var m = id ? modeState.hookAgents[id] : null;
    return { mode: m || modeState.hookMain, own: Boolean(m && m !== modeState.hookMain) };
  }
  function renderModes() {
    var m = mainMode();
    // Claude reports its mode with its first reply; in page control it can be picked before that.
    modeButton.classList.toggle('on', Boolean(MODE_INFO[m]) || driving());
    modeButton.classList.toggle('ro', !driving());
    modeButton.setAttribute('data-mode', m || '');
    modeButton.replaceChildren.apply(modeButton, [el('i'), el('span', { text: MODE_INFO[m] ? modeLabel(m) : 'Choose mode' })].concat(driving() ? [el('span', { class: 'ms', text: '· Alt+M' })] : []));
    modeButton.title = driving()
      ? (MODE_INFO[m] ? 'Permission mode: ' + MODE_INFO[m][1] : 'Claude says which permission mode it starts in with its first reply. Pick one now to set it.') + ' Click to change it, or press Alt+M in the message box.'
      : 'Permission mode in Claude Code: ' + (MODE_INFO[m] ? MODE_INFO[m][1] : '') + ' Change it there with Shift+Tab; a page can\'t change the mode of a Claude Code window. To change it here, turn on page control (' + PC_CMD + ').';
    Object.keys(agents).forEach(function (k) {
      var a = agents[k];
      if (!a.modeEl) return;
      var am = agentModeOf(k);
      a.modeEl.style.display = MODE_INFO[am.mode] || drive.active ? '' : 'none';
      a.modeEl.classList.toggle('own', am.own);
      a.modeEl.classList.toggle('ro', !driving() || Boolean(a.done));
      a.modeEl.setAttribute('data-mode', am.mode || '');
      a.modeEl.replaceChildren(el('i'), el('span', { text: MODE_INFO[am.mode] ? modeLabel(am.mode) : 'Mode' }));
      a.modeEl.title = (am.own ? 'This subagent has its own permission mode: ' : 'Same permission mode as Claude: ') + (MODE_INFO[am.mode] ? modeLabel(am.mode) + '. ' + MODE_INFO[am.mode][1] : 'not known yet.') +
        (driving() && !a.done ? ' Click to change it for this subagent only.' : !driving() ? ' Shown from Claude Code. To set it here, turn on page control (' + PC_CMD + ').' : '');
    });
    renderFollow();
    swSoon();
  }
  function closeModeMenu() {
    var open = [root].concat(pop.panel ? [pop.panel.root] : [], pop.dock ? [pop.dock.root] : []);
    open.forEach(function (r) { r.querySelectorAll('.lwrap.mwrap').forEach(function (n) { n.remove(); }); });
  }
  // target: 'main', or a subagent's card key.
  function openModeMenu(button, target) {
    closeModeMenu();
    closeLayoutMenu();
    var isMain = target === 'main';
    var current = isMain ? drive.mode : (drive.agentModes[target] || null);
    var menu = el('div', { class: 'lmenu modes', role: 'menu' });
    var wrap = el('div', { class: 'lwrap mwrap' }, menu);
    function item(mode, label, desc, act) {
      var b = el('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(mode === current), class: (mode === current ? 'on' : '') + (mode === 'bypassPermissions' ? ' danger' : '') },
        el('span', { class: 'mt' }, el('span', { text: label }), el('span', { class: 'md', text: desc })));
      b.addEventListener('click', act);
      menu.appendChild(b);
    }
    function choose(mode) {
      closeModeMenu();
      if (isMain) setMainMode(mode);
      else setAgentMode(target, mode);
    }
    menu.appendChild(el('div', { class: 'lh', text: isMain ? 'Permission mode' : 'Mode for ' + ownerLabel(target) }));
    if (!isMain) {
      item(null, 'Same as Claude' + (drive.mode ? ' (' + modeLabel(drive.mode) + ')' : ''), 'Follows Claude\'s mode as it changes.', function () { closeModeMenu(); setAgentMode(target, null); });
    }
    (isMain ? ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] : AGENT_MODE_LIST).forEach(function (m) {
      item(m, modeLabel(m), MODE_INFO[m][1] + (LOOSE_MODES[m] ? ' You confirm it in the EditLens window.' : ''), function () { choose(m); });
    });
    wrap.addEventListener('pointerdown', function (e) { if (e.target === wrap) closeModeMenu(); });
    wrap.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeModeMenu();
    });
    menuHost(button).appendChild(wrap);
    var view = button.ownerDocument.defaultView;
    var b = button.getBoundingClientRect();
    var mw = menu.offsetWidth;
    var mh = menu.offsetHeight;
    menu.style.left = Math.round(clamp(b.left, 8, view.innerWidth - mw - 8)) + 'px';
    menu.style.top = Math.round(b.top - mh - 6 > 8 ? b.top - mh - 6 : Math.min(view.innerHeight - mh - 8, b.bottom + 6)) + 'px';
    var first = menu.querySelector('button.on') || menu.querySelector('button');
    if (first) first.focus();
  }
  // Modes that let Claude do more without asking: only the EditLens window turns them on.
  var LOOSE_MODES = { acceptEdits: true, bypassPermissions: true };
  function modeDone(r) {
    if (r && r.error) showToast(r.error);
    else if (r && r.pending) showToast('Confirm the new mode in the EditLens window.');
  }
  function setMainMode(mode) {
    if (LOOSE_MODES[mode]) openAnswerWindow('');
    driveRequest('/drive/mode', { mode: mode }).then(modeDone).catch(function (err) { showToast('Could not change the mode: ' + err.message); });
  }
  function setAgentMode(k, mode) {
    var a = agents[k];
    if (LOOSE_MODES[mode] || (mode === null && LOOSE_MODES[drive.mode])) openAnswerWindow('');
    driveRequest('/drive/agent-mode', { agent: (a && a.key) || k, mode: mode, label: ownerLabel(k) }).then(modeDone).catch(function (err) { showToast('Could not change the mode: ' + err.message); });
  }
  function cycleMode() {
    var i = MODE_CYCLE.indexOf(drive.mode);
    setMainMode(MODE_CYCLE[(i + 1) % MODE_CYCLE.length]);
  }
  modeButton.addEventListener('click', function () {
    if (driving()) openModeMenu(modeButton, 'main');
    else showToast('This is Claude Code\'s permission mode. Change it there with Shift+Tab; a page can\'t change it. To change it here, turn on page control (' + PC_CMD + ').');
  });
  function onDriveMode(ev) {
    if (MODE_INFO[ev.mode]) drive.mode = ev.mode;
    drive.agentModes = ev.agentModes && typeof ev.agentModes === 'object' ? ev.agentModes : {};
    if (ev.note) showToast(ev.note);
    renderModes();
  }
  function onHookMode(ev) {
    if (!MODE_INFO[ev.mode]) return;
    if (ev.agentId) modeState.hookAgents[ev.agentId] = ev.mode;
    else modeState.hookMain = ev.mode;
    renderModes();
  }

  // ---------- pages without HMR: apply the change ourselves ----------
  function hasHmr() {
    return Boolean(
      document.querySelector('script[src*="/@vite/client"],script[src*="/_next/"],script[src*="webpack-dev-server"],script[src*="livereload"]') ||
      window.__NEXT_DATA__ || window.next || window.webpackHotUpdate || window.__webpack_require__ || window.__vite_plugin_react_preamble_installed__
    );
  }

  var STYLE_EXT = /\.(css)$/i;
  var PAGE_EXT = /\.html?$/i;

  function currentPageFile() {
    var p = location.pathname;
    return p.endsWith('/') ? 'index.html' : baseName(p);
  }

  function swapStylesheet(ev) {
    var name = baseName(ev.file);
    var links = Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]')).filter(function (l) {
      return baseName(new URL(l.href, location.href).pathname) === name;
    });
    links.forEach(function (link) {
      var next = link.cloneNode();
      var url = new URL(link.href, location.href);
      url.searchParams.set('edit-lens', String(Date.now()));
      next.href = url.href;
      next.addEventListener('load', function () { link.remove(); });
      next.addEventListener('error', function () { next.remove(); });
      link.after(next);
    });
    return links.length > 0;
  }

  // Three-way DOM morph. We keep the page's HTML source as last loaded (baseline) and apply only the
  // differences between that source and the new source to the live page. Content the app's own
  // scripts rendered (a list filled from an API, say) is not changed unless its source changed.
  var baseline = null;
  function fetchSource() {
    return fetch(location.href, { cache: 'no-store', credentials: 'same-origin', editlensOwn: true })
      .then(function (res) {
        if (!res.ok) throw new Error('could not load page: ' + res.status);
        return res.text();
      })
      .then(function (html) { return new DOMParser().parseFromString(html, 'text/html'); });
  }
  function sameNode(a, b) {
    if (!a || !b || a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
    if (a.nodeType !== 1) return true;
    return (a.id || '') === (b.id || '');
  }
  function morphAttrs3(live, old, neu) {
    Array.from(old.attributes).forEach(function (a) { if (!neu.hasAttribute(a.name)) live.removeAttribute(a.name); });
    Array.from(neu.attributes).forEach(function (a) { if (old.getAttribute(a.name) !== a.value) live.setAttribute(a.name, a.value); });
  }
  // Distance (1..LOOKAHEAD) to the next node in list (from start) equal to node, or 0.
  var LOOKAHEAD = 4;
  function findAhead(node, list, start) {
    for (var d = 1; d <= LOOKAHEAD && start + d < list.length; d++) if (list[start + d].isEqualNode(node)) return d;
    return 0;
  }
  function kids(node) {
    return Array.from(node.childNodes).filter(function (n) { return !isOurs(n) && n.nodeName !== 'SCRIPT'; });
  }
  // Returns false when the live page no longer matches its source here (scripts restructured it).
  function morph3(live, old, neu) {
    if (old.isEqualNode(neu)) return true;
    if (live.nodeName !== old.nodeName) return false;
    morphAttrs3(live, old, neu);
    var L = kids(live);
    var A = kids(old);
    var B = kids(neu);
    if (L.length !== A.length) return false;
    var ok = true;
    var i = 0;
    var j = 0;
    var k = 0;
    while (i < A.length || j < B.length) {
      var x = A[i];
      var y = B[j];
      if (!x) {
        live.insertBefore(document.importNode(y, true), L[L.length - 1] ? L[L.length - 1].nextSibling : null);
        j++;
      } else if (!y) {
        L[i].remove();
        i++;
      } else if (x.isEqualNode(y)) {
        i++;
        j++;
      } else if ((k = findAhead(x, B, j)) > 0) {
        for (; k > 0; k--) live.insertBefore(document.importNode(B[j++], true), L[i]); // inserted nodes
      } else if ((k = findAhead(y, A, i)) > 0) {
        for (; k > 0; k--) L[i++].remove(); // deleted nodes
      } else if (sameNode(x, y) && L[i].nodeName === x.nodeName) {
        if (x.nodeType === 1) ok = morph3(L[i], x, y) && ok;
        else L[i].nodeValue = y.nodeValue;
        i++;
        j++;
      } else {
        live.replaceChild(document.importNode(y, true), L[i]);
        i++;
        j++;
      }
    }
    return ok;
  }
  function morphPage() {
    if (!baseline) return Promise.reject(new Error('page source not loaded yet'));
    return fetchSource().then(function (next) {
      var old = baseline;
      baseline = next;
      if (next.title && next.title !== pageTitle()) {
        document.title = next.title;
        renderTabTitle();
      }
      var ok = morph3(document.body, old.body, next.body);
      next.querySelectorAll('link[rel~="stylesheet"][href]').forEach(function (l) {
        var href = new URL(l.getAttribute('href'), location.href).pathname;
        var exists = Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]')).some(function (c) {
          return new URL(c.href, location.href).pathname === href;
        });
        if (!exists) document.head.appendChild(document.importNode(l, true));
      });
      if (!ok) throw new Error('the page was restructured by its scripts');
      return true;
    });
  }

  // The page shows data from a route Claude just changed: once the (restarting) server responds on
  // that route again, reload and outline the elements the new response fills.
  function reloadForBackend(ev, hits) {
    var target = hits.find(function (h) { return h.method === 'GET'; });
    var deadline = Date.now() + 8000;
    // A request that never answers is stopped at the deadline, and the page reloads then.
    function ready() {
      if (!target) return Promise.resolve();
      var left = deadline - Date.now();
      if (left <= 0) return Promise.resolve();
      var stop = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = 0;
      var late = new Promise(function (resolve) {
        timer = setTimeout(function () {
          if (stop) stop.abort();
          resolve(null);
        }, left);
      });
      var asked = fetch(target.path, { cache: 'no-store', credentials: 'same-origin', editlensOwn: true, signal: stop ? stop.signal : undefined }).then(
        function (res) {
          clearTimeout(timer);
          return res.ok || Date.now() >= deadline ? null : retry();
        },
        function (err) {
          // Not answering yet (TypeError), or stopped at the deadline (AbortError).
          if (!(err instanceof TypeError || err instanceof DOMException)) throw err;
          clearTimeout(timer);
          return Date.now() >= deadline ? null : retry();
        });
      return Promise.race([asked, late]);
    }
    function retry() {
      return new Promise(function (r) { setTimeout(r, 400); }).then(ready);
    }
    // Give a file-watching server a moment to notice the edit and restart.
    setTimeout(function () {
      ready().then(function () {
        storageSet('sessionStorage', 'editlens.after-reload', JSON.stringify({
          backendPaths: hits.map(function (h) { return h.path; }),
          label: (target || hits[0]).method + ' ' + (target || hits[0]).path + ' changed',
          ev: peekLite(ev),
          at: Date.now(),
        }));
        location.reload();
      });
    }, 1200);
  }

  function reloadWithHighlight(ev) {
    storageSet('sessionStorage', 'editlens.after-reload', JSON.stringify({ hints: ev.hints, label: labelFor(ev), at: Date.now(), ev: peekLite(ev) }));
    location.reload();
  }

  // Resolves once the page reflects the change (never resolves when the page reloads).
  function applyWithoutHmr(ev) {
    if (OPTS.reload === 'off' || hasHmr() || ev.kind === 'backend') return Promise.resolve('hmr');
    var file = ev.file || '';
    if (STYLE_EXT.test(file)) return Promise.resolve(swapStylesheet(ev) ? 'css' : 'none');
    if (PAGE_EXT.test(file)) {
      if (baseName(file) !== currentPageFile()) return Promise.resolve('other-page');
      if (OPTS.reload === 'full') { reloadWithHighlight(ev); return new Promise(function () {}); }
      return morphPage().then(
        function () { return 'morph'; },
        function (err) {
          console.warn('[EditLens] live update failed, reloading the page:', err);
          reloadWithHighlight(ev);
          return new Promise(function () {});
        });
    }
    if (/\.(m?js|ts)$/i.test(file) && OPTS.reload !== 'morph' && isLoadedScript(file)) {
      reloadWithHighlight(ev);
      return new Promise(function () {});
    }
    return Promise.resolve('none');
  }
  function isLoadedScript(file) {
    var name = baseName(file);
    return Array.from(document.scripts).some(function (s) { return s.src && baseName(new URL(s.src, location.href).pathname) === name; });
  }

  function inScope(ev) {
    // A task's edit in a copy of the asking computer's project: shown with the project it was given to.
    if (ev.remote && ev.remote.anywhere) return true; // a paired computer's own project: every page here
    var f = ev.taskCwd || ev.realFile || ev.file || ev.cwd;
    if (!OPTS.root || !f) return true;
    // Same rules as lib/paths.js: C:\\proj and C:/proj are the same folder.
    var norm = function (p) {
      var x = String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
      return /^[a-z]:(\/|$)/i.test(x) ? x.toLowerCase() : x;
    };
    var a = norm(OPTS.root);
    var b = norm(f);
    return b === a || b.indexOf(a + '/') === 0 || a.indexOf(b + '/') === 0;
  }

  // ---------- the browser tab's title: "● Done · App", "(2) Needs your answer · App" ----------
  // Only while the tab is hidden (another tab or app is in front), so the user can wait elsewhere.
  // The page's own title (and any change the page makes to it) is kept: the words go before it and
  // are removed when the tab is visible again.
  var tabTitle = { shown: null, own: '', done: false, watch: null };
  // The page's title without the words added here.
  function pageTitle() {
    return tabTitle.shown !== null && document.title === tabTitle.shown ? tabTitle.own : document.title;
  }
  function tabLookedAt() {
    if (document.visibilityState === 'visible' && document.hasFocus()) return true;
    // The panel or the code view in its own window counts as this page.
    return ['panel', 'dock'].some(function (w) {
      var p = pop[w];
      return Boolean(p && p.win && !p.win.closed && p.win.document.hasFocus());
    });
  }
  function renderTabTitle() {
    if (!tabTitle) return; // called while the page script is still being built
    var own = pageTitle();
    tabTitle.own = own;
    var away = !tabLookedAt();
    var n = away && pq ? pqQuestions().length : 0;
    var words = n > 0 ? '(' + (n > 99 ? '99+' : n) + ') Needs your answer · ' : away && tabTitle.done ? '● Done · ' : '';
    if (!words) {
      if (tabTitle.shown !== null && document.title === tabTitle.shown) document.title = own;
      tabTitle.shown = null;
      if (tabTitle.watch) tabTitle.watch.disconnect();
      return;
    }
    var next = words + (own || location.host);
    tabTitle.shown = next;
    if (document.title !== next) document.title = next;
    // The page sets its own title (a new route): keep it, with the words before it.
    if (typeof MutationObserver === 'function' && document.head) {
      if (!tabTitle.watch) tabTitle.watch = new MutationObserver(function () {
        if (tabTitle.shown !== null && document.title !== tabTitle.shown) renderTabTitle();
      });
      tabTitle.watch.observe(document.head, { subtree: true, childList: true, characterData: true });
    }
  }
  // Claude finished: shown in the title only when it finished while the tab was hidden.
  function tabTitleDone(on) {
    tabTitle.done = Boolean(on) && !tabLookedAt();
    renderTabTitle();
  }
  function tabTitleSeen() {
    if (!tabLookedAt()) return renderTabTitle();
    tabTitle.done = false;
    renderTabTitle();
  }
  document.addEventListener('visibilitychange', tabTitleSeen);
  window.addEventListener('focus', tabTitleSeen);
  window.addEventListener('blur', tabTitleSeen);

  // ---------- split screen: live code view (handoff 15) ----------
  // Shows files Claude edits or opens with show_code, edits line by line: a header, a sidebar (Edits,
  // Files, Agents), one or more code panes with their own tabs, and an edit timeline at the bottom.
  // 29-codeview.js draws and runs it.
  var DOCK_MIN = 320;
  var SPEEDS = [0.5, 1, 2, 4];
  var MAX_FILES = 8;
  var SPLIT_PANES = 3;
  var TIMELINE_MAX = 40;
  var SIDE_TABS = ['edits', 'files', 'agents'];
  var SHEET_SIZES = ['low', 'half', 'full'];

  var dockState = {
    mode: storageGet('localStorage', 'editlens.dock') || 'auto', // auto: opens on the first code event
    open: false,
    width: num(storageGet('localStorage', 'editlens.dockWidth'), 0, DOCK_MIN, 4000),
    layout: storageGet('localStorage', 'editlens.dockLayout') === 'tabs' ? 'tabs' : 'split',
    speed: num(storageGet('localStorage', 'editlens.speed'), 1, 0.25, 8),
    // Wrap long lines: on unless the user turned it off. 'on'/'off' are their choice; anything else
    // means no choice (before 0.24.34 off was not stored, so those users get the default).
    wrap: storageGet('localStorage', 'editlens.wrap') !== 'off',
    // Docked to a side and collapsed to a narrow bar (the page has more space).
    collapsed: storageGet('localStorage', 'editlens.dockCollapsed') === '1',
    unseen: 0, // edits while collapsed
    expandNext: false, // the next edit of a new request opens it again
    // The sidebar is shown unless hidden (Alt+Shift+B); which list it shows.
    side: storageGet('localStorage', 'editlens.dockSide') !== 'off',
    sideTab: SIDE_TABS.indexOf(storageGet('localStorage', 'editlens.dockSideTab')) >= 0 ? storageGet('localStorage', 'editlens.dockSideTab') : 'edits',
    // On a phone the code view is a bottom sheet at one of three heights.
    sheet: SHEET_SIZES.indexOf(storageGet('localStorage', 'editlens.dockSheet')) >= 0 ? storageGet('localStorage', 'editlens.dockSheet') : 'half',
  };
  var RAIL = 30;
  var files = Object.create(null); // key -> file view
  var fileOrder = []; // keys, most recently active last
  var activeKey = null; // the file shown in the focused pane
  // The panes, in screen order: each one has its own tabs ({ keys, active, el, tabs, info, body }).
  // Files the user picks open in the focused pane (the one last clicked); Claude's edits and Follow
  // open in the follow pane (the first one unless the user picks another).
  var groups = [];
  var focusGroup = 0;
  var followGroup = 0;

  // The header.
  var sideButton = el('button', { class: 'icon dsb', type: 'button', 'aria-keyshortcuts': 'Alt+Shift+B' }, icon('side'));
  var crumbEl = el('div', { class: 'crumb' });
  var dockPqBadge = el('button', { class: 'dpqb', type: 'button', hidden: '' }, icon('shield'), el('span', { class: 'n' }));
  var followHead = el('button', { class: 'fchip fhead', type: 'button', 'aria-haspopup': 'menu' });
  var prevButton = el('button', { class: 'icon', type: 'button', title: 'Previous edit (←)', 'aria-label': 'Previous edit' }, icon('chevl'));
  var pauseButton = el('button', { class: 'icon', type: 'button' }, icon('play'));
  var nextButton = el('button', { class: 'icon', type: 'button', title: 'Next edit (→)', 'aria-label': 'Next edit' }, icon('chevr'));
  var dockQueue = el('span', { class: 'dqueue', role: 'status' });
  var capsuleEl = el('div', { class: 'capsule', role: 'group', 'aria-label': 'Playback' }, prevButton, pauseButton, nextButton, dockQueue);
  var layoutButton = el('button', { class: 'icon', type: 'button' }, icon('split'));
  var dockLayoutButton = el('button', { class: 'icon', type: 'button', title: 'View: wrap, text size, speed and position', 'aria-label': 'View', 'aria-haspopup': 'menu' }, icon('more'));
  var dockClose = el('button', { class: 'icon xred', type: 'button', title: 'Close the code view (Esc). It opens again for your next request.', 'aria-label': 'Close the code view' }, icon('close'));
  var dockHead = el('div', { class: 'dhead' }, sideButton, crumbEl, el('span', { class: 'dgap' }), dockPqBadge, followHead, capsuleEl, layoutButton, dockLayoutButton, dockClose);
  // The arrow tab on the code view's inner edge: collapse to a narrow bar and back.
  var dockCollapse = el('button', { class: 'dtab', type: 'button', title: 'Collapse to a narrow bar (Alt+Shift+D)', 'aria-label': 'Collapse the code view' }, icon('chevr'));
  var railCount = el('span', { class: 'rn' });
  var dockRail = el('button', { class: 'drail', type: 'button', title: 'Expand the code view (Alt+Shift+D)', 'aria-label': 'Expand the code view' },
    el('span', { class: 'ri' }), el('span', { class: 'rt', text: 'Code view' }), railCount);
  // The sidebar: Edits, Files and Agents.
  var sideTabsEl = el('div', { class: 'dseg', role: 'tablist', 'aria-label': 'Sidebar' });
  var sideEdits = el('div', { class: 'spanel sedits', role: 'tabpanel', 'aria-label': 'Edits' });
  var sideFiles = el('div', { class: 'spanel sfiles', role: 'tabpanel', 'aria-label': 'Files' });
  var sideAgents = el('div', { class: 'spanel sagents', role: 'tabpanel', 'aria-label': 'Agents' });
  var sideFoot = el('div', { class: 'sfoot' });
  var sideEl = el('nav', { class: 'dside', 'aria-label': 'Edits, files and agents' }, sideTabsEl, el('div', { class: 'sbody' }, sideEdits, sideFiles, sideAgents), sideFoot);
  // The strip left when the sidebar is hidden.
  var stripEl = el('div', { class: 'dstrip', role: 'toolbar', 'aria-label': 'Sidebar', 'aria-orientation': 'vertical' });
  var pageNoteEl = el('div', { class: 'fpnote', role: 'status' });
  var dockEmpty = el('div', { class: 'dempty', text: 'Files Claude edits or opens appear here. Each edit is shown line by line so you can follow it.' });
  var panesEl = el('div', { class: 'panes', 'data-layout': dockState.layout }, dockEmpty);
  // The timeline: one tick per edit, a marker at the current position, the speed at the end.
  var tlStart = el('span', { class: 'tl0' });
  var tlTrack = el('div', { class: 'track', role: 'slider', tabindex: '0', 'aria-label': 'Edits: drag or click to go to one', 'aria-valuemin': '1' });
  var tlEnd = el('span', { class: 'tl1', text: 'now' });
  var tlPrev = el('button', { class: 'icon tlp', type: 'button', title: 'Previous edit', 'aria-label': 'Previous edit' }, icon('chevl'));
  var tlNext = el('button', { class: 'icon tln', type: 'button', title: 'Next edit', 'aria-label': 'Next edit' }, icon('chevr'));
  var speedButton = el('button', { class: 'speed', type: 'button', title: 'Playback speed' });
  var timelineEl = el('div', { class: 'timeline' }, tlPrev, tlStart, tlTrack, tlEnd, tlNext, speedButton);
  var dockMain = el('div', { class: 'dmain' }, pageNoteEl, panesEl, timelineEl);
  var dockBody = el('div', { class: 'dbody' }, sideEl, stripEl, dockMain);
  // A sheet inside the code view: the file button's lists in a narrow code view, or Settings.
  var dockSheetEl = el('div', { class: 'dsheet', role: 'dialog', 'aria-modal': 'true' });
  // A phone: the drag handle changes the sheet's height.
  var dockGrab = el('button', { class: 'dgrab', type: 'button', 'aria-label': 'Change the code view\'s height' }, el('i'));
  var resizer = el('div', { class: 'resizer', title: 'Drag to resize' });
  var dockFullButton = el('button', { class: 'icon', type: 'button', title: 'Full screen' }, icon('full'));
  var dockGrip = el('div', { class: 'grip', title: 'Drag to resize' });
  // A copy of a button that clicks it: the same icon, tooltip and state, kept the same as it.
  function mirrorButton(src, cls, onClick) {
    var b = el('button', { class: cls, type: 'button' });
    var sync = function () {
      b.replaceChildren.apply(b, Array.prototype.map.call(src.childNodes, function (n) { return n.cloneNode(true); }));
      b.title = src.title || '';
      b.setAttribute('aria-label', src.getAttribute('aria-label') || src.title || '');
      b.disabled = Boolean(src.disabled);
      b.style.display = src.style.display;
      var pressed = src.getAttribute('aria-pressed');
      if (pressed === null) b.removeAttribute('aria-pressed');
      else b.setAttribute('aria-pressed', pressed);
    };
    sync();
    if (typeof MutationObserver === 'function') new MutationObserver(sync).observe(src, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'disabled', 'style', 'aria-pressed'] });
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (onClick) return onClick(b);
      src.click();
    });
    return b;
  }
  // The narrow bar keeps the controls that still work there (play, next, speed, Select, full screen,
  // View, close). Select (the panel's arrow button) is here so elements can be picked while collapsed.
  var railTools = el('div', { class: 'rtools', role: 'toolbar', 'aria-label': 'Code view controls' });
  [pauseButton, nextButton, speedButton, pointButton, dockFullButton, dockLayoutButton, dockClose].forEach(function (src) {
    // A menu opens beside the button pressed, here on the bar.
    railTools.appendChild(mirrorButton(src, 'icon' + (src === dockClose ? ' xred' : src === speedButton ? ' speed' : ''), src === dockLayoutButton ? function (b) { openViewMenu(b); } : null));
  });
  var dock = el('aside', { class: 'dock', 'aria-label': 'Code view' }, resizer, dockGrab, dockHead, dockBody, dockSheetEl, dockGrip, railTools, dockRail, dockCollapse);
  root.insertBefore(dock, panel);

