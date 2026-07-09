/*
 * studio-model.js — data model for the InControl Studio: a Components-style
 * customizer for the SL MkIII in InControl mode, with more than Components
 * allows (unlimited knob/button banks, per-state LED colours, richer message
 * types). This module is the pure data layer — no MIDI, no DOM — so it's fully
 * unit-testable. The live engine (P3) and the editor UI (P2) both build on it.
 */
(function (global) {
  'use strict';

  // Message-type catalogues per control class (superset of Components).
  const MSG = {
    knob: ['CC', 'NRPN', 'Note', 'Program Change', 'Bank Change', 'Sub Bank Change', 'Song Position'],
    fader: ['CC', 'NRPN', 'Note', 'Program Change', 'Bank Change', 'Sub Bank Change', 'Song Position'],
    button: ['CC', 'NRPN', 'Note', 'Program Change', 'Bank Change', 'Sub Bank Change', 'Song Position'],
    pad_hit: ['Note', 'CC', 'NRPN', 'Program Change', 'Bank Change', 'Sub Bank Change', 'Song Position'],
    pad_pressure: ['Poly Aftertouch', 'Channel Pressure', 'Program Change', 'Sub Bank Change', 'Bank Change', 'CC', 'NRPN'],
    pitch: ['Pitch Bend', 'CC', 'NRPN', 'Note', 'Program Change', 'Bank Change', 'Sub Bank Change', 'Song Position'],
    mod: ['CC', 'NRPN', 'Note', 'Program Change', 'Bank Change', 'Sub Bank Change', 'Song Position'],
    sustain: ['Sequencer Start/Stop', 'CC', 'NRPN', 'Program Change', 'Bank Change', 'Sub Bank Change', 'Song Position', 'Poly Aftertouch', 'Channel Pressure'],
    footswitch: ['Sequencer Start/Stop', 'CC', 'NRPN', 'Note', 'Program Change', 'Bank Change', 'Sub Bank Change', 'Song Position'],
    expression: ['CC', 'NRPN', 'Program Change', 'Bank Change', 'Sub Bank Change', 'Song Position', 'Poly Aftertouch', 'Channel Pressure'],
    keys: ['Channel Pressure', 'CC', 'NRPN', 'Note', 'Program Change', 'Bank Change', 'Sub Bank Change', 'Song Position'],
  };

  const BIT_DEPTHS = ['7-bit', '8-bit scaled', '14-bit'];
  const BEHAVIORS = ['Momentary', 'Toggle', 'Inc/Dec', 'Trigger'];
  const VEL_CURVES = ['None', 'Clip', 'Scale'];
  const KNOB_MODES = ['Absolute', 'Relative'];
  const COMBINED = ['None', 'Bank when full', 'Sub-bank when full']; // knob continuous bank paging

  const led = (idle, pressed, pressure) => ({ idle: idle || '#000000', pressed: pressed || '#ffffff', pressure: pressure || '#000000' });

  // ---- per-class default assignment ----
  function make(cls, over) {
    const base = {
      cls,
      enabled: true,
      name: '',
      message_type: MSG[cls][0],
      channel: 'default', // 'default' or 1-16
      cc: 0,
      note: 0,
      start: 0,
      end: 127,
      bit_depth: '7-bit',
      led: led('#101010', '#ffffff', '#ff3b3b'),
    };
    if (cls === 'knob') Object.assign(base, { mode: 'Absolute', resolution: 616, step: 1, pivot: 0, combined: 'None' });
    if (cls === 'button' || cls === 'footswitch') Object.assign(base, { behavior: 'Momentary', down_value: 127, up_value: 0 });
    if (cls === 'pad_hit') Object.assign(base, { message_type: 'Note', behavior: 'Momentary', down_value: 127, up_value: 0, vel_min: 1, vel_max: 127, vel_curve: 'None' });
    if (cls === 'pad_pressure') Object.assign(base, { message_type: 'Poly Aftertouch' });
    return Object.assign(base, over || {});
  }

  function newBank(cls, count, namer) {
    const arr = [];
    for (let i = 0; i < count; i++) arr.push(make(cls, { name: namer ? namer(i) : '' }));
    return arr;
  }

  // Fixed first button bank: Mute + Send for the first 8 MIDI channels (2 rows of 8).
  function muteSendBank() {
    const arr = [];
    for (let i = 0; i < 8; i++) arr.push(make('button', { name: 'Mute ' + (i + 1), message_type: 'CC', cc: 0x10 + i, behavior: 'Toggle', channel: i + 1, led: led('#0a1a0a', '#ffd23b', '#000000'), fixed: true }));
    for (let i = 0; i < 8; i++) arr.push(make('button', { name: 'Send ' + (i + 1), message_type: 'CC', cc: 0x18 + i, behavior: 'Toggle', channel: i + 1, led: led('#0a0a1a', '#3bd0ff', '#000000'), fixed: true }));
    return arr;
  }

  function newModel() {
    return {
      version: 1,
      name: 'New Studio Setup',
      global: { channel: 1, template: 1, tempo: 120 },
      knobBanks: [newBank('knob', 8, (i) => 'Knob ' + (i + 1))],
      faders: newBank('fader', 8, (i) => 'Fader ' + (i + 1)),
      buttonBanks: [muteSendBank(), newBank('button', 16, (i) => 'Button ' + (i + 1))],
      pads: { hits: newBank('pad_hit', 16, (i) => 'Pad ' + (i + 1)), pressures: newBank('pad_pressure', 16, (i) => 'Pad ' + (i + 1)) },
      wheels: { pitch: make('pitch', { name: 'Pitch', message_type: 'Pitch Bend' }), mod: make('mod', { name: 'Mod', message_type: 'CC', cc: 1 }) },
      pedals: { sustain: make('sustain', { name: 'Sustain', message_type: 'CC', cc: 64 }), footswitch: make('footswitch', { name: 'Footswitch' }), expression: make('expression', { name: 'Expression', message_type: 'CC', cc: 11 }) },
      keys: { aftertouch: make('keys', { name: 'Aftertouch', message_type: 'Channel Pressure' }) },
    };
  }

  // ---- bank management (unlimited) ----
  function addKnobBank(m) { m.knobBanks.push(newBank('knob', 8, (i) => 'Knob ' + (i + 1))); return m.knobBanks.length - 1; }
  function addButtonBank(m) { m.buttonBanks.push(newBank('button', 16, (i) => 'Button ' + (i + 1))); return m.buttonBanks.length - 1; }

  // ---- import from a Components template (js/sltemplate.js model) ----
  function fromTemplate(tpl) {
    const m = newModel();
    const mapCommon = (dst, src, ccKey) => {
      dst.enabled = !!src.enabled;
      if (src.name) dst.name = src.name;
      dst.channel = src.channel;
      dst.start = src.from_value != null ? src.from_value : dst.start;
      dst.end = src.to_value != null ? src.to_value : dst.end;
      if (MSG[dst.cls].includes(SL_MSG[src.message_type])) dst.message_type = SL_MSG[src.message_type];
    };
    const SL_MSG = { 'CC': 'CC', 'NRPN': 'NRPN', 'Note': 'Note', 'Program Change': 'Program Change', 'Song Position': 'Song Position', 'Channel Pressure': 'Channel Pressure', 'Poly Aftertouch': 'Poly Aftertouch' };
    const T = tpl.sections;
    // knobs -> banks of 8
    m.knobBanks = [];
    for (let b = 0; b * 8 < T.knobs.length; b++) {
      const bank = [];
      for (let i = 0; i < 8; i++) {
        const src = T.knobs[b * 8 + i];
        const a = make('knob', { name: src.name || 'Knob ' + (i + 1) });
        mapCommon(a, src); a.cc = src.first_param || 0; a.resolution = src.resolution || 616;
        bank.push(a);
      }
      m.knobBanks.push(bank);
    }
    if (!m.knobBanks.length) m.knobBanks = [newBank('knob', 8)];
    // faders
    m.faders = T.faders.map((src, i) => { const a = make('fader', { name: src.name || 'Fader ' + (i + 1) }); mapCommon(a, src); a.cc = src.second_param || 0; return a; });
    // buttons -> fixed Mute/Send bank + imported bank
    m.buttonBanks = [muteSendBank(), T.buttons.map((src, i) => { const a = make('button', { name: src.name || 'Button ' + (i + 1) }); mapCommon(a, src); a.cc = src.fourth_param || 0; a.note = src.third_param || 0; a.behavior = BEHAVIORS[src.behavior] || 'Momentary'; a.down_value = src.first_param & 0x7f; a.up_value = src.second_param & 0x7f; return a; })];
    // pads
    m.pads.hits = T.pad_hits.map((src, i) => { const a = make('pad_hit', { name: src.name || 'Pad ' + (i + 1) }); mapCommon(a, src); a.note = src.third_param || 0; a.cc = src.fourth_param || 0; a.behavior = BEHAVIORS[src.behavior] || 'Momentary'; a.vel_max = src.max_velocity != null ? src.max_velocity : 127; a.vel_min = src.min_velocity != null ? src.min_velocity : 1; a.vel_curve = VEL_CURVES[src.range_method] || 'None'; return a; });
    m.pads.pressures = T.pad_pressures.map((src, i) => { const a = make('pad_pressure', { name: src.name || 'Pad ' + (i + 1) }); mapCommon(a, src); a.cc = src.second_param || 0; return a; });
    // wheels / pedals
    if (T.wheels[0]) { mapCommon(m.wheels.pitch, T.wheels[0]); m.wheels.pitch.cc = T.wheels[0].second_param || 0; }
    if (T.wheels[1]) { mapCommon(m.wheels.mod, T.wheels[1]); m.wheels.mod.cc = T.wheels[1].second_param || 0; }
    if (T.pedals[0]) { mapCommon(m.pedals.sustain, T.pedals[0]); m.pedals.sustain.cc = T.pedals[0].second_param || 0; }
    if (T.pedals[1]) { mapCommon(m.pedals.expression, T.pedals[1]); m.pedals.expression.cc = T.pedals[1].second_param || 0; }
    if (T.footswitches[0]) { const src = T.footswitches[0]; mapCommon(m.pedals.footswitch, src); m.pedals.footswitch.cc = src.fourth_param || 0; m.pedals.footswitch.behavior = BEHAVIORS[src.behavior] || 'Momentary'; }
    m.name = tpl.name || 'Imported';
    return m;
  }

  const toJSON = (m) => JSON.stringify(m, null, 2);
  function fromJSON(str) {
    const m = typeof str === 'string' ? JSON.parse(str) : str;
    if (!m || !m.knobBanks) throw new Error('Not a Studio setup file.');
    return m;
  }

  global.SLMK = global.SLMK || {};
  global.SLMK.studio = {
    MSG, BIT_DEPTHS, BEHAVIORS, VEL_CURVES, KNOB_MODES, COMBINED,
    make, newBank, muteSendBank, newModel, addKnobBank, addButtonBank, fromTemplate, toJSON, fromJSON,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SLMK.studio;
})(typeof window !== 'undefined' ? window : globalThis);
