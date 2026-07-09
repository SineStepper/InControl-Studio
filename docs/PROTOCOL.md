# SL MkIII LED Control — Protocol Reference

Everything here is derived from the **Novation SL MkIII Programmer's Reference
Guide**. The hardware *does* support fully custom RGB LED colours — Novation
Components simply doesn't expose it. You drive it yourself over MIDI.

## Prerequisites

- Send all messages to the **InControl** USB MIDI port (the SL MkIII exposes
  several ports; the LED API only listens on the InControl one).
- The unit must be in **InControl view** — press the physical **InControl**
  button, or your DAW/host puts it there.

## Number conventions

- MIDI channels are 1–16.
- Colour components sent to the device are **7-bit: 0–127** per channel (not
  0–255). This app scales `#RRGGBB` down with `round(v * 127 / 255)`.

## 1. RGB LED colour (SysEx) — the flexible method

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
| `<R> <G> <B>`      | 0–127 each           | Colour components                |
| `F7`               | 247                  | End of SysEx                     |

- **Solid (`01`)** — steady colour.
- **Flash (`02`)** — alternates between the LED's current *solid* colour and
  this colour, a square wave synced to the beat. (Set a solid colour first.)
- **Pulse (`03`)** — ramps this colour between dim and bright over two beats.

Example — set Pad 1 (id 38) to pure red, solid:
`F0 00 20 29 02 0A 01 03 26 01 7F 00 00 F7`

## 2. Palette colour (Note / CC) — the simple method

Instead of SysEx you can pick one of 128 fixed palette colours by sending a
Note-On (pads/keys) or CC (buttons/faders) whose **channel selects the
behaviour**:

| Behaviour | Channel | Status (CC / Note) |
| --------- | ------- | ------------------ |
| Solid     | 16      | `BF` / `9F`        |
| Flash     | 2       | `B1` / `91`        |
| Pulse     | 3       | `B2` / `92`        |

- Data byte 1 = the control's **CC/Note index** (not the LED SysEx id).
- Data byte 2 = palette colour index (0–127, from the guide's Colour Table).

Example — `BF 29 48`: set the LED above Fader 1 to palette colour 0x48 (red).

This app uses method 1 (SysEx RGB) exclusively because it allows arbitrary
colours; method 2 is documented here for completeness.

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
**overlaps** the fader and function IDs above. The Studio sequencer runtime
(`js/studio-runtime.js`) drives these via the same RGB SysEx command to light
the keys as the sequence plays (and red while auditioning/holding a step) — but
because of the id overlap this needs on-hardware confirmation, and the base note
(`LOW_NOTE`) may need adjusting per keyboard size. The colour editor still omits
the keybed so it can never send an ambiguous id from the mapping UI.

## Device inquiry (identify the unit)

Standard MIDI Device Inquiry works:

```
Send:  F0 7E 7F 06 01 F7
Reply: F0 7E <id> 06 02 00 20 29 <fc1 fc2> <fm1 fm2> <R1 R2 R3 R4> F7
```

`00 20 29` confirms Novation; the family/member and revision bytes identify the
SL MkIII and its firmware.
