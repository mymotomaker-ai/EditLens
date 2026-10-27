# EditLens privacy policy

Last updated: 11 October 2026

EditLens is a Claude Code plugin that runs on your own computer. This policy says what it does with
your data.

## What EditLens collects

Nothing. EditLens has no account, no analytics, no usage tracking and no server of its own. The plugin's
author receives no data from it.

## What stays on your computer

- **The session transcript.** While its server runs, EditLens reads each Claude Code session's
  transcript file (in `~/.claude/projects`) to show Claude's replies, tool steps and token use on your
  page. It sends them nowhere else, except to a paired computer's page (below).
- **The local server** listens only on `127.0.0.1` (your own computer). Only pages on your computer
  can connect to it, and only your account: on macOS and Windows a page needs your key, which
  `/editlens` gives it once (below). The exception is pairing, which you start yourself (below).
- **The state folder** (`~/.claude/editlens`) keeps:
  - logs of the server and the hooks;
  - copies of files from before Claude changed them, so you can restore them (at most 200 copies
    and 60 MB, oldest removed first);
  - the team board that subagents write to (at most 500 entries each; deleted after 90 days unused);
  - a key that lets Claude Code's hooks connect to the local server;
  - the Claude Agent SDK, if you turn on page control;
  - pairing keys and the addresses of computers you paired, if you use pairing; the key your pages
    use on macOS and Windows is made from the same file (`gateway-key`);
  - on a computer others paired with: the edits made there that they can see (with the files'
    text, at most about 24 MB, oldest removed first), so a computer that was away gets them later;
  - screenshots you paste into the message box (deleted after 7 days; at most the newest 60);
  - the Sessions list: names you give sessions and tasks, and for page control's last 60 sessions
    their folder, session id, first line of the first message, model, effort, mode and times;
  - the port each Claude Code session started with (by session id; deleted after 30 days), and the
    settings you denied in the EditLens window.
- **Your browser** keeps the panel's layout and choices in the page's local storage, and a
  message you are typing until you send it. For a paired computer's page it also keeps a cookie for
  that page's local address (`editlens-gw-<port>`), so only you can open it on this computer. On
  macOS and Windows it keeps your page key for each page address (`editlens.key:<EditLens address>`).

You can delete the state folder at any time. Uninstalling the plugin does not delete it.

## What is sent over the internet

- **Page control** (on by default): the setting "What /editlens does" is "Connect and turn on page
  control" unless you change it, so while "Connect when Claude Code starts" is also on (the
  default), page control turns on by itself when a Claude Code session starts or resumes and the
  project's page opens. `/editlens control` turns it on immediately; `/editlens manual` or Manual on the
  page turns it off, and "What /editlens does" = "Connect the page" keeps it off. The first time it
  turns on, it installs the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) from the npm
  registry (or the one your npm is set to use) into the state folder. Claude then runs from the
  page the same way it runs in Claude Code: it connects to Anthropic with your own API key or
  login. EditLens never reads, stores or sends your API key or login. On a server where tasks run
  as a separate account, that account never gets root's keys or tokens: it uses its own login.
- **Pairing** (only when you run `/editlens pair` and `/editlens join`): your two computers connect
  directly to each other through an encrypted link (inside an SSH connection, if you join with
  `user@address`, the default). Nothing passes through any other server, and EditLens never opens a
  firewall port. The link sends:
  - when you pair: each computer's name (from its host name), a random id for each computer, the
    EditLens versions, the paired project's folder path and the pairing key; if you join with
    `--key`, the path of that key file (never the key itself), so the ssh lines it prints for you
    have it filled in;
  - while the paired page is open (and edits made while it was closed, when it opens again): what that page shows of the paired folder on the other computer,
    as it would on that computer: Claude's edits there with the files' text, Claude's replies and
    tool steps, the files you open in the code view, the app's own pages (the paired page loads the
    app through the link), page control messages and permission questions;
  - for tasks: the task's prompt, replies, tool steps and permission questions, and the files and
    diffs Claude reads or applies with the task tools. A task on your project (`"mine"`) sends a
    copy of the project, without node_modules, `.git`, `.env` files, key files, `.claude`,
    `.mcp.json` and files over 5 MB. The tasks list is kept in the state folder of the computer
    that runs them;
  - when "Paired computers can answer questions here" is on (off by default): the EditLens window's
    questions about the paired folder and the joined computer's tasks, and your answers to them.
- **Dictation** (only when you press the mic): your browser turns your voice into text. With the
  setting "Dictation" = On this device (the default) the audio stays on your computer; Chrome
  downloads its speech model once. With Allow online, or when you press Allow in a browser that can
  only do it online (Edge, Safari), the browser sends the audio to its maker (Google, Microsoft or
  Apple) under that company's terms. EditLens itself never receives, keeps or sends the audio; only
  the text you then send goes to Claude.
- **Claude Code itself** sends your conversations to Anthropic under Anthropic's own terms and
  privacy policy (https://www.anthropic.com/legal/privacy). EditLens doesn't change that.

## Contact

Questions: mymotomaker@gmail.com
