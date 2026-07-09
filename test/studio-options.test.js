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
O.applyKnob(s, freshPattern(), 'tempo', 1, +5, 0, false);
eq(s.swing, 55, 'tempo knob2 edits swing');

// ---- Pattern menu ----
p = freshPattern(); s = seq();
O.applyKnob(s, p, 'pattern', 1, -3, 0, false); // knob2 end 15 -> 12
eq(p.end, 12, 'pattern knob2 sets end');
O.applyKnob(s, p, 'pattern', 2, +1, 0, false); // direction forward -> backwards
eq(p.direction, 'Backwards', 'pattern knob3 steps direction');
O.applyKnob(s, p, 'pattern', 0, +4, 0, false);
eq(p.start, 4, 'pattern knob1 sets start');

// ---- Screen columns ----
p = freshPattern();
const cols = O.columns(seq(), p, 'velocity', 0);
eq(cols.length, 8, 'velocity page shows 8 columns');
eq([cols[0].text, cols[1].text, cols[2].text], ['100', '-', '80'], 'columns read step velocities, empty step = -');

// ---- Soft LEDs / arrows / pattern pads ----
const leds = O.softLeds('gate');
eq(leds[9], '#00ff00', 'gate button bright when active');
eq(leds[0], O.LIGHT_ORANGE, 'microstep button 0 is light orange');
eq(O.arrowLeds(0, 8), { up: false, down: true }, 'top of list: up off, down on');
eq(O.arrowLeds(7, 8), { up: true, down: false }, 'bottom of list: up on, down off');
eq(O.patternPadLeds(2, 8)[2], '#ffffff', 'active pattern pad is white');

console.log('\n' + n + ' assertions passed');
