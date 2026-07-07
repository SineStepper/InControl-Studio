/*
 * incontrol.js — resolve incoming InControl-port MIDI messages to friendly
 * control names, so the bridge can remap them. Values from the SL MkIII
 * Programmer's Reference Guide (controls send on channel 16).
 */
'use strict';

// Pads send Note messages; their note numbers:
const PAD_NOTES = {};
for (let i = 0; i < 8; i++) PAD_NOTES[0x60 + i] = 'Pad ' + (i + 1); // Pads 1-8
for (let i = 0; i < 8; i++) PAD_NOTES[0x70 + i] = 'Pad ' + (i + 9); // Pads 9-16

// Everything else sends CC:
const CC_CONTROLS = {};
for (let i = 0; i < 8; i++) CC_CONTROLS[0x15 + i] = 'Knob ' + (i + 1); // 21-28
for (let i = 0; i < 8; i++) CC_CONTROLS[0x29 + i] = 'Fader ' + (i + 1); // 41-48
for (let i = 0; i < 24; i++) CC_CONTROLS[0x33 + i] = 'Soft ' + (i + 1); // 51-74
Object.assign(CC_CONTROLS, {
  0x51: 'Screen Up', 0x52: 'Screen Down', 0x53: 'Scene Top', 0x54: 'Scene Bottom',
  0x55: 'Pads Up', 0x56: 'Pads Down', 0x57: 'Right Soft Up', 0x58: 'Right Soft Down',
  0x59: 'Grid', 0x5a: 'Options', 0x5b: 'Shift', 0x5c: 'Duplicate', 0x5d: 'Clear',
  0x66: 'Track Left', 0x67: 'Track Right',
  0x70: 'Rewind', 0x71: 'Fast Fwd', 0x72: 'Stop', 0x73: 'Play', 0x74: 'Loop', 0x75: 'Record',
});

/**
 * Parse a raw MIDI message into { control, value, kind } or null if unknown.
 * kind is 'note' or 'cc'; value is velocity (note) or CC value (0-127).
 */
function resolve(message) {
  if (!message || message.length < 2) return null;
  const status = message[0] & 0xf0;
  const d1 = message[1];
  const d2 = message.length > 2 ? message[2] : 0;
  if (status === 0x90 || status === 0x80) {
    const name = PAD_NOTES[d1];
    if (!name) return null;
    // Note-on with velocity 0 is a release.
    return { control: name, value: status === 0x80 ? 0 : d2, kind: 'note' };
  }
  if (status === 0xb0) {
    const name = CC_CONTROLS[d1];
    if (!name) return null;
    return { control: name, value: d2, kind: 'cc' };
  }
  return null;
}

module.exports = { PAD_NOTES, CC_CONTROLS, resolve };
