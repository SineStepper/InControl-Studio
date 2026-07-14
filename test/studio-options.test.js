/* Unit tests for the options-mode sequencer logic (node test/studio-options.test.js). */
'use strict';
global.window = global;
require('../js/studio-sequencer.js');
const O = require('../js/studio-options.js');
const Q = global.SLMK.sequencer;
const assert = require('assert');
let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m + ' got ' + JSON.stringify(a)); console.log('ok  :', m); n++; };

function freshPattern() {
  const p = Q.newPattern();
  Q.toggleStepNote(p, 0, 60, 100, 6); // step 1: note 60 vel 100 gate 6
  Q.toggleStepNote(p, 2, 64, 80, 6);  // step 3
  return p;
}
const seq = () => ({ tempo: 120, swing: 50, tracks: [] });

// ---- Velocity menu: knob i edits step (page*8+i) ----
let p = freshPattern();
O.applyKnob(seq(), p, 'velocity', 0, +5, 0, false); // knob1 -> step1
eq(p.steps[0].notes[0].velocity, 105, 'velocity knob1 edits step1 (+5)');
O.applyKnob(seq(), p, 'velocity', 2, -10, 0, false); // knob3 -> step3
eq(p.steps[2].notes[0].velocity, 70, 'velocity knob3 edits step3 (-10)');
// page 1: knob1 -> step9
p = freshPattern(); Q.toggleStepNote(p, 8, 72, 64, 6);
O.applyKnob(seq(), p, 'velocity', 0, +3, 1, false);
eq(p.steps[8].notes[0].velocity, 67, 'velocity page1 knob1 edits step9');
// clamp
p = freshPattern();
O.applyKnob(seq(), p, 'velocity', 0, +100, 0, false);
eq(p.steps[0].notes[0].velocity, 127, 'velocity clamps to 127');

// ---- Shift: knob1 edits all steps at once ----
p = freshPattern();
O.applyKnob(seq(), p, 'velocity', 0, +2, 0, true);
eq([p.steps[0].notes[0].velocity, p.steps[2].notes[0].velocity], [102, 82], 'shift edits all step velocities');

// ---- Gate menu (1/6-step units, up to 32 steps = 192) ----
p = freshPattern();
O.applyKnob(seq(), p, 'gate', 0, +12, 0, false);
eq(p.steps[0].notes[0].gate, 18, 'gate knob1 +12 -> 18');
O.applyKnob(seq(), p, 'gate', 0, +1000, 0, false);
eq(p.steps[0].notes[0].gate, 192, 'gate clamps to 192 (32 steps)');

// ---- Chance menu (per-step, 0-100) ----
p = freshPattern();
O.applyKnob(seq(), p, 'chance', 0, -60, 0, false);
eq(p.steps[0].chance, 40, 'chance knob1 -60 -> 40');

// ---- Tempo menu ----
let s = seq();
O.applyKnob(s, freshPattern(), 'tempo', 0, +30, 0, false);
eq(s.tempo, 150, 'tempo knob1 +30 -> 150');
O.applyKnob(s, freshPattern(), 'tempo', 0, +1000, 0, false);
eq(s.tempo, 240, 'tempo clamps to 240');
s = seq();
O.applyKnob(s, freshPattern(), 'tempo', 1, +5, 0, false); // swing halves its rate: +5 detents -> +2
eq(s.swing, 52, 'tempo knob2 edits swing (reduced sensitivity)');
// below the threshold a small nudge does nothing (deliberate turn required)
s = seq();
O.applyKnob(s, freshPattern(), 'tempo', 1, +1, 0, false);
eq(s.swing == null ? 50 : s.swing, 50, 'tempo knob2 ignores a sub-threshold swing nudge');

// ---- Pattern menu ----
p = freshPattern(); s = seq();
O.applyKnob(s, p, 'pattern', 1, -3, 0, false); // knob2 end 15 -> 12
eq(p.end, 12, 'pattern knob2 sets end');
O.applyKnob(s, p, 'pattern', 2, +1, 0, false); // direction forward -> backwards
eq(p.direction, 'Backwards', 'pattern knob3 steps direction');
O.applyKnob(s, p, 'pattern', 0, +4, 0, false);
eq(p.start, 4, 'pattern knob1 sets start');

// ---- Shift only responds to Knob 1 (#6) ----
p = freshPattern();
const beforeV = p.steps[2].notes[0].velocity;
O.applyKnob(seq(), p, 'velocity', 2, +5, 0, true); // shift + Knob 3 -> nothing
eq(p.steps[2].notes[0].velocity, beforeV, 'shift + a non-first knob does nothing (Knob 1 always)');

// ---- Screen columns ----
p = freshPattern();
const cols = O.columns(seq(), p, 'velocity', 0);
eq(cols.length, 8, 'velocity page shows 8 columns');
eq([cols[0].top, cols[1].top], ['Step 1', 'Step 2'], 'column tops say "Step N"');
eq([cols[0].bottom, cols[1].bottom, cols[2].bottom], ['100', '-', '80'], 'columns read step velocities, empty step = -');
eq([cols[0].glyph, cols[1].glyph], [true, false], 'velocity draws a white knob glyph where a note exists');
// gate shows whole steps + 0-5 boxes (never a raw 0-192 number)
const gp = freshPattern(); gp.steps[0].notes[0].gate = 15; // 2 whole steps + 3/6
const gcols = O.columns(seq(), gp, 'gate', 0);
eq(gcols[0].bottom, '2 ###', 'gate shows whole steps + 0-5 boxes for the 1/6 remainder');
eq(gcols[0].glyph, false, 'gate uses boxes, not a knob glyph');
// #57 menu labels for the option buttons
eq([O.menuLabelForButton(0), O.menuLabelForButton(1), O.menuLabelForButton(3), O.menuLabelForButton(7)], ['Velocity', 'Gate', 'Tempo', 'Pattern'], '#57 menu labels for buttons 1/2/4/8');
// metronome controls on the tempo page (#46/#47/#45)
// these discrete controls need a deliberate turn (~4 detents) to change (reduced sensitivity)
const ms = seq(); O.applyKnob(ms, freshPattern(), 'tempo', 3, +1, 0, false); eq(ms.metronome.on, false, '#46 knob 4 ignores a sub-threshold nudge');
O.applyKnob(ms, freshPattern(), 'tempo', 3, +4, 0, false); eq(ms.metronome.on, true, '#46 knob 4 toggles metronome on after a full turn');
O.applyKnob(ms, freshPattern(), 'tempo', 4, +4, 0, false); eq(ms.metronome.sound, 'Tick', '#47 knob 5 cycles the click sound');
O.applyKnob(ms, freshPattern(), 'tempo', 5, +4, 0, false); eq(ms.metronome.silent, true, '#45 knob 6 sets blink-only (no sound)');
// chance / swing render as percentages
eq(O.columns(seq(), freshPattern(), 'chance', 0)[0].bottom, '100%', 'chance shows a percentage');
eq(O.columns(seq(), freshPattern(), 'tempo', 0)[1].bottom, '50%', 'swing shows a percentage');
eq(O.columns(seq(), freshPattern(), 'tempo', 0)[2].top, 'Swing Sync Rate', 'tempo knob 3 labelled Swing Sync Rate');

// ---- Soft LEDs / arrows / pattern pads ----
const leds = O.softLeds('gate');
eq(leds[1], '#00ff00', 'gate button (Soft 2) bright when active');
eq(leds[8], O.LIGHT_ORANGE, 'microstep button (Soft 9) is light orange');
eq(O.menuForButton(0), 'velocity', 'Soft 1 -> Velocity menu');
eq(O.menuForButton(7), 'pattern', 'Soft 8 -> Pattern menu');
eq(O.arrowLeds(0, 8), { up: false, down: true }, 'top of list: up off, down on');
eq(O.arrowLeds(7, 8), { up: true, down: false }, 'bottom of list: up on, down off');
eq(O.patternPadLeds(2, 8)[2], '#ffffff', 'active pattern pad is white');

// velocity snapping: multiple notes on a step snap to one uniform value (favouring higher)
const chordP = Q.newPattern();
Q.toggleStepNote(chordP, 0, 60, 25, 6);
Q.toggleStepNote(chordP, 0, 64, 89, 6); // step 0 has velocities 25 and 89
O.applyKnob(seq(), chordP, 'velocity', 0, +1, 0, false); // nudge up from the max (89)
eq(chordP.steps[0].notes.map((x) => x.velocity), [90, 90], 'both notes snap to 90 (max 89 +1)');

console.log('\n' + n + ' assertions passed');
