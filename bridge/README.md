# SL MkIII Bridge — colors + custom mappings, live

The SL MkIII only shows **custom LED colors in InControl mode**, and in that
mode every control sends a **fixed** MIDI message (not your template's mapping).
This little Node service gives you *both at once* without custom firmware:

1. It re-asserts your **color layout** on the InControl port and keeps it warm
   (so colors survive pad presses / mode nudges).
2. It **remaps** the fixed InControl messages to whatever you want and emits them
   on a **virtual MIDI port** your DAW / synth listens to.

So: your colors **and** your mappings, live — as long as the bridge is running.
(The colors still can't live on the device standalone — only firmware could do
that, and it can't. See [../docs/TEMPLATE-FORMAT.md](../docs/TEMPLATE-FORMAT.md).)

## Requirements

- Node.js 16+.
- macOS or Linux for the **virtual MIDI port** (created natively). On **Windows**
  there's no built-in virtual MIDI — install [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html),
  create a port, and set `"virtualPort"` in the config to its exact name (the
  bridge will open it as a normal output instead of creating one — see notes).

## Setup

```bash
cd bridge
npm install                 # installs @julusian/midi (prebuilt, no compiler)
node bridge.js --list       # see your MIDI port names
cp config.example.json config.json
# edit config.json: colors + mappings (see below)
node bridge.js              # runs; put the SL MkIII in InControl mode first
```

Design your colors in the [web tool](../index.html), **Save .json**, and point
the config at it: `"colors": "my-layout.json"`.

## Config

| Key           | Meaning                                                            |
| ------------- | ----------------------------------------------------------------- |
| `inputPort`   | substring matched against MIDI inputs (default `InControl`)        |
| `outputPort`  | substring matched against MIDI outputs (default `InControl`)       |
| `virtualPort` | name of the virtual port to create (macOS/Linux) or open (Windows/loopMIDI) |
| `keepAliveMs` | how often to re-send the color layout (ms; `0` disables)         |
| `clearOnExit` | turn all mapped LEDs off when you Ctrl+C                           |
| `colors`      | inline `{ "Pad 1": {hex,behavior}, ... }` **or** a path to a web-tool `.json` |
| `mappings`    | `{ "Pad 1": {type,number,channel}, ... }` — see below             |

### Mappings

Keys are InControl control names: `Pad 1`–`Pad 16`, `Knob 1`–`Knob 8`,
`Fader 1`–`Fader 8`, `Soft 1`–`Soft 24`, `Play`, `Stop`, `Record`, etc.
(full list in [`lib/incontrol.js`](lib/incontrol.js)).

```json
"Pad 1":  { "type": "note", "number": 36, "channel": 10 },
"Knob 1": { "type": "cc",   "number": 20, "channel": 1  },
"Soft 1": { "type": "drop" }
```

- `type`: `note` (pads → drum notes, velocity preserved), `cc` (value preserved),
  or `drop` (ignore).
- `number`: 0–127, `channel`: 1–16.
- Anything not listed is dropped unless you set `"passthrough": true`.

## Colors: which names?

`Pad 1`–`16`, `Soft 1`–`24`, `Fader 1`–`8`, and the transport/function buttons
(`Play`, `Stop`, `Record`, `Grid`, …). You can also use raw numeric LED ids, so a
`.json` exported from the web tool works directly.

## How it fits together

```
 SL MkIII (InControl) ──InControl in──▶ bridge ──remap──▶ Virtual port ──▶ your DAW/synth
        ▲                                  │
        └────────── color SysEx ──────────┘  (re-asserted every keepAliveMs)
```

## Tests

`npm test` runs the pure-logic unit tests (LED SysEx, InControl resolution,
remapping, config loading) — no hardware needed.
