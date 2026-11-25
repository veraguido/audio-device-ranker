# Audio Device Ranker

A GNOME Shell extension that **remembers your audio devices and automatically
switches to the one you prefer** whenever it (re)connects.

Plug in your USB DAC, turn on your Bluetooth headphones, dock your laptop — the
extension recognizes each device, keeps a ranked priority list for inputs and
outputs separately, and makes the highest-ranked connected device the default.
No more diving into the sound settings every time you reconnect something.

## What it does

- **Recognizes and stores devices.** Every output (playback) and input
  (recording) device GNOME sees is remembered, even after it disconnects.
- **Separate input / output rankings.** Microphones and speakers/headphones are
  ranked independently in their own sections.
- **Drag-to-rank.** A reorderable list in the preferences lets you rank devices
  by dragging them (or with up/down arrows). Top of the list = highest priority.
- **Persistent.** Rankings are stored in GSettings, so they survive
  disconnects, reconnects, reboots and extension updates. A device is matched by
  its description + origin, so the same headphones keep their rank every time.
- **Automatic switching.** When a device connects, if it outranks the currently
  active device it becomes the default automatically. Example: rank your
  Bluetooth headphones first, and reconnecting them instantly makes them the
  default output.
- **Keyboard shortcuts.** Separate, configurable shortcuts cycle the output and
  the input to the next connected device in rank order (wrapping around). An
  on-screen popup shows which device is now active.
- **Hide devices from GNOME Shell.** Switch a device off in the preferences and
  it disappears from the Quick Settings *Sound Output* / *Sound Input* menus.
  Hidden devices are also skipped by auto-switching and the cycle shortcuts,
  and if the active device gets hidden the extension moves to the best visible
  one. (GNOME Settings' Sound panel still lists every device.)

### How automatic switching decides

When a device connects, the extension:

1. Looks up its rank in the relevant (input or output) list.
2. Looks up the rank of the currently active device.
3. Switches **only if** the newly connected device has a better (lower-numbered)
   rank than the active one — or the active device isn't ranked at all.

Unranked devices are never switched to automatically, and a lower-ranked device
connecting never steals focus from a higher-ranked one you're already using.
Automatic switching can be turned off entirely from the preferences.

## Requirements

- GNOME Shell 45 – 51 (uses the modern ESM extension API).
- PulseAudio or PipeWire (the standard GNOME audio stack), accessed through the
  bundled `Gvc` mixer library.

## Installation

From the source directory:

```sh
make install     # copy files + compile the settings schema
make enable      # enable the extension (after reloading the shell)
```

After `make install`, reload GNOME Shell so it picks up the new extension:

- **X11:** press `Alt`+`F2`, type `r`, press `Enter`.
- **Wayland:** log out and back in.

Then `make enable` (or toggle it on in the *Extensions* / *Extension Manager*
app).

### Other Make targets

| Target            | Description                                            |
| ----------------- | ------------------------------------------------------ |
| `make install`    | Install into `~/.local/share/gnome-shell/extensions`.  |
| `make uninstall`  | Remove the installed extension.                        |
| `make reinstall`  | `uninstall` then `install`.                            |
| `make enable`     | Enable the extension.                                  |
| `make disable`    | Disable the extension.                                 |
| `make prefs`      | Open the preferences window.                           |
| `make pack`       | Build a distributable `.shell-extension.zip`.          |
| `make clean`      | Remove build artifacts.                                |

## Usage

1. Open the preferences (`make prefs`, or via the Extensions app).
2. Connect/switch between your audio devices once so they get recognized — they
   appear in the **Output Devices** and **Input Devices** lists.
3. Drag devices into your preferred order (or use the up/down arrows). The
   device at the top of each list is the one the extension will prefer.
4. Use the trash icon to forget a device you no longer care about.
5. Use the switch on a device row to hide it from the GNOME Shell sound menu.
6. Click a **Shortcut** row and press a key combination to set the cycle
   shortcut (Backspace removes it, Escape cancels).
7. Leave **Auto-switch on connect** enabled to have the default device follow
   your ranking automatically.

## How it works

The extension opens a `Gvc.MixerControl` — the same audio-control library GNOME
Shell itself uses — and listens for `output-added` / `input-added` events. Each
device is identified by a stable key built from its description and origin (e.g.
*"WH-1000XM4 — Bluetooth"*), which stays constant across reconnects.

Rankings are persisted as JSON arrays in two GSettings keys
(`output-devices`, `input-devices`) under the schema
`org.gnome.shell.extensions.audio-device-ranker`, with index 0 being the highest
priority; an entry with `"hidden": true` is hidden from the Quick Settings
menu. The cycle shortcuts live in `cycle-output-shortcut` /
`cycle-input-shortcut`. The preferences window and the running extension both read and write
those keys, so newly discovered devices show up in the preferences live.

## Project layout

```
.
├── extension.js     # device detection, persistence and auto-switching
├── prefs.js         # drag-to-rank preferences UI (GTK4 / libadwaita)
├── metadata.json    # extension metadata
├── stylesheet.css   # (placeholder — no panel UI)
├── schemas/         # GSettings schema
├── Makefile         # install / uninstall / pack helpers
└── README.md
```

## License

Released under the GNU GPL v2.0 or later, in keeping with GNOME Shell extensions.
