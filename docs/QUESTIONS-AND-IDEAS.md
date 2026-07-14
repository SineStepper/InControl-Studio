# Questions & implementation ideas

Written after the autonomous stretch that brought the InControl-mode app to
near-parity with the SL MkIII standalone sequencer (checked against the User
Guide and Programmer's Guide). Everything below is either a decision I need from
you or a known follow-up — the implemented behavior is summarised in
`docs/SEQUENCER-CONTROL.md`.

## Questions for you

1. **Momentary Record.** *(Resolved — keeping the toggle for now.)* Record is a
   toggle: press = arm / punch-in / punch-out. Revisit if you want hold-to-record.

2. **Session persistence of the new fields.** *(You said yes — here's where it
   stands.)* The `.syx`/pack format stores notes, velocity, gate, tie, chance,
   pattern length/direction/sync, tempo, swing and channel bit-exact. The app's
   **`.json` setup files now persist everything** (Part color, chains, per-track
   swing, micro-steps, automation) — so nothing is lost if you Save/Load setups
   in the app. What's still missing is writing those into the **hardware
   `.syx`/pack** format.

   From analysing the 64 factory sessions I found: the byte I earlier thought
   might be Part color (`0x117+track*0x2d98`) is actually just the track index
   (always 0-7), and the chain byte (`0x119+track*0x2d98`) holds the chain
   **span** (to−from) but the chain **start**, the stored **active pattern**,
   and the micro-step/swing/automation locations aren't pinned. I won't write
   guesses into real sessions (that risks corrupting them), so I need these
   controlled single-session captures — export each as its own `.syx`, named by
   what it contains, starting from an Init session with one note on Track 1 /
   Pattern 1 / step 1 unless noted:

   - **Part color:** recolor Track 1 to a distinctive color, Track 2 to a
     different one (Templates view → select Part → colored pad). Two captures,
     or one with several Parts recolored.
   - **Pattern chain:** (a) chain patterns **3→5** on Track 1; (b) chain **2→2**
     only (single) vs a 1→4 chain. These pin the chain start + span + how the
     active pattern is stored.
   - **Active pattern:** set Track 1's active pattern to **Pattern 5** (Patterns
     view → pad 5), no chain.
   - **Micro-steps:** one note on **micro-step 4** of step 1 (Options → select
     step 1 → hold the 4th micro button → play a key).
   - **Per-track swing:** set Track 1 swing **Off** (Tempo menu), Track 2 On.
   - **Automation (optional, complex):** record a single knob sweep on Track 1's
     Pattern 1, nothing else.

   Send whatever subset you can and I'll extend `readSequence`/`writeSequence`
   the same way I decoded the note grid — verifying bit-exact against the
   captures before shipping.

3. **Pattern-switch timing.** *(Resolved — implemented.)* While playing, a
   pattern/chain selection is queued and takes effect at the end of the current
   pattern (the queued pad pulses); Shift or a stopped transport switches instantly.

4. **Mute/Solo access.** The manual reaches Mute/Solo through a dedicated view
   (the right soft arrow). I left the 16 above-fader buttons always acting as
   Mute/Solo. Keep them always-on, or gate them behind Right Soft Up/Down like
   the hardware?

5. **Arp and Scales.** *(Resolved — not needed; they live on the keyboard.)*

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
- **On-screen pages.** The app has Live Colors, InControl Studio (7 control
  tabs + Sequencer) and Bridge. Dedicated on-screen Patterns/Automation pages
  would mirror the hardware but aren't essential since the surface is
  hardware-first.
- **Tap tempo** (the Tempo button isn't exposed over InControl) — could be a
  spare-control mapping if wanted.
