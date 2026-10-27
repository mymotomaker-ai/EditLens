# Install and update EditLens

Install EditLens once from its marketplace, and update it the same way.

## Install

```bash
/plugin marketplace add mymotomaker-ai/editlens
/plugin install editlens@editlens
```

Then restart Claude Code. Nothing else to set up: no npm packages, no project changes. Page control
is the one exception: the first time you turn it on, it installs the Claude Agent SDK with npm (see
[Page control](page-control.md)). To try EditLens without installing,
start Claude Code with `claude --plugin-dir /path/to/editlens`.

## Update

```bash
/plugin marketplace update editlens
/plugin update editlens@editlens
```

Then restart Claude Code. Open pages show **Update ready** with a **Reload** button for the new panel.

The running EditLens keeps going while page control runs, so an update never ends it. The line
above the prompt and `/editlens details` then say "EditLens <new> is installed, but an older one
(<old>) is still running". **`/editlens restart`** uses the new one immediately, then does what `/editlens` does: page control starts again in the same
project, continuing the same page conversation, as soon as its page reconnects. Any page control that ended without you choosing it
(EditLens restarted or updated, the Claude program it used was removed, Claude stopped) says why on
the page and in Details; after a restart or an update it starts again automatically within 30 minutes.
Manual that you chose is never undone.

On Windows, if the update says a folder is in use, stop the server and try again:

```bash
node "%USERPROFILE%\.claude\plugins\marketplaces\editlens\bin\stop.js"
```

If it still fails, close other Claude Code windows, or pull it directly with
`git -C "%USERPROFILE%\.claude\plugins\marketplaces\editlens" pull` and run the update again.
