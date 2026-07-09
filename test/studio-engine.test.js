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

const k = m.knobBanks[0][0];
Object.assign(k, { message_type: 'CC', cc: 74, start: 0, end: 127, bit_depth: '7-bit', channel: 'default' });
eq(E.handle(rt, { group: 'knob', index: 0, value: 127 }).out, [[0xb0, 74, 127]], 'knob CC full');
eq(E.handle(rt, { group: 'knob', index: 0, value: 0 }).out, [[0xb0, 74, 0]], 'knob CC zero');

k.bit_depth = '14-bit';
eq(E.handle(rt, { group: 'knob', index: 0, value: 127 }).out, [[0xb0, 74, 127], [0xb0, 106, 127]], 'knob CC 14-bit -> MSB+LSB');

k.channel = 10; k.bit_depth = '7-bit';
eq(E.handle(rt, { group: 'knob', index: 0, value: 127 }).out, [[0xb9, 74, 127]], 'knob CC on ch10');

const f = m.faders[0];
Object.assign(f, { message_type: 'Pitch Bend', channel: 'default', bit_depth: '14-bit', start: 0, end: 127 });
eq(E.handle(rt, { group: 'fader', index: 0, value: 127 }).out, [[0xe0, 127, 127]], 'fader pitch bend max');
eq(E.handle(rt, { group: 'fader', index: 0, value: 0 }).out, [[0xe0, 0, 0]], 'fader pitch bend min');

Object.assign(k, { message_type: 'NRPN', cc: 1000, bit_depth: '14-bit', channel: 'default', start: 0, end: 127 });
eq(E.handle(rt, { group: 'knob', index: 0, value: 127 }).out, [[0xb0, 99, 7], [0xb0, 98, 1000 & 127], [0xb0, 6, 127], [0xb0, 38, 127]], 'knob NRPN param 1000 val 16383');

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
