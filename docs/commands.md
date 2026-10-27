# Commands

Enter these commands in Claude Code. To learn more about one command, enter `/editlens help <command>`.

## Connect and disconnect

| Command | What it does |
| --- | --- |
| `/editlens` | Connects your page and turns on page control. For a Vite project, it runs your own Vite with EditLens added. For other projects, it finds your running dev server. If **What /editlens does** is set to **Connect the page**, it only connects |
| `/editlens 3000` | Connects the dev server on port 3000. You can also enter an address: `/editlens http://localhost:3000` |
| `/editlens <folder>` | Connects the app in that folder. If Claude Code is open on a folder that contains your app, plain `/editlens` finds it one level down. If there are several apps, it lists them, with the one you used last first |
| `/editlens new` | Creates a starter page (`index.html`) in an empty folder and connects it. It never replaces a file. Only you can run it. It doesn't run in your home folder, a system folder, or a folder with more than 20 files that aren't web files |
| `/editlens stop` | Disconnects and stops page control in this project. The chat stays available in `claude --resume` |
| `/editlens stop remove` | Also removes the EditLens lines marked in your files |
| `/editlens restart` | Restarts EditLens with the newest installed version, and then does what `/editlens` does. Page control continues in the same conversation when the page reconnects |

## Page control

| Command | What it does |
| --- | --- |
| `/editlens control` | Turns on page control, so you can use Claude from the panel on your page. It also connects the page, opens it, and waits for it |
| `/editlens manual` | Switches to Manual. You use Claude in Claude Code only, and the page shows what Claude does |
| `/editlens effort` | Shows the effort level of page control and of new tasks. To change it, enter `/editlens effort <level>` or `/editlens effort auto` |

## See what is happening

| Command | What it does |
| --- | --- |
| `/editlens status` | Shows what is connected |
| `/editlens details` | Shows Manual or page control, the page, the agents, and token use |
| `/editlens agents` | Lists every agent and what each working agent is doing: computer, model, effort, and mode |
| `/editlens sessions` | Lists page control's sessions and this project's tasks, on this computer and paired computers. You can open, stop, or rename one, and see the `claude --resume` command that continues it in Claude Code |
| `/editlens stop <name>` | Stops a running session or task by its name. Only you can enter it |
| `/editlens usage` | Shows the status line to add to Claude Code, to see exact context, cost, and plan limits |

## Settings and help

| Command | What it does |
| --- | --- |
| `/editlens settings` | Opens the [Settings](settings.md) |
| `/editlens line` | Hides or shows the EditLens line above the prompt, in the terminal and the desktop app's Code tab |
| `/editlens help` | Lists all commands by group. `/editlens help pair` (or any command) explains one command |

For pairing commands, see [Pairing](pairing.md#commands).

## The quick tour

The first time the panel opens, a short **quick tour** shows the basics. Its last step, **Try page control**, shows
how to use Claude from the panel. To see the tour again, select **More** (`…`) > **Show the quick tour**.
