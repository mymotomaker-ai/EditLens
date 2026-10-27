  // ---------- dictation: a mic button in the panel's message box and in the pick box ----------
  // The browser turns speech into text (SpeechRecognition): on this computer where it can, and online
  // only when the Dictation setting allows it. Words go in at the cursor and never replace typed text;
  // words still being heard show in grey. It never sends: Send, Add, Esc, the mic or a long silence stops it.
  ICONS.mic = 'M8.6 6a3.4 3.4 0 016.8 0v5.25a3.4 3.4 0 01-6.8 0zM5.25 11.25a6.75 6.75 0 0013.5 0M12 18v3.75';
  var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var DICT_ASKED_KEY = 'editlens.dictationAsked'; // the first-use card was answered in this browser
  var DICT_SILENCE_MS = 60000; // no words for this long: it stops
  var DICT_RESTARTS = 40; // the browser sometimes ends a session; it starts again while words come
  var DICT_LANG = (/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*/.exec(String(navigator.language || '')) || ['en-US'])[0];
  var DICT_MAKER = /\bEdg\//.test(navigator.userAgent) ? 'Microsoft' : /(Chrome|Chromium|CriOS)\//.test(navigator.userAgent) ? 'Google'
    : /\bSafari\//.test(navigator.userAgent) ? 'Apple' : 'the browser\'s maker';
  var DICT_BROWSER = DICT_MAKER === 'Microsoft' ? 'Edge' : DICT_MAKER === 'Google' ? 'Chrome' : DICT_MAKER === 'Apple' ? 'Safari' : 'The browser';
  // on: listening. closing: stopped by the user, last words still arriving. at, interim: where the grey
  // words are in the box's text. where: 'device' or 'online'. heard: when words last came. finals: how
  // many of this browser session's results are in the box already.
  var dictate = { on: false, closing: false, box: null, rec: null, at: 0, interim: '', where: '', heard: 0, restarts: 0, finals: 0, self: false, busy: false,
    startNo: 0, startBox: null };
  var dictHearTimer = 0;

  styleEl.textContent += [
    '.mic{position:relative;height:1.8em;min-width:1.8em;padding:0;border:0;border-radius:7px;background:transparent;color:var(--muted);display:inline-flex;align-items:center;justify-content:center;',
    'gap:5px;cursor:pointer;flex:none;font:600 11.5px/1 var(--sans)}',
    '.mic:hover{background:var(--fill);color:var(--fg)}.mic svg{width:1.15em;height:1.15em}.mic[hidden]{display:none}',
    '.mic.na{color:var(--faint);opacity:.55}',
    '.mic .lvl,.mic .mst,.mic .sq{display:none}',
    '.mic.rec{padding:0 9px 0 8px;border-radius:99px;background:var(--del);color:#fff}.mic.rec:hover{background:var(--del);color:#fff;filter:brightness(1.08)}',
    '.mic.rec svg{display:none}.mic.rec .lvl,.mic.rec .mst{display:inline-flex}.mic.rec .sq{display:inline-block}',
    '.mic .lvl{align-items:center;gap:2px;height:12px}.mic .lvl i{width:2.5px;height:4px;border-radius:2px;background:currentColor;opacity:.9}',
    '.mic.hear .lvl i{animation:lvl .9s ease-in-out infinite}.mic.hear .lvl i:nth-child(2){animation-delay:.15s}',
    '.mic.hear .lvl i:nth-child(3){animation-delay:.3s}.mic.hear .lvl i:nth-child(4){animation-delay:.45s}',
    '@keyframes lvl{0%,100%{height:4px}50%{height:12px}}',
    '@media (prefers-reduced-motion:reduce){.mic.hear .lvl i{animation:none;height:9px}}',
    '.mic .sq{width:7px;height:7px;border-radius:1.5px;background:currentColor}',
    '.notebox .mic{height:25px;min-width:25px}.notebox .mic.rec{padding:0 8px}',
    '.field{position:relative}.field.listen,.field.listen:focus-within{box-shadow:0 0 0 1px var(--del),0 0 0 4px var(--del-bg),var(--gshade)}',
    '.notebox.listen{box-shadow:var(--shadow),0 0 0 1.5px var(--del)}',
    '.dlst{display:none;align-items:center;gap:6px;margin:0 2px 5px;font-size:11.5px;color:var(--muted)}.dlst.on{display:flex}',
    '.dlst b{width:7px;height:7px;border-radius:50%;background:var(--del);flex:none}.dlst span{flex:1;min-width:0}.dlst em{font-style:normal;color:var(--faint)}',
    // The grey words: the box's own text is drawn by the copy behind it while they show.
    '.field.dictgrey textarea,.notebox.dictgrey textarea{color:transparent;caret-color:var(--fg)}',
    '.field.dictgrey .inmarks{color:var(--fg)}.inmarks .interim,.nbmirror .interim{color:var(--faint)}',
    '.nbwrap{position:relative;display:flex;flex:1 1 150px;min-width:120px}.notebox .nbwrap textarea{flex:1 1 auto;min-width:0;position:relative}',
    '.nbmirror{position:absolute;inset:0;overflow:hidden;pointer-events:none;color:transparent;font:inherit;padding:3px 2px;white-space:pre-wrap;overflow-wrap:break-word}',
    '.notebox.dictgrey .nbmirror{color:var(--fg)}',
    '.dpop{position:absolute;z-index:5;right:6px;bottom:calc(100% + 8px);width:min(300px,calc(100vw - 32px));padding:12px;border-radius:12px;background:var(--glass);',
    'box-shadow:var(--shadow);-webkit-backdrop-filter:blur(24px) saturate(1.4);backdrop-filter:blur(24px) saturate(1.4);font:12.5px/1.45 var(--sans);color:var(--fg);text-align:left}',
    '.notebox .dpop{bottom:auto;top:calc(100% + 8px)}',
    '.dpop h4{margin:0 0 4px;font:600 13px/1.35 var(--sans)}.dpop p{margin:0 0 8px;color:var(--fg2)}',
    '.dpop .opt{display:flex;gap:8px;align-items:flex-start;padding:7px 8px;margin:0 0 4px;border-radius:9px;cursor:pointer}.dpop .opt:hover{background:var(--fill)}',
    '.dpop .opt input{margin:2px 0 0;accent-color:var(--accent-fill)}.dpop .opt small{display:block;color:var(--faint);font-size:11.5px}',
    '.dpop .row2{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}',
    '.dpop .row2 button{padding:5px 12px;border:0;border-radius:8px;background:var(--fill2);color:var(--fg);font:600 12px/1.45 var(--sans);cursor:pointer}',
    '.dpop .row2 button.go{background:var(--accent-fill);color:#fff}',
  ].join('');

  // The mic button: grey mic; while listening a red pill (level bars, Stop and a square).
  function micButton(withWord) {
    var lvl = el('span', { class: 'lvl', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'), el('i'));
    var b = el('button', { class: 'mic', type: 'button', title: 'Dictate (Ctrl+Shift+Space)', 'aria-label': 'Dictate' },
      icon('mic'), lvl, withWord ? el('span', { class: 'mst', text: 'Stop' }) : null, el('span', { class: 'sq', 'aria-hidden': 'true' }));
    b.addEventListener('mousedown', function (e) { e.preventDefault(); }); // the focus stays in the box
    return b;
  }
  var panelMic = micButton(true);
  var noteMic = micButton(false);
  var dictLine = el('div', { class: 'dlst', role: 'status' }, el('b'), el('span'), el('em', { text: 'Esc stops' }));
  var panelField = input.closest('.field');
  sendButton.parentNode.insertBefore(panelMic, sendButton);
  panelField.insertBefore(dictLine, input.parentNode); // in the box, above its text
  // The pick box's text gets a copy behind it, for the grey words.
  var nbMirror = el('div', { class: 'nbmirror', 'aria-hidden': 'true' });
  var nbWrap = el('div', { class: 'nbwrap' });
  nbText.parentNode.insertBefore(nbWrap, nbText);
  nbWrap.appendChild(nbMirror);
  nbWrap.appendChild(nbText);
  nbAdd.parentNode.insertBefore(noteMic, nbAdd);
  nbText.addEventListener('scroll', function () { nbMirror.scrollTop = nbText.scrollTop; });

  var DICT_BOXES = [
    { kind: 'panel', area: input, ring: panelField, mic: panelMic, mirror: inMirror },
    { kind: 'note', area: nbText, ring: nbEl, mic: noteMic, mirror: nbMirror },
  ];
  function dictBoxOf(area) {
    return DICT_BOXES.filter(function (b) { return b.area === area; })[0] || null;
  }

  function dictSetting() {
    var v = settings.values && settings.values.dictation;
    return v === 'Allow online' || v === 'Off' ? v : 'On this device';
  }
  // Why dictation can't start here, known without asking the browser: 'browser' | 'insecure' | 'policy' | ''.
  function dictBlocked() {
    if (!SpeechRec) return 'browser';
    if (!window.isSecureContext) return 'insecure';
    var policy = document.permissionsPolicy || document.featurePolicy;
    if (policy && typeof policy.allowsFeature === 'function' && policy.allowsFeature('microphone') === false) return 'policy';
    return '';
  }
  var DICT_WHY = dict({
    browser: ['This browser can\'t turn speech into text', 'Use your system\'s dictation instead: Win+H on Windows, Fn twice on a Mac, the mic key on a phone keyboard.'],
    insecure: ['Dictation needs a secure page address', 'Open this page on localhost, or through the SSH tunnel, instead of a plain IP address.'],
    policy: ['This site doesn\'t allow the microphone', 'Its Permissions-Policy turns the microphone off. Use your system\'s dictation: Win+H on Windows, Fn twice on a Mac.'],
    blocked: ['The microphone is blocked for this page', 'Allow it in the address bar (the icon at its left), then press the mic again.'],
    nomic: ['No microphone was found', 'Connect one, then press the mic again.'],
    network: ['The browser couldn\'t connect to its speech service', 'Check your connection, or use your system\'s dictation: Win+H on Windows, Fn twice on a Mac.'],
    language: ['This browser can\'t turn ' + DICT_LANG + ' speech into text', 'Use your system\'s dictation: Win+H on Windows, Fn twice on a Mac.'],
    download: ['The speech model couldn\'t be downloaded', 'Press the mic to try again, or choose Allow online for Dictation in Settings.'],
    device: ['This browser can\'t do it on this device', DICT_BROWSER + ' sends the audio to ' + DICT_MAKER + ' to turn it into text. Choose Allow online for Dictation in Settings to use it.'],
    failed: ['Dictation stopped', 'Press the mic to start again.'],
  });

  // The mics show the setting and whether this browser can dictate at all.
  function renderMics() {
    if (!DICT_BOXES) return; // a setting arrived before this part ran
    var off = dictSetting() === 'Off';
    var blocked = dictBlocked();
    DICT_BOXES.forEach(function (b) {
      b.mic.hidden = off;
      b.mic.classList.toggle('na', Boolean(blocked));
      b.mic.title = blocked ? DICT_WHY[blocked][0] + ' · press for more' : 'Dictate (Ctrl+Shift+Space)';
      var live = (dictate.on || dictate.closing) && dictate.box === b;
      b.mic.classList.toggle('rec', live);
      b.mic.setAttribute('aria-label', live ? 'Stop dictating' : 'Dictate');
      b.ring.classList.toggle('listen', live);
    });
    var panelLive = (dictate.on || dictate.closing) && dictate.box === DICT_BOXES[0];
    dictLine.classList.toggle('on', panelLive);
    dictLine.querySelector('span').textContent = 'Listening · ' + (dictate.where === 'online' ? 'online, ' + DICT_MAKER : 'on this device');
  }
  function dictateSettingChanged() {
    if (dictSetting() === 'Off') {
      dictateStop();
      closeDictCard();
    } else if (dictate && dictSetting() !== 'Allow online' && dictate.where === 'online' && (dictate.on || dictate.closing)) {
      // Online is no longer allowed: listening online stops now, its grey words removed (Sol M9).
      dictFinish(false);
      showToast('Dictation stopped: the setting now allows this device only.', 4000);
    }
    renderMics();
  }

  // ----- the card above the mic: first use, and why it can't start -----
  var dictCard = null;
  // The open first-use card's answer: Esc and a click outside answer Not now.
  var dictCardCancel = null;
  function closeDictCard() {
    if (dictCard && dictCard.parentNode) dictCard.parentNode.removeChild(dictCard);
    dictCard = null;
    var cancel = dictCardCancel;
    dictCardCancel = null;
    if (cancel) cancel(null);
  }
  function dictCardAt(box, node) {
    closeDictCard();
    dictCard = node;
    (box.kind === 'panel' ? panelField : nbEl).appendChild(node);
    var first = node.querySelector('input:checked, button.go, button');
    if (first) first.focus({ preventScroll: true });
  }
  function whyCard(box, why) {
    var w = DICT_WHY[why] || DICT_WHY.failed;
    dictCardAt(box, el('div', { class: 'dpop', role: 'dialog', 'aria-label': w[0] }, el('h4', { text: w[0] }), el('p', { text: w[1] }),
      el('div', { class: 'row2' }, el('button', { type: 'button', class: 'go', text: 'OK', on: { click: function () { closeDictCard(); box.area.focus(); } } }))));
  }
  // local: the browser can do it on this device ('available' or to download). -> a promise of
  // 'device' | 'online' | null (Not now)
  function askCard(box, local) {
    return new Promise(function (resolve) {
      var done = function (v) {
        dictCardCancel = null;
        closeDictCard();
        box.area.focus({ preventScroll: true });
        resolve(v);
      };
      var go = el('button', { type: 'button', class: 'go' });
      var row = el('div', { class: 'row2' }, el('button', { type: 'button', text: 'Not now', on: { click: function () { done(null); } } }), go);
      if (local) {
        var dev = el('input', { type: 'radio', name: 'dwhere', value: 'device' });
        var onl = el('input', { type: 'radio', name: 'dwhere', value: 'online' });
        (dictSetting() === 'Allow online' ? onl : dev).checked = true;
        var label = function () { go.textContent = onl.checked || local === 'available' ? 'Start' : 'Download and start'; };
        dev.addEventListener('change', label);
        onl.addEventListener('change', label);
        label();
        go.addEventListener('click', function () { done(onl.checked ? 'online' : 'device'); });
        dictCardAt(box, el('div', { class: 'dpop', role: 'dialog', 'aria-label': 'Dictation' }, el('h4', { text: 'Speak instead of typing' }),
          el('label', { class: 'opt' }, dev, el('span', null, document.createTextNode('On this device only'),
            el('small', { text: local === 'available' ? 'Your voice stays on this computer.' : DICT_BROWSER + ' downloads the speech model once. Your voice stays on this computer.' }))),
          el('label', { class: 'opt' }, onl, el('span', null, document.createTextNode('Online (' + DICT_MAKER + ')'),
            el('small', { text: DICT_BROWSER + ' sends the audio to ' + DICT_MAKER + ' to turn it into text.' }))), row));
      } else {
        go.textContent = 'Allow';
        go.addEventListener('click', function () { done('online'); });
        dictCardAt(box, el('div', { class: 'dpop', role: 'dialog', 'aria-label': 'Dictation' }, el('h4', { text: 'Speak instead of typing' }),
          el('p', { text: DICT_BROWSER + ' sends the audio to ' + DICT_MAKER + ' to turn it into text. Nothing else from the page is sent.' }), row));
      }
      dictCardCancel = done;
    });
  }
  document.addEventListener('pointerdown', function (e) {
    if (dictCard && e.composedPath().indexOf(dictCard) < 0) closeDictCard();
  }, true);

  // Can the browser do it on this device? -> a promise of 'available' | 'downloadable' | 'unavailable'
  function dictLocal() {
    if (!SpeechRec || typeof SpeechRec.available !== 'function') return Promise.resolve('unavailable');
    var asked;
    try {
      asked = SpeechRec.available({ langs: [DICT_LANG], processLocally: true });
    } catch (err) {
      if (!(err instanceof TypeError || err instanceof DOMException)) throw err;
      return Promise.resolve('unavailable');
    }
    return Promise.resolve(asked).then(function (v) {
      return v === 'available' ? 'available' : v === 'downloadable' || v === 'downloading' ? 'downloadable' : 'unavailable';
    }, function (err) {
      if (!(err instanceof DOMException || err instanceof TypeError)) throw err;
      return 'unavailable';
    });
  }
  function dictInstall() {
    if (typeof SpeechRec.install !== 'function') return Promise.resolve(false);
    try {
      return Promise.resolve(SpeechRec.install({ langs: [DICT_LANG], processLocally: true })).then(function (ok) { return ok === true; }, function (err) {
        if (!(err instanceof DOMException || err instanceof TypeError)) throw err;
        return false;
      });
    } catch (err) {
      if (!(err instanceof TypeError || err instanceof DOMException)) throw err;
      return Promise.resolve(false);
    }
  }
  // Where it runs: the setting, the first-use card's answer and what the browser can do.
  // no: the start's number; Send or a closed box since then (a new number): no card, and null.
  // -> a promise of 'device' | 'online' | null (not started; a card says why, or Not now)
  function dictWhere(box, no) {
    var why = function (kind) {
      if (no === dictate.startNo) whyCard(box, kind);
      return null;
    };
    var install = function () {
      return dictInstall().then(function (ok) { return ok ? 'device' : why('download'); });
    };
    return dictLocal().then(function (local) {
      if (no !== dictate.startNo) return null;
      var asked = storageGet('localStorage', DICT_ASKED_KEY) === 'yes';
      var setting = dictSetting();
      var canLocal = local !== 'unavailable';
      if (asked && setting === 'Allow online') return local === 'available' ? 'device' : 'online';
      if (asked && canLocal) return local === 'available' ? 'device' : install();
      if (asked && !canLocal) return why('device');
      return askCard(box, canLocal ? local : '').then(function (choice) {
        if (!choice) return null;
        storageSet('localStorage', DICT_ASKED_KEY, 'yes');
        var want = choice === 'online' ? 'Allow online' : 'On this device';
        if (want !== setting) changeSetting('dictation', want);
        if (choice === 'online') return 'online';
        return local === 'available' ? 'device' : install();
      });
    });
  }

  // ----- listening -----
  function dictToggle(box) {
    if (dictSetting() === 'Off' || box.area.disabled) return;
    if ((dictate.on || dictate.closing) && dictate.box === box) return dictFinish(true);
    if (dictate.on || dictate.closing) dictateStop();
    var blocked = dictBlocked();
    if (blocked) return whyCard(box, blocked);
    if (dictate.busy) return undefined;
    dictate.busy = true;
    // This start's number: Send or a closed box raises dictate.startNo, and the start then does nothing.
    var no = ++dictate.startNo;
    dictate.startBox = box;
    var micState = navigator.permissions && typeof navigator.permissions.query === 'function'
      ? navigator.permissions.query({ name: 'microphone' }).then(function (p) { return p && p.state; }, function (err) {
        // Browsers that don't know the "microphone" permission name refuse the question.
        if (!(err instanceof DOMException || err instanceof TypeError)) throw err;
        return '';
      }) : Promise.resolve('');
    micState.then(function (state) {
      if (no !== dictate.startNo) return null;
      if (state === 'denied') return (whyCard(box, 'blocked'), null);
      return dictWhere(box, no);
    }).then(function (where) {
      if (no !== dictate.startNo) return;
      dictStartDone();
      // The setting may have turned Off while it waited (the card, the download), or the box closed.
      if (where && dictSetting() !== 'Off' && !box.area.disabled && box.area.getClientRects().length) dictBegin(box, where);
    }, function (err) {
      if (no === dictate.startNo) dictStartDone();
      throw err;
    });
    return undefined;
  }
  function dictStartDone() {
    dictate.busy = false;
    dictate.startBox = null;
  }
  // An error from start, stop or abort of the Web Speech API: only the DOMException names it may
  // throw there pass (InvalidStateError: already started or not running; NotAllowedError from start:
  // the browser refuses the microphone). Anything else is thrown again.
  function dictExpected(err, names) {
    if (!(err instanceof DOMException) || names.indexOf(err.name) < 0) throw err;
  }
  function dictBegin(box, where) {
    var rec = new SpeechRec();
    rec.lang = DICT_LANG;
    rec.continuous = true;
    rec.interimResults = true;
    if (where === 'device') rec.processLocally = true;
    var v = box.area.value;
    var at = box.area === document.activeElement || (box.area.getRootNode && box.area.getRootNode().activeElement === box.area) ? box.area.selectionEnd : v.length;
    dictate.on = true;
    dictate.closing = false;
    dictate.box = box;
    dictate.rec = rec;
    dictate.at = Number.isFinite(at) ? Math.max(0, Math.min(at, v.length)) : v.length;
    dictate.interim = '';
    dictate.where = where;
    dictate.heard = Date.now();
    dictate.restarts = 0;
    dictate.finals = 0;
    rec.onresult = function (e) {
      if (dictate.rec !== rec) return;
      var fin = '';
      var mid = '';
      var list = e && e.results ? e.results : [];
      var from = Number.isInteger(e && e.resultIndex) && e.resultIndex >= 0 ? e.resultIndex : 0;
      for (var i = from; i < list.length; i++) {
        var r = list[i];
        var t = r && r[0] && typeof r[0].transcript === 'string' ? r[0].transcript : '';
        if (r && r.isFinal && i < dictate.finals) continue; // in the box already
        if (r && r.isFinal) {
          fin += (fin ? ' ' : '') + t.trim();
          dictate.finals = i + 1;
        } else mid += (mid ? ' ' : '') + t.trim();
      }
      dictHear();
      dictPut(fin, dictate.on ? mid : '');
    };
    rec.onspeechstart = function () { if (dictate.rec === rec) dictHear(); };
    rec.onerror = function (e) {
      if (dictate.rec !== rec) return;
      var code = e && typeof e.error === 'string' ? e.error : '';
      if (code === 'no-speech' || code === 'aborted') return;
      var why = code === 'not-allowed' || code === 'service-not-allowed' ? 'blocked' : code === 'audio-capture' ? 'nomic' : code === 'network' ? 'network'
        : code === 'language-not-supported' ? (where === 'device' ? 'device' : 'language') : 'failed';
      dictFinish(false);
      whyCard(box, why);
    };
    rec.onend = function () {
      if (dictate.rec !== rec) return;
      // The browser ends a session after a pause: it starts again while words came lately.
      if (dictate.on && Date.now() - dictate.heard < DICT_SILENCE_MS && dictate.restarts < DICT_RESTARTS) {
        dictate.restarts++;
        dictate.finals = 0; // a new session numbers its results from 0
        try {
          rec.start();
          return;
        } catch (err) {
          dictExpected(err, ['InvalidStateError', 'NotAllowedError']);
        }
      }
      var silent = dictate.on;
      dictFinish(false, true);
      if (silent) showToast('Dictation stopped: no words for a minute', 2600);
    };
    try {
      rec.start();
    } catch (err) {
      dictExpected(err, ['InvalidStateError', 'NotAllowedError']);
      dictate.on = false;
      dictate.rec = null;
      whyCard(box, 'failed');
      return;
    }
    renderMics();
  }
  function dictHear() {
    dictate.heard = Date.now();
    var mic = dictate.box && dictate.box.mic;
    if (!mic) return;
    mic.classList.add('hear');
    clearTimeout(dictHearTimer);
    dictHearTimer = setTimeout(function () { mic.classList.remove('hear'); }, 900);
  }
  // Final words are kept permanently; words still being heard replace the earlier grey words.
  function dictPut(fin, mid) {
    var box = dictate.box;
    if (!box) return;
    var area = box.area;
    var v = area.value;
    var a = Math.max(0, Math.min(dictate.at, v.length));
    var b = a + dictate.interim.length;
    // Typed over or moved: the words go where the cursor is now.
    if (v.slice(a, b) !== dictate.interim) {
      var c = Number(area.selectionEnd);
      a = b = Number.isFinite(c) ? Math.max(0, Math.min(c, v.length)) : v.length;
    }
    var before = v.slice(0, a);
    var lead = before && !/\s$/.test(before) ? ' ' : '';
    var f = fin.trim() ? lead + fin.trim() : '';
    var m = mid.trim() ? (f ? ' ' : lead) + mid.trim() : '';
    if (!f && !m && a === b) return;
    area.value = before + f + m + v.slice(b);
    dictate.at = a + f.length;
    dictate.interim = m;
    var end = dictate.at + m.length;
    area.setSelectionRange(end, end);
    dictate.self = true;
    try {
      area.dispatchEvent(new Event('input', { bubbles: true }));
    } finally {
      dictate.self = false;
    }
    dictMirror(box);
  }
  // The box's text with the grey words, drawn behind it while they show.
  function dictMirror(box) {
    var grey = Boolean(dictate.interim) && dictate.box === box;
    box.ring.classList.toggle('dictgrey', grey);
    if (!grey) {
      if (box.kind === 'panel') renderInputMarks();
      else box.mirror.replaceChildren();
      return;
    }
    var v = box.area.value;
    var a = dictate.at;
    var b = a + dictate.interim.length;
    box.mirror.replaceChildren(document.createTextNode(v.slice(0, a)), el('span', { class: 'interim', text: v.slice(a, b) }), document.createTextNode(v.slice(b) + '​'));
    if (box.kind === 'panel') {
      var pad = parseFloat(getComputedStyle(box.mirror).paddingLeft);
      box.mirror.style.width = box.area.clientWidth + (Number.isFinite(pad) ? pad : 0) + 'px';
    }
    box.mirror.scrollTop = box.area.scrollTop;
  }
  // keep: the user stopped it (the mic or Esc): the last words still arrive. Otherwise it ends now.
  // ended: the browser ended it already.
  function dictFinish(keep, ended) {
    var rec = dictate.rec;
    var box = dictate.box;
    dictate.on = false;
    if (keep && rec) {
      dictate.closing = true;
      try {
        rec.stop();
      } catch (err) {
        dictExpected(err, ['InvalidStateError']);
      }
      // Words still being heard become final, or are removed when the browser says no more.
      setTimeout(function () { if (dictate.rec === rec) dictFinish(false); }, 2500);
      renderMics();
      return;
    }
    dictate.closing = false;
    dictate.rec = null;
    if (rec && !ended) {
      try {
        rec.abort();
      } catch (err) {
        dictExpected(err, ['InvalidStateError']);
      }
    }
    if (box && dictate.interim) {
      var v = box.area.value;
      var a = dictate.at;
      if (v.slice(a, a + dictate.interim.length) === dictate.interim) {
        box.area.value = v.slice(0, a) + v.slice(a + dictate.interim.length);
        dictate.interim = '';
        dictate.self = true;
        try {
          box.area.dispatchEvent(new Event('input', { bubbles: true }));
        } finally {
          dictate.self = false;
        }
      }
    }
    dictate.interim = '';
    clearTimeout(dictHearTimer);
    if (box) {
      box.mic.classList.remove('hear');
      dictMirror(box);
    }
    dictate.box = null;
    renderMics();
  }
  // Send, Add, a closed pick box or the setting turned off: it stops now, without the grey words.
  // area: only when dictating into that box.
  function dictateStop(area) {
    if (!dictate) return;
    // A start still waiting (the card, the download) for that box is canceled.
    if (dictate.busy && (!area || (dictate.startBox && dictate.startBox.area === area))) {
      dictate.startNo++;
      dictStartDone();
    }
    if (!(dictate.on || dictate.closing)) return;
    if (area && (!dictate.box || dictate.box.area !== area)) return;
    dictFinish(false);
  }

  DICT_BOXES.forEach(function (box) {
    box.mic.addEventListener('click', function () { dictToggle(box); });
    // Typed while it listens: the next words go where the cursor is.
    box.area.addEventListener('input', function () {
      if (dictate.self || dictate.box !== box) return;
      if (dictate.interim) return dictMirror(box);
      var c = Number(box.area.selectionEnd);
      if (Number.isFinite(c)) dictate.at = c;
      return undefined;
    });
    // Before the box's own keys (Esc closes the pick box, Enter sends): Esc stops dictating first.
    var host = box.kind === 'panel' ? panelField : nbEl;
    host.addEventListener('keydown', function (e) {
      if (e.code === 'Space' && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.target === box.area) {
        e.preventDefault();
        e.stopPropagation();
        dictToggle(box);
      } else if (e.key === 'Escape' && dictCard && host.contains(dictCard)) {
        e.preventDefault();
        e.stopPropagation();
        closeDictCard();
        box.area.focus();
      } else if (e.key === 'Escape' && (dictate.on || dictate.closing) && dictate.box === box) {
        e.preventDefault();
        e.stopPropagation();
        dictFinish(true);
      }
    }, true);
  });
  renderMics();
