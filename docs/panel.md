# The panel

The EditLens panel shows Claude's work on your page: the chat, each edit, and the code behind it.

## What the panel shows

- **Edits are highlighted where they appear.** Each time Claude edits a file, the elements that changed on
  the page are highlighted with a label like `App.jsx:27`.
- **Live chat.** Claude's replies, its tool steps and your prompts show live in a panel on the page.
  You can also type messages to Claude there.
- **Subagents.** Each subagent Claude starts gets a card showing its steps live and its result.
- **Backend edits.** Server code changes are tagged API, with the routes they touch. When this page
  calls one of those routes, the elements that route filled are highlighted in blue.
- **Claude can highlight.** Claude has a `highlight_on_page` tool that draws a dashed outline with a note
  on any element, in a different color from edit highlights.
- **Split screen with the code view.** The code Claude edits opens next to your page, and each edit is shown
  line by line: removed lines strike through, new lines are typed out. Frontend and backend files are shown
  side by side. Claude can open files there itself with `show_code`, marking the lines it is talking about.
- **Replay.** Every edit stays in the code view's Edits list, by request, and on the timeline under
  the code. Replay one, or step through them with ← and →, and the page highlights each edit's
  elements again.

![Split screen: the page, the chat panel, and server.js with Claude's edit](screenshots/dock-light-6-tabs-with-panel.png)

| An edit shown line by line | Frontend and backend side by side |
| --- | --- |
| ![An edit shown line by line](screenshots/dock-dark-2-typing.png) | ![Two files split](screenshots/dock-dark-4-split-done.png) |

The panel follows your light or dark setting and works well with Windows fonts (Segoe UI, Cascadia, Consolas)
as well as macOS. **More** (`…`) changes its text size and colors (More › Settings).

| Dark | Light |
| --- | --- |
| ![Panel in dark mode](screenshots/panel-dark.png) | ![Panel in light mode](screenshots/panel-light.png) |

Two rings in the header show **context** (teal: how full Claude's context window is) and **session**
(pink: your plan's 5-hour usage limit). Click them for details: tokens by kind, model, effort,
turns, tool calls, subagents, compactions, duration and cost.

- Context and session totals come from the session transcript. The window is your auto-compact
  window when you set one (`/autocompact`, or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`), because Claude
  compacts there. Otherwise it comes from Claude Code when it reports it, or from the model you chose
  (a model ending in `[1m]` has a 1M window), or it is 1M once the session has gone past 200K. When
  none of these is known, no window is shown. The details card says which of these it used.
- Plan limits and exact cost are only given to a Claude Code *status line*, which a plugin can't
  set. `/editlens usage` prints the line to add to your `~/.claude/settings.json` (and how to keep
  a status line you already have). EditLens never edits that file. Plan limits are your account's,
  so one terminal session's status line also gives them to page control and the desktop app's
  sessions (which run no status line). Without it, the session ring
  stays dashed and shows tokens used, never a made-up limit. The line itself reads
  `Opus 5.5  context ━━━━────── 41%  ·  5h 23%  ·  ✦ live` (`✦ live` is green while a page of the
  project is open).

| Transcript only | With Claude Code's status line |
| --- | --- |
| ![Usage details from the transcript](screenshots/usage-light-1-transcript.png) | ![Usage details with plan limits](screenshots/usage-dark-2-status-line.png) |

**Commands from the page.** Press `Ctrl+K` in the panel, `Alt+Shift+K` anywhere on the page, or type
`/` in an empty message box to open the command palette. It lists your project's and your own custom
commands and skills, the ones from installed plugins, and Claude Code's built-in commands.

- **Claude runs it:** custom commands and skills go to Claude like a page message, and Claude runs
  them with its Skill tool when it reads the message. Add arguments after a space: `ship staging`.
- **Copy:** built-in commands such as `/compact`, `/clear` and `/model` can only be typed in Claude
  Code itself, so the palette copies them for you to paste there. So do commands marked
  `disable-model-invocation`.

![The command palette](screenshots/palette-dark-1-open.png)

**Files in Claude's replies are clickable.** Markdown links like `[App.jsx](src/App.jsx)`, inline-code
paths like `` `src/pages` ``, and `src/App.jsx:4-9` in plain text open in the code view, scrolled to
and marking those lines. A folder opens a list of its files, and a name that matches more than one
file asks which one. Paths can be relative to Claude's folder or its parent, absolute, or Windows
style. Web links open in a new tab, and text inside fenced code blocks stays plain. Only files inside
the folders Claude Code works in are shown. Hidden files (`.env`, `.git`), key and secrets files,
binaries and files over 512 KB are refused with a short reason.

![A file:line reference opened in the code view](screenshots/fileref-dark-1-lines.png)

![Claude highlighting the most expensive menu item, with the chat panel](screenshots/chat-04-claude-points.png)

| Subagents shown live | Backend edit, plus a message sent from the page |
| --- | --- |
| ![Subagent card](screenshots/chat-01-subagent.png) | ![Backend edit card](screenshots/chat-02-backend-edit-and-message.png) |

![A new stat card highlighted after Claude adds it](screenshots/vite-1-new-stat.png)

| Static HTML page | Vite + React with HMR |
| --- | --- |
| ![Menu item added](screenshots/static-3-menu-item.png) | ![Activity list replaced](screenshots/vite-3-activity-list.png) |
| ![CSS change on the button](screenshots/static-2-css-button.png) | ![Grid changed to four columns](screenshots/vite-2-grid.png) |

## Use the panel

Claude already knows EditLens: the plugin's **editlens-guide** skill explains the commands, pairing,
tasks on a paired computer and subagent copies, and each session is told about it. You can just
ask in plain words. (In the Claude desktop app, `/editlens ...` may be sent to Claude as a request
instead of running by itself: Claude then runs the same command for you, once.) Some ready-made prompts:

| You want | Ask Claude |
| --- | --- |
| The basics | `What can EditLens do here, and which /editlens commands should I use?` |
| See the page | `Connect my page with EditLens and tell me its address.` |
| Show something | `Highlight the signup form on the page and open its code in the code view.` |
| Pair a VPS | `Help me pair this laptop with my VPS through EditLens. Tell me exactly what to type on each computer.` |
| Work on the VPS | `On the VPS, <task>. Wait for it to finish, then show me the diff and merge it if the tests pass.` |
| Check VPS work | `What are my tasks on the VPS doing? Show the last reply of each.` |
| Parallel agents | `Split this into two subagents working in their own copies, then merge their changes.` |
| Merge copies | `List the subagent copies with changes and merge the ones that merge without conflicts.` |

- `Alt+Shift+C` opens or minimizes the panel. Your choice is remembered.
  The Alt+Shift keys do nothing while you type in your page's own text fields (on a Mac, Option+Shift+letter types a character there). On Windows, pressing Alt+Shift alone switches the keyboard layout if you have two layouts; press the letter together with Alt+Shift.
- Type in the box at the bottom and press Enter to message Claude. Shift+Enter adds a new line.
- The header has only the main buttons: **Select** (the arrow), **Code view**, **Full screen**,
  **More** (`…`) and minimize. Everything else is under More: **Settings**, text size, page
  highlights, **Wait** (whether Claude waits for your messages after it finishes; while it is on, a
  Wait button also shows in the header), where the panel is, and the quick tour.
- The **Agents** and **Team** tabs appear once Claude starts a subagent.
- The **full screen** button (four corners) fills the screen with the panel, or with the code view
  from its View menu (`⋯`) or its sidebar strip, docked or popped out. Esc or the button again leaves full screen. Where a browser
  doesn't allow full screen (Picture-in-Picture windows), the window grows to the whole screen.
- Most of the panel is left for the conversation: what Claude is doing shows as a line under the
  title, the page control bar is one thin line, and the hint under the message box shows while you
  type. On a short window the header gets smaller.
- **Alt+Shift+P** selects things on the page to show Claude ([Select things on the page](pick-box.md)).
- The **All · Chat · Edits** tabs (and **Agents** once there are subagents) filter the timeline, and **Team** shows the team board. The Agents tab counts the subagents running now and lists them as small buttons at the top. On the Team tab, one button per open claim; click it to go to the claim in the list.
- Click an edit card to see its diff. Its elements on the page get a steady **teal** outline that
  stays until you close the card, pick another one, press **Esc** or click **Clear** in the bar at the
  bottom left. **Show** scrolls to them, makes the outline blink (also when it is already on
  screen) and opens that part of the code in the code view; with several elements each click goes to the next one ("showing 2 of 3"), and an element
  under the panel shows through it for a moment. Replaying an edit, or selecting lines in the code view, does
  the same. For a stylesheet, the elements are the ones the edited rule's selectors match (inside
  `@media` too). When none are on this page but another page shows them, the button reads
  **Go to page** and takes you there. When no page is known, it reads **Open code** and shows that
  code in the code view instead. The outline follows the elements when you scroll or the app redraws the page.
  The code view marks the whole part until you pick something else. In a narrow window Show stays on
  the page and a **Code** button opens the code.
- **Changes** in that bar lists every change this session, newest first. Click one to outline it on
  the page and open its code, marked.
  Colors on the page: orange = a new edit, blue = an API change, teal = what you selected,
  dashed = Claude highlighting. Click one of Claude's highlight cards to show that highlight again.
- If a change is off screen, a "Claude changed something below" button scrolls to it.
- **Code on hover.** Hover over a part of the page Claude changed and, after a moment, a card beside it
  shows that change: old lines in red, new lines in green, with the words that changed marked. It
  names the file and line, which agent made it (and which Claude, when there are several) and when,
  with **Open in code view**, **Replay** and **Restore**. Click the card to keep it open; Esc or a
  click elsewhere closes it. It never covers the part it explains, stays on screen in a narrow window,
  and doesn't cover the code view.
  - New code says **New** and shows only the added lines. A part Claude removed leaves a dashed
    **Removed** outline where it was for two minutes; hover it to see the removed code.
  - A stylesheet change shows the rule and how many elements on this page it affects.
  - Several changes to the same part: **‹ 1 of 3 ›** steps through them, newest first.
  - A part matched only by a nearby source line says **nearby**. Long changes scroll inside the card.
  - After a backend change reloads the page, the message at the bottom has **Show code**.
  - Turn it off with the **Show code on hover** setting, or More › Show code on hover.
- The **</>** button opens the split-screen code view. It also opens by itself when Claude edits or opens
  a file. If you close it, it stays closed until your next request (from Claude Code or the panel).
  Drag its left edge to resize it; the page moves aside to leave space for it.
  - **The header**, left to right: the sidebar button, the file button (the file's name in bold, its
    folder dim; click it for the file menu), the **Follow** label, the play controls (play or pause,
    next, and "Edit 4 of 12"), and **View** (`⋯`).
  - **The sidebar** has three tabs. **Edits** lists this session's edits under the request that made
    them; "Waiting to play" groups the ones not played yet (**Show all now** plays them immediately), and
    edits made while the page was closed are shown first. **Earlier requests** shows older ones. **Files**
    lists the open files and the project's folders. **Agents** is the [Agents switcher](subagents.md#agents-switcher). Click
    the sidebar button or press **Alt+Shift+B** to hide it: a thin strip stays with Edits (it counts
    the waiting edits), Files, Agents, **Select** and **Full screen**. In a narrow code view the file
    button opens the sidebar as a sheet instead.
  - **The file menu** (click the file name): Open in VS Code, Copy path, Copy code, **Restore…**
    (puts the file back as it was before this request), **Undo only this edit**, **Open in a split**
    and Close.
  - **Tabs and splits.** Each pane has its own row of tabs. Clicking a tab shows it in its own pane.
    A file you open (from the sidebar, an edit, the file menu or the page) goes to the pane you last
    clicked, which has a thin blue line over its tabs. Claude's edits go to the pane marked **Edits
    play here** (the first one unless you pick another). A file already open is selected where it
    is. Drag a tab to another pane or use **Open in a split** to move it; drag the line between panes
    to resize them. The panes are kept when the page reloads.
  - **The change bar** is above each change: its number (hover for who made it), why, who and
    when, **Restore**, **Undo only this edit**, and ‹ › for the older and newer change in this file. Long runs of lines that didn't change
    are hidden as "Lines 12–80 unchanged"; click to open them. Marks on the right edge show where the
    changes are.
  - **The timeline** at the bottom has a tick per edit (faded while waiting to play). Click or drag
    to go to an edit; the speed button at its end sets 0.5× to 4×.
  - **Keys**, while the code view has focus: ← and → go to the previous and next edit, Space plays or
    pauses, Esc closes a menu or leaves full screen.
  - **View** (`⋯`): Wrap long lines (on unless you turn it off), text size, speed, position
    (side, bottom, floating, its own window, full screen, collapsed to a narrow bar), Reset, the quick
    tour and Settings. In full screen and in its own window, Settings opens as a sheet inside the code
    view, not behind it.
  - Docked to a side, the arrow tab sticking out from its edge (or **Alt+Shift+D**) collapses it to a
    narrow bar on that edge, and the page gets its full width back. Click the bar or the arrow, or press
    Alt+Shift+D again, to expand it. The narrow bar keeps pause, next, speed, **Select**, **Full
    screen**, View and close.
  - Every close button (×) is red, in the light and dark themes. The bar counts the edits made while it was collapsed. It stays collapsed (also after
    a reload) until the first edit of your next request opens it again; turn that off with the
    **Expand the code view for new requests** setting.
  - The **Follow** label picks whose code you watch. **Everyone** plays every edit (the default).
    **Follow the latest edit** also opens the files any agent reads, at the lines it reads. **Main** or
    a subagent (by name and color) shows only that agent's reads and edits. **Show only this agent's
    edits** does the same in the panel. The **Follow** button on a subagent card in the panel does the
    same. Each pane names the agent it is showing once subagents are running.
  - While you follow an agent, the page follows it too. It goes to the page that shows the file the agent
    is reading or editing, scrolls to the part written on those lines, and outlines it in the agent's
    color. If that part only appears after a click on a tab or a link to another page of your app, that
    click is made for you. Other buttons, also in a menu or navigation bar, are never clicked for you.
    - Which page shows a file is learned as you use your app: the files on each page (tagged by the Vite
      plugin) and the link or tab you clicked to make them appear. Pages you haven't opened yet are
      found from the project's routes (React Router, Vue Router, and Next.js `app/` and `pages/`).
    - Moving to another page uses a link on the page or your app's router, so the app doesn't reload.
      Sites without a router load the new page.
    - **The page follows** in the Follow menu pauses it (click again to resume). It also waits while
      you are scrolling, clicking or typing on the page, and moves at most every 1.5 seconds.
    - A stylesheet like `app.css` or `index.css` styles every page, so the page stays where it is and the
      elements the changed rules style are outlined. If nothing on this page uses those rules, a line
      under the header says so. Only a CSS module (`*.module.css`) can move the page to its component.
    - App-wide files (`main.jsx`, `index`, `layout`) and files no page draws (server code, JSON) leave
      the page where it is. When no page is known yet for a page file, a line under the header says so.
    - Once edits come from more than one Claude (page control and the Claude Code window, or two
      Claude Code windows on the same project), each edit card says which one made it.
  - When Claude is faster than the playback, edits wait in order; **Show all now** shows them all
    immediately. Edit cards in the panel also have a **Replay** button.
- Opening `http://127.0.0.1:4317/` shows the feed on its own page.

## The EditLens window

**Allow** and **Always allow** never happen on your app's page. The page is code Claude edits, so
anything a page can click, Claude could click too by adding a line to the site. Instead:

- **Allow…** on a card (or in the permissions list) opens a small **EditLens window**. It lists every
  question that waits; click **Allow**, **Always allow** or **Deny** there. It closes itself when
  nothing is left. **Deny** also works right on the card.
- Turning on a less strict mode from the panel (**Accept edits**, **Bypass permissions**) asks in the same
  window.
- The window is a page of EditLens's own address, not your app's. Your app's code can open it but
  can't read it, click in it or put it in a frame, and its buttons wait a moment after it appears so
  a click meant for the page behind can't click Allow by mistake.
- If the window doesn't open, allow pop-ups for your app's page (or open `http://127.0.0.1:4317/answer`).

## Permission questions in one place

When anything waits for your answer, a round **permissions button** with a count appears in the
top corner of the page and is highlighted. Click it for one list of every question, oldest first, each
labelled with who asks: Claude or a subagent (**✦**), in page control or in Claude Code, and tasks
from a paired computer (**◆ name**). It is hidden when nothing waits.

- **Page control and paired-computer tasks:** **Deny** right there, or **Allow…** to answer in the
  EditLens window. **Show in panel** goes to the full card.
- **Claude Code's own questions** (the terminal or the desktop app) are listed so you see them, but
  you answer them in Claude Code. A page can't answer them on purpose: the page is the app Claude
  edits, so Claude could otherwise approve its own requests.
- There's no "Allow all". The highlight can be turned off (**Highlight when Claude waits for you**); it never
  moves when your system is set to reduce motion.

## Details inside Claude Code

EditLens also shows its status inside Claude Code itself, in the terminal and in the desktop app's
Code tab (Claude Code 2.1.287 or later; 2.1.286 in the desktop app):

- **A line above the prompt**, always one row:
  `✦ ● Page control · Auto   ◆ vps   Working   context ━━──────── 20%   Open  Manual  Details`.
  It shows questions waiting on the page first, then Page control or Manual, the paired computer,
  whether Claude is working, the context used, subagents and tokens. In a narrow window the least
  important parts are hidden instead of going to a second line. **Open** opens the page with the panel, **Manual** or
  **Page control** switches, and **Details** opens Details (with Disconnect and Settings). It is there as
  soon as Claude Code starts: EditLens starts its server then if it isn't running. If the server
  stops later, the line says `✕ Not running` with a **Start** button.
- **First start**: the first time ever, one line says to type `/editlens`. Later starts print nothing.
- **`/editlens details`** (or **Details**) opens a pane with all of it: the pages open, the context
  window (used, size, percent), tokens for Claude and for subagents, the cost when Claude Code reports
  it, and the agents: Main, its subagents and the tasks on paired computers, each with its status.
  Arrow keys pick one, and its details open under it (computer, model, effort, mode, when it
  started) with **Follow** (your page follows it) and **Stop** (tasks and running subagents).
  `/editlens agents` prints the same list, with the details of every working agent.
- **`/editlens sessions`** opens the Sessions list: page control's sessions and this project's tasks,
  this computer first, then one group per paired computer. Arrow keys pick one: its line says how it
  started, its model, effort, mode and start time, then `Continue here  claude --resume <id>` (the
  command that continues it in Claude Code; shown, never run, since it would replace this session),
  then **Open** (your page follows it), **Stop** (running ones) and **Rename** (the name is kept by
  EditLens and shows on the page, in Details and here). `/editlens stop <name>` stops a running one by
  that name. The panel has the same list (More › Sessions). The desktop app may not list these
  sessions.
- **Settings** opens the settings pane (see [Settings](settings.md)).
- **Hide line above prompt** in the pane, or `/editlens line`, turns the **Line above the prompt**
  setting off or on.
- Values that aren't known yet show `—`. The numbers come from the live server (`GET /summary`) as
  soon as they change; with nothing changing, Claude Code asks about twice a minute. In page control
  they're for the session the panel runs.
- This part, and the `/editlens` command itself, is a Claude Code mod (`hooks/mod.mjs`), which is
  why EditLens needs Claude Code 2.1.287 or later.

## Move the panels

- **Drag** the EditLens panel or the code view by its title to move it. A docked code view comes
  loose as a floating window. Drop a window near an edge to dock it: the code view docks left, right
  or at the bottom, and the panel moves to the nearest corner. A dashed outline shows where it will go.
- **Resize** a floating window from the grip in its corner. The panel in a corner resizes from its
  inner corner, and a docked code view from its inner edge.
- **More** (`…`) in the panel's title bar, and View (`⋯`) in the code view's header, have the same
  choices in a menu, plus:
  - **Pop out into its own window**, for a second monitor. Chrome and Edge open a Picture-in-Picture
    window that stays on top; other browsers open a pop-up (allow pop-ups for your site). Everything
    keeps working there: playback, replay, follow, rings, commands and links. Close the window, or
    pick **Back to the page**, to show it again. Reloading the page closes popped-out windows,
    because browsers only open new windows on a click.
  - **Full screen**, the same as the full screen button.
  - **Reset layout** puts both panels back where they started.
- Positions and sizes are remembered for each site. After the window shrinks or moves to another
  monitor, the panels move back on screen.
