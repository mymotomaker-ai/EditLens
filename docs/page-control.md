# Page control

With page control, the panel works as a full Claude window.

Normally the panel shows a Claude Code session, and messages typed there wait for Claude's next
turn. With page control, Claude runs from the panel itself, so every message starts it immediately,
even when Claude Code is idle, stopped or closed.

- **On by default.** Each Claude Code session (and the desktop app when it resumes one) turns page
  control on by itself as soon as your page opens, however late. Nothing starts until then, and
  never your dev server or a paired computer's page. The first time, it sets up the Claude Agent SDK
  then (`@anthropic-ai/claude-agent-sdk`, made by Anthropic, from registry.npmjs.org or your own
  npm registry setting; about 30 MB, no install scripts run; the page shows it). After an update or a restart it
  continues its earlier page conversation. **`/editlens control`** does the same immediately: it connects
  your page if it isn't, opens it in your browser and waits for it. Set **What /editlens does** to
  **Connect the page** to keep Manual, or run `/editlens manual` (or click Manual on the page).
- Claude starts on a **copy** of
  your current conversation, so the conversation in Claude Code or the desktop app is never
  changed. This is the best way to start: Claude already knows your app from the conversation.
  `/editlens control new` starts a new conversation that knows nothing about it yet.
- **One project at a time.** Claude runs from the page in one project at a time. When it runs in
  another project and nobody uses it there (no page of that project is open, and Claude is not in the
  middle of a reply or waiting for an answer), `/editlens control` switches it to Manual there and
  starts it here. Otherwise it says where it runs, and `/editlens control take` moves it: that
  project's page switches to Manual and says so, and a reply in progress there stops (as Manual
  does). Only a command you type moves it: opening a page or Claude never does.
- **Claude works inside your running app.** Page control tells Claude that the app is already running
  on the page: read a file before changing it, add to what's there, add new pages next to the existing
  ones, and never remove EditLens or change the dev server's host and port.
- The panel shows **Page control**. Type and send: Claude starts immediately. While Claude works, the
  Send button turns into **Stop** (Esc does the same); typing a message turns it back into Send.
  **Manual**, under the message box, or `/editlens manual`, switches back to manual control: you control
  Claude in Claude Code again, and the page again only shows the session.
- **API key (recommended).** Page control runs Claude through the Claude Agent SDK, and an API key
  is the recommended way to sign in tools built on it. Set `ANTHROPIC_API_KEY` on your computer and
  run `/editlens control` again: Claude then uses that key.
- **Or sign in.** Without a key, the panel says **Claude needs you to sign in once**:
  - **Sign in with Anthropic Console** runs Claude's own sign-in (`claude auth login`) with
    pay-per-use API billing. It opens your browser; finish there and Claude starts by itself. A
    message you typed meanwhile is sent then.
  - **Sign in** does the same with your Claude plan (Pro, Max, Team or Enterprise).
  - If the browser doesn't open, the panel links to the sign-in page. If that page shows a code, paste
    it into the panel.
  - The login is saved by Claude itself, the same way `/login` saves it. EditLens only asks Claude
    whether it is signed in (`claude auth status`) and never sees or stores the login. If a login expires
    later ("Please run /login"), the panel asks again.
- Claude uses your own login and permission settings. Anything they would ask you about appears in
  the panel as a card: **Allow…** (in the [EditLens window](panel.md#the-editlens-window)) or **Deny**. A question nobody
  answers is denied after 10 minutes.
- **Permission mode**, like Shift+Tab in Claude Code. The button under the message box shows Claude's
  mode; click it to pick **Ask**, **Accept edits**, **Plan**, **Auto** or **Don't ask** (**Accept
  edits** is confirmed in the EditLens window), or press Alt+M in the message box (Shift+Tab stays the key that moves focus back) to step
  through **Ask**, **Plan** and **Auto**. It starts in **Auto** (change the default with `/config` in Claude Code); until
  Claude's first reply the button reads "Choose mode".
  - **Bypass permissions** is in the menu, in red, and only turns on once you confirm it in the
    EditLens window, which says what it means. Alt+M never selects it, and page control never starts in it: if your settings start
    Claude in Bypass permissions, the panel switches it to your default mode and says why. Claude
    Code refuses Bypass permissions when it runs as root (common on a VPS), so there it isn't offered.
- If page control stops (for example Claude can't start), the access badge turns red, reads
  **Page control stopped** and says why, in the panel and on Claude Code's EditLens line.
  - **Subagents** follow Claude's mode, so they run in Auto too. To give one a mode of its own, click the mode on its card in the
    Agents tab and pick **Ask**, **Accept edits**, **Plan** or **Bypass permissions** (or **Same as
    Claude** to use Claude's mode again). For example, Claude can accept edits while one subagent still asks, or
    another can only plan. Its row in the code view's Follow menu shows the mode too. A permission card
    says which subagent asks.
  - In **Plan** (Claude's mode or a subagent's) and in a subagent's own **Ask**, EditLens's own tools are limited to
    the ones that change nothing: listing pages and paired computers, the code view, highlights, the team board,
    and reading a task on a paired computer. Starting, messaging, stopping, merging, applying or copying is
    refused with a plain reason. A subagent in Plan or Ask can still hand its report back to Claude. Under page control, the tools that change nothing never ask, in any mode.
  - In Manual, the button and the cards show the mode Claude Code reports through its hooks, read-only:
    a page can't change the mode of a Claude Code window. Change it there with Shift+Tab.
- **Safety check.** A write that would replace most of an existing file (more than half of its lines
  gone, for files of 12 lines or more), or any change that takes EditLens out of `vite.config`,
  `next.config`, `index.html` or your server file, always asks first, in every mode, Bypass
  permissions included, and for subagents too. The card says what would be lost and has no
  **Always allow**. The same check runs in Claude Code windows (Manual), where Claude Code asks you.
  Set `EDITLENS_GUARD=off` to turn it off.
- **Restore.** Every edit card for a file that existed before has a **Restore** button. It asks first,
  then puts the file back as it was before that edit (later changes to it are undone too). The file
  as it was just before the restore is kept as well, so **Undo** in the message that follows puts it
  forward again. The earlier versions are kept in `~/.claude/editlens/backups` (the latest 200,
  up to 60 MB), so this still works after a restart. A file Claude created has **Remove file** instead.
  When the file as it is now is over 2 MB or not a text file, no copy of it can be kept for Undo.
  The card says so and asks first; only **Restore without Undo** then changes the file. Remove file
  and putting an edit back ask the same way. The same goes for Restore from the laptop through the
  pairing link, and `/editlens undo` / `restore` in the terminal refuse it and say why.
- Live edits, the code view, replay, usage, file links, selecting and the team board all work as usual.
  The command palette lists the commands the page-controlled session supports, built-ins included, and
  sends them.
- Only the project's page tabs that are open when page control starts get control (a tab you reload keeps
  it, and a tab you open later gets it when no tab that has it is still open). They get a random key over
  their own connection, and every request must include it. Other tabs only show the session.
- **What it installs.** The first time page control turns on (by itself or with `/editlens control`), it runs `npm install` to put the Claude Agent SDK
  (`@anthropic-ai/claude-agent-sdk`, made by Anthropic, a fixed version, downloaded from
  registry.npmjs.org or the registry your npm is set to use) into `~/.claude/editlens/sdk` (about 30 MB),
  outside your project. Nothing else in EditLens installs packages. It runs the same `claude` program as your sessions, including the desktop app's copy on
  Windows: `/editlens control` looks it up each time and tells the live server where it is, because
  that copy isn't on PATH and moves when the app updates. If none is found, npm also installs
  Claude's own runtime (about 250 MB more). If neither works, it says so in plain words; setting
  `EDITLENS_CLAUDE_PATH` to the full path of `claude.exe` (or `claude`) always works.
