/*
 * EditLens in-page client: edit highlights, chat panel, code view and page pointing.
 * <script src="http://127.0.0.1:4317/live.js"></script>. Optional attributes: data-panel="open|min|hidden",
 * data-reload="auto|morph|full|off" (pages without HMR; auto: swap CSS, morph HTML, reload for scripts),
 * data-root="/abs/path" (only files under it), data-theme="light|dark" (default: the page's theme, else
 * the system's), data-settle="600" (ms to wait for the page to update before highlighting). */
(function () {
  'use strict';
  if (window.__editlens) return;
  var VERSION = '1.0.0';
  // Keep the same as lib/name.js.
  var PANEL_NAME = 'EditLens';
  window.__editlens = { version: VERSION };

  // Loaders like next/script insert the tag dynamically, where currentScript is null.
  // When currentScript is missing, only a /live.js served at the root of this computer's address is
  // taken, not an app's own /js/live.js.
  var script = document.currentScript || [].filter.call(document.querySelectorAll('script[src*="/live.js"]'), function (s) {
    try {
      var u = new URL(s.src);
      return /^(\/gk-[0-9a-f]{32})?\/live\.js$/.test(u.pathname) && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname);
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      return false;
    }
  })[0] || null;
  var scriptUrl = script && script.src ? new URL(script.src) : null;
  var ORIGIN = scriptUrl ? scriptUrl.origin : 'http://127.0.0.1:4317';
  // Through a paired computer's link the script's address starts with the link's key: every
  // request to EditLens keeps it (D11).
  var GK = scriptUrl ? (/^\/gk-[0-9a-f]{32}(?=\/live\.js$)/.exec(scriptUrl.pathname) || [''])[0] : '';
  // Where EditLens can't tell which account connects (macOS, Windows), a page needs this user's key
  // (D21). It comes once after # in an address /editlens opens or prints, and is kept for this
  // address: every request then starts with it, as through a link.
  var KEY_STORE = 'editlens.key:' + ORIGIN;
  var pageKey = GK ? '' : takePageKey();
  var SERVER = ORIGIN + (GK || (pageKey ? '/gk-' + pageKey : ''));
  // The key after # is taken out of the address (so it isn't copied or shared with it); else the one kept.
  function takePageKey() {
    var m = /(?:^#|&)editlens-key=([0-9a-f]{32})(?=&|$)/.exec(location.hash);
    if (!m) {
      var kept = storageGet('localStorage', KEY_STORE);
      return /^[0-9a-f]{32}$/.test(kept || '') ? kept : '';
    }
    storageSet('localStorage', KEY_STORE, m[1]);
    var rest = location.hash.slice(1).split('&').filter(function (p) { return p.indexOf('editlens-key=') !== 0; }).join('&');
    try {
      history.replaceState(history.state, '', location.pathname + location.search + (rest ? '#' + rest : ''));
    } catch (err) {
      // A page whose address can't be changed (a sandboxed frame) keeps it; the key still works.
      if (!(err instanceof DOMException)) throw err;
    }
    return m[1];
  }
  var data = (script && script.dataset) || {};

  function num(value, fallback, min, max) {
    var n = Number(value);
    return value !== undefined && value !== null && value !== '' && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  }
  // A time or other number from events or storage: finite, else 0 (Number(x) || 0 lets Infinity through).
  function finiteNum(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  // An edit number (seq) or a count from events or storage: a positive integer, else 0.
  function posInt(value) {
    var n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : 0;
  }

  var OPTS = {
    panel: data.panel || null,
    reload: data.reload || 'auto',
    root: data.root || null,
    settle: num(data.settle, 600, 0, 10000),
    theme: data.theme === 'light' || data.theme === 'dark' ? data.theme : null,
  };
  var MAX_ITEMS = 250;
  var MAX_TARGETS = 20;
  var HIGHLIGHT_MS = 4200;
  var MUTATION_MEMORY_MS = 4000;
  var RENDER_WINDOW_MS = 1500;
  // A lookup table that has no inherited keys ("constructor", "__proto__" find nothing).
  function dict(o) {
    var d = Object.create(null);
    Object.keys(o).forEach(function (k) { d[k] = o[k]; });
    return d;
  }
  var COLORS = dict({
    edit: '#d97757',
    // A code block the user selected: steady, never fades, a color no edit or pointer uses.
    selected: '#0891b2',
    purple: '#8b5cf6',
    blue: '#3b82f6',
    green: '#16a34a',
    yellow: '#ca8a04',
    pink: '#db2777',
  });

  // ---------- storage (may be unavailable: private mode, sandboxed iframes) ----------
  function storageGet(kind, key) {
    try {
      return window[kind].getItem(key);
    } catch (err) {
      if (err && (err.name === 'SecurityError' || err.name === 'TypeError')) return null;
      throw err;
    }
  }
  function storageSet(kind, key, value) {
    try {
      if (value === null) window[kind].removeItem(key);
      else window[kind].setItem(key, value);
    } catch (err) {
      if (err && (err.name === 'SecurityError' || err.name === 'QuotaExceededError' || err.name === 'TypeError')) return;
      throw err;
    }
  }

  // One-time migration of legacy storage keys.
  function moveOldKeys(kind) {
    var keys = [];
    try {
      for (var i = 0; i < window[kind].length; i++) {
        var k = window[kind].key(i);
        if (k && k.indexOf('claudeLive.') === 0) keys.push(k);
      }
    } catch (err) {
      if (err && (err.name === 'SecurityError' || err.name === 'TypeError')) return;
      throw err;
    }
    keys.forEach(function (k) {
      var to = 'editlens.' + k.slice('claudeLive.'.length);
      if (storageGet(kind, to) === null) storageSet(kind, to, storageGet(kind, k));
      storageSet(kind, k, null);
    });
  }
  moveOldKeys('localStorage');
  moveOldKeys('sessionStorage');

  // One id per tab, kept across reloads. A duplicated tab copies sessionStorage, so the stored id
  // is reused only on a reload or back/forward; anything else gets a new one.
  function newPageId() {
    var c = window.crypto;
    if (c && typeof c.getRandomValues === 'function') {
      var b = new Uint8Array(10);
      c.getRandomValues(b);
      return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    }
    return Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
  }
  function reloaded() {
    var nav = window.performance && typeof performance.getEntriesByType === 'function' ? performance.getEntriesByType('navigation')[0] : null;
    return Boolean(nav && (nav.type === 'reload' || nav.type === 'back_forward'));
  }
  var PAGE_ID = (reloaded() && storageGet('sessionStorage', 'editlens.pageId')) || newPageId();
  storageSet('sessionStorage', 'editlens.pageId', PAGE_ID);

  // ---------- DOM helpers ----------
  // A file path that wraps after a folder (src/pages/ | Customers.jsx), not in the middle of a name.
  function pathText(tag, cls, path) {
    var node = el(tag, { class: cls });
    node.appendChild(document.createTextNode('‎'));
    String(path || '').replace(/([\\/])/g, '$1\n').split('\n').forEach(function (part, i) {
      if (i) node.appendChild(document.createElement('wbr'));
      node.appendChild(document.createTextNode(part));
    });
    return node;
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') node.textContent = attrs[k];
        else if (k === 'on') Object.keys(attrs.on).forEach(function (e) { node.addEventListener(e, attrs.on[e]); });
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) node.appendChild(arguments[i]);
    return node;
  }

  function timeAgo(ts) {
    var t = Number(ts);
    if (!Number.isFinite(t)) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 5) return 'now';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    return Math.floor(s / 3600) + 'h';
  }

  function duration(ms) {
    var n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return '';
    var s = Math.round(n / 1000);
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }

  function baseName(p) {
    return String(p || '').split(/[\\/]/).pop();
  }

  // Safe markdown: headings, paragraphs, numbered and bullet lists (nested by indent), tables,
  // quotes, rules, fenced code with a Copy button, `code`, **bold**, *italic*, links.
  // Text only, never HTML.
  var FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
  var LIST_RE = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/;
  var HEAD_RE = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  var RULE_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var QUOTE_RE = /^\s{0,3}>\s?/;
  var TSEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  function indentOf(line) {
    var m = /^[ \t]*/.exec(line)[0];
    return m.replace(/\t/g, '    ').length;
  }
  // The end of a fenced block that starts at lines[i]: { code, next }.
  function readFence(lines, i) {
    var f = FENCE_RE.exec(lines[i]);
    var pad = f[1].length;
    var body = [];
    var j = i + 1;
    for (; j < lines.length; j++) {
      var close = FENCE_RE.exec(lines[j]);
      if (close && close[2][0] === f[2][0] && close[2].length >= f[2].length && !close[3]) { j++; break; }
      body.push(lines[j].slice(Math.min(pad, indentOf(lines[j]))));
    }
    return { code: body.join('\n'), next: j };
  }
  function blockStart(line, next) {
    return FENCE_RE.test(line) || HEAD_RE.test(line) || RULE_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line) ||
      (line.indexOf('|') >= 0 && next !== undefined && TSEP_RE.test(next) && next.indexOf('-') >= 0);
  }
  function renderMarkdown(text) {
    var box = el('div', { class: 'md' });
    mdBlocks(box, String(text || '').replace(/\r\n?/g, '\n').split('\n'), 0);
    return box;
  }
  function mdBlocks(box, lines, depth) {
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (FENCE_RE.test(line)) {
        var f = readFence(lines, i);
        box.appendChild(codeBlock(f.code));
        i = f.next;
        continue;
      }
      var h = HEAD_RE.exec(line);
      if (h) {
        var level = h[1].length;
        box.appendChild(inline(el('p', { class: 'h h' + level, role: 'heading', 'aria-level': String(Math.min(6, level + 2)) }), h[2]));
        i++;
        continue;
      }
      if (RULE_RE.test(line)) { box.appendChild(el('hr')); i++; continue; }
      if (QUOTE_RE.test(line)) {
        var quoted = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) quoted.push(lines[i++].replace(QUOTE_RE, ''));
        var q = el('blockquote');
        // Deeply nested quotes stay readable as text.
        if (depth < 4) mdBlocks(q, quoted, depth + 1);
        else q.appendChild(inline(el('p'), quoted.join(' ')));
        box.appendChild(q);
        continue;
      }
      if (line.indexOf('|') >= 0 && TSEP_RE.test(lines[i + 1] || '') && (lines[i + 1] || '').indexOf('-') >= 0) {
        var rows = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) rows.push(lines[i++]);
        box.appendChild(mdTable(rows));
        continue;
      }
      if (LIST_RE.test(line)) {
        i = mdList(box, lines, i, depth);
        continue;
      }
      var p = el('p');
      var first = true;
      while (i < lines.length && lines[i].trim() && (first || !blockStart(lines[i], lines[i + 1]))) {
        if (!first) p.appendChild(el('br'));
        inline(p, lines[i].trim());
        first = false;
        i++;
      }
      box.appendChild(p);
    }
  }
  // A table's cells, split on | that is not escaped.
  function tableCells(row) {
    var s = row.trim().replace(/^\|/, '').replace(/\|$/, '');
    var cells = [];
    var cur = '';
    for (var k = 0; k < s.length; k++) {
      if (s[k] === '\\' && s[k + 1] === '|') { cur += '|'; k++; }
      else if (s[k] === '|') { cells.push(cur.trim()); cur = ''; }
      else cur += s[k];
    }
    cells.push(cur.trim());
    return cells;
  }
  function mdTable(rows) {
    var head = tableCells(rows[0]);
    var align = tableCells(rows[1]).map(function (c) {
      var l = c[0] === ':';
      var r = c[c.length - 1] === ':';
      return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
    });
    var cols = Math.min(head.length, 30);
    var cell = function (tag, textValue, k) {
      var c = inline(el(tag), textValue || '');
      if (align[k]) c.style.textAlign = align[k];
      return c;
    };
    var tr = el('tr');
    for (var k = 0; k < cols; k++) tr.appendChild(cell('th', head[k], k));
    var body = el('tbody');
    rows.slice(2, 202).forEach(function (r) {
      var cells = tableCells(r);
      var row = el('tr');
      for (var k = 0; k < cols; k++) row.appendChild(cell('td', cells[k], k));
      body.appendChild(row);
    });
    return el('div', { class: 'tbl' }, el('table', null, el('thead', null, tr), body));
  }
  // A list from lines[i]: items nest by their indent, numbered lists keep their first number,
  // and a code block indented under an item stays in that item. Returns the next line.
  function mdList(box, lines, i, depth) {
    var stack = []; // { indent, ordered, list, li, parent }
    var lastIndent = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) {
        // A blank line ends the list unless the list continues after it.
        var j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && (LIST_RE.test(lines[j]) || (indentOf(lines[j]) > 0 && stack.length))) { i = j; continue; }
        return j;
      }
      var m = LIST_RE.exec(line);
      var ind = indentOf(line);
      var top = stack[stack.length - 1];
      if (m && !RULE_RE.test(line)) {
        while (stack.length > 1 && ind < stack[stack.length - 1].indent - 1) stack.pop();
        top = stack[stack.length - 1];
        var ordered = m[3] !== undefined;
        var parent = null;
        if (!top) parent = box;
        else if (ind >= top.indent + 2 && top.li) parent = top.li;
        else if (top.ordered !== ordered) parent = top.parent;
        if (parent) {
          var list = el(ordered ? 'ol' : 'ul');
          var start = ordered ? Number(m[3]) : 1;
          if (ordered && Number.isFinite(start) && start !== 1 && start >= 0 && start < 1e9) list.setAttribute('start', String(start));
          parent.appendChild(list);
          var entry = { indent: top && parent === top.parent ? top.indent : ind, ordered: ordered, list: list, li: null, parent: parent };
          if (top && parent === top.parent) stack[stack.length - 1] = entry;
          else stack.push(entry);
          top = entry;
        }
        top.li = inline(el('li'), m[4]);
        top.list.appendChild(top.li);
        lastIndent = ind;
        i++;
        continue;
      }
      if (!top || !top.li) return i;
      // Under an item: its code block, or more of its text.
      if (FENCE_RE.test(line) && ind > lastIndent) {
        var f = readFence(lines, i);
        top.li.appendChild(codeBlock(f.code));
        i = f.next;
        continue;
      }
      if (ind === 0 && blockStart(line, lines[i + 1])) return i;
      top.li.appendChild(el('br'));
      inline(top.li, line.trim());
      i++;
    }
    return i;
  }
  // A code block with a Copy button.
  function codeBlock(code) {
    return el('div', { class: 'cblock' }, el('pre', { text: code }), copyButton(function () { return code; }, 'Copy code', 'ccopy'));
  }
  // A small Copy button: after a copy its icon is a check and it says "Copied" for about a second.
  function copyButton(getText, label, cls) {
    var b = el('button', { class: 'cpy ' + (cls || ''), type: 'button', title: label, 'aria-label': label }, icon('copy'), el('span', { text: 'Copy' }));
    var timer = 0;
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      copyText(getText(), null, function () {
        clearTimeout(timer);
        b.classList.add('done');
        b.replaceChildren(icon('check'), el('span', { text: 'Copied' }));
        timer = setTimeout(function () {
          b.classList.remove('done');
          b.replaceChildren(icon('copy'), el('span', { text: 'Copy' }));
        }, 1100);
      });
    });
    return b;
  }
  function inline(parent, text) {
    var parts = String(text).split(/(\[[^\]\n]+\]\([^)\s]+(?:\s+"[^"]*")?\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/);
    parts.forEach(function (part) {
      if (!part) return;
      var link = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(part);
      if (link) parent.appendChild(linkFor(link[1], link[2]));
      else if (part[0] === '`' && part.length > 2) {
        var code = part.slice(1, -1);
        var ref = fileRef(code, false);
        parent.appendChild(ref ? fileLink(el('code', { text: code }), ref) : el('code', { text: code }));
      }
      else if (part.indexOf('**') === 0 && part.length > 4) parent.appendChild(el('strong', { text: part.slice(2, -2) }));
      else if (part[0] === '*' && part.length > 2) parent.appendChild(el('em', { text: part.slice(1, -1) }));
      else plainWithRefs(parent, part);
    });
    return parent;
  }

  // ---------- file references in Claude's replies: click to open in the code view ----------
  var CODE_EXT = /\.(jsx?|tsx?|mjs|cjs|json|css|scss|sass|less|html?|vue|svelte|astro|mdx?|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|ps1|bat|ya?ml|toml|ini|txt|sql|graphql|gql|prisma|xml|svg|lock)$/i;
  // "src/App.jsx", "C:\\proj\\a.js", "./x.ts:12", "server.js:10-20", "src/pages/", "src#L5"
  function fileRef(raw, strict) {
    var s = String(raw || '').trim().replace(/^["'(<]+|[>)"',.;]+$/g, '');
    if (!s || s.length > 300 || /\s/.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^file:/i.test(s)) return null;
    var line = null;
    var end = null;
    var m = /^(.*?)(?::(\d+)(?:[-–:](\d+))?|#L(\d+)(?:-L?(\d+))?)$/.exec(s);
    if (m && m[1] && !/^[a-z]$/i.test(m[1])) {
      s = m[1];
      line = Number(m[2] || m[4]);
      end = m[3] || m[5] ? Number(m[3] || m[5]) : null;
    }
    var slash = /[\\/]/.test(s);
    var ext = CODE_EXT.test(s);
    var named = /^(?:[A-Za-z]:)?[\w@.\\/\[\]()+~-]+$/.test(s) && /[A-Za-z]/.test(s);
    if (!named || /^\.+$/.test(s) || /^\d+(\.\d+)*$/.test(s)) return null;
    // Bare names need a code extension; in plain text a path also needs a slash or a line number.
    if (!ext && !(slash && !strict)) return null;
    if (strict && !slash && line === null) return null;
    return { path: s, line: Number.isFinite(line) && line > 0 ? line : null, end: Number.isFinite(end) && end > 0 ? end : null };
  }
  function linkFor(label, target) {
    if (/^https?:\/\//i.test(target)) return el('a', { href: target, target: '_blank', rel: 'noopener noreferrer', text: label });
    var ref = fileRef(target, false) || (!/^[a-z]+:/i.test(target) || /^file:/i.test(target) ? { path: target, line: null, end: null } : null);
    return ref ? fileLink(document.createTextNode(label), ref) : document.createTextNode(label);
  }
  function fileLink(inner, ref) {
    var a = el('a', { href: '#', class: 'fref', title: 'Open ' + ref.path + (ref.line ? ' at line ' + ref.line : '') + ' in the code view' }, inner);
    a.addEventListener('click', function (e) {
      e.preventDefault();
      openRef(ref);
    });
    return a;
  }
  // Plain text: bare http(s) URLs, and paths like src/App.jsx:12.
  function plainWithRefs(parent, text) {
    var re = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]|(?:[A-Za-z]:)?(?:\.{0,2}[\\/])?[\w@.-]+(?:[\\/][\w@.-]+)+\/?(?::\d+(?:[-–]\d+)?)?|[\w@-][\w@.-]*\.[A-Za-z]{1,10}:\d+(?:[-–]\d+)?)/g;
    var last = 0;
    var m;
    while ((m = re.exec(text))) {
      var tok = m[0];
      var node = null;
      if (/^https?:/i.test(tok)) node = el('a', { href: tok, target: '_blank', rel: 'noopener noreferrer', text: tok });
      else {
        var ref = fileRef(tok, true);
        if (ref) node = fileLink(document.createTextNode(tok), ref);
      }
      if (!node) continue;
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      parent.appendChild(node);
      last = m.index + tok.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }
  // One-line text without markdown marks, for the activity line.
  function plain(text) {
    return String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*`#>]+/g, '').replace(/\s+/g, ' ').trim();
  }

  // ---------- shadow host ----------
  var host = document.createElement('edit-lens');
  host.setAttribute('data-editlens', '');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  var root = host.attachShadow({ mode: 'open' });
  // Panels popped out into their own windows: { win, host, root, pip } (see "movable windows").
  var pop = { panel: null, dock: null };

  // ---------- theme: Light or Dark when picked, else the page's own theme, else the computer's ----------
  var themePick = OPTS.theme;
  var themeNow = null;
  function schemeOf(value) {
    var words = String(value || '').toLowerCase().split(/[^a-z]+/);
    var dark = words.indexOf('dark') >= 0;
    var light = words.indexOf('light') >= 0;
    return dark === light ? null : dark ? 'dark' : 'light';
  }
  // A theme marker the page put on <html> or <body>: class dark/light, data-theme, data-bs-theme, data-mode.
  function markerOf(node) {
    if (!node || !node.getAttribute) return null;
    var cls = node.classList;
    var byClass = schemeOf((cls.contains('dark') || cls.contains('dark-mode') ? ' dark' : '') + (cls.contains('light') || cls.contains('light-mode') ? ' light' : ''));
    if (byClass) return byClass;
    var names = ['data-theme', 'data-bs-theme', 'data-mode', 'data-color-scheme'];
    for (var i = 0; i < names.length; i++) {
      var t = schemeOf(node.getAttribute(names[i]));
      if (t) return t;
    }
    return null;
  }
  // Dark or light from a computed background color; null when (mostly) transparent or unreadable.
  function brightnessOf(node) {
    if (!node) return null;
    var m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(getComputedStyle(node).backgroundColor || '');
    if (!m) return null;
    var a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
    var rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!(a >= 0.5) || !isFinite(a) || rgb.some(function (n) { return !isFinite(n); })) return null;
    var lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    return lum < 0.5 ? 'dark' : 'light';
  }
  // Only the page's own <html>, <body> and color-scheme are read; the edit-lens element is never read.
  function pageTheme() {
    var html = document.documentElement;
    var body = document.body;
    var t = schemeOf(getComputedStyle(html).colorScheme);
    if (t) return t;
    var meta = document.querySelector('meta[name="color-scheme" i]');
    t = meta && schemeOf(meta.getAttribute('content'));
    return t || markerOf(html) || markerOf(body) || brightnessOf(body) || brightnessOf(html);
  }
  function computerTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  // The background behind a popped-out window, the same as the theme's --bg.
  function popBaseCss(theme) {
    return 'html,body{margin:0;height:100%;overflow:hidden;color-scheme:' + theme + ';background:' + (theme === 'dark' ? '#242426' : '#fbfbfa') + '}';
  }
  function applyTheme() {
    var t = themePick || pageTheme() || computerTheme();
    if (t === themeNow) return;
    themeNow = t;
    [host].concat(pop.panel ? [pop.panel.host] : [], pop.dock ? [pop.dock.host] : []).forEach(function (h) { h.setAttribute('data-theme', t); });
    ['panel', 'dock'].forEach(function (k) { if (pop[k] && pop[k].base) pop[k].base.textContent = popBaseCss(t); });
  }
  var themeQueued = false;
  function themeSoon() {
    if (themeQueued) return;
    themeQueued = true;
    setTimeout(function () { themeQueued = false; applyTheme(); }, 0);
  }
  // Sites change theme through attributes on <html>/<body>, new stylesheets, or the system setting.
  var themeWatch = new MutationObserver(function (records) {
    var body = document.body;
    if (body && body !== themeWatch.body) {
      themeWatch.body = body;
      themeWatch.observe(body, { attributes: true });
    }
    // EditLens's own marks (data-editlens-*) and the edit-lens element never change the result.
    if (records.some(function (r) {
      if (r.type === 'attributes') return !/^data-editlens/.test(r.attributeName);
      return [].some.call(r.addedNodes, function (n) { return n !== host; }) || [].some.call(r.removedNodes, function (n) { return n !== host; });
    })) themeSoon();
  });
  themeWatch.observe(document.documentElement, { attributes: true, childList: true });
  if (document.head) themeWatch.observe(document.head, { childList: true });
  if (document.body) {
    themeWatch.body = document.body;
    themeWatch.observe(document.body, { attributes: true });
  }
  document.addEventListener('DOMContentLoaded', function () {
    if (document.head) themeWatch.observe(document.head, { childList: true });
    themeWatch.takeRecords();
    if (document.body && themeWatch.body !== document.body) {
      themeWatch.body = document.body;
      themeWatch.observe(document.body, { attributes: true });
    }
    applyTheme();
  });
  // A stylesheet that finishes loading can change the page's background.
  document.addEventListener('load', function (e) { if (e.target && e.target.tagName === 'LINK') themeSoon(); }, true);
  window.addEventListener('load', themeSoon);
  if (window.matchMedia) {
    var themeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    if (themeQuery.addEventListener) themeQuery.addEventListener('change', themeSoon);
    else if (themeQuery.addListener) themeQuery.addListener(themeSoon);
  }
  applyTheme();

  // Fonts: Windows first (Segoe UI Variable / Cascadia / Consolas), then macOS, then Linux.
  // Never let monospace use Courier New, which is thin and hard to read on Windows.
  var SANS = '-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI Variable Text","Segoe UI",system-ui,Inter,Roboto,"Helvetica Neue",Arial,sans-serif';
  var MONO = '"Cascadia Mono","Cascadia Code",Consolas,ui-monospace,"SF Mono",SFMono-Regular,Menlo,"JetBrains Mono","DejaVu Sans Mono","Liberation Mono",monospace';
  // One set of tokens for the panel, the code view and the EditLens window (light and dark):
  // thin borders, one soft shadow, and the accent only for the main action and live state.
  var LIGHT = '--accent:#c4592f;--accent-hi:#e9845d;--accent-ink:#a8481f;--accent-soft:rgba(196,89,47,.10);--accent-line:rgba(196,89,47,.32);' +
    '--glass:rgba(252,252,251,.94);--accent-fill:#bf552c;--bg:#fbfbfa;--raise:#ffffff;--sunk:#f0f0ee;--bubble:#efeeea;--fg:#1d1d1f;--fg2:#3a3a3c;--muted:#6e6e73;--faint:#8e8e93;' +
    '--line:rgba(0,0,0,.08);--line2:rgba(0,0,0,.14);--scroll:rgba(0,0,0,.24);--fill:rgba(0,0,0,.045);--fill2:rgba(0,0,0,.07);' +
    '--add:#248a3d;--add-bg:rgba(36,138,61,.09);--del:#d70015;--del-bg:rgba(215,0,21,.07);' +
    '--api:#0a66d6;--api-ink:#0a58b8;--api-soft:rgba(10,102,214,.09);--agent:#7c3aed;--agent-ink:#6427d4;--agent-soft:rgba(124,58,237,.06);' +
    '--ctx:#0f8b8d;--ctx-soft:rgba(15,139,141,.10);--sel:#0e7490;--sel-soft:rgba(14,116,144,.09);--ses:#c2387f;--ses-soft:rgba(194,56,127,.09);--warn:#b25000;--focus:#0a66d6;' +
    '--pick:#0e8a6a;--pick-ink:#0b6e55;--pick-soft:rgba(14,138,106,.16);' +
    '--code-bg:#ffffff;--syn-c:#87847c;--syn-s:#1b7a43;--syn-n:#b45309;--syn-k:#7c3aed;--syn-t:#c2410c;--syn-p:#1d4fd7;' +
    '--card:0 0 0 .5px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.05);' +
    '--shadow:0 0 0 .5px rgba(0,0,0,.08),0 10px 30px -8px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.06);' +
    '--gbox:rgba(255,255,255,.78);--gsolid:#ffffff;--gline:0 0 0 .5px rgba(0,0,0,.08);--gfg:#1d1d1f;--gph:#a1a1a6;';
  var DARK = '--accent:#e8865f;--accent-hi:#f0a07f;--accent-ink:#f2a98b;--accent-soft:rgba(232,134,95,.16);--accent-line:rgba(232,134,95,.42);' +
    '--glass:rgba(36,36,38,.94);--accent-fill:#b4532c;--bg:#242426;--raise:#2c2c2e;--sunk:#1c1c1e;--bubble:#333336;--fg:#f5f5f7;--fg2:#d1d1d6;--muted:#98989d;--faint:#7c7c81;' +
    '--line:rgba(255,255,255,.09);--line2:rgba(255,255,255,.15);--scroll:rgba(255,255,255,.22);--fill:rgba(255,255,255,.06);--fill2:rgba(255,255,255,.10);' +
    '--add:#32d74b;--add-bg:rgba(50,215,75,.10);--del:#ff6961;--del-bg:rgba(255,105,97,.10);' +
    '--api:#64a8ff;--api-ink:#a3c6ff;--api-soft:rgba(100,168,255,.12);--agent:#a78bfa;--agent-ink:#cbbcfd;--agent-soft:rgba(167,139,250,.09);' +
    '--ctx:#4fd1c5;--ctx-soft:rgba(79,209,197,.12);--sel:#22d3ee;--sel-soft:rgba(34,211,238,.11);--ses:#f472b6;--ses-soft:rgba(244,114,182,.11);--warn:#ffb340;--focus:#64a8ff;' +
    '--pick:#0e8a6a;--pick-ink:#5fd3ad;--pick-soft:rgba(46,196,154,.24);' +
    '--code-bg:#1c1c1e;--syn-c:#8c8980;--syn-s:#86d9a6;--syn-n:#f5b571;--syn-k:#c4b5fd;--syn-t:#f2a98b;--syn-p:#a3c6ff;' +
    '--card:0 0 0 .5px rgba(255,255,255,.10),0 1px 2px rgba(0,0,0,.3);' +
    '--shadow:0 0 0 .5px rgba(255,255,255,.10),0 14px 36px -8px rgba(0,0,0,.6),0 2px 6px rgba(0,0,0,.3);' +
    '--gbox:rgba(44,44,46,.78);--gsolid:#2c2c2e;--gline:0 0 0 .5px rgba(255,255,255,.09);--gfg:#f5f5f7;--gph:#636366;';
  var THIN_SCROLL = 'scrollbar-width:thin;scrollbar-color:var(--scroll) transparent;';

  root.appendChild(el('style', { text: [
    ':host{' + LIGHT + '--sans:' + SANS + ';--mono:' + MONO + '}',
    ':host([data-theme=dark]){' + DARK + '}',
    '@media (prefers-color-scheme:dark){:host(:not([data-theme=light])){' + DARK + '}}',
    '*{box-sizing:border-box}',
    '.panel,.pill,.toast,.edge,.note{font-family:var(--sans);color:var(--fg);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}',
    'button{font:inherit;color:inherit}',
    'button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}',
    // highlights on the page
    '.layer{position:fixed;inset:0;pointer-events:none;overflow:hidden}',
    '.box{--c:var(--accent);position:fixed;border:1.5px solid var(--c);border-radius:7px;background:transparent;',
    'box-shadow:0 0 0 4px color-mix(in srgb,var(--c) 18%,transparent);animation:pop .3s ease-out,glow 1.2s ease-in-out .3s 1;transition:opacity .6s ease}',
    // An edit's file tag is hidden: the marker and the hover card show the file instead.
    '.box:not(.point):not(.sel)>.tag{display:none}',
    // Change markers in the page margin (numbered like the edit cards).
    '.mlayer.off{display:none}',
    '.emark{position:fixed;width:18px;height:18px;padding:0;border:0;border-radius:50%;pointer-events:auto;cursor:pointer;display:grid;place-items:center;',
    'background:var(--accent);color:#fff;font:600 10px/1 var(--sans);box-shadow:0 0 0 2px var(--raise),0 1px 4px rgba(0,0,0,.25);animation:pop .3s ease-out}',
    '.emark.seen{background:var(--raise);color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent),0 0 0 2px var(--raise),0 1px 3px rgba(0,0,0,.15)}',
    '.emark:hover,.emark:focus-visible{transform:scale(1.12)}.emark:focus-visible{outline:2px solid var(--focus);outline-offset:2px}',
    '.box.point{border-style:dashed;border-width:2.5px;background:color-mix(in srgb,var(--c) 9%,transparent);animation:pop .35s ease-out,breathe 2.4s ease-in-out .35s infinite}',
    '.box.out{opacity:0}',
    '.box.sel{border-width:2.5px;background:color-mix(in srgb,var(--c) 8%,transparent);animation:pop .3s ease-out;',
    'box-shadow:0 0 0 1px rgba(255,255,255,.85) inset,0 0 0 1px rgba(255,255,255,.85),0 0 0 4px color-mix(in srgb,var(--c) 22%,transparent)}',
    '.box.sel.again{animation:none}',
    // Show: the outline it scrolled into view pulses (still a thick ring when motion is reduced).
    '.box.hit{outline:3px solid var(--c);outline-offset:5px;animation:hit .45s ease-in-out 3}',
    '@keyframes hit{50%{outline-offset:11px}}',
    '.box.sel .tag{background:#0e7490}',
    '.box.sel.fol .tag{background:var(--c)}',
    '.selbar{position:fixed;left:16px;bottom:16px;display:none;flex-wrap:wrap;align-items:center;gap:6px 8px;max-width:min(calc(100vw - 32px),460px);pointer-events:auto;',
    'background:var(--raise);color:var(--fg);border:1px solid var(--line2);box-shadow:var(--shadow),inset 3px 0 0 var(--sel);border-radius:10px;padding:6px 6px 6px 12px;font:500 13px/1.3 var(--sans)}',
    '.selbar.on{display:flex}',
    '.selbar .st{flex:1 1 13em;min-width:0;white-space:normal;overflow-wrap:break-word}',
    '.selbar .st b{font:600 12.5px/1 var(--mono);color:var(--sel)}',
    '.selbar .mini{flex:none}',
    '.selbar .mini:disabled{display:none}',
    '.selbar .mini.chg[aria-expanded=true]{background:var(--sel-soft);border-color:var(--sel);color:var(--sel)}',
    // All changes, opened from the selection bar: newest first; a click shows it on the page and in the code.
    '.chlist{position:fixed;left:16px;display:none;flex-direction:column;width:min(calc(100vw - 32px),460px);max-height:min(46vh,380px);overflow:auto;pointer-events:auto;',
    'background:var(--raise);color:var(--fg);border:1px solid var(--line2);box-shadow:var(--shadow);border-radius:10px;padding:4px;font:500 13px/1.3 var(--sans);' + THIN_SCROLL + '}',
    '.chlist.on{display:flex}.chlist.on.nobar{display:none}',
    '.chlist .chh{display:flex;align-items:center;gap:.5em;padding:6px 8px 4px;font-size:.86em;color:var(--muted)}.chlist .chh b{color:var(--fg);margin-right:auto}',
    '.chlist .chi{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:2px 8px;text-align:left;width:100%;padding:6px 8px;border:0;border-radius:7px;background:none;color:inherit;font:inherit;cursor:pointer}',
    '.chlist .chi:hover{background:var(--hover,rgba(127,127,127,.08))}.chlist .chi.on{background:var(--sel-soft);box-shadow:inset 3px 0 0 var(--sel)}',
    '.chlist .chi i{width:.55em;height:.55em;border-radius:50%;background:var(--fc,var(--accent))}',
    '.chlist .chi .f{font:600 12.5px/1.3 var(--mono);overflow-wrap:anywhere}.chlist .chi .m{font-size:.84em;color:var(--muted);white-space:nowrap}',
    '.chlist .chi .w{grid-column:2/4;font-size:.84em;color:var(--muted);overflow-wrap:anywhere}',
    '.chlist .chi .a{color:var(--add)}.chlist .chi .d{color:var(--del)}',
    '.tag{position:absolute;left:-2px;bottom:100%;margin-bottom:5px;background:var(--c);color:#fff;font:600 12px/1 var(--mono);',
    'padding:5px 8px;border-radius:6px;white-space:normal;overflow-wrap:anywhere;line-height:1.35;width:max-content;max-width:min(60vw,420px);box-shadow:0 2px 8px rgba(0,0,0,.18)}',
    '.tag.below{bottom:auto;top:100%;margin:5px 0 0}',
    '.note{position:absolute;left:-2px;bottom:100%;margin-bottom:7px;background:var(--c);color:#fff;font-size:13px;font-weight:500;line-height:1.4;',
    'padding:7px 11px;border-radius:10px;max-width:min(70vw,340px);box-shadow:0 6px 20px rgba(0,0,0,.22)}',
    '.note::before{content:"✦ Claude";display:block;font-size:11px;font-weight:700;letter-spacing:.04em;opacity:.85;margin-bottom:2px}',
    '.note.below{bottom:auto;top:100%;margin:7px 0 0}',
    '@keyframes pop{from{transform:scale(1.06);opacity:0}to{transform:scale(1);opacity:1}}',
    '@keyframes glow{50%{box-shadow:0 0 0 6px color-mix(in srgb,var(--c) 26%,transparent)}}',
    '@keyframes breathe{50%{box-shadow:0 0 0 8px color-mix(in srgb,var(--c) 10%,transparent),0 0 30px color-mix(in srgb,var(--c) 40%,transparent)}}',
    '.cursor{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;color:var(--accent);opacity:0;',
    'transition:left .5s cubic-bezier(.2,.8,.2,1),top .5s cubic-bezier(.2,.8,.2,1),opacity .2s;filter:drop-shadow(0 0 6px rgba(217,119,87,.8))}',
    '.cursor.on{opacity:1}',
    '.bar{position:fixed;left:0;right:0;top:0;height:3px;opacity:0;transition:opacity .3s;',
    'background:linear-gradient(90deg,transparent,var(--accent),var(--accent-hi),var(--accent),transparent);background-size:50% 100%;animation:slide 1.2s linear infinite}',
    '.bar.on{opacity:1}',
    '@keyframes slide{from{background-position:-50% 0}to{background-position:150% 0}}',
    '.edge{position:fixed;left:50%;transform:translateX(-50%);pointer-events:auto;cursor:pointer;background:var(--accent);color:#fff;border:0;',
    'font-weight:600;font-size:13px;padding:9px 14px;border-radius:999px;box-shadow:var(--shadow);display:none}',
    '.edge.top{top:12px}.edge.bottom{bottom:12px}.edge.on{display:block}',
    // the user pointing (green: theirs; Claude's pointers are purple, edits orange)
    '.catcher{position:fixed;inset:0;pointer-events:auto;cursor:crosshair;display:none;touch-action:none}.catcher.on{display:block}',
    '.ubox{--c:#0e8a6a;position:fixed;border:2px solid var(--c);border-radius:6px;pointer-events:none;display:none}',
    '.ubox.on,.ubox.mark{display:block}',
    '.ubox.hover{background:color-mix(in srgb,var(--c) 10%,transparent)}',
    '.ubox.drag{border-style:dashed;background:color-mix(in srgb,var(--c) 8%,transparent)}',
    '.ubox.mark{border-width:2.5px;background:color-mix(in srgb,var(--c) 7%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 18%,transparent);animation:pop .3s ease-out}',
    '.ubox.mark.area{border-style:dashed;background:color-mix(in srgb,var(--c) 3%,transparent)}.ubox.mark.gone{display:none}',
    '.ubox .num{position:absolute;left:-11px;top:-11px;min-width:22px;height:22px;padding:0 5px;border-radius:11px;background:var(--c);color:#fff;font:700 12px/22px var(--sans);text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.25)}',
    '.ubox .tag{background:var(--c)}',
    '.pickbar{position:fixed;left:50%;top:12px;transform:translateX(-50%);background:#0e8a6a;color:#fff;font:600 13px/1.3 var(--sans);padding:9px 16px;border-radius:999px;box-shadow:var(--shadow);display:none;pointer-events:none;max-width:calc(100vw - 32px);text-align:center}',
    '.pickbar.on{display:block}',
    // the message box next to the picked item
    '.notebox{position:fixed;left:0;top:0;width:380px;display:none;pointer-events:auto;background:var(--glass);border-radius:14px;box-shadow:var(--shadow);' +
      '-webkit-backdrop-filter:blur(24px) saturate(1.4);backdrop-filter:blur(24px) saturate(1.4);padding:7px 7px 7px 8px;' +
      'font:13px/1.45 var(--sans);color:var(--fg);-webkit-font-smoothing:antialiased;animation:pop .2s ease-out}',
    '.notebox.on{display:block}.notebox.gone{visibility:hidden}',
    '.notebox::before{content:"";position:absolute;width:12px;height:12px;background:var(--glass);transform:rotate(45deg);border-radius:2px}',
    '.notebox[data-side=dn]::before{top:-6px;left:var(--ax,16px);box-shadow:-.5px -.5px 0 var(--line2)}',
    '.notebox[data-side=up]::before{bottom:-6px;left:var(--ax,16px);box-shadow:.5px .5px 0 var(--line2)}',
    '.notebox[data-side=lf]::before{left:-6px;top:var(--ay,12px);box-shadow:-.5px .5px 0 var(--line2)}',
    '.notebox[data-side=rt]::before{right:-6px;top:var(--ay,12px);box-shadow:.5px -.5px 0 var(--line2)}',
    '.nbrow{position:relative;display:flex;align-items:flex-start;gap:7px}',
    '.nbchip{display:inline-flex;align-items:center;gap:5px;flex:0 1 auto;min-width:0;max-width:50%;margin-top:1px;padding:3px 8px 3px 4px;border:0;border-radius:8px;' +
      'background:var(--pick-soft);color:var(--pick-ink);font:500 11.5px/1.3 var(--sans);white-space:nowrap;cursor:default}',
    '.nbchip span{overflow:hidden;text-overflow:ellipsis}',
    '.nbchip i,.nbli i{font-style:normal;flex:none;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--pick);color:#fff;font:600 9.5px/16px var(--sans);text-align:center}',
    '.nbchip i+i{margin-left:-9px;box-shadow:0 0 0 1.5px var(--raise)}',
    '.notebox textarea{flex:1 1 150px;min-width:120px;height:25px;max-height:calc(5.8em + 6px);margin:0;padding:3px 2px;border:0;background:transparent;color:var(--fg);' +
      'font:inherit;resize:none;outline:none;overflow-y:auto;' + THIN_SCROLL + '}',
    '.notebox textarea::placeholder{color:var(--faint)}',
    '.nbadd{flex:none;padding:4px 12px;border:0;border-radius:8px;background:var(--pick);color:#fff;font:600 12px/1.45 var(--sans);cursor:pointer}',
    '.nbadd:disabled{background:var(--fill2);color:var(--faint);cursor:default}',
    '.nbhint{display:flex;gap:10px;margin:5px 2px 0 4px;font-size:11px;color:var(--faint)}.nbhint[hidden]{display:none}.nbhint b{font-weight:500;color:var(--muted)}',
    '.nblist{display:none;margin-top:6px;padding:3px;border-radius:10px;background:var(--fill)}.notebox.list .nblist{display:block}',
    '.nbli{display:flex;align-items:center;gap:7px;padding:4px 4px 4px 6px;border-radius:7px;font-size:12px}',
    '.nbli span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.nbli button{flex:none;width:20px;height:20px;border:0;border-radius:50%;background:transparent;color:var(--muted);cursor:pointer;font-size:14px;line-height:1}',
    '.nbli button:hover{background:var(--fill2);color:var(--fg)}',
    '.atts{display:flex;flex-wrap:wrap;gap:5px;margin:0 0 7px}.atts:empty{display:none}',
    '.atts.sent{margin:.35em 0 0;justify-content:flex-end}',
    '.att{display:inline-flex;align-items:center;gap:.4em;max-width:100%;border-radius:999px;padding:.2em .35em .2em .25em;font-size:.84em;color:var(--fg2);',
    'background:color-mix(in srgb,#0e8a6a 10%,transparent);border:1px solid color-mix(in srgb,#0e8a6a 35%,transparent)}',
    '.att b{min-width:1.55em;height:1.55em;border-radius:99px;background:#0e8a6a;color:#fff;font-size:.82em;display:grid;place-items:center;padding:0 .3em}',
    '.att .an{cursor:pointer;white-space:normal;overflow-wrap:anywhere;max-width:24em}.att .an:hover{text-decoration:underline}',
    '.att .ax{border:0;background:transparent;color:var(--del);cursor:pointer;padding:0 .3em;font-size:1.05em;line-height:1}.att .ax:hover{color:var(--del);background:var(--del-bg);border-radius:4px}',
    '.atts.sent .att{padding-right:.6em}',
    '.codepick{position:fixed;display:none;pointer-events:auto;border:0;border-radius:999px;background:#0e8a6a;color:#fff;font:600 12.5px/1 var(--sans);padding:8px 12px;box-shadow:var(--shadow);cursor:pointer;z-index:5}',
    '.codepick.on{display:block}',
    // page control
    '.drivebar{display:none;align-items:center;flex-wrap:wrap;gap:.4em;margin:0 10px 6px;padding:.2em .3em .2em .6em;border-radius:9px;background:var(--accent-soft);border:1px solid var(--accent-line);font-size:.8em;color:var(--fg2)}',
    '.drivebar .det{color:var(--muted)}',
    '.acc{display:none;align-items:center;gap:.35em;padding:.2em .5em;border-radius:6px;font:inherit;font-size:.8em;font-weight:500;line-height:1.4;cursor:pointer;color:var(--warn);background:transparent;border:0;white-space:nowrap}',
    '.rootchip{display:none;align-self:flex-start;margin-top:.15em;padding:.1em .6em;border-radius:6px;font:inherit;font-size:.74em;font-weight:800;letter-spacing:.02em;line-height:1.5;cursor:pointer;text-transform:uppercase;color:#fff;background:#b3392e;border:1px solid #b3392e}',
    '.rootchip.on{display:inline-flex}.rootchip.wait{color:var(--del);background:color-mix(in srgb,var(--del) 12%,transparent)}',
    '.acc.on{display:inline-flex}.acc:hover,.acc[aria-expanded=true]{background:var(--fill)}',
    '.accpop,.noroot{display:none;margin:0 0 8px;padding:.6em .75em .6em 2.2em;border-radius:10px;font-size:.84em;line-height:1.45;color:var(--muted);background:var(--fill);position:relative}',
    '.accpop::before,.noroot::before{content:"!";position:absolute;left:.75em;top:.62em;width:1.05em;height:1.05em;border-radius:50%;border:1.5px solid var(--warn);color:var(--warn);font:700 .78em/1.05em var(--sans);text-align:center}',
    '.noroot:not([hidden]):not(.dismissed){display:block}.noroot b,.accpop b{display:block;color:var(--fg);font-weight:600;margin-bottom:.1em}.noroot a{color:var(--accent-ink)}',
    '.noroot .row,.accpop .row{display:flex;flex-wrap:wrap;gap:.4em;margin-top:.5em}',
    '.noroot .abtn,.accpop .abtn{font:inherit;font-size:.95em;font-weight:500;padding:.2em .7em;border-radius:7px;cursor:pointer;color:var(--fg);background:var(--fill2);border:0}',
    '.noroot .abtn.q,.accpop .abtn.q{background:transparent;color:var(--muted)}.noroot .abtn:hover,.accpop .abtn:hover{filter:brightness(1.05)}',
    '.composer.off .field>*{opacity:.55}',
    '.accpop.on{display:block}.accpop .lead{color:var(--fg);font-weight:600}.accpop p{margin:.15em 0}.accpop code{font-family:var(--mono);background:var(--code-bg,rgba(127,127,127,.12));padding:0 .3em;border-radius:4px}',
    '.accpop .row{display:flex;flex-wrap:wrap;gap:.4em;margin-top:.45em}',
    '.accpop .abtn:first-child{color:#fff;background:var(--accent-fill)}',
    '.drivebar.on{display:flex}.drivebar .t{flex:1 1 10em;min-width:0;white-space:normal;overflow-wrap:break-word}',
    '.drivebar .dd{width:.6em;height:.6em;border-radius:50%;background:var(--accent);flex:none}.drivebar.busy .dd{animation:ping 1.4s ease-out infinite}',
    '.drivebar .mini:disabled{opacity:.45;cursor:default}',
    // permission mode: under the message box, on agent cards, in the mode menu
    // Turn on page control (Manual) or Manual (page control), in the message box's bottom row.
    '.cfoot{display:contents}.cbar .pcon,.cbar .pcoff{padding:.25em .65em;white-space:nowrap}',
    '.pmode{display:none;align-items:center;gap:.4em;border:0;background:transparent;color:var(--muted);border-radius:6px;padding:.2em .5em;font:500 .8em/1.4 var(--sans);cursor:pointer;min-width:0;white-space:nowrap;overflow:hidden}',
    '.pmode.on{display:inline-flex}.pmode:hover{background:var(--fill);color:var(--fg)}',
    '.pmode.ro{cursor:help;font-weight:500}',
    '.pmode i,.amode i,.fm i{width:.55em;height:.55em;border-radius:50%;background:var(--mc,var(--faint));flex:none}',
    '.pmode .ms{color:var(--muted);font-weight:500;white-space:nowrap}',
    '[data-mode=acceptEdits]{--mc:var(--agent)}[data-mode=plan]{--mc:var(--ctx)}[data-mode=auto]{--mc:var(--warn)}[data-mode=bypassPermissions]{--mc:var(--del)}[data-mode=dontAsk]{--mc:var(--muted)}',
    '.pmode[data-mode=bypassPermissions],.amode[data-mode=bypassPermissions]{color:var(--del);border-color:color-mix(in srgb,var(--del) 45%,transparent);background:color-mix(in srgb,var(--del) 8%,transparent)}',
    '.amode{flex:none;display:inline-flex;align-items:center;gap:.35em;border:1px dashed var(--line2);background:transparent;color:var(--muted);border-radius:999px;padding:.15em .6em;font:500 .8em/1.3 var(--sans);cursor:pointer;white-space:nowrap}',
    '.amode.own{border-style:solid;color:var(--fg2);font-weight:600}.amode.ro{cursor:help}.amode:hover{border-color:var(--faint)}',
    '.fm{display:inline-flex;align-items:center;gap:.3em;margin-left:.15em;padding-left:.45em;border-left:1px solid var(--line2);color:var(--muted);font-size:.92em;white-space:nowrap}',
    '.lmenu.modes{width:min(320px,calc(100vw - 16px))}',
    '.lmenu .mt{display:flex;flex-direction:column;gap:2px;min-width:0}.lmenu .md{font-size:12px;font-weight:400;color:var(--muted);white-space:normal}',
    '.lmenu button.danger{color:var(--del)}',
    // Agents switcher: a small floating window beside the panel
    '.asw{position:fixed;pointer-events:auto;width:max-content;max-width:min(320px,calc(100vw - 16px));display:flex;flex-direction:column;background:var(--bg);color:var(--fg);',
    'border:1px solid var(--line2);border-radius:16px;box-shadow:var(--shadow);font:500 13.5px/1.35 var(--sans);opacity:0;visibility:hidden;transform:translateY(8px) scale(.97);transform-origin:bottom left;',
    'transition:opacity .18s ease,transform .22s cubic-bezier(.2,.8,.2,1),visibility 0s linear .22s}',
    '.asw.on{opacity:1;visibility:visible;transform:none;transition:opacity .18s ease,transform .22s cubic-bezier(.2,.8,.2,1)}',
    '.asw.open{width:min(var(--sww,320px),calc(100vw - 16px))}.asw.moving{transition:none;cursor:grabbing}',
    '.asw{overflow:hidden}.asw .swhead{flex:none}.asw .swbody{min-height:0;overflow:auto}',
    '.asw[data-size=s]{font-size:12.5px}.asw[data-size=l]{font-size:15px}',
    '.swhead{display:flex;align-items:center;gap:.5em;border:0;background:transparent;color:inherit;font:inherit;font-weight:600;padding:.5em .7em .5em .8em;cursor:pointer;border-radius:16px;touch-action:none;min-width:0}',
    '.swhead:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}',
    '.swhead svg{width:1.05em;height:1.05em;flex:none;color:var(--muted);transition:transform .2s;transform:rotate(180deg)}.asw.open .swhead svg{transform:none}',
    '.swt{white-space:nowrap}.asw.open .swt{flex:1}',
    '.swdots{display:flex;gap:3px;flex:none}.swdots i{width:.55em;height:.55em;border-radius:50%;background:var(--dc);flex:none}',
    '.swn{min-width:1.5em;padding:0 .45em;border-radius:999px;background:var(--agent);color:#fff;font-size:.8em;text-align:center;line-height:1.6;white-space:nowrap}.swn:empty{display:none}',
    '.swbody{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .24s cubic-bezier(.2,.8,.2,1),opacity .18s}',
    '.asw.open .swbody{grid-template-rows:1fr;opacity:1}.swin{overflow:hidden;min-height:0}',
    '.swlist{list-style:none;margin:0;padding:0 6px 6px;max-height:var(--swmax,420px);overflow-y:auto;' + THIN_SCROLL + '}',
    '.arow{position:relative;padding:.5em .6em .5em .9em;border-radius:10px;cursor:pointer;outline:0}',
    '.arow::before{content:"";position:absolute;left:.3em;top:.55em;bottom:.55em;width:3px;border-radius:2px;background:var(--ac)}',
    '.arow:hover{background:var(--sunk)}.arow:focus-visible{box-shadow:inset 0 0 0 2px var(--accent-line)}',
    '.arow.on{background:color-mix(in srgb,var(--ac) 11%,transparent)}.arow.done{color:var(--fg2)}.arow.done::before{opacity:.45}',
    '.arow .rt{display:flex;align-items:center;flex-wrap:wrap;gap:.25em .45em}',
    '.arow .rt i{width:.55em;height:.55em;border-radius:50%;background:var(--ac);flex:none;--ring:var(--ac)}.arow.run .rt i{animation:ping 1.4s ease-out infinite}',
    '.arow .rt b{font-weight:600;flex:1 1 8em;min-width:0;overflow-wrap:break-word}',
    '.arow .rt svg{width:.95em;height:.95em;color:var(--muted);flex:none}',
    '.arow .rm{display:inline-flex;align-items:center;gap:.3em;font-size:.78em;color:var(--muted);white-space:nowrap}.arow .rm::before{content:"";width:.5em;height:.5em;border-radius:50%;background:var(--mc,var(--faint))}',
    '.arow .swtime{font:500 .78em var(--mono);color:var(--muted);white-space:nowrap;margin-left:auto}',
    '.arow .rs{color:var(--fg2);font-size:.88em;margin-top:.15em;overflow-wrap:anywhere}',
    '.arow .rf{font:500 .8em var(--mono);color:var(--muted);margin-top:.1em;overflow-wrap:anywhere}',
    '.arow .ra{display:none;flex-wrap:wrap;gap:4px;margin-top:.45em}.arow.act .ra{display:flex}',
    '.arow .ra .mini{font-size:.8em;padding:.25em .6em}.arow .ra .mini.warn{color:var(--del);border-color:color-mix(in srgb,var(--del) 45%,transparent)}',
    '.arow .rmeta{font-size:.78em;color:var(--muted);margin-top:.15em;overflow-wrap:anywhere}.arow .rmeta .wait{color:var(--warn);font-weight:600}.arow .rmeta .bad{color:var(--del);font-weight:600}',
    '.rdet{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.3em .8em;margin:.5em 0 .1em;padding:.55em .65em;border-radius:9px;background:var(--raise);border:1px solid var(--line);font-size:.82em;cursor:auto}',
    '.rdet dt{color:var(--muted);white-space:nowrap}.rdet dd{margin:0;color:var(--fg2);overflow-wrap:anywhere;white-space:pre-wrap}.rdet dd.mono{font-family:var(--mono);font-size:.95em}',
    '.swhint{color:var(--muted);font-size:.78em;padding:.2em .9em .5em;line-height:1.4}',
    '.ofbar{display:none;align-items:center;flex-wrap:wrap;gap:.4em;margin:0 10px 6px;padding:.3em .4em .3em .7em;border-radius:9px;background:color-mix(in srgb,var(--ofc,var(--agent)) 9%,transparent);border:1px solid color-mix(in srgb,var(--ofc,var(--agent)) 35%,transparent);font-size:.82em;color:var(--fg2)}',
    '.ofbar.on{display:flex}.ofbar span{flex:1 1 10em;min-width:0;overflow-wrap:break-word}',
    '.feed>li.oh,.tfeed>li.oh{display:none}',
    '.lmenu .warnbox{padding:8px 9px;font-size:13px;line-height:1.45;color:var(--fg2)}.lmenu .warnbox b{color:var(--del)}',
    '.lmenu .confirm{background:var(--del);color:#fff;justify-content:center;font-weight:600;margin-top:4px}.lmenu .confirm:hover,.lmenu .confirm:focus-visible{background:var(--del);filter:brightness(1.08)}',
    '.signin{display:none;margin:0 14px 10px;padding:.7em .8em;border-radius:10px;border:1px solid var(--accent-line);background:var(--raise);font-size:.9em;color:var(--fg)}',
    '.signin.on{display:block}.signin p{margin:0 0 .5em;line-height:1.45;overflow-wrap:break-word}.signin .sub{color:var(--fg2);font-size:.92em}',
    '.signin .err{color:#b91c1c}.signin a{color:var(--accent)}',
    '.signin .allow{background:var(--accent-fill);color:#fff;border-color:var(--accent-fill)}.signin .allow:hover{background:var(--accent-ink)}',
    '.signin .row{display:flex;flex-wrap:wrap;gap:.5em;align-items:center;margin:.2em 0 .5em}',
    '.signin .code{flex:1;min-width:12em;font:inherit;padding:.35em .55em;border-radius:7px;border:1px solid var(--line2);background:var(--bg);color:var(--fg)}',
    '.k-perm{border-radius:12px;border:1px solid var(--accent-line);background:var(--raise);padding:.7em .8em;box-shadow:0 0 0 3px var(--accent-soft)}',
    '.k-perm .who{color:var(--accent-ink)}.k-perm.done{box-shadow:none;opacity:.8}',
    '.k-perm .pbody b{display:block;font-size:.95em;margin-bottom:.25em}',
    '.pnote{color:var(--muted);font-size:.88em;margin-bottom:.3em}',
    '.pwarn{color:var(--del);font-weight:600;font-size:.9em;margin:.1em 0 .35em;overflow-wrap:anywhere}',
    '.k-perm.warned{border-color:var(--del)}',
    '.pdetail{margin:.3em 0 0;padding:.5em .65em;border-radius:8px;background:var(--code-bg);font:.84em/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-height:12em;overflow:auto;' + THIN_SCROLL + '}',
    '.pdetail .rm{color:var(--del);text-decoration:line-through}.pdetail .ad{color:var(--add)}',
    '.pacts{display:flex;gap:6px;margin-top:.6em;flex-wrap:wrap}',
    '.pacts .allow{background:var(--accent-fill);color:#fff;border-color:var(--accent-fill)}.pacts .allow:hover{background:var(--accent-ink)}',
    '.pacts .deny{background:var(--del);color:#fff;border-color:var(--del)}.pacts .deny:hover{filter:brightness(1.08);background:var(--del)}',
    '.pres{font-weight:600;font-size:.88em}.k-perm.ok .pres{color:var(--add)}.k-perm.no .pres{color:var(--del)}',
    '.panel.driving .field{border-color:var(--accent-line)}',
    // panel shell
    '.panel{position:fixed;right:20px;bottom:20px;width:min(440px,calc(100vw - 40px));height:min(78vh,720px);display:flex;flex-direction:column;',
    'font-size:14px;line-height:1.5;background:var(--glass);-webkit-backdrop-filter:blur(24px) saturate(1.4);backdrop-filter:blur(24px) saturate(1.4);border-radius:16px;box-shadow:var(--shadow);pointer-events:auto;overflow:hidden;animation:rise .28s cubic-bezier(.2,.8,.2,1)}',
    '.panel[data-size=s]{font-size:13px}.panel[data-size=l]{font-size:15.5px}',
    '.panel.min,.panel.hidden{display:none}',
    '.panel:fullscreen,.dock:fullscreen,.panel.max,.dock.max{inset:0!important;left:0!important;top:0!important;right:0!important;bottom:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;border-radius:0!important;transform:none!important}',
    // In full screen the whole EditLens layer is the full-screen element and the panel or code view fills it.
    // No z-index: everything EditLens opens after it (panel, menus, toasts, questions) is drawn above.
    '.panel.max,.dock.max{position:fixed;z-index:auto}',
    '.panel{container-type:size}',
    // Show found the element under the panel: the panel turns see-through until the pointer moves back.
    '.panel.thru{opacity:.16;transition:opacity .2s ease}',
    '@container (max-height:560px){.head{padding:6px 8px 4px 10px}.head .mark{width:1.9em;height:1.9em}.filters{margin-bottom:4px}.composer:focus-within .hint{display:none}}',
    '@container (max-height:430px){.title{display:none}.drivebar .det{display:none}.agents{display:none}}',
    '@keyframes rise{from{opacity:0;transform:translateY(8px) scale(.985)}}',
    '.mark{display:grid;place-items:center;flex:none;color:#fff;border-radius:.55em;width:1.9em;height:1.9em;',
    'background:linear-gradient(160deg,#e9845d,#c4592f);box-shadow:inset 0 0 0 .5px rgba(255,255,255,.3)}',
    '.mark svg{width:58%;height:58%}',
    '.head{display:flex;align-items:center;flex-wrap:nowrap;gap:.6em;padding:12px 10px 10px 14px;min-width:0}',
    '.titles{display:flex;flex-direction:column;min-width:0;flex:1}',
    '.title{font-weight:600;font-size:.97em;line-height:1.3;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    // The header's one status line: dot or spinner, Working / Idle, then the mode (or what Claude does
    // now). Only there: other .sub elements (sign-in box lines, agent badges) are not changed.
    '.titles .sub{display:flex;align-items:center;gap:.4em;min-width:0;font-size:.82em;line-height:1.4;color:var(--muted);white-space:nowrap;overflow:hidden}',
    '.sub .status{font-size:1em;flex:none}.sub .status .label{white-space:nowrap}',
    '.smode{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}.smode:empty{display:none}',
    '.sub .now{flex:0 1 auto;margin:0;font-size:1em;color:var(--fg2);white-space:nowrap;overflow:hidden}.sub .now .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.sub .now:not(.busy){display:none}.sub:has(.now.busy:not(:empty)) .status,.sub:has(.now.busy:not(:empty)) .smode{display:none}',
    '.sub .now .spin{width:.8em;height:.8em;border-width:1.5px;border-color:var(--fill2);border-top-color:var(--accent)}',
    // A page from a paired computer: its name, in that computer's own colour.
    '.host{display:none;align-self:center;align-items:center;gap:.3em;padding:0 .5em;border-radius:99px;font-size:.95em;flex:none;font-weight:600;line-height:1.5;white-space:nowrap;color:var(--hc);background:color-mix(in srgb,var(--hc) 13%,transparent);border:1px solid color-mix(in srgb,var(--hc) 45%,transparent)}',
    '.host.on{display:inline-flex}',
    '.adot{width:.62em;height:.62em;border-radius:50%;border:1.5px solid currentColor;background:linear-gradient(90deg,currentColor 50%,transparent 50%);flex:none}',
    '.acc.err .adot{background:currentColor}',
    '.acc.err{color:var(--del);background:color-mix(in srgb,var(--del) 12%,transparent);border-color:color-mix(in srgb,var(--del) 40%,transparent)}',
    '.accerr{color:var(--del);font-weight:600}',
    '.status{display:flex;align-items:center;gap:.45em;font-size:.86em;line-height:1.45;color:var(--muted);white-space:nowrap;overflow:hidden;min-width:0}',
    '.status .label{white-space:normal;overflow-wrap:break-word}',
    '.dot{width:.55em;height:.55em;border-radius:50%;background:var(--faint);flex:none}',
    '.status.working .dot{width:.8em;height:.8em;background:none;border:1.5px solid var(--fill2);border-top-color:var(--accent);animation:spin .9s linear infinite}',
    '.status.idle .dot{background:var(--add)}',
    '.status.stopped .dot{background:var(--faint)}',
    '.status.listening .dot{background:var(--agent);animation:ping 2s ease-out infinite;--ring:var(--agent)}',
    '.status.offline .dot{background:var(--del)}',
    '@keyframes ping{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ring,var(--accent)) 55%,transparent)}100%{box-shadow:0 0 0 .5em transparent}}',
    '@keyframes blink{50%{opacity:.3}}',
    '.tools{display:flex;align-items:center;gap:2px;flex:none}',
    'button.icon{border:1px solid transparent;background:transparent;color:var(--muted);width:2em;height:2em;border-radius:.5em;cursor:pointer;display:grid;place-items:center;flex:none;transition:background .15s,color .15s,border-color .15s}',
    'button.icon svg{width:1.15em;height:1.15em}',
    'button.icon:hover{background:var(--fill);color:var(--fg)}',
    'button.icon:focus-visible{outline:2px solid var(--focus);outline-offset:1px}',
    'button.icon[aria-pressed=true]{background:var(--fill);color:var(--accent)}',
    '.meters.empty{display:none}',
    // Close buttons are red (the theme's own red), everywhere.
    'button.xred,button.icon.pkx{color:var(--del)}button.xred:hover,button.icon.pkx:hover{background:var(--del-bg);color:var(--del)}',
    'button.mini.xred{border-color:color-mix(in srgb,var(--del) 40%,transparent)}',
        'button.size{font-weight:600;font-size:.93em;letter-spacing:-.02em}',
    'button.listen{display:flex;align-items:center;gap:.4em;height:2.1em;padding:0 .8em 0 .65em;margin-right:4px;border-radius:999px;cursor:pointer;',
    'border:1px solid var(--line2);background:transparent;color:var(--muted);font-size:.86em;font-weight:600;flex:none;transition:all .15s}',
    'button.listen svg{width:1.15em;height:1.15em}',
    // Off: just the icon, so the header has room for the usage rings.
    'button.listen[aria-pressed=false]{width:2.1em;padding:0;justify-content:center}button.listen[aria-pressed=false] span{display:none}',
    'button.listen:hover{color:var(--fg);border-color:var(--faint)}',
    'button.listen[aria-pressed=true]{color:var(--agent-ink);background:var(--agent-soft);border-color:color-mix(in srgb,var(--agent) 40%,transparent)}',
    // subagent labels, tabs, activity line
    // usage rings and details
    '.meters{display:flex;gap:.3em;align-items:center;border:0;background:transparent;padding:.2em .3em;border-radius:.7em;cursor:pointer;flex:none}',
    '.meters:hover,.meters[aria-expanded=true]{background:var(--sunk)}',
    '.ring{position:relative;width:2.05em;height:2.05em;display:grid;place-items:center}',
    '.ring svg{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg)}',
    '.ring .trk{fill:none;stroke:var(--line2);stroke-width:3.2}',
    '.ring .arc{fill:none;stroke:var(--c);stroke-width:3.2;stroke-linecap:round;transition:stroke-dasharray .6s cubic-bezier(.2,.8,.2,1),stroke .3s}',
    '.ring.none .trk{stroke-dasharray:2.2 2.6}.ring.none .arc{opacity:0}',
    '.ring.hot .arc{stroke:var(--warn)}.ring.full .arc{stroke:var(--del)}',
    '.ring b{position:relative;font:700 .6em/1 var(--sans);color:var(--fg2);letter-spacing:-.02em}',
    '.ring.ctx{--c:var(--ctx)}.ring.ses{--c:var(--ses)}',
    '.usage{display:none;margin:0 14px 10px;padding:.8em .85em .7em;border-radius:12px;background:var(--raise);border:1px solid var(--line);font-size:.9em;max-height:46%;overflow:auto;' + THIN_SCROLL + '}',
    '.usage.on{display:block;animation:rise .2s ease-out}',
    // Settings card (More > Settings) and the quick tour.
    '.usage.settings{max-height:none;flex:1 1 auto;min-height:0;margin:0 12px 12px;padding:0;overflow:auto;background:transparent;border:0}',
    '.panel.sheet>.filters,.panel.sheet>.ofbar,.panel.sheet>.agents,.panel.sheet>.feed,.panel.sheet>.team,.panel.sheet>.drive-slot,.panel.sheet>.composer,.panel.sheet>.tour{display:none!important}',
    '.settings .shead{position:sticky;top:0;z-index:1;background:var(--bg);padding:.2em 0 .5em;margin:0;border-bottom:1px solid var(--line)}',
    '.settings .sback{display:inline-flex;align-items:center;gap:.35em;border:1px solid var(--line2);background:var(--raise);color:var(--fg);border-radius:8px;padding:.3em .75em;font:inherit;font-weight:600;cursor:pointer}',
    '.settings .sback:hover{border-color:var(--accent-line);background:var(--accent-soft)}',
    '.settings .sback:focus{outline:none}.settings .sback:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
    '.settings .snote{margin:.7em 0 .4em}',
    '.settings .sgroup{background:var(--raise);border:1px solid var(--line);border-radius:12px;padding:0 .85em;margin-top:.6em}',
    '.settings .sgroup .srow:first-child{border-top:0}',
    '.shead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:.3em}.shead b{font-size:1.05em}',
    '.snote{margin:0 0 .6em;color:var(--muted);font-size:.92em;line-height:1.45}',
    '.srow{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5em .9em;padding:.75em 0;border-top:1px solid var(--line)}',
    '.srow.wide{flex-direction:column;align-items:stretch}.srow.wide .slab,.srow.wide .sctl{flex:none}.srow.wide .sctl{align-items:stretch}',
    '.slab{display:flex;flex-direction:column;gap:2px;flex:1 1 14em;min-width:0}.stitle{font-weight:600;color:var(--fg)}',
    '.sdesc{color:var(--muted);font-size:.88em;line-height:1.4}',
    '.sctl{display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex:0 1 auto;max-width:100%}.sval{font-weight:600}',
    '.sw{position:relative;width:2.8em;height:1.6em;border-radius:999px;border:1px solid var(--line2);background:var(--sunk);cursor:pointer;padding:0;flex:none}',
    '.sw::after{content:"";position:absolute;top:.17em;left:.17em;width:1.16em;height:1.16em;border-radius:50%;background:var(--raise);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}',
    '.sw[aria-checked=true]{background:var(--accent);border-color:var(--accent)}.sw[aria-checked=true]::after{transform:translateX(1.2em)}',
    '.seg{display:flex;flex-wrap:wrap;gap:4px;padding:3px;background:var(--sunk);border:1px solid var(--line);border-radius:10px;max-width:100%}',
    '.seg button{flex:1 1 auto;border:1px solid transparent;background:transparent;color:var(--fg2);font:inherit;font-size:.92em;padding:.4em .75em;border-radius:7px;cursor:pointer;line-height:1.3;text-align:center}',
    '.seg button:hover{background:var(--raise);color:var(--fg)}',
    '.seg button[aria-checked=true]{background:var(--accent-fill);border-color:var(--accent-fill);color:#fff;font-weight:600}',
    '.seg button:focus-visible,.sw:focus-visible{outline:2px solid var(--accent);outline-offset:1px}',
    '.sfoot{display:flex;justify-content:flex-end;padding:.8em 0 .2em}',
    '.sfixed{color:var(--muted);font-size:.88em;text-align:right}.sfixed b{color:var(--fg);font-weight:600}',
    '.tour .tstep{color:var(--muted);font-size:.85em;margin-bottom:.2em}.tour b{display:block;font-size:1.05em;margin-bottom:.25em}',
    '.tour p{margin:0 0 .7em;line-height:1.5;color:var(--fg2)}.tour .tbtns{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}',
    '.tourfocus{outline:1.5px solid var(--accent)!important;outline-offset:2px;border-radius:8px;box-shadow:0 0 0 5px var(--accent-soft)}.feed.tourfocus{outline:0!important;box-shadow:inset 0 0 0 1.5px var(--accent-line)}',
    '.ucards{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '.ucard{border-radius:10px;padding:.6em .7em;background:var(--soft);min-width:0}',
    '.ucard.ctx{--soft:var(--ctx-soft);--c:var(--ctx)}.ucard.ses{--soft:var(--ses-soft);--c:var(--ses)}',
    '.ucard h4{margin:0 0 .25em;font-size:.78em;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--c)}',
    '.ubig{font:650 1.25em/1.2 var(--sans);letter-spacing:-.01em;color:var(--fg)}',
    '.ubig small{font-size:.62em;font-weight:500;color:var(--muted);margin-left:.3em}',
    '.usub{color:var(--muted);font-size:.86em;line-height:1.45;margin-top:.2em}',
    '.stack{display:flex;height:.42em;border-radius:99px;overflow:hidden;background:var(--line);margin:.5em 0 .35em}',
    '.stack i{display:block;height:100%}',
    '.stack .s1{background:var(--c)}.stack .s2{background:color-mix(in srgb,var(--c) 55%,transparent)}.stack .s3{background:color-mix(in srgb,var(--c) 28%,transparent)}',
    '.legend{display:flex;flex-wrap:wrap;gap:.2em .7em;font-size:.8em;color:var(--muted)}',
    '.legend span::before{content:"";display:inline-block;width:.6em;height:.6em;border-radius:2px;margin-right:.3em;background:var(--k);vertical-align:-.02em}',
    '.lim{margin-top:.35em}.lim .lt{display:flex;justify-content:space-between;gap:.5em;font-size:.86em}',
    '.lim .lb{height:.36em;border-radius:99px;background:var(--line);overflow:hidden;margin-top:.2em}.lim .lb i{display:block;height:100%;background:var(--c)}',
    '.ugrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px 10px;margin-top:.75em}',
    '.ugrid div{min-width:0}.ugrid dt{font-size:.76em;color:var(--faint);text-transform:uppercase;letter-spacing:.04em}',
    '.ugrid dd{margin:0;font:600 .95em/1.35 var(--sans);color:var(--fg);white-space:normal;overflow-wrap:anywhere}',
    '.unote{margin-top:.65em;font-size:.8em;color:var(--faint);line-height:1.45}',
    '.agents{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 8px}',
    '.panel:not([data-filter=agents]) .agents{display:none}',
    '.agents:empty{display:none}',
    '.chip{flex:none;display:flex;align-items:center;gap:.45em;border:1px solid color-mix(in srgb,var(--agent) 30%,transparent);background:var(--agent-soft);color:var(--fg2);',
    'border-radius:14px;padding:.3em .8em .3em .55em;font-size:.86em;cursor:pointer;max-width:100%}',
    '.chip span{white-space:normal;overflow-wrap:anywhere;text-align:left}',
    '.chip .spin{width:.8em;height:.8em;border-width:2px}',
    '.chip.done .spin{animation:none;border-color:var(--add);background:var(--add)}',
    '.chip.failed .spin{animation:none;border-color:var(--del);background:var(--del)}',
    // The line under the status: its spinner spins only while Claude works (the text can remain after).
    '.now:not(.busy) .spin{display:none}',
    '.chip.failed .spin{animation:none;border-color:var(--del);background:var(--del)}',
    '.filters{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;margin:0 12px 10px;padding:2px;background:var(--fill);border-radius:8px}',
    '.filters button{border:0;background:transparent;color:var(--muted);font-size:.84em;font-weight:500;padding:.25em .3em;border-radius:6px;cursor:pointer;transition:color .15s;white-space:nowrap}',
    '.filters .nb.run{background:var(--agent)}',
    '.filters button:hover{color:var(--fg)}',
    '.filters button[aria-pressed=true]{background:var(--raise);color:var(--fg);box-shadow:0 1px 2px rgba(0,0,0,.12),0 0 0 .5px var(--line)}',
    // What Claude is doing: a line across the header, under the title.
    '.now{display:flex;align-items:center;gap:.45em;flex:1 1 100%;margin:0;color:var(--fg2);font-size:.82em;line-height:1.4;min-width:0}',
    '.now:empty{display:none}',
    '.now .t{white-space:normal;overflow-wrap:anywhere;min-width:0}',
    '.now .spin{border-color:var(--accent);border-right-color:transparent}',
    // team board
    '.filters button .nb{display:inline-block;min-width:1.5em;margin-left:.3em;padding:0 .35em;border-radius:99px;background:var(--accent-fill);color:#fff;font-size:.78em;font-weight:700;line-height:1.5}',
    '.filters button .nb:empty{display:none}',
    '.team{display:none;flex-direction:column;flex:1;min-height:0;border-top:1px solid var(--line)}',
    '.panel[data-filter=team] .feed{display:none}.panel[data-filter=team] .team{display:flex}',
    '.thead{display:flex;align-items:center;gap:6px;padding:10px 14px 8px;flex:none}',
    '.roster{display:flex;flex-wrap:wrap;gap:6px;flex:1;min-width:0}',
    '.mate{flex:none;display:flex;align-items:center;gap:.4em;border-radius:999px;padding:.25em .7em .25em .5em;font-size:.84em;color:var(--fg2);',
    'background:color-mix(in srgb,var(--ac) 10%,transparent);border:1px solid color-mix(in srgb,var(--ac) 32%,transparent)}',
    '.mate i{width:.6em;height:.6em;border-radius:50%;background:var(--ac);flex:none}',
    '.mate.live i{animation:ping 1.6s ease-out infinite;--ring:var(--ac)}',
    '.mate.left{opacity:.6}',
    '.mate small{color:var(--faint)}',
    '.claims{flex:none;margin:0 12px 6px;display:flex;flex-wrap:wrap;align-items:center;gap:5px}',
    '.claims .ch{font-size:.72em;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);font-weight:700;margin-right:.2em}',
    '.claims:empty{display:none}',
    '.claim{display:flex;gap:.4em;align-items:center;padding:.2em .6em .2em .5em;border-radius:999px;background:var(--raise);border:1px solid var(--line2);font:600 .82em var(--sans);color:var(--fg2);cursor:pointer;min-width:0}',
    '.claim:hover{border-color:var(--ac)}.claim i{width:.55em;height:.55em;border-radius:50%;background:var(--ac);flex:none}.claim small{color:var(--faint);font-weight:500}',
    '.post.flash{animation:postflash 1.2s ease-out}',
    '@keyframes postflash{0%{background:color-mix(in srgb,var(--ac) 22%,transparent)}100%{background:transparent}}',
    '.tfeed{list-style:none;margin:0;padding:6px 14px 18px;overflow:auto;flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;overscroll-behavior:contain;' + THIN_SCROLL + '}',
    '.tfeed>*{flex:none}',
    '.post{border-left:3px solid var(--ac);padding:.15em 0 .2em .7em;font-size:.93em;line-height:1.5;color:var(--fg2);overflow-wrap:anywhere}',
    '.post .ph{display:flex;align-items:baseline;gap:.5em;font-size:.86em;margin-bottom:.1em}',
    '.post .ph b{color:var(--ac);font-weight:650}',
    '.post .ph .id,.post .ph time{color:var(--faint);font-size:.95em}',
    '.post .ph time{margin-left:auto}',
    '.badge{font-size:.78em;font-weight:700;letter-spacing:.03em;text-transform:uppercase;padding:.05em .45em;border-radius:5px;background:var(--sunk);color:var(--muted)}',
    '.badge.decision{background:var(--accent-soft);color:var(--accent)}.badge.blocker{background:color-mix(in srgb,var(--del) 14%,transparent);color:var(--del)}',
    '.badge.question{background:var(--api-soft);color:var(--api-ink)}.badge.finding{background:var(--agent-soft);color:var(--agent-ink)}',
    '.badge.done{background:color-mix(in srgb,var(--add) 14%,transparent);color:var(--add)}',
    '.post .re{color:var(--faint);font-size:.86em}',
    '.post .loc{display:inline-block;font-family:var(--mono);font-size:.88em;margin-bottom:.1em}',
    '.post.quiet{border-left-color:transparent;padding-left:calc(.7em + 3px);color:var(--faint);font-size:.84em}',
    '.post.quiet b{color:var(--ac)}',
    // feed
    '.feed{list-style:none;margin:0;padding:14px 14px 18px;overflow:auto;flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;',
    'border-top:.5px solid var(--line);overscroll-behavior:contain;outline:none;' + THIN_SCROLL + '}',
    '.feed:focus-visible{box-shadow:inset 0 0 0 2px var(--focus)}',
    '.feed>*{flex:none}',
    '.empty{padding:32px 24px;color:var(--muted);text-align:center;margin:auto 0;line-height:1.6}',
    '.feed[data-filter=chat] .k-edit,.feed[data-filter=chat] .k-copy,.feed[data-filter=chat] .k-steps,.feed[data-filter=chat] .k-point{display:none}',
    '.feed[data-filter=edits] > :not(.k-edit):not(.k-copy):not(.k-missed){display:none}',
    '.feed[data-filter=agents] > :not(.k-agent){display:none}',
    // chat
    '.who{font-size:.86em;font-weight:600;color:var(--fg);margin-bottom:.2em;display:flex;gap:.5em;align-items:baseline}',
    '.k-claude{display:flex;gap:.65em;align-items:flex-start}',
    '.k-claude .mark{width:1.75em;height:1.75em;border-radius:50%;margin-top:.1em}',
    '.k-claude .body{flex:1;min-width:0}',
    '.md{color:var(--fg2);overflow-wrap:anywhere}',
    '.md strong{color:var(--fg);font-weight:600}',
    '.md p{margin:0 0 .55em}.md p:last-child{margin-bottom:0}',
    '.md p.h{font-weight:600;color:var(--fg);margin-top:.3em}',
    '.md ul{margin:.15em 0 .55em;padding-left:1.25em}.md li{margin:.1em 0}',
    '.md code{font:.88em var(--mono);background:var(--sunk);border:1px solid var(--line);padding:.05em .35em;border-radius:5px}',
    '.md pre{font:.86em/1.55 var(--mono);background:var(--sunk);border:1px solid var(--line);padding:.7em .85em;border-radius:10px;overflow:auto;margin:.35em 0 .6em;white-space:pre;' + THIN_SCROLL + '}',
    '.md p.h1{font-size:1.16em}.md p.h2{font-size:1.07em}',
    '.md ol{margin:.15em 0 .55em;padding-left:1.6em}.md li>ul,.md li>ol{margin:.1em 0 .2em}',
    '.md blockquote{margin:.3em 0 .6em;padding:.1em 0 .1em .8em;border-left:3px solid var(--line2);color:var(--muted)}',
    '.md hr{border:0;border-top:1px solid var(--line);margin:.6em 0}',
    '.md .tbl{overflow:auto;margin:.35em 0 .6em;' + THIN_SCROLL + '}',
    '.md table{border-collapse:collapse;font-size:.93em}.md th,.md td{border:1px solid var(--line);padding:.3em .6em;text-align:left;vertical-align:top}',
    '.md th{background:var(--sunk);color:var(--fg);font-weight:600}',
    '.md .cblock{position:relative}.md .cblock pre{padding-right:4.6em}',
    '.cpy{display:inline-flex;align-items:center;gap:.3em;border:0;border-radius:6px;padding:.15em .45em;font:500 .74rem/1.4 var(--sans);color:var(--muted);background:transparent;cursor:pointer;white-space:nowrap}',
    '.cpy svg{width:1.05em;height:1.05em}.cpy:hover{color:var(--fg);background:var(--fill)}.cpy.done,.cpy.done:hover{color:var(--add)}',
    '.cpy.ccopy{position:absolute;top:.4em;right:.4em;background:var(--raise);box-shadow:0 0 0 .5px var(--line2)}',
    '@media (hover:hover){.cblock .ccopy{opacity:0;transition:opacity .15s}.cblock:hover .ccopy,.cblock .ccopy:focus-visible,.cblock .ccopy.done{opacity:1}',
    '.k-claude .rcopy{opacity:0;transition:opacity .15s}.k-claude:hover .rcopy,.k-claude .rcopy:focus-visible,.k-claude .rcopy.done{opacity:1}}',
    '.who .rcopy{margin-left:auto;align-self:center}',
    '.k-user .bubble.withshots{width:min(100%,19em)}',
    '.bshots{display:grid;gap:2px;margin:-.45em -.85em .45em;border-radius:16px 16px 0 0;overflow:hidden}',
    '.bshots.n2{grid-template-columns:1fr 1fr}.bshots.n3{grid-template-columns:1fr 1fr 1fr}',
    '.bshot{display:block;line-height:0;background:var(--sunk);cursor:zoom-in}.bshot img{display:block;width:100%;max-height:220px;object-fit:cover}',
    '.bshots.n2 .bshot img,.bshots.n3 .bshot img{height:96px}.bshot.gone{display:none}',
    '.shots{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 6px}.shots:empty{display:none}',
    '.shot{display:inline-flex;align-items:center;gap:.5em;max-width:100%;padding:4px 6px 4px 4px;border-radius:9px;background:var(--fill);box-shadow:0 0 0 .5px var(--line2);font-size:.82em}',
    '.shot img{width:44px;height:30px;object-fit:cover;border-radius:5px;flex:none;background:var(--sunk)}.shot.up img{opacity:.5}',
    '.shot .st{display:flex;flex-direction:column;min-width:0;line-height:1.3}.shot .st b{font-weight:600;color:var(--fg)}.shot .st small{color:var(--muted);white-space:nowrap}',
    '.shot .sx{width:1.6em;height:1.6em;flex:none;display:grid;place-items:center;padding:0;border:0;border-radius:50%;background:var(--fill2);color:var(--muted);font-size:.85em;cursor:pointer}.shot .sx:hover{color:var(--fg)}',
    '.shoterr{display:flex;align-items:center;gap:.45em;margin:0 0 6px;padding:0 .2em;font-size:.82em;color:var(--warn)}.shoterr[hidden]{display:none}.shoterr svg{width:1.1em;height:1.1em;flex:none}',
    '.k-user{align-self:flex-end;max-width:86%;display:flex;flex-direction:column;align-items:flex-end}',
    '.k-user .who{color:var(--muted);font-weight:500}',
    '.k-user .bubble{background:var(--bubble);color:var(--fg);border-radius:16px 16px 4px 16px;padding:.45em .85em}',
    '.k-user .bubble .md{color:var(--fg)}',
    '.k-user.page .bubble{background:var(--accent-fill);color:#fff}.k-user.page .bubble .md,.k-user.page .bubble .md strong{color:#fff}',
    // File references on the orange bubble: white, with a light underline and code box.
    '.k-user.page .bubble a.fref,.k-user.page .bubble a.fref code{color:#fff;text-decoration-color:rgba(255,255,255,.7)}',
    '.k-user.page .bubble a.fref code{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.4)}',
    '.k-user .state{font-size:.82em;color:var(--muted);margin-top:.3em}',
    '.k-user .state.ok{color:var(--add)}',
    '.k-user .state.gone{text-decoration:none;color:var(--faint)}',
    '.k-user .state.wait{display:flex;flex-direction:column;align-items:flex-end;gap:.35em;text-align:right;max-width:30em;line-height:1.45}',
    '.k-user .state .acts{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}',
    '.k-steps{display:flex;flex-wrap:wrap;gap:6px;padding-left:2.4em;margin-top:-4px}',
    '.step{font:.86em/1.75 var(--mono);color:var(--muted);background:var(--sunk);border:1px solid var(--line);border-radius:7px;padding:0 .6em;max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere}',
    '.step b{font-family:var(--sans);font-weight:600;color:var(--fg2);margin-right:.15em}',
    // edit cards
    '.k-edit{padding:.6em .75em;border-radius:10px;background:var(--raise);border:0;box-shadow:var(--card);cursor:pointer;transition:box-shadow .15s}',
    '.k-edit:hover{box-shadow:0 0 0 .5px var(--line2),0 2px 6px rgba(0,0,0,.08)}',
    // The edit's number, the same as its marker on the page: filled until the user has seen it.
    '.eno{flex:none;display:inline-grid;place-items:center;min-width:1.7em;height:1.7em;padding:0 .3em;border-radius:99px;background:var(--accent-fill);color:#fff;font:600 .66em/1 var(--sans)}',
    '.eno.seen{background:transparent;color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}',
    '.k-edit .file{font:600 .9em/1.35 var(--sans)}.k-edit .file .dir{color:var(--faint);font-weight:400}',
    '.rconf{margin-top:.55em;padding:.55em .65em;border-radius:9px;border:1px solid var(--line2);background:var(--bg);cursor:default}',
    '.rconf .rq{font-size:.9em;margin-bottom:.4em;overflow-wrap:anywhere}',
    // Undo only this edit: the conflict line is dim; "Claude is undoing it" is a label like the tags.
    '.rconf .rdim{font-size:.86em;color:var(--muted);margin-bottom:.3em;overflow-wrap:anywhere}',
    // No copy of the file can be kept for Undo: the question is marked, and its button is red.
    '.rconf.nound{border-color:var(--warn);box-shadow:inset 3px 0 0 var(--warn)}',
    '.enote .mini.deny{background:var(--del);color:#fff;border-color:var(--del)}',
    '.k-edit .uask{background:var(--agent-soft);color:var(--fg2)}.chlist .chi .uask{color:var(--fg2);font-style:italic}',
    '.enote.undid{display:flex;align-items:center;gap:.5em;flex-wrap:wrap;color:var(--ctx)}',
    // A restore (Restore, Undo, Remove file, Merge undone) is the user's action: teal, not Claude's color.
    'div,button,span{--rst:var(--ctx)}',
    '.k-edit.restore{box-shadow:0 0 0 1px color-mix(in srgb,var(--ctx) 45%,transparent)}.k-edit.restore .tool,.k-edit .rtag{background:var(--ctx-soft);color:var(--ctx)}',
    '.k-edit.restore .eno{background:var(--ctx)}.k-edit.restore .eno.seen{background:transparent;color:var(--ctx);box-shadow:inset 0 0 0 1px var(--ctx)}',
    '.k-edit.restored .diff,.k-edit.restored .stat{opacity:.55}',
    '.emark.rst{background:var(--ctx)}.emark.rst.seen{background:var(--raise);color:var(--ctx);box-shadow:inset 0 0 0 1px var(--ctx),0 0 0 2px var(--raise)}',
    '.pane.rstd .cl.add{background:var(--ctx-soft);box-shadow:inset 3px 0 0 var(--ctx)}.pane.rstd .cl.add .no{color:var(--ctx)}.pane.rstd .cl.recent{box-shadow:inset 3px 0 0 var(--ctx)}',
    '.pcap.rst{background:var(--ctx-soft)}.pcap.rst .mark{display:none}.pcap .rlab{display:none}',
    '.pcap.rst .rlab{display:inline-block;flex:none;font:700 .8em/1 var(--sans);text-transform:uppercase;letter-spacing:.04em;padding:.35em .5em;border-radius:5px;background:var(--ctx);color:var(--bg)}',
    '.cnote.sys{background:var(--sunk);color:var(--fg2)}.cnote.sys::before{content:none}',
    '.pkbadge.rst{background:var(--ctx-soft);color:var(--ctx)}.pknote.rnote{color:var(--ctx);font-weight:600}',
    '.chlist .chr{display:flex;flex-wrap:wrap;align-items:flex-start;gap:4px}.chlist .chr>.chi{flex:1 1 0;min-width:0}.chlist .chrst{flex:none;margin-top:5px;font-size:.84em}',
    '.chlist .chr>.rconf{flex:1 0 100%;margin:0 0 .4em}.chlist .chi.restored .f,.chlist .chi.restored .m{opacity:.6}.chlist .chi .rb{color:var(--ctx);font-weight:600}',
    '.toast .mini{margin-left:.4em}',
    '.k-edit.sel{box-shadow:0 0 0 1.5px var(--sel);background:var(--sel-soft)}',
    '.k-edit.incopy{box-shadow:0 0 0 .5px var(--line2);background:transparent}',
    '.enote{margin-top:.45em;font-size:.86em;color:var(--muted);line-height:1.45}.enote.warn{color:var(--del);font-weight:600}',
    '.k-copy{padding:.65em .8em;border-radius:10px;background:var(--raise);border:0;box-shadow:var(--card)}',
    '.k-copy.fresh{animation:flash 1.4s ease-out}.k-copy.done{opacity:.85}',
    '.k-copy .ctitle{font-weight:600;color:var(--fg);flex:1;min-width:0;overflow-wrap:anywhere}',
    '.cfiles{list-style:none;margin:.5em 0 0;padding:0;display:flex;flex-direction:column;gap:4px}',
    '.cf{display:flex;align-items:center;gap:.5em;flex-wrap:wrap;font-size:.93em}.cf .file{flex:1 1 9em}',
    '.cst{font:600 .8em/1 var(--sans);padding:.35em .5em;border-radius:6px;background:var(--sunk);color:var(--fg2);flex:none}',
    '.cf.clean .cst{background:var(--accent-soft);color:var(--accent-ink)}',
    '.cf.conflict .cst{background:color-mix(in srgb,var(--del) 14%,transparent);color:var(--del)}',
    '.cf.same .cst{color:var(--faint)}.cf.same .file{color:var(--muted)}',
    '.cwhy{font-size:.86em;color:var(--muted)}.cf.more{color:var(--muted);font-size:.86em}',
    '.k-missed{padding:.65em .8em;border-radius:10px;background:var(--raise);border:0;box-shadow:0 0 0 1px var(--accent-line)}.k-missed .ctitle{font-weight:600;color:var(--fg);flex:1;min-width:0;overflow-wrap:anywhere}',
    '.k-edit.fresh{animation:flash 1.4s ease-out}',
    '@keyframes flash{from{background:var(--accent-soft)}}',
    '.row{display:flex;align-items:center;gap:.55em;min-width:0}',
    // A narrow panel: the buttons go under the file name so it keeps its width.
    '.k-edit .row{flex-wrap:wrap}.k-edit .row .file{flex:1 1 6em}',
    '.tool{font:500 .78em/1 var(--sans);color:var(--muted);background:var(--fill);padding:.35em .55em;border-radius:99px;flex:none;white-space:nowrap}',
    '.file{font:500 .93em/1.35 var(--mono);color:var(--fg);white-space:normal;overflow-wrap:break-word;flex:1;min-width:0}',
    '.stat{font:600 .86em var(--mono);flex:none}.plus{color:var(--add)}.minus{color:var(--del);margin-left:.4em}',
    '.ago{font-size:.86em;color:var(--faint);flex:none;min-width:2.2em;text-align:right}',
    '.sess{display:none;font-size:.86em;color:var(--muted);margin-top:2px}.sess.on{display:block}',
    '.why{color:var(--fg2);font-size:.93em;line-height:1.5;margin-top:.4em}',
    '.uses{margin-top:.55em;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:.86em;color:var(--muted)}',
    '.route{font:600 .96em var(--mono);color:var(--api-ink);background:var(--api-soft);border-radius:6px;padding:.1em .5em}',
    '.mini{border:0;background:var(--fill2);color:var(--fg);border-radius:7px;padding:.2em .7em;font-weight:500;cursor:pointer}',
    '.mini:hover{background:var(--fill2);filter:brightness(.97)}',
    '.mini.pcon{background:var(--accent-fill);border-color:var(--accent-fill);color:#fff;white-space:nowrap}.mini.pcon:hover{background:var(--accent);filter:brightness(1.08)}',
    '.k-user .state.drv .pcon,.cbar .pcon,.cbar .pcoff{font-size:.78em}.k-user .state.drv .pcon{display:none}',
    '.mini.primary{background:var(--accent-fill);border-color:var(--accent-fill);color:#fff}.mini.primary:hover{filter:brightness(1.06);background:var(--accent)}.mini:disabled{opacity:.45;cursor:default}',
    '.diff{display:none;margin:.65em 0 .1em;border:1px solid var(--line);border-radius:10px;overflow:auto;max-height:260px;background:var(--sunk);font:.86em/1.6 var(--mono);cursor:text;' + THIN_SCROLL + '}',
    '.k-edit.open .diff{display:block}',
    '.ln{white-space:pre;padding:0 .8em;min-width:max-content;color:var(--fg2)}',
    '.ln.a{background:var(--add-bg);color:var(--add)}.ln.d{background:var(--del-bg);color:var(--del)}.ln.h{color:var(--muted);background:var(--line);padding:.1em .8em}',
    // code on hover
    '.peek{position:fixed;left:0;top:0;display:none;flex-direction:column;gap:.45em;width:max-content;min-width:min(260px,calc(100vw - 16px));max-width:min(460px,calc(100vw - 16px));max-height:min(62vh,460px);',
    'overflow:auto;padding:.7em .8em;background:var(--bg);color:var(--fg);border-radius:12px;box-shadow:var(--shadow);font:14px/1.5 var(--sans);pointer-events:auto;z-index:6;cursor:pointer;' + THIN_SCROLL + '}',
    '.peek.on{display:flex}.peek.pinned{cursor:default;outline:2px solid var(--accent-line)}',
    '.peek[data-size=s]{font-size:12.5px}.peek[data-size=l]{font-size:15.5px}',
    '.pkhead{display:flex;align-items:center;gap:.5em;flex-wrap:wrap;min-width:0}',
    '.pkbadge{font-size:.78em;font-weight:700;border-radius:999px;padding:.05em .6em;background:var(--sunk);color:var(--fg2);flex:none}',
    '.pkbadge.add{background:var(--add-bg);color:var(--add)}.pkbadge.del{background:var(--del-bg);color:var(--del)}.pkbadge.css,.pkbadge.txt{background:var(--accent-soft);color:var(--accent-ink)}.pkbadge.api{background:var(--api-soft);color:var(--api-ink)}',
    '.pkfile{font:600 .9em var(--mono);overflow-wrap:anywhere;min-width:0}',
    '.pkapprox{font-size:.78em;color:var(--muted);border:1px dashed var(--line2);border-radius:999px;padding:0 .5em;flex:none}',
    '.pkwho{display:flex;align-items:center;gap:.4em;flex-wrap:wrap;font-size:.86em;color:var(--muted)}',
    '.pkwho i{width:.6em;height:.6em;border-radius:50%;background:var(--fc,var(--accent));flex:none}',
    '.pkwho span:first-of-type{color:var(--fg2);font-weight:600}',
    '.pkstep{display:flex;align-items:center;gap:.5em;font-size:.86em;color:var(--muted)}',
    '.pknote{font-size:.86em;color:var(--fg2);overflow-wrap:anywhere}',
    '.pkcode{border:1px solid var(--line);border-radius:9px;overflow:auto;background:var(--sunk);font:.86em/1.6 var(--mono);cursor:text;flex:none;max-height:none;' + THIN_SCROLL + '}',
    '.pkcode mark{background:color-mix(in srgb,currentColor 22%,transparent);color:inherit;border-radius:3px}',
    '.pkall{align-self:flex-start}',
    '.pkacts{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.pkgap{flex:1}',
    '.pkhint{font-size:.8em;color:var(--faint)}',
    '.pkx{flex:none}',
    '.peekbox{position:fixed;display:none;border:1.5px dashed var(--accent);border-radius:7px;pointer-events:none}.peekbox.on{display:block}',
    '.ghost{position:fixed;border:2px dashed var(--del);border-radius:6px;background:var(--del-bg);pointer-events:none}',
    '.ghost .tag{position:absolute;left:-2px;top:-1.7em;background:var(--del);color:#fff;font:600 11px/1.6 var(--sans);padding:0 .5em;border-radius:5px;white-space:nowrap}',
    // subagent cards
    '.k-agent{border-radius:10px;border:0;background:var(--raise);box-shadow:var(--card);overflow:hidden}',
    '.k-agent .ahead{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:.65em;padding:.6em .75em;cursor:pointer}',
    '.k-agent .abadge{grid-row:1/4;width:1.85em;height:1.85em;border-radius:.55em;display:grid;place-items:center;background:color-mix(in srgb,var(--agent) 16%,transparent);color:var(--agent);font:700 .8em/1 var(--sans)}',
    '.k-agent .abadge svg{width:1.35em;height:1.35em;stroke-width:2.4}',
    '.k-agent.done .abadge{background:var(--fill);color:var(--add)}.k-agent.failed .abadge{background:var(--fill);color:var(--del)}',
    '.k-agent .atop{display:flex;align-items:center;flex-wrap:wrap;gap:.5em;min-width:0}',
    '.k-agent .ameta{display:flex;align-items:center;gap:.45em;min-width:0;font-size:.82em;color:var(--muted);margin-top:.1em}',
    '.k-agent .atype{color:var(--muted);white-space:nowrap}.k-agent .atype::before{content:"· "}',
    '.k-agent .aprog{height:3px;border-radius:2px;background:var(--fill2);margin-top:.5em;overflow:hidden;position:relative}',
    '.k-agent .aprog i{position:absolute;top:0;bottom:0;width:40%;border-radius:2px;background:var(--agent);animation:aprog 1.6s ease-in-out infinite}',
    '.k-agent.done .aprog,.k-agent.failed .aprog{display:none}',
    '@keyframes aprog{from{left:-40%}to{left:100%}}',
    '@media (prefers-reduced-motion:reduce){.k-agent .aprog i{animation:none;left:0}}',
    '.k-agent .adesc{flex:1 1 8em;min-width:0;white-space:normal;overflow-wrap:anywhere;font-weight:600;color:var(--fg)}',
    '.k-agent .afollow{flex:none}',
    '.k-agent .astate{color:var(--muted);display:flex;align-items:center;gap:.4em;min-width:0}.k-agent .astate span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.k-agent.done .astate{color:var(--fg)}',
    '.k-agent .abody{display:none;padding:.15em .85em .8em;border-top:.5px solid var(--line)}',
    '.k-agent.open .abody{display:block}',
    '.k-agent .asteps{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding-top:.6em;max-height:240px;overflow:auto;' + THIN_SCROLL + '}',
    '.k-agent .atext{font-size:.93em}',
    '.k-agent .aresult{margin-top:.7em;padding-top:.6em;border-top:.5px solid var(--line);font-size:.93em}',
    '.spin{width:.85em;height:.85em;border:1.5px solid var(--fill2);border-top-color:var(--accent);border-radius:50%;animation:spin .9s linear infinite;flex:none}',
    '.k-agent .spin{border-top-color:var(--agent)}',
    '@media (prefers-reduced-motion:reduce){.spin{animation:none}}',
    '@keyframes spin{to{transform:rotate(360deg)}}',
    '.k-point{--pc:var(--add);display:flex;align-items:center;gap:.6em;padding:.1em 0;font-size:.9em;color:var(--muted);cursor:pointer}',
    '.k-point .pring{flex:none;width:1.45em;height:1.45em;border-radius:50%;border:1.5px solid var(--pc);color:var(--pc);display:grid;place-items:center;font-size:.8em}',
    '.k-point .ptext{flex:1;min-width:0;overflow-wrap:anywhere}.k-point:hover .ptext{color:var(--fg2)}',
    '.k-update{display:flex;align-items:center;gap:.7em;padding:.6em .85em;border-radius:12px;background:var(--api-soft);color:var(--fg2);font-size:.93em}',
    '.k-update span{flex:1}',
    '.updbar{display:flex;flex-wrap:wrap;align-items:center;gap:.3em .7em;margin:0 12px 8px;padding:.55em .8em;border-radius:10px;background:var(--api-soft);color:var(--fg2);font-size:.86em;line-height:1.4}',
    '.updbar[hidden]{display:none}.updbar b{color:var(--fg);font-weight:600}.updbar .ut{flex:1 1 14em}.updbar .ut span{display:block}',
    '.k-point b{color:var(--fg);font-weight:600}',
    // composer
    // The message box: frosted glass over the bottom of the feed, 12 px in from the panel's edges. It
    // grows upward as lines are typed (autoGrow); notices and the page control bar sit above it.
    '.composer{position:absolute;left:12px;right:12px;bottom:12px;z-index:2;display:flex;flex-direction:column;gap:6px;pointer-events:none}',
    '.composer>*{pointer-events:auto}',
    '.field{--gshade:0 -10px 30px -12px rgba(0,0,0,.28);display:flex;flex-direction:column;gap:2px;min-height:0;border:0;border-radius:14px;padding:9px 10px 7px 12px;',
    'color:var(--gfg);background:var(--gbox);-webkit-backdrop-filter:blur(14px) saturate(1.5);backdrop-filter:blur(14px) saturate(1.5);box-shadow:var(--gline),var(--gshade);transition:box-shadow .15s}',
    '.field:focus-within{box-shadow:0 0 0 1px var(--accent-line),var(--gshade)}',
    // No blur in this browser, or the system asks for less transparency: a solid box.
    '.field.solid{background:var(--gsolid);-webkit-backdrop-filter:none;backdrop-filter:none}',
    '@media (prefers-reduced-transparency:reduce){.field{background:var(--gsolid);-webkit-backdrop-filter:none;backdrop-filter:none}}',
    '.field>.atts{margin:0 0 4px}',
    '.composer>.noroot,.composer>.accpop{margin:0;background:var(--gsolid);box-shadow:var(--gline),0 -10px 30px -12px rgba(0,0,0,.28)}',
    '.composer>.drivebar{margin:0;background:linear-gradient(var(--accent-soft),var(--accent-soft)),var(--gsolid)}.composer>.signin{margin:0}',
    // One row; with no room, controls move to the next line instead of getting shorter. Only a mode
    // label wider than a whole line ends in "…".
    '.cbar{display:flex;flex-wrap:wrap;align-items:center;gap:4px;row-gap:4px;min-width:0;margin-left:-6px}',
    '.cbar .pmode>span:not(.ms){min-width:0;overflow:hidden;text-overflow:ellipsis}',
    // "N lines" (once the text is over 3 lines), the mic and Send are one group on the right; when the
    // row wraps they move to the next line together and stay on the right.
    '.cend{display:flex;align-items:center;gap:4px;margin-left:auto}',
    '.nlines{min-width:0;overflow:hidden;padding:0 4px;font-size:11px;color:var(--faint);white-space:nowrap}',
    '.composer textarea{resize:none;border:0;margin:0;background:transparent;color:var(--gfg);font:inherit;line-height:1.5;padding:.1em 0;min-height:1.6em;outline:none;' +
      'overflow-y:hidden;transition:height .16s ease-out;' + THIN_SCROLL + '}',
    '.composer textarea::placeholder{color:var(--gph)}',
    '@media (prefers-reduced-motion:reduce){.composer textarea{transition:none}}',
    // 13 px at the medium text size (the panel's is 14 px).
    '.inwrap{position:relative;display:flex;flex-direction:column;min-width:0;font-size:calc(1em - 1px)}.composer .inwrap textarea{position:relative;flex:none}',
    // Out of focus: one line with "…" over the box's text (renderShut).
    '.inone{display:none;position:absolute;left:0;right:0;top:0;padding:.1em 0;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;color:var(--gfg)}',
    '.composer .inwrap .sizer{position:absolute;left:0;top:0;width:100%;height:0;min-height:0;overflow:hidden;visibility:hidden;pointer-events:none;transition:none}',
    '.field.shut .inone{display:block}.field.shut textarea{color:transparent}.field.shut .inmarks{visibility:hidden}',
    // starts .4em further left (and as much wider), so a mark on the first character is not clipped
    '.inmarks{position:absolute;left:-.4em;top:0;bottom:0;overflow:hidden;pointer-events:none;color:transparent;font:inherit;line-height:1.5;padding:.1em 0 .1em .4em;white-space:pre-wrap;overflow-wrap:break-word}',
    '.inmarks .imk,.inone .imk{padding:.08em .32em;margin:0 -.32em;border-radius:99px;background:var(--pick-soft)}',
    '.send{width:1.9em;height:1.9em;border:0;border-radius:50%;background:var(--accent-fill);color:#fff;display:grid;place-items:center;cursor:pointer;flex:none;transition:background .15s,transform .1s}',
    '.send svg{width:1em;height:1em}',
    '.send:active{transform:scale(.94)}',
    '.listen:disabled{opacity:.45;cursor:not-allowed}',
    '.send.stop{background:var(--fg);color:var(--bg)}.send.stop svg{fill:currentColor;stroke-width:1.2}',
    '.send:disabled{background:var(--fill2);color:var(--faint);cursor:default;transform:none}',
    '.hint{display:none;font-size:.82em;line-height:1.4;color:var(--muted);margin:.3em 0 .15em;padding:0 .2em}',
    '.field:focus-within .hint{display:block}',
    // minimized pill and toast
    '.pill{position:fixed;right:20px;bottom:20px;pointer-events:auto;display:none;align-items:center;gap:.6em;border:0;background:var(--bg);color:var(--fg);',
    'border-radius:999px;padding:.4em 1em .4em .4em;box-shadow:var(--shadow);cursor:pointer;font-weight:600;font-size:14px}',
    '.pill .mark{width:2em;height:2em;border-radius:50%}',
    '.pill.on{display:flex}',
    '.pill.working .mark svg{animation:spin 2.4s linear infinite}',
    '.count{background:var(--accent-fill);color:#fff;border-radius:999px;padding:.15em .55em;font-size:.86em}',
    '.count:empty{display:none}',
    // command palette
    '.slash{width:1.8em;height:1.8em;border:0;border-radius:7px;background:transparent;color:var(--muted);display:grid;place-items:center;cursor:pointer;flex:none;font:600 1.05em/1 var(--mono)}',
    '.slash:hover{background:var(--fill);color:var(--fg)}',
    // Attach: the mic's size and look (28-dictate.js).
    '.attach{height:1.8em;min-width:1.8em;padding:0;border:0;border-radius:7px;background:transparent;color:var(--muted);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none;font:600 11.5px/1 var(--sans)}',
    '.attach:hover{background:var(--fill);color:var(--fg)}.attach svg{width:1.15em;height:1.15em}',
    '.attach:disabled{color:var(--faint);opacity:.55;background:transparent;cursor:default}',
    '.palette{position:absolute;inset:0;display:none;align-items:flex-start;justify-content:center;padding:4.2em 12px 12px;background:color-mix(in srgb,var(--bg) 55%,transparent);backdrop-filter:blur(3px);z-index:5}',
    '.palette.on{display:flex;animation:rise .16s ease-out}',
    '.pbox{width:100%;max-height:100%;display:flex;flex-direction:column;background:var(--raise);border:1px solid var(--line2);border-radius:14px;box-shadow:var(--shadow);overflow:hidden}',
    '.pin{display:flex;align-items:center;gap:.5em;padding:.6em .8em;border-bottom:1px solid var(--line)}',
    '.pin b{font:600 1.05em var(--mono);color:var(--accent)}',
    '.pin input{flex:1;min-width:0;border:0;outline:none;background:transparent;color:var(--fg);font:1em var(--mono)}',
    '.pin input::placeholder{font-family:var(--sans);color:var(--faint)}',
    '.plist{list-style:none;margin:0;padding:.35em;overflow:auto;flex:1;min-height:0;' + THIN_SCROLL + '}',
    '.pgroup{font-size:.74em;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--faint);padding:.7em .6em .3em}',
    '.pitem{display:flex;align-items:flex-start;gap:.6em;padding:.45em .6em;border-radius:9px;cursor:pointer}',
    '.pitem.sel{background:var(--accent-soft);box-shadow:inset 0 0 0 1px var(--accent-line)}',
    '.pitem .pn{font:600 .93em/1.45 var(--mono);color:var(--fg);white-space:nowrap}',
    '.pitem .ph{font:.86em/1.5 var(--mono);color:var(--faint);margin-left:.35em}',
    '.pitem .pd{font-size:.84em;color:var(--muted);line-height:1.4;white-space:normal;overflow-wrap:anywhere}',
    '.pitem .pt{flex:1;min-width:0}',
    '.pbadge{flex:none;font-size:.74em;font-weight:600;border-radius:6px;padding:.2em .5em;margin-top:.15em;white-space:nowrap}',
    '.pbadge.run{color:var(--accent-ink);background:var(--accent-soft)}.pbadge.copy{color:var(--muted);background:var(--sunk);border:1px solid var(--line)}',
    '.pempty{padding:1em .8em;color:var(--muted);font-size:.9em}',
    '.pfoot{display:flex;flex-wrap:wrap;gap:.3em 1em;padding:.5em .85em;border-top:1px solid var(--line);font-size:.78em;color:var(--faint)}',
    '.pfoot kbd{font:600 .95em var(--mono);color:var(--muted);background:var(--sunk);border:1px solid var(--line);border-radius:4px;padding:0 .3em}',
    '.md a{color:var(--accent-ink);text-decoration:underline;text-decoration-color:var(--accent-line);text-underline-offset:.18em}',
    '.md a:hover{text-decoration-color:currentColor}',
    '.md a.fref{text-decoration-style:dotted;cursor:pointer}',
    // File links everywhere (team board, claims, findings), readable in light and dark.
    'a.fref{color:var(--accent-ink);text-decoration:underline dotted;text-decoration-color:var(--accent-line);text-underline-offset:.18em;cursor:pointer}',
    '.md a.fref code{color:inherit;border-color:var(--accent-line);background:var(--accent-soft)}',
    '.k-user.cmd .bubble{font-family:var(--mono);font-size:.93em}',
    '.toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,20px);opacity:0;transition:all .35s ease;background:var(--glass);color:var(--fg);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);',
    'padding:8px 14px;border-radius:14px;font-weight:500;font-size:13px;box-shadow:var(--shadow);max-width:calc(100vw - 32px)}',
    // A narrow panel keeps its one-row header: the select button and the usage rings are hidden.
    '@container (max-width:400px){.head .tools .pt{display:none}.head .meters{display:none}}',
    '.toast.on{opacity:1;transform:translate(-50%,0);pointer-events:auto}',
    // the floating permissions button: every question that waits for the user, in one list
    '.pqb{position:fixed;display:none;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;border:0;pointer-events:auto;cursor:pointer;',
    'background:var(--accent);color:#fff;box-shadow:var(--shadow);z-index:6;font:600 13px/1 var(--sans)}',
    '.pqb.on{display:flex}.pqb svg{width:22px;height:22px}.pqb:hover{background:var(--accent-ink)}',
    '.pqb:focus-visible{outline:2px solid var(--fg);outline-offset:3px}',
    '.pqb.glow{animation:pqglow 1.6s ease-in-out infinite}',
    '@keyframes pqglow{0%,100%{box-shadow:var(--shadow),0 0 0 0 color-mix(in srgb,var(--accent) 55%,transparent)}50%{box-shadow:var(--shadow),0 0 0 9px color-mix(in srgb,var(--accent) 0%,transparent),0 0 18px 4px color-mix(in srgb,var(--accent) 45%,transparent)}}',
    '.pqb.still{box-shadow:var(--shadow),0 0 0 3px color-mix(in srgb,var(--accent) 35%,transparent)}',
    // Reduced motion stops the glow: a still ring, stronger than the one for "Highlight when waiting" Off.
    '@media (prefers-reduced-motion:reduce){.pqb.glow{box-shadow:var(--shadow),0 0 0 4px color-mix(in srgb,var(--accent) 60%,transparent)}}',
    '.pqn{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:var(--fg);color:var(--bg);display:grid;place-items:center;font-size:11.5px;box-sizing:border-box;border:2px solid var(--bg)}',
    '.pql{position:fixed;display:none;flex-direction:column;width:min(380px,calc(100vw - 24px));pointer-events:auto;background:var(--bg);color:var(--fg);border:1px solid var(--line2);',
    'border-radius:14px;box-shadow:var(--shadow);z-index:6;font:400 13.5px/1.4 var(--sans);overflow:hidden}',
    '.pql.on{display:flex;animation:rise .16s ease-out}',
    '.pqh{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}.pqh b{flex:1;font-size:14px}',
    '.pqh button{border:0;background:transparent;color:var(--muted);width:28px;height:28px;border-radius:8px;cursor:pointer;display:grid;place-items:center}.pqh button:hover{background:var(--sunk);color:var(--fg)}.pqh svg{width:16px;height:16px}',
    '.pqs{overflow:auto;padding:6px;display:flex;flex-direction:column;gap:6px}',
    '.pqi{border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--raise)}',
    '.pqw{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted)}.pqw .who{font-weight:600;color:var(--fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}',
    '.pqw i{width:8px;height:8px;border-radius:50%;flex:none;background:var(--c,var(--accent))}',
    '.pqt{font-weight:600;margin:3px 0 2px}',
    '.pqd{font:12px/1.45 var(--mono);background:var(--sunk);border-radius:6px;padding:4px 6px;margin:4px 0;white-space:pre-wrap;word-break:break-word;max-height:4.5em;overflow:auto}',
    '.pqx{font-size:12px;color:var(--muted);margin-top:4px}',
    '.pqi .pacts{margin-top:6px}',
    '.pqe{padding:14px;color:var(--muted);text-align:center}',
    // split screen: live code dock
    '.dock{position:fixed;top:0;right:0;bottom:0;width:var(--dock-w,520px);display:none;flex-direction:column;pointer-events:auto;background:var(--bg);',
    'border-left:1px solid var(--line2);box-shadow:-12px 0 40px rgba(0,0,0,.10);font-family:var(--sans);color:var(--fg);font-size:14px;line-height:1.5}',
    '.dock.on{display:flex}',
    '.dock[data-size=s]{font-size:13px}.dock[data-size=l]{font-size:15.5px}',
    '.resizer{position:absolute;left:-4px;top:0;bottom:0;width:8px;cursor:col-resize;z-index:2;touch-action:none;outline:none}',
    '.resizer::after{content:"";position:absolute;left:3px;top:50%;width:2px;height:44px;margin-top:-22px;border-radius:2px;background:var(--line2);transition:background .15s}',
    '.resizer:hover::after,.resizer.drag::after{background:var(--accent)}',
    '.resizer:focus-visible::after{background:var(--focus);box-shadow:0 0 0 2px var(--focus)}',
    '@keyframes qpulse{50%{opacity:.25}}',
    '.fchip{flex:none;display:flex;align-items:center;gap:.4em;padding:.3em .65em;border-radius:999px;border:1px solid var(--line2);background:transparent;color:var(--fg2);cursor:pointer;font:500 1em var(--sans)}',
    '.fchip:hover{border-color:var(--faint);color:var(--fg)}',
    '.fchip.on{border-color:var(--fc,var(--accent));background:color-mix(in srgb,var(--fc,var(--accent)) 13%,transparent);color:var(--fg);font-weight:600}',
    '.fchip .fd{width:.6em;height:.6em;border-radius:50%;background:var(--fc,var(--faint));flex:none;--ring:var(--fc)}',
    '.fchip.busy .fd{animation:ping 1.2s ease-out infinite}',
    '.fchip.done .fd{opacity:.45}',
    '.fchip{max-width:100%}.fchip .nm{white-space:normal;overflow-wrap:break-word;text-align:left}',
    '.fpnote{display:none;padding:5px 10px;border-bottom:1px solid var(--line);color:var(--fg2);font-size:.82em;line-height:1.35;flex:none}',
    '.fpnote.on{display:block}',
    '.psplit{display:none;flex:none;position:relative;z-index:3;background:var(--line2);touch-action:none;outline:none;transition:background .15s}',
    '.psplit.on{display:block}',
    '.panes[data-dir=rows]>.psplit{height:1px;cursor:row-resize}.panes[data-dir=rows]>.psplit::before{content:"";position:absolute;left:0;right:0;top:-4px;bottom:-4px}',
    '.panes[data-dir=cols]>.psplit{width:1px;cursor:col-resize}.panes[data-dir=cols]>.psplit::before{content:"";position:absolute;top:0;bottom:0;left:-4px;right:-4px}',
    '.psplit:hover,.psplit.drag{background:var(--accent)}',
    '.psplit:focus-visible{background:var(--focus);box-shadow:0 0 0 1px var(--focus)}',
    '.pcap{display:none;align-items:flex-start;gap:.55em;padding:.55em .9em;background:var(--accent-soft);color:var(--fg2);font-size:.9em;border-bottom:1px solid var(--line);flex:none}',
    '.pcap.on{display:flex}',
    '.pcap .mark{width:1.5em;height:1.5em;border-radius:50%;margin-top:.05em}',
    '.code{flex:1;min-height:0;overflow:auto;padding:.5em 0 2em;font:.93em/1.65 var(--mono);counter-reset:ln;color:var(--fg2);overscroll-behavior:contain;' + THIN_SCROLL + '}',
    '.cl{display:flex;white-space:pre;min-width:max-content;counter-increment:ln;max-height:4em;transition:max-height .14s ease,opacity .14s ease,background .4s ease}',
    '.cl .no{flex:none;width:3.6em;padding-right:1.1em;text-align:right;color:var(--faint);user-select:none;position:sticky;left:0;background:var(--code-bg)}',
    '.cl .no::before{content:counter(ln)}',
    '.cl .tx{padding-right:1.5em}',
    '.cl.add{background:var(--add-bg);box-shadow:inset 3px 0 0 var(--add)}',
    '.cl.add .no{color:var(--add);background:color-mix(in srgb,var(--add) 10%,var(--code-bg))}',
    '.cl.del{background:var(--del-bg);box-shadow:inset 3px 0 0 var(--del);counter-increment:none}',
    '.cl.del .tx{color:var(--del);text-decoration:line-through;text-decoration-thickness:1px}',
    '.cl.del .no{background:color-mix(in srgb,var(--del) 10%,var(--code-bg))}',
    '.cl.del .no::before{content:"−";color:var(--del)}',
    '.cl.gone{max-height:0;opacity:0}',
    '.cl.recent{box-shadow:inset 3px 0 0 color-mix(in srgb,var(--add) 70%,transparent)}',
    '.cl.lmark{background:var(--agent-soft);box-shadow:inset 3px 0 0 var(--agent)}',
    '.cl.lmark .no{color:var(--agent-ink);background:color-mix(in srgb,var(--agent) 10%,var(--code-bg))}',
    '.cl.cur .tx::after{content:"";display:inline-block;width:2px;height:1.15em;margin-left:1px;background:var(--accent);vertical-align:-.22em;animation:blink 1s step-end infinite}',
    // Wrap lines (code view menu): a long line continues under itself, after the line number.
    '.panes.wrapl .cl{white-space:pre-wrap;min-width:0;max-height:30em}.panes.wrapl .cl.gone{max-height:0}',
    '.panes.wrapl .cl .tx{flex:1;min-width:0;overflow-wrap:anywhere;padding-right:.8em}',
    '.k-edit .mini.fmore{display:grid;place-items:center;padding:.15em .2em;background:transparent;color:var(--muted)}',
    '.k-edit .mini.fmore:hover{background:var(--fill2);color:var(--fg)}.k-edit .mini.fmore svg{width:1.1em;height:1.1em}',
    '.fmenu .li svg,.fmenu .fic svg{width:16px;height:16px;flex:none}.fmenu .fic{display:grid;place-items:center;flex:none}',
    '.lmenu a.li{display:flex;width:100%;box-sizing:border-box;align-items:center;gap:10px;padding:7px 8px;border-radius:7px;color:inherit;text-decoration:none}',
    '.lmenu a.li:hover,.lmenu a.li:focus-visible{background:var(--fill);outline:0}.lmenu a.li:focus-visible{box-shadow:inset 0 0 0 2px var(--focus)}',
    '.fmenu .fside{margin-left:auto;font:12px var(--mono);color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%}',
    '.fmenu button.li:disabled{opacity:.5;cursor:default;background:transparent}',
    '.fmenu .copied .fic,.fmenu .copied .lbl{color:var(--add)}',
    '.fmenu .ffoot{padding:4px 9px 3px;font-size:11px;color:var(--faint)}',
    '.lmenu .ffoot button{display:inline;width:auto;padding:0;border-radius:3px;color:var(--accent-ink);font-size:inherit;text-decoration:underline}.lmenu .ffoot button:hover{background:transparent;color:var(--fg)}',
    '.cnote{counter-increment:none;margin:.35em 1em .35em 4.7em;padding:.35em .7em;border-radius:8px;background:var(--agent);color:#fff;font:500 .93em/1.4 var(--sans);white-space:normal;width:max-content;max-width:min(36em,80%)}',
    '.cnote::before{content:"✦ Claude  ";font-weight:700;opacity:.85}',
    '.t-c{color:var(--syn-c);font-style:italic}.t-s{color:var(--syn-s)}.t-n{color:var(--syn-n)}.t-k{color:var(--syn-k);font-weight:500}.t-t{color:var(--syn-t)}.t-p{color:var(--syn-p)}',
    '.dempty{margin:auto;padding:2em;text-align:center;color:var(--muted);max-width:26em;line-height:1.6}',
    // movable windows: dock either side or at the bottom, float, or pop out
    '.head,.dhead{touch-action:none}',
    '.head .titles{cursor:grab}',
    '.dock.left{right:auto;left:0;border-left:0;border-right:1px solid var(--line2);box-shadow:12px 0 40px rgba(0,0,0,.10)}',
    '.dock.left .resizer{left:auto;right:-4px}',
    '.dock.bottom{top:auto;left:0;right:0;width:auto;height:var(--dock-h,340px);border-left:0;border-top:1px solid var(--line2);box-shadow:0 -12px 40px rgba(0,0,0,.10)}',
    '.dock.bottom .resizer{left:0;right:0;top:-4px;bottom:auto;width:auto;height:8px;cursor:row-resize}',
    '.dock.bottom .resizer::after{left:50%;top:3px;width:44px;height:2px;margin:0 0 0 -22px}',
    '.dock.float{border:1px solid var(--line2);border-radius:14px;box-shadow:var(--shadow);overflow:hidden}',
    '.dock.float .resizer,.dock.popped .resizer{display:none}',
    // collapsed to a narrow bar
    '.dock.anim{transition:width .2s ease,height .2s ease}.dock.rail{box-shadow:none}',
    '.dock.rail>:not(.drail):not(.dtab):not(.rtools){display:none!important}',
    '.rtools{display:none;flex-direction:column;align-items:center;gap:2px;padding:6px 0;background:var(--sunk);border-bottom:1px solid var(--line)}',
    '.dock.bottom.rail{flex-direction:row}.dock.rail .rtools{display:flex}.rtools .icon{width:26px;height:26px}.rtools .icon svg{width:15px;height:15px}',
    '.rtools .speed{width:26px;padding:0;font-size:10px}',
    '.dock.bottom .rtools{flex-direction:row;padding:0 6px;border-bottom:0;border-right:1px solid var(--line)}',
    '.dtab{position:absolute;top:12px;left:-26px;width:26px;height:46px;display:grid;place-items:center;padding:0;cursor:pointer;z-index:3;pointer-events:auto;',
    'background:var(--bg);color:var(--accent);border:1px solid var(--line2);border-right:0;border-radius:12px 0 0 12px;box-shadow:-4px 2px 12px rgba(0,0,0,.10)}',
    '.dtab:hover{background:var(--accent-soft)}.dtab svg{width:18px;height:18px;stroke-width:2.4}',
    '.dock.left .dtab{left:auto;right:-26px;border-right:1px solid var(--line2);border-left:0;border-radius:0 12px 12px 0;box-shadow:4px 2px 12px rgba(0,0,0,.10)}',
    '.dock.bottom .dtab{top:-26px;left:auto;right:64px;width:46px;height:26px;border:1px solid var(--line2);border-bottom:0;border-radius:12px 12px 0 0;box-shadow:0 -4px 12px rgba(0,0,0,.10)}',
    '.dock.float .dtab,.dock.popped .dtab{display:none}',
    '.drail{display:none;flex:1;flex-direction:column;align-items:center;gap:10px;padding:12px 0;border:0;background:var(--sunk);color:var(--fg2);cursor:pointer;font:600 12px/1 var(--sans);min-width:0;min-height:0}',
    '.dock.rail .drail{display:flex}.drail:hover{background:var(--accent-soft);color:var(--accent-ink)}',
    '.drail .ri svg{width:16px;height:16px}.drail .rt{writing-mode:vertical-rl;white-space:nowrap}',
    '.drail .rn{min-width:1.6em;padding:.15em .35em;border-radius:999px;background:var(--accent-fill);color:#fff;font-size:11px;text-align:center}.drail .rn:empty{display:none}',
    '.dock.bottom .drail{flex-direction:row;padding:0 14px}.dock.bottom .drail .rt{writing-mode:horizontal-tb}',
    '.panel.float{animation:none}',
    '.grip{position:absolute;width:18px;height:18px;z-index:6;display:none;touch-action:none;cursor:nwse-resize}',
    '.grip::after{content:"";position:absolute;right:5px;bottom:5px;width:7px;height:7px;border-right:2px solid var(--faint);border-bottom:2px solid var(--faint);border-radius:0 0 2px 0;opacity:0;transition:opacity .15s}',
    '.grip:hover::after{opacity:1;border-color:var(--accent)}',
    '.grip:focus-visible{outline:2px solid var(--focus);outline-offset:-2px;border-radius:4px}.grip:focus-visible::after{opacity:1;border-color:var(--focus)}',
    '.float>.grip{display:block;right:0;bottom:0}',
    '.panel[data-corner]>.grip{display:block}',
    '.panel[data-corner=br]>.grip{left:0;top:0;transform:rotate(180deg)}',
    '.panel[data-corner=bl]>.grip{right:0;top:0;transform:rotate(-90deg);cursor:nesw-resize}',
    '.panel[data-corner=tr]>.grip{left:0;bottom:0;transform:rotate(90deg);cursor:nesw-resize}',
    '.panel[data-corner=tl]>.grip{right:0;bottom:0}',
    '.popped>.grip{display:none!important}',
    '.panel.phone>.grip{width:30px;height:30px}.panel.phone>.grip::after{width:9px;height:9px;border-width:3px}',
    '.moving{user-select:none;transition:none!important}',
    '.snap{position:fixed;display:none;pointer-events:none;border:2px dashed var(--accent);background:var(--accent-soft);border-radius:14px;z-index:7}',
    '.snap.on{display:block}',
    '.popped{position:relative!important;inset:auto!important;left:auto!important;top:auto!important;right:auto!important;bottom:auto!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;border-radius:0!important;box-shadow:none!important;border:0!important;animation:none!important;display:flex!important}',
    '.lwrap{position:fixed;inset:0;pointer-events:auto;z-index:8}',
    '.lmenu{position:fixed;min-width:220px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;padding:6px;background:var(--glass);-webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px);color:var(--fg);border:0;border-radius:14px;box-shadow:var(--shadow);font:400 13px/1.3 var(--sans)}',
    '.lmenu .lh{font-size:11px;font-weight:600;color:var(--faint);padding:6px 9px 4px}',
    // The settings menu (⋯): a segmented text size, switches, a small screen for the position, tiles.
    '.smenu{width:min(280px,calc(100vw - 16px));outline:none}.smenu .sec{padding:6px 4px 4px}.smenu .sec .lh{padding:0 4px 6px}',
    '.smenu button.li{gap:10px;padding:7px 8px}.smenu .li .lbl{flex:1;min-width:0}.smenu .li small{display:block;color:var(--faint);font-size:11px;margin-top:1px}',
    '.swi{position:relative;flex:none;width:30px;height:18px;border-radius:9px;background:var(--fill2);transition:background .15s}',
    '.swi::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:left .15s}',
    '.swi.on{background:var(--add)}.swi.on::after{left:14px}',
    '.seg3{display:flex;background:var(--fill);border-radius:8px;padding:2px;gap:2px}',
    '.lmenu .seg3 button{flex:1;justify-content:center;padding:3px 0;border-radius:6px;color:var(--muted);line-height:1.3}',
    '.lmenu .seg3 button.on{background:var(--raise);color:var(--fg);font-weight:500;box-shadow:0 1px 2px rgba(0,0,0,.12)}.lmenu .seg3 button.on::after{content:none}',
    '.seg3 .sz-s{font-size:11px}.seg3 .sz-m{font-size:13px}.seg3 .sz-l{font-size:16px}',
    '.where{display:flex;gap:10px;align-items:center;padding:0 4px}',
    '.mini-scr{position:relative;flex:none;width:66px;height:44px;border-radius:6px;background:var(--fill);box-shadow:inset 0 0 0 .5px var(--line)}',
    '.lmenu .mini-scr .spot{position:absolute;width:18px;height:12px;padding:0;border-radius:3px;background:var(--fill2)}',
    '.lmenu .mini-scr .spot:hover{background:var(--accent-line)}.lmenu .mini-scr .spot.on{background:var(--accent)}.lmenu .mini-scr .spot.on::after{content:none}',
    '.mini-scr .tl{top:4px;left:4px}.mini-scr .tr{top:4px;right:4px}.mini-scr .bl{bottom:4px;left:4px}.mini-scr .br{bottom:4px;right:4px}',
    '.lmenu .mini-scr.at-dock .right{top:4px;right:4px;width:20px;height:36px}.lmenu .mini-scr.at-dock .left{top:4px;left:4px;width:20px;height:36px}',
    '.lmenu .mini-scr.at-dock .bottom{bottom:4px;left:28px;width:12px;height:14px}.lmenu .mini-scr.at-dock .float{top:8px;left:27px;width:14px;height:12px;border-radius:3px}',
    '.where .opts{display:flex;flex-direction:column;gap:2px;font-size:12px;min-width:0}.where .opts b{font-weight:500}.where .opts span{color:var(--muted)}',
    '.smenu .acts{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:8px 4px 4px}',
    '.lmenu .acts button{flex-direction:column;justify-content:center;gap:4px;padding:8px 4px;border-radius:9px;background:var(--fill);font-size:11px;text-align:center}',
    '.lmenu .acts button:hover{background:var(--fill2)}.lmenu .acts svg{width:16px;height:16px}',
    '.smenu .foot{display:flex;justify-content:space-between;gap:6px}.lmenu .foot button{width:auto;color:var(--muted);font-size:12px}.lmenu .foot button:hover{color:var(--fg)}',
    '.lmenu button{display:flex;width:100%;align-items:center;gap:8px;border:0;background:transparent;color:inherit;text-align:left;padding:7px 9px;border-radius:7px;cursor:pointer;font:inherit}',
    '.lmenu button:hover,.lmenu button:focus-visible{background:var(--fill);outline:0}.lmenu button:focus-visible{box-shadow:inset 0 0 0 2px var(--focus)}',
    '.lmenu button.on{color:var(--accent-ink);font-weight:600}',
    '.lmenu button.on::after{content:"✓";margin-left:auto}',
    '.lmenu hr{border:0;border-top:.5px solid var(--line2);margin:4px 8px}',
    '@media (max-width:760px){.dock:not(.float):not(.popped){left:0;width:100vw!important}.resizer{display:none}}',
    '@media (max-width:760px){.dock:not(.rail):not(.left):not(.bottom) .dtab{left:0;border-left:0;border-right:1px solid var(--line2);border-radius:0 12px 12px 0}.dock.left:not(.rail) .dtab{right:0;border-right:0;border-left:1px solid var(--line2);border-radius:12px 0 0 12px}}',
    '@media (max-width:760px){.dock.rail:not(.float):not(.popped):not(.bottom){width:30px!important}.dock.rail:not(.left):not(.float):not(.popped):not(.bottom){left:auto}}',
    '@media (max-width:480px){.panel{right:12px;left:12px;bottom:12px;width:auto;height:64vh}}',
    '@media (forced-colors:active){.panel,.pill,.k-edit,.k-agent,.field{border:1px solid CanvasText}.box,.tag,.note{forced-color-adjust:none}}',
    '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}',
  ].join('') }));

  var styleEl = root.querySelector('style');

  var SPARK_PATH = 'M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9z';
  function spark(cls) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', cls || 'logo');
    svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', SPARK_PATH);
    p.setAttribute('fill', 'currentColor');
    svg.appendChild(p);
    return svg;
  }
  // Line icons (24px grid, drawn with the current text color).
  var ICONS = {
    side: 'M4.5 5.5h15v13h-15zM10 5.5v13',
    list: 'M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01',
    file: 'M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4',
    people: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5M16 5.3a3 3 0 0 1 0 5.4M17.5 14.7c1.6.6 2.7 2 3 4.3',
    chevd: 'M6 9l6 6 6-6',
    folder: 'M3.5 6.5h6l2 2h9v10h-17z',
    listen: 'M12 12h.01M8.6 8.6a4.8 4.8 0 0 0 0 6.8M15.4 8.6a4.8 4.8 0 0 1 0 6.8M5.8 5.8a8.8 8.8 0 0 0 0 12.4M18.2 5.8a8.8 8.8 0 0 1 0 12.4',
    highlight: 'M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
    hloff: 'M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M4 4l16 16',
    warn: 'M12 4l9 15.5H3zM12 10v4M12 17h.01',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    copy: 'M9 9h10.5v10.5H9zM6 15H4.5V4.5H15V6',
    minimize: 'M6 9l6 6 6-6',
    shield: 'M12 3l7.5 3v5.5c0 4.6-3.1 8.4-7.5 9.9-4.4-1.5-7.5-5.3-7.5-9.9V6L12 3zM12 8.2v4.6M12 16h.01',
    chevl: 'M15 6l-6 6 6 6',
    chevr: 'M9 6l6 6-6 6',
    chevu: 'M6 15l6-6 6 6',
    pin: 'M12 16v5M8.5 3h7l-1 6.5 3 3.5h-11l3-3.5z',
    stop: 'M7.5 7.5h9v9h-9z',
    send: 'M12 19V5M5.5 11.5L12 5l6.5 6.5',
    code: 'M8.5 7l-5 5 5 5M15.5 7l5 5-5 5',
    split: 'M4.5 4.5h15v15h-15zM4.5 12h15',
    tabs: 'M4.5 9h15v10.5h-15zM4.5 9V5.5h6l1.5 3.5',
    pause: 'M9 6v12M15 6v12',
    play: 'M8 5.5v13l10-6.5z',
    skip: 'M6 6l8 6-8 6zM18 6v12',
    replay: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5V8H8',
    close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
    prev: 'M18 6l-8 6 8 6zM6 6v12',
    next: 'M6 6l8 6-8 6zM18 6v12',
    point: 'M5 3.5l13 5.2-5.6 1.9-1.9 5.6zM12.6 12.6l5.9 5.9',
    window: 'M4.5 6.5h15v12h-15zM4.5 10h15M7 8.2h.01M9.2 8.2h.01',
    full: 'M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15',
    unfull: 'M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5',
    more: 'M5.5 12h.01M12 12h.01M18.5 12h.01',
    attach: 'M20.5 11.3l-8.4 8.4a5.4 5.4 0 0 1-7.6-7.6l8.4-8.4a3.6 3.6 0 0 1 5.1 5.1l-8.4 8.4a1.8 1.8 0 0 1-2.5-2.5l7.7-7.7',
  };
  function icon(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', name === 'more' ? '3' : name === 'listen' ? '2' : '1.9');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', ICONS[name]);
    svg.appendChild(p);
    return svg;
  }
  // Small progress ring: a dashed track and no number while the value is unknown.
  function ringEl(kind) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('aria-hidden', 'true');
    var trk = document.createElementNS(NS, 'circle');
    var arc = document.createElementNS(NS, 'circle');
    [trk, arc].forEach(function (c) {
      c.setAttribute('cx', '18');
      c.setAttribute('cy', '18');
      c.setAttribute('r', '15');
      svg.appendChild(c);
    });
    trk.setAttribute('class', 'trk');
    arc.setAttribute('class', 'arc');
    arc.setAttribute('stroke-dasharray', '0 100');
    arc.setAttribute('pathLength', '100');
    var label = el('b');
    var node = el('span', { class: 'ring none ' + kind }, svg, label);
    return {
      node: node,
      set: function (percent) {
        var p = typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
        node.classList.toggle('none', p === null);
        node.classList.toggle('hot', p !== null && p >= 70 && p < 90);
        node.classList.toggle('full', p !== null && p >= 90);
        // A small arc stays visible for tiny values so the ring never looks broken.
        arc.setAttribute('stroke-dasharray', p === null ? '0 100' : Math.max(p, 1.5) + ' 100');
        label.textContent = p === null ? '' : p < 10 ? p.toFixed(p < 1 ? 1 : 0) : String(Math.round(p));
      },
    };
  }
  function mark() {
    return el('span', { class: 'mark', 'aria-hidden': 'true' }, spark('glyph'));
  }

  var layer = el('div', { class: 'layer' });
  var pointLayer = el('div', { class: 'layer' });
  var selLayer = el('div', { class: 'layer' });
  var selText = el('span', { class: 'st' });
  var selShow = el('button', { class: 'mini', type: 'button', text: 'Show', title: 'Scroll to the highlighted elements' });
  var selClear = el('button', { class: 'mini', type: 'button', text: 'Clear', title: 'Clear this highlight (Esc)' });
  // In a narrow window the code view would cover the page, so Show stays on the page and Code opens it.
  var selCode = el('button', { class: 'mini', type: 'button', text: 'Code', title: 'Open this part in the code view' });
  var selChanges = el('button', { class: 'mini chg', type: 'button', title: 'All changes this session: click one to see it on the page and in the code', 'aria-expanded': 'false' });
  var selBar = el('div', { class: 'selbar', role: 'status' }, selText, selShow, selCode, selChanges, selClear);
  var changesList = el('div', { class: 'chlist', role: 'list', 'aria-label': 'All changes' });
  var bar = el('div', { class: 'bar' });
  var cursor = spark('cursor');
  var edgeTop = el('button', { class: 'edge top', type: 'button', text: '↑ Claude changed something above' });
  var edgeBottom = el('button', { class: 'edge bottom', type: 'button', text: '↓ Claude changed something below' });
  var toast = el('div', { class: 'toast', role: 'status' });

  var hostChip = el('span', { class: 'host', role: 'note' });
  var statusEl = el('span', { class: 'status offline' }, el('span', { class: 'dot' }), el('span', { class: 'label', text: 'Connecting' }));
  // Every "Claude can't act from this page" place offers the same button: it copies the command.
  var PC_CMD = '/editlens control';
  // Built when shown: PC_CMD names the paired computer once the page knows it (setVia).
  function pcTip() {
    return 'For full control from this page, turn on page control: type ' + PC_CMD + ' in Claude Code. Click to copy it.';
  }
  // Shown in Manual: the page only shows what Claude does. A click explains how to turn on page control.
  var accessBadge = el('button', { class: 'acc', type: 'button', 'aria-expanded': 'false', title: 'Manual: this page shows edits, but Claude runs in Claude Code. Click for how to run it from here.' }, el('span', { class: 'adot', 'aria-hidden': 'true' }), el('span', { text: 'Manual' }));
  // Root (unsafe) for paired computers' tasks: red while on (here or on a paired computer), and a
  // reminder while the EditLens window waits for the user to answer it.
  var rootChip = el('button', { class: 'rootchip', type: 'button' });
  var rootStates = {}; // computer -> 'on' | 'waiting' | 'off' (and whether it is this computer)
  function renderRootChip() {
    var on = Object.keys(rootStates).filter(function (k) { return rootStates[k].state === 'on'; });
    var wait = Object.keys(rootStates).filter(function (k) { return rootStates[k].state === 'waiting' && !rootStates[k].remote; });
    rootChip.classList.toggle('on', on.length > 0 || wait.length > 0);
    rootChip.classList.toggle('wait', !on.length && wait.length > 0);
    rootChip.textContent = on.length ? '⚠ Tasks run as root on ◆ ' + on.join(', ◆ ') : wait.length ? '⚠ Root for tasks: answer in the EditLens window' : '';
    rootChip.title = on.length ? 'TASKS FROM PAIRED COMPUTERS RUN AS ROOT THERE: THEY CAN CHANGE ANYTHING ON THAT COMPUTER. To stop it, set "Run paired computers\' tasks as" back to Auto in /config on that computer.'
      : 'A setting is set to run paired computers\' tasks as root. Nothing changes until you answer in the EditLens window. Click to open it.';
  }
  function onTaskRoot(ev) {
    rootStates[String(ev.computer || '')] = { state: String(ev.state || 'off'), remote: Boolean(ev.remote) };
    renderRootChip();
  }
  rootChip.addEventListener('click', function () {
    var waiting = Object.keys(rootStates).some(function (k) { return rootStates[k].state === 'waiting' && !rootStates[k].remote; });
    if (waiting) openAnswerWindow('root');
    else showToast(rootChip.title, 12000);
  });
  var pcCode = el('code', { text: PC_CMD });
  // Why page control stopped, when it stopped with an error (shown instead of plain Manual).
  var accessErr = el('p', { class: 'accerr' });
  var accessCopy = el('button', { class: 'abtn', type: 'button', text: 'Turn on page control', title: pcTip() });
  var accessClose = el('button', { class: 'abtn q', type: 'button', text: 'Not now' });
  var accessPop = el('div', { class: 'accpop', role: 'note' },
    accessErr,
    el('b', { text: 'Manual: Claude runs in Claude Code' }),
    el('p', null, el('span', { text: 'This page shows each edit. To run Claude from here, type ' }), pcCode, el('span', { text: ' in Claude Code.' })),
    el('div', { class: 'row' }, accessCopy, accessClose));
  var listenButton = el('button', { class: 'listen', type: 'button', 'aria-label': 'Wait', title: 'While on, Claude waits for your messages after it finishes, so it can answer immediately', 'aria-pressed': 'true' }, icon('listen'), el('span', { text: 'Wait' }));
  var sizeButton = el('button', { class: 'icon size', type: 'button', title: 'Text size', text: 'Aa' });
  var hlButton = el('button', { class: 'icon hl', type: 'button', title: 'Highlights on the page (Alt+Shift+H)', 'aria-label': 'Highlights on the page', 'aria-pressed': 'true' }, icon('highlight'));
  // After "Idle" or "Working" on the status line: Manual or Page control.
  var modeText = el('span', { class: 'smode' });
  var pointButton = el('button', { class: 'icon pt', type: 'button', title: 'Select something on the page to show Claude (Alt+Shift+P)', 'aria-pressed': 'false' }, icon('point'));
  var codeButton = el('button', { class: 'icon', type: 'button', title: 'Split screen: show the code Claude is editing', 'aria-pressed': 'false' }, icon('code'));
  var minButton = el('button', { class: 'icon', type: 'button', title: 'Minimize (Alt+Shift+C)' }, icon('minimize'));
  var panelLayoutButton = el('button', { class: 'icon', type: 'button', title: 'More: settings, text size, Wait, and where this panel is (move, float, open in a new window)', 'aria-label': 'More', 'aria-haspopup': 'menu' }, icon('more'));
  var panelGrip = el('div', { class: 'grip', title: 'Drag to resize' });
  var ctxRing = ringEl('ctx');
  var sesRing = ringEl('ses');
  var metersButton = el('button', { class: 'meters', type: 'button', title: 'Context and session usage (click for details)', 'aria-expanded': 'false' }, ctxRing.node, sesRing.node);
  var usageEl = el('div', { class: 'usage', role: 'region', 'aria-label': 'Usage details' });
  var settingsEl = el('div', { class: 'usage settings', role: 'region', 'aria-label': 'Settings' });
  var tourEl = el('div', { class: 'usage tour', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Quick tour' });
  var agentsEl = el('div', { class: 'agents' });
  // The Agents switcher (a small window beside the panel) opens from the Agents tab.
  agentsEl.appendChild(el('button', { class: 'mini swopen', type: 'button', text: 'Agents switcher', title: 'Every agent in one list beside the panel (Alt+Shift+A)', on: { click: function () { toggleSwitcher(); } } }));
  var ownerBar = el('div', { class: 'ofbar', role: 'status' });
  var filtersEl = el('div', { class: 'filters' });
  var nowEl = el('div', { class: 'now' });
  // Not read aloud as it updates (every step of a run would be announced); the status line and
  // the toasts (role=status) are.
  var feedEl = el('ul', { class: 'feed', 'aria-live': 'off', 'data-filter': 'all' });
  var rosterEl = el('div', { class: 'roster' });
  var clearBoardButton = el('button', { class: 'mini', type: 'button', text: 'Clear', title: 'Start a new team board for this project' });
  var claimsEl = el('div', { class: 'claims' });
  var teamFeedEl = el('ul', { class: 'tfeed', 'aria-live': 'off' });
  var teamEmptyEl = el('li', { class: 'empty', text: 'When Claude starts subagents, they share this board: what each one claimed, found and decided appears here, in its own color.' });
  var teamEl = el('div', { class: 'team', role: 'region', 'aria-label': 'Team board' },
    el('div', { class: 'thead' }, rosterEl, clearBoardButton), claimsEl, teamFeedEl);
  var emptyEl = el('li', { class: 'empty', text: 'Claude\'s replies, edits and subagents will appear here. You can message Claude below.' });
  feedEl.appendChild(emptyEl);
  var INPUT_PLACEHOLDER = 'Message Claude, or paste a screenshot…';
  // The computer's own dictation types into any text box; the mic button (28-dictate.js) is the browser's.
  var DICTATE_KEY = /Windows/.test(navigator.userAgent) ? 'Win+H' : /Macintosh/.test(navigator.userAgent) && !(navigator.maxTouchPoints > 1) ? 'Fn Fn' : '';
  var DICTATE_TIP = 'To speak instead of typing, use your system\'s dictation: Win+H on Windows, Fn twice on a Mac, the mic key on a phone keyboard.';
  var input = el('textarea', { rows: '1', placeholder: INPUT_PLACEHOLDER, 'aria-label': 'Message Claude', title: DICTATE_TIP });
  // Behind the box: round marks on pick numbers that start a line (renderInputMarks).
  var inMirror = el('div', { class: 'inmarks', 'aria-hidden': 'true' });
  // Pasted screenshots (cards above the text) and the line that says why a file was not added.
  var shotsEl = el('div', { class: 'shots' });
  var shotErrEl = el('div', { class: 'shoterr', role: 'status', hidden: '' });
  var sendButton = el('button', { class: 'send', type: 'button', title: 'Send (Enter)', 'aria-label': 'Send', disabled: '' }, icon('send'));
  var hintEl = el('div', { class: 'hint' });
  var slashButton = el('button', { class: 'slash', type: 'button', title: 'Claude Code commands (Ctrl+K, or type / )', 'aria-label': 'Commands', text: '/' });
  // Claude's permission mode, like the line under Claude Code's prompt. Switchable in page control.
  var modeButton = el('button', { class: 'pmode', type: 'button', 'aria-haspopup': 'menu' });
  var pcFoot = pcButton();
  // A page with no project (no data-root): messages from it can't be sent to Claude, so the box is off
  // and this says where the project's page is.
  var noRootEl = el('div', { class: 'noroot', hidden: '' });
  // An update this page or this computer has not applied yet: shown until applied, and never
  // reloads by itself (setUpdate).
  var updEl = el('div', { class: 'updbar', hidden: '', role: 'status' });
  // Out of focus, the box shows its text on one line with "…" here; "N lines" is in the bottom row.
  var inOne = el('div', { class: 'inone', 'aria-hidden': 'true' });
  var linesEl = el('span', { class: 'nlines', 'aria-hidden': 'true' });
  // A hidden copy of the text box: its height is the text's full height (fitBox).
  var sizer = el('textarea', { class: 'sizer', rows: '1', tabindex: '-1', 'aria-hidden': 'true' });
  // The box: pick chips, screenshots, the text, then the bottom row. The page control bar and the
  // notices sit above it (the page control bar goes in drive-slot).
  var inwrapEl = el('div', { class: 'inwrap' }, inMirror, input, inOne, sizer);
  var cbarEl = el('div', { class: 'cbar' }, modeButton, accessBadge, el('span', { class: 'cfoot' }, pcFoot), slashButton, el('span', { class: 'cend' }, linesEl, sendButton));
  var fieldEl = el('div', { class: 'field' }, el('div', { class: 'atts-slot' }), shotsEl, shotErrEl, inwrapEl, hintEl, cbarEl);
  var composer = el('div', { class: 'composer' }, el('div', { class: 'drive-slot' }), noRootEl, accessPop, fieldEl);
  var panel = el('section', { class: 'panel', 'aria-label': PANEL_NAME },
    el('div', { class: 'head' }, mark(), el('div', { class: 'titles' }, el('span', { class: 'title', text: PANEL_NAME }), el('div', { class: 'sub' }, statusEl, modeText, nowEl, hostChip), rootChip),
      metersButton, el('div', { class: 'tools' }, listenButton, hlButton, pointButton, codeButton, panelLayoutButton, minButton)),
    updEl, usageEl, settingsEl, tourEl, filtersEl, ownerBar, agentsEl, feedEl, teamEl, composer, panelGrip);
  var countEl = el('span', { class: 'count' });
  var pill = el('button', { class: 'pill', type: 'button', title: 'Open ' + PANEL_NAME + ' (Alt+Shift+C)' }, mark(), el('span', { text: PANEL_NAME }), countEl);

  layer.appendChild(cursor);
  // Later elements are on top: the pill above the selection bar, a message above everything here.
  [selLayer, layer, pointLayer, bar, edgeTop, edgeBottom, panel, changesList, selBar, pill, toast].forEach(function (n) { root.appendChild(n); });

  // ---------- panel state ----------
  var SIZES = dict({ s: 'small', m: 'medium', l: 'large' });
  var state = {
    panel: OPTS.panel || storageGet('localStorage', 'editlens.panel') || 'open',
    highlight: storageGet('localStorage', 'editlens.highlight') !== 'off',
    // Off by default: while Claude waits for page messages, its turn stays open (hooks/live-hook.js).
    listen: storageGet('localStorage', 'editlens.listen2') === 'on',
    filter: storageGet('localStorage', 'editlens.filter') || 'all',
    size: SIZES[storageGet('localStorage', 'editlens.size')] ? storageGet('localStorage', 'editlens.size') : 'm',
    unseen: 0,
    working: false,
    listening: false,
    listenUntil: 0,
    // What the session is doing (unknown | working | idle | stopped | closed) and whether it can
    // wait for page messages at all (not in the desktop app, Remote Control or the web).
    claude: 'unknown',
    canListen: null,
    connected: false,
    lastSeq: 0,
    offlineNote: '', // why the event stream is closed, while the panel opens it again
    instance: null,
    hello: false, // the event stream's first hello arrived
    pendingAt: 0,
    changes: 0,
  };

  var FILTERS = ['all', 'chat', 'edits', 'agents', 'team'];
  var teamBadge = el('span', { class: 'nb' });
  var agentsBadge = el('span', { class: 'nb run', title: 'Subagents running now' });
  FILTERS.forEach(function (f) {
    var b = el('button', { type: 'button', text: f[0].toUpperCase() + f.slice(1), 'data-f': f });
    if (f === 'team') b.appendChild(teamBadge);
    if (f === 'agents') b.appendChild(agentsBadge);
    b.addEventListener('click', function () { setFilter(f); });
    filtersEl.appendChild(b);
  });
  function setFilter(f) {
    state.filter = f;
    feedEl.setAttribute('data-filter', f);
    panel.setAttribute('data-filter', f);
    filtersEl.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-f') === f)); });
    storageSet('localStorage', 'editlens.filter', f);
    if (typeof agents === 'object') renderTabs();
    if (f === 'team') {
      team.unseen = 0;
      renderTeam(true);
    }
    teamBadge.textContent = team.unseen > 0 ? String(team.unseen) : '';
    scrollFeed(true);
  }

  // ---------- team board: what the main agent and its subagents share ----------
  // Boards come from the server per project folder (board-sync on connect, then board entries).
  var team = { boards: {}, unseen: 0, colors: Object.create(null), nextColor: 0 };
  var MATE_COLORS = ['#7c3aed', '#2563eb', '#0f8b8d', '#c2387f', '#16a34a', '#ca8a04', '#0891b2', '#9333ea', '#e11d48', '#4f46e5'];
  function mateKey(e) {
    return e.agentId || (e.known ? 'main' : 'unknown');
  }
  function mateColor(e) {
    var k = mateKey(e);
    if (k === 'main') return 'var(--accent)';
    if (k === 'unknown') return 'var(--faint)';
    // In order of appearance, so agents working together never share a color.
    if (!(k in team.colors)) team.colors[k] = team.nextColor++;
    return MATE_COLORS[team.colors[k] % MATE_COLORS.length];
  }
  // Colors are kept for agents on a board, in the Agents list, or with edits or a place in the code
  // view (ownerColor); the rest are removed each time a board changes (cleared, trimmed or replaced).
  function pruneColors() {
    var keep = Object.create(null);
    var owner = function (k) { keep[String(k).replace(/^a:/, '')] = true; };
    teamEntries().forEach(function (e) { keep[mateKey(e)] = true; });
    if (agents) Object.keys(agents).forEach(function (k) { if (agents[k].agentId) keep[agents[k].agentId] = true; });
    if (editsBy) Object.keys(editsBy).forEach(owner);
    if (follow) Object.keys(follow.at).forEach(owner);
    Object.keys(team.colors).forEach(function (k) { if (!keep[k]) delete team.colors[k]; });
  }
  function teamEntries() {
    var all = [];
    Object.keys(team.boards).forEach(function (cwd) {
      team.boards[cwd].forEach(function (e) { all.push(e); });
    });
    return all.sort(function (a, b) { return finiteNum(a.ts) - finiteNum(b.ts); });
  }
  function boardEntry(ev) {
    var list = team.boards[ev.cwd] || (team.boards[ev.cwd] = []);
    var e = ev.entry;
    if (!e || !Number.isInteger(e.id) || list.some(function (x) { return x.id === e.id; })) return;
    list.push(e);
    if (list.length > 400) {
      list.splice(0, list.length - 400);
      pruneColors();
    }
    if (state.filter !== 'team' && e.kind !== 'join') {
      team.unseen++;
      teamBadge.textContent = String(team.unseen);
    }
    renderTeam(nearTeamBottom());
    renderTabs();
  }
  function boardSync(ev) {
    team.boards[ev.cwd] = Array.isArray(ev.entries) ? ev.entries.filter(function (e) { return e && Number.isInteger(e.id); }) : [];
    pruneColors();
    renderTeam(true);
  }
  function boardClear(ev) {
    delete team.boards[ev.cwd];
    pruneColors();
    renderTeam(true);
  }
  function nearTeamBottom() {
    return teamFeedEl.scrollHeight - teamFeedEl.scrollTop - teamFeedEl.clientHeight < 80;
  }
  function refLink(file, line, endLine) {
    var label = file + (line ? ':' + line + (endLine && endLine !== line ? '-' + endLine : '') : '');
    var l = Number(line);
    var en = Number(endLine);
    return fileLink(document.createTextNode(label), { path: file, line: Number.isFinite(l) && l > 0 ? l : null, end: Number.isFinite(en) && en > 0 ? en : null });
  }
  // `names`: each agent's latest label (its task description arrives after it joins).
  function postEl(e, byId, names) {
    var color = mateColor(e);
    var who = el('b', { text: names[mateKey(e)] || e.author || 'Agent' });
    if (e.kind === 'join' || e.kind === 'leave') {
      var q = el('li', { class: 'post quiet', style: '--ac:' + color }, who, document.createTextNode(e.kind === 'join' ? ' joined' + (e.agentType && e.name ? ' (' + e.agentType + ')' : '') : ' finished'));
      if (e.kind === 'leave' && e.text) inline(q, ': ' + e.text);
      return q;
    }
    var head = el('div', { class: 'ph' }, who);
    var badge = e.kind === 'note' ? null : e.kind === 'claim' ? 'claimed' : e.kind === 'done' ? e.status || 'done' : e.kind;
    if (badge) head.appendChild(el('span', { class: 'badge ' + (e.kind === 'done' ? 'done' : e.kind), text: badge }));
    if (e.topic) head.appendChild(el('span', { class: 'badge', text: e.topic }));
    head.appendChild(el('span', { class: 'id', text: '#' + e.id }));
    head.appendChild(el('time', { 'data-ts': String(e.ts), text: timeAgo(e.ts) }));
    var body = el('div');
    if (e.replyTo) body.appendChild(el('span', { class: 're', text: '↳ re #' + e.replyTo + ' ' }));
    if (e.kind === 'done') {
      var c = byId[e.claimId];
      if (c) body.appendChild(el('span', { class: 're', text: '“' + c.text + '” ' }));
    }
    if (e.kind === 'finding' && e.file) {
      body.appendChild(el('span', { class: 'loc' }, refLink(e.file, e.line, e.endLine)));
      body.appendChild(el('br'));
    }
    inline(body, String(e.text || ''));
    if (e.kind === 'claim' && Array.isArray(e.files) && e.files.length) {
      var fl = el('div', { class: 're' }, document.createTextNode('Files: '));
      e.files.forEach(function (f, i) {
        if (i) fl.appendChild(document.createTextNode(', '));
        fl.appendChild(refLink(f));
      });
      body.appendChild(fl);
    }
    return el('li', { class: 'post', style: '--ac:' + color, 'data-id': String(e.id), 'data-mate': mateKey(e) }, head, body);
  }
  // The board is drawn only while visible; switching to it (setFilter) draws it.
  function renderTeam(stick) {
    if (state.filter !== 'team') return;
    var entries = teamEntries();
    var byId = Object.create(null);
    var closed = Object.create(null);
    var mates = Object.create(null);
    var order = [];
    entries.forEach(function (e) {
      byId[e.id] = e;
      if (e.kind === 'done') closed[e.claimId] = true;
      var k = mateKey(e);
      if (!mates[k]) {
        mates[k] = { e: e, live: false, left: false, posts: 0 };
        order.push(k);
      }
      mates[k].name = e.author;
      if (e.kind === 'join') mates[k].live = true;
      else if (e.kind === 'leave') { mates[k].live = false; mates[k].left = true; }
      else mates[k].posts++;
    });
    rosterEl.replaceChildren();
    order.forEach(function (k) {
      var m = mates[k];
      rosterEl.appendChild(el('span', { class: 'mate' + (m.live ? ' live' : '') + (m.left ? ' left' : ''), style: '--ac:' + mateColor(m.e), title: m.live ? 'Working' : m.left ? 'Finished' : '' },
        el('i'), el('span', { text: m.name || 'Agent' }), m.posts ? el('small', { text: String(m.posts) }) : null));
    });
    claimsEl.replaceChildren();
    var open = entries.filter(function (e) { return e.kind === 'claim' && !closed[e.id]; });
    // Claimed now: one label per open claim (a click scrolls to the full claim in the list below),
    // so the list keeps its space.
    if (open.length) {
      claimsEl.appendChild(el('span', { class: 'ch', text: 'Claimed now' }));
      open.forEach(function (c) {
        var chip = el('button', { class: 'claim', type: 'button', style: '--ac:' + mateColor(c), title: c.text + (Array.isArray(c.files) && c.files.length ? '\nFiles: ' + c.files.join(', ') : '') },
          el('i'), el('span', { text: mates[mateKey(c)].name || c.author || 'Agent' }), el('small', { text: '#' + c.id }));
        chip.addEventListener('click', function () {
          var li = teamFeedEl.querySelector('[data-id="' + String(c.id).replace(/[^\w-]/g, '') + '"]');
          if (!li) return;
          li.scrollIntoView({ block: 'center', behavior: 'smooth' });
          li.classList.remove('flash');
          void li.offsetWidth;
          li.classList.add('flash');
        });
        claimsEl.appendChild(chip);
      });
    }
    teamFeedEl.replaceChildren();
    if (!entries.length) teamFeedEl.appendChild(teamEmptyEl);
    var names = Object.create(null);
    order.forEach(function (k) { names[k] = mates[k].name; });
    entries.slice(-MAX_ITEMS).forEach(function (e) { teamFeedEl.appendChild(postEl(e, byId, names)); });
    clearBoardButton.disabled = !entries.length;
    if (ownerFilter) Array.prototype.forEach.call(teamFeedEl.children, applyOwnerFilter);
    if (stick) requestAnimationFrame(function () { teamFeedEl.scrollTop = teamFeedEl.scrollHeight; });
  }
  clearBoardButton.addEventListener('click', function () {
    var cwds = Object.keys(team.boards).filter(function (cwd) { return inScope({ cwd: cwd }); });
    if (!cwds.length || !window.confirm('Clear the team board? Agents will start from an empty board.')) return;
    cwds.forEach(function (cwd) {
      postJson('/board/clear', { pageId: PAGE_ID, cwd: cwd }).catch(function (err) { showToast('Could not clear the board: ' + err.message); });
    });
  });
  setInterval(function () {
    if (state.filter !== 'team') return;
    teamFeedEl.querySelectorAll('time[data-ts]').forEach(function (t) { t.textContent = timeAgo(t.getAttribute('data-ts')); });
  }, 30000);

  function renderPanel() {
    swSoon();
    panel.classList.toggle('min', state.panel === 'min');
    panel.classList.toggle('hidden', state.panel === 'hidden');
    pill.classList.toggle('on', state.panel === 'min' && !pop.panel);
    placeFloaters();
    countEl.textContent = state.unseen > 0 ? String(state.unseen) : '';
    if (hlButton.getAttribute('aria-pressed') !== String(state.highlight)) hlButton.replaceChildren(icon(state.highlight ? 'highlight' : 'hloff'));
    hlButton.setAttribute('aria-pressed', String(state.highlight));
    if (typeof markerLayer === 'object') markerLayer.classList.toggle('off', !state.highlight);
    panel.setAttribute('data-size', state.size);
    sizeButton.title = 'Text size: ' + SIZES[state.size] + ' (click to change)';
    listenButton.setAttribute('aria-pressed', String(state.listen && state.canListen !== false));
    // Wait is in the More menu; the header shows it only while it is on.
    listenButton.style.display = state.listen && state.canListen !== false ? '' : 'none';
    listenButton.disabled = state.canListen === false;
    listenButton.title = state.canListen === false
      ? "Wait works only when Claude Code runs in a terminal. Here, page messages are sent with your next prompt. For full control from this page, turn on page control (" + PC_CMD + ').'
      : 'While on, Claude waits for your messages after it finishes, so it can answer immediately';
  }
  function setPanel(mode) {
    state.panel = mode;
    if (mode === 'open') state.unseen = 0;
    storageSet('localStorage', 'editlens.panel', mode);
    renderPanel();
    if (mode === 'open') scrollFeed(true);
    if (mode === 'open' && !tour.on) showTour(false);
  }
  minButton.addEventListener('click', function () {
    if (pop.panel) popIn('panel');
    setPanel('min');
  });
  pill.addEventListener('click', function () { setPanel('open'); });
  // fromSettings: the change came from the settings (Claude Code); otherwise it is saved there too.
  function setSize(size, fromSettings) {
    state.size = SIZES[size] ? size : 'm';
    storageSet('localStorage', 'editlens.size', state.size);
    renderPanel();
    renderDock();
    scrollFeed(true);
    if (!fromSettings) saveSetting('text_size', SIZE_NAME[state.size]);
  }
  sizeButton.addEventListener('click', function () { setSize(state.size === 's' ? 'm' : state.size === 'm' ? 'l' : 's'); });
  function setHighlight(on, fromSettings) {
    state.highlight = Boolean(on);
    storageSet('localStorage', 'editlens.highlight', state.highlight ? 'on' : 'off');
    if (!state.highlight) {
      clearBoxes();
      clearSelection();
    }
    renderPanel();
    if (!fromSettings) saveSetting('highlight', state.highlight);
  }
  // The switch in the header: turning highlights off says where edits still appear, with Undo.
  function toggleHighlight() {
    setHighlight(!state.highlight);
    if (state.highlight) return showToast('Highlights on');
    var where = toastHost();
    if (toast.parentNode !== where) where.appendChild(toast);
    toast.replaceChildren(document.createTextNode('Highlights off · edits still show in the panel '),
      el('button', { class: 'mini', type: 'button', text: 'Undo', on: { click: function () { toast.classList.remove('on'); setHighlight(true); } } }));
    if (where === root) placeToast();
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('on'); }, 6000);
  }
  hlButton.addEventListener('click', toggleHighlight);
  function setListen(on, fromSettings) {
    state.listen = Boolean(on);
    storageSet('localStorage', 'editlens.listen2', state.listen ? 'on' : 'off');
    renderPanel();
    updateHint();
    postJson('/page', { id: PAGE_ID, listen: state.listen }).catch(function (err) { showToast('Wait could not be changed: ' + err.message); });
    if (!fromSettings) saveSetting('wait', state.listen);
  }
  listenButton.addEventListener('click', function () { setListen(!state.listen); });

  // ---------- settings: stored in Claude Code; changes are applied there by the mod ----------
  // Without the mod running, a change stays local to this page.
  var SIZE_OF = dict({ Small: 's', Medium: 'm', Large: 'l' });
  var SIZE_NAME = dict({ s: 'Small', m: 'Medium', l: 'Large' });
  var THEME_OF = dict({ Auto: null, Light: 'light', Dark: 'dark' });
  // via: the computer this page runs on through a pairing link; its settings are shown, not changed.
  var settings = { values: null, fields: [], from: 'defaults', canChange: false, via: null, applied: {}, open: false, noted: false };
  // Settings that change this page. The others (start, line_above_prompt) only mean something in
  // Claude Code, so they can't be changed here while Claude Code can't accept changes.
  var PAGE_KEYS = ['theme', 'text_size', 'highlight', 'hover_code', 'pick_box', 'dictation', 'follow_page', 'expand_code_view', 'wait', 'permission_glow', 'editor'];
  var LOCAL_SETTINGS_KEY = 'editlens.localSettings';
  // Changes picked here while Claude Code can't accept them: stored for this site, so they survive a reload.
  function localSettings() {
    var m = readJsonStore('localStorage', LOCAL_SETTINGS_KEY) || {};
    var out = {};
    PAGE_KEYS.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(m, k) && (typeof m[k] === 'boolean' || typeof m[k] === 'string')) out[k] = m[k];
    });
    return out;
  }
  function saveLocalSetting(key, value) {
    if (PAGE_KEYS.indexOf(key) < 0) return;
    var m = localSettings();
    m[key] = value;
    storageSet('localStorage', LOCAL_SETTINGS_KEY, JSON.stringify(m));
  }
  function onSettings(ev) {
    if (!ev.values || typeof ev.values !== 'object') return;
    settings.values = Object.assign({}, ev.values);
    settings.fields = Array.isArray(ev.fields) ? ev.fields : [];
    settings.from = ev.from === 'claude-code' ? 'claude-code' : 'defaults';
    settings.canChange = ev.canChange === true;
    settings.via = typeof ev.via === 'string' && ev.via ? ev.via.slice(0, 24) : null;
    if (settings.canChange) storageSet('localStorage', LOCAL_SETTINGS_KEY, null);
    else if (!settings.via) {
      var local = localSettings();
      Object.keys(local).forEach(function (k) { if (k in settings.values) settings.values[k] = local[k]; });
    }
    // Only settings Claude Code has: the defaults never undo what was picked on this page.
    if (settings.from === 'claude-code') applySettings();
    if (settings.open) renderSettings();
    pqSoon();
  }
  // A setting used on this page once, and again whenever it changes in Claude Code.
  function applySettings() {
    var v = settings.values;
    var a = settings.applied;
    function changed(k) {
      if (!(k in v) || a[k] === v[k]) return false;
      a[k] = v[k];
      return true;
    }
    if (changed('theme') && !OPTS.theme && v.theme in THEME_OF) setTheme(THEME_OF[v.theme]);
    if (changed('text_size') && SIZE_OF[v.text_size] && SIZE_OF[v.text_size] !== state.size) setSize(SIZE_OF[v.text_size], true);
    if (changed('highlight') && typeof v.highlight === 'boolean' && v.highlight !== state.highlight) setHighlight(v.highlight, true);
    if (changed('hover_code') && typeof v.hover_code === 'boolean' && v.hover_code !== peek.on) setPeek(v.hover_code, true);
    if (changed('follow_page') && typeof v.follow_page === 'boolean' && v.follow_page === pageGo.paused) {
      setPagePaused(!v.follow_page, true);
      renderFollow();
    }
    if (changed('wait') && typeof v.wait === 'boolean' && v.wait !== state.listen && state.canListen !== false) setListen(v.wait, true);
    if (changed('pick_box') && v.pick_box === false) closeNoteBox({ focus: false });
    if (changed('dictation')) dictateSettingChanged();
  }
  // name: 'light' or 'dark' (always used), or null for Auto (the page's theme, else the computer's).
  function setTheme(name) {
    themePick = name === 'light' || name === 'dark' ? name : null;
    applyTheme();
  }
  // A change made on this page, sent to Claude Code. Through a pairing link it stays on this page
  // until a reload: the settings are the other computer's.
  function saveSetting(key, value) {
    if (!settings.values || settings.via) return;
    if (!settings.canChange) saveLocalSetting(key, value);
    if (settings.values[key] === value) return;
    settings.applied[key] = value;
    settings.values[key] = value;
    sendSettings({ page: PAGE_ID, key: key, value: value });
    if (settings.open) renderSettings();
  }
  function sendSettings(body) {
    fetch(SERVER + '/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (res) {
      return res.json().then(function (json) {
        if (res.status === 409) {
          // The mod stopped since the last settings: the change is kept on this page, as without it.
          if (settings.canChange) {
            settings.canChange = false;
            if (body.reset) {
              resetLocal();
              storageSet('localStorage', LOCAL_SETTINGS_KEY, null);
            } else saveLocalSetting(body.key, body.value);
            if (settings.open) renderSettings();
          }
          // Shown once, and not over a toast that has a button (its Undo would be lost).
          if (settings.noted || (toast.classList.contains('on') && toast.querySelector('button'))) return;
          showToast(json.message || 'Saved on this page only.');
          settings.noted = true;
        } else if (!res.ok) {
          showToast((json && json.error) || 'That setting could not be changed.');
        }
      });
    }).catch(function (err) {
      showToast(err instanceof SyntaxError ? 'That setting could not be changed: EditLens sent a response it could not read.'
        : 'EditLens is not responding, so the setting was not saved (' + err.message + ').');
    });
  }
  function settingLabel(f, v) {
    if (f.type === 'boolean') return v ? 'On' : 'Off';
    return v === undefined || v === null || v === '' ? '—' : String(v);
  }
  function renderSettings() {
    settingsEl.classList.toggle('on', settings.open);
    if (!settings.open) return settingsEl.replaceChildren();
    var close = el('button', { class: 'sback', type: 'button', text: 'Done' });
    close.addEventListener('click', function () { setSettingsOpen(false); });
    var kids = [el('div', { class: 'shead' }, el('b', { text: 'Settings' }), close)];
    var group = el('div', { class: 'sgroup' });
    var fixed = el('div', { class: 'sgroup' });
    // Tasks at once, the one Other computers setting a page may change: last, under its own heading.
    var others = [];
    kids.push(el('p', { class: 'snote', text: settings.via
      ? 'These are the settings of ◆ ' + settings.via + ', where this page runs. To change one, use /config on that computer (search "editlens").'
      : settings.canChange
        ? 'Saved in Claude Code, the same as /config there (search "editlens"). The rest is in the More menu.'
        : 'Claude Code isn\'t connected right now, so changes here stay on this page. To keep them, use /config in Claude Code (search "editlens").' }));
    if (!settings.fields.length) kids.push(el('p', { class: 'snote', text: 'Waiting for the settings from Claude Code…' }));
    settings.fields.forEach(function (f) {
      var v = settings.values ? settings.values[f.key] : f.default;
      var editable = !settings.via && f.pageEditable && (settings.canChange || PAGE_KEYS.indexOf(f.key) >= 0);
      var row = el('div', { class: 'srow' + (editable && Array.isArray(f.options) && f.type !== 'boolean' ? ' wide' : '') });
      var label = el('div', { class: 'slab' }, el('span', { class: 'stitle', text: f.title }), el('span', { class: 'sdesc', text: f.description }));
      // A value saved in Claude Code that is not valid: the default is used, as the terminal says too.
      if (typeof f.invalid === 'string' && v === f.default) {
        label.appendChild(el('span', { class: 'sdesc sinvalid', role: 'note', text: '"' + f.invalid.slice(0, 40) + '" is not a valid value, so the default is used.' }));
      }
      var ctl = el('div', { class: 'sctl' });
      if (!editable) {
        ctl.appendChild(el('span', { class: 'sfixed' }, el('b', { text: settingLabel(f, v) }), el('br'),
          el('span', { text: settings.via ? 'set on ◆ ' + settings.via : 'change in /config' })));
      } else if (f.type === 'boolean') {
        var sw = el('button', { class: 'sw', type: 'button', role: 'switch', 'aria-checked': String(Boolean(v)), 'aria-label': f.title });
        sw.addEventListener('click', function () { changeSetting(f.key, !v); });
        ctl.appendChild(sw);
      } else if (Array.isArray(f.options)) {
        var seg = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': f.title });
        f.options.forEach(function (o) {
          var b = el('button', { type: 'button', role: 'radio', 'aria-checked': String(o === v), text: o });
          b.addEventListener('click', function () { if (o !== v) changeSetting(f.key, o); });
          seg.appendChild(b);
        });
        ctl.appendChild(seg);
      } else if (f.type === 'number' && Number.isInteger(f.min) && Number.isInteger(f.max) && f.max - f.min <= 15) {
        // A small range (Tasks at once, 1 to 8): − n +.
        var n = Number.isInteger(v) && v >= f.min && v <= f.max ? v : f.default;
        // The rows are drawn again after a change: the focus stays on the same button.
        var step = function (by) {
          var to = n + by;
          if (to < f.min || to > f.max) return;
          changeSetting(f.key, to);
          var again = settingsEl.querySelector('.stepper[data-key="' + f.key + '"] button[data-step="' + by + '"]');
          if (again && !again.disabled) again.focus();
        };
        // At the end of the range the button is off and says the limit, not a number out of range.
        var minus = el('button', { type: 'button', 'data-step': '-1', 'aria-label': n <= f.min ? 'Fewer (lowest is ' + f.min + ')' : 'Fewer: ' + (n - 1),
          text: '−', on: { click: function () { step(-1); } } });
        var plus = el('button', { type: 'button', 'data-step': '1', 'aria-label': n >= f.max ? 'More (highest is ' + f.max + ')' : 'More: ' + (n + 1),
          text: '+', on: { click: function () { step(1); } } });
        minus.disabled = n <= f.min;
        plus.disabled = n >= f.max;
        ctl.appendChild(el('span', { class: 'stepper', 'data-key': f.key, role: 'group', 'aria-label': f.title + ': ' + n + ' (' + f.min + ' to ' + f.max + ')' }, minus, el('b', { text: String(n) }), plus));
      }
      row.append(label, ctl);
      if (editable && f.key === 'tasks_at_once') others.push(row);
      else (editable ? group : fixed).appendChild(row);
    });
    if (others.length) group.append.apply(group, [el('div', { class: 'sghead', text: 'Other computers' })].concat(others));
    if (group.childNodes.length) kids.push(group);
    if (fixed.childNodes.length && !settings.via) kids.push(el('p', { class: 'snote', text: 'Set in Claude Code only (/config, search "editlens"):' }));
    if (fixed.childNodes.length) kids.push(fixed);
    var reset = el('button', { class: 'mini', type: 'button', text: 'Reset to defaults' });
    reset.addEventListener('click', function () {
      sendSettings({ page: PAGE_ID, reset: true });
      if (!settings.canChange) {
        resetLocal();
        storageSet('localStorage', LOCAL_SETTINGS_KEY, null);
      }
    });
    // Through a pairing link nothing here can be changed, so no Reset either.
    if (!settings.via) kids.push(el('div', { class: 'sfoot' }, reset));
    settingsEl.replaceChildren.apply(settingsEl, kids);
  }
  // A switch or option picked in the Settings card: used here now, and saved in Claude Code.
  function changeSetting(key, value) {
    if (key === 'theme') setTheme(THEME_OF[value]);
    else if (key === 'text_size' && SIZE_OF[value]) setSize(SIZE_OF[value], true);
    else if (key === 'highlight') setHighlight(value, true);
    else if (key === 'hover_code') setPeek(value, true);
    else if (key === 'follow_page') {
      setPagePaused(!value, true);
      renderFollow();
    }
    else if (key === 'wait') setListen(value, true);
    else if (key === 'pick_box' && !value) closeNoteBox({ focus: false });
    if (settings.values) {
      saveSetting(key, value);
      settings.values[key] = value;
    }
    if (key === 'dictation') dictateSettingChanged();
    renderSettings();
    pqSoon();
  }
  function resetLocal() {
    settings.fields.forEach(function (f) { if (f.pageEditable && PAGE_KEYS.indexOf(f.key) >= 0 && settings.values && settings.values[f.key] !== f.default) changeSetting(f.key, f.default); });
  }
  // here: from the code view in its own window or in full screen, where Settings open above
  // it, as a sheet (handoff 15.1).
  function setSettingsOpen(on, here) {
    // One sheet at a time: Settings takes the place of the Sessions list.
    if (on && sessionsSheet.open) closeSessions();
    settings.open = Boolean(on);
    settings.inDock = settings.open && Boolean(here);
    // Settings take the whole panel while open, like a page of their own.
    panel.classList.toggle('sheet', settings.open && !settings.inDock);
    if (settings.open && usageOpen) {
      usageOpen = false;
      renderUsage();
    }
    if (settings.open && !settings.inDock && state.panel !== 'open') setPanel('open');
    renderSettings();
    settingsPlace();
    if (settings.open) {
      var first = settingsEl.querySelector('button');
      if (first) first.focus();
    }
  }

  // ---------- quick tour: four short steps the first time the panel opens ----------
  var TOUR = [
    { title: 'Watch Claude work here', text: 'When Claude edits your app, the changed parts of this page are highlighted, and its replies appear in this panel.', target: function () { return feedEl; } },
    { title: 'Message Claude', text: 'Type below to send Claude a message from the page. Press / for Claude Code commands.', target: function () { return composer; } },
    { title: 'Show Claude something', text: 'Click the arrow at the top (Select), then a part of the page. It is sent with your next message.', target: function () { return pointButton; } },
    { title: 'Everything else is under More', text: 'The … button has settings, text size, Wait, and where the panel is: a corner, floating, or its own window, and Full screen. In Claude Code, /editlens settings has the same settings.', target: function () { return panelLayoutButton; } },
    // Optional, and only while Claude runs in Claude Code (Manual stays the default).
    { title: 'Page control', get text() { return 'Run Claude from this panel instead of Claude Code. It needs a one-time setup and a login (an API key is recommended): type ' + PC_CMD + ' in Claude Code once (the button copies it). After that it turns on by itself when a session starts and this page opens.'; }, target: function () { return null; }, action: pcButton, skip: function () { return drive.active; } },
  ];
  var tour = { on: false, step: 0, focus: null, steps: TOUR };
  function showTour(force) {
    if (!force && storageGet('localStorage', 'editlens.tourDone') === '1') return;
    tour.on = true;
    tour.step = 0;
    tour.steps = TOUR.filter(function (t) { return !(t.skip && t.skip()); });
    if (settings.open) setSettingsOpen(false);
    closeSessions();
    renderTour();
  }
  function endTour() {
    tour.on = false;
    storageSet('localStorage', 'editlens.tourDone', '1');
    renderTour();
  }
  function renderTour() {
    if (tour.focus) tour.focus.classList.remove('tourfocus');
    tour.focus = null;
    tourEl.classList.toggle('on', tour.on);
    if (!tour.on) return tourEl.replaceChildren();
    var t = tour.steps[tour.step];
    var last = tour.step === tour.steps.length - 1;
    var skip = el('button', { class: 'mini', type: 'button', text: 'Skip' });
    skip.addEventListener('click', endTour);
    var back = el('button', { class: 'mini', type: 'button', text: 'Back' });
    back.disabled = tour.step === 0;
    back.addEventListener('click', function () {
      tour.step = Math.max(0, tour.step - 1);
      renderTour();
    });
    var next = el('button', { class: 'mini primary', type: 'button', text: last ? 'Done' : 'Next' });
    next.addEventListener('click', function () {
      if (last) return endTour();
      tour.step++;
      return renderTour();
    });
    var parts = [el('div', { class: 'tstep', text: 'Quick tour · ' + (tour.step + 1) + ' of ' + tour.steps.length }), el('b', { text: t.title }), el('p', { text: t.text })];
    if (t.action) parts.push(el('div', { class: 'tbtns' }, t.action()));
    parts.push(el('div', { class: 'tbtns' }, last ? null : skip, back, next));
    tourEl.replaceChildren.apply(tourEl, parts);
    var target = t.target();
    if (target) {
      target.classList.add('tourfocus');
      tour.focus = target;
    }
    return undefined;
  }
  // A shortcut pressed in the page's own text field is the user typing (on macOS Option+Shift+C
  // types "Ç"), not a command: the panel's Alt+Shift keys work everywhere else.
  var NOT_TEXT = /^(checkbox|radio|button|submit|reset|range|color|file|image|hidden)$/i;
  function hostTyping(e) {
    var path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(host) >= 0) return false;
    var t = path[0] || e.target;
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
    return t.tagName === 'INPUT' && !NOT_TEXT.test(t.type || '');
  }
  window.addEventListener('keydown', function (e) {
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === 'C' || e.key === 'c' || e.code === 'KeyC') && !hostTyping(e)) {
      e.preventDefault();
      setPanel(state.panel === 'open' ? 'min' : 'open');
    }
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === 'H' || e.key === 'h' || e.code === 'KeyH') && !hostTyping(e)) {
      e.preventDefault();
      toggleHighlight();
    }
  }, true); // capture: the message box stops its keys from being sent to the page

  // The computer this page's Claude runs on, when it isn't this one (a pairing), or null.
  // kind: 'page' (this page's script is older than its server: Reload), 'server' (a newer EditLens is
  // installed than the one running), 'pair' (the paired computer runs another version). text null
  // removes it.
  var updates = {};
  function setUpdate(kind, text, reload) {
    if (text) updates[kind] = { text: String(text), reload: Boolean(reload) };
    else delete updates[kind];
    var kinds = Object.keys(updates);
    updEl.hidden = !kinds.length;
    updEl.replaceChildren();
    if (!kinds.length) return;
    var canReload = kinds.some(function (k) { return updates[k].reload; });
    updEl.appendChild(el('b', { text: canReload ? 'Update ready' : 'Update waiting' }));
    var texts = el('span', { class: 'ut' });
    kinds.forEach(function (k) { texts.appendChild(el('span', { text: updates[k].text })); });
    updEl.appendChild(texts);
    if (canReload) {
      updEl.appendChild(el('button', { class: 'mini', type: 'button', text: 'Reload', title: 'Reload this page to use the new panel', on: { click: function () {
        // Only when the user asks, and never over a message being typed.
        if (input.value.trim() && !window.confirm('Reload now? The message you are typing will be lost.')) return;
        location.reload();
      } } }));
    }
  }
  function setVia(name) {
    state.via = typeof name === 'string' && name ? name.slice(0, 24) : null;
    hostChip.classList.toggle('on', !!state.via);
    // Page control for this page starts on that computer, from Claude Code on this one.
    PC_CMD = '/editlens control' + (state.via ? ' ' + state.via : '');
    pcCode.textContent = PC_CMD;
    accessCopy.title = pcTip();
    if (!state.via) return;
    var hue = 0;
    for (var i = 0; i < state.via.length; i++) hue = (hue * 31 + state.via.charCodeAt(i)) % 360;
    hostChip.style.setProperty('--hc', 'hsl(' + hue + ' 65% 45%)');
    hostChip.textContent = '◆ ' + state.via;
    hostChip.title = 'Runs on ' + state.via + ', a computer paired with this one. Edits, chat and page control happen there.';
  }

  function setStatus(kind, label) {
    statusEl.className = 'status ' + kind;
    statusEl.lastChild.textContent = label;
    pill.classList.toggle('working', kind === 'working');
    bar.classList.toggle('on', kind === 'working');
  }
  accessBadge.addEventListener('click', function () {
    var open = !accessPop.classList.contains('on');
    accessPop.classList.toggle('on', open);
    accessBadge.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  accessCopy.addEventListener('click', copyControl);
  accessClose.addEventListener('click', function () {
    accessPop.classList.remove('on');
    accessBadge.setAttribute('aria-expanded', 'false');
  });
  function renderAccess() {
    var show = !!state.connected && !drive.active;
    accessBadge.classList.toggle('on', show);
    var err = show && drive.lastError ? drive.lastError : '';
    accessBadge.classList.toggle('err', !!err);
    accessBadge.lastChild.textContent = err ? 'Page control stopped' : 'Manual';
    modeText.textContent = !state.connected ? '' : '· ' + (drive.active ? 'Page control' : err ? 'Page control stopped' : 'Manual');
    accessErr.textContent = err ? 'Page control stopped: ' + err : '';
    accessErr.style.display = err ? '' : 'none';
    pcFoot.style.display = show && noRootEl.hidden ? '' : 'none'; // no page control on a page with no project
    refreshWaiting();
    if (!show) {
      accessPop.classList.remove('on');
      accessBadge.setAttribute('aria-expanded', 'false');
    }
  }
  function refreshStatus() {
    renderAccess();
    if (!state.connected) return;
    if (state.working) setStatus('working', state.statusLabel || 'Working');
    else if (state.listening) setStatus('listening', 'Waiting');
    else if (state.claude === 'stopped') setStatus('idle stopped', 'Stopped');
    else if (state.claude === 'closed') setStatus('idle stopped', 'Closed');
    else setStatus('idle', 'Idle');
    updateHint();
  }

  var toastTimer = 0;
  // ms: how long a toast stays (default 2.6 s). Toasts go in the popped-out window, or in the panel
  // or code view while it is full screen, since nothing else is drawn there.
  function toastHost() {
    if (pop.panel) return pop.panel.root;
    var fe = root.fullscreenElement;
    return fe === panel || fe === dock ? fe : root;
  }
  function showToast(text, ms) {
    var where = toastHost();
    if (toast.parentNode !== where) where.appendChild(toast);
    toast.textContent = text;
    if (where === root) placeToast();
    else toast.style.top = toast.style.bottom = ''; // in the popped-out panel's window: its own position
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('on'); }, ms > 0 ? ms : 2600);
  }

  function setNow(text) {
    swSoon();
    nowEl.replaceChildren();
    nowEl.classList.toggle('busy', Boolean(state.working));
    if (!text) return;
    nowEl.appendChild(el('span', { class: 'spin' }));
    nowEl.appendChild(el('span', { class: 't', text: plain(text) }));
  }

  function postJson(path, body) {
    return fetch(SERVER + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (json) {
        if (!res.ok) {
          var err = new Error(json && json.error ? json.error : 'HTTP ' + res.status);
          err.status = res.status;
          err.body = json;
          throw err;
        }
        return json;
      });
    });
  }

  // ---------- feed helpers ----------
  function nearBottom() {
    return feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 80;
  }
  function scrollFeed(force) {
    if (force || nearBottom()) requestAnimationFrame(function () { feedEl.scrollTop = feedEl.scrollHeight; });
  }
  function append(node, live) {
    var stick = nearBottom();
    emptyEl.remove();
    feedEl.appendChild(node);
    if (ownerFilter) applyOwnerFilter(node);
    var trimmed = [];
    while (feedEl.children.length > MAX_ITEMS) {
      trimmed.push(feedEl.firstChild);
      feedEl.firstChild.remove();
    }
    if (trimmed.length) forgetTrimmed(trimmed);
    if (live && state.panel !== 'open') {
      state.unseen++;
      renderPanel();
    }
    if (stick) scrollFeed(true);
    return node;
  }

  setInterval(function () {
    feedEl.querySelectorAll('.ago').forEach(function (n) { n.textContent = timeAgo(n.getAttribute('data-ts')); });
    updateHint();
  }, 1000);

  // ---------- chat ----------
  var lastSteps = null;
  function addAssistant(ev) {
    lastSteps = null;
    if (ev.text) mainInfo.lastText = String(ev.text);
    var reply = String(ev.text || '');
    append(el('li', { class: 'msg k-claude' }, mark(), el('div', { class: 'body' },
      el('div', { class: 'who' }, el('span', { text: 'Claude' }), reply.trim() ? copyButton(function () { return reply; }, 'Copy this reply', 'rcopy') : null),
      renderMarkdown(reply))), !ev.replay);
  }
  // images: screenshots sent with the message ({ id, w, h }), shown at the top of the bubble.
  // computer: the paired computer whose page sent it (named on this computer's pages, not on its own).
  // host: the computer whose own page sent it (named on a paired computer's page).
  function addUser(text, from, replay, images, ts, computer, host) {
    lastSteps = null;
    noteRequest(text, ts); // the code view's Edits list groups the next edits under it
    var thumbs = shotThumbs(images);
    var other = state.via ? host : computer;
    var where = typeof other === 'string' && other ? 'You · from ◆ ' + other.slice(0, 24) : 'You · from this page';
    return append(el('li', { class: 'msg k-user' + (from === 'page' ? ' page' : '') },
      el('div', { class: 'who', text: from === 'page' ? where : 'You · terminal' }),
      el('div', { class: 'bubble' + (thumbs ? ' withshots' : '') }, thumbs, renderMarkdown(text))), !replay);
  }
  function shotUrl(id) {
    return SERVER + '/shot?id=' + encodeURIComponent(id) + '&page=' + encodeURIComponent(PAGE_ID);
  }
  function shotThumbs(images) {
    var list = Array.isArray(images) ? images.filter(function (s) { return s && typeof s.id === 'string' && /^[0-9a-f]{24}$/.test(s.id); }).slice(0, 3) : [];
    if (!list.length) return null;
    var row = el('div', { class: 'bshots n' + list.length });
    list.forEach(function (s, k) {
      var w = num(s.w, 0, 1, 100000);
      var h = num(s.h, 0, 1, 100000);
      var label = 'Screenshot' + (list.length > 1 ? ' ' + (k + 1) : '') + (w && h ? ', ' + w + ' × ' + h : '') + '. Open it full size.';
      var img = el('img', { src: shotUrl(s.id), alt: 'Screenshot' + (list.length > 1 ? ' ' + (k + 1) : ''), decoding: 'async' });
      // Its height is known before it loads, so the feed does not move suddenly when it appears.
      if (w && h) img.style.aspectRatio = w + ' / ' + h;
      var a = el('a', { class: 'bshot', href: shotUrl(s.id), target: '_blank', rel: 'noopener noreferrer', title: label, 'aria-label': label }, img);
      img.addEventListener('error', function () { a.classList.add('gone'); });
      row.appendChild(a);
    });
    return row;
  }
  function addStep(ev) {
    if (!lastSteps || lastSteps !== feedEl.lastChild) {
      lastSteps = append(el('li', { class: 'k-steps' }), false);
    }
    var step = el('span', { class: 'step', title: ev.tool + (ev.summary ? ': ' + ev.summary : '') }, el('b', { text: ev.tool }), ev.summary ? document.createTextNode(' ' + ev.summary) : null);
    lastSteps.appendChild(step);
    capChildren(lastSteps);
    scrollFeed(false);
  }

  // Page messages: one bubble per message id, updated when Claude receives it. A message that
  // is still waiting says plainly when Claude will get it, and can be copied or canceled.
  var pageBubbles = Object.create(null);
  function settleBubble(id, text, ok) {
    var b = pageBubbles[id];
    if (!b) return;
    b.waiting = false;
    b.stateEl.className = 'state' + (ok ? ' ok' : ' gone');
    b.stateEl.replaceChildren(el('span', { text: text }));
    refreshWaiting();
  }
  function markDelivered(ids, via) {
    (ids || []).forEach(function (id) {
      settleBubble(id, via === 'prompt' ? 'Claude got this ✓ (with your next prompt)' : 'Claude got this ✓', true);
    });
  }
  // reason: why EditLens ended it (D27 B: paired computers can't run Claude here); none: the user canceled.
  function markCancelled(ids, reason) {
    var text = typeof reason === 'string' && reason ? 'Not sent. ' + reason : 'Not sent. You canceled it.';
    (ids || []).forEach(function (id) { settleBubble(id, text, false); });
  }
  // A restarted EditLens has lost the messages that were waiting: say so, and offer to send again.
  function markRestarted() {
    Object.keys(pageBubbles).forEach(function (id) {
      var b = pageBubbles[id];
      if (!b.waiting) return;
      settleBubble(id, 'Not sent: EditLens restarted.', false);
      var again = el('button', { class: 'mini', type: 'button', text: 'Send again', title: 'Send this message to Claude again' });
      again.addEventListener('click', function () {
        again.disabled = true;
        var m = b.msg;
        var body = m.command ? { pageId: PAGE_ID, command: m.command } : { text: m.text, pageId: PAGE_ID, attachments: m.attachments, images: m.images.length ? m.images : undefined };
        (driving() ? driveRequest('/drive/message', body) : postJson('/message', body)).then(function () {
          b.stateEl.replaceChildren(el('span', { text: 'Not sent: EditLens restarted. Sent again below.' }));
        }, function (err) {
          again.disabled = false;
          showToast('Could not send: ' + err.message);
        });
      });
      b.stateEl.appendChild(el('span', { class: 'acts' }, again));
    });
  }

  // When will Claude read a message sent now? Short, plain, and true for this kind of session.
  function waitingText() {
    if (state.listening) return 'Sending to Claude now…';
    switch (state.claude) {
      case 'working':
        return 'Claude reads this when it finishes what it is doing now.';
      case 'stopped':
        return 'Claude was stopped, so it is not reading the page. This is sent with your next prompt in Claude Code.';
      case 'closed':
        return 'Claude Code is closed. This is sent with your first prompt after you open it again in this project.';
      case 'idle':
        if (state.canListen === false) return 'Claude is idle, and in this app it can\'t read page messages by itself. Turn on page control to chat from here; otherwise this is sent with your next prompt in Claude Code.';
        return state.listen
          ? 'Claude is idle. This is sent with your next prompt, or immediately after Claude’s next reply while Wait is on.'
          : 'Claude is idle. This is sent with your next prompt in Claude Code. Turn on Wait to have Claude wait for page messages after it replies.';
      default:
        return 'Waiting for Claude Code. This is sent with your next prompt there.';
    }
  }
  // Only the newest waiting message shows Turn on page control, so the button is not repeated.
  function refreshWaiting() {
    var ids = Object.keys(pageBubbles).filter(function (id) { return pageBubbles[id].waiting; });
    ids.forEach(function (id, i) {
      var b = pageBubbles[id];
      b.textEl.textContent = waitingText();
      b.stateEl.classList.toggle('drv', Boolean(drive.active) || i < ids.length - 1);
    });
  }
  // onDone, when given, replaces the "Copied" message (the button shows it itself).
  function copyText(text, note, onDone) {
    var done = onDone || function () { showToast(note || 'Copied. Paste it into Claude Code.'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function (err) { showToast('Could not copy: ' + err.message); });
      return;
    }
    var area = el('textarea', { text: text });
    area.style.cssText = 'position:fixed;opacity:0';
    root.appendChild(area);
    area.select();
    var ok = document.execCommand('copy');
    area.remove();
    if (ok) done();
    else showToast('Could not copy; select the text and copy it yourself.');
  }
  function copyControl() {
    copyText(PC_CMD, 'Copied ' + PC_CMD + '. Paste it into Claude Code to turn on page control.');
  }
  function pcButton() {
    return el('button', { class: 'mini pcon', type: 'button', text: 'Turn on page control', title: pcTip(), on: { click: copyControl } });
  }
  function addPageMessage(ev) {
    if (pageBubbles[ev.id]) return;
    var item = addUser(ev.text, 'page', ev.replay, ev.images, ev.ts, ev.computer, ev.host);
    if (ev.command) item.classList.add('cmd');
    if (Array.isArray(ev.attachments) && ev.attachments.length) item.querySelector('.bubble').after(attChips(ev.attachments));
    var textEl = el('span', { class: 't' });
    var stateEl = el('div', { class: 'state wait' }, textEl,
      el('span', { class: 'acts' },
        pcButton(),
        el('button', { class: 'mini', type: 'button', text: 'Copy', title: 'Copy this message to paste into Claude Code', on: { click: function () { copyText(ev.text); } } }),
        el('button', { class: 'mini', type: 'button', text: 'Cancel', title: 'Cancel this message so Claude never gets it', on: { click: function (e) {
          var button = e.currentTarget;
          button.disabled = true; // a second click would only get "Claude already has this message"
          postJson('/message/cancel', { id: ev.id, page: PAGE_ID }).then(null, function (err) {
            // 409: already cancelled or received; its event updates the bubble.
            if (err.status === 409) return;
            button.disabled = false;
            showToast('Could not cancel: ' + err.message);
          });
        } } })));
    item.querySelector('.bubble').after(stateEl);
    pageBubbles[ev.id] = { item: item, stateEl: stateEl, textEl: textEl, waiting: true,
      msg: { text: ev.text, command: ev.command || null, attachments: Array.isArray(ev.attachments) ? ev.attachments : [],
        images: Array.isArray(ev.images) ? ev.images.map(function (i) { return i && i.id; }).filter(Boolean) : [] } };
    if (ev.status === 'delivered') markDelivered([ev.id]);
    else if (ev.status === 'cancelled') markCancelled([ev.id]);
    else refreshWaiting();
  }

  function setClaude(ev) {
    var known = { working: 1, idle: 1, stopped: 1, closed: 1 };
    state.claude = known[ev.state] ? ev.state : 'unknown';
    if (typeof ev.canListen === 'boolean') state.canListen = ev.canListen;
    if (state.claude !== 'working') state.working = false;
    renderPanel();
    refreshStatus();
  }

  function updateHint() {
    var text;
    // Runs on every change and each second: the spinner shows whether Claude is working now.
    nowEl.classList.toggle('busy', Boolean(state.working));
    if (!state.connected) text = state.offlineNote || 'Not connected to ' + PANEL_NAME + '.';
    else if (state.via && settings.values && settings.values.remote_tasks === false) {
      // That computer refuses this page's messages (server.js answers with tasks.runsOff()).
      text = 'Running Claude from paired computers is turned off on ◆ ' + state.via + ', so messages from here are not sent. '
        + 'To send them, turn on "Paired computers can run Claude here" in /config on ◆ ' + state.via + '.';
    } else if (driving() && drive.phase === 'signin') text = 'Sign in above first. A message you send now waits until Claude starts.';
    else if (driving()) text = state.working ? 'Claude is working. A message sent now is read as soon as it can be, as when you send another message while Claude Code is working.' : 'Claude runs from this page: it starts as soon as you send.';
    else if (state.working) text = 'Claude is working. It will read your message as soon as it finishes.';
    else if (state.listening) {
      var left = Math.max(0, Math.round((state.listenUntil - Date.now()) / 1000));
      text = Number.isFinite(left) && left > 0 ? 'Claude is waiting for your message for ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + ' more.' : 'Claude is waiting for your message.';
    } else if (state.claude === 'stopped') text = 'You stopped Claude. Messages from here are sent with your next prompt in Claude Code.';
    else if (state.claude === 'closed') text = 'Claude Code is closed. Messages from here are sent with your next prompt after you reopen it.';
    else if (state.canListen === false) text = 'In this app Claude can\'t wait for messages from here. Turn on page control to chat from the page; otherwise they are sent when Claude finishes its task or with your next prompt.';
    else if (state.listen) text = 'Claude is idle. It will wait for messages here after its next reply, or read this with your next prompt.';
    else text = 'Claude reads this when it finishes its current task, or with your next prompt. Turn on Wait to have it wait for you.';
    hintEl.textContent = text;
    refreshWaiting();
  }

  var sending = false; // one send at a time: a quick second Enter must not send it twice
  function renderNoRoot(projects, why) {
    if (!why && (OPTS.root || state.via)) {
      if (noRootEl.hidden) return;
      noRootEl.hidden = true;
      composer.classList.remove('off');
      input.disabled = false;
      renderAttach();
      renderAccess();
      return;
    }
    var list = Array.isArray(projects) ? projects.filter(function (p) { return p && typeof p.url === 'string' && /^https?:\/\//.test(p.url); }).slice(0, 5) : [];
    var parts = [el('b', { text: 'This page can\'t message Claude' }), document.createTextNode(why || '')];
    if (why) {
      // The reason says what to do.
    } else if (list.length) {
      parts.push(document.createTextNode('Open your project\'s page: '));
      list.forEach(function (p, i) {
        if (i) parts.push(document.createTextNode(', '));
        // With the page key when this page has it: those pages use the same EditLens (D21).
        parts.push(el('a', { href: pageKey ? p.url.split('#')[0] + '#editlens-key=' + pageKey : p.url, target: '_top', text: p.url + (p.name ? ' (' + p.name + ')' : '') }));
      });
      parts.push(document.createTextNode('.'));
    } else {
      parts.push(document.createTextNode('Run /editlens in Claude Code in your project folder, then open the address it prints.'));
    }
    parts.push(el('div', { class: 'row' },
      why ? null : el('button', { class: 'abtn', type: 'button', text: 'Copy /editlens', on: { click: function () { copyText('/editlens', 'Copied /editlens. Paste it into Claude Code in your project folder.'); } } }),
      el('button', { class: 'abtn q', type: 'button', text: 'Not now', on: { click: function () { noRootEl.classList.add('dismissed'); } } })));
    noRootEl.replaceChildren.apply(noRootEl, parts);
    noRootEl.hidden = false;
    composer.classList.add('off');
    emptyEl.textContent = 'Claude\'s edits will appear here.';
    renderAccess();
    input.disabled = true;
    renderAttach();
    input.placeholder = 'Messages are off on this page';
  }
  // ---------- pasted screenshots ----------
  var SHOT_MAX = 3;
  var SHOT_BYTES = 5 * 1024 * 1024;
  var SHOT_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  var SHOT_REFUSED = 'That file can\'t be added: only PNG, JPEG or WebP up to 5 MB.';
  var shots = []; // { file, url, id, card, up }
  function fmtBytes(b) {
    var v = Number(b);
    if (!Number.isFinite(v) || v < 0) return '';
    return v < 1024 * 1024 ? Math.max(1, Math.round(v / 1024)) + ' KB' : (v / 1024 / 1024).toFixed(1) + ' MB';
  }
  function showShotError(text) {
    shotErrEl.replaceChildren(icon('warn'), el('span', { text: text }));
    shotErrEl.hidden = false;
  }
  function hideShotError() {
    shotErrEl.hidden = true;
  }
  // The files of a paste, when it is files: text copied from an app (Office, a web page) also
  // includes an image of it, and is pasted as text.
  function pastedFiles(data) {
    if (!data) return [];
    var types = [].slice.call(data.types || []);
    if (types.indexOf('text/html') >= 0 || types.indexOf('text/rtf') >= 0) return [];
    var files = [].slice.call(data.files || []);
    if (!files.length) {
      [].slice.call(data.items || []).forEach(function (it) {
        var f = it.kind === 'file' ? it.getAsFile() : null;
        if (f) files.push(f);
      });
    }
    return files;
  }
  function uploadShot(file) {
    return fetch(SERVER + '/shot?page=' + encodeURIComponent(PAGE_ID), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    }).then(function (res) {
      return res.json().then(function (json) {
        if (!res.ok || !json || typeof json.id !== 'string') throw new Error(json && json.error ? json.error : SHOT_REFUSED);
        return json;
      });
    });
  }
  function addShot(file) {
    if (shots.length >= SHOT_MAX) return showShotError('You can add up to ' + SHOT_MAX + ' screenshots to one message.');
    // The server checks the file's first bytes too; this only saves sending a file it would refuse.
    if (SHOT_TYPES.indexOf(file.type) < 0 || !(file.size > 0) || file.size > SHOT_BYTES) return showShotError(SHOT_REFUSED);
    hideShotError();
    var shot = { file: file, url: URL.createObjectURL(file), id: null };
    var meta = el('small', { text: fmtBytes(file.size) });
    shot.card = el('span', { class: 'shot up' },
      el('img', { src: shot.url, alt: '' }),
      el('span', { class: 'st' }, el('b', { text: 'Screenshot' }), meta),
      el('button', { type: 'button', class: 'sx', title: 'Remove this screenshot', 'aria-label': 'Remove this screenshot', text: '✕', on: { click: function () { removeShot(shot); input.focus(); } } }));
    shots.push(shot);
    shotsEl.appendChild(shot.card);
    shot.up = uploadShot(file).then(function (out) {
      shot.id = out.id;
      shot.card.classList.remove('up');
      var w = num(out.w, 0, 1, 100000);
      var h = num(out.h, 0, 1, 100000);
      meta.textContent = (w && h ? w + ' × ' + h + ' · ' : '') + fmtBytes(out.bytes);
    }, function (err) {
      removeShot(shot);
      showShotError(err && err.message ? err.message : SHOT_REFUSED);
    });
    renderSend();
  }
  function removeShot(shot) {
    shots = shots.filter(function (x) { return x !== shot; });
    shot.card.remove();
    URL.revokeObjectURL(shot.url);
    renderSend();
  }
  input.addEventListener('paste', function (e) {
    var files = pastedFiles(e.clipboardData);
    if (!files.length || input.disabled) return;
    e.preventDefault();
    files.forEach(addShot);
  });
  // Attach, right after the mode (handoff section 19): picked files are added as pasted ones are.
  // The picker's value is cleared each time, so the same file can be picked again.
  var ATTACH_TIP = 'Attach images (PNG, JPEG or WebP, up to ' + SHOT_MAX + ' files, 5 MB each)';
  var attachInput = el('input', { type: 'file', accept: SHOT_TYPES.join(','), multiple: '', hidden: '', tabindex: '-1', 'aria-hidden': 'true' });
  var attachButton = el('button', { class: 'attach', type: 'button', title: ATTACH_TIP, 'aria-label': 'Attach images' }, icon('attach'));
  // The focus stays in the box.
  attachButton.addEventListener('mousedown', function (e) { e.preventDefault(); });
  attachButton.addEventListener('click', function () { if (!input.disabled) attachInput.click(); });
  attachInput.addEventListener('change', function () {
    var files = [].slice.call(attachInput.files || []);
    attachInput.value = '';
    if (input.disabled) return;
    files.forEach(addShot);
    input.focus();
  });
  cbarEl.insertBefore(attachButton, accessBadge);
  cbarEl.appendChild(attachInput);
  function renderAttach() {
    attachButton.disabled = input.disabled;
    attachButton.title = input.disabled ? 'Images can\'t be attached: this page can\'t message Claude.' : ATTACH_TIP;
  }

  // ---------- draft and the last message sent: kept per page id, across reloads ----------
  var DRAFT_KEY = 'editlens.draft.' + PAGE_ID;
  var LAST_KEY = 'editlens.lastSent.' + PAGE_ID;
  function saveDraft() {
    storageSet('sessionStorage', DRAFT_KEY, input.value ? input.value.slice(0, 20000) : null);
  }

  function sendMessage() {
    if (sending) return;
    if (input.disabled) return;
    dictateStop(input); // words still being heard are not sent
    var typed = input.value.trim();
    var items = pick.items.slice();
    var attachments = attachmentsForSend();
    var sentShots = shots.slice();
    if (!typed && !attachments.length && !sentShots.length) return;
    sending = true;
    sendButton.disabled = true;
    // A screenshot still being saved is waited for; one that was refused is no longer in the list.
    Promise.all(sentShots.map(function (x) { return x.up; })).then(function () {
      sentShots = sentShots.filter(function (x) { return x.id && shots.indexOf(x) >= 0; });
      var count = attachments.length + sentShots.length;
      if (!typed && !count) return null;
      var text = typed || (count === 1 ? 'Look at this.' : 'Look at these.');
      var body = { text: text, pageId: PAGE_ID, attachments: attachments, images: sentShots.length ? sentShots.map(function (x) { return x.id; }) : undefined };
      return (driving() ? driveRequest('/drive/message', body) : postJson('/message', body)).then(
        function () {
          if (input.value.trim() === typed) input.value = '';
          saveDraft();
          if (typed) storageSet('sessionStorage', LAST_KEY, typed.slice(0, 20000));
          sentShots.forEach(removeShot);
          hideShotError();
          afterSend(items);
          autoGrow();
        },
        function (err) {
          showToast('Could not send: ' + err.message);
        });
    }).then(function () {
      sending = false;
      renderSend();
    });
  }
  // Like Codex: while Claude works from this page, the Send button is a Stop button (Esc too).
  // Typing a message turns it back into Send, so a follow-up can still be sent.
  function stopShown() {
    return driving() && Boolean(drive.working) && Boolean(drive.key) && !input.value.trim() && !pick.items.length && !shots.length;
  }
  function renderSend() {
    var stop = stopShown();
    if (sendButton.classList.contains('stop') !== stop || !sendButton.firstChild) {
      sendButton.classList.toggle('stop', stop);
      sendButton.replaceChildren(icon(stop ? 'stop' : 'send'));
    }
    sendButton.title = stop ? 'Stop Claude (Esc)' : 'Send (Enter)';
    sendButton.setAttribute('aria-label', stop ? 'Stop' : 'Send');
    sendButton.disabled = stop ? false : sending || (!input.value.trim() && !pick.items.length && !shots.length);
  }
  function stopTurn() {
    sendButton.disabled = true;
    driveRequest('/drive/interrupt', {}).catch(function (err) { showToast('Could not stop: ' + err.message); }).then(renderSend);
  }
  function autoGrow() {
    fitBox();
    renderInputMarks();
    renderSend();
  }
  // The box grows upward, one line per line of text, up to half the panel's height and never over
  // the header or the tabs; past that its text scrolls inside. Out of focus it shows one line with
  // "…". The text's full height is read from a hidden copy, so the height change can animate.
  var fit = { pad: -1, raf: 0, h: -1, shut: false };
  if (!(window.CSS && CSS.supports && (CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)')))) fieldEl.classList.add('solid');
  function inputLine() {
    var cs = getComputedStyle(input);
    var lh = parseFloat(cs.lineHeight);
    var pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    lh = Number.isFinite(lh) && lh > 0 ? lh : 19.5;
    return { lh: lh, one: lh + (Number.isFinite(pad) ? pad : 0) };
  }
  // Out of focus with text in it. The focus inside the box stays while another window is in front.
  function boxShut() {
    var active = fieldEl.getRootNode().activeElement;
    var hearing = dictate && dictate.on && dictate.box && dictate.box.area === input;
    return Boolean(input.value) && !hearing && !(active && fieldEl.contains(active));
  }
  function fitBox() {
    if (!composer.offsetParent) return; // not shown (settings, a minimized panel): fitted when shown
    var shut = boxShut();
    fieldEl.classList.toggle('shut', shut);
    var m = inputLine();
    sizer.value = input.value;
    var full = Math.max(m.one, sizer.scrollHeight);
    // Chips, screenshots, the bottom row and padding; then the page control bar and notices.
    var rest = fieldEl.getBoundingClientRect().height - input.getBoundingClientRect().height;
    var above = composer.offsetHeight - fieldEl.offsetHeight;
    var area = (feedEl.offsetParent ? feedEl : teamEl).getBoundingClientRect();
    var room = Math.min(panel.clientHeight / 2, fieldEl.getBoundingClientRect().bottom - above - area.top) - rest;
    var h = shut ? m.one : Math.max(m.one, Math.min(full, Math.floor(room)));
    // Not for a change under 1 px (rounding while it animates): each new height restarts the animation.
    if (Math.abs(h - fit.h) >= 1 || shut !== fit.shut) {
      input.style.height = h + 'px';
      fit.h = h;
    }
    fit.shut = shut;
    input.style.overflowY = !shut && full > h + 1 ? 'auto' : 'hidden';
    if (shut && input.scrollTop) input.scrollTop = 0;
    var lines = Math.round((full - m.one) / m.lh) + 1;
    linesEl.textContent = !shut && lines > 3 ? lines + ' lines' : '';
    if (shut) inOne.replaceChildren.apply(inOne, inputMarkKids().kids);
    else if (inOne.firstChild) inOne.replaceChildren();
    padFeed(m);
  }
  // The feed (and the team board) scrolls under the box. Its bottom padding is the height of the box
  // out of focus (and of anything above it) + 12 px, so the newest card can be scrolled clear of it.
  function padFeed(m) {
    var gap = parseFloat(getComputedStyle(fieldEl).rowGap);
    var hint = cbarEl.getBoundingClientRect().top - inwrapEl.getBoundingClientRect().bottom - (Number.isFinite(gap) ? gap : 0);
    var pad = composer.offsetHeight - input.offsetHeight + m.one - Math.max(0, hint) + 12;
    if (!Number.isFinite(pad) || Math.abs(pad - fit.pad) < 0.5) return;
    fit.pad = pad;
    var stick = nearBottom();
    feedEl.style.paddingBottom = teamFeedEl.style.paddingBottom = pad + 'px';
    if (stick) feedEl.scrollTop = feedEl.scrollHeight;
  }
  // Chips, notices or the panel's size changed: fitted again (once per frame).
  if (window.ResizeObserver) {
    var fitWatch = new ResizeObserver(function () {
      if (!fit.raf) fit.raf = requestAnimationFrame(function () { fit.raf = 0; fitBox(); });
    });
    fitWatch.observe(composer);
    fitWatch.observe(panel);
  }
  fieldEl.addEventListener('focusin', fitBox);
  fieldEl.addEventListener('focusout', function (e) {
    if (!e.relatedTarget || !fieldEl.contains(e.relatedTarget)) setTimeout(fitBox, 0);
  });
  input.addEventListener('scroll', function () { inMirror.scrollTop = input.scrollTop; });
  input.addEventListener('input', function () {
    autoGrow();
    saveDraft();
  });
  // A message typed before the page reloaded (EditLens reloads it after some edits).
  (function () {
    var draft = storageGet('sessionStorage', DRAFT_KEY);
    if (draft && !input.value) {
      input.value = draft;
      // After the whole script has run: the Send button reads page control state set up later.
      setTimeout(autoGrow, 0);
    }
  })();
  input.addEventListener('keydown', function (e) {
    e.stopPropagation(); // keep the page's own shortcuts out of the composer
    // Alt+M switches the permission mode (never into Bypass permissions). Not Shift+Tab as in
    // Claude Code: on a page that key moves the focus back, and must keep doing only that.
    if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyM' && driving()) {
      e.preventDefault();
      cycleMode();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
    // Up in an empty box restores the last message sent from this page, as in Claude Code.
    if (e.key === 'ArrowUp' && !input.value && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
      var last = storageGet('sessionStorage', LAST_KEY);
      if (last) {
        e.preventDefault();
        input.value = last;
        input.setSelectionRange(last.length, last.length);
        autoGrow();
        saveDraft();
      }
    }
    if (e.key === 'Escape' && driving() && drive.working && drive.key && !palette.classList.contains('on')) {
      e.preventDefault();
      stopTurn();
    }
  });
  sendButton.addEventListener('click', function () {
    if (sendButton.classList.contains('stop')) stopTurn();
    else sendMessage();
  });

  // ---------- usage: context and session rings, with details ----------
  // Numbers come from the session transcript, plus Claude Code's own status line numbers (exact
  // window size, cost, plan limits) when /editlens usage set that up. Unknown stays unknown.
  var usageOpen = storageGet('localStorage', 'editlens.usage') === 'open';
  var usage = null;
  function n(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  }
  function fmtTokens(v) {
    v = n(v);
    if (v === null) return '—';
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(Math.round(v));
  }
  function fmtPct(v) {
    v = n(v);
    return v === null ? '—' : (v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v))) + '%';
  }
  function fmtDuration(ms) {
    ms = n(ms);
    if (ms === null) return '—';
    var m = Math.floor(ms / 60000);
    if (m < 1) return Math.max(1, Math.round(ms / 1000)) + 's';
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    return h < 48 ? h + 'h ' + (m % 60) + 'm' : Math.round(h / 24) + 'd';
  }
  function fmtClock(ts) {
    ts = n(ts);
    if (ts === null) return '';
    var d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return '';
    var sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  function modelLabel(u) {
    if (u.modelName) return u.modelName;
    var m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(u.model || '');
    if (!m) return u.model || '—';
    return m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] && m[3].length <= 2 ? '.' + m[3] : '') + (/\[1m\]$/i.test(u.model) ? ' (1M)' : '');
  }
  var WINDOW_SOURCE = dict({
    'claude-code': 'reported by Claude Code',
    model: 'from the model setting',
    observed: 'this session went past 200K',
    autocompact: 'your auto-compact setting (/autocompact)',
  });
  var LIMIT_NAMES = dict({ five_hour: 'Current session (5-hour)', seven_day: 'This week', spend_limit: 'Spend limit' });

  function setUsage(ev) {
    // One project can have several sessions: show the one that reported last.
    if (usage && usage.sessionId !== ev.sessionId && n(usage.ts) > n(ev.ts)) return;
    usage = ev;
    renderUsage();
  }

  function sessionPercent(u) {
    var l = u && u.limits;
    if (l && l.five_hour) return n(l.five_hour.percent);
    if (l && l.spend_limit) return n(l.spend_limit.percent);
    return null;
  }

  function renderUsage() {
    var u = usage;
    var c = u ? u.context || {} : {};
    ctxRing.set(u ? n(c.percent) : null);
    sesRing.set(sessionPercent(u));
    // Two empty rings look broken: they appear with Claude's first numbers.
    metersButton.classList.toggle('empty', !u);
    var tip = !u ? 'Context: waiting for Claude’s first reply' : n(c.window) !== null ? 'Context: ' + fmtTokens(c.used) + ' of ' + fmtTokens(c.window) + ' (' + fmtPct(c.percent) + ')'
      : 'Context: ' + fmtTokens(c.used) + ' used';
    var sp = sessionPercent(u);
    tip += '\nSession: ' + (sp !== null ? fmtPct(sp) + ' of your plan’s 5-hour limit' : u ? fmtTokens(sum(u.totals)) + ' tokens used (plan limit not reported)' : '—');
    metersButton.title = tip + '\nClick for details';
    metersButton.setAttribute('aria-expanded', String(usageOpen));
    usageEl.classList.toggle('on', usageOpen);
    if (!usageOpen) return;
    usageEl.replaceChildren();
    if (!u) {
      usageEl.appendChild(el('div', { class: 'usub', text: 'Usage appears after Claude’s first reply in this session.' }));
      return;
    }
    var t = u.totals || {};
    var used = n(c.used);
    var parts = [[c.cacheRead, 's1', 'cached'], [c.cacheCreate, 's2', 'written to cache'], [c.input, 's3', 'new']];
    var win = n(c.window);
    var stack = el('div', { class: 'stack', title: 'This turn’s context by kind' });
    var legend = el('div', { class: 'legend' });
    parts.forEach(function (p) {
      var v = n(p[0]);
      if (v === null || !win) return;
      stack.appendChild(el('i', { class: p[1], style: 'width:' + Math.min(100, (v / win) * 100) + '%' }));
      legend.appendChild(el('span', { style: '--k:' + (p[1] === 's1' ? 'var(--c)' : p[1] === 's2' ? 'color-mix(in srgb,var(--c) 55%,transparent)' : 'color-mix(in srgb,var(--c) 28%,transparent)'), text: fmtTokens(v) + ' ' + p[2] }));
    });
    var ctxCard = el('div', { class: 'ucard ctx' },
      el('h4', { text: 'Context' }),
      el('div', { class: 'ubig' }, document.createTextNode(fmtTokens(used)), el('small', { text: win !== null ? 'of ' + fmtTokens(win) + ' · ' + fmtPct(c.percent) : 'used' })),
      stack, legend,
      el('div', { class: 'usub', text: (win !== null ? 'Window ' + fmtTokens(win) + ', ' + (WINDOW_SOURCE[c.windowSource] || 'unknown source') + '.' : 'Window size not known yet.') +
        (n(c.lastOutput) !== null ? ' Last reply: ' + fmtTokens(c.lastOutput) + ' tokens.' : '') }));

    var sesCard = el('div', { class: 'ucard ses' }, el('h4', { text: 'Session' }));
    var limits = u.limits || {};
    var limitKeys = Object.keys(LIMIT_NAMES).filter(function (k) { return limits[k] && n(limits[k].percent) !== null; });
    if (limitKeys.length) {
      limitKeys.forEach(function (k) {
        var l = limits[k];
        var p = n(l.percent);
        sesCard.appendChild(el('div', { class: 'lim' },
          el('div', { class: 'lt' }, el('span', { text: LIMIT_NAMES[k] }), el('b', { text: fmtPct(p) })),
          el('div', { class: 'lb' }, el('i', { style: 'width:' + Math.min(100, p) + '%' })),
          fmtClock(l.resetsAt) ? el('div', { class: 'usub', text: 'Resets ' + fmtClock(l.resetsAt) }) : null));
      });
    } else {
      sesCard.appendChild(el('div', { class: 'ubig' }, document.createTextNode(fmtTokens(sum(t))), el('small', { text: 'tokens' })));
      sesCard.appendChild(el('div', { class: 'usub', text: u.fromStatusLine
        ? 'Claude Code reports no plan limits for this account.'
        : 'Plan limits come from Claude Code’s status line. Type /editlens usage for the one line to add, then restart Claude Code (a terminal session shows them).' }));
    }

    var cost = n(u.costUSD);
    var start = n(u.startedAt);
    var duration = u.fromStatusLine ? n(u.durationMs) : start !== null ? Date.now() - start : n(u.durationMs);
    var rows = [
      ['Model', modelLabel(u)],
      ['Effort', u.effort || '—'],
      ['Duration', fmtDuration(duration)],
      ['Turns', String(n(u.turns) === null ? '—' : u.turns)],
      ['Tool calls', String(n(u.toolCalls) === null ? '—' : u.toolCalls)],
      ['Subagents', String(n(u.subagents) === null ? '—' : u.subagents) + (n(t.subagentTokens) ? ' · ' + fmtTokens(t.subagentTokens) : '')],
      ['New input', fmtTokens(t.input)],
      ['Cache read', fmtTokens(t.cacheRead)],
      ['Cache write', fmtTokens(t.cacheCreate)],
      ['Output', fmtTokens(t.output)],
      ['Compactions', String(n(u.compactions) === null ? '—' : u.compactions)],
      ['Cost', cost === null ? '—' : '$' + cost.toFixed(cost < 10 ? 2 : 0) + (u.costSource === 'transcript' ? '*' : '')],
    ];
    var grid = el('dl', { class: 'ugrid' });
    rows.forEach(function (r) { grid.appendChild(el('div', null, el('dt', { text: r[0] }), el('dd', { text: r[1], title: r[1] }))); });
    var notes = ['Totals count every API call in this session, including cache reads.'];
    if (u.costSource === 'transcript') notes.push('*Cost as last saved by Claude Code; it may be older than the current state.');
    if (u.costSource === 'claude-code') notes.push('Cost is Claude Code’s estimate.');
    usageEl.append(el('div', { class: 'ucards' }, ctxCard, sesCard), grid, el('div', { class: 'unote', text: notes.join(' ') }));
  }
  function sum(t) {
    t = t || {};
    var total = 0;
    ['input', 'cacheRead', 'cacheCreate', 'output'].forEach(function (k) { if (n(t[k]) !== null) total += t[k]; });
    return Number.isFinite(total) ? total : null; // past the largest number: unknown
  }
  metersButton.addEventListener('click', function () {
    usageOpen = !usageOpen;
    if (usageOpen && settings.open) setSettingsOpen(false);
    storageSet('localStorage', 'editlens.usage', usageOpen ? 'open' : 'closed');
    renderUsage();
  });
  // Durations and reset times change over time.
  setInterval(function () { if (usageOpen && usage) renderUsage(); }, 30000);
  renderUsage();

  // ---------- command palette: Claude Code commands from the page ----------
  // Custom commands/skills are sent as a page message; built-ins can only be copied for pasting.
  var commands = [];
  var palInput = el('input', { type: 'text', placeholder: 'Search commands, then add arguments after a space', 'aria-label': 'Command', spellcheck: 'false', autocomplete: 'off' });
  var palList = el('ul', { class: 'plist', role: 'listbox' });
  var palette = el('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Claude Code commands' },
    el('div', { class: 'pbox' },
      el('div', { class: 'pin' }, el('b', { text: '/' }), palInput),
      palList,
      el('div', { class: 'pfoot' },
        el('span', null, el('kbd', { text: '↑↓' }), document.createTextNode(' choose')),
        el('span', null, el('kbd', { text: 'Tab' }), document.createTextNode(' complete')),
        el('span', null, el('kbd', { text: 'Enter' }), document.createTextNode(' send or copy')),
        el('span', null, el('kbd', { text: 'Esc' }), document.createTextNode(' close')))));
  panel.appendChild(palette);
  var palItems = [];
  var palSel = 0;

  function setCommands(ev) {
    if (!Array.isArray(ev.commands)) return;
    // The latest session in this project is used.
    commands = ev.commands.filter(function (c) { return c && typeof c.name === 'string'; });
    if (palette.classList.contains('on')) renderPalette();
  }
  function parseQuery() {
    var q = palInput.value.replace(/^\s*\/?/, '');
    var at = q.search(/\s/);
    return { name: (at < 0 ? q : q.slice(0, at)).toLowerCase(), args: at < 0 ? '' : q.slice(at + 1).trim() };
  }
  function score(c, q) {
    var name = c.name.toLowerCase();
    if (!q) return 1;
    if (name === q) return 100;
    if (name.indexOf(q) === 0) return 60;
    var tail = name.split(':').pop();
    if (tail.indexOf(q) === 0) return 50;
    if (name.indexOf(q) >= 0) return 30;
    if ((c.description || '').toLowerCase().indexOf(q) >= 0) return 10;
    return 0;
  }
  function renderPalette() {
    var q = parseQuery();
    var ranked = commands.map(function (c) { return { c: c, s: score(c, q.name) }; })
      .filter(function (r) { return r.s > 0; })
      .sort(function (a, b) { return b.s - a.s || a.c.name.localeCompare(b.c.name); });
    var run = ranked.filter(function (r) { return r.c.runnable; });
    var copy = ranked.filter(function (r) { return !r.c.runnable; });
    palList.replaceChildren();
    palItems = [];
    if (!commands.length) {
      palList.appendChild(el('li', { class: 'pempty', text: 'Commands appear when Claude Code starts a session in this project.' }));
      return;
    }
    if (!ranked.length) {
      palList.appendChild(el('li', { class: 'pempty', text: 'No command matches “' + q.name + '”.' }));
      return;
    }
    var group = function (title, rows) {
      if (!rows.length) return;
      palList.appendChild(el('li', { class: 'pgroup', text: title }));
      rows.forEach(function (r) {
        var c = r.c;
        var i = palItems.length;
        var li = el('li', { class: 'pitem', role: 'option', title: c.source ? 'From ' + c.source : '' },
          el('div', { class: 'pt' },
            el('div', null, el('span', { class: 'pn', text: '/' + c.name }), c.argumentHint ? el('span', { class: 'ph', text: c.argumentHint }) : null),
            c.description ? el('div', { class: 'pd', text: c.description }) : null),
          c.runnable
            ? el('span', { class: 'pbadge run', text: 'Claude runs it', title: 'Sent to Claude like a page message; it runs the command with its Skill tool when it reads it' })
            : el('span', { class: 'pbadge copy', text: 'Copy', title: c.kind === 'built-in' ? 'Built into Claude Code: it can only be typed there, so this copies it for you to paste' : 'This command can only be typed in Claude Code, so this copies it' }));
        li.addEventListener('mousemove', function () { if (palSel !== i) { palSel = i; markSel(); } });
        li.addEventListener('click', function () { palSel = i; choose(); });
        palItems.push({ c: c, node: li });
        palList.appendChild(li);
      });
    };
    group('Claude runs these', run);
    group('Built into Claude Code · copy, then paste there', copy);
    palSel = Math.min(palSel, palItems.length - 1);
    markSel();
  }
  function markSel() {
    palItems.forEach(function (p, i) {
      p.node.classList.toggle('sel', i === palSel);
      p.node.setAttribute('aria-selected', String(i === palSel));
    });
    var cur = palItems[palSel];
    if (cur) cur.node.scrollIntoView({ block: 'nearest' });
  }
  function openPalette(seed) {
    if (state.panel !== 'open') setPanel('open');
    palette.classList.add('on');
    palInput.value = seed || '';
    palSel = 0;
    renderPalette();
    palInput.focus(); // now, so fast typing after the shortcut goes into the palette
  }
  function closePalette(back) {
    palette.classList.remove('on');
    if (back) input.focus();
  }
  function choose() {
    var item = palItems[palSel];
    if (!item) return;
    var c = item.c;
    var args = parseQuery().args;
    var line = '/' + c.name + (args ? ' ' + args : '');
    if (!c.runnable) {
      copyText(line);
      closePalette(true);
      return;
    }
    if (palSending) return;
    palSending = true;
    (driving() ? driveRequest('/drive/message', { command: { name: c.name, args: args } }) : postJson('/message', { pageId: PAGE_ID, command: { name: c.name, args: args } })).then(
      function () { closePalette(true); },
      function (err) { showToast('Could not send: ' + err.message); }).then(function () { palSending = false; });
  }
  var palSending = false;
  palInput.addEventListener('input', function () { palSel = 0; renderPalette(); });
  palInput.addEventListener('keydown', function (e) {
    e.stopPropagation(); // keep the page's own shortcuts out
    if (e.key === 'Escape') { e.preventDefault(); closePalette(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palItems.length - 1, palSel + 1); markSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(0, palSel - 1); markSel(); }
    else if (e.key === 'Tab' && palItems[palSel]) {
      e.preventDefault();
      var args = parseQuery().args;
      palInput.value = palItems[palSel].c.name + ' ' + args;
      renderPalette();
    } else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); choose(); }
  });
  palette.addEventListener('mousedown', function (e) { if (e.target === palette) closePalette(true); });
  slashButton.addEventListener('click', function () { openPalette(''); });
  // "/" as the first character of a message opens the palette.
  input.addEventListener('keydown', function (e) {
    if (e.key === '/' && !input.value && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      openPalette('');
    }
  });
  // Ctrl+K / Cmd+K inside the panel; Alt+Shift+K anywhere on the page.
  window.addEventListener('keydown', function (e) {
    var inPanel = e.composedPath && e.composedPath().indexOf(host) >= 0;
    var k = e.key === 'k' || e.key === 'K' || e.code === 'KeyK';
    if (k && ((inPanel && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) || (e.altKey && e.shiftKey && !hostTyping(e)))) {
      e.preventDefault();
      if (palette.classList.contains('on')) closePalette(true);
      else openPalette('');
    }
  }, true);

  // ---------- subagents ----------
  var STEPS_MAX = 200; // per tool-steps row or subagent card: the oldest are removed first
  var DONE_AGENTS_MAX = 50;
  var STALE_AGENT_MS = 60 * 60000;
  function capChildren(box) {
    while (box.children.length > STEPS_MAX) box.firstChild.remove();
  }
  // Items removed from the feed are not kept: message bubbles, copy and task cards with their data,
  // edit cards (forgetEditCards), and finished subagents beyond the newest DONE_AGENTS_MAX (or whose
  // card is gone), with their labels.
  function forgetTrimmed(removed) {
    Object.keys(pageBubbles).forEach(function (id) { if (!pageBubbles[id].item.isConnected) delete pageBubbles[id]; });
    [copyCards, taskCards, remoteCards, noticeCards].forEach(function (cards) {
      Object.keys(cards).forEach(function (id) {
        if (cards[id].item.isConnected) return;
        delete cards[id];
        if (cards === remoteCards) delete appliedByTask[id];
      });
    });
    forgetEditCards(removed);
    // Session labels on removed cards (each keeps its whole card).
    sessions.tags = sessions.tags.filter(function (t) { return t.isConnected; });
    pruneAgents();
  }
  function pruneAgents() {
    // A subagent whose end never arrived (its session crashed, a lost event) counts as finished once
    // it has sent no events for STALE_AGENT_MS.
    var now = Date.now();
    // A followed or pinned one stays (Pin keeps it listed after it finishes).
    var done = Object.keys(agents).filter(function (k) {
      return (agents[k].done || now - (agents[k].seen || 0) > STALE_AGENT_MS) && k !== follow.mode && !(sw && sw.pinned[k]);
    });
    var drop = done.filter(function (k) { return !agents[k].card.isConnected; });
    var extra = done.length - drop.length - DONE_AGENTS_MAX;
    if (extra > 0) drop = drop.concat(done.filter(function (k) { return agents[k].card.isConnected; }).slice(0, extra));
    if (!drop.length) return;
    drop.forEach(function (k) {
      var a = agents[k];
      a.chip.remove();
      delete agents[k];
      forgetAgent(k, a);
    });
    renderModes();
    updateAgentsBadge();
    swSoon();
  }
  var agents = Object.create(null); // toolUseId -> { card, chip, steps, ... }
  function agentFor(ev) {
    var key = ev.toolUseId || ev.agentId;
    if (key && agents[key]) return agents[key];
    if (ev.agentId) {
      for (var k in agents) if (agents[k].agentId === ev.agentId) return agents[k];
      // Not linked yet: attach to the newest running subagent that has no transcript id.
      var open = Object.keys(agents).map(function (key) { return agents[key]; }).filter(function (a) { return !a.agentId && !a.done; });
      if (open.length) {
        open[open.length - 1].agentId = ev.agentId;
        return open[open.length - 1];
      }
    }
    return null;
  }
  function addAgent(ev) {
    lastSteps = null;
    var stateEl = el('span', { class: 'astate' }, el('span', { class: 'spin' }), el('span', { text: 'Starting' }));
    var steps = el('div', { class: 'asteps' });
    var followButton = el('button', { class: 'mini afollow', type: 'button', text: 'Follow', title: 'Show the files this subagent is reading and editing in the code view' });
    followButton.addEventListener('click', function (e) {
      e.stopPropagation();
      setFollow(ev.toolUseId, true);
    });
    var modeEl = el('button', { class: 'amode', type: 'button', 'aria-haspopup': 'menu', style: 'display:none' });
    modeEl.addEventListener('click', function (e) {
      e.stopPropagation();
      var a = agents[ev.toolUseId];
      if (driving() && a && !a.done) openModeMenu(modeEl, ev.toolUseId);
      else showToast(modeEl.title);
    });
    var card = el('li', { class: 'k-agent' + (ev.replay ? '' : ' open'), 'data-owner': ev.toolUseId },
      el('div', { class: 'ahead' }, el('span', { class: 'abadge', 'aria-hidden': 'true', text: String(ev.agentType || 'agent').charAt(0).toUpperCase() }),
        el('div', { class: 'atop' }, el('span', { class: 'adesc', text: ev.description || 'Subagent' }), modeEl, followButton),
        el('div', { class: 'ameta' }, stateEl, el('span', { class: 'atype', text: ev.agentType || 'agent' })),
        el('div', { class: 'aprog', 'aria-hidden': 'true' }, el('i'))),
      el('div', { class: 'abody' }, ev.prompt ? el('div', { class: 'why', text: ev.prompt }) : null, steps));
    card.querySelector('.ahead').addEventListener('click', function () { card.classList.toggle('open'); });
    var chip = el('button', { class: 'chip', type: 'button', title: ev.description || '' }, el('span', { class: 'spin' }), el('span', { text: (ev.agentType || 'agent') + ' · ' + (ev.description || '') }));
    chip.addEventListener('click', function () {
      if (state.filter === 'edits' || state.filter === 'chat') setFilter('all');
      card.classList.add('open');
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    // The Agents tab draws its own rows (renderAgentsTab); this button is kept for its state only.
    agents[ev.toolUseId] = { key: ev.toolUseId, card: card, chip: chip, steps: steps, stateEl: stateEl, agentId: ev.agentId || null, started: finiteNum(ev.ts),
      desc: ev.description || '', type: ev.agentType || '', modeEl: modeEl, prompt: ev.prompt || '', lastStep: '', files: {}, ended: 0, failed: false, result: '', seen: Date.now(),
      model: null, ctx: null, out: new Map(), outTotal: 0, tools: 0, toolCount: null, tokens: null, lastText: '' };
    append(card, !ev.replay);
    renderModes();
    updateAgentsBadge();
  }
  // Running subagents, counted on the Agents tab (their labels appear inside that tab).
  function updateAgentsBadge() {
    var n = Object.keys(agents).filter(function (k) { return !agents[k].done; }).length;
    agentsBadge.textContent = n ? String(n) : '';
    renderTabs();
    swSoon(); // the Agents tab rows and the switcher
  }
  // Agents and Team show once there is something in them (or while they are picked).
  function renderTabs() {
    var hasAgents = Object.keys(agents).length > 0;
    var hasTeam = hasAgents || teamEntries().length > 0;
    filtersEl.querySelectorAll('button').forEach(function (b) {
      var f = b.getAttribute('data-f');
      b.hidden = (f === 'agents' && !hasAgents && state.filter !== 'agents') || (f === 'team' && !hasTeam && state.filter !== 'team');
    });
  }
  function addAgentStep(ev) {
    var a = agentFor(ev);
    if (!a) {
      addAgent({ toolUseId: ev.toolUseId || ev.agentId, agentId: ev.agentId, agentType: ev.agentType, description: 'Subagent', ts: ev.ts, replay: ev.replay });
      a = agentFor(ev) || agents[ev.agentId];
    }
    if (!a) return;
    a.agentId = a.agentId || ev.agentId;
    a.seen = Date.now();
    var stick = a.steps.scrollHeight - a.steps.scrollTop - a.steps.clientHeight < 40;
    a.lastStep = ev.kind === 'text' ? String(ev.text || '').split('\n')[0] : (ev.tool || '') + (ev.summary ? ' ' + ev.summary : '');
    if (ev.kind === 'text' && ev.text) a.lastText = String(ev.text);
    if (ev.kind === 'tool') a.tools++;
    if (!a.done && a.lastStep) {
      var stepText = a.stateEl.querySelector('span:last-child');
      if (stepText) stepText.textContent = plain(a.lastStep).slice(0, 80);
    }
    if (typeof ev.model === 'string' && ev.model) a.model = ev.model;
    if (n(ev.ctx) !== null) a.ctx = ev.ctx;
    if (ev.msgId && n(ev.out) !== null) noteOut(a, String(ev.msgId), ev.out);
    swSoon();
    if (ev.kind === 'text') a.steps.appendChild(el('div', { class: 'atext' }, renderMarkdown(ev.text)));
    else a.steps.appendChild(el('span', { class: 'step' }, el('b', { text: ev.tool }), ev.summary ? document.createTextNode(' ' + ev.summary) : null));
    capChildren(a.steps);
    if (stick) a.steps.scrollTop = a.steps.scrollHeight;
    scrollFeed(false);
  }
  // An agent's output tokens: a running total, and the counts of its newest OUT_IDS messages (a
  // message is reported again as it grows: its earlier count is subtracted from the total).
  var OUT_IDS = 200;
  function noteOut(a, id, out) {
    var was = a.out.has(id) ? a.out.get(id) : 0;
    a.out.delete(id);
    a.out.set(id, out);
    if (a.out.size > OUT_IDS) a.out.delete(a.out.keys().next().value);
    var total = a.outTotal - was + out;
    a.outTotal = Number.isFinite(total) && total >= 0 ? total : a.outTotal;
  }
  // A subagent run in the background can end twice: when it stops, then Claude Code's counts. The
  // second end keeps the first end time and replaces the result, counts and state.
  function finishAgent(ev) {
    // Its own card only (by its Agent call or subagent id): an end for a card no longer shown
    // never ends another subagent's card.
    var a = agents[ev.toolUseId || ev.agentId] || null;
    for (var k in agents) if (!a && ev.agentId && agents[k].agentId === ev.agentId) a = agents[k];
    if (!a) return;
    var again = a.done;
    a.done = true;
    var failed = ev.status === 'failed' || ev.status === 'error';
    var endTs = Number(ev.ts);
    if (!again) a.ended = Number.isFinite(endTs) && endTs > 0 && !ev.replay ? Math.max(endTs, Date.now() - 5000) : Date.now();
    if (ev.replay && !again) a.ended = Number.isFinite(endTs) && endTs > 0 ? endTs : 0;
    a.failed = failed;
    a.result = ev.text ? String(ev.text) : again ? a.result : '';
    if (!again || n(ev.toolCount) !== null) a.toolCount = n(ev.toolCount);
    if (!again || n(ev.tokens) !== null) a.tokens = n(ev.tokens);
    var bits = [failed ? 'Failed' : 'Done'];
    if (a.toolCount !== null) bits.push(a.toolCount + (a.toolCount === 1 ? ' tool' : ' tools'));
    if (!again || n(ev.durationMs) !== null) a.durationMs = n(ev.durationMs);
    var d = a.durationMs === null ? '' : duration(a.durationMs); // unknown: no time (duration(null) is 0s)
    if (d) bits.push(d);
    a.stateEl.replaceChildren(el('span', { text: bits.join(' · ') }));
    a.chip.classList.remove('done', 'failed');
    a.chip.classList.add(failed ? 'failed' : 'done');
    // Never a spinner next to Done: the badge turns into a check (or ✕) and the bar is removed.
    a.card.classList.remove('done', 'failed');
    a.card.classList.add(failed ? 'failed' : 'done');
    var badge = a.card.querySelector('.abadge');
    if (badge) badge.replaceChildren(failed ? document.createTextNode('✕') : icon('check'));
    renderModes();
    updateAgentsBadge();
    var shown = a.card.querySelector('.aresult');
    if (ev.text && shown) shown.remove();
    if (ev.text) a.card.querySelector('.abody').appendChild(el('div', { class: 'aresult' }, el('div', { class: 'who', text: 'Result' }), renderMarkdown(ev.text)));
    if (!ev.replay && !again) setTimeout(function () { a.card.classList.remove('open'); }, 1200);
    pruneAgents();
  }

