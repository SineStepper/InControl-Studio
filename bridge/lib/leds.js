/*
 * leds.js — SL MkIII InControl LED map + RGB SysEx builder (Node).
 * Mirrors the browser tool's protocol (see ../../docs/PROTOCOL.md).
 */
'use strict';

const HEADER = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0a, 0x01];
const EOX = 0xf7;
const BEHAVIOR = { solid: 0x01, flash: 0x02, pulse: 0x03 };

// LED SysEx ids by friendly name (subset most people color; extend as needed).
const LED_IDS = {};
for (let i = 0; i < 16; i++) LED_IDS['Pad ' + (i + 1)] = 38 + i;
for (let i = 0; i < 24; i++) LED_IDS['Soft ' + (i + 1)] = 4 + i;
for (let i = 0; i < 8; i++) LED_IDS['Fader ' + (i + 1)] = 54 + i;
Object.assign(LED_IDS, {
  Rewind: 33, 'Fast Fwd': 34, Stop: 35, Play: 36, Loop: 37, Record: 32,
  'Scene Top': 2, 'Scene Bottom': 3, 'Pads Up': 0, 'Pads Down': 1,
  'Right Soft Up': 28, 'Right Soft Down': 29, 'Track Left': 30, 'Track Right': 31,
  'Screen Up': 62, 'Screen Down': 63, Grid: 64, Options: 65, Duplicate: 66, Clear: 67,
});

const clamp7 = (n) => Math.max(0, Math.min(127, n | 0));
const to7 = (v255) => clamp7(Math.round((v255 * 127) / 255));

function hexTo7bit(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return { r: to7((n >> 16) & 0xff), g: to7((n >> 8) & 0xff), b: to7(n & 0xff) };
}

function ledRgb(ledId, r, g, b, behavior) {
  return HEADER.concat([
    0x03, clamp7(ledId), BEHAVIOR[behavior] || BEHAVIOR.solid, clamp7(r), clamp7(g), clamp7(b), EOX,
  ]);
}

/**
 * Build SysEx messages for a color layout.
 * @param {object} colors  Either { "Pad 1": {hex,behavior}, ... } (names) or
 *                         { "38": {hex,behavior}, ... } (numeric LED ids), i.e.
 *                         the browser tool's exported `config`.
 * @returns {number[][]} array of raw MIDI byte arrays
 */
function buildLayout(colors) {
  const msgs = [];
  Object.keys(colors || {}).forEach((key) => {
    const id = Object.prototype.hasOwnProperty.call(LED_IDS, key) ? LED_IDS[key] : Number(key);
    if (!Number.isFinite(id)) return;
    const entry = colors[key] || {};
    const { r, g, b } = hexTo7bit(entry.hex || '#000000');
    msgs.push(ledRgb(id, r, g, b, entry.behavior || 'solid'));
  });
  return msgs;
}

module.exports = { LED_IDS, ledRgb, hexTo7bit, buildLayout, BEHAVIOR };
