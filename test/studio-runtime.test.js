/*
 * studio-runtime integration test — loads the browser module stack with DOM/MIDI
 * stubs and drives the resolved-control handler (issues #1-#7): options mode,
 * scene views, pattern paging, mute/solo gating, channel select, fader LEDs.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = require('path').join(__dirname, '..');

// --- minimal DOM/window stubs ---
const sent = []; // {id, bytes}
const listeners = {};
const stubEl = { addEventListener() {}, appendChild() {}, textContent: '', classList: { add() {}, remove() {} }, style: {}, value: '', innerHTML: '' };
global.window = global;
global.document = {
  querySelector: () => null, // so init() early-returns; we drive onMsg directly
  querySelectorAll: () => [],
  createElement: () => Object.assign({}, stubEl),
  addEventListener() {},
};

// load real modules that are pure
for (const f of ['js/sysex.js', 'js/controls.js', 'js/incontrol.js', 'js/studio-sequencer.js', 'js/studio-model.js', 'js/studio-engine.js', 'js/studio-options.js']) {
  new Function('window', fs.readFileSync(path.join(root, f), 'utf8')).call(global, global);
}

// stub midi that records output
global.SLMK.midi = {
  outputPorts: () => [], inputPorts: () => [],
  guessDefaultInputId: () => 'in', guessDefaultOutputId: () => 'out', guessDefaultKeysInputId: () => 'keys',
  snapshot: () => ({ connected: true }),
  subscribeInput: () => () => {}, onChange: () => {},
  sendToOutput: (id, bytes) => sent.push({ id, bytes }),
};

// a model with a sequencer
const model = global.SLMK.studio.newModel();
global.SLMK.studio.ensureSequencer(model);
model.sequencer.tracks[0].patterns[0].steps[0].notes = [{ note: 60, velocity: 100, gate: 6 }];
global.SLMK.studioState = { getModel: () => model };

// load the runtime
new Function('window', fs.readFileSync(path.join(root, 'js/studio-runtime.js'), 'utf8')).call(global, global);

const RT = global.SLMK.studioRuntime;
const st = RT.state();
// pretend the engine is started
st.slInId = 'in'; st.slOutId = 'out'; st.destId = 'dest';
st.rt = global.SLMK.engine.makeRuntime(model);
st.baseRt = st.rt; // per-channel runtime cache falls back to this

const assert = require('assert');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('ok  :', m); n++; };
const CC = (num, val) => [0xb0, num, val];
const countSince = (mark) => sent.length - mark;

// --- #6 Options button toggles options mode + emits soft LED / screen sysex ---
let mark = sent.length;
RT.handleControl(CC(0x5a, 127)); // Options
ok(st.optionsMode === true, '#6 Options enters options mode');
ok(countSince(mark) > 0, '#6 Options emits LED/screen sysex');
// soft LED for the Options button (id 65) should have been set
ok(sent.some((m) => m.bytes[8] === 65), '#6 Options button LED (id 65) set');

// menu select: Soft 2 (index 1) -> gate
mark = sent.length;
RT.handleControl(CC(0x33 + 1, 127)); // Soft 2 -> button index 1 -> gate
ok(st.optionsMenu === 'gate', '#6 Soft 2 selects Gate menu');

// knob 1 in gate menu edits step1 gate
const before = model.sequencer.tracks[0].patterns[0].steps[0].notes[0].gate;
RT.handleControl(CC(0x15, 6)); // Knob 1, delta +6
const after = model.sequencer.tracks[0].patterns[0].steps[0].notes[0].gate;
ok(after === before + 6, '#6 Knob1 edits step1 gate (+6): ' + before + '->' + after);

// screen paging: Screen Down -> stepPage 1
RT.handleControl(CC(0x52, 127));
ok(st.stepPage === 1, '#6 Screen Down pages to steps 9-16');
RT.handleControl(CC(0x51, 127));
ok(st.stepPage === 0, '#6 Screen Up pages back to steps 1-8');

// tempo menu, knob1 changes tempo
RT.handleControl(CC(0x33 + 3, 127)); // Soft 4 -> index 3 -> tempo
const t0 = model.sequencer.tempo;
RT.handleControl(CC(0x15, 5)); // knob1 +5
ok(model.sequencer.tempo === t0 + 5, '#6 tempo menu knob1 changes tempo');

// exit options
RT.handleControl(CC(0x5a, 127));
ok(st.optionsMode === false, '#6 Options exits options mode');

// --- #4 Scene buttons set pad view ---
RT.handleControl(CC(0x53, 127)); // Scene Top -> patterns
ok(st.padView === 'patterns', '#4 Scene Top -> Patterns view');
// pad press selects pattern (Pad 3 note 0x62)
RT.handleControl([0x90, 0x62, 127]);
ok(model.sequencer.tracks[0].activePattern === 2, '#4 pad selects pattern in Patterns view');
RT.handleControl(CC(0x54, 127)); // Scene Bottom -> steps
ok(st.padView === 'steps', '#4 Scene Bottom -> Steps view');

// --- #7 Pads Up/Down cycle patterns + arrow LEDs ---
model.sequencer.tracks[0].activePattern = 0;
mark = sent.length;
RT.handleControl(CC(0x56, 127)); // Pads Down
ok(model.sequencer.tracks[0].activePattern === 1, '#7 Pads Down advances pattern');
// arrow LED ids 0 (up) and 1 (down) should have been emitted
ok(sent.slice(mark).some((m) => m.bytes[8] === 0) && sent.slice(mark).some((m) => m.bytes[8] === 1), '#7 arrow LEDs (id 0/1) refreshed');

// --- #1 Mute/Solo (Soft 9-24) gate output ---
model.sequencer.tracks[0].activePattern = 0;
// Soft 9 (index 8) -> Mute channel 1
RT.handleControl(CC(0x33 + 8, 127));
ok(st.mute.has(1), '#1 Soft 9 mutes channel 1');
// dest output on channel 1 should now be suppressed
let m2 = sent.length;
require('assert'); // noop
// simulate a sequencer note on channel 0 (=ch1) via clockTick path: call sendMusic indirectly
// use the exposed engine? Instead check channelAudible via a knob on channel 1 output:
// Soft 17 (index 16) -> Solo channel 1
RT.handleControl(CC(0x33 + 16, 127));
ok(st.solo.has(1), '#1 Soft 17 solos channel 1');

// --- #7 Channel select (Soft 1-8) ---
RT.handleControl(CC(0x33 + 4, 127)); // Soft 5 -> channel 5
ok(st.activeChannel === 5, '#7 Soft 5 selects channel 5');
ok(st.gridTrack === 4, '#7 channel select moves grid track to 5');
ok(st.rt.channel === 5, '#7 rt.channel follows selected channel');

// --- #6 no-wrap pattern paging ---
model.sequencer.tracks[4].activePattern = 0;
st.gridTrack = 4;
RT.handleControl(CC(0x55, 127)); // Pads Up at pattern 0 -> should NOT wrap to 7
ok(model.sequencer.tracks[4].activePattern === 0, '#6 Pads Up at top does not wrap');
model.sequencer.tracks[4].activePattern = 7;
RT.handleControl(CC(0x56, 127)); // Pads Down at pattern 7 -> should NOT wrap to 0
ok(model.sequencer.tracks[4].activePattern === 7, '#6 Pads Down at bottom does not wrap');

// --- #2 fader LED brightness emitted on fader move ---
mark = sent.length;
RT.handleControl([0xb0, 0x29, 100]); // Fader 1 (CC 0x29) value 100
ok(sent.slice(mark).some((m) => m.bytes[8] === 54), '#2 fader move emits fader LED (id 54)');

// --- #1 mute actually gates dest output ---
st.mute.clear(); st.solo.clear();
RT.handleControl(CC(0x33 + 2, 127)); // Soft 3 -> channel 3 (rt.channel = 3)
mark = sent.length;
RT.handleControl([0xb0, 0x29, 64]); // Fader 1 -> CC on channel 3
ok(sent.slice(mark).some((m) => m.id === 'dest' && (m.bytes[0] & 0x0f) === 2), '#1 fader output reaches dest on ch3 when unmuted');
// mute channel 3 (Soft 11 -> index 10 -> Mute[2] -> channel 3)
RT.handleControl(CC(0x33 + 10, 127));
ok(st.mute.has(3), '#1 Soft 11 mutes channel 3');
mark = sent.length;
RT.handleControl([0xb0, 0x29, 90]); // Fader 1 again
ok(!sent.slice(mark).some((m) => m.id === 'dest' && (m.bytes[0] & 0x0f) === 2), '#1 muted channel 3 output is suppressed');

// --- #7 per-channel template swaps the control mapping ---
st.mute.clear(); st.solo.clear();
const tmpl = global.SLMK.studio.newModel();
tmpl.knobBanks[0][0].cc = 99; // knob 1 sends CC 99 on this channel's template
model.channelTemplates = new Array(8).fill(null);
model.channelTemplates[5] = tmpl; // assign to channel 6
RT.handleControl(CC(0x33 + 5, 127)); // Soft 6 -> channel 6
mark = sent.length;
RT.handleControl(CC(0x15, 3)); // knob 1 turn -> should emit CC 99 (from the channel template)
ok(sent.slice(mark).some((m) => m.id === 'dest' && m.bytes[1] === 99), '#7 channel template swaps knob mapping (CC 99)');
// selecting a channel without a template falls back to the base runtime (CC 0)
RT.handleControl(CC(0x33 + 0, 127)); // Soft 1 -> channel 1 (no template)
mark = sent.length;
RT.handleControl(CC(0x15, 3));
ok(sent.slice(mark).some((m) => m.id === 'dest' && m.bytes[1] === 0), '#7 channel without template uses base mapping (CC 0)');

// --- #8 knob screen: turning a knob emits both the arc value (type 3) and the number (text type 1, object 2) ---
// Put a knob on channel 1 (no options mode). st.optionsMode is false here.
RT.handleControl(CC(0x33 + 0, 127)); // channel 1
mark = sent.length;
RT.handleControl(CC(0x15, 4)); // Knob 1 turn
const scr = sent.slice(mark).filter((m) => m.id === 'out' && m.bytes[7] === 0x02); // Set Screen Properties
ok(scr.some((m) => m.bytes[9] === 0x03 && m.bytes[10] === 0), '#8 knob turn sets the graphic-knob value (type 3, value obj 0)');
ok(scr.some((m) => m.bytes[9] === 0x01 && m.bytes[10] === 2), '#8 knob turn sets the value number below (text type 1, obj 2)');

// --- #10 keybed light guide is OFF by default (would collide with fader/function LEDs) ---
st.padView = 'steps'; st.rt.padMode = 'sequencer';
RT.handleControl(CC(0x33 + 0, 127)); // channel 1 -> gridTrack 0 (step 1 has a note)
mark = sent.length;
RT.handleControl([0x90, 0x60, 127]); // Pad 1 press -> auditions step 1 (stopped)
RT.handleControl([0x80, 0x60, 0]);   // release
ok(!sent.slice(mark).some((m) => m.bytes[7] === 0x03 && m.bytes[8] >= 54 && m.bytes[8] <= 114), '#10 key guide off: no key-LED (54-114) sysex emitted');
RT.setKeyGuide(true);
mark = sent.length;
RT.handleControl([0x90, 0x60, 127]);
ok(sent.slice(mark).some((m) => m.bytes[7] === 0x03 && m.bytes[8] === 54 + (60 - 36)), '#10 key guide on: note 60 lights key LED id 78');
RT.handleControl([0x80, 0x60, 0]);
RT.setKeyGuide(false);

console.log('\n' + n + ' integration assertions passed');
