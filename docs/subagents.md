# Subagents

A subagent is a second Claude that the main Claude starts to do part of the work at the same time. EditLens shows
each subagent, can give each one its own copy of the project, and gives all agents a shared team board.

## Agents switcher

When Claude starts subagents, a small **Agents** window appears beside the panel. While the code view is open, the
same list is in its sidebar, on the **Agents** tab. Use it to see and switch between agents.

**What each row shows:** the agent's color, name, permission mode, what it is doing now, its file, and how long it
has run. A second line shows its status (Working, Waiting for permission, Idle, Done, or Failed), model, tool
calls, and files changed. **Details** shows everything EditLens knows about the agent. A value that isn't known yet
shows "—".

**Select a row** to switch to that agent. The code view and the page then follow its work. The row shows these
buttons:

| Button | What it does |
| --- | --- |
| Open file | Opens the file the agent is working on |
| Show on page | Shows the agent's work on the page |
| Only this | Shows only this agent's messages and changes in the panel |
| Team posts | Shows what the agent wrote on the team board |
| Mode | Changes the agent's permission mode |
| Stop | Stops only this subagent, after a second click. Claude continues. Page control only |
| Pin | Keeps the agent in the list after it finishes |
| Copy summary | Copies a summary of the agent's work |

**Keys:** Alt+Shift+A opens or closes the list. Alt+Shift+] and Alt+Shift+[ switch to the next or previous agent.
In the list, use the arrow keys to move and Enter to switch.

**Make it smaller:** select its header, or press Esc in the list. It then shows only the number of running agents.

**Move it:** drag its header. Double-click the header, or select **Reset layout**, to put it back beside the
panel. It is hidden while there are no subagents.

## Subagents in their own copy

**Why:** subagents that work at the same time can change the same file and overwrite each other's changes.

In a git project, EditLens gives each subagent that can change files its own copy of the project. Git calls this a
worktree. Claude Code makes it in `.claude/worktrees/`.

A subagent gets no copy in these cases:

- It only reads files (Explore, Plan, claude-code-guide, statusline-setup, and output-style-setup).
- Its call sets its own `isolation` or `cwd`.
- The project has no commit yet, or Claude itself already works in a copy.
- Git takes more than 2 seconds. The hooks log then says why.

To turn copies off, use the **Subagents work in their own copy** setting in `/config`.

**While the subagent works,** its changes appear in the panel with a dashed border and "In its own copy". They
aren't on your page yet, so nothing is highlighted.

**When it finishes,** a **copy** card lists each file it changed:

| Label | Meaning |
| --- | --- |
| Changed | The subagent changed the file |
| New | The subagent created the file |
| Deleted | The subagent deleted the file |
| Merges with your edits | You changed other lines of the same file. The changes can be combined |
| Both changed | You both changed the same lines |
| Already in your project | Nothing to merge |
| Not merged | Claude Code settings and keys (`.claude/`, `.mcp.json`, `.env` files, key files). Copy them yourself if you want them |

- **Merge** copies every file that has no conflict into your project. Each file appears as a change on the page,
  with **Restore**.
- For a file you both changed, select **Use its version** to take the subagent's file. **Restore** puts yours back.
- **Remove copy** deletes the copy and its branch, after you confirm.
- Claude also knows about the copy and often merges it itself. The card then says everything is already in your
  project.

EditLens never merges Claude Code settings or keys from a copy, so a subagent can't add hooks, MCP servers, or
permission rules to your project.

**Without git,** or with the setting off, subagents share the project folder. When two agents change the same file
within 10 minutes, the second change's card says so in red.

You don't need Bypass permissions for any of this. Subagents use Claude's permission mode (Auto by default).

## Team board

**Why:** when several agents work at the same time, they need to know who does what. The team board is a shared
list where each agent writes what it is working on.

The **Team** tab shows the board as it changes. Each agent has its own color and is named by the task Claude gave
it.

- **Claims.** Before an agent starts, it claims a part of the work and the files it needs. If another agent already
  claimed those files, the claim is refused, and the agent is told who has them.
- **Findings.** An agent shares a file, lines, and a note. Select a finding to open those lines in the code view.
- **Notes.** Agents post decisions, questions, answers, and problems.
- When a subagent finishes, its summary appears, and its open claims are released.
- **Clear** starts a new board.

Boards are saved for each project in `~/.claude/editlens/boards/`, and stay after a restart. A board not used for
90 days is deleted.

A custom subagent whose `tools` list doesn't include the board tools can't post. It still shows as joined and
finished.

**How it works:** the board tools come from EditLens's MCP server, which subagents also get. The `SubagentStart`
hook tells each subagent its name and how to use the board. The `PreToolUse` hook reports which agent makes each
board call, so Claude Code itself tags each entry, not the agent. The `team-board` skill tells the main agent how to
split work. To turn the board off, set `EDITLENS_TEAM=off`.
