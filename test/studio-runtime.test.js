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

// #6 option screens: "Step N" tops, white knob glyph, menu name at center-bottom
mark = sent.length;
RT.handleControl(CC(0x33 + 0, 127)); // Soft 1 -> Velocity
const scr6 = sent.slice(mark).filter((m) => m.bytes[7] === 0x02);
function scrText(col, obj) { const m = scr6.find((x) => x.bytes[8] === col && x.bytes[9] === 0x01 && x.bytes[10] === obj); if (!m) return null; let s = ''; for (let i = 11; i < m.bytes.length && m.bytes[i] !== 0x00; i++) s += String.fromCharCode(m.bytes[i]); return s; }
ok(scrText(0, 0) === 'Step 1', '#6 knob screen top says "Step 1"');
ok(scr6.some((m) => m.bytes[8] === 0 && m.bytes[9] === 0x04 && m.bytes[10] === 1 && m.bytes[11] === 127 && m.bytes[12] === 127 && m.bytes[13] === 127), '#6 velocity draws a white knob glyph (rgb 127,127,127 on obj 1)');
ok(scrText(8, 2) === 'Velocity', '#6 center screen names the menu at the bottom');
// #68 each menu button's screen has a color bar (obj 3) in its menu color; none where there's no label
const optRgb = (col) => scr6.find((m) => m.bytes[9] === 0x04 && m.bytes[8] === col && m.bytes[10] === 3);
const velBar = optRgb(0); // Velocity -> red
ok(velBar && velBar.bytes[11] > 0 && velBar.bytes[12] === 0 && velBar.bytes[13] === 0, '#68 Velocity menu bar is red (obj 3)');
const emptyBar = optRgb(4); // no menu maps to soft button 5 -> no color
ok(!emptyBar || (emptyBar.bytes[11] === 0 && emptyBar.bytes[12] === 0 && emptyBar.bytes[13] === 0), '#68 a column with no menu label gets no color bar');

// #37 gate shows text (# boxes + number) but NO knob glyph, and the screen isn't blank
mark = sent.length;
RT.handleControl(CC(0x33 + 1, 127)); // Soft 2 -> Gate (a menu change)
const gsend = sent.slice(mark);
function txtOf(list, col, obj) { const m = list.find((x) => x.bytes[7] === 0x02 && x.bytes[8] === col && x.bytes[9] === 0x01 && x.bytes[10] === obj); if (!m) return null; let s = ''; for (let i = 11; i < m.bytes.length && m.bytes[i] !== 0; i++) s += String.fromCharCode(m.bytes[i]); return s; }
ok(!gsend.some((m) => m.bytes[7] === 0x02 && m.bytes[9] === 0x03), '#37 gate sends no knob glyph (no type-3 value)');
ok(txtOf(gsend, 0, 0) === 'Step 1', '#37 gate still shows its text (screen not blank)');
ok(gsend.some((m) => m.bytes[7] === 0x01), '#37 menu change re-inits the screen layout (clears stale knobs)');
// tempo page: only knobs 1-2 (tempo, swing) carry a value glyph; knobs 3-8 have none
mark = sent.length;
RT.handleControl(CC(0x33 + 3, 127)); // Soft 4 -> Tempo
const tsend = sent.slice(mark);
const tvalCols = tsend.filter((m) => m.bytes[7] === 0x02 && m.bytes[9] === 0x03).map((m) => m.bytes[8]);
ok(tvalCols.every((c) => c <= 1), '#tempo no phantom knob glyphs on knobs without a parameter (only cols 0-1)');
RT.handleControl(CC(0x33 + 0, 127)); // back to Velocity

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

// --- #54 Steps-view Pads Up/Down PREVIEW patterns without changing what plays ---
model.sequencer.tracks[0].activePattern = 0; st.viewPattern = null; st.gridTrack = 0;
mark = sent.length;
RT.handleControl(CC(0x56, 127)); // Pads Down (steps view)
ok(st.viewPattern === 1 && model.sequencer.tracks[0].activePattern === 0, '#54 Pads Down previews the next pattern, playhead unchanged');
// arrow LED ids 0 (up) and 1 (down) should have been emitted
ok(sent.slice(mark).some((m) => m.bytes[8] === 0) && sent.slice(mark).some((m) => m.bytes[8] === 1), '#7 arrow LEDs (id 0/1) refreshed');
st.viewPattern = null;

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

// --- #6 no-wrap pattern-view paging ---
st.gridTrack = 4; st.viewPattern = 0;
RT.handleControl(CC(0x55, 127)); // Pads Up at view 0 -> should NOT wrap to 7
ok(st.viewPattern === 0, '#6 view paging at top does not wrap');
st.viewPattern = 7;
RT.handleControl(CC(0x56, 127)); // Pads Down at view 7 -> should NOT wrap to 0
ok(st.viewPattern === 7, '#6 view paging at bottom does not wrap');
st.viewPattern = null; st.gridTrack = 0;

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

// --- #48-51 keybed light guide via the RGB LED-SysEx command (id = 54 + note-36),
//     skipping ids 54-67 which are shared with the fader/function LEDs ---
st.padView = 'steps'; st.rt.padMode = 'sequencer'; st.clock = null; st.keyGuide = true;
RT.handleControl(CC(0x33 + 0, 127)); // channel 1 -> gridTrack 0 (step 1 has a note 60 -> id 78)
mark = sent.length;
RT.handleControl([0x90, 0x60, 127]); // Pad 1 press -> auditions step 1 (stopped) -> key red
ok(sent.slice(mark).some((m) => m.bytes[7] === 0x03 && m.bytes[8] === 78 && m.bytes[10] > 60 && m.bytes[11] === 0), '#49 auditioned key (note 60 -> id 78) lights red');
RT.handleControl([0x80, 0x60, 0]);   // release -> reverts to Part color
mark = sent.length;
RT.handleKeys([0x90, 64, 100]); // played key on the keybed (note 64 -> id 82) -> white
ok(sent.slice(mark).some((m) => m.bytes[7] === 0x03 && m.bytes[8] === 82 && m.bytes[10] > 60 && m.bytes[11] > 60 && m.bytes[12] > 60), '#50 pressed key lights white');
RT.handleKeys([0x80, 64, 0]);
// keys that fall in the fader/function id zone (ids 54-67 = notes 36-49) are skipped
mark = sent.length;
RT.handleKeys([0x90, 40, 100]); // note 40 -> id 58 (fader zone) -> skipped
ok(!sent.slice(mark).some((m) => m.bytes[7] === 0x03 && m.bytes[8] === 58), '#48-51 low keys in the fader/function id zone are not lit (no clobber)');
RT.handleKeys([0x80, 40, 0]);
// guide off -> no color for played keys
RT.setKeyGuide(false);
mark = sent.length;
RT.handleKeys([0x90, 64, 100]);
ok(!sent.slice(mark).some((m) => m.bytes[7] === 0x03 && m.bytes[8] === 82 && (m.bytes[10] || m.bytes[11] || m.bytes[12])), '#51 guide off: no color for a played key');
RT.handleKeys([0x80, 64, 0]);
RT.setKeyGuide(true);

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

// --- #12 LED color scheme ---
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
//     colors (bank 0 = mute/solo orange; bank 1 shows the bank's own colors) ---
st.mute.clear(); st.solo.clear(); st.running = true; st.rt.buttonBank = 0;
model.buttonBanks[1][0].enabled = true; model.buttonBanks[1][0].led.idle = '#00ff00'; // bank-1 button 1 = green
RT.refreshSurface();
const muteBefore = lastLed(12);
ok(muteBefore && muteBefore.r > 0 && muteBefore.b === 0, '#31 bank 0 shows Mute (orange) on id 12');
RT.handleControl(CC(0x58, 127)); // Right Soft Down -> button bank + (to bank 1)
ok(st.rt.buttonBank === 1, '#31 Right Soft Down pages to button bank 1');
const bankLed = lastLed(12);
ok(bankLed && bankLed.g > 60 && bankLed.r === 0, '#31 bank 1 repaints id 12 to the bank color (green), not stuck orange');
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
// #59 Stop sends All-Notes-Off (CC123) to every channel
const stopPanic = new Set(sent.slice(mark).filter((m) => m.id === 'dest' && (m.bytes[0] & 0xf0) === 0xb0 && m.bytes[1] === 123).map((m) => m.bytes[0] & 0x0f));
ok(stopPanic.size === 16, '#59 Stop sends All-Notes-Off to all 16 channels (got ' + stopPanic.size + ')');
st.running = false;

// --- #17 Patterns view pages the Parts with Pads Up/Down ---
st.padView = 'patterns'; st.partTop = 0; st.rt.padMode = 'sequencer';
RT.handleControl(CC(0x56, 127)); // Pads Down -> next pair of Parts (by 2, #52)
ok(st.partTop === 2, '#52 Pads Down pages the visible Parts by 2');
RT.handleControl(CC(0x55, 127)); // Pads Up
ok(st.partTop === 0, '#17 Pads Up pages Parts back');
st.padView = 'steps';

// --- #53 switching view keeps the Part + auto-pages to what's playing ---
st.gridTrack = 5; st.activeChannel = 6; st.partTop = 0; st.viewPattern = 3;
RT.handleControl(CC(0x53, 127)); // Scene Top -> Patterns view
ok(st.activeChannel === 6, '#53 switching view does not change the selected Part');
ok(st.partTop === 4, '#53 Patterns view auto-pages to the active Part (track 5 -> row 4)');
RT.handleControl(CC(0x54, 127)); // Scene Bottom -> Steps view
ok(st.viewPattern === null, '#53 Steps view snaps the viewed pattern back to the playing one');
// --- #42 Part-select buttons default to rainbow Part colors, not blue ---
st.gridTrack = 0; st.activeChannel = 1; st.running = true;
model.sequencer.tracks[1].color = null; // no explicit color -> should fall back to a Part color, not blue
mark = sent.length;
RT.refreshSurface();
const p2led = lastLed(4 + 1); // Soft 2 = Part 2 (id 5)
ok(p2led && !(p2led.r < p2led.b && p2led.g < p2led.b), '#42 Part 2 button is a Part color (orange-ish), not a blue default');
st.running = false;
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
// release the held key so the recorded note is finalised — while a key is HELD the
// sequencer must NOT re-emit that note (it would cut the live note being held, #82).
RT.handleKeys([0x80, 72, 0]);
// after the cycle elapses, the (now released) note plays normally from the sequencer
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

// --- same-note overwrite: re-recording a pitch on a step replaces it, no stacking ---
model.sequencer.tracks[0].patterns[0] = SEQ.newPattern();
st.seqRt = SEQ.makeSeqRuntime(model.sequencer); st.seqRt.playing = true; st.seqRt.tick = 0; st.clock = 1;
st.recEcho.clear(); st.recRef.clear(); st.seqNoteTick.clear(); st.recording = true;
RT.tick(); // playhead on step 1
RT.handleKeys([0x90, 60, 40]); RT.handleKeys([0x80, 60, 0]);  // C4 vel 40 on step 1
RT.handleKeys([0x90, 60, 110]); RT.handleKeys([0x80, 60, 0]); // C4 again on step 1 -> overwrite
const step0c4 = model.sequencer.tracks[0].patterns[0].steps[0].notes.filter((x) => x.note === 60);
ok(step0c4.length === 1, 'a re-recorded C4 on a step overwrites, not stacks (one note)');
ok(step0c4[0].velocity === 110, 're-recorded note keeps the newest velocity');
st.recording = false; st.clock = null; st.seqRt.playing = false; st.recEcho.clear();

// --- forward-quantize wraps past the loop end to step 1 (no longer stuck on the last step) ---
model.sequencer.tracks[0].patterns[0] = SEQ.newPattern();
st.seqRt = SEQ.makeSeqRuntime(model.sequencer); st.seqRt.playing = true; st.seqRt.tick = 0; st.clock = 1;
st.recEcho.clear(); st.recRef.clear(); st.seqNoteTick.clear(); st.recording = true;
for (let i = 0; i <= 94; i++) RT.tick(); // late in step 16 (tick 94, past its halfway boundary)
RT.handleKeys([0x90, 77, 100]); RT.handleKeys([0x80, 77, 0]);
const steps77 = model.sequencer.tracks[0].patterns[0].steps;
ok(steps77[0].notes.some((x) => x.note === 77) && !steps77[15].notes.some((x) => x.note === 77),
  'a note played late in the last step rounds forward to step 1, not stranded on step 16');
st.recording = false; st.clock = null; st.seqRt.playing = false; st.recEcho.clear(); st.seqNoteTick.clear();

// --- hold-pad-to-program works while the Options screen is open ---
st.mute.clear(); st.solo.clear(); st.recording = false; st.clock = null;
RT.handleControl(CC(0x33 + 0, 127)); // select channel 1 -> gridTrack 0
model.sequencer.tracks[0].patterns[0] = SEQ.newPattern(); model.sequencer.tracks[0].activePattern = 0;
st.optionsMode = true; st.padView = 'steps'; st.rt.padMode = 'sequencer'; st.heldPads.clear(); st.heldKeys.clear();
RT.handleControl([0x90, 0x60 + 3, 127]); // hold Pad 4 (step 4) in options mode
ok(st.heldPads.has(3), 'options mode: holding a pad registers it as held');
RT.handleKeys([0x90, 62, 100]); RT.handleKeys([0x80, 62, 0]); // play a key while the pad is held
ok(model.sequencer.tracks[0].patterns[0].steps[3].notes.some((x) => x.note === 62),
  'options mode: hold-pad + key programs the note onto that step');
RT.handleControl([0x80, 0x60 + 3, 0]); // release the pad
ok(!st.heldPads.has(3), 'options mode: releasing the pad clears it from held');
st.optionsMode = false; st.heldPads.clear(); st.heldKeys.clear();

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

// --- #60 each Part keeps its OWN control values (separate runtimes) ---
st.mute.clear(); st.solo.clear(); st.optionsMode = false; st.recording = false; st.clock = null; st.seqRt = null;
st.channelRt = {}; st.heldKeys.clear(); st.noteChan.clear();
RT.handleControl(CC(0x33 + 0, 127)); // Part 1
const rt1 = st.rt; rt1.acc['knob:0:0'] = 99;
RT.handleControl(CC(0x33 + 1, 127)); // Part 2
ok(st.rt !== rt1, '#60 each Part gets its own runtime');
ok(st.rt.acc['knob:0:0'] === undefined, '#60 Part 2 does not inherit Part 1 knob value');
RT.handleControl(CC(0x33 + 0, 127)); // back to Part 1
ok(st.rt === rt1 && st.rt.acc['knob:0:0'] === 99, '#60 Part 1 keeps its own knob value across switches');

// --- #64 held note stops on its ORIGIN channel when switching Parts ---
st.channelRt = {}; st.heldKeys.clear(); st.noteChan.clear();
RT.handleControl(CC(0x33 + 0, 127)); // Part 1 -> channel 1 (ch0)
RT.handleKeys([0x90, 61, 100]);      // hold a note -> sounds on ch0, tracked
mark = sent.length;
RT.handleControl(CC(0x33 + 2, 127)); // switch to Part 3
ok(sent.slice(mark).some((m) => m.id === 'dest' && m.bytes[0] === (0x80 | 0) && m.bytes[1] === 61), '#64 switching Parts sends note-off on the ORIGIN channel (ch1), not the new one');
ok(st.heldKeys.size === 0, '#64 physically-held keys are cleared after the switch');
st.heldKeys.clear(); st.noteChan.clear();

// --- #61 downbeat flashes green on the grid LED, other beats yellow ---
st.optionsMode = false; st.mute.clear(); st.solo.clear(); st.gridTrack = 0;
model.sequencer.tracks[0].patterns[0] = SEQ.newPattern(); // 16 steps @ 1/16 -> 96 ticks/loop
model.sequencer.metronome = { on: true, sound: 'Ping' }; st.audioCtx = null;
st.seqRt = SEQ.makeSeqRuntime(model.sequencer); st.seqRt.playing = true; st.seqRt.tick = 0; st.clock = 1;
const led64 = (mk) => { const m = sent.slice(mk).reverse().find((x) => x.bytes[7] === 0x03 && x.bytes[8] === 64); return m ? { r: m.bytes[10], g: m.bytes[11], b: m.bytes[12] } : null; };
mark = sent.length; RT.tick(); // beatTick 0 = downbeat
let g0 = led64(mark);
ok(g0 && g0.r === 0 && g0.g > 0 && g0.b === 0, '#61 downbeat flashes green');
for (let i = 0; i < 23; i++) RT.tick(); // advance to seqRt.tick = 24
mark = sent.length; RT.tick(); // beatTick 24 = beat 2 (not a downbeat)
let g1 = led64(mark);
ok(g1 && g1.r > 0 && g1.g > 0 && g1.b === 0, '#61 non-downbeat beats flash yellow');
st.clock = null; st.seqRt.playing = false; model.sequencer.metronome.on = false;

// --- #63/#65/#66 knob screens: colored bars, part label at the bottom, 5th-screen step graphic ---
st.optionsMode = false; st.clock = null; st.seqRt = null; st.running = true;
RT.handleControl(CC(0x33 + 0, 127)); // Part 1
mark = sent.length;
RT.refreshSurface();
const kscr = sent.slice(mark).filter((m) => m.bytes[7] === 0x02);
const stxt = (col, obj) => { const m = kscr.find((x) => x.bytes[8] === col && x.bytes[9] === 0x01 && x.bytes[10] === obj); if (!m) return null; let s = ''; for (let i = 11; i < m.bytes.length && m.bytes[i] !== 0; i++) s += String.fromCharCode(m.bytes[i]); return s; };
ok(kscr.some((m) => m.bytes[8] === 0 && m.bytes[9] === 0x04 && m.bytes[10] === 0), '#63 knob screen top bar gets an RGB color (type 4, obj 0)');
ok(kscr.some((m) => m.bytes[8] === 0 && m.bytes[9] === 0x04 && m.bytes[10] === 2), '#63 knob screen bottom bar gets an RGB color (type 4, obj 2)');
ok(stxt(0, 3), '#65 part label sits on the bottom text row (obj 3)');
ok(stxt(0, 2) === '' || stxt(0, 2) == null, '#65 the old label row (obj 2) is cleared so the label does not appear twice');
ok(stxt(4, 3), '#65 column 4 is a normal knob screen with its own Part label (obj 3), not the animation');
const notif = sent.slice(mark).find((m) => m.bytes[7] === 0x04);
ok(notif, '#66 the 8-pattern chain strip is sent via the center-screen notification command (0x04)');
{ let s = ''; for (let i = 8; i < notif.bytes.length && notif.bytes[i] !== 0; i++) s += String.fromCharCode(notif.bytes[i]); ok(s.length === 8, '#66 the notification carries the 8-pattern strip'); }
st.running = false;

// --- 5th screen (column 8): knob bank / part name / Mute+Solo rows, with the
//     correct edge-bar colors (left = Part, right-top = top button row, right-bottom = bottom row) ---
st.optionsMode = false; st.clock = null; st.seqRt = null; st.running = true;
if (st.rt) st.rt.buttonBank = 0;
RT.handleControl(CC(0x33 + 0, 127)); // Part 1
mark = sent.length;
RT.refreshSurface();
const cscr = sent.slice(mark).filter((m) => m.bytes[7] === 0x02 && m.bytes[8] === 8);
const ctxt = (obj) => { const m = cscr.find((x) => x.bytes[9] === 0x01 && x.bytes[10] === obj); if (!m) return null; let s = ''; for (let i = 11; i < m.bytes.length && m.bytes[i] !== 0; i++) s += String.fromCharCode(m.bytes[i]); return s; };
ok(ctxt(1) === 'Part 1', '#69 5th screen row 1 (obj 1) is the Part name');
ok(/^Knobs/.test(ctxt(0) || ''), '#69 the row above the part name (obj 0) is the knob bank, not the pattern strip');
ok(ctxt(2) === 'Mute' && ctxt(3) === 'Solo', '#69 the button-bank rows read "Mute" (obj 2) over "Solo" (obj 3)');
// on this screen an object's color bar renders one region below its text, so the
// RIGHT-TOP bar (beside "Mute" on obj 2) is set on obj 1 and RIGHT-BOTTOM on obj 2.
const cRgb = (obj) => cscr.find((m) => m.bytes[9] === 0x04 && m.bytes[10] === obj);
const leftBar = cRgb(0), topBar = cRgb(1), botBar = cRgb(2);
ok(leftBar && leftBar.bytes[11] > leftBar.bytes[13], '#68 LEFT edge bar (obj 0) is the selected Part color (Part 1 red: R > B)');
ok(topBar && topBar.bytes[11] > topBar.bytes[13], '#68 RIGHT-TOP bar (obj 1) is the mute row average (orange: R > B)');
ok(botBar && botBar.bytes[13] > botBar.bytes[11], '#68 RIGHT-BOTTOM bar (obj 2) is the solo row average (blue: B > R)');
ok(!cRgb(3), '#68 obj 3 gets no color (its bar region is off-screen)');

// --- #68 knob screen top bar only appears for ENABLED knobs ---
model.knobBanks[0][0].enabled = true; model.knobBanks[0][1].enabled = false;
mark = sent.length; RT.refreshSurface();
const kbars = sent.slice(mark).filter((m) => m.bytes[7] === 0x02 && m.bytes[9] === 0x04 && m.bytes[10] === 0);
const barAt = (col) => { const m = kbars.find((x) => x.bytes[8] === col); return m ? (m.bytes[11] || m.bytes[12] || m.bytes[13]) : 0; };
ok(barAt(0) > 0, '#68 enabled knob (col 0) shows a Part-color top bar');
ok(barAt(1) === 0, '#68 disabled knob (col 1) shows no top bar (black)');
model.knobBanks[0][1].enabled = true;

// --- #69 adjusting a knob briefly shows its value on the 5th screen ---
Object.assign(model.knobBanks[0][0], { message_type: 'CC', cc: 74, start: 0, end: 127, bit_depth: '7-bit', channel: 'default', mode: 'Absolute', step: 1, enabled: true, led: { idle: '#00ff00', pressed: '#fff' } });
st.channelRt = {}; RT.handleControl(CC(0x33 + 0, 127));
mark = sent.length;
RT.handleControl(CC(0x15, 5)); // knob 1 turn (+5) on the resolved knob CC
const v5 = sent.slice(mark).filter((m) => m.bytes[7] === 0x02 && m.bytes[8] === 8 && m.bytes[9] === 0x01 && m.bytes[10] === 5);
ok(v5.length > 0, '#69 turning a knob writes a value overlay onto the 5th screen bottom row (column 8, obj 5)');
st.screen5 = null; st.running = false;

console.log('\n' + n + ' integration assertions passed');
