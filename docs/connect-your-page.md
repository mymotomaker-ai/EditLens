# Connect your page

**The easy way, with no changes to your project:** in Claude Code, run **`/editlens`**.

- **Vite projects:** EditLens runs your own Vite (from your `node_modules`, with your own
  `vite.config`) with EditLens added, and prints the address to open. Everything works, including
  exact source lines when you select things on the page. The extra config is in
  `~/.claude/editlens/connect`, never in your project.
- **A plain site** (an `index.html` and no dev script): EditLens serves the folder itself, so no
  dev server is needed. Each edit shows on the page immediately. Hidden files (`.git`, `.env`) are
  never served, and it listens on 127.0.0.1 only. You can seek to any point in video and audio.
- **Anything else** (Next.js, Express, your own server): start your dev server as usual, then run
  `/editlens`. It looks where the server ran last time, then where the project's dev script or
  framework runs it (`--port`, `-p`, `PORT=` in the script or in `.env`, then 3000 for Next.js). It
  connects by itself only when it's sure the server is this project's: the port is in the project's
  dev script or `.env`, the program listening there runs from the project folder (its working
  folder on Linux and macOS, its command line on Windows), or the server responded there within the
  last 12 hours with the same page title. When none of these is true (say another project's server
  on port 3000), it asks: click **Connect localhost:3000** on the EditLens line above the prompt,
  or run `/editlens <address>`.
  If it isn't running, `/editlens` says the exact command to start it (`npm run dev`, say). If it's somewhere else, give the
  address: `/editlens http://localhost:3000`. EditLens gives you a local address (the same one each
  time for a project) that serves your app with the EditLens script added to every page. Hot reload
  still works. A site with an `index.html` keeps working when its own server stops: EditLens
  serves the folder until the server is back.
- **Python (Flask, FastAPI, Django):** start your server as usual (`flask run --debug`,
  `uvicorn main:app --reload` or `python manage.py runserver`), then run `/editlens`. EditLens
  recognizes the project from `manage.py` or its `requirements.txt` / `pyproject.toml`, finds the
  server on 5000 (Flask) or 8000 (Django, FastAPI), and gives you an address that serves your app
  with EditLens added. If the server isn't running, `/editlens` prints the command to start it.
  In any other project, 5000 and 8000 are tried last and only when they serve a web page (on a Mac,
  AirPlay uses 5000). To use your server's own address instead, add the script tag to your base
  template between marker comments:
  ```html
  <!-- editlens:start -->
  <script src="http://127.0.0.1:4317/live.js" data-root="/path/to/your/project"></script>
  <!-- editlens:end -->
  ```
  `/editlens stop remove` removes it again. Editing a `.py` route highlights the parts of the page
  that route fills.
- With **Connect when Claude Code starts** on (the default), all of this happens by itself when a
  session starts.
- It stops with **`/editlens stop`**, or by itself when the Claude Code session that
  connected it ends. Your own dev server, if you run one, is never touched.

**Or add it to your files** in one of the ways below. Each one is for development only. Put the
added lines between `editlens:start` and `editlens:end` comments, each on its own line, so they
can be taken out later:

```js
// editlens:start
import editlens from '/path/to/editlens/integrations/vite.mjs';
// editlens:end
export default defineConfig({
  plugins: [
    react(),
    // editlens:start
    editlens(),
    // editlens:end
  ],
});
```

**`/editlens stop remove`** then removes every marked block (a copy of each file is
kept first), including blocks marked `live-edits:start` and `live-edits:end` (the old name). Lines without markers are listed, and Claude removes them only if you say so.

Reminders, so EditLens doesn't stay in your project by accident:

- A `git commit` (by Claude, in Claude Code or page control) whose changes add EditLens to a file
  asks first, with **Deny** to keep it out of the commit.
- The EditLens line above Claude Code's prompt shows `! in vite.config.js` while a project file
  loads EditLens, and the Details pane lists the lines.
- The Vite plugin only runs in `vite dev` (`apply: 'serve'`), so a production build never includes
  it, even if it is left in.

**Vite** (`vite.config.js`):
```js
import editlens from '/path/to/editlens/integrations/vite.mjs';
export default defineConfig({ plugins: [react(), editlens()] });
```

**Next.js** (`app/layout.tsx`):
```tsx
import Script from 'next/script';
// inside <body>
{process.env.NODE_ENV === 'development' && <Script src="http://127.0.0.1:4317/live.js" data-root="/path/to/your/project" />}
```

**Express / Connect:**
```js
if (process.env.NODE_ENV !== 'production') app.use(require('/path/to/editlens/integrations/middleware.js')());
```

**With a strict Content-Security-Policy:** give the Vite plugin or the middleware a `nonce`
option and it is added to the EditLens script tag: `editlens({ nonce: 'abc' })` for Vite, and for
Express a string or a function that gets the request, such as `({ nonce: (req) => req.cspNonce })`.
The policy must also allow the live server's address in `script-src` and `connect-src`
(`http://127.0.0.1:4317`, or the port you set), and `'unsafe-inline'` in `style-src` for the
panel's styles.

**Anything else**, including plain HTML: add this tag. Put it in `<head>`, or anywhere before your
app's scripts, so it can record which API calls fill the page:
```html
<script src="http://127.0.0.1:4317/live.js" data-root="/path/to/your/project"></script>
```
`data-root` is your project folder. Without it the page only shows edits: it can't send messages,
open files or take page control.

Inside Claude Code, `/editlens status` shows what is connected and any EditLens lines in your
project files.
