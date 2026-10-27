# Pairing: use Claude on another computer

Pairing connects EditLens on two computers. You can then see and use Claude on one computer from the browser on
the other.

**Example:** your project and Claude Code are on a VPS (a computer you rent online). You want to see Claude's
changes and use its panel on your laptop.

In this guide:

- **VPS** is the computer where your project and Claude Code are.
- **Laptop** is the computer you use to see the page.

There is no account and no server in between. The two computers connect directly, through SSH and an encrypted
connection. SSH is the standard way to connect to another computer securely.

You enter all commands in Claude Code, in the terminal or in the chat of the Claude desktop app.

## Before you start

- Install EditLens on both computers.
- Make sure you can sign in to the VPS from the laptop with an SSH key. EditLens can't type a password for you.

## Step 1. On the VPS, enter `/editlens pair`

Open Claude Code in your project on the VPS, and enter `/editlens pair`.

EditLens shows a line that starts with `/editlens join`, with a one-time code. The second line is the same, with
`--key`. Use the second line if your SSH key is in a file that SSH doesn't use by default.

![/editlens pair on the VPS shows the line to enter on the laptop](pairing/pairing-1-pair.png)

The code works once and expires after 10 minutes.

## Step 2. On the laptop, enter the `/editlens join` line

1. Copy the line from the VPS.
2. Paste it into Claude Code on the laptop, and press Enter.

If you use the `--key` line, put the path of your key file in the quotes, for example
`--key "C:/Users/you/.ssh/id_ed25519"`. If SSH doesn't use port 22 on the VPS, add `--ssh-port <number>`.

![/editlens join on the laptop: Paired with ◆ vps](pairing/pairing-2-join.png)

You must enter this line yourself. Claude can't enter it for you, because it opens a connection to another
computer. Claude Code's auto mode blocks this on purpose.

## Step 3. The VPS's page opens on the laptop

The laptop opens the VPS's website in your browser, with the EditLens panel. The colored **◆ vps** label in the
panel shows which computer the page and Claude run on.

The first address includes your key (`?editlens-key=…`). Your browser saves a cookie on that first visit, so
later the address works without the key. To use another browser, open the address that `/editlens join` shows.

![The VPS's page on the laptop, with the ◆ vps label](pairing/pairing-3-paired-page.png)

## Step 4. See changes from the VPS on the laptop

Each change Claude makes on the VPS appears on the laptop's page as it happens. The page reloads, the changed part
is highlighted, and the code view shows the change. **Restore** and **Undo** work from the laptop too.

![A change made on the VPS appears on the laptop's page](pairing/pairing-live-edit.gif)

![The change card and the code view afterward](pairing/pairing-4-live-edit.png)

## Step 5. Use Claude on the VPS from the laptop: `/editlens control vps`

To send messages to Claude on the VPS from the laptop's panel, enter `/editlens control vps` in Claude Code on the
laptop. EditLens opens the paired page in your browser and waits for it. If the laptop has no browser that
EditLens can open, it shows the page's address. Page control starts when you open it.

![/editlens control vps on the laptop](pairing/pairing-5-control.png)

The panel shows **Page control**. What you type in the panel is sent to Claude on the VPS.

When Claude needs your OK for a step, a card appears in the panel:

- To deny it, select **Deny** on the card.
- To allow it, use the EditLens window on the VPS (`http://127.0.0.1:4317/answer` on the VPS). To allow it from
  the laptop instead, see Step 6.

A page can never allow a step.

![The panel in page control on the VPS](pairing/pairing-6-page-control.png)

To switch back, enter `/editlens manual vps`. If page control already runs in another project on the VPS, enter
`/editlens control vps take` to move it to the paired project.

## Step 6 (optional). Answer the VPS's questions on the laptop

This setting is off by default. When it is on, you can allow or deny Claude's questions on the VPS from the
laptop. The VPS's EditLens window opens on the laptop through the pairing connection.

1. On the VPS, enter `/editlens settings`, and select **Can answer here** (under **Other computers**) twice. Or
   turn on **Paired computers can answer questions here** in `/config`. Only the VPS can turn it on. The laptop,
   its page, and Claude can't.
2. On the laptop, a task card that waits for an answer now shows "◆ vps lets you answer it here" and an
   **Answer…** button. On the paired page, **Allow…** opens the same window.

   ![A task card on the laptop with Answer…](pairing/pairing-7-answer-card.png)

3. The window shows which computer asked. Select **Allow** or **Deny**. Only a person who selects a button there
   can answer.

   ![The VPS's EditLens window, opened on the laptop](pairing/pairing-8-answer-window.png)

This covers questions from page control in the paired folder and from tasks the laptop gave. Changes to the VPS's
settings, Root (unsafe), and permission modes are still answered on the VPS only. When you turn the setting off or
unpair, the laptop can't use the window anymore.

## Give Claude on the VPS tasks

A *task* is work that Claude on the laptop gives to Claude on the VPS. Ask Claude on the laptop in plain words, for
example "On the VPS, update the dependencies and run the tests."

### How to follow a task

- **On the laptop,** the panel shows a **Task on ◆ VPS** card while the task runs. It shows the request, each file
  the task changes, its last reply, and when a question waits for your answer. Files changed by a command, such as
  a script, show as "Changed by a command".
- **Open the ◆ VPS app** opens the VPS's website through the pairing connection.
- **Stop task** on the card stops the task.

### Whose code the task uses

When the laptop's project and the VPS's project are different, Claude chooses one:

- **This project (`"mine"`):** EditLens sends a copy of the laptop's project to the VPS. When the task is done,
  Claude copies the changes back to the laptop. Each changed file then appears on the laptop's page like any other
  change, marked "(from VPS)".
- **The VPS's project (`"theirs"`):** the task works on the project that is already on the VPS. Its changes are
  added to that project when Claude merges them, or when you select **Merge** on the copy card.

A sent project is saved in the VPS's EditLens folder, not in its project. EditLens never sends `node_modules`,
`.git`, `.env` files, `.claude`, or `.mcp.json`. Secrets stay on the laptop, and its hooks and MCP servers never
run on the VPS. Files larger than 5 MB are not sent, and EditLens lists them. Build output and
installs on the VPS, such as `node_modules`, `dist`, `build`, and logs, are never copied back.

### Rules that keep tasks safe

- **A task's text is never a command.** What the laptop's Claude writes is marked as written by Claude, not by you.
  A leading `/` is not run, so commands such as `/login` and `/editlens join` stay yours to enter.
- **Permission questions stay on the VPS.** A task uses the VPS's page control permission mode: Auto by default,
  and never Bypass as root. A question appears as a task card on both computers. **Deny** works on either card.
  **Allow** works only in the VPS's EditLens window. The laptop can open that window if Step 6 is on.
- **Each task has its own copy.** In a git project, each task works in its own copy of the project (a git
  worktree in `.claude/worktrees/`). Several tasks and your own Claude on the VPS can't change the same files at
  the same time. In a project without git, or without a first commit, the task works in the project itself and
  says so. To get copies, enter `git init` and make one commit.
- **Copying back is careful.** Claude copies back only files you haven't changed since they were sent. It waits
  until the task is not working. A file that your editor or dev server keeps open fails on its own; close it and
  try again.

### What you see from the VPS

While the laptop is paired and its page is open, each change made on the VPS appears on the laptop's page. This
includes changes from tasks and from Claude in the VPS's own sessions. Each card shows where it was made, for
example "◆ vps: src/App.jsx". These changes are never highlighted on the laptop's page. Key and password files show
as changed, without their lines.

A change made by Claude in the VPS's own session has **Restore** and **Undo only this edit** on the laptop too.
The VPS checks the request first. If a later change changed the same lines, ask Claude on the VPS instead. A
task's changes have no Restore on the laptop.

### If the connection breaks

- If the connection breaks, only that one request fails. The task keeps running on the VPS.
- If Claude Code restarts on the VPS, running tasks stop and say so. A new message continues the same
  conversation.
- The VPS keeps the last 50 tasks. The **Tasks at once** setting on the VPS sets how many run at the same time:
  1 to 8, 4 by default. More tasks wait, up to 8, and show "Waiting".
- The VPS saves its changes for the laptop on disk, about 24 MB. A laptop that was offline gets them when it
  reconnects. If there were more, the page shows how many were not kept.

### Turn tasks off

On the VPS, set **Paired computers can run Claude here** to Off in `/config`. A page can't change it. The laptop
then can't start tasks, message them, merge their changes, or start page control on the VPS. It can still list,
read, and stop its tasks, and copy files from the VPS's project.

### Claude's task tools

Claude on the laptop uses these tools. You don't need to call them yourself.

| Tool | What it does |
| --- | --- |
| `list_paired_computers` | Lists the paired computers, whether each is connected, and the project on each |
| `start_task_on_computer` | Starts a task on the VPS, with a copy of this project (`workspace: "mine"`) or on the VPS's project (`"theirs"`) |
| `check_computer_task` | Shows a task's state, new replies, and result. It can wait while the task works |
| `message_computer_task` | Sends a new message in the same task |
| `stop_computer_task` | Stops a task |
| `merge_computer_task` | Adds the task's changes to the VPS's project. Files that someone changed on the VPS wait for you in the VPS's panel |
| `get_computer_task_changes` | Lists the files the task added, changed, or deleted |
| `get_computer_task_file` | Shows one of those files, and how it differs from the same file on the laptop |
| `apply_computer_task` | For a `"mine"` task: writes its changes into the laptop's project, only for files you haven't changed since they were sent |
| `wait_for_computer_tasks` | Waits until a task finishes, needs you, or changes |
| `get_computer_task_diff` | Shows the whole change as one diff, in pages |
| `list_computer_task_files`, `search_computer_task` | Lists or searches the task's files |
| `undo_computer_task_apply`, `undo_computer_task_merge` | Cancels an apply or a merge, file by file, if the files haven't changed since. Apply and merge also take `dry_run` to show what would change |
| `list_computer_tasks` | Lists every task it started on the VPS |

## Run tasks as a normal account

**Why:** on a Linux server where Claude Code runs as the root user, a task can change anything on the computer.
A normal account limits what a task can change.

To set it up:

1. In Claude Code on the server, enter:

   ```
   /editlens task-user
   ```

   EditLens creates a normal account named `editlens`, with no password, no sudo, and its own group. It installs
   Claude Code for that account with Claude Code's official installer
   (`curl -fsSL https://claude.ai/install.sh | bash`).

2. Sign in to Claude with that account, in a terminal on the server. It has its own login. Nothing is copied
   from root.

   ```sh
   su - editlens
   claude          # then /login, follow the link, then /exit
   exit
   ```

After that, tasks on a project sent from the laptop run as the `editlens` account. Their files are in
`/home/editlens/editlens-workspaces`. They can't use root or open root's files or other accounts' private
files.

- `/editlens task-user status` shows what is set up. If the setup stopped before it finished, enter
  `/editlens task-user` again.
- If the account isn't ready (no Claude Code, or not signed in), a task says what is missing. It never runs as
  root instead.
- The account gets none of root's API keys, login token, or other secrets. It gets only what programs need to run:
  `PATH`, language, terminal, and proxy settings.
- The task's hooks get their own key. It only lets them report changes in the task's files. They can't answer
  permission questions, change settings, or start a server.
- Tasks on the server's own project (`"theirs"`) still run as Claude Code's user, because that project is usually
  in root's home folder, which the account can't open.

**To remove it,** enter `/editlens task-user off`. EditLens removes the account and its home folder after no task
is running. Add `--force` to remove it anyway. EditLens removes only an account that it created. If you created an
`editlens` account yourself, EditLens only stops using it and tells you how to remove it
(`sudo userdel -r editlens`).

**Root (unsafe).** To run every task as root anyway, set **Run paired computers' tasks as** to **Root (unsafe)** in
`/config` on the server. The EditLens window on the server then asks you to confirm. Select **Run tasks as root**
to turn it on, or **Keep the safe account** to cancel. While it is on, a red **⚠ Tasks run as root** label appears
in the panel on both computers. It never turns on by itself. Bypass permissions is still not allowed as root. To
turn it off, set the setting back to **Auto**.

## Commands

| Command | Where | What it does |
| --- | --- | --- |
| `/editlens pair` | VPS | Starts pairing for 10 minutes and shows the line to enter on the laptop (through SSH) |
| `/editlens pair open` | VPS | The same, for a direct connection without SSH. You open the pairing port in the firewall yourself |
| `/editlens pair off` | VPS | Ends every pairing and closes the pairing port. Page control that the laptop started on the VPS stops too |
| `/editlens join <user>@<address> <code>` | Laptop | Pairs with that computer. Add `--key "<path>"` for a key file |
| `/editlens join` | Laptop | Lists the paired computers, their state, and their local addresses |
| `/editlens join off [name]` | Laptop | Unpairs one computer, or all of them |
| `/editlens control <name>` | Laptop | Starts page control for Claude on that computer |
| `/editlens manual <name>` | Laptop | Switches back to Manual. The page only shows what Claude does |

`/editlens pair off` removes every pairing on that computer. To remove only one computer, enter
`/editlens join off <name>` on the laptop.

## Good to know

- **One folder only.** Pairing covers the folder where you entered `/editlens pair`. A laptop has one pairing with
  each computer. If you pair again, the new pairing replaces the old one.
- **Firewall.** The pairing port accepts connections from the VPS itself only (`127.0.0.1`). The laptop connects
  through SSH, so you don't need to open a firewall port. With `/editlens pair open`, the port accepts connections
  from any address (`/editlens join 203.0.113.5 <code>`). You then open port 4318 in the VPS's firewall yourself.
  `EDITLENS_PAIR_PORT` sets another port. EditLens never opens a firewall port.
- **Reconnecting.** When the connection breaks (Wi-Fi, sleep, or a restart), the panel shows "Reconnecting to
  vps…" and reconnects by itself. The VPS's EditLens server runs while its Claude Code runs.
- **Versions.** Both computers need EditLens 0.24.45 or later. With an older version, the page shows "Update
  EditLens on ◆ <name> (0.24.45 or later), then reload this page."

### Security details

- The code has about 138 random bits, works once, and expires after 10 minutes. It is never sent. Both computers
  use it as a TLS pre-shared key (ECDHE-PSK with ChaCha20-Poly1305, forward secret).
- After pairing, the VPS gives the laptop its own 256-bit key. Each computer saves it in its state folder, where
  only the owner can read it.
- The pairing port is open only while a code waits or a pairing exists. Ten wrong keys in one minute block that
  address for 10 minutes.
- A paired page sees only the folder you paired: its changes, chat, tasks, and files. It can never use the VPS's
  hook key.
- On the laptop, only the paired page's two local addresses can use the connection. They need a key made from a
  file that only your account can read, so another account on a shared computer gets nothing.
- The first SSH connection saves the VPS's host key.

The pictures on this page are made by `test/docs-pairing.js` (Step 6: `test/taskcard-preview.js`) with two
EditLens servers on one computer and a test version of Claude. The addresses and names are examples.
