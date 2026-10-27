# Page control

Page control lets you use Claude from the panel on your page. You type instructions in the panel, as in Claude Code,
and Claude starts working immediately.

**Why use it:** you can stay on your page while you work with Claude. Without page control (Manual), a message
typed in the panel waits until Claude finishes its current turn in Claude Code. With page control, every message
starts Claude immediately, even when Claude Code is waiting, stopped, or closed.

## Turn it on or off

Page control is on by default. When a Claude Code session starts and your page opens, page control turns on.
Nothing starts before your page opens.

- To turn it on now, enter `/editlens control` in Claude Code. EditLens connects your page, opens it in your
  browser, and waits for it.
- To turn it off, select **Manual** under the message box, or enter `/editlens manual`. You then use Claude in
  Claude Code again, and the page only shows what Claude does.
- To keep it off by default, set **What /editlens does** to **Connect the page** in
  [Settings](settings.md).

The first time page control turns on, EditLens installs the Claude Agent SDK. This is Anthropic's package for
running Claude from other apps. It is about 30 MB and is saved outside your project. See
[What it installs](#what-it-installs).

## Which conversation Claude uses

Claude starts with a copy of your current Claude Code conversation, so it already knows your app. Your
conversation in Claude Code isn't changed.

To start a new conversation that knows nothing about your app, enter `/editlens control new`.

After an update or a restart, Claude continues the same page conversation.

## Send a message

1. Type your message in the panel.
2. Select **Send**, or press Enter. Claude starts immediately.
3. To stop Claude, select **Stop** or press Esc.

While Claude works, the **Send** button changes to **Stop**. When you type a new message, it changes back to
**Send**.

Page control tells Claude that your app is already running on the page. Claude reads a file before it changes
it, adds to what is there, and never removes EditLens or changes the dev server's address and port.

## Sign in

Page control uses your own Claude login. There are two ways to sign in.

**Use an API key (recommended).** Set the `ANTHROPIC_API_KEY` environment variable on your computer, and then
enter `/editlens control` again.

**Or sign in from the panel.** Without an API key, the panel shows **Claude needs you to sign in once**:

- **Sign in** uses your Claude plan (Pro, Max, Team, or Enterprise).
- **Sign in with Anthropic Console** uses pay-per-use API billing.

Both open your browser. Finish the sign-in there, and Claude starts. If the browser doesn't open, the panel shows
a link to the sign-in page. If that page shows a code, paste it into the panel.

Claude saves the login itself, the same way `/login` does. EditLens never sees or saves your login. If the login
expires later, the panel asks you to sign in again.

## Permission questions

When Claude needs your OK for a step, such as running a command, a card appears in the panel.

- To allow it, select **Allow…**. The [EditLens window](panel.md#the-editlens-window) opens. Select **Allow**
  there.
- To deny it, select **Deny** on the card.

Claude uses your own permission settings, so it asks the same questions as in Claude Code. A question that nobody
answers is denied after 10 minutes.

## Permission mode

The permission mode sets how often Claude asks permission questions. It works like Shift+Tab in Claude Code.

To change it, select the mode button under the message box, and then select a mode:

| Mode | What Claude does |
| --- | --- |
| Ask | Asks before most steps. |
| Accept edits | Changes files without asking. You confirm this mode in the EditLens window. |
| Plan | Only reads and plans. It changes nothing. |
| Auto | Asks less often. This is the default. |
| Don't ask | Denies anything that would need a question. |
| Bypass permissions | Never asks. It is shown in red. You confirm it in the EditLens window. |

You can also press Alt+M in the message box to switch between Ask, Plan, and Auto.

- To change the default mode, use `/config` in Claude Code.
- Page control never starts in Bypass permissions. If your settings start Claude in that mode, the panel changes
  it to your default mode and says why.
- Claude Code doesn't allow Bypass permissions when it runs as the root user, which is common on a VPS. In that
  case, the mode isn't shown.
- Until Claude's first reply, the button shows **Choose mode**.

**Subagents** use Claude's mode. To give one subagent its own mode, open the **Agents** tab, select the mode on
its card, and select a mode. Select **Same as Claude** to use Claude's mode again.

In Plan mode, and when a subagent is in its own Ask mode, EditLens tools that change something are not allowed.
For example, Claude can't start or stop a task. Tools that only read or show something, such as highlights and
the code view, still work and never ask.

**In Manual,** the mode button and the cards show Claude Code's mode. You can't change it from
the page. Change it in Claude Code with Shift+Tab.

## Safety check

EditLens always asks before Claude does one of these things:

- Replaces most of an existing file. This means more than half of its lines are removed, in a file of 12 lines
  or more.
- Removes EditLens from `vite.config`, `next.config`, `index.html`, or your server file.

It asks in every permission mode, including Bypass permissions, and for subagents too. The card says what would
be lost, and it has no **Always allow**. The same check runs in Claude Code, which then asks you.

To turn it off, set the environment variable `EDITLENS_GUARD=off`.

## Restore a file

Each change card has a **Restore** button. It puts the file back as it was before that change. Any later changes
to that file are removed too. EditLens asks first.

- After a restore, select **Undo** in the message that follows to cancel the restore.
- For a file that Claude created, the button is **Remove file**.
- EditLens keeps the earlier versions in `~/.claude/editlens/backups`: the latest 200, up to 60 MB. Restore works
  after a restart too.
- If the file is now larger than 2 MB, or isn't a text file, EditLens can't keep a copy for Undo. The card says
  so, and only **Restore without Undo** changes the file.

## If page control stops

If page control stops, for example because Claude can't start, the label in the panel turns red and shows
**Page control stopped** with the reason. The EditLens line in Claude Code shows the same.

## One project at a time

Page control runs in one project at a time.

- If it runs in another project and nobody uses it there, `/editlens control` switches that project to Manual and
  starts page control here.
- If someone uses it there (a page is open, or Claude is working or waiting for an answer), EditLens tells you
  where it runs. To move it here anyway, enter `/editlens control take`. The other project switches to Manual, and
  any reply in progress there stops.

Only a command that you type moves page control. Opening a page never does.

## Which browser tabs have control

Only the tabs of your page that are open when page control starts can send messages. A tab that you reload keeps
control. A tab that you open later gets control when no other tab has it. Other tabs only show the session.

Each tab with control gets a random key, and every request must include it.

Everything else works the same as in Manual: highlights, the code view, replay, usage, file links, selecting, and
the team board. The command list shows the commands that the page control session supports.

## What it installs

The first time page control turns on, EditLens runs `npm install` to add the Claude Agent SDK:

- Package: `@anthropic-ai/claude-agent-sdk`, made by Anthropic, a fixed version.
- Source: registry.npmjs.org, or the npm registry your computer is set to use.
- Location: `~/.claude/editlens/sdk`, outside your project. About 30 MB. No install scripts run.

Nothing else in EditLens installs packages.

Page control runs the same `claude` program as your Claude Code sessions. On Windows, this includes the copy
inside the Claude desktop app. That copy isn't on PATH and moves when the app updates, so `/editlens control`
finds it each time.

If no `claude` program is found, npm also installs Claude's own runtime, about 250 MB more. If that doesn't work
either, EditLens says so. To fix it, set the environment variable `EDITLENS_CLAUDE_PATH` to the full path of
`claude.exe` (Windows) or `claude` (macOS and Linux).
