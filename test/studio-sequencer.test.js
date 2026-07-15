/* Unit tests for the InControl Studio sequencer core (node test/studio-sequencer.test.js). */
'use strict';
global.window = global;
const Q = require('../js/studio-sequencer.js');
const assert = require('assert');
let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m + ' got ' + JSON.stringify(a)); console.log('ok  :', m); n++; };
const ok = (c, m) => { assert.ok(c, m); console.log('ok  :', m); n++; };
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

// pattern chains: playback advances through the chained patterns
const cseq = Q.newSequencer(); const ct = cseq.tracks[0];
ct.patterns[0].end = 1; Q.toggleStepNote(ct.patterns[0], 0, 60, 100, 6);
ct.patterns[1].end = 1; Q.toggleStepNote(ct.patterns[1], 0, 72, 100, 6);
ct.chain = { from: 0, to: 1 };
const crt = Q.makeSeqRuntime(cseq); Q.start(crt);
const played = [];
for (let k = 0; k < Q.SYNC['1/16'] * 8; k++) Q.onTick(crt, rng0).filter((e) => e.type === 'on').forEach((e) => played.push(e.note));
eq(played, [60, 72, 60, 72], 'chain 0-1 alternates patterns 0 and 1');
eq(ct.activePattern, 1, 'chain leaves activePattern on the last-played pattern');
// #70: stopping rewinds a chained track to the first pattern of its chain, step 1
Q.stop(crt);
eq(ct.activePattern, 0, '#70 stop rewinds a chained track to the first pattern of its chain');
eq(crt.pos[0].pad, ct.patterns[0].start || 0, '#70 stop positions a chained track at step 1 of that pattern');
eq(crt.pos[0].counter, -1, '#70 stop resets the chained track step counter');

// micro-steps: a note on micro-step 3 fires 3/6 of a step late
const mseq = Q.newSequencer(); const mp = mseq.tracks[0].patterns[0];
Q.toggleMicroNote(mp, 0, 0, 60, 100, 6); // step 0, micro 0 -> on beat
Q.toggleMicroNote(mp, 0, 3, 72, 100, 6); // step 0, micro 3 -> half a step late
eq(Q.microHasNotes(mp, 0, 3), true, 'micro 3 has a note');
const mrt = Q.makeSeqRuntime(mseq); Q.start(mrt);
const onAt = {};
for (let k = 0; k < Q.SYNC['1/16']; k++) Q.onTick(mrt, rng0).filter((e) => e.type === 'on').forEach((e) => (onAt[e.note] = k));
eq([onAt[60], onAt[72]], [0, 3], 'micro 0 fires at tick 0, micro 3 fires at tick 3');

// deferred pattern switch: a queued change applies at the pattern boundary, not immediately
const dseq = Q.newSequencer(); const dt = dseq.tracks[0];
dt.patterns[0].end = 1; Q.toggleStepNote(dt.patterns[0], 0, 60, 100, 6);
dt.patterns[1].end = 1; Q.toggleStepNote(dt.patterns[1], 0, 72, 100, 6);
const drt = Q.makeSeqRuntime(dseq); Q.start(drt);
Q.onTick(drt, rng0); // tick0: fires pattern 0 step 0 (note 60)
dt.pending = { activePattern: 1, chain: null }; // queue a switch to pattern 1
eq(dt.activePattern, 0, 'queued switch does not change activePattern immediately');
const dplayed = [];
for (let k = 1; k < Q.SYNC['1/16'] * 8; k++) Q.onTick(drt, rng0).filter((e) => e.type === 'on').forEach((e) => dplayed.push(e.note));
eq(dt.activePattern, 1, 'queued switch takes effect at the pattern boundary');
ok(dplayed.length >= 3 && dplayed.every((x) => x === 72), 'after the boundary only pattern 1 (note 72) plays, got ' + JSON.stringify(dplayed));

// swing: positive swing delays the off-beat step
const sseq = Q.newSequencer(); sseq.swing = 80; sseq.swingSync = '1/16';
const stp = sseq.tracks[0].patterns[0];
Q.toggleStepNote(stp, 0, 60, 100, 6); // on-beat (step 0)
Q.toggleStepNote(stp, 1, 62, 100, 6); // off-beat (step 1) -> swung later
const srt = Q.makeSeqRuntime(sseq); Q.start(srt);
const at = {};
for (let k = 0; k < Q.SYNC['1/16'] * 2; k++) Q.onTick(srt, rng0).filter((e) => e.type === 'on').forEach((e) => (at[e.note] = k));
eq(at[60], 0, 'on-beat note fires on the step boundary');
ok(at[62] > 6, 'off-beat note is swung later than its step boundary (tick 6), got ' + at[62]);

// #39: when the runtime clock is swinging the timeline, the note is NOT also
// offset here (no double swing) — the off-beat fires on its plain boundary.
const swrt = Q.makeSeqRuntime(sseq); Q.start(swrt); swrt.clockSwing = true;
const cat = {};
for (let k = 0; k < Q.SYNC['1/16'] * 2; k++) Q.onTick(swrt, rng0).filter((e) => e.type === 'on').forEach((e) => (cat[e.note] = k));
eq(cat[62], 6, '#39 with clockSwing, the off-beat note fires on its plain boundary (clock swings instead)');

// #83 time signature: caps the usable step range (non-destructively) and playback
const tsig = Q.newSequencer();
eq(Q.stepsPerBar(tsig), 16, '#83 default 4/4 = 16 steps');
tsig.signature = '3/4';
eq(Q.stepsPerBar(tsig), 12, '#83 3/4 = 12 steps');
eq(Q.barBounds(tsig, tsig.tracks[0].patterns[0]).end, 11, '#83 3/4 caps a full-length pattern end to 11');
const tp = tsig.tracks[0].patterns[0]; tp.steps.forEach((s, i) => (s.notes = [{ note: 60 + i, velocity: 100, gate: 6 }]));
const trt = Q.makeSeqRuntime(tsig); trt.playing = true; const seen = new Set();
for (let k = 0; k < 24 * 8; k++) Q.onTick(trt).filter((e) => e.type === 'on').forEach((e) => seen.add(e.note - 60));
ok(Math.max.apply(null, Array.from(seen)) <= 11, '#83 3/4 never plays a step past 12');
tsig.signature = '4/4';
eq(Q.barBounds(tsig, tsig.tracks[0].patterns[0]).end, 15, '#83 switching back to 4/4 restores the full range (non-destructive)');

console.log('\nALL ' + n + ' SEQUENCER TESTS PASSED');
