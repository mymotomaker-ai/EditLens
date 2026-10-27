# Commands

Type these in Claude Code. `/editlens help <command>` says more about one.

| Command | What it does |
| --- | --- |
| `/editlens` | Start EditLens and connect your page (Vite: runs your own Vite with EditLens added; anything else: finds your running dev server). With the setting **What /editlens does** on its default, it also turns on page control; set to "Connect the page", it only connects |
| `/editlens 3000` | Connect the dev server on that port, or give its address: `/editlens http://localhost:3000`. Page control as with `/editlens` |
| `/editlens <folder>` | Connect the app in that folder. Claude Code opened on a folder that has your app in it? Plain `/editlens` finds it one level down; with several apps, it lists them, the one you used last first |
| `/editlens new` | A folder with no app yet: make a starter page (`index.html`) and connect it. It never replaces a file, only you can run it (Claude can only suggest it), and it is not made in your home folder, a system folder or a folder with more than 20 files that are not web files |
| `/editlens stop` | Disconnect, and end page control in this project (its chat stays in `claude --resume`). `/editlens stop remove` also removes EditLens lines marked in your files |
| `/editlens control` | Page control: run Claude from the panel on the page. On by default; this connects the page too, opens it and waits for it. `/editlens manual` switches back |
| `/editlens restart` | Restart EditLens with the newest installed version, then do what `/editlens` does. Page control that was running starts again in the same conversation when its page reconnects |
| `/editlens settings` | [Settings](settings.md) |
| `/editlens status` | What is connected |
| `/editlens details` | Manual or page control, the page, agents and token use |
| `/editlens effort` | The effort level of page control now and of new tasks. `/editlens effort <level>` or `auto` changes it |
| `/editlens agents` | Every agent and what each working one is doing: computer, model, effort, mode |
| `/editlens sessions` | Page control's sessions and this project's tasks, here and on paired computers: open, stop or rename one, and the `claude --resume` command that continues it in Claude Code. `/editlens stop <name>` stops a running one by its name (only you can type it) |
| `/editlens usage` | The status line to add for exact context, cost and plan limits |
| `/editlens line` | Hide or show the EditLens line above the prompt (where the line shows: the terminal and the desktop Code tab) |
| `/editlens help` | The commands, grouped. `/editlens help pair` (or any command) says more about one |

The first time the panel opens, a short **quick tour** shows the basics. Its last step, **Try page
control**, shows how Claude runs from the panel. Page control is on by default;
`/editlens manual` (or the **What /editlens does** setting) keeps Claude in Claude Code. **More** (the `…` button) has everything else, and **Show the quick tour** shows it again.
