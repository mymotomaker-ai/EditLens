<p align="center"><img src=".claude-plugin/icon.png" width="96" alt="EditLens icon"></p>

<h1 align="center">EditLens</h1>

<p align="center">See Claude's edits on your page as they happen. A plugin for Claude Code.</p>

![Claude edits a page: each change is highlighted, the code view types it out, and two agents work at the same time](docs/editlens-demo.gif)

## What it does

- **Highlights each edit on the page.** Every element Claude changes is highlighted, with the file and line.
- **Shows the chat on the page.** Claude's replies, tool steps, and subagents appear live in a panel.
- **Shows the code next to the page.** Each edit is typed out line by line. Replay any edit later.
- **Sends messages from the page.** Select an element, add a note, and send it to Claude.
- **Runs Claude from the page.** With page control, the panel works as a full Claude window.

Works with Vite, Next.js, Express, plain HTML, and most other dev servers. No changes to your project.

## Requirements

- Claude Code 2.1.287 or later (2.1.286 or later in the desktop app)
- Node.js 18 or later
- Windows, macOS, or Linux

## Install

In Claude Code, run:

```
/plugin marketplace add mymotomaker-ai/editlens
/plugin install editlens@editlens
```

Then restart Claude Code.

## Get started

1. Open Claude Code in your app's folder.
2. Run `/editlens`.
3. Open the address it prints.

Ask Claude for a change. The page highlights each edit, and the panel shows the chat.

No app yet? Create an empty folder, open Claude Code there, and run `/editlens new`. It makes a starter page and connects it.

## Examples

Type these in Claude Code, or in the panel with page control:

1. "Make the header sticky and give the buttons rounded corners."
   Each edit is highlighted on the page as Claude makes it.
2. "Highlight every button on this page that has no label for screen readers, and show me the code for the first one."
   Claude outlines the buttons on the page and opens the code in the code view.
3. Select the arrow button in the panel header, then the pricing card, and type "Make this card match the others."
   Claude receives the element and the lines of code that draw it.

## Commands

| Command | What it does |
| --- | --- |
| `/editlens` | Connect your page and start page control |
| `/editlens 3000` | Connect the dev server on port 3000 |
| `/editlens new` | Make a starter page in an empty folder and connect it |
| `/editlens stop` | Disconnect and end page control |
| `/editlens manual` | Keep Claude in Claude Code only |
| `/editlens settings` | Open the settings |
| `/editlens status` | Show what's connected |
| `/editlens help` | List every command |

All commands: [docs/commands.md](docs/commands.md).

## Documentation

| Page | Contents |
| --- | --- |
| [Connect your page](docs/connect-your-page.md) | Vite, plain sites, other dev servers, and manual setup |
| [The panel](docs/panel.md) | Chat, edit cards, code view, replay, usage, and the command palette |
| [Page control](docs/page-control.md) | Run Claude from the page, sign in, and permission modes |
| [Select things on the page](docs/pick-box.md) | Send an element and a note to Claude |
| [Dictation](docs/dictation.md) | Type messages with your voice |
| [Subagents](docs/subagents.md) | Agents switcher, separate copies, and the team board |
| [Pairing](docs/pairing.md) | See and control Claude on another computer |
| [Settings](docs/settings.md) | Every setting and its default |
| [How it works](docs/how-it-works.md) | Hooks, the local server, and the page script |
| [Update EditLens](docs/updating.md) | Update steps and fixes for Windows |
| [Security](docs/security.md) | What the local server accepts, and from where |

## What EditLens runs and reads

- **Session transcript.** Reads each Claude Code session's transcript file in `~/.claude/projects` to show the chat on the page.
- **Hooks.** Send Claude's events (prompts, edits, tool steps, agents, permission questions) to the local server. They also add a short note to Claude's context at session start, in a git project run each editing subagent in its own worktree (the `PreToolUse` hook adds `isolation: "worktree"` to the subagent's call and approves nothing), and block Claude from calling EditLens's own approval addresses. They never answer permission questions.
- **Local server.** `node server/server.js` listens on `127.0.0.1:4317`. Only when you ask, it opens an address for your dev server, the pairing port 4318, and, for a paired computer, a local port for its page and an `ssh` connection.
- **Your app.** `/editlens` runs your project's own Vite with EditLens added, or serves a plain site's folder. It runs no other script of yours. It can open your browser.
- **Claude Code panel.** `hooks/mod.mjs` draws the line above the prompt, the `/editlens` output, and the Settings pane. It talks only to the local server on `127.0.0.1`, with the server's key: it sends settings and finished tool calls, and asks for the summary. It changes only EditLens's own settings (`editlens.*`), when you change one in its Settings pane, in the page's Settings, or with `/editlens line`. It writes the session's port to `~/.claude/editlens/session-ports`. It runs `node bin/start.js` for `/editlens`, `node bin/serve.js` to start the server, and Claude Code's `/effort` when you press the effort button. It can put text in the prompt box but never sends it. It never answers permission questions and never changes Claude Code's permission mode.
- **MCP server.** `node mcp/live-page.js` gives Claude 26 tools. Each tool states whether it only reads.
- **git.** Adds and removes worktrees for subagents, and reads status, diffs, and history.
- **npm.** The first time page control starts, it installs `@anthropic-ai/claude-agent-sdk` into `~/.claude/editlens`. Page control and tasks run Claude through it with your own Claude login. Sign-in uses `claude auth status` and `claude auth login`.
- **Task account.** Only when you type `/editlens task-user` (Linux, as root): it makes a normal `editlens` account, then runs Claude Code's official installer as that user: `curl -fsSL https://claude.ai/install.sh | bash`.
- **Files it reads.** Claude Code's settings files (it never changes them), and files in the project Claude works in, for the code view and the edit cards. It never reads hidden or secret-looking files.
- **Files it writes.** Only `~/.claude/editlens`, and EditLens lines in your files when connecting needs them. `/editlens stop remove` removes those lines.
- **Network.** Nothing goes to the author. See [Privacy](#privacy).

## Privacy

EditLens collects nothing and sends nothing to its author. Data leaves your computer only for the one-time page control install, Claude's own connection to Anthropic, a pairing link you start, and online dictation if you turn it on. See [PRIVACY.md](PRIVACY.md).

## Security

The server listens on `127.0.0.1` only and rejects requests from other hosts. Details: [docs/security.md](docs/security.md). To report a vulnerability, follow [SECURITY.md](SECURITY.md).

## Troubleshooting

- **The page doesn't connect.** Run `/editlens status`. Open the address `/editlens` printed, not your dev server's own address. For a dev server it didn't find, give the port: `/editlens 3000`.
- **The port is in use.** Choose another **Port** in `/editlens settings`, then run `/editlens restart`.
- **The page shows an old version.** Restart Claude Code, then run `/editlens restart`.
- **Page control doesn't start.** Sign in when the panel asks. Page control needs Node.js 18 or later and npm.
- **Something else.** Add the logs `~/.claude/editlens/server-4317.log` and `~/.claude/editlens/hooks.log` to a new issue.

## Support

- Questions and bugs: [open an issue](https://github.com/mymotomaker-ai/editlens/issues/new/choose).
- Security problems: report them privately, as [SECURITY.md](SECURITY.md) describes.
- Email: mymotomaker@gmail.com

EditLens has no website or domain. The GitHub repository is the only official source.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

EditLens is released under the [MIT License](LICENSE).
