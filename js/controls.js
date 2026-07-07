/*
 * controls.js — The addressable LEDs of the Novation SL MkIII.
 *
 * Each entry: { id, name, group }
 *   id    = "LED SysEx ID" (decimal) from the Programmer's Reference Guide,
 *           used as the LED index in the RGB SysEx command.
 *   group = used only for visual layout in the editor.
 *
 * NOTE ON THE KEYBED "LIGHT GUIDE": the guide lists Key LEDs with SysEx IDs
 * 54-114, which overlaps the fader / function IDs above. The keybed is driven
 * through a separate mechanism (see docs/PROTOCOL.md) and is intentionally
 * omitted here so the editor can never send an ambiguous id to hardware.
 */
(function (global) {
  'use strict';

  const CONTROLS = [];
  const add = (id, name, group) => CONTROLS.push({ id, name, group });

  // --- 2 x 8 velocity pads (LED SysEx 38-53) ---
  for (let i = 0; i < 16; i++) add(38 + i, 'Pad ' + (i + 1), 'pads');

  // --- 24 soft buttons around the screens (LED SysEx 4-27) ---
  for (let i = 0; i < 24; i++) add(4 + i, 'Soft ' + (i + 1), 'soft');

  // --- 8 fader LEDs, one above each fader (LED SysEx 54-61) ---
  for (let i = 0; i < 8; i++) add(54 + i, 'Fader ' + (i + 1), 'faders');

  // --- Transport row ---
  add(33, 'Rewind', 'transport');
  add(34, 'Fast Fwd', 'transport');
  add(35, 'Stop', 'transport');
  add(36, 'Play', 'transport');
  add(37, 'Loop', 'transport');
  add(32, 'Record', 'transport');

  // --- Function / navigation buttons ---
  add(2, 'Scene Top', 'function');
  add(3, 'Scene Bottom', 'function');
  add(0, 'Pads Up', 'function');
  add(1, 'Pads Down', 'function');
  add(28, 'Right Soft Up', 'function');
  add(29, 'Right Soft Down', 'function');
  add(30, 'Track Left', 'function');
  add(31, 'Track Right', 'function');
  add(62, 'Screen Up', 'function');
  add(63, 'Screen Down', 'function');
  add(64, 'Grid', 'function');
  add(65, 'Options', 'function');
  add(66, 'Duplicate', 'function');
  add(67, 'Clear', 'function');

  // Ordered groups for the UI, with human labels and layout hints.
  const GROUPS = [
    { key: 'pads', label: 'Pads', cols: 8 },
    { key: 'soft', label: 'Soft Buttons', cols: 8 },
    { key: 'faders', label: 'Fader LEDs', cols: 8 },
    { key: 'transport', label: 'Transport', cols: 6 },
    { key: 'function', label: 'Function & Navigation', cols: 6 },
  ];

  // Quick-pick swatches (standard 8-bit hex; converted to 7-bit on send).
  const PRESETS = [
    { name: 'Red', hex: '#ff0000' },
    { name: 'Orange', hex: '#ff6a00' },
    { name: 'Amber', hex: '#ffae00' },
    { name: 'Yellow', hex: '#ffff00' },
    { name: 'Lime', hex: '#7bff00' },
    { name: 'Green', hex: '#00ff00' },
    { name: 'Spring', hex: '#00ff88' },
    { name: 'Cyan', hex: '#00ffff' },
    { name: 'Sky', hex: '#0088ff' },
    { name: 'Blue', hex: '#0000ff' },
    { name: 'Violet', hex: '#7a00ff' },
    { name: 'Magenta', hex: '#ff00ff' },
    { name: 'Pink', hex: '#ff0088' },
    { name: 'White', hex: '#ffffff' },
    { name: 'Warm White', hex: '#ffd8a8' },
    { name: 'Off', hex: '#000000' },
  ];

  const byId = {};
  CONTROLS.forEach((c) => (byId[c.id] = c));

  global.SLMK = global.SLMK || {};
  global.SLMK.controls = { CONTROLS, GROUPS, PRESETS, byId };
})(window);
