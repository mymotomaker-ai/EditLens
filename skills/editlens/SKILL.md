---
name: editlens
description: Runs the /editlens command the user typed (connect the page, page control, settings, pairing). Only the user starts it.
argument-hint: "[control | manual | stop | restart | new | undo [N] | restore N | status | settings | 3000 | help ...]"
disable-model-invocation: true
---

The user typed `/editlens $ARGUMENTS`. Where Claude Code runs the EditLens command itself (the
terminal), this text is not used. Here it isn't, so run the command for the user:

1. Run this once with your shell tool, from the project folder, with a timeout of 10 minutes
   (page control waits up to 2 minutes for the page, and its first start downloads the Claude
   Agent SDK). Describe the call as "EditLens".

   ```
   node "${EDITLENS_STATE_DIR:-$HOME/.claude/editlens}/start.js" $ARGUMENTS
   ```

   If that file doesn't exist, run this instead:

   ```
   node "${CLAUDE_SKILL_DIR}/../../bin/start.js" $ARGUMENTS
   ```

   The words after `start.js` are the user's, as they typed them: quote them again for the shell
   before you run it. Put every argument in single quotes, also one with no spaces: `stop`
   becomes `'stop'`. Words the user put in quotes ("a b" or 'a b') are one argument: remove their
   quotes, then put single quotes around it. Write a single quote inside an argument as `'\''`.
   Never keep or use double quotes: inside them `$(...)` and backticks still run.
2. Show the user what it printed, as it is. Don't run anything else for it: the command connects
   the page, opens it and turns page control on by itself. `/editlens undo N` and
   `/editlens restore N` change the file themselves. When `undo` prints a message to copy into
   the prompt, show it and stop: don't make that change yourself until the user sends it.
3. If it failed, say what it printed and stop. Don't bypass it, and never run a pairing,
   login or account command (`join`, `pair`, `task-user`, `control <name>`, `control take`),
   `effort <level>` or `stop <name>`, the user didn't type.
4. `/editlens new` makes a file (index.html) in the user's folder, so only the user starts it. Run
   `start.js new` only when the command the user typed just now (above) is `/editlens new`.
   When output suggests `/editlens new`, tell the user to type it; never run it yourself, and never
   make the page another way instead.

For what EditLens does and how to use it, the editlens-guide skill has the details.
