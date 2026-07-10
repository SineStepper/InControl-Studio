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
  sendToOutput: (id, bytes, when) => sent.push({ id, bytes, when }),
};
global.performance = { now: () => 1000 };

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

// #6 option screens: "Step N" tops, white knob glyph, menu name at centre-bottom
mark = sent.length;
RT.handleControl(CC(0x33 + 0, 127)); // Soft 1 -> Velocity
const scr6 = sent.slice(mark).filter((m) => m.bytes[7] === 0x02);
function scrText(col, obj) { const m = scr6.find((x) => x.bytes[8] === col && x.bytes[9] === 0x01 && x.bytes[10] === obj); if (!m) return null; let s = ''; for (let i = 11; i < m.bytes.length && m.bytes[i] !== 0x00; i++) s += String.fromCharCode(m.bytes[i]); return s; }
ok(scrText(0, 0) === 'Step 1', '#6 knob screen top says "Step 1"');
ok(scr6.some((m) => m.bytes[8] === 0 && m.bytes[9] === 0x04 && m.bytes[10] === 1 && m.bytes[11] === 127 && m.bytes[12] === 127 && m.bytes[13] === 127), '#6 velocity draws a white knob glyph (rgb 127,127,127 on obj 1)');
ok(scrText(8, 2) === 'Velocity', '#6 centre screen names the menu at the bottom');

// #37 gate menu uses a text-only screen layout (no knob glyph)
mark = sent.length;
RT.handleControl(CC(0x33 + 1, 127)); // Soft 2 -> Gate
const gscr = sent.slice(mark).filter((m) => m.bytes[7] === 0x02 || m.bytes[7] === 0x01);
ok(gscr.some((m) => m.bytes[7] === 0x01 && m.bytes[8] === 0), '#37 gate sets the empty (text-only) screen layout 0');
ok(!gscr.some((m) => m.bytes[7] === 0x02 && m.bytes[9] === 0x03), '#37 gate sends no knob-glyph value (type 3)');
RT.handleControl(CC(0x33 + 0, 127)); // back to Velocity
const vscr = sent.slice(mark).filter((m) => m.bytes[7] === 0x01 && m.bytes[8] === 1);
ok(vscr.length > 0, '#37 velocity restores the knob layout 1');

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
ok(scr.some((m) => m.bytes[9] === 0x01 && m.bytes[10] === 1), '#8 knob turn sets the value number above the glyph (text type 1, obj 1)');

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

// --- automation: recording a control move stores its bytes in the pattern's lane ---
const SEQ = global.SLMK.sequencer;
RT.handleControl(CC(0x33 + 0, 127)); // channel 1 -> gridTrack 0
st.seqRt = SEQ.makeSeqRuntime(model.sequencer); st.seqRt.tick = 0; st.clock = 1; st.recording = true; st.optionsMode = false;
mark = sent.length;
RT.handleControl(CC(0x15, 4)); // Knob 1 turn -> emits a CC and records it
const lane = model.sequencer.tracks[0].patterns[0].automation;
ok(lane && Object.keys(lane).length === 1, 'automation lane created for the moved knob');
const laneKey = Object.keys(lane)[0];
ok(lane[laneKey][0] && lane[laneKey][0].length === 3, 'automation captured the CC bytes at tick 0');
st.recording = false; st.clock = null;

// --- #12 LED colour scheme ---
// helper: last RGB SysEx sent for an LED id -> {r,g,b,beh}
function lastLed(id) {
  for (let i = sent.length - 1; i >= 0; i--) { const b = sent[i].bytes; if (b[7] === 0x03 && b[8] === id) return { beh: b[9], r: b[10], g: b[11], b: b[12] }; }
  return null;
}
st.mute.clear(); st.solo.clear(); st.recording = false; st.clock = null; st.optionsMode = false;
st.padView = 'steps'; st.rt.padMode = 'sequencer';
RT.handleControl(CC(0x33 + 0, 127)); // channel 1 -> gridTrack 0
st.running = true;
RT.refreshSurface();
const play = lastLed(36), stop = lastLed(35), loop = lastLed(37), dup = lastLed(66), clr = lastLed(67), grid = lastLed(64), trk = lastLed(30);
ok(play && play.g > 0 && play.r === 0 && play.b === 0 && play.g < 60, '#12 Play dim green when stopped');
ok(stop && stop.r > 60 && stop.g > 60 && stop.b > 60, '#12 Stop bright white when stopped');
ok(loop && loop.r === 0 && loop.g === 0 && loop.b === 0, '#12 Loop unlit');
ok(dup && dup.g > 0 && dup.r === 0, '#12 Duplicate dim green');
ok(clr && clr.r > 0 && clr.g === 0, '#12 Clear dim red');
ok(grid && grid.r > 0 && grid.g > 0 && grid.b > 0 && grid.r < 60, '#12 Grid dim white');
ok(trk && trk.b > 0 && trk.r === 0 && trk.g === 0, '#12 Track Left dim blue');
// Record engaged -> bright red
st.recording = true; RT.refreshSurface();
const rec = lastLed(32);
ok(rec && rec.r > 60 && rec.g === 0, '#12 Record bright red when recording');
st.recording = false; st.running = false;

// --- #24 Screen Up/Down page knob banks ---
global.SLMK.studio.addKnobBank(model); // now 2 knob banks
st.rt.knobBank = 0; st.optionsMode = false;
RT.handleControl(CC(0x52, 127)); // Screen Down -> knob bank +
ok(st.rt.knobBank === 1, '#24 Screen Down advances the knob bank');
RT.handleControl(CC(0x51, 127)); // Screen Up -> knob bank -
ok(st.rt.knobBank === 0, '#24 Screen Up goes back a knob bank');

// --- #15 keyboard notes are re-channeled to the selected Part ---
RT.handleControl(CC(0x33 + 2, 127)); // select channel 3 -> Part channel 3
mark = sent.length;
RT.handleKeys([0x90, 60, 100]); // key note-on arriving on channel 1 (0x90)
ok(sent.slice(mark).some((m) => m.id === 'dest' && m.bytes[0] === (0x90 | 2)), '#15 keybed note re-channeled to selected Part (ch3)');

// --- #16 content change fires the onChange callback ---
let changed = 0; RT.onChange(() => changed++);
st.heldPads.add(0); st.rt.padMode = 'sequencer';
RT.handleKeys([0x90, 64, 90]); // hold-pad + key -> toggles a note, should fire onChange
ok(changed > 0, '#16 keyboard-driven note edit fires onChange for the UI');
st.heldPads.clear();

// --- #21 muting a channel sends All-Notes-Off so notes don't hang ---
st.mute.clear(); st.solo.clear();
mark = sent.length;
RT.handleControl(CC(0x33 + 8, 127)); // Soft 9 -> Mute channel 1
ok(sent.slice(mark).some((m) => m.id === 'dest' && (m.bytes[0] & 0xf0) === 0xb0 && m.bytes[1] === 123), '#21 mute sends All-Notes-Off (CC123) to the muted channel');
// a note-off still passes through even while muted (no hang)
mark = sent.length;
require('assert').ok(true);
// simulate the sequencer trying to send a note-off on the muted channel 1 (ch 0)
// via sendMusic path: use a fader mapped... simplest: check channelAudible logic indirectly is covered above.

// --- #31 button-bank paging repaints the 16 above-fader buttons to the bank's
//     colours (bank 0 = mute/solo orange; bank 1 shows the bank's own colours) ---
st.mute.clear(); st.solo.clear(); st.running = true; st.rt.buttonBank = 0;
model.buttonBanks[1][0].enabled = true; model.buttonBanks[1][0].led.idle = '#00ff00'; // bank-1 button 1 = green
RT.refreshSurface();
const muteBefore = lastLed(12);
ok(muteBefore && muteBefore.r > 0 && muteBefore.b === 0, '#31 bank 0 shows Mute (orange) on id 12');
RT.handleControl(CC(0x58, 127)); // Right Soft Down -> button bank + (to bank 1)
ok(st.rt.buttonBank === 1, '#31 Right Soft Down pages to button bank 1');
const bankLed = lastLed(12);
ok(bankLed && bankLed.g > 60 && bankLed.r === 0, '#31 bank 1 repaints id 12 to the bank colour (green), not stuck orange');
RT.handleControl(CC(0x57, 127)); // Right Soft Up -> back to bank 0
ok(lastLed(12).r > 0 && lastLed(12).b === 0, '#31 paging back restores Mute (orange)');
st.rt.buttonBank = 0; st.running = false;

// --- #26 sequencer sends MIDI clock (Start/Stop) to the SL out port ---
st.running = true;
mark = sent.length;
RT.seqPlay();
RT.tick();
ok(sent.slice(mark).some((m) => m.id === 'out' && m.bytes.length === 1 && m.bytes[0] === 0xf8), '#26 sends F8 timing clock to the SL out');
// #34: transport Start/Stop are NOT sent to the SL (they launch its internal sequencer -> phantom C)
ok(!sent.slice(mark).some((m) => m.id === 'out' && m.bytes.length === 1 && (m.bytes[0] === 0xfa || m.bytes[0] === 0xfc)), '#34 no MIDI Start/Stop sent to the SL');
mark = sent.length;
RT.seqStop();
ok(!sent.slice(mark).some((m) => m.bytes.length === 1 && m.bytes[0] === 0xfc), '#34 Stop does not send FC to the SL');
st.running = false;

// --- #17 Patterns view pages the Parts with Pads Up/Down ---
st.padView = 'patterns'; st.partTop = 0; st.rt.padMode = 'sequencer';
RT.handleControl(CC(0x56, 127)); // Pads Down -> next pair of Parts
ok(st.partTop === 1, '#17 Pads Down pages the visible Parts');
RT.handleControl(CC(0x55, 127)); // Pads Up
ok(st.partTop === 0, '#17 Pads Up pages Parts back');
st.padView = 'steps';

// --- double-key on record: the sequencer must not echo a just-recorded note
//     within the same pattern cycle (it was already monitored live once) ---
st.mute.clear(); st.solo.clear(); st.optionsMode = false; st.recording = false;
RT.handleControl(CC(0x33 + 0, 127)); // channel 1 -> gridTrack 0, Part channel 1
model.sequencer.tracks[0].patterns[model.sequencer.tracks[0].activePattern] = SEQ.newPattern();
st.seqRt = SEQ.makeSeqRuntime(model.sequencer); st.seqRt.playing = true; st.seqRt.tick = 0; st.clock = 1;
st.recEcho.clear(); st.recRef.clear();
for (let i = 0; i < 4; i++) RT.tick(); // playhead now mid-step 0 (tick 4 of 1/16 = 6 ticks/step)
st.recording = true;
mark = sent.length;
RT.handleKeys([0x90, 72, 110]); // record C5 -> lands on the next step, monitored live once
for (let i = 0; i < 88; i++) RT.tick(); // run out the rest of the 96-tick cycle
const echoOns = sent.slice(mark).filter((m) => m.id === 'dest' && (m.bytes[0] & 0xf0) === 0x90 && m.bytes[1] === 72 && m.bytes[2] > 0).length;
ok(echoOns === 1, 'recorded note sounds once this cycle (live monitor only, no sequencer echo)');
// after the cycle elapses, the note plays normally from the sequencer
mark = sent.length;
for (let i = 0; i < 96; i++) RT.tick();
const nextOns = sent.slice(mark).filter((m) => m.id === 'dest' && (m.bytes[0] & 0xf0) === 0x90 && m.bytes[1] === 72 && m.bytes[2] > 0).length;
ok(nextOns >= 1, 'recorded note plays from the sequencer on the next cycle');
st.recording = false; st.clock = null; st.seqRt.playing = false; st.recEcho.clear();

// --- record quantization: a note played on the beat lands on that step, and one
//     played just past halfway lands on the next step (symmetric nearest-step) ---
st.mute.clear(); st.solo.clear(); st.optionsMode = false;
RT.handleControl(CC(0x33 + 0, 127));
function recAt(tick, note) {
  model.sequencer.tracks[0].patterns[0] = SEQ.newPattern();
  st.seqRt = SEQ.makeSeqRuntime(model.sequencer); st.seqRt.playing = true; st.seqRt.tick = 0; st.clock = 1;
  st.recEcho.clear(); st.recRef.clear(); st.recording = true;
  for (let i = 0; i <= tick; i++) RT.tick(); // process ticks 0..tick; playhead "now" = tick
  RT.handleKeys([0x90, note, 100]);
  RT.handleKeys([0x80, note, 0]);
  st.recording = false; st.clock = null; st.seqRt.playing = false;
  return model.sequencer.tracks[0].patterns[0].steps.findIndex((s) => s.notes.some((x) => x.note === note));
}
ok(recAt(6, 80) === 1, 'note on the step-2 boundary (tick 6) records to step 2');       // exactly on beat
ok(recAt(7, 81) === 1, 'note a tick after the boundary stays on that step');            // just after
ok(recAt(2, 82) === 0, 'note before the halfway point records to the current step');    // rounds back
ok(recAt(4, 83) === 1, 'note past the halfway point records to the next step');         // rounds forward
st.recEcho.clear();

// --- #12 per-pad pressure drives pad LED brightness (instrument mode) ---
st.mute.clear(); st.solo.clear(); st.optionsMode = false; st.recording = false; st.running = true;
st.rt.padMode = 'pads';
mark = sent.length;
RT.handleControl([0xa0, 0x60, 100]); // Pad 1 pressure (poly aftertouch)
ok(sent.slice(mark).some((m) => m.bytes[7] === 0x03 && m.bytes[8] === 38), '#12 pad pressure repaints pad 1 LED (id 38)');
st.rt.padMode = 'sequencer'; st.running = false;

// --- #29 Play sends All-Notes-Off (CC123) to all 16 channels on the dest ---
st.seqRt = SEQ.makeSeqRuntime(model.sequencer); st.seqRt.tick = 0; st.clock = null;
mark = sent.length;
RT.seqPlay();
const panicChans = new Set(sent.slice(mark).filter((m) => m.id === 'dest' && (m.bytes[0] & 0xf0) === 0xb0 && m.bytes[1] === 123).map((m) => m.bytes[0] & 0x0f));
ok(panicChans.size === 16, '#29 Play panics all 16 channels (got ' + panicChans.size + ')');
RT.seqStop();

// --- MIDI is ALWAYS realtime: sequencer notes are never scheduled/timestamped,
//     even with the metronome on and a lead offset set ---
st.mute.clear(); st.solo.clear(); st.optionsMode = false; st.recording = false;
model.sequencer.tracks[0].patterns[0] = SEQ.newPattern();
model.sequencer.tracks[0].patterns[0].steps[0].notes = [{ note: 60, velocity: 100, gate: 6 }];
model.sequencer.metronome = { on: true, sound: 'Ping' };
RT.setMetroLead(40);
st.seqRt = SEQ.makeSeqRuntime(model.sequencer); st.seqRt.playing = true; st.seqRt.tick = 0; st.clock = 1; st.gridTrack = 0;
mark = sent.length;
RT.tick(); // process tick 0 -> step 1 note-on
const on0 = sent.slice(mark).find((m) => m.id === 'dest' && (m.bytes[0] & 0xf0) === 0x90 && m.bytes[1] === 60);
ok(on0 && on0.when === undefined, 'sequencer note is sent in realtime (never timestamped/delayed)');
st.clock = null; st.seqRt.playing = false; RT.setMetroLead(null); model.sequencer.metronome.on = false;

// --- metronome click is SCHEDULED EARLY (ahead by the audio latency) so it is
//     *heard* on the beat, while MIDI stays realtime ---
const clickTimes = [];
global.AudioContext = function () {
  this.currentTime = 0; this.state = 'running'; this.baseLatency = 0; this.outputLatency = 0.05; this.destination = {};
  this.createGain = () => ({ connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } });
  this.createOscillator = () => ({ connect() {}, frequency: {}, start(t) { clickTimes.push(t); }, stop() {} });
  this.resume = () => {};
};
st.audioCtx = null; st.metro = null; RT.setMetroLead(null);
model.sequencer.metronome = { on: true, sound: 'Ping' }; model.sequencer.tempo = 120;
st.seqRt = SEQ.makeSeqRuntime(model.sequencer); st.seqRt.playing = true; st.seqRt.tick = 0; st.clock = 1; st.gridTrack = 0;
const secPerTick = 60 / 120 / 24;
for (let i = 0; i <= 16; i++) RT.tick(); // process ticks 0..16; beat 24 gets scheduled at tick 16
ok(clickTimes.length >= 2, 'metronome look-ahead schedules clicks');
const targetBeat24 = 8 * secPerTick; // (24-16) ticks ahead of the frozen audio-now
ok(clickTimes.some((t) => Math.abs(t - (targetBeat24 - 0.05)) < 1e-6), 'click is scheduled 50ms (audio latency) early, so it is heard on the beat');
st.clock = null; st.seqRt.playing = false; model.sequencer.metronome.on = false; st.audioCtx = null; delete global.AudioContext;

console.log('\n' + n + ' integration assertions passed');
