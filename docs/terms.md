# Terms

These are the words EditLens uses, each in one or two plain sentences.

| Term | What it means |
| --- | --- |
| Claude Code | The app where you talk to Claude about your code. It runs in a terminal or in the Claude desktop app. EditLens is a plugin for it. |
| Plugin | An add-on that gives Claude Code new commands and features. |
| Your page | Your website, open in your browser while you build it. |
| Dev server | The program that shows your website on your own computer while you build it, for example Vite or Next.js. It usually has an address such as `http://localhost:3000`. |
| Port | The number at the end of an address, such as `3000` in `localhost:3000`. Each program on your computer uses its own port. |
| Panel | The EditLens box on your page. It shows Claude's chat, the changes, and a message box. |
| Code view | A view beside your page that shows the code of each change, line by line. |
| Page control | You type instructions to Claude in the panel on your page, as in Claude Code. It is on by default. |
| Manual | The opposite of page control. You type instructions only in Claude Code, and the page only shows what Claude does. |
| Permission question | Claude asks before it does something that needs your OK, such as running a command. |
| Permission mode | How often Claude asks permission questions. For example, Ask asks before most steps, Auto asks less often, and Bypass never asks. |
| EditLens window | A small separate window where you allow or deny Claude's permission questions. EditLens uses a separate window because Claude can change your page but can't change this window. |
| Subagent | A second Claude that the main Claude starts to do part of the work at the same time. |
| Own copy (worktree) | A separate copy of your project where one subagent works, so two agents can't change the same file at the same time. Git calls this a worktree. |
| Team board | A shared list where the agents write what each one is working on. |
| Pairing | Connects EditLens on two computers. You can then see and use Claude on one computer from the browser on the other. |
| VPS | A computer you rent online, also called a server. |
| SSH | The standard way to connect to another computer securely. Pairing uses it. |
| Task | Work that you give to Claude on a paired computer. |
| Hooks | Small scripts that Claude Code runs at fixed moments, for example after each change. EditLens uses them to tell the page what Claude did. |
| Local server | A small program that EditLens runs on your computer. It sends Claude's changes to your page. Only your own computer can connect to it. |
| Effort | How much thinking Claude does before it answers. More effort gives better answers, but takes longer and uses more of your plan. |
