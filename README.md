# Novation SL MkIII — LED Colour Customizer

A browser-based tool to set **custom RGB colours** on the Novation SL MkIII's
pads, buttons and fader LEDs — the thing **Novation Components doesn't let you
do**, even though the hardware fully supports it.

It talks to the keyboard live over the **Web MIDI API** using the SL MkIII's
documented **InControl SysEx** protocol, so you can click a pad, pick a colour,
and watch it light up instantly. No install, nothing to sign up for.

![The customizer editing SL MkIII LEDs live](assets/screenshot.png)

## What's possible (short answer)

Yes — you can set **arbitrary colours**. The SL MkIII accepts a SysEx "Set LED"
command carrying a 7-bit-per-channel RGB value for every pad, soft button,
transport button and fader LED. Each LED can be **solid**, **flashing**, or
**pulsing**. Components only offers a fixed template workflow and hides this;
the [Programmer's Reference Guide](docs/PROTOCOL.md) documents the raw messages,
and this app implements them.

The one thing that's *not* cleanly addressable is the keybed "light guide" —
its LED IDs overlap other controls in the official spec, so it's intentionally
left out. See [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Quick start

1. Connect the SL MkIII by USB and press the **InControl** button on the unit.
2. Open the app:
   - **Easiest:** serve the folder and open it in Chrome/Edge/Opera:
     ```bash
     python3 -m http.server 8000
     # then visit http://localhost:8000
     ```
   - Opening `index.html` directly (`file://`) also works in most Chromium
     builds, but a local server is the reliable path for Web MIDI + SysEx.
3. Click **Connect MIDI**, grant the SysEx permission, and pick the
   **InControl** output port.
4. Click any control, choose a colour. With **Live send** on, it updates the
   hardware immediately.

## Features

- Visual editor for all **68** addressable LEDs, grouped by section.
- Full RGB colour picker + hex entry + one-click preset swatches.
- Per-LED **solid / flash / pulse** mode.
- Multi-select (Shift/Ctrl-click) to colour many controls at once.
- **Live send** to hardware, plus **Send all**, **All off**, and **Rainbow**.
- **Save/Load** your layout as `.json`.
- **Export `.syx`** (a Standard MIDI SysEx file you can replay from any SysEx
  utility) or **Copy SysEx** hex to the clipboard.
- Layout autosaves to the browser between sessions.

## Templates & LED colours (important)

A common question: *can I bake custom LED colours into the stored **templates**
(the ones Components saves as `.syx`)?*

**Short answer: no — the template format doesn't carry LED colours.** I fully
reverse-engineered the template `.syx` format (see
[docs/TEMPLATE-FORMAT.md](docs/TEMPLATE-FORMAT.md)) and verified a bit-exact
round-trip. Templates store control **mappings** (MIDI type, CC/note, channel,
value range) — every colour-looking `7F` byte is actually a control's max value
(127). Novation's User Guide confirms it. That's precisely why Components has no
template LED-colour UI. Custom colours are only controllable **live** via the
InControl SysEx API — which is what the main tool does.

### Template Lab (experimental)

Because I only had default templates and no hardware, I can't be 100% certain
the firmware doesn't read *some* byte as colour. So there's a second page,
[**Template Lab**](template-lab.html), that lets you **test it yourself**:

![Template Lab probing pad value bytes](assets/template-lab.png)

- Load a template `.syx`, and it's decoded into all 77 control records (with a
  bit-exact round-trip check, so untouched bytes stay identical).
- Poke each pad's value bytes, or hit **Probe: rainbow pads** to write distinct
  values to every pad, then **Export edited .syx**.
- Load it onto the SL MkIII and watch the pads. If any change colour, that byte
  drives the LEDs and I'll build a real editor around it; if nothing changes, it
  confirms colours aren't in templates.

Everything runs client-side; [`js/template.js`](js/template.js) is the codec and
[`js/template-lab.js`](js/template-lab.js) the UI.

## Colours *and* your own mappings, live — the Bridge

Custom colours only exist in InControl mode, where controls send *fixed*
messages instead of your template's mapping. The [**`bridge/`**](bridge/) Node
service reconciles that: it holds your colours on the device (re-asserting them
so they stick) **and** remaps the fixed InControl messages to whatever you want,
on a virtual MIDI port your DAW/synth reads. Colours + custom mappings at the
same time, no firmware — as long as the bridge is running. See
[bridge/README.md](bridge/README.md).

```bash
cd bridge && npm install
node bridge.js --list          # find your ports
cp config.example.json config.json   # edit colours + mappings
node bridge.js                 # SL MkIII in InControl mode
```

## Browser support

Requires the **Web MIDI API with SysEx**: Chrome, Edge, and Opera (desktop).
Safari and Firefox do not currently support Web MIDI SysEx — use one of the
above, or use the exported `.syx` file with a native SysEx tool.

## How it works

- [`js/sysex.js`](js/sysex.js) — builds the `F0 00 20 29 02 0A 01 03 …` LED
  messages and handles 8-bit ⟷ 7-bit colour conversion.
- [`js/controls.js`](js/controls.js) — the map of every LED and its SysEx id.
- [`js/midi.js`](js/midi.js) — Web MIDI wrapper (port discovery + send).
- [`js/app.js`](js/app.js) — the editor UI, live sending and import/export.
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — the full message reference.

## Disclaimer

Not affiliated with or endorsed by Novation / Focusrite. "Novation" and
"SL MkIII" are trademarks of their respective owners. Protocol details come
from Novation's publicly published Programmer's Reference Guide. Use at your
own risk.

## License

MIT — see [LICENSE](LICENSE).
