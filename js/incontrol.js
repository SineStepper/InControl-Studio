/*
 * incontrol.js (browser) — resolve incoming InControl MIDI messages to control
 * names, and apply user remappings. Mirrors bridge/lib/{incontrol,remap}.js.
 */
(function (global) {
  'use strict';

  const PAD_NOTES = {};
  for (let i = 0; i < 8; i++) PAD_NOTES[0x60 + i] = 'Pad ' + (i + 1);
  for (let i = 0; i < 8; i++) PAD_NOTES[0x70 + i] = 'Pad ' + (i + 9);

  const CC_CONTROLS = {};
  for (let i = 0; i < 8; i++) CC_CONTROLS[0x15 + i] = 'Knob ' + (i + 1);
  for (let i = 0; i < 8; i++) CC_CONTROLS[0x29 + i] = 'Fader ' + (i + 1);
  for (let i = 0; i < 24; i++) CC_CONTROLS[0x33 + i] = 'Soft ' + (i + 1);
  Object.assign(CC_CONTROLS, {
    0x51: 'Screen Up', 0x52: 'Screen Down', 0x53: 'Scene Top', 0x54: 'Scene Bottom',
    0x55: 'Pads Up', 0x56: 'Pads Down', 0x57: 'Right Soft Up', 0x58: 'Right Soft Down',
    0x59: 'Grid', 0x5a: 'Options', 0x5b: 'Shift', 0x5c: 'Duplicate', 0x5d: 'Clear',
    0x66: 'Track Left', 0x67: 'Track Right',
    0x70: 'Rewind', 0x71: 'Fast Fwd', 0x72: 'Stop', 0x73: 'Play', 0x74: 'Loop', 0x75: 'Record',
  });

  // Ordered, de-duplicated list of control names (for building the mapping UI).
  const CONTROL_NAMES = [];
  for (let i = 1; i <= 16; i++) CONTROL_NAMES.push('Pad ' + i);
  for (let i = 1; i <= 8; i++) CONTROL_NAMES.push('Knob ' + i);
  for (let i = 1; i <= 8; i++) CONTROL_NAMES.push('Fader ' + i);
  for (let i = 1; i <= 24; i++) CONTROL_NAMES.push('Soft ' + i);
  ['Play', 'Stop', 'Record', 'Rewind', 'Fast Fwd', 'Loop', 'Track Left', 'Track Right',
   'Grid', 'Options', 'Duplicate', 'Clear'].forEach((n) => CONTROL_NAMES.push(n));

  function resolve(message) {
    if (!message || message.length < 2) return null;
    const status = message[0] & 0xf0;
    const d1 = message[1];
    const d2 = message.length > 2 ? message[2] : 0;
    if (status === 0x90 || status === 0x80) {
      const name = PAD_NOTES[d1];
      if (!name) return null;
      return { control: name, value: status === 0x80 ? 0 : d2, kind: 'note' };
    }
    // Per-pad pressure (polyphonic aftertouch) — drives pad LED brightness (#12).
    if (status === 0xa0) {
      const name = PAD_NOTES[d1];
      if (!name) return null;
      return { control: name, value: d2, kind: 'pressure' };
    }
    if (status === 0xb0) {
      const name = CC_CONTROLS[d1];
      if (!name) return null;
      return { control: name, value: d2, kind: 'cc' };
    }
    return null;
  }

  const clamp = (n, hi) => Math.max(0, Math.min(hi, n | 0));

  function applyRemap(ev, mappings) {
    if (!ev) return null;
    const map = mappings && mappings[ev.control];
    if (!map || map.type === 'drop') return null;
    const type = map.type || (ev.kind === 'note' ? 'note' : 'cc');
    const ch = clamp((map.channel || 1) - 1, 15);
    const num = clamp(map.number, 127);
    const val = clamp(ev.value, 127);
    if (type === 'note') return val > 0 ? [0x90 | ch, num, val] : [0x80 | ch, num, 0];
    return [0xb0 | ch, num, val];
  }

  global.SLMK = global.SLMK || {};
  global.SLMK.incontrol = { PAD_NOTES, CC_CONTROLS, CONTROL_NAMES, resolve, applyRemap };
})(window);
