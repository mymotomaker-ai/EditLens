# Development

Tests and previews never use this computer's real setup (`test/isolate.js`): the `editlens` task
account is looked up in a test passwd file (`EDITLENS_TEST_PASSWD`), Claude Code's settings come
from an empty folder (`CLAUDE_CONFIG_DIR`), and the `claude` program is a stand-in. The `test/e2e-*.js`
scripts that run the real, signed-in Claude use this computer's Claude settings and `claude` program
only with `EDITLENS_E2E_REAL_CLAUDE=1`; their other setup stays isolated.

```bash
npm test                     # unit tests: diff, DOM hints, backend routes, Windows paths, server lifecycle, code snapshots, message state, token usage, commands, file references, team board, selection attachments, page control, safety check and restore, the summary for the details inside Claude Code, connect and disconnect
node server/server.js        # run the server in the foreground
node bin/stop.js             # stop a running server

# Panel design check without running Claude: a scripted session in light and dark, 100% and 200% scale
NODE_PATH=$(npm root -g) node test/preview.js <out-dir>
# Subagents in their own copy: the copy card, Merge, a conflict, Remove, the two-agent warning
NODE_PATH=$(npm root -g) node test/copies-preview.js <out-dir>
# Claude on a paired computer, the permissions button and the EditLens window: the task card, the list
# (a click by page code approves nothing; Allow… opens the window; Claude Code's own questions shown only),
# Allow in the window, the reply, the button going, Stop task
NODE_PATH=$(npm root -g) node test/tasks-preview.js <out-dir>
# Split-screen code view: scripted edits typed out, show_code, replay, tabs; light, dark and a video
NODE_PATH=$(npm root -g) node test/dock-preview.js <out-dir>
# Usage rings and details: from a transcript alone, then with status line numbers
NODE_PATH=$(npm root -g) node test/usage-preview.js <out-dir>
# Command palette: opened with /, searched, a built-in copied, a custom command sent
NODE_PATH=$(npm root -g) node test/palette-preview.js <out-dir>
# File references in a reply: file:line, folder, duplicate name, missing file
NODE_PATH=$(npm root -g) node test/fileref-preview.js <out-dir>

# Signing in for page control, with a fake claude and SDK (no real login): Sign in, the code field, the waiting message
NODE_PATH=$(npm root -g) node test/signin-preview.js <site-url> <site-dir> <out-dir>
# Permission modes in the panel, with a fake claude and SDK: Manual read-only, the menu, Alt+M, Bypass confirm, a subagent's own mode, 480px
NODE_PATH=$(npm root -g) node test/modes-preview.js <site-url> <site-dir> <out-dir>
# Permission modes with real Claude: Accept edits, a subagent switched to Ask is asked, a subagent in Plan can't write
EDITLENS_E2E_REAL_CLAUDE=1 EDITLENS_SDK_DIR=<sdk dir> node test/e2e-modes.js [claude-path]
# Settings: one declaration (plugin.json userConfig), checked values (no NaN or blanks), hooks and the mod reporting them, a page's change made through Claude Code
node --test test/settings.test.js
# Details and settings inside Claude Code (the mod): the line above the prompt, the Details and Settings panes, /editlens, server off
claude plugin test
# Then look at it in a real window: claude --plugin-dir . , open your page, run /editlens details
# Connect without project changes: a Vite project (panel, source lines, Disconnect) and a running Node app through an EditLens address
NODE_PATH=$(npm root -g) node test/e2e-connect.js <vite-project-dir> <other-project-dir> <other-url> <out-dir>
# Safety check with real Claude: in Accept edits a write that replaces most of a file still asks, with the reason; a normal edit doesn't
EDITLENS_E2E_REAL_CLAUDE=1 EDITLENS_SDK_DIR=<sdk dir> node test/e2e-guard.js [claude-path]
# Restore on an edit card: asks, puts the file back, Undo, Remove file instead for a new file, 480px
NODE_PATH=$(npm root -g) node test/restore-preview.js <site-url> <site-dir> <out-dir>
# Restore and Remove file over a file too large for an Undo copy: asks first, light, dark, 480px
NODE_PATH=$(npm root -g) node test/no-undo-preview.js <out-dir>
# Page control end-to-end: bin/drive.js, a message from the page, a permission answered, Manual
EDITLENS_E2E_REAL_CLAUDE=1 EDITLENS_SDK_DIR=<sdk dir> NODE_PATH=$(npm root -g) node test/e2e-drive.js <site-dir> <site-url> <out-dir> [session-id]
# The message box next to a pick: below, above, beside an area, Add and Enter never send, Esc, Shift+click, the setting, narrow, phone
NODE_PATH=$(npm root -g) node test/pickbox-preview.js <out-dir>
# Dictation with a stand-in speech API: first-use card, grey words, never sent, Esc, Send, Add, silence, no mic, online only, the setting
NODE_PATH=$(npm root -g) node test/dictation-preview.js <out-dir>
# Selecting: a running Vite + React app (examples/vite-react), hover, click, drag, code lines, Claude highlighting back
NODE_PATH=$(npm root -g) node test/point-preview.js <site-url> <site-dir> <out-dir>
# Selected stylesheet edits (rule selectors, Open code) and full, untrimmed text
NODE_PATH=$(npm root -g) node test/select-css-preview.js <site-url> <site-dir> <out-dir>
# Selected code: an edit card's outline lasts, follows a re-render and scrolling, Esc/Clear end it, code lines
NODE_PATH=$(npm root -g) node test/select-preview.js <site-url> <site-dir> <out-dir>
# Following one agent in the code view, and the split layout at small window sizes
NODE_PATH=$(npm root -g) node test/follow-preview.js <site-url> <site-dir> <out-dir>
# The page follows an agent: routes, a learned tab click, scrolling, pause, waiting, Go to page (examples/vite-router)
NODE_PATH=$(npm root -g) node test/page-follow-preview.js <site-url> <site-dir> <out-dir>
# Reading space and full screen: header, tabs, claims, narrow code view header, full screen docked and popped out
NODE_PATH=$(npm root -g) node test/space-preview.js <site-url> <site-dir> <out-dir>
# Agents switcher: rows, switching, actions, keys, drag/move to the edge/saved/Reset, minimized panel, Stop in page control, 480px
NODE_PATH=$(npm root -g) node test/agents-preview.js <site-url> <site-dir> <out-dir>
# Narrow windows (480px): replay header, Follow chips, tabs, docked and popped-out code view, panel tabs; flags letter-by-letter text and anything past the edge
NODE_PATH=$(npm root -g) node test/narrow-preview.js <site-url> <site-dir> <out-dir>
# Moving the panels: drag, move to the edge, dock left/bottom, resize, remembered, pop out, reset
NODE_PATH=$(npm root -g) node test/layout-preview.js <site-url> <site-dir> <out-dir>
# Team board end-to-end: Claude runs two subagents at the same time; screenshots the Team tab
EDITLENS_E2E_REAL_CLAUDE=1 NODE_PATH=$(npm root -g) node test/e2e-team.js <site-dir> <site-url> <out-dir>

# End-to-end: opens a page in Chromium, runs Claude Code with this plugin, screenshots each change
# (EDITLENS_E2E_PANEL=min makes the panel small first, so it covers less of the page)
EDITLENS_E2E_REAL_CLAUDE=1 NODE_PATH=$(npm root -g) node test/e2e-demo.js <site-dir> <site-url> <out-dir> "<prompt>"
# Chat, subagents, backend edits, page messages and selecting, on examples/fullstack
EDITLENS_E2E_REAL_CLAUDE=1 NODE_PATH=$(npm root -g) node test/e2e-chat.js <site-dir> <site-url> <out-dir>
```

`examples/static-site`, `examples/vite-react`, `examples/vite-router` and `examples/fullstack` (run it with
`node --watch server.js`) are the pages used for the screenshots.

Hooks never block Claude. Any failure is written to `~/.claude/editlens/hooks.log` and the
hook exits 0.
