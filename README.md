# Screenshot Plus

**English** · [Русский](README.ru.md)

A GNOME Shell 50 extension that adds Flameshot-style drawing to the built-in
screenshot tool, and records the screen to AV1 on the GPU. `Print` still opens the
same native screenshot UI, now with a toolbar.

![Everything in one minute](docs/overview-en.gif)

Everything in one minute. The same as a video: [overview-en.mp4](docs/overview-en.mp4)
(AV1, recorded by the extension itself, 740 KB). The demos for each part below show the
interface in Russian; it follows the system language, see [Settings](#settings).

## Drawing

![Drawing](docs/drawing.gif)

- Pen, line, arrow, rectangle, ellipse, highlighter, text, pixelate and numbers.
- Ten colours. Width is set with a slider or the mouse wheel, and every tool keeps its
  own: a thin pen and a thick highlighter do not overwrite each other.
- A click places a number; drag instead and it gets an arrow. Numbering runs across
  all of them.
- Pixelate hides passwords and anything else that must not end up in the picture. The
  file holds only the blocks there, none of the original pixels.
- `Shift` while drawing gives exact 45° steps and squares.
- Copy and save are separate. The window closes the moment you press either, and the
  image is finished in the background. If saving fails, the image is left on the
  clipboard and a notification says so.
- Instead of the loud shutter you get a short soft click, also for screenshots taken
  with GNOME's own shortcuts. This can be changed in the settings.

## Text

![Text](docs/text.gif)

- Letter colour, outline and background are set separately, the background also with
  its opacity, height and width.
- Two handles on the sides. While you drag one, the other stays put, and the text turns
  and scales around it, smoothly and without jumps. With `Shift` the angle moves in 15°
  steps, and it snaps near level.
- The handle on top moves the text.
- Double-click edits it. Turned text stays turned and new letters run along it. Pasting
  from the clipboard works.

## Editing what is drawn

![Editing](docs/editing.gif)

The select tool (`0`) picks up any shape. Drag it, pull its handles, recolour it,
change its width with the wheel, remove it with `Delete`. A number with an arrow has
parts: the circle moves on its own and the arrow keeps pointing at the same spot, the
tip moves on its own too, and dragging the arrow itself moves everything. `Ctrl+Z`
undoes any of it.

## Selection

![Selection](docs/selection.gif)

- With any tool, pressing outside the selection starts a new one, and its corners and
  edges resize it as they do without a tool. The pointer changes, and a label next to
  it says which will happen: "New selection" or "Resize selection".
- A stray click outside does not throw the selection away.
- Drawings stay when the selection changes: whatever ends up outside is dimmed along
  with the screen. Only what is inside goes into the picture.
- The selection can span both monitors, as in the native UI. The toolbar sits on the
  monitor that holds most of the selection.

## Keys

| Key | Action |
|---|---|
| `1`–`9` | pen, line, arrow, rectangle, ellipse, highlighter, text, pixelate, number |
| `0` | select: pick up what is already drawn |
| `Ctrl+C` | copy only |
| `Ctrl+S` | save only |
| `Enter` or the round button | save and copy |
| `Ctrl+Z`, `Ctrl+Shift+Z` | undo, redo |
| `Delete` | delete the selected shape |
| `Esc` | deselect, then close |
| mouse wheel | width, text size |
| `Shift` while drawing | exact 45° and squares |

Shortcuts are bound to physical keys, so they work with any keyboard layout.

## Settings

![Settings](docs/settings.png)

Open them from the Extensions app, or with
`gnome-extensions prefs screenshot-plus@maksym`.

- **Language.** The system language by default, or English when there is no
  translation for it. Available: English, Russian, Ukrainian, German, French, Spanish,
  Portuguese, Italian, Polish, Norwegian Bokmål, Turkish, Japanese, Simplified Chinese
  and Esperanto. Translations other than English and Russian were written without a
  native speaker, so corrections are welcome: the strings are in `translations.js`.
- **Screenshot sound.** Soft click, GNOME's shutter, or none.
- **Recording codec.** AV1 or H.264.
- **Microphone.** Records sound from the default microphone along with the screen.

## Recording

The codec is chosen in the settings or with the `AV1`/`H.264` button in recording
mode. `H.264` is GNOME's own recorder, for when compatibility matters.

The microphone button next to it (and the same switch in the settings) adds sound
from the default microphone: mono AAC at 96 kbit/s, which every player handles and
which barely adds to the file. GNOME's recorder cannot record sound, so H.264 with the
microphone goes through this extension's recorder as well, on NVENC or else on the
CPU. If the microphone cannot be opened, the recording goes on without sound and a
notification says so.

For AV1 the recorder takes the first path that fits:

1. `amd-av1-dmabuf`: the AMD encoder with no frame copies. Only when the width is a
   multiple of 64 and the height of 16, otherwise it adds black bars (1920×1080
   becomes 1920×1082).
2. `nvenc-av1`: NVENC, with frames going through system memory. Sides from 200 pixels.
3. GNOME's own recorder: on any start-up failure, and for very small areas.

The recorder runs as a separate process (`recorder.js`), so if it crashes, the shell
does not. The path in use is written to the journal:
`journalctl --user -b -g 'screenshot-plus'`.

## Install and remove

```sh
git clone https://github.com/Noxam98/screenshot-plus ~/src/screenshot-plus
ln -s ~/src/screenshot-plus ~/.local/share/gnome-shell/extensions/screenshot-plus@maksym
glib-compile-schemas ~/src/screenshot-plus/schemas
gnome-extensions enable screenshot-plus@maksym   # after logging in again
```

To turn it off: `gnome-extensions disable screenshot-plus@maksym`.

## Applying code changes

Run `./reload.sh`, no new login needed. GNOME caches modules by path for the whole
session, so `extension.js` copies the code to a new folder under
`$XDG_RUNTIME_DIR/screenshot-plus` on every enable and runs it from there. A new login
is needed only when `extension.js` or `metadata.json` themselves change.

## Tests

`tests/session.sh` starts a separate GNOME Shell with no screen and its own `HOME`,
dconf and D-Bus, so the real session is left alone. `tests/ctl.sh` drives it and sends
input, `tests/stop.sh` stops it. `gjs -m tests/shapes-test.js` checks the geometry.

## License

GPL-2.0-or-later, like GNOME Shell itself. The text is in `LICENSE`.
