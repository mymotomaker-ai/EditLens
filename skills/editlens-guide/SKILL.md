---
name: editlens-guide
description: What EditLens is and how to use it - the /editlens commands, connecting a page, page control, pairing a laptop with a VPS, giving Claude on a paired computer tasks, subagent copies and Merge. Use whenever EditLens, the panel, pairing, a paired computer or VPS, remote tasks, page control or subagent copies are discussed.
---

# EditLens

EditLens is a Claude Code plugin. It shows your work live on the web page the user is building:

- **Edits are highlighted on the page** where they appear. Each edit is captioned with your last sentence
  before it, so say in one short sentence what you are about to change before each edit.
- **A panel on the page** shows your replies, tool steps and subagents live. The user can type to
  you there; you get those messages through the Stop hook or with their next prompt.
- **A code view** next to the page replays each edit line by line.
- It changes no project file to connect (it adds itself to Vite, serves other dev servers through its own address, or
  serves a plain site itself).
- Only the user's account can connect. On macOS and Windows a page needs the user's key: `/editlens`
  opens and prints the page's address with it after `#`, and the browser keeps it for that address.
  A page whose panel says "Open this page once from Claude Code: /editlens" needs that once.
- Python (Flask, FastAPI, Django): the user starts the server as usual (`flask run --debug`,
  `uvicorn main:app --reload`, `python manage.py runserver`) and runs `/editlens`; it finds 5000 or
  8000. To open the server's own address instead, the script tag goes in the base template between
  `<!-- editlens:start -->` and `<!-- editlens:end -->` lines, with `data-root` set to the project.

## Commands (the user types these; you can suggest them)

| Command | What it does |
| --- | --- |
| `/editlens` | Start EditLens, connect this project's page and print its address; also turns on page control when the setting "What /editlens does" says so (the default) |
| `/editlens 3000` or `/editlens http://localhost:3000` | Connect the dev server at that port or address |
| `/editlens <folder>` | Connect the app in that folder |
| `/editlens new` | A folder with no app yet: make a starter page (index.html) and connect it. Never replaces a file; refused in the home folder, system folders and folders full of other files |
| `/editlens stop` | Disconnect and end page control in this project (`stop remove` also removes EditLens lines marked in files) |
| `/editlens stop <name>` | Stop the running page control session or task with that name (as `/editlens sessions` lists it) |
| `/editlens control` / `/editlens manual` | Page control on (run Claude from the panel; also connects, opens and waits for the page) / back to Claude Code |
| `/editlens control take` | Page control runs in another project: end it there (its page switches to Manual, a reply in progress stops) and start it here |
| `/editlens undo` | This session's recent edits, numbered as on the page: undo one, or restore its file |
| `/editlens undo N` / `undo N back` | Undo only edit N, keeping later changes / put it back |
| `/editlens restore N` / `restore N back` | The whole file from before edit N (later changes to it are undone too) / undo the restore |
| `/editlens effort` / `effort <level>` | Claude's effort level: page control now, new tasks (the Effort setting), this terminal (read only: `/effort` changes it) and running tasks / set page control's level and the Effort setting (auto, low, medium, high, xhigh; auto, the default, follows Claude Code's `/effort`). `max` changes only the page control session running now and is never saved |
| `/editlens settings` | Settings (also in `/config`, search "editlens") |
| `/editlens status` | What is connected |
| `/editlens details` | Manual or page control, pages, agents and token use |
| `/editlens agents` | Every agent (Main, subagents, tasks on paired computers) and what each working one is doing |
| `/editlens sessions` | Page control's sessions and this project's tasks, here and on paired computers: open, stop or rename one, and the `claude --resume` command that continues it in Claude Code (shown, never run) |
| `/editlens usage` | The status line to add for exact context, cost and plan limits |
| `/editlens line` | Hide or show the EditLens line above the prompt |
| `/editlens restart` | Use the newest installed EditLens now (an update waits while page control runs), then do what `/editlens` does; page control that was running starts again |
| `/editlens help` / `help <command>` | The commands, grouped / more about one |
| `/editlens pair` | On the VPS: prints a one-time line to type on the laptop |
| `/editlens pair open` | On the VPS: the same, for a direct join without SSH (the user opens the pairing port in the firewall) |
| `/editlens join <user>@<address> <code> [--key "<path of your key file>"] [--ssh-port <n>]` | On the laptop: pair with the VPS (`--key`: the path of a key file ssh doesn't use by itself) |
| `/editlens join` / `join off [name]` | The paired computers / unpair |
| `/editlens control <name>` / `manual <name>` | Page control on that paired computer / back (`control <name> take`: move it there from another project) |
| `/editlens task-user` / `task-user status` / `task-user off` | On a root Linux server: paired computers' tasks run as a normal account (set up / check / remove; an account made manually is kept and only turned off) |

**Only the user may type** `/editlens new`, `/editlens join ...`, `/editlens control <name>`, `/editlens control take`, `/editlens task-user`, `/editlens effort <level>`, `/editlens stop <name>`, logins (`/login`)
and anything that opens a connection into another computer. Never run them for the user, never
ask for the pairing code, passwords or keys, and never bypass a blocked step: tell the user
the exact line to type and where (the laptop's Claude Code, or the VPS's).

**Page control is on by default.** Each session turns it on by itself when the project's page opens
(the first time, it installs the Claude Agent SDK then; `/editlens control` does it immediately); the
user's messages typed in the panel then go to the Claude running from the page. To keep Claude in
Claude Code: `/editlens manual`, or the setting "What /editlens does" = "Connect the page".

If the user wants the page connected, suggest `/editlens`. If it says there is no app in the folder and the user wants
to start a site, tell them they can type `/editlens new` (a starter page they then ask you to change). If it says it found a server but can't
tell it is this project's, the user clicks **Connect localhost:<port>** on the EditLens line or
types `/editlens <address>`.

**Notes on picks.** When the user selects something on the page, a small box opens next to it
for a note. Their message then has lines that start with a selection's number ("2 Make it green"):
each such line is about that selection. The box never sends; the user presses Send in the panel.

**Dictation.** The panel's message box and the pick box have a mic (Ctrl+Shift+Space): the browser
turns speech into text, on the computer by default (setting Dictation: On this device, Allow online,
Off). It never sends the message to Claude; with Allow online, the browser sends the audio to its maker
(Google for Chrome). The computer's own dictation works too (Win+H on Windows, Fn twice on a Mac).

## Pairing a laptop with a VPS

1. On the VPS, in Claude Code in the project: `/editlens pair`. It prints one line with a code
   that works once and expires in 10 minutes, then the same line with
   `--key "<path of your key file>"` for a key file ssh doesn't use by itself.
2. On the laptop, the user types one of those lines into Claude Code (not a chat window), with the
   their key file's path in place of <path of your key file> when they use the second. It uses
   SSH with a key login, so no firewall port is needed.
3. The laptop opens the VPS's page with the panel; a **◆ name** label shows which computer it is.

Both computers should run the same EditLens version. After a restart, if the computers don't
connect again by themselves, pair again.

## Giving Claude on a paired computer a task (MCP tools, `live-page` server)

Use these when the user asks for work "on the VPS" (or another paired computer). First decide
**whose code** the task works on:

- **`workspace: "mine"`**: this computer's project is sent with the task (as it is now, uncommitted
  changes included; never node_modules, .git, .env files, .claude or .mcp.json) and the task works
  on a copy of it there. Use it when the work is for the project open here (for example, the user's
  laptop app). Its changes are copied back with `apply_computer_task`.
- **`workspace: "theirs"`**: the task works on the paired computer's own project. In a git project
  with at least one commit, it works in its own git worktree from the last commit, and
  `merge_computer_task` merges the changes into that project. Without git (or before the first
  commit) there is no copy: the task edits the project folder itself, shared with other agents, its
  changes are there immediately and there is nothing to merge (the task's note says so). Use "theirs"
  for work on that computer's project (its server, its site).

On a VPS where Claude Code runs as root, "mine" tasks run as the normal account `editlens` when it
exists (its own Claude Code and login). A task note that it runs as root means the user can type
`/editlens task-user` in Claude Code on that computer once. If a task says that account isn't signed
in, tell the user to sign it in themselves on the VPS (`su - editlens`, `claude`, `/login`); never
do it for them.

When the two projects differ, `start_task_on_computer` refuses until you choose, and says what
each project is. When they are the same code (same first commit or git remote), "theirs" is the
default.

1. `list_paired_computers`: the names, whether each is connected, and the project there.
2. `start_task_on_computer` with a complete prompt: Claude there knows nothing of this
   conversation, so include the goal, the files, and how to check the result. Its `effort`
   (low, medium, high, xhigh, max) is optional: left out, the user's Effort setting is used, and
   the user can change it on the task card. Writing a level into the prompt does nothing.
3. `check_computer_task` with `wait_seconds` (up to 300) and `since` (replies already seen) until
   the state is `idle` (finished its turn), `ended`, `stopped` or `failed`. Replies arrive whole;
   when there are more than fit, the answer says which `since` to check with next. If it waits for
   a permission answer, tell the user: only they can allow it, in the EditLens window on that
   computer (a panel can only deny); you can't.
   Each check also lists its tool steps (`activity`: titles like `Edit src/App.jsx`, `Bash npm
   test`; pass `activity_since` = the last `activityCount`) and `filesEdited`, so you can see
   early that a task is going wrong and correct it.
   With several tasks, or to keep working meanwhile, use `wait_for_computer_tasks` (`until`:
   `turn_done`, `needs_user`, `any_change` or `all_done`): it returns from this computer's copy of
   their state as soon as one happens, with one line per task.
   Claude there gets your messages marked as written by you (another Claude), never as the user's,
   and a leading `/` is never run as a command.
4. `message_computer_task` for follow-ups or answers in the same conversation.
5. Review before applying any changes:
   - `get_computer_task_changes` lists the files it added, changed or deleted;
   - `get_computer_task_diff` gives the whole change as one diff (pages of 60 KB, `offset`);
   - `get_computer_task_file` shows one file whole (with how it differs from the same file here),
     or only `start_line`..`end_line`;
   - `list_computer_task_files` and `search_computer_task` (plain text, `glob`) check its claims
     without asking Claude there anything.
   Keys and credential files (.env, private keys, package registry logins, ...) are never sent or read.
6. Get the changes back:
   - `"mine"` tasks: `apply_computer_task` writes the changed files into this project. A file is
     written only when it is still as it was sent; files changed here since are listed as
     conflicts: read them with `get_computer_task_file` and edit them yourself. Pass `files` to
     take only some.
   - `"theirs"` tasks: `merge_computer_task` (only files nobody changed on that computer; the rest
     wait for the user's **Merge** in the panel there).
   - Both take `dry_run: true` first to see what would happen, writing nothing. Apply only an
     idle task.
   - Undo: `undo_computer_task_apply` with the `apply` id an apply returned, or
     `undo_computer_task_merge`. A file is restored only while it is still as the apply or merge
     left it.
7. `stop_computer_task` stops a task; `list_computer_tasks` lists them.

To copy files that are already in the paired computer's own project (no task, no Claude run
there): `copy_from_computer` with `path` (a file, a folder, or `.`) and optionally `to`. Files
that already match are skipped; a different file here is a conflict unless `overwrite: true`.
Use `dry_run: true` first for a big folder. It returns a copy id: `undo_computer_task_apply`
with that id puts the files back. node_modules, .git, .env and key files are never copied.
If a sign-in error mentions "another Claude Code process is refreshing it", that is a busy
sign-in, not an expired one: wait a moment and try again; don't ask the user to /login.

The user sees the task live on their page's panel (a **Task on ◆ name** card with each file it
edits). Applied files show on their page as edits. After applying, tell the user what changed and
where to look (the page or route the task named, for example `#/admin`).

Never copy files through chat text or in small pieces: use the tools above.

## Subagents in their own copy

In a git project, each subagent that can edit files gets its own copy (a git worktree, made by
Claude Code). Its edits are not in the project until merged. When it finishes, a **copy** card
lists the files: Changed, New, Deleted, Merges with your edits, Both changed, Already in your
project. If a subagent's result names a copy, merge what you want (or let the user click
**Merge**); files both sides changed need the user's choice (**Use its version**).

EditLens gives a subagent no copy when:
- the setting "Subagents work in their own copy" is off;
- it only reads: Explore, Plan, claude-code-guide, statusline-setup, output-style-setup;
- your Agent call sets its own `isolation` or `cwd`;
- the project is not a git project, or has no commit yet;
- you already work in a copy (`.claude/worktrees/<name>`);
- git needs more than 2 seconds to check the project.
When a subagent gets a copy, EditLens adds a note to that Agent call saying so; a result that
names no copy means it worked in the project folder.

## Permissions

Questions from page control and remote tasks are answered by people only: **Allow** happens in
the EditLens window, a page can only **Deny**. Bypass is never a default. Never try to answer a
permission question yourself.

## Other tools

`highlight_on_page` points at something on the page, `clear_page_highlights` removes it,
`show_code` opens files in the code view, `list_live_pages` lists connected pages. The team
board tools (`read_board`, `claim_task`, `post_note`, `complete_task`, `share_finding`) are
described in the team-board skill.
