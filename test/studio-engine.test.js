/* Unit tests for the InControl Studio engine core (run: node test/studio-engine.test.js). */
'use strict';
global.window = global;
require('../js/sysex.js');
require('../js/sltemplate.js');
require('../js/studio-model.js');
const E = require('../js/studio-engine.js');
const S = global.SLMK.studio;
const assert = require('assert');
let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m + ' got ' + JSON.stringify(a)); console.log('ok  :', m); n++; };

const m = S.newModel();
const rt = E.makeRuntime(m); // channel 1

// Knobs are endless encoders: value 1 = +1, value 127 = -1 (two's complement).
const k = m.knobBanks[0][0];
Object.assign(k, { message_type: 'CC', cc: 74, start: 0, end: 127, bit_depth: '7-bit', channel: 'default', mode: 'Absolute', step: 1, pivot: 0 });
eq(E.knobDelta(1), 1, 'delta of value 1 = +1');
eq(E.knobDelta(127), -1, 'delta of value 127 = -1');
eq(E.knobDelta(10), 10, 'delta of value 10 = +10 (fast turn)');
eq(E.handle(rt, { group: 'knob', index: 0, value: 1 }).out, [[0xb0, 74, 1]], 'knob +1 -> CC 1 (accumulate)');
eq(E.handle(rt, { group: 'knob', index: 0, value: 1 }).out, [[0xb0, 74, 2]], 'knob +1 again -> CC 2');
eq(E.handle(rt, { group: 'knob', index: 0, value: 127 }).out, [[0xb0, 74, 1]], 'knob -1 -> CC 1');
eq(E.handle(rt, { group: 'knob', index: 0, value: 127 }).out, [[0xb0, 74, 0]], 'knob -1 -> CC 0');
eq(E.handle(rt, { group: 'knob', index: 0, value: 127 }).out, [[0xb0, 74, 0]], 'knob -1 clamps at 0');

// Relative mode passes the delta through as a relative CC.
const kr = m.knobBanks[0][1];
Object.assign(kr, { message_type: 'CC', cc: 80, channel: 'default', mode: 'Relative' });
eq(E.handle(rt, { group: 'knob', index: 1, value: 1 }).out, [[0xb0, 80, 1]], 'relative knob +1 -> CC 1');
eq(E.handle(rt, { group: 'knob', index: 1, value: 127 }).out, [[0xb0, 80, 127]], 'relative knob -1 -> CC 127');

const f = m.faders[0];
Object.assign(f, { message_type: 'Pitch Bend', channel: 'default', bit_depth: '14-bit', start: 0, end: 127 });
eq(E.handle(rt, { group: 'fader', index: 0, value: 127 }).out, [[0xe0, 127, 127]], 'fader pitch bend max (absolute)');
eq(E.handle(rt, { group: 'fader', index: 0, value: 0 }).out, [[0xe0, 0, 0]], 'fader pitch bend min');

rt.buttonBank = 1;
const b = m.buttonBanks[1][0];
Object.assign(b, { message_type: 'CC', cc: 20, behavior: 'Momentary', down_value: 127, up_value: 0, channel: 'default' });
eq(E.handle(rt, { group: 'button', index: 0, value: 127 }).out, [[0xb0, 20, 127]], 'button momentary press');
eq(E.handle(rt, { group: 'button', index: 0, value: 0 }).out, [[0xb0, 20, 0]], 'button momentary release');

b.behavior = 'Toggle';
eq(E.handle(rt, { group: 'button', index: 0, value: 127 }).out, [[0xb0, 20, 127]], 'toggle press1 -> on');
eq(E.handle(rt, { group: 'button', index: 0, value: 0 }).out, [], 'toggle release -> nothing');
eq(E.handle(rt, { group: 'button', index: 0, value: 127 }).out, [[0xb0, 20, 0]], 'toggle press2 -> off');

const p = m.pads.hits[0];
Object.assign(p, { message_type: 'Note', note: 36, channel: 'default', vel_min: 10, vel_max: 100, vel_curve: 'Scale' });
eq(E.handle(rt, { group: 'pad', index: 0, value: 127 }).out, [[0x90, 36, 100]], 'pad note scale max vel');
eq(E.handle(rt, { group: 'pad', index: 0, value: 0 }).out, [[0x80, 36, 0]], 'pad note release');

S.addKnobBank(m);
E.nav(rt, 'knobBank+'); eq(rt.knobBank, 1, 'knobBank+ -> 1');
E.nav(rt, 'knobBank+'); eq(rt.knobBank, 0, 'knobBank+ wraps');
E.nav(rt, 'channel+'); eq(rt.channel, 2, 'channel+ -> 2');

const leds = E.ledMessages(rt);
eq(leds.length, 16 + 16 + 8, 'led count pads+buttons+faders');
eq(leds[0].slice(0, 9), [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0a, 0x01, 0x03, 38], 'first LED targets pad 38');

console.log('\nALL ' + n + ' ENGINE TESTS PASSED');
