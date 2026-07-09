/* Unit tests for the InControl Studio sequencer core (node test/studio-sequencer.test.js). */
'use strict';
global.window = global;
const Q = require('../js/studio-sequencer.js');
const assert = require('assert');
let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m + ' got ' + JSON.stringify(a)); console.log('ok  :', m); n++; };
const rng0 = () => 0; // deterministic: chance always passes, random dir -> first step

// model shape
const seq = Q.newSequencer();
eq([seq.tracks.length, seq.tracks[0].patterns.length, seq.tracks[0].patterns[0].steps.length], [8, 8, 16], 'shape 8x8x16');

// put a note on step 0 and step 2 of track 0 pattern 0
const pat = seq.tracks[0].patterns[0];
Q.toggleStepNote(pat, 0, 60, 100, 6); // 1-step gate
Q.toggleStepNote(pat, 2, 64, 80, 6);
eq(Q.stepHasNotes(pat, 0), true, 'step0 has a note');

// run playback: 1/16 = 6 ticks/step, forward
const rt = Q.makeSeqRuntime(seq);
Q.start(rt);
// tick 0 -> step0 note-on 60
let ev = Q.onTick(rt, rng0);
eq(ev.filter((e) => e.type === 'on'), [{ type: 'on', channel: 0, note: 60, velocity: 100 }], 'tick0 fires step0 note-on');
// ticks 1..5 nothing new until gate expires at tick 6
let offAt = null;
for (let t = 1; t <= 6; t++) { ev = Q.onTick(rt, rng0); if (ev.some((e) => e.type === 'off' && e.note === 60)) offAt = t; }
eq(offAt, 6, 'note 60 off at tick 6 (1-step gate)');
// at tick 6 also step1 (empty) -> counter increments; tick12 -> step2 note 64
for (let t = 7; t < 12; t++) Q.onTick(rt, rng0);
ev = Q.onTick(rt, rng0); // tick 12
eq(ev.filter((e) => e.type === 'on'), [{ type: 'on', channel: 0, note: 64, velocity: 80 }], 'tick12 fires step2 note 64');

// stepIndexFor directions
eq([0, 1, 2, 3].map((c) => Q.stepIndexFor(c, 0, 3, 'Forward', 0)), [0, 1, 2, 3], 'forward 0..3');
eq([0, 1, 2, 3].map((c) => Q.stepIndexFor(c, 0, 3, 'Backwards', 0)), [3, 2, 1, 0], 'backwards');
eq([0, 1, 2, 3, 4, 5].map((c) => Q.stepIndexFor(c, 0, 3, 'Ping-Pong', 0)), [0, 1, 2, 3, 2, 1], 'ping-pong');
eq([0, 1].map((c) => Q.stepIndexFor(c, 5, 8, 'Random', 0, rng0)), [5, 5], 'random with rng0 -> lo');
eq(Q.stepIndexFor(0, 0, 3, 'Forward', 2), 2, 'shift +2');

// chance 0 => step muted
const seq2 = Q.newSequencer(); const p2 = seq2.tracks[0].patterns[0];
Q.toggleStepNote(p2, 0, 60, 100, 6); Q.setStepChance(p2, 0, 0);
const rt2 = Q.makeSeqRuntime(seq2); Q.start(rt2);
eq(Q.onTick(rt2, () => 0.5).filter((e) => e.type === 'on'), [], 'chance 0 mutes step');

// gate longer than a step: 2 steps (12 sixths) -> off at tick 12
const seq3 = Q.newSequencer(); const p3 = seq3.tracks[0].patterns[0];
Q.toggleStepNote(p3, 0, 60, 100, 12);
const rt3 = Q.makeSeqRuntime(seq3); Q.start(rt3);
let off3 = null; for (let t = 0; t <= 12; t++) { const e = Q.onTick(rt3, rng0); if (e.some((x) => x.type === 'off')) off3 = t; }
eq(off3, 12, '2-step gate -> note off at tick 12');

// editing: copy, clear, transpose
Q.copyStep(pat, 0, 5); eq(Q.stepHasNotes(pat, 5), true, 'copyStep');
Q.clearStep(pat, 0); eq(Q.stepHasNotes(pat, 0), false, 'clearStep');
eq(Q.transposePattern(pat, 12), true, 'transpose +12 ok');
eq(pat.steps[2].notes[0].note, 76, 'transposed 64 -> 76');

// stop flushes sounding notes
const rt4 = Q.makeSeqRuntime(Q.newSequencer());
const sp = seq.tracks[0].patterns[0];
const rt5 = Q.makeSeqRuntime(seq); Q.start(rt5); Q.onTick(rt5, rng0);
eq(Q.stop(rt5).every((e) => e.type === 'off'), true, 'stop returns note-offs');

console.log('\nALL ' + n + ' SEQUENCER TESTS PASSED');
