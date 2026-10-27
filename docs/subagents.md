# Subagents

EditLens shows each subagent Claude starts, can run it in its own copy of the project, and gives the agents a shared team board.

## Agents switcher

When Claude starts subagents, a small **Agents** window appears beside the panel (while the code view
is open, the same list is its sidebar's **Agents** tab). It is one place to switch between agents:

- One row per agent: Main first, then pinned ones, then the running ones and those that just
  finished. Each row shows the agent's color, name, permission mode, what it is doing now, its file
  and how long it has run.
- Under each row, one line says its status (Working, Waiting for permission, Idle, Done, Failed), model,
  tool calls and files changed. **Details** opens everything known about it: status, type, model,
  permission mode, how long it has run, what it is doing now, its current file and lines, tool calls,
  files changed with the number of edits each, tokens (context and output, or the total once it
  finishes), its open Team board claims, its task, and its last message or result. Main shows its
  context and session tokens, this turn's time and its last reply. Anything not known shows "—".
- **Click a row** to switch to that agent: the code view and the page follow its work. The row then
  shows its actions: **Open file**, **Show on page**, **Only this** (the panel shows only that
  agent's messages and edits), **Team posts** (its claims, notes and findings), **Mode** (its
  permission mode), **Stop** (page control only: stops that subagent alone, after a second click;
  Claude continues), **Pin** (keeps it listed after it finishes) and **Copy summary**.
- **Collapse** it to a small button with the running count by clicking its header (or Esc in the list).
- **Keys**: Alt+Shift+A opens and closes it (the Agents tab, in the code view); Alt+Shift+] and Alt+Shift+[ switch to the next and
  previous agent from anywhere; in the list, the arrow keys move and Enter switches.
- **Where it is**: beside the panel's inner edge (narrower if space is short, above the panel in a
  narrow window), or the page's bottom-left corner when the panel is popped out or minimized. Drag
  its header to move it; dropped near an edge, it moves to that edge. Its place is remembered with the layout;
  double-click the header, or **Reset layout**, to put it back beside the panel. It hides itself
  while there are no subagents. Moved to the top half of the window it opens downward, in the
  bottom half upward, and it always stays inside the window (also when the window shrinks or a saved
  place is off screen), with the list scrolling inside. The panel and the floating code view do the
  same: their title bars never leave the window.

## Subagents in their own copy

Subagents that work at the same time as Claude (or each other) can overwrite each other's edits.
In a git project, EditLens gives each subagent that can edit files its own copy of the project: a
git worktree, made by Claude Code itself, in `.claude/worktrees/`. Read-only subagents (Explore,
Plan, claude-code-guide, statusline-setup, output-style-setup) get none, and so does a call that sets its own
`isolation` or `cwd`. There is no copy either when the project has no commit yet, when Claude itself already works
in a copy, or when git needs more than 2 seconds (the hooks log then says why). Turn it off with
**Subagents work in their own copy** in `/config`.

- **While it works**, its edits show in the panel with a dashed border and "In its own copy". They
  aren't on your page yet, so nothing is highlighted there.
- **When it finishes**, a **copy** card lists each file it changed: **Changed**, **New**,
  **Deleted**, **Merges with your edits** (you changed other lines of the same file),
  **Both changed** (you both changed the same lines) or **Already in your project**.
- **Merge** copies into your project every file that merges without conflicts. Each one shows as an edit on the page, with
  **Restore**. A file you both changed is never merged by itself: **Use its version** takes the
  copy's file, and Restore puts yours back.
- Claude Code configuration and keys a subagent wrote in its copy (`.claude/`, `.mcp.json`, `.env`
  files, key files) are never merged: the card lists them as **Not merged**, and you copy them
  manually if you want them, so an agent can't add hooks, MCP servers or permission rules to your project.
- **Remove copy** deletes the copy and its branch, after you confirm. Claude is also told about
  the copy and often merges it itself; the card then says everything is already in.
- **Without git** (or with the setting off), subagents share the folder. When two agents edit the
  same file within 10 minutes, the second edit's card says so in red.

You don't need Bypass permissions for any of this: subagents run in Claude's mode (Auto by
default).

## Team board

When Claude starts subagents, they share one board with Claude and with each other. The **Team**
tab shows it live, with each agent in its own color and named by the task Claude gave it.

- Agents **claim** a part of the work and the files it touches before they start. If another agent
  already claimed those files, the claim is refused and the agent is told who has it.
- They **share findings** (a file, lines and a note). Click one to open those lines in the code view.
- They post **notes**: decisions, questions, answers and problems that stop them.
- When a subagent finishes, its summary appears, and any claim it left open is released.
- **Clear** starts a new board. Boards are saved per project in `~/.claude/editlens/boards/`
  and stay after restarts. A board not used for 90 days is deleted.

How it works: the board tools come from the plugin's MCP server, which subagents also get. The
plugin's `SubagentStart` hook tells each subagent its name and how to use the board. Its
`PreToolUse` hook reports which agent makes each board call, so entries are tagged by Claude Code
itself rather than by what an agent says about itself. The `team-board` skill tells the main agent how to split
work. Set `EDITLENS_TEAM=off` to turn the board instructions and entries off.

A custom subagent whose `tools` list leaves out the board tools can't post; it still shows as
joined and finished.

Script tag options:

| Attribute | Default | Meaning |
| --- | --- | --- |
| `data-panel` | remembered, else `open` | `open`, `min` or `hidden` |
| `data-reload` | `auto` | For pages without hot reload: `auto`, `morph` (never full reload), `full`, or `off` |
| `data-root` | none (Vite, the proxy and the middleware set it) | Your project folder. Needed to send messages, open files, restore and take page control. A drive, filesystem root or your home folder is ignored |
| `data-theme` | follows the page's theme, else the system | `light` or `dark` |
| `data-settle` | `600` | Milliseconds to wait for the page to update before highlighting |

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `EDITLENS_PORT` | `4317` | Server port |
| `EDITLENS_PAIR_PORT` | `4318` | Port another computer pairs with (open only while pairing: `/editlens pair`) |
| `EDITLENS_ORIGINS` | none | Extra page origins allowed to connect, comma separated |
| `EDITLENS_IDLE_MINUTES` | `120` | Server stops after this long with no events and no pages (never while a pairing exists) |
| `EDITLENS_WAIT_MINUTES` | `5` | How long Claude waits for a page message after a turn (0 turns it off, max 59, because the Stop hook may run for an hour at most) |
| `EDITLENS_TEAM` | on | Set to `off` to stop telling subagents about the team board |
| `EDITLENS_DISABLE` | unset | Set to `1` to turn the hooks off |
| `EDITLENS_DEBUG` | unset | Set to `1` to log each hook's input to `~/.claude/editlens/hooks.log`: names, ids and paths; other text as its length only |
| `EDITLENS_STEADY_PORTS` | on | Set to `off` so a project's EditLens address takes any free port instead of the same one (4400–4899) each time; `npm test` does this |
