  // Part of the page script: the files in client/src are joined in order (lib/client-script.js)
  // and share the one scope opened in 1-panel.js.
  // Code view and panel can dock, float, or pop out (Document PiP if available, else a pop-up).
  // Popping out moves the panel's own elements, so everything keeps working. Saved per site.
  var LAYOUT_KEY = 'editlens.layout';
  var CORNERS = ['br', 'bl', 'tr', 'tl'];
  var DOCK_MODES = ['right', 'left', 'bottom', 'float'];
  var EDGE = 20;
  var SNAP = 28;
  var snapEl = el('div', { class: 'snap' });
  function defaultLayout() {
    // agents: the Agents switcher's left and bottom once dragged; null = beside the panel.
    return { panel: { mode: 'corner', corner: 'br', x: null, y: null, w: null, h: null }, dock: { mode: 'right', bh: null, x: null, y: null, w: null, h: null }, agents: { x: null, b: null } };
  }
  function loadLayout() {
    var out = defaultLayout();
    var saved = null;
    try {
      saved = JSON.parse(storageGet('localStorage', LAYOUT_KEY) || 'null');
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    if (!saved || typeof saved !== 'object') return out;
    var p = saved.panel || {};
    var d = saved.dock || {};
    if (p.mode === 'float') out.panel.mode = 'float';
    if (CORNERS.indexOf(p.corner) >= 0) out.panel.corner = p.corner;
    if (DOCK_MODES.indexOf(d.mode) >= 0) out.dock.mode = d.mode;
    // Clamped to the window when used; here only invalid values (NaN, text) are removed.
    ['x', 'y', 'w', 'h'].forEach(function (k) {
      out.panel[k] = num(p[k], null, -20000, 20000);
      out.dock[k] = num(d[k], null, -20000, 20000);
    });
    out.dock.bh = num(d.bh, null, 120, 20000);
    // The panel's size on a phone, kept apart from its size in a wider window.
    out.panel.pw = num(p.pw, null, 200, 20000);
    out.panel.ph = num(p.ph, null, 160, 20000);
    var ag = saved.agents || {};
    out.agents.x = num(ag.x, null, -20000, 20000);
    out.agents.b = num(ag.b, null, -20000, 20000);
    if (out.agents.x === null || out.agents.b === null) out.agents.x = out.agents.b = null;
    return out;
  }
  var layout = loadLayout();
  function saveLayout() {
    storageSet('localStorage', LAYOUT_KEY, JSON.stringify(layout));
  }
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  function dockHeight() {
    var h = layout.dock.bh || Math.round(window.innerHeight * 0.4);
    return clamp(h, Math.min(200, window.innerHeight - 120), Math.max(200, window.innerHeight - 160));
  }
  // The page's own inline styles, restored when the code view moves or closes.
  var pageShift = null;
  function setPageShift(s) {
    var st = document.documentElement.style;
    if (!pageShift) pageShift = { marginRight: st.marginRight, marginLeft: st.marginLeft, paddingBottom: st.paddingBottom };
    st.marginRight = s && s.right ? s.right + 'px' : pageShift.marginRight;
    st.marginLeft = s && s.left ? s.left + 'px' : pageShift.marginLeft;
    st.paddingBottom = s && s.bottom ? s.bottom + 'px' : pageShift.paddingBottom;
    if (!s) pageShift = null;
  }
  function dockSide() {
    return dockState.open && !pop.dock && window.innerWidth > 760 && layout.dock.mode !== 'float' ? layout.dock.mode : null;
  }
  function placeDock() {
    var mode = pop.dock ? 'popped' : layout.dock.mode;
    dock.classList.toggle('on', dockState.open || Boolean(pop.dock));
    dock.setAttribute('data-size', state.size);
    ['left', 'bottom', 'float'].forEach(function (m) { dock.classList.toggle(m, mode === m); });
    dock.classList.toggle('popped', mode === 'popped');
    var rail = railOn();
    dock.classList.toggle('rail', rail);
    var w = rail ? RAIL : dockWidth();
    dock.style.setProperty('--dock-w', w + 'px');
    dock.style.setProperty('--dock-h', (rail ? RAIL : dockHeight()) + 'px');
    renderRail();
    var st = dock.style;
    st.left = st.top = st.width = st.height = '';
    if (mode === 'float') {
      var r = floatRect(layout.dock, 560, Math.round(window.innerHeight * 0.7), 340, 260);
      // Not moved yet: keep it beside the open panel, so the panel never covers its resize grip.
      var pr = layout.dock.x === null && !pop.panel && state.panel === 'open' ? panel.getBoundingClientRect() : null;
      if (pr && pr.width && r.x < pr.right && r.x + r.w > pr.left && r.y < pr.bottom && r.y + r.h > pr.top && pr.left - EDGE - r.w >= 0) {
        r.x = Math.round(pr.left - EDGE - r.w);
      }
      st.left = r.x + 'px';
      st.top = r.y + 'px';
      st.width = r.w + 'px';
      st.height = r.h + 'px';
    }
    // A narrow bar always gets its own space, even in a small window, so it never covers the page.
    placeSheet(rail);
    var side = rail ? layout.dock.mode : dockSide();
    setPageShift(side === 'right' ? { right: w } : side === 'left' ? { left: w } : side === 'bottom' ? { bottom: rail ? RAIL : dockHeight() } : null);
    sizeDockRows();
  }
  function sizeDockRows() {
    sizeDock();
    var h = dock.clientHeight;
    if (!Number.isFinite(h) || h <= 0) return;
    dock.classList.toggle('short', h < 330);
    dock.classList.toggle('tiny', h < 250);
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(sizeDockRows).observe(dock);
  function railOn() {
    // Full screen from the narrow bar shows the whole code view; the bar returns when it ends.
    return dockState.collapsed && dockState.open && !pop.dock && layout.dock.mode !== 'float' && !(fullFallback && isFull('dock'));
  }
  function renderRail() {
    var m = layout.dock.mode;
    var rail = railOn();
    dockCollapse.style.display = pop.dock || m === 'float' ? 'none' : '';
    // Points the way it moves: toward the edge to collapse, away from it to expand.
    var toEdge = m === 'left' ? 'chevl' : m === 'bottom' ? 'minimize' : 'chevr';
    var fromEdge = m === 'left' ? 'chevr' : m === 'bottom' ? 'chevu' : 'chevl';
    dockCollapse.replaceChildren(icon(rail ? fromEdge : toEdge));
    dockCollapse.title = rail ? 'Expand the code view (Alt+Shift+D)' : 'Collapse to a narrow bar (Alt+Shift+D)';
    dockCollapse.setAttribute('aria-label', rail ? 'Expand the code view' : 'Collapse the code view');
    dockRail.querySelector('.ri').replaceChildren(icon(m === 'left' ? 'chevr' : m === 'bottom' ? 'chevu' : 'chevl'));
    railCount.textContent = dockState.unseen ? String(dockState.unseen) : '';
    railCount.title = dockState.unseen ? dockState.unseen + ' edit' + (dockState.unseen === 1 ? '' : 's') + ' since you collapsed it' : '';
    var cur = player && player.current && player.current.ev ? baseName(player.current.ev.relFile || player.current.ev.file) : '';
    dockRail.title = 'Expand the code view (Alt+Shift+D)' + (cur ? ' · playing ' + cur : '');
  }
  function setDockCollapsed(on) {
    dockState.collapsed = Boolean(on);
    if (!on) dockState.unseen = 0;
    storageSet('localStorage', 'editlens.dockCollapsed', on ? '1' : null);
    dock.classList.add('anim');
    setTimeout(function () { dock.classList.remove('anim'); }, 260);
    renderDock();
  }
  function toggleDockCollapsed() {
    if (!dockState.open && !pop.dock) {
      setDock(true, false);
      return setDockCollapsed(false);
    }
    if (pop.dock || layout.dock.mode === 'float') return showToast('The code view collapses when it is beside the page or at the bottom. In View, choose Left, Right or At the bottom.');
    setDockCollapsed(!dockState.collapsed);
  }
  // A floating window's box, kept fully on screen.
  function floatRect(L, dw, dh, minW, minH) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    // Never wider or taller than the window, even when it is smaller than the minimum.
    var w = clamp(L.w || dw, Math.min(minW, vw - 8), Math.max(40, vw - 8));
    var h = clamp(L.h || dh, Math.min(minH, vh - 8), Math.max(40, vh - 8));
    var x = clamp(L.x === null ? vw - w - EDGE : L.x, 0, Math.max(0, vw - w));
    var y = clamp(L.y === null ? EDGE : L.y, 0, Math.max(0, vh - h));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }
  // The part of the window the page still shows, beside a docked code view.
  function pageArea() {
    var a = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    var rail = railOn();
    var side = rail ? layout.dock.mode : dockSide();
    if (side === 'right') a.right -= rail ? RAIL : dockWidth();
    else if (side === 'left') a.left += rail ? RAIL : dockWidth();
    else if (side === 'bottom') a.bottom -= rail ? RAIL : dockHeight();
    return a;
  }
  function placePanel() {
    var ps = panel.style;
    var qs = pill.style;
    ['left', 'right', 'top', 'bottom', 'width', 'height', 'maxWidth', 'maxHeight'].forEach(function (k) { ps[k] = ''; qs[k] = ''; });
    panel.classList.toggle('float', layout.panel.mode === 'float' && !pop.panel);
    panel.removeAttribute('data-corner');
    panel.classList.remove('phone');
    if (pop.panel) return; // popped out: its own window sets the size
    if (window.innerWidth <= 480) {
      // A phone: the stylesheet places it across the bottom; the grip in its top-left corner
      // changes its height and width, remembered for phones only.
      var P = layout.panel;
      panel.classList.add('phone');
      panel.setAttribute('data-corner', 'br');
      if (P.ph) ps.height = clamp(P.ph, 200, window.innerHeight - 24) + 'px';
      if (P.pw) {
        ps.width = clamp(P.pw, 240, window.innerWidth - 24) + 'px';
        ps.left = 'auto';
      }
      return;
    }
    var a = pageArea();
    // A short window with the code view docked at the bottom: the panel uses the full window height
    // (over the code view) so its header stays on screen.
    if (a.bottom - a.top - EDGE * 2 < 220) a = { left: a.left, right: a.right, top: 0, bottom: window.innerHeight };
    var L = layout.panel;
    // As big as the page area allows, and never bigger than the window (its header stays on screen).
    var aw = Math.min(window.innerWidth - 8, Math.max(260, a.right - a.left - EDGE * 2));
    var ah = Math.min(window.innerHeight - 8, Math.max(220, a.bottom - a.top - EDGE * 2));
    ps.maxWidth = aw + 'px';
    ps.maxHeight = ah + 'px';
    if (L.w) ps.width = clamp(L.w, Math.min(320, aw), aw) + 'px';
    if (L.h) ps.height = clamp(L.h, Math.min(280, ah), ah) + 'px';
    if (L.mode === 'float') {
      var w = panel.offsetWidth || 440;
      var h = panel.offsetHeight || 600;
      var x = clamp(L.x === null ? a.right - w - EDGE : L.x, 0, Math.max(0, window.innerWidth - w));
      var y = clamp(L.y === null ? a.bottom - h - EDGE : L.y, 0, Math.max(0, window.innerHeight - h));
      ps.left = qs.left = Math.round(x) + 'px';
      ps.top = qs.top = Math.round(y) + 'px';
      ps.right = ps.bottom = qs.right = qs.bottom = 'auto';
      return;
    }
    var c = L.corner;
    panel.setAttribute('data-corner', c);
    var hz = c[1] === 'r' ? 'right' : 'left';
    var vt = c[0] === 'b' ? 'bottom' : 'top';
    ps[hz] = qs[hz] = (hz === 'right' ? window.innerWidth - a.right : a.left) + EDGE + 'px';
    ps[vt] = qs[vt] = (vt === 'bottom' ? window.innerHeight - a.bottom : a.top) + EDGE + 'px';
    ps[hz === 'right' ? 'left' : 'right'] = qs[hz === 'right' ? 'left' : 'right'] = 'auto';
    ps[vt === 'bottom' ? 'top' : 'bottom'] = qs[vt === 'bottom' ? 'top' : 'bottom'] = 'auto';
  }

  // Where a dragged window would dock if dropped now.
  function snapFor(which, x, y, rect) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    if (which === 'dock') {
      if (vw <= 760) return null;
      if (x < SNAP) return { mode: 'left', box: { left: 0, top: 0, width: dockWidth(), height: vh } };
      if (x > vw - SNAP) return { mode: 'right', box: { left: vw - dockWidth(), top: 0, width: dockWidth(), height: vh } };
      if (y > vh - SNAP) return { mode: 'bottom', box: { left: 0, top: vh - dockHeight(), width: vw, height: dockHeight() } };
      return null;
    }
    var a = pageArea();
    var h = rect.left - a.left < SNAP ? 'l' : a.right - rect.right < SNAP ? 'r' : null;
    var v = rect.top - a.top < SNAP ? 't' : a.bottom - rect.bottom < SNAP ? 'b' : null;
    if (!h || !v) return null;
    return {
      corner: v + h,
      box: { left: h === 'l' ? a.left + EDGE : a.right - EDGE - rect.width, top: v === 't' ? a.top + EDGE : a.bottom - EDGE - rect.height, width: rect.width, height: rect.height },
    };
  }
  function showSnap(target) {
    snapEl.classList.toggle('on', Boolean(target));
    if (target) placeRect(snapEl, target.box);
  }
  // Drag a window by its title area. Dragging a docked code view makes it float.
  function startMove(which, e) {
    var node = which === 'dock' ? dock : panel;
    if (e.button !== 0 || pop[which] || window.innerWidth <= 480) return;
    if (e.target.closest && e.target.closest('button,a,input,textarea,select,.meters,.usage')) return;
    var handle = e.currentTarget;
    var startX = e.clientX;
    var startY = e.clientY;
    var r = node.getBoundingClientRect();
    var offX = e.clientX - r.left;
    var offY = e.clientY - r.top;
    var moved = false;
    var target = null;
    var L = layout[which];
    handle.setPointerCapture(e.pointerId);
    function move(ev) {
      if (!moved) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return;
        moved = true;
        node.classList.add('moving');
        if (which === 'dock' && L.mode !== 'float') {
          // Becomes a floating window of a usable size, under the pointer.
          L.mode = 'float';
          L.w = L.w || Math.min(560, Math.round(r.width));
          L.h = L.h || Math.min(Math.round(window.innerHeight * 0.7), Math.round(r.height));
          offX = Math.min(offX, L.w - 60);
          offY = Math.min(offY, 30);
        } else if (which === 'panel') {
          L.mode = 'float';
        }
      }
      L.x = Math.round(ev.clientX - offX);
      L.y = Math.round(ev.clientY - offY);
      renderDockSoon(); // at most once a frame while dragging
      target = snapFor(which, ev.clientX, ev.clientY, node.getBoundingClientRect());
      showSnap(target);
    }
    function up() {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      node.classList.remove('moving');
      showSnap(null);
      if (!moved) return;
      if (target && which === 'dock') L.mode = target.mode;
      if (target && which === 'panel') {
        L.mode = 'corner';
        L.corner = target.corner;
      }
      renderDock();
      saveLayout();
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }
  // Resize from the grip: a floating window from its bottom-right corner, the panel in a corner
  // from its inner corner.
  function startResize(which, e) {
    var node = which === 'dock' ? dock : panel;
    if (e.button !== 0 || pop[which]) return;
    e.preventDefault();
    e.stopPropagation();
    var grip = e.currentTarget;
    var L = layout[which];
    var phone = which === 'panel' && panel.classList.contains('phone');
    var corner = phone ? 'br' : which === 'panel' && L.mode === 'corner' ? L.corner : 'tl'; // fixed corner
    var kw = phone ? 'pw' : 'w';
    var kh = phone ? 'ph' : 'h';
    grip.setPointerCapture(e.pointerId);
    node.classList.add('moving');
    function move(ev) {
      var r = node.getBoundingClientRect();
      var w = corner[1] === 'r' ? r.right - ev.clientX : ev.clientX - r.left;
      var h = corner[0] === 'b' ? r.bottom - ev.clientY : ev.clientY - r.top;
      L[kw] = Math.round(Math.max(phone ? 240 : which === 'dock' ? 340 : 320, w));
      L[kh] = Math.round(Math.max(phone ? 200 : which === 'dock' ? 260 : 280, h));
      if (!phone && (which === 'dock' || L.mode === 'float')) {
        L.x = Math.round(r.left);
        L.y = Math.round(r.top);
      }
      renderDockSoon();
    }
    function up() {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      node.classList.remove('moving');
      var r = node.getBoundingClientRect();
      L[kw] = Math.round(r.width);
      L[kh] = Math.round(r.height);
      saveLayout();
    }
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }
  panel.querySelector('.head').addEventListener('pointerdown', function (e) { startMove('panel', e); });
  dock.querySelector('.dhead').addEventListener('pointerdown', function (e) { startMove('dock', e); });
  panelGrip.addEventListener('pointerdown', function (e) { startResize('panel', e); });
  dockGrip.addEventListener('pointerdown', function (e) { startResize('dock', e); });
  // Grip keys: arrows resize (Shift for bigger steps); double-click restores the default size.
  function gripKeys(which) {
    var phone = which === 'panel' && panel.classList.contains('phone');
    return { w: phone ? 'pw' : 'w', h: phone ? 'ph' : 'h', minW: phone ? 240 : which === 'dock' ? 340 : 320, minH: phone ? 200 : which === 'dock' ? 260 : 280 };
  }
  function resizeByKey(which, e) {
    var step = e.shiftKey ? 60 : 20;
    var d = { ArrowRight: [step, 0], ArrowLeft: [-step, 0], ArrowDown: [0, step], ArrowUp: [0, -step] }[e.key];
    if (!d || pop[which]) return;
    e.preventDefault();
    e.stopPropagation();
    var node = which === 'dock' ? dock : panel;
    var L = layout[which];
    var k = gripKeys(which);
    var r = node.getBoundingClientRect();
    L[k.w] = Math.round(Math.max(k.minW, r.width + d[0]));
    L[k.h] = Math.round(Math.max(k.minH, r.height + d[1]));
    if (k.w === 'w' && (which === 'dock' || L.mode === 'float')) {
      L.x = Math.round(r.left);
      L.y = Math.round(r.top);
    }
    renderDock();
    // What the window allows, not what was asked for.
    r = node.getBoundingClientRect();
    L[k.w] = Math.round(r.width);
    L[k.h] = Math.round(r.height);
    saveLayout();
  }
  function resetSize(which) {
    if (pop[which]) return;
    var L = layout[which];
    var k = gripKeys(which);
    L[k.w] = L[k.h] = null;
    renderDock();
    saveLayout();
  }
  [['panel', panelGrip], ['dock', dockGrip]].forEach(function (p) {
    p[1].setAttribute('tabindex', '0');
    p[1].setAttribute('role', 'button');
    p[1].setAttribute('aria-label', p[0] === 'dock' ? 'Resize the code view' : 'Resize the panel');
    p[1].setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown');
    p[1].title = 'Drag to resize. Arrow keys also resize. Double-click for the default size.';
    p[1].addEventListener('keydown', function (e) { resizeByKey(p[0], e); });
    p[1].addEventListener('dblclick', function (e) {
      e.stopPropagation();
      resetSize(p[0]);
    });
  });

  function selectionOf(node) {
    var r = node.getRootNode();
    return r.getSelection ? r.getSelection() : node.ownerDocument.getSelection();
  }
  // A timer that keeps running in a popped-out code view while the page's own tab is hidden, and
  // still fires if that window closes.
  function later(fn, ms) {
    var done = false;
    function run() {
      if (done) return;
      done = true;
      fn();
    }
    var w = pop.dock && !pop.dock.win.closed ? pop.dock.win : null;
    if (w) w.setTimeout(run, ms);
    setTimeout(run, ms + (w ? 300 : 0));
  }
  // Keys pressed in a popped-out window also trigger the page's shortcuts (Alt+Shift+…, Ctrl+K, Esc).
  function forwardKey(e) {
    var shortcut = e.key === 'Escape' || (e.altKey && e.shiftKey) || ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K'));
    if (!shortcut || e.defaultPrevented) return;
    var copy = new KeyboardEvent('keydown', { key: e.key, code: e.code, altKey: e.altKey, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, bubbles: true, cancelable: true });
    window.dispatchEvent(copy);
    if (copy.defaultPrevented) e.preventDefault();
  }
  // Two quick clicks would open two windows before the first one has opened.
  var popBusy = { panel: false, dock: false };
  async function popOut(which) {
    if (pop[which]) {
      pop[which].win.focus();
      return;
    }
    // A new window can't be drawn above a full-screen page.
    leaveFullFor();
    if (popBusy[which]) return;
    popBusy[which] = true;
    try {
      await popOutNow(which);
    } finally {
      popBusy[which] = false;
    }
  }
  async function popOutNow(which) {
    var node = which === 'dock' ? dock : panel;
    var r = node.getBoundingClientRect();
    var w = Math.round(clamp(r.width || 520, 380, 1400));
    var h = Math.round(clamp(r.height || 680, 460, 1200));
    var win = null;
    var pip = false;
    var dpip = window.documentPictureInPicture;
    // Picture-in-Picture allows one window per tab: the second panel gets a pop-up.
    var pipTaken = (pop.panel && pop.panel.pip) || (pop.dock && pop.dock.pip);
    if (dpip && typeof dpip.requestWindow === 'function' && !pipTaken) {
      try {
        win = await dpip.requestWindow({ width: w, height: h });
        pip = true;
      } catch (err) {
        if (!err || ['NotAllowedError', 'NotSupportedError', 'InvalidStateError', 'SecurityError'].indexOf(err.name) < 0) throw err;
        console.warn('[EditLens] Picture-in-Picture not available, using a pop-up:', err.message);
      }
    }
    if (!win) win = window.open('', 'editlens-' + which + '-' + PAGE_ID, 'popup,width=' + w + ',height=' + h);
    if (!win) {
      showToast('The browser blocked the new window. Allow pop-ups for this site, then try again.');
      return;
    }
    var doc = win.document;
    doc.head.replaceChildren();
    doc.body.replaceChildren();
    doc.title = (which === 'dock' ? 'Code view · ' : PANEL_NAME + ' · ') + (pageTitle() || location.host);
    // Looking at this window counts as looking at the page (the tab title's Done and questions).
    win.addEventListener('focus', tabTitleSeen);
    win.addEventListener('blur', tabTitleSeen);
    var meta = doc.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    var base = doc.createElement('style');
    // The theme's own background, updated by applyTheme when the theme changes.
    base.textContent = popBaseCss(themeNow || 'light');
    doc.head.append(meta, base);
    var popHost = doc.createElement('edit-lens');
    popHost.setAttribute('data-theme', themeNow || 'light');
    popHost.style.cssText = 'all:initial;position:fixed;inset:0;display:block;';
    var popRoot = popHost.attachShadow({ mode: 'open' });
    popRoot.appendChild(styleEl.cloneNode(true));
    doc.body.appendChild(popHost);
    node.classList.add('popped');
    popRoot.appendChild(node);
    pop[which] = { win: win, host: popHost, root: popRoot, pip: pip, base: base };
    win.addEventListener('keydown', forwardKey);
    doc.addEventListener('fullscreenchange', onFullChange);
    win.addEventListener('resize', function () { if (which === 'dock') renderPanes(); });
    win.addEventListener('pagehide', function () { if (pop[which] && pop[which].win === win) popIn(which, true); });
    if (which === 'panel' && state.panel !== 'open') setPanel('open');
    if (which === 'dock' && !dockState.open) setDock(true, false);
    renderPanel();
    renderDock();
  }
  function popIn(which, closed) {
    var p = pop[which];
    if (!p) return;
    pop[which] = null;
    var node = which === 'dock' ? dock : panel;
    // Its full screen was in that window (resized window or its own layer), so it ends here.
    if (fullFallback[which] && fullFallback[which].kind !== 'page') {
      fullFallback[which] = null;
      node.classList.remove('max');
    }
    node.classList.remove('popped');
    // The code view is under the panel; the panel under the pill and toasts.
    if (which === 'dock') root.insertBefore(dock, panel.parentNode === root ? panel : pill);
    else root.insertBefore(panel, pill);
    if (toast.parentNode === p.root) root.appendChild(toast);
    if (!closed && !p.win.closed) p.win.close();
    renderPanel();
    renderDock();
  }
  // The page reloads or closes (or goes to another address): close the windows it popped out; they don't
  // work without it. They open again from the menu (browsers only open windows on a click).
  window.addEventListener('pagehide', function () {
    ['panel', 'dock'].forEach(function (k) { if (pop[k] && !pop[k].win.closed) pop[k].win.close(); });
  });

  // Full screen: the EditLens layer (<edit-lens>, or the one in a popped-out window) is the full-screen
  // element and the part fills it (.max), so menus, toasts and dialogs still appear above it. A browser
  // window can't appear above it: the code view leaves full screen first (leaveFullFor). fullFallback
  // kind: 'host' (Fullscreen API), 'page' (API refused: covers the window), 'window' (full-screen pop-up).
  var fullFallback = { panel: null, dock: null };
  function fullNode(which) {
    return which === 'dock' ? dock : panel;
  }
  function isFull(which) {
    var node = fullNode(which);
    var r = node.getRootNode();
    return Boolean((r && r.fullscreenElement === node) || fullFallback[which]);
  }
  function toggleFull(which) {
    var node = fullNode(which);
    var doc = node.ownerDocument;
    var other = which === 'dock' ? 'panel' : 'dock';
    if (isFull(which)) {
      var f = fullFallback[which];
      fullFallback[which] = null;
      if (f && f.kind === 'window' && !f.win.closed) {
        f.win.resizeTo(f.w, f.h);
        f.win.moveTo(f.x, f.y);
      }
      node.classList.remove('max');
      // The layer stays in full screen while the other part still fills it.
      var still = fullFallback[other] && fullFallback[other].kind === 'host';
      if (doc.fullscreenElement && !still) doc.exitFullscreen().catch(function (err) { console.warn('[EditLens] exit full screen:', err.message); });
      renderFull();
      return;
    }
    // One part at a time: the other one leaves full screen (the layer stays in it).
    var prev = fullFallback[other];
    if (prev && prev.kind === 'host' && fullNode(other).getRootNode() === node.getRootNode()) {
      fullFallback[other] = null;
      fullNode(other).classList.remove('max');
      fullFallback[which] = prev;
      node.classList.add('max');
      renderFull();
      return;
    }
    var layer = node.getRootNode().host;
    var fallback = function () {
      var p = pop[which];
      if (p && !p.win.closed) {
        var w = p.win;
        fullFallback[which] = { kind: 'window', win: w, w: w.outerWidth, h: w.outerHeight, x: w.screenX, y: w.screenY };
        w.moveTo(0, 0);
        w.resizeTo(w.screen.availWidth, w.screen.availHeight);
      } else {
        fullFallback[which] = { kind: 'page' };
        node.classList.add('max');
      }
      renderFull();
    };
    if (doc.fullscreenEnabled && layer && typeof layer.requestFullscreen === 'function') {
      // Marked now: the fullscreenchange event can come before the promise.
      fullFallback[which] = { kind: 'host', host: layer };
      node.classList.add('max');
      renderFull();
      layer.requestFullscreen().then(renderFull, function (err) {
        // Refused (no user click, blocked by the page, an iframe): fill the window instead.
        if (!err || (err.name !== 'TypeError' && err.name !== 'NotAllowedError' && err.name !== 'NotSupportedError')) console.warn('[EditLens] full screen:', err);
        fullFallback[which] = null;
        fallback();
      });
    } else fallback();
  }
  // Before opening another browser window, which can't be drawn above a full-screen page.
  function leaveFullFor() {
    ['dock', 'panel'].forEach(function (k) {
      var f = fullFallback[k];
      if (f && (f.kind === 'host' || f.kind === 'window')) toggleFull(k);
    });
  }
  // A menu goes into the part that is in full screen: only that part is drawn.
  function menuHost(button) {
    var host = button.getRootNode();
    return (host && host.fullscreenElement) || host;
  }
  function renderFull() {
    var on = isFull('dock');
    dockFullButton.replaceChildren(icon(on ? 'unfull' : 'full'));
    dockFullButton.title = on ? 'Exit full screen (Esc)' : 'Full screen';
    dockFullButton.setAttribute('aria-pressed', String(on));
    // Permission questions stay visible in full screen.
    var fe = root.fullscreenElement;
    var host = fe === panel || fe === dock ? fe : root;
    if (typeof pqButton !== 'undefined' && pqButton && pqButton.parentNode && pqButton.parentNode !== host) {
      host.appendChild(pqButton);
      host.appendChild(pqList);
    }
    placeDock();
    if (typeof renderPanes === 'function') renderPanes();
  }
  function onFullChange() {
    // Left full screen with Esc (or the browser ended it): the part returns to its place.
    ['panel', 'dock'].forEach(function (k) {
      var f = fullFallback[k];
      if (!f || f.kind !== 'host' || f.host.ownerDocument.fullscreenElement === f.host) return;
      fullFallback[k] = null;
      fullNode(k).classList.remove('max');
    });
    // An open menu was placed for the full-screen size; it would be in the wrong place now.
    closeLayoutMenu();
    closeModeMenu();
    renderDock();
    renderFull();
  }
  document.addEventListener('fullscreenchange', onFullChange);
  dockFullButton.addEventListener('click', function () { toggleFull('dock'); });
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    ['panel', 'dock'].forEach(function (k) { if (fullFallback[k] && fullFallback[k].kind === 'page') toggleFull(k); });
  });

  function resetLayout() {
    popIn('panel');
    popIn('dock');
    ['panel', 'dock'].forEach(function (k) { if (isFull(k)) toggleFull(k); });
    dockState.collapsed = false;
    dockState.unseen = 0;
    storageSet('localStorage', 'editlens.dockCollapsed', null);
    layout = defaultLayout();
    dockState.width = 0;
    swSoon();
    storageSet('localStorage', LAYOUT_KEY, null);
    storageSet('localStorage', 'editlens.dockWidth', null);
    renderDock();
  }
  function closeLayoutMenu() {
    var open = [root].concat(pop.panel ? [pop.panel.root] : [], pop.dock ? [pop.dock.root] : []);
    open.forEach(function (r) { r.querySelectorAll('.lwrap').forEach(function (n) { n.remove(); }); });
  }
  function openLayoutMenu(which, button) {
    // The code view has its own View menu.
    if (which === 'dock') return openViewMenu(button);
    closeLayoutMenu();
    var L = layout[which];
    var popped = Boolean(pop[which]);
    var menu = el('div', { class: 'lmenu', role: 'menu' });
    var wrap = el('div', { class: 'lwrap' }, menu);
    menu.classList.add('smenu');
    function act(fn) {
      return function () {
        closeLayoutMenu();
        fn();
      };
    }
    function sep() {
      menu.appendChild(el('hr'));
    }
    function sec(title) {
      var box = el('div', { class: 'sec' }, el('div', { class: 'lh', text: title }));
      menu.appendChild(box);
      return box;
    }
    // A row with an on/off switch; clicking anywhere on the row toggles it.
    function swRow(label, sub, on, fn) {
      var b = el('button', { type: 'button', role: 'menuitemcheckbox', class: 'li', 'aria-checked': String(Boolean(on)) },
        el('span', { class: 'lbl' }, document.createTextNode(label), sub ? el('small', { text: sub }) : null),
        el('span', { class: 'swi' + (on ? ' on' : ''), 'aria-hidden': 'true' }));
      b.addEventListener('click', act(fn));
      menu.appendChild(b);
    }
    // Text size: three A's in one segmented control.
    var seg = el('div', { class: 'seg3', role: 'radiogroup', 'aria-label': 'Text size' });
    [['s', 'Small text'], ['m', 'Medium text'], ['l', 'Large text']].forEach(function (x) {
      var b = el('button', { type: 'button', role: 'menuitemradio', class: 'sz-' + x[0] + (state.size === x[0] ? ' on' : ''), 'aria-checked': String(state.size === x[0]), 'aria-label': x[1], title: x[1], text: 'A' });
      b.addEventListener('click', act(function () { setSize(x[0]); }));
      seg.appendChild(b);
    });
    sec('Text size').appendChild(seg);
    if (which === 'panel') {
      sep();
      swRow('Highlight changes on the page', '', state.highlight, function () { hlButton.click(); });
      swRow('Show code on hover', '', peek.on, function () { setPeek(!peek.on); renderSettings(); });
      swRow('Message box next to what you pick', 'Off: you type in the panel', pickBoxOn(), function () { changeSetting('pick_box', !pickBoxOn()); });
      if (state.canListen !== false) swRow('Wait for my messages', 'Claude waits after it finishes', state.listen, function () { setListen(!state.listen); });
    }
    sep();
    var where = sec(which === 'dock' ? 'Code view position' : 'Panel position');
    if (popped) {
      where.appendChild(el('div', { class: 'where' }, el('div', { class: 'opts' }, el('b', { text: 'In its own window' }), el('span', { text: 'Use “Back to the page” below to show it on the page again.' }))));
    } else if (which === 'panel' && window.innerWidth <= 480) {
      // placePanel puts it across the bottom of a phone-sized window, whatever corner is saved.
      where.appendChild(el('div', { class: 'where' }, el('div', { class: 'opts' }, el('b', { text: 'At the bottom' }),
        el('span', { text: 'In a narrow window the panel is at the bottom. Make the window wider to move it to a corner.' }))));
    } else {
      // A small screen: click a spot to move it there.
      var spots = which === 'dock'
        ? [['right', 'Docked right'], ['left', 'Docked left'], ['bottom', 'Docked at the bottom'], ['float', 'Floating window']]
        : [['br', 'Bottom right'], ['bl', 'Bottom left'], ['tr', 'Top right'], ['tl', 'Top left']];
      var cur = which === 'dock' ? L.mode : L.mode === 'corner' ? L.corner : 'float';
      var scr = el('div', { class: 'mini-scr at-' + which, role: 'radiogroup', 'aria-label': which === 'dock' ? 'Code view position' : 'Panel corner' });
      spots.forEach(function (x) {
        var b = el('button', { type: 'button', role: 'menuitemradio', class: 'spot ' + x[0] + (cur === x[0] ? ' on' : ''), 'aria-checked': String(cur === x[0]), 'aria-label': x[1], title: x[1] });
        b.addEventListener('click', act(function () {
          if (which === 'dock') L.mode = x[0];
          else {
            L.mode = 'corner';
            L.corner = x[0];
          }
          saveLayout();
          renderDock();
        }));
        scr.appendChild(b);
      });
      var name = (spots.find(function (x) { return x[0] === cur; }) || [null, 'Floating'])[1];
      where.appendChild(el('div', { class: 'where' }, scr, el('div', { class: 'opts' }, el('b', { text: name }),
        el('span', { text: which === 'dock' ? 'Click a spot to move it there.' : 'Click a corner, or drag the panel to move it anywhere.' }))));
    }
    // Three tiles: Open in new window (or Back to the page), Full screen, Reset.
    var tiles = el('div', { class: 'acts' });
    function tile(ic, label, fn) {
      var b = el('button', { type: 'button', role: 'menuitem' }, icon(ic), el('span', { text: label }));
      b.addEventListener('click', act(fn));
      tiles.appendChild(b);
    }
    if (popped) tile('chevl', 'Back to the page', function () { popIn(which); });
    else tile('window', 'Open in new window', function () { popOut(which); });
    tile(isFull(which) ? 'unfull' : 'full', isFull(which) ? 'Exit full screen' : 'Full screen', function () { toggleFull(which); });
    tile('replay', 'Reset', resetLayout);
    menu.appendChild(tiles);
    if (which === 'panel') {
      sep();
      // Sessions: page control's sessions and this project's tasks.
      var sesB = el('button', { type: 'button', role: 'menuitem', class: 'li', 'data-act': 'sessions' },
        el('span', { class: 'lbl' }, document.createTextNode('Sessions'), el('small', { text: 'Open, continue in terminal, rename or stop' })));
      sesB.addEventListener('click', act(function () { openSessions(null); }));
      menu.appendChild(sesB);
      sep();
      var tourB = el('button', { type: 'button', role: 'menuitem', text: 'Quick tour' });
      tourB.addEventListener('click', act(function () { showTour(true); }));
      var allB = el('button', { type: 'button', role: 'menuitem', text: 'All settings ›' });
      allB.addEventListener('click', act(function () { setSettingsOpen(!settings.open); }));
      menu.appendChild(el('div', { class: 'foot' }, tourB, allB));
    }
    wrap.addEventListener('pointerdown', function (e) { if (e.target === wrap) closeLayoutMenu(); });
    wrap.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeLayoutMenu();
    });
    menuHost(button).appendChild(wrap);
    var view = button.ownerDocument.defaultView;
    var b = button.getBoundingClientRect();
    var mw = menu.offsetWidth;
    var mh = menu.offsetHeight;
    menu.style.left = Math.round(clamp(b.right - mw, 8, view.innerWidth - mw - 8)) + 'px';
    menu.style.top = Math.round(b.bottom + mh + 8 < view.innerHeight ? b.bottom + 6 : Math.max(8, b.top - mh - 6)) + 'px';
    // The menu itself takes focus (Tab moves into it), so no control looks picked on open.
    if (menu.classList.contains('smenu')) {
      menu.setAttribute('tabindex', '-1');
      menu.focus();
    } else {
      var first = menu.querySelector('button');
      if (first) first.focus();
    }
  }
  panelLayoutButton.addEventListener('click', function () { openLayoutMenu('panel', panelLayoutButton); });

  // ---------- file menu: open a file in your editor, copy its path or its code ----------
  // From the file name in a code view pane and from More on an edit card. Open is only a
  // vscode://file/… or cursor://file/… link: EditLens starts nothing on this computer itself.
  var EDITOR_SCHEMES = dict({ 'VS Code': 'vscode', Cursor: 'cursor' });
  function editorName() {
    var v = settings.values && settings.values.editor;
    return v === 'VS Code' || v === 'Cursor' || v === 'None' ? v : 'VS Code';
  }
  // A line number for a link or a label: a positive whole number, or null (never "NaN").
  function lineNo(raw) {
    var n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 1 && n <= 10000000 ? Math.floor(n) : null;
  }
  // -> 'vscode://file/home/me/app/src/App.jsx:23', or null when the full path is not known.
  function editorLink(editor, file, line) {
    var scheme = EDITOR_SCHEMES[editor];
    var p = String(file || '').replace(/\\/g, '/');
    if (!scheme || !(/^\/[^/]/.test(p) || /^[A-Za-z]:\//.test(p)) || /(^|\/)\.\.(\/|$)/.test(p)) return null;
    if (p[0] !== '/') p = '/' + p;
    var url = scheme + '://file' + p.split('/').map(function (part) {
      return encodeURIComponent(part).replace(/^([A-Za-z])%3A$/, '$1:'); // the drive letter keeps its colon
    }).join('/');
    var n = lineNo(line);
    return n ? url + ':' + n : url;
  }
  // The paired computer a file is on, or null when it is on this computer.
  function fileComputer(relFile, remote) {
    if (remote && remote.computer) return String(remote.computer).slice(0, 40);
    var m = /^◆ ([^:]{1,40}): /.exec(String(relFile || ''));
    return m ? m[1] : state.via || null;
  }
  function copyPlain(text, node) {
    var doc = node.ownerDocument || document;
    var view = doc.defaultView || window;
    if (view.navigator.clipboard && view.isSecureContext) return view.navigator.clipboard.writeText(text);
    var area = doc.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0';
    node.getRootNode().appendChild(area);
    area.select();
    var ok = doc.execCommand('copy');
    area.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error('the browser did not allow it. Select the text and copy it yourself'));
  }
  // info: { file (full path), rel (shown path), line, computer|null, code: () => Promise<text> | null }
  function openFileMenu(button, info) {
    closeLayoutMenu();
    var menu = el('div', { class: 'lmenu smenu fmenu', role: 'menu', 'aria-label': 'File menu' });
    var wrap = el('div', { class: 'lwrap' }, menu);
    var editor = editorName();
    var line = lineNo(info.line);
    var rel = viewPath(info.file, info.rel).rel.replace(/^◆ [^:]*: /, '');
    var pathText = rel + (line ? ':' + line : '');
    // The code is asked for now, so the copy still counts as part of the click.
    var code = info.code ? info.code() : null;
    if (code) code.catch(function (err) { console.warn('[EditLens] could not get the code to copy:', err); });
    function label(text, sub) {
      return el('span', { class: 'lbl' }, document.createTextNode(text), sub ? el('small', { text: sub }) : null);
    }
    menu.appendChild(el('div', { class: 'lh', text: baseName(rel) || rel }));
    if (editor !== 'None') {
      var link = info.computer ? null : editorLink(editor, info.file, line);
      var sub = info.computer ? 'File is on ' + info.computer : !link ? 'Its full path is not known' : line ? 'At line ' + line : '';
      var open = link
        ? el('a', { class: 'li fopen', role: 'menuitem', href: link }, icon('code'), label('Open in ' + editor, sub))
        : el('button', { class: 'li fopen', type: 'button', role: 'menuitem', disabled: '', 'aria-disabled': 'true' }, icon('code'), label('Open in ' + editor, sub));
      // The browser asks before it starts the editor; the menu closes after the click.
      if (link) open.addEventListener('click', function () { setTimeout(closeLayoutMenu, 0); });
      menu.appendChild(open);
    }
    function copyRow(text, side, get, none) {
      var ic = el('span', { class: 'fic' }, icon('copy'));
      var lab = label(text, get ? '' : none);
      var b = el('button', { class: 'li', type: 'button', role: 'menuitem' }, ic, lab, side ? el('span', { class: 'fside', text: side }) : null);
      if (!get) b.setAttribute('disabled', '');
      var timer = 0;
      b.addEventListener('click', function () {
        get().then(function (value) {
          if (typeof value !== 'string') throw new Error(snapshotFailText().replace(/^Could not show this edit: /, ''));
          return copyPlain(value, b);
        }).then(function () {
          // A green check and "Copied" for about a second, then the row as it was.
          clearTimeout(timer);
          b.classList.add('copied');
          ic.replaceChildren(icon('check'));
          lab.firstChild.nodeValue = 'Copied';
          timer = setTimeout(function () {
            b.classList.remove('copied');
            ic.replaceChildren(icon('copy'));
            lab.firstChild.nodeValue = text;
          }, 1000);
        }, function (err) {
          showToast('Could not copy: ' + err.message, 6000);
        });
      });
      menu.appendChild(b);
    }
    copyRow('Copy path', pathText, function () { return Promise.resolve(pathText); });
    copyRow('Copy code', '', code ? function () { return code; } : null, 'Its code is not kept');
    if (info.extra) info.extra(menu);
    menu.appendChild(el('hr'));
    var change = el('button', { type: 'button', text: 'change in Settings' });
    change.addEventListener('click', function () {
      closeLayoutMenu();
      // From a popped-out or full-screen code view, Settings open above it as a sheet; else in the panel.
      openSettingsHere(button);
    });
    menu.appendChild(el('div', { class: 'ffoot' }, document.createTextNode('Editor: ' + editor + ' · '), change));
    wrap.addEventListener('pointerdown', function (e) { if (e.target === wrap) closeLayoutMenu(); });
    wrap.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeLayoutMenu();
      button.focus();
    });
    menuHost(button).appendChild(wrap);
    var view = button.ownerDocument.defaultView;
    var b = button.getBoundingClientRect();
    var mw = menu.offsetWidth;
    var mh = menu.offsetHeight;
    menu.style.left = Math.round(clamp(b.left, 8, view.innerWidth - mw - 8)) + 'px';
    menu.style.top = Math.round(b.bottom + mh + 8 < view.innerHeight ? b.bottom + 6 : Math.max(8, b.top - mh - 6)) + 'px';
    menu.setAttribute('tabindex', '-1');
    menu.focus();
  }
  // A code view pane: the line of the newest edit shown in it.
  function paneLine(f) {
    for (var i = 0; i < f.rows.length; i++) {
      var c = f.rows[i].classList;
      if (c.contains('lmark') || c.contains('add') || c.contains('recent')) return i + 1;
    }
    for (var j = changes.length - 1; j >= 0; j--) {
      var ev = changes[j];
      if (ev.file && keyOf(ev.file) === f.key) return lineNo(ev.hunks && firstChangedLine(ev.hunks[0]));
    }
    return null;
  }
  function paneMenu(f, button) {
    var lines = function () { return f.lines.length ? f.lines.join('\n') + '\n' : ''; };
    openFileMenu(button, { file: f.file, rel: f.relFile, line: paneLine(f), computer: fileComputer(f.relFile, null),
      code: function () {
        if (!f.snapId) return Promise.resolve(lines());
        return fetchSnapshot(f.snapId).then(function (s) { return s && typeof s.after === 'string' ? s.after : lines(); });
      },
      // The code view's own rows: Restore, Undo only this edit, Open in a split, Close.
      extra: function (menu) {
        function row(act, text, off, fn) {
          var b = el('button', { class: 'li', type: 'button', role: 'menuitem', 'data-act': act },
            el('span', { class: 'lbl' }, document.createTextNode(text), off ? el('small', { text: off }) : null));
          if (off) b.setAttribute('disabled', '');
          b.addEventListener('click', function () {
            closeLayoutMenu();
            fn();
          });
          menu.appendChild(b);
          return b;
        }
        menu.appendChild(el('hr'));
        var r = paneRestoreInfo(f);
        var rb = row('restore', r ? r.text : 'Restore…', r ? r.off : 'No edit of Claude\'s to restore here', function () { paneAsk(f, 'restore'); });
        rb.setAttribute('data-state', r ? 'on' : 'none');
        if (r) rb.title = r.title;
        var last = paneLastEdit(f);
        row('undo-only', 'Undo only this edit', last && canUndoOnly(last) ? (fromOldStart(last) ? OLD_EDIT : '')
          : 'Only for Claude\'s latest edit, while it can be undone alone', function () { paneAsk(f, 'only'); });
        menu.appendChild(el('hr'));
        row('split', 'Open in a split', f.group && f.group.keys.length > 1 ? '' : 'It is the only file in its pane', function () { moveFile(f, 'new'); });
        row('close', 'Close', '', function () { closeFile(f); });
      } });
  }
  function editMenu(ev, button) {
    openFileMenu(button, { file: ev.file, rel: ev.relFile || ev.file, line: ev.hunks && firstChangedLine(ev.hunks[0]), computer: fileComputer(ev.relFile, ev.remote),
      code: ev.snapshot ? function () { return fetchSnapshot(ev.snapshot).then(function (s) { return s && typeof s.after === 'string' ? s.after : null; }); } : null });
  }

  // ---------- Agents switcher: switch between agents from a small floating window ----------
  // Order: main, pinned, running, recently finished. Hidden while there are no subagents.
  // Alt+Shift+A toggles it; Alt+Shift+] / [ switch agents.
  var sw = { open: storageGet('localStorage', 'editlens.agentsOpen') !== 'closed', pinned: {}, active: null, stopAsk: null, timer: 0, details: {} };
  var editsBy = Object.create(null); // owner -> { file: edits }
  // A removed agent (a: its record) is removed from every map: its timer, pin, details state, edit
  // counts and Follow position, by its key and by "a:<agentId>", and its hook mode and color.
  // (These maps are set as the script starts; an agent removed before that has nothing in them.)
  function forgetAgent(k, a) {
    var id = a && a.agentId ? a.agentId : '';
    if (remoteIdle) {
      clearTimeout(remoteIdle[k]);
      delete remoteIdle[k];
    }
    if (sw) {
      delete sw.pinned[k];
      delete sw.details[k];
    }
    [k, id ? 'a:' + id : null].forEach(function (key) {
      if (!key) return;
      if (editsBy) delete editsBy[key];
      if (follow) delete follow.at[key];
    });
    if (!id) return;
    if (modeState) delete modeState.hookAgents[id];
    // A teammate on a board with the same id keeps its color.
    if (team && !teamEntries().some(function (e) { return e && e.agentId === id; })) delete team.colors[id];
  }
  var mainInfo = { start: 0, end: 0, lastText: '', tools: 0 }; // the main agent's current turn and last reply
  (function () {
    var saved = null;
    try {
      saved = JSON.parse(storageGet('sessionStorage', 'editlens.agentsPinned') || '[]');
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    if (Array.isArray(saved)) saved.forEach(function (k) { if (typeof k === 'string') sw.pinned[k] = true; });
  })();
  var swDots = el('span', { class: 'swdots' });
  var swCount = el('span', { class: 'swn', title: 'Subagents running now' });
  var swHead = el('button', { class: 'swhead', type: 'button', 'aria-expanded': String(sw.open), title: 'Agents: click to open or close (Alt+Shift+A). Drag to move; double-click to put it back beside the panel.' },
    swDots, el('span', { class: 'swt', text: 'Agents' }), swCount, icon('minimize'));
  var swList = el('ul', { class: 'swlist', role: 'listbox', 'aria-label': 'Agents' });
  var swHint = el('div', { class: 'swhint', text: 'Click an agent to switch to it. Alt+Shift+] and [ switch from anywhere.' });
  var switcher = el('div', { class: 'asw', role: 'region', 'aria-label': 'Agents switcher' }, swHead, el('div', { class: 'swbody' }, el('div', { class: 'swin' }, swList, swHint)));
  root.insertBefore(switcher, panel);
  var ownerFilter = null;

  function swSoon() {
    pqSoon();
    if (!sw || !switcher || sw.timer) return; // also called while the panel is still being built
    sw.timer = requestAnimationFrame(function () {
      sw.timer = 0;
      renderSwitcher();
    });
  }
  function swStarted(a) {
    var t = Number(a.started);
    return Number.isFinite(t) && t > 0 ? t : 0;
  }
  function swKeys() {
    var now = Date.now();
    var keys = Object.keys(agents).filter(function (k) {
      var a = agents[k];
      return !a.done || sw.pinned[k] || follow.mode === k || (a.ended && now - a.ended < 90000);
    });
    keys.sort(function (x, y) {
      var ax = agents[x];
      var ay = agents[y];
      return ((sw.pinned[y] ? 1 : 0) - (sw.pinned[x] ? 1 : 0)) || ((ax.done ? 1 : 0) - (ay.done ? 1 : 0)) || (swStarted(ax) - swStarted(ay));
    });
    return ['main'].concat(keys);
  }
  function elapsedText(k) {
    var a = agents[k];
    if (k === 'main') return mainInfo.start ? fmtElapsed((mainInfo.end || Date.now()) - mainInfo.start) : '';
    if (!a) return '';
    var start = swStarted(a);
    if (!start) return '';
    return fmtElapsed((a.done ? a.ended || start : Date.now()) - start);
  }
  function fmtElapsed(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    var sec = Math.round(ms / 1000);
    if (sec < 60) return sec + 's';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ' + String(sec % 60).padStart(2, '0') + 's';
    return Math.floor(min / 60) + 'h ' + String(min % 60).padStart(2, '0') + 'm';
  }
  function swAt(k) {
    var a = agents[k];
    return follow.at[k] || (a && a.agentId ? follow.at['a:' + a.agentId] : null) || null;
  }
  function swStep(k) {
    if (k === 'main') {
      return nowEl.textContent.trim(); // empty: the status line says it
    }
    var a = agents[k];
    if (a.done) return (a.failed ? 'Failed' : 'Done') + (a.result ? ': ' + a.result.split('\n').filter(function (l) { return l.trim(); })[0] : '');
    return a.lastStep || 'Starting…';
  }
  function panelOnPage() {
    return !pop.panel && state.panel === 'open';
  }
  function renderSwitcher() {
    renderAgentsTab();
    refreshAgentCard();
    swHome();
    var subs = Object.keys(agents);
    var running = subs.filter(function (k) { return !agents[k].done; });
    var keys = swKeys();
    // While the code view is open the list is in its sidebar (Agents), not a floating window.
    var inDock = swInDock();
    var on = keys.length > 1 && !inDock;
    var changed = switcher.classList.contains('on') !== on;
    switcher.classList.toggle('on', on);
    switcher.classList.toggle('open', sw.open);
    switcher.setAttribute('data-size', state.size);
    swHead.setAttribute('aria-expanded', String(sw.open));
    swCount.textContent = running.length ? String(running.length) : '';
    swDots.replaceChildren.apply(swDots, ['main'].concat(running).slice(0, 6).map(function (k) {
      var i = el('i');
      i.style.setProperty('--dc', ownerColor(k));
      return i;
    }));
    // Shown or hidden: the selection bar moves out of its way, or back down (placeFloaters).
    if (changed && !on) placeFloaters();
    if (!on && !inDock) return;
    if (sw.active && keys.indexOf(sw.active) < 0) sw.active = null;
    var focused = swList.getRootNode().activeElement;
    var focusKey = focused && focused.closest && focused.closest('.arow') ? focused.closest('.arow').getAttribute('data-key') : null;
    var focusAction = focused && focused.closest && focused.closest('.ra') ? focused.getAttribute('data-act') : null;
    swList.replaceChildren.apply(swList, keys.map(swRow));
    if (focusKey) {
      var row = swList.querySelector('.arow[data-key="' + cssEscape(focusKey) + '"]');
      var target = row && focusAction ? row.querySelector('[data-act="' + focusAction + '"]') : row;
      if (target) target.focus({ preventScroll: true });
    }
    if (on) placeSwitcher();
    if (changed && on) placeFloaters();
  }
  function swRow(k) {
    var a = agents[k];
    var main = k === 'main';
    var running = main ? state.working : !a.done;
    var at = swAt(k);
    var mode = main ? mainMode() : agentModeOf(k).mode;
    var act = sw.active === k;
    var li = el('li', {
      class: 'arow' + (follow.mode === k ? ' on' : '') + (act ? ' act' : '') + (running ? ' run' : '') + (a && a.done ? ' done' : ''),
      role: 'option', tabindex: '-1', 'data-key': k, 'aria-selected': String(follow.mode === k),
      title: follow.mode === k ? 'Following ' + ownerLabel(k) : 'Switch to ' + ownerLabel(k) + ': the code view and the page follow its work',
    });
    li.style.setProperty('--ac', ownerColor(k));
    var top = el('div', { class: 'rt' }, el('i'), el('b', { text: ownerLabel(k) }));
    if (sw.pinned[k]) top.appendChild(icon('pin'));
    if (MODE_INFO[mode]) top.appendChild(el('span', { class: 'rm', 'data-mode': mode, text: modeLabel(mode) }));
    top.appendChild(el('span', { class: 'swtime', text: elapsedText(k) }));
    li.appendChild(top);
    var step = swStep(k);
    if (step) li.appendChild(el('div', { class: 'rs', text: step }));
    // The file as the project names it: never a copy's ".claude/worktrees/<name>/" or a task's folder there.
    if (at && at.file) li.appendChild(el('div', { class: 'rf', text: atPath(at) + lineText(at) }));
    li.appendChild(swMeta(k));
    if (act) li.appendChild(swActions(k, at));
    if (sw.details[k]) li.appendChild(swDetails(k));
    li.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('button')) return;
      switchToAgent(k);
    });
    return li;
  }
  function lineText(at) {
    var a = posInt(at.line);
    var b = posInt(at.end);
    if (!(a > 0)) return '';
    return ':' + a + (b > a ? '-' + b : '');
  }
  // What an agent is doing: Working, Waiting for permission, Idle, Done, Failed, Stopped.
  function swStatus(k) {
    var a = agents[k];
    var waiting = Object.keys(permCards).some(function (id) {
      var o = permCards[id].owner;
      return o === k || (a && a.agentId && o === 'a:' + a.agentId);
    });
    if (waiting) return { text: 'Waiting for permission', cls: 'wait' };
    if (k !== 'main') return a.done ? (a.failed ? { text: 'Failed', cls: 'bad' } : { text: 'Done', cls: '' }) : { text: 'Working', cls: '' };
    if (state.working) return { text: 'Working', cls: '' };
    if (state.claude === 'stopped') return { text: 'Stopped', cls: '' };
    if (state.claude === 'closed') return { text: 'Closed', cls: '' };
    return { text: 'Idle', cls: '' };
  }
  function agentModel(k) {
    if (k === 'main') {
      var m = drive.active && drive.model ? drive.model : usage && usage.model ? usage.model : null;
      return m ? modelLabel({ model: m, modelName: !drive.active && usage ? usage.modelName : null }) : null;
    }
    var a = agents[k];
    return a.model ? modelLabel({ model: a.model }) : null;
  }
  function agentTools(k) {
    var a = agents[k];
    if (k === 'main') return mainInfo.tools || null;
    return a.toolCount !== null && a.toolCount !== undefined ? a.toolCount : a.tools;
  }
  // Files an agent changed, with how many edits each.
  function agentEdits(k) {
    var a = agents[k];
    var out = Object.create(null);
    [k, a && a.agentId ? 'a:' + a.agentId : null].forEach(function (o) {
      if (!o || !editsBy[o]) return;
      Object.keys(editsBy[o]).forEach(function (f) {
        // A sum too large to be a count is not kept (Sol L1).
        var s = (out[f] || 0) + posInt(editsBy[o][f]);
        out[f] = Number.isSafeInteger(s) ? s : out[f] || 0;
      });
    });
    return out;
  }
  function agentClaims(k) {
    var a = agents[k];
    var mate = k === 'main' ? 'main' : a && a.agentId;
    if (!mate) return [];
    var entries = teamEntries();
    var closed = Object.create(null);
    entries.forEach(function (e) { if (e.kind === 'done') closed[e.claimId] = true; });
    return entries.filter(function (e) { return e.kind === 'claim' && !closed[e.id] && mateKey(e) === mate; });
  }
  function agentTokens(k) {
    var a = agents[k];
    if (k === 'main') {
      var c = usage && usage.context;
      if (!c || n(c.used) === null) return null;
      return 'Context ' + fmtTokens(c.used) + (n(c.window) !== null ? ' of ' + fmtTokens(c.window) + ' (' + fmtPct(c.percent) + ')' : '') +
        (usage.totals ? ' · ' + fmtTokens(sum(usage.totals)) + ' this session' : '');
    }
    var out = n(a.outTotal) || 0;
    var bits = [];
    if (a.tokens !== null && a.tokens !== undefined) bits.push(fmtTokens(a.tokens) + ' in total');
    if (n(a.ctx) !== null) bits.push('context ' + fmtTokens(a.ctx));
    if (out > 0) bits.push(fmtTokens(out) + ' written');
    return bits.length ? bits.join(' · ') : null;
  }
  function plural(v, one, many) {
    return v + ' ' + (v === 1 ? one : many);
  }
  // One compact line under the step: status, model, tools, files changed.
  function swMeta(k) {
    var st = swStatus(k);
    var line = el('div', { class: 'rmeta' }, el('span', { class: st.cls, text: st.text }));
    var bits = [];
    var model = agentModel(k);
    if (model) bits.push(model);
    var tools = agentTools(k);
    if (n(tools) !== null && tools > 0) bits.push(plural(tools, 'tool call', 'tool calls'));
    var files = Object.keys(agentEdits(k)).length;
    if (files) bits.push(plural(files, 'file changed', 'files changed'));
    if (bits.length) line.appendChild(document.createTextNode(' · ' + bits.join(' · ')));
    return line;
  }
  // Everything known about one agent; "—" where something isn't known (yet).
  function swDetails(k) {
    var a = agents[k];
    var main = k === 'main';
    var dash = function (v) { return v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v)) ? '—' : String(v); };
    var at = swAt(k);
    var mode = main ? mainMode() : agentModeOf(k).mode;
    var edits = agentEdits(k);
    var claims = agentClaims(k);
    var tools = agentTools(k);
    var rows = [
      ['Status', swStatus(k).text],
      ['Model', agentModel(k)],
      ['Permission mode', MODE_INFO[mode] ? modeLabel(mode) + (main ? '' : agentModeOf(k).own ? ' (its own)' : ' (same as Claude)') : null],
      [main ? 'This turn' : 'Running for', elapsedText(k)],
      ['Now', main || !a.done ? swStep(k) : null],
      ['Current file', at && at.file ? atPath(at) + lineText(at) : null, 'mono'],
      ['Tool calls', n(tools)],
      ['Files changed', Object.keys(edits).length ? Object.keys(edits).map(function (f) { return shownPath(f) + '  ×' + edits[f]; }).join('\n') : null, 'mono'],
      ['Tokens', agentTokens(k)],
      ['Team claims', claims.length ? claims.map(function (c) { return '#' + c.id + ' ' + c.text; }).join('\n') : null],
    ];
    if (!main) rows.splice(1, 0, ['Type', a.remote ? null : a.type || null]); // remote: its name shows it
    if (!main) rows.push(['Task', a.prompt || null]);
    rows.push([main ? 'Last reply' : a.done ? 'Result' : 'Last message', main ? mainInfo.lastText : a.done ? a.result || a.lastText : a.lastText]);
    var dl = el('dl', { class: 'rdet' });
    rows.forEach(function (r) {
      dl.appendChild(el('dt', { text: r[0] }));
      var dd = el('dd', { class: r[2] || '', text: dash(r[1]) });
      if (r[0] === 'This turn' || r[0] === 'Running for') dd.setAttribute('data-elapsed', '1');
      dl.appendChild(dd);
    });
    dl.addEventListener('click', function (e) { e.stopPropagation(); });
    return dl;
  }
  function relPath(file) {
    var f = String(file || '');
    // A file in a subagent's (or a task's) copy: the part inside the project.
    if (shownPath(f) !== f) return shownPath(f);
    var r = OPTS.root ? String(OPTS.root).replace(/\\/g, '/').replace(/\/$/, '') + '/' : '';
    var n = f.replace(/\\/g, '/');
    return r && n.indexOf(r) === 0 ? n.slice(r.length) : n.split('/').slice(-3).join('/');
  }
  function swActions(k, at) {
    var a = agents[k];
    var main = k === 'main';
    var box = el('div', { class: 'ra' });
    function add(id, label, title, fn, cls) {
      var b = el('button', { class: 'mini' + (cls ? ' ' + cls : ''), type: 'button', text: label, title: title, 'data-act': id });
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        fn(b);
      });
      box.appendChild(b);
      return b;
    }
    add('details', sw.details[k] ? 'Hide details' : 'Details', 'Everything known about ' + ownerLabel(k) + ': status, model, mode, time, tool calls, files changed, tokens, claims and its last message', function () {
      sw.details[k] = !sw.details[k];
      swSoon();
    });
    if (at && at.file) {
      add('file', 'Open file', 'Open ' + atPath(at) + ' in the code view', function () {
        follow.shown = null;
        openRef({ path: at.file, line: posInt(at.line) || null, end: posInt(at.end) || null }, k);
      });
      add('page', 'Show on page', 'Go to the page that shows ' + atPath(at) + ' and outline it', function () {
        revealFile(followTask(k));
      });
    }
    var only = ownerFilter === k;
    add('only', only ? 'Show all agents' : 'Only this', only ? 'Show every agent\'s messages and edits again' : 'Show only ' + ownerLabel(k) + '\'s messages and edits in the panel', function () {
      setOwnerFilter(only ? null : k);
      if (!only && (state.filter === 'team' || state.filter === 'agents')) setFilter('all');
    });
    add('team', 'Team posts', ownerLabel(k) + '\'s claims, notes and findings on the Team board', function () {
      setOwnerFilter(k);
      setFilter('team');
      if (state.panel !== 'open') setPanel('open');
    });
    if (main || (!a.done && !a.remote)) {
      add('mode', 'Mode', driving() ? 'Change the permission mode' + (main ? '' : ' of this subagent') : 'Permission mode (shown from Claude Code)', function (b) {
        if (driving()) openModeMenu(b, k);
        else showToast(main ? modeButton.title : (a.modeEl ? a.modeEl.title : ''));
      });
    }
    if (!main && !a.done && !a.remote && driving()) {
      var asking = sw.stopAsk === k;
      add('stop', asking ? 'Stop it?' : 'Stop', asking ? 'Click again to stop this subagent; Claude continues with the rest' : 'Stop this subagent only', function (b) {
        if (sw.stopAsk !== k) {
          sw.stopAsk = k;
          swSoon();
          setTimeout(function () { if (sw.stopAsk === k) { sw.stopAsk = null; swSoon(); } }, 4000);
          return;
        }
        sw.stopAsk = null;
        b.disabled = true;
        driveRequest('/drive/stop-agent', { agent: a.agentId || a.key }).then(function (r) {
          if (r && r.error) showToast(r.error);
          else showToast('Stopped ' + ownerLabel(k) + '.');
        }).catch(function (err) { showToast('Could not stop it: ' + err.message); });
      }, 'warn');
    }
    if (!main) {
      add('pin', sw.pinned[k] ? 'Unpin' : 'Pin', sw.pinned[k] ? 'Remove it from the list when it finishes' : 'Keep it at the top of this list, even after it finishes', function () {
        if (sw.pinned[k]) delete sw.pinned[k];
        else sw.pinned[k] = true;
        storageSet('sessionStorage', 'editlens.agentsPinned', JSON.stringify(Object.keys(sw.pinned)));
        swSoon();
      });
    }
    add('copy', 'Copy summary', 'Copy what this agent was asked, what it is doing, its files and its result', function () { copyText(agentSummary(k)); });
    return box;
  }
  function agentSummary(k) {
    var a = agents[k];
    var main = k === 'main';
    var mode = main ? mainMode() : agentModeOf(k).mode;
    var lines = [ownerLabel(k) + (a && a.type && !a.remote ? ' (' + a.type + ')' : '')];
    var status = main ? (state.working ? 'working' : 'idle') : a.done ? (a.failed ? 'failed' : 'done') : 'running';
    var t = elapsedText(k);
    lines.push('Status: ' + status + (t ? ', ' + t : ''));
    if (MODE_INFO[mode]) lines.push('Permission mode: ' + modeLabel(mode));
    if (a && a.prompt) lines.push('Task: ' + a.prompt);
    if (!main && !a.done) lines.push('Now: ' + swStep(k));
    if (main) lines.push('Now: ' + (swStep(k) || swStatus(k).text));
    var at = swAt(k);
    if (at && at.file) lines.push('Current file: ' + atPath(at) + (posInt(at.line) > 0 ? ':' + posInt(at.line) : ''));
    var files = a ? Object.keys(a.files || {}).map(function (f) { return typeof a.files[f] === 'string' ? shownPath(a.files[f]) : relPath(f); })
      : Object.keys(follow.at).filter(function (o) { return o === 'main'; }).map(function (o) { return relPath(follow.at[o].file); });
    if (files.length) lines.push('Files: ' + files.join(', '));
    if (a && a.result) lines.push('Result:\n' + a.result);
    return lines.join('\n');
  }
  function switchToAgent(k) {
    sw.active = k;
    setFollow(k, true);
    swSoon();
  }
  function cycleAgent(step) {
    var keys = swKeys();
    if (keys.length < 2) return showToast('No subagents are running. Claude starts them with the Agent tool.');
    var i = keys.indexOf(follow.mode);
    var next = keys[(i + step + keys.length) % keys.length];
    if (!sw.open && !swInDock()) toggleSwitcher(true);
    switchToAgent(next);
    showToast('Following ' + ownerLabel(next));
  }
  function toggleSwitcher(open) {
    sw.open = typeof open === 'boolean' ? open : !sw.open;
    storageSet('localStorage', 'editlens.agentsOpen', sw.open ? null : 'closed');
    renderSwitcher();
  }
  // Only one agent's messages and edits (and Team posts) in the panel.
  function ownerMatch(node, k) {
    var mate = node.getAttribute('data-mate');
    var a = agents[k];
    if (mate !== null) return k === 'main' ? mate === 'main' : Boolean(a && a.agentId && mate === a.agentId);
    var o = node.getAttribute('data-owner') || 'main';
    return o === k || Boolean(a && a.agentId && o === 'a:' + a.agentId);
  }
  function applyOwnerFilter(node) {
    if (!node || node.nodeType !== 1 || node === emptyEl || node === teamEmptyEl) return;
    node.classList.toggle('oh', Boolean(ownerFilter) && !ownerMatch(node, ownerFilter));
  }
  function setOwnerFilter(k) {
    ownerFilter = k && (k === 'main' || agents[k]) ? k : null;
    Array.prototype.forEach.call(feedEl.children, applyOwnerFilter);
    Array.prototype.forEach.call(teamFeedEl.children, applyOwnerFilter);
    ownerBar.classList.toggle('on', Boolean(ownerFilter));
    if (ownerFilter) {
      ownerBar.style.setProperty('--ofc', ownerColor(ownerFilter));
      ownerBar.replaceChildren(el('span', { text: 'Showing only ' + ownerLabel(ownerFilter) }),
        el('button', { class: 'mini', type: 'button', text: 'Show all agents', on: { click: function () { setOwnerFilter(null); } } }));
    } else {
      ownerBar.replaceChildren();
    }
    scrollFeed(true);
    swSoon();
  }
  // Default beside the panel; a dragged position replaces it (grows down in the top half, up in the
  // bottom). The header always stays on screen so it can be closed or moved.
  function placeSwitcher() {
    var st = switcher.style;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var w = switcher.offsetWidth;
    var h = switcher.offsetHeight;
    var L = layout.agents;
    var a = pageArea();
    var pos = null; // { left | right, bottom }
    var width = 320;
    var MIN_W = 230;
    var headH = swHead.offsetHeight || 40;
    if (L.x !== null && L.b !== null) {
      // b: from the window's bottom to the header's bottom (growing down) or the box's (growing up).
      var b = clamp(L.b, 4, Math.max(4, vh - headH - 4));
      var down = vh - b - headH / 2 < vh / 2;
      pos = down
        ? { left: clamp(L.x, 4, Math.max(4, vw - w - 4)), top: vh - b - headH }
        : { left: clamp(L.x, 4, Math.max(4, vw - w - 4)), bottom: b };
    } else if (panelOnPage()) {
      var r = panel.getBoundingClientRect();
      var bottom = vh - r.bottom;
      var onRight = r.left + r.width / 2 > vw / 2;
      // Room beside the panel's inner edge; the switcher narrows to fit it.
      var room = onRight ? r.left - a.left - 16 : a.right - r.right - 16;
      if (room >= MIN_W) {
        width = Math.min(320, room);
        pos = onRight ? { right: vw - r.left + 10, bottom: bottom } : { left: r.right + 10, bottom: bottom };
      } else if (r.top - a.top >= 200) {
        // The selection bar also goes above the panel when it has no room beside it (placeFloaters):
        // then the switcher goes above the bar, and its list scrolls in the space left.
        var over = vh - r.top + 8;
        var sb = selBar.classList.contains('on') ? selBar.getBoundingClientRect() : null;
        if (sb && sb.height && sb.bottom > vh - over - h && sb.top < vh - over && sb.left < r.left + width && sb.right > r.left) over = vh - sb.top + 8;
        pos = { left: Math.max(4, r.left), bottom: over };
      } else {
        pos = { left: a.left + 8, bottom: vh - a.bottom + EDGE };
      }
    } else {
      pos = { left: a.left + EDGE, bottom: vh - a.bottom + EDGE };
    }
    switcher.style.setProperty('--sww', Math.round(width) + 'px');
    st.left = pos.left !== undefined ? Math.round(pos.left) + 'px' : 'auto';
    st.right = pos.right !== undefined ? Math.round(pos.right) + 'px' : 'auto';
    st.bottom = pos.top === undefined ? Math.round(pos.bottom) + 'px' : 'auto';
    st.top = pos.top !== undefined ? Math.round(pos.top) + 'px' : 'auto';
    switcher.style.transformOrigin = pos.top !== undefined ? 'top left' : 'bottom left';
    // The list scrolls instead of going past the window's edge. Measured from the parts around it
    // (not the whole box, which may still be animating open).
    var room = pos.top !== undefined ? vh - pos.top - 4 : vh - pos.bottom - 4;
    var chrome = headH + (swHint.offsetHeight || 0) + 14;
    switcher.style.setProperty('--swmax', Math.max(40, Math.min(440, room - chrome)) + 'px');
    st.maxHeight = Math.max(headH, room) + 'px';
  }
  // Drag by the header; dropped near an edge, it moves to the edge. A click opens or closes it.
  swHead.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    var r = switcher.getBoundingClientRect();
    var startX = e.clientX;
    var startY = e.clientY;
    var offX = e.clientX - r.left;
    var offTop = e.clientY - r.top;
    var moved = false;
    // Where the header's top is -> layout.agents.b for that spot (see placeSwitcher).
    function bFor(headTop) {
      var vh = window.innerHeight;
      var headH = swHead.offsetHeight || 40;
      headTop = clamp(headTop, 4, Math.max(4, vh - headH - 4));
      var down = headTop + headH / 2 < vh / 2;
      return Math.round(down ? vh - headTop - headH : vh - headTop - switcher.offsetHeight);
    }
    swHead.setPointerCapture(e.pointerId);
    function move(ev) {
      if (!moved) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return;
        moved = true;
        switcher.classList.add('moving');
      }
      layout.agents.x = Math.round(ev.clientX - offX);
      layout.agents.b = bFor(ev.clientY - offTop);
      placeSwitcher();
    }
    function up() {
      swHead.removeEventListener('pointermove', move);
      swHead.removeEventListener('pointerup', up);
      swHead.removeEventListener('pointercancel', up);
      switcher.classList.remove('moving');
      if (!moved) return;
      swHead.dataset.dragged = '1';
      var box = switcher.getBoundingClientRect();
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      if (box.left < SNAP) layout.agents.x = EDGE;
      else if (vw - box.right < SNAP) layout.agents.x = Math.round(vw - box.width - EDGE);
      if (box.top < SNAP) layout.agents.b = bFor(EDGE);
      else if (vh - box.bottom < SNAP) layout.agents.b = bFor(vh - EDGE - box.height);
      placeSwitcher();
      saveLayout();
    }
    swHead.addEventListener('pointermove', move);
    swHead.addEventListener('pointerup', up);
    swHead.addEventListener('pointercancel', up);
  });
  swHead.addEventListener('click', function () {
    if (swHead.dataset.dragged) {
      delete swHead.dataset.dragged;
      return;
    }
    toggleSwitcher();
  });
  swHead.addEventListener('dblclick', function () {
    layout.agents.x = layout.agents.b = null;
    saveLayout();
    toggleSwitcher(true);
  });
  swList.addEventListener('keydown', function (e) {
    var rows = Array.prototype.slice.call(swList.querySelectorAll('.arow'));
    var cur = e.target.closest ? e.target.closest('.arow') : null;
    var i = rows.indexOf(cur);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      var n = rows[clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, rows.length - 1)];
      if (n) n.focus();
    } else if ((e.key === 'Enter' || e.key === ' ') && cur && e.target === cur) {
      e.preventDefault();
      switchToAgent(cur.getAttribute('data-key'));
    } else if (e.key === 'Escape' && !swInDock()) {
      e.preventDefault();
      e.stopPropagation();
      toggleSwitcher(false);
      swHead.focus();
    }
  });
  swList.addEventListener('focusin', function (e) {
    var rows = swList.querySelectorAll('.arow');
    rows.forEach(function (r) { r.setAttribute('tabindex', r === (e.target.closest && e.target.closest('.arow')) ? '0' : '-1'); });
  });
  window.addEventListener('keydown', function (e) {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || hostTyping(e)) return;
    if (e.code === 'KeyA' || e.key === 'A' || e.key === 'a') {
      e.preventDefault();
      // The code view open: its sidebar's Agents list.
      if (swInDock()) toggleSideTab('agents');
      else if (Object.keys(agents).length) toggleSwitcher();
      else showToast('No subagents yet. The Agents switcher appears when Claude starts one.');
    } else if (e.code === 'BracketRight' || e.code === 'BracketLeft') {
      e.preventDefault();
      cycleAgent(e.code === 'BracketRight' ? 1 : -1);
    }
  });
  setInterval(function () {
    if ((!switcher.classList.contains('on') || !sw.open) && !swInDock()) return;
    swList.querySelectorAll('.arow').forEach(function (row) {
      var t = row.querySelector('.swtime');
      var text = elapsedText(row.getAttribute('data-key'));
      if (t) t.textContent = text;
      var d = row.querySelector('.rdet [data-elapsed]');
      if (d) d.textContent = text || '—';
    });
    // Finished agents leave the list after a while, unless pinned or followed.
    if (swList.children.length !== swKeys().length) swSoon();
  }, 1000);

  // ---------- Follow: showing the page for the code ----------
  // Following an agent navigates to the page showing its file and outlines those lines. The
  // file->page map is learned while browsing, plus server-read routes. Waits while the user
  // is using the page.
  var PAGE_MAP_KEY = 'editlens.pageMap';
  var PAGE_TASK_KEY = 'editlens.pageTask';
  var CLICKABLE = 'a[href],button,[role="tab"],[role="link"],[role="button"],[role="menuitem"],summary';
  var HOLD_MS = 6000; // after the user touches the page, wait this long before moving it
  var GAP_MS = 1500; // at most one page move this often
  var pageMap = readJsonStore('localStorage', PAGE_MAP_KEY) || {};
  var learn = { files: {}, route: null, via: null, viaAt: 0, timer: 0 };
  var pageGo = {
    paused: storageGet('localStorage', 'editlens.followPage') === 'off',
    pending: null, timer: 0, seq: 0, lastInput: 0, lastAt: 0, lastKey: '', note: '', routes: null, routesAt: 0,
  };

  function readJsonStore(kind, key) {
    var raw = storageGet(kind, key);
    if (!raw) return null;
    try {
      var v = JSON.parse(raw);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch (err) {
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }
  var pageMapTimer = 0;
  function savePageMap() {
    if (pageMapTimer) return;
    pageMapTimer = setTimeout(function () {
      pageMapTimer = 0;
      var keys = Object.keys(pageMap);
      if (keys.length > 400) {
        keys.sort(function (a, b) { return finiteNum(pageMap[a].ts) - finiteNum(pageMap[b].ts); })
          .slice(0, keys.length - 400).forEach(function (k) { delete pageMap[k]; });
      }
      storageSet('localStorage', PAGE_MAP_KEY, JSON.stringify(pageMap));
    }, 500);
  }
  // The page as a router sees it: path and query, plus the hash for hash routers (#/reports).
  function routeNow() {
    var h = location.hash && location.hash.indexOf('#/') === 0 ? location.hash : '';
    return location.pathname + location.search + h;
  }
  function srcOf(e) {
    var s = parseSrc(e.getAttribute('data-editlens-src'));
    return s ? { file: s.file, line: s.line } : null;
  }
  function filesOnPage() {
    var out = Object.create(null);
    safeQueryAll('[data-editlens-src]').forEach(function (e) {
      var s = srcOf(e);
      if (s && !out[s.file] && visible(e)) out[s.file] = true;
    });
    return out;
  }
  function lookupFile(map, file) {
    if (!map || !file) return null;
    var best = null;
    Object.keys(map).forEach(function (k) {
      if (samePath(k, file) && (!best || finiteNum(map[k].ts) > finiteNum(map[best].ts))) best = k;
    });
    return best === null ? null : map[best];
  }

  // Learning: which files each page shows, and which click made a file appear.
  function learnSoon() {
    if (!learn.timer) learn.timer = setTimeout(learnNow, 600);
  }
  function learnNow() {
    learn.timer = 0;
    var route = routeNow();
    var files = filesOnPage();
    var via = learn.via && Date.now() - learn.viaAt < 5000 && learn.via.route === route ? learn.via.desc : null;
    var changed = false;
    Object.keys(files).forEach(function (f) {
      var appeared = !learn.files[f] || learn.route !== route;
      if (!appeared && pageMap[f]) return;
      pageMap[f] = { route: route, via: learn.route === route ? via : null, ts: Date.now() };
      changed = true;
    });
    learn.files = files;
    learn.route = route;
    if (changed) savePageMap();
  }
  // Follow may press only what moves around the app: links to another route, and tabs. Never one in a
  // form, a submit button, or one whose words do something (Delete, Pay, Send, Log off…).
  var RISKY_WORDS = /\b(delete|remove|clear|reset|submit|send|save|pay|buy|order|checkout|confirm|approve|reject|accept|decline|ok|yes|no|cancel|close|log ?out|sign ?out|sign ?in|log ?in|log ?off|sign ?off|sign ?up|register|subscribe|unsubscribe|leave|exit|quit|deactivate|disconnect|revoke|discard|restore|archive|publish|post|upload|download|import|export|run|start|stop|create|add|new|edit|update|refresh|retry|undo|redo|copy|share|invite|transfer|withdraw|deposit|empty|purge|drop|kill|disable|enable)\b/i;
  var VIA_MAX_AGE = 30 * 864e5;
  function safeWords(e) {
    var words = String(e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim() + ' ' + (e.getAttribute('aria-label') || '');
    return words.length <= 40 && !RISKY_WORDS.test(words);
  }
  // A link counts only when its href goes to another route of this site: '#', 'javascript:' and
  // same-route links do their work in a click handler, which may delete or pay.
  function routeLink(a) {
    var href = String(a.getAttribute('href') || '').trim();
    if (!href || /^javascript:/i.test(href) || (href.charAt(0) === '#' && href.indexOf('#/') !== 0)) return false;
    var u;
    try {
      u = new URL(href, location.href);
    } catch (err) {
      if (err instanceof TypeError) return false;
      throw err;
    }
    if (u.origin !== location.origin) return false;
    var to = u.pathname + u.search + (u.hash.indexOf('#/') === 0 ? u.hash : '');
    return to !== routeNow();
  }
  // In a form, or owned by one through form="..." (a button with no type then submits it), or a
  // submit or reset control: never clicked by Follow (Sol H7).
  function formish(t) {
    if (t.closest('form') || t.hasAttribute('form') || t.form) return true;
    var type = String(t.getAttribute('type') || '').toLowerCase();
    return type === 'submit' || type === 'reset' || (t.tagName === 'INPUT' && type === 'image');
  }
  // Follow replays only a link to another route of this app and a tab. A plain button, also in a nav
  // bar, menu bar or menu, needs your click: its words can be in any language, and it may act.
  // Follow still moves the page through the history API when it knows the route.
  function navLike(t) {
    if (!t || !t.matches || !t.matches('a[href],[role="tab"]')) return false;
    // Not in a form, not a submit, no action words (an extra guard).
    if (formish(t) || !safeWords(t)) return false;
    return t.matches('a[href]') ? routeLink(t) : true;
  }
  function describeClickable(t) {
    var text = String(t.innerText || t.textContent || '').replace(/\s+/g, ' ').trim();
    var s = srcOf(t) || srcOf(t.closest('[data-editlens-src]') || t);
    return {
      tag: t.tagName.toLowerCase(),
      text: text.length <= 80 ? text : '',
      label: t.getAttribute('aria-label') || '',
      id: t.id || '',
      href: t.tagName === 'A' ? t.getAttribute('href') || '' : '',
      src: s ? s.file + ':' + s.line : '',
    };
  }
  function findClickable(d) {
    if (!d) return null;
    var list = safeQueryAll(CLICKABLE).filter(function (e) { return usable(e) && visible(e); });
    var tests = [
      function (e) { return d.id && e.id === d.id; },
      function (e) { return d.label && e.getAttribute('aria-label') === d.label && e.tagName.toLowerCase() === d.tag; },
      function (e) { return d.text && e.tagName.toLowerCase() === d.tag && String(e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim() === d.text; },
      function (e) { return d.href && e.tagName === 'A' && e.getAttribute('href') === d.href; },
      function (e) { var s = srcOf(e); return d.src && s && s.file + ':' + s.line === d.src; },
    ];
    for (var i = 0; i < tests.length; i++) {
      var hit = list.find(tests[i]);
      if (hit) return hit;
    }
    return null;
  }
  document.addEventListener('click', function (e) {
    if (!e.isTrusted || isOurs(e.target)) return;
    var t = e.target && e.target.closest ? e.target.closest(CLICKABLE) : null;
    if (!t) return;
    learn.files = filesOnPage();
    learn.route = routeNow();
    learn.via = navLike(t) ? { desc: describeClickable(t), route: learn.route } : null;
    learn.viaAt = Date.now();
  }, true);
  ['wheel', 'keydown', 'pointerdown', 'touchstart'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (e.isTrusted && !isOurs(e.target)) pageGo.lastInput = Date.now();
    }, { capture: true, passive: true });
  });
  window.addEventListener('popstate', learnSoon);
  window.addEventListener('hashchange', learnSoon);

  // Routes the server read from the project (updated periodically).
  function staticRoutes() {
    if (pageGo.routes && Date.now() - pageGo.routesAt < 30000) return Promise.resolve(pageGo.routes);
    return fetch(SERVER + '/pages?' + new URLSearchParams({ page: PAGE_ID }).toString()).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (j) {
      pageGo.routes = j && j.files && typeof j.files === 'object' ? j : { files: {} };
      pageGo.routesAt = Date.now();
      return pageGo.routes;
    }, function (err) {
      console.warn('[EditLens] could not read the project routes:', err);
      return { files: {} };
    });
  }
  // Where a file shows: { route, via } or null. Learned while browsing first, then server routes.
  function knownPlace(file) {
    var rec = lookupFile(pageMap, file);
    if (rec && typeof rec.route === 'string') return { route: rec.route, via: rec.via && Date.now() - finiteNum(rec.ts) < VIA_MAX_AGE ? rec.via : null };
    var files = pageGo.routes && pageGo.routes.files;
    if (!files) return null;
    var hit = null;
    Object.keys(files).forEach(function (k) { if (!hit && samePath(k, file) && Array.isArray(files[k]) && files[k].length) hit = files[k]; });
    if (!hit) return null;
    return { route: hit.indexOf(location.pathname) >= 0 ? location.pathname : hit[0], via: null };
  }
  function whereIs(file) {
    var now = knownPlace(file);
    if (now && lookupFile(pageMap, file)) return Promise.resolve(now);
    return staticRoutes().then(function () { return knownPlace(file); });
  }

  // The elements written on these lines of the file; if none, the nearest one; whole file: its outermost.
  function elementsForFile(file, a, b) {
    var all = [];
    safeQueryAll('[data-editlens-src]').forEach(function (e) {
      var s = srcOf(e);
      if (s && samePath(s.file, file) && visible(e)) all.push({ e: e, line: s.line });
    });
    if (!all.length) return [];
    var hit = all;
    if (a > 0) {
      var end = b >= a ? b : a;
      hit = all.filter(function (x) { return x.line >= a && x.line <= end; });
      if (!hit.length) {
        var near = all.reduce(function (best, x) { return !best || Math.abs(x.line - a) < Math.abs(best.line - a) ? x : best; }, null);
        hit = [near];
      }
    }
    var els = hit.map(function (x) { return x.e; });
    return els.filter(function (e) { return !els.some(function (o) { return o !== e && o.contains(e); }); });
  }
  // token: a page move's number; when a newer move or a pause raises pageGo.seq, it stops with [].
  function waitForElements(find, ms, token) {
    var until = Date.now() + ms;
    return new Promise(function (resolve) {
      (function check() {
        if (token !== undefined && token !== pageGo.seq) return resolve([]);
        var list = find();
        if (list.length || Date.now() > until) return resolve(list);
        setTimeout(check, 150);
      })();
    });
  }
  function pause(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Going to a page: a link to it on the page (the app's router handles it), else the history API
  // with a popstate event (React Router, Vue Router), else loading the page.
  function storeTask(task) {
    storageSet('sessionStorage', PAGE_TASK_KEY, task ? JSON.stringify({ task: task, until: Date.now() + 20000 }) : null);
  }
  // A link Follow may click to go to url: shown, with the checks of a learned click (no action
  // words, not in a form, goes to another route), and going exactly there.
  function safeLinkTo(url) {
    return safeQueryAll('a[href]').find(function (a) {
      if (!usable(a) || a.target === '_blank' || a.hasAttribute('download') || !visible(a) || !navLike(a)) return false;
      if (getComputedStyle(a).visibility === 'hidden') return false;
      try {
        var u = new URL(a.getAttribute('href'), location.href);
        return u.origin === url.origin && u.pathname === url.pathname && u.search === url.search && (u.hash === url.hash || url.hash.indexOf('#/') !== 0);
      } catch (err) {
        if (err instanceof TypeError) return false;
        throw err;
      }
    }) || null;
  }
  // token: the page move's number; a pause or a newer move raises pageGo.seq, and nothing more happens.
  function goTo(route, task, token) {
    if (token !== pageGo.seq) return Promise.resolve(false);
    if (route === routeNow() || route === location.pathname) return Promise.resolve(true);
    var url;
    try {
      url = new URL(route, location.href);
    } catch (err) {
      if (err instanceof TypeError) return Promise.resolve(false);
      throw err;
    }
    if (url.origin !== location.origin) return Promise.resolve(false);
    storeTask(task); // in case the page reloads
    var started = Date.now();
    var link = safeLinkTo(url);
    if (link) link.click();
    else if (url.pathname === location.pathname && url.search === location.search) location.hash = url.hash;
    else {
      history.pushState(null, '', url.pathname + url.search + url.hash);
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    }
    return pause(700).then(function () {
      // Something else moved the page meanwhile (you, a pause, or a newer page move): leave it there.
      if (token !== pageGo.seq || location.pathname !== url.pathname) {
        storeTask(null);
        return false;
      }
      takeRecords();
      if (mutations.some(function (m) { return m.t >= started; })) return true;
      // The address changed but the app didn't react (no client-side router): load the page; the
      // task continues there.
      location.assign(url.href);
      return new Promise(function () {});
    });
  }

  function setPageNote(text) {
    if (pageGo.note === text) return;
    pageGo.note = text;
    renderFollow();
  }
  // Show a file's lines on the page. task: { file, line, end, owner, keep, quiet }
  //   owner: outline in that agent's color; keep: the user's own selection stays (Show).
  //   selectors: for a stylesheet, the CSS selectors of the rules on those lines.
  function taskFinder(task) {
    if (task.keep) return function () { return sel.key ? selectionTargets() : []; };
    if (task.selectors) return function () { return elementsFromHints({ selectors: task.selectors }).filter(visible); };
    var a = posInt(task.line);
    var b = posInt(task.end);
    return function () { return elementsForFile(task.file, a, b); };
  }
  // Files that belong to no single page: global stylesheets, the app's entry and layout files.
  var MODULE_STYLE = /\.module\.[a-z]+$/i;
  var APP_WIDE = /(^|[\/\\])(main|index|app|_app|_document|layout|root|entry[-.\w]*|globals?|theme|reset|base|variables|tokens|styles?)\.[a-z]+$/i;
  // Files whose code draws part of a page (anything else, like a server file or JSON, never does).
  var PAGE_FILE = /\.(jsx|tsx|vue|svelte|astro|html?|mdx)$/i;
  function pageNote(task, msg) {
    setPageNote(msg);
    if (!task.quiet) showToast(msg);
    return false;
  }
  function revealFile(task) {
    var token = ++pageGo.seq;
    pageGo.lastAt = Date.now();
    var file = task.file || '';
    if (task.away && !task.keep) return Promise.resolve(pageNote(task, task.away));
    if (STYLE_FILE.test(file) && !task.keep) return revealStyle(task, token);
    var find = taskFinder(task);
    if (find().length) return Promise.resolve(arrived(task, token));
    return whereIs(file).then(function (place) {
      if (token !== pageGo.seq) return false;
      if (!place) {
        var name = baseName(file);
        // A global stylesheet or an app-wide file is on every page: stay here.
        if (STYLE_FILE.test(file)) return pageNote(task, 'The selected CSS in ' + name + " doesn't change anything on this page.");
        if (APP_WIDE.test(file)) return pageNote(task, name + ' sets up the whole app, so there is no one part of this page to show. Its code is in the code view.');
        if (!PAGE_FILE.test(file)) return pageNote(task, name + ' does not make anything shown on this page. Its code is in the code view.');
        return pageNote(task, name + " isn't on this page. Open the page that shows it once, and after that, Follow opens it automatically.");
      }
      return goTo(place.route, task, token).then(function (ok) {
        return ok && token === pageGo.seq ? afterRoute(task, place, find, token) : false;
      });
    });
  }
  // A stylesheet shows on whatever page uses its rules: outline what the changed rules style on
  // this page. Only a CSS module (one component's styles) can move the page to another route.
  function styleLines(task) {
    var fromSnap = task.snapshot ? fetchSnapshot(task.snapshot) : Promise.resolve(null);
    return fromSnap.then(function (snap) {
      if (snap && typeof snap.after === 'string') return snap;
      var q = new URLSearchParams({ ref: task.file, page: PAGE_ID });
      return fetch(SERVER + '/file?' + q.toString()).then(function (res) {
        return res.ok ? res.json() : null;
      }).then(function (j) {
        return j && j.kind === 'file' && j.snapshot ? fetchSnapshot(snapRef(j.snapshot)) : null;
      });
    }).then(function (snap) {
      return snap && typeof snap.after === 'string' ? splitLines(snap.after) : null;
    }, function (err) {
      console.warn('[EditLens] could not read the stylesheet:', err);
      return null;
    });
  }
  function revealStyle(task, token) {
    var file = task.file || '';
    var name = baseName(file);
    return styleLines(task).then(function (lines) {
      if (token !== pageGo.seq) return false;
      var a = posInt(task.line);
      var b = posInt(task.end) > a ? posInt(task.end) : a;
      var set = new Set();
      if (lines) for (var i = a || 1; i <= (a ? b : lines.length) && set.size < 2000; i++) set.add(i);
      var selectors = lines ? cssSelectorsAt(lines, set) : [];
      var t = {};
      Object.keys(task).forEach(function (k) { t[k] = task[k]; });
      t.selectors = selectors;
      return waitForElements(taskFinder(t), 600).then(function (list) {
        if (token !== pageGo.seq) return false;
        if (list.length) return arrived(t, token);
        if (MODULE_STYLE.test(file)) {
          return whereIs(file).then(function (place) {
            if (token !== pageGo.seq) return false;
            if (!place) return pageNote(task, 'The CSS in ' + name + " isn't used on this page. Open the page that uses it once, and after that, Follow opens it automatically.");
            return goTo(place.route, t, token).then(function (ok) {
              return ok && token === pageGo.seq ? afterRoute(t, place, taskFinder(t), token) : false;
            });
          });
        }
        var whole = selectors.length && selectors.every(function (s) { return /^(html|body|:root|\*)$/i.test(cleanSelector(s) || s); });
        return pageNote(task, whole ? 'This CSS change in ' + name + ' affects the whole page (' + selectors.join(', ') + ').'
          : 'This CSS change in ' + name + " doesn't affect anything on this page" + (selectors.length ? ' (it changes ' + selectors.join(', ') + ')' : '') + '. It may change how other pages look.');
      });
    });
  }
  // On the right page: click the button that shows the file if needed, then wait for it.
  function afterRoute(task, place, find, token) {
    storeTask(null);
    var step = place.via && !find().length
      ? waitForElements(function () { var c = findClickable(place.via); return c && navLike(c) ? [c] : []; }, 2500, token).then(function (c) {
        if (c[0] && token === pageGo.seq) c[0].click();
      })
      : Promise.resolve();
    return step.then(function () { return waitForElements(find, 4000, token); }).then(function (list) {
      if (token !== pageGo.seq) return false;
      if (list.length) return arrived(task, token);
      var msg = 'Went to ' + place.route + ', but ' + (STYLE_FILE.test(task.file || '') ? 'the CSS in ' + baseName(task.file) + " doesn't change anything there." : baseName(task.file) + " isn't showing there right now. It may need a click or data first.");
      setPageNote(msg);
      if (!task.quiet) showToast(msg);
      return false;
    });
  }
  function arrived(task, token) {
    if (token !== pageGo.seq) return false;
    setPageNote('');
    if (task.keep) {
      drawSelection(true);
      revealBox(sel.boxes[0]);
      return true;
    }
    var a = posInt(task.line);
    var b = posInt(task.end) > a ? posInt(task.end) : 0;
    select({
      key: 'follow:' + normPath(task.file) + ':' + a + '-' + b,
      kind: 'follow',
      label: (task.owner ? ownerLabel(task.owner) + ' · ' : '') + baseName(task.file) + (a ? ':' + a + (b ? '–' + b : '') : ''),
      find: taskFinder(task),
      scroll: true, file: task.file, line: a || null, end: b || null,
      color: task.owner ? ownerColor(task.owner) : null,
    });
    if (sel.boxes.length && !sel.boxes.some(onScreen)) revealBox(sel.boxes[0]);
    return true;
  }

  // Following: the followed agent read or edited a file.
  function pageFollow(owner, at) {
    if (pageGo.paused || !at || !at.file || !(follow.mode === owner || follow.mode === 'active')) return;
    var key = normPath(at.file) + ':' + (at.line || '') + ':' + (at.end || '');
    if (key === pageGo.lastKey && Date.now() - pageGo.lastAt < 4000) return;
    pageGo.pending = { file: at.file, line: at.line || null, end: at.end || null, snapshot: at.snapshot || null, owner: owner, quiet: true, key: key, away: at.away || '' };
    schedulePending(50);
  }
  function schedulePending(min) {
    clearTimeout(pageGo.timer);
    var wait = Math.max(min || 0, HOLD_MS - (Date.now() - pageGo.lastInput), GAP_MS - (Date.now() - pageGo.lastAt));
    if (HOLD_MS - (Date.now() - pageGo.lastInput) > 0) setPageNote("Waiting until you stop scrolling or typing, then the page follows.");
    pageGo.timer = setTimeout(runPending, wait);
  }
  function runPending() {
    var t = pageGo.pending;
    if (!t || pageGo.paused) return;
    if (Date.now() - pageGo.lastInput < HOLD_MS) return schedulePending(0);
    pageGo.pending = null;
    pageGo.lastKey = t.key;
    revealFile(t);
  }
  function setPagePaused(on, fromSettings) {
    pageGo.paused = on;
    pageGo.seq++; // stops a page move that is waiting
    storeTask(null);
    storageSet('localStorage', 'editlens.followPage', on ? 'off' : null);
    if (!fromSettings) saveSetting('follow_page', !on);
    clearTimeout(pageGo.timer);
    pageGo.pending = null;
    setPageNote('');
    if (!on && follow.mode !== 'all') {
      var k = follow.mode === 'active' ? latestOwner() : follow.mode;
      if (k && follow.at[k]) revealFile(followTask(k));
    }
  }

  // ---------- code on hover: what changed in the part of the page under the pointer ----------
  // "Changed" = highlighted for an edit here, source lines edited in the last 30 min, or styled
  // by an edited CSS rule. Removed parts are shown as a dashed outline.
  var PEEK_DELAY = 300;
  var PEEK_RECENT_MS = 30 * 60 * 1000;
  var peek = {
    on: storageGet('localStorage', 'editlens.hoverCode') !== 'off',
    marks: new WeakMap(), // element -> [{ ev, approx }]
    edits: [], // recent edits, newest last
    cssSel: new WeakMap(), // stylesheet edit -> selectors of its changed rules
    ghosts: [], // { ev, parent, prev, next, node, until }
    removed: [], // { t, parent, prev, next }
    timer: 0, hideTimer: 0, raf: 0, x: 0, y: 0,
    key: null, entries: [], i: 0, pinned: false, anchor: null, all: false,
  };
  var peekCard = el('div', { class: 'peek', role: 'dialog', 'aria-label': 'Code for this part of the page' });
  var peekOutline = el('div', { class: 'peekbox' });

  function setPeek(on, fromSettings) {
    peek.on = Boolean(on);
    storageSet('localStorage', 'editlens.hoverCode', peek.on ? null : 'off');
    if (!fromSettings) saveSetting('hover_code', peek.on);
    if (!peek.on) hidePeek(true);
  }
  // An edit arrived (live or from history): remember it, and read a stylesheet's changed rules.
  function peekRemember(ev) {
    if (!ev || !ev.hunks || !ev.hunks.length) return;
    peek.edits.push(ev);
    if (peek.edits.length > 200) peek.edits.splice(0, peek.edits.length - 200);
    if (STYLE_FILE.test(ev.file || ev.relFile || '') && ev.snapshot) {
      fetchSnapshot(ev.snapshot).then(function (snap) {
        if (snap && typeof snap.after === 'string') peek.cssSel.set(ev, cssSelectorsAt(splitLines(snap.after), changedLines(ev.hunks)));
      }, function (err) { console.warn('[EditLens] could not read the stylesheet:', err); });
    }
  }
  // These elements were highlighted for this edit. A part as big as half the window (a whole
  // page section that re-rendered) is left out, so hovering anywhere on it doesn't open a card.
  function peekMark(targets, ev, approx) {
    if (!ev || !ev.hunks) return;
    var half = window.innerWidth * window.innerHeight / 2;
    targets.forEach(function (t) {
      var r = t.getBoundingClientRect();
      if (r.width * r.height > half) return;
      var list = (peek.marks.get(t) || []).filter(function (m) { return m.ev !== ev; });
      list.push({ ev: ev, approx: Boolean(approx) });
      peek.marks.set(t, list.slice(-6));
    });
  }
  // Parts of the page that were removed, so a removal can be shown where it was.
  function peekNoteRemoved(records, now) {
    records.forEach(function (r) {
      if (r.type !== 'childList' || !r.removedNodes.length) return;
      var parent = elementFor(r.target);
      if (!parent) return;
      r.removedNodes.forEach(function (n) {
        if (n.nodeType !== 1 || IGNORED_TAGS[n.tagName]) return;
        peek.removed.push({ t: now, parent: parent, prev: r.previousSibling, next: r.nextSibling });
      });
    });
    var cutoff = now - MUTATION_MEMORY_MS;
    while (peek.removed.length && peek.removed[0].t < cutoff) peek.removed.shift();
    if (peek.removed.length > 100) peek.removed.splice(0, peek.removed.length - 100);
  }
  function onlyRemoves(hunks) {
    var any = false;
    var add = false;
    (hunks || []).forEach(function (h) { (h.lines || []).forEach(function (l) { if (l[0] === '-') any = true; if (l[0] === '+') add = true; }); });
    return any && !add;
  }
  // An edit that only removed code: a dashed outline where each removed part was.
  function peekGhosts(ev, since) {
    if (!onlyRemoves(ev.hunks)) return;
    var spots = peek.removed.filter(function (r) { return r.t >= since && r.parent.isConnected; });
    spots = spots.filter(function (r, i) { return !spots.some(function (o, j) { return j < i && o.parent === r.parent && o.prev === r.prev; }); }).slice(0, 5);
    spots.forEach(function (r) {
      var node = el('div', { class: 'ghost' }, el('span', { class: 'tag', text: 'Removed · ' + labelFor(ev) }));
      layer.appendChild(node);
      peek.ghosts.push({ ev: ev, parent: r.parent, prev: r.prev && r.prev.nodeType === 1 ? r.prev : null, next: r.next && r.next.nodeType === 1 ? r.next : null, node: node, until: Date.now() + 120000 });
    });
    while (peek.ghosts.length > 8) peek.ghosts.shift().node.remove();
    placeGhosts();
  }
  function ghostRect(g) {
    var p = g.parent.getBoundingClientRect();
    var top = g.prev && g.prev.isConnected ? g.prev.getBoundingClientRect().bottom : p.top;
    var bottom = g.next && g.next.isConnected ? g.next.getBoundingClientRect().top : p.bottom;
    if (!(bottom - top >= 8) || bottom - top > 120) bottom = top + 8;
    return { left: p.left, top: top, width: Math.max(24, p.width), height: bottom - top };
  }
  function placeGhosts() {
    var now = Date.now();
    peek.ghosts = peek.ghosts.filter(function (g) {
      var keep = g.until > now && g.parent.isConnected && peek.on;
      if (!keep) g.node.remove();
      return keep;
    });
    peek.ghosts.forEach(function (g) {
      var r = ghostRect(g);
      g.node.style.left = r.left + 'px';
      g.node.style.top = r.top + 'px';
      g.node.style.width = r.width + 'px';
      g.node.style.height = r.height + 'px';
    });
    cancelAnimationFrame(peek.raf);
    peek.raf = peek.ghosts.length || peek.key ? requestAnimationFrame(placeGhosts) : 0;
    if (peek.key) placePeek();
  }

  function recentEdit(ev) {
    var t = Number(ev.ts);
    return !Number.isFinite(t) || Date.now() - t < PEEK_RECENT_MS;
  }
  // The changed lines of this edit whose code an element (or its nearest source element) is.
  // The tagged elements on the page, read once and kept until the page changes, so a hover doesn't
  // query the whole page on every frame.
  var taggedCache = null;
  var taggedWatch = null;
  function taggedOnPage() {
    if (taggedCache) return taggedCache;
    if (!taggedWatch && typeof MutationObserver === 'function' && document.documentElement) {
      taggedWatch = new MutationObserver(function () { taggedCache = null; });
      taggedWatch.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-editlens-src'] });
    }
    var list = safeQueryAll('[data-editlens-src]').map(function (e) { return { e: e, s: srcOf(e) }; })
      .filter(function (x) { return x.s; });
    if (taggedWatch) taggedCache = list;
    return list;
  }
  function sourceMatch(node) {
    var a = node.closest ? node.closest('[data-editlens-src]') : null;
    var s = a ? srcOf(a) : null;
    if (!s) return [];
    var onPage = taggedOnPage().filter(function (x) { return samePath(x.s.file, s.file); });
    var out = [];
    peek.edits.slice().reverse().forEach(function (ev) {
      if (ev.kind === 'backend' || STYLE_FILE.test(ev.file || '') || !recentEdit(ev)) return;
      if (!samePath(ev.relFile || ev.file, s.file) && !samePath(ev.file, s.file)) return;
      var hit = null;
      changedLines(ev.hunks).forEach(function (line) {
        if (hit && !hit.approx) return;
        var exact = onPage.filter(function (x) { return x.s.line === line && x.e.contains(node); });
        if (exact.length) {
          hit = { ev: ev, approx: false, el: exact[exact.length - 1].e, line: line };
          return;
        }
        // No element starts on that line: it belongs to the element that starts last before it.
        var owner = null;
        onPage.forEach(function (x) { if (x.s.line <= line && (!owner || x.s.line >= owner.s.line)) owner = x; });
        if (!hit && owner && owner.e === a) hit = { ev: ev, approx: true, el: a, line: line };
      });
      if (hit) out.push(hit);
    });
    return out;
  }
  function styleMatch(node) {
    var out = [];
    peek.edits.slice().reverse().forEach(function (ev) {
      var sels = peek.cssSel.get(ev);
      if (!sels || !sels.length || !recentEdit(ev)) return;
      for (var e = node, d = 0; e && d < 3 && e !== document.body; e = e.parentElement, d++) {
        var hit = sels.filter(function (s) {
          var c = cleanSelector(s);
          if (!c || /^(html|body|:root|\*)$/i.test(c)) return false;
          try {
            return e.matches(c);
          } catch (err) {
            if (err && err.name === 'SyntaxError') return false;
            throw err;
          }
        });
        if (hit.length) {
          out.push({ ev: ev, approx: false, el: e, css: hit });
          return;
        }
      }
    });
    return out;
  }
  // Everything known about the part of the page under the pointer, newest first.
  function peekFind(node, x, y) {
    var g = peek.ghosts.find(function (gh) {
      var r = ghostRect(gh);
      return x >= r.left - 4 && x <= r.left + r.width + 4 && y >= r.top - 4 && y <= r.top + r.height + 4;
    });
    if (g) return [{ ev: g.ev, approx: false, el: null, ghost: g }];
    // From the source lines, from what was highlighted for an edit, and from the stylesheets.
    var found = sourceMatch(node);
    for (var e = node, d = 0; e && e !== document.body && e !== document.documentElement && d < 12; e = e.parentElement, d++) {
      var marks = peek.marks.get(e);
      if (marks && e.isConnected) marks.slice().reverse().forEach(function (m) { found.push({ ev: m.ev, approx: m.approx, el: e }); });
      if (sel.ev && sel.boxes.some(function (b) { return b.target === e; })) found.push({ ev: sel.ev, approx: false, el: e });
    }
    found = found.concat(styleMatch(node));
    // A part as big as half the window (a whole page section) gets no card: it would cover the page.
    var half = window.innerWidth * window.innerHeight / 2;
    found = found.filter(function (f) {
      var r = f.el ? f.el.getBoundingClientRect() : null;
      return !r || r.width * r.height <= half;
    });
    // One card for the innermost part: every change found is about the spot under the pointer.
    var anchor = null;
    found.forEach(function (f) { if (f.el && (!anchor || anchor.contains(f.el))) anchor = f.el; });
    var seen = [];
    return found.filter(function (f) {
      var dup = seen.find(function (o) { return o.ev === f.ev; });
      if (dup) {
        if (dup.approx && !f.approx) dup.approx = false;
        if (f.css && !dup.css) dup.css = f.css;
        return false;
      }
      seen.push(f);
      return true;
    }).map(function (f) {
      return { ev: f.ev, approx: f.approx, el: anchor || f.el, line: f.line, css: f.css };
    }).sort(function (a, b) { return finiteNum(b.ev.ts) - finiteNum(a.ev.ts); });
  }

  var peekIds = new WeakMap();
  var peekNextId = 1;
  function peekId(e) {
    if (!peekIds.has(e)) peekIds.set(e, peekNextId++);
    return peekIds.get(e);
  }
  // What a page reload needs to show an edit again.
  function peekLite(ev) {
    var out = {};
    ['type', 'kind', 'tool', 'file', 'relFile', 'hunks', 'ts', 'sessionId', 'agentId', 'agentType', 'snapshot', 'backup', 'seq', 'intent', 'created', 'truncated', 'routes', 'via', 'restoredFrom', 'removedSeq', 'fileKind'].forEach(function (k) {
      if (ev[k] !== undefined) out[k] = ev[k];
    });
    // The server start it came from (not enumerable on the event): its buttons stay on after the reload.
    if (typeof ev.inst === 'string') out.inst = ev.inst;
    return out;
  }
  function peekBlocked() {
    return !peek.on || pick.on || document.hidden;
  }
  // At most one lookup per frame, and none while there are no edits to show.
  var peekFrame = 0;
  var peekPath = null;
  function onPeekMove(e) {
    peek.x = e.clientX;
    peek.y = e.clientY;
    peekPath = e.composedPath ? e.composedPath() : null;
    if (!peekFrame) peekFrame = requestAnimationFrame(peekLookup);
  }
  function peekLookup() {
    peekFrame = 0;
    if (peekBlocked() || peek.pinned) return;
    if (!peek.edits.length && !peek.key) return;
    if (peekPath && peekPath.indexOf(host) >= 0) {
      // Over the card itself: keep it. Over the panel or anything else of ours: hide it.
      if (peek.key && peekPath.indexOf(peekCard) >= 0) return clearTimeout(peek.hideTimer);
      // Over the marker whose card is open: keep it.
      if (peek.key && peekPath.some(function (n) { return n.classList && n.classList.contains('emark'); })) return clearTimeout(peek.hideTimer);
      return peekLater(null);
    }
    var e = { clientX: peek.x, clientY: peek.y };
    var target = document.elementFromPoint(e.clientX, e.clientY);
    var entries = target && !isOurs(target) ? peekFind(target, e.clientX, e.clientY) : [];
    var key = entries.length ? entries.map(function (f) { return editKey(f.ev); }).join('|') + '@' + (entries[0].el ? peekId(entries[0].el) : 'ghost') : null;
    if (key === peek.key) return clearTimeout(peek.hideTimer);
    peekLater(entries.length ? { key: key, entries: entries } : null);
  }
  function peekLater(next) {
    clearTimeout(peek.timer);
    if (!next) {
      if (!peek.key) return;
      clearTimeout(peek.hideTimer);
      peek.hideTimer = setTimeout(function () { if (!peek.pinned) hidePeek(); }, 250);
      return;
    }
    peek.timer = setTimeout(function () {
      if (peekBlocked() || peek.pinned) return;
      showPeek(next.entries, next.key, null);
    }, PEEK_DELAY);
  }
  function showPeek(entries, key, anchor) {
    clearTimeout(peek.hideTimer);
    peek.key = key;
    peek.entries = entries;
    peek.i = 0;
    peek.all = false;
    peek.anchor = anchor;
    if (peekCard.parentNode !== root) root.appendChild(peekCard);
    if (peekOutline.parentNode !== layer) layer.appendChild(peekOutline);
    renderPeek();
    peekCard.classList.add('on');
    placeGhosts();
  }
  function hidePeek(force) {
    clearTimeout(peek.timer);
    clearTimeout(peek.hideTimer);
    if (!force && peek.pinned) return;
    peek.key = null;
    peek.entries = [];
    peek.pinned = false;
    peek.anchor = null;
    peek.confirm = null;
    peekCard.classList.remove('on', 'pinned');
    peekOutline.classList.remove('on');
  }
  function pinPeek(on) {
    peek.pinned = on;
    peekCard.classList.toggle('pinned', on);
    renderPeek();
  }

  // The hunks that belong to this part of the page (all of them when unsure).
  function peekHunks(f) {
    var hunks = f.ev.hunks || [];
    if (f.line == null || hunks.length < 2) return hunks;
    var mine = hunks.filter(function (h) {
      var start = Number(h.newStart);
      var span = (h.lines || []).filter(function (l) { return l[0] !== '-'; }).length;
      return Number.isFinite(start) && f.line >= start && f.line <= start + Math.max(span, 1);
    });
    return mine.length ? mine : hunks;
  }
  function peekKind(f, hunks) {
    if (f.ghost) return ['Removed', 'del'];
    if (f.ev.kind === 'restore') return [restoreLabel(f.ev), 'rst'];
    if (f.ev.kind === 'backend') return ['API', 'api'];
    if (f.css) return ['Style', 'css'];
    if (f.ev.created) return ['New file', 'add'];
    var adds = 0;
    var dels = 0;
    hunks.forEach(function (h) { (h.lines || []).forEach(function (l) { if (l[0] === '+') adds++; else if (l[0] === '-') dels++; }); });
    if (adds && !dels) return ['New', 'add'];
    if (dels && !adds) return ['Removed', 'del'];
    if (adds === 1 && dels === 1) return ['Text', 'txt'];
    return ['Changed', 'chg'];
  }
  // Word-by-word differences between an old and a new line.
  function wordDiff(a, b) {
    var x = a.match(/\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g) || [];
    var y = b.match(/\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g) || [];
    if (x.length * y.length > 40000) return null;
    var dp = [];
    for (var i = 0; i <= x.length; i++) {
      dp.push(new Array(y.length + 1).fill(0));
    }
    for (i = x.length - 1; i >= 0; i--) {
      for (var j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
    var oldParts = [];
    var newParts = [];
    i = 0;
    j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        oldParts.push([x[i], false]);
        newParts.push([y[j], false]);
        i++;
        j++;
      } else if (j < y.length && (i >= x.length || dp[i][j + 1] >= dp[i + 1][j])) newParts.push([y[j++], true]);
      else oldParts.push([x[i++], true]);
    }
    return { old: oldParts, new: newParts };
  }
  function wordLine(sign, parts, cls) {
    var row = el('div', { class: 'ln ' + cls });
    row.appendChild(document.createTextNode(sign));
    parts.forEach(function (p) { row.appendChild(p[1] ? el('mark', { text: p[0] }) : document.createTextNode(p[0])); });
    return row;
  }
  // old → new: removed lines, then added lines; a line changed in place shows which words changed.
  function peekCode(hunks) {
    var box = el('div', { class: 'pkcode' });
    hunks.forEach(function (h) {
      var start = firstChangedLine(h);
      box.appendChild(el('div', { class: 'ln h', text: 'line ' + (Number.isFinite(start) ? start : '—') }));
      var lines = h.lines || [];
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (l[0] !== '-') {
          box.appendChild(el('div', { class: 'ln' + (l[0] === '+' ? ' a' : ''), text: l }));
          continue;
        }
        var dels = [];
        while (i < lines.length && lines[i][0] === '-') dels.push(lines[i++]);
        var adds = [];
        while (i < lines.length && lines[i][0] === '+') adds.push(lines[i++]);
        i--;
        var paired = dels.length === adds.length && dels.length <= 6;
        var diffs = paired ? dels.map(function (d, k) { return wordDiff(d.slice(1), adds[k].slice(1)); }) : [];
        if (paired && diffs.every(Boolean)) {
          diffs.forEach(function (w) { box.appendChild(wordLine('-', w.old, 'd')); });
          diffs.forEach(function (w) { box.appendChild(wordLine('+', w.new, 'a')); });
        } else {
          dels.forEach(function (d) { box.appendChild(el('div', { class: 'ln d', text: d })); });
          adds.forEach(function (a) { box.appendChild(el('div', { class: 'ln a', text: a })); });
        }
      }
    });
    return box;
  }
  function renderPeek() {
    var f = peek.entries[peek.i];
    if (!f) return hidePeek(true);
    var ev = f.ev;
    var hunks = peek.all ? (ev.hunks || []) : peekHunks(f);
    var kind = peekKind(f, hunks);
    var first = hunks[0] ? firstChangedLine(hunks[0]) : NaN;
    var owner = ownerOf(ev);
    var head = el('div', { class: 'pkhead' },
      el('span', { class: 'pkbadge ' + kind[1], text: kind[0] }),
      el('span', { class: 'pkfile', text: '‎' + (ev.relFile || ev.file || '') + (Number.isFinite(first) && first > 0 ? ':' + first : '') }),
      f.approx ? el('span', { class: 'pkapprox', text: 'nearby', title: 'Matched by the nearest source line, so this may be a nearby change' }) : null);
    var who = el('div', { class: 'pkwho' }, el('i'), el('span', { text: ownerLabel(owner, true) }));
    who.style.setProperty('--fc', ownerColor(owner));
    var on = sessions.seen.length > 1 || sessions.control.length > 0;
    if (on && ev.sessionId) who.appendChild(el('span', { class: 'pksess', text: '· From ' + sessionLabel(ev.sessionId) }));
    who.appendChild(el('span', { class: 'pkago', text: '· ' + (timeAgo(ev.ts) || '—') }));
    var kids = [head, who, null];
    if (peek.entries.length > 1) {
      kids.push(el('div', { class: 'pkstep' },
        el('button', { class: 'mini', type: 'button', text: '‹', title: 'Newer change here', 'aria-label': 'Newer change', on: { click: function (e) { e.stopPropagation(); peek.i = Math.max(0, peek.i - 1); peek.all = false; renderPeek(); } } }),
        el('span', { text: (peek.i + 1) + ' of ' + peek.entries.length }),
        el('button', { class: 'mini', type: 'button', text: '›', title: 'Older change here', 'aria-label': 'Older change', on: { click: function (e) { e.stopPropagation(); peek.i = Math.min(peek.entries.length - 1, peek.i + 1); peek.all = false; renderPeek(); } } })));
    }
    if (f.css) {
      var n = elementsFromHints({ selectors: f.css }).filter(visible).length;
      kids.push(el('div', { class: 'pknote', text: 'Rule ' + f.css.join(', ') + ' · affects ' + n + ' element' + (n === 1 ? '' : 's') + ' on this page' }));
    }
    if (ev.intent) kids.push(el('div', { class: 'pknote', text: ev.intent }));
    var undoneBy = restoredBy(ev);
    if (undoneBy) kids.push(el('div', { class: 'pknote rnote', text: undoneBy.via === 'undo' ? 'This restore was undone.' : 'This change was undone (' + restoreLabel(undoneBy).toLowerCase() + (clock(undoneBy.ts) ? ' at ' + clock(undoneBy.ts) : '') + '). The file no longer has it.' }));
    if (isUndoAsked(ev)) kids.push(el('div', { class: 'pknote rnote', text: 'Claude is undoing it.' }));
    kids.push(peekCode(hunks));
    if (ev.truncated) kids.push(el('div', { class: 'pknote', text: 'Claude Code sent only part of this diff. Open it in the code view to see the whole file.' }));
    if (!peek.all && hunks.length < (ev.hunks || []).length) {
      kids.push(el('button', { class: 'mini pkall', type: 'button', text: 'Show all ' + ev.hunks.length + ' changes in this edit', on: { click: function (e) { e.stopPropagation(); peek.all = true; renderPeek(); } } }));
    }
    var acts = el('div', { class: 'pkacts' });
    var last = hunks.reduce(function (n, h) { var l = lastChangedLine(h); return Number.isFinite(l) && l > n ? l : n; }, 0);
    acts.appendChild(el('button', { class: 'mini', type: 'button', text: 'Open in code view', on: { click: function (e) {
      e.stopPropagation();
      var at = Number.isFinite(first) && first > 0 ? first : null;
      // Restored since: the file as it is now, without this edit's line marks.
      if (restoredBy(ev) && ev.kind !== 'restore') return openRef({ path: ev.file || ev.relFile, line: null, end: null, note: 'This change was restored, so the file no longer has it. Shown as it is now.' }, owner);
      // The file as this edit left it: after later edits the file now has other line numbers.
      openSelectionCode({ file: ev.relFile || ev.file, relFile: ev.relFile, snapshot: ev.snapshot || null, line: at,
        end: at && last >= at ? last : null, lines: Array.from(changedLines(hunks)), edit: ev, approx: Boolean(f.approx) }, owner);
    } } }));
    if (ev.snapshot) acts.appendChild(el('button', { class: 'mini', type: 'button', text: 'Replay', on: { click: function (e) { e.stopPropagation(); replayEdit(ev); } } }));
    var rstT = restoreTarget(ev);
    var rstText = rstT ? restoreButtonText(ev) : '';
    if (rstText && rstT.off) acts.appendChild(el('button', { class: 'mini pkrst', type: 'button', text: rstText, disabled: 'disabled', title: rstT.off }));
    else if (rstText) acts.appendChild(el('button', { class: 'mini pkrst', type: 'button', text: rstText, 'aria-expanded': peek.confirm === ev ? 'true' : 'false', on: { click: function (e) { e.stopPropagation(); peekRestore(ev); } } }));
    acts.appendChild(el('span', { class: 'pkgap' }));
    acts.appendChild(peek.pinned
      ? el('button', { class: 'icon pkx', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close' }, icon('close'))
      : el('span', { class: 'pkhint', text: 'Click to keep open' }));
    // On top, so the buttons are never below a long diff.
    kids[2] = acts;
    // The Restore question is drawn with the card, so it stays when the card is drawn again.
    if (peek.confirm && peek.confirm !== ev) peek.confirm = null;
    if (peek.confirm === ev) {
      var box = restoreQuestion(ev, function (ok) {
        peek.confirm = null;
        if (ok) hidePeek(true);
        else renderPeek();
      });
      if (box) kids.splice(3, 0, box);
      else peek.confirm = null;
    }
    peekCard.replaceChildren.apply(peekCard, kids);
    peekCard.setAttribute('data-size', state.size);
    var x = peekCard.querySelector('.pkx');
    if (x) x.addEventListener('click', function (e) { e.stopPropagation(); hidePeek(true); });
    placePeek();
  }
  // Restore on the hover card: keeps the card open and asks first (the question is drawn by renderPeek).
  function peekRestore(ev) {
    peek.confirm = peek.confirm === ev ? null : ev;
    if (!peek.pinned) pinPeek(true);
    else renderPeek();
  }
  // Beside the part it explains (right, left, below, then above), always fully on screen and never
  // under the code view.
  function placePeek() {
    var f = peek.entries[peek.i];
    if (!f) return;
    var r = peek.anchor ? peek.anchor.getBoundingClientRect() : f.ghost ? ghostRect(f.ghost) : f.el && f.el.isConnected ? f.el.getBoundingClientRect() : null;
    if (!r) return hidePeek(true);
    if (f.el) {
      peekOutline.style.left = (r.left - 3) + 'px';
      peekOutline.style.top = (r.top - 3) + 'px';
      peekOutline.style.width = (r.width + 6) + 'px';
      peekOutline.style.height = (r.height + 6) + 'px';
      peekOutline.classList.add('on');
    } else peekOutline.classList.remove('on');
    var right = window.innerWidth;
    if (dockState.open && !pop.dock) right = Math.min(right, dock.getBoundingClientRect().left);
    var w = peekCard.offsetWidth;
    var h = peekCard.offsetHeight;
    var gap = 10;
    var m = 8;
    var left;
    var top;
    if (r.left + r.width + gap + w <= right - m) {
      left = r.left + r.width + gap;
      top = r.top;
    } else if (r.left - gap - w >= m) {
      left = r.left - gap - w;
      top = r.top;
    } else {
      left = r.left;
      top = r.top + r.height + gap + h <= window.innerHeight - m ? r.top + r.height + gap : r.top - gap - h;
    }
    left = Math.max(m, Math.min(left, right - w - m));
    top = Math.max(m, Math.min(top, window.innerHeight - h - m));
    peekCard.style.left = left + 'px';
    peekCard.style.top = top + 'px';
  }
  // A change with no part of its own on the page (a backend route): the card opens from a button.
  function peekFromButton(ev, button) {
    showPeek([{ ev: ev, approx: false, el: null }], 'button:' + editKey(ev), button);
    pinPeek(true);
  }

  document.addEventListener('mousemove', onPeekMove, { passive: true, capture: true });
  document.addEventListener('scroll', function () { if (peek.key) placePeek(); }, { passive: true, capture: true });
  window.addEventListener('resize', function () { if (peek.key) placePeek(); });
  peekCard.addEventListener('click', function () { if (!peek.pinned) pinPeek(true); });
  peekCard.addEventListener('mouseleave', function () { if (!peek.pinned) peekLater(null); });
  document.addEventListener('pointerdown', function (e) {
    if (!peek.pinned || (e.composedPath && e.composedPath().indexOf(peekCard) >= 0)) return;
    hidePeek(true);
  }, true);
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !peek.key) return;
    e.preventDefault();
    hidePeek(true);
  }, true);

  // A page move that reloaded the page: finish it here.
  (function resumeTask() {
    var stored = readJsonStore('sessionStorage', PAGE_TASK_KEY);
    storeTask(null);
    if (!stored || !stored.task || !(finiteNum(stored.until) > Date.now())) return;
    var task = stored.task;
    // Its number now: a pause or a newer page move before it runs raises pageGo.seq and stops it.
    var token = ++pageGo.seq;
    setTimeout(function () {
      if (token !== pageGo.seq || pageGo.paused) return;
      var place = knownPlace(task.file) || { route: routeNow(), via: null };
      afterRoute(task, place, taskFinder(task), token);
    }, 400);
  })();
  learnSoon();
  setTimeout(staticRoutes, 1500);
  renderFollow();


  // A file named in a reply was clicked: open it (at its lines) in the code view. Folders and
  // ambiguous names open a picker; anything the server won't show explains why.
  var picker = el('div', { class: 'palette picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Choose a file' });
  var pickerFrom = null; // focus returns here when the picker closes
  function closePicker() {
    picker.classList.remove('on');
    if (pickerFrom && pickerFrom.isConnected) pickerFrom.focus();
    pickerFrom = null;
  }
  panel.appendChild(picker);
  picker.addEventListener('mousedown', function (e) { if (e.target === picker) closePicker(); });
  picker.addEventListener('keydown', function (e) {
    e.stopPropagation();
    if (e.key === 'Escape') closePicker();
  });
  function showPicker(title, rows) {
    var list = el('ul', { class: 'plist' });
    rows.forEach(function (r) {
      var li = el('li', { class: 'pitem', role: 'option', tabindex: '0' },
        el('div', { class: 'pt' }, el('div', null, el('span', { class: 'pn', text: r.label })), r.sub ? el('div', { class: 'pd', text: r.sub }) : null));
      var go = function () { picker.classList.remove('on'); r.open(); };
      li.addEventListener('click', go);
      li.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
      list.appendChild(li);
    });
    if (!rows.length) list.appendChild(el('li', { class: 'pempty', text: 'This folder is empty.' }));
    picker.replaceChildren(el('div', { class: 'pbox' }, el('div', { class: 'pin' }, el('b', { text: '›' }), el('span', { text: title })), list,
      el('div', { class: 'pfoot' }, el('span', null, el('kbd', { text: 'Esc' }), document.createTextNode(' close')))));
    if (state.panel !== 'open') setPanel('open');
    if (!picker.classList.contains('on')) pickerFrom = root.activeElement || document.activeElement;
    picker.classList.add('on');
    var first = list.querySelector('.pitem');
    if (first) first.focus();
  }
  // ref.auto: Claude's own move (following an agent), which respects a closed code view; anything
  // else is you asking to see it. ref.followReq: the Follow request it answers (see openAt); a
  // newer one, or a change of Follow, since it was asked for: the answer is not shown.
  function openRef(ref, owner) {
    if (!ref.auto) showCodeView();
    var q = new URLSearchParams({ ref: ref.path, page: PAGE_ID });
    var stale = function () { return ref.followReq !== undefined && ref.followReq !== follow.req; };
    fetch(SERVER + '/file?' + q.toString()).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, json: json }; });
    }).then(function (r) {
      if (stale()) return undefined;
      var j = r.json || {};
      if (!r.ok) return showToast(j.error || 'Could not open ' + ref.path);
      if (j.kind === 'dir') {
        return showPicker(j.rel + '/', (j.entries || []).map(function (f) {
          return { label: f.name + (f.dir ? '/' : ''), sub: f.dir ? 'Folder' : '', open: function () { openRef({ path: f.rel, line: null, end: null }); } };
        }));
      }
      if (j.kind === 'choices') {
        return showPicker('Which ' + baseName(ref.path) + '?', (j.matches || []).map(function (m) {
          return { label: m, open: function () { openRef({ path: m, line: ref.line, end: ref.end, part: ref.part }); } };
        }));
      }
      if (j.kind !== 'file' || !j.snapshot) return showToast('Could not open ' + ref.path);
      if (ref.auto) setDock(true, false);
      else showCodeView();
      enqueue({ ev: { type: 'code', snapshot: snapRef(j.snapshot), file: j.file, relFile: j.relFile, line: ref.line, endLine: ref.end, part: Boolean(ref.part), note: ref.note || null }, owner: owner || null,
        auto: Boolean(ref.auto && !ref.picked), followReq: ref.followReq });
    }).catch(function (err) {
      if (!stale()) showToast('Could not open ' + ref.path + ': ' + err.message);
    });
  }

  function onChange(ev) {
    // A restore is your action, not one of Claude's changes.
    if (ev.kind !== 'restore') state.changes++;
    addEditCard(ev, true);
    // An edit in a subagent's own copy isn't on this page until it is merged, and one in a copy of
    // a paired computer's project never is: nothing to highlight.
    if (ev.copy || ev.task || ev.remote) return;
    if (ev.intent && !ev.autoIntent && ev.tool !== 'Merge' && ev.tool !== 'Apply') setNow(ev.intent);
    // Mutations count from when Claude announced the edit (HMR can arrive before this event).
    var since = state.pendingAt && Date.now() - state.pendingAt < 15000 ? state.pendingAt : Date.now() - 1500;
    state.pendingAt = 0;
    if (ev.kind === 'restore' && ev.fileKind === 'backend') return;
    if (ev.kind === 'backend') {
      var hits = pagePathsFor(ev.routes);
      highlightBackend(ev, false);
      if (hits.length && OPTS.reload !== 'off') reloadForBackend(ev, hits);
      return;
    }
    applyWithoutHmr(ev).then(function () {
      setTimeout(function () {
        var changed = changedElementsSince(since);
        var shown = changed.length ? highlight(changed, { label: labelFor(ev), ev: ev, color: ev.kind === 'restore' ? RESTORE_COLOR : null }) : 0;
        if (!shown) highlightFromHints(ev, false);
        peekGhosts(ev, since);
      }, OPTS.settle);
    });
  }

  // ---------- a subagent's own copy (git worktree): what it changed, Merge and Remove ----------
  var copyCards = Object.create(null);
  var COPY_STATES = {
    held: 'Not merged',
    clean: 'Ready',
    merged: 'Merges with your edits',
    conflict: 'Both changed',
    same: 'Already in your project',
  };
  function copyKeyOf(ev) {
    return String(ev.cwd || '') + '\u0000' + String(ev.name || '');
  }
  function addCopyCard(ev, fresh) {
    var key = copyKeyOf(ev);
    var old = copyCards[key];
    if (old && old.item.parentNode) old.item.remove();
    var item = el('li', { class: 'k-copy' + (fresh ? ' fresh' : '') });
    item.setAttribute('data-owner', ownerOf(ev));
    copyCards[key] = { item: item, ev: ev, st: ev };
    renderCopy(key);
    append(item, fresh);
    if (!fresh) refreshCopy(key);
  }
  function copyWho(ev) {
    var k = ownerOf(ev);
    return ev.agentName || ownerLabel(k);
  }
  function renderCopy(key, busy) {
    var c = copyCards[key];
    if (!c) return;
    var ev = c.ev;
    var st = c.st || {};
    var item = c.item;
    item.replaceChildren();
    item.appendChild(el('div', { class: 'row' },
      el('span', { class: 'tool', text: 'copy' }),
      el('span', { class: 'ctitle', text: copyWho(ev) + ' finished in its own copy' }),
      el('span', { class: 'ago', 'data-ts': String(ev.ts), text: timeAgo(ev.ts) })));
    if (c.checkError) item.appendChild(el('div', { class: 'why', text: 'Could not check this copy just now (' + c.checkError + '), so this may be older than the current state.' }));
    if (st.removed || st.gone) {
      item.classList.add('done');
      item.appendChild(el('div', { class: 'why', text: st.gone ? 'This copy was deleted.' : 'Copy removed.' }));
      return;
    }
    var files = Array.isArray(st.files) ? st.files : [];
    var ready = posInt(st.ready);
    var conflicts = posInt(st.conflicts);
    var left = ready + conflicts;
    // Counts too large to be real are not shown, and the copy may still have changes (Sol L8).
    var known = Number.isSafeInteger(left);
    if (!known) ready = conflicts = 0;
    item.classList.toggle('done', known && !left);
    var heldFiles = files.filter(function (f) { return f.state === 'held'; });
    var held = heldFiles.length;
    var mergeable = files.length - held;
    item.appendChild(el('div', { class: 'why', text: !files.length ? 'It changed nothing.' :
      !known ? 'Could not read how many files are left to merge.' :
      !left ? (!mergeable ? 'Nothing to merge.' : held ? 'Its other changes are in your project now.' : 'Everything it changed is in your project now.') :
      (ready ? ready + (ready === 1 ? ' file is' : ' files are') + ' ready to merge' : 'Nothing can merge automatically') +
      (conflicts ? '. ' + conflicts + (conflicts === 1 ? ' file needs' : ' files need') + ' your choice: you both changed the same lines.' : '.') }));
    if (held) item.appendChild(el('div', { class: 'why', text: held + (held === 1 ? ' file is' : ' files are') + ' Claude Code configuration or keys (.claude, .mcp.json, .env, key files). They never merge automatically. If you want them, copy them yourself from the copy.' }));
    var list = el('ul', { class: 'cfiles' });
    files.forEach(function (f) {
      var what = f.state === 'clean' ? (f.added ? 'New' : f.deleted ? 'Deleted' : 'Changed') : COPY_STATES[f.state] || f.state;
      var row = el('li', { class: 'cf ' + f.state },
        el('span', { class: 'cst', text: what }),
        pathText('span', 'file', f.relFile));
      if (f.state === 'conflict' && !f.why) {
        row.appendChild(el('button', { class: 'mini', type: 'button', title: 'Replace your version of this file with the copy\'s. Restore on the edit card puts yours back.', text: 'Use its version', disabled: busy || null,
          on: { click: function () { mergeCopy(key, [f.relFile]); } } }));
      } else if (f.why) {
        row.appendChild(el('span', { class: 'cwhy', text: f.why }));
      }
      list.appendChild(row);
    });
    if (posInt(st.more)) list.appendChild(el('li', { class: 'cf more', text: '+' + posInt(st.more) + ' more' }));
    if (files.length) item.appendChild(list);
    var acts = el('div', { class: 'pacts' });
    if (ready) {
      acts.appendChild(el('button', { class: 'mini allow', type: 'button', disabled: busy || null, text: busy ? 'Merging…' : 'Merge ' + ready + (ready === 1 ? ' file' : ' files'),
        title: 'Add these changes to your project. Each file shows as an edit you can Restore.',
        on: { click: function () { mergeCopy(key, []); } } }));
    }
    acts.appendChild(el('button', { class: 'mini', type: 'button', disabled: busy || null, text: 'Remove copy',
      on: { click: function () { confirmRemoveCopy(key, !known || left > 0, heldFiles); } } }));
    item.appendChild(acts);
  }
  function copyQuery(c) {
    return new URLSearchParams({ page: PAGE_ID, root: String(c.ev.cwd || ''), name: String(c.ev.name || '') }).toString();
  }
  function refreshCopy(key) {
    var c = copyCards[key];
    if (!c) return;
    fetch(SERVER + '/copy?' + copyQuery(c)).then(function (res) {
      return res.json().then(function (j) {
        c.st = res.ok ? j : { gone: res.status === 404 };
        c.checkError = null;
        renderCopy(key);
      });
    }).catch(function (err) {
      if (!(err instanceof Error)) throw err;
      // EditLens did not respond (or sent an invalid response): the card says its state may be old.
      c.checkError = err.message;
      renderCopy(key);
    });
  }
  function mergeCopy(key, take) {
    var c = copyCards[key];
    if (!c) return;
    renderCopy(key, true);
    postJson('/copy/merge', { page: PAGE_ID, root: c.ev.cwd, name: c.ev.name, take: take }).then(function (r) {
      var n = r && Array.isArray(r.applied) ? r.applied.length : 0;
      showToast(n ? 'Merged ' + n + (n === 1 ? ' file' : ' files') + ' from ' + copyWho(c.ev) + '.' : 'Nothing new to merge.');
      refreshCopy(key);
    }).catch(function (err) {
      // The request failed, or showing its response did: the buttons appear again in both cases.
      showToast('Could not merge: ' + err.message, 6000);
      renderCopy(key);
    });
  }
  // held: the configuration or key files that never merge; named, as removing loses them (Sol L3).
  function confirmRemoveCopy(key, left, held) {
    var c = copyCards[key];
    if (!c) return;
    var old = c.item.querySelector('.rconf');
    if (old) return old.remove();
    var names = (held || []).slice(0, 3).map(function (f) { return String(f.relFile || ''); }).join(', ') +
      ((held || []).length > 3 ? ' and ' + (held.length - 3) + ' more' : '');
    var q = left ? 'Remove this copy and its branch? Its changes that aren\'t merged are lost.'
      : !(held || []).length ? 'Remove this copy and its branch? Everything it changed is in your project.'
        : 'Remove this copy and its branch? Its other changes are in your project, but ' + held.length +
          (held.length === 1 ? ' configuration or key file was' : ' configuration or key files were') + ' never merged and will be lost: ' + names + '.';
    var box = el('div', { class: 'rconf', role: 'group' }, el('div', { class: 'rq', text: q }));
    var acts = el('div', { class: 'pacts' });
    var go = el('button', { class: 'mini ' + (left ? 'deny' : 'allow'), type: 'button', text: 'Remove', on: { click: function () {
      go.disabled = true;
      postJson('/copy/remove', { page: PAGE_ID, root: c.ev.cwd, name: c.ev.name }).then(function () {
        c.st = { removed: true };
        renderCopy(key);
      }, function (err) {
        go.disabled = false;
        showToast('Could not remove the copy: ' + err.message, 6000);
      });
    } } });
    acts.appendChild(go);
    var cancel = el('button', { class: 'mini', type: 'button', text: 'Cancel', on: { click: function () { box.remove(); } } });
    acts.appendChild(cancel);
    box.appendChild(acts);
    c.item.appendChild(box);
    focusCancel(box, cancel);
  }
  function onCopyState(ev) {
    var key = copyKeyOf(ev);
    var c = copyCards[key];
    if (!c) return;
    c.st = ev;
    renderCopy(key);
  }

  // Task cards (here and from a paired computer) are drawn in 27-taskcard.js.

  // Claude on a paired computer edits outside the project this page is paired with: shown once per
  // folder, so it is clear why its edits don't appear here.
  // Notices shown already, by key: past SEEN_MAX the oldest key is forgotten (Sol L2).
  var SEEN_MAX = 200;
  function seenBefore(seen, key) {
    if (seen.has(key)) return true;
    seen.add(key);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
    return false;
  }
  var outsideSeen = new Set();
  function onRemoteOutside(ev) {
    var where = String(ev.where || '');
    var who = String(ev.computer || 'Paired computer');
    if (!where || seenBefore(outsideSeen, who + '\u0000' + where)) return;
    var item = el('li', { class: 'k-missed' });
    item.appendChild(el('div', { class: 'row' }, el('span', { class: 'tool', text: '◆ ' + who }), el('span', { class: 'ctitle', text: 'Claude on ◆ ' + who + ' is working in another folder' })));
    item.appendChild(el('div', { class: 'why', text: 'It edits files in ' + where + (ev.paired ? ', outside the project this computer is paired with (' + ev.paired + ')' : '') +
      '. Those edits stay there and are not shown here. To see them, pair from that folder: run /editlens pair in Claude Code there.' }));
    append(item, true);
  }

  // A paired computer removed edits before this computer got them (it was away too long): how many.
  var missedSeen = new Set();
  function onRemoteMissed(ev) {
    if (!ev.text || seenBefore(missedSeen, String(ev.sessionId || ''))) return;
    var who = String(ev.computer || 'Paired computer');
    var item = el('li', { class: 'k-missed' });
    item.appendChild(el('div', { class: 'row' }, el('span', { class: 'tool', text: '◆ ' + who }), el('span', { class: 'ctitle', text: 'Edits from ◆ ' + who + ' not kept' })));
    item.appendChild(el('div', { class: 'why', text: String(ev.text) }));
    append(item, true);
  }

  // ---------- permissions button: every question that needs your answer ----------
  // Page control and paired-computer tasks: Deny here, Allow in the EditLens window. Claude Code's own
  // questions are only listed: the page is the app Claude edits, so it must never approve its requests.
  // Shown with a count only while something waits; highlighted unless its setting is off or motion reduced.
  var askItems = Object.create(null); // Claude Code's own questions, by id
  var pq = { open: false, timer: 0 };
  var pqCount = el('span', { class: 'pqn' });
  var pqButton = el('button', { class: 'pqb', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, icon('shield'), pqCount);
  var pqClose = el('button', { type: 'button', title: 'Close', 'aria-label': 'Close' }, icon('close'));
  var pqTitle = el('b');
  var pqItems = el('div', { class: 'pqs' });
  var pqList = el('div', { class: 'pql', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Permission questions' }, el('div', { class: 'pqh' }, pqTitle, pqClose), pqItems);
  pqButton.addEventListener('click', function () { setPqOpen(!pq.open); });
  pqClose.addEventListener('click', function () {
    setPqOpen(false);
    pqButton.focus();
  });
  pqList.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    setPqOpen(false);
    pqButton.focus();
  });
  window.addEventListener('pointerdown', function (e) {
    if (!pq.open) return;
    var path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(pqList) < 0 && path.indexOf(pqButton) < 0) setPqOpen(false);
  }, true);
  window.addEventListener('resize', function () { pqSoon(); });

  function pqSoon() {
    if (!pq) return; // also called while the page script is still being built
    // Not drawn while the tab is hidden (no animation frames there), so the title is set now.
    renderTabTitle();
    if (pq.timer) return;
    pq.timer = requestAnimationFrame(function () {
      pq.timer = 0;
      renderPq();
    });
  }
  function onAsk(ev) {
    if (!ev.id) return;
    if (ev.type === 'ask') askItems[ev.id] = ev;
    else delete askItems[ev.id];
    pqSoon();
  }
  // Oldest first: { key, kind: 'drive' | 'task' | 'ask', p, ts, who, owner, card, task }
  function pqQuestions() {
    var out = [];
    var via = state.via ? ' · ◆ ' + state.via : '';
    Object.keys(permCards).forEach(function (id) {
      var c = permCards[id];
      if (!c.p) return;
      var p = c.p;
      out.push({ key: 'p:' + id, kind: 'drive', p: p, ts: finiteNum(p.ts), owner: c.owner, card: c.card,
        who: '✦ ' + (p.agentKey && agents[p.agentKey] ? ownerLabel(p.agentKey) : p.agentId ? 'A subagent' : 'Claude') + ' in page control' + via });
    });
    Object.keys(taskCards).forEach(function (tid) {
      var c = taskCards[tid];
      var ev = c.ev || {};
      (Array.isArray(ev.permissions) ? ev.permissions : []).forEach(function (p) {
        out.push({ key: 't:' + tid + ':' + p.id, kind: 'task', task: tid, p: p, ts: finiteNum(p.ts) || finiteNum(ev.ts), card: c.item,
          who: 'Task from ◆ ' + (ev.by || 'a paired computer') });
      });
    });
    Object.keys(askItems).forEach(function (id) {
      var q = askItems[id];
      var owner = q.agentId ? ownerOf(q) : 'main';
      out.push({ key: 'a:' + id, kind: 'ask', p: q, ts: finiteNum(q.ts), owner: owner,
        who: '✦ ' + (q.agentId ? ownerLabel(owner) : 'Claude') + ' in Claude Code' + via });
    });
    return out.sort(function (a, b) { return a.ts - b.ts; });
  }
  function renderPq() {
    var list = pqQuestions();
    var n = list.length;
    var glow = !(settings.values && settings.values.permission_glow === false);
    pqButton.classList.toggle('on', n > 0);
    pqButton.classList.toggle('glow', n > 0 && glow);
    pqButton.classList.toggle('still', n > 0 && !glow);
    pqCount.textContent = n > 99 ? '99+' : String(n);
    var label = n === 1 ? '1 permission question needs your answer' : n + ' permission questions need your answer';
    pqButton.title = label;
    pqButton.setAttribute('aria-label', label);
    // The same count in the code view's header; a click shows the questions (never answers them).
    dockPqBadge.hidden = !n;
    dockPqBadge.querySelector('.n').textContent = pqCount.textContent;
    dockPqBadge.title = label;
    dockPqBadge.setAttribute('aria-label', label);
    if (!n && pq.open) setPqOpen(false);
    else if (pq.open) renderPqList(list);
    placePq();
  }
  function setPqOpen(on) {
    pq.open = Boolean(on);
    pqList.classList.toggle('on', pq.open);
    pqButton.setAttribute('aria-expanded', String(pq.open));
    if (!pq.open) {
      if (pqList.contains(root.activeElement)) pqButton.focus(); // back where it was opened from
      return;
    }
    renderPqList(pqQuestions());
    placePq();
    pqClose.focus(); // not an answer: Enter must never allow by accident
  }
  function renderPqList(list) {
    pqTitle.textContent = list.length === 1 ? '1 question needs your answer' : list.length + ' questions need your answer';
    if (!list.length) return pqItems.replaceChildren(el('div', { class: 'pqe', text: 'No questions need your answer.' }));
    pqItems.replaceChildren.apply(pqItems, list.map(pqItem));
  }
  function pqItem(q) {
    var p = q.p;
    var dot = el('i');
    if (q.owner) dot.style.setProperty('--c', ownerColor(q.owner));
    var box = el('div', { class: 'pqi', role: 'group', 'aria-label': q.who },
      el('div', { class: 'pqw' }, dot, el('span', { class: 'who', text: q.who }), el('span', { class: 'ago', 'data-ts': String(q.ts), text: timeAgo(q.ts) })),
      el('div', { class: 'pqt', text: p.title || 'Use ' + (p.tool || 'a tool') }));
    if (p.warning) box.appendChild(el('div', { class: 'enote warn', text: p.warning }));
    if (p.detail) box.appendChild(el('div', { class: 'pqd', text: p.detail }));
    var acts;
    if (q.kind === 'ask') {
      box.appendChild(el('div', { class: 'pqx', text: 'Answer this in Claude Code. A page can\'t answer it, so Claude can\'t approve its own request.' }));
      acts = el('div', { class: 'pacts' });
    } else {
      acts = answerActions(q.kind === 'task' ? 't:' + q.task + ':' + p.id : 'p:' + p.id, p.canAlways, q.kind === 'task'
        ? function () { return postJson('/task/answer', { page: PAGE_ID, task: q.task, id: p.id, decision: 'deny' }); }
        : drive.key ? function () { return driveRequest('/drive/permission', { id: p.id, decision: 'deny' }); } : null);
    }
    if (q.card && q.card.isConnected) {
      acts.appendChild(el('button', { class: 'mini', type: 'button', text: 'Show in panel', on: { click: function () {
        setPqOpen(false);
        if (state.panel !== 'open') setPanel('open');
        q.card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } } }));
    }
    if (acts.childNodes.length) box.appendChild(acts);
    return box;
  }
  // A free spot on the page (top right first), not covering the panel, the pill, the Agents switcher,
  // the selection bar and its list; the list opens toward the middle of the window.
  function placePq() {
    if (!pqButton.classList.contains('on')) return;
    var a = pageArea();
    var S = 44;
    var M = 16;
    var busy = [panelOnPage() ? panel : null, pill, switcher, selBar, changesList, pickBar].filter(Boolean).map(function (n) {
      return n.getBoundingClientRect();
    }).filter(function (r) { return r.width > 0 && r.height > 0; });
    var free = function (x, y) {
      return busy.every(function (r) { return x + S + 8 <= r.left || x - 8 >= r.right || y + S + 8 <= r.top || y - 8 >= r.bottom; });
    };
    var spots = [];
    for (var y = a.top + M; y + S <= a.bottom - M; y += 56) spots.push([a.right - M - S, y]);
    for (var y2 = a.top + M; y2 + S <= a.bottom - M; y2 += 56) spots.push([a.left + M, y2]);
    var spot = spots.filter(function (s) { return free(s[0], s[1]); })[0] || [a.right - M - S, a.top + M];
    pqButton.style.left = Math.round(spot[0]) + 'px';
    pqButton.style.top = Math.round(spot[1]) + 'px';
    if (!pq.open) return;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var w = Math.min(380, vw - 24);
    var left = spot[0] + S / 2 > vw / 2 ? spot[0] + S - w : spot[0];
    left = Math.max(12, Math.min(left, vw - w - 12));
    pqList.style.left = Math.round(left) + 'px';
    if (spot[1] + S / 2 < vh / 2) {
      pqList.style.top = Math.round(spot[1] + S + 8) + 'px';
      pqList.style.bottom = 'auto';
      pqList.style.maxHeight = Math.round(Math.max(120, vh - spot[1] - S - 20)) + 'px';
    } else {
      pqList.style.top = 'auto';
      pqList.style.bottom = Math.round(vh - spot[1] + 8) + 'px';
      pqList.style.maxHeight = Math.round(Math.max(120, spot[1] - 20)) + 'px';
    }
  }

  function handle(ev) {
    if (!ev || typeof ev !== 'object') return;
    var seq = Number(ev.seq);
    if (Number.isFinite(seq) && seq > 0) {
      if (seq <= state.lastSeq) return;
      state.lastSeq = seq;
    }
    if (ev.type === 'hello') {
      // A restarted server numbers its events from 1 again: forget the old position.
      if (typeof ev.instance === 'string' && state.instance && ev.instance !== state.instance) {
        state.lastSeq = 0;
        state.instance = ev.instance;
        markRestarted();
        oldEditsOff();
        forgetSnapshots();
      }
      if (typeof ev.instance === 'string') state.instance = ev.instance;
      setVia(ev.via && ev.via.name);
      state.hello = true;
      sessionsHello();
      renderNoRoot(ev.projects);
      return checkVersion(ev.version, ev.via);
    }
    // Which start of the server sent it (not enumerable: never sent back).
    if (state.instance) Object.defineProperty(ev, 'inst', { value: state.instance });
    if (ev.snapshot) ev.snapshot = snapRef(ev.snapshot);
    if (!inScope(ev)) return;
    if (ev.replay) return replay(ev);
    switch (ev.type) {
      case 'prompt':
        dockForNewRequest(ev);
        tabTitleDone(false);
        mainInfo.start = Date.now();
        mainInfo.end = 0;
        state.working = true;
        state.changes = 0;
        state.statusLabel = 'Working';
        setNow('Thinking…');
        refreshStatus();
        break;
      case 'pending':
        state.working = true;
        state.pendingAt = Date.now();
        state.statusLabel = 'Editing ' + baseName(ev.relFile || ev.file);
        setNow(ev.intent || 'Editing ' + (ev.relFile || ev.file) + '…');
        refreshStatus();
        break;
      case 'change':
        // A merge from the panel is your action, and a paired computer's applied work is done:
        // neither is Claude working.
        if (ev.tool !== 'Merge' && ev.tool !== 'Apply' && ev.kind !== 'restore' && !ev.remote) {
          state.working = true;
          state.statusLabel = 'Working';
          refreshStatus();
        }
        onChange(ev);
        codeForEdit(ev, true);
        markSeen(ev.seq);
        break;
      case 'code':
        codeForView(ev, true);
        break;
      case 'chat':
        handleChat(ev);
        break;
      case 'page-message':
        dockForNewRequest(ev);
        addPageMessage(ev);
        break;
      case 'usage':
        setUsage(ev);
        break;
      case 'drive-error':
        if (!drive.active) {
          drive.lastError = String(ev.error || '');
          renderAccess();
        }
        break;
      case 'copy':
        addCopyCard(ev, true);
        break;
      case 'copy-state':
        onCopyState(ev);
        break;
      case 'task':
        onTask(ev);
        pqSoon();
        if (sessionsSheet.open) sessionsSoon();
        break;
      case 'task-root':
        onTaskRoot(ev);
        break;
      case 'task-remote':
        onRemoteTask(ev);
        if (sessionsSheet.open) sessionsSoon();
        break;
      case 'task-applied':
        onTaskApplied(ev);
        break;
      case 'task-slots':
        onTaskSlots(ev);
        break;
      case 'sessions-changed':
        // A name changed, or page control started or ended: the names on chips and the open list.
        sessionsSoon();
        break;
      case 'follow-agent':
        // Follow picked in the terminal's agents list; an old one (a reconnect) is not acted on.
        if (Date.now() - finiteNum(ev.ts) < 15000) onFollowAgent(ev);
        break;
      case 'remote-outside':
        onRemoteOutside(ev);
        break;
      case 'remote-missed':
        onRemoteMissed(ev);
        break;
      case 'task-notice':
        onTaskNotice(ev);
        break;
      case 'ask':
      case 'ask-done':
        onAsk(ev);
        break;
      case 'pair-notice':
        // "Paired with laptop-1": shown once, when it happens.
        if (ev.text && Date.now() - finiteNum(ev.at) < 15000) showToast(String(ev.text), 8000);
        break;
      case 'setup':
        // Page control's one-time download: shown while it runs (a replay of an old one isn't).
        if (ev.text && Date.now() - finiteNum(ev.ts) < 15 * 60000) showToast(ev.text, 15 * 60000);
        else if (!ev.text && setupShown) toast.classList.remove('on');
        setupShown = Boolean(ev.text);
        break;
      case 'commands':
        // In page control, the palette lists what that session supports.
        normalCommands = ev;
        if (!(driving() && drive.commands)) setCommands(ev);
        break;
      case 'board':
        boardEntry(ev);
        break;
      case 'drive-grant':
        onDriveGrant(ev);
        break;
      case 'drive-status':
        onDriveStatus(ev);
        onDriveEffort(ev);
        break;
      case 'drive':
        onDrive(ev);
        onDriveEffort(ev);
        break;
      case 'drive-effort':
        onDriveEffort(ev);
        break;
      case 'effort':
        onTerminalEffort(ev);
        break;
      case 'update-waiting':
        onUpdateWaiting(ev);
        break;
      case 'drive-note':
        // Page control continued after the Claude program was replaced.
        if (ev.text) showToast(String(ev.text), 12000);
        break;
      case 'drive-signin':
        onSignIn(ev);
        break;
      case 'drive-mode':
        onDriveMode(ev);
        break;
      case 'mode':
        onHookMode(ev);
        break;
      case 'settings':
        onSettings(ev);
        // Sent when the page connects: the names given to sessions, for the chips.
        sessionsSoon();
        break;
      case 'drive-commands':
        drive.commands = { commands: (ev.commands || []).map(function (c) { return { name: c.name, description: c.description, argumentHint: c.argumentHint, runnable: true, source: 'Claude' }; }) };
        if (driving()) setCommands(drive.commands);
        break;
      case 'permission':
        addPermission(ev);
        break;
      case 'permission-done':
        settlePermission(ev.id, ev.decision);
        break;
      case 'drive-message':
        dockForNewRequest(ev);
        addDriveMessage(ev);
        break;
      case 'board-sync':
        boardSync(ev);
        break;
      case 'board-clear':
        boardClear(ev);
        break;
      case 'state':
        setClaude(ev);
        if (ev.state === 'stopped') setNow('Stopped.');
        break;
      case 'cancelled':
        markCancelled(ev.ids, ev.reason);
        break;
      case 'delivered':
        markDelivered(ev.ids, ev.via);
        if (ev.via === 'listen' || ev.via === 'stop') {
          state.working = true;
          state.statusLabel = 'Working';
          setNow('Reading your message…');
          refreshStatus();
        }
        break;
      case 'listen':
        state.listening = Boolean(ev.active);
        state.listenUntil = finiteNum(ev.until);
        if (state.listening) state.working = false;
        refreshStatus();
        break;
      case 'point': {
        var results = showPoint(ev, true);
        addPointCard(ev, results);
        break;
      }
      case 'point-clear':
        clearPoints();
        break;
      case 'idle':
        if (mainInfo.start && !mainInfo.end) mainInfo.end = Date.now();
        state.working = false;
        setNow(state.changes ? 'Done: ' + state.changes + ' change' + (state.changes === 1 ? '' : 's') + '.' : '');
        if (state.changes) showToast('Claude finished · ' + state.changes + ' change' + (state.changes === 1 ? '' : 's'));
        refreshStatus();
        tabTitleDone(true);
        break;
      default:
        break;
    }
  }

  // The plugin was updated while this page kept the old script: offer a reload once.
  var updateShown = false;
  // hello: { version, via: { name, peerVersion } }. Page script older than its server: a persistent
  // Update ready bar (and one feed item). A paired page: the two computers' versions when they differ.
  function checkVersion(serverVersion, via) {
    var peer = via && typeof via.peerVersion === 'string' ? via.peerVersion.slice(0, 20) : '';
    var name = via && via.name ? String(via.name).slice(0, 24) : '';
    setUpdate('pair', peer && serverVersion && peer !== serverVersion
      ? name + ' runs ' + PANEL_NAME + ' ' + serverVersion + ' and this computer runs ' + peer + '. Update the older one: /plugin update editlens@editlens there, then /editlens restart.'
      : null);
    if (!serverVersion || serverVersion === VERSION) return setUpdate('page', null);
    setUpdate('page', PANEL_NAME + ' ' + serverVersion + ' is running; this page still has ' + VERSION + '. Reload to use it.', true);
    if (updateShown) return;
    updateShown = true;
    append(el('li', { class: 'k-update' },
      el('span', { text: PANEL_NAME + ' was updated to ' + serverVersion + '. Reload this page to use the new version.' }),
      el('button', { class: 'mini', type: 'button', text: 'Reload', on: { click: function () { location.reload(); } } })), true);
  }
  // The server says a newer EditLens is installed than the one running (it waits for page control
  // or tasks, or an old server was never replaced).
  function onUpdateWaiting(ev) {
    var installed = typeof ev.installed === 'string' ? ev.installed.slice(0, 20) : '';
    if (!installed || !ev.running) return setUpdate('server', null);
    setUpdate('server', PANEL_NAME + ' ' + installed + ' is installed, but ' + String(ev.running).slice(0, 20) + ' is still running. '
      + (ev.busy ? 'It updates when ' + (ev.busy === 'tasks' ? 'the tasks finish' : 'page control stops, and starts again') + '. To update now, type /editlens restart in Claude Code.' : 'Type /editlens restart in Claude Code to use it.'));
  }

  function handleChat(ev) {
    switch (ev.role) {
      case 'assistant':
        if (!ev.backlog && !ev.replay) {
          state.working = state.working || !state.listening;
          setNow(String(ev.text).split('\n')[0]);
        }
        addAssistant(ev);
        break;
      case 'user':
        // In page control the page already shows what was typed here.
        if (drive.sessionId && ev.sessionId === drive.sessionId && !ev.backlog) break;
        addUser(ev.text, 'terminal', ev.backlog, null, ev.ts);
        break;
      case 'tool':
        mainInfo.tools++;
        swSoon();
        addStep(ev);
        if (ev.file) noteAt('main', { file: ev.file, line: ev.line, end: ev.end, op: ev.op }, !ev.backlog && !ev.replay);
        break;
      case 'agent-start':
        addAgent(ev);
        break;
      case 'agent-step':
        addAgentStep(ev);
        if (ev.kind === 'tool' && ev.file) noteAt(ownerOf(ev), { file: ev.file, line: ev.line, end: ev.end, op: ev.op }, !ev.backlog && !ev.replay);
        break;
      case 'agent-done':
        finishAgent(ev);
        break;
      case 'copy':
        addCopyCard(ev, false);
        break;
      default:
        break;
    }
  }

  // ---------- edits made while this page was closed: a notice with Play ----------
  // The page keeps (in this browser) the newest edit it has shown. Edits in the history sent when it
  // opens that are newer (or, the first time, from the last 30 minutes) were never shown: the
  // notice offers to show them in order in the code view.
  var MISSED_MS = 30 * 60000;
  var missed = { list: [], timer: 0, item: null };
  function seenEdits() {
    var raw = storageGet('localStorage', 'editlens.seenEdits');
    if (!raw) return null;
    try {
      var v = JSON.parse(raw);
      return v && typeof v.instance === 'string' && Number.isFinite(Number(v.seq)) ? v : null;
    } catch (err) {
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }
  function markSeen(seq) {
    if (!state.instance || !(posInt(seq) > 0)) return;
    var s = seenEdits();
    if (s && s.instance === state.instance && Number(s.seq) >= posInt(seq)) return;
    storageSet('localStorage', 'editlens.seenEdits', JSON.stringify({ instance: state.instance, seq: posInt(seq) }));
  }
  function wasMissed(ev) {
    if (!ev.snapshot || !(posInt(ev.seq) > 0)) return false;
    var s = seenEdits();
    if (s && s.instance === state.instance) return posInt(ev.seq) > Number(s.seq);
    var ts = Number(ev.ts);
    return Number.isFinite(ts) && Date.now() - ts < MISSED_MS;
  }
  function missedFrom(ev) {
    return ev.remote && ev.remote.computer ? '◆ ' + ev.remote.computer : 'Claude here';
  }
  function showMissed() {
    missed.timer = 0;
    var list = missed.list.slice(-50);
    missed.list = [];
    if (!list.length) return;
    markSeen(list[list.length - 1].seq);
    var counts = {};
    var order = [];
    list.forEach(function (ev) {
      var k = missedFrom(ev);
      if (!counts[k]) order.push(k);
      counts[k] = (counts[k] || 0) + 1;
    });
    var n = list.length;
    var title = order.length === 1
      ? n + (n === 1 ? ' edit' : ' edits') + ' from ' + order[0] + ' while this page was closed'
      : n + ' edits while this page was closed (' + order.map(function (k) { return counts[k] + ' from ' + k; }).join(', ') + ')';
    if (missed.item && missed.item.isConnected) missed.item.remove();
    var item = el('li', { class: 'k-missed' });
    var play = el('button', { class: 'mini play', type: 'button', text: 'Play', title: 'Play them in order in the code view', on: { click: function () {
      showCodeView();
      list.forEach(function (ev) { enqueue({ ev: ev, owner: ownerOf(ev) }); });
      item.remove();
      noteMissed(null);
    } } });
    var dismiss = el('button', { class: 'mini', type: 'button', text: 'Close', on: { click: function () { item.remove(); noteMissed(null); } } });
    item.appendChild(el('div', { class: 'row' }, el('span', { class: 'tool', text: 'missed' }), el('span', { class: 'ctitle', text: title })));
    item.appendChild(el('div', { class: 'why', text: list.map(function (ev) { return String(ev.relFile || ev.file || '').replace(/^◆ [^:]*: /, ''); }).filter(function (f, i, a) { return f && a.indexOf(f) === i; }).slice(0, 6).join(', ') }));
    item.appendChild(el('div', { class: 'pacts' }, play, dismiss));
    missed.item = item;
    append(item, false);
    noteMissed(title, list, item); // also at the top of the code view's Edits list
  }

  // History sent when the page connects: rebuild the panel without animations or highlights.
  function replay(ev) {
    switch (ev.type) {
      case 'change':
        // A restarted server lists the edits it keeps copies of again: this page already shows them.
        if (ev.earlier && shownBefore(ev)) break;
        addEditCard(ev, false);
        codeForEdit(ev, false);
        if (wasMissed(ev)) missed.list.push(ev);
        else markSeen(ev.seq);
        clearTimeout(missed.timer);
        missed.timer = setTimeout(showMissed, 400);
        break;
      case 'chat':
        handleChat(ev);
        break;
      case 'page-message':
        addPageMessage(ev);
        break;
      case 'drive-message':
        addDriveMessage(ev);
        break;
      case 'delivered':
        markDelivered(ev.ids, ev.via);
        break;
      case 'cancelled':
        markCancelled(ev.ids, ev.reason);
        break;
      case 'state':
        setClaude(ev);
        break;
      case 'point':
        addPointCard(ev, null);
        break;
      case 'copy':
        addCopyCard(ev, false); // then asks the server for the copy's current state
        break;
      case 'prompt':
        state.working = true;
        break;
      case 'idle':
        state.working = false;
        break;
      default:
        break;
    }
  }

  // The event stream. The browser opens it again by itself after a network error, but a response
  // that is not 200 (a gateway or proxy error while EditLens restarts) closes it permanently: then it
  // is opened again here, waiting longer each time, and the panel says it can't connect meanwhile.
  var STREAM_RETRY_MS = [1000, 2000, 5000, 10000, 20000, 30000];
  var stream = { source: null, timer: 0, fails: 0 };
  // Whether this page needs the page key (D21): '' not asked yet, 'ok', or 'needed'.
  var keyCheck = '';
  var KEY_TEXT = 'Open this page once from Claude Code: /editlens. On this computer the panel needs your key, and that address gives it to this browser.';
  function connect() {
    // A page opened as a file has no address the server can allow (its origin is "null"), and its
    // files are not the project's running app: point to the project's real address instead.
    if (location.protocol === 'file:') {
      renderNoRoot([], 'This page is opened as a file, so EditLens can\'t connect to it. Run /editlens in Claude Code in your project folder and open the address it prints (for example http://127.0.0.1:5173).');
      setStatus('offline', 'Opened as a file. Open the project\'s address instead');
      return;
    }
    if (!GK && !keyCheck) {
      checkPageKey();
      return;
    }
    if (keyCheck === 'needed') {
      askForKey();
      return;
    }
    clearTimeout(stream.timer);
    stream.timer = 0;
    if (stream.source) stream.source.close();
    var params = new URLSearchParams({ page: PAGE_ID, url: location.href, title: pageTitle() || '', listen: state.listen ? '1' : '0' });
    if (OPTS.root) params.set('root', OPTS.root);
    // Opened again: continue after the last event this page has (only from the same server start).
    if (state.instance && state.lastSeq > 0) params.set('since', state.instance + '.' + state.lastSeq);
    var source = stream.source = new EventSource(SERVER + '/events?' + params.toString());
    source.addEventListener('open', function () {
      if (stream.source !== source) return;
      stream.fails = 0;
      state.offlineNote = '';
      state.connected = true;
      // The server sends Claude Code's open questions again: none is kept from before.
      askItems = Object.create(null);
      pqSoon();
      refreshStatus();
      scrollFeed(true);
    });
    source.addEventListener('claude', function (msg) {
      if (stream.source !== source) return;
      var ev;
      try {
        ev = JSON.parse(msg.data);
      } catch (err) {
        if (err instanceof SyntaxError) return;
        throw err;
      }
      handle(ev);
    });
    source.addEventListener('error', function () {
      if (stream.source !== source) return;
      state.connected = false;
      renderAccess();
      var who = state.via || PANEL_NAME;
      if (source.readyState === EventSource.CLOSED) {
        // Closed permanently: open it again after a wait, asking first whether a key is needed now.
        source.close();
        keyCheck = '';
        var wait = STREAM_RETRY_MS[Math.min(stream.fails, STREAM_RETRY_MS.length - 1)];
        stream.fails++;
        stream.timer = setTimeout(connect, wait);
        setStatus('offline', 'Can\'t connect to ' + who + '. Trying again in ' + Math.round(wait / 1000) + ' s');
        state.offlineNote = 'Can\'t connect to ' + who + '. The panel tries again by itself' +
          (stream.fails >= 3 ? (state.via ? '. If it keeps failing, run /editlens join in Claude Code to see why.' : '. If it keeps failing, run /editlens in Claude Code.') : '.');
      } else {
        // The browser opens it again by itself.
        setStatus('offline', 'Reconnecting to ' + who + '…');
      }
      updateHint();
    });
  }
  // Connected again: retry now instead of waiting.
  window.addEventListener('online', function () {
    if (stream.timer) connect();
  });

  // The health check says whether this page's account needs the key (and whether the one kept is
  // good). When EditLens doesn't answer, the stream tries as before and asks again after.
  function checkPageKey() {
    fetch(SERVER + '/health', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (h) {
      keyCheck = h && h.key === 'needed' ? 'needed' : 'ok';
      if (keyCheck === 'needed' && pageKey) {
        // The key kept is not this computer's key now (its state folder was reset, for example).
        storageSet('localStorage', KEY_STORE, null);
        pageKey = '';
        SERVER = ORIGIN;
      }
      connect();
    }, function (err) {
      if (!(err instanceof Error)) throw err;
      keyCheck = 'ok';
      connect();
    });
  }
  function askForKey() {
    state.connected = false;
    renderNoRoot([], KEY_TEXT);
    setStatus('offline', 'Open this page once from Claude Code: /editlens');
    state.offlineNote = KEY_TEXT;
    updateHint();
  }
  // The key arrived in another tab of this address (the one /editlens opened): connect here too.
  window.addEventListener('storage', function (e) {
    if (GK || e.key !== KEY_STORE || !/^[0-9a-f]{32}$/.test(e.newValue || '') || e.newValue === pageKey) return;
    pageKey = e.newValue;
    SERVER = ORIGIN + '/gk-' + pageKey;
    keyCheck = '';
    noRootEl.hidden = true;
    composer.classList.remove('off');
    input.disabled = false;
    renderAttach();
    renderAccess();
    connect();
  });

  function start() {
    // Pointing overlays: below the code view and the panel, so those stay usable while pointing.
    [markLayer, catcher, hoverBox, dragBox, nbEl].forEach(function (n) { root.insertBefore(n, dock); });
    root.appendChild(pickBar);
    root.appendChild(pqButton);
    root.appendChild(pqList);
    root.appendChild(codePick);
    root.appendChild(snapEl);
    composer.querySelector('.atts-slot').replaceWith(attsEl);
    panel.querySelector('.drive-slot').replaceWith(driveBar);
    composer.querySelector('.cfoot').appendChild(handBackButton);
    driveBar.after(signinBox);
    renderDrive();
    pointButton.addEventListener('click', function () { setPick(!pick.on); });
    panesEl.addEventListener('mouseup', checkCodeSelection);
    document.documentElement.appendChild(host);
    setFilter(FILTERS.indexOf(state.filter) >= 0 ? state.filter : 'all');
    renderPanel();
    renderTabs();
    if (state.panel === 'open') showTour(false);
    if (dockState.mode === 'open') dockState.open = true;
    renderDock();
    restoreDock();
    updateHint();
    // Only the attributes that change what is shown (not data-* or aria-* changes).
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'src', 'href', 'open', 'value', 'checked', 'disabled'] });
    var after = storageGet('sessionStorage', 'editlens.after-reload');
    if (after) {
      storageSet('sessionStorage', 'editlens.after-reload', null);
      var saved = null;
      try {
        saved = JSON.parse(after);
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
      }
      if (saved && saved.ev && typeof saved.ev === 'object' && typeof saved.ev.inst === 'string') {
        var inst = saved.ev.inst;
        delete saved.ev.inst;
        Object.defineProperty(saved.ev, 'inst', { value: inst });
      }
      if (saved && Date.now() - finiteNum(saved.at) < 15000) {
        if (Array.isArray(saved.backendPaths)) {
          // Wait for the app to get and render the new data, then outline it.
          setTimeout(function () {
            var els = elementsForPaths(saved.backendPaths.map(function (p) { return { path: p }; }));
            highlight(els, { label: saved.label, color: COLORS.blue, scroll: true, ev: saved.ev || null });
            if (saved.ev && saved.ev.hunks) showReloadToast(saved.label, saved.ev);
          }, 1500);
        } else {
          setTimeout(function () { highlight(elementsFromHints(saved.hints), { label: saved.label, scroll: true, ev: saved.ev || null, approx: true }); }, OPTS.settle);
        }
      }
    }
    if (!hasHmr() && OPTS.reload !== 'off') {
      fetchSource().then(function (doc) { baseline = doc; }, function (err) { console.warn('[EditLens] could not load page source:', err); });
    }
    connect();
  }

  // If starting fails, a later copy of the script may try again.
  function startOnce() {
    try {
      start();
    } catch (err) {
      window.__editlens = null;
      observer.disconnect();
      restorePatches();
      host.remove();
      throw err;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startOnce);
  else startOnce();
})();
