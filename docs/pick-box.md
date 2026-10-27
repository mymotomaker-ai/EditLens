# Select things on the page

Show Claude exactly which element, area, or code you mean, instead of describing it.

## Select an element, an area, or code

- Press **Alt+Shift+P** or click the arrow button in the panel header. Hover outlines an element and
  shows where it is written (for example `StatCard · App.jsx:9`).
- **Click** an element to attach it. **Shift+click** attaches several. **Drag** a box to attach an
  area. Press **Esc** to stop.
- In the code view, **select some lines** and click **Attach lines… for Claude**.
- Each attachment gets a green number on the page and a label above the message box. Click a label to
  scroll to it, or × to remove it. Type your message and send. The message can also be empty.
- **Images.** Paste a screenshot into the message box, or click **Attach** (the paperclip after the
  permission mode) to choose PNG, JPEG or WebP files: up to 3 per message, 5 MB each.
- **A note next to it.** After a pick, a small message box opens next to the item. Type a note and
  press **Add** (or Enter): it goes into the panel's message box on its own line, after the pick's
  number ("2 Make it green"). Nothing is sent until you press Send there. Esc closes the box and keeps
  what you typed. Shift+click more items first to write one note for all of them. Clicking an item
  picked before opens the box at it again. Small screens and
  phones use the panel's box. Steps with pictures: [A note next to what you pick](#a-note-next-to-what-you-pick).
- Claude receives, for each number: the source file and line, the component, the visible text, a
  selector, the size and position, and a few computed styles. For code, it gets the lines themselves.
- Claude can answer by highlighting the same numbers (`highlight_on_page` with `{ "marker": 2 }`).

Where the file and line come from, best first:

1. The Vite plugin tags every HTML element written in JSX/TSX with `data-editlens-src="src/App.jsx:9:5"`
   during `vite dev` only. It uses your project's own `@babel/core`, which `@vitejs/plugin-react`
   installs. Turn it off with `editlens({ source: false })`.
2. React 18 development info. In Vite apps without the tag, its line numbers are shifted, so
   Claude is told to find the element in the file.
3. React 19, Vue and Svelte: the component's file (Svelte also gives the line).
4. Otherwise: the component name, text and selector, which are usually enough to search for.

## A note next to what you pick

After you select something on the page, a small message box opens next to it. Type what you want
changed there; **Add** puts it in the panel's message box, where you send it. Nothing is sent from
the small box.

### Step 1. Pick something

Press the pointer button in the panel (or **Alt+Shift+P**), then click an element. It gets a green number,
and the box opens just below it, pointing at it. It names what you picked.

![The box below a picked heading](pick-box/pick-box-1-open.png)

### Step 2. Type a note

![A note typed in the box](pick-box/pick-box-2-type.png)

**Shift+Enter** starts a new line. You can also use the mic: [docs/dictation.md](dictation.md).

### Step 3. Add it to your message

Press **Add** or **Enter**. The note goes into the panel's message box on its own line, after the
pick's number ("1 Make the heading bolder"); the number is marked in green. Nothing is sent: change
the message if you like, then press **Send**.

![The note in the panel's message box](pick-box/pick-box-3-added.png)

### More than one item

**Shift+click** more items before you type: one note for all of them. The box shows how many; point
at it to see the list, and × removes one.

![One note for two picks](pick-box/pick-box-4-two.png)

A dragged area gets the box beside it. Near the bottom of the window the box opens above the item.
Clicking an item you picked before opens the box at it again, for another note with its number.

![The box beside a dragged area](pick-box/pick-box-5-area.png)

![The box above an item near the bottom](pick-box/pick-box-6-above.png)

### Closing it

**Esc** or a click elsewhere closes the box and keeps what you typed (it goes into the panel's
message box). On phones and narrow windows the panel's message box is used instead.

### The setting

More (⋯) > **Message box next to what you pick**, or Settings. Off: you type in the panel as before.

![The switch in the More menu](pick-box/pick-box-7-setting.png)
