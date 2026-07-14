# SL MkIII LED Control — Protocol Reference

Everything here is derived from the **Novation SL MkIII Programmer's Reference
Guide**. The hardware *does* support fully custom RGB LED colors — Novation
Components simply doesn't expose it. You drive it yourself over MIDI.

## Prerequisites

- Send all messages to the **InControl** USB MIDI port (the SL MkIII exposes
  several ports; the LED API only listens on the InControl one).
- The unit must be in **InControl view** — press the physical **InControl**
  button, or your DAW/host puts it there.

## Number conventions

- MIDI channels are 1–16.
- Color components sent to the device are **7-bit: 0–127** per channel (not
  0–255). This app scales `#RRGGBB` down with `round(v * 127 / 255)`.

## 1. RGB LED color (SysEx) — the flexible method

```
F0 00 20 29 02 0A 01 03 <ledId> <behavior> <R> <G> <B> F7
```

| Byte(s)            | Value                | Meaning                          |
| ------------------ | -------------------- | -------------------------------- |
| `F0`               | 240                  | Start of SysEx                   |
| `00 20 29`         | 0 32 41              | Novation manufacturer ID         |
| `02 0A 01`         | 2 10 1               | SL MkIII device / model          |
| `03`               | 3                    | "Set LED" command                |
| `<ledId>`          | see table below      | Which LED                        |
| `<behavior>`       | `01`/`02`/`03`       | Solid / Flash / Pulse            |
| `<R> <G> <B>`      | 0–127 each           | Color components                |
| `F7`               | 247                  | End of SysEx                     |

- **Solid (`01`)** — steady color.
- **Flash (`02`)** — alternates between the LED's current *solid* color and
  this color, a square wave synced to the beat. (Set a solid color first.)
- **Pulse (`03`)** — ramps this color between dim and bright over two beats.

Example — set Pad 1 (id 38) to pure red, solid:
`F0 00 20 29 02 0A 01 03 26 01 7F 00 00 F7`

## 2. Palette color (Note / CC) — the simple method

Instead of SysEx you can pick one of 128 fixed palette colors by sending a
Note-On (pads/keys) or CC (buttons/faders) whose **channel selects the
behavior**:

| Behavior | Channel | Status (CC / Note) |
| --------- | ------- | ------------------ |
| Solid     | 16      | `BF` / `9F`        |
| Flash     | 2       | `B1` / `91`        |
| Pulse     | 3       | `B2` / `92`        |

- Data byte 1 = the control's **CC/Note index** (not the LED SysEx id).
- Data byte 2 = palette color index (0–127, from the guide's Color Table).

Example — `BF 29 48`: set the LED above Fader 1 to palette color 0x48 (red).

This app uses method 1 (SysEx RGB) exclusively because it allows arbitrary
colors; method 2 is documented here for completeness.

## LED SysEx IDs

| Control group         | Count | LED SysEx IDs (decimal) |
| --------------------- | ----- | ----------------------- |
| Pads 1–16             | 16    | 38–53                   |
| Soft Buttons 1–24     | 24    | 4–27                    |
| Fader LEDs 1–8        | 8     | 54–61                   |
| Record / Rewind / FF / Stop / Play / Loop | 6 | 32 / 33 / 34 / 35 / 36 / 37 |
| Scene Launch Top / Bottom | 2 | 2 / 3                 |
| Pads Up / Down        | 2     | 0 / 1                   |
| Right Soft Up / Down  | 2     | 28 / 29                 |
| Track Left / Right    | 2     | 30 / 31                 |
| Screen Up / Down      | 2     | 62 / 63                 |
| Grid / Options / Duplicate / Clear | 4 | 64 / 65 / 66 / 67 |

### A note on the keybed "Light Guide"

The guide lists per-key LEDs (Key LEDs 1–61) with SysEx IDs **54–114**, which
are the **same ids** as the Fader LEDs (54–61) and function-button LEDs (62–67).
So the light guide cannot be driven independently of those LEDs over this API.
The Studio sequencer runtime has the code to light keys during playback (red
while auditioning/holding a step) but it is **off by default** for this reason;
enable it with `SLMK.studioRuntime.setKeyGuide(true)` to experiment (base note
`LOW_NOTE` in `studio-runtime.js`). The color editor omits the keybed entirely.

## Screens (InControl notification API)

The SL MkIII has **5 physical screens**: screens 1–4 sit under the knobs (two
knobs + two Part labels each) and the 5th is the center notification screen. In
the protocol these are **9 columns** — columns 0–7 are the eight knob slots
(two per physical screen 1–4) and **column 8 is the 5th screen**. Set a
**layout** first, then set **properties** on the objects within each column.

```
Layout:    F0 00 20 29 02 0A 01 01 <layout> F7          # 0 empty, 1 knob, 2 box
Property:  F0 00 20 29 02 0A 01 02 <col> <type> <obj> <data…> F7
```

| Property `type` | Meaning | Data |
| --------------- | ------- | ---- |
| `01` | Text  | 7-bit ASCII, ≤9 chars, NUL-terminated |
| `03` | Value | one byte 0–127 (drives the knob arc) |
| `04` | RGB   | `<R> <G> <B>`, 0–127 each |

**Objects within a column** (knob layout):

| `obj` | Position | Used for |
| ----- | -------- | -------- |
| `0` | Top row  | knob name (text) / top-bar color |
| `1` | Knob icon | the value arc (value) + its number (text) + icon color (RGB) |
| `2` | Below the knob | text / bottom-bar color |
| `3` | Bottom edge | the lowest text row (labels hug the bottom here) |

This app tints the top (`obj 0`) and bottom (`obj 2`) bars for at-a-glance
color coding, keeps Part labels on the bottom row (`obj 3`), and draws a live
two-row playhead graphic across the 5th screen's lower half (`obj 2`/`obj 3`).
Each column's bottom label is tinted its own Part's color (the selected Part
brighter); the knob-name top bar shows only when that knob is enabled.

**5th screen (column 8)** object map (deduced from hardware — text and color
of one object can render in different screen regions):

| `obj` | Text | Color bar |
| ----- | ---- | ---------- |
| `0` | knob-bank name (row above the part name) | **left edge** = selected Part color |
| `1` | Part name | — |
| `2` | "Mute" / button-bank name (right, top) | **right-top edge** = avg of the top button row |
| `3` | "Solo" (right, bottom) | **right-bottom edge** = avg of the bottom button row |
| `4` | 8-pattern chain strip on the **very top edge** (full width) | — |
| `5` | transient overlay (knob/fader value, or paged-to Part names) | tint = control color |

The pattern strip uses `#` = current/playing, `+` = chained, `-` = unchained.
Per-character color isn't possible (a text object takes one color), so the
strip distinguishes its three states by glyph.

## Device inquiry (identify the unit)

Standard MIDI Device Inquiry works:

```
Send:  F0 7E 7F 06 01 F7
Reply: F0 7E <id> 06 02 00 20 29 <fc1 fc2> <fm1 fm2> <R1 R2 R3 R4> F7
```

`00 20 29` confirms Novation; the family/member and revision bytes identify the
SL MkIII and its firmware.
