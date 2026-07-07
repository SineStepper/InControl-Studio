# SL MkIII Template `.syx` Format (reverse-engineered)

This documents the template dump format that Novation Components saves and
transmits — reverse-engineered from real exports and **verified by bit-exact
round-trip** (decode → re-encode reproduces the original file byte-for-byte).

> **Bottom line on colours:** templates store control **mappings**, not LED
> colours. The User Guide is explicit: *"A Template contains mapping data for:
> 16 Rotary Knobs, 16 Pads (both hit and pressure), 8 Faders, 16 Buttons…"*.
> No RGB/palette colour field is present. See "Colour analysis" below.

## Container

A dump is a sequence of SysEx messages, each `F0 … F7`, all sharing:

```
F0 00 20 29 02 0A 03 <cmd> …
         │        │    └ 01 = start · 02 = data chunk · 03 = end
         │        └ 03 = template  (note: 01 = live InControl, see PROTOCOL.md)
         └ Novation manufacturer ID
```

A typical single-template file is: one `01` start message, ~14 `02` data
chunks, one `03` end message.

### Data chunks (`cmd = 02`)

The template body is spread across the `02` chunks. Within each such message the
**encoded payload begins at byte offset `0x13`** and runs until the closing
`F7`. Byte `0x0F` carries the chunk's sequence index.

### 7-to-8 bit encoding

MIDI SysEx data bytes must be 0–127, so the 8-bit body is packed as:

```
[ d0 d1 d2 d3 d4 d5 d6 ][ MSB ]   ← repeat
```

`MSB` bit *k* = bit 7 of `dk`. A trailing partial group (< 7 bytes) is emitted
with **no** MSB byte. To decode: drop the MSB byte from each group, OR its bits
back into the high bit of the 7 data bytes.

### End message (`cmd = 03`) — body checksum

The `03` message carries a **CRC-32 of the decoded body** in its trailing 8
bytes (before `F7`), stored as 8 nibbles, most-significant first:

```
… 02 00 <n0 n1 n2 n3 n4 n5 n6 n7> F7      crc = (n0<<28)|(n1<<24)|…|n7
```

It's the standard IEEE/zlib CRC-32 (`poly 0xEDB88320`, init & final-xor
`0xFFFFFFFF`) over the entire decoded body (header + all 77 records). **This must
be recomputed after any edit** or Novation Components rejects the file on import.
Verified: both sample files' stored nibbles equal `zlib.crc32(body)`.

## Decoded body

```
offset 0x00 : 50 0D 01 00            magic / version
offset 0x04 : 16 bytes               template name (space-padded ASCII)
offset 0x14 : control records        77 × 44 bytes
```

### Control record (44 bytes)

```
+0        : 01 if the control has a custom label, else 00
+1 … +14  : label (ASCII, NUL/space padded)
+15 …     : value fields (positions depend on control type)
…         : MIDI CC or note number
rest      : 00 padding
```

The 77 records are always in this order (matching the User Guide's control
counts):

| Records | Count | Control            | Value-byte offsets |
| ------- | ----- | ------------------ | ------------------ |
| 0–15    | 16    | Buttons (8×2)      | 15, 22             |
| 16–31   | 16    | Rotary Knobs (2 pages) | 20, 21, 25     |
| 32–39   | 8     | Faders             | 16                 |
| 40–43   | 4     | Pedals / expression | 16                |
| 44      | 1     | Footswitch         | 15, 22             |
| 45–60   | 16    | Pads — hit         | 15, 22, 29         |
| 61–76   | 16    | Pads — pressure    | 16                 |

## Colour analysis

- Across two independent templates, every value byte that isn't a label or a
  CC/note number is **`0x7F` (127)** — i.e. the control's **maximum value**.
  A histogram of the whole body shows only: `0x00` padding, printable ASCII
  labels, small CC/note numbers, record flags (`01`), and `0x7F`. There are **no
  varied colour-palette values and no RGB triples** with real colours.
- The two files differ only in labels and CC/note numbers — never in the `7F`
  value bytes.
- This matches Components' behaviour (no template LED-colour UI) and the User
  Guide's description of template contents.

**Conclusion:** LED colours are not part of the template. Custom LED colours are
only controllable *live* via the InControl SysEx API ([PROTOCOL.md](PROTOCOL.md)).
The [Template Lab](../template-lab.html) exists to let you *test this on
hardware* by poking the value bytes and observing whether the LEDs react.

### Hardware-confirmed (tested on a real SL MkIII)

Both open questions were settled on hardware:

1. **Editing template bytes does not change LED colour.** A rainbow probe that
   wrote distinct values to every pad's value bytes (offsets 15/22/29), exported
   with a valid recomputed CRC and imported into Components, produced **no**
   colour change on the unit.
2. **Live RGB SysEx only affects LEDs in InControl view.** Sending the
   `…02 0A 01 03…` LED command while the unit is on a plain template does
   nothing; the LEDs only respond in InControl mode.

**Therefore:** custom LED colours are strictly an InControl-mode, live feature.
They cannot be baked into a template or shown in standalone template mode. Use
the [live customizer](../index.html) in InControl view.
