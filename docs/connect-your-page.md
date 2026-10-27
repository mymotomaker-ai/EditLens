# Connect your page

To see Claude's changes, EditLens must connect to your website in the browser. This page shows how.

## The easy way: `/editlens`

In Claude Code, enter **`/editlens`**. EditLens finds your website and shows an address. Open that address in your
browser. You don't need to change your project.

With the **Connect when Claude Code starts** setting on (the default), this happens by itself when a session
starts.

To disconnect, enter **`/editlens stop`**. EditLens also disconnects when the Claude Code session that connected it
ends. EditLens never stops or changes your own dev server.

What `/editlens` does depends on your project:

### Vite projects

EditLens runs your own Vite, with your own `vite.config`, and adds EditLens to it. Everything works, including the
exact source lines when you select parts of the page. The extra settings are saved in
`~/.claude/editlens/connect`, never in your project.

### Plain websites

A plain website is a folder with an `index.html` file and no dev script. EditLens shows the folder itself, so you
don't need a dev server. Each change appears on the page immediately.

EditLens never shows hidden files (`.git`, `.env`), and only your own computer can open the address.

### Next.js, Express, and other dev servers

1. Start your dev server as usual, for example with `npm run dev`.
2. Enter `/editlens`.

EditLens looks for your server where it ran last time, and then where the project's dev script runs it (`--port`,
`-p`, or `PORT=` in the script or in `.env`, then port 3000 for Next.js).

EditLens connects by itself only when it is sure the server belongs to this project. If it isn't sure, for example
when another project's server uses port 3000, it asks you. Select **Connect localhost:3000** on the EditLens line
above the prompt, or enter `/editlens <address>`.

- If your server isn't running, `/editlens` shows the command to start it.
- If your server uses another address, enter it: `/editlens http://localhost:3000`.

EditLens gives you its own address for your website, with EditLens added to every page. The address stays the same
for each project. Hot reload still works. If your site has an `index.html` file and its server stops, EditLens shows
the folder until the server starts again.

### Python (Flask, FastAPI, Django)

1. Start your server as usual, for example `flask run --debug`, `uvicorn main:app --reload`, or
   `python manage.py runserver`.
2. Enter `/editlens`.

EditLens finds the project from `manage.py`, `requirements.txt`, or `pyproject.toml`. It looks for the server on port
5000 (Flask) or 8000 (Django and FastAPI). When you change a `.py` route, EditLens highlights the parts of the page
that the route fills.

To use your server's own address instead, add this tag to your base template:

```html
<!-- editlens:start -->
<script src="http://127.0.0.1:4317/live.js" data-root="/path/to/your/project"></script>
<!-- editlens:end -->
```

## Add EditLens to your files yourself

You can also add EditLens to your project files. Use this for development only.

Put the added lines between `editlens:start` and `editlens:end` comments, each on its own line. EditLens can then
find and remove them later:

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

To remove them, enter **`/editlens stop remove`**. EditLens saves a copy of each file first. It also removes blocks
marked `live-edits:start` and `live-edits:end` (the old name). EditLens lists lines without these comments, and
Claude removes them only if you say so.

### Vite (`vite.config.js`)

```js
import editlens from '/path/to/editlens/integrations/vite.mjs';
export default defineConfig({ plugins: [react(), editlens()] });
```

The Vite plugin runs only in `vite dev`, so a production build never includes EditLens.

### Next.js (`app/layout.tsx`)

```tsx
import Script from 'next/script';
// inside <body>
{process.env.NODE_ENV === 'development' && <Script src="http://127.0.0.1:4317/live.js" data-root="/path/to/your/project" />}
```

### Express or Connect

```js
if (process.env.NODE_ENV !== 'production') app.use(require('/path/to/editlens/integrations/middleware.js')());
```

### Any other website, including plain HTML

Add this tag in `<head>`, before your app's scripts:

```html
<script src="http://127.0.0.1:4317/live.js" data-root="/path/to/your/project"></script>
```

`data-root` is your project folder. Without it, the page only shows changes. It can't send messages, open files, or
use page control.

### Script tag options

| Attribute | Default | What it does |
| --- | --- | --- |
| `data-root` | None. Vite, the EditLens address, and the middleware set it | Your project folder. Needed to send messages, open files, restore, and use page control. A drive, the file system root, or your home folder is ignored |
| `data-panel` | Your last choice, or `open` | `open`, `min`, or `hidden` |
| `data-reload` | `auto` | For pages without hot reload: `auto`, `morph` (never reload the whole page), `full`, or `off` |
| `data-theme` | The page's theme, or your computer's | `light` or `dark` |
| `data-settle` | `600` | Milliseconds to wait for the page to update before highlighting |

### Sites with a strict Content Security Policy

Give the Vite plugin or the middleware a `nonce` option, and EditLens adds it to its script tag:

- Vite: `editlens({ nonce: 'abc' })`
- Express: a string, or a function that gets the request, such as `({ nonce: (req) => req.cspNonce })`

The policy must also allow `http://127.0.0.1:4317` (or the port you set) in `script-src` and `connect-src`, and
`'unsafe-inline'` in `style-src` for the panel's styles.

## So EditLens doesn't stay in your project by mistake

- If a `git commit` would add EditLens to a file, EditLens asks first. Select **Deny** to keep it out of the commit.
- While a project file loads EditLens, the EditLens line in Claude Code shows a warning such as
  `! in vite.config.js`. The Details pane lists the lines.

To see what is connected and any EditLens lines in your files, enter `/editlens status`.
