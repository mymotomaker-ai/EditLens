# Dictation: speak instead of typing

The panel's message box and the box next to a pick have a **mic**. Press it (or **Ctrl+Shift+Space**
in the box) and speak. Your browser turns your voice into text. Nothing is ever sent by itself: you
read the text, change it if you like, and press Send.

## Step 1. Press the mic and choose where your voice goes

The first time, a card asks where your voice is turned into text.

- **On this device only** (chosen at first): it stays on your computer. Chrome downloads its speech
  model once; the button says **Download and start**.
- **Online**: the browser sends the audio to its maker (Google for Chrome) to turn it into text.

![The first-use card above the mic: On this device only, or Online](dictation/dictation-1-first-use.png)

Edge and Safari can only do it online. Their card says where the audio goes and that nothing else
from the page is sent; press **Allow** to continue.

![The card in a browser that does it online only](dictation/dictation-4-online.png)

Then the browser asks once for the microphone.

## Step 2. Speak

The box gets a red ring, the mic becomes a red **Stop** pill and a line above the box says
**Listening · on this device** (or **online**). Words still being heard are grey; they turn normal
when the browser is sure of them. They go in at the cursor and never replace what you typed, and you
can keep typing while it listens.

![Listening: grey words still being heard after the typed text](dictation/dictation-2-listening.png)

![The same in dark colors](dictation/dictation-2-listening-dark.png)

## Step 3. Stop

Any of these stops it: **Esc**, the **Stop** pill, **Send**, or a minute with no words. Send never
sends the grey words.

## In the box next to a pick

The pick box has its own mic before **Add**. **Esc** stops listening first and keeps the box open;
**Add** (or Enter) puts the note in the panel's message box, without the grey words.

![Dictating a note in the box next to a pick](dictation/dictation-3-pick-box.png)

## When there is no mic

The mic stays, grey, and pressing it says why:

- **Firefox** (and some other browsers) can't turn speech into text.
- **A plain IP address** (http://192.168…) isn't a secure page: open the page on localhost, or
  through the SSH tunnel `/editlens` prints.
- **The microphone is blocked** for the page, or the site's Permissions-Policy turns it off: allow it
  in the address bar.

![The grey mic's card in a browser without speech input](dictation/dictation-5-unavailable.png)

Your computer's own dictation always works in both boxes: **Win+H** on Windows, **Fn** twice on a Mac,
the mic key on a phone keyboard. In Claude Code's terminal, `/voice` does the same.

## The setting

Settings > **Dictation** (or `/config`, search "editlens"):

- **On this device** (default): only where the browser can do it on your computer.
- **Allow online**: the browser may send the audio to its maker.
- **Off**: no mic button.

![Settings: Dictation](dictation/dictation-6-setting.png)
