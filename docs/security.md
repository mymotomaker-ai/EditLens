# Security

EditLens sends your source code from Claude Code to your page. This page explains how EditLens makes sure only you
and your own pages can see it, and only you can allow Claude's actions.

## Only your computer can connect

- The EditLens server accepts connections from your own computer only (`127.0.0.1`). It refuses requests whose
  `Host` header isn't localhost. This blocks DNS rebinding attacks. The built-in static server and the dev server
  proxy do the same.
- The proxy keeps your app's Content Security Policy and only adds the EditLens server's address to it. If the policy
  uses `'strict-dynamic'` or nonce styles, the proxy can't add it, and leaves the policy as it is.
- Only pages on localhost can read the changes. A website you visit can't. To allow other addresses, use
  `EDITLENS_ORIGINS`.
- The only exception is the pairing port, which you open with `/editlens pair`. It accepts only the encrypted
  connection described in [Pairing](pairing.md#good-to-know). It also listens on `127.0.0.1` only, unless you use
  `/editlens pair open`.

## Only your account can connect

- **Linux:** the server checks which account opened each connection, and refuses other accounts.
- **macOS and Windows:** the system can't tell the server which account connected. So the server responds only to
  its health check and the page script until a page has your key. `/editlens` opens your page's address with the key
  after `#`, which is never sent to a server. Your browser saves the key for that address, and the page sends it
  with every request. A page opened another way shows "Open this page once from Claude Code: /editlens".
- The key is made from a file in the state folder that only your account can read.
- The hooks send changes to the server with a random token. The server writes the token to a file that only your
  account can read (`0600`) when it starts.

## Only you can allow Claude's actions

- You allow a permission question only in the **EditLens window**. It is a page of the EditLens server, not your
  app. It needs a key that only that window has, can't be put in a frame, and shares nothing with your app's window.
- A page can only deny.
- Through a pairing, the window opens on the other computer only if this computer turned on **Paired computers can
  answer questions here**. It then covers only page control in the paired folder and the tasks that computer gave.
- **Always allow** lasts for the current session only. It is never saved to a settings file.
- Less strict modes (Accept edits and Bypass permissions) are also turned on in the EditLens window. A page can't
  change page control's permission mode setting.
- Claude Code's own permission questions are only listed on the page. You answer them in Claude Code.

## Claude can't approve its own actions

- Claude can't call EditLens's approval or control addresses, or read EditLens's keys. EditLens denies these
  commands in every session.
- This is a pattern check. What stops a hidden command is that the command is itself a permission question, and that
  **Allow** needs the window's key.
- A program on your computer that runs as your account can do what you can, as with any local tool.

## Pages are limited to their project

- Messages typed on the page are accepted only from localhost pages, so another website can't send instructions to
  Claude.
- Page control starts only from Claude Code, never from a page. Its requests need a key that is sent only to that
  project's open pages.
- A page reads files only from the folders of its own project (`data-root`). A page without a project, or with a
  drive, the file system root, or your home folder as its project, gets no files, can't send messages or restore,
  and never gets page control.
- EditLens never shows hidden files, password and key files, or links that lead outside the project. `show_code`
  follows the same rules.
- **Restore** only writes a file back to a copy that EditLens saved before one of Claude's changes. The request names
  that saved copy, never a path. EditLens accepts it only from a page of the same project.
- The page script shows every value as text, never as HTML.
