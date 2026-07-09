# Questions & implementation ideas

Written after the autonomous stretch that brought the InControl-mode app to
near-parity with the SL MkIII standalone sequencer (checked against the User
Guide and Programmer's Guide). Everything below is either a decision I need from
you or a known follow-up — the implemented behaviour is summarised in
`docs/SEQUENCER-CONTROL.md`.

## Questions for you

1. **Momentary Record.** The standalone tells *tap-to-toggle* apart from
   *hold-to-record* by how long you hold the Record button. The InControl MIDI
   stream doesn't give reliable press-duration, so I made Record a toggle
   (press = arm/punch-in/punch-out). Do you want (a) keep toggle, (b) always
   hold-to-record, or (c) a press-duration threshold to emulate both?

2. **Session persistence of the new fields.** The `.syx`/pack session format I
   reverse-engineered stores notes, velocity, gate, tie, chance, pattern
   length/direction/sync, tempo, swing and channel — and round-trips those
   bit-exact. It does **not** yet store: **micro-steps, pattern chains,
   per-track swing on/off, automation, or Part colours.** Those currently live
   only in the app's own JSON. Want me to reverse-engineer where the hardware
   stores them? Each needs a few targeted ground-truth captures (e.g. a session
   with one note on micro-step 3, a session with a 1→3 pattern chain, a session
   with distinct Part colours) — same method that worked before.

3. **Pattern-switch timing.** The standalone defers a single pattern change to
   the end of the current pattern when playing (instant only with Shift). I
   switch immediately. Want the deferred-until-boundary behaviour?

4. **Mute/Solo access.** The manual reaches Mute/Solo through a dedicated view
   (the right soft arrow). I left the 16 above-fader buttons always acting as
   Mute/Solo. Keep them always-on, or gate them behind Right Soft Up/Down like
   the hardware?

5. **Arp and Scales.** These are separate SL modes, not the sequencer. Do you
   want them in InControl too? They'd need button mappings (the Arp/Scales/Latch
   buttons aren't exposed over InControl), so I'd map them onto spare controls —
   tell me if that's wanted and I'll spec it.

6. **Soft-button / micro-step physical mapping.** I mapped menus to Soft 1-8 and
   micro-steps/mute-solo to Soft 9-24 from the guide. If anything is off on your
   unit, it's two constants (`MENU_BUTTONS` / `MICROSTEP_BUTTONS` in
   `js/studio-options.js`) plus the LED-id offsets — quick to correct.

## Follow-ups I already know about (no input needed, just not done yet)

- **Automation depth.** Records/replays knob/fader/button moves per tick and
  clears a lane with Clear+move. Not yet: pad-pressure/wheel/pedal automation,
  Step-Edit manual value assignment (stopped + Record + select step + move
  control), the "control lights red while automating" feedback, and on-screen
  automation-lane display.
- **Keybed light guide** stays off by default — the guide gives key LEDs the
  same SysEx ids as the fader/function LEDs, so it can't run cleanly alongside
  them (`setKeyGuide(true)` to experiment).
- **Non-quantised record** places note-ons on the nearest micro-step; note-off
  gate is still rounded to sixths.
- **Scale note-quantise** (snap/filter/display) could hook into `onKeys` /
  `recordNoteOn` once Scales is wanted.
- **On-screen pages.** The app has Live Colours, InControl Studio (7 control
  tabs + Sequencer) and Bridge. Dedicated on-screen Patterns/Automation pages
  would mirror the hardware but aren't essential since the surface is
  hardware-first.
- **Tap tempo** (the Tempo button isn't exposed over InControl) — could be a
  spare-control mapping if wanted.
