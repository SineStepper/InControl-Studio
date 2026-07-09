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
| `+1`   | constant `0x64` (100) |
| `+2,+3`| `0x00` |
| `+4 …` | 8 **note slots**, 4 bytes each |

### Note slot (4 bytes, at `step + 4 + k*4`, k = 0…7)

| Offset | Meaning |
|--------|---------|
| `+0`   | **note number** (0 = empty slot) |
| `+1`   | **velocity** (1–127; `0x60`/96 in an empty slot) |
| `+2`   | **gate** length; **bit 7 (`0x80`) = tie** (note held past the step) |
| `+3`   | `0x00` |

An **empty slot** is canonically `00 60 00 00`. A slot is a real note **iff its
note byte ≠ 0**. Up to 8 notes per step gives chords (up to 6 observed in the
factory sessions).

## What is decoded vs. preserved

`js/session.js` decodes **notes** (number, velocity, gate, tie) into the
studio-sequencer model and can write them back. `writeSequence` overwrites only
the note slots and the per-step flag (recomputed only for steps whose slots
actually changed), leaving every other byte untouched — so re-exporting an
unmodified session is byte-for-byte identical to the original.

Per-**pattern** settings (length/start/end, play direction, sync rate, swing)
and per-**track**/global settings (tempo, channel) live in the pattern/track
headers and are **not yet decoded** — the ground-truth captures all used
defaults, so those fields can't be pinned without further varied samples.
Importing therefore loads the notes and leaves pattern settings at defaults.
