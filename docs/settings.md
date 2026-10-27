# Settings

All EditLens settings are saved in Claude Code. You can change them in these places:

- Enter **`/editlens settings`** in Claude Code. Each setting has a button to change it, and **Reset to defaults**
  puts all settings back.
- Enter **`/config`** in Claude Code, and type `editlens` to find them. Or enter
  `/plugin configure editlens@editlens`.
- In the panel on your page, select **More** > **Settings**. A change there is also saved in Claude Code.

## Page control

| Setting | Default | What it does |
| --- | --- | --- |
| What /editlens does | Connect and turn on page control | The default lets you use Claude from the panel on your page. **Connect the page** (Manual): you use Claude in Claude Code only, and the page shows what Claude does |
| Page control: permission mode | Auto | How often Claude asks before it acts when you use it from the page. This is the mode page control starts in. Bypass is never the default |
| Effort | Auto | How much effort Claude puts into each answer when you use it from the page. More effort gives better answers, but takes longer and uses more of your plan. See [Effort](#effort) |
| Safety check | On | Asks before Claude replaces most of a file or removes EditLens from your app. See [Safety check](page-control.md#safety-check) |

## Other computers

These settings are for [pairing](pairing.md).

| Setting | Default | What it does |
| --- | --- | --- |
| Paired computers can run Claude here | On | Lets a paired computer give tasks to Claude on this computer and start page control here. Only you can allow their permission questions, in this computer's EditLens window. **Off:** the paired computer can only list its tasks and copy files from this project |
| Paired computers can answer questions here | Off | Lets a computer that joined this one allow or deny Claude's questions here, through this computer's EditLens window. Only this computer can turn it on. See [Step 6](pairing.md#step-6-optional-answer-the-vpss-questions-on-the-laptop) |
| Tasks at once | 4 | How many tasks from paired computers run on this computer at the same time, 1 to 8. More tasks wait. Each running task uses about 0.3–0.5 GB of memory and uses your plan's limits |
| Run paired computers' tasks as | Auto | **Auto:** on Linux, when Claude Code runs as root, tasks run as the normal account `editlens`. See [Run tasks as a normal account](pairing.md#run-tasks-as-a-normal-account). **Root (unsafe):** tasks run as root, only after you allow it in the EditLens window |

## Subagents

| Setting | Default | What it does |
| --- | --- | --- |
| Subagents work in their own copy | On | In a git project, each subagent that changes files gets its own copy of the project, so agents can't overwrite each other's changes. See [Subagents](subagents.md#subagents-in-their-own-copy) |

## Page and panel

| Setting | Default | What it does |
| --- | --- | --- |
| Highlight when Claude waits for you | On | Highlights the permissions button while a question waits for your answer |
| Highlight changes on the page | On | Highlights the changed parts of the page |
| Show code on hover | On | Shows the old and new code when you move the pointer over a changed part of the page |
| Message box next to what you pick | On | Opens a small box next to what you select on the page, for a note. See [Select things on the page](pick-box.md) |
| Dictation | On this device | Where your voice is turned into text: **On this device**, **Allow online** (the browser may send the audio to its maker), or **Off** (no mic button). See [Dictation](dictation.md) |
| Follow: go to the page being changed | On | Your page goes to the page of your app that Claude is changing. It only selects links to other pages of your app and tabs (`role="tab"`), never other buttons |
| Expand the code view for new requests | On | Opens the code view again for the first change of each new request, if you made it a narrow bar |
| Panel colors | Auto | **Auto** (the page's colors, or your computer's), **Light**, or **Dark** |
| Panel text size | Medium | **Small**, **Medium**, or **Large** |
| Editor | VS Code | The code editor that **Open** starts from the code view. **None** hides Open |

## Claude Code

| Setting | Default | What it does |
| --- | --- | --- |
| Connect when Claude Code starts | On | Connects your page when a session starts, so you don't need to enter `/editlens` first. Vite projects start with EditLens. A plain site is shown by EditLens itself. Other projects connect if their dev server is already running |
| Wait for page messages | Off | After Claude finishes, it waits a few minutes for a message typed on the page. Terminal only |
| Line above the prompt | On | Shows the EditLens line above Claude Code's prompt |
| Port | 4317 | The port the EditLens server uses. Change it only if 4317 is in use. Enter `/editlens restart` after you change it |

## Effort

Effort sets how much thinking Claude does before it answers.

- **Auto** (default): uses the same level as Claude Code (the level `/effort` saves, or Claude Code's default).
- To change the setting, use Settings or enter `/editlens effort <level>`.
- To change the level for the current page session only, use the effort menu on the page. The page conversation
  keeps that level when it continues, until you change this setting.
- **Max** is used for one session only. It is never saved.

## Settings that a page can't change

For safety, a page can't change these settings. Change them in Claude Code:

- Safety check
- Connect when Claude Code starts
- Paired computers can run Claude here
- Run paired computers' tasks as
- Subagents work in their own copy
- Page control: permission mode
- Port

EditLens checks every value. A value that isn't valid, such as a blank or an unknown option, uses the default.

## Environment variables

Environment variables are set on your computer, outside Claude Code. When one is set, EditLens uses it instead of
the setting.

| Variable | Default | What it does |
| --- | --- | --- |
| `EDITLENS_PORT` | `4317` | The server port |
| `EDITLENS_GUARD` | on | Set to `off` to turn off the safety check |
| `EDITLENS_PAIR_PORT` | `4318` | The port another computer pairs with. It is open only while pairing |
| `EDITLENS_ORIGINS` | none | Other page addresses that may connect, separated by commas |
| `EDITLENS_IDLE_MINUTES` | `120` | The server stops after this many minutes with no activity and no open pages. It never stops while a pairing exists |
| `EDITLENS_WAIT_MINUTES` | `5` | How long Claude waits for a page message after it finishes. `0` turns it off. The maximum is 59 |
| `EDITLENS_TEAM` | on | Set to `off` to turn off the team board |
| `EDITLENS_DISABLE` | unset | Set to `1` to turn off the hooks |
| `EDITLENS_DEBUG` | unset | Set to `1` to log each hook's input to `~/.claude/editlens/hooks.log`. Only names, ids, and paths are logged. Other text is logged as its length only |
| `EDITLENS_STEADY_PORTS` | on | Set to `off` to give a project's EditLens address any free port, instead of the same port (4400–4899) each time. `npm test` does this |
| `EDITLENS_CLAUDE_PATH` | unset | The full path of the `claude` program, if page control can't find it |
| `EDITLENS_WAIT_ANYWHERE` | unset | Set to `1` to let Claude wait for page messages in sessions that aren't a local terminal |
