# SL MkIII Session format (`.syx` / `.slmkiiisession`)

How a Novation SL MkIII **session** stores its step sequence, reverse-engineered
from controlled ground-truth captures and verified **bit-exact against all 64
factory sessions** in the stock `SLMKiii_sessions.syx` dump.

## Container

A session `.syx` is a run of session dumps that share the template SysEx
container (`docs/TEMPLATE-FORMAT.md`) but with:

- type byte **`0x01`** (templates use `0x02`),
- a per-session **slot** byte at message offset 17,
- nibble-encoded chunk indices, and a **CRC-32** footer over the decoded body.

Decoding (7-to-8, MSB-first) yields a **94208-byte "USER" body** per session
(magic `55 53 45 52`, name at `0x20`, 32 bytes, space-padded). A full dump holds
64 sessions. `js/session.js` `decodeSyx` / `encodeSyx` round-trip this bit-exact.

Components packs (`.slmkiiipack`) carry the same 94208-byte body as
`sessions/*.slmkiiisession`.

## Step sequence layout (inside the USER body)

The SL MkIII sequencer is **8 tracks × 8 patterns × 16 steps**. Each step is a
fixed **36-byte (`0x24`) record**. The grid for a given track/pattern starts at:

```
gridOffset(track, pattern) = 0x13c + track*0x2d98 + pattern*0x5ac
```

- Patterns within a track are spaced `0x5ac` (1452) bytes apart.
- Tracks are spaced `0x2d98` bytes apart (`8*0x5ac` + a 56-byte per-track header).
- Step *s* of a grid is at `gridOffset + s*0x24`.

### Step record (36 bytes)

| Offset | Meaning |
|--------|---------|
| `+0`   | flag — per-slot **active bitmask** (bit *k* set when slot *k* holds a note). Bit 0 is cleared for tied notes, so it is *not* a reliable note-present flag on its own. |
| `+1`   | **chance / probability** (0–100; `0x64`/100 = always) |
| `+2,+3`| `0x00` |
| `+4 …` | 8 **note slots**, 4 bytes each |

### Note slot (4 bytes, at `step + 4 + k*4`, k = 0…7)

| Offset | Meaning |
|--------|---------|
| `+0`   | **note number** (0 = empty slot) |
| `+1`   | **velocity** (1–127; `0x60`/96 in an empty slot) |
| `+2`   | **gate** length in **sixths of a step** (6 = one full step, 18 = three steps); **bit 7 (`0x80`) = tie** (legato into the next note) |
| `+3`   | `0x00` |

An **empty slot** is canonically `00 60 00 00`. A slot is a real note **iff its
note byte ≠ 0**. Up to 8 notes per step gives chords (up to 6 observed in the
factory sessions).

### Per-pattern footer (at `gridOffset + 0x240`, i.e. just past the 16-step grid)

| Offset | Meaning |
|--------|---------|
| `+0`   | **length − 1** (last active step index; length = value + 1) |
| `+1`   | **sync rate** index: `0`=1/32T `1`=1/32 `2`=1/16T `3`=1/16 `4`=1/8T `5`=1/8 `6`=1/4T `7`=1/4 |
| `+2`   | **direction**: `0`=Forward `1`=Backwards `2`=Ping-Pong `3`=Random |

### Globals & per-track (in the header region before the grids)

| Offset | Meaning |
|--------|---------|
| `0x40` | **tempo** BPM, 16-bit little-endian (`0x40` lo, `0x41` hi) |
| `0x42` | **swing** (`50` = straight/off) |
| `0x115 + track*0x2d98` | per-track **MIDI channel** (0-based; track *n* defaults to channel *n*) |
| `0x119 + track*0x2d98` | per-track **pattern-chain** field (location pinned; exact chaining semantics still tentative — preserved verbatim on write) |

## What is decoded vs. preserved

`js/session.js` `readSequence` / `writeSequence` decode and re-encode: notes
(number, velocity, gate, tie, chords), per-step chance, per-pattern length /
sync rate / direction, tempo, swing, and per-track channel. Every offset above
was pinned from **controlled single-field ground-truth captures** and verified.

`writeSequence` overwrites only those known fields (and the per-step flag,
recomputed only for steps whose slots actually changed), leaving every other
byte untouched — so re-exporting an **unmodified** session is byte-for-byte
identical to the original (verified across all 64 factory sessions and all 13
single-field captures).

Still opaque (preserved, not interpreted): the pattern-chain semantics, and any
per-pattern *start* offset (the hardware stores only length, implying start 0).
