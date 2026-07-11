/*
 * studio-engine.js — InControl Studio live engine (P3), pure core.
 *
 * Translates resolved InControl input (which control moved, and by how much)
 * into outgoing MIDI per the current model / bank / channel, drives per-state
 * LED colours, and runs the navigation state machine (bank paging, channel).
 * No MIDI I/O or DOM here — the runtime (studio-runtime.js) wires this to ports,
 * so every rule below is unit-testable.
 */
(function (global) {
  'use strict';
  const sysex = global.SLMK && global.SLMK.sysex;

  // ---- runtime state ----
  function makeRuntime(model) {
    return {
      model,
      knobBank: 0,
      buttonBank: 0, // start on the fixed Mute/Solo bank; paging cycles to banks 1+ (#31)
      channel: (model.global && model.global.channel) || 1,
      template: (model.global && model.global.template) || 1,
      padMode: 'sequencer', // 'sequencer' (pads drive the step/pattern grid) | 'pads' (instrument, via Grid)
      toggle: {}, // key -> bool, for Toggle behaviour
      inc: {}, // key -> current value, for Inc/Dec
      held: {}, // key -> bool, for LED pressed state
      acc: {}, // key -> accumulated value, for endless-encoder knobs
      bank: {}, // key -> bank number, for combined continuous bank-change knobs
    };
  }

  // SL MkIII rotary encoders are endless: they send two's-complement deltas
  // (1..63 = +1..+63, 64..127 = -1..-64). Decode to a signed delta.
  function knobDelta(raw) { if (!raw) return 0; return raw < 64 ? raw : raw - 128; }

  // ---- value scaling ----
  function scale(raw, start, end, bit) {
    const t = Math.max(0, Math.min(127, raw)) / 127;
    const base = start + (end - start) * t; // in the 0-127 domain the user set
    if (bit === '14-bit') return Math.round((base / 127) * 16383) & 0x3fff;
    if (bit === '8-bit scaled') return Math.round((base / 127) * 255) & 0xff;
    return Math.round(base) & 0x7f;
  }

  // ---- message builders (ch is 0-15) ----
  const CC = (ch, cc, v) => [0xb0 | ch, cc & 0x7f, v & 0x7f];
  const NOTE_ON = (ch, n, vel) => [0x90 | ch, n & 0x7f, vel & 0x7f];
  const NOTE_OFF = (ch, n) => [0x80 | ch, n & 0x7f, 0];
  const PC = (ch, v) => [0xc0 | ch, v & 0x7f];
  const CHAN_PRESSURE = (ch, v) => [0xd0 | ch, v & 0x7f];
  const POLY_AT = (ch, n, v) => [0xa0 | ch, n & 0x7f, v & 0x7f];
  const PITCH = (ch, v14) => [0xe0 | ch, v14 & 0x7f, (v14 >> 7) & 0x7f];
  const SONG_POS = (v14) => [0xf2, v14 & 0x7f, (v14 >> 7) & 0x7f];
  const NRPN = (ch, param, v14) => [CC(ch, 99, (param >> 7) & 0x7f), CC(ch, 98, param & 0x7f), CC(ch, 6, (v14 >> 7) & 0x7f), CC(ch, 38, v14 & 0x7f)];

  const chanOf = (a, rt) => ((a.channel === 'default' ? rt.channel : a.channel) - 1) & 0x0f;

  // Stable per-control state key (includes the bank for banked controls).
  function keyFor(rt, group, index) {
    const bank = group === 'button' ? rt.buttonBank : group === 'knob' ? rt.knobBank : 0;
    return group + ':' + bank + ':' + index;
  }

  /**
   * Produce outgoing MIDI messages for a continuous control move (0-127 raw).
   * Returns an array of byte arrays.
   */
  // Emit MIDI for an already-resolved output value `v` (0-127 for 7/8-bit,
  // 0-16383 for 14-bit).
  function emitValue(a, v, rt) {
    const ch = chanOf(a, rt);
    const b14 = a.bit_depth === '14-bit';
    switch (a.message_type) {
      case 'CC': return b14 ? [CC(ch, a.cc, (v >> 7) & 0x7f), CC(ch, (a.cc + 32) & 0x7f, v & 0x7f)] : [CC(ch, a.cc, a.bit_depth === '8-bit scaled' ? v >> 1 : v & 0x7f)];
      case 'NRPN': return NRPN(ch, a.cc, b14 ? v : v << 7);
      case 'Note': return [NOTE_ON(ch, a.note, v & 0x7f)];
      case 'Program Change': return [PC(ch, v & 0x7f)];
      case 'Bank Change': return [CC(ch, 0, v & 0x7f)];
      case 'Sub Bank Change': return [CC(ch, 32, v & 0x7f)];
      case 'Song Position': return [SONG_POS(b14 ? v : v << 7)];
      case 'Pitch Bend': return [PITCH(ch, b14 ? v : v << 7)];
      case 'Channel Pressure': return [CHAN_PRESSURE(ch, v & 0x7f)];
      case 'Poly Aftertouch': return [POLY_AT(ch, a.note, v & 0x7f)];
      default: return [];
    }
  }

  // Absolute continuous control (fader/wheel/pedal): scale 0-127 -> range.
  function continuousOut(a, raw, rt) { return emitValue(a, scale(raw, a.start, a.end, a.bit_depth), rt); }

  // Endless-encoder knob: accumulate the signed delta into the output range.
  function knobOut(a, rawDelta, rt, key) {
    const d = knobDelta(rawDelta);
    if (d === 0) return [];
    // Combined continuous bank-change: one knob sweeps Program Changes 0-127, then
    // rolls the (sub-)bank up/down and continues — the SL can't do this.
    if (a.combined && a.combined !== 'None' && a.message_type === 'Program Change') {
      const ch = chanOf(a, rt);
      const stepU = a.step || 1;
      let pc = rt.acc[key]; if (pc == null) pc = a.pivot || 0;
      let bank = rt.bank[key] || 0;
      pc += d * stepU;
      let bankChanged = false;
      while (pc > 127) { pc -= 128; if (bank < 127) { bank++; bankChanged = true; } else { pc = 127; } }
      while (pc < 0) { pc += 128; if (bank > 0) { bank--; bankChanged = true; } else { pc = 0; } }
      rt.acc[key] = pc; rt.bank[key] = bank;
      const out = [];
      if (bankChanged) out.push(CC(ch, a.combined === 'Sub-bank when full' ? 32 : 0, bank));
      out.push(PC(ch, pc));
      return out;
    }
    if (a.mode === 'Relative') {
      // Pass the delta through as a relative (two's-complement) CC.
      const rel = d > 0 ? d & 0x3f : (128 + d) & 0x7f;
      return [CC(chanOf(a, rt), a.cc, rel)];
    }
    const FS = a.bit_depth === '14-bit' ? 16383 : 127;
    const lo = Math.round((Math.min(a.start, a.end) / 127) * FS);
    const hi = Math.round((Math.max(a.start, a.end) / 127) * FS);
    const stepU = (a.step || 1) * (a.bit_depth === '14-bit' ? 128 : 1);
    let acc = rt.acc[key];
    if (acc == null) { acc = a.pivot ? Math.round((a.pivot / 127) * FS) : lo; acc = Math.max(lo, Math.min(hi, acc)); }
    acc = Math.max(lo, Math.min(hi, acc + d * stepU));
    rt.acc[key] = acc;
    return emitValue(a, acc, rt);
  }

  /** Fixed-value message for a switch press/release (value already chosen). */
  function switchOut(a, value, rt, opts) {
    const ch = chanOf(a, rt);
    const mt = a.message_type;
    switch (mt) {
      case 'Note': return value > 0 ? [NOTE_ON(ch, a.note, opts && opts.velocity != null ? opts.velocity : value)] : [NOTE_OFF(ch, a.note)];
      case 'CC': return [CC(ch, a.cc, value)];
      case 'NRPN': return NRPN(ch, a.cc, value << 7);
      case 'Program Change': return [PC(ch, value)];
      case 'Bank Change': return [CC(ch, 0, value)];
      case 'Sub Bank Change': return [CC(ch, 32, value)];
      case 'Song Position': return [SONG_POS(value << 7)];
      default: return [];
    }
  }

  // velocity mapped through vel_min/vel_max/curve for pad hits
  function padVelocity(a, raw) {
    if (a.vel_curve === 'Clip') return Math.max(a.vel_min, Math.min(a.vel_max, raw));
    if (a.vel_curve === 'Scale') return Math.round(a.vel_min + ((a.vel_max - a.vel_min) * raw) / 127) & 0x7f;
    return raw & 0x7f; // None
  }

  /**
   * Handle a resolved input event.
   * @param rt runtime
   * @param ev { group:'knob'|'fader'|'button'|'pad', index:0-based, kind:'cc'|'note', value:0-127 }
   * @returns { out: byteArrays[], nav?: string, ledDirty?: bool }
   */
  function handle(rt, ev) {
    const a = assignmentFor(rt, ev.group, ev.index);
    if (!a || !a.enabled) return { out: [] };
    const key = keyFor(rt, ev.group, ev.index);

    if (ev.group === 'knob') return { out: knobOut(a, ev.value, rt, key) };
    if (ev.group === 'fader') return { out: continuousOut(a, ev.value, rt) };
    // switch-like: button or pad
    const pressed = ev.value > 0;
    rt.held[key] = pressed;
    const beh = a.behavior || 'Momentary';
    if (ev.group === 'pad' && a.message_type === 'Note') {
      // velocity-sensitive note
      if (pressed) return { out: [NOTE_ON(chanOf(a, rt), a.note, padVelocity(a, ev.value))], ledDirty: true };
      return { out: [NOTE_OFF(chanOf(a, rt), a.note)], ledDirty: true };
    }
    if (beh === 'Momentary') return { out: switchOut(a, pressed ? a.down_value : a.up_value, rt), ledDirty: true };
    if (beh === 'Trigger') return { out: pressed ? switchOut(a, a.down_value, rt) : [], ledDirty: true };
    if (beh === 'Toggle') {
      if (!pressed) return { out: [], ledDirty: true };
      rt.toggle[key] = !rt.toggle[key];
      return { out: switchOut(a, rt.toggle[key] ? a.down_value : a.up_value, rt), ledDirty: true };
    }
    if (beh === 'Inc/Dec') {
      if (!pressed) return { out: [] };
      const cur = (rt.inc[key] || 0) + 1;
      rt.inc[key] = cur > 127 ? 0 : cur;
      return { out: switchOut(a, rt.inc[key], rt), ledDirty: true };
    }
    return { out: [] };
  }

  function assignmentFor(rt, group, index) {
    const m = rt.model;
    if (group === 'knob') return (m.knobBanks[rt.knobBank] || [])[index];
    if (group === 'fader') return m.faders[index];
    if (group === 'button') return (m.buttonBanks[rt.buttonBank] || [])[index];
    if (group === 'pad') return m.pads.hits[index];
    return null;
  }

  // Current display value (0-127) for a knob, for the SL screens.
  function knobDisplay(rt, index) {
    const a = (rt.model.knobBanks[rt.knobBank] || [])[index]; if (!a) return null;
    const acc = rt.acc[keyFor(rt, 'knob', index)];
    if (acc == null) return a.pivot || 0;
    const FS = a.bit_depth === '14-bit' ? 16383 : 127;
    return Math.round((acc / (FS || 127)) * 127) & 0x7f;
  }

  // ---- navigation ----
  function nav(rt, action) {
    const m = rt.model;
    switch (action) {
      // Bank paging clamps at the ends (no wrap) so it matches the arrow LEDs,
      // which go dark when there are no more pages in that direction.
      case 'knobBank+': rt.knobBank = Math.min(m.knobBanks.length - 1, rt.knobBank + 1); return { ledDirty: true };
      case 'knobBank-': rt.knobBank = Math.max(0, rt.knobBank - 1); return { ledDirty: true };
      case 'buttonBank+': rt.buttonBank = Math.min(m.buttonBanks.length - 1, rt.buttonBank + 1); return { ledDirty: true };
      case 'buttonBank-': rt.buttonBank = Math.max(0, rt.buttonBank - 1); return { ledDirty: true };
      case 'channel+': rt.channel = (rt.channel % 16) + 1; return { ledDirty: true };
      case 'channel-': rt.channel = ((rt.channel - 2 + 16) % 16) + 1; return { ledDirty: true };
      case 'grid': rt.padMode = rt.padMode === 'pads' ? 'sequencer' : 'pads'; return { ledDirty: true };
      default: return {};
    }
  }

  // Map InControl navigation control names -> nav actions.
  const NAV_MAP = {
    'Track Left': 'channel-', 'Track Right': 'channel+',
    'Screen Up': 'knobBank-', 'Screen Down': 'knobBank+',
    'Right Soft Up': 'buttonBank-', 'Right Soft Down': 'buttonBank+',
    'Grid': 'grid',
  };

  // ---- LED output for the current bank/state ----
  function ledFor(a, key, rt) {
    const l = a.led || {};
    if (rt.held[key]) return l.pressed || '#ffffff';
    return l.idle || '#000000';
  }
  /** All LED SysEx messages for the current view (pads + current button bank + faders). */
  function ledMessages(rt) {
    if (!sysex) return [];
    const out = [];
    const m = rt.model;
    const push = (ledId, a, key) => { const { r, g, b } = sysex.hexTo7bit(ledFor(a, key, rt)); out.push(sysex.ledRgb(ledId, r, g, b, 'solid')); };
    m.pads.hits.forEach((a, i) => push(38 + i, a, keyFor(rt, 'pad', i)));
    (m.buttonBanks[rt.buttonBank] || []).forEach((a, i) => { if (i < 16) push(4 + i, a, keyFor(rt, 'button', i)); });
    m.faders.forEach((a, i) => push(54 + i, a, keyFor(rt, 'fader', i)));
    return out;
  }

  /** Single LED SysEx for one control (or null if it has no RGB LED). */
  function ledOne(rt, group, index) {
    if (!sysex) return null;
    const m = rt.model; let id = null, a = null;
    if (group === 'pad') { id = 38 + index; a = m.pads.hits[index]; }
    else if (group === 'button' && index < 16) { id = 4 + index; a = (m.buttonBanks[rt.buttonBank] || [])[index]; }
    else if (group === 'fader') { id = 54 + index; a = m.faders[index]; }
    if (id == null || !a) return null;
    const { r, g, b } = sysex.hexTo7bit(ledFor(a, keyFor(rt, group, index), rt));
    return sysex.ledRgb(id, r, g, b, 'solid');
  }

  global.SLMK = global.SLMK || {};
  global.SLMK.engine = {
    makeRuntime, scale, continuousOut, emitValue, knobOut, knobDelta, knobDisplay, switchOut, padVelocity, handle, assignmentFor, nav, NAV_MAP, ledMessages, ledOne, keyFor,
    _msg: { CC, NOTE_ON, NOTE_OFF, PC, CHAN_PRESSURE, POLY_AT, PITCH, SONG_POS, NRPN },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SLMK.engine;
})(typeof window !== 'undefined' ? window : globalThis);
