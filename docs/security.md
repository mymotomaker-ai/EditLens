# Security

Events contain your source code, so the server is strictly limited:

- It runs on `127.0.0.1` only, and it rejects requests whose `Host` header is not localhost. This
  blocks DNS rebinding. So do the built-in static server and the dev-server proxy; the proxy keeps
  your app's Content-Security-Policy and only adds the live server's address to it (when the policy
  uses `'strict-dynamic'` or nonce styles, the proxy can't, and leaves it off as before). The one
  exception is the pairing port, which you open with `/editlens pair` and which accepts only the
  encrypted link described in [Pairing](pairing.md#good-to-know). It too listens on 127.0.0.1
  unless you choose `/editlens pair open`.
- Only pages served from localhost origins can read the stream. A website you visit can't. Add other
  origins with `EDITLENS_ORIGINS`.
- **Only your account.** On Linux the server checks which account opened each connection and
  refuses other accounts. macOS and Windows can't tell it, so there the server answers only its health
  check and the page script until a page has your key. `/editlens` opens (and prints) your page's
  address with the key after `#`, which is never sent to a server; your browser keeps it for that
  address and the page sends it with every request, the EditLens window too. A page opened another
  way says "Open this page once from Claude Code: /editlens". The key is made from a file in the
  state folder that only your account can read.
- Posting events requires a random token. The server writes the token to a `0600` file when it starts,
  and only the hooks read it.
- Messages typed on the page are accepted only from localhost pages, so another website can't send
  instructions to Claude.
- Page control starts only from Claude Code (`/editlens control`, or by itself when a session
  starts, from your setting); never from a page. Its requests need a per-run key
  that is sent only to that project's open pages.
- **Only you allow.** A permission question (page control, or a task from a paired computer) is
  allowed only in the EditLens window: a page of the live server's own address that needs a key
  only that window has, can't be framed and shares nothing with your app's window. It opens only
  as a browser window (a script has to fake the browser's headers, and the task account below
  can't connect to it at all). Through a pairing link it opens only when that computer turned on
  "Paired computers can answer questions here", and then only for its page control and the tasks
  the joined computer gave. Pages can only deny. **Always allow** lasts for that session only; it is
  never saved to a settings file. Less strict modes (Accept edits, Bypass permissions) are turned on there too, and a page can't
  change page control's permission mode setting. Claude Code's own permission questions are only
  listed on the page (by a PermissionRequest hook that never answers); you answer them in Claude
  Code.
- **Claude can't call EditLens's own approval or control endpoints.** A command or fetch from
  Claude to them, or one that reads EditLens's keys, is denied in every session. This is a
  pattern check; what stops a hidden command is that the command is itself a permission
  question, and that Allow needs the window's key. A program on this computer that runs as you can
  do what you can, as with any local tool.
- A page reads files only from the folders Claude Code sessions run in that belong to the page's
  project (`data-root`). A page that names no project, or a drive, filesystem root or home folder,
  gets no files, can't send messages or restore, and never gets page control. Hidden files,
  secret-looking files and links that lead outside the project are never shown, and `show_code`
  follows the same rules.
- **Restore** only writes a file back to a version the live server saved before one of Claude's edits.
  The request names that saved copy, never a path, and is accepted only from a page connected to the
  server for the same project.
- The page script renders every value as text and never as HTML.
