/*
 * sysex.js — Novation SL MkIII InControl SysEx / MIDI message builders.
 *
 * All values documented in the SL MkIII Programmer's Reference Guide.
 * LEDs are addressed on the *InControl* USB port while the unit is in
 * InControl view. Two addressing schemes exist:
 *
 *   1. RGB via SysEx (what this app uses — fully custom 21-bit color):
 *        F0 00 20 29 02 0A 01 03 <ledId> <behavior> <R> <G> <B> F7
 *      R/G/B are each 0-127 (7-bit).
 *
 *   2. Palette via Note/CC on a behavior-specific channel (128 fixed colors):
 *        solid   -> channel 16   flash -> channel 2   pulse -> channel 3
 *      (kept here for reference / .syx export completeness).
 */
(function (global) {
  'use strict';

  // SysEx header: Start-of-Exclusive + Novation manufacturer id (00 20 29)
  // + SL MkIII device / model bytes (02 0A 01).
  const HEADER = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0a, 0x01];
  const EOX = 0xf7;

  // Command IDs (byte immediately after the header).
  const CMD_SET_LED = 0x03;

  // LED behavior byte for the RGB SysEx command.
  const BEHAVIOR = { solid: 0x01, flash: 0x02, pulse: 0x03 };

  const clamp7 = (n) => Math.max(0, Math.min(127, n | 0));

  /**
   * Build the RGB "Set LED" SysEx message.
   * @param {number} ledId    LED SysEx id (see controls.js)
   * @param {number} r 0-127
   * @param {number} g 0-127
   * @param {number} b 0-127
   * @param {'solid'|'flash'|'pulse'} behavior
   * @returns {number[]} raw MIDI bytes
   */
  function ledRgb(ledId, r, g, b, behavior) {
    const beh = BEHAVIOR[behavior] || BEHAVIOR.solid;
    return HEADER.concat([
      CMD_SET_LED,
      clamp7(ledId),
      beh,
      clamp7(r),
      clamp7(g),
      clamp7(b),
      EOX,
    ]);
  }

  // ---- Color helpers: the UI works in 8-bit #RRGGBB, hardware in 7-bit. ----

  const to7 = (v255) => clamp7(Math.round((v255 * 127) / 255)); // 0-255 -> 0-127
  const to8 = (v127) => Math.round((clamp7(v127) * 255) / 127); // 0-127 -> 0-255

  function hexToRgb255(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
    if (!m) return { r: 0, g: 0, b: 0 };
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
  }

  function rgb255ToHex(r, g, b) {
    const h = (v) => v.toString(16).padStart(2, '0');
    return '#' + h(r & 0xff) + h(g & 0xff) + h(b & 0xff);
  }

  /** Convert a UI color (#RRGGBB) into the 7-bit triple the device expects. */
  function hexTo7bit(hex) {
    const { r, g, b } = hexToRgb255(hex);
    return { r: to7(r), g: to7(g), b: to7(b) };
  }

  /** Build the SysEx for one control from a config entry {hex, behavior}. */
  function ledFromConfig(ledId, entry) {
    const c = entry || {};
    const { r, g, b } = hexTo7bit(c.hex || '#000000');
    return ledRgb(ledId, r, g, b, c.behavior || 'solid');
  }

  /**
   * Concatenate SysEx for every control in a config object
   * ({ ledId: {hex, behavior}, ... }) into one flat byte stream.
   */
  function buildAll(config) {
    const out = [];
    Object.keys(config).forEach((id) => {
      out.push(...ledFromConfig(Number(id), config[id]));
    });
    return out;
  }

  function bytesToHexString(bytes) {
    return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  }

  /** Wrap a byte array in a downloadable Standard MIDI SysEx (.syx) Blob. */
  function syxBlob(bytes) {
    return new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
  }

  // ---- Screen control (InControl API, Programmer's Reference Guide) ----
  // Set the screen layout: 0 empty, 1 knob, 2 box.
  function screenLayout(index) { return HEADER.concat([0x01, index & 0x7f, EOX]); }
  // Set a value property (type 3) on a column's object.
  function screenValue(col, obj, value) { return HEADER.concat([0x02, col & 0x7f, 0x03, obj & 0x7f, clamp7(value), EOX]); }
  // Set a text property (type 1) on a column's object (7-bit ASCII + NUL).
  function screenText(col, obj, text) {
    const t = []; for (const ch of String(text).slice(0, 9)) t.push(ch.charCodeAt(0) & 0x7f); t.push(0x00);
    return HEADER.concat([0x02, col & 0x7f, 0x01, obj & 0x7f], t, [EOX]);
  }
  // Set an RGB color property (type 4) on a column's object.
  function screenRgb(col, obj, r, g, b) { return HEADER.concat([0x02, col & 0x7f, 0x04, obj & 0x7f, clamp7(r), clamp7(g), clamp7(b), EOX]); }
  // Center-screen notification (command 0x04): two lines of 7-bit ASCII shown
  // across the top of the center screen (up to 18 chars each per the Programmer's
  // Reference). Each line is NUL-terminated.
  function screenNotify(line1, line2) {
    const enc = (s) => { const t = []; for (const ch of String(s || '').slice(0, 18)) t.push(ch.charCodeAt(0) & 0x7f); t.push(0x00); return t; };
    return HEADER.concat([0x04], enc(line1), enc(line2 || ''), [EOX]);
  }

  global.SLMK = global.SLMK || {};
  global.SLMK.sysex = {
    HEADER,
    BEHAVIOR,
    ledRgb,
    ledFromConfig,
    buildAll,
    to7,
    to8,
    hexToRgb255,
    rgb255ToHex,
    hexTo7bit,
    bytesToHexString,
    syxBlob,
    screenLayout,
    screenValue,
    screenText,
    screenRgb,
    screenNotify,
  };
})(window);
