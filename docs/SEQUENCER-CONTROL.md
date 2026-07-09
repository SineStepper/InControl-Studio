# Sequencer control surface (InControl mode)

How the SL MkIII's own buttons/pads/knobs/screens drive the Studio sequencer
while the unit is in InControl mode, mirroring the standalone sequencer
(GitHub issues #4, #6, #7). Implemented in `js/studio-runtime.js` with the pure
logic in `js/studio-options.js`.

## Pads & views (#7, #4)

- **Pads** default to controlling the sequencer. During playback they show the
  step position (playhead); steps with notes are lit.
- **Grid** button toggles the pads between sequencer control and a playable
  **instrument**.
- **Pads Up / Pads Down** page through the 8 patterns. The arrow LEDs reflect
  list position: at the top the Up arrow is off and Down is lit; at the bottom,
  the reverse.
- **Scene 1 (Top) → Patterns view**, **Scene 2 (Bottom) → Steps view** (#4).
  In Patterns view the pads select the active pattern; in Steps view they edit
  the 16 steps. (The Scene buttons are unused by the standalone sequencer, so we
  repurpose them here.)
- **Pads Up/Down do not wrap** — they stop at the first/last pattern.

## Buttons, channels, mute/solo

- **Soft 1-8** (the row below the screens) select the **channel/instrument**
  (1-8). Selecting a channel moves the sequencer track to match, routes
  `default`-channel controls to that channel, and swaps in that channel's
  **assigned template** if one is set (Studio → "Per-channel instruments" bar).
- **Soft 9-24** (the 16 buttons above the faders) are the fixed **Mute/Solo**
  bank: Soft 9-16 = Mute 1-8, Soft 17-24 = Solo 1-8. They send no MIDI of their
  own — only their colour is editable (Mute orange, Solo light blue by default).
  Mute silences its channel's output; Solo restricts output to soloed channels.
  Channels are mappable (default 1-8).

## LEDs

- **Transport** defaults: Play green, Record red, Stop red, Loop yellow,
  Fast-Fwd/Rewind white.
- **Faders and wheels** have no idle/pressed state — the LED above each fader
  brightens/darkens with the control's value.
- Pressing any pad or button briefly **lightens** it to near-white.
- **Keybed light guide** (SysEx ids 54-114): **off by default.** The
  Programmer's Guide gives the key LEDs the *same* SysEx ids as the Fader LEDs
  (54-61) and function-button LEDs (62-67), so lighting keys clobbers those —
  the SL MkIII can't drive the light guide independently over this API. The code
  is present (keys light on playback, red while auditioning/holding a step);
  enable it to experiment with `SLMK.studioRuntime.setKeyGuide(true)` (base note
  is `LOW_NOTE` in `studio-runtime.js`).

## Options mode (#6)

Pressing **Options** opens an editing surface; the screens show a per-knob
readout and the row of soft buttons below the screens (**Soft 1-8**) selects a
menu. The first six above-fader buttons (**Soft 9-14**) become the **microstep**
row and light light-orange.

| Button | Menu | Colour | Knobs |
|--------|------|--------|-------|
| 1 | Velocity | red | Knobs 1-8 set steps' velocity (1-127) |
| 2 | Gate | green | Knobs 1-8 set gate length in ⅙-step units (up to 32 steps) |
| 3 | Chance | orange | Knobs 1-8 set steps' chance (0-100%) |
| 4 | Tempo | white | Knob 1 tempo (40-240), Knob 2 swing (10-80%), Knob 3 swing sync rate |
| 8 | Pattern | blue | Knob 1 start, Knob 2 end, Knob 3 direction, Knob 4 sync rate, Knob 5 shift (wraps) |

- In the per-step menus, **Screen Down / Screen Up** page between steps 1-8 and
  9-16, and holding **Shift** makes Knob 1 edit **all** steps at once.
- The screens update in real time as you turn the knobs.

## Assumptions / limitations

- **Soft-button layout:** Soft 1-8 = the row below the screens (menu select /
  channel select); Soft 9-24 = the 16 buttons above the faders (Mute/Solo, or
  the microstep row in options mode). Adjust `MENU_BUTTONS` /
  `MICROSTEP_BUTTONS` in `js/studio-options.js` if a unit's layout differs.
- **Microsteps** are surfaced (the six buttons light and track a selection) but
  the sequencer model does not yet store per-microstep notes, so edits apply to
  the whole step. Full microstep support needs a model extension (and the
  microstep storage location in the session body is not yet reverse-engineered).
