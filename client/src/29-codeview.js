  // Part of the page script: the files in client/src are joined in order (lib/client-script.js)
  // and share the one scope opened in 1-panel.js.
  // ---------- the code view (elements are made in 2-page.js) ----------
  // Header: sidebar, file path (its name opens the file menu), Follow, playback, Split, View, Close.
  // Sidebar (Edits, Files, Agents) or a thin strip; panes with tabs, change bars, folds, edge marks;
  // a timeline at the bottom. Narrow: the sidebar is a sheet; phone: a bottom sheet at three heights.
  styleEl.textContent += [
    // The header: one row.
    '.dhead{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:.5px solid var(--line2);min-width:0;flex:none}',
    '.dhead button.icon,.dstrip button.icon{width:28px;height:28px;border:0;border-radius:7px}.dhead button.icon svg,.dstrip button.icon svg{width:16px;height:16px}',
    '.dhead button.icon:hover,.dstrip button.icon:hover{background:var(--fill);color:var(--fg)}',
    '.dhead button.xred:hover{background:var(--del-bg);color:var(--del)}',
    '.dhead button.dsb[aria-pressed=true]{color:var(--fg)}',
    '.dgap{flex:1 1 0;min-width:0}.dbr{display:none}',
    '.crumb{display:flex;align-items:center;min-width:0;flex:0 1 auto;font-size:.893em;color:var(--muted);white-space:nowrap}',
    // The folder is cut from the left; the name stays whole.
    '.crumb .cdir{flex:0 1000 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}',
    '.crumb .cdir>span{direction:ltr;unicode-bidi:isolate}',
    '.crumb .sep{color:var(--faint);margin:0 4px}',
    '.crumb .cnone{color:var(--fg);font-weight:600;padding:0 4px}',
    '.fbtn{display:inline-flex;align-items:center;gap:5px;flex:0 1 auto;min-width:0;padding:3px 7px;border:0;border-radius:7px;background:transparent;color:var(--fg);cursor:pointer;font:inherit}',
    '.fbtn:hover{background:var(--fill)}.fbtn b{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0}',
    '.fbtn svg{width:11px;height:11px;flex:none;color:var(--muted)}',
    '.dock .cno[hidden]{display:none}.fbtn .cno,.tab .cno{width:14px;height:14px;font-size:8px}',
    // Follow shrinks before the path does (its text is cut, its dot stays).
    '.fhead{flex:0 50 auto;min-width:42px;max-width:42%;display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border:0;border-radius:99px;background:var(--fill);color:var(--fg);',
    'font:500 .857em/1.45 var(--sans);white-space:nowrap;cursor:pointer}',
    '.fhead:hover{background:var(--fill2)}.fhead.on{box-shadow:0 0 0 1.5px var(--accent)}',
    '.fhead .ftx{min-width:0;overflow:hidden;text-overflow:ellipsis}.fhead .aw{color:var(--muted)}.fhead svg{width:11px;height:11px;flex:none;color:var(--muted)}',
    '.am.every{background:var(--fg)}',
    '.dpqb{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:0;border-radius:99px;background:color-mix(in srgb,var(--warn) 15%,transparent);',
    'color:var(--warn);font:600 .82em var(--sans);cursor:pointer;flex:none}.dpqb[hidden]{display:none}.dpqb svg{width:14px;height:14px}',
    '.capsule{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:9px;background:var(--fill);flex:none}',
    '.capsule button.icon{width:26px;height:24px;border-radius:7px}.capsule button.icon svg{width:15px;height:15px}',
    '.capsule button.icon:hover:not(:disabled){background:var(--fill2)}.capsule button.icon:disabled{opacity:.4;cursor:default}',
    '.dqueue{display:inline-flex;align-items:center;gap:5px;padding:0 6px;font:500 .82em/1 var(--sans);color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.dqueue .qdot{width:6px;height:6px;border-radius:50%;background:var(--accent);animation:qpulse 1.2s ease-in-out infinite}',
    '@keyframes qpulse{50%{opacity:.25}}',
    '.dqueue .sh{display:none}',
    '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}',
    // The body: the sidebar or the strip, then the code and the timeline.
    '.dbody{flex:1;min-height:0;display:flex}',
    '.dside{width:236px;flex:none;display:flex;flex-direction:column;gap:6px;padding:8px;background:var(--sunk);border-right:.5px solid var(--line2);min-width:0;min-height:0}',
    '.dock.noside .dbody>.dside,.dock.narrow .dbody>.dside{display:none}',
    '.dseg{display:flex;padding:2px;border-radius:8px;background:var(--fill);flex:none}',
    '.dseg button{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:3px 0;border:0;border-radius:6px;background:transparent;color:var(--muted);font:500 .857em/1.4 var(--sans);cursor:pointer}',
    '.dseg button:hover{color:var(--fg)}.dseg button[aria-selected=true]{background:var(--raise);color:var(--fg);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12)}',
    '.dseg .k{color:var(--muted);font-weight:400}.dseg .k:empty{display:none}',
    '.sbody{flex:1;min-height:0;overflow:auto;margin:0 -8px;padding:0 8px;' + THIN_SCROLL + '}',
    '.spanel{display:none;flex-direction:column;gap:1px}.spanel.on{display:flex}',
    '.egh{display:flex;align-items:center;gap:6px;padding:8px 6px 2px;font:600 .786em/1.4 var(--sans);color:var(--muted);min-width:0}',
    '.egh .q{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.egh .k{margin-left:auto;font-weight:400;flex:none}',
    '.egh .mini{margin-left:auto;flex:none;font-size:1em;padding:1px 8px}.egh .mini+.mini{margin-left:0}',
    '.egh.missed{flex-wrap:wrap}.egh.missed .q{white-space:normal}',
    '.erow{display:grid;grid-template-columns:16px minmax(0,1fr);gap:2px 8px;width:100%;padding:6px;border:0;border-radius:8px;background:transparent;color:var(--fg);',
    'font:400 .857em/1.4 var(--sans);text-align:left;cursor:pointer}',
    '.erow:hover{background:var(--fill)}.erow.on{background:var(--raise);box-shadow:0 0 0 .5px var(--line2),0 1px 2px rgba(0,0,0,.06)}',
    '.erow .cno{margin-top:1px}',
    '.erow .ef{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.erow .ef span{color:var(--faint);font-weight:400;margin-left:4px}',
    '.erow .ew{grid-column:2;display:flex;align-items:center;gap:6px;min-width:0;color:var(--muted);font-size:.96em;white-space:nowrap;overflow:hidden}',
    '.erow .ew .an{overflow:hidden;text-overflow:ellipsis;min-width:0}.erow .ew .aw{flex:none}',
    '.erow .cnt{margin-left:auto;flex:none;font:.92em var(--mono)}.erow .cnt .a{color:var(--add)}.erow .cnt .d{color:var(--del)}',
    '.am.rs{background:var(--ctx)}',
    '.sempty{padding:10px 6px;color:var(--muted);font-size:.857em;line-height:1.5}',
    '.sdfoot{flex:none;display:flex;align-items:center;gap:6px;padding:6px 6px 2px;font-size:.82em;color:var(--muted)}.sdfoot[hidden]{display:none}',
    '.sdfoot button{border:0;background:transparent;color:var(--muted);padding:2px 0;font:inherit;cursor:pointer}',
    '.sdfoot button:hover:not(:disabled){color:var(--fg)}.sdfoot button:disabled{opacity:.45;cursor:default}.sdfoot .more{margin-left:auto}',
    '.frow{display:flex;align-items:center;gap:8px;width:100%;padding:5px 6px;border:0;border-radius:7px;background:transparent;color:var(--fg);',
    'font:400 .857em/1.4 var(--sans);text-align:left;cursor:pointer;min-width:0}',
    '.frow:hover{background:var(--fill)}.frow.on{background:var(--raise);box-shadow:0 0 0 .5px var(--line2)}',
    '.frow svg{width:14px;height:14px;flex:none;color:var(--muted)}.frow .fn{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1 auto}',
    '.frow .fd{color:var(--faint);margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;min-width:0;flex:0 1000 auto}',
    '.sagents .swlist{max-height:none;overflow:visible;padding:0}.sagents .arow{font-size:.93em}.sagents .swhint{padding:8px 6px}',
    // The strip left when the sidebar is hidden (not in a narrow code view or on a phone).
    '.dstrip{display:none;width:40px;flex:none;flex-direction:column;align-items:center;gap:4px;padding:8px 4px;background:var(--sunk);border-right:.5px solid var(--line2)}',
    '.dock.noside:not(.narrow) .dstrip{display:flex}',
    '.dstrip button.icon{position:relative}.dstrip button[aria-pressed=true]{background:var(--raise);color:var(--fg);box-shadow:0 0 0 .5px var(--line2)}',
    '.dstrip hr{width:20px;border:0;border-top:.5px solid var(--line2);margin:4px 0}.dstrip .sgap{flex:1}',
    '.dstrip .bdg{position:absolute;top:-3px;right:-5px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--accent-fill);color:#fff;font:600 9px/14px var(--sans);text-align:center}',
    '.dstrip .bdg:empty{display:none}',
    // The code: panes, each with its own tabs.
    '.dmain{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}',
    '.panes{flex:1;min-height:0;display:flex;flex-direction:column}.panes[data-dir=cols]{flex-direction:row}',
    '.pgrp{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;background:var(--code-bg)}.pgrp.empty{display:none}',
    '.ptrow{display:flex;align-items:flex-end;gap:6px;padding:6px 8px 0;border-bottom:.5px solid var(--line2);background:var(--bg);flex:none;min-width:0}',
    // The focused pane: a thin accent line above its tabs.
    '.pgrp.focus>.ptrow{box-shadow:inset 0 1.5px 0 var(--accent)}.ptrow.drop{background:var(--accent-soft)}',
    '.ptabs{display:flex;gap:2px;min-width:0;overflow-x:auto;flex:1 1 auto;scrollbar-width:none}.ptabs::-webkit-scrollbar{display:none}',
    '.tab{display:inline-flex;align-items:center;gap:6px;padding:6px 6px 6px 10px;border-radius:8px 8px 0 0;font:400 .857em/1.3 var(--sans);color:var(--muted);',
    'white-space:nowrap;flex:none;cursor:pointer;outline:none}',
    '.tab:hover{color:var(--fg)}.tab:focus-visible{box-shadow:inset 0 0 0 2px var(--focus)}',
    '.tab.on{background:var(--code-bg);color:var(--fg);font-weight:600;box-shadow:0 0 0 .5px var(--line2)}',
    '.tab .kd{display:none;width:6px;height:6px;border-radius:50%;background:var(--accent);flex:none}.tab.busy .kd{display:block;animation:ping 1.2s ease-out infinite}',
    '.tab.backend .kd{background:var(--api)}.tab.dragging{opacity:.45}',
    '.tab .x{width:16px;height:16px;border:0;border-radius:4px;background:transparent;color:var(--faint);display:grid;place-items:center;padding:0;cursor:pointer;font-size:13px;line-height:1}',
    '.tab .x:hover{background:var(--fill2);color:var(--fg)}',
    '.pinfo{flex:none;display:flex;align-items:center;gap:8px;padding:0 2px 6px;font-size:.786em;color:var(--faint);white-space:nowrap;min-width:0;max-width:45%}',
    '.pinfo .who{display:none;min-width:0}.pinfo .who.on{display:inline-flex}.pinfo .who .achip{max-width:100%}',
    '.pfol{flex:none;margin:0 0 4px;padding:2px 8px;border:0;border-radius:99px;background:transparent;color:var(--muted);font:500 .786em/1.4 var(--sans);cursor:pointer;white-space:nowrap}',
    '.pfol:hover{background:var(--fill)}.pfol[aria-pressed=true]{background:var(--accent-soft);color:var(--accent-ink)}.pfol[hidden]{display:none}',
    '.gbody{flex:1;min-height:0;display:flex;flex-direction:column}',
    '.pdrop{display:none;margin:auto;padding:14px 18px;border:1.5px dashed var(--accent-line);border-radius:12px;color:var(--accent-ink);font-size:.857em}',
    '.panes.dragging .pdrop.on{display:block}.pdrop.over{background:var(--accent-soft)}',
    '.pane{flex:1;min-height:0;display:none;flex-direction:column;background:var(--code-bg);overflow:hidden}.pane.on{display:flex}',
    '.pane>.rconf{margin:.45em .9em;flex:none}',
    '.cwrap{flex:1;min-height:0;position:relative;display:flex;flex-direction:column}',
    '.dock .code{font-size:.86em;outline:none}.dock .code:focus-visible{box-shadow:inset 0 0 0 2px var(--focus)}',
    // A change's bar: its number, why, who and when, and what can be done with it.
    '.hbar{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin:4px 12px 4px 4.5em;padding:4px 6px 4px 8px;border-radius:8px;background:var(--fill);',
    'font:400 1em/1.45 var(--sans);color:var(--fg);white-space:normal;counter-increment:none;min-width:0;max-width:calc(100% - 5.5em);box-sizing:border-box}',
    '.hbar .why{font-weight:600;min-width:0;overflow-wrap:anywhere}',
    '.hbar .hw{display:inline-flex;align-items:center;gap:6px;min-width:0;color:var(--muted)}.hbar .hw .achip{background:transparent;padding:0}',
    '.hbar .near{padding:0 7px;border-radius:99px;background:var(--fill2);color:var(--muted);font-size:.92em}',
    '.hbar .acts{margin-left:auto;display:flex;gap:2px;flex:none}',
    '.hbar .acts button{padding:2px 9px;border:0;border-radius:6px;background:transparent;color:var(--muted);font:500 .96em/1.4 var(--sans);cursor:pointer}',
    '.hbar .acts button:hover:not(:disabled){background:var(--fill2);color:var(--fg)}.hbar .acts button:disabled{opacity:.4;cursor:default}',
    '.hbar .acts .bmore{display:none}',
    '.hbar.part{background:transparent;padding-top:0;padding-bottom:0}.hbar.part .why{font-weight:500;color:var(--muted)}',
    '.hbar.hl{background:var(--accent-soft);box-shadow:0 0 0 1.5px var(--accent)}',
    '.hbar.rst .cno{background:var(--ctx)}',
    '.hbar button.cno{border:0;padding:0;margin:0;cursor:pointer;font:600 9px/1 var(--sans)}.hbar button.cno:focus-visible{outline:2px solid var(--focus);outline-offset:1px}',
    '.hbox{margin:0 12px 6px 4.5em;font:400 1em/1.45 var(--sans);white-space:normal;counter-increment:none}.hbox:empty{display:none}.hbox .rconf{margin:0}',
    '.cfold{display:flex;align-items:center;gap:6px;margin:2px 12px 2px 4.5em;padding:2px 6px;border:0;border-radius:6px;background:transparent;color:var(--muted);',
    'font:400 .96em/1.5 var(--sans);cursor:pointer;white-space:normal}',
    '.cfold:hover{background:var(--fill);color:var(--fg)}.cfold svg{width:11px;height:11px}',
    '.cl.fold{display:none}',
    '.emarks{position:absolute;right:3px;top:8px;bottom:8px;width:5px;border-radius:3px;background:var(--fill);z-index:1}.emarks:empty{display:none}',
    '.emarks i{position:absolute;left:0;right:0;min-height:4px;border-radius:2px;background:var(--accent);cursor:pointer}',
    '.emarks i.lm{background:var(--agent)}.emarks i.rs{background:var(--ctx)}',
    // The timeline: one tick per edit in its agent's colour; faded ticks are still waiting.
    '.timeline{display:flex;align-items:center;gap:10px;padding:8px 12px;border-top:.5px solid var(--line2);font-size:.82em;color:var(--muted);flex:none;background:var(--bg)}',
    '.timeline .tl0,.timeline .tl1{white-space:nowrap;font-variant-numeric:tabular-nums}.timeline .tl0:empty{display:none}',
    '.track{position:relative;flex:1;height:22px;min-width:80px;cursor:pointer;touch-action:none;outline:none;border-radius:6px}',
    '.track::before{content:"";position:absolute;left:0;right:0;top:10px;height:2px;border-radius:1px;background:var(--fill2)}',
    '.track:focus-visible{box-shadow:0 0 0 2px var(--focus)}',
    '.track .tld{position:absolute;left:0;top:10px;height:2px;border-radius:1px;background:var(--accent)}',
    '.track .tlt{position:absolute;top:5px;width:3px;height:12px;border-radius:2px;transform:translateX(-1px);background:var(--add)}.track .tlt.wait{opacity:.4}',
    '.track .tlh{position:absolute;top:3px;width:16px;height:16px;border-radius:50%;background:var(--raise);box-shadow:0 0 0 1.5px var(--accent),0 1px 3px rgba(0,0,0,.2);',
    'transform:translateX(-8px);border:0;padding:0;cursor:grab}.track.drag .tlh{cursor:grabbing}',
    '.track .tlnone{position:absolute;left:0;top:2px;color:var(--faint);background:var(--bg);padding-right:8px}',
    '.timeline button.speed{height:22px;padding:0 8px;border:0;border-radius:99px;background:var(--fill);color:var(--fg);font:500 1em var(--sans);cursor:pointer;flex:none}',
    '.timeline button.speed:hover{background:var(--fill2)}',
    '.timeline .tlp,.timeline .tln{display:none}',
    '.dock.tiny .timeline{display:none}',
    // Menus: View and Follow.
    '.vmenu .vrow{display:flex;align-items:center;gap:10px;padding:5px 8px}.vmenu .vrow .lbl{flex:1}.vmenu .vrow .seg3{flex:none;min-width:116px}',
    '.vmenu .vsp button{font-size:11.5px;padding:3px 6px}',
    '.vmenu .side2{display:flex;gap:2px;padding:2px;border-radius:7px;background:var(--fill);flex:none}',
    '.lmenu .vmenu .side2 button,.vmenu .side2 button{width:auto;padding:2px 8px;border-radius:5px;font-size:11.5px;color:var(--muted)}',
    '.vmenu .side2 button.on{background:var(--raise);color:var(--fg);box-shadow:0 1px 2px rgba(0,0,0,.12)}.vmenu .side2 button.on::after{content:none}',
    '.lmenu [role=menuitemradio][aria-checked=true]:not(.on)>.lbl::after{content:"  ✓";color:var(--accent-ink)}',
    '.fwmenu button.fchip{border:0;border-radius:7px;background:transparent;padding:7px 8px;font:inherit;max-width:none;gap:9px;color:var(--fg)}',
    '.fwmenu button.fchip:hover,.fwmenu button.fchip:focus-visible{background:var(--fill)}',
    '.fwmenu button.fchip.on{box-shadow:none;background:var(--fill);color:var(--fg);font-weight:600}',
    '.fwmenu .fchip .an{white-space:normal}.fwmenu .fchip .nm{flex:1}',
    '.fmenu .lh{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    // A sheet inside the code view: the sidebar in a narrow code view, or Settings.
    '.dsheet{display:none;position:absolute;left:0;right:0;bottom:0;top:46px;z-index:5;flex-direction:column;background:var(--bg);',
    'box-shadow:0 -8px 30px rgba(0,0,0,.16),0 0 0 .5px var(--line2);border-radius:14px 14px 0 0;animation:rise .2s ease-out}',
    '.dsheet.on{display:flex}.dsheet.settings{top:0;border-radius:0}',
    // Permission questions stay above it.
    '.dock.max.shtop{z-index:1}.pqb,.pql{z-index:2}',
    '.dsheet .shh{display:flex;align-items:center;gap:8px;padding:10px 12px 6px;flex:none}.dsheet.settings .shh{display:none}',
    '.dsheet .shh b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsheet .shb{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto;padding:0 8px 8px}',
    '.dsheet .dside{display:flex;width:auto;flex:1;background:transparent;border:0;padding:0}',
    '.dsheet .usage.settings{margin:0;display:block;max-height:none;padding:6px 6px 12px}',
    // Narrow: the sidebar is in the file button's sheet; the controls get smaller.
    '.dock.narrow .dsb,.dock.narrow .crumb .cdir,.dock.narrow .pinfo,.dock.narrow .capsule .cplay,.dock.narrow .timeline .tl0,.dock.narrow .timeline .tl1{display:none}',
    '.dock.narrow .fhead .ftx{display:none}.dock.narrow .fhead{padding:3px 8px}',
    '.dock.narrow .dqueue .lg{display:none}.dock.narrow .dqueue .sh{display:inline}',
    '.dock.narrow .hbar .acts>:not(.bmore),.dock.narrow .hbar .hw,.dock.narrow .hbar .near{display:none}.dock.narrow .hbar .acts .bmore{display:inline-block}',
    '.dock.narrow .hbar,.dock.narrow .hbox,.dock.narrow .cfold{margin-left:10px;max-width:calc(100% - 20px)}',
    // A phone: a bottom sheet at one of three heights, the drag handle on top.
    '.dgrab{display:none;flex:none;align-self:center;width:64px;height:16px;padding:0;border:0;background:transparent;cursor:grab;touch-action:none}',
    '.dgrab i{display:block;width:36px;height:5px;margin:7px auto 4px;border-radius:3px;background:var(--fill2)}',
    '.dock.phone:not(.float):not(.popped):not(.max){top:auto!important;left:0!important;right:0!important;bottom:0!important;width:100vw!important;',
    'height:var(--sheet-h,58vh)!important;border:0;border-radius:18px 18px 0 0;box-shadow:0 -8px 30px rgba(0,0,0,.18);overflow:hidden}',
    '.dock.phone .dgrab{display:block}',
    '.dock.phone .dhead{flex-wrap:wrap;border:0;padding:2px 12px 8px;gap:6px}',
    '.dock.phone .dsb,.dock.phone .capsule button,.dock.phone .dlay,.dock.phone .crumb .cdir,.dock.phone .pinfo,.dock.phone .resizer,.dock.phone .dtab,.dock.phone .dgap{display:none}',
    '.dock.phone .crumb{order:1;flex:1 1 0}.dock.phone .dview{order:2}.dock.phone .dhead .xred{order:3}',
    '.dock.phone .dbr{display:block;order:4;flex-basis:100%;height:0}.dock.phone .dpqb{order:5}.dock.phone .fhead{order:6;max-width:65%}.dock.phone .capsule{order:7}',
    '.dock.phone .fbtn{font-size:1.07em}.dock.phone .fhead .ftx{display:inline}.dock.phone .dqueue .lg{display:inline}.dock.phone .dqueue .sh{display:none}',
    '.dock.phone .timeline{padding:10px 14px 16px}.dock.phone .timeline .tl0,.dock.phone .timeline .tl1,.dock.phone .timeline .speed{display:none}',
    '.dock.phone .timeline .tlp,.dock.phone .timeline .tln{display:grid;width:36px;height:36px;border-radius:10px;background:var(--fill);color:var(--fg)}',
    '.dock.phone .dsheet{top:40px}',
    '@media (prefers-reduced-motion:reduce){.dqueue .qdot,.tab.busy .kd{animation:none}.dsheet{animation:none}}',
  ].join('');

  function dockWidth() {
    // Wide enough for the sidebar beside the code (the narrow layout starts below 560 px).
    var w = dockState.width || Math.max(640, Math.round(window.innerWidth * 0.42));
    return Math.max(DOCK_MIN, Math.min(w, window.innerWidth - 320));
  }
  function renderDock() {
    // The panel first: a floating code view's first position avoids where the panel is now.
    placePanel();
    placeDock();
    placeFloaters();
    swSoon();
    codeButton.setAttribute('aria-pressed', String(dockState.open));
    panesEl.setAttribute('data-layout', dockState.layout);
    panesEl.classList.toggle('wrapl', dockState.wrap);
    var split = dockState.layout === 'split';
    layoutButton.replaceChildren(icon(split ? 'tabs' : 'split'));
    layoutButton.title = split ? 'One pane: every file as a tab' : 'Split: show files side by side';
    layoutButton.setAttribute('aria-label', split ? 'One pane' : 'Split');
    layoutButton.setAttribute('aria-pressed', String(split));
    speedButton.textContent = dockState.speed + '×';
    speedButton.title = 'Playback speed ' + dockState.speed + '×. Click for the next speed.';
    renderSideState();
    renderPlayback();
    renderPanes();
  }
  function setWrap(on) {
    dockState.wrap = Boolean(on);
    // Stored for both values, so off stays off when the default is on.
    storageSet('localStorage', 'editlens.wrap', dockState.wrap ? 'on' : 'off');
    renderDock();
  }
  function setDock(open, remember) {
    dockState.open = open;
    storageSet('sessionStorage', 'editlens.dockOpen', open ? '1' : null);
    if (remember) {
      dockState.mode = open ? 'open' : 'closed';
      storageSet('localStorage', 'editlens.dock', dockState.mode);
    }
    renderDock();
  }
  // Called when Claude edits or opens a file: open the view unless the user closed it. Closing it
  // lasts until the next request (from Claude Code or this page).
  function wantDock() {
    // On a phone the open panel would cover most of it: the edit card's Replay opens it instead.
    var covered = window.innerWidth <= 480 && state.panel === 'open' && !pop.panel && !pop.dock;
    if (!dockState.open && dockState.mode !== 'closed' && !covered) setDock(true, false);
    return dockState.open;
  }
  // User asked to see code: make the code view visible whatever the layout (expand, focus the
  // pop-out, or minimize the panel in a narrow window).
  function showCodeView() {
    // Close the hover card; it would cover the code.
    if (peekCard.classList.contains('on')) hidePeek(true);
    if (!dockState.open && !pop.dock) setDock(true, false);
    if (dockState.mode === 'closed') {
      dockState.mode = 'auto';
      storageSet('localStorage', 'editlens.dock', null);
    }
    if (railOn()) setDockCollapsed(false);
    if (pop.dock && !pop.dock.win.closed) {
      try { pop.dock.win.focus(); } catch (err) { console.warn('[EditLens] could not focus the code view window:', err.message); }
      return;
    }
    if (!pop.panel && isFull('panel')) toggleFull('panel');
    if (!pop.panel && state.panel === 'open' && codeCoversPage()) setPanel('min');
  }
  function dockForNewRequest(ev) {
    if (!ev.backlog) dockState.expandNext = true;
    if (ev.backlog || dockState.mode !== 'closed') return;
    dockState.mode = 'auto';
    storageSet('localStorage', 'editlens.dock', null);
  }
  dockCollapse.addEventListener('click', function (e) {
    e.stopPropagation();
    setDockCollapsed(!railOn());
  });
  dockRail.addEventListener('click', function () { setDockCollapsed(false); });
  window.addEventListener('keydown', function (e) {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || !(e.code === 'KeyD' || e.key === 'D' || e.key === 'd') || hostTyping(e)) return;
    e.preventDefault();
    toggleDockCollapsed();
  });
  function closeDock() {
    if (pop.dock) popIn('dock');
    setDock(false, true);
  }
  dockClose.addEventListener('click', closeDock);
  layoutButton.addEventListener('click', function () { setLayout(dockState.layout !== 'split'); });
  function setSpeed(s) {
    dockState.speed = SPEEDS.indexOf(s) >= 0 ? s : 1;
    storageSet('localStorage', 'editlens.speed', String(dockState.speed));
    renderDock();
  }
  speedButton.addEventListener('click', function () {
    var i = SPEEDS.indexOf(dockState.speed);
    setSpeed(SPEEDS[(i + 1) % SPEEDS.length]);
  });
  pauseButton.addEventListener('click', togglePlay);
  prevButton.addEventListener('click', function () { stepEdit(-1); });
  nextButton.addEventListener('click', function () { stepEdit(1); });
  tlPrev.addEventListener('click', function () { stepEdit(-1); });
  tlNext.addEventListener('click', function () { stepEdit(1); });
  // Layout work at most once a frame during a window resize or a drag.
  var dockFrame = 0;
  function renderDockSoon() {
    if (!dockFrame) dockFrame = requestAnimationFrame(function () { dockFrame = 0; renderDock(); });
  }
  // Window resized or moved to another monitor: keep both panels on screen.
  window.addEventListener('resize', renderDockSoon);
  resizer.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add('drag');
    function move(ev) {
      if (layout.dock.mode === 'bottom') layout.dock.bh = Math.round(window.innerHeight - ev.clientY);
      else dockState.width = Math.round(layout.dock.mode === 'left' ? ev.clientX : window.innerWidth - ev.clientX);
      renderDockSoon();
    }
    function up() {
      resizer.classList.remove('drag');
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      resizer.removeEventListener('pointercancel', up);
      if (dockFrame) cancelAnimationFrame(dockFrame);
      dockFrame = 0;
      renderDock();
      dockState.width = dockWidth();
      layout.dock.bh = dockHeight();
      storageSet('localStorage', 'editlens.dockWidth', String(dockState.width));
      saveLayout();
    }
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
    resizer.addEventListener('pointercancel', up);
  });
  // The divider between the page and the docked code view, by keyboard and double-click.
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('tabindex', '0');
  resizer.setAttribute('aria-label', 'Resize the code view');
  resizer.title = 'Drag to resize. Arrow keys also move it. Double-click for the default size.';
  function renderResizerValue() {
    var bottom = layout.dock.mode === 'bottom';
    resizer.setAttribute('aria-orientation', bottom ? 'horizontal' : 'vertical');
    resizer.setAttribute('aria-valuemin', String(bottom ? 120 : DOCK_MIN));
    resizer.setAttribute('aria-valuemax', String(bottom ? Math.max(120, window.innerHeight - 160) : Math.max(DOCK_MIN, window.innerWidth - 320)));
    resizer.setAttribute('aria-valuenow', String(bottom ? dockHeight() : dockWidth()));
  }
  function saveDockSize() {
    dockState.width = dockWidth();
    layout.dock.bh = dockHeight();
    storageSet('localStorage', 'editlens.dockWidth', String(dockState.width));
    saveLayout();
    renderResizerValue();
  }
  resizer.addEventListener('keydown', function (e) {
    var m = layout.dock.mode;
    var step = e.shiftKey ? 64 : 16;
    // Each key moves the divider that way on screen; Home and End move it to either end.
    var grow = m === 'bottom' ? { ArrowUp: step, ArrowDown: -step, Home: 1e5, End: -1e5 }[e.key]
      : m === 'left' ? { ArrowRight: step, ArrowLeft: -step, Home: -1e5, End: 1e5 }[e.key]
        : { ArrowLeft: step, ArrowRight: -step, Home: 1e5, End: -1e5 }[e.key];
    if (grow === undefined || m === 'float' || pop.dock) return;
    e.preventDefault();
    e.stopPropagation();
    if (m === 'bottom') layout.dock.bh = Math.max(120, dockHeight() + grow);
    else dockState.width = Math.max(DOCK_MIN, dockWidth() + grow);
    renderDock();
    saveDockSize();
  });
  resizer.addEventListener('dblclick', function () {
    dockState.width = 0;
    layout.dock.bh = null;
    storageSet('localStorage', 'editlens.dockWidth', null);
    renderDock();
    saveLayout();
    renderResizerValue();
  });
  resizer.addEventListener('focus', renderResizerValue);

  // ----- syntax colors: a simple per-line tokenizer -----
  var KEYWORDS = /^(?:const|let|var|function|return|if|else|for|while|do|import|from|export|default|class|new|async|await|def|try|catch|except|finally|throw|raise|true|false|null|undefined|None|True|False|self|this|switch|case|break|continue|in|of|typeof|instanceof|extends|public|private|protected|static|interface|type|enum|lambda|with|as|elif|pass|yield|func|package|struct|fn|pub|use|mut|impl|and|or|not|is)$/;
  function langOf(file) {
    var ext = (String(file).match(/\.([a-z0-9]+)$/i) || [])[1] || '';
    ext = ext.toLowerCase();
    if (/^(css|scss|less|sass)$/.test(ext)) return 'css';
    if (/^(html?|vue|svelte|xml|svg)$/.test(ext)) return 'html';
    if (/^(py|rb|sh|bash|zsh|ya?ml|toml|r|pl)$/.test(ext)) return 'hash';
    return 'c';
  }
  var TOKENS = {
    c: /(\/\/.*$|\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(<\/?[A-Za-z][\w.-]*)/g,
    hash: /(#.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_][\w]*)|(<\/?[A-Za-z][\w.-]*)/g,
    css: /(\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(-?\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?\b|#[0-9a-fA-F]{3,8}\b)|([a-z-]+(?=\s*:(?!:)))|(@[a-z-]+)/g,
    html: /(<!--.*?(?:-->|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d+(?:\.\d+)?\b)|([a-zA-Z-:]+(?==))|(<\/?[A-Za-z][\w.-]*|\/?>)/g,
  };
  function paint(tx, text, lang) {
    tx.replaceChildren();
    var re = TOKENS[lang] || TOKENS.c;
    re.lastIndex = 0;
    var at = 0;
    var m;
    var source = text.length > 2000 ? text.slice(0, 2000) : text; // limits work on very long lines
    while ((m = re.exec(source)) !== null) {
      if (m[0] === '') { re.lastIndex++; continue; }
      var cls = m[1] ? 't-c' : m[2] ? 't-s' : m[3] ? 't-n' : m[4] ? (lang === 'c' || lang === 'hash' ? (KEYWORDS.test(m[4]) ? 't-k' : null) : 't-p') : m[5] ? (lang === 'css' ? 't-k' : 't-t') : null;
      if (!cls) continue;
      if (m.index > at) tx.appendChild(document.createTextNode(source.slice(at, m.index)));
      tx.appendChild(el('span', { class: cls, text: m[0] }));
      at = m.index + m[0].length;
    }
    if (at < text.length) tx.appendChild(document.createTextNode(text.slice(at)));
  }

  function splitLines(text) {
    if (typeof text !== 'string' || text === '') return [];
    var lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.map(function (l) { return l.replace(/\r$/, ''); });
  }
  function makeRow(text, lang) {
    var tx = el('span', { class: 'tx' });
    paint(tx, text, lang);
    return el('div', { class: 'cl' }, el('span', { class: 'no' }), tx);
  }

  function keyOf(file) {
    var x = String(file || '').replace(/\\/g, '/');
    return /^[a-z]:\//i.test(x) ? x.toLowerCase() : x;
  }
  // A path as the code view shows it: relative to the project when it can be (a full path inside
  // the project is cut to the part after it), with the full path for hovering.
  // -> { rel: 'essays/a.md', dir: 'essays/', name: 'a.md', full: 'C:\Users\me\proj\essays\a.md' }
  function viewPath(file, relFile) {
    var full = String(file || relFile || '');
    var rel = String(relFile || file || '');
    var tag = /^◆ [^:]{1,40}: /.exec(rel); // a paired computer's file keeps its name at the start
    var pre = tag ? tag[0] : '';
    var p = rel.slice(pre.length);
    if (OPTS.root && (/^[\\/]/.test(p) || /^[A-Za-z]:[\\/]/.test(p))) {
      // Same rules as lib/paths.js: C:\proj and c:/proj are the same folder. Only slashes and
      // case change, so lengths match the path as given.
      var norm = function (x) {
        var y = String(x).replace(/\\/g, '/');
        return /^[a-z]:\//i.test(y) ? y.toLowerCase() : y;
      };
      var root = norm(OPTS.root).replace(/(.)\/+$/, '$1');
      if (norm(p).indexOf(root + '/') === 0) p = p.slice(root.length + 1);
    }
    var cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1;
    return { rel: pre + p, dir: pre + p.slice(0, cut), name: p.slice(cut) || p, full: tag ? rel : full };
  }
  function openFile(file, relFile, kind) {
    var key = keyOf(file);
    var f = files[key];
    if (!f) {
      var vp = viewPath(file, relFile);
      // The path people see: no "◆ computer: " and no copy's folder at the start.
      var shown = shownPath(vp.rel);
      var codeEl = el('div', { class: 'code', role: 'region', tabindex: '0', 'aria-label': shown });
      var capText = el('span', { class: 't' });
      var cap = el('div', { class: 'pcap' }, mark(), capText);
      var marksEl = el('div', { class: 'emarks', 'aria-hidden': 'true' });
      var paneEl = el('section', { class: 'pane ' + (kind || 'frontend'), 'data-path': shown }, cap, el('div', { class: 'cwrap' }, codeEl, marksEl));
      var closeX = el('button', { class: 'x', type: 'button', title: 'Close', 'aria-label': 'Close ' + shown, text: '×' });
      var tno = el('span', { class: 'cno', hidden: '', 'aria-hidden': 'true' });
      var tab = el('div', { class: 'tab ' + (kind || 'frontend'), role: 'tab', tabindex: '-1', draggable: 'true', title: vp.full, 'aria-selected': 'false' },
        el('span', { class: 'kd' }), tno, el('span', { class: 'nm', text: baseName(file) }), closeX);
      f = files[key] = { key: key, file: file, relFile: relFile || file, rel: vp.rel, shown: shown, kind: kind || 'frontend', lang: langOf(file),
        lines: [], rows: [], paneEl: paneEl, codeEl: codeEl, cap: cap, capText: capText, countEl: el('span', { class: 'lines' }), whoEl: el('span', { class: 'who' }),
        tab: tab, tno: tno, marksEl: marksEl, notes: [], folds: [], group: null, barEv: null };
      tab.addEventListener('click', function (e) {
        if (e.target === closeX) return;
        showFile(f, true);
      });
      tab.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        showFile(f, true);
      });
      // Moving a tab to another pane: drag it onto that pane's tabs (or "Open in a split").
      tab.addEventListener('dragstart', function (e) {
        tabDrag = f.key;
        tab.classList.add('dragging');
        panesEl.classList.add('dragging');
        dropZone.classList.toggle('on', groups.length < splitCount(splitDir()));
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', shown);
        }
      });
      tab.addEventListener('dragend', function () {
        tabDrag = null;
        tab.classList.remove('dragging');
        panesEl.classList.remove('dragging');
        groups.forEach(function (g) { g.head.classList.remove('drop'); });
      });
      // Clicking or typing in a pane gives it focus.
      paneEl.addEventListener('pointerdown', function () { focusGroupOf(f.group); });
      paneEl.addEventListener('focusin', function () { focusGroupOf(f.group); });
      closeX.addEventListener('click', function () { closeFile(f); });
      paneRestore(f);
      if (fileOrder.length >= MAX_FILES) {
        var oldest = files[fileOrder[0]];
        if (oldest && (!player.current || player.current.file !== oldest)) closeFile(oldest);
      }
    } else if (kind && kind !== 'view' && f.kind !== kind) {
      // A file Claude first only opened is now being edited.
      ['frontend', 'backend', 'view'].forEach(function (k) { f.tab.classList.toggle(k, k === kind); f.paneEl.classList.toggle(k, k === kind); });
      f.kind = kind;
    }
    return f;
  }
  // The file menu's Restore: for the newest edit of this file that still has an earlier copy.
  // A restore still in effect offers Undo restore; an undo, or a restore that was undone, is skipped,
  // so the edit it was about gets Restore again.
  function paneRestoreEdit(f) {
    for (var i = changes.length - 1; i >= 0; i--) {
      var ev = changes[i];
      if (!ev.file || keyOf(ev.file) !== f.key) continue;
      // "Undo only this edit" is offered again as Put it back on the edit it undid.
      if (ev.kind === 'restore' && (ev.via === 'undo' || ev.via === 'undo-edit' || restoredBy(ev))) continue;
      if (restoreTarget(ev)) return ev;
    }
    return null;
  }
  // The newest edit of this file Claude made (for Undo only this edit), or null.
  function paneLastEdit(f) {
    for (var i = changes.length - 1; i >= 0; i--) {
      var ev = changes[i];
      if (ev.file && keyOf(ev.file) === f.key && ev.kind !== 'restore') return ev;
    }
    return null;
  }
  function paneRestore(f) {
    var ev = paneRestoreEdit(f);
    f.rstEv = ev && restoreTarget(ev) ? ev : null;
    if (!f.rstEv) {
      var open = f.paneEl.querySelector(':scope>.rconf[data-kind=restore]');
      if (open) open.remove();
    }
  }
  // { text, title, off } for the file menu's Restore row, or null when there is nothing to restore.
  function paneRestoreInfo(f) {
    var ev = f.rstEv;
    var t = ev ? restoreTarget(ev) : null;
    if (!t) return null;
    var undid = restoredBy(ev);
    return {
      text: undid && undid.via === 'undo-edit' ? 'Put it back' : t.undo ? 'Undo restore' : 'Restore…',
      off: t.off || '',
      title: t.off ? t.off : undid && undid.via === 'undo-edit' ? 'Put Claude\'s edit back in ' + f.shown
        : t.undo ? 'Put ' + f.shown + ' back as it was before the last restore'
          : 'Put ' + f.shown + ' back as it was before Claude\'s latest edit of it (' + (clock(ev.ts) || 'earlier') + ')',
    };
  }
  // A question at the top of the pane (from the file menu): Restore, or Undo only this edit.
  function paneAsk(f, kind) {
    var open = f.paneEl.querySelector(':scope>.rconf');
    if (open) {
      var same = open.getAttribute('data-kind') === kind;
      open.remove();
      if (same) return;
    }
    var box = null;
    var done = function () { if (box) box.remove(); };
    if (kind === 'restore' && f.rstEv) box = restoreQuestion(f.rstEv, done);
    else if (kind === 'only') box = undoOnlyQuestion(paneLastEdit(f), done);
    if (!box) return;
    box.setAttribute('data-kind', kind);
    f.cap.after(box);
  }
  var paneRestoreTimer = 0;
  function paneRestoreSoon() {
    if (paneRestoreTimer) return;
    paneRestoreTimer = setTimeout(function () {
      paneRestoreTimer = 0;
      Object.keys(files).forEach(function (k) {
        paneRestore(files[k]);
        refreshBars(files[k]);
      });
    }, 0);
  }
  function closeFile(f) {
    if (player.current && player.current.file === f) player.skip = true;
    var g = f.group;
    f.group = null;
    f.tab.remove();
    f.paneEl.remove();
    delete files[f.key];
    fileOrder = fileOrder.filter(function (k) { return k !== f.key; });
    if (g) {
      g.keys = g.keys.filter(function (k) { return k !== f.key; });
      if (g.active === f.key) g.active = newestKey(g.keys);
      if (!g.keys.length) dropGroup(g);
    }
    saveDockFiles();
    saveGroups();
    renderPanes();
    sideSoon();
  }

  // ----- panes, each with its own tabs; a tab moves only by drag or "Open in a split" -----
  // A file you pick: if open, its pane shows it and gets focus; else it opens in the focused pane.
  // Claude's edits and moves: an open file plays where it is; others get a new pane if split view has
  // room, else the pane that follows (the first, or the one set by "Play edits here").
  var tabDrag = null; // the key of the tab being dragged
  var dropZone = el('div', { class: 'pdrop', text: 'Drop here for a new pane' });
  function newestKey(keys) {
    var best = null;
    keys.forEach(function (k) { if (best === null || fileOrder.indexOf(k) > fileOrder.indexOf(best)) best = k; });
    return best;
  }
  function makeGroup() {
    var tabs = el('div', { class: 'ptabs', role: 'tablist', 'aria-label': 'Open files' });
    var info = el('div', { class: 'pinfo' });
    var fol = el('button', { class: 'pfol', type: 'button', hidden: '' });
    var head = el('div', { class: 'ptrow' }, tabs, info, fol);
    var body = el('div', { class: 'gbody' });
    var g = { keys: [], active: null, el: el('section', { class: 'pgrp empty' }, head, body), head: head, tabs: tabs, info: info, fol: fol, body: body };
    g.el.addEventListener('pointerdown', function () { focusGroupOf(g); });
    fol.addEventListener('click', function () {
      followGroup = Math.max(0, groups.indexOf(g));
      saveGroups();
      renderPanes();
    });
    head.addEventListener('dragover', function (e) {
      if (!tabDrag || !files[tabDrag] || files[tabDrag].group === g) return;
      e.preventDefault();
      head.classList.add('drop');
    });
    head.addEventListener('dragleave', function () { head.classList.remove('drop'); });
    head.addEventListener('drop', function (e) {
      e.preventDefault();
      head.classList.remove('drop');
      if (tabDrag && files[tabDrag]) moveFile(files[tabDrag], g);
    });
    // Arrow keys move between the tabs of this pane.
    tabs.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var list = Array.prototype.slice.call(tabs.querySelectorAll('.tab'));
      var i = list.indexOf(e.target.closest ? e.target.closest('.tab') : null);
      if (i < 0) return;
      e.preventDefault();
      e.stopPropagation();
      var next = list[clamp(i + (e.key === 'ArrowRight' ? 1 : -1), 0, list.length - 1)];
      if (next) next.focus();
    });
    panesEl.insertBefore(g.el, dropZone);
    return g;
  }
  // Puts a file in a pane (no drawing); the pane shows it.
  function placeIn(f, g) {
    var from = f.group;
    if (from === g) {
      g.active = f.key;
      return;
    }
    if (from) {
      from.keys = from.keys.filter(function (k) { return k !== f.key; });
      if (from.active === f.key) from.active = newestKey(from.keys);
    }
    g.keys.push(f.key);
    g.active = f.key;
    f.group = g;
    g.tabs.appendChild(f.tab);
    g.body.appendChild(f.paneEl);
  }
  function dropGroup(g) {
    var i = groups.indexOf(g);
    if (i < 0 || groups.length <= 1) return;
    groups.splice(i, 1);
    g.el.remove();
    if (focusGroup > i) focusGroup--;
    else if (focusGroup === i) focusGroup = Math.min(i, groups.length - 1);
    if (followGroup > i) followGroup--;
    else if (followGroup === i) followGroup = Math.min(i, groups.length - 1);
  }
  function mergeInto(g, into) {
    g.keys.slice().forEach(function (k) { if (files[k]) placeIn(files[k], into); });
    if (g.active && files[g.active] && into === groups[focusGroup]) into.active = g.active;
    dropGroup(g);
  }
  // At most n panes: extra panes merge into a neighbour; the focused pane is never the one removed.
  function fitGroups(n) {
    var max = Math.max(1, n);
    while (groups.length > max) {
      var drop = groups.length - 1 === focusGroup ? groups.length - 2 : groups.length - 1;
      mergeInto(groups[drop], groups[drop - 1] || groups[drop + 1]);
    }
  }
  function focusedFile() {
    var g = groups[focusGroup];
    return g && g.active && files[g.active] ? files[g.active] : null;
  }
  function showFile(f, pick) {
    fileOrder = fileOrder.filter(function (k) { return k !== f.key; });
    fileOrder.push(f.key);
    var g = f.group;
    if (!g) {
      g = pick ? groups[focusGroup] : groups[followGroup];
      // Claude's file: a pane of its own while there is space.
      if (!pick && dockState.layout === 'split' && groups.some(function (x) { return x.keys.length; }) && groups.length < splitCount(splitDir())) {
        g = makeGroup();
        groups.push(g);
      }
      g = g || groups[0];
    }
    placeIn(f, g);
    if (pick) focusGroup = Math.max(0, groups.indexOf(g));
    saveGroups();
    renderPanes();
    sideSoon();
  }
  // Moves a file to another pane (dragged there), or to a new one ('new': "Open in a split").
  function moveFile(f, target) {
    var from = f.group;
    if (!from) return;
    if (target === 'new') {
      if (dockState.layout !== 'split') {
        dockState.layout = 'split';
        storageSet('localStorage', 'editlens.dockLayout', 'split');
      }
      if (groups.length < splitCount(splitDir())) {
        target = makeGroup();
        groups.splice(groups.indexOf(from) + 1, 0, target);
      } else {
        target = groups[(groups.indexOf(from) + 1) % groups.length];
        if (target === from) return showToast('There is no room for another pane here. Make the code view larger, or use a smaller text size.');
      }
    }
    if (target === from) return;
    placeIn(f, target);
    if (!from.keys.length) dropGroup(from);
    focusGroup = Math.max(0, groups.indexOf(target));
    saveGroups();
    renderDock();
  }
  // Split on: the focused pane keeps its file, the most recent others get panes of their own.
  // Split off: every file in one pane, as tabs.
  function setLayout(split) {
    dockState.layout = split ? 'split' : 'tabs';
    storageSet('localStorage', 'editlens.dockLayout', dockState.layout);
    if (!split) fitGroups(1);
    else {
      var g = groups[focusGroup] || groups[0];
      var room = splitCount(splitDir()) - groups.length;
      fileOrder.slice().reverse().filter(function (k) { return files[k] && files[k].group === g && k !== g.active; }).slice(0, Math.max(0, room)).forEach(function (k) {
        var ng = makeGroup();
        groups.push(ng);
        placeIn(files[k], ng);
      });
      if (g) g.active = g.active || newestKey(g.keys);
    }
    saveGroups();
    renderDock();
  }
  // The pane last clicked or typed in has focus (an accent line above its tabs).
  function focusGroupOf(g) {
    var i = groups.indexOf(g);
    if (i < 0 || i === focusGroup) return;
    focusGroup = i;
    saveGroups();
    markGroups();
    renderCrumb();
  }
  // Kept for this browser tab, so a reload (a backend edit) shows the same files in the same panes.
  function saveGroups() {
    var list = groups.map(function (g) { return { keys: g.keys.slice(), active: g.active }; }).filter(function (g) { return g.keys.length; });
    storageSet('sessionStorage', 'editlens.dockPanes', list.length ? JSON.stringify({ v: 2, groups: list, focus: focusGroup, follow: followGroup }) : null);
  }
  // raw: the panes as saved before the files were opened again (opening them saves again).
  function loadGroups(raw) {
    var saved = null;
    try {
      saved = JSON.parse((typeof raw === 'string' ? raw : storageGet('sessionStorage', 'editlens.dockPanes')) || 'null');
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    if (!saved || !Array.isArray(saved.groups)) return;
    var used = Object.create(null);
    var want = saved.groups.slice(0, SPLIT_PANES).map(function (g) {
      var keys = (g && Array.isArray(g.keys) ? g.keys : []).filter(function (k) {
        var ok = typeof k === 'string' && files[k] && !used[k];
        if (ok) used[k] = true;
        return ok;
      });
      return { keys: keys, active: g && keys.indexOf(g.active) >= 0 ? g.active : keys[keys.length - 1] };
    }).filter(function (g) { return g.keys.length; });
    if (!want.length) return;
    if (dockState.layout !== 'split') want = [{ keys: want.reduce(function (all, g) { return all.concat(g.keys); }, []), active: want[0].active }];
    while (groups.length < want.length) groups.push(makeGroup());
    want.forEach(function (w, i) {
      var g = groups[i];
      w.keys.forEach(function (k) { placeIn(files[k], g); });
      // The tabs in their saved order (a file already in this pane kept its place).
      g.keys = w.keys.concat(g.keys.filter(function (k) { return w.keys.indexOf(k) < 0; }));
      g.keys.forEach(function (k) { g.tabs.appendChild(files[k].tab); });
      g.active = w.active;
    });
    groups.slice().forEach(function (g) { if (!g.keys.length) dropGroup(g); });
    focusGroup = Math.floor(num(saved.focus, 0, 0, groups.length - 1));
    followGroup = Math.floor(num(saved.follow, 0, 0, groups.length - 1));
    renderPanes();
  }
  // Split view: as many stacked panes as fit at about eight lines each, so a short window or a
  // large text size never makes them too small. Side by side, each at least SPLIT_MIN_W wide,
  // when the code view is wide enough.
  function splitCount(dir) {
    if (dir === 'cols') return Math.max(1, Math.min(SPLIT_PANES, Math.floor((panesEl.clientWidth + 1) / (SPLIT_MIN_W + 1))));
    var h = panesEl.clientHeight;
    var size = parseFloat(dock.ownerDocument.defaultView.getComputedStyle(dock).fontSize);
    if (!(h > 0) || !(size > 0) || !Number.isFinite(size)) return SPLIT_PANES;
    return Math.max(1, Math.min(SPLIT_PANES, Math.floor(h / (size * 15))));
  }

  // ----- split view: dividers between the panes, dragged, moved with the keyboard, remembered -----
  var SPLIT_KEY = 'editlens.splitSizes';
  var SPLIT_MIN_W = 220;
  var splitDividers = [];
  var splitNow = { dir: 'rows', n: 0 };
  function evenSizes(n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(1 / n);
    return out;
  }
  function normalSizes(fr) {
    var sum = fr.reduce(function (a, b) { return a + b; }, 0);
    return fr.map(function (x) { return x / sum; });
  }
  // Saved as { rows2: [0.6, 0.4], cols3: [...] }: each a share of the space; anything else is removed.
  function loadSplitSizes() {
    var saved = null;
    try {
      saved = JSON.parse(storageGet('localStorage', SPLIT_KEY) || 'null');
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    var out = {};
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out;
    Object.keys(saved).forEach(function (k) {
      var m = /^(rows|cols)([2-9])$/.exec(k);
      var v = saved[k];
      if (!m || !Array.isArray(v) || v.length !== Number(m[2])) return;
      var fr = v.map(function (x) { return num(x, null, 0.02, 1); });
      if (fr.every(function (x) { return x !== null; })) out[k] = normalSizes(fr);
    });
    return out;
  }
  var splitSizes = loadSplitSizes();
  // How many panes fit, and side by side or stacked, changes with the room they get (the sidebar
  // shown or hidden, the code view resized), not only with the window.
  var panesFrame = 0;
  var panesSize = '';
  if (typeof ResizeObserver === 'function') new ResizeObserver(function () {
    var size = panesEl.clientWidth + 'x' + panesEl.clientHeight;
    if (size === panesSize || panesFrame) return;
    panesSize = size;
    panesFrame = requestAnimationFrame(function () { panesFrame = 0; renderPanes(); });
  }).observe(panesEl);
  function saveSplitSizes() {
    storageSet('localStorage', SPLIT_KEY, Object.keys(splitSizes).length ? JSON.stringify(splitSizes) : null);
  }
  // Side by side when the code view is wide (docked at the bottom, a wide window), else stacked.
  function splitDir() {
    var w = panesEl.clientWidth;
    var h = panesEl.clientHeight;
    return w >= SPLIT_MIN_W * 2 + 1 && w > h * 1.3 ? 'cols' : 'rows';
  }
  function splitMin(dir) {
    if (dir === 'cols') return SPLIT_MIN_W;
    var size = parseFloat(dock.ownerDocument.defaultView.getComputedStyle(dock).fontSize);
    return Math.round(Math.max(80, (size > 0 && Number.isFinite(size) ? size : 13) * 6));
  }
  function splitSpace(dir) {
    return dir === 'cols' ? panesEl.clientWidth : panesEl.clientHeight;
  }
  function layoutSplit(dir) {
    var n = groups.length;
    var on = n > 1;
    var fr = on ? splitSizes[dir + n] || evenSizes(n) : [];
    // The window got smaller since: equal sizes instead of a pane below the minimum.
    var room = splitSpace(dir) - (n - 1);
    if (on && room > 0 && fr.some(function (x) { return x * room < splitMin(dir) - 1; })) fr = evenSizes(n);
    panesEl.setAttribute('data-dir', dir);
    groups.forEach(function (g, i) {
      g.el.style.order = String(i * 2);
      g.el.style.flex = on ? fr[i] + ' 1 0px' : '';
    });
    while (splitDividers.length < SPLIT_PANES - 1) splitDividers.push(makeDivider(splitDividers.length));
    var at = 0;
    splitDividers.forEach(function (d, i) {
      var show = on && i < n - 1;
      d.classList.toggle('on', show);
      d.style.order = String(i * 2 + 1);
      d.setAttribute('aria-orientation', dir === 'cols' ? 'vertical' : 'horizontal');
      if (!show) return;
      at += fr[i];
      d.setAttribute('aria-valuenow', String(Math.round(at * 100)));
    });
    dropZone.style.order = String(SPLIT_PANES * 2 + 1);
    splitNow = { dir: dir, n: on ? n : 0 };
  }
  function makeDivider(i) {
    var d = el('div', { class: 'psplit', role: 'separator', tabindex: '0', 'aria-label': 'Resize the panes', 'aria-valuemin': '0', 'aria-valuemax': '100',
      title: 'Drag to resize. Arrow keys also move it. Double-click to make the panes the same size.' });
    d.addEventListener('pointerdown', function (e) { startSplitDrag(i, e); });
    d.addEventListener('dblclick', function () {
      delete splitSizes[splitNow.dir + splitNow.n];
      saveSplitSizes();
      renderPanes();
    });
    d.addEventListener('keydown', function (e) { splitKey(i, e); });
    panesEl.appendChild(d);
    return d;
  }
  // Pixel sizes of the panes, from the page itself (also right in a popped-out window).
  function splitPixels() {
    var cols = splitNow.dir === 'cols';
    return groups.slice(0, splitNow.n).map(function (g) {
      var r = g.el.getBoundingClientRect();
      return { start: cols ? r.left : r.top, size: cols ? r.width : r.height };
    });
  }
  // Puts divider i at pos (window coordinates), keeping both panes beside it at the minimum or more.
  function moveDivider(i, pos) {
    var px = splitPixels();
    if (i + 1 >= px.length) return false;
    var a = px[i];
    var b = px[i + 1];
    var total = a.size + b.size;
    var min = splitMin(splitNow.dir);
    if (!(total > 0) || !Number.isFinite(pos) || total < min * 2) return false;
    var next = clamp(pos - a.start, min, total - min);
    var sizes = px.map(function (p) { return p.size; });
    sizes[i] = next;
    sizes[i + 1] = total - next;
    splitSizes[splitNow.dir + sizes.length] = normalSizes(sizes);
    layoutSplit(splitNow.dir);
    return true;
  }
  function startSplitDrag(i, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    var d = e.currentTarget;
    var cols = splitNow.dir === 'cols';
    d.setPointerCapture(e.pointerId);
    d.classList.add('drag');
    function move(ev) { moveDivider(i, cols ? ev.clientX : ev.clientY); }
    function up() {
      d.classList.remove('drag');
      d.removeEventListener('pointermove', move);
      d.removeEventListener('pointerup', up);
      d.removeEventListener('pointercancel', up);
      saveSplitSizes();
    }
    d.addEventListener('pointermove', move);
    d.addEventListener('pointerup', up);
    d.addEventListener('pointercancel', up);
  }
  function splitKey(i, e) {
    var px = splitPixels();
    if (i + 1 >= px.length) return;
    var edge = px[i].start + px[i].size;
    var step = e.shiftKey ? 64 : 16;
    var to = { ArrowLeft: edge - step, ArrowUp: edge - step, ArrowRight: edge + step, ArrowDown: edge + step,
      Home: px[i].start, End: px[i + 1].start + px[i + 1].size }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    if (moveDivider(i, to)) saveSplitSizes();
  }
  function renderPanes() {
    // A file opened again after a reload, not yet in a pane: the pane that follows.
    Object.keys(files).forEach(function (k) { if (!files[k].group) placeIn(files[k], groups[followGroup] || groups[0]); });
    var dir = splitDir();
    fitGroups(dockState.layout === 'split' ? splitCount(dir) : 1);
    groups.slice().forEach(function (g) { if (!g.keys.length) dropGroup(g); });
    focusGroup = clamp(Number.isFinite(focusGroup) ? focusGroup : 0, 0, groups.length - 1);
    followGroup = clamp(Number.isFinite(followGroup) ? followGroup : 0, 0, groups.length - 1);
    layoutSplit(dir);
    groups.forEach(renderGroup);
    markGroups();
    dockEmpty.style.display = fileOrder.length ? 'none' : '';
    renderCrumb();
    // Panes change size when files are added or the layout changes: keep each one's latest
    // change in view.
    requestAnimationFrame(function () {
      groups.forEach(function (g) {
        var f = files[g.active];
        if (f && f.focusRow) reveal(f, f.focusRow, false);
      });
    });
  }
  // One pane: its tabs in the order they were opened, the shown file's code, who and how long.
  function renderGroup(g) {
    g.el.classList.toggle('empty', !g.keys.length);
    // The code had focus (← → and Space): the file shown next in this pane keeps it.
    var r = dock.getRootNode();
    var had = r.activeElement && r.activeElement.classList && r.activeElement.classList.contains('code') && g.body.contains(r.activeElement) ? r.activeElement : null;
    g.keys.forEach(function (k) {
      var f = files[k];
      var on = k === g.active;
      f.tab.classList.toggle('on', on);
      f.tab.setAttribute('aria-selected', String(on));
      f.tab.setAttribute('tabindex', on ? '0' : '-1');
      f.paneEl.classList.toggle('on', on);
    });
    var f = files[g.active];
    if (f) g.info.replaceChildren(f.whoEl, f.countEl);
    else g.info.replaceChildren();
    if (had && f && had !== f.codeEl) f.codeEl.focus({ preventScroll: true });
  }
  function markGroups() {
    var many = groups.length > 1;
    groups.forEach(function (g, i) {
      g.el.classList.toggle('focus', many && i === focusGroup);
      g.fol.hidden = !many;
      var follows = i === followGroup;
      g.fol.textContent = follows ? 'Edits play here' : 'Play edits here';
      g.fol.setAttribute('aria-pressed', String(follows));
      g.fol.title = follows ? 'Claude\'s edits and the agent you follow open in this pane' : 'Open Claude\'s edits and the agent you follow in this pane';
    });
    var f = focusedFile();
    activeKey = f ? f.key : null;
  }
  function setText(f, text) {
    f.lines = splitLines(text);
    clearNotes(f);
    var frag = document.createDocumentFragment();
    f.rows = f.lines.map(function (line) {
      var r = makeRow(line, f.lang);
      frag.appendChild(r);
      return r;
    });
    f.codeEl.replaceChildren(frag);
    f.countEl.textContent = linesText(f.lines);
  }
  // Notes, change bars and folds are removed; every line is shown again.
  function clearNotes(f) {
    f.notes.forEach(function (n) { n.remove(); });
    f.notes = [];
    f.folds = [];
    f.rows.forEach(function (r) { r.classList.remove('lmark', 'fold'); });
    f.marksEl.replaceChildren();
    f.barEv = null;
    f.tno.hidden = true;
  }
  function reveal(f, row, smooth) {
    if (!row || !row.isConnected) return;
    if (row.classList.contains('fold')) unfoldAt(f, row);
    f.focusRow = row;
    var box = f.codeEl;
    var top = row.offsetTop - box.offsetTop;
    if (top < box.scrollTop + box.clientHeight * 0.2 || top > box.scrollTop + box.clientHeight * 0.7) {
      box.scrollTo({ top: Math.max(0, top - box.clientHeight * 0.35), behavior: smooth && dockState.speed <= 2 ? 'smooth' : 'auto' });
    }
  }

  var player = { queue: [], current: null, paused: false, skip: false, running: false, skipped: 0 };
  // While paused, at most this many edits wait; older ones are skipped (they stay in the timeline).
  var QUEUE_MAX = 200;
  // The newest SNAPSHOT_CACHE_MAX snapshots; a failed load is not kept, so a retry can work.
  var SNAPSHOT_CACHE_MAX = 60;
  var snapshotCache = new Map();
  // Why the last snapshot could not be read: 'down' (no response) or 'gone' (no longer kept).
  var snapshotFail = '';
  function snapshotFailText() {
    return snapshotFail === 'down'
      ? 'This change can\'t be shown because EditLens isn\'t running. In Claude Code, enter /editlens, and then try again.'
      : 'Could not show this edit: its code is no longer kept (EditLens restarted or removed older edits).';
  }
  // Snapshot numbers start again when EditLens restarts: a reference also names the server start
  // ("<instance>.<id>"), and the server refuses one from another start.
  function snapRef(id) {
    return typeof id === 'string' && id && state.instance && id.indexOf('.') < 0 ? state.instance + '.' + id : id;
  }
  // EditLens restarted: no snapshot from the old start is kept.
  function forgetSnapshots() {
    snapshotCache.clear();
  }
  function fetchSnapshot(id) {
    if (!id || typeof id !== 'string') return Promise.resolve(null);
    var hit = snapshotCache.get(id);
    if (hit) {
      snapshotCache.delete(id);
      snapshotCache.set(id, hit);
      return hit;
    }
    var dot = id.indexOf('.');
    var inst = dot >= 0 ? id.slice(0, dot) : '';
    if (inst && state.instance && inst !== state.instance) {
      snapshotFail = 'gone';
      return Promise.resolve(null);
    }
    var q = 'id=' + encodeURIComponent(dot >= 0 ? id.slice(dot + 1) : id) + (inst ? '&instance=' + encodeURIComponent(inst) : '');
    var p = fetch(SERVER + '/snapshot?' + q).then(function (res) {
      if (!res.ok) snapshotFail = 'gone';
      // A body that is not JSON (SyntaxError) or that stopped arriving (TypeError): not kept.
      return res.ok ? res.json().catch(function (err) {
        if (!(err instanceof SyntaxError) && !(err instanceof TypeError)) throw err;
        console.warn('[EditLens] could not read code:', err);
        snapshotFail = err instanceof TypeError ? 'down' : 'gone';
        return null;
      }) : null;
    }, function (err) {
      console.warn('[EditLens] could not load code:', err);
      snapshotFail = 'down';
      return null;
    }).then(function (snap) {
      if (!snap && snapshotCache.get(id) === p) snapshotCache.delete(id);
      return snap;
    });
    snapshotCache.set(id, p);
    while (snapshotCache.size > SNAPSHOT_CACHE_MAX) snapshotCache.delete(snapshotCache.keys().next().value);
    return p;
  }
  function enqueue(job) {
    player.queue.push(job);
    while (player.queue.length > QUEUE_MAX) {
      player.queue.shift();
      player.skipped++;
    }
    renderQueue();
    if (!player.running) runQueue();
  }
  // Show every waiting edit now (also when paused).
  function catchUp() {
    player.paused = false;
    player.skip = true;
    player.queue.forEach(function (job) { job.instant = true; });
    renderQueue();
  }
  function renderQueue() {
    renderPlayback();
    sideSoon();
  }
  // Claude's edits still waiting to play (not replays you asked for).
  function waitingEdits() {
    return player.queue.filter(function (j) { return !j.replay && j.ev && j.ev.type !== 'code'; }).map(function (j) { return j.ev; });
  }
  // The capsule ("Edit 5 of 7", "5/7" when narrow), its buttons, the strip's badge and the timeline.
  function renderPlayback() {
    var cur = player.current;
    var queued = player.queue.length;
    // running: an edit is being fetched before it plays (nothing is current yet).
    var busy = Boolean(cur || queued || player.running);
    var total = timeline.length;
    var at = timelinePos >= 0 && timelinePos < total ? timelinePos + 1 : 0;
    var status = cur ? (player.paused ? 'Paused: ' : cur.replay ? 'Replaying ' : 'Playing ') + baseName(cur.file.file) : queued ? (player.paused ? 'Paused · next' : 'Next') : '';
    if (queued) status += ' · ' + queued + ' more waiting';
    if (player.skipped) status += ' · ' + player.skipped + ' skipped';
    var live = Boolean(cur && !player.paused);
    dockQueue.classList.toggle('live', live);
    if (busy) dockQueue.setAttribute('data-busy', '1');
    else dockQueue.removeAttribute('data-busy');
    var long = !total ? 'No edits yet' : (player.paused && busy ? 'Paused · ' : '') + (at ? 'Edit ' + at + ' of ' + total : total + (total === 1 ? ' edit' : ' edits'));
    // A dot that pulses while an edit plays, so it is clear something is moving.
    dockQueue.replaceChildren();
    if (live) dockQueue.appendChild(el('i', { class: 'qdot', 'aria-hidden': 'true' }));
    dockQueue.appendChild(el('span', { class: 'lg', text: long }));
    dockQueue.appendChild(el('span', { class: 'sh', 'aria-hidden': 'true', text: total ? (at || '–') + '/' + total : '0' }));
    if (status) dockQueue.appendChild(el('span', { class: 'sr', text: status }));
    dockQueue.title = status || long;
    var label = busy ? (player.paused ? 'Resume playback' : 'Pause playback') : 'Play from here';
    pauseButton.replaceChildren(icon(busy && !player.paused ? 'pause' : 'play'));
    pauseButton.setAttribute('aria-label', label);
    pauseButton.title = label + ' (Space)';
    var first = !total || (at === 1 && !cur);
    var last = !total || (!busy && (at === total || !at));
    [prevButton, tlPrev].forEach(function (b) { b.disabled = first; });
    [nextButton, tlNext].forEach(function (b) { b.disabled = last; });
    var waiting = waitingEdits().length;
    stripBadge.textContent = waiting ? String(waiting) : '';
    renderTimeline();
  }
  function wait(ms) {
    return new Promise(function (resolve) {
      var left = ms / dockState.speed;
      (function tick() {
        if (player.skip) return resolve();
        if (player.paused) return later(tick, 120);
        if (left <= 0) return resolve();
        var step = Math.min(left, 40);
        left -= step;
        later(tick, step);
      })();
    });
  }
  function runQueue() {
    if (player.running) return;
    var job = player.queue.shift();
    // A file Follow opened before a newer one (or before Follow changed): skipped.
    while (job && job.followReq !== undefined && job.followReq !== follow.req) job = player.queue.shift();
    if (!job) {
      player.current = null;
      player.skipped = 0;
      renderQueue();
      return;
    }
    player.running = true;
    player.skip = Boolean(job.instant);
    var done = function () {
      player.running = false;
      player.skip = false;
      runQueue();
    };
    playJob(job).then(done, function (err) {
      console.warn('[EditLens] could not play an edit:', err);
      done();
    });
  }

  async function playJob(job) {
    var ev = job.ev;
    var snap = await fetchSnapshot(ev.snapshot);
    // Follow changed while the code was loading: the file of the Follow before is not opened (Sol M7).
    if (job.followReq !== undefined && job.followReq !== follow.req) return;
    if (!snap) {
      showToast(snapshotFailText(), 5000);
      return;
    }
    // A restore keeps the file's own UI/API label.
    var f = openFile(snap.file, snap.relFile, ev.type === 'code' ? 'view' : ev.kind === 'restore' ? (ev.fileKind === 'backend' ? 'backend' : null) : ev.kind);
    // job.auto: Claude's own edit or move; anything else is you picking the file.
    showFile(f, !job.auto);
    if (job.owner) showOwner(f, job.owner);
    // Where the timeline's head is: this edit (or the edit a hover card opened).
    var at = timeline.indexOf(ev.type === 'code' && ev.edit ? ev.edit : ev);
    if (at >= 0) timelinePos = at;
    player.current = { file: f, replay: job.replay, ev: ev };
    renderQueue();
    f.tab.classList.add('busy');
    try {
      f.snapId = ev.snapshot;
      saveDockFiles();
      if (ev.type === 'code') {
        markRestorePlay(f, null);
        showRange(f, snap.after, ev);
        // From the hover card or a Changes row: that change's bar, highlighted.
        if (ev.edit) editBars(f, ev.edit, { hunks: ev.edit.hunks, hl: true, approx: Boolean(ev.approx) });
        emptyNote(f, snap);
        return;
      }
      if (job.replay) replayHighlight(ev);
      await playEdit(f, snap, ev);
      editBars(f, ev, { hunks: Array.isArray(snap.hunks) && snap.hunks.length ? snap.hunks : ev.hunks });
      emptyNote(f, snap);
    } finally {
      saveDockFiles();
      f.tab.classList.remove('busy');
      f.cap.classList.remove('on');
      player.current = null;
      renderMarks(f);
      renderQueue();
    }
  }

  // Changed line numbers as runs of lines next to each other: [[5, 6], [38, 38]].
  function lineRanges(lines, max) {
    if (!Array.isArray(lines)) return [];
    var list = lines.map(Number).filter(function (n) { return Number.isInteger(n) && n >= 1 && n <= max; })
      .sort(function (a, b) { return a - b; });
    var out = [];
    list.forEach(function (n) {
      var last = out[out.length - 1];
      if (last && n <= last[1] + 1) last[1] = Math.max(last[1], n);
      else out.push([n, n]);
    });
    return out;
  }
  function emptyNote(f, snap) {
    if (snap.after !== '' || f.lines.some(Boolean)) return;
    var note = el('div', { class: 'cnote', text: 'This file is now empty: the edit removed all its text or deleted the file.' });
    f.codeEl.prepend(note);
    f.notes.push(note);
  }
  function showRange(f, text, ev) {
    setText(f, text);
    var from = Number(ev.line);
    var to = Number(ev.endLine);
    if (!Number.isFinite(from) || from < 1 || from > f.rows.length) {
      if (ev.note) {
        var top = el('div', { class: 'cnote sys', text: ev.note });
        f.codeEl.prepend(top);
        f.notes.push(top);
      }
      f.codeEl.scrollTop = 0;
      return;
    }
    if (!Number.isFinite(to) || to < from) to = from;
    // One edit in two places (lines 5 and 38) marks each place, not every line between them.
    var ranges = lineRanges(ev.lines, f.rows.length);
    if (!ranges.length) ranges = [[from, to]];
    ranges.forEach(function (r) {
      // A part of the page or an edit: mark all of it, up to the end of the element or block.
      var end = ev.part ? Math.max(r[1], partEnd(f.lines, r[0])) : r[1];
      end = Math.min(end, f.rows.length);
      for (var i = r[0] - 1; i < end; i++) f.rows[i].classList.add('lmark'); // 'mark' is the logo's class
    });
    if (ev.note) {
      var note = el('div', { class: 'cnote', text: ev.note });
      f.rows[from - 1].before(note);
      f.notes.push(note);
    }
    reveal(f, f.rows[from - 1], true);
  }

  // A restore plays like an edit, labelled with what it was ("Restored", "Undone") in the restore color.
  function markRestorePlay(f, ev) {
    var on = Boolean(ev && ev.kind === 'restore');
    f.paneEl.classList.toggle('rstd', on);
    f.cap.classList.toggle('rst', on);
    var lab = f.cap.querySelector('.rlab');
    if (on && !lab) f.cap.insertBefore(lab = el('span', { class: 'rlab' }), f.capText);
    if (lab) lab.textContent = on ? restoreLabel(ev) : '';
  }
  async function playEdit(f, snap, ev) {
    f.rows.forEach(function (r) { r.classList.remove('recent'); });
    markRestorePlay(f, ev);
    if (ev.intent) {
      f.capText.textContent = ev.intent;
      f.cap.classList.add('on');
    }
    var finalLines = splitLines(snap.after);
    // A hunk without a usable start line can't be placed: show the result instead of guessing.
    var placeable = Array.isArray(snap.hunks) && snap.hunks.every(function (h) { var o = Number(h && h.oldStart); return Number.isInteger(o) && o >= 0 && Array.isArray(h.lines); });
    if (!snap.hunks || snap.before === null || !placeable) {
      // Nothing to animate (new view, very large change): show the result and mark changed lines.
      setText(f, snap.after);
      markHunkLines(f, ev.hunks);
      return;
    }
    if (f.lines.join('\n') !== splitLines(snap.before).join('\n')) setText(f, snap.before);
    clearNotes(f);
    var changed = snap.hunks.reduce(function (n, h) { return n + h.lines.filter(function (l) { return l[0] === '+' || l[0] === '-'; }).length; }, 0);
    var typing = changed <= 60; // short edits are typed out; long ones appear a line at a time
    var delta = 0;
    for (var h = 0; h < snap.hunks.length && !player.skip; h++) {
      var hunk = snap.hunks[h];
      var idx = Math.max(0, posInt(hunk.oldStart) - 1) + delta;
      for (var j = 0; j < hunk.lines.length && !player.skip; j++) {
        var line = hunk.lines[j];
        var op = line[0];
        var text = line.slice(1);
        if (op === ' ') {
          idx++;
        } else if (op === '-') {
          var gone = f.rows[idx];
          if (!gone) break;
          reveal(f, gone, true);
          gone.classList.add('del');
          await wait(typing ? 320 : 110);
          gone.classList.add('gone');
          await wait(150);
          gone.remove();
          f.rows.splice(idx, 1);
          f.lines.splice(idx, 1);
          delta--;
        } else if (op === '+') {
          var row = makeRow('', f.lang);
          var tx = row.lastChild;
          if (f.rows[idx]) f.rows[idx].before(row);
          else f.codeEl.appendChild(row);
          f.rows.splice(idx, 0, row);
          f.lines.splice(idx, 0, text);
          row.classList.add('add', 'cur');
          reveal(f, row, true);
          if (typing && text.trim()) {
            var steps = Math.max(1, Math.min(24, Math.ceil(text.length / 3)));
            for (var s = 1; s <= steps && !player.skip; s++) {
              tx.textContent = text.slice(0, Math.ceil((text.length * s) / steps));
              await wait(Math.max(12, Math.min(40, 600 / steps)));
            }
          } else {
            await wait(typing ? 120 : 70);
          }
          paint(tx, text, f.lang);
          row.classList.remove('cur');
          idx++;
          delta++;
        }
        f.countEl.textContent = linesText(f.lines);
      }
      await wait(260);
    }
    if (player.skip || f.lines.join('\n') !== finalLines.join('\n')) {
      setText(f, snap.after);
      markHunkLines(f, snap.hunks);
    } else {
      // Added lines keep a light marker until the next edit of this file.
      f.rows.forEach(function (r) {
        if (r.classList.contains('add')) r.classList.replace('add', 'recent');
      });
    }
  }
  // Mark the lines a set of hunks added, in the file as it is after the edit.
  function markHunkLines(f, hunks) {
    var first = null;
    (hunks || []).forEach(function (h) {
      var n = Number(h.newStart) - 1;
      if (!Number.isFinite(n)) return;
      (h.lines || []).forEach(function (l) {
        if (l[0] === '-' || l[0] === '\\') return;
        if (l[0] === '+' && f.rows[n]) {
          f.rows[n].classList.add('recent');
          if (!first) first = f.rows[n];
        }
        n++;
      });
    });
    if (first) reveal(f, first, false);
  }

  var timeline = []; // change events with code, oldest first
  var timelinePos = -1;
  // Every edit for the Changes list, also those with no stored code (binary, very large).
  var CHANGES_MAX = 200;
  var changes = [];
  var changesCount = 0;
  function addToChanges(ev) {
    if (changes.indexOf(ev) >= 0) return;
    changes.push(ev);
    changesCount++;
    if (changes.length > CHANGES_MAX) changes.shift();
    if (changesList.classList.contains('on')) renderChanges();
    else renderChangesButton();
  }
  function addToTimeline(ev) {
    if (!ev.snapshot) return;
    timeline.push(ev);
    if (timeline.length > TIMELINE_MAX) {
      timeline.shift();
      if (timelinePos >= 0) timelinePos--;
    }
    renderPlayback();
    sideSoon();
  }
  function clock(ts) {
    var d = new Date(Number(ts));
    return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  }
  // Plays edit i of the timeline again; picking one means you want to see it, so it plays now.
  function replayAt(i) {
    if (!(i >= 0 && i < timeline.length)) return;
    timelinePos = i;
    showCodeView();
    player.queue = [];
    player.skipped = 0;
    player.skip = Boolean(player.current);
    player.paused = false;
    enqueue({ ev: timeline[i], replay: true });
  }
  function replayEdit(ev) {
    var i = timeline.indexOf(ev);
    if (i >= 0) replayAt(i);
    else if (ev.snapshot) {
      showCodeView();
      enqueue({ ev: ev, replay: true });
    }
  }
  // Previous or next edit (the capsule, the arrow keys, a swipe). Next while Claude's edits play
  // shows the current edit immediately and continues to the next.
  function stepEdit(d) {
    if (!timeline.length) return;
    if (d > 0 && player.current && !player.current.replay) {
      player.skip = true;
      return;
    }
    var from = timelinePos >= 0 && timelinePos < timeline.length ? timelinePos : timeline.length;
    var i = clamp(from + d, 0, timeline.length - 1);
    if (i === timelinePos && !player.current) return;
    replayAt(i);
  }
  // Play or pause. With nothing playing: play from the edit after the timeline's head (at the
  // end, the last ten edits again, in the order Claude made them).
  function togglePlay() {
    if (player.current || player.queue.length || player.running) {
      player.paused = !player.paused;
      renderDock();
      renderQueue();
      return;
    }
    if (!timeline.length) return showToast('No edits yet. Claude\'s edits play here as they come.');
    var from = timelinePos >= 0 && timelinePos < timeline.length - 1 ? timelinePos + 1 : Math.max(0, timeline.length - 10);
    showCodeView();
    player.paused = false;
    timeline.slice(from).forEach(function (ev) { enqueue({ ev: ev, replay: true }); });
  }
  function replayHighlight(ev) {
    if (!state.highlight) return;
    selectEdit(ev, true);
  }

  // Backend edits reload the page: save the open files for this tab and open them again.
  function saveDockFiles() {
    var list = fileOrder.map(function (k) { return files[k]; }).filter(function (f) { return f && f.snapId; })
      .map(function (f) { return { s: f.snapId, kind: f.kind }; });
    storageSet('sessionStorage', 'editlens.dockFiles', list.length ? JSON.stringify(list) : null);
  }
  function restoreDock() {
    if (storageGet('sessionStorage', 'editlens.dockOpen') !== '1' || dockState.mode === 'closed') return;
    var list = null;
    try {
      list = JSON.parse(storageGet('sessionStorage', 'editlens.dockFiles') || '[]');
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    var panes = storageGet('sessionStorage', 'editlens.dockPanes');
    setDock(true, false);
    if (!Array.isArray(list)) return;
    // One bad item (old or edited storage) skips that file only, never the rest of the restore. A
    // reference with no server start ("s1", saved by 0.24.43) can name another file now (Sol M8).
    list.reduce(function (chain, item) {
      if (!item || typeof item.s !== 'string' || item.s.indexOf('.') < 1) return chain;
      return chain.then(function () {
        return fetchSnapshot(item.s).then(function (snap) {
          if (!snap || typeof snap.file !== 'string' || typeof snap.after !== 'string') return;
          var f = openFile(snap.file, snap.relFile, item.kind);
          f.snapId = item.s;
          setText(f, snap.after);
          showFile(f, false);
        }).catch(function (err) {
          console.warn('[EditLens] could not open a saved code view file again', err);
        });
      });
    }, Promise.resolve()).then(function () { loadGroups(panes); });
  }

  // Entry points from the event stream.
  function codeForEdit(ev, live) {
    var owner = ownerOf(ev);
    var hunk = ev.hunks && ev.hunks[0];
    var line = hunk ? firstChangedLine(hunk) : NaN;
    // away: not in this site's files (a copy or a paired computer); Follow says so instead of moving.
    if (ev.file) noteAt(owner, { file: ev.file, rel: ev.relFile || null, line: Number.isFinite(line) && line > 0 ? line : null, end: null, op: 'edit', snapshot: ev.snapshot || null, away: awayNote(ev) }, live);
    addToChanges(ev);
    noteRequestEdit(ev);
    if (!ev.snapshot) return;
    addToTimeline(ev);
    if (live && dockState.collapsed && dockState.open) {
      // Collapsed: count it, and open again for the first edit of a new request (a setting).
      dockState.unseen++;
      if (dockState.expandNext && !(settings.values && settings.values.expand_code_view === false)) setDockCollapsed(false);
      else renderRail();
    }
    if (live) dockState.expandNext = false;
    // A restore is the user's own action: it plays whichever agent the view follows.
    if (live && (following(owner) || ev.kind === 'restore') && wantDock()) enqueue({ ev: ev, owner: owner, auto: true });
    if (ev.backup || ev.kind === 'restore') paneRestoreSoon();
  }
  function codeForView(ev, live) {
    if (!ev.snapshot || !live) return;
    if (wantDock()) enqueue({ ev: ev, auto: true });
  }

  codeButton.addEventListener('click', function () { setDock(!dockState.open, true); });

  // ---------- following one agent in the code view ----------
  // all: every edit shows; latest: also opens files any agent reads; one agent: only its edits/reads.
  // req: the number of the newest file Follow opened; a file asked for before it is not shown.
  var follow = { mode: storageGet('sessionStorage', 'editlens.follow') || 'all', at: {}, shown: null, req: 0 };
  function ownerOf(ev) {
    if (!ev.agentId) return 'main';
    var a = agentFor(ev);
    return a ? a.key : 'a:' + ev.agentId;
  }
  // The agent's label: "Main", the subagent's description, "◆ vm · Task", "◆ vm"; never an id.
  // short: next to a path that already names the paired computer ("◆ vm: faq.html"), so the
  // computer is not named twice.
  function ownerLabel(k, short) {
    var nm = agentName(k);
    if (short && remoteKeyOf(k)) return nm.word || 'Claude Code';
    return nm.name + (nm.word ? ' · ' + nm.word : '');
  }
  function ownerColor(k) {
    if (k === 'main') return 'var(--accent)';
    var a = agents[k];
    var id = a ? a.agentId : String(k).replace(/^a:/, '');
    return id ? mateColor({ agentId: id }) : 'var(--agent)';
  }
  function following(owner) {
    return follow.mode === 'all' || follow.mode === 'active' || follow.mode === owner;
  }
  function latestOwner() {
    var best = null;
    Object.keys(follow.at).forEach(function (k) {
      if (!best || follow.at[k].ts > follow.at[best].ts) best = k;
    });
    return best;
  }
  // Where an agent is working now; opens it when that agent is followed.
  function noteAt(owner, at, live) {
    var prev = follow.at[owner];
    // The transcript reports an edit after the edit itself arrived with its line: keep that line.
    if (at.op === 'edit' && !at.line && prev && prev.file === at.file && Date.now() - prev.ts < 10000) at.line = prev.line;
    if (at.op === 'edit' && !at.snapshot && prev && prev.file === at.file && prev.snapshot && Date.now() - prev.ts < 10000) at.snapshot = prev.snapshot;
    at.ts = Date.now();
    follow.at[owner] = at;
    if (agents[owner]) agents[owner].files[at.file] = at.rel || true; // project-relative name, if known
    renderFollow();
    swSoon();
    if (!live) return;
    pageFollow(owner, at);
    if (at.op === 'read' && (follow.mode === owner || follow.mode === 'active')) openAt(owner, at, true);
  }
  // Showing on the page where an agent is now (its Follow button, or Show).
  function followTask(k) {
    var at = follow.at[k];
    return { file: at.file, line: at.line, end: at.end, snapshot: at.snapshot || null, owner: k, quiet: false, away: at.away || '' };
  }
  // auto: the agent moved (not you picking Follow).
  function openAt(owner, at, auto) {
    var line = posInt(at.line) || null;
    var end = line !== null && posInt(at.end) >= line ? posInt(at.end) : null;
    var key = at.file + ':' + line + ':' + end;
    if (follow.shown === key || !wantDock()) return;
    follow.shown = key;
    var req = ++follow.req;
    // A file not in this project (a copy, a paired computer): open the text from its edit instead.
    if (at.away && at.snapshot) {
      setDock(true, false);
      enqueue({ ev: { type: 'code', snapshot: at.snapshot, file: at.file, line: line, endLine: end, part: false, note: null }, owner: owner, auto: Boolean(auto), followReq: req });
      return;
    }
    openRef({ path: at.file, line: line, end: end, auto: true, picked: !auto, followReq: req }, owner);
  }
  function setFollow(mode, jump) {
    follow.mode = mode;
    follow.shown = null;
    follow.req++; // a file still on its way for the Follow before is not shown
    storeTask(null); // nor is a page move saved before a reload
    if (mode !== 'all' && mode !== 'active') sw.active = mode;
    swSoon();
    storageSet('sessionStorage', 'editlens.follow', mode === 'all' ? null : mode);
    renderFollow();
    clearTimeout(pageGo.timer);
    pageGo.pending = null;
    pageGo.seq++; // cancel a page move not yet done
    setPageNote('');
    if (mode === 'all') return;
    if (jump) showCodeView();
    var k = mode === 'active' ? latestOwner() : mode;
    if (k && follow.at[k]) {
      openAt(k, follow.at[k]);
      if (jump && !pageGo.paused) revealFile(followTask(k));
    }
    else if (jump) showToast(ownerLabel(k || 'main') + " hasn't opened a file yet. Its code appears here when it does.");
  }
  function renderFollow() {
    renderFollowHead();
    fillFollowMenu();
    pageNoteEl.textContent = follow.mode === 'all' ? '' : pageGo.note;
    pageNoteEl.classList.toggle('on', Boolean(pageNoteEl.textContent));
  }
  // The Follow chip in the header: "Following everyone", or the agent's own label.
  function renderFollowHead() {
    var m = follow.mode;
    var kids;
    followHead.classList.toggle('on', m !== 'all');
    followHead.removeAttribute('data-key');
    if (m === 'all') {
      kids = [el('span', { class: 'am every', 'aria-hidden': 'true' }), el('span', { class: 'ftx', text: 'Following everyone' })];
    } else if (m === 'active') {
      var k = latestOwner();
      kids = [k ? chipParts(k)[0] : el('span', { class: 'am', 'aria-hidden': 'true' }), el('span', { class: 'ftx', text: 'Following the latest' + (k ? ' · ' + ownerLabel(k) : '') })];
    } else {
      var parts = chipParts(m);
      kids = [parts[0], el('span', { class: 'ftx' }, document.createTextNode('Following '), parts[1], parts[2] || null)];
      followHead.setAttribute('data-key', m);
    }
    followHead.replaceChildren.apply(followHead, kids.concat([icon('chevd')]));
    var label = m === 'all' ? 'Following everyone' : m === 'active' ? 'Following the latest edit' : 'Following ' + chipLabel(m);
    followHead.setAttribute('aria-label', label + '. Choose whom to follow');
    followHead.title = label + '. Click to choose whose edits play here.';
  }
  // The Follow menu: Everyone, Main, each subagent and task, Follow the latest edit, Show only this
  // agent's edits, and whether the page follows. Drawn again while open, as agents start and end.
  var followMenu = null;
  function openFollowMenu(button) {
    closeLayoutMenu();
    var menu = el('div', { class: 'lmenu smenu follow fwmenu', role: 'menu', 'aria-label': 'Follow' });
    var wrap = el('div', { class: 'lwrap' }, menu);
    followMenu = { menu: menu, button: button };
    fillFollowMenu();
    showMenu(wrap, menu, button, false);
  }
  function fillFollowMenu() {
    if (!followMenu || (!followMenu.menu.isConnected && followMenu.menu.childNodes.length)) {
      followMenu = null;
      return;
    }
    var menu = followMenu.menu;
    var active = menu.getRootNode().activeElement;
    var again = active && menu.contains(active) ? active.getAttribute('data-key') || active.getAttribute('data-mode') || active.getAttribute('data-act') : null;
    var kids = [el('div', { class: 'lh', text: 'Follow' })];
    function pick(mode) {
      closeLayoutMenu();
      followMenu = null;
      setFollow(mode, true);
      followHead.focus();
    }
    function row(mode, label, title) {
      var on = follow.mode === mode;
      var b = el('button', { type: 'button', role: 'menuitemradio', class: 'li fchip' + (on ? ' on' : ''), 'aria-checked': String(on), 'data-mode': mode, title: title },
        el('span', { class: 'am every', 'aria-hidden': 'true' }), el('span', { class: 'nm', text: label }));
      if (mode === 'active') b.firstChild.className = 'am';
      b.addEventListener('click', function () { pick(mode); });
      return b;
    }
    kids.push(row('all', 'Everyone', 'Play every edit, from any agent'));
    var keys = ['main'].concat(Object.keys(agents).slice(-8));
    if (follow.mode !== 'all' && follow.mode !== 'active' && keys.indexOf(follow.mode) < 0) keys.push(follow.mode);
    keys.forEach(function (k) {
      var on = follow.mode === k;
      // Each agent's label: status mark, name, one dim word; hover shows its card.
      var b = el('button', { type: 'button', role: 'menuitemradio', class: 'li fchip achip' + (on ? ' on' : ''), 'aria-checked': String(on), 'data-key': k });
      chipParts(k).forEach(function (p) { b.appendChild(p); });
      // A subagent with its own permission mode shows it.
      var am = agents[k] ? agentModeOf(k) : null;
      if (am && am.own && MODE_INFO[am.mode]) b.appendChild(el('span', { class: 'fm', 'data-mode': am.mode }, el('i'), el('span', { text: modeLabel(am.mode) })));
      bindAgentCard(b, k, function () { pick(k); });
      kids.push(b);
    });
    kids.push(el('hr'));
    kids.push(row('active', 'Follow the latest edit', 'Switch to the agent that last read or edited a file'));
    var one = follow.mode !== 'all' && follow.mode !== 'active' ? follow.mode : null;
    var only = Boolean(one) && ownerFilter === one;
    var ob = el('button', { type: 'button', role: 'menuitemcheckbox', class: 'li', 'aria-checked': String(only), 'data-act': 'only' },
      el('span', { class: 'lbl' }, document.createTextNode('Show only this agent\'s edits'), el('small', { text: one ? 'In the panel: ' + ownerLabel(one) + ' only' : 'Follow one agent first' })),
      el('span', { class: 'swi' + (only ? ' on' : ''), 'aria-hidden': 'true' }));
    if (!one) ob.disabled = true;
    ob.addEventListener('click', function () {
      setOwnerFilter(only ? null : one);
      if (!only && (state.filter === 'team' || state.filter === 'agents')) setFilter('all');
      fillFollowMenu();
    });
    kids.push(ob);
    // Whether the page follows: with Everyone nobody is followed, so turning it on follows the
    // latest agent.
    var everyone = follow.mode === 'all';
    var pageOn = !everyone && !pageGo.paused;
    var pb = el('button', { type: 'button', role: 'menuitemcheckbox', class: 'li', 'aria-checked': String(pageOn), 'data-act': 'page' },
      el('span', { class: 'lbl' }, document.createTextNode('The page follows'), el('small', { text: everyone ? 'Off while following everyone. Turn it on to follow the latest agent.'
        : pageGo.paused ? 'Paused: the page stays where it is' : 'Opens the part of your app the agent works on and outlines it' })),
      el('span', { class: 'swi' + (pageOn ? ' on' : ''), 'aria-hidden': 'true' }));
    pb.addEventListener('click', function () {
      if (everyone) {
        if (pageGo.paused) setPagePaused(false);
        setFollow('active', true);
      } else setPagePaused(!pageGo.paused);
      renderFollow();
    });
    kids.push(pb);
    menu.replaceChildren.apply(menu, kids);
    if (again) {
      var back = menu.querySelector('[data-key="' + cssEscape(again) + '"],[data-mode="' + cssEscape(again) + '"],[data-act="' + cssEscape(again) + '"]');
      if (back) back.focus({ preventScroll: true });
    }
  }
  followHead.addEventListener('click', function () { openFollowMenu(followHead); });
  function showOwner(f, owner) {
    // Labeled only when there are subagents.
    var on = Object.keys(agents).length > 0;
    f.whoEl.classList.toggle('on', on);
    if (!on) return;
    f.whoEl.style.setProperty('--fc', ownerColor(owner));
    // The agent's label, small; hover or focus shows its details card. The path never names the
    // paired computer: the chip does.
    f.whoEl.replaceChildren(agentChip(owner, { small: true }));
    f.whoEl.title = 'Last shown for ' + ownerLabel(owner);
  }

  // ---------- a change's bar, folding, and the marks on the right edge ----------
  var FOLD_MIN = 8; // unchanged lines, one after another, before they fold
  var FOLD_KEEP = 3; // lines kept around each change
  var BAR_HUNKS = 8;
  var barEvs = new WeakMap(); // bar -> its edit
  // Bars for one edit: before the first changed line of each part it changed. The first bar has
  // the buttons. o: { hunks, hl (opened from the hover card), approx (a nearby match) }.
  function editBars(f, ev, o) {
    var opt = o || {};
    var hunks = Array.isArray(opt.hunks) ? opt.hunks : [];
    var rows = [];
    var first = null;
    hunks.slice(0, BAR_HUNKS).forEach(function (h) {
      var line = firstChangedLine(h);
      if (!Number.isFinite(line)) return;
      var idx = clamp(Math.floor(line) - 1, 0, Math.max(0, f.rows.length - 1));
      if (rows.indexOf(idx) >= 0) return;
      rows.push(idx);
      var bar = hunkBar(f, ev, opt, !first);
      if (f.rows[idx]) f.rows[idx].before(bar);
      else f.codeEl.appendChild(bar);
      f.notes.push(bar);
      if (!first) first = bar;
    });
    if (!first) {
      // Nothing to place it by (a new or emptied file): the bar goes at the top.
      first = hunkBar(f, ev, opt, true);
      f.codeEl.prepend(first);
      f.notes.push(first);
    }
    f.barEv = ev;
    var no = editNumber(ev);
    f.tno.textContent = String(no);
    f.tno.classList.toggle('seen', Boolean(editNo[editKey(ev)] && editNo[editKey(ev)].seen));
    f.tno.hidden = false;
    foldRows(f, rows);
    renderMarks(f);
    reveal(f, first, false);
    if (f === focusedFile()) renderCrumb();
  }
  function hunkBar(f, ev, opt, full) {
    var rst = ev.kind === 'restore';
    var k = rst ? null : ownerOf(ev);
    var no = editNumber(ev);
    var seen = Boolean(editNo[editKey(ev)] && editNo[editKey(ev)].seen);
    // The number: who made it (the agent's details card) on hover, focus or a tap.
    var cno = el('button', { class: 'cno' + (seen ? ' seen' : ''), type: 'button', text: String(no), 'aria-label': 'Edit ' + no + (k ? ', by ' + chipLabel(k) : '') });
    if (k) bindAgentCard(cno, k, null);
    var why = el('b', { class: 'why', text: rst ? restoreLabel(ev) : ev.intent || (full ? 'Edit ' + no : 'More of edit ' + no) });
    var bar = el('div', { class: 'hbar' + (full ? '' : ' part') + (rst ? ' rst' : '') + (opt.hl ? ' hl' : ''), role: 'group', 'aria-label': 'Edit ' + no, 'data-ekey': editKey(ev) }, cno, why);
    if (full) {
      var hw = el('span', { class: 'hw' });
      if (k) {
        var chip = agentChip(k, { small: true });
        chip.classList.add('bare');
        hw.append(document.createTextNode('·'), chip);
      }
      var ago = timeAgo(ev.ts);
      if (ago) hw.appendChild(el('span', { text: '· ' + ago, title: clock(ev.ts) }));
      bar.appendChild(hw);
      if (opt.approx) bar.appendChild(el('span', { class: 'near', text: 'nearby', title: 'Matched by the nearest source line, so this may be a nearby change' }));
      bar.appendChild(barActs(f, ev, bar));
      barEvs.set(bar, ev);
    }
    return bar;
  }
  // Restore, Undo only this edit, the older and newer change in this file; narrow: one "Restore ▾".
  function barActs(f, ev, bar) {
    var acts = el('span', { class: 'acts' });
    var text = restoreButtonText(ev);
    var t = restoreTarget(ev);
    if (text) {
      var rb = el('button', { class: 'brst', type: 'button', text: text, 'aria-expanded': 'false' });
      if (t && t.off) {
        rb.disabled = true;
        rb.title = t.off;
      } else rb.addEventListener('click', function () { barAsk(f, ev, bar, 'restore', rb); });
      // Remove file sends the edit's number.
      if (!t) seqButton(rb, ev);
      acts.appendChild(rb);
    }
    var only = canUndoOnly(ev);
    if (only) {
      var ub = el('button', { class: 'buo', type: 'button', text: UNDO_ONLY, title: 'Remove only this edit from the file. Later changes stay.', 'aria-expanded': 'false' });
      ub.addEventListener('click', function () { barAsk(f, ev, bar, 'only', ub); });
      acts.appendChild(seqButton(ub, ev));
    }
    var older = fileEditNear(ev, -1);
    var newer = fileEditNear(ev, 1);
    var ob = el('button', { class: 'bprev', type: 'button', text: '‹', title: older ? 'Older change in this file' : 'No older change in this file', 'aria-label': 'Older change in this file' });
    var nb = el('button', { class: 'bnext', type: 'button', text: '›', title: newer ? 'Newer change in this file' : 'No newer change in this file', 'aria-label': 'Newer change in this file' });
    ob.disabled = !older;
    nb.disabled = !newer;
    ob.addEventListener('click', function () { replayEdit(older); });
    nb.addEventListener('click', function () { replayEdit(newer); });
    acts.append(ob, nb);
    if (text || only) {
      var mb = el('button', { class: 'bmore', type: 'button', text: 'Restore ▾', 'aria-haspopup': 'menu' });
      mb.addEventListener('click', function () { barMenu(f, ev, bar, mb); });
      acts.appendChild(mb);
    }
    return acts;
  }
  // The edit of this file before (-1) or after (1) ev, among the edits that can be shown.
  function fileEditNear(ev, d) {
    var key = keyOf(ev.file || ev.relFile || '');
    var list = timeline.filter(function (e) { return keyOf(e.file || e.relFile || '') === key; });
    var i = list.indexOf(ev);
    return i >= 0 ? list[i + d] || null : null;
  }
  // The question under a bar: Restore (or Remove file), or Undo only this edit. A second click closes it.
  function barAsk(f, ev, bar, kind, button) {
    var next = bar.nextElementSibling;
    if (next && next.classList.contains('hbox')) {
      var same = next.getAttribute('data-kind') === kind;
      next.remove();
      bar.querySelectorAll('[aria-expanded]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
      if (same) return;
    }
    var wrap = el('div', { class: 'hbox', 'data-kind': kind });
    var done = function () {
      wrap.remove();
      if (button) button.setAttribute('aria-expanded', 'false');
    };
    var box = null;
    if (kind === 'only') box = undoOnlyQuestion(ev, done);
    else if (restoreTarget(ev)) box = restoreQuestion(ev, done);
    else if (canRemove(ev) && !restoredBy(ev)) {
      bar.after(wrap);
      f.notes.push(wrap);
      confirmRemove(ev, wrap);
      if (button) button.setAttribute('aria-expanded', 'true');
      return;
    }
    if (!box) return;
    wrap.appendChild(box);
    bar.after(wrap);
    f.notes.push(wrap);
    if (button) button.setAttribute('aria-expanded', 'true');
  }
  // Narrow: "Restore ▾" contains Restore and Undo only this edit.
  function barMenu(f, ev, bar, button) {
    closeLayoutMenu();
    var menu = el('div', { class: 'lmenu smenu', role: 'menu', 'aria-label': 'Restore' });
    var wrap = el('div', { class: 'lwrap' }, menu);
    var text = restoreButtonText(ev);
    var t = restoreTarget(ev);
    if (text) {
      var rb = el('button', { class: 'li', type: 'button', role: 'menuitem', text: text });
      if (t && t.off) {
        rb.disabled = true;
        rb.title = t.off;
      }
      rb.addEventListener('click', function () {
        closeLayoutMenu();
        barAsk(f, ev, bar, 'restore', null);
      });
      if (!t) seqButton(rb, ev);
      menu.appendChild(rb);
    }
    if (canUndoOnly(ev)) {
      var ub = el('button', { class: 'li', type: 'button', role: 'menuitem', text: UNDO_ONLY });
      ub.addEventListener('click', function () {
        closeLayoutMenu();
        barAsk(f, ev, bar, 'only', null);
      });
      menu.appendChild(seqButton(ub, ev));
    }
    showMenu(wrap, menu, button, true);
  }
  // A restore or an undo changed what Restore does: update the bars' buttons.
  function refreshBars(f) {
    f.notes.forEach(function (n) {
      var ev = barEvs.get(n);
      var acts = ev && n.querySelector(':scope>.acts');
      if (acts && n.isConnected) acts.replaceWith(barActs(f, ev, n));
    });
  }
  // "Undo only this edit", asked first like Restore. done(ok) is called when it closes.
  function undoOnlyQuestion(ev, done) {
    if (!ev || !canUndoOnly(ev)) return null;
    var name = ev.relFile || ev.file || 'this file';
    var box = el('div', { class: 'rconf', role: 'group' },
      el('div', { class: 'rq', text: 'Remove only this edit from ' + name + '? Later changes to it stay.' }));
    var cancel = el('button', { class: 'mini', type: 'button', text: 'Cancel', on: { click: function (e) { e.stopPropagation(); done(false); } } });
    var only = undoOnlyButton(ev, name, box, done);
    only.classList.add('allow');
    box.appendChild(el('div', { class: 'pacts' }, only, cancel));
    focusCancel(box, cancel);
    return box;
  }
  // Long runs of unchanged lines fold into one "Lines 1–17 unchanged" row; a click shows them.
  // Hidden lines don't count, so the row counts them: the line numbers after it stay correct.
  function foldRows(f, barRows) {
    var n = f.rows.length;
    if (n < FOLD_MIN + FOLD_KEEP) return;
    var keep = new Uint8Array(n);
    var any = false;
    var near = function (i) {
      any = true;
      for (var j = Math.max(0, i - FOLD_KEEP); j <= Math.min(n - 1, i + FOLD_KEEP); j++) keep[j] = 1;
    };
    f.rows.forEach(function (r, i) {
      var c = r.classList;
      if (c.contains('lmark') || c.contains('recent') || c.contains('add')) near(i);
    });
    (barRows || []).forEach(near);
    if (!any) return;
    var i = 0;
    while (i < n) {
      if (keep[i]) {
        i++;
        continue;
      }
      var j = i;
      while (j < n && !keep[j]) j++;
      if (j - i >= FOLD_MIN) addFold(f, i, j - 1);
      i = j;
    }
  }
  function addFold(f, a, b) {
    var rows = f.rows.slice(a, b + 1);
    var btn = el('button', { class: 'cfold', type: 'button', title: 'Show these lines', 'aria-expanded': 'false' },
      icon('chevd'), el('span', { text: 'Lines ' + (a + 1) + '–' + (b + 1) + ' unchanged' }));
    btn.style.counterIncrement = 'ln ' + rows.length;
    var fold = { btn: btn, rows: rows };
    btn.addEventListener('click', function () { unfold(f, fold); });
    rows.forEach(function (r) { r.classList.add('fold'); });
    rows[0].before(btn);
    f.notes.push(btn);
    f.folds.push(fold);
  }
  function unfold(f, fold) {
    fold.rows.forEach(function (r) { r.classList.remove('fold'); });
    fold.btn.remove();
    f.folds = f.folds.filter(function (x) { return x !== fold; });
    f.notes = f.notes.filter(function (x) { return x !== fold.btn; });
  }
  function unfoldAt(f, row) {
    var fold = f.folds.find(function (x) { return x.rows.indexOf(row) >= 0; });
    if (fold) unfold(f, fold);
  }
  // Marks on the right edge: where this file's changes are, so a long file is easy to scan.
  function renderMarks(f) {
    var n = f.rows.length;
    var runs = [];
    f.rows.forEach(function (r, i) {
      var c = r.classList;
      var kind = c.contains('lmark') ? 'lm' : c.contains('recent') || c.contains('add') ? (f.paneEl.classList.contains('rstd') ? 'rs' : 'ad') : null;
      if (!kind) return;
      var last = runs[runs.length - 1];
      if (last && last.kind === kind && last.end === i - 1) last.end = i;
      else runs.push({ start: i, end: i, kind: kind });
    });
    f.marksEl.replaceChildren.apply(f.marksEl, runs.slice(0, 200).map(function (run) {
      var m = el('i', { class: run.kind, title: 'Line ' + (run.start + 1) + (run.end > run.start ? '–' + (run.end + 1) : '') });
      m.style.top = (run.start / n) * 100 + '%';
      m.style.height = ((run.end - run.start + 1) / n) * 100 + '%';
      m.addEventListener('click', function () { reveal(f, f.rows[run.start], true); });
      return m;
    }));
  }

  // ---------- the header: the path of the focused pane's file ----------
  // The file button stays the same element, so a menu opened from it keeps its place and focus.
  var crumbDir = el('span', { class: 'cdir' });
  var crumbBtn = el('button', { class: 'fbtn', type: 'button', 'aria-haspopup': 'menu' });
  crumbBtn.addEventListener('click', function () {
    var f = focusedFile();
    if (!f) return;
    // Narrow: the sidebar's lists in a sheet (the file menu is at its top).
    if (dock.classList.contains('narrow')) openDockSheet('side');
    else paneMenu(f, crumbBtn);
  });
  function renderCrumb() {
    var f = focusedFile();
    activeKey = f ? f.key : null;
    if (!f) {
      crumbEl.replaceChildren(el('span', { class: 'cnone', text: 'Code view' }));
      return;
    }
    var vp = viewPath(f.file, f.relFile);
    var shown = shownPath(vp.rel);
    var cut = Math.max(shown.lastIndexOf('/'), shown.lastIndexOf('\\')) + 1;
    var parts = shown.slice(0, cut).split(/[\\/]/).filter(Boolean);
    var inner = el('span');
    parts.forEach(function (p) {
      inner.appendChild(el('span', { class: 'cs', text: p }));
      inner.appendChild(el('span', { class: 'sep', text: '›', 'aria-hidden': 'true' }));
    });
    crumbDir.replaceChildren(inner);
    crumbDir.title = vp.full;
    var where = editWhere({ remote: null, copy: /[\\/]\.claude[\\/]worktrees[\\/]/.test(String(f.file)), task: null });
    crumbBtn.setAttribute('aria-label', shown + ': file menu');
    crumbBtn.title = vp.full + (where ? '\n' + where : '') + '\nClick for the file menu';
    crumbBtn.replaceChildren();
    if (f.barEv) crumbBtn.appendChild(el('span', { class: 'cno' + (editNo[editKey(f.barEv)] && editNo[editKey(f.barEv)].seen ? ' seen' : ''), text: String(editNumber(f.barEv)), 'aria-hidden': 'true' }));
    crumbBtn.append(el('b', { text: shown.slice(cut) || shown }), icon('chevd'));
    if (parts.length) {
      if (crumbDir.parentNode !== crumbEl || crumbBtn.parentNode !== crumbEl) crumbEl.replaceChildren(crumbDir, crumbBtn);
    } else if (crumbDir.parentNode === crumbEl || crumbBtn.parentNode !== crumbEl) crumbEl.replaceChildren(crumbBtn);
  }

  // ---------- menus ----------
  // Puts a menu beside its button (in the part that is in full screen), closes it on Esc or a
  // click outside, and gives it focus.
  function showMenu(wrap, menu, button, right) {
    wrap.addEventListener('pointerdown', function (e) { if (e.target === wrap) closeLayoutMenu(); });
    wrap.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeLayoutMenu();
      if (button.isConnected) button.focus();
    });
    menuHost(button).appendChild(wrap);
    var view = button.ownerDocument.defaultView;
    var b = button.getBoundingClientRect();
    var mw = menu.offsetWidth;
    var mh = menu.offsetHeight;
    menu.style.left = Math.round(clamp(right ? b.right - mw : b.left, 8, view.innerWidth - mw - 8)) + 'px';
    menu.style.top = Math.round(b.bottom + mh + 8 < view.innerHeight ? b.bottom + 6 : Math.max(8, b.top - mh - 6)) + 'px';
    menu.setAttribute('tabindex', '-1');
    menu.focus();
  }
  // View (⋯): wrap, text size, speed; where the code view is placed; reset, tour, settings.
  function openViewMenu(button) {
    closeLayoutMenu();
    var L = layout.dock;
    var popped = Boolean(pop.dock);
    var full = isFull('dock');
    var menu = el('div', { class: 'lmenu smenu vmenu', role: 'menu', 'aria-label': 'View' });
    var wrap = el('div', { class: 'lwrap' }, menu);
    function act(fn) {
      return function () {
        closeLayoutMenu();
        fn();
      };
    }
    function item(label, sub, fn, attrs) {
      var b = el('button', Object.assign({ type: 'button', role: 'menuitem', class: 'li' }, attrs || {}),
        el('span', { class: 'lbl' }, document.createTextNode(label), sub ? el('small', { text: sub }) : null));
      b.addEventListener('click', act(fn));
      menu.appendChild(b);
      return b;
    }
    function place(mode, label, sub) {
      var on = !popped && (mode === 'side' ? L.mode === 'right' || L.mode === 'left' : L.mode === mode);
      return item(label, sub, function () { setDockMode(mode === 'side' ? (L.mode === 'left' ? 'left' : 'right') : mode); }, { role: 'menuitemradio', 'aria-checked': String(on), 'data-act': mode });
    }
    menu.appendChild(el('div', { class: 'lh', text: 'View' }));
    var wb = el('button', { type: 'button', role: 'menuitemcheckbox', class: 'li', 'aria-checked': String(dockState.wrap), 'data-act': 'wrap' },
      el('span', { class: 'lbl' }, document.createTextNode('Wrap long lines'), el('small', { text: 'Long lines continue on the next line' })),
      el('span', { class: 'swi' + (dockState.wrap ? ' on' : ''), 'aria-hidden': 'true' }));
    wb.addEventListener('click', act(function () { setWrap(!dockState.wrap); }));
    menu.appendChild(wb);
    var seg = el('div', { class: 'seg3', role: 'radiogroup', 'aria-label': 'Text size' });
    [['s', 'Small text'], ['m', 'Medium text'], ['l', 'Large text']].forEach(function (x) {
      var b = el('button', { type: 'button', role: 'menuitemradio', class: 'sz-' + x[0] + (state.size === x[0] ? ' on' : ''), 'aria-checked': String(state.size === x[0]), 'aria-label': x[1], title: x[1], text: 'A' });
      b.addEventListener('click', act(function () { setSize(x[0]); }));
      seg.appendChild(b);
    });
    menu.appendChild(el('div', { class: 'vrow' }, el('span', { class: 'lbl', text: 'Text size' }), seg));
    var sp = el('div', { class: 'seg3 vsp', role: 'radiogroup', 'aria-label': 'Speed' });
    SPEEDS.forEach(function (s) {
      var b = el('button', { type: 'button', role: 'menuitemradio', class: dockState.speed === s ? 'on' : '', 'aria-checked': String(dockState.speed === s), text: s + '×' });
      b.addEventListener('click', act(function () { setSpeed(s); }));
      sp.appendChild(b);
    });
    menu.appendChild(el('div', { class: 'vrow' }, el('span', { class: 'lbl', text: 'Speed' }), sp));
    menu.appendChild(el('hr'));
    menu.appendChild(el('div', { class: 'lh', text: 'Position' }));
    if (popped) {
      item('Back to the page', 'It is in its own window now', function () { popIn('dock'); }, { 'data-act': 'popin' });
    } else {
      var beside = place('side', 'Beside the page', '');
      // Which side: two small buttons in the row.
      var two = el('span', { class: 'side2', role: 'group', 'aria-label': 'Side' });
      [['left', 'Left'], ['right', 'Right']].forEach(function (x) {
        var b = el('button', { type: 'button', class: L.mode === x[0] ? 'on' : '', 'aria-pressed': String(L.mode === x[0]), text: x[1], title: 'Docked ' + x[0] });
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          closeLayoutMenu();
          setDockMode(x[0]);
        });
        two.appendChild(b);
      });
      beside.appendChild(two);
      place('bottom', 'At the bottom', '');
      place('float', 'Floating window', 'Move it anywhere on the page');
      item('In its own window', 'A separate window, also on another screen', function () { popOut('dock'); }, { 'data-act': 'popout' });
    }
    item(full ? 'Exit full screen' : 'Full screen', '', function () { toggleFull('dock'); }, { 'data-act': 'full' });
    menu.appendChild(el('hr'));
    if (!popped && L.mode !== 'float') item('Collapse to a narrow bar', 'Alt+Shift+D', function () { setDockCollapsed(true); }, { 'data-act': 'collapse' });
    item('Reset layout', 'Back where it started, at the default size', resetLayout, { 'data-act': 'reset' });
    item('Quick tour', '', function () { showTour(true); }, { 'data-act': 'tour' });
    item('All settings', '', function () { openSettingsHere(button); }, { 'data-act': 'settings' });
    showMenu(wrap, menu, button, true);
  }
  function setDockMode(mode) {
    if (DOCK_MODES.indexOf(mode) < 0) return;
    layout.dock.mode = mode;
    saveLayout();
    renderDock();
  }
  // Settings from inside the code view: in its own window or in full screen they open as a sheet
  // in the code view; else in the panel.
  function openSettingsHere(button) {
    var here = Boolean(button && dock.contains(button)) && (Boolean(pop.dock) || isFull('dock'));
    if (!here && button && button.ownerDocument !== document) {
      leaveFullFor();
      window.focus();
    }
    setSettingsOpen(true, here);
  }

  // ---------- the sheet inside the code view ----------
  var sheet = { kind: null, from: null };
  var sheetTitle = el('b');
  var sheetMenu = el('button', { class: 'mini', type: 'button', text: 'File menu', 'aria-haspopup': 'menu' });
  var sheetDone = el('button', { class: 'mini', type: 'button', text: 'Done' });
  var sheetBody = el('div', { class: 'shb' });
  dockSheetEl.append(el('div', { class: 'shh' }, sheetTitle, sheetMenu, sheetDone), sheetBody);
  sheetDone.addEventListener('click', function () { closeDockSheet(); });
  sheetMenu.addEventListener('click', function () {
    var f = focusedFile();
    if (f) paneMenu(f, sheetMenu);
  });
  dockSheetEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    closeDockSheet();
  });
  function openDockSheet(kind) {
    if (sheet.kind === kind) return;
    if (sheet.kind) closeDockSheet(true);
    var r = dock.getRootNode();
    sheet = { kind: kind, from: r.activeElement || null };
    dockSheetEl.classList.toggle('settings', kind === 'settings');
    if (kind === 'settings') {
      dockSheetEl.setAttribute('aria-label', 'Settings');
      sheetTitle.textContent = 'Settings';
      sheetMenu.hidden = true;
      sheetBody.replaceChildren(settingsEl);
    } else {
      var f = focusedFile();
      sheetTitle.textContent = f ? baseName(f.file) : 'Code view';
      sheetMenu.hidden = !f;
      dockSheetEl.setAttribute('aria-label', 'Edits, files and agents');
      sheetBody.replaceChildren(sideEl);
      renderSideState();
    }
    dockSheetEl.classList.add('on');
    // Settings in a full-screen code view appear above the panel too, so nothing covers them.
    dock.classList.toggle('shtop', kind === 'settings' && isFull('dock'));
    if (kind === 'side') {
      var tab = sideTabsEl.querySelector('[aria-selected=true]');
      if (tab) tab.focus();
    }
  }
  // Esc or Done: the sheet closes and focus returns to where it was.
  function closeDockSheet(quiet) {
    if (!sheet.kind) return;
    // Settings close through their own path, which returns here (settingsPlace).
    if (sheet.kind === 'settings' && settings.open && settings.inDock) return setSettingsOpen(false);
    var kind = sheet.kind;
    var from = sheet.from;
    sheet = { kind: null, from: null };
    dockSheetEl.classList.remove('on');
    dock.classList.remove('shtop');
    if (kind === 'side') dockBody.insertBefore(sideEl, dockBody.firstChild);
    if (kind === 'settings' && settingsEl.parentNode !== panel) usageEl.after(settingsEl);
    renderSideState();
    if (!quiet && from && from.isConnected) from.focus();
  }
  // Called when Settings open or close: a sheet in the code view, or their place in the panel.
  function settingsPlace() {
    if (settings.open && settings.inDock) return openDockSheet('settings');
    if (settingsEl.parentNode !== panel) usageEl.after(settingsEl);
    if (sheet.kind === 'settings') closeDockSheet();
  }

  // ---------- the sidebar: Edits, Files, Agents; the strip when it is hidden ----------
  var sideTabButtons = {};
  [['edits', 'Edits'], ['files', 'Files'], ['agents', 'Agents']].forEach(function (x) {
    var b = el('button', { type: 'button', role: 'tab', 'data-tab': x[0], 'aria-selected': 'false' }, el('span', { text: x[1] }), el('span', { class: 'k' }));
    b.addEventListener('click', function () { setSide(true, x[0]); });
    sideTabsEl.appendChild(b);
    sideTabButtons[x[0]] = b;
  });
  sideTabsEl.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    var i = SIDE_TABS.indexOf(dockState.sideTab) + (e.key === 'ArrowRight' ? 1 : -1);
    var next = SIDE_TABS[(i + SIDE_TABS.length) % SIDE_TABS.length];
    setSide(true, next);
    sideTabButtons[next].focus();
  });
  var sideAll = el('button', { type: 'button', text: 'Show all now', title: 'Show every waiting edit now' });
  var sideMore = el('button', { class: 'more', type: 'button' });
  sideFoot.append(sideAll, el('span', { text: '·', 'aria-hidden': 'true' }), sideMore);
  sideFoot.className = 'sdfoot';
  sideAll.addEventListener('click', catchUp);
  var showEarlier = false;
  sideMore.addEventListener('click', function () {
    showEarlier = !showEarlier;
    renderEdits();
  });
  var stripBadge = el('span', { class: 'bdg' });
  var stripTabs = {};
  var stripShow = el('button', { class: 'icon', type: 'button', title: 'Show the sidebar (Alt+Shift+B)', 'aria-label': 'Show the sidebar' }, icon('side'));
  stripShow.addEventListener('click', function () { setSide(true); });
  [['edits', 'list', 'Edits'], ['files', 'file', 'Files'], ['agents', 'people', 'Agents (Alt+Shift+A)']].forEach(function (x) {
    var b = el('button', { class: 'icon', type: 'button', title: x[2], 'aria-label': x[2].replace(/ \(.*/, ''), 'data-tab': x[0] }, icon(x[1]));
    if (x[0] === 'edits') b.appendChild(stripBadge);
    b.addEventListener('click', function () { setSide(true, x[0]); });
    stripTabs[x[0]] = b;
  });
  // Select and Full screen are always at the bottom.
  stripEl.append(stripShow, el('hr'), stripTabs.edits, stripTabs.files, stripTabs.agents, el('span', { class: 'sgap' }),
    mirrorButton(pointButton, 'icon'), mirrorButton(dockFullButton, 'icon'));
  sideButton.addEventListener('click', function () { toggleSide(); });

  function dockNarrow() {
    return dock.classList.contains('narrow');
  }
  function setSide(on, tab) {
    if (tab && SIDE_TABS.indexOf(tab) >= 0) {
      dockState.sideTab = tab;
      storageSet('localStorage', 'editlens.dockSideTab', tab === 'edits' ? null : tab);
    }
    // Narrow: the sidebar is a sheet.
    if (dockNarrow()) {
      if (on) openDockSheet('side');
      else closeDockSheet();
    } else {
      dockState.side = Boolean(on);
      storageSet('localStorage', 'editlens.dockSide', on ? null : 'off');
    }
    renderSideState();
  }
  function sideShown() {
    return dockNarrow() ? sheet.kind === 'side' : dockState.side;
  }
  function toggleSide() {
    setSide(!sideShown());
  }
  // Alt+Shift+A and the strip: open that list, or close the sidebar when it is already open there.
  function toggleSideTab(tab) {
    if (sideShown() && dockState.sideTab === tab) setSide(false);
    else setSide(true, tab);
  }
  function renderSideState() {
    var shown = sideShown();
    dock.classList.toggle('noside', !dockState.side);
    sideButton.setAttribute('aria-pressed', String(shown));
    sideButton.title = (shown ? 'Hide' : 'Show') + ' the sidebar (Alt+Shift+B)';
    sideButton.setAttribute('aria-label', shown ? 'Hide the sidebar' : 'Show the sidebar');
    SIDE_TABS.forEach(function (t) {
      var on = dockState.sideTab === t;
      sideTabButtons[t].setAttribute('aria-selected', String(on));
      sideTabButtons[t].setAttribute('tabindex', on ? '0' : '-1');
      stripTabs[t].setAttribute('aria-pressed', 'false');
    });
    sideEdits.classList.toggle('on', dockState.sideTab === 'edits');
    sideFiles.classList.toggle('on', dockState.sideTab === 'files');
    sideAgents.classList.toggle('on', dockState.sideTab === 'agents');
    sideFoot.hidden = dockState.sideTab !== 'edits';
    swSoon();
    sideSoon();
  }
  var sideTimer = 0;
  // Drawn at most every 40 ms (a timer, so it also runs while the page's tab is hidden behind a
  // popped-out code view).
  function sideSoon() {
    if (sideTimer || typeof sideEdits === 'undefined') return;
    sideTimer = setTimeout(function () {
      sideTimer = 0;
      renderSide();
    }, 40);
  }
  function renderSide() {
    var running = Object.keys(agents).filter(function (k) { return !agents[k].done; }).length;
    sideTabButtons.agents.querySelector('.k').textContent = running ? String(running) : '';
    var waiting = waitingEdits().length;
    sideTabButtons.edits.querySelector('.k').textContent = waiting ? String(waiting) : '';
    stripBadge.textContent = waiting ? String(waiting) : '';
    if (!dockShown()) return;
    if (dockState.sideTab === 'edits') renderEdits();
    else if (dockState.sideTab === 'files') renderFiles();
  }
  function dockShown() {
    return (dockState.open || Boolean(pop.dock)) && !railOn();
  }

  // Edits, grouped by your request (newest first), Claude's edits waiting to play under their own
  // heading, and the edits made while this page was closed at the top.
  var REQUESTS_MAX = 30;
  var REQUEST_EDITS_MAX = 80;
  var requests = [];
  var missedGroup = null;
  // A message to Claude, from the terminal or this page: the next edits are grouped under it.
  function noteRequest(text, ts) {
    if (!Array.isArray(requests)) return; // the page script is still being built
    var t = Number(ts);
    requests.push({ text: firstLine(text, 90), ts: Number.isFinite(t) && t > 0 ? t : Date.now(), edits: [] });
    if (requests.length > REQUESTS_MAX) requests.shift();
    sideSoon();
  }
  function noteRequestEdit(ev) {
    if (!requests.length) requests.push({ text: '', ts: finiteNum(ev.ts) || Date.now(), edits: [] });
    var r = requests[requests.length - 1];
    if (r.edits.indexOf(ev) >= 0) return;
    r.edits.push(ev);
    if (r.edits.length > REQUEST_EDITS_MAX) r.edits.shift();
    sideSoon();
  }
  // "N edits while this page was closed", with Play; null when it is done or closed.
  function noteMissed(title, list, card) {
    missedGroup = title && Array.isArray(list) && list.length ? { title: title, list: list, card: card } : null;
    sideSoon();
  }
  function playMissed() {
    var g = missedGroup;
    if (!g) return;
    showCodeView();
    g.list.forEach(function (ev) { enqueue({ ev: ev, owner: ownerOf(ev) }); });
    if (g.card) g.card.remove();
    noteMissed(null);
  }
  function editRow(ev, on) {
    var n = editNumber(ev);
    var seen = Boolean(editNo[editKey(ev)] && editNo[editKey(ev)].seen);
    var p = splitPath(ev.relFile || ev.file);
    var k = ev.kind === 'restore' ? null : ownerOf(ev);
    var who = el('span', { class: 'ew' });
    if (k) chipParts(k, true).forEach(function (x) { who.appendChild(x); });
    else who.append(el('span', { class: 'am rs', 'aria-hidden': 'true' }), el('span', { class: 'an', text: restoreLabel(ev) }));
    who.appendChild(countsNode(countsOf(ev)));
    var b = el('button', { class: 'erow' + (on ? ' on' : ''), type: 'button', 'data-ekey': editKey(ev), 'aria-current': on ? 'true' : null,
      title: [ev.intent || '', shownPath(ev.relFile || ev.file), clock(ev.ts)].filter(Boolean).join('\n') },
    el('span', { class: 'cno' + (seen ? ' seen' : ''), text: String(n), 'aria-hidden': 'true' }),
    el('span', { class: 'ef' }, document.createTextNode(p.name || p.dir), p.name && p.dir ? el('span', { text: p.dir }) : null), who);
    b.addEventListener('click', function () {
      lookedAt(ev);
      if (ev.snapshot) replayEdit(ev);
      else openRef({ path: ev.file || ev.relFile, line: lineNo(ev.hunks && firstChangedLine(ev.hunks[0])), end: null });
    });
    return b;
  }
  function renderEdits() {
    var waiting = waitingEdits();
    var cur = timelinePos >= 0 ? timeline[timelinePos] : null;
    var skip = new Set(waiting);
    var kids = [];
    if (missedGroup) {
      var play = el('button', { class: 'mini', type: 'button', text: 'Play', title: 'Play them in order' });
      play.addEventListener('click', playMissed);
      var close = el('button', { class: 'mini', type: 'button', text: 'Close' });
      close.addEventListener('click', function () {
        if (missedGroup && missedGroup.card) missedGroup.card.remove();
        noteMissed(null);
      });
      kids.push(el('div', { class: 'egh missed' }, el('span', { class: 'q', text: missedGroup.title }), play, close));
      missedGroup.list.forEach(function (ev) {
        skip.add(ev);
        kids.push(editRow(ev, ev === cur));
      });
    }
    if (waiting.length) {
      kids.push(el('div', { class: 'egh wait' }, el('span', { class: 'q', text: 'Waiting to play' }), el('span', { class: 'k', text: String(waiting.length) })));
      waiting.forEach(function (ev) { kids.push(editRow(ev, false)); });
    }
    var list = requests.filter(function (r) { return r.edits.some(function (e) { return !skip.has(e); }); }).reverse();
    var cut = !showEarlier && list.length > 4;
    (cut ? list.slice(0, 4) : list).forEach(function (r) {
      var head = r.text ? '“' + r.text + '”' : 'Earlier edits';
      kids.push(el('div', { class: 'egh req', title: r.text || '' }, el('span', { class: 'q', text: head }), el('span', { class: 'k', text: clock(r.ts) })));
      r.edits.forEach(function (ev) { if (!skip.has(ev)) kids.push(editRow(ev, ev === cur)); });
    });
    if (!kids.length) kids.push(el('div', { class: 'sempty', text: 'Edits Claude makes appear here, grouped by your request. Click one to play it again.' }));
    var top = sideEdits.parentNode ? sideEdits.parentNode.scrollTop : 0;
    sideEdits.replaceChildren.apply(sideEdits, kids);
    if (sideEdits.parentNode) sideEdits.parentNode.scrollTop = top;
    sideAll.disabled = !waiting.length;
    sideMore.textContent = showEarlier ? '‹ Fewer requests' : 'Earlier requests ›';
    sideMore.disabled = !showEarlier && list.length <= 4;
  }

  // Files: the open files, then the project's folders (the file picker and folder browser).
  var browse = { path: '.', data: null, busy: false, error: '' };
  function loadBrowse(p) {
    browse = { path: p, data: null, busy: true, error: '' };
    var q = new URLSearchParams({ ref: p, page: PAGE_ID });
    fetch(SERVER + '/file?' + q.toString()).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, json: json }; });
    }).then(function (r) {
      if (browse.path !== p) return;
      var j = r.json || {};
      browse.busy = false;
      if (r.ok && j.kind === 'dir') browse.data = j;
      else browse.error = j.error || 'Could not list this folder.';
      renderFiles();
    }).catch(function (err) {
      if (browse.path !== p) return;
      browse.busy = false;
      browse.error = 'Could not list this folder: ' + err.message;
      renderFiles();
    });
  }
  function renderFiles() {
    var kids = [el('div', { class: 'egh' }, el('span', { class: 'q', text: 'Open' }), el('span', { class: 'k', text: fileOrder.length ? String(fileOrder.length) : '' }))];
    var cur = focusedFile();
    fileOrder.slice().reverse().forEach(function (k) {
      var f = files[k];
      if (!f) return;
      var p = splitPath(f.shown);
      var b = el('button', { class: 'frow' + (f === cur ? ' on' : ''), type: 'button', title: f.shown, 'data-key': k }, icon('file'), el('span', { class: 'fn', text: p.name || f.shown }), p.dir ? el('span', { class: 'fd', text: p.dir }) : null);
      b.addEventListener('click', function () { showFile(f, true); });
      kids.push(b);
    });
    if (!fileOrder.length) kids.push(el('div', { class: 'sempty', text: 'No files open yet.' }));
    var at = browse.data && browse.data.rel ? browse.data.rel : '';
    var head = el('div', { class: 'egh' }, el('span', { class: 'q', text: at ? 'Project › ' + at : 'Project', title: at }));
    if (browse.path !== '.') {
      var up = el('button', { class: 'mini', type: 'button', text: '‹ Up', title: 'The folder above' });
      up.addEventListener('click', function () {
        var parts = String(at || browse.path).split(/[\\/]/).filter(Boolean);
        parts.pop();
        loadBrowse(parts.length ? parts.join('/') : '.');
        renderFiles();
      });
      head.appendChild(up);
    }
    kids.push(head);
    if (!browse.data && !browse.busy && !browse.error && dockShown() && dockState.sideTab === 'files') loadBrowse(browse.path);
    if (browse.busy) kids.push(el('div', { class: 'sempty', text: 'Loading…' }));
    else if (browse.error) {
      var again = el('button', { class: 'mini', type: 'button', text: 'Try again' });
      again.addEventListener('click', function () { loadBrowse(browse.path); renderFiles(); });
      kids.push(el('div', { class: 'sempty' }, el('div', { text: browse.error }), again));
    } else if (browse.data) {
      var entries = Array.isArray(browse.data.entries) ? browse.data.entries : [];
      if (!entries.length) kids.push(el('div', { class: 'sempty', text: 'This folder is empty.' }));
      entries.forEach(function (x) {
        if (!x || typeof x.name !== 'string' || typeof x.rel !== 'string') return;
        var b = el('button', { class: 'frow', type: 'button', title: x.rel, 'data-rel': x.rel }, icon(x.dir ? 'folder' : 'file'), el('span', { class: 'fn', text: x.name + (x.dir ? '/' : '') }));
        b.addEventListener('click', function () {
          if (x.dir) {
            loadBrowse(x.rel);
            renderFiles();
          } else openRef({ path: x.rel, line: null, end: null });
        });
        kids.push(b);
      });
    }
    sideFiles.replaceChildren.apply(sideFiles, kids);
  }

  // Agents: the agents list (switcher) is here while the code view is open.
  function swInDock() {
    return dockShown();
  }
  function swHome() {
    var box = swInDock() ? sideAgents : switcher.querySelector('.swin');
    if (box && swList.parentNode !== box) box.append(swList, swHint);
  }

  // ---------- the timeline at the bottom ----------
  var tlDone = el('span', { class: 'tld' });
  var tlHead = el('button', { class: 'tlh', type: 'button', tabindex: '-1', 'aria-label': 'Play or pause', title: 'Click to play or pause. Drag to go to an edit.' });
  function tickAt(i, n) {
    return n <= 1 ? 50 : 3 + (i * 94) / (n - 1);
  }
  function tickColor(ev) {
    if (ev.kind === 'restore') return RESTORE_COLOR;
    var k = ownerOf(ev);
    var kind = agentKind(k);
    return kind === 'main' ? 'var(--add)' : kind === 'sub' ? ownerColor(k) : 'var(--accent)';
  }
  function renderTimeline() {
    var n = timeline.length;
    var wait = new Set(waitingEdits());
    var at = timelinePos >= 0 && timelinePos < n ? timelinePos : n - 1;
    if (!n) {
      tlTrack.replaceChildren(el('span', { class: 'tlnone', text: 'No edits yet' }));
      tlStart.textContent = '';
      tlTrack.setAttribute('aria-valuemax', '1');
      tlTrack.setAttribute('aria-valuenow', '0');
      tlTrack.setAttribute('aria-valuetext', 'No edits yet');
      return;
    }
    var kids = [tlDone];
    timeline.forEach(function (ev, i) {
      var t = el('i', { class: 'tlt' + (wait.has(ev) ? ' wait' : '') + (i === timelinePos ? ' on' : ''), title: (ev.intent ? ev.intent + '\n' : '') + shownPath(ev.relFile || ev.file) + (wait.has(ev) ? '\nWaiting to play' : '') });
      t.style.left = tickAt(i, n) + '%';
      t.style.background = tickColor(ev);
      kids.push(t);
    });
    kids.push(tlHead);
    tlTrack.replaceChildren.apply(tlTrack, kids);
    tlDone.style.width = tickAt(at, n) + '%';
    tlHead.style.left = tickAt(at, n) + '%';
    tlStart.textContent = clock(timeline[0].ts);
    tlTrack.setAttribute('aria-valuemax', String(n));
    tlTrack.setAttribute('aria-valuenow', String(at + 1));
    tlTrack.setAttribute('aria-valuetext', 'Edit ' + (at + 1) + ' of ' + n + ': ' + baseName(timeline[at].relFile || timeline[at].file));
  }
  // The edit nearest to x on the track.
  function tickFor(x) {
    var r = tlTrack.getBoundingClientRect();
    var n = timeline.length;
    if (!n || !(r.width > 0) || !Number.isFinite(x)) return -1;
    if (n === 1) return 0;
    return clamp(Math.round((((x - r.left) / r.width) * 100 - 3) / 94 * (n - 1)), 0, n - 1);
  }
  // Click or drag to an edit; dragged to the end with edits waiting, they all show now. A click
  // on the round head plays or pauses.
  tlTrack.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || !timeline.length) return;
    e.preventDefault();
    var onHead = e.target === tlHead;
    var startX = e.clientX;
    var moved = false;
    tlTrack.setPointerCapture(e.pointerId);
    tlTrack.focus({ preventScroll: true });
    function move(ev) {
      if (!moved && Math.abs(ev.clientX - startX) < 4) return;
      moved = true;
      tlTrack.classList.add('drag');
      var i = tickFor(ev.clientX);
      if (i < 0) return;
      var p = tickAt(i, timeline.length) + '%';
      tlHead.style.left = p;
      tlDone.style.width = p;
      tlTrack.setAttribute('aria-valuenow', String(i + 1));
    }
    function up(ev) {
      tlTrack.removeEventListener('pointermove', move);
      tlTrack.removeEventListener('pointerup', up);
      tlTrack.removeEventListener('pointercancel', up);
      tlTrack.classList.remove('drag');
      if (ev.type === 'pointercancel') return renderTimeline();
      if (onHead && !moved) return togglePlay();
      var i = tickFor(ev.clientX);
      if (i < 0) return renderTimeline();
      if (i === timeline.length - 1 && waitingEdits().length) {
        catchUp();
        return renderTimeline();
      }
      replayAt(i);
    }
    tlTrack.addEventListener('pointermove', move);
    tlTrack.addEventListener('pointerup', up);
    tlTrack.addEventListener('pointercancel', up);
  });
  tlTrack.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    var n = timeline.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') stepEdit(-1);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') stepEdit(1);
    else if (e.key === 'Home' && n) replayAt(0);
    else if (e.key === 'End' && n) {
      if (waitingEdits().length) catchUp();
      else replayAt(n - 1);
    } else if (e.key === ' ' || e.key === 'Enter') togglePlay();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  // ---------- keys ----------
  // ← → and Space only while the code view has focus (never Alt+←, the browser's Back); not in a
  // field, a button, a menu or a sheet. Esc there closes the code view.
  dock.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
    var space = e.key === ' ' || e.code === 'Space';
    var esc = e.key === 'Escape';
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && !space && !esc) return;
    if (e.shiftKey && !esc) return;
    var t = e.composedPath ? e.composedPath()[0] : e.target;
    if (t && t.nodeType === 1 && t.closest('input,textarea,select,button,a[href],[contenteditable],[role=tab],[role=slider],[role=separator],[role=menu],[role=dialog],.lwrap')) return;
    if (esc) {
      // Pointing, a selection on the page or full screen handle Esc first.
      if (pick.on || sel.key || isFull('dock') || sheet.kind) return;
      e.preventDefault();
      closeDock();
      return;
    }
    e.preventDefault();
    if (space) togglePlay();
    else stepEdit(e.key === 'ArrowLeft' ? -1 : 1);
  });
  // Alt+Shift+B: show or hide the sidebar.
  window.addEventListener('keydown', function (e) {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || !(e.code === 'KeyB' || e.key === 'B' || e.key === 'b') || hostTyping(e)) return;
    e.preventDefault();
    if (!dockShown()) {
      showCodeView();
      return setSide(true);
    }
    toggleSide();
  });
  // A phone: swipe left or right on the code for the next or previous edit.
  var swipe = null;
  panesEl.addEventListener('touchstart', function (e) {
    swipe = null;
    if (!dock.classList.contains('phone') || e.touches.length !== 1) return;
    var code = e.target && e.target.closest ? e.target.closest('.code') : null;
    // Code that scrolls sideways (Wrap off) keeps the swipe for scrolling.
    if (code && code.scrollWidth > code.clientWidth + 1) return;
    swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, at: Date.now() };
  }, { passive: true });
  panesEl.addEventListener('touchend', function (e) {
    var s = swipe;
    swipe = null;
    if (!s || !e.changedTouches.length) return;
    var dx = e.changedTouches[0].clientX - s.x;
    var dy = e.changedTouches[0].clientY - s.y;
    if (Math.abs(dx) < 60 || Math.abs(dy) > 40 || Date.now() - s.at > 900) return;
    stepEdit(dx < 0 ? 1 : -1);
  }, { passive: true });

  // ---------- narrow and phone ----------
  var SHEET_H = dict({ low: '34vh', half: '58vh', full: 'calc(100vh - 24px)' });
  // Called by placeDock: a phone-sized window shows the code view as a bottom sheet.
  function placeSheet(rail) {
    var phone = !rail && !pop.dock && window.innerWidth <= 480 && layout.dock.mode !== 'float';
    dock.classList.toggle('phone', phone);
    dock.style.setProperty('--sheet-h', SHEET_H[dockState.sheet] || SHEET_H.half);
    dockGrab.setAttribute('aria-label', 'Code view height: ' + { low: 'low', half: 'half', full: 'full' }[dockState.sheet] + '. Click to change, or drag.');
    // The minimized panel's button is just above the timeline, not over its next button.
    var tlh = phone && dockShown() ? timelineEl.offsetHeight : 0;
    pill.style.bottom = tlh > 0 ? Math.round(tlh + 10) + 'px' : '';
  }
  function setSheetSize(size) {
    dockState.sheet = SHEET_SIZES.indexOf(size) >= 0 ? size : 'half';
    storageSet('localStorage', 'editlens.dockSheet', dockState.sheet === 'half' ? null : dockState.sheet);
    renderDock();
  }
  // The drag handle: a click goes to the next height; a drag picks the nearest one.
  dockGrab.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault();
    var y0 = e.clientY;
    var h0 = dock.getBoundingClientRect().height;
    var moved = false;
    dockGrab.setPointerCapture(e.pointerId);
    function move(ev) {
      if (!moved && Math.abs(ev.clientY - y0) < 6) return;
      moved = true;
      dock.style.setProperty('--sheet-h', Math.round(clamp(h0 - (ev.clientY - y0), 120, window.innerHeight - 24)) + 'px');
    }
    function up(ev) {
      dockGrab.removeEventListener('pointermove', move);
      dockGrab.removeEventListener('pointerup', up);
      dockGrab.removeEventListener('pointercancel', up);
      if (!moved) return setSheetSize(SHEET_SIZES[(SHEET_SIZES.indexOf(dockState.sheet) + 1) % SHEET_SIZES.length]);
      var frac = dock.getBoundingClientRect().height / Math.max(1, window.innerHeight);
      setSheetSize(ev.type === 'pointercancel' ? dockState.sheet : frac < 0.46 ? 'low' : frac < 0.79 ? 'half' : 'full');
    }
    dockGrab.addEventListener('pointermove', move);
    dockGrab.addEventListener('pointerup', up);
    dockGrab.addEventListener('pointercancel', up);
  });
  dockGrab.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    var i = SHEET_SIZES.indexOf(dockState.sheet) + (e.key === 'ArrowUp' ? 1 : -1);
    setSheetSize(SHEET_SIZES[clamp(i, 0, SHEET_SIZES.length - 1)]);
  });
  // Narrow (below about 560 px): the sidebar moves into the file button's sheet.
  function sizeDock() {
    var w = dock.clientWidth;
    if (!Number.isFinite(w) || w <= 0) return;
    var narrow = w < 560;
    if (narrow === dockNarrow()) return;
    dock.classList.toggle('narrow', narrow);
    if (!narrow && sheet.kind === 'side') closeDockSheet(true);
    renderSideState();
  }

  // ---------- start ----------
  dockHead.insertBefore(el('span', { class: 'dbr' }), dockPqBadge);
  layoutButton.classList.add('dlay');
  dockLayoutButton.classList.add('dview');
  pauseButton.classList.add('cplay');
  panesEl.appendChild(dropZone);
  dropZone.addEventListener('dragover', function (e) {
    if (!tabDrag) return;
    e.preventDefault();
    dropZone.classList.add('over');
  });
  dropZone.addEventListener('dragleave', function () { dropZone.classList.remove('over'); });
  dropZone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropZone.classList.remove('over');
    if (tabDrag && files[tabDrag]) moveFile(files[tabDrag], 'new');
  });
  dockPqBadge.addEventListener('click', function () { setPqOpen(true); });
  dockLayoutButton.addEventListener('click', function () { openViewMenu(dockLayoutButton); });
  groups.push(makeGroup());
