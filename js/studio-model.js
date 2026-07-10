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
    // Faders and wheels have no idle/pressed state — their LED brightness tracks value.
    // led.idle is the full-value colour; the runtime dims it toward black as the value drops.
    if (cls === 'fader' || cls === 'pitch' || cls === 'mod') { base.colorMode = 'value'; base.led = led('#20c0ff', '#20c0ff', '#000000'); }
    // Knobs have no RGB ring; led.idle is the on-screen knob-glyph colour, which
    // the SL shows white by default (not black/unlit).
    if (cls === 'knob') Object.assign(base, { mode: 'Absolute', resolution: 616, step: 1, pivot: 0, combined: 'None', led: led('#ffffff', '#ffffff', '#000000') });
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

  // Fixed first button bank: Mute + Solo for the first 8 MIDI channels (2 rows of 8).
  // These send no MIDI of their own and only their colour is editable. Mute stops
  // MIDI on its channel; Solo restricts output to its channel. Channels are
  // mappable (default 1-8). led.idle is the base colour; pressed shows the
  // engaged (brighter) state.
  function muteSoloBank() {
    const arr = [];
    for (let i = 0; i < 8; i++) arr.push(make('button', { name: 'Mute ' + (i + 1), role: 'mute', channel: i + 1, fixed: true, colorOnly: true, led: led('#ff6a00', '#ffd9a8', '#000000') }));
    for (let i = 0; i < 8; i++) arr.push(make('button', { name: 'Solo ' + (i + 1), role: 'solo', channel: i + 1, fixed: true, colorOnly: true, led: led('#5bc8ff', '#c8ecff', '#000000') }));
    return arr;
  }
  const muteSendBank = muteSoloBank; // back-compat alias

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
    // The parsed template stores message_type as a NUMERIC index into
    // sltemplate.MESSAGE_TYPES (e.g. 3 = Program Change). Resolve it to the name
    // so Program Change / NRPN / Note etc. survive import instead of falling back
    // to CC (#35). Strings are still accepted for forward-compat.
    const SLTYPES = (global.SLMK.sltemplate && global.SLMK.sltemplate.MESSAGE_TYPES) || ['CC', 'NRPN', 'Note', 'Program Change', 'Song Position', 'Channel Pressure', 'Poly Aftertouch'];
    const mapCommon = (dst, src, ccKey) => {
      dst.enabled = !!src.enabled;
      if (src.name) dst.name = src.name;
      dst.channel = src.channel;
      dst.start = src.from_value != null ? src.from_value : dst.start;
      dst.end = src.to_value != null ? src.to_value : dst.end;
      const name = typeof src.message_type === 'number' ? SLTYPES[src.message_type] : src.message_type;
      if (name && MSG[dst.cls].includes(name)) dst.message_type = name;
    };
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

  // ---- Template library (#32) ----------------------------------------------
  // A template is a named control mapping. The editor edits the *active* template;
  // the model's live control sections (knobBanks/faders/…) ARE the active
  // template's sections (same references), so editing mutates it in place.
  const SECTIONS = ['knobBanks', 'faders', 'buttonBanks', 'pads', 'wheels', 'pedals', 'keys'];
  function uid(arr, prefix) { let i = 1; const has = (x) => arr.some((e) => e.id === x); while (has(prefix + i)) i++; return prefix + i; }
  function templateFromSections(m, name, order) {
    const t = { id: '', name: name || 'Template', order: order || 0 };
    SECTIONS.forEach((k) => (t[k] = m[k]));
    return t;
  }
  // Ensure the library exists; seed it with the current sections as "Template 1".
  function ensureTemplates(m) {
    if (!m.templates || !m.templates.length) {
      const t = templateFromSections(m, m.name || 'Template 1', 1);
      t.id = 't1';
      m.templates = [t];
      m.activeTemplate = t.id;
    }
    // keep the active template's sections pointed at the live model sections
    if (!m.templates.some((t) => t.id === m.activeTemplate)) m.activeTemplate = m.templates[0].id;
    return m.templates;
  }
  const activeTemplate = (m) => (m.templates || []).find((t) => t.id === m.activeTemplate) || (m.templates || [])[0];
  // Point the model's live sections at a template so the editor edits it.
  function selectTemplate(m, id) {
    ensureTemplates(m);
    const t = m.templates.find((x) => x.id === id); if (!t) return;
    SECTIONS.forEach((k) => (m[k] = t[k]));
    m.activeTemplate = id; m.name = t.name;
  }
  const nextOrder = (arr) => (arr.length ? Math.max.apply(null, arr.map((x) => x.order || 0)) : 0) + 1;
  // Create a new template and select it. opts.from = a model whose sections to
  // adopt (e.g. an imported .syx); opts.clone = duplicate the active template;
  // otherwise a blank default. opts.name sets the name.
  function addTemplate(m, opts) {
    ensureTemplates(m);
    const cur = activeTemplate(m); if (cur) SECTIONS.forEach((k) => (cur[k] = m[k])); // save current edits first
    let src;
    if (opts && opts.from) src = opts.from;
    else if (opts && opts.clone) src = JSON.parse(JSON.stringify(cur));
    else src = newModel();
    const t = { id: uid(m.templates, 't'), name: (opts && opts.name) || 'Template ' + (m.templates.length + 1), order: nextOrder(m.templates) };
    SECTIONS.forEach((k) => (t[k] = src[k]));
    m.templates.push(t);
    selectTemplate(m, t.id);
    return t;
  }
  function removeTemplate(m, id) {
    ensureTemplates(m);
    if (m.templates.length <= 1) return; // keep at least one
    const wasActive = m.activeTemplate === id;
    m.templates = m.templates.filter((t) => t.id !== id);
    // clear any part mapping that referenced it
    (m.partTemplates || []).forEach((tid, i) => { if (tid === id) m.partTemplates[i] = null; });
    if (wasActive) selectTemplate(m, m.templates[0].id);
  }
  function renameTemplate(m, id, name) { const t = (m.templates || []).find((x) => x.id === id); if (t) { t.name = name; if (m.activeTemplate === id) m.name = name; } }
  // Map a template to one of the 8 parts (channels). The runtime uses this to give
  // each part its own instrument mapping (#32).
  function mapTemplateToPart(m, id, partIdx) {
    ensureTemplates(m);
    m.partTemplates = m.partTemplates || new Array(8).fill(null);
    m.partTemplates[partIdx] = id;
    // materialise a snapshot the live engine reads (kept in sync with channelTemplates)
    const t = m.templates.find((x) => x.id === id);
    m.channelTemplates = m.channelTemplates || new Array(8).fill(null);
    m.channelTemplates[partIdx] = t ? JSON.parse(JSON.stringify({ name: t.name, knobBanks: t.knobBanks, faders: t.faders, pads: t.pads, buttonBanks: t.buttonBanks })) : null;
  }
  function unmapPart(m, partIdx) { if (m.partTemplates) m.partTemplates[partIdx] = null; if (m.channelTemplates) m.channelTemplates[partIdx] = null; }

  // ---- Session library (#33) -----------------------------------------------
  // A session bundles the full sequencer state + which template maps to each part.
  function ensureSessions(m) { if (!m.sessions) m.sessions = []; return m.sessions; }
  function snapshotSession(m, name) {
    ensureSequencer(m); ensureSessions(m); ensureTemplates(m);
    const s = {
      id: uid(m.sessions, 's'), name: name || 'Session ' + (m.sessions.length + 1),
      order: (m.sessions.length ? Math.max.apply(null, m.sessions.map((x) => x.order || 0)) : 0) + 1,
      sequencer: JSON.parse(JSON.stringify(m.sequencer)),
      partTemplates: (m.partTemplates || new Array(8).fill(null)).slice(),
    };
    m.sessions.push(s);
    return s;
  }
  function loadSession(m, id) {
    ensureSessions(m);
    const s = m.sessions.find((x) => x.id === id); if (!s) return;
    m.sequencer = JSON.parse(JSON.stringify(s.sequencer));
    if (s.partTemplates) { m.partTemplates = s.partTemplates.slice(); s.partTemplates.forEach((tid, i) => { if (tid) mapTemplateToPart(m, tid, i); else unmapPart(m, i); }); }
  }
  function removeSession(m, id) { if (m.sessions) m.sessions = m.sessions.filter((s) => s.id !== id); }
  function renameSession(m, id, name) { const s = (m.sessions || []).find((x) => x.id === id); if (s) s.name = name; }
  // Add an imported (Novation Components) session: decode its sequence into a
  // full session entry that can be played back (#33).
  function addImportedSession(m, name, bytes) {
    ensureSessions(m);
    const seq = global.SLMK.session ? global.SLMK.session.readSequence(bytes) : null;
    const s = { id: uid(m.sessions, 's'), name: name || 'Imported', order: (m.sessions.length ? Math.max.apply(null, m.sessions.map((x) => x.order || 0)) : 0) + 1, sequencer: seq, partTemplates: new Array(8).fill(null), imported: true };
    m.sessions.push(s);
    return s;
  }

  // Attach a sequencer to a model if it doesn't have one yet (kept out of
  // newModel so modules that don't load the sequencer still work).
  function ensureSequencer(m) {
    if (!m.sequencer && global.SLMK.sequencer) m.sequencer = global.SLMK.sequencer.newSequencer();
    return m.sequencer;
  }

  // Serialize the studio model back to a Components .syx template. Lossy: only
  // the first knob banks / first editable button bank / base assignments map to
  // the 77-record template; extra banks, per-state colours and the sequencer
  // don't exist in the template format.
  function toTemplate(sm) {
    const T = global.SLMK.sltemplate;
    const tpl = T.newTemplate();
    tpl.name = (sm.name || 'Studio').slice(0, 16);
    const midx = (name) => { const i = T.MESSAGE_TYPES.indexOf(name); return i >= 0 ? i : 0; }; // unsupported -> CC
    const beh = (b) => Math.max(0, BEHAVIORS.indexOf(b));
    const vc = (c) => Math.max(0, VEL_CURVES.indexOf(c));
    const faderRec = (a) => ({ enabled: !!a.enabled, name: a.name || '', message_type: midx(a.message_type), channel: a.channel, from_value: a.start | 0, to_value: a.end | 0, first_param: 0, second_param: a.cc | 0, lsb_index: 0 });
    const knobRec = (a) => ({ enabled: !!a.enabled, name: a.name || '', message_type: midx(a.message_type), first_param: a.cc | 0, lsb_index: 0, relative: a.mode === 'Relative' ? 1 : 0, eight_bit: a.bit_depth === '14-bit' ? 1 : 0, pivot: a.pivot | 0, step: a.step || 1, resolution: a.resolution || 616, channel: a.channel, from_value: a.start | 0, to_value: a.end | 0 });
    const btnRec = (a) => ({ enabled: !!a.enabled, name: a.name || '', message_type: midx(a.message_type), behavior: beh(a.behavior), action: 0, first_param: a.down_value | 0, second_param: a.up_value | 0, step: 0, wrap: false, pair: false, channel: a.channel, third_param: a.note | 0, fourth_param: a.cc | 0, lsb_index: 0 });
    const padRec = (a) => Object.assign(btnRec(a), { max_velocity: a.vel_max | 0, min_velocity: a.vel_min | 0, range_method: vc(a.vel_curve) });
    const pad16 = (arr) => { const o = arr.slice(0, 16); while (o.length < 16) o.push(make('knob')); return o; };
    const bbank = sm.buttonBanks[1] || sm.buttonBanks[0];
    tpl.sections.buttons = bbank.slice(0, 16).map(btnRec);
    tpl.sections.knobs = pad16((sm.knobBanks[0] || []).concat(sm.knobBanks[1] || [])).map(knobRec);
    tpl.sections.faders = sm.faders.slice(0, 8).map(faderRec);
    tpl.sections.wheels = [faderRec(sm.wheels.pitch), faderRec(sm.wheels.mod)];
    tpl.sections.pedals = [faderRec(sm.pedals.sustain), faderRec(sm.pedals.expression)];
    tpl.sections.footswitches = [btnRec(sm.pedals.footswitch)];
    tpl.sections.pad_hits = sm.pads.hits.slice(0, 16).map(padRec);
    tpl.sections.pad_pressures = sm.pads.pressures.slice(0, 16).map(faderRec);
    return tpl;
  }

  // #27: templates and setups are one and the same. Merge a Components template's
  // parameters INTO an existing setup instead of replacing it — the sequencer,
  // per-channel assignments and the fixed Mute/Solo bank are preserved; the
  // template's knobs/faders/buttons/pads/wheels/pedals overlay the setup, and any
  // extra banks it carries are appended.
  function mergeTemplate(m, tpl) {
    const t = fromTemplate(tpl);
    m.knobBanks = t.knobBanks.length ? t.knobBanks : m.knobBanks;
    m.faders = t.faders;
    // keep buttonBanks[0] (fixed Mute/Solo); overlay the editable banks from the template
    const fixed = m.buttonBanks[0] || muteSoloBank();
    m.buttonBanks = [fixed].concat(t.buttonBanks.slice(1));
    if (m.buttonBanks.length < 2) m.buttonBanks.push(newBank('button', 16, (i) => 'Button ' + (i + 1)));
    m.pads = t.pads;
    m.wheels = t.wheels;
    m.pedals = t.pedals;
    m.keys = t.keys;
    if (tpl.name) m.name = tpl.name;
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
    make, newBank, muteSendBank, muteSoloBank, newModel, addKnobBank, addButtonBank, fromTemplate, mergeTemplate, toTemplate, ensureSequencer, toJSON, fromJSON,
    ensureTemplates, activeTemplate, selectTemplate, addTemplate, removeTemplate, renameTemplate, mapTemplateToPart, unmapPart,
    ensureSessions, snapshotSession, loadSession, removeSession, renameSession, addImportedSession,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SLMK.studio;
})(typeof window !== 'undefined' ? window : globalThis);
