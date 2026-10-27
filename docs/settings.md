# Settings

Settings are in Claude Code, so there is one place for them:

- **`/editlens settings`** opens a settings pane: each setting with a button to change it, and
  **Reset to defaults**.
- They are also in **`/config`** (type `editlens` to find them) and in
  `/plugin configure editlens@editlens`.
- The panel on the page has the same settings under **More › Settings**. A change there is saved in
  Claude Code too, so both always agree.

| Setting | Default | What it does |
| --- | --- | --- |
| What /editlens does | Connect and turn on page control | With **Connect when Claude Code starts** also on (the default), page control turns on by itself when a session starts (or the desktop app resumes it) and your page opens; the first time, it sets itself up then. "Connect the page" = Manual: Claude stays in Claude Code |
| Page control: permission mode | Auto | How Claude asks before acting when it runs from the page (also tasks from a paired computer). Bypass is never a default |
| Effort | Auto | Claude's effort level when it runs from the page (also tasks it starts). Auto: the level Claude Code uses by itself (the one `/effort` saves, else Claude Code's default). Change it in Settings or with `/editlens effort <level>`. A level picked in the page's effort label changes only the page control session running now; that page conversation keeps it when it continues, until this setting changes while page control runs. Max lasts one session and is never saved |
| Safety check | On | Ask before Claude replaces most of a file or removes EditLens from your app |
| Paired computers can run Claude here | On | A computer paired with this one can give Claude here tasks and start page control here. Off blocks only that: it can still list its tasks and copy files from this project. Their permission questions appear in the panel here: only you can allow them, in the EditLens window; a page can only deny |
| Paired computers can answer questions here | Off | A computer that joined this one (`/editlens join`) can allow or deny Claude's permission questions here, in this computer's EditLens window opened through the pairing link: questions from page control in the paired folder and from tasks it gave. Turn it on here only (the paired computer and its page can't). See [docs/pairing.md](pairing.md#step-6-optional-answer-the-vpss-questions-on-the-laptop) |
| Tasks at once | 4 | How many paired computers' tasks run on this computer at the same time, 1 to 8 (more wait for an available session). Each running task adds about 0.3–0.5 GB of memory and uses your plan's limits in parallel. A change applies to the next task that starts; running tasks keep running |
| Run paired computers' tasks as | Auto | Auto: on Linux, when Claude Code runs as root and a normal account named `editlens` exists, tasks on a sent project run as that account (see "Tasks as a normal account"). Root (unsafe): as root, only after you allow it in the EditLens window |
| Subagents work in their own copy | On | In a git project, each subagent that edits gets its own copy (a git worktree), so agents can't overwrite each other |
| Highlight when Claude waits for you | On | The floating permissions button is highlighted while a question waits; off, it stays still |
| Highlight changes on the page | On | Changed parts of the page are highlighted |
| Show code on hover | On | Hover over a changed part of the page to see its code, old and new, beside it |
| Message box next to what you pick | On | After you select something on the page, a small box opens next to it for a note. **Add** puts the note in the panel's message box; nothing is sent until you press Send. Off: you type in the panel. See [docs/pick-box.md](pick-box.md) |
| Dictation | On this device | Where your voice is turned into text when you press the mic: On this device, Allow online (the browser may send the audio to its maker), or Off (no mic button). See [docs/dictation.md](dictation.md) |
| Follow: go to the page being changed | On | The page goes to the page of your app Claude is editing. To get there it only uses links to another page of your app and tabs (`role="tab"`), never other buttons |
| Expand the code view for new requests | On | A code view made smaller to a narrow bar opens again for the first edit of each new request |
| Wait for page messages | Off | Claude waits a few minutes after it finishes for a message typed on the page (terminal only) |
| Line above the prompt | On | The EditLens line above Claude Code's prompt |
| Panel colors | Auto | Auto (the page's own colors, else your computer's), Light or Dark |
| Panel text size | Medium | Small, Medium or Large |
| Connect when Claude Code starts | On | Connect your page when a session starts, so `/editlens` isn't needed first (Vite: starts its page; a plain site: serves its folder; others: when the dev server already runs) |
| Port | 4317 | Where the EditLens server listens; takes effect after `/editlens restart` (`/clear` keeps the running port) |

The safety check, connecting at start, paired computers running Claude (and as which user), subagent copies, page
control's permission mode and the port can only be changed in Claude Code, never from a page. Every value is checked: one that doesn't fit (blank, not a number, an unknown choice) uses the
default. The environment variables `EDITLENS_PORT` and `EDITLENS_GUARD=off` are used instead when set.
