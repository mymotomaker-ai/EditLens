# Install and update EditLens

## Install

1. In Claude Code, enter these two commands:

   ```bash
   /plugin marketplace add mymotomaker-ai/editlens
   /plugin install editlens@editlens
   ```

2. Restart Claude Code.

You don't need to install anything else or change your project. The only exception is page control: the first time
it turns on, it installs the Claude Agent SDK with npm. See [Page control](page-control.md#what-it-installs).

To try EditLens without installing it, start Claude Code with `claude --plugin-dir /path/to/editlens`.

## Update

1. In Claude Code, enter these two commands:

   ```bash
   /plugin marketplace update editlens
   /plugin update editlens@editlens
   ```

2. Restart Claude Code.

Open pages show **Update ready** with a **Reload** button. Select it to load the new panel.

### If page control is running

An update doesn't stop page control. The old version keeps running until you restart it. The line above the prompt
and `/editlens details` show "EditLens <new> is installed, but an older one (<old>) is still running".

To use the new version now, enter **`/editlens restart`**. Page control starts again in the same project, and
continues the same page conversation when your page reconnects.

If page control stopped without your choice, for example because of a restart or an update, the page and Details
say why. After a restart or an update, it starts again by itself within 30 minutes. If you chose Manual, it stays
Manual.

## Fix an update problem on Windows

If the update says a folder is in use:

1. Stop the EditLens server:

   ```bash
   node "%USERPROFILE%\.claude\plugins\marketplaces\editlens\bin\stop.js"
   ```

2. Run the update again.

If it still fails, close other Claude Code windows. Or update the files directly with
`git -C "%USERPROFILE%\.claude\plugins\marketplaces\editlens" pull`, and then run the update again.
