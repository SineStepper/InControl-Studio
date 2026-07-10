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

## LED colour scheme (issue #12)

The surface is fully cleared on start and repainted from the sequencer state, so
nothing overlaps. Default rule: **buttons are unlit at rest and flash white when
pressed, unless stated below.**

- **Sequencer pads (Steps):** empty step = dim Part colour; used step = bright
  Part colour; current step = white (pulsing white when stopped); **pressed = red**.
- **Note pads (Grid/instrument):** dim Part colour at rest, bright Part when
  pressed. (Per-pad pressure→brightness is a follow-up.)
- **Soft 1-8** (below screens): Part colours (active white). In options mode they
  become the menu buttons (Velocity red / Gate green / Chance orange / Tempo
  white / Pattern blue); unmapped ones are unlit.
- **Soft 9-24** (above faders): Mute (orange) / Solo (light blue); a Part silenced
  by another's Solo pulses.
- **Transport:** Play dim→bright green (playing), Record dim→bright red
  (recording), Stop bright white when stopped / dim when playing; **Loop, FFW,
  RWD unlit and unmapped**.
- **Duplicate** dim green, **Clear** dim red, **Track L/R** dim blue, **Grid**
  dim white — all flash white when pressed.
- **Up/down arrows** (Pads, Screen, Right-Soft) light only when there's somewhere
  to go; Screen Up/Down mirror Pads Up/Down (pattern paging).
- **Faders/wheels** have no idle/pressed state — LED brightness tracks value.
- Every change is pushed to the SL MkIII automatically (no refresh button).
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

## Standalone-sequencer parity (implemented)

Driven entirely from the SL MkIII hardware, matching the User Guide:

- **Steps view** — pads are the 16 steps; playhead white, notes in the Part
  colour, empty dim, notes outside start/end red, start step yellow (Pattern
  menu). Hold pad + key (or key + pad) toggles notes; Clear+pad clears;
  Duplicate+pad copies.
- **Patterns view** — pads are the 8 patterns in the Part colour; **press two+
  together to chain**; Clear+pad resets, Duplicate+pad copies.
- **Micro-steps** — 6 per step; in options mode select a step (pad) then hold a
  micro-step button (Soft 9-14) + play keys; playback offsets by micro/6 of a step.
- **Options menus** — Velocity / Gate / Chance / Pattern; Velocity & Gate snap a
  step's notes to one value (highest wins); Chance 0% mutes a step; Pattern sets
  start / end / direction / sync / shift.
- **Recording** — Record arms/toggles; **Shift+Record** toggles record quantise
  (off → notes land on the nearest micro-step). Notes quantise to the sync rate.
- **Swing** — global 20-80% at the swing sync rate, per-track On/Off.
- **Automation** — while recording+playing, knob/fader/button moves record into
  per-pattern lanes (up to 8) and replay each loop; Clear+move clears a lane.
- **Mute/Solo** — Soft 9-16 Mute, Soft 17-24 Solo; a Part silenced by another's
  Solo pulses.
- **Per-Part instruments** — Soft 1-8 select the Part/channel and swap its
  assigned template.

See `docs/QUESTIONS-AND-IDEAS.md` for what still needs your input or a follow-up
(momentary record, Arp/Scales, session persistence of the newer fields, etc.).

## MIDI clock / arp sync (#26)

On play the sequencer emits MIDI real-time clock — **Start (FA)**, **timing
clock (F8) at 24 PPQN**, **Stop (FC)** — to both the SL's **InControl output**
and its **main (non-InControl) output** port, because the keyboard arpeggiator
follows external clock on the *main* port, not the InControl one. For the arp
(or any tempo-driven feature) to actually lock to the sequencer, the SL MkIII
must have its **Clock Source set to receive external clock** (Settings ▸ Clock
Source = *External* or *Auto*). With it on *Internal* the unit ignores incoming
clock and the arp runs at its own tempo.

## Assumptions / limitations

- **Soft-button layout:** Soft 1-8 = the row below the screens (menu select /
  channel select); Soft 9-24 = the 16 buttons above the faders (Mute/Solo, or
  the microstep row in options mode). Adjust `MENU_BUTTONS` /
  `MICROSTEP_BUTTONS` in `js/studio-options.js` if a unit's layout differs.
- **Microsteps** are surfaced (the six buttons light and track a selection) but
  the sequencer model does not yet store per-microstep notes, so edits apply to
  the whole step. Full microstep support needs a model extension (and the
  microstep storage location in the session body is not yet reverse-engineered).
