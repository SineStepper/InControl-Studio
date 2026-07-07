/* Unit tests for the bridge's pure logic (no hardware / MIDI I/O needed). */
'use strict';
const assert = require('assert');
const leds = require('./lib/leds');
const incontrol = require('./lib/incontrol');
const remap = require('./lib/remap');
const { parseArgs, loadConfig } = require('./bridge');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log('ok  :', msg); n++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg + ' — got ' + JSON.stringify(a)); console.log('ok  :', msg); n++; };

// --- leds ---
eq(leds.ledRgb(38, 127, 0, 0, 'solid'),
  [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0a, 0x01, 0x03, 38, 0x01, 127, 0, 0, 0xf7],
  'ledRgb Pad1 red matches protocol');
eq(leds.hexTo7bit('#ff0000'), { r: 127, g: 0, b: 0 }, 'hexTo7bit red');
eq(leds.buildLayout({ 'Pad 1': { hex: '#00ff00', behavior: 'pulse' } })[0],
  [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0a, 0x01, 0x03, 38, 0x03, 0, 127, 0, 0xf7],
  'buildLayout resolves name -> LED id and pulse behaviour');
eq(leds.buildLayout({ '46': { hex: '#0000ff' } })[0].slice(8, 13),
  [46, 0x01, 0, 0, 127], 'buildLayout accepts numeric LED ids (browser export)');

// --- incontrol resolve ---
eq(incontrol.resolve([0x9f, 0x60, 100]), { control: 'Pad 1', value: 100, kind: 'note' }, 'note-on Pad 1');
eq(incontrol.resolve([0x9f, 0x77, 0]), { control: 'Pad 16', value: 0, kind: 'note' }, 'Pad 16 release (vel 0)');
eq(incontrol.resolve([0xbf, 0x15, 64]), { control: 'Knob 1', value: 64, kind: 'cc' }, 'CC Knob 1');
eq(incontrol.resolve([0xbf, 0x29, 127]), { control: 'Fader 1', value: 127, kind: 'cc' }, 'CC Fader 1');
eq(incontrol.resolve([0xbf, 0x73, 127]), { control: 'Play', value: 127, kind: 'cc' }, 'CC Play button');
ok(incontrol.resolve([0xbf, 0x7f, 0]) === null, 'unknown CC -> null');

// --- remap ---
const M = { 'Pad 1': { type: 'note', number: 36, channel: 10 }, 'Knob 1': { type: 'cc', number: 20, channel: 1 } };
eq(remap.apply(incontrol.resolve([0x9f, 0x60, 100]), M), [0x99, 36, 100], 'Pad1 hit -> note 36 ch10');
eq(remap.apply(incontrol.resolve([0x9f, 0x60, 0]), M), [0x89, 36, 0], 'Pad1 release -> note-off');
eq(remap.apply(incontrol.resolve([0xbf, 0x15, 64]), M), [0xb0, 20, 64], 'Knob1 -> CC20 ch1');
ok(remap.apply(incontrol.resolve([0x9f, 0x61, 100]), M) === null, 'unmapped control -> null (no passthrough)');
eq(remap.apply({ control: 'X', value: 5, kind: 'cc' }, { X: { type: 'drop' } }), null, 'drop -> null');
// channel/number clamping
eq(remap.apply({ control: 'X', value: 200, kind: 'cc' }, { X: { type: 'cc', number: 999, channel: 99 } }),
  [0xbf, 127, 127], 'out-of-range clamps to channel16/127');

// --- config loading (colors-by-reference) ---
const tmp = path.join(require('os').tmpdir(), 'slmk-cfg-test');
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, 'colors.json'), JSON.stringify({ format: 'slmkiii-customizer', config: { '38': { hex: '#ff0000' } } }));
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ colors: 'colors.json', mappings: {} }));
const cfg = loadConfig(path.join(tmp, 'config.json'));
eq(cfg.colors, { '38': { hex: '#ff0000' } }, 'colors-by-reference resolves the browser export');
eq(parseArgs(['node', 'bridge.js', '--list']).list, true, 'parseArgs --list');

console.log('\nALL ' + n + ' TESTS PASSED');
